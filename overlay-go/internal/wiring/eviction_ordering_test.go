package wiring

// Wire contract §9.8 — eviction ordering.
//
// evictedAt is stamped ONLY after the input restore succeeded. The stamp is
// what makes ERR_EVICTED permanent for these bytes and what tells the FIX L
// spend guard that the restored coins are live again, so stamping it over a
// failed restore would publish a lie in both directions: the wallet is told to
// build a new spend, while the coins it would need are still marked spent with
// no token row. On any restore failure the callback answers 503 (Arcade
// retries) and the record is left exactly as it was.

import (
	"context"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

func TestEvictTxStampsNothingWhenTheRestoreFails(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_evict_ordering",
		ServerPrivKeyHex: testPrivHex,
		HostingURL:       "https://overlay.example.com",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
		ArcadeURL:        "https://arcade.example.com",
	})
	if err != nil {
		t.Fatal("Build:", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_ = app.Mongo.Drop(cleanupCtx)
		_ = app.Mongo.Client().Disconnect(cleanupCtx)
	})

	const topic = "tm_mandala"
	const owner = "02poisonedbalance"
	parent := wiringTestTx(t, nil, 0, 1, 0x71)
	parentID := parent.TxID()
	child := wiringTestTx(t, parent, 0, 1, 0)
	childID := child.TxID()
	childStr := childID.String()

	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertOutputs(ctx, topic, childID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: childID, Topic: topic}); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *parentID, Index: 0}}, topic, childID); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.RecordAdmission(ctx, mandala.AdmissionRecord{
		Txid:                 childStr,
		Topics:               []string{topic},
		OutputsToAdmit:       []uint32{0},
		AdmissionSignature:   "3044",
		AdmissionIdentityKey: "02aa",
		Restore: &mandala.RestoreSnapshot{
			SpentOutpoints: []string{parentID.String() + ".0"},
			TokenRows: []mandala.TokenRow{{
				Txid: parentID.String(), OutputIndex: 0, AssetID: "a.0",
				Amount: 40, IdentityKey: owner, CreatedAt: time.Now(),
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// Break the restore deterministically: the owner's balance document holds
	// a non-numeric value, so the re-credit ($inc) the token-row restore
	// performs fails. This is the last step of "restore the inputs", i.e.
	// exactly the failure §9.8 is about.
	if _, err := app.Mongo.Collection("mandalaBalances").InsertOne(ctx, bson.D{
		{Key: "identityKey", Value: owner},
		{Key: "balance", Value: "not-a-number"},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := app.EvictTx(ctx, childStr); err == nil {
		t.Fatal("a failed restore must surface as an eviction error, not be swallowed")
	}

	rec, err := app.Store.GetAdmission(ctx, childStr)
	if err != nil {
		t.Fatal(err)
	}
	if rec == nil || rec.EvictedAt != "" {
		t.Fatalf("evictedAt was stamped over a failed restore: %+v", rec)
	}
	// The eviction's destructive half must not have run either — the outputs
	// and the applied-transaction record are still there for the retry.
	outs, err := st.FindOutputsForTransaction(ctx, childID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(outs) == 0 {
		t.Fatal("the evicted transaction's outputs were deleted despite the failed restore")
	}
	applied, err := app.EngineStore.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: childID, Topic: topic})
	if err != nil {
		t.Fatal(err)
	}
	if !applied {
		t.Fatal("the applied-transaction record was deleted despite the failed restore")
	}

	// With the balance repaired, the retry Arcade sends completes the whole
	// unwind and reports what it handed back (§9.12).
	if _, err := app.Mongo.Collection("mandalaBalances").UpdateOne(ctx,
		bson.D{{Key: "identityKey", Value: owner}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "balance", Value: int64(0)}}}}); err != nil {
		t.Fatal(err)
	}
	outcome, err := app.EvictTx(ctx, childStr)
	if err != nil {
		t.Fatal("retry after repair:", err)
	}
	// RestoredOutpoints is 0 on the retry precisely because the failed attempt
	// had already unmarked the engine-side spend before it died: the restore
	// runs first and is idempotent, which is the ordering under test.
	if outcome.RestoredTokenRows != 1 || outcome.AlreadyEvicted {
		t.Fatalf("eviction outcome = %+v, want 1 token row replayed and not already evicted", outcome)
	}
	rec, err = app.Store.GetAdmission(ctx, childStr)
	if err != nil || rec == nil || rec.EvictedAt == "" {
		t.Fatalf("evictedAt not stamped after a successful restore: %+v %v", rec, err)
	}

	// A repeat callback is idempotent and says so.
	repeat, err := app.EvictTx(ctx, childStr)
	if err != nil {
		t.Fatal("repeat eviction:", err)
	}
	if !repeat.AlreadyEvicted {
		t.Fatalf("repeat eviction outcome = %+v, want alreadyEvicted", repeat)
	}
}

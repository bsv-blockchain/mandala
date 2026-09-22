package wiring

// Task 12 wiring test: Build with a local Mongo and empty ArcadeURL returns
// an App whose Engine is non-nil, and Engine.Lookup for ls_mandala with
// {"assetId":"missing.0"} answers an empty output-list. That single call
// proves topic-manager/lookup-service registration, the enginestore Storage,
// and the engine hydration path end-to-end.
//
// Requires Mongo at localhost:27017 (Task 8 skip pattern; the
// mandala_wiring_test_lookup_services db is dropped in cleanup).

import (
	"context"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/sirdeggen/mandala/overlay-go/internal/arcade"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// Arbitrary valid secp256k1 private key (test-only).
const testPrivHex = "1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"

// requireMongo pre-flight-pings mongodb://localhost:27017 (the same
// connect-then-ping shape as httpapi/admin_test.go's testAdminDB) so a test
// skips ONLY when Mongo itself is unreachable in this environment. Any
// Build error that occurs after this succeeds is a real failure, not an
// environment gap, and must fail the test via t.Fatal instead of skipping.
func requireMongo(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://localhost:27017"))
	if err != nil {
		t.Skip("mongo unavailable:", err)
	}
	defer func() { _ = client.Disconnect(context.Background()) }()
	if err := client.Ping(ctx, nil); err != nil {
		t.Skip("mongo unavailable:", err)
	}
}

func TestBuildAndLookupEndToEnd(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test",
		ServerPrivKeyHex: testPrivHex,
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
		// ArcadeURL empty: scripts-only chain tracker, nil broadcaster.
	})
	if err != nil {
		t.Fatal("Build:", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_ = app.Mongo.Drop(cleanupCtx)
		_ = app.Mongo.Client().Disconnect(cleanupCtx)
	})

	if app.Engine == nil {
		t.Fatal("Engine is nil")
	}
	if app.Store == nil || app.Verifier == nil || app.Mongo == nil {
		t.Fatalf("incomplete App: %+v", app)
	}
	if app.ArcadeEnabled {
		t.Fatal("ArcadeEnabled must be false when ArcadeURL is empty")
	}
	if app.PrepareSubmitCompensation != nil || app.EvictTx != nil {
		t.Fatal("compensation/eviction closures must be nil without Arcade (no broadcaster, no /arc-ingest)")
	}
	if app.FindRawTxs == nil {
		t.Fatal("FindRawTxs must always be wired -- /admin/activity has no Arcade dependency")
	}
	if app.Mongo.Name() != "mandala_wiring_test_lookup_services" {
		t.Fatalf("db name = %q", app.Mongo.Name())
	}
	if !app.Engine.HasTopicManager("tm_mandala") {
		t.Fatal("tm_mandala not registered")
	}
	if !app.Engine.HasLookupService("ls_mandala") {
		t.Fatal("ls_mandala not registered")
	}

	answer, err := app.Engine.Lookup(ctx, &lookup.LookupQuestion{
		Service: "ls_mandala",
		Query:   []byte(`{"assetId":"missing.0"}`),
	})
	if err != nil {
		t.Fatal("Lookup:", err)
	}
	if answer.Type != lookup.AnswerTypeOutputList {
		t.Fatalf("answer type = %v, want output-list", answer.Type)
	}
	if len(answer.Outputs) != 0 {
		t.Fatalf("outputs = %d, want 0", len(answer.Outputs))
	}
}

// TestBuildWithArcadeURLDefaultsBroadcasterAndTracker proves Task 16's
// wiring: a non-empty ArcadeURL makes Build default the engine's
// Broadcaster/ChainTracker to Arcade-backed implementations (rather than
// nil/scriptsOnlyTracker) without any Option override, and threads
// ArcadeCallbackToken onto App. No real Arcade deployment is contacted —
// arcade.NewBroadcaster/NewChaintracks only build HTTP clients at
// construction time.
func TestBuildWithArcadeURLDefaultsBroadcasterAndTracker(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:            "mandala_wiring_test_arcade",
		ServerPrivKeyHex:    testPrivHex,
		HostingURL:          "https://overlay.example.com",
		MongoURL:            "mongodb://localhost:27017",
		Network:             "test",
		ArcadeURL:           "https://arcade.example.com",
		ArcadeAPIKey:        "test-api-key",
		ArcadeCallbackToken: "test-callback-token",
	})
	if err != nil {
		t.Fatal("Build:", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_ = app.Mongo.Drop(cleanupCtx)
		_ = app.Mongo.Client().Disconnect(cleanupCtx)
	})

	if !app.ArcadeEnabled {
		t.Fatal("ArcadeEnabled must be true when ArcadeURL is set")
	}
	if app.ArcadeCallbackToken != "test-callback-token" {
		t.Fatalf("ArcadeCallbackToken = %q, want test-callback-token", app.ArcadeCallbackToken)
	}
	if _, ok := app.Engine.Broadcaster.(*arcade.Broadcaster); !ok {
		t.Fatalf("Engine.Broadcaster = %T, want *arcade.Broadcaster", app.Engine.Broadcaster)
	}
	if _, ok := app.Engine.ChainTracker.(*arcade.Chaintracks); !ok {
		t.Fatalf("Engine.ChainTracker = %T, want *arcade.Chaintracks", app.Engine.ChainTracker)
	}
}

// TestBuildWithArcadeURLHonorsOptionOverride proves the WithBroadcaster/
// WithChainTracker seam still wins over the ArcadeURL default — the seam
// tests substitute a stub through instead of a real Arcade deployment.
func TestBuildWithArcadeURLHonorsOptionOverride(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	stubTracker := scriptsOnlyTracker{}
	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_arcade_override",
		ServerPrivKeyHex: testPrivHex,
		HostingURL:       "https://overlay.example.com",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
		ArcadeURL:        "https://arcade.example.com",
	}, WithChainTracker(stubTracker))
	if err != nil {
		t.Fatal("Build:", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_ = app.Mongo.Drop(cleanupCtx)
		_ = app.Mongo.Client().Disconnect(cleanupCtx)
	})

	if _, ok := app.Engine.ChainTracker.(scriptsOnlyTracker); !ok {
		t.Fatalf("Engine.ChainTracker = %T, want the injected scriptsOnlyTracker override", app.Engine.ChainTracker)
	}
	// Broadcaster wasn't overridden, so it should still default to Arcade.
	if _, ok := app.Engine.Broadcaster.(*arcade.Broadcaster); !ok {
		t.Fatalf("Engine.Broadcaster = %T, want *arcade.Broadcaster", app.Engine.Broadcaster)
	}
}

func TestScriptsOnlyTracker(t *testing.T) {
	ctx := context.Background()
	tr := scriptsOnlyTracker{}
	ok, err := tr.IsValidRootForHeight(ctx, nil, 0)
	if err != nil || !ok {
		t.Fatalf("IsValidRootForHeight = %v, %v; want true, nil", ok, err)
	}
	if _, err := tr.CurrentHeight(ctx); err != nil {
		t.Fatal("CurrentHeight:", err)
	}
}

// --- Task 18: broadcast-failure compensation + terminal-status eviction ---

// wiringTestTx builds a minimal transaction: one input spending src:vout
// (or a dummy outpoint when src is nil) and n outputs.
func wiringTestTx(t *testing.T, src *transaction.Transaction, vout uint32, outputs int, fill byte) *transaction.Transaction {
	t.Helper()
	tx := transaction.NewTransaction()
	var srcID *chainhash.Hash
	if src != nil {
		srcID = src.TxID()
	} else {
		raw := make([]byte, 32)
		for i := range raw {
			raw[i] = fill
		}
		var err error
		if srcID, err = chainhash.NewHash(raw); err != nil {
			t.Fatal(err)
		}
	}
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID:       srcID,
		SourceTxOutIndex: vout,
		UnlockingScript:  &script.Script{},
	})
	for i := 0; i < outputs; i++ {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(i + 1), LockingScript: &script.Script{}})
	}
	return tx
}

// TestBuildArcadeCompensationRoundTrip drives Build's
// PrepareSubmitCompensation closure against real Mongo: seed the state the
// engine would have seen pre-submit, snapshot, replay the exact mutations
// v1.3.2's markSpentAndNotify performs before a failed broadcast, then
// compensate and assert everything is restored.
func TestBuildArcadeCompensationRoundTrip(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_comp",
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
	if app.PrepareSubmitCompensation == nil || app.EvictTx == nil {
		t.Fatal("Arcade-enabled Build must wire PrepareSubmitCompensation and EvictTx")
	}

	const topic = "tm_mandala"
	parent := wiringTestTx(t, nil, 0, 1, 0x41)
	parentID := parent.TxID()
	child := wiringTestTx(t, parent, 0, 1, 0)
	childID := child.TxID()
	beefBytes, err := child.AtomicBEEF(true)
	if err != nil {
		t.Fatal(err)
	}

	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.StoreToken(ctx, mandala.TokenRow{
		Txid: parentID.String(), OutputIndex: 0, AssetID: "a.0", Amount: 40,
		IdentityKey: "02k", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.AdjustBalance(ctx, "02k", 40); err != nil {
		t.Fatal(err)
	}

	// The submit handler snapshots BEFORE Engine.Submit.
	compensate, restore, err := app.PrepareSubmitCompensation(ctx, beefBytes)
	if err != nil {
		t.Fatal("prepare:", err)
	}
	if compensate == nil {
		t.Fatal("prepare returned nil compensation for a valid BEEF")
	}
	// The same snapshot must also come back as a plain value, for the
	// admission record to persist (FIX E).
	if restore == nil || len(restore.TokenRows) != 1 || restore.TokenRows[0].Amount != 40 {
		t.Fatalf("restore snapshot = %+v, want the pre-spend parent row", restore)
	}
	if len(restore.SpentOutpoints) != 1 || restore.SpentOutpoints[0] != parentID.String()+".0" {
		t.Fatalf("restore.spentOutpoints = %v", restore.SpentOutpoints)
	}

	// Replay what v1.3.2's markSpentAndNotify does before broadcastIfNeeded
	// fails: MarkUTXOsAsSpent + ls_mandala.OutputSpent (balance debit + row
	// delete).
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *parentID, Index: 0}}, topic, childID); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.AdjustBalance(ctx, "02k", -40); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.DeleteToken(ctx, parentID.String(), 0); err != nil {
		t.Fatal(err)
	}

	if err := compensate(ctx); err != nil {
		t.Fatal("compensate:", err)
	}

	topicName := topic
	unspent := false
	got, err := st.FindOutput(ctx, &transaction.Outpoint{Txid: *parentID, Index: 0}, &topicName, &unspent, false)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Spent {
		t.Fatalf("parent:0 must be unspent again after compensation, got %+v", got)
	}
	row, err := app.Store.GetTokenRow(ctx, parentID.String(), 0)
	if err != nil || row == nil {
		t.Fatal(row, err)
	}
	if row.Amount != 40 || row.IdentityKey != "02k" || row.AssetID != "a.0" {
		t.Fatalf("restored token row: %+v", row)
	}
	if b, _ := app.Store.GetBalance(ctx, "02k"); b != 40 {
		t.Fatalf("balance after compensation = %d, want 40", b)
	}

	// Running the compensation twice must not double-credit.
	if err := compensate(ctx); err != nil {
		t.Fatal("second compensate:", err)
	}
	if b, _ := app.Store.GetBalance(ctx, "02k"); b != 40 {
		t.Fatalf("balance after double compensation = %d, want 40", b)
	}
}

// TestBuildArcadeCompensationSkipsAlreadyCommittedTx is the dupe-resubmit
// case: a tx already folded (applied-transaction record exists, its input
// already spent by it, and the mandala token row it consumed already gone)
// gets resubmitted — go-overlay-services v1.3.2 lets a duplicate through its
// per-topic dupe gate before re-attempting broadcast, so a broadcast failure
// on the SECOND attempt must not compensate: doing so would unmark the
// original successful submit's spent input and try to resurrect a token row
// that was correctly deleted. A genuine broadcast failure can never reach
// this state (commitAdmittedOutputs — which inserts the applied-transaction
// record — never runs before a failed broadcast).
func TestBuildArcadeCompensationSkipsAlreadyCommittedTx(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_comp_dup",
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
	parent := wiringTestTx(t, nil, 0, 1, 0x61)
	parentID := parent.TxID()
	child := wiringTestTx(t, parent, 0, 1, 0)
	childID := child.TxID()
	beefBytes, err := child.AtomicBEEF(true)
	if err != nil {
		t.Fatal(err)
	}

	st := app.Engine.Storage

	// Seed the state left behind by the ORIGINAL successful submit of child:
	// parent:0 already spent by childID, an applied-transaction record for
	// childID under tm_mandala, and NO mandala token row for parent:0 (it was
	// correctly consumed when that submit committed).
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *parentID, Index: 0}}, topic, childID); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: childID, Topic: topic}); err != nil {
		t.Fatal(err)
	}

	// The submit handler snapshots BEFORE Engine.Submit, exactly as it would
	// for the duplicate resubmit attempt.
	compensate, _, err := app.PrepareSubmitCompensation(ctx, beefBytes)
	if err != nil {
		t.Fatal("prepare:", err)
	}
	if compensate == nil {
		t.Fatal("prepare returned nil compensation for a valid BEEF")
	}

	if err := compensate(ctx); err != nil {
		t.Fatal("compensate:", err)
	}

	topicName := topic
	spent := true
	got, err := st.FindOutput(ctx, &transaction.Outpoint{Txid: *parentID, Index: 0}, &topicName, &spent, false)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("parent:0 must remain spent after skipped compensation (already-committed tx)")
	}
	row, err := app.Store.GetTokenRow(ctx, parentID.String(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if row != nil {
		t.Fatalf("token row must not be resurrected by skipped compensation: %+v", row)
	}
}

// TestBuildArcadeEvictTxRoundTrip drives Build's EvictTx closure against
// real Mongo: seed a folded transaction (engine outputs + applied record +
// mandala token/metadata projections), evict by txid, and assert everything
// is gone — with balances untouched (TS OutputEvicted parity: eviction never
// adjusts balances).
func TestBuildArcadeEvictTxRoundTrip(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_evict",
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
	tx := wiringTestTx(t, nil, 0, 2, 0x51)
	txid := tx.TxID()
	txidStr := txid.String()

	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0, 1}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: topic}); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.StoreToken(ctx, mandala.TokenRow{
		Txid: txidStr, OutputIndex: 0, AssetID: "a.0", Amount: 10,
		IdentityKey: "02e", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.AdjustBalance(ctx, "02e", 10); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.StoreMetadata(ctx, mandala.MetadataRow{Txid: txidStr, OutputIndex: 1, AssetID: "asset-x"}); err != nil {
		t.Fatal(err)
	}

	if _, err := app.EvictTx(ctx, txidStr); err != nil {
		t.Fatal("EvictTx:", err)
	}

	outs, err := st.FindOutputsForTransaction(ctx, txid, false)
	if err != nil || len(outs) != 0 {
		t.Fatalf("engine outputs after eviction = %d err %v, want 0", len(outs), err)
	}
	exists, err := st.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: topic})
	if err != nil || exists {
		t.Fatalf("applied record after eviction: exists=%v err=%v", exists, err)
	}
	if row, _ := app.Store.GetTokenRow(ctx, txidStr, 0); row != nil {
		t.Fatalf("token row survived eviction: %+v", row)
	}
	if ops, _ := app.Store.FindMetadataByAssetID(ctx, "asset-x"); len(ops) != 0 {
		t.Fatalf("metadata survived eviction: %v", ops)
	}
	if b, _ := app.Store.GetBalance(ctx, "02e"); b != 10 {
		t.Fatalf("balance after eviction = %d, want 10 (eviction must not adjust balances)", b)
	}

	// Evicting the same txid again is a no-op.
	if _, err := app.EvictTx(ctx, txidStr); err != nil {
		t.Fatal("second EvictTx:", err)
	}
}

// TestFindRawTxsBatchesOverEnginestore is Task 17's wiring test: App's
// FindRawTxs (activity.Deps.FindRawTxs's production implementation) must
// resolve every stored txid to its raw hex and simply omit unknown ones,
// batching several txids in one call.
func TestFindRawTxsBatchesOverEnginestore(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_rawtxs",
		ServerPrivKeyHex: testPrivHex,
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
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
	tx1 := wiringTestTx(t, nil, 0, 1, 0x71)
	tx1id := tx1.TxID()
	tx2 := wiringTestTx(t, nil, 0, 1, 0x72)
	tx2id := tx2.TxID()

	beef1 := transaction.NewBeefV2()
	if _, err := beef1.MergeTransaction(tx1); err != nil {
		t.Fatal(err)
	}
	beef2 := transaction.NewBeefV2()
	if _, err := beef2.MergeTransaction(tx2); err != nil {
		t.Fatal(err)
	}

	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, topic, tx1id, []uint32{0}, nil, beef1, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertOutputs(ctx, topic, tx2id, []uint32{0}, nil, beef2, nil); err != nil {
		t.Fatal(err)
	}

	missingID := wiringTestTx(t, nil, 0, 1, 0x73).TxID().String()
	got, err := app.FindRawTxs(ctx, []string{tx1id.String(), tx2id.String(), missingID})
	if err != nil {
		t.Fatal(err)
	}
	if got[tx1id.String()] != tx1.Hex() {
		t.Fatalf("tx1 hex = %q, want %q", got[tx1id.String()], tx1.Hex())
	}
	if got[tx2id.String()] != tx2.Hex() {
		t.Fatalf("tx2 hex = %q, want %q", got[tx2id.String()], tx2.Hex())
	}
	if _, ok := got[missingID]; ok {
		t.Fatalf("missing txid must be absent from the map, got %q", got[missingID])
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2", len(got))
	}
}

// TestBuildArcadeEvictTxRestoresInputs is FIX E: an /arc-ingest terminal
// status used to delete the transaction's outputs and walk away, leaving the
// coin it spent marked spent forever with no token row — provably unspent on
// chain, unspendable through the overlay. Eviction must now be the exact
// inverse of admission for inputs: unmark the engine-side spend, replay the
// token rows from the snapshot persisted on the admission record, stamp
// evictedAt, and only then delete the evicted outputs.
func TestBuildArcadeEvictTxRestoresInputs(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_evict_restore",
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
	parent := wiringTestTx(t, nil, 0, 1, 0x61)
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
	// The child spent the parent's coin: engine mark + the mandala row gone.
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *parentID, Index: 0}}, topic, childID); err != nil {
		t.Fatal(err)
	}
	// ... and the admission recorded the pre-spend snapshot, exactly as the
	// submit handler persists it.
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
				Amount: 40, IdentityKey: "02k", CreatedAt: time.Now(),
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := app.EvictTx(ctx, childStr); err != nil {
		t.Fatal("EvictTx:", err)
	}

	topicName := topic
	unspent := false
	got, err := st.FindOutput(ctx, &transaction.Outpoint{Txid: *parentID, Index: 0}, &topicName, &unspent, false)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Spent {
		t.Fatalf("the evicted tx's input must be spendable again, got %+v", got)
	}
	row, err := app.Store.GetTokenRow(ctx, parentID.String(), 0)
	if err != nil || row == nil || row.Amount != 40 {
		t.Fatalf("token row not restored from the admission snapshot: %+v %v", row, err)
	}
	if b, _ := app.Store.GetBalance(ctx, "02k"); b != 40 {
		t.Fatalf("balance after restore = %d, want 40", b)
	}
	rec, err := app.Store.GetAdmission(ctx, childStr)
	if err != nil || rec == nil || rec.EvictedAt == "" {
		t.Fatalf("evictedAt not stamped: %+v %v", rec, err)
	}
	// The evicted transaction's own outputs are gone, as before.
	outs, err := st.FindOutputsForTransaction(ctx, childID, false)
	if err != nil || len(outs) != 0 {
		t.Fatalf("evicted outputs = %d err %v, want 0", len(outs), err)
	}

	// And the restored coin now reads as LIVE to the FIX L spend guard, even
	// though an engine row still names the evicted tx elsewhere: a client
	// racing the restore must never be told the coin is gone.
	by, err := spendChecker(app.EngineStore, app.Store).SpentBy(ctx, parentID.String(), 0)
	if err != nil || by != "" {
		t.Fatalf("spend guard after eviction = %q (%v), want live", by, err)
	}
}

// TestSpendCheckerNamesTheCompetingSpender is the other half of the guard:
// a coin spent by a live (un-evicted) transaction reports that transaction.
func TestSpendCheckerNamesTheCompetingSpender(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_spendguard",
		ServerPrivKeyHex: testPrivHex,
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
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
	parent := wiringTestTx(t, nil, 0, 1, 0x71)
	parentID := parent.TxID()
	child := wiringTestTx(t, parent, 0, 1, 0)
	childID := child.TxID()

	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	guard := spendChecker(app.EngineStore, app.Store)
	if by, err := guard.SpentBy(ctx, parentID.String(), 0); err != nil || by != "" {
		t.Fatalf("live coin reported spent by %q (%v)", by, err)
	}
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *parentID, Index: 0}}, topic, childID); err != nil {
		t.Fatal(err)
	}
	if by, err := guard.SpentBy(ctx, parentID.String(), 0); err != nil || by != childID.String() {
		t.Fatalf("spend guard = %q (%v), want %s", by, err, childID)
	}
}

// TestAppliedAdmissionProofDerivesOutputsFromTheEngine is FIX C: the engine's
// own applied-transaction record plus its stored outputs are enough to
// re-sign an admission whose mandalaAdmissions row never existed.
func TestAppliedAdmissionProofDerivesOutputsFromTheEngine(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_proof",
		ServerPrivKeyHex: testPrivHex,
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
	})
	if err != nil {
		t.Fatal("Build:", err)
	}
	t.Cleanup(func() {
		cleanupCtx := context.Background()
		_ = app.Mongo.Drop(cleanupCtx)
		_ = app.Mongo.Client().Disconnect(cleanupCtx)
	})
	if app.AppliedAdmissionProof == nil {
		t.Fatal("AppliedAdmissionProof must always be wired")
	}

	const topic = "tm_mandala"
	tx := wiringTestTx(t, nil, 0, 3, 0x81)
	txid := tx.TxID()

	applied, outputs, err := app.AppliedAdmissionProof(ctx, txid.String())
	if err != nil || applied || len(outputs) != 0 {
		t.Fatalf("unknown txid: applied=%v outputs=%v err=%v", applied, outputs, err)
	}
	// A malformed txid is "not applied", never an error.
	if applied, _, err := app.AppliedAdmissionProof(ctx, "not-a-txid"); err != nil || applied {
		t.Fatalf("malformed txid: applied=%v err=%v", applied, err)
	}

	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{2, 0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: topic}); err != nil {
		t.Fatal(err)
	}
	applied, outputs, err = app.AppliedAdmissionProof(ctx, txid.String())
	if err != nil || !applied {
		t.Fatalf("applied=%v err=%v", applied, err)
	}
	if len(outputs) != 2 || outputs[0] != 0 || outputs[1] != 2 {
		t.Fatalf("outputs = %v, want [0 2]", outputs)
	}
}

// TestBuildArcadeEvictTxPurgesAdminHistory — 2026-09-21 incident: eviction
// restored the inputs but left the evicted tx's admin-history row behind, so
// PickAssetAuthHead kept naming the evicted tx as the live auth head and the
// asset state kept its folded (never-mined) action. Eviction must delete the
// rows and rebuild the state — and must do so on a REPEAT callback too, since
// the production heads were stuck behind an eviction that had already been
// stamped before this fix existed.
func TestBuildArcadeEvictTxPurgesAdminHistory(t *testing.T) {
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_evict_history",
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
	parent := wiringTestTx(t, nil, 0, 1, 0x62)
	parentID := parent.TxID()
	parentStr := parentID.String()
	child := wiringTestTx(t, parent, 0, 1, 0)
	childID := child.TxID()
	childStr := childID.String()
	assetID := parentStr + ".0"
	issuer := "03" + "ab"[:2] + parentStr[:62]

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
	// Admin chain: parent.0 registered the asset (seq 1); child.0 paused it
	// (seq 2) and is the current head + the folded state.
	for _, e := range []mandala.AdminHistoryEntry{
		{AssetID: assetID, Txid: parentStr, OutputIndex: 0, Height: 9007199254740991, AdmitSeq: 1,
			ActionDetails: mandala.ActionDetails{"kind": "register", "assetId": assetID, "issuer": issuer}, CreatedAt: time.Now()},
		{AssetID: assetID, Txid: childStr, OutputIndex: 0, Height: 9007199254740991, AdmitSeq: 2,
			ActionDetails: mandala.ActionDetails{"kind": "pause", "assetId": assetID, "priorOutpoint": assetID}, CreatedAt: time.Now()},
	} {
		if err := app.Store.AppendAdminHistory(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.Store.PutAssetState(ctx, mandala.AssetAdminState{
		AssetID: assetID, IssuerIdentityKey: issuer, IsPaused: true, AccessMode: "denylist",
		BlockedIdentities: []string{}, AllowedIdentities: []string{}, FrozenOutpoints: []mandala.FrozenRef{}, EvictedOutpoints: []string{},
		LastProcessedHeight: 9007199254740991, LastAdmitSeq: 2,
	}); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.RecordAdmission(ctx, mandala.AdmissionRecord{
		Txid: childStr, Topics: []string{topic}, OutputsToAdmit: []uint32{0},
		AdmissionSignature: "3044", AdmissionIdentityKey: "02aa",
		Restore: &mandala.RestoreSnapshot{SpentOutpoints: []string{assetID}},
	}); err != nil {
		t.Fatal(err)
	}
	// The production case: already stamped by an eviction that predates the
	// history purge. The repeat must still purge.
	if err := app.Store.MarkEvicted(ctx, childStr); err != nil {
		t.Fatal(err)
	}

	out, err := app.EvictTx(ctx, childStr)
	if err != nil {
		t.Fatal("EvictTx:", err)
	}
	if !out.AlreadyEvicted {
		t.Fatalf("expected the repeat eviction to report alreadyEvicted, got %+v", out)
	}

	rows, err := app.Store.FindAdminHistoryByAssetID(ctx, assetID)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Txid != parentStr {
		t.Fatalf("admin history after eviction = %+v, want only the register row", rows)
	}
	head, ok := mandala.PickAssetAuthHead(rows)
	if !ok || head.Txid != parentStr || head.OutputIndex != 0 {
		t.Fatalf("auth head after eviction = %+v (%v), want %s.0", head, ok, parentStr)
	}
	state, err := app.Store.GetAssetState(ctx, assetID)
	if err != nil {
		t.Fatal(err)
	}
	if state.IsPaused || state.LastAdmitSeq != 1 || state.IssuerIdentityKey != issuer {
		t.Fatalf("asset state after eviction = %+v, want unpaused, seq 1, issuer kept", state)
	}
}

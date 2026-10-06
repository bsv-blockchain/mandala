package wiring

// FIX E never-clobber, Go side — the mirror of overlay/src/eviction.test.ts's
// "never clobbers a live spend" cases.
//
// A token row is handed back only for a coin that is live again: one this
// eviction unmarked, or one already unspent (an earlier, partly failed attempt
// unmarked it). A coin spent by another live transaction keeps no row, a
// snapshot outpoint the engine has no output for gets none, and a repeat
// terminal callback restores nothing at all. Before this, EvictTx restored
// every snapshot row unconditionally: a re-delivery after the coin was
// legitimately re-spent re-inserted its row and re-credited the holder — a
// phantom row and a double balance credit that nothing repairs.

import (
	"context"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalav2"
)

const evictHolder = "02evictholder"

type evictFixture struct {
	app      *App
	parentID *chainhash.Hash
	childID  *chainhash.Hash
	child    string
}

// evictFixtureFor builds the state an admitted child leaves behind: it spent
// parent:0 (engine mark by the child; the lookup deleted the coin's 40-unit
// row and debited the holder), and its admission record carries the
// pre-spend snapshot.
func evictFixtureFor(t *testing.T, name string, fill byte) *evictFixture {
	t.Helper()
	requireMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	app, err := Build(ctx, Config{
		NodeName:         "mandala_wiring_test_" + name,
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
	parent := wiringTestTx(t, nil, 0, 1, fill)
	parentID := parent.TxID()
	child := wiringTestTx(t, parent, 0, 1, 0)
	childID := child.TxID()
	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, tokenTopic, parentID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertOutputs(ctx, tokenTopic, childID, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: childID, Topic: tokenTopic}); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *parentID, Index: 0}}, tokenTopic, childID); err != nil {
		t.Fatal(err)
	}
	if err := app.Store.RecordAdmission(ctx, mandalav2.AdmissionRecord{
		Txid:                 childID.String(),
		Topics:               []string{tokenTopic},
		OutputsToAdmit:       []uint32{0},
		AdmissionSignature:   "3044",
		AdmissionIdentityKey: "02aa",
		Restore: &mandalav2.RestoreSnapshot{
			SpentOutpoints: []string{parentID.String() + ".0"},
			TokenRows:      []mandalav2.TokenRow{evictRow(parentID.String(), 0)},
		},
	}); err != nil {
		t.Fatal(err)
	}
	return &evictFixture{app: app, parentID: parentID, childID: childID, child: childID.String()}
}

func evictRow(txid string, vout uint32) mandalav2.TokenRow {
	return mandalav2.TokenRow{Txid: txid, OutputIndex: vout, AssetID: "a.0", Amount: 40, IdentityKey: evictHolder, CreatedAt: time.Now()}
}

func (f *evictFixture) balance(t *testing.T) int64 {
	t.Helper()
	b, err := f.app.Store.GetBalance(context.Background(), evictHolder)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (f *evictFixture) parentRow(t *testing.T) *mandalav2.TokenRow {
	t.Helper()
	r, err := f.app.Store.GetTokenRow(context.Background(), f.parentID.String(), 0)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// The review's sequence: A is evicted (X unmarked, row restored, holder
// credited); B then legitimately spends X (row deleted, holder debited);
// Arcade — or an operator following the 2026-09-21 runbook — re-delivers A's
// terminal status. The repeat must restore nothing.
func TestEvictTxRedeliveryAfterARespendRestoresNothing(t *testing.T) {
	f := evictFixtureFor(t, "evict_redeliver", 0x81)
	ctx := context.Background()

	out, err := f.app.EvictTx(ctx, f.child)
	if err != nil {
		t.Fatal("EvictTx:", err)
	}
	if out.RestoredOutpoints != 1 || out.RestoredTokenRows != 1 || out.AlreadyEvicted {
		t.Fatalf("first eviction outcome = %+v, want 1/1/false", out)
	}
	if f.parentRow(t) == nil || f.balance(t) != 40 {
		t.Fatalf("first eviction must restore the row and credit 40: row=%v balance=%d", f.parentRow(t), f.balance(t))
	}

	// B spends X: engine mark by B, then the lookup's OutputSpent.
	b := wiringTestTx(t, nil, 0, 1, 0x82).TxID()
	if err := f.app.Engine.Storage.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *f.parentID, Index: 0}}, tokenTopic, b); err != nil {
		t.Fatal(err)
	}
	if err := f.app.Store.AdjustBalance(ctx, evictHolder, -40); err != nil {
		t.Fatal(err)
	}
	if err := f.app.Store.DeleteToken(ctx, f.parentID.String(), 0); err != nil {
		t.Fatal(err)
	}

	again, err := f.app.EvictTx(ctx, f.child)
	if err != nil {
		t.Fatal("re-delivered EvictTx:", err)
	}
	if !again.AlreadyEvicted || again.RestoredOutpoints != 0 || again.RestoredTokenRows != 0 {
		t.Fatalf("re-delivery outcome = %+v, want alreadyEvicted with nothing restored (TS reports 0/0/true)", again)
	}
	if r := f.parentRow(t); r != nil {
		t.Fatalf("re-delivery minted a phantom row for a coin B spent: %+v", r)
	}
	if got := f.balance(t); got != 0 {
		t.Fatalf("balance after re-delivery = %d, want 0 (no second credit)", got)
	}
	if by, err := f.app.EngineStore.SpendStateOf(ctx, tokenTopic, f.parentID.String(), 0); err != nil || by != b.String() {
		t.Fatalf("X must still be spent by B, got %q (%v)", by, err)
	}
}

// A coin another live tx holds at eviction time is neither unmarked nor given
// a row (TS: "never clobbers a live spend").
func TestEvictTxNeverClobbersALiveSpend(t *testing.T) {
	f := evictFixtureFor(t, "evict_clobber", 0x83)
	ctx := context.Background()

	// The child's mark was released and B took the coin.
	if _, err := f.app.EngineStore.UnmarkSpentBySpendTxid(ctx, f.child); err != nil {
		t.Fatal(err)
	}
	b := wiringTestTx(t, nil, 0, 1, 0x84).TxID()
	if err := f.app.Engine.Storage.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{{Txid: *f.parentID, Index: 0}}, tokenTopic, b); err != nil {
		t.Fatal(err)
	}

	out, err := f.app.EvictTx(ctx, f.child)
	if err != nil {
		t.Fatal("EvictTx:", err)
	}
	if out.RestoredOutpoints != 0 || out.RestoredTokenRows != 0 || out.AlreadyEvicted {
		t.Fatalf("outcome = %+v, want 0/0/false", out)
	}
	if r := f.parentRow(t); r != nil {
		t.Fatalf("a coin spent by a live tx got a token row back: %+v", r)
	}
	if f.balance(t) != 0 {
		t.Fatalf("balance = %d, want 0", f.balance(t))
	}
	if by, _ := f.app.EngineStore.SpendStateOf(ctx, tokenTopic, f.parentID.String(), 0); by != b.String() {
		t.Fatalf("X must stay spent by B, got %q", by)
	}
	rec, err := f.app.Store.GetAdmission(ctx, f.child)
	if err != nil || rec == nil || rec.EvictedAt == "" {
		t.Fatalf("eviction must still be stamped: %+v %v", rec, err)
	}
}

// An earlier attempt unmarked the coin and then failed before the restore:
// the retry finds nothing to unmark but the coin is live, so its row comes
// back (TS: "a retry after a partial failure still restores the token row of
// a coin the first attempt unmarked").
func TestEvictTxRetryRestoresACoinAnEarlierAttemptUnmarked(t *testing.T) {
	f := evictFixtureFor(t, "evict_retry", 0x85)
	ctx := context.Background()
	if _, err := f.app.EngineStore.UnmarkSpentBySpendTxid(ctx, f.child); err != nil {
		t.Fatal(err)
	}

	out, err := f.app.EvictTx(ctx, f.child)
	if err != nil {
		t.Fatal("EvictTx:", err)
	}
	if out.RestoredOutpoints != 0 || out.RestoredTokenRows != 1 {
		t.Fatalf("outcome = %+v, want 0 unmarked, 1 row restored", out)
	}
	if f.parentRow(t) == nil || f.balance(t) != 40 {
		t.Fatalf("row=%v balance=%d, want the row back and 40 credited", f.parentRow(t), f.balance(t))
	}
}

// A snapshot outpoint the engine holds no output for is not live: no row.
// (SpendStateOf reads a missing document as "", which is why the restore uses
// IsUnspent.)
func TestEvictTxRestoresNoRowForAnOutpointTheEngineDoesNotHold(t *testing.T) {
	f := evictFixtureFor(t, "evict_missing", 0x86)
	ctx := context.Background()
	ghost := wiringTestTx(t, nil, 0, 1, 0x87).TxID().String()
	if err := f.app.Store.RecordAdmission(ctx, mandalav2.AdmissionRecord{
		Txid: f.child, Topics: []string{tokenTopic}, OutputsToAdmit: []uint32{0},
		AdmissionSignature: "3044", AdmissionIdentityKey: "02aa",
		Restore: &mandalav2.RestoreSnapshot{
			SpentOutpoints: []string{f.parentID.String() + ".0", ghost + ".0"},
			TokenRows:      []mandalav2.TokenRow{evictRow(f.parentID.String(), 0), evictRow(ghost, 0)},
		},
	}); err != nil {
		t.Fatal(err)
	}

	out, err := f.app.EvictTx(ctx, f.child)
	if err != nil {
		t.Fatal("EvictTx:", err)
	}
	if out.RestoredTokenRows != 1 {
		t.Fatalf("restoredTokenRows = %d, want 1 (the ghost outpoint is not live)", out.RestoredTokenRows)
	}
	if r, _ := f.app.Store.GetTokenRow(ctx, ghost, 0); r != nil {
		t.Fatalf("phantom row restored for an outpoint the engine does not hold: %+v", r)
	}
	if f.balance(t) != 40 {
		t.Fatalf("balance = %d, want 40 (the real coin only)", f.balance(t))
	}
}

// restoredTokenRows counts the rows handed to the (idempotent) restore — the
// restorable set — exactly as TS counts them, so a row that is already back
// from an earlier attempt still counts and the 200 body matches across stacks.
func TestEvictTxCountsRestorableRowsEvenWhenAlreadyPresent(t *testing.T) {
	f := evictFixtureFor(t, "evict_count", 0x88)
	ctx := context.Background()
	if err := f.app.Store.RestoreTokens(ctx, []mandalav2.TokenRow{evictRow(f.parentID.String(), 0)}); err != nil {
		t.Fatal(err)
	}
	out, err := f.app.EvictTx(ctx, f.child)
	if err != nil {
		t.Fatal("EvictTx:", err)
	}
	if out.RestoredOutpoints != 1 || out.RestoredTokenRows != 1 {
		t.Fatalf("outcome = %+v, want 1/1", out)
	}
	if f.balance(t) != 40 {
		t.Fatalf("balance = %d, want 40 (credited once, by the earlier restore)", f.balance(t))
	}
}

// The crash-window retry, end to end on the Go side: the admitting attempt's
// records carry a snapshot without X's row (the crashed attempt's OutputSpent
// already deleted it), yet the eviction still puts the row back, because the
// store merges into the first attempt's snapshot instead of replacing it.
func TestEvictTxAfterACrashRetryStillRestoresTheRow(t *testing.T) {
	f := evictFixtureFor(t, "evict_crash_retry", 0x89)
	ctx := context.Background()
	degraded := &mandalav2.RestoreSnapshot{SpentOutpoints: []string{f.parentID.String() + ".0"}, TokenRows: []mandalav2.TokenRow{}}
	for _, pending := range []bool{true, false} {
		rec := mandalav2.AdmissionRecord{Txid: f.child, Topics: []string{tokenTopic}, Pending: pending, Restore: degraded}
		if !pending {
			rec.OutputsToAdmit, rec.AdmissionSignature, rec.AdmissionIdentityKey = []uint32{0}, "3044", "02aa"
		}
		if err := f.app.Store.RecordAdmission(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	out, err := f.app.EvictTx(ctx, f.child)
	if err != nil {
		t.Fatal("EvictTx:", err)
	}
	if out.RestoredTokenRows != 1 || f.parentRow(t) == nil || f.balance(t) != 40 {
		t.Fatalf("outcome %+v row %v balance %d: the first snapshot's row must come back", out, f.parentRow(t), f.balance(t))
	}
}

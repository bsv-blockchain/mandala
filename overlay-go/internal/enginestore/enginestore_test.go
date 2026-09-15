package enginestore

// Task 12 tests: in-repo Mongo implementation of go-overlay-services v1.3.2
// engine.Storage. Every test exercises the storage exactly the way
// engine.go's call sites do (positional FindOutputs, nil-on-missing
// FindOutput, LoadAncillaryBeef merge, ReconcileMerkleRoot state moves).
//
// Requires Mongo at localhost:27017 (same skip-pattern as Task 8; test db
// mandala_go_engine_test is dropped in cleanup).

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const topic = "tm_mandala"

// topicVar is an addressable copy of topic for FindOutput's *string param.
var topicVar = topic

func testDB(t *testing.T) *mongo.Database {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://localhost:27017"))
	if err != nil {
		t.Skip("mongo unavailable:", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		t.Skip("mongo unavailable:", err)
	}
	db := client.Database("mandala_go_engine_test")
	// Drop up-front too so a crashed previous run can't leak state in.
	_ = db.Drop(context.Background())
	t.Cleanup(func() { _ = db.Drop(context.Background()) })
	return db
}

// newTx builds a distinct minimal transaction: one dummy input (fill byte
// makes txids differ) and n outputs.
func newTx(fill byte, outputs int) *transaction.Transaction {
	tx := transaction.NewTransaction()
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = fill
	}
	h, err := chainhash.NewHash(raw)
	if err != nil {
		panic(err)
	}
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID:       h,
		SourceTxOutIndex: 0,
		UnlockingScript:  &script.Script{},
	})
	for i := 0; i < outputs; i++ {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(i + 1), LockingScript: &script.Script{}})
	}
	return tx
}

// addProof attaches a single-leaf merkle path (a 1-tx block) at the given
// height and returns the merkle root the path computes.
func addProof(t *testing.T, tx *transaction.Transaction, height uint32) *chainhash.Hash {
	t.Helper()
	txid := tx.TxID()
	isTxid := true
	tx.MerklePath = transaction.NewMerklePath(height, [][]*transaction.PathElement{
		{{Offset: 0, Hash: txid, Txid: &isTxid}},
	})
	root, err := tx.MerklePath.ComputeRoot(txid)
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func beefFor(t *testing.T, txs ...*transaction.Transaction) *transaction.Beef {
	t.Helper()
	beef := transaction.NewBeefV2()
	for _, tx := range txs {
		if _, err := beef.MergeTransaction(tx); err != nil {
			t.Fatal(err)
		}
	}
	return beef
}

func op(txid *chainhash.Hash, vout uint32) *transaction.Outpoint {
	return &transaction.Outpoint{Txid: *txid, Index: vout}
}

// mustNew builds a Store and fails the test if index creation does not succeed
// — New aborts on that (wire contract §9.9), so tests must too rather than
// running against a half-indexed database.
func mustNew(t *testing.T, db *mongo.Database) *Store {
	t.Helper()
	st, err := New(db)
	if err != nil {
		t.Fatalf("enginestore.New: %v", err)
	}
	return st
}

// --- insert / find group ---

func TestInsertAndFind(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	tx := newTx(0x01, 2)
	root := addProof(t, tx, 100)
	txid := tx.TxID()
	consumed := op(tx.Inputs[0].SourceTXID, 0)

	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0, 1}, []*transaction.Outpoint{consumed}, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	// Empty admit list must be a no-op, not an error (engine calls
	// InsertOutputs even for topics with zero OutputsToAdmit).
	if err := st.InsertOutputs(ctx, topic, txid, nil, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal("empty InsertOutputs:", err)
	}

	// FindOutput with topic + BEEF (hydrateOneFormula shape uses topic=nil).
	got, err := st.FindOutput(ctx, op(txid, 0), nil, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Fatal("output not found")
	}
	if got.Topic != topic || got.Spent || got.Outpoint.Index != 0 || !got.Outpoint.Txid.Equal(*txid) {
		t.Fatalf("bad output: %+v", got)
	}
	if got.Beef == nil || got.Beef.FindTransactionByHash(txid) == nil {
		t.Fatal("BEEF did not round-trip through storage")
	}
	if len(got.OutputsConsumed) != 1 || !got.OutputsConsumed[0].Equal(consumed) {
		t.Fatalf("outputsConsumed: %+v", got.OutputsConsumed)
	}
	if got.MerkleState != engine.MerkleStateValidated {
		t.Fatalf("mined output state = %v, want Validated", got.MerkleState)
	}
	if got.MerkleRoot == nil || !got.MerkleRoot.Equal(*root) {
		t.Fatalf("merkleRoot = %v, want %v", got.MerkleRoot, root)
	}
	if got.BlockHeight != 100 {
		t.Fatalf("blockHeight = %d, want 100", got.BlockHeight)
	}
	if got.Score == 0 {
		t.Fatal("score not assigned on insert")
	}

	// includeBEEF=false must leave Beef nil (deleteUTXODeep path).
	got, err = st.FindOutput(ctx, op(txid, 0), &[]string{topic}[0], nil, false)
	if err != nil || got == nil {
		t.Fatal(got, err)
	}
	if got.Beef != nil {
		t.Fatal("Beef must be nil when includeBEEF=false")
	}

	// Missing output: engine expects (nil, nil), not an error.
	missing := newTx(0x02, 1).TxID()
	if got, err = st.FindOutput(ctx, op(missing, 0), nil, nil, true); err != nil || got != nil {
		t.Fatalf("missing output: got %+v err %v, want nil,nil", got, err)
	}

	// spent filter mismatch also returns nil.
	spent := true
	if got, err = st.FindOutput(ctx, op(txid, 0), nil, &spent, false); err != nil || got != nil {
		t.Fatalf("spent-filter: got %+v err %v, want nil,nil", got, err)
	}

	// FindOutputs is positional: result[i] pairs with outpoints[i], nil for
	// missing (mergeExistingOutputs indexes the result by vin).
	batch, err := st.FindOutputs(ctx, []*transaction.Outpoint{op(missing, 0), op(txid, 1)}, topic, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(batch) != 2 {
		t.Fatalf("batch len = %d, want 2 (positional)", len(batch))
	}
	if batch[0] != nil {
		t.Fatal("batch[0] must be nil for missing outpoint")
	}
	if batch[1] == nil || batch[1].Outpoint.Index != 1 || batch[1].Beef == nil {
		t.Fatalf("batch[1]: %+v", batch[1])
	}

	// FindOutputsForTransaction spans all outputs of the txid.
	all, err := st.FindOutputsForTransaction(ctx, txid, false)
	if err != nil || len(all) != 2 {
		t.Fatalf("forTransaction: %d outputs, err %v", len(all), err)
	}
}

func TestFindUTXOsForTopic(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	tx1 := newTx(0x03, 1)
	if err := st.InsertOutputs(ctx, topic, tx1.TxID(), []uint32{0}, nil, beefFor(t, tx1), nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond) // distinct scores
	tx2 := newTx(0x04, 1)
	if err := st.InsertOutputs(ctx, topic, tx2.TxID(), []uint32{0}, nil, beefFor(t, tx2), nil); err != nil {
		t.Fatal(err)
	}

	utxos, err := st.FindUTXOsForTopic(ctx, topic, 0, 0, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(utxos) != 2 {
		t.Fatalf("utxos = %d, want 2", len(utxos))
	}
	if utxos[0].Score >= utxos[1].Score {
		t.Fatalf("not sorted ascending by score: %f %f", utxos[0].Score, utxos[1].Score)
	}
	if utxos[0].Beef == nil {
		t.Fatal("includeBEEF=true must hydrate Beef")
	}

	// since is an exclusive lower bound on score (GASP paging resumes after
	// the last seen interaction score).
	utxos, err = st.FindUTXOsForTopic(ctx, topic, utxos[0].Score, 0, false)
	if err != nil || len(utxos) != 1 || !utxos[0].Outpoint.Txid.Equal(*tx2.TxID()) {
		t.Fatalf("since-filter: %+v err %v", utxos, err)
	}

	// limit
	utxos, err = st.FindUTXOsForTopic(ctx, topic, 0, 1, false)
	if err != nil || len(utxos) != 1 {
		t.Fatalf("limit: %d err %v", len(utxos), err)
	}

	// spent outputs are not UTXOs.
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(tx1.TxID(), 0)}, topic, tx2.TxID()); err != nil {
		t.Fatal(err)
	}
	utxos, err = st.FindUTXOsForTopic(ctx, topic, 0, 0, false)
	if err != nil || len(utxos) != 1 || !utxos[0].Outpoint.Txid.Equal(*tx2.TxID()) {
		t.Fatalf("after spend: %+v err %v", utxos, err)
	}

	// other topic sees nothing.
	utxos, err = st.FindUTXOsForTopic(ctx, "tm_other", 0, 0, false)
	if err != nil || len(utxos) != 0 {
		t.Fatalf("other topic: %d err %v", len(utxos), err)
	}
}

// --- spend / consume group ---

func TestSpendAndConsumedBy(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	parent := newTx(0x05, 2)
	parentID := parent.TxID()
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0, 1}, nil, beefFor(t, parent), nil); err != nil {
		t.Fatal(err)
	}

	child := newTx(0x06, 1)
	childID := child.TxID()

	// Engine flow for a submit consuming parent:0 with coinsToRetain=[0]:
	// MarkUTXOsAsSpent -> InsertOutputs(child, outpointsConsumed=[parent:0])
	// -> UpdateConsumedBy(parent:0, [child:0]).
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(parentID, 0)}, topic, childID); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertOutputs(ctx, topic, childID, []uint32{0}, []*transaction.Outpoint{op(parentID, 0)}, beefFor(t, parent, child), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateConsumedBy(ctx, op(parentID, 0), topic, []*transaction.Outpoint{op(childID, 0)}); err != nil {
		t.Fatal(err)
	}

	got, err := st.FindOutput(ctx, op(parentID, 0), nil, nil, false)
	if err != nil || got == nil {
		t.Fatal(got, err)
	}
	if !got.Spent {
		t.Fatal("parent:0 must be spent")
	}
	if len(got.ConsumedBy) != 1 || !got.ConsumedBy[0].Equal(op(childID, 0)) {
		t.Fatalf("consumedBy: %+v", got.ConsumedBy)
	}

	// The retained coin was NOT deleted: history hydration must still walk
	// child.OutputsConsumed -> parent:0.
	kid, err := st.FindOutput(ctx, op(childID, 0), nil, nil, false)
	if err != nil || kid == nil {
		t.Fatal(kid, err)
	}
	if len(kid.OutputsConsumed) != 1 || !kid.OutputsConsumed[0].Equal(op(parentID, 0)) {
		t.Fatalf("outputsConsumed: %+v", kid.OutputsConsumed)
	}

	// parent:1 untouched by the batch spend.
	other, err := st.FindOutput(ctx, op(parentID, 1), nil, nil, false)
	if err != nil || other == nil || other.Spent {
		t.Fatalf("parent:1: %+v err %v", other, err)
	}

	// UpdateConsumedBy replaces the whole list (engine passes the full
	// updated slice, including on deleteUTXODeep shrink).
	if err := st.UpdateConsumedBy(ctx, op(parentID, 0), topic, nil); err != nil {
		t.Fatal(err)
	}
	got, _ = st.FindOutput(ctx, op(parentID, 0), nil, nil, false)
	if len(got.ConsumedBy) != 0 {
		t.Fatalf("consumedBy after clear: %+v", got.ConsumedBy)
	}
}

// --- merkle-state group ---

func TestMerkleStateLifecycle(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	// tx1 mined at 100 (root R1), tx2 claims height 100 with a different
	// root, tx3 unmined.
	tx1 := newTx(0x07, 1)
	root1 := addProof(t, tx1, 100)
	tx2 := newTx(0x08, 1)
	root2 := addProof(t, tx2, 100)
	tx3 := newTx(0x09, 1)

	for _, tx := range []*transaction.Transaction{tx1, tx2, tx3} {
		if err := st.InsertOutputs(ctx, topic, tx.TxID(), []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
			t.Fatal(err)
		}
	}
	if root1.Equal(*root2) {
		t.Fatal("test setup: roots must differ")
	}

	// Unmined output starts Unmined.
	got, err := st.FindOutput(ctx, op(tx3.TxID(), 0), nil, nil, false)
	if err != nil || got == nil || got.MerkleState != engine.MerkleStateUnmined {
		t.Fatalf("tx3 state: %+v err %v", got, err)
	}

	// ReconcileMerkleRoot(topic, 100, root1): matching -> Validated,
	// non-matching -> Invalidated, null roots stay Unmined.
	if err := st.ReconcileMerkleRoot(ctx, topic, 100, root1); err != nil {
		t.Fatal(err)
	}
	assertState := func(txid *chainhash.Hash, want engine.MerkleState) {
		t.Helper()
		o, err := st.FindOutput(ctx, op(txid, 0), nil, nil, false)
		if err != nil || o == nil {
			t.Fatal(o, err)
		}
		if o.MerkleState != want {
			t.Fatalf("state = %v, want %v", o.MerkleState, want)
		}
	}
	assertState(tx1.TxID(), engine.MerkleStateValidated)
	assertState(tx2.TxID(), engine.MerkleStateInvalidated)
	assertState(tx3.TxID(), engine.MerkleStateUnmined)

	// SyncInvalidatedOutputs pages invalidated outpoints (outpoints only).
	ops, err := st.FindOutpointsByMerkleState(ctx, topic, engine.MerkleStateInvalidated, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 1 || !ops[0].Equal(op(tx2.TxID(), 0)) {
		t.Fatalf("invalidated outpoints: %+v", ops)
	}
	// limit is respected.
	ops, err = st.FindOutpointsByMerkleState(ctx, topic, engine.MerkleStateUnmined, 1)
	if err != nil || len(ops) != 1 {
		t.Fatalf("unmined limit: %+v err %v", ops, err)
	}

	// HandleNewMerkleProof flow: UpdateTransactionBEEF with a re-proved tx2
	// (now at the honest root height 101), then UpdateOutputBlockHeight.
	newRoot := addProof(t, tx2, 101)
	if err := st.UpdateTransactionBEEF(ctx, tx2.TxID(), beefFor(t, tx2)); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateOutputBlockHeight(ctx, op(tx2.TxID(), 0), topic, 101, 7); err != nil {
		t.Fatal(err)
	}
	got, err = st.FindOutput(ctx, op(tx2.TxID(), 0), nil, nil, true)
	if err != nil || got == nil {
		t.Fatal(got, err)
	}
	if got.BlockHeight != 101 || got.BlockIdx != 7 {
		t.Fatalf("block info: h=%d idx=%d", got.BlockHeight, got.BlockIdx)
	}
	if got.Beef == nil || got.Beef.FindBumpByHash(tx2.TxID()) == nil {
		t.Fatal("updated BEEF must carry the new proof")
	}
	// Reconcile at 101 with the new root validates it again.
	if err := st.ReconcileMerkleRoot(ctx, topic, 101, newRoot); err != nil {
		t.Fatal(err)
	}
	assertState(tx2.TxID(), engine.MerkleStateValidated)
}

// --- applied-tx group ---

func TestAppliedTransactions(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	txid := newTx(0x0a, 1).TxID()
	rec := &overlay.AppliedTransaction{Txid: txid, Topic: topic}

	exists, err := st.DoesAppliedTransactionExist(ctx, rec)
	if err != nil || exists {
		t.Fatalf("pre-insert exists=%v err=%v", exists, err)
	}
	if err := st.InsertAppliedTransaction(ctx, rec); err != nil {
		t.Fatal(err)
	}
	exists, err = st.DoesAppliedTransactionExist(ctx, rec)
	if err != nil || !exists {
		t.Fatalf("post-insert exists=%v err=%v", exists, err)
	}
	// Re-insert of the same (topic, txid) is idempotent, not an error.
	if err := st.InsertAppliedTransaction(ctx, rec); err != nil {
		t.Fatal("duplicate insert must be idempotent:", err)
	}
	// Same txid under a different topic is a distinct record.
	exists, err = st.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: "tm_other"})
	if err != nil || exists {
		t.Fatalf("other-topic exists=%v err=%v", exists, err)
	}
}

// --- delete group ---

func TestDeleteOutput(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	tx := newTx(0x0b, 2)
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0, 1}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteOutput(ctx, op(txid, 0), topic); err != nil {
		t.Fatal(err)
	}
	if got, err := st.FindOutput(ctx, op(txid, 0), nil, nil, false); err != nil || got != nil {
		t.Fatalf("deleted output still found: %+v err %v", got, err)
	}
	// Sibling untouched.
	if got, err := st.FindOutput(ctx, op(txid, 1), nil, nil, false); err != nil || got == nil {
		t.Fatalf("sibling: %+v err %v", got, err)
	}
	// Deleting a missing output is not an error (deleteUTXODeep tolerance).
	if err := st.DeleteOutput(ctx, op(txid, 0), topic); err != nil {
		t.Fatal("double delete:", err)
	}
}

// --- BEEF round-trip / ancillary group ---

func TestLoadAncillaryBeef(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	anc := newTx(0x0c, 1) // ancillary tx admitted on its own earlier
	ancID := anc.TxID()
	if err := st.InsertOutputs(ctx, topic, ancID, []uint32{0}, nil, beefFor(t, anc), nil); err != nil {
		t.Fatal(err)
	}

	// Case 1: ancillary tx NOT inside the output's own BEEF -> merged from
	// storage by txid.
	tx := newTx(0x0d, 1)
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0}, nil, beefFor(t, tx), []*chainhash.Hash{ancID}); err != nil {
		t.Fatal(err)
	}
	got, err := st.FindOutput(ctx, op(txid, 0), nil, nil, true)
	if err != nil || got == nil {
		t.Fatal(got, err)
	}
	if len(got.AncillaryTxids) != 1 || !got.AncillaryTxids[0].Equal(*ancID) {
		t.Fatalf("ancillaryTxids did not round-trip: %+v", got.AncillaryTxids)
	}
	if got.Beef.FindTransactionByHash(ancID) != nil {
		t.Fatal("test setup: ancillary must not already be in the beef")
	}
	if err := st.LoadAncillaryBeef(ctx, got); err != nil {
		t.Fatal(err)
	}
	if got.Beef.FindTransactionByHash(ancID) == nil {
		t.Fatal("LoadAncillaryBeef must merge the ancillary tx into Beef")
	}

	// Case 2: ancillary already inside the BEEF -> no-op success.
	tx2 := newTx(0x0e, 1)
	if err := st.InsertOutputs(ctx, topic, tx2.TxID(), []uint32{0}, nil, beefFor(t, tx2, anc), []*chainhash.Hash{ancID}); err != nil {
		t.Fatal(err)
	}
	got2, err := st.FindOutput(ctx, op(tx2.TxID(), 0), nil, nil, true)
	if err != nil || got2 == nil {
		t.Fatal(got2, err)
	}
	if err := st.LoadAncillaryBeef(ctx, got2); err != nil {
		t.Fatal(err)
	}
	if got2.Beef.FindTransactionByHash(ancID) == nil {
		t.Fatal("ancillary tx missing after LoadAncillaryBeef")
	}

	// Case 3: ancillary txid known nowhere -> error (the full BEEF cannot be
	// assembled, and the engine treats that as fatal for the lookup).
	ghost := newTx(0x0f, 1).TxID()
	tx3 := newTx(0x10, 1)
	if err := st.InsertOutputs(ctx, topic, tx3.TxID(), []uint32{0}, nil, beefFor(t, tx3), []*chainhash.Hash{ghost}); err != nil {
		t.Fatal(err)
	}
	got3, err := st.FindOutput(ctx, op(tx3.TxID(), 0), nil, nil, true)
	if err != nil || got3 == nil {
		t.Fatal(got3, err)
	}
	if err := st.LoadAncillaryBeef(ctx, got3); err == nil {
		t.Fatal("missing ancillary beef must error")
	}

	// No ancillary txids -> nil fast path (every hydrateOneFormula call).
	gotAnc, err := st.FindOutput(ctx, op(ancID, 0), nil, nil, true)
	if err != nil || gotAnc == nil {
		t.Fatal(gotAnc, err)
	}
	if err := st.LoadAncillaryBeef(ctx, gotAnc); err != nil {
		t.Fatal(err)
	}
}

// --- last-interaction group (GASP bookkeeping; GASP is off but the
// interface must still behave) ---

func TestLastInteraction(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	score, err := st.GetLastInteraction(ctx, "https://peer.example", topic)
	if err != nil || score != 0 {
		t.Fatalf("empty score = %f err %v, want 0", score, err)
	}
	if err := st.UpdateLastInteraction(ctx, "https://peer.example", topic, 42.5); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateLastInteraction(ctx, "https://peer.example", topic, 99); err != nil {
		t.Fatal(err)
	}
	score, err = st.GetLastInteraction(ctx, "https://peer.example", topic)
	if err != nil || score != 99 {
		t.Fatalf("score = %f err %v, want 99", score, err)
	}
	// Distinct (host, topic) key.
	score, err = st.GetLastInteraction(ctx, "https://peer.example", "tm_other")
	if err != nil || score != 0 {
		t.Fatalf("other-topic score = %f err %v, want 0", score, err)
	}
}

// --- unique index guard ---

func TestUniqueIndexes(t *testing.T) {
	ctx := context.Background()
	db := testDB(t)
	st := mustNew(t, db)

	tx := newTx(0x11, 1)
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	// Re-insert of the same (topic, txid, vout) must not create a second doc
	// (unique index topic+txid+outputIndex; upsert semantics).
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	n, err := db.Collection("engineOutputs").CountDocuments(ctx, map[string]any{"txid": txid.String()})
	if err != nil || n != 1 {
		t.Fatalf("docs = %d err %v, want 1", n, err)
	}
	// Same outpoint under another topic is a separate document.
	if err := st.InsertOutputs(ctx, "tm_other", txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	n, _ = db.Collection("engineOutputs").CountDocuments(ctx, map[string]any{"txid": txid.String()})
	if n != 2 {
		t.Fatalf("docs across topics = %d, want 2", n)
	}
}

// --- broadcast-failure compensation (UnmarkSpentBySpendTxid) ---

// TestUnmarkSpentBySpendTxid round-trips the compensation path: mark via
// MarkUTXOsAsSpent (recording spendTxid), unmark by that spendTxid, and
// assert the outputs are spendable again via FindUTXOsForTopic.
func TestUnmarkSpentBySpendTxid(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	parent := newTx(0x21, 2)
	parentID := parent.TxID()
	other := newTx(0x22, 1)
	otherID := other.TxID()
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0, 1}, nil, beefFor(t, parent), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertOutputs(ctx, topic, otherID, []uint32{0}, nil, beefFor(t, other), nil); err != nil {
		t.Fatal(err)
	}

	spendA := newTx(0x23, 1).TxID()
	spendB := newTx(0x24, 1).TxID()
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(parentID, 0), op(parentID, 1)}, topic, spendA); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(otherID, 0)}, topic, spendB); err != nil {
		t.Fatal(err)
	}

	utxos, err := st.FindUTXOsForTopic(ctx, topic, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(utxos) != 0 {
		t.Fatalf("utxos after marking = %d, want 0", len(utxos))
	}

	n, err := st.UnmarkSpentBySpendTxid(ctx, spendA.String())
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("unmarked = %d, want 2", n)
	}

	utxos, err = st.FindUTXOsForTopic(ctx, topic, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(utxos) != 2 {
		t.Fatalf("utxos after unmark = %d, want 2 (parent:0, parent:1)", len(utxos))
	}
	for _, u := range utxos {
		if !u.Outpoint.Txid.Equal(*parentID) {
			t.Fatalf("unexpected unmarked outpoint %s (spendB's input must stay spent)", u.Outpoint.String())
		}
		if u.Spent {
			t.Fatalf("output %s still flagged spent", u.Outpoint.String())
		}
	}

	// spendB's input is untouched.
	got, err := st.FindOutput(ctx, op(otherID, 0), nil, nil, false)
	if err != nil || got == nil {
		t.Fatal(got, err)
	}
	if !got.Spent {
		t.Fatal("other:0 must remain spent")
	}

	// Unmarking again is a harmless no-op (0 modified).
	n, err = st.UnmarkSpentBySpendTxid(ctx, spendA.String())
	if err != nil || n != 0 {
		t.Fatalf("second unmark = %d, %v; want 0, nil", n, err)
	}
}

// --- terminal-status eviction (FindOutputsByTxid / Delete*ByTxid) ---

func TestFindAndDeleteOutputsByTxid(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	tx := newTx(0x31, 2)
	txid := tx.TxID()
	keep := newTx(0x32, 1)
	keepID := keep.TxID()
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0, 1}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	// Same txid under a second topic: FindOutputsByTxid must dedupe the
	// outpoint, DeleteOutputsByTxid must remove both docs.
	if err := st.InsertOutputs(ctx, "tm_other", txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertOutputs(ctx, topic, keepID, []uint32{0}, nil, beefFor(t, keep), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertAppliedTransaction(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: topic}); err != nil {
		t.Fatal(err)
	}

	ops, err := st.FindOutputsByTxid(ctx, txid.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 2 {
		t.Fatalf("outpoints = %d, want 2 (deduped across topics)", len(ops))
	}
	seen := map[uint32]bool{}
	for _, o := range ops {
		if !o.Txid.Equal(*txid) {
			t.Fatalf("foreign outpoint %s", o.String())
		}
		seen[o.Index] = true
	}
	if !seen[0] || !seen[1] {
		t.Fatalf("outpoints missing a vout: %v", seen)
	}

	if err := st.DeleteOutputsByTxid(ctx, txid.String()); err != nil {
		t.Fatal(err)
	}
	all, err := st.FindOutputsForTransaction(ctx, txid, false)
	if err != nil || len(all) != 0 {
		t.Fatalf("outputs after delete = %d err %v, want 0", len(all), err)
	}
	// Unrelated outputs survive.
	if got, err := st.FindOutput(ctx, op(keepID, 0), nil, nil, false); err != nil || got == nil {
		t.Fatal("unrelated output was deleted:", got, err)
	}

	if err := st.DeleteAppliedTransactionsByTxid(ctx, txid.String()); err != nil {
		t.Fatal(err)
	}
	exists, err := st.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: topic})
	if err != nil || exists {
		t.Fatalf("applied record survived eviction: exists=%v err=%v", exists, err)
	}

	// Evicting an unknown txid is a no-op, not an error.
	if ops, err := st.FindOutputsByTxid(ctx, keep.TxID().String()); err != nil || len(ops) != 1 {
		t.Fatalf("keep outpoints = %d err %v", len(ops), err)
	}
	missing := newTx(0x33, 1).TxID().String()
	if ops, err := st.FindOutputsByTxid(ctx, missing); err != nil || len(ops) != 0 {
		t.Fatalf("missing txid: %d outpoints, err %v", len(ops), err)
	}
	if err := st.DeleteOutputsByTxid(ctx, missing); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteAppliedTransactionsByTxid(ctx, missing); err != nil {
		t.Fatal(err)
	}
}

// TestRawTxHexByTxid is Task 17's TDD case for the small concrete method the
// /admin/activity route's FindRawTxs adapter is built over: enginestore has
// no dedicated raw-tx collection (BEEF bytes live inline on each output
// document, per the package doc comment), so reconstructing a raw tx by
// txid means finding any output document carrying that txid's BEEF and
// pulling the transaction back out of it.
func TestRawTxHexByTxid(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	tx := newTx(0x41, 2)
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{0, 1}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}

	hexStr, ok, err := st.RawTxHexByTxid(ctx, txid.String())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok = false, want true for a stored txid")
	}
	if hexStr != tx.Hex() {
		t.Fatalf("hex = %q, want %q", hexStr, tx.Hex())
	}

	// A second topic's output for the SAME txid (e.g. change output filed
	// under a different topic manager) must resolve identically — any output
	// document carrying the txid's BEEF is sufficient.
	if err := st.InsertOutputs(ctx, "tm_other", txid, []uint32{0}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	if hexStr, ok, err = st.RawTxHexByTxid(ctx, txid.String()); err != nil || !ok || hexStr != tx.Hex() {
		t.Fatalf("cross-topic lookup: hex=%q ok=%v err=%v", hexStr, ok, err)
	}

	// Unknown txid: (_, false, nil) — not an error (mirrors FindOutput's
	// nil-on-missing contract elsewhere in this package).
	missingHex, ok, err := st.RawTxHexByTxid(ctx, newTx(0x42, 1).TxID().String())
	if err != nil {
		t.Fatal(err)
	}
	if ok || missingHex != "" {
		t.Fatalf("missing txid: hex=%q ok=%v, want \"\",false", missingHex, ok)
	}

	// An output document inserted with a nil BEEF (InsertOutputs' zero-BEEF
	// no-BEEF path — see e.g. TestFindAndDeleteOutputsByTxid's `nil` beef
	// arguments) has no beef field at all; it must not satisfy the lookup.
	noBeefTx := newTx(0x43, 1)
	noBeefTxid := noBeefTx.TxID()
	if err := st.InsertOutputs(ctx, topic, noBeefTxid, []uint32{0}, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.RawTxHexByTxid(ctx, noBeefTxid.String()); err != nil || ok {
		t.Fatalf("no-beef output: ok=%v err=%v, want false,nil", ok, err)
	}

	if _, _, err := st.RawTxHexByTxid(ctx, "not-a-txid"); err == nil {
		t.Fatal("bad txid: want an error, got nil")
	}
}

// OutputBeefBytes serves the stored BEEF of one (topic, txid, vout) for the
// /admin/registry/beef and /admin/asset-auth/beef recovery routes (A10/A17):
// the exact bytes InsertOutputs stored, spent or not, and (nil, false) when
// the topic never admitted that outpoint.
func TestOutputBeefBytes(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))
	tx := newTx(0x51, 2)
	txid := tx.TxID()
	beef := beefFor(t, tx)
	if err := st.InsertOutputs(ctx, "tm_mandala", txid, []uint32{1}, nil, beef, nil); err != nil {
		t.Fatal(err)
	}
	want, err := beef.Bytes()
	if err != nil {
		t.Fatal(err)
	}

	got, ok, err := st.OutputBeefBytes(ctx, "tm_mandala", txid.String(), 1)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("stored BEEF bytes differ")
	}
	// Still served once spent — recovery needs the head's BEEF even after the
	// engine marks it spent by a later admin action.
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(txid, 1)}, "tm_mandala", newTx(0x52, 1).TxID()); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.OutputBeefBytes(ctx, "tm_mandala", txid.String(), 1); err != nil || !ok {
		t.Fatalf("spent output: ok=%v err=%v", ok, err)
	}
	// Wrong vout, wrong topic, unknown txid: absent, not an error.
	for _, c := range []struct {
		topic string
		txid  string
		vout  uint32
	}{
		{"tm_mandala", txid.String(), 0},
		{"tm_mandala_registry", txid.String(), 1},
		{"tm_mandala", newTx(0x53, 1).TxID().String(), 1},
	} {
		if _, ok, err := st.OutputBeefBytes(ctx, c.topic, c.txid, c.vout); err != nil || ok {
			t.Fatalf("%+v: ok=%v err=%v, want absent", c, ok, err)
		}
	}
}

// --- FIX L: compare-and-swap spend marking ---

// TestMarkUTXOsAsSpentRefusesAConflictingSpend is the double-spend the
// overlay used to wave through: two submitted transactions both spend the
// same admitted coin, and the unconditional UpdateMany simply let the second
// overwrite spendTxid. The mark is now a compare-and-swap on spent=false
// with a rows-affected check, so the loser is refused and — crucially — the
// coins it DID manage to mark in the same call are handed back, leaving no
// half-spent wreckage behind.
func TestMarkUTXOsAsSpentRefusesAConflictingSpend(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	parent := newTx(0x41, 2)
	parentID := parent.TxID()
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0, 1}, nil, beefFor(t, parent), nil); err != nil {
		t.Fatal(err)
	}

	winner := newTx(0x42, 1).TxID()
	loser := newTx(0x43, 1).TxID()

	// Winner takes output 0 only.
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(parentID, 0)}, topic, winner); err != nil {
		t.Fatal(err)
	}
	// Loser wants both 0 (contested) and 1 (free).
	err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(parentID, 0), op(parentID, 1)}, topic, loser)
	if err == nil {
		t.Fatal("the conflicting spend was accepted")
	}
	if !strings.Contains(err.Error(), "already spent") {
		t.Fatalf("error = %v, want it to name the conflict", err)
	}
	if !strings.Contains(err.Error(), winner.String()) {
		t.Fatalf("error = %v, want it to name the competing txid %s", err, winner)
	}

	// Output 0 still belongs to the winner.
	got, err := st.FindOutput(ctx, op(parentID, 0), &topicVar, nil, false)
	if err != nil || got == nil || !got.Spent {
		t.Fatalf("winner's mark was lost: %+v %v", got, err)
	}
	if by, err := st.SpendStateOf(ctx, topic, parentID.String(), 0); err != nil || by != winner.String() {
		t.Fatalf("spendTxid = %q (%v), want the winner %s", by, err, winner)
	}
	// Output 1 was rolled back: the loser holds nothing.
	if by, err := st.SpendStateOf(ctx, topic, parentID.String(), 1); err != nil || by != "" {
		t.Fatalf("output 1 spendTxid = %q (%v), want empty — the failed mark must roll back", by, err)
	}
	utxos, err := st.FindUTXOsForTopic(ctx, topic, 0, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(utxos) != 1 || utxos[0].Outpoint.Index != 1 {
		t.Fatalf("spendable outputs = %+v, want only parent:1", utxos)
	}
}

// Re-marking a coin this very transaction already spent is not a conflict:
// it is the idempotent resubmit path, and refusing it would strand a
// transaction whose first attempt died between marking and committing.
func TestMarkUTXOsAsSpentIsIdempotentForTheSameSpender(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	parent := newTx(0x44, 1)
	parentID := parent.TxID()
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0}, nil, beefFor(t, parent), nil); err != nil {
		t.Fatal(err)
	}
	spender := newTx(0x45, 1).TxID()
	for i := 0; i < 2; i++ {
		if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(parentID, 0)}, topic, spender); err != nil {
			t.Fatalf("mark %d: %v", i, err)
		}
	}
	if by, _ := st.SpendStateOf(ctx, topic, parentID.String(), 0); by != spender.String() {
		t.Fatalf("spendTxid = %q, want %s", by, spender)
	}
}

// SpendStateOf reports "" for a live coin and for a coin no document exists
// for at all — a missing row is not evidence of a spend.
func TestSpendStateOfLiveAndUnknownOutpoints(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	parent := newTx(0x46, 1)
	parentID := parent.TxID()
	if err := st.InsertOutputs(ctx, topic, parentID, []uint32{0}, nil, beefFor(t, parent), nil); err != nil {
		t.Fatal(err)
	}
	if by, err := st.SpendStateOf(ctx, topic, parentID.String(), 0); err != nil || by != "" {
		t.Fatalf("live coin: %q %v", by, err)
	}
	if by, err := st.SpendStateOf(ctx, topic, newTx(0x47, 1).TxID().String(), 0); err != nil || by != "" {
		t.Fatalf("unknown outpoint: %q %v, want empty and no error", by, err)
	}
}

// --- FIX C: deriving outputsToAdmit from the engine's own stored outputs ---

func TestAdmittedOutputIndexes(t *testing.T) {
	ctx := context.Background()
	st := mustNew(t, testDB(t))

	tx := newTx(0x48, 4)
	txid := tx.TxID()
	if err := st.InsertOutputs(ctx, topic, txid, []uint32{2, 0}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	// A different topic's admission of the same txid must not leak in.
	if err := st.InsertOutputs(ctx, "tm_other", txid, []uint32{3}, nil, beefFor(t, tx), nil); err != nil {
		t.Fatal(err)
	}
	got, err := st.AdmittedOutputIndexes(ctx, topic, txid.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != 0 || got[1] != 2 {
		t.Fatalf("admitted indexes = %v, want [0 2] ascending", got)
	}
	// Spent outputs still count: admission is history, not current liquidity.
	if err := st.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{op(txid, 0)}, topic, newTx(0x49, 1).TxID()); err != nil {
		t.Fatal(err)
	}
	got, err = st.AdmittedOutputIndexes(ctx, topic, txid.String())
	if err != nil || len(got) != 2 {
		t.Fatalf("admitted indexes after spend = %v (%v), want both still listed", got, err)
	}
	empty, err := st.AdmittedOutputIndexes(ctx, topic, newTx(0x4a, 1).TxID().String())
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("unknown txid = %v, want empty", empty)
	}
}

// Wire contract §9.9 — index creation failures abort startup. The unique
// (topic, txid, outputIndex) index is what makes this store single-valued per
// admitted output; two rows already violating it make the index impossible to
// build, and New must refuse rather than hand back a store that silently lost
// the guarantee.
func TestNewAbortsWhenAnIndexCannotBeCreated(t *testing.T) {
	ctx := context.Background()
	db := testDB(t)
	dupe := bson.D{
		{Key: "topic", Value: topic},
		{Key: "txid", Value: strings.Repeat("ab", 32)},
		{Key: "outputIndex", Value: int32(0)},
	}
	if _, err := db.Collection("engineOutputs").InsertMany(ctx, []any{dupe, dupe}); err != nil {
		t.Fatal("seeding the duplicate rows:", err)
	}
	st, err := New(db)
	if err == nil {
		t.Fatal("New returned a Store without its unique output index")
	}
	if st != nil {
		t.Fatalf("New returned a non-nil Store alongside its error: %+v", st)
	}
	if !strings.Contains(err.Error(), "engineOutputs") {
		t.Fatalf("error must name the collection that failed, got: %v", err)
	}
}

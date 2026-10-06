package wiring

// Engine contract probes (Q3 Task 1). Each test pins one go-overlay-services
// v1.3.7 behaviour the Q3 design rests on, on the real engine with stub
// managers and lookups (F/gos-engine §4, §5, §13; F/gaps G6, G8, G17, G18). A
// future engine bump that changes one of them fails here first: re-read the
// design rule named in the test before taking that bump.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

const contractDB = "mandala3_test_engine_contract"

// probeTM is a stub topic manager: admit decides the instructions from the
// previousCoins the engine passes; calls counts every run.
type probeTM struct {
	admit func(previousCoins []uint32) overlay.AdmittanceInstructions
	calls atomic.Int32
}

var _ engine.TopicManager = (*probeTM)(nil)

func (p *probeTM) IdentifyAdmissibleOutputs(_ context.Context, _ *transaction.Beef, _ *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	p.calls.Add(1)
	return p.admit(append([]uint32(nil), previousCoins...)), nil
}

func (p *probeTM) IdentifyNeededInputs(context.Context, *transaction.Beef, *chainhash.Hash) ([]*transaction.Outpoint, error) {
	return nil, nil
}

func (p *probeTM) GetDocumentation() string { return "probe topic manager" }

func (p *probeTM) GetMetaData() *overlay.MetaData { return &overlay.MetaData{Name: "probe"} }

// admitZero admits output 0 and retains every previous coin.
func admitZero(previousCoins []uint32) overlay.AdmittanceInstructions {
	return overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}, CoinsToRetain: previousCoins}
}

// admitZeroRetainNothing admits output 0 and retains no previous coin.
func admitZeroRetainNothing([]uint32) overlay.AdmittanceInstructions {
	return overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}, CoinsToRetain: []uint32{}}
}

var errProbeAdmit = errors.New("probe lookup: admit refused")

// probeLS is a stub lookup service that records every engine callback as
// "admit <topic> <txid>.<vout>", "spent <topic> <txid>.<vout>",
// "noLongerRetained <topic> <txid>.<vout>" or "evicted <txid>.<vout>".
// failAdmit makes OutputAdmittedByTopic return errProbeAdmit (nothing recorded).
type probeLS struct {
	mu        sync.Mutex
	events    []string
	failAdmit bool
}

var _ engine.LookupService = (*probeLS)(nil)

func (l *probeLS) record(e string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, e)
}

func (l *probeLS) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.events...)
}

func (l *probeLS) setFailAdmit(fail bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failAdmit = fail
}

func (l *probeLS) OutputAdmittedByTopic(_ context.Context, p *engine.OutputAdmittedByTopic) error {
	_, _, txid, err := transaction.ParseBeef(p.AtomicBEEF)
	if err != nil {
		return fmt.Errorf("probe lookup: %w", err)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failAdmit {
		return errProbeAdmit
	}
	l.events = append(l.events, fmt.Sprintf("admit %s %s.%d", p.Topic, txid, p.OutputIndex))
	return nil
}

func (l *probeLS) OutputSpent(_ context.Context, p *engine.OutputSpent) error {
	l.record(fmt.Sprintf("spent %s %s", p.Topic, p.Outpoint))
	return nil
}

func (l *probeLS) OutputNoLongerRetainedInHistory(_ context.Context, op *transaction.Outpoint, topic string) error {
	l.record(fmt.Sprintf("noLongerRetained %s %s", topic, op))
	return nil
}

func (l *probeLS) OutputEvicted(_ context.Context, op *transaction.Outpoint) error {
	l.record(fmt.Sprintf("evicted %s", op))
	return nil
}

func (l *probeLS) OutputBlockHeightUpdated(context.Context, *chainhash.Hash, uint32, uint64) error {
	return nil
}

func (l *probeLS) Lookup(context.Context, *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	return &lookup.LookupAnswer{Type: lookup.AnswerTypeOutputList}, nil
}

func (l *probeLS) GetDocumentation() string { return "probe lookup service" }

func (l *probeLS) GetMetaData() *overlay.MetaData { return &overlay.MetaData{Name: "probe"} }

// newProbeEngine is the real v1.3.7 engine over the real Mongo engine store,
// scripts-only SPV, no broadcaster.
func newProbeEngine(t *testing.T, db *mongo.Database, managers map[string]engine.TopicManager, lookups map[string]engine.LookupService) (*engine.Engine, *enginestore.Store) {
	t.Helper()
	es, err := enginestore.New(db)
	if err != nil {
		t.Fatal(err)
	}
	if lookups == nil {
		lookups = map[string]engine.LookupService{}
	}
	return engine.NewEngine(&engine.Config{
		Managers:       managers,
		LookupServices: lookups,
		Storage:        es,
		ChainTracker:   scriptsOnlyTracker{},
	}), es
}

// probeSource is a proven one-output P2PKH tx; sats makes each txid distinct.
// A proven tx is itself submittable: spv.Verify stops at its merkle path.
func probeSource(t *testing.T, sats uint64) *transaction.Transaction {
	t.Helper()
	_, lock := p2pkhKeyAndLock(t)
	src := transaction.NewTransaction()
	src.Version = 2
	src.AddOutput(&transaction.TransactionOutput{Satoshis: sats, LockingScript: lock})
	return withMerklePath(src)
}

// probeSpend spends parent:0 with the test key; its output 0 is a P2PKH lock.
func probeSpend(t *testing.T, parent *transaction.Transaction) *transaction.Transaction {
	t.Helper()
	key, lock := p2pkhKeyAndLock(t)
	return signedSpend(t, key, parent, 2, sighash.AllForkID, lock)
}

func probeSubmit(ctx context.Context, eng *engine.Engine, beef []byte, topics ...string) (overlay.Steak, error) {
	return eng.Submit(ctx, overlay.TaggedBEEF{Beef: beef, Topics: topics}, engine.SubmitModeCurrent, nil)
}

func mustProbeSubmit(t *testing.T, ctx context.Context, eng *engine.Engine, tx *transaction.Transaction, topics ...string) overlay.Steak {
	t.Helper()
	steak, err := probeSubmit(ctx, eng, atomicBEEF(t, tx), topics...)
	if err != nil {
		t.Fatalf("Submit %s on %v: %v", tx.TxID(), topics, err)
	}
	return steak
}

func outpointOf(tx *transaction.Transaction, vout uint32) *transaction.Outpoint {
	return &transaction.Outpoint{Txid: *tx.TxID(), Index: vout}
}

func countDocs(t *testing.T, ctx context.Context, db *mongo.Database, coll string) int64 {
	t.Helper()
	n, err := db.Collection(coll).CountDocuments(ctx, bson.D{})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func contractCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// G6: one unknown topic refuses the whole submit with the bare sentinel
// before any manager runs or anything is written. httpapi maps it with
// errors.Is (Task 20) and pre-checks HasTopicManager before any record write.
func TestEngineContractUnknownTopic(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	tm := &probeTM{admit: admitZero}
	eng, _ := newProbeEngine(t, db, map[string]engine.TopicManager{"tm_probe_a": tm}, nil)

	_, err := probeSubmit(ctx, eng, atomicBEEF(t, probeSource(t, 1001)), "tm_probe_a", "tm_probe_missing")
	if err != engine.ErrUnknownTopic { //nolint:errorlint // the pin is that the sentinel is NOT wrapped
		t.Fatalf("Submit error = %#v, want engine.ErrUnknownTopic itself", err)
	}
	if !errors.Is(err, engine.ErrUnknownTopic) || err.Error() != "unknown-topic" {
		t.Fatalf("Submit error text = %q, want unknown-topic", err)
	}
	if n := tm.calls.Load(); n != 0 {
		t.Fatalf("manager ran %d times, want 0", n)
	}
	for _, coll := range []string{"engineOutputs", "engineAppliedTransactions"} {
		if n := countDocs(t, ctx, db, coll); n != 0 {
			t.Fatalf("%s holds %d docs, want 0", coll, n)
		}
	}
}

// G8 (retained): a retained previous coin keeps its doc, marked spent by the
// spender, so eviction's UnmarkSpentBySpendTxid can make it live again.
func TestEngineContractRetainKeepsSpentDoc(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	const topic = "tm_probe_a"
	tm := &probeTM{admit: admitZero}
	eng, es := newProbeEngine(t, db, map[string]engine.TopicManager{topic: tm}, map[string]engine.LookupService{"ls_probe_a": &probeLS{}})

	tx1 := probeSource(t, 1002)
	tx2 := probeSpend(t, tx1)
	mustProbeSubmit(t, ctx, eng, tx1, topic)
	steak := mustProbeSubmit(t, ctx, eng, tx2, topic)

	if got := steak[topic].CoinsRemoved; len(got) != 0 {
		t.Fatalf("CoinsRemoved = %v, want none for a retained coin", got)
	}
	tp := topic
	out, err := es.FindOutput(ctx, outpointOf(tx1, 0), &tp, nil, false)
	if err != nil || out == nil {
		t.Fatalf("tx1:0 doc = %v (%v), want it kept", out, err)
	}
	if !out.Spent || len(out.ConsumedBy) != 1 || out.ConsumedBy[0].String() != outpointOf(tx2, 0).String() {
		t.Fatalf("tx1:0 spent=%v consumedBy=%v, want spent and consumed by %s", out.Spent, out.ConsumedBy, outpointOf(tx2, 0))
	}
	if by, err := es.SpendStateOf(ctx, topic, tx1.TxID().String(), 0); err != nil || by != tx2.TxID().String() {
		t.Fatalf("tx1:0 spent by %q (%v), want %s", by, err, tx2.TxID())
	}
	n, err := es.UnmarkSpentBySpendTxid(ctx, tx2.TxID().String())
	if err != nil || n != 1 {
		t.Fatalf("UnmarkSpentBySpendTxid = %d (%v), want 1", n, err)
	}
	if live, err := es.IsUnspent(ctx, topic, tx1.TxID().String(), 0); err != nil || !live {
		t.Fatalf("tx1:0 live = %v (%v), want true after the unmark", live, err)
	}
}

// G8 (not retained): a previous coin the manager does not retain is deleted
// (deleteUTXODeep), reported in CoinsRemoved and noLongerRetained to every
// lookup, and can never be restored by an eviction.
func TestEngineContractNotRetainedDeletesDoc(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	const topic = "tm_probe_a"
	tm := &probeTM{admit: admitZeroRetainNothing}
	lsA, lsB := &probeLS{}, &probeLS{}
	eng, es := newProbeEngine(t, db, map[string]engine.TopicManager{topic: tm},
		map[string]engine.LookupService{"ls_probe_a": lsA, "ls_probe_b": lsB})

	tx1 := probeSource(t, 1003)
	tx2 := probeSpend(t, tx1)
	mustProbeSubmit(t, ctx, eng, tx1, topic)
	steak := mustProbeSubmit(t, ctx, eng, tx2, topic)

	if got := steak[topic].CoinsRemoved; !slices.Equal(got, []uint32{0}) {
		t.Fatalf("CoinsRemoved = %v, want [0]", got)
	}
	tp := topic
	if out, err := es.FindOutput(ctx, outpointOf(tx1, 0), &tp, nil, false); err != nil || out != nil {
		t.Fatalf("tx1:0 doc = %v (%v), want deleted", out, err)
	}
	want := "noLongerRetained " + topic + " " + outpointOf(tx1, 0).String()
	for name, ls := range map[string]*probeLS{"ls_probe_a": lsA, "ls_probe_b": lsB} {
		if !slices.Contains(ls.snapshot(), want) {
			t.Fatalf("%s events = %v, want %q", name, ls.snapshot(), want)
		}
	}
	if n, err := es.UnmarkSpentBySpendTxid(ctx, tx2.TxID().String()); err != nil || n != 0 {
		t.Fatalf("UnmarkSpentBySpendTxid = %d (%v), want 0: the deleted coin cannot be unmarked", n, err)
	}
	if live, err := es.IsUnspent(ctx, topic, tx1.TxID().String(), 0); err != nil || live {
		t.Fatalf("tx1:0 live = %v (%v), want false: a deleted coin is not live", live, err)
	}
}

// G18: every lookup gets every topic's admit and spend events, whatever topic
// it was registered for; the engine never calls OutputEvicted.
func TestEngineContractLookupFanOut(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	lsA, lsB := &probeLS{}, &probeLS{}
	eng, _ := newProbeEngine(t, db,
		map[string]engine.TopicManager{"tm_probe_a": &probeTM{admit: admitZero}, "tm_probe_b": &probeTM{admit: admitZero}},
		map[string]engine.LookupService{"ls_probe_a": lsA, "ls_probe_b": lsB})

	tx1 := probeSource(t, 1004)
	tx2 := probeSpend(t, tx1)
	mustProbeSubmit(t, ctx, eng, tx1, "tm_probe_a")
	mustProbeSubmit(t, ctx, eng, tx2, "tm_probe_a")

	want := []string{
		"admit tm_probe_a " + outpointOf(tx1, 0).String(),
		"spent tm_probe_a " + outpointOf(tx1, 0).String(),
		"admit tm_probe_a " + outpointOf(tx2, 0).String(),
	}
	for name, ls := range map[string]*probeLS{"ls_probe_a": lsA, "ls_probe_b (registered beside tm_probe_b)": lsB} {
		if got := ls.snapshot(); !slices.Equal(got, want) {
			t.Fatalf("%s events = %v, want %v", name, got, want)
		}
	}
}

// G18: a lookup failure aborts Submit AFTER the inputs were marked spent and
// the outputs inserted, with no applied record, so a resubmit runs the
// manager again and converges once the lookup recovers.
func TestEngineContractLookupErrorAbortsAfterSpend(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	const topic = "tm_probe_a"
	tm := &probeTM{admit: admitZero}
	ls := &probeLS{}
	eng, es := newProbeEngine(t, db, map[string]engine.TopicManager{topic: tm}, map[string]engine.LookupService{"ls_probe_a": ls})

	tx1 := probeSource(t, 1005)
	tx2 := probeSpend(t, tx1)
	mustProbeSubmit(t, ctx, eng, tx1, topic)

	ls.setFailAdmit(true)
	beef2 := atomicBEEF(t, tx2)
	if _, err := probeSubmit(ctx, eng, beef2, topic); !errors.Is(err, errProbeAdmit) {
		t.Fatalf("Submit error = %v, want the lookup's error", err)
	}
	if by, err := es.SpendStateOf(ctx, topic, tx1.TxID().String(), 0); err != nil || by != tx2.TxID().String() {
		t.Fatalf("tx1:0 spent by %q (%v), want %s: the engine does not unwind the spend mark", by, err, tx2.TxID())
	}
	tp := topic
	if out, err := es.FindOutput(ctx, outpointOf(tx2, 0), &tp, nil, false); err != nil || out == nil {
		t.Fatalf("tx2:0 doc = %v (%v), want inserted before the lookup ran", out, err)
	}
	applied := &overlay.AppliedTransaction{Txid: tx2.TxID(), Topic: topic}
	if ok, err := es.DoesAppliedTransactionExist(ctx, applied); err != nil || ok {
		t.Fatalf("applied record for tx2 = %v (%v), want none", ok, err)
	}
	if n := tm.calls.Load(); n != 2 {
		t.Fatalf("manager runs = %d, want 2 (tx1, tx2)", n)
	}

	ls.setFailAdmit(false)
	if _, err := probeSubmit(ctx, eng, beef2, topic); err != nil {
		t.Fatalf("resubmit with the lookup recovered: %v", err)
	}
	if n := tm.calls.Load(); n != 3 {
		t.Fatalf("manager runs = %d, want 3: the resubmit must reach the manager again", n)
	}
	if ok, err := es.DoesAppliedTransactionExist(ctx, applied); err != nil || !ok {
		t.Fatalf("applied record for tx2 after the resubmit = %v (%v), want present", ok, err)
	}
}

// G17: the legacy submit path does not dedupe topics; a repeated topic runs
// its manager twice and notifies every lookup twice. httpapi dedupes X-Topics.
func TestEngineContractDuplicateTopicRunsTwice(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	tm := &probeTM{admit: admitZero}
	ls := &probeLS{}
	eng, _ := newProbeEngine(t, db, map[string]engine.TopicManager{"tm_probe_a": tm}, map[string]engine.LookupService{"ls_probe_a": ls})

	tx := probeSource(t, 1006)
	steak := mustProbeSubmit(t, ctx, eng, tx, "tm_probe_a", "tm_probe_a")
	if n := tm.calls.Load(); n != 2 {
		t.Fatalf("manager runs = %d, want 2", n)
	}
	if len(steak) != 1 {
		t.Fatalf("steak entries = %d, want 1 (a map)", len(steak))
	}
	admit := "admit tm_probe_a " + outpointOf(tx, 0).String()
	n := 0
	for _, e := range ls.snapshot() {
		if e == admit {
			n++
		}
	}
	if n != 2 {
		t.Fatalf("%q seen %d times, want 2", admit, n)
	}
}

// Runtime registration (TT §6.1): RegisterTopicManager / RegisterLookupService
// beside in-flight submits is race-free under -race, and a topic registered at
// runtime admits at once.
func TestEngineContractRegisterDuringSubmit(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	tm := &probeTM{admit: admitZero}
	eng, _ := newProbeEngine(t, db, map[string]engine.TopicManager{"tm_probe_a": tm}, map[string]engine.LookupService{"ls_probe_a": &probeLS{}})

	const submits = 8
	beefs := make([][]byte, submits)
	for i := range beefs {
		beefs[i] = atomicBEEF(t, probeSource(t, 1100+uint64(i)))
	}
	late := probeSource(t, 1200)
	lateBeef := atomicBEEF(t, late)

	errs := make(chan error, submits)
	var wg sync.WaitGroup
	for i := range submits {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := probeSubmit(ctx, eng, beefs[i], "tm_probe_a")
			errs <- err
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 1; i <= 8; i++ {
			eng.RegisterLookupService(fmt.Sprintf("ls_probe_%d", i), &probeLS{})
			eng.RegisterTopicManager(fmt.Sprintf("tm_probe_%d", i), &probeTM{admit: admitZero})
		}
	}()
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent submit: %v", err)
		}
	}
	if n := tm.calls.Load(); n != submits {
		t.Fatalf("tm_probe_a runs = %d, want %d", n, submits)
	}
	for i := 1; i <= 8; i++ {
		if !eng.HasTopicManager(fmt.Sprintf("tm_probe_%d", i)) || !eng.HasLookupService(fmt.Sprintf("ls_probe_%d", i)) {
			t.Fatalf("tm_probe_%d / ls_probe_%d not registered", i, i)
		}
	}
	steak, err := probeSubmit(ctx, eng, lateBeef, "tm_probe_8")
	if err != nil || !slices.Equal(steak["tm_probe_8"].OutputsToAdmit, []uint32{0}) {
		t.Fatalf("submit on the runtime-registered topic = %v (%v), want [0] admitted", steak, err)
	}
}

// digestV3Hex is the lowercase hex SHA-256 of a σI v3 preimage (A1.2).
func digestV3Hex(preimage string) string {
	sum := sha256.Sum256([]byte(preimage))
	return hex.EncodeToString(sum[:])
}

// A1.2: two σ-topics admitting the same vout in one submit get two STEAK
// entries; the v3 digest binds the topic, so their σI differ. The fixed
// preimages pin the Global Constraints vectors (Task 10 re-pins them on
// AdmissionDigestV3).
func TestEngineContractTwoTopicsOneSubmitSigmaShape(t *testing.T) {
	db := testmongo.DB(t, contractDB)
	ctx := contractCtx(t)
	eng, es := newProbeEngine(t, db,
		map[string]engine.TopicManager{"tm_probe_a": &probeTM{admit: admitZero}, "tm_probe_b": &probeTM{admit: admitZero}}, nil)

	tx := probeSource(t, 1007)
	steak := mustProbeSubmit(t, ctx, eng, tx, "tm_probe_a", "tm_probe_b")
	txid := tx.TxID().String()
	digests := map[string]string{}
	for _, topic := range []string{"tm_probe_a", "tm_probe_b"} {
		if steak[topic] == nil || !slices.Equal(steak[topic].OutputsToAdmit, []uint32{0}) {
			t.Fatalf("steak[%s] = %+v, want outputsToAdmit [0]", topic, steak[topic])
		}
		tp := topic
		if out, err := es.FindOutput(ctx, outpointOf(tx, 0), &tp, nil, false); err != nil || out == nil {
			t.Fatalf("%s doc for %s.0 = %v (%v), want stored", topic, txid, out, err)
		}
		digests[topic] = digestV3Hex("mandala-admit:v3:" + topic + ":" + txid + ":0")
	}
	if digests["tm_probe_a"] == digests["tm_probe_b"] {
		t.Fatal("the v3 digest must differ per topic for the same txid and outputs")
	}

	const vt = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for _, c := range []struct{ preimage, want string }{
		{"mandala-admit:v3:tm_mandala:" + vt + ":0", "2dd76e2fbb8234967159f842f463b58bd0a76efcc49e7c8372bdbc8a9931db5c"},
		{"mandala-admit:v3:tm_" + vt + ":" + vt + ":0", "654768162ffd1d0011e33cff4f8e553cf34a159c6006e627f4987f57c2891d0d"},
		{"mandala-admit:v3:tm_" + vt + ":" + vt + ":0,1", "d75c8da798a7347ef623e57cc827c3188c36acd8e84f9b9f69f531d1ebe335b1"},
	} {
		if got := digestV3Hex(c.preimage); got != c.want {
			t.Fatalf("sha256(%q) = %s, want %s", c.preimage, got, c.want)
		}
	}
}

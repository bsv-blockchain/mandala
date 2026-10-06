package mandala

// V-15 on the real engine (go-overlay-services v1.3.7, legacy submit path) and real Mongo: the engine store never
// resurrects or unmarks a spend another commit owns. Final review C6 (a late same-txid submit's InsertOutputs) and
// C13/C15/C19 (MarkUTXOsAsSpent's CAS-conflict rollback across topics), each driven to the interleaving the review
// forced, through a wrapper of the engine store.

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// useStorage rebuilds f.eng (tm_mandala only, as newEngineFlow does) over st, a wrapper of f.es. Call it before any
// topic or lookup is hosted. The managers keep reading f.es directly.
func (f *engineFlow) useStorage(st engine.Storage) {
	f.t.Helper()
	reg, err := NewTokenRegistryTopicManager(f.deps)
	if err != nil {
		f.t.Fatalf("registry manager: %v", err)
	}
	f.eng = engine.NewEngine(&engine.Config{
		Managers:     map[string]engine.TopicManager{MandalaTopic: reg},
		Storage:      st,
		ChainTracker: mandalatest.ScriptsOnlyTracker(),
	})
}

// doubleClickGate holds the two submits of target at MarkUTXOsAsSpent (engine step 7), after both passed the dupe
// gate and the managers: the first goes on once the second has arrived, the second waits for release. A gate that
// times out fails the mark, so the test fails on the submit's error instead of hanging.
type doubleClickGate struct {
	*enginestore.Store
	target  string
	mu      sync.Mutex
	n       int
	both    chan struct{}
	release chan struct{}
}

func (g *doubleClickGate) MarkUTXOsAsSpent(ctx context.Context, ops []*transaction.Outpoint, topic string, spend *chainhash.Hash) error {
	if spend != nil && spend.String() == g.target {
		g.mu.Lock()
		g.n++
		n := g.n
		if n == 2 {
			close(g.both)
		}
		g.mu.Unlock()
		switch n {
		case 1:
			select {
			case <-g.both:
			case <-time.After(30 * time.Second):
				return errors.New("doubleClickGate: the second submit never reached MarkUTXOsAsSpent")
			}
		case 2:
			select {
			case <-g.release:
			case <-time.After(60 * time.Second):
				return errors.New("doubleClickGate: never released")
			}
		}
	}
	return g.Store.MarkUTXOsAsSpent(ctx, ops, topic, spend)
}

// flowMaintenance runs one owner-index maintenance pass the way wiring does: the V-13 sweep and the V-11 balance
// rebuild (the gate's exclusive section), then the reconcile of topic (D §4.2a rule 5). It returns the rows the
// reconcile repaired.
func flowMaintenance(t *testing.T, f *engineFlow, tokenID, topic string) int {
	t.Helper()
	if _, err := SweepOwnerIndex(f.ctx, SweepDeps{Store: f.store, Engine: f.es, TokenIDs: []string{tokenID}}); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, err := f.store.RebuildBalances(f.ctx); err != nil {
		t.Fatalf("rebuild balances: %v", err)
	}
	res, err := ReconcileOwnerIndex(f.ctx, ReconcileDeps{Store: f.store, Engine: f.es, Topic: topic, OnRepair: func(string, bool) {}})
	if err != nil {
		t.Fatalf("reconcile %s: %v", topic, err)
	}
	return res.Repaired
}

func flowSupply(t *testing.T, f *engineFlow, tokenID string) string {
	t.Helper()
	s, err := f.store.CirculatingSupply(f.ctx, tokenID)
	if err != nil {
		t.Fatalf("supply %s: %v", tokenID, err)
	}
	return s.String()
}

func flowBalance(t *testing.T, f *engineFlow, identityKey string) int64 {
	t.Helper()
	b, err := f.store.GetBalance(f.ctx, identityKey)
	if err != nil {
		t.Fatalf("balance: %v", err)
	}
	return b
}

// C6: two submits of T (a double-click) both pass the dupe gate; the first commits; the holder spends T's change T.1
// in U; then the second submit of T reaches InsertOutputs. Its write used to replace T.1's document, so T.1 read
// unspent (U's spend and consumedBy erased), a second spend V of T.1 was admitted, and maintenance kept the re-minted
// row because the engine agreed it was live: supply 160 of 100. T.1 must stay spent by U.
func TestEngineLateSameTxidSubmitKeepsALaterSpend(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_late_resubmit")
	f.deps.Spends = flowSpends{es: f.es}
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	d := mandalatest.Deploy(t, issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	iss := mandalatest.Issue(t, d, 0, issuer, holder, 100)
	T := mandalatest.Transfer(t, iss, 1, receiver, 40) // T.0 receiver 40, T.1 holder's change 60
	gate := &doubleClickGate{Store: f.es, target: T.Txid, both: make(chan struct{}), release: make(chan struct{})}
	f.useStorage(gate)
	f.withRegistryLookup()
	topic := f.hostWithLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)
	f.mustSubmit(iss, topic)

	errs := make(chan error, 2)
	for range 2 {
		go func() { _, err := f.submit(T, topic); errs <- err }()
	}
	released := false
	t.Cleanup(func() {
		if !released {
			close(gate.release)
		}
	})
	if err := <-errs; err != nil {
		t.Fatalf("the double-click's first submit: %v", err)
	}

	U := mandalatest.Transfer(t, T, 1, receiver, 10) // U.0 receiver 10, U.1 holder 50; U retains T.1
	flowEntry(t, f.mustSubmit(U, topic), topic, []uint32{0, 1}, []uint32{0})
	if by, err := f.es.SpendStateOf(f.ctx, topic, T.Txid, 1); err != nil || by != U.Txid {
		t.Fatalf("precondition: T.1 spent by %q (%v), want U %s", by, err, U.Txid)
	}

	close(gate.release)
	released = true
	if err := <-errs; err != nil {
		t.Fatalf("the double-click's late submit: %v", err)
	}

	if by, err := f.es.SpendStateOf(f.ctx, topic, T.Txid, 1); err != nil || by != U.Txid {
		t.Fatalf("T.1 spent by %q (%v) after the late submit, want U %s: InsertOutputs resurrected a spent output", by, err, U.Txid)
	}
	t1 := &transaction.Outpoint{Txid: *T.Tx.TxID(), Index: 1}
	out, err := f.es.FindOutput(f.ctx, t1, &topic, nil, false)
	if err != nil || out == nil || !out.Spent {
		t.Fatalf("T.1 engine output = %+v (%v), want spent", out, err)
	}
	var consumedBy []string
	for _, o := range out.ConsumedBy {
		consumedBy = append(consumedBy, o.String())
	}
	if want := []string{U.Txid + ".0", U.Txid + ".1"}; !slices.Equal(consumedBy, want) {
		t.Fatalf("T.1 consumedBy = %v, want %v (deleteUTXODeep walks it)", consumedBy, want)
	}
	if live, err := f.es.IsUnspent(f.ctx, topic, T.Txid, 0); err != nil || !live {
		t.Fatalf("T.0 live = %v (%v), want true", live, err)
	}

	// A second spend of T.1 meets the conflicting-spend guard.
	V := mandalatest.Transfer(t, T, 1, receiver, 5)
	_, err = f.submit(V, topic)
	if rej := mgrRefusal(t, err, CodeInputSpent, "input "+T.Txid+".1: already spent by "+U.Txid, topic); rej.SpendTxid != U.Txid {
		t.Fatalf("SpendTxid = %q, want U %s", rej.SpendTxid, U.Txid)
	}

	// The late submit's notify ran ls_<id>.OutputAdmittedByTopic for T.1 (the row U took). The engine reads T.1 spent,
	// so the maintenance pass takes that row back and repairs nothing; supply and balances are U's view.
	if repaired := flowMaintenance(t, f, id, topic); repaired != 0 {
		t.Fatalf("reconcile repaired %d rows, want 0", repaired)
	}
	if row, err := f.store.GetTokenRow(f.ctx, T.Txid, 1); err != nil || row != nil {
		t.Fatalf("T.1 row = %+v (%v) after maintenance, want none", row, err)
	}
	if got := flowSupply(t, f, id); got != "100" {
		t.Fatalf("supply = %s, want 100", got)
	}
	if got := flowTokenOutpoints(t, f, id); !slices.Equal(sortedCopy(got), sortedCopy([]string{T.Txid + ".0", U.Txid + ".0", U.Txid + ".1"})) {
		t.Fatalf("value rows = %v, want T.0, U.0, U.1", got)
	}
	for key, want := range map[string]int64{holder.Identity: 50, receiver.Identity: 50} {
		if got := flowBalance(t, f, key); got != want {
			t.Fatalf("balance of %s = %d, want %d", key[:8], got, want)
		}
	}
}

// C13/C15/C19: a two-token transfer x is admitted naming only [tm_A] (a1 spent by x, applied on tm_A). Its retry names
// [tm_A, tm_B]; the engine skips tm_A as a dupe, and a competing spend X of b1 marks b1 on tm_B between x's guard and
// x's mark there. x's tm_B mark loses the CAS. Its rollback used to unmark x's spends on every topic, so a1 read live on
// tm_A although x is applied there; the reconcile re-minted a1's row (supply A 200 of 100) and a second spend of a1
// was admitted. The rollback now hands back only this call's marks.
func TestEngineRetryCASConflictKeepsACommittedTopicSpend(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_retry_conflict")
	f.deps.Spends = flowSpends{es: f.es}
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	deployA := mandalatest.Deploy(t, issuer, "USD")
	idA := brc162.DeployTokenID(deployA.Txid, 0)
	deployB := mandalatest.Deploy(t, issuer, "EUR")
	idB := brc162.DeployTokenID(deployB.Txid, 0)
	issueA := mandalatest.Issue(t, deployA, 0, issuer, holder, 100)
	issueB := mandalatest.Issue(t, deployB, 0, issuer, holder, 50)
	x := mandalatest.TwoTokenTransfer(t, issueA, 1, issueB, 1, receiver)
	X := mandalatest.Transfer(t, issueB, 1, receiver, 10) // the holder's competing spend of b1

	b1 := &transaction.Outpoint{Txid: *issueB.Tx.TxID(), Index: 1}
	topicB, err := TokenTopic(idB)
	if err != nil {
		t.Fatal(err)
	}
	hook := &competingMark{Store: f.es, target: x.Txid, topic: topicB, before: func(ctx context.Context) error {
		return f.es.MarkUTXOsAsSpent(ctx, []*transaction.Outpoint{b1}, topicB, X.Tx.TxID())
	}}
	f.useStorage(hook)
	f.withRegistryLookup()
	topicA := f.hostWithLookup(idA)
	if got := f.hostWithLookup(idB); got != topicB {
		t.Fatalf("hosted %s, want %s", got, topicB)
	}
	f.mustSubmit(deployA, MandalaTopic, topicA)
	f.mustSubmit(issueA, topicA)
	f.mustSubmit(deployB, MandalaTopic, topicB)
	f.mustSubmit(issueB, topicB)

	// x's first submit names [tm_A] only (Review Focus 1): admitted there.
	flowEntry(t, f.mustSubmit(x, topicA), topicA, []uint32{0}, []uint32{0})
	if got := flowSupply(t, f, idA); got != "100" {
		t.Fatalf("supply A after x on [tm_A] = %s, want 100", got)
	}

	if hook.ran() {
		t.Fatal("the competing mark ran before the retry")
	}

	// The retry names [tm_A, tm_B]: tm_A is a dupe, tm_B's mark loses to X.
	_, err = f.submit(x, topicA, topicB)
	if err == nil || !strings.Contains(err.Error(), "already spent by "+X.Txid) {
		t.Fatalf("retry error = %v, want the CAS refusal naming X %s", err, X.Txid)
	}
	if !hook.ran() {
		t.Fatal("the competing mark never ran: the retry did not reach x's tm_B mark")
	}

	if by, err := f.es.SpendStateOf(f.ctx, topicA, issueA.Txid, 1); err != nil || by != x.Txid {
		t.Fatalf("a1 on tm_A spent by %q (%v), want x %s: the rollback unmarked a committed topic's spend", by, err, x.Txid)
	}
	if by, err := f.es.SpendStateOf(f.ctx, topicB, issueB.Txid, 1); err != nil || by != X.Txid {
		t.Fatalf("b1 on tm_B spent by %q (%v), want X %s", by, err, X.Txid)
	}
	if applied, err := f.es.AppliedTopics(f.ctx, x.Txid); err != nil || !slices.Equal(applied, []string{topicA}) {
		t.Fatalf("x applied on %v (%v), want [%s]", applied, err, topicA)
	}

	// A second spend of a1 meets the conflicting-spend guard.
	again := mandalatest.Transfer(t, issueA, 1, receiver, 5)
	_, err = f.submit(again, topicA)
	mgrRefusal(t, err, CodeInputSpent, "input "+issueA.Txid+".1: already spent by "+x.Txid, topicA)

	// Maintenance re-mints nothing: a1 is spent on tm_A, so its row stays taken.
	if repaired := flowMaintenance(t, f, idA, topicA); repaired != 0 {
		t.Fatalf("reconcile of tm_A repaired %d rows, want 0", repaired)
	}
	if row, err := f.store.GetTokenRow(f.ctx, issueA.Txid, 1); err != nil || row != nil {
		t.Fatalf("a1 row = %+v (%v), want none", row, err)
	}
	if got := flowSupply(t, f, idA); got != "100" {
		t.Fatalf("supply A = %s, want 100", got)
	}
	if got := flowBalance(t, f, holder.Identity); got != 50 {
		t.Fatalf("holder balance = %d, want 50 (b1 only)", got)
	}
}

// competingMark runs before once, just before target's first MarkUTXOsAsSpent on topic: after the engine ran every
// guard (identify runs for all topics before the first mark), before target's own mark there.
type competingMark struct {
	*enginestore.Store
	target string
	topic  string
	before func(ctx context.Context) error
	mu     sync.Mutex
	fired  bool
}

func (c *competingMark) MarkUTXOsAsSpent(ctx context.Context, ops []*transaction.Outpoint, topic string, spend *chainhash.Hash) error {
	if spend != nil && spend.String() == c.target && topic == c.topic {
		c.mu.Lock()
		run := !c.fired
		c.fired = true
		c.mu.Unlock()
		if run {
			if err := c.before(ctx); err != nil {
				return err
			}
		}
	}
	return c.Store.MarkUTXOsAsSpent(ctx, ops, topic, spend)
}

func (c *competingMark) ran() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.fired
}

func sortedCopy(s []string) []string {
	c := slices.Clone(s)
	slices.Sort(c)
	return c
}

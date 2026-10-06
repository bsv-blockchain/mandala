package mandala

// V-16 on the real engine (go-overlay-services v1.3.7, legacy submit path) and real Mongo. The engine marks a
// transaction's inputs spent and runs every lookup's OutputSpent (which takes their owner rows) BEFORE it broadcasts
// and commits, and the applied record is its last write; a lookup fault anywhere in that window aborts Submit with
// nothing unwound. Final review §C2-§C4, §C7-§C10, §C18: the resubmit of the same transaction then met layer B's repair,
// which read its own spend mark as "not admitted" and answered 503 "owner index unavailable" forever (coin locked,
// admin action never folded). The repair now reads a coin spent by the transaction under validation as admitted, so
// the resubmit converges. §C11: the V-13 sweep must not take the row of such an uncommitted spend in the meantime.

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

var errInjectedLookup = errors.New("injected lookup fault")

// lookupFault wraps a lookup service. Armed for spentAfterTake, the next OutputSpent runs the real one (the row is
// taken and debited) and then fails, as a balance $inc or a second input's take failing would. Armed for admitted,
// the next OutputAdmittedByTopic fails before any write (a NextAdmitSeq blip, or a crash before the applied record).
type lookupFault struct {
	engine.LookupService
	spentAfterTake atomic.Bool
	admitted       atomic.Bool
}

func (l *lookupFault) OutputSpent(ctx context.Context, p *engine.OutputSpent) error {
	if err := l.LookupService.OutputSpent(ctx, p); err != nil {
		return err
	}
	if l.spentAfterTake.CompareAndSwap(true, false) {
		return errInjectedLookup
	}
	return nil
}

func (l *lookupFault) OutputAdmittedByTopic(ctx context.Context, p *engine.OutputAdmittedByTopic) error {
	if l.admitted.CompareAndSwap(true, false) {
		return errInjectedLookup
	}
	return l.LookupService.OutputAdmittedByTopic(ctx, p)
}

// hostWithFaultyLookup registers ls_<tokenID> behind a lookupFault, then tm_<tokenID>.
func (f *engineFlow) hostWithFaultyLookup(tokenID string) (string, *lookupFault) {
	f.t.Helper()
	ls, err := NewTokenLookupService(tokenID, f.deps.Verifier, f.store)
	if err != nil {
		f.t.Fatalf("token lookup %s: %v", tokenID, err)
	}
	w := &lookupFault{LookupService: ls}
	f.eng.RegisterLookupService(ls.Name(), w)
	return f.host(tokenID), w
}

// recordingBroadcaster accepts every transaction and records its txid (engine step 8).
type recordingBroadcaster struct {
	mu    sync.Mutex
	txids []string
}

func (b *recordingBroadcaster) Broadcast(tx *transaction.Transaction) (*transaction.BroadcastSuccess, *transaction.BroadcastFailure) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.txids = append(b.txids, tx.TxID().String())
	return &transaction.BroadcastSuccess{Txid: tx.TxID().String()}, nil
}

func (b *recordingBroadcaster) BroadcastCtx(_ context.Context, tx *transaction.Transaction) (*transaction.BroadcastSuccess, *transaction.BroadcastFailure) {
	return b.Broadcast(tx)
}

func (b *recordingBroadcaster) count(txid string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, id := range b.txids {
		if id == txid {
			n++
		}
	}
	return n
}

// flowCommitted asserts the coin src.vout is spent on topic by spender and spender is applied there: the coin is not
// left spent by an unapplied transaction.
func flowCommitted(t *testing.T, f *engineFlow, topic, srcTxid string, vout uint32, spender string) {
	t.Helper()
	if by, err := f.es.SpendStateOf(f.ctx, topic, srcTxid, vout); err != nil || by != spender {
		t.Fatalf("%s.%d on %s spent by %q (%v), want %s", srcTxid[:8], vout, topic, by, err, spender)
	}
	if applied, err := f.es.AppliedTopics(f.ctx, spender); err != nil || !slices.Contains(applied, topic) {
		t.Fatalf("%s applied on %v (%v), want %s", spender[:8], applied, err, topic)
	}
}

// (a) A pre-broadcast fault: ls_<id>.OutputSpent takes the input's row and then fails. The first submit errors with the
// coin marked spent by tr, its row gone and nothing broadcast or applied. The resubmit of the same bytes is admitted:
// the repair rebuilds the row from the journal (the coin is spent by tr itself), the resubmit's own OutputSpent takes
// it again, and balances and supply move exactly once.
func TestEngineResubmitAfterAFaultInTheSpendNotificationIsAdmitted(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_selfspend_spent")
	f.deps.Spends = flowSpends{es: f.es}
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	d := mandalatest.Deploy(t, issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic, ls := f.hostWithFaultyLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)
	iss := mandalatest.Issue(t, d, 0, issuer, holder, 100)
	f.mustSubmit(iss, topic)
	b := &recordingBroadcaster{}
	f.eng.Broadcaster = b

	tr := mandalatest.Transfer(t, iss, 1, receiver, 40)
	ls.spentAfterTake.Store(true)
	if _, err := f.submit(tr, topic); !errors.Is(err, errInjectedLookup) {
		t.Fatalf("first submit: err = %v, want the injected fault", err)
	}
	if by, err := f.es.SpendStateOf(f.ctx, topic, iss.Txid, 1); err != nil || by != tr.Txid {
		t.Fatalf("after the fault iss.1 is spent by %q (%v), want tr", by, err)
	}
	if row, err := f.store.GetTokenRow(f.ctx, iss.Txid, 1); err != nil || row != nil {
		t.Fatalf("after the fault the row of iss.1 = %+v (%v), want taken", row, err)
	}
	if n := b.count(tr.Txid); n != 0 {
		t.Fatalf("tr broadcast %d times before the fault, want 0 (step 7 precedes step 8)", n)
	}

	f.repairs = nil
	flowEntry(t, f.mustSubmit(tr, topic), topic, []uint32{0, 1}, []uint32{0})
	flowCommitted(t, f, topic, iss.Txid, 1, tr.Txid)
	if b.count(tr.Txid) != 1 {
		t.Fatalf("tr broadcast %d times, want 1", b.count(tr.Txid))
	}
	if want := []string{iss.Txid + ".1"}; !slices.Equal(f.repairs, want) {
		t.Fatalf("repairs = %v, want %v (the self-spent coin repaired inline)", f.repairs, want)
	}
	if row, err := f.store.GetTokenRow(f.ctx, iss.Txid, 1); err != nil || row != nil {
		t.Fatalf("the repaired row of iss.1 = %+v (%v), want taken again by the resubmit's spend", row, err)
	}
	for key, want := range map[string]int64{holder.Identity: 60, receiver.Identity: 40} {
		if got := flowBalance(t, f, key); got != want {
			t.Fatalf("balance of %s = %d, want %d", key[:8], got, want)
		}
	}
	if got := flowSupply(t, f, id); got != "100" {
		t.Fatalf("supply = %s, want 100", got)
	}

	// A different spend of iss.1 is the final ERR_INPUT_SPENT naming tr; maintenance changes nothing.
	_, err := f.submit(mandalatest.Transfer(t, iss, 1, receiver, 10), topic)
	if rej := mgrRefusal(t, err, CodeInputSpent, "input "+iss.Txid+".1: already spent by "+tr.Txid, topic); rej.SpendTxid != tr.Txid {
		t.Fatalf("SpendTxid = %q, want tr", rej.SpendTxid)
	}
	if repaired := flowMaintenance(t, f, id, topic); repaired != 0 {
		t.Fatalf("reconcile repaired %d rows, want 0", repaired)
	}
	if got := flowSupply(t, f, id); got != "100" || flowBalance(t, f, holder.Identity) != 60 || flowBalance(t, f, receiver.Identity) != 40 {
		t.Fatalf("after maintenance: supply %s, holder %d, receiver %d", got, flowBalance(t, f, holder.Identity), flowBalance(t, f, receiver.Identity))
	}
}

// (b) A post-broadcast fault (§C3, §C9): an admin action (freezeOutput of iss.1, spending the authority iss.0) is
// broadcast, its output inserted, then ls_<id>.OutputAdmittedByTopic fails before any write, so no history row and no
// applied record exist. The resubmit is admitted and the freeze is folded: a transfer of the frozen coin is refused.
func TestEngineResubmitAfterAPostBroadcastFaultFoldsTheAdminAction(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_selfspend_admit")
	f.deps.Spends = flowSpends{es: f.es}
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	d := mandalatest.Deploy(t, issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic, ls := f.hostWithFaultyLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)
	iss := mandalatest.Issue(t, d, 0, issuer, holder, 100)
	f.mustSubmit(iss, topic)
	b := &recordingBroadcaster{}
	f.eng.Broadcaster = b

	frozenOp := iss.Txid + ".1"
	freeze := mandalatest.Build(t, []mandalatest.In{{Src: iss, Vout: 0}},
		[]mandalatest.Out{mgrActionOut(t, id, AdminDetails{Kind: "freezeOutput", Outpoint: frozenOp})}, nil)
	ls.admitted.Store(true)
	if _, err := f.submit(freeze, topic); !errors.Is(err, errInjectedLookup) {
		t.Fatalf("first submit: err = %v, want the injected fault", err)
	}
	if b.count(freeze.Txid) != 1 {
		t.Fatalf("freeze broadcast %d times, want 1: the fault must come after the broadcast", b.count(freeze.Txid))
	}
	if applied, err := f.es.AppliedTopics(f.ctx, freeze.Txid); err != nil || len(applied) != 0 {
		t.Fatalf("freeze applied on %v (%v) after the fault, want none", applied, err)
	}
	if row, err := f.store.GetAuthorityRow(f.ctx, iss.Txid, 0); err != nil || row != nil {
		t.Fatalf("after the fault the authority row of iss.0 = %+v (%v), want taken", row, err)
	}
	if state, err := f.store.GetAssetState(f.ctx, id); err != nil || len(state.FrozenOutpoints) != 0 {
		t.Fatalf("the freeze was folded before its resubmit: %+v (%v)", state.FrozenOutpoints, err)
	}

	flowEntry(t, f.mustSubmit(freeze, topic), topic, []uint32{0}, []uint32{0})
	flowCommitted(t, f, topic, iss.Txid, 0, freeze.Txid)
	state, err := f.store.GetAssetState(f.ctx, id)
	if err != nil || !slices.Equal(state.FrozenOutpoints, []FrozenRef{{Outpoint: frozenOp, Amount: 100, Owner: holder.Identity}}) {
		t.Fatalf("folded freeze = %+v, %v", state.FrozenOutpoints, err)
	}
	_, err = f.submit(mandalatest.Transfer(t, iss, 1, receiver, 40), topic)
	requireReject(t, err, CodeFrozen, "input 0: coin "+frozenOp+" is frozen")
	if got := flowAuthorityOutpoints(t, f, topic, id); !slices.Equal(got, []string{freeze.Txid + ".0"}) {
		t.Fatalf("authority rows = %v, want the freeze's only", got)
	}
	history, err := f.store.FindAdminHistory(f.ctx, id, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, h := range history {
		kinds = append(kinds, h.Kind)
	}
	if want := []string{"issue", "freezeOutput"}; !slices.Equal(kinds, want) {
		t.Fatalf("history kinds = %v, want %v", kinds, want)
	}
}

// (c) tm_mandala_kyc: the same fault on an admitIdentity spending the registry authority, in the spend notification
// (after the take) or after the broadcast; the resubmit is admitted, the identity admitted and the chain continues.
func TestEngineKYCResubmitAfterALookupFaultIsAdmitted(t *testing.T) {
	for _, stage := range []string{"OutputSpent after the take", "OutputAdmittedByTopic"} {
		t.Run(stage, func(t *testing.T) {
			f := newEngineFlow(t, "mandala3_test_flow_selfspend_kyc")
			kyc, err := NewKYCTopicManager(KYCTopicDeps{Verifier: f.deps.Verifier, TrustedIssuers: f.deps.TrustedIssuers,
				Store: f.store, Engine: f.es, Claims: f.store, Spends: flowSpends{es: f.es}, OnOwnerRepair: func(string, bool) {}})
			if err != nil {
				t.Fatal(err)
			}
			ls := &lookupFault{LookupService: NewKYCLookupService(f.store)}
			f.eng.RegisterLookupService(KYCLookup, ls)
			f.eng.RegisterTopicManager(KYCTopic, kyc)
			holder, receiver := mandalatest.Holder, mandalatest.Receiver

			reg := kycDeploy(t, "Mandala registry")
			regID := brc162.DeployTokenID(reg.Txid, 0)
			f.mustSubmit(reg, KYCTopic)
			admit := kycAction(t, reg, 0, regID, AdminDetails{Kind: "admitIdentity", IdentityKey: holder.Identity})
			if stage == "OutputAdmittedByTopic" {
				ls.admitted.Store(true)
			} else {
				ls.spentAfterTake.Store(true)
			}
			if _, err := f.submit(admit, KYCTopic); !errors.Is(err, errInjectedLookup) {
				t.Fatalf("first submit: err = %v, want the injected fault", err)
			}
			if row, err := f.store.GetAuthorityRow(f.ctx, reg.Txid, 0); err != nil || row != nil {
				t.Fatalf("after the fault the registry authority row = %+v (%v), want taken", row, err)
			}
			if ok, err := f.store.KYCAdmitted(f.ctx, holder.Identity); err != nil || ok {
				t.Fatalf("holder admitted before the resubmit: %v, %v", ok, err)
			}

			flowEntry(t, f.mustSubmit(admit, KYCTopic), KYCTopic, []uint32{0}, []uint32{0})
			flowCommitted(t, f, KYCTopic, reg.Txid, 0, admit.Txid)
			if ok, err := f.store.KYCAdmitted(f.ctx, holder.Identity); err != nil || !ok {
				t.Fatalf("holder admitted = %v, %v", ok, err)
			}
			if got := flowAuthorityOutpoints(t, f, KYCTopic, regID); !slices.Equal(got, []string{admit.Txid + ".0"}) {
				t.Fatalf("registry authority rows = %v, want the admit's only", got)
			}
			next := kycAction(t, admit, 0, regID, AdminDetails{Kind: "admitIdentity", IdentityKey: receiver.Identity})
			flowEntry(t, f.mustSubmit(next, KYCTopic), KYCTopic, []uint32{0}, []uint32{0})
			if ok, err := f.store.KYCAdmitted(f.ctx, receiver.Identity); err != nil || !ok {
				t.Fatalf("receiver admitted = %v, %v", ok, err)
			}
		})
	}
}

// V-17 on the real engine: a second admin transaction spending the registry authority coin the first one committed
// is the final ERR_INPUT_SPENT naming the first, not a retryable 503.
func TestEngineKYCDoubleSpendIsInputSpent(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_kyc_double_spend")
	kyc, err := NewKYCTopicManager(KYCTopicDeps{Verifier: f.deps.Verifier, TrustedIssuers: f.deps.TrustedIssuers,
		Store: f.store, Engine: f.es, Claims: f.store, Spends: flowSpends{es: f.es}, OnOwnerRepair: func(string, bool) {}})
	if err != nil {
		t.Fatal(err)
	}
	f.eng.RegisterLookupService(KYCLookup, NewKYCLookupService(f.store))
	f.eng.RegisterTopicManager(KYCTopic, kyc)
	reg := kycDeploy(t, "Mandala registry")
	regID := brc162.DeployTokenID(reg.Txid, 0)
	f.mustSubmit(reg, KYCTopic)
	first := kycAction(t, reg, 0, regID, AdminDetails{Kind: "admitIdentity", IdentityKey: mandalatest.Holder.Identity})
	f.mustSubmit(first, KYCTopic)

	second := kycAction(t, reg, 0, regID, AdminDetails{Kind: "admitIdentity", IdentityKey: mandalatest.Receiver.Identity})
	for attempt := 1; attempt <= 2; attempt++ {
		_, err := f.submit(second, KYCTopic)
		if rej := mgrRefusal(t, err, CodeInputSpent, "input "+reg.Txid+".0: already spent by "+first.Txid, KYCTopic); rej.SpendTxid != first.Txid {
			t.Fatalf("attempt %d: SpendTxid = %q, want %s", attempt, rej.SpendTxid, first.Txid)
		}
	}
	if ok, err := f.store.KYCAdmitted(f.ctx, mandalatest.Receiver.Identity); err != nil || ok {
		t.Fatalf("the refused admit was applied: %v, %v", ok, err)
	}
}

// §C11: a crash after the engine's MarkUTXOsAsSpent(iss.1, tr) and before OutputSpent leaves the row of iss.1 beside a
// coin spent by an unapplied tr. Without maintenance the resubmit is admitted (the control). With a maintenance run
// first, the sweep keeps that row (tr has no applied record on the topic), so the resubmit is admitted the same way;
// after the commit, a maintenance run changes nothing.
func TestEngineSweepKeepsTheRowOfAnUncommittedSpend(t *testing.T) {
	for _, maintain := range []bool{false, true} {
		name := "control"
		if maintain {
			name = "maintenance before the resubmit"
		}
		t.Run(name, func(t *testing.T) {
			f := newEngineFlow(t, "mandala3_test_flow_sweep_pending")
			f.deps.Spends = flowSpends{es: f.es}
			issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
			d := mandalatest.Deploy(t, issuer, "USD")
			id := brc162.DeployTokenID(d.Txid, 0)
			topic := f.hostWithLookup(id)
			f.mustSubmit(d, MandalaTopic, topic)
			iss := mandalatest.Issue(t, d, 0, issuer, holder, 100)
			f.mustSubmit(iss, topic)
			tr := mandalatest.Transfer(t, iss, 1, receiver, 40)
			op := &transaction.Outpoint{Txid: *iss.Tx.TxID(), Index: 1}
			if err := f.es.MarkUTXOsAsSpent(f.ctx, []*transaction.Outpoint{op}, topic, tr.Tx.TxID()); err != nil {
				t.Fatalf("mark: %v", err)
			}

			if maintain {
				taken, err := SweepOwnerIndex(f.ctx, SweepDeps{Store: f.store, Engine: f.es, Spends: f.deps.Spends, Applied: f.es, TokenIDs: []string{id}})
				if err != nil || taken != 0 {
					t.Fatalf("sweep took %d (%v), want 0: the row of an uncommitted spend is not a phantom", taken, err)
				}
				if repaired := flowMaintenance(t, f, id, topic); repaired != 0 {
					t.Fatalf("reconcile repaired %d rows, want 0", repaired)
				}
				if row, err := f.store.GetTokenRow(f.ctx, iss.Txid, 1); err != nil || row == nil || flowBalance(t, f, holder.Identity) != 100 {
					t.Fatalf("after maintenance: row of iss.1 %+v (%v), holder %d; want the row and 100", row, err, flowBalance(t, f, holder.Identity))
				}
			}

			flowEntry(t, f.mustSubmit(tr, topic), topic, []uint32{0, 1}, []uint32{0})
			flowCommitted(t, f, topic, iss.Txid, 1, tr.Txid)
			for key, want := range map[string]int64{holder.Identity: 60, receiver.Identity: 40} {
				if got := flowBalance(t, f, key); got != want {
					t.Fatalf("balance of %s = %d, want %d", key[:8], got, want)
				}
			}
			if repaired := flowMaintenance(t, f, id, topic); repaired != 0 {
				t.Fatalf("reconcile after the commit repaired %d rows, want 0", repaired)
			}
			if got := flowSupply(t, f, id); got != "100" || flowBalance(t, f, holder.Identity) != 60 {
				t.Fatalf("after the commit and maintenance: supply %s, holder %d", got, flowBalance(t, f, holder.Identity))
			}
			if row, err := f.store.GetTokenRow(f.ctx, iss.Txid, 1); err != nil || row != nil {
				t.Fatalf("the row of the committed spend iss.1 = %+v (%v), want none", row, err)
			}
		})
	}
}

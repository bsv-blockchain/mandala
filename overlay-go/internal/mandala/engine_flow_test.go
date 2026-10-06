package mandala

import (
	"context"
	"fmt"
	"reflect"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

// engineFlow is a real v1.3.7 engine on real Mongo with tm_mandala registered and token topics
// hosted by hand (no registrar, no host rules). Submits carry the envelope in ctx, as httpapi does.
type engineFlow struct {
	t       *testing.T
	ctx     context.Context
	eng     *engine.Engine
	es      *enginestore.Store
	store   *Store
	deps    TokenTopicDeps
	repairs []string
}

func newEngineFlow(t *testing.T, dbName string) *engineFlow {
	t.Helper()
	db := testmongo.DB(t, dbName)
	es, err := enginestore.New(db)
	if err != nil {
		t.Fatalf("enginestore: %v", err)
	}
	store, err := NewStore(db)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	f := &engineFlow{t: t, ctx: ctx, es: es, store: store}
	v := overlayVerifier(t)
	f.deps = TokenTopicDeps{
		Verifier:         v,
		TrustedIssuers:   []string{mandalatest.Issuer.Identity},
		MembershipExempt: []string{v.IdentityKey()},
		Store:            store,
		Engine:           es,
		Screening:        NoSanctions{},
		OnOwnerRepair:    func(op string, _ bool) { f.repairs = append(f.repairs, op) },
	}
	reg, err := NewTokenRegistryTopicManager(f.deps)
	if err != nil {
		t.Fatalf("registry manager: %v", err)
	}
	f.eng = engine.NewEngine(&engine.Config{
		Managers:     map[string]engine.TopicManager{MandalaTopic: reg},
		Storage:      es,
		ChainTracker: mandalatest.ScriptsOnlyTracker(),
	})
	return f
}

// host registers tm_<tokenID> with a manager built from f.deps as they are now.
func (f *engineFlow) host(tokenID string) string {
	f.t.Helper()
	m, err := NewTokenTopicManager(tokenID, f.deps)
	if err != nil {
		f.t.Fatalf("token manager %s: %v", tokenID, err)
	}
	f.eng.RegisterTopicManager(m.Topic(), m)
	return m.Topic()
}

func (f *engineFlow) submit(b *mandalatest.Built, topics ...string) (overlay.Steak, error) {
	return f.eng.Submit(WithOffChainValues(f.ctx, b.OffChain),
		overlay.TaggedBEEF{Beef: b.Beef, Topics: topics, OffChainValues: b.OffChain}, engine.SubmitModeCurrent, nil)
}

func (f *engineFlow) mustSubmit(b *mandalatest.Built, topics ...string) overlay.Steak {
	f.t.Helper()
	steak, err := f.submit(b, topics...)
	if err != nil {
		f.t.Fatalf("submit %s to %v: %v", b.Txid, topics, err)
	}
	return steak
}

func flowEntry(t *testing.T, steak overlay.Steak, topic string, outputs, coins []uint32) {
	t.Helper()
	e := steak[topic]
	if e == nil {
		t.Fatalf("no STEAK entry for %s in %v", topic, steak)
	}
	if !slices.Equal(e.OutputsToAdmit, outputs) || !slices.Equal(e.CoinsToRetain, coins) {
		t.Fatalf("%s admitted {%v %v}, want {%v %v}", topic, e.OutputsToAdmit, e.CoinsToRetain, outputs, coins)
	}
}

// flowSpends is the conflicting-spend source wiring builds from the engine store (D-6).
type flowSpends struct{ es *enginestore.Store }

func (s flowSpends) SpentBy(ctx context.Context, topic, txid string, vout uint32) (string, error) {
	return s.es.SpendStateOf(ctx, topic, txid, vout)
}

func TestEngineDeployThroughBothTopics(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_managers")
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic := f.host(id)
	steak := f.mustSubmit(d, MandalaTopic, topic)
	flowEntry(t, steak, MandalaTopic, []uint32{0}, []uint32{})
	flowEntry(t, steak, topic, []uint32{0}, []uint32{})

	rows, err := f.store.OwnerJournalByOutpoint(f.ctx, d.Txid, 0)
	if err != nil || len(rows) != 1 || rows[0].Topic != topic || rows[0].Role != brc162.RoleDeploy || rows[0].IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("journal = %+v, %v; want one deploy row under %s", rows, err, topic)
	}
	for _, tp := range []string{MandalaTopic, topic} {
		if live, err := f.es.IsUnspent(f.ctx, tp, d.Txid, 0); err != nil || !live {
			t.Fatalf("deploy coin on %s: live=%v err=%v", tp, live, err)
		}
	}
	onRegistry, err := AdmissionDigestV3(MandalaTopic, d.Txid, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	onToken, err := AdmissionDigestV3(topic, d.Txid, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	if onRegistry == onToken {
		t.Fatal("the deploy's two σI digests are equal: v3 must bind the topic")
	}
}

func TestEngineIssueRetainsTheDeployCoin(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_managers")
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic := f.host(id)
	f.mustSubmit(d, MandalaTopic, topic)

	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	flowEntry(t, f.mustSubmit(iss, topic), topic, []uint32{0, 1}, []uint32{0})

	// G8: a retained coin keeps its spent doc, which eviction later un-marks
	spender, err := f.es.SpendStateOf(f.ctx, topic, d.Txid, 0)
	if err != nil || spender != iss.Txid {
		t.Fatalf("deploy coin on %s spent by %q (%v), want %s", topic, spender, err, iss.Txid)
	}
	// G16: the tm_mandala copy of the deploy is never marked spent by an issue naming tm_<id> only
	if live, err := f.es.IsUnspent(f.ctx, MandalaTopic, d.Txid, 0); err != nil || !live {
		t.Fatalf("tm_mandala deploy copy: live=%v err=%v", live, err)
	}
	// no lookups ran, so the issue repaired the deploy's authority row from the journal (§4.2a rule 3)
	if want := []string{d.Txid + ".0"}; !slices.Equal(f.repairs, want) {
		t.Fatalf("repairs = %v, want %v", f.repairs, want)
	}
	row, err := f.store.GetAuthorityRow(f.ctx, d.Txid, 0)
	if err != nil || row == nil || row.Topic != topic || row.IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("repaired authority row = %+v, %v", row, err)
	}
}

func TestEngineConflictingSpendRefused(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_managers")
	f.deps.Spends = flowSpends{es: f.es}
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic := f.host(id)
	f.mustSubmit(d, MandalaTopic, topic)
	first := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	f.mustSubmit(first, topic)

	// the engine still lists the spent deploy coin as a previous coin (FindOutputs spent=nil)
	second := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 200)
	_, err := f.submit(second, topic)
	rej := mgrRefusal(t, err, CodeInputSpent, "input "+d.Txid+".0: already spent by "+first.Txid, topic)
	if rej.SpendTxid != first.Txid {
		t.Fatalf("SpendTxid = %q, want %s", rej.SpendTxid, first.Txid)
	}
}

// hostWithLookup registers ls_<tokenID> and then tm_<tokenID> (the order TokenTopics.Ensure uses).
func (f *engineFlow) hostWithLookup(tokenID string) string {
	f.t.Helper()
	ls, err := NewTokenLookupService(tokenID, f.deps.Verifier, f.store)
	if err != nil {
		f.t.Fatalf("token lookup %s: %v", tokenID, err)
	}
	f.eng.RegisterLookupService(ls.Name(), ls)
	return f.host(tokenID)
}

// withRegistryLookup registers ls_mandala.
func (f *engineFlow) withRegistryLookup() {
	f.eng.RegisterLookupService(MandalaLookup, NewTokenRegistryLookupService(f.deps.Verifier, f.store))
}

func flowTokenOutpoints(t *testing.T, f *engineFlow, tokenID string) []string {
	t.Helper()
	rows, err := f.store.FindTokensByTokenID(f.ctx, tokenID, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%s.%d", r.Txid, r.OutputIndex))
	}
	return out
}

func flowAuthorityOutpoints(t *testing.T, f *engineFlow, topic, tokenID string) []string {
	t.Helper()
	rows, err := f.store.ListAuthorities(f.ctx, topic, tokenID)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%s.%d", r.Txid, r.OutputIndex))
	}
	return out
}

func TestEngineFullFlowDeployIssueTransferTwoToken(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_full")
	f.withRegistryLookup()
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver

	deployA := mandalatest.Deploy(t, issuer, "USD")
	idA := brc162.DeployTokenID(deployA.Txid, 0)
	topicA := f.hostWithLookup(idA)
	f.mustSubmit(deployA, MandalaTopic, topicA)
	issueA := mandalatest.Issue(t, deployA, 0, issuer, holder, 100)
	flowEntry(t, f.mustSubmit(issueA, topicA), topicA, []uint32{0, 1}, []uint32{0})
	transferA := mandalatest.Transfer(t, issueA, 1, receiver, 40)
	flowEntry(t, f.mustSubmit(transferA, topicA), topicA, []uint32{0, 1}, []uint32{0})

	deployB := mandalatest.Deploy(t, issuer, "EUR")
	idB := brc162.DeployTokenID(deployB.Txid, 0)
	topicB := f.hostWithLookup(idB)
	f.mustSubmit(deployB, MandalaTopic, topicB)
	issueB := mandalatest.Issue(t, deployB, 0, issuer, holder, 50)
	f.mustSubmit(issueB, topicB)

	two := mandalatest.TwoTokenTransfer(t, transferA, 1, issueB, 1, receiver)
	steak := f.mustSubmit(two, topicA, topicB)
	flowEntry(t, steak, topicA, []uint32{0}, []uint32{0})
	flowEntry(t, steak, topicB, []uint32{1}, []uint32{1})

	for key, want := range map[string]int64{holder.Identity: 0, receiver.Identity: 150, issuer.Identity: 0} {
		if bal, err := f.store.GetBalance(f.ctx, key); err != nil || bal != want {
			t.Fatalf("balance of %s = %d, %v; want %d", key, bal, err, want)
		}
	}
	wantA := []string{transferA.Txid + ".0", two.Txid + ".0"}
	sort.Strings(wantA)
	if got := flowTokenOutpoints(t, f, idA); !slices.Equal(got, wantA) {
		t.Fatalf("rows of A = %v, want %v", got, wantA)
	}
	if got := flowTokenOutpoints(t, f, idB); !slices.Equal(got, []string{two.Txid + ".1"}) {
		t.Fatalf("rows of B = %v", got)
	}
	if got := flowAuthorityOutpoints(t, f, topicA, idA); !slices.Equal(got, []string{issueA.Txid + ".0"}) {
		t.Fatalf("authorities of A = %v (the spent deploy authority must be taken)", got)
	}
	if got := flowAuthorityOutpoints(t, f, topicB, idB); !slices.Equal(got, []string{issueB.Txid + ".0"}) {
		t.Fatalf("authorities of B = %v", got)
	}
	for id, sym := range map[string]string{idA: "USD", idB: "EUR"} {
		if md, err := f.store.FindMetadata(f.ctx, id); err != nil || md == nil || md.Sym != sym {
			t.Fatalf("metadata of %s = %+v, %v", id, md, err)
		}
		if s, err := f.store.GetAssetState(f.ctx, id); err != nil || s.LastAdmitSeq == 0 {
			t.Fatalf("state of %s not folded: %+v, %v", id, s, err)
		}
		if r, err := f.store.FindRegistryRecord(f.ctx, id); err != nil || r == nil || r.Issuer != issuer.Identity {
			t.Fatalf("registry record of %s = %+v, %v", id, r, err)
		}
	}
}

func TestEngineTransferOfALeavesTokenBUntouched(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_full")
	issuer, holder := mandalatest.Issuer, mandalatest.Holder
	deployA := mandalatest.Deploy(t, issuer, "USD")
	idA := brc162.DeployTokenID(deployA.Txid, 0)
	topicA := f.hostWithLookup(idA)
	deployB := mandalatest.Deploy(t, issuer, "EUR")
	idB := brc162.DeployTokenID(deployB.Txid, 0)
	topicB := f.hostWithLookup(idB)
	f.mustSubmit(deployA, MandalaTopic, topicA)
	f.mustSubmit(deployB, MandalaTopic, topicB)
	issueA := mandalatest.Issue(t, deployA, 0, issuer, holder, 100)
	f.mustSubmit(issueA, topicA)
	f.mustSubmit(mandalatest.Issue(t, deployB, 0, issuer, holder, 50), topicB)

	snapshot := func() ([]string, []string, int, AssetAdminState) {
		history, err := f.store.FindAdminHistory(f.ctx, idB, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		state, err := f.store.GetAssetState(f.ctx, idB)
		if err != nil {
			t.Fatal(err)
		}
		return flowTokenOutpoints(t, f, idB), flowAuthorityOutpoints(t, f, topicB, idB), len(history), state
	}
	rows1, auths1, hist1, state1 := snapshot()
	steak := f.mustSubmit(mandalatest.Transfer(t, issueA, 1, mandalatest.Receiver, 40), topicA)
	if len(steak) != 1 || steak[topicA] == nil {
		t.Fatalf("steak = %v, want only %s", steak, topicA)
	}
	rows2, auths2, hist2, state2 := snapshot()
	if !slices.Equal(rows1, rows2) || !slices.Equal(auths1, auths2) || hist1 != hist2 || !reflect.DeepEqual(state1, state2) {
		t.Fatalf("token B changed under a transfer of A (G18 fan-out): rows %v→%v auths %v→%v history %d→%d", rows1, rows2, auths1, auths2, hist1, hist2)
	}
}

func TestRegistryRecordSurvivesAnIssueThatNamesTmMandala(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_full")
	f.withRegistryLookup()
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic := f.hostWithLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)

	// V-1 makes this unreachable over HTTP; on the engine, tm_mandala retains nothing (G8, G16)
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	steak := f.mustSubmit(iss, MandalaTopic, topic)
	reg := steak[MandalaTopic]
	if reg == nil || len(reg.OutputsToAdmit) != 0 || len(reg.CoinsToRetain) != 0 || !slices.Equal(reg.CoinsRemoved, []uint32{0}) {
		t.Fatalf("tm_mandala entry = %+v, want {[] [] removed [0]}", reg)
	}
	flowEntry(t, steak, topic, []uint32{0, 1}, []uint32{0})
	regTopic := MandalaTopic
	if out, err := f.es.FindOutput(f.ctx, lkOutpoint(t, d.Txid, 0), &regTopic, nil, false); err != nil || out != nil {
		t.Fatalf("tm_mandala deploy doc = %+v, %v; want deleted", out, err)
	}
	if r, err := f.store.FindRegistryRecord(f.ctx, id); err != nil || r == nil {
		t.Fatalf("registry record = %+v, %v; want it kept (T7)", r, err)
	}
	if bal, _ := f.store.GetBalance(f.ctx, mandalatest.Holder.Identity); bal != 100 {
		t.Fatalf("holder balance = %d, want 100 (credited once)", bal)
	}
	if got := flowTokenOutpoints(t, f, id); !slices.Equal(got, []string{iss.Txid + ".1"}) {
		t.Fatalf("rows = %v", got)
	}
}

// D §8.2 owner index on the real engine and real Mongo (§4.2a rules 3 and 4). A lost owner row is repaired inline from
// the journal inside the manager phase, then the same submit's OutputSpent takes the repaired row back, so the balances
// move exactly once. A coin whose row and journal row are both gone is ERR_UNAVAILABLE on every retry (never a final
// refusal): the engine applies nothing and the coin stays live. (The 503 mapping of that code is pinned by Task 20's
// A1.3 matrix, row "typed unavailable".)
func TestEngineOwnerIndexRepairOnTheRealEngine(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_full")
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	d := mandalatest.Deploy(t, issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic := f.hostWithLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)
	iss := mandalatest.Issue(t, d, 0, issuer, holder, 100)
	f.mustSubmit(iss, topic)

	// A lost lookup write: the owner row of iss:1 is gone and its credit undone; the journal row stays.
	if took, err := takeRow(f.ctx, f.store, iss.Txid, 1); err != nil || !took {
		t.Fatalf("take iss:1 = %v, %v", took, err)
	}
	if bal, _ := f.store.GetBalance(f.ctx, holder.Identity); bal != 0 {
		t.Fatalf("holder balance after the lost write = %d, want 0", bal)
	}
	tr := mandalatest.Transfer(t, iss, 1, receiver, 40)
	flowEntry(t, f.mustSubmit(tr, topic), topic, []uint32{0, 1}, []uint32{0})
	if want := []string{iss.Txid + ".1"}; !slices.Equal(f.repairs, want) {
		t.Fatalf("repairs = %v, want %v (one inline repair)", f.repairs, want)
	}
	for key, want := range map[string]int64{holder.Identity: 60, receiver.Identity: 40} {
		if bal, err := f.store.GetBalance(f.ctx, key); err != nil || bal != want {
			t.Fatalf("balance of %s = %d, %v; want %d (credited once)", key, bal, err, want)
		}
	}
	if row, err := f.store.GetTokenRow(f.ctx, iss.Txid, 1); err != nil || row != nil {
		t.Fatalf("the repaired row of the spent coin = %+v, %v; want it taken by the spend", row, err)
	}

	// Row and journal row both gone: unrepairable.
	iss2 := mandalatest.Issue(t, iss, 0, issuer, holder, 50)
	f.mustSubmit(iss2, topic)
	if took, err := takeRow(f.ctx, f.store, iss2.Txid, 1); err != nil || !took {
		t.Fatalf("take iss2:1 = %v, %v", took, err)
	}
	if res, err := f.store.owners.DeleteOne(f.ctx, bson.D{{Key: "txid", Value: iss2.Txid}, {Key: "outputIndex", Value: 1}, {Key: "topic", Value: topic}}); err != nil || res.DeletedCount != 1 {
		t.Fatalf("delete the journal row of iss2:1: %+v, %v", res, err)
	}
	tr2 := mandalatest.Transfer(t, iss2, 1, receiver, 10)
	for attempt := 1; attempt <= 2; attempt++ {
		_, err := f.submit(tr2, topic)
		if rej := requireReject(t, err, CodeUnavailable, "owner index unavailable for "+iss2.Txid+".1"); rej.Topic != topic {
			t.Fatalf("attempt %d: refusal topic %q, want %s", attempt, rej.Topic, topic)
		}
	}
	if live, err := f.es.IsUnspent(f.ctx, topic, iss2.Txid, 1); err != nil || !live {
		t.Fatalf("iss2:1 live=%v err=%v: an unavailable owner index must leave the coin live", live, err)
	}
	if applied, err := f.es.DoesAppliedTransactionExist(f.ctx, &overlay.AppliedTransaction{Txid: tr2.Tx.TxID(), Topic: topic}); err != nil || applied {
		t.Fatalf("tr2 applied=%v err=%v; want nothing applied", applied, err)
	}
	if row, _ := f.store.GetTokenRow(f.ctx, iss2.Txid, 1); row != nil || len(f.repairs) != 1 {
		t.Fatalf("an unrepairable coin was repaired: row %+v, repairs %v", row, f.repairs)
	}
	if bal, _ := f.store.GetBalance(f.ctx, holder.Identity); bal != 60 {
		t.Fatalf("holder balance = %d, want 60 (nothing credited for the refused spend)", bal)
	}
}

// D §1.1 / §8.4 on the real engine: admin actions folded by ls_<id> gate the next submit through layers C and D.
// freeze -> a transfer of the frozen coin is ERR_FROZEN -> reissue (checked against the folded freeze) -> pause -> a
// transfer is ERR_PAUSED -> redeem (an admin action, so allowed while paused).
func TestEngineAdminActionsGateTheNextSubmit(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_flow_full")
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	d := mandalatest.Deploy(t, issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic := f.hostWithLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)
	iss := mandalatest.Issue(t, d, 0, issuer, holder, 100)
	f.mustSubmit(iss, topic)

	frozenOp := iss.Txid + ".1"
	freeze := mandalatest.Build(t, []mandalatest.In{{Src: iss, Vout: 0}},
		[]mandalatest.Out{mgrActionOut(t, id, AdminDetails{Kind: "freezeOutput", Outpoint: frozenOp})}, nil)
	flowEntry(t, f.mustSubmit(freeze, topic), topic, []uint32{0}, []uint32{0})
	state, err := f.store.GetAssetState(f.ctx, id)
	if err != nil || !slices.Equal(state.FrozenOutpoints, []FrozenRef{{Outpoint: frozenOp, Amount: 100, Owner: holder.Identity}}) {
		t.Fatalf("folded freeze = %+v, %v", state.FrozenOutpoints, err)
	}
	_, err = f.submit(mandalatest.Transfer(t, iss, 1, receiver, 40), topic)
	requireReject(t, err, CodeFrozen, "input 0: coin "+frozenOp+" is frozen")

	reissue := mandalatest.Build(t, []mandalatest.In{{Src: freeze, Vout: 0}}, []mandalatest.Out{
		mgrActionOut(t, id, AdminDetails{Kind: "reissue", Outpoint: frozenOp, Recipient: receiver.Identity}),
		{Owner: receiver, Prover: issuer, TokenID: id, Amount: 100},
	}, nil)
	flowEntry(t, f.mustSubmit(reissue, topic), topic, []uint32{0, 1}, []uint32{0})
	if state, err = f.store.GetAssetState(f.ctx, id); err != nil || len(state.FrozenOutpoints) != 0 || !slices.Contains(state.EvictedOutpoints, frozenOp) {
		t.Fatalf("folded reissue: frozen %+v, evicted %v, %v", state.FrozenOutpoints, state.EvictedOutpoints, err)
	}
	if bal, _ := f.store.GetBalance(f.ctx, receiver.Identity); bal != 100 {
		t.Fatalf("receiver balance after the reissue = %d, want 100", bal)
	}

	pause := mandalatest.Build(t, []mandalatest.In{{Src: reissue, Vout: 0}},
		[]mandalatest.Out{mgrActionOut(t, id, AdminDetails{Kind: "pause"})}, nil)
	flowEntry(t, f.mustSubmit(pause, topic), topic, []uint32{0}, []uint32{0})
	if state, err = f.store.GetAssetState(f.ctx, id); err != nil || !state.IsPaused {
		t.Fatalf("the pause was not folded: %+v, %v", state, err)
	}
	_, err = f.submit(mandalatest.Transfer(t, reissue, 1, holder, 10), topic)
	requireReject(t, err, CodePaused, "token "+id+" is paused")

	redeem := mandalatest.Build(t, []mandalatest.In{{Src: pause, Vout: 0}, {Src: reissue, Vout: 1}},
		[]mandalatest.Out{mgrActionOut(t, id, AdminDetails{Kind: "redeem"})}, nil)
	flowEntry(t, f.mustSubmit(redeem, topic), topic, []uint32{0}, []uint32{0, 1})
	if bal, _ := f.store.GetBalance(f.ctx, receiver.Identity); bal != 0 {
		t.Fatalf("receiver balance after the redeem = %d, want 0", bal)
	}
	history, err := f.store.FindAdminHistory(f.ctx, id, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, h := range history {
		kinds = append(kinds, h.Kind)
	}
	if want := []string{"issue", "freezeOutput", "reissue", "pause", "redeem"}; !slices.Equal(kinds, want) {
		t.Fatalf("history kinds = %v, want %v", kinds, want)
	}
}

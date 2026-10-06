package mandala

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"

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

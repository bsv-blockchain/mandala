package httpapi

// /submit on the real v3 stack: wiring.Build (real engine, real Mongo, scripts-only SPV) behind New(app), kit
// transactions with real signatures and linkages. Token topics are registered with app.Tokens.Ensure, because the
// deploy hook arrives in Task 23.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sort"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

type flowApp struct {
	app *wiring.App
	srv *fiber.App
}

// flowConfig: the kit's overlay key verifies every kit linkage and signs σI; the kit's issuer is the only trusted issuer.
func flowConfig(nodeName string) wiring.Config {
	return wiring.Config{
		NodeName:         nodeName,
		ServerPrivKeyHex: mandalatest.Overlay.PrivHex(),
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
		IssuerKeys:       []string{mandalatest.Issuer.Identity},
	}
}

// newFlowApp gives the test a fresh <NodeName>_lookup_services (testmongo skips when Mongo is down and drops it
// before and after) and builds the overlay on it.
func newFlowApp(t *testing.T, nodeName string) *flowApp {
	t.Helper()
	testmongo.DB(t, nodeName+"_lookup_services")
	return openFlowApp(t, flowConfig(nodeName))
}

// openFlowApp builds on the database as it stands: a second process on the same NodeName.
func openFlowApp(t *testing.T, cfg wiring.Config) *flowApp {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, err := wiring.Build(ctx, cfg, wiring.WithChainTracker(mandalatest.ScriptsOnlyTracker()))
	if err != nil {
		t.Fatalf("wiring.Build: %v", err)
	}
	t.Cleanup(func() {
		app.Close()
		_ = app.Mongo.Client().Disconnect(context.Background())
	})
	return &flowApp{app: app, srv: New(app)}
}

// ensure registers the deploy's token topic and returns tm_<txid>.
func (f *flowApp) ensure(t *testing.T, deploy *mandalatest.Built) string {
	t.Helper()
	if ok, err := f.app.Tokens.Ensure(deploy.Txid + "_0"); err != nil || !ok {
		t.Fatalf("Ensure(%s_0) = %v, %v", deploy.Txid, ok, err)
	}
	topic, err := mandala.TokenTopic(deploy.Txid + "_0")
	if err != nil {
		t.Fatal(err)
	}
	return topic
}

// post submits b with its framed envelope and returns the status and the decoded body.
func (f *flowApp) post(t *testing.T, b *mandalatest.Built, topics ...string) (int, map[string]any) {
	t.Helper()
	raw, err := json.Marshal(topics)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(mandalatest.SubmitBody(b)))
	req.Header.Set("X-Topics", string(raw))
	req.Header.Set("x-includes-off-chain-values", "true")
	resp := doRequest(t, f.srv, req)
	var body map[string]any
	if err := json.Unmarshal(readRawBody(t, resp), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return resp.StatusCode, body
}

func (f *flowApp) mustPost(t *testing.T, b *mandalatest.Built, topics ...string) map[string]any {
	t.Helper()
	status, body := f.post(t, b, topics...)
	if status != http.StatusOK {
		t.Fatalf("POST %s to %v: %d %v", b.Txid, topics, status, body)
	}
	return body
}

// deploy builds a deploy by the kit issuer, registers its topic and admits it to tm_mandala and tm_<txid>.
func (f *flowApp) deploy(t *testing.T, sym string) (*mandalatest.Built, string) {
	t.Helper()
	dep := mandalatest.Deploy(t, mandalatest.Issuer, sym)
	topic := f.ensure(t, dep)
	f.mustPost(t, dep, mandala.MandalaTopic, topic)
	return dep, topic
}

// kycAdmitIdentity is a registry admin transaction spending src.vout (the registry authority) into one issuer-owned
// authority output committing to admitIdentity(identityKey).
func kycAdmitIdentity(t *testing.T, src *mandalatest.Built, vout uint32, registryID, identityKey string) *mandalatest.Built {
	t.Helper()
	details, err := mandala.EncodeAdminDetails(mandala.AdminDetails{Kind: "admitIdentity", IdentityKey: identityKey})
	if err != nil {
		t.Fatal(err)
	}
	return mandalatest.Build(t, []mandalatest.In{{Src: src, Vout: vout}}, []mandalatest.Out{{Owner: mandalatest.Issuer,
		Prover: mandalatest.Issuer, TokenID: registryID, Payload: mandalatest.AdmPayload(sha256.Sum256(details)), HasPayload: true,
		Details: details}}, nil)
}

// V-17 (final review §C5) on the production stack: the KYC topic is wired with the conflicting-spend guard. Two admin
// transactions spend the registry authority coin; the second answers 400 ERR_INPUT_SPENT naming the first, final and
// with spendTxid on the wire (it used to be a retryable 503 "owner index unavailable", forever), on every retry, and
// nothing is persisted for it.
func TestSubmitKYCDoubleSpendIsInputSpent(t *testing.T) {
	f := newFlowApp(t, "mandala3_test_submit_flow_kyc_double")
	reg := mandalatest.Build(t, nil, []mandalatest.Out{{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer,
		Payload: mandalatest.DeployPayload("KYC", 0, "Mandala registry"), HasPayload: true}}, &mandalatest.Issuer)
	regID := reg.Txid + "_0"
	f.mustPost(t, reg, mandala.KYCTopic)
	first := kycAdmitIdentity(t, reg, 0, regID, mandalatest.Holder.Identity)
	f.mustPost(t, first, mandala.KYCTopic)

	second := kycAdmitIdentity(t, reg, 0, regID, mandalatest.Receiver.Identity)
	// The guard runs before the envelope (the KYC guard order amendment): a malformed envelope does not mask it.
	malformed := *second
	malformed.OffChain = []byte("[]")
	for attempt, b := range []*mandalatest.Built{second, second, &malformed} {
		status, body := f.post(t, b, mandala.KYCTopic)
		if status != http.StatusBadRequest || body["code"] != "ERR_INPUT_SPENT" || body["retryable"] != false ||
			body["spendTxid"] != first.Txid || body["description"] != "input "+reg.Txid+".0: already spent by "+first.Txid {
			t.Fatalf("attempt %d: %d %v", attempt+1, status, body)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if rec, err := f.app.Store.GetAdmission(ctx, second.Txid); err != nil || (rec != nil && rec.RefusedCode != "") {
		t.Fatalf("record of the refused double spend = %+v (%v), want no refusal persisted", rec, err)
	}
	if ok, err := f.app.Store.KYCAdmitted(ctx, mandalatest.Receiver.Identity); err != nil || ok {
		t.Fatalf("the refused admit was applied: %v, %v", ok, err)
	}
}

// A1.2: a deploy carries σI on both entries, bound to their topics; duplicate X-Topics collapse to one entry.
func TestSubmitDeployCarriesTwoTopicBoundSignatures(t *testing.T) {
	f := newFlowApp(t, "mandala3_test_submit_flow_deploy")
	ctx := context.Background()
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	topic := f.ensure(t, dep)

	body := f.mustPost(t, dep, mandala.MandalaTopic, topic, topic)
	if len(body) != 2 {
		t.Fatalf("STEAK = %v, want exactly the two named topics", body)
	}
	reg, tok := entryOf(t, body, mandala.MandalaTopic), entryOf(t, body, topic)
	for _, e := range []map[string]any{reg, tok} {
		if got := outputsOf(t, e); !reflect.DeepEqual(got, []uint32{0}) {
			t.Fatalf("outputs = %v, want [0]", got)
		}
	}
	requireSigma(t, reg, mandalatest.Overlay.Identity, mandala.MandalaTopic, dep.Txid, []uint32{0}, topic)
	requireSigma(t, tok, mandalatest.Overlay.Identity, topic, dep.Txid, []uint32{0}, mandala.MandalaTopic)
	if reg["admissionSignature"] == tok["admissionSignature"] {
		t.Fatal("the deploy's two σI are identical; digest v3 must bind the topic")
	}
	rec, err := f.app.Store.GetAdmission(ctx, dep.Txid)
	if err != nil || rec == nil || !rec.Admitted() {
		t.Fatalf("record = %+v (%v), want admitted", rec, err)
	}
	want := []string{mandala.MandalaTopic, topic}
	sort.Strings(want) // admissionKeys sorts, and every "tm_<hex>" sorts before "tm_mandala"
	if got := admissionKeys(*rec); !reflect.DeepEqual(got, want) {
		t.Fatalf("record admissions = %v, want %v", got, want)
	}
}

// Review Focus 1 — a retry with a different topic set. A two-token transfer first submitted naming only tm_<A> (lib
// bug), then retried naming tm_<A> and tm_<B>: the retry must reach Submit (no 200 replay), the engine skips tm_<A> as
// applied, tm_<B> admits B's output, the answer carries σI for both topics (A's re-signed from the record), the
// record's map gains tm_<B> without losing tm_<A>, and the provisional write merged the retry's spent outpoints.
func TestSubmitRetryWithExtraTopicReachesTheUncoveredTopic(t *testing.T) {
	f := newFlowApp(t, "mandala3_test_submit_flow_retry")
	ctx := context.Background()
	depA, topicA := f.deploy(t, "AAA")
	depB, topicB := f.deploy(t, "BBB")
	issA := mandalatest.Issue(t, depA, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	f.mustPost(t, issA, topicA)
	issB := mandalatest.Issue(t, depB, 0, mandalatest.Issuer, mandalatest.Holder, 70)
	f.mustPost(t, issB, topicB)
	x := mandalatest.TwoTokenTransfer(t, issA, 1, issB, 1, mandalatest.Receiver)

	first := f.mustPost(t, x, topicA)
	if got := outputsOf(t, entryOf(t, first, topicA)); !reflect.DeepEqual(got, []uint32{0}) {
		t.Fatalf("first submit: tm_<A> outputs %v, want [0]", got)
	}
	if live, err := f.app.EngineStore.IsUnspent(ctx, topicB, issB.Txid, 1); err != nil || !live {
		t.Fatalf("precondition: B's coin must still be live on tm_<B> (%v %v)", live, err)
	}

	second := f.mustPost(t, x, topicA, topicB)
	a, b := entryOf(t, second, topicA), entryOf(t, second, topicB)
	if got := outputsOf(t, a); !reflect.DeepEqual(got, []uint32{0}) {
		t.Fatalf("retry: tm_<A> outputs %v, want [0] (from the record)", got)
	}
	if got := outputsOf(t, b); !reflect.DeepEqual(got, []uint32{1}) {
		t.Fatalf("retry: tm_<B> outputs %v, want [1]", got)
	}
	requireSigma(t, a, mandalatest.Overlay.Identity, topicA, x.Txid, []uint32{0}, topicB)
	requireSigma(t, b, mandalatest.Overlay.Identity, topicB, x.Txid, []uint32{1}, topicA)

	// tm_<B> really ran: its output is admitted, B's input coin is spent there, and the manager journaled the owner.
	out, err := f.app.EngineStore.FindOutput(ctx, &transaction.Outpoint{Txid: *x.Tx.TxID(), Index: 1}, &topicB, nil, false)
	if err != nil || out == nil {
		t.Fatalf("x:1 is not admitted on tm_<B> (%v): the retry was answered without reaching the uncovered topic", err)
	}
	if live, _ := f.app.EngineStore.IsUnspent(ctx, topicB, issB.Txid, 1); live {
		t.Fatal("B's input coin is still live on tm_<B> although the transfer spent it")
	}
	rows, err := f.app.Store.OwnerJournalByOutpoint(ctx, x.Txid, 1)
	if err != nil || len(rows) != 1 || rows[0].Topic != topicB {
		t.Fatalf("journal for x:1 = %+v (%v), want one row under tm_<B>", rows, err)
	}
	if bal, _ := f.app.Store.GetBalance(ctx, mandalatest.Receiver.Identity); bal != 170 {
		t.Fatalf("receiver balance = %d, want 170 (100 of A + 70 of B)", bal)
	}

	rec, err := f.app.Store.GetAdmission(ctx, x.Txid)
	if err != nil || rec == nil || rec.Pending || rec.EvictedAt != "" {
		t.Fatalf("record = %+v (%v), want a final, unevicted record", rec, err)
	}
	wantTopics := []string{topicA, topicB}
	sort.Strings(wantTopics) // admissionKeys sorts; the deploy txids fix no order
	if got := admissionKeys(*rec); !reflect.DeepEqual(got, wantTopics) {
		t.Fatalf("record admissions = %v, want both topics %v", got, wantTopics)
	}
	if !reflect.DeepEqual(rec.Admissions[topicA].OutputsToAdmit, []uint32{0}) || !reflect.DeepEqual(rec.Admissions[topicB].OutputsToAdmit, []uint32{1}) {
		t.Fatalf("record admissions = %+v", rec.Admissions)
	}
	if !slices.Contains(rec.Topics, topicB) || rec.Restore == nil || !slices.Contains(rec.Restore.SpentOutpoints, issB.Txid+".1") {
		t.Fatalf("record topics %v / restore %+v must include the retry's topic and B's spent coin", rec.Topics, rec.Restore)
	}

	// Now both topics are applied: the same submit is a pure replay and changes nothing.
	third := f.mustPost(t, x, topicA, topicB)
	if !reflect.DeepEqual(outputsOf(t, entryOf(t, third, topicB)), []uint32{1}) {
		t.Fatalf("replay = %v", third)
	}
	if bal, _ := f.app.Store.GetBalance(ctx, mandalatest.Receiver.Identity); bal != 170 {
		t.Fatalf("receiver balance after the replay = %d, want 170", bal)
	}
}

// G6/A1.3 on the real stack: a submit naming an unhosted token topic is 400 unknown-topic and leaves nothing behind;
// once the topic is registered the identical bytes admit with σI.
func TestUnhostedTopicLeavesNothingAndTheSameBytesAdmitOnceHosted(t *testing.T) {
	const node = "mandala3_test_submit_flow_unhosted"
	f := newFlowApp(t, node)
	ctx := context.Background()
	dep, topic := f.deploy(t, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)

	// A second process on the same database that has not registered the token (no Start, no Ensure).
	g := openFlowApp(t, flowConfig(node))
	status, body := g.post(t, iss, topic)
	if status != http.StatusBadRequest || body["code"] != CodeShape || body["retryable"] != false || body["description"] != "unknown-topic: "+topic {
		t.Fatalf("unhosted: %d %v", status, body)
	}
	if rec, err := g.app.Store.GetAdmission(ctx, iss.Txid); err != nil || rec != nil {
		t.Fatalf("unhosted submit left a record: %+v (%v)", rec, err)
	}
	if ops, err := g.app.EngineStore.FindOutputsByTxid(ctx, iss.Txid); err != nil || len(ops) != 0 {
		t.Fatalf("unhosted submit reached the engine: %v (%v)", ops, err)
	}
	if live, _ := g.app.EngineStore.IsUnspent(ctx, topic, dep.Txid, 0); !live {
		t.Fatal("the deploy coin was touched by a refused submit")
	}

	if ok, err := g.app.Tokens.Ensure(dep.Txid + "_0"); err != nil || !ok {
		t.Fatalf("Ensure: %v %v", ok, err)
	}
	admitted := g.mustPost(t, iss, topic)
	e := entryOf(t, admitted, topic)
	if got := outputsOf(t, e); !reflect.DeepEqual(got, []uint32{0, 1}) {
		t.Fatalf("outputs = %v, want [0 1] (new authority + value)", got)
	}
	requireSigma(t, e, mandalatest.Overlay.Identity, topic, iss.Txid, []uint32{0, 1}, mandala.MandalaTopic)
}

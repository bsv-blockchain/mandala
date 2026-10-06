package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"sync"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/httpapi"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

const (
	e2eNode      = "mandala3_test_e2e"
	e2eAllowNode = "mandala3_test_e2e_allow"
)

type e2eOverlay struct {
	app  *wiring.App
	http *fiber.App
	stop func()
}

// e2eDB skips without Mongo and drops <node>_lookup_services before and after the test.
func e2eDB(t *testing.T, node string) {
	t.Helper()
	testmongo.DB(t, node+"_lookup_services")
}

// e2eBoot builds the production stack on node (scripts-only SPV, no broadcaster, the kit's overlay key, the kit
// issuer trusted), runs the boot (App.Start) and serves it through httpapi.New. stop is idempotent and registered
// for cleanup; it never drops the database (a restart test boots twice on it).
func e2eBoot(t *testing.T, node string, allow []string, allowSet bool) e2eOverlay {
	t.Helper()
	ctx := context.Background()
	app, err := wiring.Build(ctx, wiring.Config{
		NodeName:          node,
		ServerPrivKeyHex:  mandalatest.Overlay.PrivHex(),
		HostingURL:        "http://localhost:8081",
		MongoURL:          "mongodb://localhost:27017",
		Network:           "test",
		IssuerKeys:        []string{mandalatest.Issuer.Identity},
		TokenAllowlist:    allow,
		TokenAllowlistSet: allowSet,
	}, wiring.WithChainTracker(mandalatest.ScriptsOnlyTracker()))
	if err != nil {
		t.Fatalf("wiring.Build: %v", err)
	}
	var once sync.Once
	stop := func() {
		once.Do(func() {
			app.Close()
			_ = app.Mongo.Client().Disconnect(context.Background())
		})
	}
	t.Cleanup(stop)
	if err := app.Start(ctx); err != nil {
		t.Fatalf("App.Start: %v", err)
	}
	return e2eOverlay{app: app, http: httpapi.New(app), stop: stop}
}

func e2eDo(t *testing.T, o e2eOverlay, req *http.Request) (int, []byte) {
	t.Helper()
	resp, err := o.http.Test(req, -1)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, body
}

func e2eSubmit(t *testing.T, o e2eOverlay, b *mandalatest.Built, topics ...string) (int, []byte) {
	t.Helper()
	hdr, err := json.Marshal(topics)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(mandalatest.SubmitBody(b)))
	req.Header.Set("X-Topics", string(hdr))
	req.Header.Set("x-includes-off-chain-values", "true")
	req.Header.Set("Content-Type", "application/octet-stream")
	return e2eDo(t, o, req)
}

func e2eGet(t *testing.T, o e2eOverlay, path string) (int, []byte) {
	t.Helper()
	return e2eDo(t, o, httptest.NewRequest(http.MethodGet, path, nil))
}

type e2eAdmittance struct {
	OutputsToAdmit       []uint32 `json:"outputsToAdmit"`
	CoinsToRetain        []uint32 `json:"coinsToRetain"`
	AdmissionSignature   string   `json:"admissionSignature"`
	AdmissionIdentityKey string   `json:"admissionIdentityKey"`
}

// e2eAdmit submits b on topics, requires 200 and returns the STEAK.
func e2eAdmit(t *testing.T, o e2eOverlay, b *mandalatest.Built, topics ...string) map[string]e2eAdmittance {
	t.Helper()
	code, body := e2eSubmit(t, o, b, topics...)
	if code != 200 {
		t.Fatalf("submit %s on %v: %d %s", b.Txid, topics, code, body)
	}
	var steak map[string]e2eAdmittance
	if err := json.Unmarshal(body, &steak); err != nil {
		t.Fatalf("steak %s: %v", body, err)
	}
	return steak
}

// e2eSigma requires the entry to admit want and carry a σI by the overlay that verifies under topic only.
func e2eSigma(t *testing.T, topic, txid string, a e2eAdmittance, want []uint32) {
	t.Helper()
	if !slices.Equal(a.OutputsToAdmit, want) {
		t.Fatalf("%s admitted %v, want %v", topic, a.OutputsToAdmit, want)
	}
	if a.AdmissionIdentityKey != mandalatest.Overlay.Identity {
		t.Fatalf("%s σI identity %q, want the overlay's", topic, a.AdmissionIdentityKey)
	}
	ok, err := mandala.VerifyAdmission(topic, txid, want, a.AdmissionSignature, a.AdmissionIdentityKey)
	if err != nil || !ok {
		t.Fatalf("%s σI does not verify: %v", topic, err)
	}
}

type e2eToken struct {
	TokenID    string `json:"tokenId"`
	DeployTxid string `json:"deployTxid"`
	Sym        string `json:"sym"`
	Dec        int64  `json:"dec"`
	Label      string `json:"label"`
	Issuer     string `json:"issuer"`
	Hosted     bool   `json:"hosted"`
}

func e2eTokens(t *testing.T, o e2eOverlay) map[string]e2eToken {
	t.Helper()
	code, body := e2eGet(t, o, "/admin/tokens")
	var list []e2eToken
	if err := json.Unmarshal(body, &list); code != 200 || err != nil {
		t.Fatalf("GET /admin/tokens: %d %s %v", code, body, err)
	}
	out := map[string]e2eToken{}
	for _, tok := range list {
		out[tok.TokenID] = tok
	}
	return out
}

func e2eBalance(t *testing.T, o e2eOverlay, p mandalatest.Party) int64 {
	t.Helper()
	b, err := o.app.Store.GetBalance(context.Background(), p.Identity)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// A1.1 success criterion, part 1: one overlay following every token admits a deploy (both topics), an issue, a
// transfer and a two-token transfer, with one σI per topic.
func TestE2EFollowAllDeployIssueTransferTwoToken(t *testing.T) {
	e2eDB(t, e2eNode)
	o := e2eBoot(t, e2eNode, nil, false)
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver

	depA := mandalatest.Deploy(t, I, "USD")
	tmA := "tm_" + depA.Txid
	steak := e2eAdmit(t, o, depA, mandala.MandalaTopic, tmA)
	e2eSigma(t, mandala.MandalaTopic, depA.Txid, steak[mandala.MandalaTopic], []uint32{0})
	e2eSigma(t, tmA, depA.Txid, steak[tmA], []uint32{0})
	if steak[mandala.MandalaTopic].AdmissionSignature == steak[tmA].AdmissionSignature {
		t.Fatal("the deploy's two σI are identical: digest v3 must bind the topic")
	}
	if !o.app.Tokens.Hosted(depA.Txid + "_0") {
		t.Fatal("the deploy hook did not register tm_<A>")
	}

	issA := mandalatest.Issue(t, depA, 0, I, H, 1000)
	steak = e2eAdmit(t, o, issA, tmA)
	e2eSigma(t, tmA, issA.Txid, steak[tmA], []uint32{0, 1})
	if !slices.Equal(steak[tmA].CoinsToRetain, []uint32{0}) {
		t.Fatalf("issue coinsToRetain = %v, want [0] (the deploy coin, G8)", steak[tmA].CoinsToRetain)
	}

	trA := mandalatest.Transfer(t, issA, 1, R, 400)
	steak = e2eAdmit(t, o, trA, tmA)
	e2eSigma(t, tmA, trA.Txid, steak[tmA], []uint32{0, 1})

	depB := mandalatest.Deploy(t, I, "EUR")
	tmB := "tm_" + depB.Txid
	steak = e2eAdmit(t, o, depB, mandala.MandalaTopic, tmB)
	e2eSigma(t, tmB, depB.Txid, steak[tmB], []uint32{0})
	issB := mandalatest.Issue(t, depB, 0, I, H, 500)
	e2eSigma(t, tmB, issB.Txid, e2eAdmit(t, o, issB, tmB)[tmB], []uint32{0, 1})

	two := mandalatest.TwoTokenTransfer(t, trA, 1, issB, 1, R) // out0 = A 600, out1 = B 500, both to R
	steak = e2eAdmit(t, o, two, tmA, tmB)
	e2eSigma(t, tmA, two.Txid, steak[tmA], []uint32{0})
	e2eSigma(t, tmB, two.Txid, steak[tmB], []uint32{1})
	if steak[tmA].AdmissionSignature == steak[tmB].AdmissionSignature {
		t.Fatal("a two-token transfer's σI must differ per topic")
	}
	if h, r := e2eBalance(t, o, H), e2eBalance(t, o, R); h != 0 || r != 1500 {
		t.Fatalf("balances holder %d receiver %d, want 0 and 1500", h, r)
	}

	tokens := e2eTokens(t, o)
	for _, c := range []struct {
		dep *mandalatest.Built
		sym string
	}{{depA, "USD"}, {depB, "EUR"}} {
		tok, ok := tokens[c.dep.Txid+"_0"]
		if !ok || !tok.Hosted || tok.DeployTxid != c.dep.Txid || tok.Sym != c.sym || tok.Dec != 2 || tok.Label != "US Dollar" || tok.Issuer != I.Identity {
			t.Fatalf("/admin/tokens entry for %s = %+v (present %v)", c.sym, tok, ok)
		}
	}
	if len(tokens) != 2 {
		t.Fatalf("/admin/tokens = %+v, want A and B", tokens)
	}

	code, body := e2eGet(t, o, "/admin/admission/"+two.Txid)
	var adm struct {
		Txid       string `json:"txid"`
		Admissions map[string]struct {
			OutputsToAdmit     []uint32 `json:"outputsToAdmit"`
			AdmissionSignature string   `json:"admissionSignature"`
		} `json:"admissions"`
		AdmissionIdentityKey string `json:"admissionIdentityKey"`
	}
	if err := json.Unmarshal(body, &adm); code != 200 || err != nil {
		t.Fatalf("GET /admin/admission: %d %s %v", code, body, err)
	}
	if adm.Txid != two.Txid || len(adm.Admissions) != 2 || adm.AdmissionIdentityKey != mandalatest.Overlay.Identity ||
		!slices.Equal(adm.Admissions[tmA].OutputsToAdmit, []uint32{0}) || adm.Admissions[tmA].AdmissionSignature != steak[tmA].AdmissionSignature ||
		!slices.Equal(adm.Admissions[tmB].OutputsToAdmit, []uint32{1}) || adm.Admissions[tmB].AdmissionSignature != steak[tmB].AdmissionSignature {
		t.Fatalf("admission map = %+v", adm)
	}

	code, body = e2eGet(t, o, "/admin/activity?tokenId="+depA.Txid+"_0")
	var page struct {
		Entries []struct {
			Txid   string  `json:"txid"`
			Kind   string  `json:"kind"`
			From   *string `json:"from"`
			To     *string `json:"to"`
			Amount int64   `json:"amount"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(body, &page); code != 200 || err != nil {
		t.Fatalf("GET /admin/activity: %d %s %v", code, body, err)
	}
	kinds := map[string]string{}
	for _, e := range page.Entries {
		kinds[e.Txid] = e.Kind
	}
	if kinds[issA.Txid] != "issue" || kinds[trA.Txid] != "transfer" {
		t.Fatalf("activity kinds = %v, want the issue as issue and the transfer as transfer", kinds)
	}
}

// A1.1 success criterion, part 2: an allowlisted overlay refuses a submit naming an unlisted token topic with
// 400 ERR_SHAPE and keeps nothing of it.
func TestE2EAllowlistedOverlayRefusesAnUnlistedToken(t *testing.T) {
	e2eDB(t, e2eAllowNode)
	I := mandalatest.Issuer
	depA := mandalatest.Deploy(t, I, "USD")
	depB := mandalatest.Deploy(t, I, "EUR")
	o := e2eBoot(t, e2eAllowNode, []string{depA.Txid}, true) // the allowlist holds deploy txids, not _0 ids
	ctx := context.Background()

	e2eAdmit(t, o, depA, mandala.MandalaTopic, "tm_"+depA.Txid)

	code, body := e2eSubmit(t, o, depB, mandala.MandalaTopic, "tm_"+depB.Txid)
	var e struct {
		Code        string `json:"code"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(body, &e); code != 400 || err != nil || e.Code != "ERR_SHAPE" || e.Description != "unknown-topic: tm_"+depB.Txid {
		t.Fatalf("unlisted deploy: %d %s", code, body)
	}
	if code, body = e2eGet(t, o, "/admin/admission/"+depB.Txid); code != 404 {
		t.Fatalf("GET /admin/admission of the refused deploy: %d %s, want 404", code, body)
	}
	if o.app.Tokens.Hosted(depB.Txid+"_0") || o.app.Engine.HasTopicManager("tm_"+depB.Txid) {
		t.Fatal("an unlisted token was registered")
	}
	if outs, err := o.app.EngineStore.FindOutputsByTxid(ctx, depB.Txid); err != nil || len(outs) != 0 {
		t.Fatalf("engine outputs of the refused deploy = %v, err %v; want none", outs, err)
	}
	tokens := e2eTokens(t, o)
	if len(tokens) != 1 || !tokens[depA.Txid+"_0"].Hosted {
		t.Fatalf("/admin/tokens = %+v, want only A, hosted", tokens)
	}
}

// A1.1 success criterion, part 3: a restart re-registers every token from the boot union (registry records and
// owner-journal topics), including a token whose registry record is gone, and the boot repair (D-21, Q2
// restoreMissingRecords) puts that token back on GET /admin/tokens, the only token-list wire (A1.4).
func TestE2ERestartReRegistersFromTheBootUnion(t *testing.T) {
	e2eDB(t, e2eNode)
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	first := e2eBoot(t, e2eNode, nil, false)
	depA := mandalatest.Deploy(t, I, "USD")
	e2eAdmit(t, first, depA, mandala.MandalaTopic, "tm_"+depA.Txid)
	e2eAdmit(t, first, mandalatest.Issue(t, depA, 0, I, H, 1000), "tm_"+depA.Txid)
	depB := mandalatest.Deploy(t, I, "EUR")
	tmB := "tm_" + depB.Txid
	e2eAdmit(t, first, depB, mandala.MandalaTopic, tmB)
	issB := mandalatest.Issue(t, depB, 0, I, H, 500)
	e2eAdmit(t, first, issB, tmB)
	if err := first.app.Store.DeleteRegistryRecord(context.Background(), depB.Txid+"_0"); err != nil {
		t.Fatal(err)
	}
	first.stop()

	second := e2eBoot(t, e2eNode, nil, false)
	want := []string{depA.Txid + "_0", depB.Txid + "_0"}
	sort.Strings(want)
	if got := second.app.Tokens.Registered(); !slices.Equal(got, want) {
		t.Fatalf("Registered() after restart = %v, want %v (B from the owner journal)", got, want)
	}
	trB := mandalatest.Transfer(t, issB, 1, R, 200)
	e2eSigma(t, tmB, trB.Txid, e2eAdmit(t, second, trB, tmB)[tmB], []uint32{0, 1})
	tokens := e2eTokens(t, second)
	b, listed := tokens[depB.Txid+"_0"]
	if len(tokens) != 2 || !tokens[depA.Txid+"_0"].Hosted || !listed || !b.Hosted || b.DeployTxid != depB.Txid || b.Sym != "EUR" || b.Issuer != I.Identity {
		t.Fatalf("/admin/tokens = %+v, want A and B, both hosted (B's record rebuilt at boot from its metadata and deploy journal row)", tokens)
	}
}

// TT §6.5 over HTTP-admitted state: evicting a two-token transfer restores each input under its own topic,
// restores both owner rows and balances, leaves both asset states as they were and is idempotent.
func TestE2EEvictTwoTokenTransfer(t *testing.T) {
	e2eDB(t, e2eNode)
	o := e2eBoot(t, e2eNode, nil, false)
	ctx := context.Background()
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver

	depA := mandalatest.Deploy(t, I, "USD")
	tmA := "tm_" + depA.Txid
	e2eAdmit(t, o, depA, mandala.MandalaTopic, tmA)
	issA := mandalatest.Issue(t, depA, 0, I, H, 1000)
	e2eAdmit(t, o, issA, tmA)
	depB := mandalatest.Deploy(t, I, "EUR")
	tmB := "tm_" + depB.Txid
	e2eAdmit(t, o, depB, mandala.MandalaTopic, tmB)
	issB := mandalatest.Issue(t, depB, 0, I, H, 500)
	e2eAdmit(t, o, issB, tmB)

	stateBefore := map[string][]byte{}
	for _, id := range []string{depA.Txid + "_0", depB.Txid + "_0"} {
		code, body := e2eGet(t, o, "/admin/asset-state/"+id)
		if code != 200 {
			t.Fatalf("asset-state %s: %d %s", id, code, body)
		}
		stateBefore[id] = body
	}

	two := mandalatest.TwoTokenTransfer(t, issA, 1, issB, 1, R)
	e2eAdmit(t, o, two, tmA, tmB)
	if h, r := e2eBalance(t, o, H), e2eBalance(t, o, R); h != 0 || r != 1500 {
		t.Fatalf("after the transfer: holder %d receiver %d, want 0 and 1500", h, r)
	}
	rec, err := o.app.Store.GetAdmission(ctx, two.Txid)
	if err != nil || rec == nil || rec.Restore == nil ||
		!slices.Contains(rec.Restore.SpentOutpoints, issA.Txid+".1") || !slices.Contains(rec.Restore.SpentOutpoints, issB.Txid+".1") {
		t.Fatalf("admission record restore = %+v, err %v; want both token inputs (New(app) must pass WithBroadcastCompensation)", rec, err)
	}

	out, err := o.app.EvictTx(ctx, two.Txid)
	if err != nil {
		t.Fatalf("EvictTx: %v", err)
	}
	if out.AlreadyEvicted || out.RestoredOutpoints != 2 || out.RestoredTokenRows != 2 {
		t.Fatalf("eviction outcome = %+v, want 2 outpoints and 2 token rows restored", out)
	}
	for _, c := range []struct{ topic, txid string }{{tmA, issA.Txid}, {tmB, issB.Txid}} {
		live, err := o.app.EngineStore.IsUnspent(ctx, c.topic, c.txid, 1)
		if err != nil || !live {
			t.Fatalf("%s.1 on %s: live=%v err %v, want live again", c.txid, c.topic, live, err)
		}
		row, err := o.app.Store.GetTokenRow(ctx, c.txid, 1)
		if err != nil || row == nil {
			t.Fatalf("owner row %s.1 = %+v, err %v; want restored", c.txid, row, err)
		}
	}
	for vout := uint32(0); vout < 2; vout++ {
		if row, err := o.app.Store.GetTokenRow(ctx, two.Txid, vout); err != nil || row != nil {
			t.Fatalf("retired row %s.%d = %+v, err %v; want gone", two.Txid, vout, row, err)
		}
	}
	if h, r := e2eBalance(t, o, H), e2eBalance(t, o, R); h != 1500 || r != 0 {
		t.Fatalf("after eviction: holder %d receiver %d, want 1500 and 0", h, r)
	}
	for id, before := range stateBefore {
		code, after := e2eGet(t, o, "/admin/asset-state/"+id)
		if code != 200 || !bytes.Equal(before, after) {
			t.Fatalf("asset-state %s changed by evicting a plain transfer:\nbefore %s\nafter  %s", id, before, after)
		}
	}

	again, err := o.app.EvictTx(ctx, two.Txid)
	if err != nil || !again.AlreadyEvicted {
		t.Fatalf("replayed eviction = %+v, err %v; want AlreadyEvicted", again, err)
	}
	if h, r := e2eBalance(t, o, H), e2eBalance(t, o, R); h != 1500 || r != 0 {
		t.Fatalf("a replayed eviction moved balances: holder %d receiver %d", h, r)
	}
	code, body := e2eSubmit(t, o, two, tmA, tmB)
	var e struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &e); code != 410 || err != nil || e.Code != "ERR_EVICTED" {
		t.Fatalf("resubmitting the evicted transfer: %d %s, want 410 ERR_EVICTED", code, body)
	}
}

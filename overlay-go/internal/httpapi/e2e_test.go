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
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/colorprofile"
	"github.com/sirdeggen/mandala/overlay-go/internal/httpapi"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

const (
	e2eNode      = "mandala3_test_e2e"
	e2eAllowNode = "mandala3_test_e2e_allow"
	e2eColorNode = "mandala3_test_e2e_color"
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
	if !e2eVerifyByScheme(topic, txid, want, a.AdmissionSignature, a.AdmissionIdentityKey) {
		t.Fatalf("%s σI does not verify under its scheme", topic)
	}
}

// e2eVerifyByScheme: a color topic carries the BRC-207 attested v1 signature (BRC-42 child of the overlay key),
// tm_mandala carries σI v3 under the bare key (contract §3).
func e2eVerifyByScheme(topic, txid string, outs []uint32, sig, ident string) bool {
	switch mandala.AdmissionSchemeOf(topic) {
	case mandala.SchemeAttestedV1:
		return mandala.VerifyAttestation(topic, txid, outs, sig, ident)
	case mandala.SchemeMandalaV3:
		ok, err := mandala.VerifyAdmission(topic, txid, outs, sig, ident)
		return err == nil && ok
	default:
		return false
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
	if !b.Big().IsInt64() {
		t.Fatalf("balance %s is not an int64", b)
	}
	return b.Big().Int64()
}

// A1.1 success criterion, part 1: one overlay following every token admits a deploy (both topics), an issue, a
// transfer and a two-token transfer, with one σI per topic.
func TestE2EFollowAllDeployIssueTransferTwoToken(t *testing.T) {
	e2eDB(t, e2eNode)
	o := e2eBoot(t, e2eNode, nil, false)
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver

	depA := mandalatest.Deploy(t, I, "USD")
	tmA := mandala.TokenTopicOfTxid(depA.Txid)
	steak := e2eAdmit(t, o, depA, mandala.MandalaTopic, tmA)
	e2eSigma(t, mandala.MandalaTopic, depA.Txid, steak[mandala.MandalaTopic], []uint32{0})
	e2eSigma(t, tmA, depA.Txid, steak[tmA], []uint32{0})
	if steak[mandala.MandalaTopic].AdmissionSignature == steak[tmA].AdmissionSignature {
		t.Fatal("the deploy's two σI are identical: each scheme must bind the topic")
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
	tmB := mandala.TokenTopicOfTxid(depB.Txid)
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
			Amount string  `json:"amount"` // a decimal string (contract §0)
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

	e2eAdmit(t, o, depA, mandala.MandalaTopic, mandala.TokenTopicOfTxid(depA.Txid))

	code, body := e2eSubmit(t, o, depB, mandala.MandalaTopic, mandala.TokenTopicOfTxid(depB.Txid))
	var e struct {
		Code        string `json:"code"`
		Description string `json:"description"`
	}
	if err := json.Unmarshal(body, &e); code != 400 || err != nil || e.Code != "ERR_SHAPE" || e.Description != "unknown-topic: "+mandala.TokenTopicOfTxid(depB.Txid) {
		t.Fatalf("unlisted deploy: %d %s", code, body)
	}
	if code, body = e2eGet(t, o, "/admin/admission/"+depB.Txid); code != 404 {
		t.Fatalf("GET /admin/admission of the refused deploy: %d %s, want 404", code, body)
	}
	if o.app.Tokens.Hosted(depB.Txid+"_0") || o.app.Engine.HasTopicManager(mandala.TokenTopicOfTxid(depB.Txid)) {
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
	e2eAdmit(t, first, depA, mandala.MandalaTopic, mandala.TokenTopicOfTxid(depA.Txid))
	e2eAdmit(t, first, mandalatest.Issue(t, depA, 0, I, H, 1000), mandala.TokenTopicOfTxid(depA.Txid))
	depB := mandalatest.Deploy(t, I, "EUR")
	tmB := mandala.TokenTopicOfTxid(depB.Txid)
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
	tmA := mandala.TokenTopicOfTxid(depA.Txid)
	e2eAdmit(t, o, depA, mandala.MandalaTopic, tmA)
	issA := mandalatest.Issue(t, depA, 0, I, H, 1000)
	e2eAdmit(t, o, issA, tmA)
	depB := mandalatest.Deploy(t, I, "EUR")
	tmB := mandala.TokenTopicOfTxid(depB.Txid)
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

// Review Focus 2: a double-submit of an admitted tm_color_* transaction answers byte-identical attestations (RFC 6979),
// and /admin/admission serves the same bytes; the deploy's tm_mandala entry stays σI v3 under the bare key.
func TestE2EReplayReturnsIdenticalAttestation(t *testing.T) {
	e2eDB(t, e2eNode)
	o := e2eBoot(t, e2eNode, nil, false)
	I, H := mandalatest.Issuer, mandalatest.Holder

	dep := mandalatest.Deploy(t, I, "USD")
	tm := mandala.TokenTopicOfTxid(dep.Txid)
	depSteak := e2eAdmit(t, o, dep, mandala.MandalaTopic, tm)
	reg, tok := depSteak[mandala.MandalaTopic], depSteak[tm]
	if ok, err := mandala.VerifyAdmission(mandala.MandalaTopic, dep.Txid, []uint32{0}, reg.AdmissionSignature, mandalatest.Overlay.Identity); err != nil || !ok {
		t.Fatalf("deploy tm_mandala entry is not σI v3 under the bare key: %v", err)
	}
	if !mandala.VerifyAttestation(tm, dep.Txid, []uint32{0}, tok.AdmissionSignature, mandalatest.Overlay.Identity) {
		t.Fatal("deploy tm_color entry is not the attested v1 signature")
	}
	if ok, _ := mandala.VerifyAdmission(tm, dep.Txid, []uint32{0}, tok.AdmissionSignature, mandalatest.Overlay.Identity); ok {
		t.Fatal("deploy tm_color entry verifies under the bare key")
	}

	iss := mandalatest.Issue(t, dep, 0, I, H, 1000)
	first := e2eAdmit(t, o, iss, tm)[tm]
	second := e2eAdmit(t, o, iss, tm)[tm]
	if !slices.Equal(first.OutputsToAdmit, []uint32{0, 1}) || !slices.Equal(second.OutputsToAdmit, first.OutputsToAdmit) {
		t.Fatalf("outputsToAdmit first %v replay %v, want [0 1] twice", first.OutputsToAdmit, second.OutputsToAdmit)
	}
	if first.AdmissionSignature == "" || second.AdmissionSignature != first.AdmissionSignature {
		t.Fatalf("replay attestation %q differs from %q", second.AdmissionSignature, first.AdmissionSignature)
	}
	if first.AdmissionIdentityKey != mandalatest.Overlay.Identity || second.AdmissionIdentityKey != first.AdmissionIdentityKey {
		t.Fatalf("admissionIdentityKey first %q replay %q, want the overlay root key", first.AdmissionIdentityKey, second.AdmissionIdentityKey)
	}
	if !mandala.VerifyAttestation(tm, iss.Txid, first.OutputsToAdmit, first.AdmissionSignature, mandalatest.Overlay.Identity) {
		t.Fatal("the issue attestation does not verify")
	}

	code, body := e2eGet(t, o, "/admin/admission/"+iss.Txid)
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
	if adm.Txid != iss.Txid || len(adm.Admissions) != 1 || adm.AdmissionIdentityKey != mandalatest.Overlay.Identity ||
		!slices.Equal(adm.Admissions[tm].OutputsToAdmit, first.OutputsToAdmit) || adm.Admissions[tm].AdmissionSignature != first.AdmissionSignature {
		t.Fatalf("admission map = %+v", adm)
	}
}

// B7: the Mandala issuer-v1 handler's fallback for a receipt its host did not record re-submits the bare AtomicBEEF
// (no x-includes-off-chain-values, no envelope). An admitted transaction must answer with the same verifiable
// attestation (serveKnownVerdict replays without looking at the payload); an unadmitted one is refused.
func TestE2EBareReplayOfAnAdmittedTxReturnsItsAttestation(t *testing.T) {
	e2eDB(t, e2eNode)
	o := e2eBoot(t, e2eNode, nil, false)
	I, H := mandalatest.Issuer, mandalatest.Holder
	dep := mandalatest.Deploy(t, I, "USD")
	tm := mandala.TokenTopicOfTxid(dep.Txid)
	e2eAdmit(t, o, dep, mandala.MandalaTopic, tm)
	iss := mandalatest.Issue(t, dep, 0, I, H, 1000)
	first := e2eAdmit(t, o, iss, tm)[tm]

	bare := func(b *mandalatest.Built) (int, []byte) {
		hdr, _ := json.Marshal([]string{tm})
		req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(b.Beef))
		req.Header.Set("X-Topics", string(hdr))
		req.Header.Set("Content-Type", "application/octet-stream")
		return e2eDo(t, o, req)
	}
	code, body := bare(iss)
	var steak map[string]e2eAdmittance
	if err := json.Unmarshal(body, &steak); code != 200 || err != nil {
		t.Fatalf("bare replay of an admitted tx: %d %s", code, body)
	}
	got := steak[tm]
	if !slices.Equal(got.OutputsToAdmit, first.OutputsToAdmit) || got.AdmissionSignature != first.AdmissionSignature {
		t.Fatalf("bare replay %+v differs from the admission %+v", got, first)
	}
	if !mandala.VerifyAttestation(tm, iss.Txid, got.OutputsToAdmit, got.AdmissionSignature, mandalatest.Overlay.Identity) {
		t.Fatal("bare replay attestation does not verify")
	}

	// A transaction the overlay never admitted gets no admission from a bare submit.
	other := mandalatest.Issue(t, dep, 0, I, H, 7)
	if code, body := bare(other); code == 200 {
		var st map[string]e2eAdmittance
		_ = json.Unmarshal(body, &st)
		if len(st[tm].OutputsToAdmit) > 0 {
			t.Fatalf("a bare submit of an unadmitted tx was admitted: %s", body)
		}
	}
}

// Review Focus 4: a deploy whose req names another overlay's key is a final ERR_SHAPE. The refusal is persisted and
// replayed by payload hash, nothing is applied and no registry row exists; the same deploy with this overlay's req is
// a different transaction and is admitted on both topics.
func TestE2EDeployWrongReqIsFinalAndPersisted(t *testing.T) {
	e2eDB(t, e2eNode)
	o := e2eBoot(t, e2eNode, nil, false)
	I := mandalatest.Issuer
	const want = "output 0: deploy payload is not a valid Mandala deploy map (req does not match this overlay's Mandala profiles)"
	wrong := mandalatest.DeployWithPayload(t, I, mandalatest.DeployPayloadWith(brc162.CborMap{
		"sym": "USD", "dec": uint64(2), "label": "US Dollar", "req": colorprofile.MandalaReq(mandalatest.Rogue.Identity)}))
	tm := mandala.TokenTopicOfTxid(wrong.Txid)

	type refusal struct {
		Code        string `json:"code"`
		Retryable   *bool  `json:"retryable"`
		Description string `json:"description"`
	}
	requireRefusal := func(what string, code int, body []byte) {
		t.Helper()
		var r refusal
		if err := json.Unmarshal(body, &r); code != 400 || err != nil || r.Code != "ERR_SHAPE" || r.Retryable == nil || *r.Retryable || r.Description != want {
			t.Fatalf("%s: %d %s, want 400 final ERR_SHAPE %q", what, code, body, want)
		}
	}
	code, first := e2eSubmit(t, o, wrong, mandala.MandalaTopic, tm)
	requireRefusal("first submit", code, first)
	code, second := e2eSubmit(t, o, wrong, mandala.MandalaTopic, tm)
	requireRefusal("resubmit", code, second)
	if !bytes.Equal(first, second) {
		t.Fatalf("resubmit body %s differs from %s", second, first)
	}
	rec, err := o.app.Store.GetAdmission(context.Background(), wrong.Txid)
	if err != nil || rec == nil || rec.RefusedCode != "ERR_SHAPE" || rec.RefusedDescription != want || rec.RefusedPayloadHash != mandala.PayloadHashHex(wrong.OffChain) || rec.Admitted() {
		t.Fatalf("persisted refusal = %+v, err %v", rec, err)
	}
	code, body := e2eGet(t, o, "/admin/admission/"+wrong.Txid+"?payloadHash="+mandala.PayloadHashHex(wrong.OffChain))
	requireRefusal("GET /admin/admission?payloadHash", code, body)
	// without the payload hash the refusal is not served, and no applied engine record stands behind it
	if code, body := e2eGet(t, o, "/admin/admission/"+wrong.Txid); code != 404 {
		t.Fatalf("GET /admin/admission without payloadHash: %d %s, want 404 (nothing applied)", code, body)
	}
	if _, ok := e2eTokens(t, o)[wrong.Txid+"_0"]; ok {
		t.Fatal("a refused deploy has a registry row")
	}

	right := mandalatest.DeployWithPayload(t, I, mandalatest.DeployPayloadWith(brc162.CborMap{
		"sym": "USD", "dec": uint64(2), "label": "US Dollar", "req": colorprofile.MandalaReq(mandalatest.Overlay.Identity)}))
	if right.Txid == wrong.Txid {
		t.Fatal("the corrected deploy reuses the refused txid")
	}
	tmRight := mandala.TokenTopicOfTxid(right.Txid)
	steak := e2eAdmit(t, o, right, mandala.MandalaTopic, tmRight)
	if !slices.Equal(steak[mandala.MandalaTopic].OutputsToAdmit, []uint32{0}) || !slices.Equal(steak[tmRight].OutputsToAdmit, []uint32{0}) {
		t.Fatalf("corrected deploy STEAK = %+v", steak)
	}
	if _, ok := e2eTokens(t, o)[right.Txid+"_0"]; !ok {
		t.Fatal("the admitted deploy has no registry row")
	}
}

// Task 10 (contract §5.1, design B4) through /submit with x-includes-off-chain-values: an issuer payout under a
// p color derivation, then a holder transfer whose envelope is {"outputs":[…]} only, both attested on tm_color_<id>.
func TestE2EColorHolderFlow(t *testing.T) {
	e2eDB(t, e2eNode)
	o := e2eBoot(t, e2eNode, nil, false)
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver

	dep := mandalatest.Deploy(t, I, "TUSD")
	id := mandalatest.TokenIDOf(dep, 0)
	tm := mandala.TokenTopicOfTxid(dep.Txid)
	steak := e2eAdmit(t, o, dep, mandala.MandalaTopic, tm)
	e2eSigma(t, mandala.MandalaTopic, dep.Txid, steak[mandala.MandalaTopic], []uint32{0})
	e2eSigma(t, tm, dep.Txid, steak[tm], []uint32{0})

	r1 := &mandalatest.ColorRemittance{Prefix: "AAAAAAAAAAAAAAAAAAAAAA==", Suffix: "BBBBBBBBBBBBBBBBBBBBBB=="}
	iss := mandalatest.IssueTo(t, dep, 0, I, H, 1000, r1)
	e2eSigma(t, tm, iss.Txid, e2eAdmit(t, o, iss, tm)[tm], []uint32{0, 1})

	r2 := &mandalatest.ColorRemittance{Prefix: "pppppppppppppppppppppppppppppppppppppppppppppppp", Suffix: "ssssssssssssssssssssssssssssssssssssssssssssssss"}
	r3 := &mandalatest.ColorRemittance{Prefix: "CCCCCCCCCCCCCCCCCCCCCC==", Suffix: "DDDDDDDDDDDDDDDDDDDDDD=="}
	tr := mandalatest.BuildWith(t, []mandalatest.In{{Src: iss, Vout: 1}}, []mandalatest.Out{
		{Owner: R, Prover: H, TokenID: id, Amount: 600, Color: r2},
		{Owner: H, Prover: H, TokenID: id, Amount: 400, Color: r3},
	}, nil, mandalatest.BuildOptions{OutputsOnlyEnvelope: true})
	if !bytes.HasPrefix(tr.OffChain, []byte(`{"outputs":[`)) || bytes.Contains(tr.OffChain, []byte(`"inputs"`)) {
		t.Fatalf("not an outputs-only envelope: %s", tr.OffChain)
	}
	first := e2eAdmit(t, o, tr, tm)
	if len(first) != 1 {
		t.Fatalf("holder transfer STEAK = %+v, want only %s", first, tm)
	}
	e2eSigma(t, tm, tr.Txid, first[tm], []uint32{0, 1})
	if h, r := e2eBalance(t, o, H), e2eBalance(t, o, R); h != 400 || r != 600 {
		t.Fatalf("balances holder %d receiver %d, want 400 and 600", h, r)
	}
	// double-submit: the same attestation bytes, nothing moves
	second := e2eAdmit(t, o, tr, tm)[tm]
	if second.AdmissionSignature != first[tm].AdmissionSignature || !slices.Equal(second.OutputsToAdmit, first[tm].OutputsToAdmit) {
		t.Fatalf("replay %+v differs from %+v", second, first[tm])
	}
	if h, r := e2eBalance(t, o, H), e2eBalance(t, o, R); h != 400 || r != 600 {
		t.Fatalf("balances after the replay holder %d receiver %d, want 400 and 600", h, r)
	}
}

type e2eLookupItem struct {
	Beef        []byte
	OutputIndex uint32
	Txid        string
}

// e2eLookup POSTs /lookup {service, query} and returns the status, and on 200 the output-list items.
func e2eLookup(t *testing.T, o e2eOverlay, service, query string) (int, []e2eLookupItem, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/lookup", strings.NewReader(`{"service":"`+service+`","query":`+query+`}`))
	req.Header.Set("Content-Type", "application/json")
	code, body := e2eDo(t, o, req)
	if code != 200 {
		return code, nil, body
	}
	var ans struct {
		Type    string `json:"type"`
		Outputs []struct {
			Beef        []int   `json:"beef"`
			OutputIndex uint32  `json:"outputIndex"`
			Txid        *string `json:"txid"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(body, &ans); err != nil || ans.Type != "output-list" {
		t.Fatalf("lookup answer %s: %v", body, err)
	}
	items := make([]e2eLookupItem, 0, len(ans.Outputs))
	for _, out := range ans.Outputs {
		if out.Txid == nil {
			t.Fatalf("lookup item without txid: %s", body)
		}
		beef := make([]byte, len(out.Beef))
		for i, v := range out.Beef {
			beef[i] = byte(v)
		}
		items = append(items, e2eLookupItem{Beef: beef, OutputIndex: out.OutputIndex, Txid: *out.Txid})
	}
	return code, items, body
}

// e2eColorQuery is a color-* query object on asset id for the outpoints.
func e2eColorQuery(typ, id string, ops ...string) string {
	q, _ := json.Marshal(map[string]any{"type": typ, "version": 1, "assetId": id, "topic": "tm_color_" + id, "outpoints": ops})
	return string(q)
}

// e2eRequireItems: the answer is exactly want (built tx, vout) in order, each item's txid is its AtomicBEEF subject,
// and the BEEF parses to that txid with the built locking script at outputIndex.
func e2eRequireItems(t *testing.T, label string, items []e2eLookupItem, want ...e2eOut) {
	t.Helper()
	if len(items) != len(want) {
		t.Fatalf("%s: %d items, want %d", label, len(items), len(want))
	}
	for i, w := range want {
		it := items[i]
		if it.Txid != w.b.Txid || it.OutputIndex != w.vout {
			t.Fatalf("%s[%d] = %s.%d, want %s.%d", label, i, it.Txid, it.OutputIndex, w.b.Txid, w.vout)
		}
		beef, tx, txid, err := transaction.ParseBeef(it.Beef)
		if err != nil || txid == nil || txid.String() != w.b.Txid {
			t.Fatalf("%s[%d]: ParseBeef txid %v, %v", label, i, txid, err)
		}
		if tx == nil {
			tx = beef.FindTransactionForSigningByHash(txid)
		}
		if tx == nil || int(w.vout) >= len(tx.Outputs) ||
			!bytes.Equal(tx.Outputs[w.vout].LockingScript.Bytes(), w.b.Tx.Outputs[w.vout].LockingScript.Bytes()) {
			t.Fatalf("%s[%d]: the BEEF's output %d is not the built script", label, i, w.vout)
		}
	}
}

type e2eOut struct {
	b    *mandalatest.Built
	vout uint32
}

func (e e2eOut) String() string { return e.b.Txid + "." + strconv.FormatUint(uint64(e.vout), 10) }

// Review Focus 3: color-admission answers admitted outputs spent or not (the deploy <txid>.0 after an issue), with
// BEEF and txid; color-spendability omits the spent ones. The legacy query keeps answering, with txid on every item.
func TestE2EColorLookupsSpentAndUnspent(t *testing.T) {
	e2eDB(t, e2eColorNode)
	o := e2eBoot(t, e2eColorNode, nil, false)
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver

	d := mandalatest.Deploy(t, I, "USD")
	id := mandalatest.TokenIDOf(d, 0)
	tm := mandala.TokenTopicOfTxid(d.Txid)
	ls := "ls_color_" + id
	e2eAdmit(t, o, d, mandala.MandalaTopic, tm)
	d0 := e2eOut{d, 0}
	_, items, _ := e2eLookup(t, o, ls, e2eColorQuery("color-spendability", id, d0.String()))
	e2eRequireItems(t, "spendability before the issue", items, d0)

	is := mandalatest.Issue(t, d, 0, I, H, 1000)
	e2eAdmit(t, o, is, tm)
	is0, is1 := e2eOut{is, 0}, e2eOut{is, 1}

	code, items, body := e2eLookup(t, o, ls, e2eColorQuery("color-admission", id, d0.String(), is0.String(), is1.String()))
	if code != 200 {
		t.Fatalf("color-admission: %d %s", code, body)
	}
	e2eRequireItems(t, "admission [d.0, is.0, is.1]", items, d0, is0, is1)
	_, items, _ = e2eLookup(t, o, ls, e2eColorQuery("color-spendability", id, d0.String(), is0.String(), is1.String()))
	e2eRequireItems(t, "spendability [d.0, is.0, is.1]", items, is0, is1)

	tr := mandalatest.Transfer(t, is, 1, R, 400)
	e2eAdmit(t, o, tr, tm)
	_, items, _ = e2eLookup(t, o, ls, e2eColorQuery("color-spendability", id, is1.String()))
	e2eRequireItems(t, "spendability [is.1] after the transfer", items)
	_, items, _ = e2eLookup(t, o, ls, e2eColorQuery("color-admission", id, is1.String()))
	e2eRequireItems(t, "admission [is.1] after the transfer", items, is1)
	_, items, _ = e2eLookup(t, o, ls, e2eColorQuery("color-spendability", id, e2eOut{tr, 1}.String(), e2eOut{tr, 0}.String()))
	e2eRequireItems(t, "spendability of the transfer outputs", items, e2eOut{tr, 1}, e2eOut{tr, 0})

	// an outpoint never admitted, and one of another asset's deploy, answer nothing
	other := mandalatest.Deploy(t, I, "EUR")
	e2eAdmit(t, o, other, mandala.MandalaTopic, mandala.TokenTopicOfTxid(other.Txid))
	_, items, _ = e2eLookup(t, o, ls, e2eColorQuery("color-admission", id, e2eOut{other, 0}.String(), strings.Repeat("00", 32)+".0"))
	e2eRequireItems(t, "admission of foreign outpoints", items)

	// the legacy query still answers, and every item carries its txid
	code, items, body = e2eLookup(t, o, ls, `{"tokenId":"`+id+`"}`)
	if code != 200 || len(items) == 0 {
		t.Fatalf("legacy tokenId lookup: %d %s", code, body)
	}
	for _, it := range items {
		if beefTxid := e2eAtomicSubject(t, it.Beef); it.Txid != beefTxid {
			t.Fatalf("legacy item txid %s, AtomicBEEF subject %s", it.Txid, beefTxid)
		}
	}

	// query refusals are 400; an unhosted service is 400
	for _, q := range []string{
		e2eColorQuery("color-admission", id, strings.ToUpper(d.Txid)+".0"),
		e2eColorQuery("color-admission", id, d0.String(), d0.String()),
		`{"type":"color-admission","tokenId":"` + id + `"}`,
	} {
		if code, _, body := e2eLookup(t, o, ls, q); code != 400 {
			t.Fatalf("%s: %d %s, want 400", q, code, body)
		}
	}
	if code, _, body := e2eLookup(t, o, ls+"_1", e2eColorQuery("color-admission", id, d0.String())); code != 400 {
		t.Fatalf("unhosted service: %d %s, want 400", code, body)
	}
}

func e2eAtomicSubject(t *testing.T, beef []byte) string {
	t.Helper()
	_, _, txid, err := transaction.ParseBeef(beef)
	if err != nil || txid == nil || len(beef) < 36 || !bytes.Equal(beef[:4], []byte{1, 1, 1, 1}) {
		t.Fatalf("not AtomicBEEF: %v", err)
	}
	return txid.String()
}

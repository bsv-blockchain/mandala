package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/maintenance"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

const hookNode = "mandala3_test_submit_hook"

// ---- stubs --------------------------------------------------------------------------------------------------

// hookStubSubmitter answers HasTopicManager from a set and Submit with [0] on every named topic. entered (when
// non-nil) receives one value per Submit; unblock (when non-nil) holds Submit until it is closed.
type hookStubSubmitter struct {
	mu      sync.Mutex
	hosted  map[string]bool
	calls   atomic.Int32
	entered chan struct{}
	unblock chan struct{}
}

var _ Submitter = (*hookStubSubmitter)(nil)

func newHookStubSubmitter(hosted ...string) *hookStubSubmitter {
	s := &hookStubSubmitter{hosted: map[string]bool{}}
	for _, h := range hosted {
		s.hosted[h] = true
	}
	return s
}

func (s *hookStubSubmitter) host(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hosted[name] = true
}

func (s *hookStubSubmitter) HasTopicManager(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hosted[name]
}

func (s *hookStubSubmitter) Submit(_ context.Context, tb overlay.TaggedBEEF, _ engine.SumbitMode, _ engine.OnSteakReady) (overlay.Steak, error) {
	s.calls.Add(1)
	if s.entered != nil {
		s.entered <- struct{}{}
	}
	if s.unblock != nil {
		<-s.unblock
	}
	steak := overlay.Steak{}
	for _, topic := range tb.Topics {
		steak[topic] = &overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{0}, CoinsToRetain: []uint32{}}
	}
	return steak, nil
}

// hookStubRegistrar records Ensure calls; a successful Ensure hosts tm_<hex> on sub (when set), as the real
// registrar registers the manager on the engine.
type hookStubRegistrar struct {
	mu     sync.Mutex
	calls  []string
	result bool
	err    error
	sub    *hookStubSubmitter
}

func (r *hookStubRegistrar) Ensure(tokenID string) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, tokenID)
	if r.err != nil {
		return false, r.err
	}
	if r.result && r.sub != nil {
		r.sub.host("tm_" + strings.TrimSuffix(tokenID, "_0"))
	}
	return r.result, nil
}

func (r *hookStubRegistrar) ensured() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.calls)
}

// hookStubPrecheck stands in for the registry dry run and records the off-chain values its ctx carried.
type hookStubPrecheck struct {
	mu       sync.Mutex
	calls    int
	offChain []byte
	admit    []uint32
	err      error
}

func (p *hookStubPrecheck) run(ctx context.Context, _ *transaction.Beef, _ *chainhash.Hash) (overlay.AdmittanceInstructions, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	p.offChain = mandala.OffChainValuesFrom(ctx)
	if p.err != nil {
		return overlay.AdmittanceInstructions{}, p.err
	}
	return overlay.AdmittanceInstructions{OutputsToAdmit: p.admit, CoinsToRetain: []uint32{}}, nil
}

func (p *hookStubPrecheck) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func (p *hookStubPrecheck) sawOffChain() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.offChain
}

// hookStubRecorder is an AdmissionRecorder that remembers every call and stores nothing.
type hookStubRecorder struct {
	mu       sync.Mutex
	gets     int
	records  int
	refusals []mandala.Refusal
}

var _ AdmissionRecorder = (*hookStubRecorder)(nil)

func (r *hookStubRecorder) GetAdmission(context.Context, string) (*mandala.AdmissionRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gets++
	return nil, nil
}

func (r *hookStubRecorder) RecordAdmission(context.Context, mandala.AdmissionRecord) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.records++
	return nil
}

func (r *hookStubRecorder) MarkRefused(_ context.Context, ref mandala.Refusal) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refusals = append(r.refusals, ref)
	return nil
}

func (r *hookStubRecorder) snapshot() (gets, records int, refusals []mandala.Refusal) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.gets, r.records, slices.Clone(r.refusals)
}

type hookFailingGate struct{}

func (hookFailingGate) Enter(context.Context) (func(), error) { return nil, errors.New("gate closed") }

// ---- request and body helpers ---------------------------------------------------------------------------------

// hookDo POSTs body to /submit with the off-chain framing header. It never calls t (safe in goroutines).
func hookDo(f *fiber.App, topicsHeader string, body []byte) (int, []byte, error) {
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(body))
	if topicsHeader != "" {
		req.Header.Set("X-Topics", topicsHeader)
	}
	req.Header.Set("x-includes-off-chain-values", "true")
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := f.Test(req, -1)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	return resp.StatusCode, out, err
}

func hookTopics(t testing.TB, topics ...string) string {
	t.Helper()
	b, err := json.Marshal(topics)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func hookSubmit(t *testing.T, f *fiber.App, b *mandalatest.Built, topics ...string) (int, []byte) {
	t.Helper()
	code, body, err := hookDo(f, hookTopics(t, topics...), mandalatest.SubmitBody(b))
	if err != nil {
		t.Fatalf("POST /submit: %v", err)
	}
	return code, body
}

type hookError struct {
	Status      string `json:"status"`
	Code        string `json:"code"`
	Retryable   bool   `json:"retryable"`
	Description string `json:"description"`
	Message     string `json:"message"`
	SpendTxid   string `json:"spendTxid"`
}

type hookAdmittance struct {
	OutputsToAdmit       []uint32 `json:"outputsToAdmit"`
	CoinsToRetain        []uint32 `json:"coinsToRetain"`
	AdmissionSignature   string   `json:"admissionSignature"`
	AdmissionIdentityKey string   `json:"admissionIdentityKey"`
}

func hookDecodeError(t *testing.T, body []byte) hookError {
	t.Helper()
	var e hookError
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("error body %s: %v", body, err)
	}
	return e
}

func hookDecodeSteak(t *testing.T, body []byte) map[string]hookAdmittance {
	t.Helper()
	var s map[string]hookAdmittance
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatalf("steak body %s: %v", body, err)
	}
	return s
}

func hookRequireError(t *testing.T, code int, body []byte, wantStatus int, wantCode, wantDescription string) {
	t.Helper()
	if code != wantStatus {
		t.Fatalf("status = %d, want %d; body %s", code, wantStatus, body)
	}
	e := hookDecodeError(t, body)
	if e.Status != "error" || e.Code != wantCode || e.Description != wantDescription || e.Message != wantDescription {
		t.Fatalf("body = %+v, want code %s description %q", e, wantCode, wantDescription)
	}
}

func hookPairing(txid string) string { return "X-Topics naming tm_mandala must also name tm_" + txid }

// hookDeploy builds an issuer-owned deploy with the given amount, linkage and deploySig signer.
func hookDeploy(t *testing.T, amount uint64, noLinkage bool, sigBy *mandalatest.Party) *mandalatest.Built {
	t.Helper()
	return mandalatest.Build(t, nil, []mandalatest.Out{{
		Owner:      mandalatest.Issuer,
		Prover:     mandalatest.Issuer,
		Amount:     amount,
		Payload:    mandalatest.DeployPayload("USD", 2, "US Dollar"),
		HasPayload: true,
		NoLinkage:  noLinkage,
	}}, sigBy)
}

// ---- real-engine helpers ---------------------------------------------------------------------------------------

// newHookApp builds the production stack on a fresh hookNode database (skipped without Mongo; dropped before and
// after). allowSet with an empty allow hosts no token.
func newHookApp(t *testing.T, allow []string, allowSet bool) *wiring.App {
	t.Helper()
	testmongo.DB(t, hookNode+"_lookup_services")
	app, err := wiring.Build(context.Background(), wiring.Config{
		NodeName:          hookNode,
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
	t.Cleanup(func() {
		ctx := context.Background()
		_ = app.Mongo.Drop(ctx)
		_ = app.Mongo.Client().Disconnect(ctx)
	})
	return app
}

func hookApplied(t *testing.T, app *wiring.App, topic, txid string) bool {
	t.Helper()
	h, err := chainhash.NewHashFromHex(txid)
	if err != nil {
		t.Fatal(err)
	}
	ok, err := app.EngineStore.DoesAppliedTransactionExist(context.Background(), &overlay.AppliedTransaction{Txid: h, Topic: topic})
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

// hookRequireNothingWritten: no admission record, no engine applied record on tm_mandala or tm_<txid>, no token
// topic registered for <txid>_0.
func hookRequireNothingWritten(t *testing.T, app *wiring.App, txid string) {
	t.Helper()
	rec, err := app.Store.GetAdmission(context.Background(), txid)
	if err != nil {
		t.Fatal(err)
	}
	if rec != nil {
		t.Fatalf("admission record written for %s: %+v", txid, rec)
	}
	for _, topic := range []string{mandala.MandalaTopic, "tm_" + txid} {
		if hookApplied(t, app, topic, txid) {
			t.Fatalf("%s applied on %s", txid, topic)
		}
	}
	if app.Tokens.Hosted(txid+"_0") || app.Engine.HasTopicManager("tm_"+txid) {
		t.Fatalf("tm_%s was registered", txid)
	}
}

// ---- tests ----------------------------------------------------------------------------------------------------

func TestHostRuleVerdictRowsExist(t *testing.T) {
	if v := hostRuleVerdict(mandala.CodeShape); v.Code != "ERR_SHAPE" || v.HTTP != 400 || v.Retryable {
		t.Fatalf("shape row = %+v", v)
	}
	if v := hostRuleVerdict(mandala.CodeUnavailable); v.Code != "ERR_UNAVAILABLE" || v.HTTP != 503 || !v.Retryable {
		t.Fatalf("unavailable row = %+v", v)
	}
}

// Review Focus 2. Every pre-Q5 client sends ["tm_mandala"], and a lib bug can send a deploy that way or name
// tm_mandala on a token tx. Expected: 400 ERR_SHAPE with the exact text, no record, no registration, nothing
// persisted, Submit never called.
func TestSubmitNamingRegistryWithoutOwnTokenTopicIsRefused(t *testing.T) {
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	dep := mandalatest.Deploy(t, I, "USD")
	iss := mandalatest.Issue(t, dep, 0, I, H, 1000)
	tr := mandalatest.Transfer(t, iss, 1, R, 400)
	tmDep := "tm_" + dep.Txid

	t.Run("stub: Submit, the registrar, the precheck and the store are never reached", func(t *testing.T) {
		for _, c := range []struct {
			name   string
			b      *mandalatest.Built
			topics []string
		}{
			{"deploy naming only tm_mandala", dep, []string{mandala.MandalaTopic}},
			{"transfer naming only tm_mandala", tr, []string{mandala.MandalaTopic}},
			{"issue naming tm_mandala and its token topic", iss, []string{mandala.MandalaTopic, tmDep}},
		} {
			t.Run(c.name, func(t *testing.T) {
				sub := newHookStubSubmitter(mandala.MandalaTopic, tmDep)
				reg := &hookStubRegistrar{result: true, sub: sub}
				pre := &hookStubPrecheck{admit: []uint32{0}}
				rec := &hookStubRecorder{}
				f := newServer(sub, nil, nil, nil, WithDeployHook(reg, pre.run), WithAdmissionStore(rec, nil))

				code, body := hookSubmit(t, f, c.b, c.topics...)
				hookRequireError(t, code, body, 400, "ERR_SHAPE", hookPairing(c.b.Txid))
				if hookDecodeError(t, body).Retryable {
					t.Fatal("the pairing refusal must be retryable:false")
				}
				if n := sub.calls.Load(); n != 0 {
					t.Fatalf("Submit called %d times", n)
				}
				if got := reg.ensured(); len(got) != 0 {
					t.Fatalf("Ensure called with %v", got)
				}
				if n := pre.count(); n != 0 {
					t.Fatalf("precheck called %d times", n)
				}
				if gets, records, refusals := rec.snapshot(); gets+records+len(refusals) != 0 {
					t.Fatalf("admission store touched: gets=%d records=%d refusals=%v", gets, records, refusals)
				}
			})
		}
	})

	t.Run("engine: no record, no registration, the registry's engine doc survives", func(t *testing.T) {
		app := newHookApp(t, nil, false)
		f := New(app)
		ctx := context.Background()

		code, body := hookSubmit(t, f, dep, mandala.MandalaTopic)
		hookRequireError(t, code, body, 400, "ERR_SHAPE", hookPairing(dep.Txid))
		hookRequireNothingWritten(t, app, dep.Txid)

		// The same bytes admit once both topics are named (TT T5).
		if code, body = hookSubmit(t, f, dep, mandala.MandalaTopic, tmDep); code != 200 {
			t.Fatalf("deploy naming both topics: %d %s", code, body)
		}

		// A token tx naming tm_mandala would have had its registry entry retain nothing (coinsToRetain: [])
		// and delete the registry's engine doc of the deploy coin (G8, G16): refused before the engine.
		code, body = hookSubmit(t, f, iss, mandala.MandalaTopic, tmDep)
		hookRequireError(t, code, body, 400, "ERR_SHAPE", hookPairing(iss.Txid))
		hookRequireNothingWritten(t, app, iss.Txid)
		live, err := app.EngineStore.IsUnspent(ctx, tmDep, dep.Txid, 0)
		if err != nil || !live {
			t.Fatalf("deploy coin on %s: live=%v err=%v, want live (the refused issue spent nothing)", tmDep, live, err)
		}

		if code, body = hookSubmit(t, f, iss, tmDep); code != 200 {
			t.Fatalf("issue naming its token topic: %d %s", code, body)
		}
		code, body = hookSubmit(t, f, tr, mandala.MandalaTopic)
		hookRequireError(t, code, body, 400, "ERR_SHAPE", hookPairing(tr.Txid))
		hookRequireNothingWritten(t, app, tr.Txid)

		h, err := chainhash.NewHashFromHex(dep.Txid)
		if err != nil {
			t.Fatal(err)
		}
		registry := mandala.MandalaTopic
		out, err := app.EngineStore.FindOutput(ctx, &transaction.Outpoint{Txid: *h, Index: 0}, &registry, nil, false)
		if err != nil || out == nil {
			t.Fatalf("tm_mandala engine doc of the deploy: %v, err %v; want present", out, err)
		}
		if r, err := app.Store.FindRegistryRecord(ctx, dep.Txid+"_0"); err != nil || r == nil {
			t.Fatalf("registry record: %+v, err %v; want present", r, err)
		}
	})
}

func TestDeployHookOutcomes(t *testing.T) {
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	tm := "tm_" + dep.Txid
	authority := &mandala.RejectError{Code: mandala.CodeAuthority, Reason: "output 0: deploy requires a valid deploySig over this txid", Topic: mandala.MandalaTopic}
	untrusted := &mandala.RejectError{Code: mandala.CodeUntrusted, Reason: "output 0: owner 02ab is not a trusted issuer", Topic: mandala.MandalaTopic}
	cases := []struct {
		name         string
		hosted       bool
		admit        []uint32
		preErr       error
		ensureResult bool
		ensureErr    error
		wantStatus   int // 0 = the core answered; only wantSubmit is checked
		wantCode     string
		wantDesc     string
		wantPrecheck int
		wantEnsure   []string
		wantSubmit   int32
		wantRefusal  bool
	}{
		{name: "token topic already hosted: no precheck, no Ensure", hosted: true, admit: []uint32{0}, ensureResult: true,
			wantPrecheck: 0, wantSubmit: 1},
		{name: "registry admits [0]: Ensure then the core", admit: []uint32{0}, ensureResult: true,
			wantPrecheck: 1, wantEnsure: []string{dep.Txid + "_0"}, wantSubmit: 1},
		{name: "registry admits nothing: no Ensure; the pre-check refuses the unhosted topic", admit: []uint32{}, ensureResult: true,
			wantStatus: 400, wantCode: "ERR_SHAPE", wantDesc: "unknown-topic: " + tm, wantPrecheck: 1},
		{name: "allowlisted out: Ensure false; the pre-check refuses", admit: []uint32{0}, ensureResult: false,
			wantStatus: 400, wantCode: "ERR_SHAPE", wantDesc: "unknown-topic: " + tm, wantPrecheck: 1, wantEnsure: []string{dep.Txid + "_0"}},
		{name: "Ensure fails: 503", admit: []uint32{0}, ensureErr: errors.New("boom"),
			wantStatus: 503, wantCode: "ERR_UNAVAILABLE", wantDesc: "token topic registration failed: boom", wantPrecheck: 1, wantEnsure: []string{dep.Txid + "_0"}},
		{name: "final registry refusal: answered and persisted by tm_mandala", preErr: authority,
			wantStatus: 400, wantCode: "ERR_AUTHORITY", wantDesc: authority.Reason, wantPrecheck: 1, wantRefusal: true},
		{name: "retryable registry refusal: answered, never persisted", preErr: untrusted,
			wantStatus: 409, wantCode: "ERR_UNTRUSTED", wantDesc: untrusted.Reason, wantPrecheck: 1},
		{name: "registry dependency fault: 503, never persisted", preErr: errors.New("registry storage down"),
			wantStatus: 503, wantCode: "ERR_UNAVAILABLE", wantDesc: "registry storage down", wantPrecheck: 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sub := newHookStubSubmitter(mandala.MandalaTopic)
			if c.hosted {
				sub.host(tm)
			}
			reg := &hookStubRegistrar{result: c.ensureResult, err: c.ensureErr, sub: sub}
			pre := &hookStubPrecheck{admit: c.admit, err: c.preErr}
			rec := &hookStubRecorder{}
			f := newServer(sub, nil, nil, nil, WithDeployHook(reg, pre.run), WithAdmissionStore(rec, nil))

			code, body := hookSubmit(t, f, dep, mandala.MandalaTopic, tm)
			if c.wantStatus != 0 {
				hookRequireError(t, code, body, c.wantStatus, c.wantCode, c.wantDesc)
			}
			if n := pre.count(); n != c.wantPrecheck {
				t.Fatalf("precheck calls = %d, want %d", n, c.wantPrecheck)
			}
			if c.wantPrecheck > 0 && !bytes.Equal(pre.sawOffChain(), dep.OffChain) {
				t.Fatal("the precheck ctx did not carry the submitted off-chain values")
			}
			if got := reg.ensured(); !slices.Equal(got, c.wantEnsure) {
				t.Fatalf("Ensure calls = %v, want %v", got, c.wantEnsure)
			}
			if n := sub.calls.Load(); n != c.wantSubmit {
				t.Fatalf("Submit calls = %d, want %d", n, c.wantSubmit)
			}
			_, _, refusals := rec.snapshot()
			if !c.wantRefusal {
				if len(refusals) != 0 {
					t.Fatalf("persisted %v, want nothing", refusals)
				}
				return
			}
			want := mandala.Refusal{Txid: dep.Txid, Code: "ERR_AUTHORITY", Description: authority.Reason,
				PayloadHash: mandala.PayloadHashHex(dep.OffChain), Topic: mandala.MandalaTopic}
			if len(refusals) != 1 || refusals[0] != want {
				t.Fatalf("refusals = %+v, want [%+v]", refusals, want)
			}
		})
	}
}

func TestHostRulesLeaveMalformedRequestsToTheCore(t *testing.T) {
	sub := newHookStubSubmitter(mandala.MandalaTopic)
	reg := &hookStubRegistrar{result: true, sub: sub}
	pre := &hookStubPrecheck{admit: []uint32{0}}
	f := newServer(sub, nil, nil, nil, WithDeployHook(reg, pre.run))

	// No X-Topics: Task 20's step 1 answers.
	code, body, err := hookDo(f, "", []byte{})
	if err != nil {
		t.Fatal(err)
	}
	hookRequireError(t, code, body, 400, "ERR_SHAPE", "X-Topics header is required")

	// tm_mandala named but the BEEF does not parse (txidErr != nil): no pairing, no hook; the core decides.
	code, body, err = hookDo(f, hookTopics(t, mandala.MandalaTopic), []byte{0x03, 'a', 'b', 'c'})
	if err != nil {
		t.Fatal(err)
	}
	if code == 400 && strings.HasPrefix(hookDecodeError(t, body).Description, "X-Topics naming") {
		t.Fatalf("pairing fired on an unparseable BEEF: %s", body)
	}
	if pre.count() != 0 || len(reg.ensured()) != 0 {
		t.Fatal("the deploy hook ran on an unparseable BEEF")
	}
}

func TestRefusedDeployRegistersNoTopic(t *testing.T) {
	app := newHookApp(t, nil, false)
	f := New(app)
	ctx := context.Background()
	I, Rg := mandalatest.Issuer, mandalatest.Rogue

	cases := []struct {
		name      string
		b         *mandalatest.Built
		status    int
		code      string
		reason    string
		persisted bool
	}{
		{"untrusted issuer", mandalatest.Deploy(t, Rg, "RGE"), 409, "ERR_UNTRUSTED",
			"output 0: owner " + Rg.Identity + " is not a trusted issuer", false},
		{"deploySig by another key", hookDeploy(t, 0, false, &Rg), 400, "ERR_AUTHORITY",
			"output 0: deploy requires a valid deploySig over this txid", true},
		{"fixed supply", hookDeploy(t, 1000, false, &I), 400, "ERR_AUTHORITY",
			"output 0: fixed-supply deploys are not allowed", true},
		{"no linkage", hookDeploy(t, 0, true, &I), 400, "ERR_LINKAGE",
			"output 0: token output with no verified linkage", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for attempt := 1; attempt <= 2; attempt++ { // a retry earns the same answer from the same rules
				code, body := hookSubmit(t, f, c.b, mandala.MandalaTopic, "tm_"+c.b.Txid)
				hookRequireError(t, code, body, c.status, c.code, c.reason)
			}
			if app.Engine.HasTopicManager("tm_"+c.b.Txid) || app.Tokens.Hosted(c.b.Txid+"_0") {
				t.Fatal("a refused deploy registered its token topic")
			}
			if hookApplied(t, app, mandala.MandalaTopic, c.b.Txid) {
				t.Fatal("a refused deploy reached the engine")
			}
			rec, err := app.Store.GetAdmission(ctx, c.b.Txid)
			if err != nil {
				t.Fatal(err)
			}
			if !c.persisted {
				if rec != nil {
					t.Fatalf("a retryable refusal was persisted: %+v", rec)
				}
				return
			}
			if rec == nil || rec.RefusedCode != c.code || rec.RefusedDescription != c.reason ||
				rec.RefusedTopic != mandala.MandalaTopic || rec.RefusedPayloadHash != mandala.PayloadHashHex(c.b.OffChain) ||
				rec.Pending || len(rec.Admissions) != 0 {
				t.Fatalf("record = %+v, want a %s refusal by tm_mandala keyed by the payload hash", rec, c.code)
			}
		})
	}

	t.Run("a valid deploy afterwards is unaffected", func(t *testing.T) {
		good := mandalatest.Deploy(t, I, "USD")
		code, body := hookSubmit(t, f, good, mandala.MandalaTopic, "tm_"+good.Txid)
		if code != 200 {
			t.Fatalf("valid deploy: %d %s", code, body)
		}
		steak := hookDecodeSteak(t, body)
		for _, topic := range []string{mandala.MandalaTopic, "tm_" + good.Txid} {
			if !slices.Equal(steak[topic].OutputsToAdmit, []uint32{0}) {
				t.Fatalf("%s admitted %v, want [0]", topic, steak[topic].OutputsToAdmit)
			}
		}
		recs, err := app.Store.ListRegistryRecords(ctx, 100, 0)
		if err != nil || len(recs) != 1 || recs[0].TokenID != good.Txid+"_0" {
			t.Fatalf("registry records = %+v, err %v; want only %s_0", recs, err, good.Txid)
		}
	})
}

func TestAllowlistedOutDeployIsUnknownTopicAndLeavesNothing(t *testing.T) {
	app := newHookApp(t, []string{}, true) // "[]" hosts no token (V-3)
	f := New(app)
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")

	code, body := hookSubmit(t, f, dep, mandala.MandalaTopic, "tm_"+dep.Txid)
	hookRequireError(t, code, body, 400, "ERR_SHAPE", "unknown-topic: tm_"+dep.Txid)
	hookRequireNothingWritten(t, app, dep.Txid)
	recs, err := app.Store.ListRegistryRecords(context.Background(), 100, 0)
	if err != nil || len(recs) != 0 {
		t.Fatalf("registry records = %+v, err %v; want none", recs, err)
	}
}

func TestValidDeployRegistersThenAdmitsBothTopicsWithTwoSigma(t *testing.T) {
	app := newHookApp(t, nil, false)
	f := New(app)
	ctx := context.Background()
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	tm := "tm_" + dep.Txid

	if app.Engine.HasTopicManager(tm) {
		t.Fatal("token topic registered before its deploy")
	}
	code, body := hookSubmit(t, f, dep, mandala.MandalaTopic, tm)
	if code != 200 {
		t.Fatalf("deploy: %d %s", code, body)
	}
	if !app.Tokens.Hosted(dep.Txid+"_0") || !app.Engine.HasTopicManager(tm) {
		t.Fatal("the deploy hook did not register the token topic")
	}
	steak := hookDecodeSteak(t, body)
	sigs := map[string]string{}
	for _, topic := range []string{mandala.MandalaTopic, tm} {
		e := steak[topic]
		if !slices.Equal(e.OutputsToAdmit, []uint32{0}) || e.AdmissionIdentityKey != mandalatest.Overlay.Identity {
			t.Fatalf("%s entry = %+v", topic, e)
		}
		ok, err := mandala.VerifyAdmission(topic, dep.Txid, []uint32{0}, e.AdmissionSignature, e.AdmissionIdentityKey)
		if err != nil || !ok {
			t.Fatalf("σI on %s does not verify: %v", topic, err)
		}
		sigs[topic] = e.AdmissionSignature
	}
	if sigs[mandala.MandalaTopic] == sigs[tm] {
		t.Fatal("the two σI are identical: digest v3 must bind the topic")
	}
	if ok, _ := mandala.VerifyAdmission(tm, dep.Txid, []uint32{0}, sigs[mandala.MandalaTopic], mandalatest.Overlay.Identity); ok {
		t.Fatal("the tm_mandala σI verifies under the token topic")
	}
	rows, err := app.Store.OwnerJournalByOutpoint(ctx, dep.Txid, 0)
	if err != nil || len(rows) != 1 || rows[0].Topic != tm {
		t.Fatalf("journal rows = %+v, err %v; want exactly one under %s (tm_mandala never journals)", rows, err, tm)
	}
}

// R8: two identical deploys race. One factory build, both 200 with the same σI, one journal row, one record. A request
// that reads step 4 before the other commits and meets the engine's dupe gate after it still answers σI, from the proof
// re-read after Submit (D-20; the deterministic case is TestSubmit_DupeGateRaceAnswersFromTheReReadProof, Task 20).
func TestDoubleClickedDeployOverHTTP(t *testing.T) {
	app := newHookApp(t, nil, false)
	var builds atomic.Int32
	deps := mandala.TokenTopicDeps{
		Verifier:         app.Verifier,
		TrustedIssuers:   []string{mandalatest.Issuer.Identity},
		MembershipExempt: []string{mandalatest.Overlay.Identity},
		Store:            app.Store,
		Engine:           app.EngineStore,
		Screening:        mandala.NoSanctions{},
		Membership:       mandala.KYCMembership{Store: app.Store},
		// Spends is nil: a deploy spends no token coin, so the conflicting-spend guard is not exercised here.
	}
	app.Tokens = wiring.NewTokenTopics(app.Engine, nil, false, func(id string) (engine.TopicManager, engine.LookupService, error) {
		builds.Add(1)
		tm, err := mandala.NewTokenTopicManager(id, deps)
		if err != nil {
			return nil, nil, err
		}
		ls, err := mandala.NewTokenLookupService(id, app.Verifier, app.Store)
		if err != nil {
			return nil, nil, err
		}
		return tm, ls, nil
	})
	f := New(app)
	ctx := context.Background()
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	tm := "tm_" + dep.Txid
	hdr := hookTopics(t, mandala.MandalaTopic, tm)
	body := mandalatest.SubmitBody(dep)

	type result struct {
		code int
		body []byte
		err  error
	}
	start := make(chan struct{})
	results := make(chan result, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			code, b, err := hookDo(f, hdr, body)
			results <- result{code, b, err}
		}()
	}
	close(start)
	var steaks []map[string]hookAdmittance
	for i := 0; i < 2; i++ {
		select {
		case r := <-results:
			if r.err != nil || r.code != 200 {
				t.Fatalf("double-clicked deploy: %d %s %v", r.code, r.body, r.err)
			}
			steaks = append(steaks, hookDecodeSteak(t, r.body))
		case <-time.After(30 * time.Second):
			t.Fatal("a double-clicked deploy did not finish (deadlock?)")
		}
	}
	if n := builds.Load(); n != 1 {
		t.Fatalf("factory builds = %d, want 1", n)
	}
	for _, topic := range []string{mandala.MandalaTopic, tm} {
		if steaks[0][topic].AdmissionSignature == "" || steaks[0][topic].AdmissionSignature != steaks[1][topic].AdmissionSignature {
			t.Fatalf("%s σI differ or are missing: %q vs %q", topic, steaks[0][topic].AdmissionSignature, steaks[1][topic].AdmissionSignature)
		}
	}
	rows, err := app.Store.OwnerJournalByOutpoint(ctx, dep.Txid, 0)
	if err != nil || len(rows) != 1 {
		t.Fatalf("journal rows = %+v, err %v; want one", rows, err)
	}
	rec, err := app.Store.GetAdmission(ctx, dep.Txid)
	if err != nil || rec == nil || !rec.Admitted() || len(rec.Admissions) != 2 {
		t.Fatalf("admission record = %+v, err %v; want one admitted record with both topics", rec, err)
	}
	recs, err := app.Store.ListRegistryRecords(ctx, 100, 0)
	if err != nil || len(recs) != 1 {
		t.Fatalf("registry records = %+v, err %v; want one", recs, err)
	}
}

func TestSubmitGateHoldsSubmitsWhileAnExclusiveSectionRuns(t *testing.T) {
	g := maintenance.NewGate(5 * time.Second)
	sub := newHookStubSubmitter("tm_probe")
	sub.entered = make(chan struct{}, 1)
	f := newServer(sub, nil, nil, nil, WithSubmitGate(g))
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	hdr, body := hookTopics(t, "tm_probe"), mandalatest.SubmitBody(dep)

	inside, leave := make(chan struct{}), make(chan struct{})
	exDone := make(chan error, 1)
	go func() {
		exDone <- g.Exclusive(context.Background(), func(context.Context) error {
			close(inside)
			<-leave
			return nil
		})
	}()
	<-inside

	type result struct {
		code int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		code, _, err := hookDo(f, hdr, body)
		done <- result{code, err}
	}()
	select {
	case <-sub.entered:
		t.Fatal("Submit ran while the exclusive section held the gate")
	case <-time.After(300 * time.Millisecond):
	}
	close(leave)
	if err := <-exDone; err != nil {
		t.Fatalf("Exclusive: %v", err)
	}
	select {
	case <-sub.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the submit never ran after the exclusive section ended")
	}
	if r := <-done; r.err != nil || r.code != 200 {
		t.Fatalf("submit after the exclusive section: %d %v", r.code, r.err)
	}
}

func TestSubmitGateExclusiveWaitsForAnInFlightSubmit(t *testing.T) {
	g := maintenance.NewGate(5 * time.Second)
	sub := newHookStubSubmitter("tm_probe")
	sub.entered = make(chan struct{}, 1)
	sub.unblock = make(chan struct{})
	f := newServer(sub, nil, nil, nil, WithSubmitGate(g))
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	hdr, body := hookTopics(t, "tm_probe"), mandalatest.SubmitBody(dep)

	type result struct {
		code int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		code, _, err := hookDo(f, hdr, body)
		done <- result{code, err}
	}()
	select {
	case <-sub.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the submit never reached Submit")
	}

	ran := make(chan struct{})
	exDone := make(chan error, 1)
	go func() {
		exDone <- g.Exclusive(context.Background(), func(context.Context) error {
			close(ran)
			return nil
		})
	}()
	select {
	case <-ran:
		t.Fatal("the exclusive section started beside an in-flight submit")
	case <-time.After(300 * time.Millisecond):
	}
	if !g.Busy() {
		t.Fatal("a waiting exclusive section must report Busy")
	}
	close(sub.unblock)
	if r := <-done; r.err != nil || r.code != 200 {
		t.Fatalf("in-flight submit: %d %v", r.code, r.err)
	}
	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		t.Fatal("the exclusive section never ran after the submit drained")
	}
	if err := <-exDone; err != nil {
		t.Fatalf("Exclusive: %v", err)
	}
}

func TestSubmitGateEnterFailureIs503(t *testing.T) {
	sub := newHookStubSubmitter("tm_probe")
	f := newServer(sub, nil, nil, nil, WithSubmitGate(hookFailingGate{}))
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	code, body := hookSubmit(t, f, dep, "tm_probe")
	hookRequireError(t, code, body, 503, "ERR_UNAVAILABLE", "maintenance gate unavailable: gate closed")
	if !hookDecodeError(t, body).Retryable {
		t.Fatal("a gate failure must be retryable")
	}
	if n := sub.calls.Load(); n != 0 {
		t.Fatalf("Submit called %d times", n)
	}
}

func TestNewHoldsTheSubmitGateForTheWholeRequest(t *testing.T) {
	app := newHookApp(t, nil, false)
	f := New(app)
	inside, leave := make(chan struct{}), make(chan struct{})
	exDone := make(chan error, 1)
	go func() {
		exDone <- app.Gate.Exclusive(context.Background(), func(context.Context) error {
			close(inside)
			<-leave
			return nil
		})
	}()
	<-inside

	type result struct {
		code int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		code, _, err := hookDo(f, "", []byte{}) // no X-Topics: the core answers 400, but only after the gate
		done <- result{code, err}
	}()
	select {
	case r := <-done:
		t.Fatalf("the request finished (%d) while the exclusive section held app.Gate", r.code)
	case <-time.After(300 * time.Millisecond):
	}
	close(leave)
	if err := <-exDone; err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if r.err != nil || r.code != 400 {
			t.Fatalf("after the exclusive section: %d %v, want the core's 400", r.code, r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the request never finished")
	}
}

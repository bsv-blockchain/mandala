package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// varintBytes encodes n as a Bitcoin VarInt, the inverse of readVarInt —
// used by tests to build framed request bodies at each width.
func varintBytes(n uint64) []byte {
	switch {
	case n < 0xfd:
		return []byte{byte(n)}
	case n <= 0xffff:
		b := make([]byte, 3)
		b[0] = 0xfd
		binary.LittleEndian.PutUint16(b[1:], uint16(n))
		return b
	case n <= 0xffffffff:
		b := make([]byte, 5)
		b[0] = 0xfe
		binary.LittleEndian.PutUint32(b[1:], uint32(n))
		return b
	default:
		b := make([]byte, 9)
		b[0] = 0xff
		binary.LittleEndian.PutUint64(b[1:], n)
		return b
	}
}

// stubSubmitter is a Submitter test double: it records what it was called
// with and returns canned results, so tests never need a real engine or
// Mongo.
type stubSubmitter struct {
	steak overlay.Steak
	err   error

	gotCtx  context.Context
	gotTB   overlay.TaggedBEEF
	gotMode engine.SumbitMode
}

func (s *stubSubmitter) Submit(ctx context.Context, tb overlay.TaggedBEEF, mode engine.SumbitMode, _ engine.OnSteakReady) (overlay.Steak, error) {
	s.gotCtx = ctx
	s.gotTB = tb
	s.gotMode = mode
	return s.steak, s.err
}

func doRequest(t *testing.T, app *fiber.App, req *http.Request) *http.Response {
	t.Helper()
	resp, err := app.Test(req, -1)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	return resp
}

func readRawBody(t *testing.T, resp *http.Response) []byte {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return b
}

func decodeJSON(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	raw := readRawBody(t, resp)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal body %q: %v", raw, err)
	}
	return m
}

func TestSubmit_MissingTopics(t *testing.T) {
	app := newServer(&stubSubmitter{}, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader([]byte{0x01}))
	resp := doRequest(t, app, req)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
	if _, ok := body["message"]; !ok {
		t.Fatalf("body = %v, missing message field", body)
	}
}

func TestSubmit_InvalidTopicsJSON(t *testing.T) {
	app := newServer(&stubSubmitter{}, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader([]byte{0x01}))
	req.Header.Set("X-Topics", "not-json")
	resp := doRequest(t, app, req)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
}

func TestSubmit_FramedBodySplit(t *testing.T) {
	cases := []struct {
		name     string
		beefSize int
	}{
		{"short varint (<0xfd)", 10},
		{"0xfd-prefixed varint", 300},
		{"0xfe-prefixed varint (u32)", 70000},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			beef := make([]byte, tc.beefSize)
			for i := range beef {
				beef[i] = byte(i % 256)
			}
			offChain := []byte(`{"inputs":[],"outputs":[],"admin":[]}`)

			var wire bytes.Buffer
			wire.Write(varintBytes(uint64(len(beef))))
			wire.Write(beef)
			wire.Write(offChain)

			stub := &stubSubmitter{steak: overlay.Steak{}}
			app := newServer(stub, nil, nil, nil)

			req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(wire.Bytes()))
			req.Header.Set("X-Topics", `["tm_mandala"]`)
			req.Header.Set("x-includes-off-chain-values", "true")
			req.Header.Set("Content-Type", "application/octet-stream")

			resp := doRequest(t, app, req)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
			}

			if !bytes.Equal(stub.gotTB.Beef, beef) {
				t.Fatalf("beef mismatch: got %d bytes, want %d bytes", len(stub.gotTB.Beef), len(beef))
			}
			if !bytes.Equal(stub.gotTB.OffChainValues, offChain) {
				t.Fatalf("offChain mismatch: got %q, want %q", stub.gotTB.OffChainValues, offChain)
			}
		})
	}
}

func TestReadVarInt(t *testing.T) {
	cases := []struct {
		name      string
		input     []byte
		want      uint64
		wantError bool
	}{
		// Single-byte values (< 0xfd)
		{"single-byte 0x00", []byte{0x00}, 0, false},
		{"single-byte 0xfc", []byte{0xfc}, 0xfc, false},

		// 0xfd prefix with 2-byte little-endian value
		{"0xfd prefix: 253", append([]byte{0xfd}, varintBytes(253)[1:]...), 253, false},
		{"0xfd prefix: 65535", append([]byte{0xfd}, varintBytes(65535)[1:]...), 65535, false},

		// 0xfe prefix with 4-byte little-endian value
		{"0xfe prefix: 65536", append([]byte{0xfe}, varintBytes(65536)[1:]...), 65536, false},
		{"0xfe prefix: max u32", append([]byte{0xfe}, varintBytes(0xffffffff)[1:]...), 0xffffffff, false},

		// 0xff prefix with 8-byte little-endian value
		{"0xff prefix: 2^32", append([]byte{0xff}, varintBytes(uint64(1) << 32)[1:]...), uint64(1) << 32, false},

		// Truncated inputs (missing bytes after prefix)
		{"truncated: 0xfd without data", []byte{0xfd}, 0, true},
		{"truncated: 0xfd with 1 byte", []byte{0xfd, 0x01}, 0, true},
		{"truncated: 0xfe without data", []byte{0xfe}, 0, true},
		{"truncated: 0xfe with 2 bytes", []byte{0xfe, 0x01, 0x02}, 0, true},
		{"truncated: 0xff without data", []byte{0xff}, 0, true},
		{"truncated: 0xff with 4 bytes", []byte{0xff, 0x01, 0x02, 0x03, 0x04}, 0, true},

		// Empty input
		{"empty reader", []byte{}, 0, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := bytes.NewReader(tc.input)
			got, err := readVarInt(r)

			if tc.wantError {
				if err == nil {
					t.Fatalf("readVarInt(%v) = %d, nil; want error", tc.input, got)
				}
			} else {
				if err != nil {
					t.Fatalf("readVarInt(%v) error: %v", tc.input, err)
				}
				if got != tc.want {
					t.Fatalf("readVarInt(%v) = %d, want %d", tc.input, got, tc.want)
				}
			}
		})
	}
}

func TestSubmit_TruncatedFraming(t *testing.T) {
	// Header says off-chain values are present, but varint declares a length
	// greater than remaining body bytes. Should return 400, never panic.
	beef := make([]byte, 100)
	for i := range beef {
		beef[i] = byte(i % 256)
	}
	offChain := []byte(`{"inputs":[],"outputs":[]}`)

	// Frame a body: [varint=500][100 bytes beef][28 bytes offChain]
	// Total is 500 declared beef but only 100 actual → truncation.
	var wire bytes.Buffer
	wire.Write(varintBytes(500)) // Declare 500 bytes of beef
	wire.Write(beef)             // But only provide 100
	wire.Write(offChain)

	stub := &stubSubmitter{steak: overlay.Steak{}}
	app := newServer(stub, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(wire.Bytes()))
	req.Header.Set("X-Topics", `["tm_mandala"]`)
	req.Header.Set("x-includes-off-chain-values", "true")

	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}

	body := decodeJSON(t, resp)
	if body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
	if msg, ok := body["message"].(string); !ok || msg == "" {
		t.Fatalf("body = %v, want non-empty error message", body)
	}
}

func TestSubmit_NoOffChainValuesFlag_WholeBodyIsBeef(t *testing.T) {
	beef := []byte{0xde, 0xad, 0xbe, 0xef, 0x01, 0x02}

	stub := &stubSubmitter{steak: overlay.Steak{}}
	app := newServer(stub, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(beef))
	req.Header.Set("X-Topics", `["tm_mandala"]`)

	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	if !bytes.Equal(stub.gotTB.Beef, beef) {
		t.Fatalf("beef mismatch: got %v, want %v", stub.gotTB.Beef, beef)
	}
	if len(stub.gotTB.OffChainValues) != 0 {
		t.Fatalf("offChainValues = %v, want empty", stub.gotTB.OffChainValues)
	}
}

func TestSubmit_CtxThreadsDecodedPayload(t *testing.T) {
	offChain := []byte(`{"inputs":[{"index":0,"linkage":{"prover":"p","verifier":"v","counterparty":"c","protocolID":[2,"mandala token"],"keyID":"k","encryptedLinkage":[1,2],"encryptedLinkageProof":[3,4],"proofType":0}}],"outputs":[]}`)
	beef := []byte{0xde, 0xad, 0xbe, 0xef}

	var wire bytes.Buffer
	wire.Write(varintBytes(uint64(len(beef))))
	wire.Write(beef)
	wire.Write(offChain)

	stub := &stubSubmitter{steak: overlay.Steak{}}
	app := newServer(stub, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(wire.Bytes()))
	req.Header.Set("X-Topics", `["tm_mandala"]`)
	req.Header.Set("x-includes-off-chain-values", "true")

	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}

	if stub.gotCtx == nil {
		t.Fatal("Submit was called with a nil ctx")
	}
	payload := mandala.PayloadFromContext(stub.gotCtx)
	if len(payload.Inputs) != 1 {
		t.Fatalf("payload.Inputs = %d, want 1 (payload: %+v)", len(payload.Inputs), payload)
	}
}

func TestSubmit_SuccessReturnsBareSteak(t *testing.T) {
	stub := &stubSubmitter{
		steak: overlay.Steak{
			"tm_mandala": &overlay.AdmittanceInstructions{
				OutputsToAdmit: []uint32{0, 1},
				CoinsToRetain:  nil, // deliberately nil: must still marshal as [], never null
			},
		},
	}
	app := newServer(stub, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader([]byte{0xde, 0xad}))
	req.Header.Set("X-Topics", `["tm_mandala"]`)

	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	raw := readRawBody(t, resp)
	if bytes.Contains(raw, []byte("null")) {
		t.Fatalf("body contains null, arrays must never be null: %s", raw)
	}

	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("unmarshal body %q: %v", raw, err)
	}
	if _, hasStatus := body["status"]; hasStatus {
		t.Fatalf("body = %v, success response must be bare (no status/message envelope)", body)
	}

	tm, ok := body["tm_mandala"].(map[string]any)
	if !ok {
		t.Fatalf("body = %v, missing tm_mandala object", body)
	}
	admits, ok := tm["outputsToAdmit"].([]any)
	if !ok || len(admits) != 2 {
		t.Fatalf("outputsToAdmit = %v, want [0,1]", tm["outputsToAdmit"])
	}
	retain, ok := tm["coinsToRetain"].([]any)
	if !ok {
		t.Fatalf("coinsToRetain missing or wrong type: %v (%T)", tm["coinsToRetain"], tm["coinsToRetain"])
	}
	if len(retain) != 0 {
		t.Fatalf("coinsToRetain = %v, want []", retain)
	}
}

// FIX D: an engine error that is NOT a topic-manager verdict (here, an
// unknown topic) is a dependency/infrastructure fault and must answer 503
// ERR_UNAVAILABLE, retryable — never a permanent 400. The old handler
// returned 400 for every Submit error uniformly, which is exactly the
// unsoundness that let a Mongo blip look like "this transaction is invalid".
func TestSubmit_NonVerdictEngineErrorIs503Unavailable(t *testing.T) {
	stub := &stubSubmitter{err: errors.New("unknown-topic")}
	app := newServer(stub, nil, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader([]byte{0x01}))
	req.Header.Set("X-Topics", `["tm_mandala"]`)

	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" || body["code"] != CodeUnavailable || body["retryable"] != true {
		t.Fatalf("body = %v, want ERR_UNAVAILABLE retryable", body)
	}
	if body["description"] != "unknown-topic" {
		t.Fatalf("description = %v, want %q", body["description"], "unknown-topic")
	}
}

func TestOptionsPreflight(t *testing.T) {
	app := newServer(&stubSubmitter{}, nil, nil, nil)

	req := httptest.NewRequest(http.MethodOptions, "/submit", nil)
	resp := doRequest(t, app, req)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	want := map[string]string{
		"Access-Control-Allow-Origin":          "*",
		"Access-Control-Allow-Headers":         "*",
		"Access-Control-Allow-Methods":         "*",
		"Access-Control-Expose-Headers":        "*",
		"Access-Control-Allow-Private-Network": "true",
	}
	for header, wantVal := range want {
		if got := resp.Header.Get(header); got != wantVal {
			t.Errorf("%s = %q, want %q", header, got, wantVal)
		}
	}
}

func TestUnknownRoute404(t *testing.T) {
	app := newServer(&stubSubmitter{}, nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/nope-not-a-route", nil)
	resp := doRequest(t, app, req)

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	want := map[string]any{
		"status":      "error",
		"code":        "ERR_ROUTE_NOT_FOUND",
		"description": "Route not found.",
	}
	for k, v := range want {
		if body[k] != v {
			t.Errorf("body[%q] = %v, want %v", k, body[k], v)
		}
	}
}

// --- broadcast-failure compensation (Task: engine marks spent before broadcast) ---

// stubCompensation is a PrepareSubmitCompensation double: prepare records
// the beef it saw and hands back a compensate closure that records calls.
type stubCompensation struct {
	prepareErr    error
	compensateErr error
	restore       *mandala.RestoreSnapshot

	prepareCalls    int
	compensateCalls int
	gotBeef         []byte
}

func (s *stubCompensation) prepare(_ context.Context, beef []byte) (func(context.Context) error, *mandala.RestoreSnapshot, error) {
	s.prepareCalls++
	s.gotBeef = append([]byte(nil), beef...)
	if s.prepareErr != nil {
		return nil, nil, s.prepareErr
	}
	return func(context.Context) error {
		s.compensateCalls++
		return s.compensateErr
	}, s.restore, nil
}

func submitReq(body []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(body))
	req.Header.Set("X-Topics", `["tm_mandala"]`)
	return req
}

func TestSubmit_BroadcastFailureRunsCompensation(t *testing.T) {
	comp := &stubCompensation{}
	stub := &stubSubmitter{err: &transaction.BroadcastFailure{Code: "REJECTED", Description: "terminal"}}
	app := newServer(stub, nil, nil, nil, WithBroadcastCompensation(comp.prepare))

	beef := []byte{0xde, 0xad, 0xbe, 0xef}
	resp := doRequest(t, app, submitReq(beef))

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (a broadcast failure is retryable, not a verdict)", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
	if comp.prepareCalls != 1 {
		t.Fatalf("prepare calls = %d, want 1 (snapshot must be taken before Submit)", comp.prepareCalls)
	}
	if !bytes.Equal(comp.gotBeef, beef) {
		t.Fatalf("prepare beef = %v, want %v", comp.gotBeef, beef)
	}
	if comp.compensateCalls != 1 {
		t.Fatalf("compensate calls = %d, want 1", comp.compensateCalls)
	}
}

func TestSubmit_NonBroadcastErrorSkipsCompensation(t *testing.T) {
	comp := &stubCompensation{}
	stub := &stubSubmitter{err: errors.New("unknown-topic")}
	app := newServer(stub, nil, nil, nil, WithBroadcastCompensation(comp.prepare))

	resp := doRequest(t, app, submitReq([]byte{0x01}))

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if comp.compensateCalls != 0 {
		t.Fatalf("compensate calls = %d, want 0 (validation errors occur before the engine marks anything)", comp.compensateCalls)
	}
}

func TestSubmit_SuccessSkipsCompensation(t *testing.T) {
	comp := &stubCompensation{}
	stub := &stubSubmitter{steak: overlay.Steak{}}
	app := newServer(stub, nil, nil, nil, WithBroadcastCompensation(comp.prepare))

	resp := doRequest(t, app, submitReq([]byte{0x01}))

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if comp.prepareCalls != 1 {
		t.Fatalf("prepare calls = %d, want 1", comp.prepareCalls)
	}
	if comp.compensateCalls != 0 {
		t.Fatalf("compensate calls = %d, want 0", comp.compensateCalls)
	}
}

// TestSubmit_PrepareErrorRejectsBeforeSubmit: if the snapshot cannot be
// taken, submitting would risk unrecoverable state on a broadcast failure —
// the handler refuses without calling Submit. The refusal is a storage
// fault, so it is 503 ERR_UNAVAILABLE (retryable), not a verdict.
func TestSubmit_PrepareErrorRejectsBeforeSubmit(t *testing.T) {
	comp := &stubCompensation{prepareErr: errors.New("mongo down")}
	stub := &stubSubmitter{steak: overlay.Steak{}}
	app := newServer(stub, nil, nil, nil, WithBroadcastCompensation(comp.prepare))

	resp := doRequest(t, app, submitReq([]byte{0x01}))

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["code"] != CodeUnavailable {
		t.Fatalf("code = %v, want %s", body["code"], CodeUnavailable)
	}
	if stub.gotCtx != nil {
		t.Fatal("Submit must not be called when the compensation snapshot failed")
	}
}

// TestSubmit_CompensationErrorStillReturns400: a failing compensation is
// logged, not surfaced — the client still sees the broadcast failure
// (retryable, 503).
func TestSubmit_CompensationErrorStillReturns400(t *testing.T) {
	comp := &stubCompensation{compensateErr: errors.New("restore failed")}
	stub := &stubSubmitter{err: &transaction.BroadcastFailure{Code: "REJECTED", Description: "terminal"}}
	app := newServer(stub, nil, nil, nil, WithBroadcastCompensation(comp.prepare))

	resp := doRequest(t, app, submitReq([]byte{0x01}))

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if comp.compensateCalls != 1 {
		t.Fatalf("compensate calls = %d, want 1", comp.compensateCalls)
	}
}

// TestSubmit_NoCompensationConfiguredStillWorks pins the non-Arcade path:
// nil PrepareSubmitCompensation keeps the pre-existing behavior.
func TestSubmit_NoCompensationConfiguredStillWorks(t *testing.T) {
	stub := &stubSubmitter{err: &transaction.BroadcastFailure{Code: "REJECTED", Description: "terminal"}}
	app := newServer(stub, nil, nil, nil)

	resp := doRequest(t, app, submitReq([]byte{0x01}))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
}

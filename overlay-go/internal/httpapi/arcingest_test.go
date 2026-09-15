package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"
)

// stubMerkleProofHandler is a MerkleProofHandler test double: it records
// what it was called with and returns a canned error, so tests never need a
// real engine.
type stubMerkleProofHandler struct {
	err error

	calls    int
	gotCtx   context.Context
	gotTxid  *chainhash.Hash
	gotProof *transaction.MerklePath
}

func (s *stubMerkleProofHandler) HandleNewMerkleProof(ctx context.Context, txid *chainhash.Hash, proof *transaction.MerklePath) error {
	s.calls++
	s.gotCtx = ctx
	s.gotTxid = txid
	s.gotProof = proof
	return s.err
}

func newArcIngestApp(h MerkleProofHandler, callbackToken string) *fiber.App {
	return newArcIngestAppEvict(h, callbackToken, nil)
}

func newArcIngestAppEvict(h MerkleProofHandler, callbackToken string, evict EvictTx) *fiber.App {
	f := fiber.New()
	registerArcIngestRoutes(f, h, callbackToken, evict)
	return f
}

// stubEvictTx records EvictTx calls and returns a canned outcome/error.
type stubEvictTx struct {
	err     error
	outcome EvictionOutcome

	calls    int
	gotTxids []string
}

func (s *stubEvictTx) evict(_ context.Context, txid string) (EvictionOutcome, error) {
	s.calls++
	s.gotTxids = append(s.gotTxids, txid)
	return s.outcome, s.err
}

// samplePathHex builds a trivial single-leaf MerklePath and returns its hex
// encoding — enough to round-trip through transaction.NewMerklePathFromHex
// without needing a real block.
func samplePathHex(t *testing.T, txid *chainhash.Hash) string {
	t.Helper()
	isTxid := true
	mp := transaction.NewMerklePath(100, [][]*transaction.PathElement{
		{{Offset: 0, Hash: txid, Txid: &isTxid}},
	})
	return mp.Hex()
}

const sampleTxidHex = "00000000000000000000000000000000000000000000000000000000000abc"

func TestArcIngestBadTokenRejected(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "expected-token")

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer wrong-token")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if h.calls != 0 {
		t.Fatalf("handler called %d times, want 0", h.calls)
	}
}

func TestArcIngestMissingTokenRejected(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "expected-token")

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestArcIngestGoodBearerTokenWithProof(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "expected-token")

	txid, err := chainhash.NewHashFromHex(sampleTxidHex)
	if err != nil {
		t.Fatalf("NewHashFromHex: %v", err)
	}
	pathHex := samplePathHex(t, txid)

	body := `{"txid":"` + sampleTxidHex + `","merklePath":"` + pathHex + `","blockHeight":100}`
	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer expected-token")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if h.calls != 1 {
		t.Fatalf("handler called %d times, want 1", h.calls)
	}
	if h.gotTxid == nil || h.gotTxid.String() != txid.String() {
		t.Fatalf("gotTxid = %v, want %v", h.gotTxid, txid)
	}
	if h.gotProof == nil {
		t.Fatal("gotProof is nil, want the parsed merkle path")
	}
}

func TestArcIngestGoodXCallbackTokenHeader(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "expected-token")

	txid, err := chainhash.NewHashFromHex(sampleTxidHex)
	if err != nil {
		t.Fatalf("NewHashFromHex: %v", err)
	}
	pathHex := samplePathHex(t, txid)

	body := `{"txid":"` + sampleTxidHex + `","merklePath":"` + pathHex + `"}`
	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-callback-token", "expected-token")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if h.calls != 1 {
		t.Fatalf("handler called %d times, want 1", h.calls)
	}
}

func TestArcIngestNoTokenConfiguredSkipsCheck(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "")

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusAccepted {
		t.Fatalf("status = %d, want 202 (no proof, no token configured)", resp.StatusCode)
	}
}

func TestArcIngestNoProofReturns202(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "")

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"SENT_TO_NETWORK"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusAccepted {
		t.Fatalf("status = %d, want 202", resp.StatusCode)
	}
	if h.calls != 0 {
		t.Fatalf("handler called %d times, want 0", h.calls)
	}
}

// TestArcIngestTerminalStatusReturns200WithoutProofHandling covers the
// nil-EvictTx fallback (eviction not wired): the terminal status is still
// acknowledged with 200 (log-only) and never reaches the proof handler.
func TestArcIngestTerminalStatusReturns200WithoutProofHandling(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "")

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"REJECTED"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 for terminal status", resp.StatusCode)
	}
	if h.calls != 0 {
		t.Fatalf("handler called %d times, want 0 (no eviction hook to call)", h.calls)
	}
}

// TestArcIngestTerminalStatusEvicts pins the TS-parity path: a terminal
// txStatus evicts the applied transaction (EvictTx gets the txid) and
// acknowledges with 200; the proof handler is never involved.
func TestArcIngestTerminalStatusEvicts(t *testing.T) {
	h := &stubMerkleProofHandler{}
	ev := &stubEvictTx{}
	app := newArcIngestAppEvict(h, "", ev.evict)

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"REJECTED"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ev.calls != 1 || len(ev.gotTxids) != 1 || ev.gotTxids[0] != sampleTxidHex {
		t.Fatalf("EvictTx calls = %d txids = %v, want 1 call with %s", ev.calls, ev.gotTxids, sampleTxidHex)
	}
	if h.calls != 0 {
		t.Fatalf("proof handler called %d times, want 0", h.calls)
	}
}

// Wire contract §9.8: a failed eviction must NOT be acknowledged, and it is a
// retryable dependency fault (503) — nothing was stamped, the inputs are still
// marked spent, and Arcade must re-deliver so the unwind is attempted again.
func TestArcIngestTerminalStatusEvictionErrorIs503(t *testing.T) {
	h := &stubMerkleProofHandler{}
	ev := &stubEvictTx{err: errors.New("mongo down")}
	app := newArcIngestAppEvict(h, "", ev.evict)

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"DOUBLE_SPEND_ATTEMPTED"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
	if ev.calls != 1 {
		t.Fatalf("EvictTx calls = %d, want 1", ev.calls)
	}
}

// Wire contract §9.12 — the terminal-status 200 body, byte-for-byte: both
// engines answer with the same message and the same six data keys, so Arcade
// (and an operator reading its delivery log) sees one shape.
func TestArcIngestTerminalStatusBodyMatchesTheContract(t *testing.T) {
	h := &stubMerkleProofHandler{}
	ev := &stubEvictTx{outcome: EvictionOutcome{
		RestoredOutpoints: 2, RestoredTokenRows: 1, AlreadyEvicted: true,
	}}
	app := newArcIngestAppEvict(h, "", ev.evict)

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest",
		strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"REJECTED","extraInfo":"fee too low"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["status"] != "success" || body["message"] != "Terminal transaction status processed" {
		t.Fatalf("body = %v", body)
	}
	data, _ := body["data"].(map[string]any)
	if data == nil {
		t.Fatalf("body = %v, missing data", body)
	}
	want := map[string]any{
		"txid":              sampleTxidHex,
		"txStatus":          "REJECTED",
		"reason":            "fee too low",
		"restoredOutpoints": float64(2),
		"restoredTokenRows": float64(1),
		"alreadyEvicted":    true,
	}
	if len(data) != len(want) {
		t.Fatalf("data has keys %v, want exactly %v", data, want)
	}
	for k, v := range want {
		if data[k] != v {
			t.Fatalf("data[%q] = %v, want %v", k, data[k], v)
		}
	}
}

// With eviction unwired the shape is unchanged — only the counts are zero.
func TestArcIngestTerminalStatusBodyWithoutEvictionWired(t *testing.T) {
	app := newArcIngestApp(&stubMerkleProofHandler{}, "")
	req := httptest.NewRequest(http.MethodPost, "/arc-ingest",
		strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"REJECTED"}`))
	req.Header.Set("Content-Type", "application/json")

	body := decodeJSON(t, doRequest(t, app, req))
	if body["message"] != "Terminal transaction status processed" {
		t.Fatalf("body = %v", body)
	}
	data, _ := body["data"].(map[string]any)
	if data["restoredOutpoints"] != float64(0) || data["alreadyEvicted"] != false {
		t.Fatalf("data = %v", data)
	}
}

// TestArcIngestNonTerminalStatusDoesNotEvict guards against over-eager
// eviction: an in-flight status must leave EvictTx uncalled.
func TestArcIngestNonTerminalStatusDoesNotEvict(t *testing.T) {
	h := &stubMerkleProofHandler{}
	ev := &stubEvictTx{}
	app := newArcIngestAppEvict(h, "", ev.evict)

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"SENT_TO_NETWORK"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusAccepted {
		t.Fatalf("status = %d, want 202", resp.StatusCode)
	}
	if ev.calls != 0 {
		t.Fatalf("EvictTx calls = %d, want 0", ev.calls)
	}
}

func TestArcIngestMissingTxidIsBadRequest(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newArcIngestApp(h, "")

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestArcIngestHandlerErrorIsBadRequest(t *testing.T) {
	h := &stubMerkleProofHandler{err: errors.New("boom")}
	app := newArcIngestApp(h, "")

	txid, err := chainhash.NewHashFromHex(sampleTxidHex)
	if err != nil {
		t.Fatalf("NewHashFromHex: %v", err)
	}
	pathHex := samplePathHex(t, txid)
	body := `{"txid":"` + sampleTxidHex + `","merklePath":"` + pathHex + `"}`
	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

// TestArcIngestRouteAbsentWhenArcadeDisabled proves newServer only mounts
// /arc-ingest when the caller opts in — Task 16's wiring gates this on
// App.ArcadeEnabled.
func TestArcIngestRouteAbsentWhenArcadeDisabled(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil)

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusNotFound {
		t.Fatalf("status = %d, want 404 when Arcade is disabled", resp.StatusCode)
	}
}

func TestArcIngestRoutePresentWhenArcadeEnabled(t *testing.T) {
	h := &stubMerkleProofHandler{}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithArcade(h, "callback-token", nil))

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"SENT_TO_NETWORK"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer callback-token")

	resp := doRequest(t, app, req)
	if resp.StatusCode == fiber.StatusNotFound {
		t.Fatal("status = 404, want the route to be registered when Arcade is enabled with a callback token")
	}
}

// FIX E, second half: /arc-ingest must NOT be mounted without a callback
// token. Eviction now restores a transaction's inputs and permanently voids
// its σ_I, so an unauthenticated terminal-status callback is an unwind
// primitive for anyone who can reach the node. An empty token used to mean
// "skip the token check" (OverlayExpress's default) and left the route wide
// open; it now means the route does not exist, while the rest of the node
// serves normally.
func TestArcIngestRouteAbsentWhenCallbackTokenIsEmpty(t *testing.T) {
	h := &stubMerkleProofHandler{}
	evict := &stubEvictTx{}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil, WithArcade(h, "", evict.evict))

	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"REJECTED"}`))
	req.Header.Set("Content-Type", "application/json")

	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusNotFound {
		t.Fatalf("status = %d, want 404 when the Arcade callback token is empty", resp.StatusCode)
	}
	if evict.calls != 0 {
		t.Fatalf("eviction ran %d times through an unmounted route", evict.calls)
	}

	// The rest of the node still serves.
	health := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.StatusCode != fiber.StatusOK {
		t.Fatalf("/health = %d, want the node to keep serving everything else", health.StatusCode)
	}
}

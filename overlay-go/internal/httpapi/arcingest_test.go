package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf16"

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

// A full 64-hex txid: /arc-ingest refuses anything else before touching any
// store (as the TS route does).
const sampleTxidHex = "0000000000000000000000000000000000000000000000000000000000000abc"

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
		"txid":     sampleTxidHex,
		"txStatus": "REJECTED",
		// The reason is "<txStatus> <extraInfo>", trimmed — the TS route's (and
		// upstream overlay-express's) construction, byte-identical (§9.12).
		"reason":            "REJECTED fee too low",
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

// Wire contract §9.12 parity with overlay/src/eviction.ts: a txid that is not
// 64 hex characters is refused 400 with the TS message before any eviction or
// proof ingestion runs, on the terminal and the proof path alike.
func TestArcIngestRefusesATxidThatIsNot64Hex(t *testing.T) {
	cases := map[string]string{
		"too short":   strings.Repeat("ab", 31),
		"too long":    strings.Repeat("ab", 32) + "0",
		"not hex":     strings.Repeat("zz", 32),
		"an outpoint": strings.Repeat("ab", 32) + ".0",
		"padded":      " " + strings.Repeat("ab", 32),
	}
	for name, bad := range cases {
		t.Run(name, func(t *testing.T) {
			h := &stubMerkleProofHandler{}
			ev := &stubEvictTx{}
			app := newArcIngestAppEvict(h, "", ev.evict)
			for _, body := range []string{
				`{"txid":"` + bad + `","txStatus":"REJECTED"}`,
				`{"txid":"` + bad + `","txStatus":"MINED","merklePath":"deadbeef"}`,
			} {
				req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				resp := doRequest(t, app, req)
				if resp.StatusCode != fiber.StatusBadRequest {
					t.Fatalf("status = %d, want 400", resp.StatusCode)
				}
				got := decodeJSON(t, resp)
				if got["status"] != "error" || got["message"] != "Provider callback txid must be 64 hex characters" {
					t.Fatalf("body = %v", got)
				}
			}
			if ev.calls != 0 || h.calls != 0 {
				t.Fatalf("evict calls = %d, proof calls = %d; want none", ev.calls, h.calls)
			}
		})
	}
}

// An upper-case txid is accepted and lowercased before anything uses it, as
// on TS — the admission record is keyed by the lowercase txid.
func TestArcIngestLowercasesTheTxid(t *testing.T) {
	ev := &stubEvictTx{}
	app := newArcIngestAppEvict(&stubMerkleProofHandler{}, "", ev.evict)
	upper := strings.ToUpper(strings.Repeat("ab", 32))
	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+upper+`","txStatus":"REJECTED"}`))
	req.Header.Set("Content-Type", "application/json")
	resp := doRequest(t, app, req)
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if len(ev.gotTxids) != 1 || ev.gotTxids[0] != strings.Repeat("ab", 32) {
		t.Fatalf("evicted %v, want the lowercase txid", ev.gotTxids)
	}
	data, _ := decodeJSON(t, resp)["data"].(map[string]any)
	if data["txid"] != strings.Repeat("ab", 32) {
		t.Fatalf("data.txid = %v, want lowercase", data["txid"])
	}
}

// The reason is bounded to 256 UTF-16 code units, as on TS (whose engine
// refuses a reason over 1024 UTF-8 bytes). 256 units is at most 768 bytes.
func TestArcIngestBoundsTheReasonTo256UTF16Units(t *testing.T) {
	for name, extra := range map[string]string{
		"ascii":          strings.Repeat("x", 2000),
		"astral (emoji)": strings.Repeat("\U0001F600", 1000),
		"bmp multi-byte": strings.Repeat("é", 2000),
	} {
		t.Run(name, func(t *testing.T) {
			app := newArcIngestAppEvict(&stubMerkleProofHandler{}, "", (&stubEvictTx{}).evict)
			payload, _ := json.Marshal(map[string]string{"txid": sampleTxidHex, "txStatus": "REJECTED", "extraInfo": extra})
			req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(string(payload)))
			req.Header.Set("Content-Type", "application/json")
			resp := doRequest(t, app, req)
			if resp.StatusCode != fiber.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}
			data, _ := decodeJSON(t, resp)["data"].(map[string]any)
			reason, _ := data["reason"].(string)
			if !strings.HasPrefix(reason, "REJECTED ") {
				t.Fatalf("reason = %q, want it to start with the status", reason)
			}
			if n := len(utf16.Encode([]rune(reason))); n > 256 {
				t.Fatalf("reason is %d UTF-16 units, want <= 256", n)
			}
			if len(reason) > 1024 {
				t.Fatalf("reason is %d UTF-8 bytes, want <= 1024", len(reason))
			}
		})
	}
}

// The cut keeps a surrogate pair that ends exactly on the bound, and drops
// only a high surrogate whose low half fell past it.
func TestEvictionReasonCutRespectsSurrogatePairs(t *testing.T) {
	// "R " is 2 units and each emoji 2 more, so 127 emoji end exactly on 256.
	r := evictionReason("R", strings.Repeat("\U0001F600", 200))
	if want := "R " + strings.Repeat("\U0001F600", 127); r != want {
		t.Fatalf("reason = %q (%d units), want 127 whole emoji", r, len(utf16.Encode([]rune(r))))
	}
	if strings.ContainsRune(r, '\uFFFD') {
		t.Fatalf("reason carries a replacement character: %q", r)
	}
	// Odd alignment: "RX " is 3 units, so the 256th unit is a high surrogate.
	r = evictionReason("RX", strings.Repeat("\U0001F600", 200))
	if want := "RX " + strings.Repeat("\U0001F600", 126); r != want {
		t.Fatalf("reason = %q, want the split pair dropped (%d units)", r, len(utf16.Encode([]rune(r))))
	}
}

// With no extraInfo the reason is the status alone; with neither it is empty.
func TestArcIngestReasonWithoutExtraInfo(t *testing.T) {
	app := newArcIngestAppEvict(&stubMerkleProofHandler{}, "", (&stubEvictTx{}).evict)
	req := httptest.NewRequest(http.MethodPost, "/arc-ingest", strings.NewReader(`{"txid":"`+sampleTxidHex+`","txStatus":"REJECTED"}`))
	req.Header.Set("Content-Type", "application/json")
	data, _ := decodeJSON(t, doRequest(t, app, req))["data"].(map[string]any)
	if data["reason"] != "REJECTED" {
		t.Fatalf("reason = %v, want REJECTED", data["reason"])
	}
}

package httpapi

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/draft"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/settle"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
)

const testAsset = "abababababababababababababababababababababababababababababababab.0"

// Canonical txids and outpoints: the API refuses any other shape (ERR_SHAPE).
var (
	txid1 = strings.Repeat("a1", 32)
	txid2 = strings.Repeat("a2", 32)
	txid3 = strings.Repeat("a3", 32)
	txid4 = strings.Repeat("a4", 32)
)

func outpoint(b string, vout int) string { return strings.Repeat(b, 32) + "." + strconv.Itoa(vout) }

// ---------------------------------------------------------------------------
// stubs

type stubDrafter struct {
	resp     *draft.Response
	ref      *draft.Refusal
	err      error
	lastReq  draft.Request
	panicMsg string // non-empty: Draft panics instead of returning
}

func (d *stubDrafter) Draft(_ context.Context, req draft.Request) (*draft.Response, *draft.Refusal, error) {
	if d.panicMsg != "" {
		panic(d.panicMsg)
	}
	d.lastReq = req
	return d.resp, d.ref, d.err
}

type stubSettler struct {
	settled  int
	err      error
	lastTxid string
	lastBeef []byte
	calls    int
	sleep    time.Duration // > 0: Settle blocks this long before returning
}

func (s *stubSettler) Settle(_ context.Context, txid string, beef []byte) (int, error) {
	if s.sleep > 0 {
		time.Sleep(s.sleep)
	}
	s.calls++
	s.lastTxid, s.lastBeef = txid, beef
	return s.settled, s.err
}

// clock is a settable /health cache clock.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// balanceErrSource overrides *fuel.Fake's BalanceSats to fail, so /health's
// wallet-failure degrade path can be exercised without teaching the shared
// Fake about balance failures.
type balanceErrSource struct {
	*fuel.Fake
	err error
}

func (b *balanceErrSource) BalanceSats(context.Context) (uint64, error) { return 0, b.err }

// ---------------------------------------------------------------------------
// harness

type harness struct {
	t       *testing.T
	handler http.Handler
	st      *store.Store
	src     *fuel.Fake
	cfg     config.Config
	drafter *stubDrafter
	settler *stubSettler
	apiKey  string
	clock   *clock
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	vars := map[string]string{
		"ISSUER_ROOT_KEY":      "dc745c57de627a6d3a3ca549e0f9fb6b8f779108a1fe6fe290cc4df3461125d6",
		"FK_API_KEY":           "0123456789abcdef0123456789abcdef",
		"FK_STORAGE_CONFIG":    "x",
		"FK_NETWORK":           "test",
		"FUEL_ASSET_IDS":       testAsset,
		"FK_POOL_TARGET":       "100",
		"FK_LOW_WATER_PERCENT": "60",
	}
	cfg, err := config.Load(func(k string) string { return vars[k] })
	require.NoError(t, err)

	issuer, err := ec.PrivateKeyFromHex(cfg.IssuerRootKeyHex)
	require.NoError(t, err)
	src := fuel.NewFake(issuer)

	now := time.Unix(1_758_500_000, 0)
	st, err := store.Open("sqlite", filepath.Join(t.TempDir(), "fk.sqlite"), func() time.Time { return now })
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })

	h := &harness{
		t: t, st: st, src: src, cfg: cfg,
		drafter: &stubDrafter{}, settler: &stubSettler{}, apiKey: cfg.APIKey,
		clock: &clock{t: now},
	}
	h.handler = New(Deps{
		APIKey: cfg.APIKey, Drafter: h.drafter, Store: st, Settler: h.settler,
		Source: src, Cfg: cfg, Logger: nil, Now: h.clock.now,
	})
	return h
}

// seedReserved claims and commits a single-pair reservation directly against
// the store, as if a prior /draft had run, so /consume and /release have
// something real to act on.
func (h *harness) seedReserved(outpoint, requestID, requester string) {
	h.t.Helper()
	ctx := context.Background()
	cand := store.Candidate{Outpoint: outpoint, Satoshis: 200, FuelScript: "aa", FuelBeef: "bb", DerivationPrefix: "p", DerivationSuffix: "s"}
	ok, err := h.st.Claim(ctx, cand, requestID, requester, testAsset, 0, 60)
	require.NoError(h.t, err)
	require.True(h.t, ok)
	_, err = h.st.Commit(ctx, requestID, []store.CommitPair{{Outpoint: outpoint, FeeScript: "cc", KeyID: "kid", FeeAmount: "20"}}, 600)
	require.NoError(h.t, err)
}

func (h *harness) do(method, path string, body any, key string) *httptest.ResponseRecorder {
	h.t.Helper()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		require.NoError(h.t, err)
		reader = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, reader)
	if key != "" {
		req.Header.Set("X-Fuel-Key", key)
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	require.Equal(t, "application/json", rec.Header().Get("Content-Type"))
	var m map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &m), "body: %s", rec.Body.String())
	return m
}

// ---------------------------------------------------------------------------
// X-Fuel-Key guard

func TestGuard_RequiresKeyOnEveryRouteExceptHealth(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		method, path string
		body         any
	}{
		{"POST", "/draft", draft.Request{}},
		{"POST", "/consume", map[string]any{}},
		{"POST", "/release", map[string]any{}},
		{"POST", "/settle", map[string]any{}},
		{"DELETE", "/deny/abc", nil},
	}
	for _, c := range cases {
		for _, key := range []string{"", "wrong-key-that-is-not-the-real-one"} {
			rec := h.do(c.method, c.path, c.body, key)
			require.Equal(t, http.StatusUnauthorized, rec.Code, "%s %s key=%q", c.method, c.path, key)
			m := decodeMap(t, rec)
			require.Equal(t, "error", m["status"])
			require.Equal(t, "ERR_UNAUTHORIZED", m["code"])
			require.Equal(t, false, m["retryable"])
		}
	}
}

func TestHealth_NoKeyRequired(t *testing.T) {
	h := newHarness(t)
	rec := h.do("GET", "/health", nil, "")
	require.Equal(t, http.StatusOK, rec.Code)
}

// ---------------------------------------------------------------------------
// POST /draft

func TestDraft_RefusalMapsStatusAndBody(t *testing.T) {
	h := newHarness(t)
	h.drafter.ref = &draft.Refusal{Code: "ERR_FUEL_QUOTA", HTTP: 429, Retryable: true, Description: "quota exceeded"}
	rec := h.do("POST", "/draft", draft.Request{AssetID: testAsset}, h.apiKey)
	require.Equal(t, 429, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, "error", m["status"])
	require.Equal(t, "ERR_FUEL_QUOTA", m["code"])
	require.Equal(t, true, m["retryable"])
	require.Equal(t, "quota exceeded", m["description"])
	require.Equal(t, testAsset, h.drafter.lastReq.AssetID)
}

func TestDraft_InfraErrorMapsTo503(t *testing.T) {
	h := newHarness(t)
	h.drafter.err = errors.New("boom")
	rec := h.do("POST", "/draft", draft.Request{AssetID: testAsset}, h.apiKey)
	require.Equal(t, 503, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, "ERR_FUEL_UNAVAILABLE", m["code"])
	require.Equal(t, true, m["retryable"])
}

func TestDraft_MalformedBodyIs400Shape(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest("POST", "/draft", bytes.NewReader([]byte("not json")))
	req.Header.Set("X-Fuel-Key", h.apiKey)
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	require.Equal(t, 400, rec.Code)
	require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
}

func TestDraft_ResponseHasExactSpecFieldNames(t *testing.T) {
	h := newHarness(t)
	h.drafter.resp = &draft.Response{
		RequestID: "req1", AssetID: testAsset, K: 1, FeePerPair: "20", ExpiresAt: 123,
		DraftTx: "aa", FuelBeef: "bb",
		Pairs: []draft.Pair{{
			Vin: 0, Vout: 0, FuelOutpoint: "txid.0", FuelSatoshis: 200,
			KeyID: "fee-txid.0", Counterparty: "cp", FeeScript: "cc", FeeAmount: "20",
		}},
	}
	rec := h.do("POST", "/draft", draft.Request{AssetID: testAsset}, h.apiKey)
	require.Equal(t, 200, rec.Code)
	m := decodeMap(t, rec)
	for _, k := range []string{"requestId", "assetId", "k", "feePerPair", "expiresAt", "draftTx", "fuelBeef", "pairs"} {
		require.Contains(t, m, k)
	}
	require.Equal(t, "req1", m["requestId"])
	pairs, ok := m["pairs"].([]any)
	require.True(t, ok)
	require.Len(t, pairs, 1)
	p, ok := pairs[0].(map[string]any)
	require.True(t, ok)
	for _, k := range []string{"vin", "vout", "fuelOutpoint", "fuelSatoshis", "keyID", "counterparty", "feeScript", "feeAmount"} {
		require.Contains(t, p, k)
	}
}

// ---------------------------------------------------------------------------
// POST /consume

func TestConsume(t *testing.T) {
	h := newHarness(t)
	const requestID, requester = "req-consume-1", "requester-1"
	outpoint := outpoint("de", 0)
	h.seedReserved(outpoint, requestID, requester)

	t.Run("ok", func(t *testing.T) {
		body := map[string]any{"txid": txid1, "pairs": []map[string]any{{"outpoint": outpoint, "requestId": requestID}}}
		rec := h.do("POST", "/consume", body, h.apiKey)
		require.Equal(t, 200, rec.Code)
		m := decodeMap(t, rec)
		require.Equal(t, true, m["ok"])
		require.NotContains(t, m, "outpoint")
		require.NotContains(t, m, "reason")
	})

	t.Run("refused: consumed by another txid", func(t *testing.T) {
		body := map[string]any{"txid": txid2, "pairs": []map[string]any{{"outpoint": outpoint, "requestId": requestID}}}
		rec := h.do("POST", "/consume", body, h.apiKey)
		require.Equal(t, 200, rec.Code)
		m := decodeMap(t, rec)
		require.Equal(t, false, m["ok"])
		require.Equal(t, outpoint, m["outpoint"])
		require.Equal(t, "consumed by another txid", m["reason"])
	})

	t.Run("malformed: missing txid", func(t *testing.T) {
		body := map[string]any{"pairs": []map[string]any{{"outpoint": outpoint, "requestId": requestID}}}
		rec := h.do("POST", "/consume", body, h.apiKey)
		require.Equal(t, 400, rec.Code)
		require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
	})

	t.Run("malformed: empty pairs", func(t *testing.T) {
		body := map[string]any{"txid": txid3, "pairs": []map[string]any{}}
		rec := h.do("POST", "/consume", body, h.apiKey)
		require.Equal(t, 400, rec.Code)
		require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
	})

	t.Run("malformed: empty field in pair", func(t *testing.T) {
		body := map[string]any{"txid": txid4, "pairs": []map[string]any{{"outpoint": "", "requestId": requestID}}}
		rec := h.do("POST", "/consume", body, h.apiKey)
		require.Equal(t, 400, rec.Code)
		require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
	})
}

func TestConsume_StoreErrorMapsTo503(t *testing.T) {
	h := newHarness(t)
	require.NoError(t, h.st.Close())
	body := map[string]any{"txid": txid1, "pairs": []map[string]any{{"outpoint": outpoint("de", 0), "requestId": "r1"}}}
	rec := h.do("POST", "/consume", body, h.apiKey)
	require.Equal(t, 503, rec.Code)
	require.Equal(t, "ERR_UNAVAILABLE", decodeMap(t, rec)["code"])
}

// ---------------------------------------------------------------------------
// POST /release

func TestRelease_ByRequestID(t *testing.T) {
	h := newHarness(t)
	h.seedReserved("op-release-1.0", "req-release-1", "requester-1")
	rec := h.do("POST", "/release", map[string]any{"requestId": "req-release-1"}, h.apiKey)
	require.Equal(t, 200, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, true, m["ok"])
	require.Equal(t, float64(1), m["affected"])
}

func TestRelease_ByEviction(t *testing.T) {
	h := newHarness(t)
	const requestID = "req-release-2"
	outpoint := outpoint("ef", 2)
	h.seedReserved(outpoint, requestID, "requester-2")
	_, err := h.st.Consume(context.Background(), txid1, []store.ConsumeItem{{Outpoint: outpoint, RequestID: requestID}})
	require.NoError(t, err)

	rec := h.do("POST", "/release", map[string]any{"txid": txid1, "outpoints": []string{outpoint}}, h.apiKey)
	require.Equal(t, 200, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, true, m["ok"])
	require.Equal(t, float64(1), m["affected"])
}

func TestRelease_NeitherFormIs400Shape(t *testing.T) {
	h := newHarness(t)
	rec := h.do("POST", "/release", map[string]any{}, h.apiKey)
	require.Equal(t, 400, rec.Code)
	require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
}

func TestRelease_BothFormsIs400Shape(t *testing.T) {
	h := newHarness(t)
	body := map[string]any{"requestId": "r1", "txid": "t1", "outpoints": []string{"op"}}
	rec := h.do("POST", "/release", body, h.apiKey)
	require.Equal(t, 400, rec.Code)
	require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
}

func TestRelease_PartialEvictionIs400Shape(t *testing.T) {
	h := newHarness(t)
	rec := h.do("POST", "/release", map[string]any{"txid": "t1"}, h.apiKey)
	require.Equal(t, 400, rec.Code)
	require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
}

// ---------------------------------------------------------------------------
// POST /settle

func TestSettle_PassesDecodedHexToSettler(t *testing.T) {
	h := newHarness(t)
	h.settler.settled = 2
	beefHex := hex.EncodeToString([]byte{0xde, 0xad, 0xbe, 0xef})
	rec := h.do("POST", "/settle", map[string]any{"txid": txid1, "atomicBeef": beefHex}, h.apiKey)
	require.Equal(t, 200, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, float64(2), m["settled"])
	require.Equal(t, txid1, h.settler.lastTxid)
	require.Equal(t, []byte{0xde, 0xad, 0xbe, 0xef}, h.settler.lastBeef)
}

func TestSettle_BadHexIs400Shape(t *testing.T) {
	h := newHarness(t)
	rec := h.do("POST", "/settle", map[string]any{"txid": txid1, "atomicBeef": "not-hex"}, h.apiKey)
	require.Equal(t, 400, rec.Code)
	require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
	require.Zero(t, h.settler.calls)
}

func TestSettle_SettlerErrorMapsTo503(t *testing.T) {
	h := newHarness(t)
	h.settler.err = errors.New("settle failed")
	rec := h.do("POST", "/settle", map[string]any{"txid": txid1, "atomicBeef": "aa"}, h.apiKey)
	require.Equal(t, 503, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, "ERR_UNAVAILABLE", m["code"])
	require.Equal(t, true, m["retryable"])
}

// A permanent settle failure (settle.ErrInvalid) is a final 400 with an
// alert, never a 503 the overlay would retry forever.
func TestSettle_InvalidMapsTo400Final(t *testing.T) {
	h := newHarness(t)
	var logs bytes.Buffer
	h.handler = New(Deps{
		APIKey: h.apiKey, Drafter: h.drafter, Store: h.st, Settler: h.settler,
		Source: h.src, Cfg: h.cfg, Logger: slog.New(slog.NewJSONHandler(&logs, nil)), Now: h.clock.now,
	})
	h.settler.err = fmt.Errorf("settle %s: %w", txid1, fmt.Errorf("%w: transaction does not spend fuel x", settle.ErrInvalid))
	rec := h.do("POST", "/settle", map[string]any{"txid": txid1, "atomicBeef": "aa"}, h.apiKey)
	require.Equal(t, 400, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, "error", m["status"])
	require.Equal(t, "ERR_SETTLE_INVALID", m["code"])
	require.Equal(t, false, m["retryable"])
	require.Contains(t, m["description"], "does not spend fuel")
	require.Contains(t, logs.String(), `"alert":"settle_invalid"`)
	require.Contains(t, logs.String(), `"level":"ERROR"`)
}

// ---------------------------------------------------------------------------
// GET /health

func TestHealth_ShapeAndLowWaterArithmetic(t *testing.T) {
	h := newHarness(t)
	h.src.AddFuel(t, h.cfg.Denomination)
	h.src.AddFuel(t, h.cfg.Denomination)
	h.src.Balance = 12345

	rec := h.do("GET", "/health", nil, "")
	require.Equal(t, 200, rec.Code)
	m := decodeMap(t, rec)

	pool, ok := m["pool"].(map[string]any)
	require.True(t, ok)
	for _, k := range []string{"available", "reserving", "reserved", "consumedUnsettled", "released", "recheckPending", "dropped", "spentExternal"} {
		require.Contains(t, pool, k)
	}
	require.Equal(t, float64(2), pool["available"])
	require.Equal(t, float64(2), m["provenFuel"])
	require.Equal(t, float64(12345), m["issuerBsvSats"])
	require.Equal(t, float64(h.cfg.PoolTarget*h.cfg.LowWaterPercent/100), m["lowWater"])
	require.Equal(t, float64(h.cfg.Denomination), m["denomination"])
	require.Equal(t, float64(0), m["denied"])
	require.NotContains(t, m, "errors")
}

func TestHealth_WalletFailureDegradesTo200(t *testing.T) {
	h := newHarness(t)
	bad := &balanceErrSource{Fake: h.src, err: errors.New("wallet down")}
	handler := New(Deps{
		APIKey: h.apiKey, Drafter: h.drafter, Store: h.st, Settler: h.settler,
		Source: bad, Cfg: h.cfg, Logger: nil,
	})
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest("GET", "/health", nil))
	require.Equal(t, 200, rec.Code)
	m := decodeMap(t, rec)
	require.Nil(t, m["issuerBsvSats"])
	errs, ok := m["errors"].([]any)
	require.True(t, ok)
	require.NotEmpty(t, errs)
}

func TestHealth_ListProvenFailureDegradesTo200(t *testing.T) {
	h := newHarness(t)
	h.src.FailNextList(errors.New("list failed"))
	rec := h.do("GET", "/health", nil, "")
	require.Equal(t, 200, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, float64(0), m["provenFuel"])
	errs, ok := m["errors"].([]any)
	require.True(t, ok)
	require.NotEmpty(t, errs)
}

// ---------------------------------------------------------------------------
// shape validation (txid, outpoints)

// Every txid the overlay sends is 64 lowercase hex and every outpoint is the
// canonical "<txid>.<vout>"; anything else is a 400 ERR_SHAPE that never
// reaches the store or the settler.
func TestShape_TxidAndOutpointsAreValidated(t *testing.T) {
	h := newHarness(t)
	require.NoError(t, h.st.Close()) // any request that reached the store would answer 503
	good := outpoint("cd", 1)
	badTxids := map[string]string{
		"short": txid1[:62], "long": txid1 + "00", "uppercase": strings.ToUpper(txid1), "not hex": strings.Repeat("zz", 32),
	}
	badOutpoints := map[string]string{
		"no vout": strings.Repeat("cd", 32), "uppercase": strings.ToUpper(strings.Repeat("cd", 32)) + ".1",
		"short txid": "deadbeef.0", "leading zero": strings.Repeat("cd", 32) + ".01", "negative": strings.Repeat("cd", 32) + ".-1",
		"vout overflow": strings.Repeat("cd", 32) + ".4294967296", "separator": strings.Repeat("cd", 32) + ":1",
	}
	expect400 := func(t *testing.T, path string, body any) {
		t.Helper()
		rec := h.do("POST", path, body, h.apiKey)
		require.Equal(t, 400, rec.Code, "%s %v", path, body)
		m := decodeMap(t, rec)
		require.Equal(t, "ERR_SHAPE", m["code"])
		require.Equal(t, false, m["retryable"])
	}
	for name, txid := range badTxids {
		t.Run("txid "+name, func(t *testing.T) {
			expect400(t, "/consume", map[string]any{"txid": txid, "pairs": []map[string]any{{"outpoint": good, "requestId": "r1"}}})
			expect400(t, "/release", map[string]any{"txid": txid, "outpoints": []string{good}})
			expect400(t, "/settle", map[string]any{"txid": txid, "atomicBeef": "aa"})
		})
	}
	for name, op := range badOutpoints {
		t.Run("outpoint "+name, func(t *testing.T) {
			expect400(t, "/consume", map[string]any{"txid": txid1, "pairs": []map[string]any{
				{"outpoint": good, "requestId": "r1"}, {"outpoint": op, "requestId": "r1"}}})
			expect400(t, "/release", map[string]any{"txid": txid1, "outpoints": []string{good, op}})
		})
	}
	require.Zero(t, h.settler.calls)

	// The canonical shapes pass validation (and reach the closed store).
	rec := h.do("POST", "/consume", map[string]any{"txid": txid1, "pairs": []map[string]any{{"outpoint": good, "requestId": "r1"}}}, h.apiKey)
	require.Equal(t, 503, rec.Code)
	rec = h.do("POST", "/release", map[string]any{"txid": txid1, "outpoints": []string{outpoint("cd", 4294967295)}}, h.apiKey)
	require.Equal(t, 503, rec.Code)
}

// ---------------------------------------------------------------------------
// /health cache and /livez

// /health reuses its pool listing and store counts for 10 s: a probe loop
// costs one wallet listing per window, not one per probe.
func TestHealth_CachesListingAndCountsFor10s(t *testing.T) {
	h := newHarness(t)
	h.src.AddFuel(t, h.cfg.Denomination)
	get := func() map[string]any {
		t.Helper()
		rec := h.do("GET", "/health", nil, "")
		require.Equal(t, 200, rec.Code)
		return decodeMap(t, rec)
	}
	require.Equal(t, float64(1), get()["provenFuel"])
	require.Equal(t, 1, h.src.ListProvenCalls())

	h.src.AddFuel(t, h.cfg.Denomination)
	h.seedReserved(outpoint("be", 0), "req-cache", "requester-cache")
	h.clock.add(healthCacheTTL - time.Second)
	m := get()
	require.Equal(t, 1, h.src.ListProvenCalls(), "the second call within 10 s hits the cache")
	require.Equal(t, float64(1), m["provenFuel"], "cached listing")
	require.Equal(t, float64(0), m["pool"].(map[string]any)["reserved"], "cached counts")

	h.clock.add(time.Second)
	m = get()
	require.Equal(t, 2, h.src.ListProvenCalls(), "refreshed after 10 s")
	require.Equal(t, float64(2), m["provenFuel"])
	require.Equal(t, float64(1), m["pool"].(map[string]any)["reserved"])
}

// A failed listing is not cached: the next probe retries at once.
func TestHealth_FailedListingIsNotCached(t *testing.T) {
	h := newHarness(t)
	h.src.AddFuel(t, h.cfg.Denomination)
	h.src.FailNextList(errors.New("list failed"))
	rec := h.do("GET", "/health", nil, "")
	require.Contains(t, decodeMap(t, rec), "errors")
	rec = h.do("GET", "/health", nil, "")
	m := decodeMap(t, rec)
	require.NotContains(t, m, "errors")
	require.Equal(t, float64(1), m["provenFuel"])
	require.Equal(t, 2, h.src.ListProvenCalls())
}

// /livez answers without any I/O: no key, no store, no wallet.
func TestLivez_NoIOAndNoKey(t *testing.T) {
	h := newHarness(t)
	require.NoError(t, h.st.Close())
	h.src.FailNextList(errors.New("wallet down"))
	rec := h.do("GET", "/livez", nil, "")
	require.Equal(t, 200, rec.Code)
	require.Equal(t, map[string]any{"ok": true}, decodeMap(t, rec))
	require.Zero(t, h.src.ListProvenCalls())
}

// ---------------------------------------------------------------------------
// DELETE /deny/{requester}

// requesterHex is a 66-hex-char (compressed-DER-shaped) requester key used
// wherever a test needs a value that passes handleDeny's shape check.
const requesterHex = "02abababababababababababababababababababababababababababababababab"

func TestDeny_RemovedAfterStoreDenyAndLowercases(t *testing.T) {
	h := newHarness(t)
	require.NoError(t, h.st.Deny(context.Background(), requesterHex, "reason", "op"))

	rec := h.do("DELETE", "/deny/"+strings.ToUpper(requesterHex), nil, h.apiKey)
	require.Equal(t, 200, rec.Code)
	require.Equal(t, true, decodeMap(t, rec)["removed"])

	// Idempotent: the second delete finds nothing left to remove.
	rec2 := h.do("DELETE", "/deny/"+requesterHex, nil, h.apiKey)
	require.Equal(t, 200, rec2.Code)
	require.Equal(t, false, decodeMap(t, rec2)["removed"])
}

func TestDeny_MalformedPathIs400ShapeWithoutTouchingStore(t *testing.T) {
	h := newHarness(t)
	rec := h.do("DELETE", "/deny/not-hex-and-way-too-short", nil, h.apiKey)
	require.Equal(t, 400, rec.Code)
	require.Equal(t, "ERR_SHAPE", decodeMap(t, rec)["code"])
	// The store was never touched: closing it does not change the outcome.
	require.NoError(t, h.st.Close())
	rec2 := h.do("DELETE", "/deny/not-hex-and-way-too-short", nil, h.apiKey)
	require.Equal(t, 400, rec2.Code)
}

func TestDeny_StoreErrorMapsTo503(t *testing.T) {
	h := newHarness(t)
	require.NoError(t, h.st.Close())
	rec := h.do("DELETE", "/deny/"+requesterHex, nil, h.apiKey)
	require.Equal(t, 503, rec.Code)
	require.Equal(t, "ERR_UNAVAILABLE", decodeMap(t, rec)["code"])
}

// ---------------------------------------------------------------------------
// Fix round 1 regressions

// TestGuard_EmptyAPIKeyAlwaysRefuses pins the critical fix: a Deps.APIKey of
// "" (a misconfigured keeper) must never be treated as "any key matches".
// subtle.ConstantTimeCompare("", "") == 1, so the guard must special-case the
// empty-key configuration before delegating to it.
func TestGuard_EmptyAPIKeyAlwaysRefuses(t *testing.T) {
	h := newHarness(t)
	handler := New(Deps{
		APIKey: "", Drafter: h.drafter, Store: h.st, Settler: h.settler,
		Source: h.src, Cfg: h.cfg, Logger: nil,
	})
	body := map[string]any{"txid": "tx1", "pairs": []map[string]any{{"outpoint": "op", "requestId": "r1"}}}
	b, err := json.Marshal(body)
	require.NoError(t, err)

	for _, key := range []string{"", "anything"} {
		req := httptest.NewRequest("POST", "/consume", bytes.NewReader(b))
		if key != "" {
			req.Header.Set("X-Fuel-Key", key)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		require.Equal(t, http.StatusUnauthorized, rec.Code, "key=%q", key)
		require.Equal(t, "ERR_UNAUTHORIZED", decodeMap(t, rec)["code"], "key=%q", key)
	}
}

// TestRecover_HandlerPanicIsAnsweredAsJSON500 pins the panic-recovery fix.
// Without server.recover sitting inside http.TimeoutHandler, a handler panic
// is caught by TimeoutHandler only to be re-panicked synchronously in the
// caller's goroutine (go1.27 net/http/server.go), which would fail this test
// with an unrecovered panic instead of producing a response.
func TestRecover_HandlerPanicIsAnsweredAsJSON500(t *testing.T) {
	h := newHarness(t)
	h.drafter.panicMsg = "boom"
	rec := h.do("POST", "/draft", draft.Request{AssetID: testAsset}, h.apiKey)
	require.Equal(t, http.StatusInternalServerError, rec.Code)
	m := decodeMap(t, rec)
	require.Equal(t, "error", m["status"])
	require.Equal(t, "ERR_INTERNAL", m["code"])
	require.Equal(t, true, m["retryable"])
}

// TestTimeout_ResponseCarriesJSONContentType pins the Content-Type fix: the
// 503 http.TimeoutHandler writes when a handler overruns its deadline must
// still carry Content-Type: application/json (decodeMap asserts this on
// every call), not just the routes that reply through writeJSON.
func TestTimeout_ResponseCarriesJSONContentType(t *testing.T) {
	h := newHarness(t)
	slow := &stubSettler{sleep: 50 * time.Millisecond}
	handler := New(Deps{
		APIKey: h.apiKey, Drafter: h.drafter, Store: h.st, Settler: slow,
		Source: h.src, Cfg: h.cfg, Logger: nil, Timeout: 5 * time.Millisecond,
	})
	req := httptest.NewRequest("POST", "/settle", bytes.NewReader([]byte(`{"txid":"`+txid1+`","atomicBeef":"aa"}`)))
	req.Header.Set("X-Fuel-Key", h.apiKey)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	m := decodeMap(t, rec) // asserts Content-Type: application/json
	require.Equal(t, "ERR_TIMEOUT", m["code"])
}

package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// testAdminDB connects to a dedicated test database (dropped in cleanup) so
// the httpapi package's Mongo-backed admin tests never collide with the
// mandala/enginestore packages' own test databases. Skips (not fails) when
// Mongo is unreachable, matching the pattern used throughout this repo.
func testAdminDB(t *testing.T) *mongo.Database {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://localhost:27017"))
	if err != nil {
		t.Skip("mongo unavailable:", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		t.Skip("mongo unavailable:", err)
	}
	db := client.Database("mandala_go_httpadmin_test")
	t.Cleanup(func() { _ = db.Drop(context.Background()) })
	return db
}

// mustMandalaStore / mustEngineStore build the real stores and fail the test
// if index creation does not succeed — both constructors abort on that (wire
// contract §9.9), so tests must too rather than running against a
// half-indexed database.
func mustMandalaStore(t *testing.T, db *mongo.Database) *mandala.Store {
	t.Helper()
	s, err := mandala.NewStore(db)
	if err != nil {
		t.Fatalf("mandala.NewStore: %v", err)
	}
	return s
}

func mustEngineStore(t *testing.T, db *mongo.Database) *enginestore.Store {
	t.Helper()
	es, err := enginestore.New(db)
	if err != nil {
		t.Fatalf("enginestore.New: %v", err)
	}
	return es
}

// seedHistory appends an "issue 100" then a "redeem 30" admin-history entry
// for assetID via the real Store (NextAdmitSeq'd, so admitSeq ordering is
// realistic), returning the two admitSeqs in insertion order.
func seedHistory(t *testing.T, store *mandala.Store, assetID string) (seq1, seq2 int64) {
	t.Helper()
	ctx := context.Background()
	var err error
	seq1, err = store.NextAdmitSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	seq2, err = store.NextAdmitSeq(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AppendAdminHistory(ctx, mandala.AdminHistoryEntry{
		AssetID: assetID, Txid: "t1", OutputIndex: 0, Height: 10, Offset: 0, AdmitSeq: seq1,
		ActionDetails: mandala.ActionDetails{"kind": "issue", "amount": float64(100)},
		CreatedAt:     time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendAdminHistory(ctx, mandala.AdminHistoryEntry{
		AssetID: assetID, Txid: "t2", OutputIndex: 1, Height: 11, Offset: 0, AdmitSeq: seq2,
		ActionDetails: mandala.ActionDetails{"kind": "redeem", "amount": float64(30)},
		CreatedAt:     time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	return seq1, seq2
}

func TestAdminAssetState_DefaultShapeForUnknownAsset(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-state/unknown-asset.0", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	var state mandala.AssetAdminState
	raw := readRawBody(t, resp)
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatalf("unmarshal: %v (body: %s)", err, raw)
	}
	if state.AssetID != "unknown-asset.0" {
		t.Fatalf("assetId = %q, want unknown-asset.0", state.AssetID)
	}
	if state.AccessMode != "denylist" {
		t.Fatalf("accessMode = %q, want denylist", state.AccessMode)
	}
	if state.IsPaused {
		t.Fatalf("isPaused = true, want false for unknown asset")
	}
	// Non-nil, non-null empty arrays — not omitted, not `null`.
	for _, want := range []string{`"blockedIdentities":[]`, `"allowedIdentities":[]`, `"frozenOutpoints":[]`, `"evictedOutpoints":[]`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("body = %s, want to contain %s", raw, want)
		}
	}
}

func TestAdminAssetState_Error(t *testing.T) {
	stub := &stubAdminStore{stateErr: errors.New("boom")}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, stub, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-state/a.0", nil))
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if _, ok := body["error"]; !ok {
		t.Fatalf("body = %v, want an \"error\" field (not status/message)", body)
	}
	if _, ok := body["status"]; ok {
		t.Fatalf("body = %v, admin routes must use {error} shape, not {status,message}", body)
	}
}

func TestAdminHistory_SeededEntriesAndFieldNames(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	seedHistory(t, store, "asset-a.0")
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history/asset-a.0", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	var rows []map[string]any
	raw := readRawBody(t, resp)
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("unmarshal: %v (body: %s)", err, raw)
	}
	if len(rows) != 2 {
		t.Fatalf("len(rows) = %d, want 2 (body: %s)", len(rows), raw)
	}
	for _, field := range []string{"assetId", "txid", "outputIndex", "height", "offset", "admitSeq", "actionDetails"} {
		if _, ok := rows[0][field]; !ok {
			t.Fatalf("row missing field %q: %+v", field, rows[0])
		}
	}
	actionDetails, ok := rows[0]["actionDetails"].(map[string]any)
	if !ok {
		t.Fatalf("actionDetails not an object: %+v", rows[0]["actionDetails"])
	}
	if actionDetails["kind"] != "issue" {
		t.Fatalf("first row (height-ordered) kind = %v, want issue", actionDetails["kind"])
	}
}

func TestAdminHistory_EmptyArrayNotNullForUnknownAsset(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history/no-such-asset.0", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	raw := readRawBody(t, resp)
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Fatalf("body = %s, want exactly [] (never null)", raw)
	}
}

func TestAdminHistory_Error(t *testing.T) {
	stub := &stubAdminStore{historyErr: errors.New("boom")}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, stub, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history/a.0", nil))
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if _, ok := body["error"]; !ok {
		t.Fatalf("body = %v, want an \"error\" field", body)
	}
}

func TestAdminHistoryPage_NewestFirstAndLimit(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	_, seq2 := seedHistory(t, store, "asset-b.0")
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history-page/asset-b.0?limit=1&offset=0", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	var rows []mandala.AdminHistoryEntry
	raw := readRawBody(t, resp)
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("unmarshal: %v (body: %s)", err, raw)
	}
	if len(rows) != 1 {
		t.Fatalf("len(rows) = %d, want 1 (limit=1)", len(rows))
	}
	if rows[0].AdmitSeq != seq2 {
		t.Fatalf("admitSeq = %d, want newest (%d)", rows[0].AdmitSeq, seq2)
	}
}

func TestAdminHistoryPage_DefaultsAndEmptyArray(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history-page/no-such-asset.0", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	raw := readRawBody(t, resp)
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Fatalf("body = %s, want exactly [] (never null) with no limit/offset given", raw)
	}
}

func TestAdminHistoryPage_Error(t *testing.T) {
	stub := &stubAdminStore{pageErr: errors.New("boom")}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, stub, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history-page/a.0", nil))
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
}

func TestAdminSummary_IssueRedeemMath(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	seedHistory(t, store, "asset-c.0")
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-summary/asset-c.0", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if got := body["totalIssued"]; got != float64(100) {
		t.Fatalf("totalIssued = %v, want 100", got)
	}
	if got := body["totalRedeemed"]; got != float64(30) {
		t.Fatalf("totalRedeemed = %v, want 30", got)
	}
	if got := body["actionCount"]; got != float64(2) {
		t.Fatalf("actionCount = %v, want 2", got)
	}
}

func TestAdminSummary_Error(t *testing.T) {
	stub := &stubAdminStore{summaryErr: errors.New("boom")}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, stub, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-summary/a.0", nil))
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if _, ok := body["error"]; !ok {
		t.Fatalf("body = %v, want an \"error\" field", body)
	}
}

// TestAdminAssetID_URLEncodedRoundTrip asserts that a percent-encoded '.'
// in the :assetId path segment (as encodeURIComponent may produce, e.g.
// when re-encoding a txid.vout string) resolves to the exact same store
// key as the plain, unencoded form. Fiber's c.Params returns the raw path
// segment; assetIDParam must url.PathUnescape it.
func TestAdminAssetID_URLEncodedRoundTrip(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	const assetID = "ab..ab.0"
	seedHistory(t, store, assetID)
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	plain := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history/ab..ab.0", nil))
	if plain.StatusCode != http.StatusOK {
		t.Fatalf("plain: status = %d, want 200 (body: %s)", plain.StatusCode, readRawBody(t, plain))
	}
	plainBody := readRawBody(t, plain)
	var plainRows []map[string]any
	if err := json.Unmarshal(plainBody, &plainRows); err != nil {
		t.Fatalf("plain unmarshal: %v (body: %s)", err, plainBody)
	}
	if len(plainRows) != 2 {
		t.Fatalf("plain: len(rows) = %d, want 2 (body: %s)", len(plainRows), plainBody)
	}

	encoded := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/admin-history/ab..ab%2E0", nil))
	if encoded.StatusCode != http.StatusOK {
		t.Fatalf("encoded: status = %d, want 200 (body: %s)", encoded.StatusCode, readRawBody(t, encoded))
	}
	encodedBody := readRawBody(t, encoded)
	var encodedRows []map[string]any
	if err := json.Unmarshal(encodedBody, &encodedRows); err != nil {
		t.Fatalf("encoded unmarshal: %v (body: %s)", err, encodedBody)
	}
	if len(encodedRows) != 2 {
		t.Fatalf("encoded (%%2E): len(rows) = %d, want 2 (body: %s)", len(encodedRows), encodedBody)
	}

	if string(plainBody) != string(encodedBody) {
		t.Fatalf("plain and %%2E-encoded assetId paths returned different bodies:\nplain:   %s\nencoded: %s", plainBody, encodedBody)
	}
}

func TestHealth_OK(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil)

	for _, path := range []string{"/health", "/health/live", "/health/ready"} {
		t.Run(path, func(t *testing.T) {
			resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, path, nil))
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
			}
			body := decodeJSON(t, resp)
			if body["status"] != "ok" {
				t.Fatalf("body = %v, want status:ok", body)
			}
		})
	}
}

func TestHealthReady_PingFailureIs503(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, func(context.Context) error {
		return errors.New("mongo down")
	})

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
}

// stubAdminStore is an AdminStore test double for exercising the 500-error
// paths without needing a real Store failure mode.
type stubAdminStore struct {
	stateErr   error
	historyErr error
	pageErr    error
	summaryErr error
}

func (s *stubAdminStore) GetAssetState(context.Context, string) (mandala.AssetAdminState, error) {
	return mandala.AssetAdminState{}, s.stateErr
}

func (s *stubAdminStore) FindAdminHistoryByAssetID(context.Context, string) ([]mandala.AdminHistoryEntry, error) {
	return nil, s.historyErr
}

func (s *stubAdminStore) PageAdminHistory(context.Context, string, int64, int64) ([]mandala.AdminHistoryEntry, error) {
	return nil, s.pageErr
}

func (s *stubAdminStore) AdminSummary(context.Context, string) (int64, int64, int64, error) {
	return 0, 0, 0, s.summaryErr
}

func (s *stubAdminStore) GetTokenRow(context.Context, string, uint32) (*mandala.TokenRow, error) {
	return nil, nil
}

// TestHealthReady_TimeoutBeforeBlockingPing asserts that /health/ready
// wraps the context with an explicit 2-second timeout before calling the
// Pinger. A pinger that blocks indefinitely (or longer than 2s) must not
// hang the handler — it should return 503 quickly.
func TestHealthReady_TimeoutBeforeBlockingPing(t *testing.T) {
	blockingPinger := func(ctx context.Context) error {
		// Simulate a blocking operation by sleeping much longer than the expected timeout
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Second):
			return nil
		}
	}

	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, blockingPinger)

	start := time.Now()
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	elapsed := time.Since(start)

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
	// Assert handler returned promptly (well under 5s wall-clock)
	if elapsed > 5*time.Second {
		t.Fatalf("handler took %v, want < 5s (timeout not working)", elapsed)
	}
}

// TestAdminAssetState_NilStoreReturns500 asserts that a nil AdminStore
// returns 500 with {"error": "store unavailable"} rather than panicking.
func TestAdminAssetState_NilStoreReturns500(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-state/a.0", nil))
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	body := decodeJSON(t, resp)
	if body["error"] != "store unavailable" {
		t.Fatalf("body = %v, want error:store unavailable", body)
	}
}

// --- A10: per-asset admin-auth head + BEEF recovery routes -------------------

// seedAuthChain appends three admin outputs for assetID: two mined (heights
// 10 and 11) and one unmined (height = Number.MAX_SAFE_INTEGER, as the TS
// lookup service records it), inserted out of chain order so the head must
// come from the (height, offset, admitSeq) ordering, not insertion order.
func seedAuthChain(t *testing.T, store *mandala.Store, assetID string) (headOutpoint string) {
	t.Helper()
	ctx := context.Background()
	const maxSafe = int64(9007199254740991)
	entries := []mandala.AdminHistoryEntry{
		{AssetID: assetID, Txid: strings.Repeat("bb", 32), OutputIndex: 1, Height: 11, Offset: 4, ActionDetails: mandala.ActionDetails{"kind": "pause", "assetId": assetID}},
		{AssetID: assetID, Txid: strings.Repeat("cc", 32), OutputIndex: 0, Height: maxSafe, Offset: 0, ActionDetails: mandala.ActionDetails{"kind": "unpause", "assetId": assetID, "priorOutpoint": strings.Repeat("bb", 32) + ".1"}},
		{AssetID: assetID, Txid: strings.Repeat("aa", 32), OutputIndex: 0, Height: 10, Offset: 9, ActionDetails: mandala.ActionDetails{"kind": "register"}},
	}
	for _, e := range entries {
		seq, err := store.NextAdmitSeq(ctx)
		if err != nil {
			t.Fatal(err)
		}
		e.AdmitSeq = seq
		e.CreatedAt = time.Now()
		if err := store.AppendAdminHistory(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	return strings.Repeat("cc", 32) + ".0"
}

func TestAssetAuth_HeadByChainOrderAndURLEncodedAssetID(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	const assetID = "ab..ab.0"
	head := seedAuthChain(t, store, assetID)
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	plain := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-auth/ab..ab.0", nil))
	if plain.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", plain.StatusCode, readRawBody(t, plain))
	}
	plainBody := readRawBody(t, plain)
	var got struct {
		AuthOutpoint string                `json:"authOutpoint"`
		AuthDetails  mandala.ActionDetails `json:"authDetails"`
	}
	if err := json.Unmarshal(plainBody, &got); err != nil {
		t.Fatalf("unmarshal: %v (body: %s)", err, plainBody)
	}
	if got.AuthOutpoint != head {
		t.Fatalf("authOutpoint = %s, want the unmined head %s (body: %s)", got.AuthOutpoint, head, plainBody)
	}
	if got.AuthDetails.Kind() != "unpause" {
		t.Fatalf("authDetails = %+v, want the head's details", got.AuthDetails)
	}
	for _, unwanted := range []string{`"assetId":"ab..ab.0","txid"`, `"admitSeq"`, `"height"`} {
		if strings.Contains(string(plainBody), unwanted) {
			t.Fatalf("body leaks history fields (%s): %s", unwanted, plainBody)
		}
	}

	encoded := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-auth/ab..ab%2E0", nil))
	if encoded.StatusCode != http.StatusOK {
		t.Fatalf("encoded: status = %d (body: %s)", encoded.StatusCode, readRawBody(t, encoded))
	}
	if b := readRawBody(t, encoded); string(b) != string(plainBody) {
		t.Fatalf("plain and %%2E-encoded assetId differ:\nplain:   %s\nencoded: %s", plainBody, b)
	}
}

func TestAssetAuth_NotFoundShape(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-auth/no-such-asset.0", nil))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if body["error"] != "no admin history for this asset" {
		t.Fatalf("body = %v, want {error: no admin history for this asset}", body)
	}
	if _, ok := body["status"]; ok {
		t.Fatalf("body = %v, admin routes use the {error} shape", body)
	}
}

func TestAssetAuth_Error(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{historyErr: errors.New("boom")}, nil)
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-auth/a.0", nil))
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["error"] != "boom" {
		t.Fatalf("body = %v", body)
	}
}

// stubBeef answers OutputBeefBytes from a map keyed "<topic>|<txid>.<vout>".
func stubBeef(have map[string][]byte) OutputBeefFunc {
	return func(_ context.Context, topic, txid string, vout uint32) ([]byte, bool, error) {
		b, ok := have[topic+"|"+txid+"."+strconv.FormatUint(uint64(vout), 10)]
		return b, ok, nil
	}
}

func TestBeefRoutes_ShapesMatchTS(t *testing.T) {
	txid := strings.Repeat("dd", 32)
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithOutputBeef(stubBeef(map[string][]byte{
		"tm_mandala|" + txid + ".2":          {1, 2, 3},
		"tm_mandala_registry|" + txid + ".0": {9, 8},
	})))

	cases := []struct {
		path     string
		status   int
		wantBody string
	}{
		{"/admin/asset-auth/beef/" + txid + "?vout=2", 200, `{"beef":[1,2,3],"outputIndex":2}`},
		{"/admin/asset-auth/beef/" + txid, 404, `{"error":"admin tx not in overlay storage"}`},
		{"/admin/asset-auth/beef/" + txid + "?vout=junk", 404, `{"error":"admin tx not in overlay storage"}`},
		{"/admin/registry/beef/" + txid, 200, `{"beef":[9,8],"outputIndex":0}`},
		{"/admin/registry/beef/" + txid + "?vout=junk", 200, `{"beef":[9,8],"outputIndex":0}`},
		{"/admin/registry/beef/" + txid + "?vout=1", 404, `{"error":"registry tx not in overlay storage"}`},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, c.path, nil))
			body := strings.TrimSpace(string(readRawBody(t, resp)))
			if resp.StatusCode != c.status || body != c.wantBody {
				t.Fatalf("got %d %s, want %d %s", resp.StatusCode, body, c.status, c.wantBody)
			}
		})
	}
}

func TestBeefRoutes_WithoutEngineStoreAre500(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil)
	for _, path := range []string{"/admin/asset-auth/beef/" + strings.Repeat("dd", 32), "/admin/registry/beef/" + strings.Repeat("dd", 32)} {
		resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, path, nil))
		if resp.StatusCode != http.StatusInternalServerError {
			t.Fatalf("%s: status = %d, want 500", path, resp.StatusCode)
		}
		if body := decodeJSON(t, resp); body["error"] != "engine store unavailable" {
			t.Fatalf("%s: body = %v", path, body)
		}
	}
}

// --- A16: hasFrozenRow on /admin/asset-state -----------------------------------

func TestAdminAssetState_HasFrozenRow(t *testing.T) {
	ctx := context.Background()
	store := mustMandalaStore(t, testAdminDB(t))
	const assetID = "frz.0"
	live := strings.Repeat("11", 32) + ".0"
	gone := strings.Repeat("22", 32) + ".1"
	st := mandala.DefaultAssetState(assetID)
	st.FrozenOutpoints = []mandala.FrozenRef{
		{Outpoint: live, Amount: 40, Owner: "02aa"},
		{Outpoint: gone, Amount: 0, Owner: ""},
	}
	if err := store.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}
	if err := store.StoreToken(ctx, mandala.TokenRow{Txid: strings.Repeat("11", 32), OutputIndex: 0, AssetID: assetID, Amount: 40, IdentityKey: "02aa"}); err != nil {
		t.Fatal(err)
	}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/asset-state/"+assetID, nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	raw := readRawBody(t, resp)
	var got struct {
		FrozenOutpoints []struct {
			Outpoint     string `json:"outpoint"`
			HasFrozenRow *bool  `json:"hasFrozenRow"`
		} `json:"frozenOutpoints"`
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v (body: %s)", err, raw)
	}
	if len(got.FrozenOutpoints) != 2 || got.FrozenOutpoints[0].HasFrozenRow == nil || got.FrozenOutpoints[1].HasFrozenRow == nil {
		t.Fatalf("hasFrozenRow must be present on every ref: %s", raw)
	}
	if !*got.FrozenOutpoints[0].HasFrozenRow || *got.FrozenOutpoints[1].HasFrozenRow {
		t.Fatalf("hasFrozenRow: live=%v gone=%v (body: %s)", *got.FrozenOutpoints[0].HasFrozenRow, *got.FrozenOutpoints[1].HasFrozenRow, raw)
	}
}

// ---------------------------------------------------------------------------
// A13 — bearer auth + narrowed CORS on the identity-bearing admin routes.
// Mirrors overlay/src/adminAuth.test.ts's cases so both backends are pinned
// to the same 401 shape and CORS behavior.
// ---------------------------------------------------------------------------

// stubRegistryStore adds ListRegistry to stubAdminStore so /admin/registry
// registers without a live Mongo connection (registerAdminRoutes only mounts
// that route when the store satisfies the ListRegistry interface).
type stubRegistryStore struct {
	stubAdminStore
	rows []mandala.RegistryRow
	err  error
}

func (s *stubRegistryStore) ListRegistry(context.Context) ([]mandala.RegistryRow, error) {
	return s.rows, s.err
}

// noopActivityLinkage is an ActivityLinkage stub that never needs Mongo —
// enough to exercise the auth gate in front of the handler, which never runs
// on a 401.
type noopActivityLinkage struct{}

func (noopActivityLinkage) ListLinkage(context.Context, int64, *time.Time) ([]mandala.LinkageRow, error) {
	return nil, nil
}

func (noopActivityLinkage) FindLinkageByOutpoints(context.Context, []mandala.Outpoint) ([]mandala.LinkageRow, error) {
	return nil, nil
}

func noopFindRawTxs(context.Context, []string) (map[string]string, error) {
	return map[string]string{}, nil
}

func TestAdminAuth_RegistryUnauthenticatedIs401WhenTokenSet(t *testing.T) {
	store := &stubRegistryStore{}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithAdminAPIToken("secret"))

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if len(body) != 1 || body["error"] != "unauthorized" {
		t.Fatalf("body = %v, want exactly {error: unauthorized}", body)
	}
}

func TestAdminAuth_RegistryWrongTokenIs401(t *testing.T) {
	store := &stubRegistryStore{}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithAdminAPIToken("secret"))

	req := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	req.Header.Set("Authorization", "Bearer nope")
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
}

func TestAdminAuth_RegistryCorrectTokenIs200(t *testing.T) {
	store := &stubRegistryStore{rows: []mandala.RegistryRow{{IdentityKey: "02aa", Status: "admitted"}}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithAdminAPIToken("secret"))

	req := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	req.Header.Set("Authorization", "Bearer secret")
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
}

func TestAdminAuth_RegistryOpenWhenTokenUnset(t *testing.T) {
	store := &stubRegistryStore{rows: []mandala.RegistryRow{}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil) // no WithAdminAPIToken: unset -> open

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 when ADMIN_API_TOKEN is unset (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
}

func TestAdminAuth_ActivityUnauthenticatedIs401WhenTokenSet(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithActivity(noopActivityLinkage{}, noopFindRawTxs),
		WithAdminAPIToken("secret"))

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity", nil))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
	body := decodeJSON(t, resp)
	if body["error"] != "unauthorized" {
		t.Fatalf("body = %v, want {error: unauthorized}", body)
	}
}

func TestAdminAuth_ActivityCorrectTokenIs200(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithActivity(noopActivityLinkage{}, noopFindRawTxs),
		WithAdminAPIToken("secret"))

	req := httptest.NewRequest(http.MethodGet, "/admin/activity", nil)
	req.Header.Set("Authorization", "Bearer secret")
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
}

func TestAdminAuth_ActivityOpenWhenTokenUnset(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil,
		WithActivity(noopActivityLinkage{}, noopFindRawTxs))

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/activity", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 when ADMIN_API_TOKEN is unset (body: %s)", resp.StatusCode, readRawBody(t, resp))
	}
}

// TestAdminAuth_PublicRoutesStayOpenEvenWhenTokenSet pins the route split:
// asset-state*, admin-history*, admin-summary*, asset-auth*, registry/beef/*
// are the public audit/recovery surface (R29) and must never require the
// console token, even when one is configured.
func TestAdminAuth_PublicRoutesStayOpenEvenWhenTokenSet(t *testing.T) {
	store := mustMandalaStore(t, testAdminDB(t))
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithAdminAPIToken("secret"))

	for _, path := range []string{
		"/admin/asset-state/unknown-asset.0",
		"/admin/admin-history/unknown-asset.0",
		"/admin/admin-history-page/unknown-asset.0",
		"/admin/admin-summary/unknown-asset.0",
		"/admin/asset-auth/unknown-asset.0",
	} {
		resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, path, nil))
		// asset-auth 404s for an asset with no history — still "public", i.e.
		// never 401 — so accept either 200 or 404, but never 401.
		if resp.StatusCode == http.StatusUnauthorized {
			t.Fatalf("%s: status = 401, want it to stay public even with ADMIN_API_TOKEN set", path)
		}
	}
}

func TestAdminAuth_RegistryBeefStaysOpenEvenWhenTokenSet(t *testing.T) {
	// /admin/registry/beef/:txid must work without a console token (registry
	// recovery, lib/src/registryRecover.ts) even when ADMIN_API_TOKEN is set.
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithAdminAPIToken("secret"))

	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry/beef/"+strings.Repeat("aa", 32), nil))
	if resp.StatusCode == http.StatusUnauthorized {
		t.Fatalf("status = 401, want /admin/registry/beef to stay public even with ADMIN_API_TOKEN set")
	}
}

func TestAdminCORS_GatedRouteEchoesAllowedOriginOnly(t *testing.T) {
	store := &stubRegistryStore{rows: []mandala.RegistryRow{}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil,
		WithAdminCORSOrigins([]string{"https://console.example"}))

	allowed := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	allowed.Header.Set("Origin", "https://console.example")
	resp := doRequest(t, app, allowed)
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://console.example" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the allowed origin echoed back", got)
	}

	disallowed := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	disallowed.Header.Set("Origin", "https://evil.example")
	resp2 := doRequest(t, app, disallowed)
	if got := resp2.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty for a disallowed origin", got)
	}
}

func TestAdminCORS_GatedRouteOptionsPreflightListsAuthorization(t *testing.T) {
	store := &stubRegistryStore{}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil,
		WithAdminCORSOrigins([]string{"https://console.example"}))

	req := httptest.NewRequest(http.MethodOptions, "/admin/registry", nil)
	req.Header.Set("Origin", "https://console.example")
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") {
		t.Fatalf("Access-Control-Allow-Headers = %q, want it to list Authorization", got)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://console.example" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the allowed origin echoed back on preflight", got)
	}
}

// TestAdminCORS_GatedRouteOmitsPrivateNetworkHeader pins that
// Access-Control-Allow-Private-Network — set on every public route's CORS
// (server.go) — is NOT set on the gated routes.
func TestAdminCORS_GatedRouteOmitsPrivateNetworkHeader(t *testing.T) {
	store := &stubRegistryStore{rows: []mandala.RegistryRow{}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil,
		WithAdminCORSOrigins([]string{"https://console.example"}))

	req := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	req.Header.Set("Origin", "https://console.example")
	resp := doRequest(t, app, req)
	if got := resp.Header.Get("Access-Control-Allow-Private-Network"); got != "" {
		t.Fatalf("Access-Control-Allow-Private-Network = %q, want unset on a gated route", got)
	}
}

// TestAdminCORS_PublicRouteKeepsWildcard is a regression guard: the public
// routes must keep exactly their pre-A13 wildcard CORS + Allow-Private-Network,
// unaffected by the gated routes' narrowed CORS living in the same middleware.
func TestAdminCORS_PublicRouteKeepsWildcard(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil,
		WithAdminCORSOrigins([]string{"https://console.example"}))

	req := httptest.NewRequest(http.MethodGet, "/admin/asset-state/a.0", nil)
	req.Header.Set("Origin", "https://evil.example")
	resp := doRequest(t, app, req)
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

func TestParseBearerToken(t *testing.T) {
	if got, ok := ParseBearerToken("Bearer abc123"); !ok || got != "abc123" {
		t.Fatalf("got (%q, %v), want (abc123, true)", got, ok)
	}
	if _, ok := ParseBearerToken(""); ok {
		t.Fatal("empty header: want ok=false")
	}
	if _, ok := ParseBearerToken("Basic abc123"); ok {
		t.Fatal("non-Bearer scheme: want ok=false")
	}
	if _, ok := ParseBearerToken("Bearer "); ok {
		t.Fatal("Bearer with no token: want ok=false")
	}
}

func TestIsAdminAuthorized(t *testing.T) {
	if !IsAdminAuthorized("", "") {
		t.Fatal("unset token: want always authorized")
	}
	if !IsAdminAuthorized("Bearer wrong", "") {
		t.Fatal("unset token: want always authorized regardless of header")
	}
	if IsAdminAuthorized("", "secret") {
		t.Fatal("missing header with a set token: want unauthorized")
	}
	if IsAdminAuthorized("Bearer wrong", "secret") {
		t.Fatal("wrong token: want unauthorized")
	}
	if IsAdminAuthorized("Bearer short", "a-much-longer-secret-token") {
		t.Fatal("different-length token: want unauthorized")
	}
	if !IsAdminAuthorized("Bearer secret", "secret") {
		t.Fatal("exact token: want authorized")
	}
}

func TestParseAdminCORSOrigins(t *testing.T) {
	got := ParseAdminCORSOrigins("https://a.example, https://b.example", "http://localhost:8081")
	want := []string{"https://a.example", "https://b.example"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v, want %v", got, want)
	}

	got2 := ParseAdminCORSOrigins("", "http://localhost:8081/some/path")
	want2 := []string{"http://localhost:8081", "http://127.0.0.1:5173", "http://localhost:5173"}
	if len(got2) != len(want2) {
		t.Fatalf("got %v, want %v", got2, want2)
	}
	for i := range want2 {
		if got2[i] != want2[i] {
			t.Fatalf("got %v, want %v", got2, want2)
		}
	}
}

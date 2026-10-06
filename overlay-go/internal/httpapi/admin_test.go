package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// stubAdminStore is the v3 AdminStore double.
type stubAdminStore struct {
	noTokenReads
	rows  []mandala.KYCRow
	err   error
	calls int
}

func (s *stubAdminStore) ListKYC(context.Context) ([]mandala.KYCRow, error) {
	s.calls++
	return s.rows, s.err
}

var _ AdminStore = (*stubAdminStore)(nil)

// stubBeefWhere answers OutputBeefWhere from a map keyed "<topic>|<txid>.<vout>", trying topics in sorted order as
// enginestore.OutputBeefWhere does.
func stubBeefWhere(have map[string][]byte) OutputBeefWhereFunc {
	return func(_ context.Context, txid string, vout uint32, accept func(string) bool) ([]byte, string, bool, error) {
		keys := make([]string, 0, len(have))
		for k := range have {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		want := txid + "." + strconv.FormatUint(uint64(vout), 10)
		for _, k := range keys {
			topic, op, _ := strings.Cut(k, "|")
			if op == want && accept(topic) {
				return have[k], topic, true, nil
			}
		}
		return nil, "", false, nil
	}
}

func TestRegistry_ListsTheKYCRows(t *testing.T) {
	ta, tb := strings.Repeat("a", 64), strings.Repeat("b", 64)
	store := &stubAdminStore{rows: []mandala.KYCRow{
		{IdentityKey: "02bb", Status: "revoked", Txid: tb, OutputIndex: 0, AdmitSeq: 2},
		{IdentityKey: "02aa", Status: "admitted", Txid: ta, OutputIndex: 1, AdmitSeq: 1},
	}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil)
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	want := `[{"identityKey":"02bb","status":"revoked","txid":"` + tb + `","outputIndex":0,"admitSeq":2},` +
		`{"identityKey":"02aa","status":"admitted","txid":"` + ta + `","outputIndex":1,"admitSeq":1}]`
	if got := strings.TrimSpace(string(readRawBody(t, resp))); got != want {
		t.Fatalf("body = %s\nwant   %s", got, want)
	}
}

func TestRegistry_EmptyIsAnArray(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil)
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil))
	if got := strings.TrimSpace(string(readRawBody(t, resp))); resp.StatusCode != 200 || got != "[]" {
		t.Fatalf("%d %s, want 200 []", resp.StatusCode, got)
	}
}

func TestRegistry_StoreFaultAndNilStoreAre500(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{err: errors.New("boom")}, nil)
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil))
	if body := decodeJSON(t, resp); resp.StatusCode != 500 || body["error"] != "boom" {
		t.Fatalf("store fault: %d %v", resp.StatusCode, body)
	}
	app = newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil)
	resp = doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil))
	if body := decodeJSON(t, resp); resp.StatusCode != 500 || body["error"] != "store unavailable" {
		t.Fatalf("nil store: %d %v", resp.StatusCode, body)
	}
}

// A1.5: /admin/registry/beef reads tm_mandala_kyc only, whatever else holds the outpoint.
func TestRegistryBeef_ServesOnlyTheKYCTopic(t *testing.T) {
	txid := strings.Repeat("dd", 32)
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithOutputBeefWhere(stubBeefWhere(map[string][]byte{
		mandala.KYCTopic + "|" + txid + ".0":     {9, 8},
		mandala.MandalaTopic + "|" + txid + ".0": {7},
		"tm_" + txid + "|" + txid + ".1":         {1, 2},
	})))
	cases := []struct {
		path   string
		status int
		body   string
	}{
		{"/admin/registry/beef/" + txid, 200, `{"beef":[9,8],"outputIndex":0}`},
		{"/admin/registry/beef/" + txid + "?vout=junk", 200, `{"beef":[9,8],"outputIndex":0}`},
		{"/admin/registry/beef/" + txid + "?vout=1", 404, `{"error":"registry tx not in overlay storage"}`},
	}
	for _, c := range cases {
		resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, c.path, nil))
		if got := strings.TrimSpace(string(readRawBody(t, resp))); resp.StatusCode != c.status || got != c.body {
			t.Fatalf("%s: %d %s, want %d %s", c.path, resp.StatusCode, got, c.status, c.body)
		}
	}
}

func TestRegistryBeef_WithoutEngineStoreIs500(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil)
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry/beef/"+strings.Repeat("dd", 32), nil))
	if body := decodeJSON(t, resp); resp.StatusCode != 500 || body["error"] != "engine store unavailable" {
		t.Fatalf("%d %v", resp.StatusCode, body)
	}
}

// The v2 /admin/asset-auth/* routes are gone for good (v3 has /admin/authorities/*, Task 24).
func TestAssetAuthRoutesAreGone(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithOutputBeefWhere(stubBeefWhere(nil)))
	for _, path := range []string{"/admin/asset-auth/" + strings.Repeat("a", 64) + ".0", "/admin/asset-auth/beef/" + strings.Repeat("a", 64)} {
		resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, path, nil))
		if body := decodeJSON(t, resp); resp.StatusCode != 404 || body["code"] != "ERR_ROUTE_NOT_FOUND" {
			t.Fatalf("%s: %d %v", path, resp.StatusCode, body)
		}
	}
}

func TestAdminAuth_RegistryUnauthenticatedIs401WhenTokenSet(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithAdminAPIToken("secret"))
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); len(body) != 1 || body["error"] != "unauthorized" {
		t.Fatalf("body = %v, want exactly {error: unauthorized}", body)
	}
}

func TestAdminAuth_RegistryWrongTokenIs401(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithAdminAPIToken("secret"))
	req := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	req.Header.Set("Authorization", "Bearer nope")
	if resp := doRequest(t, app, req); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestAdminAuth_RegistryCorrectTokenIs200(t *testing.T) {
	store := &stubAdminStore{rows: []mandala.KYCRow{{IdentityKey: "02aa", Status: "admitted"}}}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, store, nil, WithAdminAPIToken("secret"))
	req := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	req.Header.Set("Authorization", "Bearer secret")
	if resp := doRequest(t, app, req); resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func TestAdminAuth_RegistryOpenWhenTokenUnset(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil)
	if resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry", nil)); resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 when ADMIN_API_TOKEN is unset", resp.StatusCode)
	}
}

func TestAdminAuth_RegistryBeefStaysOpenEvenWhenTokenSet(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithAdminAPIToken("secret"), WithOutputBeefWhere(stubBeefWhere(nil)))
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/admin/registry/beef/"+strings.Repeat("aa", 32), nil))
	if resp.StatusCode == http.StatusUnauthorized {
		t.Fatal("/admin/registry/beef must stay public even with ADMIN_API_TOKEN set")
	}
}

func TestAdminCORS_GatedRouteEchoesAllowedOriginOnly(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithAdminCORSOrigins([]string{"https://console.example"}))
	allowed := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	allowed.Header.Set("Origin", "https://console.example")
	if got := doRequest(t, app, allowed).Header.Get("Access-Control-Allow-Origin"); got != "https://console.example" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the allowed origin echoed back", got)
	}
	disallowed := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	disallowed.Header.Set("Origin", "https://evil.example")
	if got := doRequest(t, app, disallowed).Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want empty for a disallowed origin", got)
	}
}

func TestAdminCORS_GatedRouteOptionsPreflightListsAuthorization(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithAdminCORSOrigins([]string{"https://console.example"}))
	req := httptest.NewRequest(http.MethodOptions, "/admin/registry", nil)
	req.Header.Set("Origin", "https://console.example")
	resp := doRequest(t, app, req)
	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") ||
		resp.Header.Get("Access-Control-Allow-Origin") != "https://console.example" {
		t.Fatalf("preflight %d headers %v", resp.StatusCode, resp.Header)
	}
}

func TestAdminCORS_GatedRouteOmitsPrivateNetworkHeader(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil, WithAdminCORSOrigins([]string{"https://console.example"}))
	req := httptest.NewRequest(http.MethodGet, "/admin/registry", nil)
	req.Header.Set("Origin", "https://console.example")
	if got := doRequest(t, app, req).Header.Get("Access-Control-Allow-Private-Network"); got != "" {
		t.Fatalf("Access-Control-Allow-Private-Network = %q, want unset on a gated route", got)
	}
}

func TestAdminCORS_PublicRouteKeepsWildcard(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, &stubAdminStore{}, nil,
		WithAdminCORSOrigins([]string{"https://console.example"}), WithOutputBeefWhere(stubBeefWhere(nil)))
	req := httptest.NewRequest(http.MethodGet, "/admin/registry/beef/"+strings.Repeat("aa", 32), nil)
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
	if !IsAdminAuthorized("", "") || !IsAdminAuthorized("Bearer wrong", "") {
		t.Fatal("unset token: want always authorized")
	}
	if IsAdminAuthorized("", "secret") || IsAdminAuthorized("Bearer wrong", "secret") || IsAdminAuthorized("Bearer short", "a-much-longer-secret-token") {
		t.Fatal("a missing, wrong or different-length token must be unauthorized")
	}
	if !IsAdminAuthorized("Bearer secret", "secret") {
		t.Fatal("exact token: want authorized")
	}
}

func TestParseAdminCORSOrigins(t *testing.T) {
	got := ParseAdminCORSOrigins("https://a.example, https://b.example", "http://localhost:8081")
	if want := []string{"https://a.example", "https://b.example"}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got %v, want %v", got, want)
	}
	got2 := ParseAdminCORSOrigins("", "http://localhost:8081/some/path")
	if want2 := []string{"http://localhost:8081", "http://127.0.0.1:5173", "http://localhost:5173"}; strings.Join(got2, ",") != strings.Join(want2, ",") {
		t.Fatalf("got %v, want %v", got2, want2)
	}
}

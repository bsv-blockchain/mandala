package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

var (
	tokA   = strings.Repeat("a1", 32) + "_0"
	tokB   = strings.Repeat("b2", 32) + "_0"
	tokC   = strings.Repeat("c3", 32) + "_0"
	tokKey = "02" + strings.Repeat("cd", 32)
)

func tokHex(id string) string { return strings.TrimSuffix(id, "_0") }

// noTokenReads gives a stub AdminStore the six token-route reads Task 24 added to AdminStore. Every call fails, so a
// stub that embeds it and is asked for a token route answers 500, never a fabricated 200.
type noTokenReads struct{}

var errNoTokenReads = errors.New("token reads not stubbed")

func (noTokenReads) GetAssetState(context.Context, string) (mandala.AssetAdminState, error) {
	return mandala.AssetAdminState{}, errNoTokenReads
}
func (noTokenReads) GetTokenRow(context.Context, string, uint32) (*mandala.TokenRecord, error) {
	return nil, errNoTokenReads
}
func (noTokenReads) FindAdminHistory(context.Context, string, int64, int64) ([]mandala.AdminHistoryEntry, error) {
	return nil, errNoTokenReads
}
func (noTokenReads) PageAdminHistoryNewestFirst(context.Context, string, int64, int64) ([]mandala.AdminHistoryEntry, error) {
	return nil, errNoTokenReads
}
func (noTokenReads) ListAuthorities(context.Context, string, string) ([]mandala.AuthorityRecord, error) {
	return nil, errNoTokenReads
}
func (noTokenReads) ListRegistryRecords(context.Context, int64, int64) ([]mandala.TokenRegistryRecord, error) {
	return nil, errNoTokenReads
}

// tokStubStore counts every read, fails them all with err (when set) and records the paging arguments.
type tokStubStore struct {
	calls                 atomic.Int32
	err                   error
	pageLimit, pageOffset atomic.Int64
	listLimit, listSkip   atomic.Int64
}

var _ AdminStore = (*tokStubStore)(nil)

func (s *tokStubStore) hit() error {
	s.calls.Add(1)
	return s.err
}

func (s *tokStubStore) ListKYC(context.Context) ([]mandala.KYCRow, error) { return nil, s.hit() }
func (s *tokStubStore) GetAssetState(_ context.Context, id string) (mandala.AssetAdminState, error) {
	return mandala.DefaultAssetState(id, nil), s.hit()
}
func (s *tokStubStore) GetTokenRow(context.Context, string, uint32) (*mandala.TokenRecord, error) {
	return nil, s.hit()
}
func (s *tokStubStore) FindAdminHistory(context.Context, string, int64, int64) ([]mandala.AdminHistoryEntry, error) {
	return nil, s.hit()
}
func (s *tokStubStore) PageAdminHistoryNewestFirst(_ context.Context, _ string, limit, offset int64) ([]mandala.AdminHistoryEntry, error) {
	s.pageLimit.Store(limit)
	s.pageOffset.Store(offset)
	return nil, s.hit()
}
func (s *tokStubStore) ListAuthorities(context.Context, string, string) ([]mandala.AuthorityRecord, error) {
	return nil, s.hit()
}
func (s *tokStubStore) ListRegistryRecords(_ context.Context, limit, skip int64) ([]mandala.TokenRegistryRecord, error) {
	s.listLimit.Store(limit)
	s.listSkip.Store(skip)
	return nil, s.hit()
}

func tokStore(t *testing.T) *mandala.Store {
	t.Helper()
	s, err := mandala.NewStore(testmongo.DB(t, "mandala3_test_tokens"))
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

func tokHosting(ids ...string) TokenHosting {
	set := map[string]bool{}
	for _, id := range ids {
		set[id] = true
	}
	return func(id string) bool { return set[id] }
}

func tokGet(t *testing.T, f *fiber.App, path string, headers map[string]string) (int, http.Header, []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := f.Test(req, -1)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, body
}

func tokRequireJSON(t *testing.T, code int, body []byte, wantStatus int, want string) {
	t.Helper()
	if code != wantStatus || strings.TrimSpace(string(body)) != want {
		t.Fatalf("got %d %s, want %d %s", code, body, wantStatus, want)
	}
}

var tokIDRoutes = []string{"/admin/authorities/%s", "/admin/asset-state/%s", "/admin/admin-history/%s", "/admin/admin-history-page/%s", "/admin/admin-summary/%s"}

func TestTokenRoutesRefuseMalformedIdsBeforeAnyRead(t *testing.T) {
	st := &tokStubStore{}
	f := newServer(nil, nil, st, nil, WithTokenHosting(func(string) bool { return true }))
	bad := []string{tokHex(tokA) + ".0", strings.ToUpper(tokHex(tokA)) + "_0", tokHex(tokA) + "_1", strings.Repeat("a1", 31) + "_0", "beef", "x"}
	for _, route := range tokIDRoutes {
		for _, id := range bad {
			code, _, body := tokGet(t, f, fmt.Sprintf(route, id), nil)
			tokRequireJSON(t, code, body, 400, `{"error":"invalid tokenId"}`)
		}
	}
	if n := st.calls.Load(); n != 0 {
		t.Fatalf("store read %d times for malformed ids", n)
	}
}

func TestTokenRoutesAnswer404ForAnUnhostedToken(t *testing.T) {
	st := &tokStubStore{}
	for _, f := range []*fiber.App{
		newServer(nil, nil, st, nil, WithTokenHosting(tokHosting(tokB))),
		newServer(nil, nil, st, nil), // no hosting: every token reads as not hosted
	} {
		for _, route := range tokIDRoutes {
			code, _, body := tokGet(t, f, fmt.Sprintf(route, tokA), nil)
			tokRequireJSON(t, code, body, 404, `{"error":"token not hosted"}`)
		}
	}
	if n := st.calls.Load(); n != 0 {
		t.Fatalf("store read %d times for an unhosted token", n)
	}
}

func TestTokenRoutesAnswer500OnAStoreFault(t *testing.T) {
	st := &tokStubStore{err: errors.New("mongo down")}
	f := newServer(nil, nil, st, nil, WithTokenHosting(tokHosting(tokA)))
	for _, route := range tokIDRoutes {
		code, _, body := tokGet(t, f, fmt.Sprintf(route, tokA), nil)
		tokRequireJSON(t, code, body, 500, `{"error":"mongo down"}`)
	}
	code, _, body := tokGet(t, f, "/admin/tokens", nil)
	tokRequireJSON(t, code, body, 500, `{"error":"mongo down"}`)
}

type tokListEntry struct {
	TokenID      string `json:"tokenId"`
	DeployTxid   string `json:"deployTxid"`
	Sym          string `json:"sym"`
	Dec          int64  `json:"dec"`
	Label        string `json:"label"`
	Issuer       string `json:"issuer"`
	FeeRatePerKb *int64 `json:"feeRatePerKb"`
	CreatedAt    string `json:"createdAt"`
	Hosted       bool   `json:"hosted"`
}

func TestTokenListIsPublicOrderedAndFlagsHosting(t *testing.T) {
	s := tokStore(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	fee := int64(25)
	for _, r := range []mandala.TokenRegistryRecord{
		{TokenID: tokC, DeployTxid: tokHex(tokC), Sym: "CCC", Dec: 2, Label: "C", Issuer: tokKey, CreatedAt: t0.Add(time.Second)},
		{TokenID: tokB, DeployTxid: tokHex(tokB), Sym: "BBB", Dec: 0, Label: "B", Issuer: tokKey, FeeRatePerKb: &fee, CreatedAt: t0},
		{TokenID: tokA, DeployTxid: tokHex(tokA), Sym: "AAA", Dec: 8, Label: "A", Issuer: tokKey, CreatedAt: t0},
	} {
		if _, err := s.StoreRegistryRecord(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	// A set admin token gates nothing here: /admin/tokens is public (A1.4).
	f := newServer(nil, nil, s, nil, WithTokenHosting(tokHosting(tokA, tokC)), WithAdminAPIToken("console-secret"))
	if adminGatedPath("/admin/tokens") {
		t.Fatal("/admin/tokens must not be a gated path")
	}
	code, hdr, body := tokGet(t, f, "/admin/tokens", map[string]string{"Origin": "https://wallet.example"})
	if code != 200 || hdr.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("GET /admin/tokens: %d, ACAO %q, body %s", code, hdr.Get("Access-Control-Allow-Origin"), body)
	}
	var got []tokListEntry
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	want := []tokListEntry{
		{TokenID: tokA, DeployTxid: tokHex(tokA), Sym: "AAA", Dec: 8, Label: "A", Issuer: tokKey, CreatedAt: "2026-10-05T12:00:00.000Z", Hosted: true},
		{TokenID: tokB, DeployTxid: tokHex(tokB), Sym: "BBB", Dec: 0, Label: "B", Issuer: tokKey, FeeRatePerKb: &fee, CreatedAt: "2026-10-05T12:00:00.000Z", Hosted: false},
		{TokenID: tokC, DeployTxid: tokHex(tokC), Sym: "CCC", Dec: 2, Label: "C", Issuer: tokKey, CreatedAt: "2026-10-05T12:00:01.000Z", Hosted: true},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d entries %s, want 3 (createdAt, then tokenId)", len(got), body)
	}
	for i := range want {
		g, w := got[i], want[i]
		if g.TokenID != w.TokenID || g.DeployTxid != w.DeployTxid || g.Sym != w.Sym || g.Dec != w.Dec || g.Label != w.Label ||
			g.Issuer != w.Issuer || g.CreatedAt != w.CreatedAt || g.Hosted != w.Hosted || (g.FeeRatePerKb == nil) != (w.FeeRatePerKb == nil) ||
			(g.FeeRatePerKb != nil && *g.FeeRatePerKb != *w.FeeRatePerKb) {
			t.Fatalf("entry %d = %+v, want %+v", i, g, w)
		}
	}
	if !strings.Contains(string(body), `"feeRatePerKb":null`) {
		t.Fatalf("an unset fee rate must be JSON null: %s", body)
	}
	code, _, body = tokGet(t, f, "/admin/tokens?limit=1&skip=1", nil)
	if err := json.Unmarshal(body, &got); code != 200 || err != nil || len(got) != 1 || got[0].TokenID != tokB {
		t.Fatalf("?limit=1&skip=1: %d %s", code, body)
	}
	code, _, body = tokGet(t, f, "/admin/tokens?skip=3", nil)
	tokRequireJSON(t, code, body, 200, `[]`)
}

func TestTokenListPagingParameters(t *testing.T) {
	const limitErr = `{"error":"limit must be an integer from 1 to 100"}`
	const skipErr = `{"error":"skip must be an integer from 0 to 100000"}`
	for _, c := range []struct {
		query       string
		status      int
		body        string
		limit, skip int64
	}{
		{"", 200, "[]", 100, 0},
		{"?limit=&skip=", 200, "[]", 100, 0},
		{"?limit=1&skip=0", 200, "[]", 1, 0},
		{"?limit=100&skip=100000", 200, "[]", 100, 100000},
		{"?limit=0", 400, limitErr, 0, 0},
		{"?limit=101", 400, limitErr, 0, 0},
		{"?limit=-1", 400, limitErr, 0, 0},
		{"?limit=1.5", 400, limitErr, 0, 0},
		{"?limit=abc", 400, limitErr, 0, 0},
		{"?skip=-1", 400, skipErr, 0, 0},
		{"?skip=100001", 400, skipErr, 0, 0},
		{"?skip=x", 400, skipErr, 0, 0},
		{"?limit=0&skip=-1", 400, limitErr, 0, 0},
	} {
		st := &tokStubStore{}
		f := newServer(nil, nil, st, nil, WithTokenHosting(tokHosting()))
		code, _, body := tokGet(t, f, "/admin/tokens"+c.query, nil)
		tokRequireJSON(t, code, body, c.status, c.body)
		if c.status != 200 {
			if st.calls.Load() != 0 {
				t.Fatalf("%s: store read on a refused query", c.query)
			}
			continue
		}
		if st.listLimit.Load() != c.limit || st.listSkip.Load() != c.skip {
			t.Fatalf("%s: store got limit %d skip %d, want %d %d", c.query, st.listLimit.Load(), st.listSkip.Load(), c.limit, c.skip)
		}
	}
}

func TestAuthoritiesListsTheTokenTopicSortedByOutpointString(t *testing.T) {
	s := tokStore(t)
	ctx := context.Background()
	topicA, err := mandala.TokenTopic(tokA)
	if err != nil {
		t.Fatal(err)
	}
	tx1 := strings.Repeat("ee", 32)
	for _, r := range []mandala.AuthorityRecord{
		{Txid: tx1, OutputIndex: 2, Topic: topicA, TokenID: tokA, IdentityKey: tokKey},
		{Txid: tx1, OutputIndex: 10, Topic: topicA, TokenID: tokA, IdentityKey: tokKey},
		{Txid: strings.Repeat("0f", 32), OutputIndex: 1, Topic: "tm_" + strings.Repeat("99", 32), TokenID: tokA, IdentityKey: tokKey},
	} {
		if _, err := s.StoreAuthorityIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	f := newServer(nil, nil, s, nil, WithTokenHosting(tokHosting(tokA, tokC)))
	code, _, body := tokGet(t, f, "/admin/authorities/"+tokA, nil)
	// TS sorts the outpoint STRING: ".10" before ".2". A row of the same id under another topic is not this token's.
	want := fmt.Sprintf(`{"tokenId":"%s","authorities":[{"outpoint":"%s.10","identityKey":"%s"},{"outpoint":"%s.2","identityKey":"%s"}]}`, tokA, tx1, tokKey, tx1, tokKey)
	tokRequireJSON(t, code, body, 200, want)
	code, _, body = tokGet(t, f, "/admin/authorities/"+tokC, nil)
	tokRequireJSON(t, code, body, 200, fmt.Sprintf(`{"tokenId":"%s","authorities":[]}`, tokC))
}

func TestAssetStateFlagsFrozenRows(t *testing.T) {
	s := tokStore(t)
	ctx := context.Background()
	withRow := strings.Repeat("dd", 32)
	st := mandala.DefaultAssetState(tokA, nil)
	st.IsPaused = true
	st.FrozenOutpoints = []mandala.FrozenRef{
		{Outpoint: withRow + ".3", Amount: 5, Owner: tokKey},
		{Outpoint: strings.Repeat("de", 32) + ".1", Amount: 7, Owner: tokKey},
	}
	if err := s.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StoreTokenIfAbsent(ctx, mandala.TokenRecord{Txid: withRow, OutputIndex: 3, TokenID: tokA, Amount: 5, IdentityKey: tokKey, CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	f := newServer(nil, nil, s, nil, WithTokenHosting(tokHosting(tokA, tokC)))

	code, _, body := tokGet(t, f, "/admin/asset-state/"+tokA, nil)
	var got struct {
		TokenID         string `json:"tokenId"`
		IsPaused        bool   `json:"isPaused"`
		AccessMode      string `json:"accessMode"`
		FrozenOutpoints []struct {
			Outpoint     string `json:"outpoint"`
			Amount       int64  `json:"amount"`
			Owner        string `json:"owner"`
			HasFrozenRow bool   `json:"hasFrozenRow"`
		} `json:"frozenOutpoints"`
	}
	if err := json.Unmarshal(body, &got); code != 200 || err != nil {
		t.Fatalf("asset-state: %d %s %v", code, body, err)
	}
	if got.TokenID != tokA || !got.IsPaused || got.AccessMode != "denylist" || len(got.FrozenOutpoints) != 2 ||
		!got.FrozenOutpoints[0].HasFrozenRow || got.FrozenOutpoints[1].HasFrozenRow ||
		got.FrozenOutpoints[0].Amount != 5 || got.FrozenOutpoints[1].Owner != tokKey {
		t.Fatalf("asset-state = %+v", got)
	}
	code, _, body = tokGet(t, f, "/admin/asset-state/"+tokC, nil) // hosted, no state yet: the default, not persisted
	if code != 200 || !strings.Contains(string(body), `"frozenOutpoints":[]`) || !strings.Contains(string(body), `"isPaused":false`) {
		t.Fatalf("default state: %d %s", code, body)
	}
}

func TestAdminHistoryRoutesReadTheToken(t *testing.T) {
	s := tokStore(t)
	ctx := context.Background()
	for i, e := range []mandala.AdminHistoryEntry{
		{TokenID: tokA, Txid: strings.Repeat("01", 32), OutputIndex: 0, Kind: "issue", Delta: 500, Height: 10, AdmitSeq: 1},
		{TokenID: tokA, Txid: strings.Repeat("02", 32), OutputIndex: 0, Kind: "redeem", Delta: -200, Height: 11, AdmitSeq: 2},
		{TokenID: tokA, Txid: strings.Repeat("03", 32), OutputIndex: 0, Kind: "pause", Delta: 0, Height: 12, AdmitSeq: 3},
		{TokenID: tokB, Txid: strings.Repeat("04", 32), OutputIndex: 0, Kind: "issue", Delta: 9, Height: 13, AdmitSeq: 4},
	} {
		e.CreatedAt = time.Date(2026, 10, 5, 12, i, 0, 0, time.UTC)
		if _, err := s.AppendAdminHistory(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	f := newServer(nil, nil, s, nil, WithTokenHosting(tokHosting(tokA, tokC)))
	kinds := func(body []byte) []string {
		var rows []struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(body, &rows); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		out := []string{}
		for _, r := range rows {
			out = append(out, r.Kind)
		}
		return out
	}
	if code, _, body := tokGet(t, f, "/admin/admin-history/"+tokA, nil); code != 200 || strings.Join(kinds(body), ",") != "issue,redeem,pause" {
		t.Fatalf("history (fold order): %d %s", code, body)
	}
	if code, _, body := tokGet(t, f, "/admin/admin-history-page/"+tokA+"?limit=2", nil); code != 200 || strings.Join(kinds(body), ",") != "pause,redeem" {
		t.Fatalf("history page (newest first): %d %s", code, body)
	}
	if code, _, body := tokGet(t, f, "/admin/admin-history-page/"+tokA+"?limit=1&offset=1", nil); code != 200 || strings.Join(kinds(body), ",") != "redeem" {
		t.Fatalf("history page offset: %d %s", code, body)
	}
	code, _, body := tokGet(t, f, "/admin/admin-summary/"+tokA, nil)
	tokRequireJSON(t, code, body, 200, `{"totalIssued":500,"totalRedeemed":200,"actionCount":3}`)
	code, _, body = tokGet(t, f, "/admin/admin-history/"+tokC, nil)
	tokRequireJSON(t, code, body, 200, `[]`)
}

func TestAdminHistoryPageClampsLikeTS(t *testing.T) {
	for _, c := range []struct {
		query         string
		limit, offset int64
	}{
		{"", 100, 0}, {"?limit=", 100, 0}, {"?limit=0", 1, 0}, {"?limit=-5", 1, 0}, {"?limit=1.9", 1, 0},
		{"?limit=9999", 500, 0}, {"?limit=abc", 100, 0}, {"?limit=Infinity", 100, 0}, {"?limit=%20", 1, 0},
		{"?limit=1e2", 100, 0}, {"?offset=-3", 100, 0}, {"?offset=2.7", 100, 2}, {"?offset=x", 100, 0},
	} {
		st := &tokStubStore{}
		f := newServer(nil, nil, st, nil, WithTokenHosting(tokHosting(tokA)))
		if code, _, body := tokGet(t, f, "/admin/admin-history-page/"+tokA+c.query, nil); code != 200 {
			t.Fatalf("%s: %d %s", c.query, code, body)
		}
		if st.pageLimit.Load() != c.limit || st.pageOffset.Load() != c.offset {
			t.Fatalf("%s: store got limit %d offset %d, want %d %d", c.query, st.pageLimit.Load(), st.pageOffset.Load(), c.limit, c.offset)
		}
	}
}

func TestSummarizeAdminHistoryDedupesPerOutpoint(t *testing.T) {
	got := summarizeAdminHistory([]mandala.AdminHistoryEntry{
		{Txid: "a", OutputIndex: 1, Kind: "issue", Delta: 500},
		{Txid: "a", OutputIndex: 1, Kind: "issue", Delta: 500},
		{Txid: "b", OutputIndex: 1, Kind: "redeem", Delta: -200},
		{Txid: "c", OutputIndex: 1, Kind: "pause", Delta: 0},
		{Txid: "d", OutputIndex: 1, Kind: "reissue", Delta: 50},
	})
	if got != (adminSummary{TotalIssued: 550, TotalRedeemed: 200, ActionCount: 4}) {
		t.Fatalf("summary = %+v", got)
	}
}

type tokBeefDoc struct {
	topic string
	beef  []byte
}

// tokBeefWhere mimics OutputBeefWhere: the first doc of the outpoint, by topic, whose topic accept approves.
func tokBeefWhere(docs map[string][]tokBeefDoc, fault error) OutputBeefWhereFunc {
	return func(_ context.Context, txid string, vout uint32, accept func(string) bool) ([]byte, string, bool, error) {
		if fault != nil {
			return nil, "", false, fault
		}
		list := append([]tokBeefDoc(nil), docs[fmt.Sprintf("%s.%d", txid, vout)]...)
		sort.Slice(list, func(i, j int) bool { return list[i].topic < list[j].topic })
		for _, d := range list {
			if accept(d.topic) {
				return d.beef, d.topic, true, nil
			}
		}
		return nil, "", false, nil
	}
}

func TestAuthoritiesBeefServesOnlyATokenTopicCopy(t *testing.T) {
	deployTx, regOnly, kycTx := strings.Repeat("aa", 32), strings.Repeat("bb", 32), strings.Repeat("cc", 32)
	docs := map[string][]tokBeefDoc{
		deployTx + ".0": {{mandala.MandalaTopic, []byte{1, 2}}, {"tm_" + deployTx, []byte{3, 4}}},
		regOnly + ".0":  {{mandala.MandalaTopic, []byte{5}}},
		kycTx + ".0":    {{mandala.KYCTopic, []byte{6}}},
	}
	f := newServer(nil, nil, &tokStubStore{}, nil, WithOutputBeefWhere(tokBeefWhere(docs, nil)))
	const notFound = `{"error":"admin tx not in overlay storage"}`

	code, _, body := tokGet(t, f, "/admin/authorities/beef/"+deployTx+"?vout=0", nil)
	tokRequireJSON(t, code, body, 200, `{"beef":[3,4],"outputIndex":0}`)
	code, _, body = tokGet(t, f, "/admin/authorities/beef/"+deployTx+"?vout=zz", nil) // junk vout reads 0
	tokRequireJSON(t, code, body, 200, `{"beef":[3,4],"outputIndex":0}`)
	code, _, body = tokGet(t, f, "/admin/authorities/beef/"+regOnly, nil)
	tokRequireJSON(t, code, body, 404, notFound)
	code, _, body = tokGet(t, f, "/admin/authorities/beef/"+kycTx, nil)
	tokRequireJSON(t, code, body, 404, notFound)

	faulty := newServer(nil, nil, &tokStubStore{}, nil, WithOutputBeefWhere(tokBeefWhere(nil, errors.New("engine down"))))
	code, _, body = tokGet(t, faulty, "/admin/authorities/beef/"+deployTx, nil)
	tokRequireJSON(t, code, body, 500, `{"error":"engine down"}`)
	none := newServer(nil, nil, &tokStubStore{}, nil)
	code, _, body = tokGet(t, none, "/admin/authorities/beef/"+deployTx, nil)
	tokRequireJSON(t, code, body, 500, `{"error":"engine store unavailable"}`)
}

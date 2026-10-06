package httpapi

// v3 token read routes (TT §6.6, A1.4, A1.5, V-5). Wire shapes are TS overlay/src/tokenRoutes.ts: camelCase,
// arrays never null, 500 {"error": …} on a store fault. Every :tokenId route validates the id first (400, before any
// read: an old-format id must never read as "none") and then asks the registrar whether this host follows the token
// (404 token not hosted). All of them are public with wildcard CORS (none is an adminGatedPath).

import (
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// TokenHosting reports whether this host registered the token's topic (App.Tokens.Hosted).
type TokenHosting func(tokenID string) bool

// WithTokenHosting supplies the registrar's view for the :tokenId routes and the /admin/tokens hosted flag.
// Unset (nil), every token reads as not hosted.
func WithTokenHosting(h TokenHosting) ServerOption {
	return func(o *serverOptions) { o.tokenHosting = h }
}

const authorityTxNotFound = "admin tx not in overlay storage"

func registerTokenRoutes(f *fiber.App, store AdminStore, hosting TokenHosting, beefWhere OutputBeefWhereFunc) {
	f.Get("/admin/tokens", tokenListHandler(store, hosting))
	// Before /:tokenId, so the literal "beef" segment is never read as a token id.
	f.Get("/admin/authorities/beef/:txid", authoritiesBeefHandler(beefWhere))
	f.Get("/admin/authorities/:tokenId", hostedToken(store, hosting, authoritiesHandler))
	f.Get("/admin/asset-state/:tokenId", hostedToken(store, hosting, tokenAssetStateHandler))
	f.Get("/admin/admin-history/:tokenId", hostedToken(store, hosting, tokenAdminHistoryHandler))
	f.Get("/admin/admin-history-page/:tokenId", hostedToken(store, hosting, tokenAdminHistoryPageHandler))
	f.Get("/admin/admin-summary/:tokenId", hostedToken(store, hosting, tokenAdminSummaryHandler))
}

func tokenRouteFailure(c *fiber.Ctx, err error) error {
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

// tokenRoute is a :tokenId route body: tokenID is canonical and hosted, store is non-nil.
type tokenRoute func(c *fiber.Ctx, store AdminStore, tokenID string) error

// hostedToken runs the checks every :tokenId route shares, in order: malformed → 400 {"error":"invalid tokenId"};
// not hosted → 404 {"error":"token not hosted"}; then the route.
func hostedToken(store AdminStore, hosting TokenHosting, route tokenRoute) fiber.Handler {
	return func(c *fiber.Ctx) error {
		id, err := url.PathUnescape(c.Params("tokenId"))
		if err != nil || !mandala.IsTokenID(id) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid tokenId"})
		}
		if hosting == nil || !hosting(id) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "token not hosted"})
		}
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		return route(c, store, id)
	}
}

// ---- GET /admin/tokens (A1.4, V-5) ----------------------------------------------------------------------------

type tokenListEntry struct {
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

// tokenListHandler serves the registry list (every token ever deployed, ordered createdAt then tokenId) with a
// hosted flag. It is the only wire for the list: /lookup stays outputs-only (A1.4, G19).
func tokenListHandler(store AdminStore, hosting TokenHosting) fiber.Handler {
	return func(c *fiber.Ctx) error {
		limit, ok := boundedIntParam(c.Query("limit"), 100, 1, 100)
		if !ok {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "limit must be an integer from 1 to 100"})
		}
		skip, ok := boundedIntParam(c.Query("skip"), 0, 0, 100000)
		if !ok {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "skip must be an integer from 0 to 100000"})
		}
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		recs, err := store.ListRegistryRecords(c.UserContext(), limit, skip)
		if err != nil {
			return tokenRouteFailure(c, err)
		}
		out := make([]tokenListEntry, 0, len(recs))
		for _, r := range recs {
			out = append(out, tokenListEntry{
				TokenID: r.TokenID, DeployTxid: r.DeployTxid, Sym: r.Sym, Dec: r.Dec, Label: r.Label, Issuer: r.Issuer,
				FeeRatePerKb: r.FeeRatePerKb, CreatedAt: mandala.IsoStamp(r.CreatedAt), Hosted: hosting != nil && hosting(r.TokenID),
			})
		}
		return c.Status(fiber.StatusOK).JSON(out)
	}
}

// boundedIntParam reads a V-5 paging parameter: blank (absent or "?limit=") is def; otherwise a base-10 integer in
// [min, max], else ok is false.
func boundedIntParam(raw string, def, min, max int64) (int64, bool) {
	if raw == "" {
		return def, true
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < min || n > max {
		return 0, false
	}
	return n, true
}

// ---- GET /admin/authorities/beef/:txid?vout= (A1.5) ------------------------------------------------------------

// authoritiesBeefHandler serves the stored BEEF of an authority output so an issuer whose wallet lost the coin's
// bookkeeping can re-attach it. The route has no token id, so the output is found across topics and served only
// from a tm_<id> copy: a tm_mandala (registry) or tm_mandala_kyc copy is never an authority of a token.
func authoritiesBeefHandler(where OutputBeefWhereFunc) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if where == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "engine store unavailable"})
		}
		vout := uint32(0) // TS Number(vout ?? 0), junk -> 0
		if n, err := strconv.ParseUint(c.Query("vout"), 10, 32); err == nil {
			vout = uint32(n)
		}
		txid, err := url.PathUnescape(c.Params("txid"))
		if err != nil {
			return tokenRouteFailure(c, err)
		}
		beef, _, found, err := where(c.UserContext(), txid, vout, mandala.IsTokenTopic)
		if err != nil {
			return tokenRouteFailure(c, err)
		}
		if !found {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": authorityTxNotFound})
		}
		nums := make([]uint16, len(beef)) // a JSON number array, as TS Array.from(beef); []byte would be base64
		for i, b := range beef {
			nums[i] = uint16(b)
		}
		return c.Status(fiber.StatusOK).JSON(struct {
			Beef        []uint16 `json:"beef"`
			OutputIndex uint32   `json:"outputIndex"`
		}{nums, vout})
	}
}

// ---- GET /admin/authorities/:tokenId ---------------------------------------------------------------------------

type authorityWire struct {
	Outpoint    string `json:"outpoint"`
	IdentityKey string `json:"identityKey"`
}

// authoritiesHandler lists the token's unspent authority coins from its own topic, sorted by the outpoint STRING
// (TS sort: "<txid>.10" before "<txid>.2").
func authoritiesHandler(c *fiber.Ctx, store AdminStore, tokenID string) error {
	topic, err := mandala.TokenTopic(tokenID)
	if err != nil {
		return tokenRouteFailure(c, err)
	}
	rows, err := store.ListAuthorities(c.UserContext(), topic, tokenID)
	if err != nil {
		return tokenRouteFailure(c, err)
	}
	out := make([]authorityWire, 0, len(rows))
	for _, r := range rows {
		out = append(out, authorityWire{Outpoint: r.Txid + "." + strconv.FormatUint(uint64(r.OutputIndex), 10), IdentityKey: r.IdentityKey})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Outpoint < out[j].Outpoint })
	return c.Status(fiber.StatusOK).JSON(struct {
		TokenID     string          `json:"tokenId"`
		Authorities []authorityWire `json:"authorities"`
	}{tokenID, out})
}

// ---- GET /admin/asset-state/:tokenId ---------------------------------------------------------------------------

type frozenRefWire struct {
	mandala.FrozenRef
	HasFrozenRow bool `json:"hasFrozenRow"`
}

// assetStateWire shadows the embedded frozenOutpoints (the shallower field wins in encoding/json).
type assetStateWire struct {
	mandala.AssetAdminState
	FrozenOutpoints []frozenRefWire `json:"frozenOutpoints"`
}

// tokenAssetStateHandler serves the folded state (the default, not persisted, for a token with none) with A16's
// hasFrozenRow per frozen ref: whether the frozen coin still has a live token row, read now.
func tokenAssetStateHandler(c *fiber.Ctx, store AdminStore, tokenID string) error {
	ctx := c.UserContext()
	st, err := store.GetAssetState(ctx, tokenID)
	if err != nil {
		return tokenRouteFailure(c, err)
	}
	frozen := make([]frozenRefWire, 0, len(st.FrozenOutpoints))
	for _, f := range st.FrozenOutpoints {
		has := false
		if txid, vout, ok := splitTokenOutpoint(f.Outpoint); ok {
			row, err := store.GetTokenRow(ctx, txid, vout)
			if err != nil {
				return tokenRouteFailure(c, err)
			}
			has = row != nil
		}
		frozen = append(frozen, frozenRefWire{FrozenRef: f, HasFrozenRow: has})
	}
	return c.Status(fiber.StatusOK).JSON(assetStateWire{AssetAdminState: st, FrozenOutpoints: frozen})
}

// splitTokenOutpoint is TS splitOutpoint (tokenRoutes.ts:33-39): split at the last '.', a non-empty txid, a
// non-negative integer vout.
func splitTokenOutpoint(op string) (string, uint32, bool) {
	dot := strings.LastIndex(op, ".")
	if dot <= 0 {
		return "", 0, false
	}
	n, err := strconv.ParseUint(op[dot+1:], 10, 32)
	if err != nil {
		return "", 0, false
	}
	return op[:dot], uint32(n), true
}

// ---- GET /admin/admin-history/:tokenId, /admin/admin-history-page/:tokenId, /admin/admin-summary/:tokenId ------

func tokenAdminHistoryHandler(c *fiber.Ctx, store AdminStore, tokenID string) error {
	rows, err := store.FindAdminHistory(c.UserContext(), tokenID, 0, 0) // fold order, all rows
	if err != nil {
		return tokenRouteFailure(c, err)
	}
	if rows == nil {
		rows = []mandala.AdminHistoryEntry{}
	}
	return c.Status(fiber.StatusOK).JSON(rows)
}

// tokenAdminHistoryPageHandler pages newest first by admitSeq with TS's clamps (tokenRoutes.ts:100-109).
func tokenAdminHistoryPageHandler(c *fiber.Ctx, store AdminStore, tokenID string) error {
	limit := jsClampedInt(c.Query("limit"), 100, 1, 500)
	offset := jsClampedInt(c.Query("offset"), 0, 0, math.MaxInt64)
	rows, err := store.PageAdminHistoryNewestFirst(c.UserContext(), tokenID, limit, offset)
	if err != nil {
		return tokenRouteFailure(c, err)
	}
	if rows == nil {
		rows = []mandala.AdminHistoryEntry{}
	}
	return c.Status(fiber.StatusOK).JSON(rows)
}

// jsClampedInt is TS `Number(raw === "" ? def : raw ?? def)`, then non-finite -> def, else
// clamp(Math.trunc(n), min, max). An absent or empty raw is def; a whitespace-only raw is JS Number(" ") = 0;
// strconv.ParseFloat stands in for Number ("1.5", "1e2", "Infinity", "NaN"; anything unparseable is NaN -> def).
func jsClampedInt(raw string, def, min, max int64) int64 {
	if raw == "" {
		return def
	}
	f := 0.0
	if s := strings.TrimSpace(raw); s != "" {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return def
		}
		f = v
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return def
	}
	t := math.Trunc(f)
	if t < float64(min) {
		return min
	}
	if t >= float64(max) {
		return max
	}
	return int64(t)
}

type adminSummary struct {
	TotalIssued   int64 `json:"totalIssued"`
	TotalRedeemed int64 `json:"totalRedeemed"`
	ActionCount   int64 `json:"actionCount"`
}

// summarizeAdminHistory is TS summarizeHistory: one row per (txid, outputIndex) (re-admits append duplicates),
// Σ positive delta issued, Σ |negative delta| redeemed, distinct actions counted.
func summarizeAdminHistory(rows []mandala.AdminHistoryEntry) adminSummary {
	seen := make(map[string]bool, len(rows))
	var s adminSummary
	for _, r := range rows {
		key := r.Txid + ":" + strconv.FormatUint(uint64(r.OutputIndex), 10)
		if seen[key] {
			continue
		}
		seen[key] = true
		switch d := int64(r.Delta); {
		case d > 0:
			s.TotalIssued += d
		case d < 0:
			s.TotalRedeemed += -d
		}
	}
	s.ActionCount = int64(len(seen))
	return s
}

func tokenAdminSummaryHandler(c *fiber.Ctx, store AdminStore, tokenID string) error {
	rows, err := store.FindAdminHistory(c.UserContext(), tokenID, 0, 0)
	if err != nil {
		return tokenRouteFailure(c, err)
	}
	return c.Status(fiber.StatusOK).JSON(summarizeAdminHistory(rows))
}

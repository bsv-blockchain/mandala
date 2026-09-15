package httpapi

import (
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// AdminStore is the narrow slice of *mandala.Store the /admin/* GET routes
// depend on (Appendix B §3). *mandala.Store satisfies it; tests substitute
// a stub so they never need Mongo.
type AdminStore interface {
	GetAssetState(ctx context.Context, assetID string) (mandala.AssetAdminState, error)
	GetTokenRow(ctx context.Context, txid string, vout uint32) (*mandala.TokenRow, error)
	FindAdminHistoryByAssetID(ctx context.Context, assetID string) ([]mandala.AdminHistoryEntry, error)
	PageAdminHistory(ctx context.Context, assetID string, limit, offset int64) ([]mandala.AdminHistoryEntry, error)
	AdminSummary(ctx context.Context, assetID string) (totalIssued, totalRedeemed, actionCount int64, err error)
}

var _ AdminStore = (*mandala.Store)(nil)

// OutputBeefFunc serves the BEEF the engine stored for one admitted output
// (enginestore.Store.OutputBeefBytes): (bytes, true) when the topic admitted
// that outpoint, (nil, false) otherwise. Backs the two recovery BEEF routes.
type OutputBeefFunc func(ctx context.Context, topic, txid string, vout uint32) ([]byte, bool, error)

// 404 strings shared with overlay/src/index.ts and overlay/src/assetAuth.ts.
const (
	registryTxNotFound = "registry tx not in overlay storage"
	adminTxNotFound    = "admin tx not in overlay storage"
	assetAuthNotFound  = "no admin history for this asset"
)

// Pinger is the narrow dependency /health/ready needs to prove Mongo
// connectivity. wiring wires this to app.Mongo.Client().Ping; tests inject
// a stub func so they never need a live Mongo connection.
type Pinger func(ctx context.Context) error

// registerAdminRoutes wires the four bespoke admin GET endpoints (Appendix B
// §3a-3d) plus /admin/registry. /admin/activity (Appendix B §3e, Task 17) is
// registered separately via the WithActivity ServerOption (see
// server.go/activity.go) since it depends on the engine's raw-tx store, not
// just AdminStore. adminToken gates only /admin/registry (A13) — every other
// route here is the public audit surface and stays open regardless.
func registerAdminRoutes(f *fiber.App, store AdminStore, beef OutputBeefFunc, adminToken string) {
	f.Get("/admin/asset-state/:assetId", assetStateHandler(store))
	f.Get("/admin/admin-history/:assetId", adminHistoryHandler(store))
	f.Get("/admin/admin-history-page/:assetId", adminHistoryPageHandler(store))
	f.Get("/admin/admin-summary/:assetId", adminSummaryHandler(store))
	// The BEEF routes are registered before the :assetId route so the literal
	// "beef" segment can never be read as an asset id.
	f.Get("/admin/asset-auth/beef/:txid", beefHandler(beef, "tm_mandala", adminTxNotFound))
	f.Get("/admin/asset-auth/:assetId", assetAuthHandler(store))
	f.Get("/admin/registry/beef/:txid", beefHandler(beef, mandala.RegistryTopic, registryTxNotFound))
	if r, ok := store.(interface {
		ListRegistry(ctx context.Context) ([]mandala.RegistryRow, error)
	}); ok {
		f.Get("/admin/registry", AdminAuthMiddleware(adminToken), func(c *fiber.Ctx) error {
			rows, err := r.ListRegistry(c.UserContext())
			if err != nil {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
			}
			return c.JSON(rows)
		})
	}
}

// registerAdmissionRoute wires GET /admin/admission/:txid (wire contract §3,
// A12) — the endpoint a wallet asks "did this transaction actually get
// admitted, and under what signature?" It is gated exactly like
// /admin/registry (A13: bearer token + narrowed CORS via adminGatedPath),
// because the answer names identities' coins. Registered unconditionally so
// the route exists (and 404s honestly) even before a store is wired.
func registerAdmissionRoute(f *fiber.App, rec AdmissionRecorder, proof AppliedAdmissionProof, signer AdmissionSigner, adminToken string) {
	f.Get("/admin/admission/:txid", AdminAuthMiddleware(adminToken), admissionHandler(rec, proof, signer))
}

// txid64Hex matches the only txid shape this API accepts: exactly 64
// lowercase hex characters, after the caller's value has been lowercased.
var txid64Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// admissionHandler serves the five shapes of wire contract §3 as amended by
// §9.3:
//
//	200 {txid, outputsToAdmit, admissionSignature, admissionIdentityKey, at}
//	410 {status:"error", code:"ERR_EVICTED",   retryable:false, description}
//	400 {status:"error", code:<final code>,    retryable:false, description}   (persisted refusal, payloadHash matched)
//	400 {status:"error", code:"ERR_SHAPE",     retryable:false, description}   (malformed txid)
//	404 {status:"error", message:"no admission on record for <txid>"}
//
// The 404 body keeps the TS overlay's existing wording verbatim. FIX C
// applies here too: with no record but an engine applied-transaction proof,
// the admission is re-derived and re-signed rather than reported missing —
// but an EMPTY admitted set is never a 200 (§9.3), because an empty set is
// not something σ_I can speak for.
//
// A persisted refusal is served only to a caller that names the payload it was
// earned with (?payloadHash=, §9.1/§9.3). Without a matching hash the refusal
// is not this caller's answer and the route falls through as if it were not
// there — the same rule /submit applies, so the two endpoints can never
// disagree about whether a transaction is refused.
func admissionHandler(rec AdmissionRecorder, proof AppliedAdmissionProof, signer AdmissionSigner) fiber.Handler {
	return func(c *fiber.Ctx) error {
		raw, err := url.PathUnescape(c.Params("txid"))
		if err != nil {
			return adminErrorResponse(c, err)
		}
		// Txids are case-insensitive hex on the wire but lowercase everywhere
		// in this system (the digest, the record key, the engine store), so
		// normalise before anything is looked up or echoed back.
		txid := strings.ToLower(raw)
		if !txid64Hex.MatchString(txid) {
			return verdictResponse(c, verdictShape,
				"invalid txid: expected 64 hex characters, got "+strconv.Itoa(len(raw)), "")
		}
		payloadHash := strings.ToLower(c.Query("payloadHash"))
		ctx := c.UserContext()
		if rec != nil {
			record, err := rec.GetAdmission(ctx, txid)
			if err != nil {
				return verdictResponse(c, verdictUnavailable, "admission record lookup failed: "+err.Error(), "")
			}
			switch {
			case record == nil:
				// fall through to the applied-store proof
			case record.EvictedAt != "":
				return verdictResponse(c, verdictEvicted, evictedDescription(txid), "")
			case record.RefusedCode != "" && record.RefusedPayloadHash == payloadHash:
				return verdictResponse(c,
					Verdict{Code: record.RefusedCode, HTTP: fiber.StatusBadRequest, Retryable: false, Final: true},
					record.RefusedDescription, record.RefusedSpendTxid)
			case record.Admitted():
				return admissionJSON(c, txid, record.OutputsToAdmit, record.AdmissionSignature, record.AdmissionIdentityKey, record.At, signer)
			}
		}
		if proof != nil {
			applied, outputs, err := proof(ctx, txid)
			if err != nil {
				return verdictResponse(c, verdictUnavailable, "applied-transaction lookup failed: "+err.Error(), "")
			}
			if applied && len(canonicalOutputs(outputs)) > 0 {
				return admissionJSON(c, txid, outputs, "", "", "", signer)
			}
		}
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"status":  "error",
			"message": "no admission on record for " + txid,
		})
	}
}

// admissionJSON writes the 200 shape, re-signing when the stored record
// carries no signature (or none was stored at all, the FIX C re-derivation
// case). RFC6979 determinism makes the re-signed value identical to the one
// /submit returned.
func admissionJSON(c *fiber.Ctx, txid string, outputs []uint32, sig, ident, at string, signer AdmissionSigner) error {
	canonical := canonicalOutputs(outputs)
	if sig == "" || ident == "" {
		sig, ident = signAdmission(signer, txid, nil, canonical)
	}
	if at == "" {
		at = mandala.IsoStamp(time.Now())
	}
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"txid":                 txid,
		"outputsToAdmit":       nonNilUint32(canonical),
		"admissionSignature":   sig,
		"admissionIdentityKey": ident,
		"at":                   at,
	})
}

// assetAuthHandler implements GET /admin/asset-auth/:assetId (A10): the
// chain head of the asset's admin outputs as {authOutpoint, authDetails},
// so an issuer whose wallet lost the auth output's bookkeeping can re-attach
// it. 404 {error} when the overlay holds no admin history for the asset.
func assetAuthHandler(store AdminStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		assetID, err := assetIDParam(c)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		rows, err := store.FindAdminHistoryByAssetID(c.UserContext(), assetID)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		head, ok := mandala.PickAssetAuthHead(rows)
		if !ok {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": assetAuthNotFound})
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"authOutpoint": head.Txid + "." + strconv.FormatUint(uint64(head.OutputIndex), 10),
			"authDetails":  head.ActionDetails,
		})
	}
}

// beefHandler implements GET /admin/{registry,asset-auth}/beef/:txid?vout=
// with the TS shapes (overlay/src/index.ts, assetAuth.ts): 200
// {beef: number[], outputIndex}, 404 {error: notFound}. `vout` is read as
// Number(vout ?? 0): absent or unparseable means 0.
func beefHandler(beef OutputBeefFunc, topic, notFound string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if beef == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "engine store unavailable"})
		}
		vout := uint32(0)
		if n, err := strconv.ParseUint(c.Query("vout"), 10, 32); err == nil {
			vout = uint32(n)
		}
		txid, err := url.PathUnescape(c.Params("txid"))
		if err != nil {
			return adminErrorResponse(c, err)
		}
		bytes, ok, err := beef(c.UserContext(), topic, txid, vout)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		if !ok {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": notFound})
		}
		// []byte would marshal as base64; the TS route serves a JSON array of
		// numbers (Array.from(out.beef)).
		nums := make([]uint16, len(bytes))
		for i, b := range bytes {
			nums[i] = uint16(b)
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"beef": nums, "outputIndex": vout})
	}
}

// registerHealthRoutes wires /health, /health/live (always ok — the process
// is up) and /health/ready (pings Mongo; 503 on failure). This is a
// simplified stand-in for OverlayExpress's full health-report machinery —
// the frontend never calls these routes (Appendix B §3 lists only the 5
// bespoke admin/lookup/submit calls), so the minimal {"status":...} shape
// the task calls for is all that's needed here.
func registerHealthRoutes(f *fiber.App, ping Pinger) {
	f.Get("/health", healthOKHandler)
	f.Get("/health/live", healthOKHandler)
	f.Get("/health/ready", healthReadyHandler(ping))
}

func healthOKHandler(c *fiber.Ctx) error {
	return c.Status(fiber.StatusOK).JSON(fiber.Map{"status": "ok"})
}

func healthReadyHandler(ping Pinger) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if ping != nil {
			ctx, cancel := context.WithTimeout(c.UserContext(), 2*time.Second)
			defer cancel()
			if err := ping(ctx); err != nil {
				return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"status": "error"})
			}
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"status": "ok"})
	}
}

// assetIDParam extracts and URL-decodes the :assetId path segment. Fiber's
// c.Params returns the RAW path segment (no automatic percent-decoding);
// assetIds are txid.vout pairs containing a literal '.' that
// encodeURIComponent may or may not have escaped (e.g. "ab..ab%2E0" for
// "ab..ab.0"), so both the plain and percent-encoded forms must resolve to
// the same store key.
func assetIDParam(c *fiber.Ctx) (string, error) {
	return url.PathUnescape(c.Params("assetId"))
}

// adminErrorResponse mirrors overlay/src/index.ts's 500 {"error": String(e)}
// shape used by every /admin/* GET route — deliberately different from
// /submit and /lookup's 400 {"status","message"} shape (Appendix B §3).
func adminErrorResponse(c *fiber.Ctx, err error) error {
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

func assetStateHandler(store AdminStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		assetID, err := assetIDParam(c)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		state, err := store.GetAssetState(c.UserContext(), assetID)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		// Each frozen ref carries hasFrozenRow (A16): whether the frozen coin
		// still has a token row, i.e. whether a reissue of it can succeed.
		state, err = mandala.AnnotateFrozenRows(c.UserContext(), state, store)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		return c.Status(fiber.StatusOK).JSON(state)
	}
}

func adminHistoryHandler(store AdminStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		assetID, err := assetIDParam(c)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		rows, err := store.FindAdminHistoryByAssetID(c.UserContext(), assetID)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		return c.Status(fiber.StatusOK).JSON(nonNilHistory(rows))
	}
}

// adminHistoryPageHandler implements Appendix B §3c. Query params are
// parsed here and handed to the store un-clamped (aside from the
// missing/unparseable -> 0 fallback, which the store's own clamp already
// maps to its 100 default) — Store.PageAdminHistory owns the [1,500] limit
// clamp and the >=0 offset clamp (overlay-go/internal/mandala/storage.go),
// so this handler does not duplicate that logic.
func adminHistoryPageHandler(store AdminStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		assetID, err := assetIDParam(c)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		limit := queryInt64(c, "limit")
		offset := queryInt64(c, "offset")
		rows, err := store.PageAdminHistory(c.UserContext(), assetID, limit, offset)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		return c.Status(fiber.StatusOK).JSON(nonNilHistory(rows))
	}
}

func adminSummaryHandler(store AdminStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		assetID, err := assetIDParam(c)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		issued, redeemed, count, err := store.AdminSummary(c.UserContext(), assetID)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"totalIssued":   issued,
			"totalRedeemed": redeemed,
			"actionCount":   count,
		})
	}
}

// nonNilHistory normalizes a nil history slice to an empty one — the wire
// contract requires JSON `[]`, never `null` (Appendix B §3b/§3c).
func nonNilHistory(rows []mandala.AdminHistoryEntry) []mandala.AdminHistoryEntry {
	if rows == nil {
		return []mandala.AdminHistoryEntry{}
	}
	return rows
}

// queryInt64 parses an integer query param, returning 0 (the store's
// "use the default" sentinel) when absent or unparseable — matching the TS
// route's `Number(req.query.limit ?? 100) || 100` behavior for the missing
// and NaN cases.
func queryInt64(c *fiber.Ctx, key string) int64 {
	raw := c.Query(key)
	if raw == "" {
		return 0
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

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

// AdminStore is the slice of *mandala.Store the admin GET routes read. Task 24 adds the token-route reads.
type AdminStore interface {
	ListKYC(ctx context.Context) ([]mandala.KYCRow, error)
}

var _ AdminStore = (*mandala.Store)(nil)

// OutputBeefWhereFunc serves the stored BEEF of one output from the first topic (sorted) accept() approves, spent or
// not (enginestore.Store.OutputBeefWhere).
type OutputBeefWhereFunc func(ctx context.Context, txid string, vout uint32, accept func(topic string) bool) ([]byte, string, bool, error)

// registryTxNotFound is shared with overlay/src/index.ts.
const registryTxNotFound = "registry tx not in overlay storage"

// registerAdminRoutes wires the KYC registry routes (A1.5: same URLs, tm_mandala_kyc). /admin/registry is gated;
// its BEEF recovery route is public.
func registerAdminRoutes(f *fiber.App, store AdminStore, beefWhere OutputBeefWhereFunc, adminToken string) {
	f.Get("/admin/registry/beef/:txid", beefWhereHandler(beefWhere, isKYCTopic, registryTxNotFound))
	f.Get("/admin/registry", AdminAuthMiddleware(adminToken), registryHandler(store))
}

func isKYCTopic(topic string) bool { return topic == mandala.KYCTopic }

// registryHandler lists the KYC identity rows, newest action first (mandala.Store.ListKYC).
func registryHandler(store AdminStore) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if store == nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "store unavailable"})
		}
		rows, err := store.ListKYC(c.UserContext())
		if err != nil {
			return adminErrorResponse(c, err)
		}
		if rows == nil {
			rows = []mandala.KYCRow{}
		}
		return c.Status(fiber.StatusOK).JSON(rows)
	}
}

// registerAdmissionRoute wires GET /admin/admission/:txid, gated like /admin/registry (bearer + narrowed CORS).
func registerAdmissionRoute(f *fiber.App, rec AdmissionRecorder, proof AppliedAdmissionProof, signer mandala.AdmissionSigner, adminToken string) {
	f.Get("/admin/admission/:txid", AdminAuthMiddleware(adminToken), admissionHandler(rec, proof, signer))
}

// txid64Hex matches the only txid shape this API accepts, after lowercasing.
var txid64Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// admissionHandler serves the per-topic admission (A1.2):
//
//	200 {txid, admissions: {<topic>: {outputsToAdmit, admissionSignature}}, admissionIdentityKey, at}
//	410 ERR_EVICTED; 400 a persisted refusal whose payloadHash matches ?payloadHash=; 400 ERR_SHAPE malformed txid;
//	404 {status:"error", message:"no admission on record for <txid>"}
//
// With no admitted record, the engine's applied proof is re-signed per σ-topic with ≥ 1 output; an empty set is never
// a 200, and KYC is never signed.
func admissionHandler(rec AdmissionRecorder, proof AppliedAdmissionProof, signer mandala.AdmissionSigner) fiber.Handler {
	return func(c *fiber.Ctx) error {
		raw, err := url.PathUnescape(c.Params("txid"))
		if err != nil {
			return adminErrorResponse(c, err)
		}
		txid := strings.ToLower(raw)
		if !txid64Hex.MatchString(txid) {
			return verdictResponse(c, verdictShape, "invalid txid: expected 64 hex characters, got "+strconv.Itoa(len(raw)), "")
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
			case record.EvictedAt != "":
				return verdictResponse(c, verdictEvicted, evictedDescription(txid), "")
			case record.RefusedCode != "" && record.RefusedPayloadHash == payloadHash:
				return verdictResponse(c,
					Verdict{Code: record.RefusedCode, HTTP: fiber.StatusBadRequest, Retryable: false, Final: true},
					record.RefusedDescription, record.RefusedSpendTxid)
			case record.Admitted():
				return admissionMapJSON(c, txid, record.Admissions, record.AdmissionIdentityKey, record.At, signer)
			}
		}
		if proof != nil {
			applied, err := proof(ctx, txid)
			if err != nil {
				return verdictResponse(c, verdictUnavailable, "applied-transaction lookup failed: "+err.Error(), "")
			}
			adm := map[string]mandala.TopicAdmission{}
			for topic, outs := range applied {
				if canonical := mandala.CanonicalOutputs(outs); mandala.IsSigmaTopic(topic) && len(canonical) > 0 {
					adm[topic] = mandala.TopicAdmission{OutputsToAdmit: canonical}
				}
			}
			if len(adm) > 0 {
				return admissionMapJSON(c, txid, adm, "", "", signer)
			}
		}
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"status": "error", "message": "no admission on record for " + txid})
	}
}

// admissionMapJSON writes the 200 shape. A stored σI is served as stored when the record also holds the identity key;
// otherwise the entry is re-signed (RFC6979: the same bytes /submit returned).
func admissionMapJSON(c *fiber.Ctx, txid string, adm map[string]mandala.TopicAdmission, ident, at string, signer mandala.AdmissionSigner) error {
	stored := ident != ""
	out := make(map[string]fiber.Map, len(adm))
	for topic, a := range adm {
		outs := mandala.CanonicalOutputs(a.OutputsToAdmit)
		sig := a.AdmissionSignature
		if sig == "" || !stored {
			s, key := signAdmission(signer, topic, txid, outs)
			sig = s
			if key != "" {
				ident = key
			}
		}
		out[topic] = fiber.Map{"outputsToAdmit": nonNilUint32(outs), "admissionSignature": sig}
	}
	if at == "" {
		at = mandala.IsoStamp(time.Now())
	}
	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"txid":                 txid,
		"admissions":           out,
		"admissionIdentityKey": ident,
		"at":                   at,
	})
}

// beefWhereHandler serves GET …/beef/:txid?vout= as 200 {beef: number[], outputIndex} from the first topic accept()
// approves, else 404 {"error": notFound}. vout reads Number(vout ?? 0): absent or unparseable means 0.
func beefWhereHandler(where OutputBeefWhereFunc, accept func(topic string) bool, notFound string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if where == nil {
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
		beef, _, ok, err := where(c.UserContext(), txid, vout, accept)
		if err != nil {
			return adminErrorResponse(c, err)
		}
		if !ok {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": notFound})
		}
		nums := make([]uint16, len(beef)) // []byte would marshal as base64; TS serves Array.from(beef)
		for i, b := range beef {
			nums[i] = uint16(b)
		}
		return c.Status(fiber.StatusOK).JSON(fiber.Map{"beef": nums, "outputIndex": vout})
	}
}

// adminErrorResponse mirrors overlay/src/index.ts's 500 {"error": String(e)}.
func adminErrorResponse(c *fiber.Ctx, err error) error {
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

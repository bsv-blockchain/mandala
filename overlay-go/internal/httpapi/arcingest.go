package httpapi

import (
	"context"
	"crypto/subtle"
	"log"
	"strings"
	"unicode/utf16"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/arcade"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// MerkleProofHandler is the narrow slice of *engine.Engine that POST
// /arc-ingest depends on for proof ingestion (engine.HandleNewMerkleProof
// per overlay-go/README.md "Pinned API notes"). *engine.Engine satisfies
// it; tests substitute a stub so they never need Mongo or a real engine.
type MerkleProofHandler interface {
	HandleNewMerkleProof(ctx context.Context, txid *chainhash.Hash, proof *transaction.MerklePath) error
}

var _ MerkleProofHandler = (*engine.Engine)(nil)

// EvictionOutcome is the /arc-ingest terminal-status report (wire contract
// §9.12); it is declared in the domain package because wiring, which produces
// it, cannot import this one.
type EvictionOutcome = mandala.EvictionOutcome

// EvictTx removes an applied transaction from the overlay on a terminal
// Arcade txStatus — the Go stand-in for the TS /arc-ingest route's
// Engine.evictAppliedTransaction (which deletes the tx's outputs and
// notifies each lookup service via OutputEvicted). go-overlay-services
// v1.3.7's engine exposes no eviction API, so wiring.Build assembles the
// equivalent from the concrete enginestore + ls_mandala and threads it here.
type EvictTx func(ctx context.Context, txid string) (EvictionOutcome, error)

// registerArcIngestRoutes wires POST /arc-ingest (OverlayExpress.ts
// ~1578-1653) — the Arcade broadcast-status/proof callback. Callers
// register this only when Arcade is configured (see WithArcade); a
// non-empty callbackToken gates every request behind
// "Authorization: Bearer <token>" or "x-callback-token: <token>".
func registerArcIngestRoutes(f *fiber.App, h MerkleProofHandler, callbackToken string, evict EvictTx) {
	f.Post("/arc-ingest", arcIngestHandler(h, callbackToken, evict))
}

// arcIngestBody mirrors the JSON body Arcade posts to /arc-ingest
// (OverlayExpress.ts destructures txid, merklePath, blockHeight, txStatus,
// extraInfo from req.body).
type arcIngestBody struct {
	Txid        string `json:"txid"`
	MerklePath  string `json:"merklePath"`
	BlockHeight *int64 `json:"blockHeight"`
	TxStatus    string `json:"txStatus"`
	ExtraInfo   string `json:"extraInfo"`
}

// arcIngestHandler implements OverlayExpress.ts's /arc-ingest route: token
// check, then classify by txStatus/merklePath presence. As on the TS overlay's
// route (overlay/src/eviction.ts), the txid is lowercased and refused 400
// unless it is 64 hex characters, and the terminal reason is
// "<txStatus> <extraInfo>" trimmed and bounded to 256 UTF-16 units, so the
// §9.12 body is the same on both engines.
//
// A terminal txStatus evicts the applied transaction via evict (mirroring
// the TS route's Engine.evictAppliedTransaction — a real @bsv/overlay
// method that deletes the tx's outputs and notifies lookup services'
// OutputEvicted; the Go engine has no such API, so the equivalent is
// assembled in wiring.Build). Eviction success is logged and acknowledged
// with 200; an eviction error answers 500 so Arcade retries the callback.
// With a nil evict (eviction not wired) the terminal status is log-only,
// acknowledged 200 to stop Arcade retrying.
func arcIngestHandler(h MerkleProofHandler, callbackToken string, evict EvictTx) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if callbackToken != "" && !hasValidCallbackToken(c, callbackToken) {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
				"status":  "error",
				"message": "Unauthorized callback",
			})
		}

		var body arcIngestBody
		if err := c.BodyParser(&body); err != nil {
			return errorResponse(c, fiber.StatusBadRequest, "invalid request body: "+err.Error())
		}
		if body.Txid == "" {
			return errorResponse(c, fiber.StatusBadRequest, "Provider callback is missing txid")
		}
		// As on TS (overlay/src/eviction.ts): lowercased, then refused unless
		// it is 64 hex characters, before any store is touched — the record
		// is keyed by the lowercase txid, and a stamp for a txid that is no tx
		// would otherwise be written before anything noticed.
		body.Txid = strings.ToLower(body.Txid)
		if !isTxidHex(body.Txid) {
			return errorResponse(c, fiber.StatusBadRequest, "Provider callback txid must be 64 hex characters")
		}

		if arcade.IsTerminalStatus(body.TxStatus, body.ExtraInfo) {
			reason := evictionReason(body.TxStatus, body.ExtraInfo)
			var outcome EvictionOutcome
			var err error
			if evict == nil {
				log.Printf("arc-ingest: terminal status %q for txid %s (eviction not wired — state left in place)", body.TxStatus, body.Txid)
			} else if outcome, err = evict(c.UserContext(), body.Txid); err != nil {
				// Wire contract §9.8: the restore is the whole point of the
				// eviction, and it runs BEFORE evictedAt is stamped. A failure
				// here means nothing was stamped and the inputs are still
				// marked spent, so this is a retryable dependency fault (503)
				// — Arcade re-delivers and the unwind is attempted again. A
				// 4xx/5xx-final answer would have Arcade give up on a callback
				// that must not be lost.
				log.Printf("arc-ingest: eviction for terminal status %q txid %s failed (nothing stamped, inputs still spent): %v", body.TxStatus, body.Txid, err)
				return errorResponse(c, fiber.StatusServiceUnavailable, "failed to evict transaction: "+err.Error())
			} else {
				log.Printf("arc-ingest: terminal status %q for txid %s — applied transaction evicted (outpoints=%d tokenRows=%d alreadyEvicted=%v)",
					body.TxStatus, body.Txid, outcome.RestoredOutpoints, outcome.RestoredTokenRows, outcome.AlreadyEvicted)
			}
			// Wire contract §9.12 — the terminal-status body, identical on
			// both engines.
			return c.Status(fiber.StatusOK).JSON(fiber.Map{
				"status":  "success",
				"message": "Terminal transaction status processed",
				"data": fiber.Map{
					"txid":              body.Txid,
					"txStatus":          body.TxStatus,
					"reason":            reason,
					"restoredOutpoints": outcome.RestoredOutpoints,
					"restoredTokenRows": outcome.RestoredTokenRows,
					"alreadyEvicted":    outcome.AlreadyEvicted,
				},
			})
		}

		if body.MerklePath == "" {
			return c.Status(fiber.StatusAccepted).JSON(fiber.Map{
				"status":  "success",
				"message": "Transaction status received without proof",
			})
		}

		txid, err := chainhash.NewHashFromHex(body.Txid)
		if err != nil {
			return errorResponse(c, fiber.StatusBadRequest, "invalid txid: "+err.Error())
		}
		proof, err := transaction.NewMerklePathFromHex(body.MerklePath)
		if err != nil {
			return errorResponse(c, fiber.StatusBadRequest, "invalid merklePath: "+err.Error())
		}
		if err := h.HandleNewMerkleProof(c.UserContext(), txid, proof); err != nil {
			return errorResponse(c, fiber.StatusBadRequest, err.Error())
		}

		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"status":  "success",
			"message": "Transaction status updated",
		})
	}
}

// isTxidHex reports whether s is exactly 64 lowercase hex characters.
func isTxidHex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// maxReasonUnits is the TS route's bound on the eviction reason: 256 UTF-16
// code units (at most 768 UTF-8 bytes, under the TS engine's 1024-byte cap).
const maxReasonUnits = 256

// evictionReason is the terminal-status reason exactly as the TS route (and
// upstream overlay-express) builds it — "<txStatus> <extraInfo>", trimmed —
// then cut to maxReasonUnits UTF-16 code units, so the §9.12 body is the same
// on both engines. One unavoidable edge: where the cut splits a surrogate
// pair, TS keeps the lone high surrogate and Go (whose strings are UTF-8)
// drops it.
func evictionReason(txStatus, extraInfo string) string {
	reason := strings.TrimSpace(txStatus + " " + extraInfo)
	units := utf16.Encode([]rune(reason))
	if len(units) <= maxReasonUnits {
		return reason
	}
	units = units[:maxReasonUnits]
	if last := units[len(units)-1]; last >= 0xd800 && last < 0xdc00 {
		// a high surrogate whose low half was cut off
		units = units[:len(units)-1]
	}
	return string(utf16.Decode(units))
}

// hasValidCallbackToken checks the Authorization: Bearer <token> and
// x-callback-token: <token> header forms Arcade may present (either one
// matching is sufficient), mirroring OverlayExpress.ts's /arc-ingest token
// check. Comparisons are constant-time so a mistimed guess can't leak how
// many leading bytes of the configured token it got right.
func hasValidCallbackToken(c *fiber.Ctx, token string) bool {
	auth := c.Get(fiber.HeaderAuthorization)
	bearer := strings.TrimPrefix(auth, "Bearer ")
	if constantTimeEqual(bearer, token) {
		return true
	}
	return constantTimeEqual(c.Get("x-callback-token"), token)
}

// constantTimeEqual reports whether a and b are equal without leaking
// timing information about a mismatch's position (subtle.ConstantTimeCompare
// requires equal-length inputs, so the length check is a fast, non-secret
// gate before the constant-time byte comparison).
func constantTimeEqual(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

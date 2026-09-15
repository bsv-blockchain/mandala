package httpapi

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// FIX D — the structural, persisted verdict taxonomy for POST /submit and
// GET /admin/admission/:txid (wire contract §2). Both engines answer with
//
//	{ status:"error", code, retryable, description, spendTxid? }
//
// and mint a 400/409 code ONLY from a topic manager's own reject(...) reason.
// Anything else — SPV/chaintracker, storage, broadcast/Arcade, sanctions
// provider, unknown internal error — is ERR_UNAVAILABLE (503, retryable),
// because a dependency fault must never convince a wallet that a transaction
// is permanently invalid.
const (
	CodeConservation = "ERR_CONSERVATION"
	CodeLinkage      = "ERR_LINKAGE"
	CodeShape        = "ERR_SHAPE"
	CodeSatoshis     = "ERR_SATOSHIS"
	CodeInputSpent   = "ERR_INPUT_SPENT"
	CodePaused       = "ERR_PAUSED"
	CodeFrozen       = "ERR_FROZEN"
	CodeSanctioned   = "ERR_SANCTIONED"
	CodeAccess       = "ERR_ACCESS"
	CodeMembership   = "ERR_MEMBERSHIP"
	CodeEvicted      = "ERR_EVICTED"
	CodeUnavailable  = "ERR_UNAVAILABLE"
)

// Verdict is one row of the wire contract §2 table.
type Verdict struct {
	Code      string
	HTTP      int
	Retryable bool
	// Final marks the verdicts that are persisted per txid and re-served
	// identically to every later submitter ("verdict wins"): the 400 rows and
	// ERR_EVICTED. Liftable 409 policy refusals and 503 faults are not.
	Final bool
}

var (
	verdictConservation = Verdict{CodeConservation, fiber.StatusBadRequest, false, true}
	verdictLinkage      = Verdict{CodeLinkage, fiber.StatusBadRequest, false, true}
	verdictShape        = Verdict{CodeShape, fiber.StatusBadRequest, false, true}
	verdictSatoshis     = Verdict{CodeSatoshis, fiber.StatusBadRequest, false, true}
	verdictInputSpent   = Verdict{CodeInputSpent, fiber.StatusBadRequest, false, true}
	verdictPaused       = Verdict{CodePaused, fiber.StatusConflict, true, false}
	verdictFrozen       = Verdict{CodeFrozen, fiber.StatusConflict, true, false}
	verdictSanctioned   = Verdict{CodeSanctioned, fiber.StatusConflict, true, false}
	verdictAccess       = Verdict{CodeAccess, fiber.StatusConflict, true, false}
	verdictMembership   = Verdict{CodeMembership, fiber.StatusConflict, true, false}
	verdictEvicted      = Verdict{CodeEvicted, fiber.StatusGone, false, true}
	verdictUnavailable  = Verdict{CodeUnavailable, fiber.StatusServiceUnavailable, true, false}
)

// rejectReasonTable is the SHARED substring table of wire contract §2 — row
// for row, substring for substring, in the same evaluation order as the TS
// engine's REASON_TABLE (overlay/src/submitVerdict.ts), first hit wins. TS
// groups several substrings under one code in one row; Go lists them as
// consecutive single-substring rows, which is the same table since matching is
// first-hit-wins within a row too. There are no Go-only rows: a reason either
// exists on both stacks or it is not in the table.
//
// Two rows deviate from the order §2 prints them in, both deliberately and
// both on BOTH stacks:
//
//  1. The admin-chain anchoring row is pre-empted to the top. That refusal
//     (mandala.adminNotAnchoredReason, byte-identical to TS's
//     adminChainGuard) ends "...spent by this transaction", so the generic
//     "spent" row would otherwise mint ERR_INPUT_SPENT for a bad admin chain
//     and tell a wallet some innocent coin is gone — while §2 files a bad
//     admin chain under ERR_SHAPE. It also contains "previously admitted",
//     which is deliberately NOT the membership row's "not admitted", so no
//     other row competes for it.
//  2. The membership row precedes the bare "sanction" row: §2's own note
//     says the upstream membership string is "sanctioned party involved in
//     transfer" and must map to ERR_MEMBERSHIP, which is impossible if
//     "sanction" — a substring of it — is tested first.
//
// One Go-only consequence worth knowing: the Go control-gate reason "control
// gate rejected the transaction (paused asset or access mode)" contains both
// "paused" and "access mode", so it reports ERR_PAUSED. Both rows are 409
// retryable, so the HTTP behaviour is identical either way — only the code
// differs, and a wallet treats both as "retry later".
//
// Matching is case-insensitive on the reason text; every substring below is
// already lowercase.
var rejectReasonTable = []struct {
	Substring string
	Verdict   Verdict
}{
	{"not anchored to the asset admin chain", verdictShape},
	{"conservation", verdictConservation},
	{"no verified linkage", verdictLinkage},
	{"linkage", verdictLinkage},
	{"satoshi", verdictSatoshis},
	{"sanctioned party", verdictMembership},
	{"not admitted", verdictMembership},
	{"membership", verdictMembership},
	{"paused", verdictPaused},
	{"frozen", verdictFrozen},
	{"sanction", verdictSanctioned},
	{"access mode", verdictAccess},
	{"allowlist", verdictAccess},
	{"denylist", verdictAccess},
	{"spent", verdictInputSpent},
}

// VerdictForRejectReason maps a topic manager's own rejection text to its
// wire code. Anything unmatched is ERR_SHAPE: a deterministic content reason
// the manager refused for, just not one of the named ones.
func VerdictForRejectReason(reason string) Verdict {
	lower := strings.ToLower(reason)
	for _, row := range rejectReasonTable {
		if strings.Contains(lower, row.Substring) {
			return row.Verdict
		}
	}
	return verdictShape
}

// SubmitVerdict is a fully classified /submit failure: the wire row, the
// description to serve, the FIX L competitor (empty for every other reason),
// and the topic whose manager refused (empty for a dependency fault).
type SubmitVerdict struct {
	Verdict     Verdict
	Description string
	SpendTxid   string
	Topic       string
}

// Persistable reports whether this verdict should be written to the txid's
// admission record as the answer every later submitter of the same payload
// gets.
//
// Three conditions, all necessary. It must be FINAL — a liftable 409 or a 503
// fault is by definition not the last word. It must come from the TOKEN
// topic's manager: persisting, say, tm_mandala_registry's "no admissible
// registry outputs" would make that txid answer 400 forever, including to a
// later, perfectly good submission of the same bytes to tm_mandala only.
// Registry refusals still get their accurate 4xx code on the call that earned
// it; they just do not become the transaction's recorded verdict.
//
// And it must not be ERR_INPUT_SPENT (wire contract §9.2). That one is a
// statement about LIVE state — which coin some other transaction currently
// holds — and that state is undone by an eviction of the competitor. Persisted,
// it would outlive its own truth: the coin comes back and the wallet is still
// told, forever, that it is gone. It is re-derived from the live token row on
// every submit instead, and stays 400 retryable:false with spendTxid on the
// wire so the wallet can confirm the competitor via
// GET /admin/admission/<spendTxid>.
func (s SubmitVerdict) Persistable() bool {
	return s.Verdict.Final && s.Topic == tokenTopic && s.Verdict.Code != CodeInputSpent
}

// VerdictForSubmitError classifies an error returned by engine.Submit. Only a
// *mandala.RejectError — a manager's own verdict — may become a 400/409;
// every other error is a dependency fault and answers 503 ERR_UNAVAILABLE.
func VerdictForSubmitError(err error) SubmitVerdict {
	var rej *mandala.RejectError
	if errors.As(err, &rej) {
		return SubmitVerdict{
			Verdict:     VerdictForRejectReason(rej.Error()),
			Description: rej.Error(),
			SpendTxid:   rej.SpendTxid,
			Topic:       rej.Topic,
		}
	}
	return SubmitVerdict{Verdict: verdictUnavailable, Description: err.Error()}
}

// verdictResponse writes the wire contract §2 error body. `message` is
// carried alongside `description` with the same text so the pre-existing
// {status, message} clients (and the TS overlay's own older shape) keep
// working; nothing reads both.
func verdictResponse(c *fiber.Ctx, v Verdict, description, spendTxid string) error {
	body := fiber.Map{
		"status":      "error",
		"code":        v.Code,
		"retryable":   v.Retryable,
		"description": description,
		"message":     description,
	}
	if spendTxid != "" {
		body["spendTxid"] = spendTxid
	}
	return c.Status(v.HTTP).JSON(body)
}

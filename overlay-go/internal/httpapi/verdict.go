package httpapi

import (
	"errors"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// The wire codes of D §6.3. Every manager code is a mandala.Code; ERR_EVICTED is the host's own (an eviction stamp,
// never a manager refusal).
const (
	CodeConservation = string(mandala.CodeConservation)
	CodeLinkage      = string(mandala.CodeLinkage)
	CodeShape        = string(mandala.CodeShape)
	CodeSatoshis     = string(mandala.CodeSatoshis)
	CodeAuthority    = string(mandala.CodeAuthority)
	CodeInputSpent   = string(mandala.CodeInputSpent)
	CodeUntrusted    = string(mandala.CodeUntrusted)
	CodePaused       = string(mandala.CodePaused)
	CodeFrozen       = string(mandala.CodeFrozen)
	CodeSanctioned   = string(mandala.CodeSanctioned)
	CodeAccess       = string(mandala.CodeAccess)
	CodeMembership   = string(mandala.CodeMembership)
	CodeEvicted      = "ERR_EVICTED"
	CodeUnavailable  = string(mandala.CodeUnavailable)
)

// unknownTopicDescription is the engine's ErrUnknownTopic text; the pre-check appends ": <name>" (V-7).
const unknownTopicDescription = "unknown-topic"

// Verdict is one row of the D §6.3 table. Final marks the codes a persisted refusal may carry; whether a refusal is
// persisted is SubmitVerdict.Persistable's call.
type Verdict struct {
	Code      string
	HTTP      int
	Retryable bool
	Final     bool
}

var (
	verdictShape       = Verdict{CodeShape, fiber.StatusBadRequest, false, true}
	verdictEvicted     = Verdict{CodeEvicted, fiber.StatusGone, false, true}
	verdictUnavailable = Verdict{CodeUnavailable, fiber.StatusServiceUnavailable, true, false}
)

// verdictRows is the typed table: a manager refusal carries its code structurally, and no reason text is ever read.
var verdictRows = map[mandala.Code]Verdict{
	mandala.CodeConservation: {CodeConservation, fiber.StatusBadRequest, false, true},
	mandala.CodeLinkage:      {CodeLinkage, fiber.StatusBadRequest, false, true},
	mandala.CodeShape:        verdictShape,
	mandala.CodeSatoshis:     {CodeSatoshis, fiber.StatusBadRequest, false, true},
	mandala.CodeAuthority:    {CodeAuthority, fiber.StatusBadRequest, false, true},
	mandala.CodeInputSpent:   {CodeInputSpent, fiber.StatusBadRequest, false, true},
	mandala.CodeUntrusted:    {CodeUntrusted, fiber.StatusConflict, true, false},
	mandala.CodePaused:       {CodePaused, fiber.StatusConflict, true, false},
	mandala.CodeFrozen:       {CodeFrozen, fiber.StatusConflict, true, false},
	mandala.CodeSanctioned:   {CodeSanctioned, fiber.StatusConflict, true, false},
	mandala.CodeAccess:       {CodeAccess, fiber.StatusConflict, true, false},
	mandala.CodeMembership:   {CodeMembership, fiber.StatusConflict, true, false},
	mandala.CodeUnavailable:  verdictUnavailable,
}

// VerdictForCode is the D §6.3 row of a manager code.
func VerdictForCode(code mandala.Code) (Verdict, bool) {
	v, ok := verdictRows[code]
	return v, ok
}

// SubmitVerdict is a classified /submit failure: the wire row, the description, the competing spend (ERR_INPUT_SPENT
// only), the refusing topic, and whether a manager typed it.
type SubmitVerdict struct {
	Verdict     Verdict
	Description string
	SpendTxid   string
	Topic       string
	Typed       bool
}

// Persistable is A1.3: a refusal becomes the transaction's recorded verdict (for this payload) only when a manager
// typed it with a final code, the refusing topic is tm_mandala or a tm_<id>, and it is not ERR_INPUT_SPENT, which is a
// statement about live state that an eviction of the competitor undoes.
func (s SubmitVerdict) Persistable() bool {
	return s.Typed && s.Verdict.Final && mandala.IsSigmaTopic(s.Topic) && s.Verdict.Code != CodeInputSpent
}

// VerdictForSubmitError classifies an engine.Submit error. A typed manager refusal answers its row; an untyped one, or
// a code outside the table, answers 400 ERR_SHAPE untyped (never persisted); the engine's unknown-topic answers 400
// ERR_SHAPE untyped (TT §9); every other error is a dependency fault, 503 ERR_UNAVAILABLE.
func VerdictForSubmitError(err error) SubmitVerdict {
	var rej *mandala.RejectError
	if errors.As(err, &rej) {
		if v, ok := VerdictForCode(rej.Code); ok {
			return SubmitVerdict{Verdict: v, Description: rej.Reason, SpendTxid: rej.SpendTxid, Topic: rej.Topic, Typed: true}
		}
		return SubmitVerdict{Verdict: verdictShape, Description: rej.Reason, Topic: rej.Topic}
	}
	if errors.Is(err, engine.ErrUnknownTopic) {
		return SubmitVerdict{Verdict: verdictShape, Description: unknownTopicDescription}
	}
	return SubmitVerdict{Verdict: verdictUnavailable, Description: err.Error()}
}

// verdictResponse writes the D §6.3 error body {status, code, retryable, description, message, spendTxid?}.
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

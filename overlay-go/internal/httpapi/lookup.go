package httpapi

import (
	"encoding/json"

	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

func registerLookupRoutes(f *fiber.App, l Lookuper) {
	f.Post("/lookup", lookupHandler(l))
}

// lookupRequestBody mirrors the shape the TS overlay validates against
// (OverlayExpress.ts: body must have a string "service" and a "query"
// field that is present). json.RawMessage leaves Query nil when the key
// is absent from the body but non-nil (even for a literal `null`) when
// it's present, letting us tell "missing" apart from "present" without a
// decode-then-re-encode round trip that could reorder the query object.
type lookupRequestBody struct {
	Service string          `json:"service"`
	Query   json.RawMessage `json:"query"`
}

// lookupHandler implements Appendix B §2: validate the body, forward
// Service/Query verbatim to the engine's Lookup, and respond with the
// LookupResolver's JSON fallback shape. The X-Aggregation header is
// intentionally never read — we always answer application/json, which is
// one of the two encodings the TS LookupResolver accepts (switched on
// response Content-Type), and the binary aggregation mode is out of
// scope for this port.
func lookupHandler(l Lookuper) fiber.Handler {
	return func(c *fiber.Ctx) error {
		var req lookupRequestBody
		if err := json.Unmarshal(c.Body(), &req); err != nil {
			return errorResponse(c, fiber.StatusBadRequest, "invalid request: body must contain \"service\" (string) and \"query\" fields")
		}
		if req.Service == "" || req.Query == nil {
			return errorResponse(c, fiber.StatusBadRequest, "invalid request: body must contain \"service\" (string) and \"query\" fields")
		}

		answer, err := l.Lookup(c.UserContext(), &lookup.LookupQuestion{
			Service: req.Service,
			Query:   req.Query,
		})
		if err != nil {
			return errorResponse(c, fiber.StatusBadRequest, err.Error())
		}

		return c.Status(fiber.StatusOK).JSON(answerToWire(answer))
	}
}

// wireOutput mirrors the TS LookupAnswer output-list item — a JSON number
// array for the BEEF bytes and a plain output index. go-sdk's
// lookup.OutputListItem tags Beef as `[]byte`, which encoding/json
// marshals as a base64 string, not the number array the frontend's
// LookupResolver expects; hence this local mirror rather than marshaling
// the SDK type directly (same lesson as submitHandler's wireAdmittance).
type wireOutput struct {
	Beef        mandala.NumBytes `json:"beef"`
	OutputIndex uint32           `json:"outputIndex"`
}

// wireLookupAnswer mirrors the TS LookupAnswer wire shape.
type wireLookupAnswer struct {
	Type    string       `json:"type"`
	Outputs []wireOutput `json:"outputs"`
}

// answerToWire converts an *lookup.LookupAnswer into the wire shape,
// normalizing a nil/empty Outputs slice to `[]` (never `null`). The
// engine hydrates ls_mandala answers to output-list (T11/T12), but the
// Type string is passed through verbatim regardless of its value —
// defensive, since ls_mandala always returns output-list.
func answerToWire(answer *lookup.LookupAnswer) wireLookupAnswer {
	if answer == nil {
		return wireLookupAnswer{Outputs: []wireOutput{}}
	}

	outputs := make([]wireOutput, 0, len(answer.Outputs))
	for _, o := range answer.Outputs {
		if o == nil {
			continue
		}
		outputs = append(outputs, wireOutput{
			Beef:        mandala.NumBytes(o.Beef),
			OutputIndex: o.OutputIndex,
		})
	}

	return wireLookupAnswer{
		Type:    string(answer.Type),
		Outputs: outputs,
	}
}

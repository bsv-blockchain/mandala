package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"slices"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/arcade"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// tokenTopic is the one topic σ_I speaks for. A registry-only admission
// never yields a token signature (wire contract §1).
const tokenTopic = "tm_mandala"

// Submitter is the narrow slice of *engine.Engine that POST /submit
// depends on (signature per overlay-go/README.md "Pinned API notes" —
// engine.Submit, including the upstream SumbitMode typo). *engine.Engine
// satisfies it; tests substitute a stub so they never need Mongo or real
// topic managers.
type Submitter interface {
	Submit(ctx context.Context, taggedBEEF overlay.TaggedBEEF, mode engine.SumbitMode, onSteakReady engine.OnSteakReady) (overlay.Steak, error)
}

var _ Submitter = (*engine.Engine)(nil)

// AdmissionRecorder is the σ_I / verdict persistence seam (wire contract §4).
// *mandala.Store satisfies it; tests substitute a stub so they never need
// Mongo. Writes happen synchronously before /submit answers, so a client
// holding a 200 is guaranteed the record is readable on its very next GET.
type AdmissionRecorder interface {
	GetAdmission(ctx context.Context, txid string) (*mandala.AdmissionRecord, error)
	// RecordAdmission writes the provisional row (rec.Pending) or finalizes it
	// (wire contract §9.4).
	RecordAdmission(ctx context.Context, rec mandala.AdmissionRecord) error
	MarkRefused(ctx context.Context, r mandala.Refusal) error
}

var _ AdmissionRecorder = (*mandala.Store)(nil)

// AppliedAdmissionProof answers FIX C: does the ENGINE's own durable
// applied-transaction store say this txid went through tm_mandala, and which
// output indexes does it hold for it? It is what lets a resubmit be signed
// even when the mandalaAdmissions row is missing entirely — a Go admission
// that predates this feature, or one lost to a crash between commit and
// record. wiring backs it with enginestore.
type AppliedAdmissionProof func(ctx context.Context, txid string) (applied bool, outputsToAdmit []uint32, err error)

// PrepareSubmitCompensation is the Arcade-path compensation seam for the
// pinned go-overlay-services v1.3.2 engine's submit ordering (validate →
// mark inputs spent + notify OutputSpent → broadcast → fold): a failed
// broadcast aborts Submit AFTER the inputs were marked spent and the mandala
// projections destroyed, and the engine never unwinds that. The handler
// calls prepare BEFORE Engine.Submit (it must snapshot the restorable state
// while it still exists); the returned compensate closure is invoked only
// when Submit fails with a broadcast-classified error
// (arcade.IsBroadcastFailureErr), and the returned restore snapshot — the
// same data, given a durable home — is persisted on the admission record on
// success so a post-hoc eviction (FIX E) can hand the inputs back long after
// this request is gone. A nil compensate means "nothing to compensate" (e.g.
// the BEEF won't survive Submit's own parse step anyway). Wired by
// wiring.Build when Arcade is enabled; nil otherwise.
type PrepareSubmitCompensation func(ctx context.Context, beef []byte) (compensate func(context.Context) error, restore *mandala.RestoreSnapshot, err error)

func registerSubmitRoutes(f *fiber.App, s Submitter, prepare PrepareSubmitCompensation, signer AdmissionSigner, rec AdmissionRecorder, proof AppliedAdmissionProof) {
	f.Post("/submit", submitHandler(s, prepare, signer, rec, proof))
}

// submitHandler implements Appendix B §1 plus wire contract §2: parse
// X-Topics, split the optionally-framed body into beef + off-chain values,
// decode the off-chain payload and thread it onto ctx (the topic manager
// reads it from there) as well as onto TaggedBEEF.OffChainValues (the lookup
// service reads it from there), serve any persisted or engine-proven verdict
// for this txid WITHOUT re-running side effects, otherwise submit and answer
// with the STEAK (σ_I attached to the tm_mandala entry) or a structured
// verdict.
func submitHandler(s Submitter, prepare PrepareSubmitCompensation, signer AdmissionSigner, rec AdmissionRecorder, proof AppliedAdmissionProof) fiber.Handler {
	return func(c *fiber.Ctx) error {
		topicsHeader := c.Get("X-Topics")
		if topicsHeader == "" {
			return verdictResponse(c, verdictShape, "X-Topics header is required", "")
		}
		var topics []string
		if err := json.Unmarshal([]byte(topicsHeader), &topics); err != nil {
			return verdictResponse(c, verdictShape, "X-Topics header must be a JSON array of strings", "")
		}

		body := c.Body()
		var beef, offChain []byte
		if c.Get("x-includes-off-chain-values") == "true" {
			r := bytes.NewReader(body)
			beefLen, err := readVarInt(r)
			if err != nil {
				return verdictResponse(c, verdictShape, "invalid off-chain values framing: "+err.Error(), "")
			}
			consumed := len(body) - r.Len()
			if beefLen > uint64(len(body)-consumed) {
				return verdictResponse(c, verdictShape, "invalid off-chain values framing: beef length exceeds body", "")
			}
			beef = body[consumed : consumed+int(beefLen)]
			offChain = body[consumed+int(beefLen):]
		} else {
			beef = body
		}

		payload, err := mandala.DecodeLinkagePayload(offChain)
		if err != nil {
			return verdictResponse(c, verdictShape, "invalid off-chain values payload: "+err.Error(), "")
		}
		ctx := mandala.WithPayload(c.UserContext(), payload)

		// Wire contract §9.1: a persisted refusal is keyed by (txid,
		// payloadHash), because the txid does not commit to the off-chain
		// payload. Computed over the bytes exactly as framed on the wire.
		payloadHash := mandala.PayloadHashHex(offChain)

		// The txid is needed before anything else: it keys the persisted
		// verdict, the engine's applied proof and σ_I itself. Bodies that
		// aren't parseable BEEF (the engine will reject them in a moment)
		// simply skip every txid-keyed step.
		txid, txidErr := txidFromBeef(beef)
		tokenSubmit := slices.Contains(topics, tokenTopic)

		// FIX C/D — idempotent dupe path and payload-scoped "verdict wins",
		// both BEFORE any side effect: no snapshot, no Submit, no broadcast.
		// Scoped to submissions that actually name tm_mandala (§9.6 ordering /
		// finding 8): every state this serves from — σ_I, the refusal, the
		// eviction stamp, the applied proof — is tm_mandala's, so a
		// registry-only submit of an already-admitted txid must still reach
		// the registry manager rather than being answered from the token
		// topic's record.
		if txidErr == nil && tokenSubmit {
			if handled, err := serveKnownVerdict(c, ctx, txid, payloadHash, signer, rec, proof); handled {
				return err
			}
		}

		// Snapshot restorable state BEFORE Submit: the engine's OutputSpent
		// notifications delete the mandala token rows mid-Submit, so a
		// post-failure snapshot would find nothing left to restore. If the
		// snapshot itself fails, refuse to submit — a broadcast failure
		// afterwards would be uncompensatable.
		var compensate func(context.Context) error
		var restore *mandala.RestoreSnapshot
		if prepare != nil {
			var prepErr error
			if compensate, restore, prepErr = prepare(ctx, beef); prepErr != nil {
				return verdictResponse(c, verdictUnavailable,
					"broadcast-failure compensation unavailable: "+prepErr.Error(), "")
			}
		}

		// Wire contract §9.4 — the PROVISIONAL record, written here, at the
		// snapshot seam, because everything after this line can mutate state:
		// the engine marks the inputs spent and destroys the mandala token
		// rows before it broadcasts. If the process dies anywhere in there,
		// this row is what still names the coins to hand back, and the dupe
		// path finalizes it from the engine's own applied proof. A failed
		// write is 503: submitting without a durable snapshot is exactly the
		// unwind hole the record exists to close.
		if rec != nil && txidErr == nil && tokenSubmit {
			if perr := rec.RecordAdmission(ctx, mandala.AdmissionRecord{
				Txid:    txid,
				Topics:  topics,
				Restore: restore,
				Pending: true,
			}); perr != nil {
				log.Printf("submit: provisional admission record write for %s failed: %v", txid, perr)
				return verdictResponse(c, verdictUnavailable,
					"provisional admission record write failed: "+perr.Error(), "")
			}
		}

		steak, err := s.Submit(ctx, overlay.TaggedBEEF{
			Beef:           beef,
			Topics:         topics,
			OffChainValues: offChain,
		}, engine.SubmitModeCurrent, nil)
		if err != nil {
			// Broadcast failures are the one error path the pinned engine
			// takes after marking inputs spent (see PrepareSubmitCompensation)
			// — undo that marking. Every other Submit error either happened
			// before markSpentAndNotify (nothing to undo) or is a mid-commit
			// storage fault with no clean inverse (compensating those could
			// resurrect state the commit already deleted).
			if compensate != nil && arcade.IsBroadcastFailureErr(err) {
				if cerr := compensate(ctx); cerr != nil {
					log.Printf("submit: broadcast-failure compensation failed (state may need manual repair): submit=%v compensation=%v", err, cerr)
				}
			}
			sv := VerdictForSubmitError(err)
			// "Verdict wins", scoped to this payload (§9.1): persist the
			// FINAL, token-topic refusals so every later submitter of the same
			// bytes AND the same payload converges on the same answer. A
			// failure to persist is logged, never surfaced — the caller still
			// gets the verdict it earned.
			if sv.Persistable() && rec != nil && txidErr == nil {
				if perr := rec.MarkRefused(ctx, mandala.Refusal{
					Txid:        txid,
					Code:        sv.Verdict.Code,
					Description: sv.Description,
					SpendTxid:   sv.SpendTxid,
					PayloadHash: payloadHash,
				}); perr != nil {
					log.Printf("submit: persisting final verdict %s for %s failed: %v", sv.Verdict.Code, txid, perr)
				}
			}
			return verdictResponse(c, sv.Verdict, sv.Description, sv.SpendTxid)
		}

		admits := admittedTokenOutputs(steak)
		sig, ident := signAdmission(signer, txid, txidErr, admits)

		// The FINALIZE (§9.4) is written SYNCHRONOUSLY, before the 200 is sent
		// (wire contract §4). If the write fails the client gets 503 rather
		// than a signature it could not look up afterwards; its retry lands on
		// the dupe path above, which re-signs and finalizes from the engine's
		// own applied proof. It also clears any refusal this txid earned under
		// a different payload (§9.1).
		if rec != nil && txidErr == nil && len(admits) > 0 {
			record := mandala.AdmissionRecord{
				Txid:                 txid,
				Topics:               admittingTopics(steak),
				OutputsToAdmit:       admits,
				AdmissionSignature:   sig,
				AdmissionIdentityKey: ident,
			}
			record.Restore = restore
			if perr := rec.RecordAdmission(ctx, record); perr != nil {
				log.Printf("submit: admission record write for %s failed: %v", txid, perr)
				return verdictResponse(c, verdictUnavailable,
					"admission record write failed: "+perr.Error(), "")
			}
		}

		return c.Status(fiber.StatusOK).JSON(steakToWire(steak, sig, ident))
	}
}

// serveKnownVerdict answers from state alone — the persisted admission record
// first, then the engine's own applied-transaction proof — and reports
// whether it did. Nothing here re-runs admission, re-marks inputs or
// re-broadcasts (wire contract §2's dupe row); the one write it may do is
// §9.4's finalize of a provisional record the applied proof has just shown to
// be a real admission.
//
// A persisted refusal applies ONLY to the payload that earned it (§9.1). With
// a different payload the record is not a verdict at all: the request falls
// through to the applied proof and then to a fresh evaluation, which is what
// stops any holder of the BEEF from poisoning a transaction by submitting it
// stripped of its linkage payload.
func serveKnownVerdict(c *fiber.Ctx, ctx context.Context, txid, payloadHash string, signer AdmissionSigner, rec AdmissionRecorder, proof AppliedAdmissionProof) (bool, error) {
	var record *mandala.AdmissionRecord
	if rec != nil {
		var err error
		record, err = rec.GetAdmission(ctx, txid)
		if err != nil {
			return true, verdictResponse(c, verdictUnavailable, "admission record lookup failed: "+err.Error(), "")
		}
		switch {
		case record == nil:
			// fall through to the applied-store proof
		case record.EvictedAt != "":
			return true, verdictResponse(c, verdictEvicted, evictedDescription(txid), "")
		case record.RefusedCode != "" && record.RefusedPayloadHash == payloadHash:
			return true, verdictResponse(c,
				Verdict{Code: record.RefusedCode, HTTP: fiber.StatusBadRequest, Retryable: false, Final: true},
				record.RefusedDescription, record.RefusedSpendTxid)
		case record.Admitted():
			return true, admittedResponse(c, txid, record.OutputsToAdmit, signer)
		}
	}
	if proof != nil {
		applied, outputs, err := proof(ctx, txid)
		if err != nil {
			return true, verdictResponse(c, verdictUnavailable, "applied-transaction lookup failed: "+err.Error(), "")
		}
		if applied {
			canonical := canonicalOutputs(outputs)
			sig, ident := signAdmission(signer, txid, nil, canonical)
			// §9.4: the engine's applied proof has settled it — complete the
			// provisional row (or supply one that was lost entirely) so the
			// admission endpoint and the next submitter read the same answer
			// without consulting the engine again. A failed finalize is 503:
			// the caller retries, and the snapshot is already durable.
			if rec != nil && !record.Admitted() && len(canonical) > 0 {
				if perr := rec.RecordAdmission(ctx, mandala.AdmissionRecord{
					Txid:                 txid,
					Topics:               []string{tokenTopic},
					OutputsToAdmit:       canonical,
					AdmissionSignature:   sig,
					AdmissionIdentityKey: ident,
				}); perr != nil {
					log.Printf("submit: finalizing pending admission record for %s failed: %v", txid, perr)
					return true, verdictResponse(c, verdictUnavailable,
						"admission record write failed: "+perr.Error(), "")
				}
			}
			return true, signedAdmittanceResponse(c, canonical, sig, ident)
		}
	}
	return false, nil
}

// evictedDescription is the one sentence both engines return for an evicted
// txid, byte-identical on the TS side: permanent for these bytes, but the
// inputs are live again, so the wallet must build a NEW spend rather than
// retry this one forever. No timestamp — the description is part of the wire
// contract and has to compare equal across engines and across calls; the
// eviction time lives on the record, not in the prose.
func evictedDescription(txid string) string {
	return fmt.Sprintf("transaction %s was admitted and later evicted; its inputs are spendable again", txid)
}

// admittedResponse is the 200 the dupe path serves: the same outputsToAdmit
// with a freshly computed (and, thanks to RFC6979, byte-identical) σ_I.
// coinsToRetain is empty here — the engine's per-topic dupe gate does not
// recompute it, and no consumer of the dupe path reads it.
func admittedResponse(c *fiber.Ctx, txid string, outputs []uint32, signer AdmissionSigner) error {
	canonical := canonicalOutputs(outputs)
	sig, ident := signAdmission(signer, txid, nil, canonical)
	return signedAdmittanceResponse(c, canonical, sig, ident)
}

// signedAdmittanceResponse writes the dupe path's 200 for an already-computed
// (canonical set, σ_I) pair.
func signedAdmittanceResponse(c *fiber.Ctx, canonical []uint32, sig, ident string) error {
	return c.Status(fiber.StatusOK).JSON(map[string]wireAdmittance{
		tokenTopic: {
			OutputsToAdmit:       nonNilUint32(canonical),
			CoinsToRetain:        []uint32{},
			AdmissionSignature:   sig,
			AdmissionIdentityKey: ident,
		},
	})
}

// signAdmission produces σ_I over admissionDigestV2(txid, outputsToAdmit).
// Signing is best-effort: a failure logs and drops the fields rather than
// failing an otherwise good submission.
func signAdmission(signer AdmissionSigner, txid string, txidErr error, outputs []uint32) (sig, ident string) {
	if signer == nil || txidErr != nil || len(outputs) == 0 {
		return "", ""
	}
	s, k, err := signer.SignAdmission(txid, outputs)
	if err != nil {
		log.Printf("submit: admission signature failed: %v", err)
		return "", ""
	}
	return s, k
}

// admittedTokenOutputs is the tm_mandala topic's OWN admitted set in
// canonical form — the set σ_I speaks for. A registry-only admission returns
// nothing, so it never yields a token signature.
func admittedTokenOutputs(steak overlay.Steak) []uint32 {
	ai, ok := steak[tokenTopic]
	if !ok || ai == nil {
		return nil
	}
	return canonicalOutputs(ai.OutputsToAdmit)
}

// admittingTopics lists every topic that admitted at least one output, for
// the admission record's `topics` field.
func admittingTopics(steak overlay.Steak) []string {
	topics := make([]string, 0, len(steak))
	for topic, ai := range steak {
		if ai != nil && len(ai.OutputsToAdmit) > 0 {
			topics = append(topics, topic)
		}
	}
	slices.Sort(topics)
	return topics
}

func errorResponse(c *fiber.Ctx, status int, message string) error {
	return c.Status(status).JSON(fiber.Map{
		"status":  "error",
		"message": message,
	})
}

// wireAdmittance mirrors the TS SDK's AdmittanceInstructions wire shape —
// camelCase keys, arrays never null (Appendix B §1). go-sdk's
// overlay.AdmittanceInstructions carries no json tags at all (so its
// default encoding is PascalCase field names) and lets a nil slice
// marshal to `null`; neither matches the wire contract, hence this local
// mirror rather than marshaling the SDK type directly.
type wireAdmittance struct {
	OutputsToAdmit       []uint32 `json:"outputsToAdmit"`
	CoinsToRetain        []uint32 `json:"coinsToRetain"`
	CoinsRemoved         []uint32 `json:"coinsRemoved,omitempty"`
	AdmissionSignature   string   `json:"admissionSignature,omitempty"`
	AdmissionIdentityKey string   `json:"admissionIdentityKey,omitempty"`
}

// steakToWire converts an overlay.Steak into the bare, camelCase JSON map
// the frontend's SHIPBroadcaster expects, normalizing nil slices to `[]`.
// σ_I rides on the tm_mandala entry only: the digest covers that topic's own
// admitted output set, so attaching it to a registry entry would assert
// coverage the signature does not have (wire contract §1/§2).
func steakToWire(steak overlay.Steak, sig, ident string) map[string]wireAdmittance {
	out := make(map[string]wireAdmittance, len(steak))
	for topic, ai := range steak {
		if ai == nil {
			ai = &overlay.AdmittanceInstructions{}
		}
		w := wireAdmittance{
			OutputsToAdmit: nonNilUint32(ai.OutputsToAdmit),
			CoinsToRetain:  nonNilUint32(ai.CoinsToRetain),
			CoinsRemoved:   ai.CoinsRemoved,
		}
		if topic == tokenTopic && len(w.OutputsToAdmit) > 0 {
			w.AdmissionSignature = sig
			w.AdmissionIdentityKey = ident
		}
		out[topic] = w
	}
	return out
}

func txidFromBeef(beef []byte) (string, error) {
	_, tx, txid, err := transaction.ParseBeef(beef)
	if err != nil {
		return "", err
	}
	if txid != nil {
		return txid.String(), nil
	}
	if tx != nil {
		return tx.TxID().String(), nil
	}
	return "", fmt.Errorf("txid not in beef")
}

func nonNilUint32(s []uint32) []uint32 {
	if s == nil {
		return []uint32{}
	}
	return s
}

// readVarInt reads a Bitcoin VarInt (little-endian) from r: the leading
// byte is either a literal value (<0xfd), or a 0xfd/0xfe/0xff prefix
// introducing a 2/4/8-byte little-endian length.
func readVarInt(r *bytes.Reader) (uint64, error) {
	first, err := r.ReadByte()
	if err != nil {
		return 0, err
	}
	switch first {
	case 0xfd:
		var v uint16
		if err := binary.Read(r, binary.LittleEndian, &v); err != nil {
			return 0, err
		}
		return uint64(v), nil
	case 0xfe:
		var v uint32
		if err := binary.Read(r, binary.LittleEndian, &v); err != nil {
			return 0, err
		}
		return uint64(v), nil
	case 0xff:
		var v uint64
		if err := binary.Read(r, binary.LittleEndian, &v); err != nil {
			return 0, err
		}
		return v, nil
	default:
		return uint64(first), nil
	}
}

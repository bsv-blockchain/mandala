package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/arcade"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

// Submitter is the slice of *engine.Engine POST /submit needs: Submit, and HasTopicManager for the unknown-topic
// pre-check (G6, A1.3).
type Submitter interface {
	Submit(ctx context.Context, taggedBEEF overlay.TaggedBEEF, mode engine.SumbitMode, onSteakReady engine.OnSteakReady) (overlay.Steak, error)
	HasTopicManager(name string) bool
}

var _ Submitter = (*engine.Engine)(nil)

// AdmissionRecorder is the per-txid admission record (A1.2): provisional and final writes, refusals.
type AdmissionRecorder interface {
	GetAdmission(ctx context.Context, txid string) (*mandala.AdmissionRecord, error)
	RecordAdmission(ctx context.Context, rec mandala.AdmissionRecord) error
	MarkRefused(ctx context.Context, r mandala.Refusal) error
}

var _ AdmissionRecorder = (*mandala.Store)(nil)

// AppliedAdmissionProof maps every topic with an engine applied record for txid to the vouts it holds for it.
type AppliedAdmissionProof func(ctx context.Context, txid string) (map[string][]uint32, error)

// PrepareSubmitCompensation snapshots a submit's inputs before Engine.Submit (the restore snapshot the record keeps)
// and returns the compensation run only on a broadcast failure (wiring.prepareSubmitCompensation).
type PrepareSubmitCompensation func(ctx context.Context, beef []byte, topics []string) (compensate func(context.Context) error, restore *mandala.RestoreSnapshot, err error)

// submitDeps are POST /submit's collaborators. Task 23 adds the deploy hook and the maintenance gate here.
type submitDeps struct {
	submitter Submitter
	prepare   PrepareSubmitCompensation
	signer    mandala.AdmissionSigner
	recorder  AdmissionRecorder
	proof     AppliedAdmissionProof
}

func registerSubmitRoutes(f *fiber.App, d submitDeps) {
	f.Post("/submit", submitHandler(d))
}

// submitHandler is POST /submit on v3 (steps numbered as in the plan's Task 20 order).
func submitHandler(d submitDeps) fiber.Handler {
	return func(c *fiber.Ctx) error {
		// 1. X-Topics, deduplicated (G17).
		topics, problem := parseTopicsHeader(c.Get("X-Topics"))
		if problem != "" {
			return verdictResponse(c, verdictShape, problem, "")
		}
		// 2. Framing, payload identity, the raw envelope on ctx for the managers (never decoded here), the txid.
		beef, offChain, problem := splitSubmitBody(c.Body(), c.Get("x-includes-off-chain-values") == "true")
		if problem != "" {
			return verdictResponse(c, verdictShape, problem, "")
		}
		payloadHash := mandala.PayloadHashHex(offChain)
		ctx := mandala.WithOffChainValues(c.UserContext(), offChain)
		txid, txidErr := txidFromBeef(beef)

		// 3. Every named topic must be hosted before anything is read or written (G6, A1.3).
		for _, topic := range topics {
			if !d.submitter.HasTopicManager(topic) {
				return verdictResponse(c, verdictShape, unknownTopicDescription+": "+topic, "")
			}
		}

		// 4. What this node already knows (D-8): eviction, a refusal for this payload, a full replay.
		sigmaSubmit := txidErr == nil && namesSigmaTopic(topics)
		var known knownState
		if sigmaSubmit {
			handled, k, err := serveKnownVerdict(c, ctx, d, txid, payloadHash, topics)
			if handled {
				return err
			}
			known = k
		}

		// 5. Script-rules parity with TS; never persisted.
		if cerr := wiring.CheckChronicleSighashRule(beef); cerr != nil {
			return verdictResponse(c, verdictUnavailable, cerr.Error(), "")
		}

		// 6. Snapshot before the engine can mark anything spent.
		var compensate func(context.Context) error
		var restore *mandala.RestoreSnapshot
		if d.prepare != nil {
			var err error
			if compensate, restore, err = d.prepare(ctx, beef, topics); err != nil {
				return verdictResponse(c, verdictUnavailable, "broadcast-failure compensation unavailable: "+err.Error(), "")
			}
		}

		// 7. The provisional record: durable before anything below can mutate state.
		if d.recorder != nil && sigmaSubmit {
			if err := d.recorder.RecordAdmission(ctx, mandala.AdmissionRecord{Txid: txid, Topics: topics, Restore: restore, Pending: true}); err != nil {
				log.Printf("submit: provisional admission record write for %s failed: %v", txid, err)
				return verdictResponse(c, verdictUnavailable, "provisional admission record write failed: "+err.Error(), "")
			}
		}

		// 8. The engine.
		steak, err := d.submitter.Submit(ctx, overlay.TaggedBEEF{Beef: beef, Topics: topics, OffChainValues: offChain}, engine.SubmitModeCurrent, nil)

		// 9. A refusal or a fault.
		if err != nil {
			if compensate != nil && arcade.IsBroadcastFailureErr(err) {
				if cerr := compensate(ctx); cerr != nil {
					log.Printf("submit: broadcast-failure compensation failed (state may need manual repair): submit=%v compensation=%v", err, cerr)
				}
			}
			sv := VerdictForSubmitError(err)
			if sv.Persistable() && d.recorder != nil && txidErr == nil {
				if perr := d.recorder.MarkRefused(ctx, mandala.Refusal{
					Txid: txid, Code: sv.Verdict.Code, Description: sv.Description, SpendTxid: sv.SpendTxid, PayloadHash: payloadHash, Topic: sv.Topic,
				}); perr != nil {
					log.Printf("submit: persisting final verdict %s for %s failed: %v", sv.Verdict.Code, txid, perr)
				}
			}
			return verdictResponse(c, sv.Verdict, sv.Description, sv.SpendTxid)
		}

		// 10. Admitted: σI per σ-topic entry, finalized before the 200. A σ-topic entry that came back empty although
		// step 4's proof did not cover the topic may be a dupe-gate hit: a concurrent submit of this txid committed
		// between step 4 and the engine's check (F/gos-engine §5 row 5a, check-then-act; row 11f, the applied record is
		// its last write, so its outputs are stored). Re-read the proof once and answer such a topic like the known
		// path (D-20).
		if txidErr == nil && d.proof != nil && emptyUncoveredSigmaEntry(steak, known) {
			proof, err := d.proof(ctx, txid)
			if err != nil {
				return verdictResponse(c, verdictUnavailable, "applied-transaction lookup failed: "+err.Error(), "")
			}
			known.proof = proof
		}
		entries, admissions, ident := admittedEntries(steak, known, d.signer, txid, txidErr == nil)
		if d.recorder != nil && txidErr == nil && len(admissions) > 0 {
			if err := d.recorder.RecordAdmission(ctx, mandala.AdmissionRecord{
				Txid: txid, Topics: topics, Admissions: admissions, AdmissionIdentityKey: ident, Restore: restore,
			}); err != nil {
				log.Printf("submit: admission record write for %s failed: %v", txid, err)
				return verdictResponse(c, verdictUnavailable, "admission record write failed: "+err.Error(), "")
			}
		}
		return c.Status(fiber.StatusOK).JSON(entries)
	}
}

// parseTopicsHeader reads X-Topics as a JSON array of strings and deduplicates it, keeping first positions.
func parseTopicsHeader(header string) ([]string, string) {
	if header == "" {
		return nil, "X-Topics header is required"
	}
	var topics []string
	if err := json.Unmarshal([]byte(header), &topics); err != nil {
		return nil, "X-Topics header must be a JSON array of strings"
	}
	return dedupeTopics(topics), ""
}

// dedupeTopics keeps each topic's first position (G17: the legacy engine runs a repeated topic twice).
func dedupeTopics(topics []string) []string {
	out := make([]string, 0, len(topics))
	seen := make(map[string]bool, len(topics))
	for _, t := range topics {
		if !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// splitSubmitBody splits a body framed as CompactSize(len(beef)) || beef || offChain; unframed, the whole body is beef.
func splitSubmitBody(body []byte, framed bool) ([]byte, []byte, string) {
	if !framed {
		return body, nil, ""
	}
	r := bytes.NewReader(body)
	beefLen, err := readVarInt(r)
	if err != nil {
		return nil, nil, "invalid off-chain values framing: " + err.Error()
	}
	consumed := len(body) - r.Len()
	if beefLen > uint64(len(body)-consumed) {
		return nil, nil, "invalid off-chain values framing: beef length exceeds body"
	}
	return body[consumed : consumed+int(beefLen)], body[consumed+int(beefLen):], ""
}

func namesSigmaTopic(topics []string) bool {
	for _, t := range topics {
		if mandala.IsSigmaTopic(t) {
			return true
		}
	}
	return false
}

// knownState is what this node knew about a σ-submit's txid before Submit: its admission record and the engine's
// applied proof (topic -> admitted vouts).
type knownState struct {
	record *mandala.AdmissionRecord
	proof  map[string][]uint32
}

// applied reports whether the engine holds an applied record for topic (its dupe gate will skip that topic).
func (k knownState) applied(topic string) bool {
	_, ok := k.proof[topic]
	return ok
}

// appliedOutputs is an applied topic's admitted set: the record's own entry first, else the engine's stored outputs.
func (k knownState) appliedOutputs(topic string) []uint32 {
	if k.record != nil {
		if a, ok := k.record.Admissions[topic]; ok && len(a.OutputsToAdmit) > 0 {
			return mandala.CanonicalOutputs(a.OutputsToAdmit)
		}
	}
	return mandala.CanonicalOutputs(k.proof[topic])
}

// recorded reports whether the record already holds a signed admission for topic.
func (k knownState) recorded(topic string) bool {
	if k.record == nil {
		return false
	}
	a, ok := k.record.Admissions[topic]
	return ok && a.AdmissionSignature != "" && len(a.OutputsToAdmit) > 0
}

// serveKnownVerdict answers from state alone and reports whether it did. An eviction is 410 forever; a refusal answers
// only the payload that earned it; and a 200 replay needs an engine applied record for EVERY named topic (D-8) — a
// record alone, or a proof covering only some topics, falls through to Submit, whose per-topic dupe gate skips the
// applied topics and runs the rest. The replay writes nothing but the record entries it lacks.
func serveKnownVerdict(c *fiber.Ctx, ctx context.Context, d submitDeps, txid, payloadHash string, topics []string) (bool, knownState, error) {
	var k knownState
	if d.recorder != nil {
		record, err := d.recorder.GetAdmission(ctx, txid)
		if err != nil {
			return true, k, verdictResponse(c, verdictUnavailable, "admission record lookup failed: "+err.Error(), "")
		}
		if record != nil {
			if record.EvictedAt != "" {
				return true, k, verdictResponse(c, verdictEvicted, evictedDescription(txid), "")
			}
			if record.RefusedCode != "" && record.RefusedPayloadHash == payloadHash {
				return true, k, verdictResponse(c,
					Verdict{Code: record.RefusedCode, HTTP: fiber.StatusBadRequest, Retryable: false, Final: true},
					record.RefusedDescription, record.RefusedSpendTxid)
			}
		}
		k.record = record
	}
	if d.proof != nil {
		proof, err := d.proof(ctx, txid)
		if err != nil {
			return true, k, verdictResponse(c, verdictUnavailable, "applied-transaction lookup failed: "+err.Error(), "")
		}
		k.proof = proof
	}
	for _, topic := range topics {
		if !k.applied(topic) {
			return false, k, nil
		}
	}

	body := make(map[string]wireAdmittance, len(topics))
	finalize := map[string]mandala.TopicAdmission{}
	ident := ""
	for _, topic := range topics {
		outs := k.appliedOutputs(topic)
		w := wireAdmittance{OutputsToAdmit: nonNilUint32(outs), CoinsToRetain: []uint32{}}
		if mandala.IsSigmaTopic(topic) && len(outs) > 0 {
			if sig, key := signAdmission(d.signer, topic, txid, outs); sig != "" {
				w.AdmissionSignature, w.AdmissionIdentityKey = sig, key
				ident = key
				if !k.recorded(topic) {
					finalize[topic] = mandala.TopicAdmission{OutputsToAdmit: outs, AdmissionSignature: sig}
				}
			}
		}
		body[topic] = w
	}
	if d.recorder != nil && len(finalize) > 0 {
		if err := d.recorder.RecordAdmission(ctx, mandala.AdmissionRecord{Txid: txid, Topics: topics, Admissions: finalize, AdmissionIdentityKey: ident}); err != nil {
			log.Printf("submit: finalizing the admission record of %s from the applied proof failed: %v", txid, err)
			return true, k, verdictResponse(c, verdictUnavailable, "admission record write failed: "+err.Error(), "")
		}
	}
	return true, k, c.Status(fiber.StatusOK).JSON(body)
}

// emptyUncoveredSigmaEntry reports a σ-topic STEAK entry with no outputs for a topic step 4's proof did not cover: the
// shape a dupe-gate hit leaves when a concurrent submit of the txid committed after step 4 (D-20).
func emptyUncoveredSigmaEntry(steak overlay.Steak, known knownState) bool {
	for topic, ai := range steak {
		if mandala.IsSigmaTopic(topic) && (ai == nil || len(ai.OutputsToAdmit) == 0) && !known.applied(topic) {
			return true
		}
	}
	return false
}

// admittedEntries turns the STEAK into wire entries. A σ-topic the engine skipped as applied (in known.proof, entry
// empty) answers its recorded or stored outputs; every σ-topic entry with outputs is signed with its own v3 digest and
// returned in the finalize map. KYC entries are never signed.
func admittedEntries(steak overlay.Steak, known knownState, signer mandala.AdmissionSigner, txid string, txidOK bool) (map[string]wireAdmittance, map[string]mandala.TopicAdmission, string) {
	entries := make(map[string]wireAdmittance, len(steak))
	admissions := map[string]mandala.TopicAdmission{}
	ident := ""
	for topic, ai := range steak {
		if ai == nil {
			ai = &overlay.AdmittanceInstructions{}
		}
		w := wireAdmittance{
			OutputsToAdmit: nonNilUint32(ai.OutputsToAdmit),
			CoinsToRetain:  nonNilUint32(ai.CoinsToRetain),
			CoinsRemoved:   ai.CoinsRemoved,
		}
		outs := mandala.CanonicalOutputs(ai.OutputsToAdmit)
		if len(outs) == 0 && known.applied(topic) {
			outs = known.appliedOutputs(topic)
			w.OutputsToAdmit = nonNilUint32(outs)
		}
		if txidOK && mandala.IsSigmaTopic(topic) && len(outs) > 0 {
			if sig, key := signAdmission(signer, topic, txid, outs); sig != "" {
				w.AdmissionSignature, w.AdmissionIdentityKey = sig, key
				admissions[topic] = mandala.TopicAdmission{OutputsToAdmit: outs, AdmissionSignature: sig}
				ident = key
			}
		}
		entries[topic] = w
	}
	return entries, admissions, ident
}

// evictedDescription is the one sentence both engines return for an evicted txid (byte-identical with TS).
func evictedDescription(txid string) string {
	return fmt.Sprintf("transaction %s was admitted and later evicted; its inputs are spendable again", txid)
}

// signAdmission is σI over AdmissionDigestV3(topic, txid, outputs). Best-effort: a failure logs and drops the fields.
func signAdmission(signer mandala.AdmissionSigner, topic, txid string, outputs []uint32) (sig, ident string) {
	if signer == nil || len(outputs) == 0 {
		return "", ""
	}
	s, k, err := signer.SignAdmission(topic, txid, outputs)
	if err != nil {
		log.Printf("submit: admission signature for %s on %s failed: %v", txid, topic, err)
		return "", ""
	}
	return s, k
}

func errorResponse(c *fiber.Ctx, status int, message string) error {
	return c.Status(status).JSON(fiber.Map{"status": "error", "message": message})
}

// wireAdmittance is the TS AdmittanceInstructions wire shape: camelCase keys, arrays never null.
type wireAdmittance struct {
	OutputsToAdmit       []uint32 `json:"outputsToAdmit"`
	CoinsToRetain        []uint32 `json:"coinsToRetain"`
	CoinsRemoved         []uint32 `json:"coinsRemoved,omitempty"`
	AdmissionSignature   string   `json:"admissionSignature,omitempty"`
	AdmissionIdentityKey string   `json:"admissionIdentityKey,omitempty"`
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

// errNonCanonicalVarInt is a CompactSize written wider than its value needs; TS refuses it, so Go does too.
var errNonCanonicalVarInt = errors.New("non-canonical varInt")

// readVarInt reads a canonical Bitcoin CompactSize (little-endian) from r.
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
		if v < 0xfd {
			return 0, errNonCanonicalVarInt
		}
		return uint64(v), nil
	case 0xfe:
		var v uint32
		if err := binary.Read(r, binary.LittleEndian, &v); err != nil {
			return 0, err
		}
		if v <= 0xffff {
			return 0, errNonCanonicalVarInt
		}
		return uint64(v), nil
	case 0xff:
		var v uint64
		if err := binary.Read(r, binary.LittleEndian, &v); err != nil {
			return 0, err
		}
		if v <= 0xffffffff {
			return 0, errNonCanonicalVarInt
		}
		return v, nil
	default:
		return uint64(first), nil
	}
}

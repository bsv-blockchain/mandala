package mandala

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// AdmissionsCollection is the Mongo collection name, identical on both
// engines (wire contract §4; the TS overlay's is also `mandalaAdmissions`).
const AdmissionsCollection = "mandalaAdmissions"

// RestoreSnapshot is the pre-spend state of everything one submitted
// transaction consumed, captured at admission time so eviction can be the
// exact inverse of admission long after the submitting request is gone
// (FIX E). It is the same data the pre-Submit broadcast-failure compensation
// already snapshots — persisted here instead of living only in a closure.
type RestoreSnapshot struct {
	// SpentOutpoints are the "<txid>.<vout>" inputs this transaction marked
	// spent. The engine-side unmark is keyed on spendTxid, so this list is
	// bookkeeping/audit rather than the unmark's input; it is persisted
	// because the wire contract pins it and because it is what tells an
	// operator which coins an eviction was supposed to hand back.
	SpentOutpoints []string `bson:"spentOutpoints" json:"spentOutpoints"`
	// TokenRows is the pre-spend mandalaTokens snapshot RestoreTokens feeds on.
	TokenRows []TokenRow `bson:"tokenRows" json:"tokenRows"`
}

// EvictionOutcome is what one eviction hands back for the /arc-ingest
// terminal-status body (wire contract §9.12). The counts are what was actually
// restored, not what was attempted, so an operator reading the callback log —
// or the Arcade response itself — can tell a real unwind from the idempotent
// repeat Arcade is entitled to send. It lives here, in the domain package,
// rather than in httpapi because wiring (which produces it) cannot import
// httpapi: httpapi imports wiring.
type EvictionOutcome struct {
	// RestoredOutpoints is the number of engine-side spend marks THIS call
	// unmarked — 0 on an idempotent repeat, because the restore runs first and
	// a previous attempt already handed those coins back.
	RestoredOutpoints int `json:"restoredOutpoints"`
	// RestoredTokenRows is the number of mandala token rows replayed from the
	// admission record's snapshot.
	RestoredTokenRows int `json:"restoredTokenRows"`
	// AlreadyEvicted reports that this txid carried an eviction stamp before
	// this callback.
	AlreadyEvicted bool `json:"alreadyEvicted"`
}

// AdmissionRecord is the overlay-internal admission row (wire contract §4,
// spec §2.4). Exactly one of the admission fields / refusedCode / evictedAt
// groups is meaningful at a time, and the FIRST final verdict for a txid is
// the one every later submitter sees ("verdict wins").
//
// refusedDescription and refusedSpendTxid are additive to the contract's
// field list: the re-served 400 must carry the same description and the same
// ERR_INPUT_SPENT competitor as the original refusal did, and re-deriving
// either from the code alone would drift between engines.
type AdmissionRecord struct {
	Txid                 string   `bson:"txid" json:"txid"`
	Topics               []string `bson:"topics" json:"topics"`
	OutputsToAdmit       []uint32 `bson:"outputsToAdmit" json:"outputsToAdmit"`
	AdmissionSignature   string   `bson:"admissionSignature" json:"admissionSignature"`
	AdmissionIdentityKey string   `bson:"admissionIdentityKey" json:"admissionIdentityKey"`
	At                   string   `bson:"at" json:"at"`

	RefusedCode        string `bson:"refusedCode,omitempty" json:"refusedCode,omitempty"`
	RefusedDescription string `bson:"refusedDescription,omitempty" json:"refusedDescription,omitempty"`
	RefusedSpendTxid   string `bson:"refusedSpendTxid,omitempty" json:"refusedSpendTxid,omitempty"`
	RefusedAt          string `bson:"refusedAt,omitempty" json:"refusedAt,omitempty"`
	// RefusedPayloadHash scopes the persisted refusal to the exact off-chain
	// payload it was earned with (wire contract §9.1): sha256 of the
	// offChainValues bytes as submitted, lowercase hex, sha256("") for an
	// absent payload. The txid does NOT commit to the off-chain payload, so a
	// refusal keyed by txid alone let any holder of the BEEF poison a
	// transaction permanently by submitting it without its linkage payload.
	RefusedPayloadHash string `bson:"refusedPayloadHash,omitempty" json:"refusedPayloadHash,omitempty"`
	EvictedAt          string `bson:"evictedAt,omitempty" json:"evictedAt,omitempty"`

	// Pending marks the PROVISIONAL record written before the engine mutates
	// anything (wire contract §9.4). It carries the restore snapshot and
	// nothing else; a crash between it and the finalize leaves a row the dupe
	// path completes from the engine's own applied proof.
	Pending bool `bson:"pending,omitempty" json:"pending,omitempty"`

	Restore *RestoreSnapshot `bson:"restore,omitempty" json:"restore,omitempty"`
}

// Admitted reports whether this record carries a FINAL token admission (as
// opposed to a provisional row, a refusal or an eviction stamp).
func (r *AdmissionRecord) Admitted() bool {
	return r != nil && !r.Pending && r.EvictedAt == "" && r.RefusedCode == "" && len(r.OutputsToAdmit) > 0
}

// Refusal is one FINAL refusal verdict as persisted on the admission record.
// PayloadHash is what scopes it (§9.1); an empty one would apply the refusal
// to every payload, which is exactly the poisoning this field exists to stop,
// so callers always pass PayloadHashHex's output.
type Refusal struct {
	Txid        string
	Code        string
	Description string
	SpendTxid   string
	PayloadHash string
}

// IsoStamp renders a timestamp exactly the way JavaScript's
// Date#toISOString does (UTC, millisecond precision, trailing Z), so both
// engines' `at`/`refusedAt`/`evictedAt` strings are the same shape.
func IsoStamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// RecordAdmission persists an admission record for txid, in either of wire
// contract §9.4's two shapes:
//
//   - rec.Pending: the PROVISIONAL row, written before the engine mutates
//     anything ({txid, topics, restore, at, pending:true}). Its whole job is to
//     make the restore snapshot durable before the inputs are marked spent, so
//     a crash mid-Submit cannot strand them.
//   - otherwise: the FINALIZE, written SYNCHRONOUSLY before /submit answers
//     200 — so a client that received a signature is guaranteed the record is
//     readable on its very next GET /admin/admission/:txid — which also clears
//     any refusal fields the row carried (§9.1: an admission of a txid wipes a
//     refusal earned by a different payload).
//
// Neither shape can overwrite an eviction stamp, and the provisional shape
// cannot overwrite an existing admission: the conditional filter turns those
// into a no-op (the unique-txid upsert collision is that signal, not a
// failure).
func (s *Store) RecordAdmission(ctx context.Context, rec AdmissionRecord) error {
	if rec.At == "" {
		rec.At = IsoStamp(time.Now())
	}
	filter := bson.D{
		{Key: "txid", Value: rec.Txid},
		{Key: "evictedAt", Value: bson.D{{Key: "$exists", Value: false}}},
	}
	set := bson.D{
		{Key: "txid", Value: rec.Txid},
		{Key: "topics", Value: nonNilStrings(rec.Topics)},
		{Key: "at", Value: rec.At},
	}
	if rec.Restore != nil {
		set = append(set, bson.E{Key: "restore", Value: rec.Restore})
	}
	update := bson.D{}
	if rec.Pending {
		filter = append(filter, bson.E{Key: "admissionSignature", Value: bson.D{{Key: "$exists", Value: false}}})
		set = append(set, bson.E{Key: "pending", Value: true})
	} else {
		set = append(set,
			bson.E{Key: "outputsToAdmit", Value: nonNilUint32s(rec.OutputsToAdmit)},
			bson.E{Key: "admissionSignature", Value: rec.AdmissionSignature},
			bson.E{Key: "admissionIdentityKey", Value: rec.AdmissionIdentityKey},
			bson.E{Key: "pending", Value: false})
		update = append(update, bson.E{Key: "$unset", Value: bson.D{
			{Key: "refusedCode", Value: ""},
			{Key: "refusedDescription", Value: ""},
			{Key: "refusedSpendTxid", Value: ""},
			{Key: "refusedAt", Value: ""},
			{Key: "refusedPayloadHash", Value: ""},
		}})
	}
	update = append(update, bson.E{Key: "$set", Value: set})
	_, err := s.admissions.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return nil // an eviction (or, for a provisional row, an admission) already stands
	}
	return err
}

// GetAdmission returns the record for txid, or (nil, nil) when none exists.
func (s *Store) GetAdmission(ctx context.Context, txid string) (*AdmissionRecord, error) {
	var rec AdmissionRecord
	err := s.admissions.FindOne(ctx, bson.D{{Key: "txid", Value: txid}}).Decode(&rec)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

// MarkRefused persists a FINAL refusal verdict for txid, scoped to the payload
// it was earned with (wire contract §9.1).
//
// "Verdict wins" is now per (txid, payloadHash), not per txid: a LATER refusal
// overwrites the refusal fields, because the transaction may have been
// evaluated fresh under a different payload and lost for a different reason —
// and the record must describe the refusal that is actually replayable. What
// it still cannot overwrite is an admission or an eviction; the conditional
// filter makes those a no-op, and the upsert's duplicate-key collision on the
// unique txid index is exactly that no-op signal, not a failure.
//
// SpendTxid is the competing transaction for an ERR_INPUT_SPENT verdict — which
// §9.2 forbids persisting at all, so in practice it is always empty here; the
// field is kept because the record shape is part of the contract and because
// nothing in this layer should silently depend on a caller-side rule.
func (s *Store) MarkRefused(ctx context.Context, r Refusal) error {
	set := bson.D{
		{Key: "txid", Value: r.Txid},
		{Key: "refusedCode", Value: r.Code},
		{Key: "refusedDescription", Value: r.Description},
		{Key: "refusedPayloadHash", Value: r.PayloadHash},
		{Key: "refusedAt", Value: IsoStamp(time.Now())},
	}
	if r.SpendTxid != "" {
		set = append(set, bson.E{Key: "refusedSpendTxid", Value: r.SpendTxid})
	}
	_, err := s.admissions.UpdateOne(ctx,
		bson.D{
			{Key: "txid", Value: r.Txid},
			{Key: "evictedAt", Value: bson.D{{Key: "$exists", Value: false}}},
			{Key: "admissionSignature", Value: bson.D{{Key: "$exists", Value: false}}},
		},
		bson.D{{Key: "$set", Value: set}},
		options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return nil // an admission or eviction already stands for this txid
	}
	return err
}

// PayloadHashHex is wire contract §9.1's payload identity: sha256 over the
// off-chain values EXACTLY as submitted, lowercase hex. An absent or empty
// payload hashes the empty byte string, so "no payload" is itself a stable,
// comparable identity rather than a wildcard.
func PayloadHashHex(offChainValues []byte) string {
	sum := sha256.Sum256(offChainValues)
	return hex.EncodeToString(sum[:])
}

// MarkEvicted stamps evictedAt on txid's record, creating one if the
// admission predates this feature or was lost. The stamp is written once —
// a repeat eviction keeps the original timestamp — and makes the ERR_EVICTED
// verdict permanent for these bytes (FIX E).
func (s *Store) MarkEvicted(ctx context.Context, txid string) error {
	_, err := s.admissions.UpdateOne(ctx,
		bson.D{
			{Key: "txid", Value: txid},
			{Key: "evictedAt", Value: bson.D{{Key: "$exists", Value: false}}},
		},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "txid", Value: txid},
			{Key: "evictedAt", Value: IsoStamp(time.Now())},
		}}},
		options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return nil // already evicted
	}
	return err
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func nonNilUint32s(s []uint32) []uint32 {
	if s == nil {
		return []uint32{}
	}
	return s
}

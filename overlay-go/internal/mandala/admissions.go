package mandala

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// AdmissionDigestPrefixV3 is the σI v3 message prefix (TT A1.2). Digest v2 (no topic) is gone.
const AdmissionDigestPrefixV3 = "mandala-admit:v3:"

// ErrNoAdmittedOutputs: no admitted outputs means no signature (a topic that admitted nothing
// carries no σI).
var ErrNoAdmittedOutputs = errors.New("admission: no admitted outputs to sign over")

// CanonicalOutputs is the one canonical form of an admitted output set: ascending, deduplicated;
// nil when empty. The digest, the record and the wire all use it.
func CanonicalOutputs(outs []uint32) []uint32 {
	if len(outs) == 0 {
		return nil
	}
	sorted := slices.Clone(outs)
	slices.Sort(sorted)
	return slices.Compact(sorted)
}

// AdmissionDigestV3 is SHA-256("mandala-admit:v3:" + topic + ":" + txid + ":" + join(canonical
// outputsToAdmit, ",")) (TT A1.2). The topic binds the signature: a deploy's tm_mandala and
// tm_<id> σI differ although both admit [0].
func AdmissionDigestV3(topic, txid string, outputsToAdmit []uint32) ([32]byte, error) {
	canonical := CanonicalOutputs(outputsToAdmit)
	if len(canonical) == 0 {
		return [32]byte{}, ErrNoAdmittedOutputs
	}
	parts := make([]string, len(canonical))
	for i, v := range canonical {
		parts[i] = strconv.FormatUint(uint64(v), 10)
	}
	return sha256.Sum256([]byte(AdmissionDigestPrefixV3 + topic + ":" + txid + ":" + strings.Join(parts, ","))), nil
}

// AdmissionSigner produces σI for one topic's admission.
type AdmissionSigner interface {
	SignAdmission(topic, txid string, outputsToAdmit []uint32) (sigDERHex, identityKeyHex string, err error)
}

// ECAdmissionSigner signs with the overlay identity key. Signing is RFC6979, so re-signing an
// admission (the dupe path) reproduces byte-identical σI.
type ECAdmissionSigner struct {
	priv *ec.PrivateKey
}

var _ AdmissionSigner = (*ECAdmissionSigner)(nil)

// NewECAdmissionSigner parses the overlay's hex private key.
func NewECAdmissionSigner(privHex string) (*ECAdmissionSigner, error) {
	priv, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		return nil, fmt.Errorf("admission signer: %w", err)
	}
	return &ECAdmissionSigner{priv: priv}, nil
}

// SignAdmission returns the DER hex signature over AdmissionDigestV3(topic, txid, outputs) and the
// compressed identity key hex; an empty output set is ErrNoAdmittedOutputs.
func (s *ECAdmissionSigner) SignAdmission(topic, txid string, outputsToAdmit []uint32) (string, string, error) {
	if s == nil || s.priv == nil {
		return "", "", errors.New("admission signer: nil")
	}
	digest, err := AdmissionDigestV3(topic, txid, outputsToAdmit)
	if err != nil {
		return "", "", err
	}
	sig, err := s.priv.Sign(digest[:])
	if err != nil {
		return "", "", err
	}
	der, err := sig.ToDER()
	if err != nil {
		return "", "", err
	}
	return hex.EncodeToString(der), hex.EncodeToString(s.priv.PubKey().Compressed()), nil
}

// VerifyAdmission checks a σI against the v3 digest of (topic, txid, outputs). A malformed
// signature, key or empty set is an error; a well-formed signature that does not verify is false.
func VerifyAdmission(topic, txid string, outputsToAdmit []uint32, sigDERHex, identityKeyHex string) (bool, error) {
	digest, err := AdmissionDigestV3(topic, txid, outputsToAdmit)
	if err != nil {
		return false, err
	}
	der, err := hex.DecodeString(sigDERHex)
	if err != nil {
		return false, fmt.Errorf("admission signature: %w", err)
	}
	sig, err := ec.FromDER(der)
	if err != nil {
		return false, fmt.Errorf("admission signature: %w", err)
	}
	pub, err := ec.PublicKeyFromString(identityKeyHex)
	if err != nil {
		return false, fmt.Errorf("admission identity key: %w", err)
	}
	return sig.Verify(digest[:], pub), nil
}

// TopicAdmission is one topic's entry in the admission record: its admitted outputs (canonical)
// and its σI.
type TopicAdmission struct {
	OutputsToAdmit     []uint32 `bson:"outputsToAdmit" json:"outputsToAdmit"`
	AdmissionSignature string   `bson:"admissionSignature" json:"admissionSignature"`
}

// RestoreSnapshot is every input "<txid>.<vout>" a transaction spent, recorded before the engine
// marks them (wire contract §9.4). Owners are not snapshotted: eviction restores rows from the
// journal (plan D-7), so the legacy tokenRows field is dropped (a stored one is ignored on read).
type RestoreSnapshot struct {
	SpentOutpoints []string `bson:"spentOutpoints" json:"spentOutpoints"`
}

// EvictionOutcome is what one eviction reports to /arc-ingest (wire contract §9.12).
type EvictionOutcome struct {
	RestoredOutpoints int  `json:"restoredOutpoints"`
	RestoredTokenRows int  `json:"restoredTokenRows"`
	AlreadyEvicted    bool `json:"alreadyEvicted"`
}

// AdmissionRecord is the one mandalaAdmissions row of a txid (TT A1.2): a per-topic admission map
// with one admissionIdentityKey, or a persisted refusal, or an eviction stamp; plus the provisional
// flag and the restore snapshot.
type AdmissionRecord struct {
	Txid                 string                    `bson:"txid"`
	Topics               []string                  `bson:"topics"`
	Admissions           map[string]TopicAdmission `bson:"admissions,omitempty"`
	AdmissionIdentityKey string                    `bson:"admissionIdentityKey,omitempty"`
	At                   string                    `bson:"at"`
	RefusedCode          string                    `bson:"refusedCode,omitempty"`
	RefusedDescription   string                    `bson:"refusedDescription,omitempty"`
	RefusedSpendTxid     string                    `bson:"refusedSpendTxid,omitempty"`
	RefusedAt            string                    `bson:"refusedAt,omitempty"`
	RefusedPayloadHash   string                    `bson:"refusedPayloadHash,omitempty"`
	RefusedTopic         string                    `bson:"refusedTopic,omitempty"` // V-6
	EvictedAt            string                    `bson:"evictedAt,omitempty"`
	Pending              bool                      `bson:"pending,omitempty"`
	Restore              *RestoreSnapshot          `bson:"restore,omitempty"`
}

// Admitted reports a final admission: not provisional, not evicted, not refused, and at least one
// topic entry.
func (r *AdmissionRecord) Admitted() bool {
	return r != nil && !r.Pending && r.EvictedAt == "" && r.RefusedCode == "" && len(r.Admissions) > 0
}

// Refusal is one final refusal to persist (A1.3), scoped to the payload it was earned with.
type Refusal struct{ Txid, Code, Description, SpendTxid, PayloadHash, Topic string }

// MergeRestoreSnapshot is §9.4's "the snapshot only grows" (TS mergeRestore): the union of
// spentOutpoints, deduplicated by the lowercased outpoint, first-seen order kept (existing first),
// spelling as first seen. nil + nil = nil; otherwise SpentOutpoints is non-nil.
func MergeRestoreSnapshot(existing, incoming *RestoreSnapshot) *RestoreSnapshot {
	if existing == nil && incoming == nil {
		return nil
	}
	out := &RestoreSnapshot{SpentOutpoints: []string{}}
	seen := map[string]bool{}
	for _, src := range []*RestoreSnapshot{existing, incoming} {
		if src == nil {
			continue
		}
		for _, op := range src.SpentOutpoints {
			key := strings.ToLower(op)
			if seen[key] {
				continue
			}
			seen[key] = true
			out.SpentOutpoints = append(out.SpentOutpoints, op)
		}
	}
	return out
}

// PayloadHashHex is sha256 of the off-chain values exactly as submitted, lowercase hex; an absent
// payload hashes "" (wire contract §9.1).
func PayloadHashHex(offChainValues []byte) string {
	sum := sha256.Sum256(offChainValues)
	return hex.EncodeToString(sum[:])
}

// IsoStamp renders t like JavaScript Date#toISOString (UTC, milliseconds, trailing Z).
func IsoStamp(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

func admNotExists() bson.D { return bson.D{{Key: "$exists", Value: false}} }

// admKeyOK refuses a topic that cannot key the admissions map (a "." would nest, a "$" would
// be an operator).
func admKeyOK(topic string) error {
	if topic == "" || strings.ContainsAny(topic, ".$") {
		return fmt.Errorf("admission record: topic %q cannot key the admissions map", topic)
	}
	return nil
}

func admAddTopics(topics []string) bson.D {
	each := topics
	if each == nil {
		each = []string{}
	}
	return bson.D{{Key: "topics", Value: bson.D{{Key: "$each", Value: each}}}}
}

// guardedUpsert runs an upsert whose filter guards on more than the unique txid. MongoDB retries a
// duplicate-key upsert only for a pure-equality filter, so a guarded upsert that loses an insert race
// to another writer of the same txid sees E11000. The record exists then, so the update is re-run
// without upsert: it applies when the guard still admits the record and is a no-op when the guard
// excludes it (an eviction or an admission that must stand).
func (s *Store) guardedUpsert(ctx context.Context, filter, update bson.D) error {
	_, err := s.admissions.UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	if !mongo.IsDuplicateKeyError(err) {
		return err
	}
	_, err = s.admissions.UpdateOne(ctx, filter, update)
	return err
}

// RecordAdmission writes a txid's record in one of two shapes.
//
// Provisional (rec.Pending): written before the engine mutates anything, to make rec.Restore
// durable. An evicted record is left alone. Otherwise the stored snapshot is merged with
// rec.Restore and the topics are added. A record that already holds an admission is never set
// pending (D-8: a retry naming another topic must not hide the admission it already has); any
// other record, or none, becomes {pending: true}. A finalize or eviction that lands between the
// read and the write turns the write into a duplicate-key no-op, so it is re-read once and written
// in the other shape.
//
// Finalize (!rec.Pending): $set "admissions.<topic>" for every topic of rec.Admissions with at
// least one output (other topics' entries are never replaced), admissionIdentityKey, pending:false
// and the merged snapshot; add the topics; clear every refused* field; never over an eviction.
// Every write that inserts a record takes its txid from the filter's equality.
func (s *Store) RecordAdmission(ctx context.Context, rec AdmissionRecord) error {
	if rec.At == "" {
		rec.At = IsoStamp(time.Now())
	}
	if rec.Pending {
		return s.recordProvisional(ctx, rec)
	}
	return s.recordFinal(ctx, rec)
}

func (s *Store) recordProvisional(ctx context.Context, rec AdmissionRecord) error {
	for attempt := 0; attempt < 3; attempt++ {
		prior, err := s.GetAdmission(ctx, rec.Txid)
		if err != nil {
			return err
		}
		if prior != nil && prior.EvictedAt != "" {
			return nil
		}
		var stored *RestoreSnapshot
		if prior != nil {
			stored = prior.Restore
		}
		merged := MergeRestoreSnapshot(stored, rec.Restore)
		if prior != nil && len(prior.Admissions) > 0 {
			update := bson.D{{Key: "$addToSet", Value: admAddTopics(rec.Topics)}}
			if merged != nil {
				update = append(update, bson.E{Key: "$set", Value: bson.D{{Key: "restore", Value: merged}}})
			}
			_, err := s.admissions.UpdateOne(ctx, bson.D{{Key: "txid", Value: rec.Txid}, {Key: "evictedAt", Value: admNotExists()}}, update)
			return err
		}
		set := bson.D{{Key: "pending", Value: true}}
		if merged != nil {
			set = append(set, bson.E{Key: "restore", Value: merged})
		}
		_, err = s.admissions.UpdateOne(ctx,
			bson.D{{Key: "txid", Value: rec.Txid}, {Key: "evictedAt", Value: admNotExists()}, {Key: "admissions", Value: admNotExists()}},
			bson.D{
				{Key: "$set", Value: set},
				{Key: "$addToSet", Value: admAddTopics(rec.Topics)},
				{Key: "$setOnInsert", Value: bson.D{{Key: "at", Value: rec.At}}},
			},
			options.UpdateOne().SetUpsert(true))
		if !mongo.IsDuplicateKeyError(err) {
			return err
		}
		// An admission or eviction landed after the read: re-read and take the other shape.
	}
	return nil
}

func (s *Store) recordFinal(ctx context.Context, rec AdmissionRecord) error {
	set := bson.D{{Key: "pending", Value: false}}
	for _, topic := range slices.Sorted(maps.Keys(rec.Admissions)) {
		entry := rec.Admissions[topic]
		outs := CanonicalOutputs(entry.OutputsToAdmit)
		if len(outs) == 0 {
			continue
		}
		if err := admKeyOK(topic); err != nil {
			return err
		}
		set = append(set, bson.E{Key: "admissions." + topic, Value: TopicAdmission{OutputsToAdmit: outs, AdmissionSignature: entry.AdmissionSignature}})
	}
	if rec.AdmissionIdentityKey != "" {
		set = append(set, bson.E{Key: "admissionIdentityKey", Value: rec.AdmissionIdentityKey})
	}
	if rec.Restore != nil {
		prior, err := s.GetAdmission(ctx, rec.Txid)
		if err != nil {
			return err
		}
		var stored *RestoreSnapshot
		if prior != nil {
			stored = prior.Restore
		}
		set = append(set, bson.E{Key: "restore", Value: MergeRestoreSnapshot(stored, rec.Restore)})
	}
	return s.guardedUpsert(ctx,
		bson.D{{Key: "txid", Value: rec.Txid}, {Key: "evictedAt", Value: admNotExists()}},
		bson.D{
			{Key: "$set", Value: set},
			{Key: "$addToSet", Value: admAddTopics(rec.Topics)},
			{Key: "$unset", Value: bson.D{
				{Key: "refusedCode", Value: ""},
				{Key: "refusedDescription", Value: ""},
				{Key: "refusedSpendTxid", Value: ""},
				{Key: "refusedAt", Value: ""},
				{Key: "refusedPayloadHash", Value: ""},
				{Key: "refusedTopic", Value: ""},
			}},
			{Key: "$setOnInsert", Value: bson.D{{Key: "at", Value: rec.At}}},
		})
}

// GetAdmission reads a txid's record, nil when it has none.
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

// MarkRefused persists a final refusal (A1.3) unless the record holds an admission or an eviction. A later refusal replaces an earlier
// one: the replayable refusal is the latest fresh evaluation (wire contract §9.1). spendTxid and
// topic are unset when empty, so no field of an older refusal survives.
func (s *Store) MarkRefused(ctx context.Context, r Refusal) error {
	set := bson.D{
		{Key: "refusedCode", Value: r.Code},
		{Key: "refusedDescription", Value: r.Description},
		{Key: "refusedPayloadHash", Value: r.PayloadHash},
		{Key: "refusedAt", Value: IsoStamp(time.Now())},
	}
	unset := bson.D{}
	for _, f := range []struct{ key, value string }{{"refusedSpendTxid", r.SpendTxid}, {"refusedTopic", r.Topic}} {
		if f.value != "" {
			set = append(set, bson.E{Key: f.key, Value: f.value})
		} else {
			unset = append(unset, bson.E{Key: f.key, Value: ""})
		}
	}
	update := bson.D{
		{Key: "$set", Value: set},
		{Key: "$setOnInsert", Value: bson.D{{Key: "at", Value: IsoStamp(time.Now())}}},
	}
	if len(unset) > 0 {
		update = append(update, bson.E{Key: "$unset", Value: unset})
	}
	return s.guardedUpsert(ctx,
		bson.D{{Key: "txid", Value: r.Txid}, {Key: "evictedAt", Value: admNotExists()}, {Key: "admissions", Value: admNotExists()}},
		update)
}

// MarkEvicted stamps evictedAt once (a repeat keeps the first stamp), creating the record when the
// txid has none: the ERR_EVICTED verdict is permanent for these bytes.
func (s *Store) MarkEvicted(ctx context.Context, txid string) error {
	return s.guardedUpsert(ctx,
		bson.D{{Key: "txid", Value: txid}, {Key: "evictedAt", Value: admNotExists()}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "evictedAt", Value: IsoStamp(time.Now())}}}})
}

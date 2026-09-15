package mandala

import (
	"context"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const recTxid = "3f0c9a1b2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"

func sampleAdmission() AdmissionRecord {
	return AdmissionRecord{
		Txid:                 recTxid,
		Topics:               []string{"tm_mandala"},
		OutputsToAdmit:       []uint32{0, 2},
		AdmissionSignature:   "3044deadbeef",
		AdmissionIdentityKey: "02" + "ab",
		Restore: &RestoreSnapshot{
			SpentOutpoints: []string{"aa.0"},
			TokenRows: []TokenRow{{
				Txid: "aa", OutputIndex: 0, AssetID: "a.0", Amount: 100,
				IdentityKey: "02cd", CreatedAt: time.Now().UTC().Truncate(time.Millisecond),
			}},
		},
	}
}

func TestAdmissionRecordRoundTripWithRestoreSnapshot(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))

	if got, err := s.GetAdmission(ctx, recTxid); err != nil || got != nil {
		t.Fatalf("unknown txid: got %+v, %v; want nil, nil", got, err)
	}
	if err := s.RecordAdmission(ctx, sampleAdmission()); err != nil {
		t.Fatal("RecordAdmission:", err)
	}
	got, err := s.GetAdmission(ctx, recTxid)
	if err != nil || got == nil {
		t.Fatalf("GetAdmission: %+v %v", got, err)
	}
	if got.At == "" {
		t.Fatal("at must be stamped by the store")
	}
	if len(got.OutputsToAdmit) != 2 || got.OutputsToAdmit[0] != 0 || got.OutputsToAdmit[1] != 2 {
		t.Fatalf("outputsToAdmit = %v", got.OutputsToAdmit)
	}
	if got.AdmissionSignature != "3044deadbeef" {
		t.Fatalf("signature = %q", got.AdmissionSignature)
	}
	if got.Restore == nil || len(got.Restore.TokenRows) != 1 || got.Restore.TokenRows[0].Amount != 100 {
		t.Fatalf("restore snapshot lost: %+v", got.Restore)
	}
	if len(got.Restore.SpentOutpoints) != 1 || got.Restore.SpentOutpoints[0] != "aa.0" {
		t.Fatalf("restore.spentOutpoints = %v", got.Restore.SpentOutpoints)
	}
}

// The txid index is unique: a concurrent second admission of the same txid
// updates the one row rather than creating a second, divergent verdict.
func TestAdmissionRecordIsUniqueByTxid(t *testing.T) {
	ctx := context.Background()
	db := testDB(t)
	s := mustStore(t, db)
	if err := s.RecordAdmission(ctx, sampleAdmission()); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAdmission(ctx, sampleAdmission()); err != nil {
		t.Fatal("re-recording the same txid must be idempotent:", err)
	}
	n, err := db.Collection("mandalaAdmissions").CountDocuments(ctx, bson.D{{Key: "txid", Value: recTxid}})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows for txid = %d, want 1", n)
	}
	if _, err := db.Collection("mandalaAdmissions").InsertOne(ctx, bson.D{{Key: "txid", Value: recTxid}}); err == nil {
		t.Fatal("a raw duplicate insert must violate the unique index on txid")
	}
}

// §9.1 — a refusal is recorded against the payload that earned it, and a later
// refusal (necessarily a fresh evaluation, since a matching-payload resubmit
// never reaches the engine) overwrites it. What must be replayable is the
// refusal that is actually re-derivable, not the first one ever seen.
func TestMarkRefusedIsPayloadScopedAndLatestWins(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	hashA := PayloadHashHex([]byte(`{"outputs":[]}`))
	hashB := PayloadHashHex(nil)

	if err := s.MarkRefused(ctx, Refusal{
		Txid: recTxid, Code: "ERR_CONSERVATION", Description: "conservation violated", PayloadHash: hashA,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkRefused(ctx, Refusal{
		Txid: recTxid, Code: "ERR_LINKAGE", Description: "output 0: ... no verified linkage", PayloadHash: hashB,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetAdmission(ctx, recTxid)
	if err != nil || got == nil {
		t.Fatalf("GetAdmission: %+v %v", got, err)
	}
	if got.RefusedCode != "ERR_LINKAGE" || got.RefusedPayloadHash != hashB {
		t.Fatalf("refusal = %s/%s, want the latest one scoped to its own payload", got.RefusedCode, got.RefusedPayloadHash)
	}
	if got.RefusedAt == "" {
		t.Fatal("refusedAt must be stamped")
	}
}

// The competing txid is persisted when a caller asks for it — the caller-side
// rule (§9.2: /submit never persists ERR_INPUT_SPENT at all) is enforced in
// httpapi, and this layer stays honest about what it was told to write.
func TestMarkRefusedPersistsTheCompetingSpendTxid(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	competitor := "cd" + recTxid[2:]
	if err := s.MarkRefused(ctx, Refusal{
		Txid: recTxid, Code: "ERR_INPUT_SPENT",
		Description: "input aa.0 already spent by " + competitor,
		SpendTxid:   competitor, PayloadHash: PayloadHashHex(nil),
	}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetAdmission(ctx, recTxid)
	if got == nil || got.RefusedSpendTxid != competitor {
		t.Fatalf("refusedSpendTxid = %+v, want %s", got, competitor)
	}
}

func TestMarkRefusedNeverOverwritesAnAdmission(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	if err := s.RecordAdmission(ctx, sampleAdmission()); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkRefused(ctx, Refusal{
		Txid: recTxid, Code: "ERR_SHAPE", Description: "late refusal", PayloadHash: PayloadHashHex(nil),
	}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetAdmission(ctx, recTxid)
	if got.RefusedCode != "" {
		t.Fatalf("an admitted record was overwritten by a refusal: %+v", got)
	}
	if got.AdmissionSignature == "" {
		t.Fatal("admission fields lost")
	}
}

// §9.1 — an admission CLEARS the refusal fields: the same bytes with the right
// payload are admissible, and nothing on the record may keep claiming
// otherwise.
func TestRecordAdmissionClearsAnEarlierRefusal(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	if err := s.MarkRefused(ctx, Refusal{
		Txid: recTxid, Code: "ERR_LINKAGE", Description: "stripped payload",
		PayloadHash: PayloadHashHex(nil),
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAdmission(ctx, sampleAdmission()); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetAdmission(ctx, recTxid)
	if got.RefusedCode != "" || got.RefusedDescription != "" || got.RefusedPayloadHash != "" || got.RefusedAt != "" {
		t.Fatalf("admission did not clear the refusal fields: %+v", got)
	}
	if !got.Admitted() {
		t.Fatalf("record is not admitted after RecordAdmission: %+v", got)
	}
}

// §9.4 — the provisional row carries the restore snapshot and nothing else; it
// is not an admission until it is finalized, and it can never clobber one.
func TestProvisionalRecordIsPendingUntilFinalized(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	provisional := AdmissionRecord{
		Txid:    recTxid,
		Topics:  []string{"tm_mandala"},
		Pending: true,
		Restore: sampleAdmission().Restore,
	}
	if err := s.RecordAdmission(ctx, provisional); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetAdmission(ctx, recTxid)
	if got == nil || !got.Pending {
		t.Fatalf("provisional row not marked pending: %+v", got)
	}
	if got.Admitted() {
		t.Fatal("a pending row must not read as an admission")
	}
	if got.Restore == nil || len(got.Restore.TokenRows) != 1 {
		t.Fatalf("the restore snapshot must be durable before Submit: %+v", got.Restore)
	}

	if err := s.RecordAdmission(ctx, sampleAdmission()); err != nil {
		t.Fatal(err)
	}
	final, _ := s.GetAdmission(ctx, recTxid)
	if final.Pending || !final.Admitted() {
		t.Fatalf("finalize left the row pending: %+v", final)
	}

	// A provisional write arriving after the finalize (a racing retry) must
	// not undo it.
	if err := s.RecordAdmission(ctx, provisional); err != nil {
		t.Fatal(err)
	}
	after, _ := s.GetAdmission(ctx, recTxid)
	if after.Pending || !after.Admitted() {
		t.Fatalf("a late provisional write clobbered the admission: %+v", after)
	}
}

func TestMarkEvictedStampsOnceAndSurvivesOnARecordlessTxid(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	if err := s.RecordAdmission(ctx, sampleAdmission()); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkEvicted(ctx, recTxid); err != nil {
		t.Fatal(err)
	}
	first, _ := s.GetAdmission(ctx, recTxid)
	if first.EvictedAt == "" {
		t.Fatal("evictedAt not stamped")
	}
	if err := s.MarkEvicted(ctx, recTxid); err != nil {
		t.Fatal(err)
	}
	second, _ := s.GetAdmission(ctx, recTxid)
	if second.EvictedAt != first.EvictedAt {
		t.Fatalf("evictedAt re-stamped: %q -> %q", first.EvictedAt, second.EvictedAt)
	}

	// An eviction of a txid with no record at all still leaves the permanent
	// ERR_EVICTED verdict behind (Go admissions predating this feature, or a
	// crash-lost record).
	other := "aa" + recTxid[2:]
	if err := s.MarkEvicted(ctx, other); err != nil {
		t.Fatal(err)
	}
	rec, err := s.GetAdmission(ctx, other)
	if err != nil || rec == nil || rec.EvictedAt == "" {
		t.Fatalf("eviction of a recordless txid: %+v %v", rec, err)
	}
}

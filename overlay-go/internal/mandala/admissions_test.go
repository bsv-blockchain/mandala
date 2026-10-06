package mandala

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

const admTxid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

var (
	admTopicA = "tm_" + strings.Repeat("a", 64)
	admTopicB = "tm_" + strings.Repeat("b", 64)
)

func admissionStore(t *testing.T) (*Store, *mongo.Database) {
	t.Helper()
	db := testmongo.DB(t, "mandala3_test_admissions")
	return mustStore(t, db), db
}

// The verified vectors of the Global Constraints (TT A1.2).
func TestAdmissionDigestV3Vectors(t *testing.T) {
	for _, c := range []struct {
		topic string
		outs  []uint32
		want  string
	}{
		{"tm_mandala", []uint32{0}, "2dd76e2fbb8234967159f842f463b58bd0a76efcc49e7c8372bdbc8a9931db5c"},
		{"tm_" + admTxid, []uint32{0}, "654768162ffd1d0011e33cff4f8e553cf34a159c6006e627f4987f57c2891d0d"},
		{"tm_" + admTxid, []uint32{1, 0, 1}, "d75c8da798a7347ef623e57cc827c3188c36acd8e84f9b9f69f531d1ebe335b1"},
	} {
		got, err := AdmissionDigestV3(c.topic, admTxid, c.outs)
		if err != nil || hex.EncodeToString(got[:]) != c.want {
			t.Fatalf("%s %v: %x %v, want %s", c.topic, c.outs, got, err, c.want)
		}
	}
	want := sha256.Sum256([]byte("mandala-admit:v3:" + admTopicA + ":" + admTxid + ":2,10"))
	if got, _ := AdmissionDigestV3(admTopicA, admTxid, []uint32{10, 2, 10}); got != want {
		t.Fatal("indexes are decimal, ascending and deduplicated")
	}
	for _, outs := range [][]uint32{nil, {}} {
		if _, err := AdmissionDigestV3(admTopicA, admTxid, outs); !errors.Is(err, ErrNoAdmittedOutputs) {
			t.Fatalf("empty set: %v", err)
		}
	}
	if got := CanonicalOutputs([]uint32{3, 0, 3, 1}); len(got) != 3 || got[0] != 0 || got[2] != 3 {
		t.Fatalf("canonical = %v", got)
	}
	if CanonicalOutputs(nil) != nil || CanonicalOutputs([]uint32{}) != nil {
		t.Fatal("an empty set is nil")
	}
}

func TestSignAndVerifyAdmissionPerTopic(t *testing.T) {
	privHex := strings.Repeat("0a", 32)
	s, err := NewECAdmissionSigner(privHex)
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := ec.PrivateKeyFromHex(privHex)
	sig, key, err := s.SignAdmission(admTopicA, admTxid, []uint32{2, 0})
	if err != nil {
		t.Fatal(err)
	}
	if key != hex.EncodeToString(priv.PubKey().Compressed()) {
		t.Fatalf("identity key %s", key)
	}
	if ok, err := VerifyAdmission(admTopicA, admTxid, []uint32{0, 2}, sig, key); err != nil || !ok {
		t.Fatalf("own topic: %v %v", ok, err)
	}
	if ok, err := VerifyAdmission(admTopicB, admTxid, []uint32{0, 2}, sig, key); err != nil || ok {
		t.Fatalf("another topic's digest must not verify: %v %v", ok, err)
	}
	if ok, _ := VerifyAdmission(admTopicA, admTxid, []uint32{0}, sig, key); ok {
		t.Fatal("another output set must not verify")
	}
	again, _, _ := s.SignAdmission(admTopicA, admTxid, []uint32{0, 2, 2})
	if again != sig {
		t.Fatal("RFC6979: re-signing the same admission must give the same σI")
	}
	if _, _, err := s.SignAdmission(admTopicA, admTxid, nil); !errors.Is(err, ErrNoAdmittedOutputs) {
		t.Fatalf("empty set: %v", err)
	}
	if _, err := VerifyAdmission(admTopicA, admTxid, []uint32{0}, "zz", key); err == nil {
		t.Fatal("a non-hex signature is an error")
	}
	if _, err := VerifyAdmission(admTopicA, admTxid, []uint32{0}, sig, "02zz"); err == nil {
		t.Fatal("a bad identity key is an error")
	}
	if _, err := NewECAdmissionSigner("not hex"); err == nil {
		t.Fatal("a bad private key is an error")
	}
}

func TestAdmittedTruthTable(t *testing.T) {
	adm := map[string]TopicAdmission{admTopicA: {OutputsToAdmit: []uint32{0}, AdmissionSignature: "30"}}
	for name, c := range map[string]struct {
		rec  *AdmissionRecord
		want bool
	}{
		"nil":           {nil, false},
		"admitted":      {&AdmissionRecord{Admissions: adm}, true},
		"no admissions": {&AdmissionRecord{}, false},
		"pending":       {&AdmissionRecord{Admissions: adm, Pending: true}, false},
		"evicted":       {&AdmissionRecord{Admissions: adm, EvictedAt: "x"}, false},
		"refused":       {&AdmissionRecord{Admissions: adm, RefusedCode: "ERR_SHAPE"}, false},
		"empty map":     {&AdmissionRecord{Admissions: map[string]TopicAdmission{}}, false},
	} {
		if got := c.rec.Admitted(); got != c.want {
			t.Fatalf("%s: Admitted() = %v", name, got)
		}
	}
}

func admFinalize(t *testing.T, s *Store, topic string, outs []uint32, sig string) {
	t.Helper()
	if err := s.RecordAdmission(context.Background(), AdmissionRecord{
		Txid: admTxid, Topics: []string{topic}, AdmissionIdentityKey: "02" + strings.Repeat("ab", 32),
		Admissions: map[string]TopicAdmission{topic: {OutputsToAdmit: outs, AdmissionSignature: sig}},
	}); err != nil {
		t.Fatal(err)
	}
}

func admGet(t *testing.T, s *Store) *AdmissionRecord {
	t.Helper()
	rec, err := s.GetAdmission(context.Background(), admTxid)
	if err != nil || rec == nil {
		t.Fatalf("GetAdmission: %+v %v", rec, err)
	}
	return rec
}

func TestFinalizesOnTwoTopicsMergeIntoOneMap(t *testing.T) {
	s, db := admissionStore(t)
	if rec, err := s.GetAdmission(context.Background(), admTxid); rec != nil || err != nil {
		t.Fatalf("unknown txid: %+v %v", rec, err)
	}
	admFinalize(t, s, admTopicA, []uint32{2, 0, 2}, "30aa")
	admFinalize(t, s, admTopicB, []uint32{1}, "30bb")
	rec := admGet(t, s)
	if !rec.Admitted() || rec.Pending || rec.At == "" || rec.AdmissionIdentityKey == "" {
		t.Fatalf("record: %+v", rec)
	}
	a, b := rec.Admissions[admTopicA], rec.Admissions[admTopicB]
	if len(a.OutputsToAdmit) != 2 || a.OutputsToAdmit[0] != 0 || a.OutputsToAdmit[1] != 2 || a.AdmissionSignature != "30aa" {
		t.Fatalf("topic A entry (stored canonical): %+v", a)
	}
	if len(b.OutputsToAdmit) != 1 || b.AdmissionSignature != "30bb" {
		t.Fatalf("topic B entry: %+v", b)
	}
	if strings.Join(rec.Topics, ",") != admTopicA+","+admTopicB {
		t.Fatalf("topics = %v", rec.Topics)
	}
	admFinalize(t, s, admTopicA, []uint32{0, 2}, "30aa") // a replayed admFinalize changes nothing
	if n, _ := db.Collection(AdmissionsCollection).CountDocuments(context.Background(), bson.D{}); n != 1 {
		t.Fatalf("%d records, want one per txid", n)
	}
	if len(admGet(t, s).Admissions) != 2 {
		t.Fatal("a replayed admFinalize lost an entry")
	}
}

func TestFinalizeWithAnEmptyTopicLeavesTheMapUntouched(t *testing.T) {
	s, _ := admissionStore(t)
	admFinalize(t, s, admTopicA, []uint32{0}, "30aa")
	admFinalize(t, s, admTopicB, nil, "")
	rec := admGet(t, s)
	if len(rec.Admissions) != 1 || rec.Admissions[admTopicA].AdmissionSignature != "30aa" {
		t.Fatalf("map = %+v", rec.Admissions)
	}
	if err := s.RecordAdmission(context.Background(), AdmissionRecord{
		Txid: admTxid, Admissions: map[string]TopicAdmission{"tm.bad": {OutputsToAdmit: []uint32{0}}},
	}); err == nil {
		t.Fatal("a topic containing a dot must not key the map")
	}
}

func TestProvisionalRecord(t *testing.T) {
	ctx := context.Background()
	s, _ := admissionStore(t)
	first := &RestoreSnapshot{SpentOutpoints: []string{"AA.0"}}
	if err := s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA}, Pending: true, Restore: first}); err != nil {
		t.Fatal(err)
	}
	rec := admGet(t, s)
	if !rec.Pending || rec.Admitted() || rec.At == "" || len(rec.Restore.SpentOutpoints) != 1 {
		t.Fatalf("provisional: %+v", rec)
	}
	admFinalize(t, s, admTopicA, []uint32{0}, "30aa")
	// The retry with another topic (Review Focus 1): its provisional write must not set pending on
	// the admitted record, but adds its topic and merges its snapshot.
	if err := s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA, admTopicB}, Pending: true, Restore: &RestoreSnapshot{SpentOutpoints: []string{"aa.0", "bb.1"}}}); err != nil {
		t.Fatal(err)
	}
	rec = admGet(t, s)
	if rec.Pending || !rec.Admitted() {
		t.Fatalf("a provisional write set pending on an admitted record: %+v", rec)
	}
	if strings.Join(rec.Topics, ",") != admTopicA+","+admTopicB || strings.Join(rec.Restore.SpentOutpoints, ",") != "AA.0,bb.1" {
		t.Fatalf("topics %v restore %v", rec.Topics, rec.Restore)
	}
	if err := s.MarkEvicted(ctx, admTxid); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{"tm_mandala"}, Pending: true, Restore: &RestoreSnapshot{SpentOutpoints: []string{"cc.2"}}}); err != nil {
		t.Fatal(err)
	}
	rec = admGet(t, s)
	if rec.Pending || len(rec.Topics) != 2 || len(rec.Restore.SpentOutpoints) != 2 {
		t.Fatalf("a provisional write changed an evicted record: %+v", rec)
	}
}

// A provisional write racing a admFinalize never leaves the admitted record pending.
func TestProvisionalRacingAFinalizeNeverHidesTheAdmission(t *testing.T) {
	ctx := context.Background()
	s, db := admissionStore(t)
	for i := 0; i < 20; i++ {
		if _, err := db.Collection(AdmissionsCollection).DeleteMany(ctx, bson.D{}); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			if err := s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicB}, Pending: true, Restore: &RestoreSnapshot{SpentOutpoints: []string{"aa.0"}}}); err != nil {
				t.Error(err)
			}
		}()
		go func() {
			defer wg.Done()
			if err := s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA}, Admissions: map[string]TopicAdmission{admTopicA: {OutputsToAdmit: []uint32{0}, AdmissionSignature: "30"}}}); err != nil {
				t.Error(err)
			}
		}()
		wg.Wait()
		rec := admGet(t, s)
		if rec.Pending || !rec.Admitted() {
			t.Fatalf("iteration %d: %+v", i, rec)
		}
	}
}

// The guarded writes never lose a refusal or an eviction stamp to a concurrent first insert of
// the same txid (MongoDB does not retry a duplicate-key upsert whose filter is not pure equality).
func TestConcurrentFirstWritesOfOneTxidAllLand(t *testing.T) {
	ctx := context.Background()
	s, db := admissionStore(t)
	race := func(a, b func() error) {
		t.Helper()
		if _, err := db.Collection(AdmissionsCollection).DeleteMany(ctx, bson.D{}); err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		for _, f := range []func() error{a, b} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := f(); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
	}
	provisional := func() error {
		return s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA}, Pending: true, Restore: &RestoreSnapshot{SpentOutpoints: []string{"aa.0"}}})
	}
	refuse := func() error {
		return s.MarkRefused(ctx, Refusal{Txid: admTxid, Code: "ERR_LINKAGE", Description: "x", PayloadHash: PayloadHashHex(nil), Topic: admTopicA})
	}
	evict := func() error { return s.MarkEvicted(ctx, admTxid) }
	final := func() error {
		return s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA}, Admissions: map[string]TopicAdmission{admTopicA: {OutputsToAdmit: []uint32{0}, AdmissionSignature: "30"}}})
	}
	for i := 0; i < 20; i++ {
		race(provisional, refuse)
		if rec := admGet(t, s); rec.RefusedCode != "ERR_LINKAGE" || !rec.Pending || rec.Restore == nil {
			t.Fatalf("iteration %d, refusal + provisional: %+v", i, rec)
		}
		race(evict, provisional)
		if rec := admGet(t, s); rec.EvictedAt == "" {
			t.Fatalf("iteration %d, eviction + provisional lost the stamp: %+v", i, rec)
		}
		race(evict, final)
		if rec := admGet(t, s); rec.EvictedAt == "" {
			t.Fatalf("iteration %d, eviction + finalize lost the stamp: %+v", i, rec)
		}
	}
}

func TestMarkRefused(t *testing.T) {
	ctx := context.Background()
	s, _ := admissionStore(t)
	hashA, hashB := PayloadHashHex([]byte(`{"outputs":[]}`)), PayloadHashHex(nil)
	competitor := strings.Repeat("cd", 32)
	if err := s.MarkRefused(ctx, Refusal{Txid: admTxid, Code: "ERR_INPUT_SPENT", Description: "input x.0: already spent by " + competitor, SpendTxid: competitor, PayloadHash: hashA, Topic: admTopicA}); err != nil {
		t.Fatal(err)
	}
	rec := admGet(t, s)
	if rec.RefusedSpendTxid != competitor || rec.RefusedTopic != admTopicA || rec.RefusedAt == "" || rec.At == "" {
		t.Fatalf("refusal: %+v", rec)
	}
	if err := s.MarkRefused(ctx, Refusal{Txid: admTxid, Code: "ERR_LINKAGE", Description: "output 0: token output with no verified linkage", PayloadHash: hashB}); err != nil {
		t.Fatal(err)
	}
	rec = admGet(t, s)
	if rec.RefusedCode != "ERR_LINKAGE" || rec.RefusedPayloadHash != hashB || rec.RefusedSpendTxid != "" || rec.RefusedTopic != "" {
		t.Fatalf("the latest refusal wins, whole: %+v", rec)
	}
	admFinalize(t, s, admTopicA, []uint32{0}, "30aa")
	rec = admGet(t, s)
	if rec.RefusedCode != "" || rec.RefusedDescription != "" || rec.RefusedAt != "" || rec.RefusedPayloadHash != "" || !rec.Admitted() {
		t.Fatalf("an admission clears the refusal: %+v", rec)
	}
	if err := s.MarkRefused(ctx, Refusal{Txid: admTxid, Code: "ERR_SHAPE", Description: "late", PayloadHash: hashB, Topic: admTopicB}); err != nil {
		t.Fatal(err)
	}
	if rec = admGet(t, s); rec.RefusedCode != "" || !rec.Admitted() {
		t.Fatalf("a refusal overwrote an admission: %+v", rec)
	}
	other := strings.Repeat("ef", 32)
	if err := s.MarkEvicted(ctx, other); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkRefused(ctx, Refusal{Txid: other, Code: "ERR_SHAPE", Description: "late", PayloadHash: hashB}); err != nil {
		t.Fatal(err)
	}
	if rec, _ := s.GetAdmission(ctx, other); rec.RefusedCode != "" || rec.EvictedAt == "" {
		t.Fatalf("a refusal overwrote an eviction: %+v", rec)
	}
}

func TestMarkEvictedStampsOnceAndSurvivesARecordlessTxid(t *testing.T) {
	ctx := context.Background()
	s, _ := admissionStore(t)
	admFinalize(t, s, admTopicA, []uint32{0}, "30aa")
	if err := s.MarkEvicted(ctx, admTxid); err != nil {
		t.Fatal(err)
	}
	first := admGet(t, s)
	if first.EvictedAt == "" || first.Admitted() {
		t.Fatalf("evicted: %+v", first)
	}
	if err := s.MarkEvicted(ctx, admTxid); err != nil {
		t.Fatal(err)
	}
	if again := admGet(t, s); again.EvictedAt != first.EvictedAt {
		t.Fatalf("re-stamped: %q -> %q", first.EvictedAt, again.EvictedAt)
	}
	admFinalize(t, s, admTopicB, []uint32{1}, "30bb")
	if rec := admGet(t, s); len(rec.Admissions) != 1 {
		t.Fatalf("a admFinalize wrote over an eviction: %+v", rec.Admissions)
	}
	other := strings.Repeat("ef", 32)
	if err := s.MarkEvicted(ctx, other); err != nil {
		t.Fatal(err)
	}
	if rec, err := s.GetAdmission(ctx, other); err != nil || rec == nil || rec.EvictedAt == "" {
		t.Fatalf("recordless eviction: %+v %v", rec, err)
	}
}

func TestRecordAdmissionGrowsTheRestoreSnapshot(t *testing.T) {
	ctx := context.Background()
	s, db := admissionStore(t)
	// A legacy record with tokenRows decodes; the field is dropped.
	if _, err := db.Collection(AdmissionsCollection).InsertOne(ctx, bson.D{
		{Key: "txid", Value: admTxid}, {Key: "topics", Value: bson.A{"tm_mandala"}}, {Key: "pending", Value: true},
		{Key: "restore", Value: bson.D{{Key: "spentOutpoints", Value: bson.A{"aa.0"}}, {Key: "tokenRows", Value: bson.A{bson.D{{Key: "txid", Value: "aa"}}}}}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA}, Pending: true, Restore: &RestoreSnapshot{SpentOutpoints: []string{}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordAdmission(ctx, AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA}, Pending: true}); err != nil {
		t.Fatal(err)
	}
	rec := admGet(t, s)
	if rec.Restore == nil || strings.Join(rec.Restore.SpentOutpoints, ",") != "aa.0" {
		t.Fatalf("an empty or absent snapshot must not shrink the stored one: %+v", rec.Restore)
	}
	final := AdmissionRecord{Txid: admTxid, Topics: []string{admTopicA}, Admissions: map[string]TopicAdmission{admTopicA: {OutputsToAdmit: []uint32{0}, AdmissionSignature: "30"}},
		Restore: &RestoreSnapshot{SpentOutpoints: []string{"AA.0", "bb.1"}}}
	if err := s.RecordAdmission(ctx, final); err != nil {
		t.Fatal(err)
	}
	rec = admGet(t, s)
	if strings.Join(rec.Restore.SpentOutpoints, ",") != "aa.0,bb.1" || !rec.Admitted() {
		t.Fatalf("admFinalize merges: %+v", rec)
	}
	if strings.Join(rec.Topics, ",") != "tm_mandala,"+admTopicA {
		t.Fatalf("topics = %v", rec.Topics)
	}
}

func TestMergeRestoreSnapshot(t *testing.T) {
	first := &RestoreSnapshot{SpentOutpoints: []string{"AA.0", "bb.1"}}
	later := &RestoreSnapshot{SpentOutpoints: []string{"aa.0", "cc.2", "cc.2"}}
	got := MergeRestoreSnapshot(first, later)
	if strings.Join(got.SpentOutpoints, ",") != "AA.0,bb.1,cc.2" {
		t.Fatalf("merge = %v", got.SpentOutpoints)
	}
	if MergeRestoreSnapshot(nil, nil) != nil {
		t.Fatal("nil + nil must stay nil")
	}
	if m := MergeRestoreSnapshot(&RestoreSnapshot{}, nil); m == nil || m.SpentOutpoints == nil {
		t.Fatalf("an empty merge must marshal as [], not null: %+v", m)
	}
	if PayloadHashHex(nil) != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" {
		t.Fatal("an absent payload hashes the empty string")
	}
}

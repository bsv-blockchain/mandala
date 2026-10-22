package mandala

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/wallet"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

const admTxid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

var (
	admTopicA = TokenTopicOfTxid(strings.Repeat("a", 64))
	admTopicB = TokenTopicOfTxid(strings.Repeat("b", 64))
)

func admissionStore(t *testing.T) (*Store, *mongo.Database) {
	t.Helper()
	db := testmongo.DB(t, "mandala3_test_admissions")
	return mustStore(t, db), db
}

// admLegacyTokenTopic is the pre-1Color token topic spelling the TT A1.2 vectors were verified on. The v3
// digest hashes its topic argument as given, so the cross-verified bytes stay pinned on that string.
const admLegacyTokenTopic = "tm_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// The verified vectors of the Global Constraints (TT A1.2).
func TestAdmissionDigestV3Vectors(t *testing.T) {
	for _, c := range []struct {
		topic string
		outs  []uint32
		want  string
	}{
		{"tm_mandala", []uint32{0}, "2dd76e2fbb8234967159f842f463b58bd0a76efcc49e7c8372bdbc8a9931db5c"},
		{admLegacyTokenTopic, []uint32{0}, "654768162ffd1d0011e33cff4f8e553cf34a159c6006e627f4987f57c2891d0d"},
		{admLegacyTokenTopic, []uint32{1, 0, 1}, "d75c8da798a7347ef623e57cc827c3188c36acd8e84f9b9f69f531d1ebe335b1"},
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

// tm_mandala keeps σI v3 with the bare key; a color topic carries the attested v1 signature (contract §3).
func TestSignAndVerifyAdmissionPerTopic(t *testing.T) {
	privHex := strings.Repeat("0a", 32)
	s, err := NewECAdmissionSigner(privHex)
	if err != nil {
		t.Fatal(err)
	}
	priv, _ := ec.PrivateKeyFromHex(privHex)
	sig, key, err := s.SignAdmission(MandalaTopic, admTxid, []uint32{2, 0})
	if err != nil {
		t.Fatal(err)
	}
	if key != hex.EncodeToString(priv.PubKey().Compressed()) {
		t.Fatalf("identity key %s", key)
	}
	if ok, err := VerifyAdmission(MandalaTopic, admTxid, []uint32{0, 2}, sig, key); err != nil || !ok {
		t.Fatalf("own topic: %v %v", ok, err)
	}
	if ok, err := VerifyAdmission(admTopicA, admTxid, []uint32{0, 2}, sig, key); err != nil || ok {
		t.Fatalf("another topic's digest must not verify: %v %v", ok, err)
	}
	if ok, _ := VerifyAdmission(MandalaTopic, admTxid, []uint32{0}, sig, key); ok {
		t.Fatal("another output set must not verify")
	}
	again, _, _ := s.SignAdmission(MandalaTopic, admTxid, []uint32{0, 2, 2})
	if again != sig {
		t.Fatal("RFC6979: re-signing the same admission must give the same σI")
	}
	for _, topic := range []string{MandalaTopic, admTopicA} {
		if _, _, err := s.SignAdmission(topic, admTxid, nil); !errors.Is(err, ErrNoAdmittedOutputs) {
			t.Fatalf("%s empty set: %v", topic, err)
		}
	}
	if _, err := VerifyAdmission(MandalaTopic, admTxid, []uint32{0}, "zz", key); err == nil {
		t.Fatal("a non-hex signature is an error")
	}
	if _, err := VerifyAdmission(MandalaTopic, admTxid, []uint32{0}, sig, "02zz"); err == nil {
		t.Fatal("a bad identity key is an error")
	}
	if _, err := NewECAdmissionSigner("not hex"); err == nil {
		t.Fatal("a bad private key is an error")
	}

	att, attKey, err := s.SignAdmission(admTopicA, admTxid, []uint32{2, 0})
	if err != nil || attKey != key {
		t.Fatalf("color topic: %v, identity %s (must be the root key)", err, attKey)
	}
	if !VerifyAttestation(admTopicA, admTxid, []uint32{0, 2}, att, key) {
		t.Fatal("attested σI on its own topic")
	}
	if VerifyAttestation(admTopicB, admTxid, []uint32{0, 2}, att, key) {
		t.Fatal("attested σI verifies under another color topic")
	}
	if ok, _ := VerifyAdmission(admTopicA, admTxid, []uint32{0, 2}, att, key); ok {
		t.Fatal("a color topic's σI verifies as v3 under the bare key")
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

// BRC-207 attested admission statement, C.0 vectors (0207:10224-10264; contract §3).
const (
	c0Topic  = "tm_color_c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0"
	c0Txid   = "05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931"
	c0Signer = "02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046"
	c0Tweak  = "6ef21748a4f6f5034842184e25f68e8df8663e036622ad9b3d061c6dd81ea93b" // 0207:10230
	c0Child  = "033520aaa77b6914019796e974d1737acc890c5283c0921ddcfc2d5c815db8fb90"
	c0Digest = "9f61b417ec979c3c057313fe56f3c6056d2962b6bceaaa8272377bb9a80d8f9d"
	c0Low    = "3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a"
	c0High   = "3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7"
	msgC0    = "1color-admit:v1:" + c0Topic + ":" + c0Txid + ":0,2"
)

// c0Priv is the public test integer 5555 (0207:10224); never for funds.
func c0Priv(t *testing.T) *ec.PrivateKey {
	t.Helper()
	b := make([]byte, 32)
	b[30], b[31] = 0x15, 0xb3
	p, _ := ec.PrivateKeyFromBytes(b)
	return p
}

// signWith signs data through ProtoWallet.CreateSignature on the attestation protocol with keyID, counterparty anyone.
func signWith(t *testing.T, priv *ec.PrivateKey, keyID, data string) string {
	t.Helper()
	w, err := wallet.NewProtoWallet(wallet.ProtoWalletArgs{Type: wallet.ProtoWalletArgsTypePrivateKey, PrivateKey: priv})
	if err != nil {
		t.Fatal(err)
	}
	res, err := w.CreateSignature(context.Background(), wallet.CreateSignatureArgs{
		EncryptionArgs: wallet.EncryptionArgs{
			ProtocolID:   AttestationProtocol,
			KeyID:        keyID,
			Counterparty: wallet.Counterparty{Type: wallet.CounterpartyTypeAnyone},
		},
		Data: []byte(data),
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(res.Signature.Serialize())
}

// bareSign signs sha256(msg) with the root key itself (no BRC-42 child).
func bareSign(t *testing.T, priv *ec.PrivateKey, msg string) string {
	t.Helper()
	d := sha256.Sum256([]byte(msg))
	sig, err := priv.Sign(d[:])
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(sig.Serialize())
}

func TestAttestationC0Vectors(t *testing.T) {
	priv := c0Priv(t)
	if priv.PubKey().ToDERHex() != c0Signer {
		t.Fatal("signer")
	}
	// BRC-42 HMAC tweak, asserted on its own: key = compressed shared secret of (anyone = scalar 1, signer), which is
	// the signer point itself; msg = utf8 invoice "2-color admission attestation-1". If this passes and the child
	// fails, the fault is point addition; if this fails, it is the invoice string or the HMAC key.
	anyPriv, _ := wallet.AnyoneKey()
	shared, err := anyPriv.DeriveSharedSecret(priv.PubKey())
	if err != nil || !shared.IsEqual(priv.PubKey()) {
		t.Fatal("shared secret with scalar 1 must be the signer point", err)
	}
	mac := hmac.New(sha256.New, shared.Compressed())
	mac.Write([]byte("2-color admission attestation-1"))
	if got := hex.EncodeToString(mac.Sum(nil)); got != c0Tweak {
		t.Fatalf("HMAC tweak %s (invoice or HMAC key wrong)", got)
	}
	child, err := AttestationSigningKey(priv.PubKey())
	if err != nil || child.ToDERHex() != c0Child {
		t.Fatal(child, err)
	}
	msg, err := AttestationMessage(c0Topic, c0Txid, []uint32{0, 2})
	if err != nil || msg != msgC0 {
		t.Fatal(msg, err)
	}
	if d := sha256.Sum256([]byte(msg)); hex.EncodeToString(d[:]) != c0Digest {
		t.Fatal("digest")
	}
	s := &ECAdmissionSigner{priv: priv}
	sig, ident, err := s.SignAdmission(c0Topic, c0Txid, []uint32{2, 0, 2}) // canonicalised by the signer
	if err != nil || sig != c0Low || ident != c0Signer {
		t.Fatal(sig, ident, err)
	}
	if !VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low, c0Signer) {
		t.Fatal("low-S")
	}
	if !VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0High, c0Signer) {
		t.Fatal("high-S (BSV Chronicle: never normalize S)")
	}
}

func TestAttestationC0Negatives(t *testing.T) {
	other := "tm_color_" + strings.Repeat("00", 32) + "_0"
	priv := c0Priv(t)
	for name, ok := range map[string]bool{
		"reordered":        VerifyAttestation(c0Topic, c0Txid, []uint32{2, 0}, c0Low, c0Signer),
		"duplicate":        VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2, 2}, c0Low, c0Signer),
		"missing 2":        VerifyAttestation(c0Topic, c0Txid, []uint32{0}, c0Low, c0Signer),
		"empty":            VerifyAttestation(c0Topic, c0Txid, nil, c0Low, c0Signer),
		"other topic":      VerifyAttestation(other, c0Txid, []uint32{0, 2}, c0Low, c0Signer),
		"tm_mandala topic": VerifyAttestation(MandalaTopic, c0Txid, []uint32{0, 2}, c0Low, c0Signer),
		"uppercase sig":    VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, strings.ToUpper(c0Low), c0Signer),
		"uppercase signer": VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low, strings.ToUpper(c0Signer)),
		"uppercase txid":   VerifyAttestation(c0Topic, strings.ToUpper(c0Txid), []uint32{0, 2}, c0Low, c0Signer),
		"uncompressed":     VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low, hex.EncodeToString(priv.PubKey().Uncompressed())),
		"off-curve signer": VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low, "02"+strings.Repeat("00", 32)),
		"trailing":         VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low+"00", c0Signer),
		"truncated":        VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low[:len(c0Low)-2], c0Signer),
		"keyID 2":          VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, signWith(t, priv, "2", msgC0), c0Signer),
		"newline":          VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, signWith(t, priv, "1", msgC0+"\n"), c0Signer),
		"bare key":         VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, bareSign(t, priv, msgC0), c0Signer),
		"child as signer":  VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, c0Low, c0Child),
	} {
		if ok {
			t.Errorf("%s verified", name)
		}
	}
	// The positive control for the helpers: keyID "1" over the exact message is the C.0 low-S signature.
	if got := signWith(t, priv, "1", msgC0); got != c0Low {
		t.Fatalf("signWith control %s", got)
	}
	der, _ := hex.DecodeString(c0Low)
	sig, _ := ec.ParseDERSignature(der)
	if d := sha256.Sum256([]byte(msgC0)); sig.Verify(d[:], priv.PubKey()) {
		t.Fatal("C.0 signature verifies against the bare key")
	}
	s := &ECAdmissionSigner{priv: priv}
	if _, _, err := s.SignAdmission(KYCTopic, c0Txid, []uint32{0}); !errors.Is(err, ErrUnsignedTopic) {
		t.Fatal(err)
	}
	if _, _, err := s.SignAdmission("tm_"+strings.Repeat("c7", 32), c0Txid, []uint32{0}); !errors.Is(err, ErrUnsignedTopic) {
		t.Fatal("a legacy token topic is unsigned:", err)
	}
	if _, _, err := s.SignAdmission(c0Topic, c0Txid, nil); !errors.Is(err, ErrNoAdmittedOutputs) {
		t.Fatal("empty set:", err)
	}
	for _, c := range []struct {
		topic, txid string
		outs        []uint32
	}{
		{MandalaTopic, c0Txid, []uint32{0}},
		{"tm_color_" + strings.Repeat("c7", 32) + "_1", c0Txid, []uint32{0}},
		{c0Topic, strings.ToUpper(c0Txid), []uint32{0}},
		{c0Topic, c0Txid[:63], []uint32{0}},
		{c0Topic, c0Txid, nil},
		{c0Topic, c0Txid, []uint32{2, 0}},
		{c0Topic, c0Txid, []uint32{0, 0}},
	} {
		if _, err := AttestationMessage(c.topic, c.txid, c.outs); err == nil {
			t.Errorf("AttestationMessage(%q, %q, %v) accepted", c.topic, c.txid, c.outs)
		}
	}
	if m, err := AttestationMessage(c0Topic, c0Txid, []uint32{4294967295}); err != nil || !strings.HasSuffix(m, ":4294967295") {
		t.Fatal(m, err)
	}
}

// The attested signature is RFC6979-deterministic: the replay and /admin/admission paths re-sign to the same bytes.
func TestAttestationDeterministicAndRootIdentity(t *testing.T) {
	priv := c0Priv(t)
	s := &ECAdmissionSigner{priv: priv}
	a, ka, _ := s.SignAdmission(c0Topic, c0Txid, []uint32{0, 2})
	b, kb, _ := s.SignAdmission(c0Topic, c0Txid, []uint32{2, 0})
	if a != b || ka != kb || ka != c0Signer {
		t.Fatal("re-signing must reproduce the bytes and report the root identity key")
	}
	m, km, err := s.SignAdmission(MandalaTopic, c0Txid, []uint32{0, 2})
	if err != nil || km != c0Signer || m == a {
		t.Fatal("tm_mandala keeps v3 with the bare key", m, err)
	}
	if ok, err := VerifyAdmission(MandalaTopic, c0Txid, []uint32{0, 2}, m, c0Signer); err != nil || !ok {
		t.Fatal("v3 on tm_mandala", err)
	}
	if VerifyAttestation(c0Topic, c0Txid, []uint32{0, 2}, m, c0Signer) {
		t.Fatal("a v3 σI verifies as an attestation")
	}
}

package mandala

import (
	"context"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

// The Store tests share one database, dropped before and after every test; none runs in parallel.
func storeDB(t *testing.T) *mongo.Database { return testmongo.DB(t, "mandala3_test_store") }

func mustStore(t *testing.T, db *mongo.Database) *Store {
	t.Helper()
	s, err := NewStore(db)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

func newTestStore(t *testing.T) (*Store, *mongo.Database) {
	t.Helper()
	db := storeDB(t)
	return mustStore(t, db), db
}

// stHex is a 64-hex id made of one repeated byte, e.g. stHex(0xaa) = "aaaa…aa".
func stHex(b byte) string { return strings.Repeat(fmt.Sprintf("%02x", b), 32) }

const (
	stKeyA = "02" + "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
	stKeyB = "03" + "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
)

var stEpoch = time.Unix(0, 0).UTC()

func stCount(t *testing.T, db *mongo.Database, coll string, filter bson.D) int64 {
	t.Helper()
	n, err := db.Collection(coll).CountDocuments(context.Background(), filter)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func stRaw(t *testing.T, db *mongo.Database, coll string, filter bson.D, field string) bson.RawValue {
	t.Helper()
	raw, err := db.Collection(coll).FindOne(context.Background(), filter).Raw()
	if err != nil {
		t.Fatalf("%s %v: %v", coll, filter, err)
	}
	return raw.Lookup(field)
}

// ---- indexes ----

func TestNewStoreCreatesEveryIndex(t *testing.T) {
	ctx := context.Background()
	_, db := newTestStore(t)
	want := map[string][]string{
		OwnersCollection:        {"txid_1_outputIndex_1_topic_1 unique"},
		TokensCollection:        {"identityKey_1", "tokenId_1", "txid_1_outputIndex_1 unique"},
		AuthoritiesCollection:   {"topic_1_tokenId_1", "txid_1_outputIndex_1 unique"},
		LinkageCollection:       {"createdAt_-1", "identityKey_1", "txid_1_outputIndex_1 unique"},
		BalancesCollection:      {"identityKey_1 unique"},
		MetadataCollection:      {"tokenId_1 unique"},
		AssetStatesCollection:   {"tokenId_1 unique"},
		AdminHistoryCollection:  {"tokenId_1_admitSeq_-1", "tokenId_1_height_1_offset_1_admitSeq_1", "tokenId_1_txid_1_outputIndex_1 unique", "txid_1"},
		TokenRegistryCollection: {"createdAt_1", "tokenId_1 unique"},
		KYCRegistryCollection:   {"identityKey_1 unique", "status_1"},
		AdmissionsCollection:    {"txid_1 unique"},
	}
	for coll, wantIdx := range want {
		cur, err := db.Collection(coll).Indexes().List(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var specs []struct {
			Name   string `bson:"name"`
			Unique bool   `bson:"unique"`
		}
		if err := cur.All(ctx, &specs); err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, s := range specs {
			if s.Name == "_id_" {
				continue
			}
			if s.Unique {
				got = append(got, s.Name+" unique")
			} else {
				got = append(got, s.Name)
			}
		}
		slices.Sort(got)
		if strings.Join(got, ",") != strings.Join(wantIdx, ",") {
			t.Fatalf("%s indexes = %v, want %v", coll, got, wantIdx)
		}
	}
}

// Go discipline (F/ts-storage §2.4): an index that cannot be built aborts boot, naming the collection.
func TestNewStoreAbortsWhenAnIndexCannotBeCreated(t *testing.T) {
	ctx := context.Background()
	db := storeDB(t)
	if _, err := db.Collection(TokenRegistryCollection).InsertMany(ctx, []any{
		bson.D{{Key: "tokenId", Value: stHex(0xaa) + "_0"}},
		bson.D{{Key: "tokenId", Value: stHex(0xaa) + "_0"}},
	}); err != nil {
		t.Fatal(err)
	}
	s, err := NewStore(db)
	if err == nil || s != nil {
		t.Fatalf("NewStore = %v, %v; want nil and an error", s, err)
	}
	if !strings.Contains(err.Error(), "mandala store: index creation failed on "+TokenRegistryCollection) {
		t.Fatalf("error must name the collection: %v", err)
	}
}

// ---- owner journal ----

func stOwner(txid string, vout uint32, topic string, role brc162.Role, amount Amount, key string) OwnerRecord {
	return OwnerRecord{Txid: txid, OutputIndex: vout, Topic: topic, TokenID: stHex(0xaa) + "_0", Role: role, Amount: amount, IdentityKey: key, CreatedAt: stEpoch}
}

func TestRecordOwnersIsFirstWriteWinsAndAppendOnly(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	topicA, topicB := "tm_"+stHex(0xaa), "tm_"+stHex(0xbb)
	if err := s.RecordOwners(ctx, nil); err != nil {
		t.Fatal("empty batch:", err)
	}
	if n := stCount(t, db, OwnersCollection, bson.D{}); n != 0 {
		t.Fatalf("an empty batch wrote %d rows", n)
	}
	first := stOwner(stHex(1), 0, topicA, brc162.RoleValue, 100, stKeyA)
	if err := s.RecordOwners(ctx, []OwnerRecord{first}); err != nil {
		t.Fatal(err)
	}
	rewrite := first
	rewrite.IdentityKey, rewrite.Amount = stKeyB, 7
	second := stOwner(stHex(1), 1, topicA, brc162.RoleAuthority, 0, stKeyB)
	if err := s.RecordOwners(ctx, []OwnerRecord{rewrite, second}); err != nil {
		t.Fatal("a partly-duplicate batch:", err)
	}
	got, err := s.GetOwnerJournal(ctx, stHex(1), 0, topicA)
	if err != nil || got == nil || got.IdentityKey != stKeyA || got.Amount != 100 || !got.CreatedAt.Equal(stEpoch) {
		t.Fatalf("first write must win: %+v %v", got, err)
	}
	if got, _ := s.GetOwnerJournal(ctx, stHex(1), 1, topicA); got == nil || got.Role != brc162.RoleAuthority {
		t.Fatalf("the batch's new row was not inserted: %+v", got)
	}
	if err := s.RecordOwners(ctx, []OwnerRecord{stOwner(stHex(1), 0, topicB, brc162.RoleValue, 100, stKeyA)}); err != nil {
		t.Fatal(err)
	}
	if n := stCount(t, db, OwnersCollection, bson.D{{Key: "txid", Value: stHex(1)}, {Key: "outputIndex", Value: 0}}); n != 2 {
		t.Fatalf("one row per topic: %d rows", n)
	}
	if got, err := s.GetOwnerJournal(ctx, stHex(1), 0, "tm_mandala_kyc"); got != nil || err != nil {
		t.Fatalf("another topic's journal must read nil: %+v %v", got, err)
	}
	if v := stRaw(t, db, OwnersCollection, bson.D{{Key: "topic", Value: topicA}, {Key: "outputIndex", Value: 0}}, "amount"); v.Type != bson.TypeDouble {
		t.Fatalf("journal amount written as %v, want double", v.Type)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- s.RecordOwners(ctx, []OwnerRecord{stOwner(stHex(2), 0, topicA, brc162.RoleValue, 5, stKeyA), stOwner(stHex(2), 1, topicA, brc162.RoleValue, 6, stKeyA)})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal("concurrent identical batches:", err)
		}
	}
	if n := stCount(t, db, OwnersCollection, bson.D{{Key: "txid", Value: stHex(2)}}); n != 2 {
		t.Fatalf("concurrent batches wrote %d rows, want 2", n)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.RecordOwners(cancelled, []OwnerRecord{stOwner(stHex(3), 0, topicA, brc162.RoleValue, 1, stKeyA)}); err == nil {
		t.Fatal("a non-duplicate failure must be returned")
	}
}

func TestOwnerJournalByOutpointAndDistinctTopics(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	topicA, topicB := "tm_"+stHex(0xaa), "tm_"+stHex(0xbb)
	if err := s.RecordOwners(ctx, []OwnerRecord{
		stOwner(stHex(9), 0, topicB, brc162.RoleValue, 3, stKeyB),
		stOwner(stHex(9), 0, topicA, brc162.RoleValue, 3, stKeyA),
		stOwner(stHex(9), 1, KYCTopic, brc162.RoleAuthority, 0, stKeyA),
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := s.OwnerJournalByOutpoint(ctx, stHex(9), 0)
	if err != nil || len(rows) != 2 || rows[0].Topic != topicA || rows[1].Topic != topicB {
		t.Fatalf("by outpoint: %+v %v", rows, err)
	}
	if rows, err := s.OwnerJournalByOutpoint(ctx, stHex(8), 0); err != nil || rows == nil || len(rows) != 0 {
		t.Fatalf("no rows must read []: %#v %v", rows, err)
	}
	topics, err := s.DistinctOwnerTopics(ctx)
	if err != nil || strings.Join(topics, ",") != topicA+","+topicB+","+KYCTopic {
		t.Fatalf("distinct topics = %v %v", topics, err)
	}
	var tokenTopics []string
	for _, tp := range topics {
		if IsTokenTopic(tp) {
			tokenTopics = append(tokenTopics, tp)
		}
	}
	if strings.Join(tokenTopics, ",") != topicA+","+topicB {
		t.Fatalf("token topics = %v", tokenTopics)
	}
}

// ---- value index ----

func stToken(txid string, vout uint32, tokenID string, amount Amount, key string) TokenRecord {
	return TokenRecord{Txid: txid, OutputIndex: vout, TokenID: tokenID, Amount: amount, IdentityKey: key, CreatedAt: stEpoch}
}

func TestTokenRowFirstWriteWinsAndTheCapIsADouble(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	tok := stHex(0xaa) + "_0"
	if got, err := s.GetTokenRow(ctx, stHex(1), 0); got != nil || err != nil {
		t.Fatalf("absent row: %+v %v", got, err)
	}
	ok, err := s.StoreTokenIfAbsent(ctx, stToken(stHex(1), 0, tok, Amount(MaxSafeAmount), stKeyA))
	if err != nil || !ok {
		t.Fatalf("first store: %v %v", ok, err)
	}
	ok, err = s.StoreTokenIfAbsent(ctx, stToken(stHex(1), 0, tok, 1, stKeyB))
	if err != nil || ok {
		t.Fatalf("second store must lose: %v %v", ok, err)
	}
	got, err := s.GetTokenRow(ctx, stHex(1), 0)
	if err != nil || got.Amount != Amount(MaxSafeAmount) || got.IdentityKey != stKeyA {
		t.Fatalf("row: %+v %v", got, err)
	}
	if v := stRaw(t, db, TokensCollection, bson.D{{Key: "txid", Value: stHex(1)}}, "amount"); v.Type != bson.TypeDouble || v.Double() != 9007199254740991 {
		t.Fatalf("amount stored as %v", v)
	}
	// A TS-written row holds a small amount as int32; a Go-era row as int64.
	if _, err := db.Collection(TokensCollection).InsertMany(ctx, []any{
		bson.D{{Key: "txid", Value: stHex(2)}, {Key: "outputIndex", Value: int32(0)}, {Key: "tokenId", Value: tok}, {Key: "amount", Value: int32(5)}, {Key: "identityKey", Value: stKeyA}, {Key: "createdAt", Value: stEpoch}},
		bson.D{{Key: "txid", Value: stHex(3)}, {Key: "outputIndex", Value: int64(0)}, {Key: "tokenId", Value: tok}, {Key: "amount", Value: int64(7)}, {Key: "identityKey", Value: stKeyA}, {Key: "createdAt", Value: stEpoch}},
	}); err != nil {
		t.Fatal(err)
	}
	if r, err := s.GetTokenRow(ctx, stHex(2), 0); err != nil || r.Amount != 5 {
		t.Fatalf("int32 row: %+v %v", r, err)
	}
	if r, err := s.GetTokenRow(ctx, stHex(3), 0); err != nil || r.Amount != 7 {
		t.Fatalf("int64 row: %+v %v", r, err)
	}
}

func TestTakeTokenRemovesExactlyOnce(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	tok := stHex(0xaa) + "_0"
	if _, err := s.StoreTokenIfAbsent(ctx, stToken(stHex(1), 2, tok, 40, stKeyA)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	taken := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := s.TakeToken(ctx, stHex(1), 2)
			if err != nil {
				t.Error(err)
				return
			}
			if r != nil {
				mu.Lock()
				taken++
				mu.Unlock()
				if r.Amount != 40 || r.IdentityKey != stKeyA {
					t.Errorf("taken row %+v", r)
				}
			}
		}()
	}
	wg.Wait()
	if taken != 1 {
		t.Fatalf("taken %d times, want exactly once", taken)
	}
	if r, err := s.TakeToken(ctx, stHex(1), 2); r != nil || err != nil {
		t.Fatalf("a second take: %+v %v", r, err)
	}
}

func TestFindTokensByTokenIDPagesLiveRowsInOutpointOrder(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	tok, other := stHex(0xaa)+"_0", stHex(0xbb)+"_0"
	for _, r := range []TokenRecord{
		stToken(stHex(2), 0, tok, 1, stKeyA),
		stToken(stHex(1), 1, tok, 2, stKeyA),
		stToken(stHex(1), 0, tok, 3, stKeyA),
		stToken(stHex(3), 0, tok, 4, stKeyA),
		stToken(stHex(4), 0, other, 5, stKeyA),
	} {
		if _, err := s.StoreTokenIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	st := DefaultAssetState(tok, nil)
	st.EvictedOutpoints = []string{strings.ToUpper(stHex(1)) + ".1", "not-an-outpoint", stHex(3) + ".00"}
	if err := s.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}
	outpoints := func(rows []TokenRecord) string {
		var ops []string
		for _, r := range rows {
			ops = append(ops, fmt.Sprintf("%s.%d", r.Txid[:2], r.OutputIndex))
		}
		return strings.Join(ops, ",")
	}
	rows, err := s.FindTokensByTokenID(ctx, tok, 100, 0)
	if err != nil || outpoints(rows) != "01.0,02.0,03.0" {
		t.Fatalf("live rows = %s %v (evicted 01.1 excluded case-insensitively, malformed entries ignored)", outpoints(rows), err)
	}
	if rows, _ := s.FindTokensByTokenID(ctx, tok, 1, 1); outpoints(rows) != "02.0" {
		t.Fatalf("page (1,1) = %s", outpoints(rows))
	}
	if rows, _ := s.FindTokensByTokenID(ctx, other, 0, 0); outpoints(rows) != "04.0" {
		t.Fatalf("another token's evicted list must not apply: %s", outpoints(rows))
	}
}

func TestCirculatingSupply(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	tok, other := stHex(0xaa)+"_0", stHex(0xbb)+"_0"
	supply := func(id string) string {
		v, err := s.CirculatingSupply(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return v.String()
	}
	if got := supply(tok); got != "0" {
		t.Fatalf("no rows: %s", got)
	}
	for _, r := range []TokenRecord{
		stToken(stHex(1), 0, tok, 100, stKeyA),
		stToken(stHex(1), 1, tok, 50, stKeyB),
		stToken(stHex(2), 1, tok, 7, stKeyB), // same vout as an evicted outpoint, another tx: counted
		stToken(stHex(3), 0, other, 9, stKeyA),
	} {
		if _, err := s.StoreTokenIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if got := supply(tok); got != "157" {
		t.Fatalf("sum = %s, want 157", got)
	}
	if _, err := s.TakeToken(ctx, stHex(1), 0); err != nil {
		t.Fatal(err)
	}
	if got := supply(tok); got != "57" {
		t.Fatalf("after a spend = %s, want 57", got)
	}
	st := DefaultAssetState(tok, nil)
	st.EvictedOutpoints = []string{strings.ToUpper(stHex(1)) + ".1", "zz.1"}
	if err := s.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}
	if got := supply(tok); got != "7" {
		t.Fatalf("evicted excluded = %s, want 7", got)
	}
	if got := supply(other); got != "9" {
		t.Fatalf("per-token evicted = %s, want 9", got)
	}
	big2 := stHex(0xcc) + "_0"
	for i := byte(0); i < 2; i++ {
		if _, err := s.StoreTokenIfAbsent(ctx, stToken(stHex(0x10+i), 0, big2, Amount(MaxSafeAmount), stKeyA)); err != nil {
			t.Fatal(err)
		}
	}
	want := new(big.Int).Mul(big.NewInt(2), new(big.Int).SetUint64(MaxSafeAmount))
	if got := supply(big2); got != want.String() {
		t.Fatalf("past 2^53 = %s, want %s", got, want)
	}
}

func TestIndexedVoutsByTxidUnionsTokensAndAuthorities(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	tok := stHex(0xaa) + "_0"
	if _, err := s.StoreTokenIfAbsent(ctx, stToken(stHex(1), 2, tok, 5, stKeyA)); err != nil {
		t.Fatal(err)
	}
	for _, v := range []uint32{0, 2} {
		if _, err := s.StoreAuthorityIfAbsent(ctx, AuthorityRecord{Txid: stHex(1), OutputIndex: v, Topic: "tm_" + stHex(0xaa), TokenID: tok, IdentityKey: stKeyA, CreatedAt: stEpoch}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.IndexedVoutsByTxid(ctx, stHex(1))
	if err != nil || fmt.Sprint(got) != "[0 2]" {
		t.Fatalf("vouts = %v %v", got, err)
	}
	if got, err := s.IndexedVoutsByTxid(ctx, stHex(2)); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("no rows must read []: %#v %v", got, err)
	}
}

// ---- authority index ----

func TestAuthorityRowsFirstWriteWinsTakeAndList(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	tok := stHex(0xaa) + "_0"
	topic := "tm_" + stHex(0xaa)
	row := func(txid string, vout uint32, topic, key string) AuthorityRecord {
		return AuthorityRecord{Txid: txid, OutputIndex: vout, Topic: topic, TokenID: tok, IdentityKey: key, CreatedAt: stEpoch}
	}
	if ok, err := s.StoreAuthorityIfAbsent(ctx, row(stHex(2), 0, topic, stKeyA)); err != nil || !ok {
		t.Fatalf("first: %v %v", ok, err)
	}
	if ok, err := s.StoreAuthorityIfAbsent(ctx, row(stHex(2), 0, topic, stKeyB)); err != nil || ok {
		t.Fatalf("second must lose: %v %v", ok, err)
	}
	for _, r := range []AuthorityRecord{row(stHex(1), 3, topic, stKeyA), row(stHex(1), 0, topic, stKeyA), row(stHex(3), 0, KYCTopic, stKeyA)} {
		if _, err := s.StoreAuthorityIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := s.GetAuthorityRow(ctx, stHex(2), 0); err != nil || got.IdentityKey != stKeyA {
		t.Fatalf("get: %+v %v", got, err)
	}
	list, err := s.ListAuthorities(ctx, topic, tok)
	if err != nil || len(list) != 3 || list[0].Txid != stHex(1) || list[0].OutputIndex != 0 || list[1].OutputIndex != 3 || list[2].Txid != stHex(2) {
		t.Fatalf("list: %+v %v", list, err)
	}
	if got, err := s.TakeAuthority(ctx, stHex(3), 0); err != nil || got == nil || got.Topic != KYCTopic {
		t.Fatalf("take (any topic): %+v %v", got, err)
	}
	if got, err := s.TakeAuthority(ctx, stHex(3), 0); err != nil || got != nil {
		t.Fatalf("second take: %+v %v", got, err)
	}
}

// ---- §4.2a repair ----

func TestRepairOwnerRow(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	topic := "tm_" + stHex(0xaa)
	value := stOwner(stHex(1), 1, topic, brc162.RoleValue, 40, stKeyA)

	inserted, err := s.RepairOwnerRow(ctx, value)
	if err != nil || !inserted {
		t.Fatalf("missing row: inserted=%v err=%v", inserted, err)
	}
	if b, _ := s.GetBalance(ctx, stKeyA); b != 40 {
		t.Fatalf("insert credits once: balance %d", b)
	}
	row, _ := s.GetTokenRow(ctx, stHex(1), 1)
	if row == nil || row.Amount != 40 || row.TokenID != value.TokenID || !row.CreatedAt.Equal(stEpoch) {
		t.Fatalf("repaired row %+v", row)
	}
	if inserted, err := s.RepairOwnerRow(ctx, value); err != nil || inserted {
		t.Fatalf("an existing row is corrected, not inserted: %v %v", inserted, err)
	}
	if b, _ := s.GetBalance(ctx, stKeyA); b != 40 {
		t.Fatalf("a correction must not re-credit: balance %d", b)
	}
	// A wrong row (amount 99) is corrected from the journal without a credit.
	if _, err := db.Collection(TokensCollection).UpdateOne(ctx, bson.D{{Key: "txid", Value: stHex(1)}}, bson.D{{Key: "$set", Value: bson.D{{Key: "amount", Value: 99.0}}}}); err != nil {
		t.Fatal(err)
	}
	if inserted, err := s.RepairOwnerRow(ctx, value); err != nil || inserted {
		t.Fatalf("correction: %v %v", inserted, err)
	}
	if row, _ := s.GetTokenRow(ctx, stHex(1), 1); row.Amount != 40 {
		t.Fatalf("corrected amount %d", row.Amount)
	}
	if b, _ := s.GetBalance(ctx, stKeyA); b != 40 {
		t.Fatalf("balance after correction %d", b)
	}

	auth := stOwner(stHex(2), 0, topic, brc162.RoleAuthority, 0, stKeyB)
	if inserted, err := s.RepairOwnerRow(ctx, auth); err != nil || !inserted {
		t.Fatalf("authority: %v %v", inserted, err)
	}
	deploy := stOwner(stHex(3), 0, topic, brc162.RoleDeploy, 0, stKeyB)
	if inserted, err := s.RepairOwnerRow(ctx, deploy); err != nil || !inserted {
		t.Fatalf("deploy: %v %v", inserted, err)
	}
	for _, txid := range []string{stHex(2), stHex(3)} {
		a, _ := s.GetAuthorityRow(ctx, txid, 0)
		if a == nil || a.Topic != topic || a.IdentityKey != stKeyB {
			t.Fatalf("authority row for %s: %+v", txid[:2], a)
		}
		if r, _ := s.GetTokenRow(ctx, txid, 0); r != nil {
			t.Fatal("a deploy/authority journal must not write a value row")
		}
	}
	if b, _ := s.GetBalance(ctx, stKeyB); b != 0 {
		t.Fatalf("an authority repair never credits: balance %d", b)
	}
	if n := stCount(t, db, OwnersCollection, bson.D{}); n != 0 {
		t.Fatalf("repair wrote %d journal rows", n)
	}
}

func TestConcurrentRepairCreditsOnce(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	j := stOwner(stHex(7), 0, "tm_"+stHex(0xaa), brc162.RoleValue, 25, stKeyA)
	var wg sync.WaitGroup
	var mu sync.Mutex
	inserts := 0
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			inserted, err := s.RepairOwnerRow(ctx, j)
			if err != nil {
				t.Error(err)
				return
			}
			if inserted {
				mu.Lock()
				inserts++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if inserts != 1 {
		t.Fatalf("%d repairs reported an insert, want 1", inserts)
	}
	if b, _ := s.GetBalance(ctx, stKeyA); b != 25 {
		t.Fatalf("balance %d, want 25 (credited once)", b)
	}
}

// ---- balances, linkage, metadata ----

func TestBalances(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	if b, err := s.GetBalance(ctx, stKeyA); b != 0 || err != nil {
		t.Fatalf("unknown identity: %d %v", b, err)
	}
	if err := s.AdjustBalance(ctx, stKeyA, 40); err != nil {
		t.Fatal(err)
	}
	if err := s.AdjustBalance(ctx, stKeyA, -15); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.GetBalance(ctx, stKeyA); b != 25 {
		t.Fatalf("balance %d", b)
	}
	if _, err := db.Collection(BalancesCollection).InsertOne(ctx, bson.D{{Key: "identityKey", Value: stKeyB}, {Key: "balance", Value: 12.0}}); err != nil {
		t.Fatal(err)
	}
	if b, err := s.GetBalance(ctx, stKeyB); b != 12 || err != nil {
		t.Fatalf("a TS double balance: %d %v", b, err)
	}
}

// V-11: mandalaBalances is a derived index of mandalaTokens. A credit or debit lost between a row
// write and its $inc is never retried by the write paths; RebuildBalances heals it.
func TestRebuildBalancesHealsTheBalanceIndex(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	tok, other := stHex(0xaa)+"_0", stHex(0xbb)+"_0"
	topic := "tm_" + stHex(0xaa)
	keyC := "02" + strings.Repeat("c3", 32)
	keyD := "03" + strings.Repeat("d4", 32)
	keyE := "02" + strings.Repeat("e5", 32)
	mustRow := func(r TokenRecord) {
		t.Helper()
		if ok, err := s.StoreTokenIfAbsent(ctx, r); err != nil || !ok {
			t.Fatalf("store row %s.%d: %v %v", r.Txid[:2], r.OutputIndex, ok, err)
		}
	}
	credit := func(key string, delta int64) {
		t.Helper()
		if err := s.AdjustBalance(ctx, key, delta); err != nil {
			t.Fatal(err)
		}
	}

	// A: one repaired row credited normally, then a row whose credit was lost (the row write landed,
	// the process died before the $inc). The retried repair finds the row and does not credit.
	if inserted, err := s.RepairOwnerRow(ctx, stOwner(stHex(1), 0, topic, brc162.RoleValue, 40, stKeyA)); err != nil || !inserted {
		t.Fatalf("repair: %v %v", inserted, err)
	}
	mustRow(stToken(stHex(1), 1, tok, 25, stKeyA))
	if inserted, err := s.RepairOwnerRow(ctx, stOwner(stHex(1), 1, topic, brc162.RoleValue, 25, stKeyA)); err != nil || inserted {
		t.Fatalf("retried repair: %v %v", inserted, err)
	}
	// A also lost a debit: a spent row of another token was taken, its owner never debited.
	mustRow(stToken(stHex(2), 0, other, 5, stKeyA))
	credit(stKeyA, 5)
	if r, err := s.TakeToken(ctx, stHex(2), 0); err != nil || r == nil {
		t.Fatalf("take: %+v %v", r, err)
	}
	if b, _ := s.GetBalance(ctx, stKeyA); b != 45 {
		t.Fatalf("precondition: A's balance %d, want the drifted 45", b)
	}
	// B: a balance document with no rows left (the last row's debit was lost).
	credit(stKeyB, 30)
	// C: a row with no balance document, on an outpoint a reissue evicted. No path debits a
	// reissued row, so it still counts (CirculatingSupply excludes it; balances do not).
	mustRow(stToken(stHex(3), 0, tok, 7, keyC))
	st := DefaultAssetState(tok, nil)
	st.EvictedOutpoints = []string{stHex(3) + ".0"}
	if err := s.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}
	// D: already right, across two tokens, as the int64 the Go $inc writes: it is not rewritten.
	mustRow(stToken(stHex(4), 0, tok, 12, keyD))
	mustRow(stToken(stHex(4), 1, other, 3, keyD))
	credit(keyD, 15)
	// E: a stored balance that does not decode (fractional) is replaced.
	mustRow(stToken(stHex(5), 0, tok, 9, keyE))
	if _, err := db.Collection(BalancesCollection).InsertOne(ctx, bson.D{{Key: "identityKey", Value: keyE}, {Key: "balance", Value: 2.5}}); err != nil {
		t.Fatal(err)
	}

	res, err := s.RebuildBalances(ctx)
	if err != nil || res.Changed != 4 || res.Unsafe == nil || len(res.Unsafe) != 0 {
		t.Fatalf("rebuild = %+v, %v; want 4 changed (A, B, C, E) and no unsafe key", res, err)
	}
	for _, want := range []struct {
		key string
		bal int64
	}{{stKeyA, 65}, {stKeyB, 0}, {keyC, 7}, {keyD, 15}, {keyE, 9}} {
		if b, err := s.GetBalance(ctx, want.key); b != want.bal || err != nil {
			t.Fatalf("balance of %s = %d, %v; want %d", want.key[:4], b, err, want.bal)
		}
	}
	if n := stCount(t, db, BalancesCollection, bson.D{{Key: "identityKey", Value: stKeyB}}); n != 1 {
		t.Fatalf("an identity with no rows keeps its document (at 0): %d documents", n)
	}
	if n := stCount(t, db, BalancesCollection, bson.D{}); n != 5 {
		t.Fatalf("%d balance documents, want 5", n)
	}
	for _, key := range []string{stKeyA, stKeyB, keyC, keyE} {
		if v := stRaw(t, db, BalancesCollection, bson.D{{Key: "identityKey", Value: key}}, "balance"); v.Type != bson.TypeDouble {
			t.Fatalf("rebuilt balance of %s stored as %v, want double", key[:4], v.Type)
		}
	}
	if v := stRaw(t, db, BalancesCollection, bson.D{{Key: "identityKey", Value: keyD}}, "balance"); v.Type != bson.TypeInt64 {
		t.Fatalf("an unchanged balance was rewritten: stored as %v", v.Type)
	}

	again, err := s.RebuildBalances(ctx)
	if err != nil || again.Changed != 0 || again.Unsafe == nil || len(again.Unsafe) != 0 {
		t.Fatalf("a second run = %+v, %v; want nothing changed", again, err)
	}
}

// V-11: an identity's balance sums every token it holds, so it can pass 2^53-1 although no single
// token's supply can. RebuildBalances reports such an identity instead of failing and leaves its
// document as it is; the same run still heals every other identity.
func TestRebuildBalancesReportsAnUnsafeSumWithoutFailing(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	tokX, tokY := stHex(0xaa)+"_0", stHex(0xbb)+"_0"
	keyC := "02" + strings.Repeat("c3", 32)
	for _, r := range []TokenRecord{
		stToken(stHex(1), 0, tokX, Amount(MaxSafeAmount), stKeyA), // A: 2^53 in all, the second credit lost
		stToken(stHex(1), 1, tokY, 1, stKeyA),
		stToken(stHex(2), 0, tokX, Amount(MaxSafeAmount), keyC), // C: 2^54-2 in all, no balance document
		stToken(stHex(2), 1, tokY, Amount(MaxSafeAmount), keyC),
		stToken(stHex(3), 0, tokX, 10, stKeyB), // B: safe, its credit lost
	} {
		if ok, err := s.StoreTokenIfAbsent(ctx, r); err != nil || !ok {
			t.Fatalf("store row %s.%d: %v %v", r.Txid[:2], r.OutputIndex, ok, err)
		}
	}
	if err := s.AdjustBalance(ctx, stKeyA, int64(MaxSafeAmount)); err != nil {
		t.Fatal(err)
	}

	for run := 1; run <= 2; run++ {
		res, err := s.RebuildBalances(ctx)
		wantChanged := 1 // B
		if run == 2 {
			wantChanged = 0
		}
		if err != nil || res.Changed != wantChanged || strings.Join(res.Unsafe, ",") != stKeyA+","+keyC {
			t.Fatalf("run %d = %+v, %v; want %d changed and unsafe [A C]", run, res, err, wantChanged)
		}
		if b, err := s.GetBalance(ctx, stKeyA); b != int64(MaxSafeAmount) || err != nil {
			t.Fatalf("run %d: an unsafe identity's document must be left readable as it was: %d %v", run, b, err)
		}
		if n := stCount(t, db, BalancesCollection, bson.D{{Key: "identityKey", Value: keyC}}); n != 0 {
			t.Fatalf("run %d: an unsafe identity got a document", run)
		}
		if b, err := s.GetBalance(ctx, stKeyB); b != 10 || err != nil {
			t.Fatalf("run %d: B's balance %d, %v; want 10", run, b, err)
		}
	}
}

func stLinkage(keyID string) SpecificLinkage {
	return SpecificLinkage{Prover: stKeyA, Verifier: stKeyB, Counterparty: stKeyA, ProtocolID: ProtocolID{SecurityLevel: 2, Name: "mandala token"}, KeyID: keyID, EncryptedLinkage: NumBytes{1, 2, 3}, EncryptedLinkageProof: NumBytes{0}}
}

func TestLinkageLastWriteWinsAndLists(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	t0 := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	if err := s.StoreLinkage(ctx, LinkageRecord{Txid: stHex(1), OutputIndex: 0, IdentityKey: stKeyA, Linkage: stLinkage("out-0"), CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	if err := s.StoreLinkage(ctx, LinkageRecord{Txid: stHex(1), OutputIndex: 0, IdentityKey: stKeyB, Linkage: stLinkage("out-0"), CreatedAt: t0.Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if err := s.StoreLinkage(ctx, LinkageRecord{Txid: stHex(2), OutputIndex: 1, IdentityKey: stKeyA, Linkage: stLinkage("out-1"), CreatedAt: t0.Add(2 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if n := stCount(t, db, LinkageCollection, bson.D{{Key: "txid", Value: stHex(1)}}); n != 1 {
		t.Fatalf("one record per outpoint: %d", n)
	}
	if v := stRaw(t, db, LinkageCollection, bson.D{{Key: "txid", Value: stHex(1)}}, "linkage"); v.Document().Lookup("protocolID").Type != bson.TypeArray {
		t.Fatal("protocolID must be stored as the TS 2-element array")
	}
	rows, err := s.ListLinkage(ctx, 10, nil)
	if err != nil || len(rows) != 2 || rows[0].Txid != stHex(2) || rows[1].IdentityKey != stKeyB {
		t.Fatalf("newest first, last write wins: %+v %v", rows, err)
	}
	before := t0.Add(90 * time.Second)
	if rows, _ := s.ListLinkage(ctx, 10, &before); len(rows) != 1 || rows[0].Txid != stHex(1) {
		t.Fatalf("before: %+v", rows)
	}
	found, err := s.FindLinkageByOutpoints(ctx, []Outpoint{{Txid: stHex(2), OutputIndex: 1}, {Txid: stHex(9), OutputIndex: 0}})
	if err != nil || len(found) != 1 || found[0].Linkage.KeyID != "out-1" || string(found[0].Linkage.EncryptedLinkage) != "\x01\x02\x03" {
		t.Fatalf("by outpoints: %+v %v", found, err)
	}
}

// V-10 (R8): concurrent same-txid submits store one outpoint's linkage at once (each with its own
// createdAt); the unique (txid, outputIndex) key keeps one record and no store fails.
func TestConcurrentStoreLinkageOneRowPerOutpoint(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	t0 := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	for k := byte(1); k <= 8; k++ {
		txid := stHex(k)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				r := LinkageRecord{Txid: txid, OutputIndex: 0, IdentityKey: stKeyA, Linkage: stLinkage("out-0"), CreatedAt: t0.Add(time.Duration(i) * time.Second)}
				if err := s.StoreLinkage(ctx, r); err != nil {
					t.Errorf("key %d store %d: %v", k, i, err)
				}
			}(i)
		}
		close(start)
		wg.Wait()
		if n := stCount(t, db, LinkageCollection, bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: 0}}); n != 1 {
			t.Fatalf("key %d: %d linkage records, want 1", k, n)
		}
	}
}

func TestMetadataIsKeyedByTokenID(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	tok, other := stHex(0xaa)+"_0", stHex(0xbb)+"_0"
	fee := int64(250)
	if err := s.StoreMetadata(ctx, MetadataRecord{TokenID: tok, Txid: stHex(0xaa), Sym: "OLD", Dec: 2, Label: "Old", FeeRatePerKb: &fee}); err != nil {
		t.Fatal(err)
	}
	if err := s.StoreMetadata(ctx, MetadataRecord{TokenID: tok, Txid: stHex(0xaa), Sym: "USD", Dec: 2, Label: "US Dollar"}); err != nil {
		t.Fatal(err)
	}
	if err := s.StoreMetadata(ctx, MetadataRecord{TokenID: other, Txid: stHex(0xbb), Sym: "EUR", Dec: 2, Label: "Euro"}); err != nil {
		t.Fatal(err)
	}
	m, err := s.FindMetadata(ctx, tok)
	if err != nil || m == nil || m.Sym != "USD" || m.FeeRatePerKb != nil || m.OutputIndex != 0 {
		t.Fatalf("metadata: %+v %v", m, err)
	}
	all, err := s.AllMetadata(ctx)
	if err != nil || len(all) != 2 || all[0].TokenID != tok || all[0].Sym != "USD" || all[1].TokenID != other || all[1].Sym != "EUR" {
		t.Fatalf("AllMetadata = %+v %v, want both tokens in tokenId order", all, err)
	}
	if v := stRaw(t, db, MetadataCollection, bson.D{{Key: "tokenId", Value: tok}}, "feeRatePerKb"); v.Type != bson.TypeNull {
		t.Fatalf("feeRatePerKb stored as %v, want null", v.Type)
	}
	if err := s.DeleteMetadata(ctx, tok); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.FindMetadata(ctx, tok); m != nil {
		t.Fatal("not deleted")
	}
	if m, _ := s.FindMetadata(ctx, other); m == nil {
		t.Fatal("deleting one token's metadata deleted another's")
	}
}

// ---- asset state ----

func TestAssetStateDefaultPutAndIfAbsent(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	tok := stHex(0xaa) + "_0"
	st, err := s.GetAssetState(ctx, tok)
	if err != nil || st.TokenID != tok || st.AccessMode != "denylist" || st.FrozenOutpoints == nil {
		t.Fatalf("default: %+v %v", st, err)
	}
	if n := stCount(t, db, AssetStatesCollection, bson.D{}); n != 0 {
		t.Fatal("reading a default must not persist it")
	}
	fee := int64(500)
	first := DefaultAssetState(tok, &fee)
	if ok, err := s.PutAssetStateIfAbsent(ctx, first); err != nil || !ok {
		t.Fatalf("if absent: %v %v", ok, err)
	}
	second := DefaultAssetState(tok, nil)
	second.IsPaused = true
	if ok, err := s.PutAssetStateIfAbsent(ctx, second); err != nil || ok {
		t.Fatalf("second if absent must lose: %v %v", ok, err)
	}
	if got, _ := s.GetAssetState(ctx, tok); got.IsPaused || got.FeeRatePerKb == nil || *got.FeeRatePerKb != 500 {
		t.Fatalf("first kept: %+v", got)
	}
	replaced := AssetAdminState{TokenID: tok, AccessMode: "allowlist", FrozenOutpoints: []FrozenRef{{Outpoint: stHex(1) + ".0", Amount: 10, Owner: stKeyA}}, LastAdmitSeq: 9}
	if err := s.PutAssetState(ctx, replaced); err != nil {
		t.Fatal(err)
	}
	got, _ := s.GetAssetState(ctx, tok)
	if got.AccessMode != "allowlist" || got.FeeRatePerKb != nil || len(got.FrozenOutpoints) != 1 || got.FrozenOutpoints[0].Amount != 10 || got.LastAdmitSeq != 9 {
		t.Fatalf("put replaces: %+v", got)
	}
	if v := stRaw(t, db, AssetStatesCollection, bson.D{{Key: "tokenId", Value: tok}}, "blockedIdentities"); v.Type != bson.TypeArray {
		t.Fatalf("a nil list must be written as [], got %v", v.Type)
	}
	if got.BlockedIdentities == nil || got.EvictedOutpoints == nil {
		t.Fatalf("lists must read non-nil: %+v", got)
	}
}

// ---- admin history and counters ----

func stHistory(tok, txid string, vout uint32, kind string, height, offset, seq int64) AdminHistoryEntry {
	return AdminHistoryEntry{TokenID: tok, Txid: txid, OutputIndex: vout, Kind: kind, DetailsHex: "a1", Commitment: stHex(0xcc), Delta: 0, Height: height, Offset: offset, AdmitSeq: seq, CreatedAt: stEpoch}
}

func TestAdminHistory(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	tok, other := stHex(0xaa)+"_0", stHex(0xbb)+"_0"
	frozen := Amount(30)
	owner := stKeyA
	freeze := stHistory(tok, stHex(4), 0, "freezeOutput", 100, 0, 4)
	freeze.FrozenAmount, freeze.FrozenOwner = &frozen, &owner
	issue := stHistory(tok, stHex(1), 0, "issue", 100, 2, 1)
	issue.Delta = -40
	for _, e := range []AdminHistoryEntry{
		stHistory(tok, stHex(3), 0, "pause", 9007199254740991, 0, 3),
		issue,
		stHistory(tok, stHex(2), 0, "unpause", 100, 2, 2),
		freeze,
		stHistory(other, stHex(1), 1, "issue", 1, 0, 5),
	} {
		if ok, err := s.AppendAdminHistory(ctx, e); err != nil || !ok {
			t.Fatalf("append %s: %v %v", e.Kind, ok, err)
		}
	}
	dup := stHistory(tok, stHex(1), 0, "redeem", 1, 1, 99)
	if ok, err := s.AppendAdminHistory(ctx, dup); err != nil || ok {
		t.Fatalf("a second append of (token, txid, vout) must lose: %v %v", ok, err)
	}
	rows, err := s.FindAdminHistory(ctx, tok, 0, 0)
	kinds := func(rs []AdminHistoryEntry) string {
		var k []string
		for _, r := range rs {
			k = append(k, r.Kind)
		}
		return strings.Join(k, ",")
	}
	if err != nil || kinds(rows) != "freezeOutput,issue,unpause,pause" {
		t.Fatalf("fold order (height, offset, admitSeq) = %s %v", kinds(rows), err)
	}
	if rows[1].Delta != -40 || rows[0].FrozenAmount == nil || *rows[0].FrozenAmount != 30 || *rows[0].FrozenOwner != stKeyA || rows[1].FrozenAmount != nil {
		t.Fatalf("delta and freeze context round trip: %+v", rows[:2])
	}
	if v := stRaw(t, db, AdminHistoryCollection, bson.D{{Key: "txid", Value: stHex(1)}, {Key: "tokenId", Value: tok}}, "frozenAmount"); v.Type != 0 {
		t.Fatalf("frozenAmount must be absent on a non-freeze row, got %v", v.Type)
	}
	if v := stRaw(t, db, AdminHistoryCollection, bson.D{{Key: "txid", Value: stHex(1)}, {Key: "tokenId", Value: tok}}, "delta"); v.Type != bson.TypeDouble {
		t.Fatalf("delta stored as %v, want double", v.Type)
	}
	if page, _ := s.FindAdminHistory(ctx, tok, 2, 1); kinds(page) != "issue,unpause" {
		t.Fatalf("page (2,1) = %s", kinds(page))
	}
	if page, _ := s.PageAdminHistoryNewestFirst(ctx, tok, 2, 0); kinds(page) != "freezeOutput,pause" {
		t.Fatalf("newest first = %s", kinds(page))
	}
	ids, err := s.TokenIDsWithHistory(ctx)
	if err != nil || strings.Join(ids, ",") != tok+","+other {
		t.Fatalf("token ids = %v %v", ids, err)
	}
	touched, err := s.TokensTouchedBy(ctx, stHex(1))
	if err != nil || strings.Join(touched, ",") != tok+","+other {
		t.Fatalf("touched = %v %v", touched, err)
	}
	if err := s.DeleteAdminHistoryByTxid(ctx, stHex(1)); err != nil {
		t.Fatal(err)
	}
	if rows, _ := s.FindAdminHistory(ctx, tok, 0, 0); kinds(rows) != "freezeOutput,unpause,pause" {
		t.Fatalf("after delete = %s", kinds(rows))
	}
	if touched, _ := s.TokensTouchedBy(ctx, stHex(1)); len(touched) != 0 {
		t.Fatalf("touched after delete = %v", touched)
	}
}

// V-10 (R8): Go submits are not serialised, so two same-txid submits can append one admin action at
// once, each with its own admitSeq. The unique (tokenId, txid, outputIndex) key keeps one row and
// reports one insert, so Task 16 recordAction folds the action once.
func TestConcurrentAppendAdminHistoryInsertsOnce(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	tok := stHex(0xaa) + "_0"
	for k := byte(1); k <= 8; k++ {
		txid := stHex(k)
		start := make(chan struct{})
		var wg sync.WaitGroup
		var mu sync.Mutex
		inserts := 0
		for i := 0; i < 16; i++ {
			wg.Add(1)
			go func(seq int64) {
				defer wg.Done()
				<-start
				inserted, err := s.AppendAdminHistory(ctx, stHistory(tok, txid, 0, "pause", 100, 0, seq))
				if err != nil {
					t.Error(err)
					return
				}
				if inserted {
					mu.Lock()
					inserts++
					mu.Unlock()
				}
			}(int64(k)*100 + int64(i))
		}
		close(start)
		wg.Wait()
		if inserts != 1 {
			t.Fatalf("key %d: %d appends reported an insert, want 1", k, inserts)
		}
		if n := stCount(t, db, AdminHistoryCollection, bson.D{{Key: "tokenId", Value: tok}, {Key: "txid", Value: txid}, {Key: "outputIndex", Value: 0}}); n != 1 {
			t.Fatalf("key %d: %d history rows, want 1", k, n)
		}
	}
}

func TestNextAdmitSeqStartsAtOneAndIsUniqueUnderConcurrency(t *testing.T) {
	ctx := context.Background()
	s, db := newTestStore(t)
	if n, err := s.NextAdmitSeq(ctx); n != 1 || err != nil {
		t.Fatalf("first = %d %v", n, err)
	}
	if n, _ := s.NextAdmitSeq(ctx); n != 2 {
		t.Fatalf("second = %d", n)
	}
	seqs := func(n int) map[int64]bool {
		t.Helper()
		var wg sync.WaitGroup
		var mu sync.Mutex
		seen := map[int64]bool{}
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				v, err := s.NextAdmitSeq(ctx)
				if err != nil {
					t.Error(err)
					return
				}
				mu.Lock()
				defer mu.Unlock()
				if seen[v] {
					t.Errorf("seq %d issued twice", v)
				}
				seen[v] = true
			}()
		}
		wg.Wait()
		return seen
	}
	seen := seqs(32)
	for n := int64(3); n <= 34; n++ {
		if !seen[n] {
			t.Fatalf("seq %d missing: %v", n, seen)
		}
	}
	// A concurrent first use (no counter document yet) also starts at 1 and never repeats.
	if err := db.Collection(CountersCollection).Drop(ctx); err != nil {
		t.Fatal(err)
	}
	first := seqs(16)
	for n := int64(1); n <= 16; n++ {
		if !first[n] {
			t.Fatalf("concurrent first use issued %v", first)
		}
	}
}

// ---- token registry records ----

func TestTokenRegistryRecords(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	t0 := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	rec := func(b byte, sym string, at time.Time) TokenRegistryRecord {
		return TokenRegistryRecord{TokenID: stHex(b) + "_0", DeployTxid: stHex(b), Sym: sym, Dec: 2, Label: sym, Issuer: stKeyA, CreatedAt: at}
	}
	if got, err := s.FindRegistryRecord(ctx, stHex(0xaa)+"_0"); got != nil || err != nil {
		t.Fatalf("absent: %+v %v", got, err)
	}
	for _, r := range []TokenRegistryRecord{rec(0xcc, "C", t0.Add(time.Minute)), rec(0xbb, "B", t0), rec(0xaa, "A", t0)} {
		if inserted, err := s.StoreRegistryRecord(ctx, r); err != nil || !inserted {
			t.Fatalf("first write of %s: inserted %v, %v", r.TokenID, inserted, err)
		}
	}
	if inserted, err := s.StoreRegistryRecord(ctx, rec(0xaa, "REPLAY", t0.Add(time.Hour))); err != nil || inserted {
		t.Fatalf("a replayed write must not insert: inserted %v, %v", inserted, err)
	}
	got, err := s.FindRegistryRecord(ctx, stHex(0xaa)+"_0")
	if err != nil || got.Sym != "A" || !got.CreatedAt.Equal(t0) || got.FeeRatePerKb != nil {
		t.Fatalf("first write wins: %+v %v", got, err)
	}
	list, err := s.ListRegistryRecords(ctx, 0, 0)
	if err != nil || len(list) != 3 || list[0].Sym != "A" || list[1].Sym != "B" || list[2].Sym != "C" {
		t.Fatalf("order (createdAt, tokenId): %+v %v", list, err)
	}
	if page, _ := s.ListRegistryRecords(ctx, 1, 1); len(page) != 1 || page[0].Sym != "B" {
		t.Fatalf("page (1,1) = %+v", page)
	}
	ids, err := s.AllRegistryTokenIDs(ctx)
	if err != nil || strings.Join(ids, ",") != stHex(0xaa)+"_0,"+stHex(0xbb)+"_0,"+stHex(0xcc)+"_0" {
		t.Fatalf("all ids = %v %v", ids, err)
	}
	if err := s.DeleteRegistryRecord(ctx, stHex(0xaa)+"_0"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.FindRegistryRecord(ctx, stHex(0xaa)+"_0"); got != nil {
		t.Fatal("not deleted")
	}
}

// Every list method answers [] (JSON), never null, on an empty database.
func TestListMethodsReturnEmptyNotNil(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestStore(t)
	tok := stHex(0xaa) + "_0"
	check := func(name string, n int, isNil bool, err error) {
		t.Helper()
		if err != nil || isNil || n != 0 {
			t.Fatalf("%s: len %d nil %v err %v", name, n, isNil, err)
		}
	}
	a, err := s.OwnerJournalByOutpoint(ctx, stHex(1), 0)
	check("OwnerJournalByOutpoint", len(a), a == nil, err)
	b, err := s.DistinctOwnerTopics(ctx)
	check("DistinctOwnerTopics", len(b), b == nil, err)
	c, err := s.FindTokensByTokenID(ctx, tok, 10, 0)
	check("FindTokensByTokenID", len(c), c == nil, err)
	d, err := s.ListAuthorities(ctx, "tm_"+stHex(0xaa), tok)
	check("ListAuthorities", len(d), d == nil, err)
	e, err := s.ListLinkage(ctx, 10, nil)
	check("ListLinkage", len(e), e == nil, err)
	f, err := s.FindLinkageByOutpoints(ctx, nil)
	check("FindLinkageByOutpoints", len(f), f == nil, err)
	g, err := s.FindAdminHistory(ctx, tok, 0, 0)
	check("FindAdminHistory", len(g), g == nil, err)
	h, err := s.PageAdminHistoryNewestFirst(ctx, tok, 10, 0)
	check("PageAdminHistoryNewestFirst", len(h), h == nil, err)
	i, err := s.TokenIDsWithHistory(ctx)
	check("TokenIDsWithHistory", len(i), i == nil, err)
	j, err := s.TokensTouchedBy(ctx, stHex(1))
	check("TokensTouchedBy", len(j), j == nil, err)
	k, err := s.ListRegistryRecords(ctx, 10, 0)
	check("ListRegistryRecords", len(k), k == nil, err)
	l, err := s.AllRegistryTokenIDs(ctx)
	check("AllRegistryTokenIDs", len(l), l == nil, err)
	m, err := s.IndexedVoutsByTxid(ctx, stHex(1))
	check("IndexedVoutsByTxid", len(m), m == nil, err)
	n, err := s.AllMetadata(ctx)
	check("AllMetadata", len(n), n == nil, err)
}

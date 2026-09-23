package mandala

import (
	"context"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

func testDB(t *testing.T) *mongo.Database {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI("mongodb://localhost:27017"))
	if err != nil {
		t.Skip("mongo unavailable:", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		t.Skip("mongo unavailable:", err)
	}
	db := client.Database("mandala_go_test")
	t.Cleanup(func() { _ = db.Drop(context.Background()) })
	return db
}

// mustStore builds a Store and fails the test if index creation does not
// succeed — NewStore aborts on that (wire contract §9.9), so tests must too
// rather than running against a half-indexed database.
func mustStore(t *testing.T, db *mongo.Database) *Store {
	t.Helper()
	s, err := NewStore(db)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return s
}

func TestTokenLifecycleAndBalances(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	row := TokenRow{Txid: "aa", OutputIndex: 1, AssetID: "a.0", Amount: 40, IdentityKey: "02k", CreatedAt: time.Now()}
	if err := s.StoreToken(ctx, row); err != nil {
		t.Fatal(err)
	}
	if err := s.StoreToken(ctx, row); err == nil {
		t.Fatal("duplicate outpoint must violate unique index")
	}
	got, err := s.GetTokenRow(ctx, "aa", 1)
	if err != nil || got == nil || got.Amount != 40 {
		t.Fatalf("%+v %v", got, err)
	}
	_ = s.AdjustBalance(ctx, "02k", 40)
	_ = s.AdjustBalance(ctx, "02k", -15)
	if b, _ := s.GetBalance(ctx, "02k"); b != 25 {
		t.Fatalf("balance %d", b)
	}
	if err := s.DeleteToken(ctx, "aa", 1); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetTokenRow(ctx, "aa", 1); got != nil {
		t.Fatal("token not deleted")
	}
}

func TestFindByAssetIDExcludesEvicted(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	_ = s.StoreToken(ctx, TokenRow{Txid: "t1", OutputIndex: 0, AssetID: "a.0", Amount: 1, CreatedAt: time.Now()})
	_ = s.StoreToken(ctx, TokenRow{Txid: "t2", OutputIndex: 0, AssetID: "a.0", Amount: 1, CreatedAt: time.Now()})
	st := DefaultAssetState("a.0")
	st.EvictedOutpoints = []string{"t2.0"}
	_ = s.PutAssetState(ctx, st)
	ops, err := s.FindByAssetID(ctx, "a.0")
	if err != nil || len(ops) != 1 || ops[0].Txid != "t1" {
		t.Fatalf("%+v %v", ops, err)
	}
}

func TestAdminHistoryOrderingAndSummary(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	seq1, _ := s.NextAdmitSeq(ctx)
	seq2, _ := s.NextAdmitSeq(ctx)
	if seq2 != seq1+1 {
		t.Fatalf("admitSeq not monotonic: %d %d", seq1, seq2)
	}
	unconfirmed := int64(9007199254740991)
	_ = s.AppendAdminHistory(ctx, AdminHistoryEntry{AssetID: "a.0", Txid: "t2", Height: unconfirmed, AdmitSeq: seq2,
		ActionDetails: ActionDetails{"kind": "issue", "amount": float64(100)}, CreatedAt: time.Now()})
	_ = s.AppendAdminHistory(ctx, AdminHistoryEntry{AssetID: "a.0", Txid: "t1", Height: 10, Offset: 3, AdmitSeq: seq1,
		ActionDetails: ActionDetails{"kind": "redeem", "amount": float64(30)}, CreatedAt: time.Now()})
	hist, err := s.FindAdminHistoryByAssetID(ctx, "a.0")
	if err != nil || len(hist) != 2 || hist[0].Txid != "t1" {
		t.Fatalf("sorted history: %+v %v", hist, err)
	}
	page, _ := s.PageAdminHistory(ctx, "a.0", 1, 0)
	if len(page) != 1 || page[0].AdmitSeq != seq2 {
		t.Fatalf("page newest-first: %+v", page)
	}
	iss, red, count, err := s.AdminSummary(ctx, "a.0")
	if err != nil || iss != 100 || red != 30 || count != 2 {
		t.Fatalf("summary %d %d %d %v", iss, red, count, err)
	}
}

// TestAdminSummaryDedupsReAdmits mirrors overlay/src/index.ts: GASP re-sync /
// reorg replay appends a duplicate history row for the same on-chain action
// with a fresh admitSeq — the summary must collapse to one row per
// (txid, outputIndex) before summing, or totals double-count.
func TestAdminSummaryDedupsReAdmits(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	seq1, _ := s.NextAdmitSeq(ctx)
	seq2, _ := s.NextAdmitSeq(ctx)
	seq3, _ := s.NextAdmitSeq(ctx)
	issue := AdminHistoryEntry{AssetID: "a.0", Txid: "t1", OutputIndex: 0, Height: 10, AdmitSeq: seq1,
		ActionDetails: ActionDetails{"kind": "issue", "amount": float64(100)}, CreatedAt: time.Now()}
	_ = s.AppendAdminHistory(ctx, issue)
	readmit := issue
	readmit.AdmitSeq = seq2
	_ = s.AppendAdminHistory(ctx, readmit)
	_ = s.AppendAdminHistory(ctx, AdminHistoryEntry{AssetID: "a.0", Txid: "t2", OutputIndex: 0, Height: 11, AdmitSeq: seq3,
		ActionDetails: ActionDetails{"kind": "redeem", "amount": float64(30)}, CreatedAt: time.Now()})
	iss, red, count, err := s.AdminSummary(ctx, "a.0")
	if err != nil || iss != 100 || red != 30 || count != 2 {
		t.Fatalf("re-admit dedup: got iss=%d red=%d count=%d err=%v, want 100 30 2", iss, red, count, err)
	}
}

// TestNextAdmitSeqPropagatesRealErrors asserts that a genuine driver error
// (here: an already-canceled context) surfaces to the caller as an error
// with seq=0, rather than being swallowed into the TS-parity (1, nil)
// fallback — which must be reserved for the "no document yet" case only.
func TestNextAdmitSeqPropagatesRealErrors(t *testing.T) {
	s := mustStore(t, testDB(t))
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already canceled — FindOneAndUpdate must fail with a real error
	seq, err := s.NextAdmitSeq(ctx)
	if err == nil {
		t.Fatalf("want error for canceled context, got seq=%d, err=nil", seq)
	}
	if seq != 0 {
		t.Fatalf("want seq=0 on error, got %d", seq)
	}
}

func TestGetAssetStateDefault(t *testing.T) {
	s := mustStore(t, testDB(t))
	st, err := s.GetAssetState(context.Background(), "missing.0")
	if err != nil || st.AccessMode != "denylist" || st.BlockedIdentities == nil {
		t.Fatalf("%+v %v", st, err)
	}
}

// TestLinkageReadsTSShapeDocument inserts a raw document in the EXACT shape
// the TS overlay writes (camelCase keys; protocolID as a 2-element BSON
// array; encryptedLinkage/encryptedLinkageProof as BSON arrays of numbers,
// not binary) and verifies the Go store reads it back correctly. This is
// the "existing demo data survives" direction: old TS-written documents
// must still decode cleanly through the Go port.
func TestLinkageReadsTSShapeDocument(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))

	tsDoc := bson.D{
		{Key: "txid", Value: "deadbeef"},
		{Key: "outputIndex", Value: int32(0)},
		{Key: "identityKey", Value: "02aa"},
		{Key: "linkage", Value: bson.D{
			{Key: "prover", Value: "02aa"},
			{Key: "verifier", Value: "02bb"},
			{Key: "counterparty", Value: "02cc"},
			{Key: "protocolID", Value: bson.A{int32(2), "mandala token"}},
			{Key: "keyID", Value: "k1"},
			{Key: "encryptedLinkage", Value: bson.A{int32(1), int32(2), int32(3)}},
			{Key: "encryptedLinkageProof", Value: bson.A{int32(0)}},
			{Key: "proofType", Value: int32(0)},
		}},
		{Key: "createdAt", Value: time.Now()},
	}
	if _, err := s.linkage.InsertOne(ctx, tsDoc); err != nil {
		t.Fatal(err)
	}

	row, err := s.GetLinkageRow(ctx, "deadbeef", 0)
	if err != nil {
		t.Fatal(err)
	}
	if row == nil {
		t.Fatal("expected linkage row, got nil")
	}
	l := row.Linkage
	if l.Prover != "02aa" || l.Verifier != "02bb" || l.Counterparty != "02cc" {
		t.Fatalf("identity fields: %+v", l)
	}
	if l.ProtocolID.SecurityLevel != 2 || l.ProtocolID.Name != "mandala token" {
		t.Fatalf("protocolID: %+v", l.ProtocolID)
	}
	if l.KeyID != "k1" || l.ProofType != 0 {
		t.Fatalf("keyID/proofType: %+v", l)
	}
	if string(l.EncryptedLinkage) != "\x01\x02\x03" {
		t.Fatalf("encryptedLinkage: %v", []byte(l.EncryptedLinkage))
	}
	if string(l.EncryptedLinkageProof) != "\x00" {
		t.Fatalf("encryptedLinkageProof: %v", []byte(l.EncryptedLinkageProof))
	}
}

// TestListMethodsReturnEmptyNotNil asserts that every list-returning Store
// method yields a non-nil, zero-length slice (JSON `[]`) on a fresh, empty
// database rather than a nil slice (JSON `null`). mongo-driver v2's
// cursor.All on a `var rows []T` leaves rows nil when the cursor yields zero
// documents, so each method under test must guard against that.
func TestListMethodsReturnEmptyNotNil(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))

	t.Run("FindByOutpoint", func(t *testing.T) {
		rows, err := s.FindByOutpoint(ctx, "nonexistent", 0)
		if err != nil {
			t.Fatal(err)
		}
		if rows == nil || len(rows) != 0 {
			t.Fatalf("want non-nil empty slice, got %#v", rows)
		}
	})

	t.Run("ListLinkage", func(t *testing.T) {
		rows, err := s.ListLinkage(ctx, 10, nil)
		if err != nil {
			t.Fatal(err)
		}
		if rows == nil || len(rows) != 0 {
			t.Fatalf("want non-nil empty slice, got %#v", rows)
		}
	})

	t.Run("FindLinkageByOutpoints", func(t *testing.T) {
		// Non-empty input, zero matches — must not short-circuit via the
		// empty-input special case, and must not return nil either.
		rows, err := s.FindLinkageByOutpoints(ctx, []Outpoint{{Txid: "nonexistent", OutputIndex: 0}})
		if err != nil {
			t.Fatal(err)
		}
		if rows == nil || len(rows) != 0 {
			t.Fatalf("want non-nil empty slice, got %#v", rows)
		}
	})

	t.Run("FindMetadataByAssetID", func(t *testing.T) {
		rows, err := s.FindMetadataByAssetID(ctx, "nonexistent.0")
		if err != nil {
			t.Fatal(err)
		}
		if rows == nil || len(rows) != 0 {
			t.Fatalf("want non-nil empty slice, got %#v", rows)
		}
	})

	t.Run("FindAdminHistoryByAssetID", func(t *testing.T) {
		rows, err := s.FindAdminHistoryByAssetID(ctx, "nonexistent.0")
		if err != nil {
			t.Fatal(err)
		}
		if rows == nil || len(rows) != 0 {
			t.Fatalf("want non-nil empty slice, got %#v", rows)
		}
	})

	t.Run("PageAdminHistory", func(t *testing.T) {
		rows, err := s.PageAdminHistory(ctx, "nonexistent.0", 10, 0)
		if err != nil {
			t.Fatal(err)
		}
		if rows == nil || len(rows) != 0 {
			t.Fatalf("want non-nil empty slice, got %#v", rows)
		}
	})
}

// TestStoreLinkageWritesTSShape writes a LinkageRow via the Go store's
// StoreLinkage, then decodes the RAW document with a plain bson.M and
// asserts the on-the-wire shape matches what the TS overlay would have
// written: camelCase field names, protocolID as a 2-element bson.A, and
// encryptedLinkage/encryptedLinkageProof as bson.A of numbers rather than
// BSON binary.
func TestStoreLinkageWritesTSShape(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))

	row := LinkageRow{
		Txid:        "cafef00d",
		OutputIndex: 2,
		IdentityKey: "02dd",
		Linkage: SpecificLinkage{
			Prover:                "02aa",
			Verifier:              "02bb",
			Counterparty:          "02cc",
			ProtocolID:            ProtocolID{SecurityLevel: 2, Name: "mandala token"},
			KeyID:                 "k1",
			EncryptedLinkage:      NumBytes{1, 2, 3},
			EncryptedLinkageProof: NumBytes{0},
			ProofType:             0,
		},
		CreatedAt: time.Now(),
	}
	if err := s.StoreLinkage(ctx, row); err != nil {
		t.Fatal(err)
	}

	var raw bson.M
	if err := s.linkage.FindOne(ctx, bson.D{{Key: "txid", Value: "cafef00d"}}).Decode(&raw); err != nil {
		t.Fatal(err)
	}

	// Nested subdocuments decode as bson.D (order-preserving) by default,
	// even when the top-level target is a bson.M — flatten to a map for
	// key-presence assertions.
	linkageD, ok := raw["linkage"].(bson.D)
	if !ok {
		t.Fatalf("linkage subdoc: got %T: %+v", raw["linkage"], raw["linkage"])
	}
	linkage := make(bson.M, len(linkageD))
	for _, e := range linkageD {
		linkage[e.Key] = e.Value
	}

	// camelCase TS key names must be present (not lowercased Go defaults).
	for _, key := range []string{"prover", "verifier", "counterparty", "protocolID", "keyID", "encryptedLinkage", "encryptedLinkageProof", "proofType"} {
		if _, ok := linkage[key]; !ok {
			t.Fatalf("missing TS-shape key %q in %+v", key, linkage)
		}
	}
	for _, badKey := range []string{"protocolid", "keyid", "encryptedlinkage", "encryptedlinkageproof", "prooftype"} {
		if _, ok := linkage[badKey]; ok {
			t.Fatalf("found lowercased Go-default key %q; want TS camelCase", badKey)
		}
	}

	protocolID, ok := linkage["protocolID"].(bson.A)
	if !ok || len(protocolID) != 2 {
		t.Fatalf("protocolID: got %T len %v: %+v", linkage["protocolID"], len(protocolID), linkage["protocolID"])
	}

	encLinkage, ok := linkage["encryptedLinkage"].(bson.A)
	if !ok {
		t.Fatalf("encryptedLinkage: got %T (want bson.A of numbers, not binary): %+v", linkage["encryptedLinkage"], linkage["encryptedLinkage"])
	}
	if len(encLinkage) != 3 {
		t.Fatalf("encryptedLinkage length: %+v", encLinkage)
	}
}

// --- broadcast-failure compensation (SnapshotTokens / RestoreTokens) ---

// TestSnapshotAndRestoreTokensRoundTrip mirrors the broadcast-failure
// compensation flow: snapshot the input token rows before submit, lose them
// to OutputSpent (delete + balance decrement), then restore — rows come back
// and the balance is re-credited.
func TestSnapshotAndRestoreTokensRoundTrip(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))

	owned := TokenRow{Txid: "aa", OutputIndex: 0, AssetID: "a.0", Amount: 40, IdentityKey: "02k", CreatedAt: time.Now()}
	anon := TokenRow{Txid: "bb", OutputIndex: 2, AssetID: "a.0", Amount: 7, IdentityKey: "", CreatedAt: time.Now()}
	if err := s.StoreToken(ctx, owned); err != nil {
		t.Fatal(err)
	}
	if err := s.StoreToken(ctx, anon); err != nil {
		t.Fatal(err)
	}
	if err := s.AdjustBalance(ctx, "02k", 40); err != nil {
		t.Fatal(err)
	}

	// Snapshot the tx's input outpoints — including one that has no token
	// row at all (a plain sats input), which must simply be absent.
	snapshot, err := s.SnapshotTokens(ctx, []Outpoint{
		{Txid: "aa", OutputIndex: 0},
		{Txid: "bb", OutputIndex: 2},
		{Txid: "cc", OutputIndex: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot) != 2 {
		t.Fatalf("snapshot rows = %d, want 2", len(snapshot))
	}

	// Simulate ls_mandala.OutputSpent on both rows.
	if err := s.AdjustBalance(ctx, "02k", -40); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteToken(ctx, "aa", 0); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteToken(ctx, "bb", 2); err != nil {
		t.Fatal(err)
	}

	if err := s.RestoreTokens(ctx, snapshot); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetTokenRow(ctx, "aa", 0)
	if err != nil || got == nil {
		t.Fatal(got, err)
	}
	if got.Amount != 40 || got.IdentityKey != "02k" || got.AssetID != "a.0" {
		t.Fatalf("restored row: %+v", got)
	}
	if got, _ := s.GetTokenRow(ctx, "bb", 2); got == nil || got.Amount != 7 || got.IdentityKey != "" {
		t.Fatalf("restored anon row: %+v", got)
	}
	if b, _ := s.GetBalance(ctx, "02k"); b != 40 {
		t.Fatalf("balance after restore = %d, want 40", b)
	}
}

// TestRestoreTokensIdempotent proves a re-run (retry after a partial
// failure, or a double compensation) neither duplicates rows nor
// double-credits balances: the balance is only re-incremented when the
// upsert actually re-inserted the row.
func TestRestoreTokensIdempotent(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))

	row := TokenRow{Txid: "dd", OutputIndex: 1, AssetID: "a.0", Amount: 25, IdentityKey: "02k", CreatedAt: time.Now()}
	if err := s.StoreToken(ctx, row); err != nil {
		t.Fatal(err)
	}
	if err := s.AdjustBalance(ctx, "02k", 25); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.SnapshotTokens(ctx, []Outpoint{{Txid: "dd", OutputIndex: 1}})
	if err != nil || len(snapshot) != 1 {
		t.Fatalf("snapshot: %d rows, err %v", len(snapshot), err)
	}
	if err := s.AdjustBalance(ctx, "02k", -25); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteToken(ctx, "dd", 1); err != nil {
		t.Fatal(err)
	}

	if err := s.RestoreTokens(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	if err := s.RestoreTokens(ctx, snapshot); err != nil {
		t.Fatal(err)
	}

	if b, _ := s.GetBalance(ctx, "02k"); b != 25 {
		t.Fatalf("balance after double restore = %d, want 25 (no double credit)", b)
	}
	n, err := s.tokens.CountDocuments(ctx, bson.D{{Key: "txid", Value: "dd"}, {Key: "outputIndex", Value: 1}})
	if err != nil || n != 1 {
		t.Fatalf("row count after double restore = %d err %v, want 1", n, err)
	}

	// Restoring rows that were never deleted must also not double-credit.
	if err := s.RestoreTokens(ctx, snapshot); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.GetBalance(ctx, "02k"); b != 25 {
		t.Fatalf("balance = %d, want 25", b)
	}
}

func TestSnapshotTokensEmpty(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	rows, err := s.SnapshotTokens(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("rows = %d, want 0", len(rows))
	}
	if err := s.RestoreTokens(ctx, nil); err != nil {
		t.Fatal("empty restore:", err)
	}
}

// Wire contract §9.9 — index creation failures abort startup. A pre-existing
// index with the same key but different options is the deterministic way to
// make Mongo refuse (it will not silently change an existing index's options),
// and it stands in for every other reason index creation can fail: the
// constructor must refuse to hand back a Store that is missing the uniqueness
// its invariants rest on.
func TestNewStoreAbortsWhenAnIndexCannotBeCreated(t *testing.T) {
	ctx := context.Background()
	db := testDB(t)
	// NewStore wants {txid:1} UNIQUE on mandalaAdmissions ("one verdict per
	// transaction"). Two rows already sharing a txid make that index
	// impossible to build — the same situation a node would hit on a database
	// that had been written without it.
	if _, err := db.Collection(AdmissionsCollection).InsertMany(ctx, []any{
		bson.D{{Key: "txid", Value: recTxid}},
		bson.D{{Key: "txid", Value: recTxid}},
	}); err != nil {
		t.Fatal("seeding the duplicate rows:", err)
	}
	s, err := NewStore(db)
	if err == nil {
		t.Fatal("NewStore returned a Store without the unique admissions index")
	}
	if s != nil {
		t.Fatalf("NewStore returned a non-nil Store alongside its error: %+v", s)
	}
	if !strings.Contains(err.Error(), AdmissionsCollection) {
		t.Fatalf("error must name the collection that failed, got: %v", err)
	}
}

func TestAssetStateFeeRateRoundTripsAndClears(t *testing.T) {
	ctx := context.Background()
	store := mustStore(t, testDB(t))
	st := DefaultAssetState("fee.0")
	seven := int64(7)
	st.FeeRatePerKb = &seven
	if err := store.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetAssetState(ctx, "fee.0")
	if err != nil {
		t.Fatal(err)
	}
	if got.FeeRatePerKb == nil || *got.FeeRatePerKb != 7 {
		t.Fatalf("feeRatePerKb after set = %v, want 7", got.FeeRatePerKb)
	}
	st.FeeRatePerKb = nil
	if err := store.PutAssetState(ctx, st); err != nil {
		t.Fatal(err)
	}
	got, err = store.GetAssetState(ctx, "fee.0")
	if err != nil {
		t.Fatal(err)
	}
	if got.FeeRatePerKb != nil {
		t.Fatalf("feeRatePerKb after clear = %d, want nil (bson must not be omitempty)", *got.FeeRatePerKb)
	}
}

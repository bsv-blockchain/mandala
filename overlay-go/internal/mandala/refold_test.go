package mandala

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

func refoldStore(t *testing.T) (*Store, *mongo.Database, context.Context) {
	t.Helper()
	db := testmongo.DB(t, "mandala3_test_refold")
	st, err := NewStore(db)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return st, db, ctx
}

func refoldTx(n byte) string { return strings.Repeat(fmt.Sprintf("%02x", n), 32) }

func refoldEntry(t *testing.T, tokenID, txid string, vout uint32, seq int64, d AdminDetails) AdminHistoryEntry {
	t.Helper()
	raw, err := EncodeAdminDetails(d)
	if err != nil {
		t.Fatalf("encode %s: %v", d.Kind, err)
	}
	sum := sha256.Sum256(raw)
	return AdminHistoryEntry{TokenID: tokenID, Txid: txid, OutputIndex: vout, Kind: d.Kind, DetailsHex: hex.EncodeToString(raw),
		Commitment: hex.EncodeToString(sum[:]), Height: 800000, Offset: seq, AdmitSeq: seq, CreatedAt: time.Now().UTC()}
}

func refoldAppend(t *testing.T, ctx context.Context, st *Store, entries ...AdminHistoryEntry) {
	t.Helper()
	for _, e := range entries {
		if inserted, err := st.AppendAdminHistory(ctx, e); err != nil || !inserted {
			t.Fatalf("append %s.%d: inserted=%v err=%v", e.Txid, e.OutputIndex, inserted, err)
		}
	}
}

func refoldCount(t *testing.T, ctx context.Context, db *mongo.Database, coll string, filter bson.D) int64 {
	t.Helper()
	n, err := db.Collection(coll).CountDocuments(ctx, filter)
	if err != nil {
		t.Fatalf("count %s: %v", coll, err)
	}
	return n
}

func TestRebuildStateStartsFromTheDeployFeeRate(t *testing.T) {
	st, db, ctx := refoldStore(t)
	tok := refoldTx(0x11) + "_0"
	fee := int64(25)
	if err := st.StoreMetadata(ctx, MetadataRecord{TokenID: tok, Txid: refoldTx(0x11), OutputIndex: 0, Sym: "USD", Dec: 2, Label: "US Dollar", FeeRatePerKb: &fee}); err != nil {
		t.Fatal(err)
	}
	if err := RebuildState(ctx, st, tok, ""); err != nil {
		t.Fatal(err)
	}
	s, err := st.GetAssetState(ctx, tok)
	if err != nil || s.FeeRatePerKb == nil || *s.FeeRatePerKb != 25 {
		t.Fatalf("state = %+v, %v; want fee 25 from the deploy metadata", s, err)
	}
	if n := refoldCount(t, ctx, db, AssetStatesCollection, bson.D{{Key: "tokenId", Value: tok}}); n != 1 {
		t.Fatalf("%d state docs, want 1", n)
	}
}

func TestRebuildStateWithNoHistoryWritesADefaultState(t *testing.T) {
	st, db, ctx := refoldStore(t)
	tok := refoldTx(0x12) + "_0"
	if err := RebuildState(ctx, st, tok, ""); err != nil {
		t.Fatal(err)
	}
	s, err := st.GetAssetState(ctx, tok)
	if err != nil || !reflect.DeepEqual(s, DefaultAssetState(tok, nil)) {
		t.Fatalf("state = %+v, %v; want the default", s, err)
	}
	if n := refoldCount(t, ctx, db, AssetStatesCollection, bson.D{{Key: "tokenId", Value: tok}}); n != 1 {
		t.Fatalf("%d state docs, want 1 (the default is written)", n)
	}
}

func TestRebuildStateSkipsTheExcludedTxid(t *testing.T) {
	st, _, ctx := refoldStore(t)
	tok := refoldTx(0x13) + "_0"
	tx1, tx2 := refoldTx(0x21), refoldTx(0x22)
	refoldAppend(t, ctx, st, refoldEntry(t, tok, tx1, 0, 1, AdminDetails{Kind: "pause"}), refoldEntry(t, tok, tx2, 0, 2, AdminDetails{Kind: "unpause"}))
	if err := RebuildState(ctx, st, tok, tx2); err != nil {
		t.Fatal(err)
	}
	if s, _ := st.GetAssetState(ctx, tok); !s.IsPaused || s.LastAdmitSeq != 1 {
		t.Fatalf("without %s: %+v; want paused at admitSeq 1", tx2, s)
	}
	if err := RebuildState(ctx, st, tok, ""); err != nil {
		t.Fatal(err)
	}
	if s, _ := st.GetAssetState(ctx, tok); s.IsPaused || s.LastAdmitSeq != 2 {
		t.Fatalf("full refold: %+v; want unpaused at admitSeq 2", s)
	}
}

func TestRebuildStateFoldContexts(t *testing.T) {
	st, _, ctx := refoldStore(t)
	holder, receiver := mandalatest.Holder.Identity, mandalatest.Receiver.Identity
	tokA, tokB, tokC := refoldTx(0x14)+"_0", refoldTx(0x15)+"_0", refoldTx(0x16)+"_0"
	rowTx, rowTxC := refoldTx(0x31), refoldTx(0x32)
	for _, r := range []TokenRecord{
		{Txid: rowTx, OutputIndex: 1, TokenID: tokA, Amount: 100, IdentityKey: holder, CreatedAt: time.Now().UTC()},
		{Txid: rowTxC, OutputIndex: 1, TokenID: tokC, Amount: 50, IdentityKey: holder, CreatedAt: time.Now().UTC()},
	} {
		if _, err := st.StoreTokenIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	recorded := refoldEntry(t, tokA, refoldTx(0x41), 0, 1, AdminDetails{Kind: "freezeOutput", Outpoint: rowTx + ".1"})
	recorded.FrozenAmount, recorded.FrozenOwner = foldAmount(7), foldString(strings.ToUpper(receiver))
	refoldAppend(t, ctx, st, recorded,
		refoldEntry(t, tokB, refoldTx(0x42), 0, 2, AdminDetails{Kind: "freezeOutput", Outpoint: rowTx + ".1"}),
		refoldEntry(t, tokC, refoldTx(0x43), 0, 3, AdminDetails{Kind: "freezeOutput", Outpoint: rowTxC + ".1"}))
	cases := []struct {
		tok  string
		want FrozenRef
	}{
		{tokA, FrozenRef{Outpoint: rowTx + ".1", Amount: 7, Owner: receiver}}, // the recorded context wins over the live row
		{tokB, FrozenRef{Outpoint: rowTx + ".1", Amount: 0, Owner: ""}},       // another token's row is no target
		{tokC, FrozenRef{Outpoint: rowTxC + ".1", Amount: 50, Owner: holder}}, // nothing recorded: read live
	}
	for _, c := range cases {
		if err := RebuildState(ctx, st, c.tok, ""); err != nil {
			t.Fatal(err)
		}
		s, _ := st.GetAssetState(ctx, c.tok)
		if !slices.Equal(s.FrozenOutpoints, []FrozenRef{c.want}) {
			t.Fatalf("%s frozen = %+v, want [%+v]", c.tok, s.FrozenOutpoints, c.want)
		}
	}
}

func TestRebuildStateAbortsOnCorruptDetailsWithoutWriting(t *testing.T) {
	st, _, ctx := refoldStore(t)
	tok := refoldTx(0x17) + "_0"
	paused := DefaultAssetState(tok, nil)
	paused.IsPaused, paused.LastAdmitSeq = true, 9
	if err := st.PutAssetState(ctx, paused); err != nil {
		t.Fatal(err)
	}
	bad := refoldEntry(t, tok, refoldTx(0x51), 0, 1, AdminDetails{Kind: "unpause"})
	bad.DetailsHex = "zz"
	refoldAppend(t, ctx, st, bad)
	err := RebuildState(ctx, st, tok, "")
	var rej *RejectError
	if !errors.As(err, &rej) || rej.Code != CodeShape {
		t.Fatalf("corrupt details: %v; want an ERR_SHAPE schema refusal", err)
	}
	if s, _ := st.GetAssetState(ctx, tok); !s.IsPaused || s.LastAdmitSeq != 9 {
		t.Fatalf("state rewritten after an aborted refold: %+v", s)
	}
}

func TestPurgeAndRefoldRefoldsBeforeDeleting(t *testing.T) {
	st, _, ctx := refoldStore(t)
	tokA, tokB := refoldTx(0x18)+"_0", refoldTx(0x19)+"_0"
	tx1, tx2 := refoldTx(0x61), refoldTx(0x62)
	nine := int64(9)
	refoldAppend(t, ctx, st,
		refoldEntry(t, tokA, tx1, 0, 1, AdminDetails{Kind: "pause"}),
		refoldEntry(t, tokA, tx2, 0, 2, AdminDetails{Kind: "unpause"}),
		refoldEntry(t, tokB, tx2, 1, 3, AdminDetails{Kind: "setFeeRate", FeeRatePerKb: &nine, HasFeeRatePerKb: true}))
	// an eviction interrupted after its refold and before its delete
	if err := RebuildState(ctx, st, tokA, tx2); err != nil {
		t.Fatal(err)
	}
	ids, err := PurgeAndRefold(ctx, st, tx2)
	if err != nil || !slices.Equal(ids, []string{tokA, tokB}) {
		t.Fatalf("PurgeAndRefold = %v, %v; want [%s %s]", ids, err, tokA, tokB)
	}
	if s, _ := st.GetAssetState(ctx, tokA); !s.IsPaused {
		t.Fatalf("%s not paused after purging the unpause", tokA)
	}
	if s, _ := st.GetAssetState(ctx, tokB); s.FeeRatePerKb != nil {
		t.Fatalf("%s fee rate %v survived its purged action", tokB, *s.FeeRatePerKb)
	}
	history, err := st.FindAdminHistory(ctx, tokA, 0, 0)
	if err != nil || len(history) != 1 || history[0].Txid != tx1 {
		t.Fatalf("history of %s = %+v, %v; want only %s", tokA, history, err, tx1)
	}
	if ids, err := PurgeAndRefold(ctx, st, tx2); err != nil || len(ids) != 0 {
		t.Fatalf("replayed purge = %v, %v; want nothing touched", ids, err)
	}
}

func TestRestoreInputRowCreditsOnce(t *testing.T) {
	st, _, ctx := refoldStore(t)
	holder := mandalatest.Holder.Identity
	j := OwnerRecord{Txid: refoldTx(0x71), OutputIndex: 1, Topic: "tm_" + refoldTx(0x1a), TokenID: refoldTx(0x1a) + "_0",
		Role: "value", Amount: 100, IdentityKey: holder, CreatedAt: time.Now().UTC()}
	for i, want := range []bool{true, false} {
		inserted, err := RestoreInputRow(ctx, st, j)
		if err != nil || inserted != want {
			t.Fatalf("restore #%d: inserted=%v err=%v, want %v", i+1, inserted, err, want)
		}
	}
	if bal, err := st.GetBalance(ctx, holder); err != nil || bal != 100 {
		t.Fatalf("balance = %d, %v; want 100 (credited once)", bal, err)
	}
}

func TestRetireOutputsDebitsOnceAndKeepsKYCRows(t *testing.T) {
	st, db, ctx := refoldStore(t)
	tx := refoldTx(0x81)
	tok := tx + "_0"
	holder, issuer := mandalatest.Holder.Identity, mandalatest.Issuer.Identity
	now := time.Now().UTC()
	if _, err := st.StoreTokenIfAbsent(ctx, TokenRecord{Txid: tx, OutputIndex: 1, TokenID: tok, Amount: 100, IdentityKey: holder, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := st.AdjustBalance(ctx, holder, 100); err != nil {
		t.Fatal(err)
	}
	if _, err := st.StoreAuthorityIfAbsent(ctx, AuthorityRecord{Txid: tx, OutputIndex: 0, Topic: "tm_" + tx, TokenID: tok, IdentityKey: issuer, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := st.StoreMetadata(ctx, MetadataRecord{TokenID: tok, Txid: tx, OutputIndex: 0, Sym: "USD", Dec: 2, Label: "US Dollar"}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.StoreRegistryRecord(ctx, TokenRegistryRecord{TokenID: tok, DeployTxid: tx, Sym: "USD", Dec: 2, Label: "US Dollar", Issuer: issuer, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	// a KYC row folded from an action of this txid (Task 17 writes these; inserted directly here)
	if _, err := db.Collection(KYCRegistryCollection).InsertOne(ctx, bson.D{
		{Key: "identityKey", Value: holder}, {Key: "status", Value: "admitted"}, {Key: "txid", Value: tx},
		{Key: "outputIndex", Value: 2}, {Key: "admitSeq", Value: 1}, {Key: "createdAt", Value: now},
	}); err != nil {
		t.Fatal(err)
	}

	n, err := RetireOutputs(ctx, st, tx)
	if err != nil || n != 2 {
		t.Fatalf("RetireOutputs = %d, %v; want 2 rows retired", n, err)
	}
	if row, _ := st.GetTokenRow(ctx, tx, 1); row != nil {
		t.Fatalf("token row kept: %+v", row)
	}
	if row, _ := st.GetAuthorityRow(ctx, tx, 0); row != nil {
		t.Fatalf("authority row kept: %+v", row)
	}
	if md, _ := st.FindMetadata(ctx, tok); md != nil {
		t.Fatalf("metadata kept: %+v", md)
	}
	if r, _ := st.FindRegistryRecord(ctx, tok); r != nil {
		t.Fatalf("registry record kept: %+v", r)
	}
	if n := refoldCount(t, ctx, db, KYCRegistryCollection, bson.D{{Key: "identityKey", Value: holder}}); n != 1 {
		t.Fatalf("%d KYC rows, want the row kept", n)
	}
	for i := 0; i < 2; i++ {
		if bal, _ := st.GetBalance(ctx, holder); bal != 0 {
			t.Fatalf("balance = %d, want 0 (debited exactly once)", bal)
		}
		if n, err := RetireOutputs(ctx, st, tx); err != nil || n != 0 {
			t.Fatalf("replayed retire = %d, %v; want 0", n, err)
		}
	}
}

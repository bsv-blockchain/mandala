package mandala

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

var (
	kycTokenA = strings.Repeat("a1", 32) + "_0"
	kycTokenB = strings.Repeat("b2", 32) + "_0"
	kycTx1    = strings.Repeat("c3", 32)
	kycTx2    = strings.Repeat("d4", 32)
)

func kycStore(t *testing.T) (*Store, *mongo.Database, context.Context) {
	t.Helper()
	db := testmongo.DB(t, "mandala3_test_kyc")
	st, err := NewStore(db)
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	return st, db, ctx
}

func TestKYCClaimFirstWins(t *testing.T) {
	st, _, ctx := kycStore(t)
	if id, ok, err := st.KYCRegistryTokenID(ctx); err != nil || ok || id != "" {
		t.Fatalf("before any claim = %q %v %v", id, ok, err)
	}
	if won, err := st.ClaimKYCRegistryTokenID(ctx, kycTokenA); err != nil || !won {
		t.Fatalf("first claim = %v, %v", won, err)
	}
	if won, err := st.ClaimKYCRegistryTokenID(ctx, kycTokenB); err != nil || won {
		t.Fatalf("second claim = %v, %v; want false", won, err)
	}
	if id, ok, err := st.KYCRegistryTokenID(ctx); err != nil || !ok || id != kycTokenA {
		t.Fatalf("claimed = %q %v %v; want %s", id, ok, err, kycTokenA)
	}
}

func TestKYCConcurrentClaimsHaveOneWinner(t *testing.T) {
	st, _, ctx := kycStore(t)
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners []string
	)
	for i := 0; i < 8; i++ {
		id := strings.Repeat(fmt.Sprintf("%02x", 0x10+i), 32) + "_0"
		wg.Add(1)
		go func() {
			defer wg.Done()
			won, err := st.ClaimKYCRegistryTokenID(ctx, id)
			if err != nil {
				t.Errorf("claim %s: %v", id, err)
				return
			}
			if won {
				mu.Lock()
				winners = append(winners, id)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if len(winners) != 1 {
		t.Fatalf("winners = %v, want exactly one", winners)
	}
	if id, _, _ := st.KYCRegistryTokenID(ctx); id != winners[0] {
		t.Fatalf("claimed %s, winner %s", id, winners[0])
	}
}

func TestKYCClaimIsNeitherAMemberNorListed(t *testing.T) {
	st, _, ctx := kycStore(t)
	if _, err := st.ClaimKYCRegistryTokenID(ctx, kycTokenA); err != nil {
		t.Fatal(err)
	}
	if active, err := st.KYCActive(ctx); err != nil || active {
		t.Fatalf("active after a claim alone = %v, %v", active, err)
	}
	if rows, err := st.ListKYC(ctx); err != nil || rows == nil || len(rows) != 0 {
		t.Fatalf("list after a claim alone = %v, %v; want an empty non-nil list", rows, err)
	}
}

func TestKYCApplyFoldsIntoOneRowPerIdentity(t *testing.T) {
	st, db, ctx := kycStore(t)
	holder := mandalatest.Holder.Identity
	if err := st.ApplyKYC(ctx, holder, "admitted", kycTx1, 0); err != nil {
		t.Fatal(err)
	}
	if err := st.ApplyKYC(ctx, holder, "revoked", kycTx2, 0); err != nil {
		t.Fatal(err)
	}
	rows, err := st.ListKYC(ctx)
	want := []KYCRow{{IdentityKey: holder, Status: "revoked", Txid: kycTx2, OutputIndex: 0, AdmitSeq: 2}}
	if err != nil || !slices.Equal(rows, want) {
		t.Fatalf("rows = %+v, %v; want %+v", rows, err, want)
	}
	if n, _ := db.Collection(KYCRegistryCollection).CountDocuments(ctx, bson.D{{Key: "identityKey", Value: holder}}); n != 1 {
		t.Fatalf("%d rows for one identity", n)
	}
	if ok, _ := st.KYCAdmitted(ctx, holder); ok {
		t.Fatal("a revoked identity reads admitted")
	}
}

func TestKYCReplayOfTheSameOutpointKeepsItsAdmitSeq(t *testing.T) {
	st, _, ctx := kycStore(t)
	holder, receiver := mandalatest.Holder.Identity, mandalatest.Receiver.Identity
	for i := 0; i < 2; i++ {
		if err := st.ApplyKYC(ctx, holder, "admitted", kycTx1, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.ApplyKYC(ctx, receiver, "admitted", kycTx2, 1); err != nil {
		t.Fatal(err)
	}
	rows, _ := st.ListKYC(ctx)
	want := []KYCRow{
		{IdentityKey: receiver, Status: "admitted", Txid: kycTx2, OutputIndex: 1, AdmitSeq: 2},
		{IdentityKey: holder, Status: "admitted", Txid: kycTx1, OutputIndex: 0, AdmitSeq: 1},
	}
	if !slices.Equal(rows, want) {
		t.Fatalf("rows = %+v, want %+v (newest first; a replay consumes no admitSeq)", rows, want)
	}
}

func TestKYCRevokedNeverAdmittedIsStillActive(t *testing.T) {
	st, _, ctx := kycStore(t)
	holder := mandalatest.Holder.Identity
	if err := st.ApplyKYC(ctx, holder, "revoked", kycTx1, 0); err != nil {
		t.Fatal(err)
	}
	if active, err := st.KYCActive(ctx); err != nil || !active {
		t.Fatalf("active = %v, %v; want true", active, err)
	}
	if ok, _ := st.KYCAdmitted(ctx, holder); ok {
		t.Fatal("revoked reads admitted")
	}
}

func TestKYCUsesItsOwnCounter(t *testing.T) {
	st, _, ctx := kycStore(t)
	if err := st.ApplyKYC(ctx, mandalatest.Holder.Identity, "admitted", kycTx1, 0); err != nil {
		t.Fatal(err)
	}
	if err := st.ApplyKYC(ctx, mandalatest.Receiver.Identity, "admitted", kycTx2, 0); err != nil {
		t.Fatal(err)
	}
	if seq, err := st.NextAdmitSeq(ctx); err != nil || seq != 1 {
		t.Fatalf("admitSeq = %d, %v; want 1 (KYC folds use registryAdmitSeq)", seq, err)
	}
}

func TestKYCMembershipReadsTheStore(t *testing.T) {
	st, _, ctx := kycStore(t)
	m := KYCMembership{Store: st}
	holder, receiver := mandalatest.Holder.Identity, mandalatest.Receiver.Identity
	if active, err := m.IsActive(ctx); err != nil || active {
		t.Fatalf("empty registry active = %v, %v", active, err)
	}
	if _, err := st.ClaimKYCRegistryTokenID(ctx, kycTokenA); err != nil {
		t.Fatal(err)
	}
	if active, _ := m.IsActive(ctx); active {
		t.Fatal("a claim alone activated membership")
	}
	if err := st.ApplyKYC(ctx, holder, "admitted", kycTx1, 0); err != nil {
		t.Fatal(err)
	}
	if err := st.ApplyKYC(ctx, receiver, "revoked", kycTx2, 0); err != nil {
		t.Fatal(err)
	}
	if active, _ := m.IsActive(ctx); !active {
		t.Fatal("membership inactive with identity rows")
	}
	for key, want := range map[string]bool{holder: true, receiver: false, mandalatest.Rogue.Identity: false} {
		if got, err := m.IsAdmitted(ctx, key); err != nil || got != want {
			t.Fatalf("IsAdmitted(%s) = %v, %v; want %v", key, got, err, want)
		}
	}
}

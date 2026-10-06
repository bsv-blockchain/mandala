package mandala

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

func TestTokenRegistryLookupRecordsADeploy(t *testing.T) {
	st, _, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := NewTokenRegistryLookupService(overlayVerifier(t), st)
	lkAdmit(t, ls, d, MandalaTopic, 0)
	r, err := st.FindRegistryRecord(ctx, id)
	if err != nil || r == nil || r.DeployTxid != d.Txid || r.Sym != "USD" || r.Dec != 2 || r.Label != "US Dollar" ||
		r.Issuer != mandalatest.Issuer.Identity || r.FeeRatePerKb != nil || r.CreatedAt.IsZero() {
		t.Fatalf("registry record = %+v, %v", r, err)
	}
}

func TestTokenRegistryLookupIgnoresAllButADeployAtZero(t *testing.T) {
	st, db, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	iss := mandalatest.Issue(t, d, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	ls := NewTokenRegistryLookupService(overlayVerifier(t), st)
	lkAdmit(t, ls, d, mgrTopic(t, brc162.DeployTokenID(d.Txid, 0)), 0) // another topic
	lkAdmit(t, ls, iss, MandalaTopic, 0, 1)                            // output 0 is an authority; 1 is not at zero
	if n := lkCount(t, ctx, db, TokenRegistryCollection, bson.D{}); n != 0 {
		t.Fatalf("%d registry records, want none", n)
	}
}

func TestTokenRegistryLookupKeepsTheRecordUntilEviction(t *testing.T) {
	st, _, ctx := lkStore(t)
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := NewTokenRegistryLookupService(overlayVerifier(t), st)
	lkAdmit(t, ls, d, MandalaTopic, 0)
	if err := ls.OutputSpent(ctx, &engine.OutputSpent{Outpoint: lkOutpoint(t, d.Txid, 0), Topic: MandalaTopic}); err != nil {
		t.Fatal(err)
	}
	if err := ls.OutputNoLongerRetainedInHistory(ctx, lkOutpoint(t, d.Txid, 0), MandalaTopic); err != nil {
		t.Fatal(err)
	}
	if err := ls.OutputEvicted(ctx, lkOutpoint(t, d.Txid, 1)); err != nil {
		t.Fatal(err)
	}
	if r, _ := st.FindRegistryRecord(ctx, id); r == nil {
		t.Fatal("the record did not survive a spend (T7)")
	}
	if err := ls.OutputEvicted(ctx, lkOutpoint(t, d.Txid, 0)); err != nil {
		t.Fatal(err)
	}
	if r, _ := st.FindRegistryRecord(ctx, id); r != nil {
		t.Fatalf("the record survived its deploy's eviction: %+v", r)
	}
}

func TestTokenRegistryLookupAnswers(t *testing.T) {
	st, _, ctx := lkStore(t)
	a := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	b := mandalatest.Deploy(t, mandalatest.Issuer, "EUR")
	ls := NewTokenRegistryLookupService(overlayVerifier(t), st)
	lkAdmit(t, ls, a, MandalaTopic, 0)
	lkAdmit(t, ls, b, MandalaTopic, 0)
	records, err := st.ListRegistryRecords(ctx, 100, 0)
	if err != nil || len(records) != 2 {
		t.Fatalf("records = %+v, %v", records, err)
	}
	all := []string{records[0].DeployTxid + ".0", records[1].DeployTxid + ".0"}
	ask := func(query string) []string {
		t.Helper()
		got, err := lkAsk(t, ls, MandalaLookup, query)
		if err != nil {
			t.Fatalf("%s: %v", query, err)
		}
		return got
	}
	if got := ask(`{"tokenId":"` + brc162.DeployTokenID(a.Txid, 0) + `"}`); !slices.Equal(got, []string{a.Txid + ".0"}) {
		t.Fatalf("tokenId = %v", got)
	}
	if got := ask(`{"tokenId":"` + mgrUntouched + `"}`); len(got) != 0 {
		t.Fatalf("unknown tokenId = %v", got)
	}
	if got := ask(`{"list":true}`); !slices.Equal(got, all) {
		t.Fatalf("list = %v, want %v", got, all)
	}
	paged := append(ask(`{"list":true,"limit":1}`), ask(`{"list":true,"limit":1,"skip":1}`)...)
	if !slices.Equal(paged, all) {
		t.Fatalf("pages = %v, want %v", paged, all)
	}
	for query, message := range map[string]string{
		`{"list":false}`:            "Unsupported query",
		`{}`:                        "Unsupported query",
		`{"list":"yes"}`:            "Invalid lookup query: list must be a boolean",
		`{"txid":"` + a.Txid + `"}`: "Invalid lookup query: unexpected field txid",
		`{"list":true,"limit":101}`: "Invalid lookup query: limit must be an integer from 1 to 100",
	} {
		if _, err := lkAsk(t, ls, MandalaLookup, query); err == nil || err.Error() != message {
			t.Fatalf("%s error = %v, want %q", query, err, message)
		}
	}
	md := ls.GetMetaData()
	if md.Name != "ls_mandala" || md.Description != "Mandala token registry: every BRC-162 token ever deployed, by tokenId or as a list." {
		t.Fatalf("metadata = %+v", md)
	}
	if ls.GetDocumentation() == "" {
		t.Fatal("empty documentation")
	}
}

// Q2 258180169 (D-21): the boot repair rebuilds a lost record from the deploy metadata and the deploy's journal row at
// output 0 on tm_<deploy txid>, in tokenId order; an existing record never changes; nothing is restored without both,
// or from a disagreeing row; a rerun restores nothing (Q2 MandalaRegistry.test.ts "restoreMissingRecords").
func TestTokenRegistryLookupRestoresMissingRecords(t *testing.T) {
	st, db, ctx := lkStore(t)
	ls := NewTokenRegistryLookupService(overlayVerifier(t), st)
	issuer := mandalatest.Issuer.Identity
	t0 := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	journaled := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	fee := int64(50)
	txid := func(pair string) string { return strings.Repeat(pair, 32) }
	lost, lost2, kept := txid("a1"), txid("a2"), txid("a3")
	notDeploy, elsewhere, upperKey, metaOnly, foreign, journalOnly := txid("b1"), txid("b2"), txid("b3"), txid("b4"), txid("b5"), txid("b6")
	meta := func(tx, sym string) MetadataRecord {
		return MetadataRecord{TokenID: tx + "_0", Txid: tx, OutputIndex: 0, Sym: sym, Dec: 2, Label: sym}
	}
	row := func(tx, topic string, role brc162.Role, key string) OwnerRecord {
		return OwnerRecord{Txid: tx, OutputIndex: 0, Topic: topic, TokenID: tx + "_0", Role: role, IdentityKey: key, CreatedAt: journaled}
	}
	lostMeta := meta(lost, "LOST")
	lostMeta.FeeRatePerKb = &fee
	foreignMeta := meta(foreign, "FOREIGN")
	foreignMeta.TokenID = txid("c1") + "_0" // tm_<foreign> does not name this token
	for _, m := range []MetadataRecord{lostMeta, meta(lost2, "LOST2"), meta(kept, "META"), meta(notDeploy, "ND"),
		meta(elsewhere, "EL"), meta(upperKey, "UK"), meta(metaOnly, "MO"), foreignMeta} {
		if err := st.StoreMetadata(ctx, m); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.RecordOwners(ctx, []OwnerRecord{
		row(lost, "tm_"+lost, brc162.RoleDeploy, issuer),
		row(lost2, "tm_"+lost2, brc162.RoleDeploy, issuer),
		row(kept, "tm_"+kept, brc162.RoleDeploy, issuer),
		row(notDeploy, "tm_"+notDeploy, brc162.RoleAuthority, issuer),
		row(elsewhere, KYCTopic, brc162.RoleDeploy, issuer),
		row(upperKey, "tm_"+upperKey, brc162.RoleDeploy, strings.ToUpper(issuer)),
		row(foreign, "tm_"+foreign, brc162.RoleDeploy, issuer),
		row(journalOnly, "tm_"+journalOnly, brc162.RoleDeploy, issuer),
	}); err != nil {
		t.Fatal(err)
	}
	if inserted, err := st.StoreRegistryRecord(ctx, TokenRegistryRecord{TokenID: kept + "_0", DeployTxid: kept, Sym: "KEPT", Dec: 2,
		Label: "KEPT", Issuer: issuer, CreatedAt: t0}); err != nil || !inserted {
		t.Fatalf("seed the kept record: %v, %v", inserted, err)
	}

	got, err := ls.RestoreMissingRecords(ctx)
	if want := []string{lost + "_0", lost2 + "_0"}; err != nil || !slices.Equal(got, want) {
		t.Fatalf("restored = %v, %v; want %v", got, err, want)
	}
	r, err := st.FindRegistryRecord(ctx, lost+"_0")
	if err != nil || r == nil || r.DeployTxid != lost || r.Sym != "LOST" || r.Dec != 2 || r.Label != "LOST" || r.Issuer != issuer ||
		r.FeeRatePerKb == nil || *r.FeeRatePerKb != 50 || !r.CreatedAt.Equal(journaled) {
		t.Fatalf("restored record = %+v, %v", r, err)
	}
	if k, err := st.FindRegistryRecord(ctx, kept+"_0"); err != nil || k == nil || k.Sym != "KEPT" || !k.CreatedAt.Equal(t0) {
		t.Fatalf("an existing record changed: %+v, %v", k, err)
	}
	if n := lkCount(t, ctx, db, TokenRegistryCollection, bson.D{}); n != 3 {
		t.Fatalf("%d registry records, want the two restored and the kept one", n)
	}
	if again, err := ls.RestoreMissingRecords(ctx); err != nil || again == nil || len(again) != 0 {
		t.Fatalf("a rerun restored %v, %v; want [] (non-nil)", again, err)
	}
	if got, err := lkAsk(t, ls, MandalaLookup, `{"tokenId":"`+lost+`_0"}`); err != nil || !slices.Equal(got, []string{lost + ".0"}) {
		t.Fatalf("the restored record does not answer {tokenId}: %v, %v", got, err)
	}
}

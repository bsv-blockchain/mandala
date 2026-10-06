package mandala

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

func TestKYCLookupClaimsAndIndexesFromAnAgreeingJournalOnly(t *testing.T) {
	st, _, ctx := kycStore(t)
	d := kycDeploy(t, "Mandala registry")
	id := brc162.DeployTokenID(d.Txid, 0)
	ls := NewKYCLookupService(st)
	lkAdmit(t, ls, d, KYCTopic, 0)
	if claimed, ok, _ := st.KYCRegistryTokenID(ctx); !ok || claimed != id {
		t.Fatalf("claim = %q %v; want %s", claimed, ok, id)
	}
	if a, _ := st.GetAuthorityRow(ctx, d.Txid, 0); a != nil {
		t.Fatalf("authority indexed with no journal row: %+v", a)
	}
	if err := st.RecordOwners(ctx, []OwnerRecord{{Txid: d.Txid, OutputIndex: 0, Topic: KYCTopic, TokenID: id,
		Role: brc162.RoleDeploy, Amount: 0, IdentityKey: mandalatest.Issuer.Identity, CreatedAt: time.Now().UTC()}}); err != nil {
		t.Fatal(err)
	}
	lkAdmit(t, ls, d, KYCTopic, 0) // a replayed notification after the journal write
	a, _ := st.GetAuthorityRow(ctx, d.Txid, 0)
	if a == nil || a.Topic != KYCTopic || a.TokenID != id || a.IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("authority row = %+v", a)
	}
}

func TestKYCLookupFoldsTheClaimedChainOnly(t *testing.T) {
	st, _, ctx := kycStore(t)
	ls := NewKYCLookupService(st)
	d := kycDeploy(t, "Mandala registry")
	rival := kycDeploy(t, "Rival registry")
	id, rivalID := brc162.DeployTokenID(d.Txid, 0), brc162.DeployTokenID(rival.Txid, 0)
	lkAdmit(t, ls, d, KYCTopic, 0)
	lkAdmit(t, ls, rival, KYCTopic, 0)
	lkAdmit(t, ls, kycAction(t, d, 0, id, AdminDetails{Kind: "admitIdentity", IdentityKey: mandalatest.Holder.Identity}), KYCTopic, 0)
	lkAdmit(t, ls, kycAction(t, rival, 0, rivalID, AdminDetails{Kind: "admitIdentity", IdentityKey: mandalatest.Receiver.Identity}), KYCTopic, 0)
	if ok, _ := st.KYCAdmitted(ctx, mandalatest.Holder.Identity); !ok {
		t.Fatal("the claimed chain's admit was not folded")
	}
	if ok, _ := st.KYCAdmitted(ctx, mandalatest.Receiver.Identity); ok {
		t.Fatal("a rival chain moved membership")
	}
	if rows, _ := st.ListKYC(ctx); len(rows) != 1 {
		t.Fatalf("rows = %+v, want one", rows)
	}
}

func TestKYCLookupIgnoresOtherTopicsAndValueOutputs(t *testing.T) {
	st, _, ctx := kycStore(t)
	ls := NewKYCLookupService(st)
	lkAdmit(t, ls, kycDeploy(t, "Mandala registry"), mgrTopic(t, mgrUntouched), 0)
	value := mandalatest.Build(t, nil, []mandalatest.Out{{Owner: mandalatest.Holder, Prover: mandalatest.Issuer, TokenID: mgrUntouched, Amount: 5}}, nil)
	lkAdmit(t, ls, value, KYCTopic, 0)
	if _, ok, _ := st.KYCRegistryTokenID(ctx); ok {
		t.Fatal("claimed from another topic's notification")
	}
	if a, _ := st.GetAuthorityRow(ctx, value.Txid, 0); a != nil {
		t.Fatalf("indexed a value output: %+v", a)
	}
}

func TestKYCLookupTakesTheAuthorityOnSpendAndEviction(t *testing.T) {
	st, _, ctx := kycStore(t)
	ls := NewKYCLookupService(st)
	holder, issuer := mandalatest.Holder.Identity, mandalatest.Issuer.Identity
	for _, tx := range []string{kycTx1, kycTx2} {
		if _, err := st.StoreAuthorityIfAbsent(ctx, AuthorityRecord{Txid: tx, OutputIndex: 0, Topic: KYCTopic, TokenID: kycTokenA, IdentityKey: issuer, CreatedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.ApplyKYC(ctx, holder, "admitted", kycTx1, 0); err != nil {
		t.Fatal(err)
	}
	if err := ls.OutputSpent(ctx, &engine.OutputSpent{Outpoint: lkOutpoint(t, kycTx1, 0), Topic: mgrTopic(t, mgrUntouched)}); err != nil {
		t.Fatal(err)
	}
	if a, _ := st.GetAuthorityRow(ctx, kycTx1, 0); a == nil {
		t.Fatal("another topic's spend took the registry authority")
	}
	if err := ls.OutputSpent(ctx, &engine.OutputSpent{Outpoint: lkOutpoint(t, kycTx1, 0), Topic: KYCTopic}); err != nil {
		t.Fatal(err)
	}
	if a, _ := st.GetAuthorityRow(ctx, kycTx1, 0); a != nil {
		t.Fatalf("spent authority kept: %+v", a)
	}
	if err := ls.OutputEvicted(ctx, lkOutpoint(t, kycTx2, 0)); err != nil {
		t.Fatal(err)
	}
	if a, _ := st.GetAuthorityRow(ctx, kycTx2, 0); a != nil {
		t.Fatalf("evicted authority kept: %+v", a)
	}
	if rows, _ := st.ListKYC(ctx); len(rows) != 1 {
		t.Fatalf("an eviction dropped a registry row: %+v", rows)
	}
	ans, err := ls.Lookup(ctx, &lookup.LookupQuestion{Service: KYCLookup, Query: json.RawMessage(`{}`)})
	if err != nil || ans.Type != lookup.AnswerTypeFormula || len(ans.Formulas) != 0 {
		t.Fatalf("lookup = %+v, %v; want an empty formula answer", ans, err)
	}
	md := ls.GetMetaData()
	if md.Name != "ls_mandala_kyc" || md.Description != "Mandala identity registry index: folds admit and revoke actions into the membership cache and tracks the registry authority." {
		t.Fatalf("metadata = %+v", md)
	}
	if ls.GetDocumentation() == "" {
		t.Fatal("empty documentation")
	}
}

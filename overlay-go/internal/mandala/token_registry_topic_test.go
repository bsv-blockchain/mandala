package mandala

import (
	"context"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

func TestTokenRegistryAdmitsADeployWithoutJournaling(t *testing.T) {
	st := newMemStore()
	d := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	got, err := mgrRunRegistry(t, d, st, nil, nil)
	mgrAdmit(t, got, err, []uint32{0}, []uint32{})
	if len(st.owners) != 0 {
		t.Fatalf("tm_mandala journaled %+v", st.owners)
	}
}

func TestTokenRegistryAndTokenTopicRefuseADeployAlike(t *testing.T) {
	issuer, rogue := mandalatest.Issuer, mandalatest.Rogue
	deployOut := func(owner mandalatest.Party, amount uint64, noLinkage bool) mandalatest.Out {
		return mandalatest.Out{Owner: owner, Prover: owner, Amount: amount,
			Payload: mandalatest.DeployPayload("USD", 2, "US Dollar"), HasPayload: true, NoLinkage: noLinkage}
	}
	cases := []struct {
		name   string
		built  *mandalatest.Built
		code   Code
		reason string
	}{
		{"untrusted issuer", mandalatest.Deploy(t, rogue, "USD"), CodeUntrusted, "output 0: owner " + rogue.Identity + " is not a trusted issuer"},
		{"missing deploySig", mandalatest.Build(t, nil, []mandalatest.Out{deployOut(issuer, 0, false)}, nil), CodeAuthority, "output 0: deploy requires a valid deploySig over this txid"},
		{"fixed supply", mandalatest.Build(t, nil, []mandalatest.Out{deployOut(issuer, 5, false)}, &issuer), CodeAuthority, "output 0: fixed-supply deploys are not allowed"},
		{"bad linkage", mandalatest.Build(t, nil, []mandalatest.Out{deployOut(issuer, 0, true)}, &issuer), CodeLinkage, "output 0: token output with no verified linkage"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id := brc162.DeployTokenID(c.built.Txid, 0)
			_, tokErr := mgrRunToken(t, id, c.built, newMemStore(), nil, nil)
			mgrRefusal(t, tokErr, c.code, c.reason, mgrTopic(t, id))
			_, regErr := mgrRunRegistry(t, c.built, newMemStore(), nil, nil)
			mgrRefusal(t, regErr, c.code, c.reason, MandalaTopic)
		})
	}
}

func TestTokenRegistryAdmitsNothingOfAnIssue(t *testing.T) {
	st := newMemStore()
	a := mgrIssue(t, st, "USD")
	got, err := mgrRunRegistry(t, a.issue, st, []uint32{0}, nil)
	mgrAdmit(t, got, err, []uint32{}, []uint32{})
}

func TestTokenRegistryNeverRunsTheSpendGuard(t *testing.T) {
	st := newMemStore()
	a := mgrIssue(t, st, "USD")
	spends := &mgrSpends{spentBy: map[string]string{a.deploy.Txid + ".0": strings.Repeat("99", 32)}}
	got, err := mgrRunRegistry(t, a.issue, st, []uint32{0}, func(d *TokenTopicDeps) { d.Spends = spends })
	mgrAdmit(t, got, err, []uint32{}, []uint32{})
	if len(spends.topics) != 0 {
		t.Fatalf("the registry ran the spend guard on %v", spends.topics)
	}
}

func TestTokenRegistryConstructorAndMetaData(t *testing.T) {
	d := mgrDeps(t, newMemStore(), nil)
	upper := strings.ToUpper(mandalatest.Holder.Identity)
	bad := d
	bad.MembershipExempt = []string{upper}
	if _, err := NewTokenRegistryTopicManager(bad); err == nil ||
		err.Error() != "TokenRegistryTopicManager: membership-exempt key "+upper+" is not a compressed lowercase public key" {
		t.Fatalf("bad exempt error = %v", err)
	}
	empty := d
	empty.TrustedIssuers = nil
	if _, err := NewTokenRegistryTopicManager(empty); err == nil || err.Error() != "TokenRegistryTopicManager: trustedIssuers must be a non-empty array" {
		t.Fatalf("empty trusted error = %v", err)
	}
	m, err := NewTokenRegistryTopicManager(d)
	if err != nil {
		t.Fatal(err)
	}
	if md := m.GetMetaData(); md.Name != "tm_mandala" || md.Description != "Mandala token registry: one permanent record per BRC-162 deploy." {
		t.Fatalf("metadata = %+v", md)
	}
	if ins, err := m.IdentifyNeededInputs(context.Background(), nil, nil); ins != nil || err != nil {
		t.Fatalf("IdentifyNeededInputs = %v, %v", ins, err)
	}
	if m.GetDocumentation() == "" {
		t.Fatal("empty documentation")
	}
}

package mandala

import (
	"context"
	"errors"
	"testing"

	"github.com/bsv-blockchain/go-sdk/overlay"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// kycDeploy is a registry deploy by the trusted issuer; label varies the txid.
func kycDeploy(t *testing.T, label string) *mandalatest.Built {
	t.Helper()
	return mandalatest.Build(t, nil, []mandalatest.Out{{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer,
		Payload: mandalatest.DeployPayload("KYC", 0, label), HasPayload: true}}, &mandalatest.Issuer)
}

// kycAction spends src:vout (a registry authority) into one authority committing to d.
func kycAction(t *testing.T, src *mandalatest.Built, vout uint32, registryID string, d AdminDetails) *mandalatest.Built {
	t.Helper()
	return mandalatest.Build(t, []mandalatest.In{{Src: src, Vout: vout}}, []mandalatest.Out{mgrActionOut(t, registryID, d)}, nil)
}

func kycRun(t *testing.T, b *mandalatest.Built, st *memStore, prev []uint32) (overlay.AdmittanceInstructions, error) {
	t.Helper()
	beef, txid, tx := mgrParse(t, b)
	m, err := NewKYCTopicManager(KYCTopicDeps{
		Verifier:       overlayVerifier(t),
		TrustedIssuers: []string{mandalatest.Issuer.Identity},
		Store:          st,
		Engine:         engineFor(KYCTopic, tx, prev),
		Claims:         st,
		OnOwnerRepair:  func(string, bool) {},
	})
	if err != nil {
		t.Fatalf("kyc manager: %v", err)
	}
	return m.IdentifyAdmissibleOutputs(WithOffChainValues(context.Background(), b.OffChain), beef, txid, prev)
}

func TestKYCManagerAdmitsTheFirstDeployAndJournalsIt(t *testing.T) {
	st := newMemStore()
	d := kycDeploy(t, "Mandala registry")
	got, err := kycRun(t, d, st, nil)
	mgrAdmit(t, got, err, []uint32{0}, []uint32{})
	if len(st.owners) != 1 || st.owners[0].Topic != KYCTopic || st.owners[0].Txid != d.Txid || st.owners[0].Role != brc162.RoleDeploy {
		t.Fatalf("journal = %+v; want the deploy under %s", st.owners, KYCTopic)
	}
}

func TestKYCManagerRefusesASecondRegistry(t *testing.T) {
	d := kycDeploy(t, "Mandala registry")
	other := newMemStore()
	other.setClaim(mgrUntouched)
	_, err := kycRun(t, d, other, nil)
	mgrRefusal(t, err, CodeShape, "tm_mandala_registry: registration chain already exists; register is genesis-only", KYCTopic)

	replay := newMemStore()
	replay.setClaim(brc162.DeployTokenID(d.Txid, 0))
	got, err := kycRun(t, d, replay, nil)
	mgrAdmit(t, got, err, []uint32{0}, []uint32{})
}

func TestKYCManagerClaimReadFaultIsUnavailable(t *testing.T) {
	st := newMemStore()
	boom := errors.New("boom")
	st.failNext("KYCRegistryTokenID", boom)
	_, err := kycRun(t, kycDeploy(t, "Mandala registry"), st, nil)
	mgrRefusal(t, err, CodeUnavailable, "the registry could not be read; retry", KYCTopic)
	if !errors.Is(err, boom) {
		t.Fatalf("cause lost: %v", err)
	}
}

func TestKYCManagerRefusesValueOutputs(t *testing.T) {
	b := mandalatest.Build(t, nil, []mandalatest.Out{
		{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer, Payload: mandalatest.DeployPayload("KYC", 0, "Mandala registry"), HasPayload: true},
		{Owner: mandalatest.Holder, Prover: mandalatest.Issuer, TokenID: mgrUntouched, Amount: 5},
	}, &mandalatest.Issuer)
	_, err := kycRun(t, b, newMemStore(), nil)
	mgrRefusal(t, err, CodeShape, "output 1: tm_mandala_registry does not admit value outputs", KYCTopic)
}

func TestKYCManagerRefusesATokenKind(t *testing.T) {
	st := newMemStore()
	d := kycDeploy(t, "Mandala registry")
	mgrSeed(t, st, d, KYCTopic)
	act := kycAction(t, d, 0, brc162.DeployTokenID(d.Txid, 0), AdminDetails{Kind: "issue"})
	_, err := kycRun(t, act, st, []uint32{0})
	mgrRefusal(t, err, CodeShape, "output 0: admin details violate the schema (kind issue is not allowed)", KYCTopic)
}

func TestKYCManagerRefusesADeployNotAtZero(t *testing.T) {
	b := mandalatest.Build(t, nil, []mandalatest.Out{
		{Owner: mandalatest.Holder, Prover: mandalatest.Issuer, TokenID: mgrUntouched, Amount: 5},
		{Owner: mandalatest.Issuer, Prover: mandalatest.Issuer, Payload: mandalatest.DeployPayload("KYC", 0, "Mandala registry"), HasPayload: true},
	}, nil)
	_, err := kycRun(t, b, newMemStore(), nil)
	mgrRefusal(t, err, CodeShape, "output 1: a deploy must be output 0", KYCTopic)
}

func TestKYCManagerRetainsPreviousCoinsAsGiven(t *testing.T) {
	st := newMemStore()
	d := kycDeploy(t, "Mandala registry")
	mgrSeed(t, st, d, KYCTopic)
	id := brc162.DeployTokenID(d.Txid, 0)
	st.setClaim(id)
	act := kycAction(t, d, 0, id, AdminDetails{Kind: "admitIdentity", IdentityKey: mandalatest.Holder.Identity})
	// input 1 is the P2PKH funding coin: unclassified, yet retained (KYC keeps previousCoins exactly)
	got, err := kycRun(t, act, st, []uint32{0, 1})
	mgrAdmit(t, got, err, []uint32{0}, []uint32{0, 1})
	found := false
	for _, o := range st.owners {
		found = found || (o.Txid == act.Txid && o.OutputIndex == 0 && o.Topic == KYCTopic)
	}
	if !found {
		t.Fatalf("the action's authority was not journaled under %s: %+v", KYCTopic, st.owners)
	}
}

func TestKYCManagerConstructorAndMetaData(t *testing.T) {
	if _, err := NewKYCTopicManager(KYCTopicDeps{}); err == nil || err.Error() != "KYCTopicManager: trustedIssuers must be a non-empty array" {
		t.Fatalf("empty trusted = %v", err)
	}
	m, err := NewKYCTopicManager(KYCTopicDeps{TrustedIssuers: []string{mandalatest.Issuer.Identity}})
	if err != nil {
		t.Fatal(err)
	}
	md := m.GetMetaData()
	if md.Name != "tm_mandala_kyc" || md.Description != "Mandala identity registry on BRC-162: a single authority chain that admits and revokes identities. No value outputs." {
		t.Fatalf("metadata = %+v", md)
	}
	if ins, err := m.IdentifyNeededInputs(context.Background(), nil, nil); ins != nil || err != nil {
		t.Fatalf("IdentifyNeededInputs = %v, %v", ins, err)
	}
	if m.GetDocumentation() == "" {
		t.Fatal("empty documentation")
	}
}

func TestEngineKYCMembershipGatesATokenTransfer(t *testing.T) {
	f := newEngineFlow(t, "mandala3_test_kyc")
	f.withRegistryLookup()
	kyc, err := NewKYCTopicManager(KYCTopicDeps{Verifier: f.deps.Verifier, TrustedIssuers: f.deps.TrustedIssuers,
		Store: f.store, Engine: f.es, Claims: f.store})
	if err != nil {
		t.Fatal(err)
	}
	f.eng.RegisterLookupService(KYCLookup, NewKYCLookupService(f.store))
	f.eng.RegisterTopicManager(KYCTopic, kyc)
	f.deps.Membership = KYCMembership{Store: f.store}
	issuer, holder, receiver := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver

	reg := kycDeploy(t, "Mandala registry")
	regID := brc162.DeployTokenID(reg.Txid, 0)
	flowEntry(t, f.mustSubmit(reg, KYCTopic), KYCTopic, []uint32{0}, []uint32{})
	admitHolder := kycAction(t, reg, 0, regID, AdminDetails{Kind: "admitIdentity", IdentityKey: holder.Identity})
	flowEntry(t, f.mustSubmit(admitHolder, KYCTopic), KYCTopic, []uint32{0}, []uint32{0})
	if ok, err := f.store.KYCAdmitted(f.ctx, holder.Identity); err != nil || !ok {
		t.Fatalf("holder admitted = %v, %v", ok, err)
	}

	d := mandalatest.Deploy(t, issuer, "USD")
	id := brc162.DeployTokenID(d.Txid, 0)
	topic := f.hostWithLookup(id)
	f.mustSubmit(d, MandalaTopic, topic)
	iss := mandalatest.Issue(t, d, 0, issuer, holder, 100)
	f.mustSubmit(iss, topic)

	tr := mandalatest.Transfer(t, iss, 1, receiver, 40)
	_, err = f.submit(tr, topic)
	mgrRefusal(t, err, CodeMembership, "identity "+receiver.Identity+" is not an admitted registry member", topic)

	admitReceiver := kycAction(t, admitHolder, 0, regID, AdminDetails{Kind: "admitIdentity", IdentityKey: receiver.Identity})
	f.mustSubmit(admitReceiver, KYCTopic)
	flowEntry(t, f.mustSubmit(tr, topic), topic, []uint32{0, 1}, []uint32{0})
}

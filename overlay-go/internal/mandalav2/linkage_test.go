package mandalav2

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"testing"
)

type linkageVector struct {
	Linkage struct {
		VerifierPrivHex       string   `json:"verifierPrivHex"`
		ProverIdentityKey     string   `json:"proverIdentityKey"`
		Counterparty          string   `json:"counterparty"`
		ProtocolID            [2]any   `json:"protocolID"`
		KeyID                 string   `json:"keyID"`
		EncryptedLinkage      NumBytes `json:"encryptedLinkage"`
		EncryptedLinkageProof NumBytes `json:"encryptedLinkageProof"`
		ProofType             int      `json:"proofType"`
		ExpectedDerivedKey    string   `json:"expectedDerivedKey"`
		ExpectedPubKeyHash    NumBytes `json:"expectedPubKeyHash"`
	} `json:"linkage"`
}

func TestVerifyKeyLinkageGoldenVector(t *testing.T) {
	b, err := os.ReadFile("../../testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v linkageVector
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	lv := v.Linkage
	ver, err := NewVerifier(lv.VerifierPrivHex)
	if err != nil {
		t.Fatal(err)
	}
	l := &SpecificLinkage{
		Prover:           lv.ProverIdentityKey,
		Verifier:         ver.IdentityKey(),
		Counterparty:     lv.Counterparty,
		ProtocolID:       ProtocolID{SecurityLevel: 2, Name: "mandala token"},
		KeyID:            lv.KeyID,
		EncryptedLinkage: lv.EncryptedLinkage,
		ProofType:        lv.ProofType,
	}
	identity, pkh, err := ver.VerifyKeyLinkage(context.Background(), l)
	if err != nil {
		t.Fatal(err)
	}
	if identity != lv.Counterparty {
		t.Fatalf("identity: %s", identity)
	}
	if !bytes.Equal(pkh, lv.ExpectedPubKeyHash) {
		t.Fatalf("pkh mismatch: %x vs %x", pkh, []byte(lv.ExpectedPubKeyHash))
	}
	if !ver.LinkageControlsPKH(context.Background(), l, lv.ExpectedPubKeyHash) {
		t.Fatal("LinkageControlsPKH must be true for the golden pkh")
	}
	if ver.LinkageControlsPKH(context.Background(), l, make([]byte, 20)) {
		t.Fatal("LinkageControlsPKH must be false for a wrong pkh")
	}
}

func TestVerifyKeyLinkageTamperedCiphertextFails(t *testing.T) {
	b, _ := os.ReadFile("../../testdata/vectors.json")
	var v linkageVector
	_ = json.Unmarshal(b, &v)
	ver, _ := NewVerifier(v.Linkage.VerifierPrivHex)
	bad := make(NumBytes, len(v.Linkage.EncryptedLinkage))
	copy(bad, v.Linkage.EncryptedLinkage)
	bad[40] ^= 0xff // flip a ciphertext byte past the 32-byte IV
	l := &SpecificLinkage{
		Prover: v.Linkage.ProverIdentityKey, Counterparty: v.Linkage.Counterparty,
		ProtocolID: ProtocolID{2, "mandala token"}, KeyID: v.Linkage.KeyID,
		EncryptedLinkage: bad,
	}
	if _, _, err := ver.VerifyKeyLinkage(context.Background(), l); err == nil {
		t.Fatal("tampered ciphertext must fail GCM auth")
	}
}

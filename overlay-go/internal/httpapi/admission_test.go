package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
)

const vectorTxid = "3f0c9a1b2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8"

// TestAdmissionDigestV2_Vectors pins wire contract §1 verbatim:
//
//	digest = SHA-256("mandala-admit:" + txid + ":" + sorted-ascending decimal
//	                 output indexes, comma-joined)
//
// The expected digest is recomputed in-test from that construction rather
// than pasted as a literal, so the TS engine's own implementation of the same
// sentence is what has to match, not a hex string someone transcribed.
func TestAdmissionDigestV2_Vectors(t *testing.T) {
	cases := []struct {
		name    string
		txid    string
		outputs []uint32
		joined  string
	}{
		{"single output", vectorTxid, []uint32{0}, "0"},
		{"contiguous set", vectorTxid, []uint32{0, 1}, "0,1"},
		{"sparse set", vectorTxid, []uint32{0, 2, 3}, "0,2,3"},
		{"unsorted input sorts ascending", vectorTxid, []uint32{3, 0, 2}, "0,2,3"},
		// Canonicalisation de-duplicates as well as sorts, matching lib's
		// canonicalOutputs and the TS signer's outputSetString.
		{"duplicates collapse", vectorTxid, []uint32{2, 0, 2}, "0,2"},
		{"every index the same", vectorTxid, []uint32{1, 1, 1}, "1"},
		{"multi-digit indexes are decimal, not hex", vectorTxid, []uint32{10, 2}, "2,10"},
		{"different txid, same set", strings.Repeat("ab", 32), []uint32{0}, "0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			want := sha256.Sum256([]byte("mandala-admit:" + tc.txid + ":" + tc.joined))
			got, err := AdmissionDigestV2(tc.txid, tc.outputs)
			if err != nil {
				t.Fatalf("AdmissionDigestV2: %v", err)
			}
			if got != want {
				t.Fatalf("digest = %x, want %x (message %q)",
					got, want, "mandala-admit:"+tc.txid+":"+tc.joined)
			}
		})
	}
}

// The v1 message ("mandala-admit:"+txid, no output set) is removed
// everywhere: a v2 digest must never collide with it.
func TestAdmissionDigestV2_DiffersFromTheRemovedV1Message(t *testing.T) {
	v1 := sha256.Sum256([]byte("mandala-admit:" + vectorTxid))
	v2, err := AdmissionDigestV2(vectorTxid, []uint32{0})
	if err != nil {
		t.Fatal(err)
	}
	if v1 == v2 {
		t.Fatal("v2 digest collides with the removed v1 message")
	}
}

// "never empty — no admitted outputs ⇒ no signature" (wire contract §1).
func TestAdmissionDigestV2_EmptySetIsRefused(t *testing.T) {
	for _, outs := range [][]uint32{nil, {}} {
		if _, err := AdmissionDigestV2(vectorTxid, outs); err == nil {
			t.Fatalf("AdmissionDigestV2(%v) = nil error, want refusal", outs)
		}
	}
}

func TestECAdmissionSigner_SignsDigestV2(t *testing.T) {
	priv, err := ec.NewPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	s := &ECAdmissionSigner{priv: priv}
	outputs := []uint32{3, 0, 2}

	sigHex, ident, err := s.SignAdmission(vectorTxid, outputs)
	if err != nil {
		t.Fatal(err)
	}
	if ident != hex.EncodeToString(priv.PubKey().Compressed()) {
		t.Fatalf("identity %s", ident)
	}
	der, err := hex.DecodeString(sigHex)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := ec.FromDER(der)
	if err != nil {
		t.Fatalf("FromDER: %v", err)
	}
	digest, err := AdmissionDigestV2(vectorTxid, outputs)
	if err != nil {
		t.Fatal(err)
	}
	if !sig.Verify(digest[:], priv.PubKey()) {
		t.Fatal("signature does not verify against admissionDigestV2")
	}
	// And it must NOT verify against the removed v1 message.
	v1 := sha256.Sum256([]byte("mandala-admit:" + vectorTxid))
	if sig.Verify(v1[:], priv.PubKey()) {
		t.Fatal("signature still verifies against the v1 message")
	}
}

// RFC6979 determinism is what lets the dupe path re-sign an admission and
// hand back byte-identical σ_I (wire contract §2's "freshly signed, no side
// effects").
func TestECAdmissionSigner_IsDeterministic(t *testing.T) {
	priv, err := ec.NewPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	s := &ECAdmissionSigner{priv: priv}
	first, _, err := s.SignAdmission(vectorTxid, []uint32{0, 2})
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := s.SignAdmission(vectorTxid, []uint32{2, 0})
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("signatures differ across calls (or across input order): %s vs %s", first, second)
	}
}

// A duplicate-bearing set and its canonical form must sign identically —
// that is what lets a verifier handed a non-canonical set still check σ_I.
func TestECAdmissionSigner_IgnoresDuplicateIndexes(t *testing.T) {
	priv, err := ec.NewPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	s := &ECAdmissionSigner{priv: priv}
	withDupes, _, err := s.SignAdmission(vectorTxid, []uint32{2, 0, 2})
	if err != nil {
		t.Fatal(err)
	}
	canonical, _, err := s.SignAdmission(vectorTxid, []uint32{0, 2})
	if err != nil {
		t.Fatal(err)
	}
	if withDupes != canonical {
		t.Fatalf("duplicate indexes changed σ_I: %s vs %s", withDupes, canonical)
	}
}

func TestECAdmissionSigner_RefusesAnEmptyOutputSet(t *testing.T) {
	priv, err := ec.NewPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	s := &ECAdmissionSigner{priv: priv}
	if _, _, err := s.SignAdmission(vectorTxid, nil); err == nil {
		t.Fatal("signing an empty admitted set must fail — registry-only admissions never yield a token σ_I")
	}
}

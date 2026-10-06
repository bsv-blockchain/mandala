package mandala

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"reflect"
	"strings"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// goldenLinkage is testdata/linkage_vector.json: the BRC-72 golden linkage
// extracted from the old-format vectors.json (`jq '.linkage'`), format-independent.
type goldenLinkage struct {
	VerifierPrivHex       string `json:"verifierPrivHex"`
	ProverIdentityKey     string `json:"proverIdentityKey"`
	Counterparty          string `json:"counterparty"`
	KeyID                 string `json:"keyID"`
	EncryptedLinkage      []int  `json:"encryptedLinkage"`
	EncryptedLinkageProof []int  `json:"encryptedLinkageProof"`
	ProofType             int    `json:"proofType"`
	ExpectedDerivedKey    string `json:"expectedDerivedKey"`
	ExpectedPubKeyHash    []int  `json:"expectedPubKeyHash"`
}

func loadGoldenLinkage(t *testing.T) goldenLinkage {
	t.Helper()
	b, err := os.ReadFile("../../testdata/linkage_vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var g goldenLinkage
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func goldenBytes(xs []int) []byte {
	out := make([]byte, len(xs))
	for i, x := range xs {
		out[i] = byte(x)
	}
	return out
}

// goldenRaw renders the golden linkage as an envelope linkage body; mutate edits the map first.
func goldenRaw(t *testing.T, g goldenLinkage, mutate func(map[string]any)) json.RawMessage {
	t.Helper()
	m := map[string]any{
		"prover":                g.ProverIdentityKey,
		"verifier":              "",
		"counterparty":          g.Counterparty,
		"protocolID":            []any{2, "mandala token"},
		"keyID":                 g.KeyID,
		"encryptedLinkage":      g.EncryptedLinkage,
		"encryptedLinkageProof": g.EncryptedLinkageProof,
		"proofType":             g.ProofType,
	}
	if mutate != nil {
		mutate(m)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func goldenVerifier(t *testing.T, g goldenLinkage) *Verifier {
	t.Helper()
	v, err := NewVerifier(g.VerifierPrivHex)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func verifyGoldenOutput(t *testing.T, v *Verifier, raw json.RawMessage) (string, []byte, error) {
	t.Helper()
	l, err := ParseLinkage(raw)
	if err != nil {
		return "", nil, err
	}
	return v.VerifyKeyLinkage(context.Background(), l)
}

func TestGoldenLinkageVerifies(t *testing.T) {
	g := loadGoldenLinkage(t)
	v := goldenVerifier(t, g)
	identity, pkh, err := verifyGoldenOutput(t, v, goldenRaw(t, g, nil))
	if err != nil {
		t.Fatal(err)
	}
	if identity != g.Counterparty || !bytes.Equal(pkh, goldenBytes(g.ExpectedPubKeyHash)) {
		t.Fatalf("identity %s pkh %x", identity, pkh)
	}
	tampered := goldenRaw(t, g, func(m map[string]any) {
		ct := append([]int{}, g.EncryptedLinkage...)
		ct[40] ^= 0xff // past the 32-byte IV
		m["encryptedLinkage"] = ct
	})
	if _, _, err := verifyGoldenOutput(t, v, tampered); err == nil {
		t.Fatal("a tampered ciphertext must fail GCM authentication")
	}
	other, err := NewVerifier(strings.Repeat("00", 31) + "46")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyGoldenOutput(t, other, goldenRaw(t, g, nil)); err == nil {
		t.Fatal("a linkage sealed for another verifier must fail")
	}
}

func TestOutputLinkageIdentityIsCanonical(t *testing.T) {
	g := loadGoldenLinkage(t)
	v := goldenVerifier(t, g)
	pub, err := ec.PublicKeyFromString(g.Counterparty)
	if err != nil {
		t.Fatal(err)
	}
	for _, form := range []string{hex.EncodeToString(pub.Uncompressed()), strings.ToUpper(g.Counterparty)} {
		identity, pkh, err := verifyGoldenOutput(t, v, goldenRaw(t, g, func(m map[string]any) { m["counterparty"] = form }))
		if err != nil || identity != g.Counterparty || !bytes.Equal(pkh, goldenBytes(g.ExpectedPubKeyHash)) {
			t.Errorf("counterparty %s: identity %s pkh %x err %v", form, identity, pkh, err)
		}
	}
}

func TestInputLinkageNamesTheCanonicalProver(t *testing.T) {
	g := loadGoldenLinkage(t)
	v := goldenVerifier(t, g)
	// prover + L·G = (counterparty + L·G) - counterparty + prover
	curve := ec.S256()
	derived, _ := ec.PublicKeyFromString(g.ExpectedDerivedKey)
	counter, _ := ec.PublicKeyFromString(g.Counterparty)
	prover, _ := ec.PublicKeyFromString(g.ProverIdentityKey)
	negY := new(big.Int).Sub(curve.Params().P, counter.Y)
	lx, ly := curve.Add(derived.X, derived.Y, counter.X, negY)
	ix, iy := curve.Add(lx, ly, prover.X, prover.Y)
	want := hash.Hash160((&ec.PublicKey{Curve: curve, X: ix, Y: iy}).Compressed())
	for _, form := range []string{g.ProverIdentityKey, strings.ToUpper(g.ProverIdentityKey)} {
		l, err := ParseLinkage(goldenRaw(t, g, func(m map[string]any) {
			m["prover"] = form
			delete(m, "counterparty") // TS never reads counterparty for an input linkage
		}))
		if err != nil {
			t.Fatal(err)
		}
		named, pkh, err := v.VerifyInputLinkage(context.Background(), l)
		if err != nil || named != g.ProverIdentityKey || !bytes.Equal(pkh, want) {
			t.Errorf("prover %s: named %s pkh %x err %v", form, named, pkh, err)
		}
	}
	for _, bad := range []string{" " + g.ProverIdentityKey, hex.EncodeToString(prover.Uncompressed()), "self", ""} {
		l, err := ParseLinkage(goldenRaw(t, g, func(m map[string]any) { m["prover"] = bad }))
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := v.VerifyInputLinkage(context.Background(), l); err == nil {
			t.Errorf("prover %q verified as an input linkage", bad)
		}
		if _, _, err := v.VerifyKeyLinkage(context.Background(), l); err == nil {
			t.Errorf("prover %q verified as an output linkage", bad)
		}
	}
}

// D-13: Go types linkage JSON strictly; TS would coerce these into the same
// invoice string and verify. Honest clients never send them.
func TestParseLinkageStrictTypingBoundary(t *testing.T) {
	g := loadGoldenLinkage(t)
	v := goldenVerifier(t, g)
	for name, mutate := range map[string]func(map[string]any){
		"string security level":  func(m map[string]any) { m["protocolID"] = []any{"2", "mandala token"} },
		"one-element protocolID": func(m map[string]any) { m["protocolID"] = []any{2} },
		"numeric keyID":          func(m map[string]any) { m["keyID"] = 5 },
		"byte out of range":      func(m map[string]any) { m["encryptedLinkage"] = []int{256} },
		"string ciphertext":      func(m map[string]any) { m["encryptedLinkage"] = "ae0d" },
		"numeric prover":         func(m map[string]any) { m["prover"] = 2 },
	} {
		if _, err := ParseLinkage(goldenRaw(t, g, mutate)); err == nil {
			t.Errorf("%s: ParseLinkage accepted it", name)
		}
	}
	twoPointZero := bytes.Replace(goldenRaw(t, g, nil), []byte(`[2,"mandala token"]`), []byte(`[2.0,"mandala token"]`), 1)
	if !bytes.Contains(twoPointZero, []byte(`[2.0,`)) {
		t.Fatal("fixture: protocolID not rewritten")
	}
	if _, err := ParseLinkage(twoPointZero); err == nil {
		t.Error("security level 2.0: ParseLinkage accepted it")
	}
	for _, raw := range []string{"", "null", `"x"`, `[]`, `12`} {
		if _, err := ParseLinkage(json.RawMessage(raw)); err == nil {
			t.Errorf("ParseLinkage(%q) accepted a non-object", raw)
		}
	}
	// Exact keys: a case-variant key binds nothing, so the linkage cannot verify.
	caseVariant := goldenRaw(t, g, func(m map[string]any) { m["Prover"] = m["prover"]; delete(m, "prover") })
	if _, _, err := verifyGoldenOutput(t, v, caseVariant); err == nil {
		t.Error(`{"Prover":…} verified: keys must match exactly`)
	}
	// go-sdk lowercases and trims the protocol name, as TS KeyDeriver does.
	upper := goldenRaw(t, g, func(m map[string]any) { m["protocolID"] = []any{2, "Mandala Token"} })
	if _, pkh, err := verifyGoldenOutput(t, v, upper); err != nil || !bytes.Equal(pkh, goldenBytes(g.ExpectedPubKeyHash)) {
		t.Errorf(`[2,"Mandala Token"]: pkh %x err %v`, pkh, err)
	}
}

func TestSpecificLinkageStorageShapes(t *testing.T) {
	l := SpecificLinkage{Prover: "p", Counterparty: "c", ProtocolID: ProtocolID{2, "mandala token"}, KeyID: "k",
		EncryptedLinkage: NumBytes{1, 255}, EncryptedLinkageProof: NumBytes{}, ProofType: 0}
	j, err := json.Marshal(l)
	if err != nil || !strings.Contains(string(j), `"protocolID":[2,"mandala token"]`) || !strings.Contains(string(j), `"encryptedLinkage":[1,255]`) {
		t.Fatalf("json = %s, %v", j, err)
	}
	b, err := bson.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	raw := bson.Raw(b)
	if raw.Lookup("protocolID").Type != bson.TypeArray || raw.Lookup("encryptedLinkage").Type != bson.TypeArray {
		t.Fatalf("bson types: protocolID %v encryptedLinkage %v", raw.Lookup("protocolID").Type, raw.Lookup("encryptedLinkage").Type)
	}
	var back SpecificLinkage
	if err := bson.Unmarshal(b, &back); err != nil || !reflect.DeepEqual(back, l) {
		t.Fatalf("bson round trip = %+v, %v", back, err)
	}
}

func TestCanonicalKeyHelpers(t *testing.T) {
	g := loadGoldenLinkage(t)
	pub, _ := ec.PublicKeyFromString(g.Counterparty)
	offCurve := "02" + strings.Repeat("00", 32)
	// x >= p (D-22): go-sdk v1.7.1 parses this compressed key and would echo it; @bsv/sdk
	// PublicKey.fromString(k).toString() re-encodes the point with x reduced mod p.
	beyondP := "02" + strings.Repeat("ff", 32)
	for _, in := range []string{g.Counterparty, strings.ToUpper(g.Counterparty), hex.EncodeToString(pub.Uncompressed())} {
		if c, err := CanonicalKey(in); err != nil || c != g.Counterparty {
			t.Errorf("CanonicalKey(%s) = %s, %v", in, c, err)
		}
	}
	if _, err := CanonicalKey(offCurve); err == nil {
		t.Error("CanonicalKey accepted an off-curve key")
	}
	if c, err := CanonicalKey(beyondP); err != nil || c != "02"+strings.Repeat("0", 54)+"01000003d0" {
		t.Errorf("CanonicalKey(x >= p) = %s, %v; want the reduced point TS toString() prints", c, err)
	}
	for _, c := range []struct {
		k                   string
		identity, canonical bool
	}{
		{g.Counterparty, true, true},
		{strings.ToUpper(g.Counterparty), false, false},
		{hex.EncodeToString(pub.Uncompressed()), false, false},
		{offCurve, true, false},
		{beyondP, true, false},
		{"04" + g.Counterparty[2:], false, false},
		{"", false, false},
	} {
		if IsIdentity(c.k) != c.identity || IsCanonicalKey(c.k) != c.canonical {
			t.Errorf("%s: IsIdentity %v IsCanonicalKey %v", c.k, IsIdentity(c.k), IsCanonicalKey(c.k))
		}
	}
	if _, err := NewVerifier("zz"); err == nil || !strings.HasPrefix(err.Error(), "verifier key: ") {
		t.Errorf("NewVerifier(zz) error = %v", err)
	}
	if v := goldenVerifier(t, g); v.IdentityKey() != "025edd5cc23c51e87a497ca815d5dce0f8ab52554f849ed8995de64c5f34ce7143" {
		t.Errorf("IdentityKey = %s", v.IdentityKey())
	}
}

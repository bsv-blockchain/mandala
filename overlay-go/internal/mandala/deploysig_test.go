package mandala

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
)

type deploySigRow struct {
	ID                string `json:"id"`
	Txid              string `json:"txid"`
	DigestHex         string `json:"digestHex"`
	IssuerIdentityKey string `json:"issuerIdentityKey"`
	KeyID             string `json:"keyID"`
	Counterparty      string `json:"counterparty"`
	SignatureHex      string `json:"signatureHex"`
}

func loadDeploySigRows(t *testing.T) []deploySigRow {
	t.Helper()
	b, err := os.ReadFile("../../testdata/brc162.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		DeploySig []deploySigRow `json:"deploySig"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.DeploySig) != 2 {
		t.Fatalf("deploySig rows = %d, want 2", len(v.DeploySig))
	}
	return v.DeploySig
}

func TestVectorDeploySig(t *testing.T) {
	ctx := context.Background()
	rows := loadDeploySigRows(t)
	for i, row := range rows {
		if hex.EncodeToString(DeployDigest(row.Txid)) != row.DigestHex || row.KeyID != "1" || row.Counterparty != "anyone" {
			t.Errorf("%s: digest %x", row.ID, DeployDigest(row.Txid))
		}
		if !VerifyDeploySig(ctx, row.Txid, row.SignatureHex, true, row.IssuerIdentityKey) {
			t.Errorf("%s: valid deploySig refused", row.ID)
		}
		other := rows[1-i]
		if VerifyDeploySig(ctx, other.Txid, row.SignatureHex, true, row.IssuerIdentityKey) {
			t.Errorf("%s: verified over another txid", row.ID)
		}
	}
	row := rows[0]
	stranger := "02" + strings.Repeat("00", 31) + "01"
	for name, ok := range map[string]bool{
		"absent":             VerifyDeploySig(ctx, row.Txid, row.SignatureHex, false, row.IssuerIdentityKey),
		"empty":              VerifyDeploySig(ctx, row.Txid, "", true, row.IssuerIdentityKey),
		"uppercase hex":      VerifyDeploySig(ctx, row.Txid, strings.ToUpper(row.SignatureHex), true, row.IssuerIdentityKey),
		"odd hex":            VerifyDeploySig(ctx, row.Txid, row.SignatureHex[1:], true, row.IssuerIdentityKey),
		"truncated":          VerifyDeploySig(ctx, row.Txid, row.SignatureHex[:len(row.SignatureHex)-2], true, row.IssuerIdentityKey),
		"another owner":      VerifyDeploySig(ctx, row.Txid, row.SignatureHex, true, stranger),
		"owner not a key":    VerifyDeploySig(ctx, row.Txid, row.SignatureHex, true, "not-a-key"),
		"uncompressed owner": VerifyDeploySig(ctx, row.Txid, row.SignatureHex, true, uncompressedHex(t, row.IssuerIdentityKey)),
	} {
		if ok {
			t.Errorf("%s: verified", name)
		}
	}
	// High-S: neither TS nor go-sdk enforces low-S, so s' = N - s still verifies.
	r, s := derSigParts(t, row.SignatureHex)
	highS := new(big.Int).Sub(ec.S256().Params().N, new(big.Int).SetBytes(s))
	if !VerifyDeploySig(ctx, row.Txid, hex.EncodeToString(derSig(r, derSigInt(highS.Bytes()))), true, row.IssuerIdentityKey) {
		t.Error("the high-S form of a valid deploySig was refused")
	}
}

func uncompressedHex(t *testing.T, k string) string {
	t.Helper()
	pub, err := ec.PublicKeyFromString(k)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(pub.Uncompressed())
}

// derParts splits a canonical DER signature into its r and s integer bodies.
func derSigParts(t *testing.T, sigHex string) (r, s []byte) {
	t.Helper()
	b, _ := hex.DecodeString(sigHex)
	rl := int(b[3])
	r = b[4 : 4+rl]
	s = b[6+rl:]
	return r, s
}

// derInt prefixes a sign pad when the high bit is set.
func derSigInt(v []byte) []byte {
	if len(v) > 0 && v[0]&0x80 != 0 {
		return append([]byte{0}, v...)
	}
	return v
}

func derSig(r, s []byte) []byte {
	body := append(append([]byte{0x02, byte(len(r))}, r...), append([]byte{0x02, byte(len(s))}, s...)...)
	return append([]byte{0x30, byte(len(body))}, body...)
}

func TestParseDERLikeTS(t *testing.T) {
	row := loadDeploySigRows(t)[0]
	r, s := derSigParts(t, row.SignatureHex)
	n := ec.S256().Params().N.Bytes()
	nMinus1 := new(big.Int).Sub(ec.S256().Params().N, big.NewInt(1)).Bytes()
	highR := append([]byte{r[0] | 0x80}, r[1:]...)
	valid := derSig(r, s)
	cases := []struct {
		name string
		sig  []byte
		ok   bool
	}{
		{"vector signature", valid, true},
		{"minimal 8-byte signature r=1 s=1", []byte{0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01}, true},
		{"sign-padded high-bit r", derSig(append([]byte{0}, highR...), s), true},
		{"s = N-1 (high-S)", derSig(r, derSigInt(nMinus1)), true},
		{"7 bytes", []byte{0x30, 0x05, 0x02, 0x01, 0x01, 0x02, 0x00}, false},
		{"73 bytes", append([]byte{0x30, 0x47}, make([]byte, 71)...), false},
		{"not a SEQUENCE", append([]byte{0x31}, valid[1:]...), false},
		{"long-form length byte", append([]byte{0x30, 0x81, valid[1]}, valid[2:]...), false},
		{"trailing byte", append(append([]byte{}, valid...), 0x00), false},
		{"length byte covers a trailing byte", append([]byte{0x30, valid[1] + 1}, append(append([]byte{}, valid[2:]...), 0x00)...), false},
		{"r tag not INTEGER", append([]byte{0x30, valid[1], 0x03}, valid[3:]...), false},
		{"high-bit r without a pad", derSig(highR, s), false},
		{"excess zero pad on r", derSig(append([]byte{0}, r...), s), false},
		{"excess zero pad on s", derSig(r, append([]byte{0}, s...)), false},
		{"r = 0", derSig([]byte{0}, s), false},
		{"s = 0", derSig(r, []byte{0}), false},
		{"zero-length r", derSig([]byte{}, s), false},
		{"s = N", derSig(r, derSigInt(n)), false},
		{"34-byte r", derSig(append([]byte{0x01}, bytes.Repeat([]byte{0x11}, 33)...), s), false},
		{"s runs past the end", valid[:len(valid)-1], false},
	}
	for _, c := range cases {
		sig, err := ParseDERLikeTS(c.sig)
		if (err == nil) != c.ok {
			t.Errorf("%s (%x): err %v, want ok=%v", c.name, c.sig, err, c.ok)
			continue
		}
		if c.ok && (sig.R.Sign() <= 0 || sig.S.Sign() <= 0) {
			t.Errorf("%s: scalars %v %v", c.name, sig.R, sig.S)
		}
	}
	sig, _ := ParseDERLikeTS(valid)
	if !bytes.Equal(sig.R.Bytes(), r) || !bytes.Equal(sig.S.Bytes(), s) {
		t.Errorf("parsed r %x s %x", sig.R.Bytes(), sig.S.Bytes())
	}
}

package mandala

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	mt "github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

func dtCborHex(t *testing.T, m brc162.CborMap) string {
	t.Helper()
	b, err := brc162.EncodeStrictCbor(m)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func dtKey(t *testing.T, p mt.Party) []byte {
	t.Helper()
	b, err := hex.DecodeString(p.Identity)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// dtOutpoint36 is the 36-byte details outpoint of txid hexID(fill), vout.
func dtOutpoint36(fill byte, vout byte) []byte {
	b := bytes.Repeat([]byte{fill}, 32)
	return append(b, vout, 0, 0, 0)
}

func TestDecodeAdminDetailsReadsEveryKind(t *testing.T) {
	bankRef := bytes.Repeat([]byte{7}, 32)
	issueHex := dtCborHex(t, brc162.CborMap{"kind": "issue", "bankRef": bankRef})
	d, sum, err := DecodeAdminDetails(issueHex, AdminKinds, 1)
	raw, _ := hex.DecodeString(issueHex)
	if err != nil || d.Kind != "issue" || !bytes.Equal(d.BankRef, bankRef) || sum != sha256.Sum256(raw) {
		t.Fatalf("issue: %+v %v", d, err)
	}
	d, _, err = DecodeAdminDetails(dtCborHex(t, brc162.CborMap{"kind": "reissue", "outpoint": dtOutpoint36(0xab, 2), "recipient": dtKey(t, mt.Holder), "reason": "court order"}), AdminKinds, 0)
	if err != nil || d.Outpoint != strings.Repeat("ab", 32)+".2" || d.Recipient != mt.Holder.Identity || !d.HasReason || d.Reason != "court order" {
		t.Fatalf("reissue: %+v %v", d, err)
	}
	d, _, err = DecodeAdminDetails(dtCborHex(t, brc162.CborMap{"kind": "setFeeRate", "feeRatePerKb": nil}), AdminKinds, 0)
	if err != nil || !d.HasFeeRatePerKb || d.FeeRatePerKb != nil {
		t.Fatalf("setFeeRate null: %+v %v", d, err)
	}
	d, _, err = DecodeAdminDetails(dtCborHex(t, brc162.CborMap{"kind": "setFeeRate", "feeRatePerKb": uint64(500)}), AdminKinds, 0)
	if err != nil || d.FeeRatePerKb == nil || *d.FeeRatePerKb != 500 {
		t.Fatalf("setFeeRate 500: %+v %v", d, err)
	}
	d, _, err = DecodeAdminDetails(dtCborHex(t, brc162.CborMap{"kind": "setAccessMode", "mode": "allowlist"}), AdminKinds, 0)
	if err != nil || d.Mode != "allowlist" {
		t.Fatalf("setAccessMode: %+v %v", d, err)
	}
	d, _, err = DecodeAdminDetails(dtCborHex(t, brc162.CborMap{"kind": "admitIdentity", "identityKey": dtKey(t, mt.Receiver)}), RegistryKinds, 0)
	if err != nil || d.IdentityKey != mt.Receiver.Identity {
		t.Fatalf("admitIdentity: %+v %v", d, err)
	}
	d, _, err = DecodeAdminDetails(dtCborHex(t, brc162.CborMap{"kind": "pause"}), AdminKinds, 0)
	if err != nil || d.HasReason || d.HasFeeRatePerKb || d.BankRef != nil {
		t.Fatalf("pause: %+v %v", d, err)
	}
}

func TestDecodeAdminDetailsSchemaRefusals(t *testing.T) {
	key := dtKey(t, mt.Holder)
	offCurve := append([]byte{0x02}, append(bytes.Repeat([]byte{0}, 31), 5)...) // x = 5 is not on secp256k1
	xAboveP := append([]byte{0x02}, bytes.Repeat([]byte{0xff}, 32)...)          // x >= p: TS reduces it, so its bytes are not canonical
	uncompressedPrefix := append([]byte{0x04}, key[1:]...)
	op := dtOutpoint36(0xab, 0)
	for _, c := range []struct {
		name    string
		hex     string
		allowed []string
		detail  string
	}{
		{"uppercase hex", "A1", AdminKinds, "details must be lowercase hex"},
		{"empty", "", AdminKinds, "details must be lowercase hex"},
		{"odd length", "a16", AdminKinds, "details must be lowercase hex"},
		{"strict CBOR passes through", "ff", AdminKinds, "indefinite length"},
		{"no kind", dtCborHex(t, brc162.CborMap{}), AdminKinds, "missing key kind"},
		{"kind not text", dtCborHex(t, brc162.CborMap{"kind": uint64(5)}), AdminKinds, "kind must be text"},
		{"kind null", dtCborHex(t, brc162.CborMap{"kind": nil}), AdminKinds, "kind must be text"},
		{"unknown kind", dtCborHex(t, brc162.CborMap{"kind": "mint"}), AdminKinds, "kind mint is not allowed"},
		{"prototype name", dtCborHex(t, brc162.CborMap{"kind": "toString"}), AdminKinds, "kind toString is not allowed"},
		{"registry kind on a token", dtCborHex(t, brc162.CborMap{"kind": "admitIdentity", "identityKey": key}), AdminKinds, "kind admitIdentity is not allowed"},
		{"token kind on the registry", dtCborHex(t, brc162.CborMap{"kind": "issue"}), RegistryKinds, "kind issue is not allowed"},
		{"unknown keys: shortest first", dtCborHex(t, brc162.CborMap{"kind": "pause", "zz": uint64(1), "aaa": uint64(1), "y": uint64(1)}), AdminKinds, "unknown key y"},
		{"unknown keys: bytewise at one length", dtCborHex(t, brc162.CborMap{"kind": "pause", "é": uint64(1), "zz": uint64(1)}), AdminKinds, "unknown key zz"},
		{"unknown key before a bad known value", dtCborHex(t, brc162.CborMap{"kind": "issue", "bankRef": "x", "q": uint64(1)}), AdminKinds, "unknown key q"},
		{"missing required", dtCborHex(t, brc162.CborMap{"kind": "freezeOutput"}), AdminKinds, "missing key outpoint"},
		{"reissue reads outpoint first", dtCborHex(t, brc162.CborMap{"kind": "reissue", "outpoint": op[:35], "recipient": []byte{1}}), AdminKinds, "outpoint must be 36 bytes"},
		{"a missing earlier field beats a later bad value", dtCborHex(t, brc162.CborMap{"kind": "reissue", "recipient": []byte{1}}), AdminKinds, "missing key outpoint"},
		{"reissue recipient", dtCborHex(t, brc162.CborMap{"kind": "reissue", "outpoint": op, "recipient": key[:32]}), AdminKinds, "recipient must be a 33-byte compressed public key"},
		{"recipient off the curve", dtCborHex(t, brc162.CborMap{"kind": "reissue", "outpoint": op, "recipient": offCurve}), AdminKinds, "recipient must be a 33-byte compressed public key"},
		{"recipient x >= p", dtCborHex(t, brc162.CborMap{"kind": "reissue", "outpoint": op, "recipient": xAboveP}), AdminKinds, "recipient must be a 33-byte compressed public key"},
		{"recipient 04 prefix", dtCborHex(t, brc162.CborMap{"kind": "reissue", "outpoint": op, "recipient": uncompressedPrefix}), AdminKinds, "recipient must be a 33-byte compressed public key"},
		{"recipient as text", dtCborHex(t, brc162.CborMap{"kind": "reissue", "outpoint": op, "recipient": mt.Holder.Identity}), AdminKinds, "recipient must be a 33-byte compressed public key"},
		{"identityKey", dtCborHex(t, brc162.CborMap{"kind": "blockIdentity", "identityKey": offCurve}), AdminKinds, "identityKey must be a 33-byte compressed public key"},
		{"bankRef as text", dtCborHex(t, brc162.CborMap{"kind": "issue", "bankRef": "x"}), AdminKinds, "bankRef must be 32 bytes"},
		{"mode", dtCborHex(t, brc162.CborMap{"kind": "setAccessMode", "mode": "open"}), AdminKinds, "mode must be denylist or allowlist"},
		{"fee rate 0", dtCborHex(t, brc162.CborMap{"kind": "setFeeRate", "feeRatePerKb": uint64(0)}), AdminKinds, "feeRatePerKb must be a safe integer >= 1 or null"},
		{"fee rate 2^53", dtCborHex(t, brc162.CborMap{"kind": "setFeeRate", "feeRatePerKb": uint64(1) << 53}), AdminKinds, "feeRatePerKb must be a safe integer >= 1 or null"},
		{"fee rate absent", dtCborHex(t, brc162.CborMap{"kind": "setFeeRate"}), AdminKinds, "missing key feeRatePerKb"},
		{"reason number", dtCborHex(t, brc162.CborMap{"kind": "pause", "reason": uint64(7)}), AdminKinds, "reason must be text"},
		{"reason null", dtCborHex(t, brc162.CborMap{"kind": "pause", "reason": nil}), AdminKinds, "reason must be text"},
	} {
		_, _, err := DecodeAdminDetails(c.hex, c.allowed, 4)
		if err == nil {
			t.Fatalf("%s: accepted", c.name)
		}
		requireReject(t, err, CodeShape, "output 4: admin details violate the schema ("+c.detail+")")
	}
}

func TestEncodeAdminDetailsRoundTrips(t *testing.T) {
	fee := int64(9)
	for _, d := range []AdminDetails{
		{Kind: "reissue", Outpoint: strings.Repeat("ab", 32) + ".4294967295", Recipient: mt.Holder.Identity},
		{Kind: "issue", BankRef: bytes.Repeat([]byte{1}, 32)},
		{Kind: "setFeeRate", HasFeeRatePerKb: true},
		{Kind: "setFeeRate", FeeRatePerKb: &fee, HasFeeRatePerKb: true, Reason: "", HasReason: true},
		{Kind: "setAccessMode", Mode: "denylist"},
	} {
		b, err := EncodeAdminDetails(d)
		if err != nil {
			t.Fatalf("%+v: %v", d, err)
		}
		got, sum, err := DecodeAdminDetails(hex.EncodeToString(b), AdminKinds, 0)
		if err != nil || sum != sha256.Sum256(b) {
			t.Fatalf("%+v: %v", d, err)
		}
		if got.Kind != d.Kind || got.Outpoint != d.Outpoint || got.Recipient != d.Recipient || !bytes.Equal(got.BankRef, d.BankRef) ||
			got.HasFeeRatePerKb != d.HasFeeRatePerKb || (got.FeeRatePerKb == nil) != (d.FeeRatePerKb == nil) || got.HasReason != d.HasReason || got.Mode != d.Mode {
			t.Fatalf("round trip %+v -> %+v", d, got)
		}
	}
	if b, _ := EncodeAdminDetails(AdminDetails{Kind: "issue"}); hex.EncodeToString(b) != "a1646b696e64656973737565" {
		t.Fatalf("{kind:issue} = %x", b)
	}
	for _, bad := range []string{strings.Repeat("AB", 32) + ".0", strings.Repeat("ab", 32) + ".4294967296", strings.Repeat("ab", 32) + ".01", "x.0"} {
		if _, err := EncodeAdminDetails(AdminDetails{Kind: "freezeOutput", Outpoint: bad}); err == nil || err.Error() != "outpoint must be <64 lowercase hex txid>.<vout 0..4294967295>" {
			t.Fatalf("outpoint %q: %v", bad, err)
		}
	}
}

func TestParseDeployMetadata(t *testing.T) {
	enc := func(m brc162.CborMap) []byte {
		b, err := brc162.EncodeStrictCbor(m)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	ok := func(m brc162.CborMap) DeployMetadata {
		t.Helper()
		md, err := ParseDeployMetadata(enc(m), true, true)
		if err != nil {
			t.Fatalf("%v: %v", m, err)
		}
		return md
	}
	md := ok(brc162.CborMap{"sym": "USD", "dec": uint64(2), "label": "US Dollar", "extra": "ignored"})
	if md.Sym != "USD" || md.Dec != 2 || md.Label != "US Dollar" || md.FeeRatePerKb != nil {
		t.Fatalf("metadata %+v", md)
	}
	if md := ok(brc162.CborMap{"sym": strings.Repeat("€", 32), "dec": uint64(18), "label": strings.Repeat("é", 64), "feeRatePerKb": uint64(500)}); md.FeeRatePerKb == nil || *md.FeeRatePerKb != 500 {
		t.Fatalf("32 code points, dec 18, 64 code points, fee 500: %+v", md)
	}
	if md := ok(brc162.CborMap{"sym": "A", "dec": uint64(0), "label": "B", "feeRatePerKb": nil}); md.FeeRatePerKb != nil {
		t.Fatal("a null fee rate reads as no fee rate")
	}
	reason := func(detail string) string {
		return "output 0: deploy payload is not a valid Mandala deploy map (" + detail + ")"
	}
	_, err := ParseDeployMetadata(nil, false, true)
	requireReject(t, err, CodeShape, reason("missing payload"))
	_, err = ParseDeployMetadata(enc(brc162.CborMap{"sym": "A", "dec": uint64(0), "label": "B"}), true, false)
	requireReject(t, err, CodeShape, reason("non-canonical payload push"))
	_, err = ParseDeployMetadata([]byte{}, true, true)
	requireReject(t, err, CodeShape, reason("truncated input"))
	for _, c := range []struct {
		m      brc162.CborMap
		detail string
	}{
		{brc162.CborMap{"dec": "x", "label": "B"}, "missing key sym"},
		{brc162.CborMap{"sym": strings.Repeat("€", 33), "dec": uint64(2), "label": "B"}, "sym must be text of 1-32 characters"},
		{brc162.CborMap{"sym": "", "dec": uint64(2), "label": "B"}, "sym must be text of 1-32 characters"},
		{brc162.CborMap{"sym": []byte("USD"), "dec": uint64(2), "label": "B"}, "sym must be text of 1-32 characters"},
		{brc162.CborMap{"sym": "A", "label": "B"}, "missing key dec"},
		{brc162.CborMap{"sym": "A", "dec": uint64(19), "label": "B"}, "dec must be an integer 0-18"},
		{brc162.CborMap{"sym": "A", "dec": "2", "label": "B"}, "dec must be an integer 0-18"},
		{brc162.CborMap{"sym": "A", "dec": uint64(2)}, "missing key label"},
		{brc162.CborMap{"sym": "A", "dec": uint64(2), "label": strings.Repeat("x", 65)}, "label must be text of 1-64 characters"},
		{brc162.CborMap{"sym": "A", "dec": uint64(2), "label": "B", "feeRatePerKb": uint64(0)}, "feeRatePerKb must be a safe integer >= 1 or null"},
		{brc162.CborMap{"sym": "A", "dec": uint64(2), "label": "B", "feeRatePerKb": false}, "feeRatePerKb must be a safe integer >= 1 or null"},
	} {
		_, err := ParseDeployMetadata(enc(c.m), true, true)
		if err == nil {
			t.Fatalf("%v: accepted", c.m)
		}
		requireReject(t, err, CodeShape, reason(c.detail))
	}
}

func TestCommitmentOf(t *testing.T) {
	var c [32]byte
	copy(c[:], bytes.Repeat([]byte{9}, 32))
	adm := mt.AdmPayload(c)
	if got, ok := CommitmentOf(adm, true, true); !ok || got != c {
		t.Fatalf("adm: %x %v", got, ok)
	}
	withExtra, _ := brc162.EncodeStrictCbor(brc162.CborMap{"adm": c[:], "note": "x"})
	if _, ok := CommitmentOf(withExtra, true, true); !ok {
		t.Fatal("other keys are ignored")
	}
	short, _ := brc162.EncodeStrictCbor(brc162.CborMap{"adm": c[:31]})
	for name, ok := range map[string]bool{
		"no payload":    func() bool { _, ok := CommitmentOf(nil, false, true); return ok }(),
		"non-canonical": func() bool { _, ok := CommitmentOf(adm, true, false); return ok }(),
		"31 bytes":      func() bool { _, ok := CommitmentOf(short, true, true); return ok }(),
		"not CBOR":      func() bool { _, ok := CommitmentOf([]byte{0xff}, true, true); return ok }(),
		"deploy map":    func() bool { _, ok := CommitmentOf(mt.DeployPayload("USD", 2, "US Dollar"), true, true); return ok }(),
	} {
		if ok {
			t.Fatalf("%s: committed", name)
		}
	}
}

package brc162

import (
	"bytes"
	"encoding/hex"
	"go/parser"
	"go/token"
	"math"
	"math/bits"
	"strconv"
	"strings"
	"testing"
)

// Fixtures from Bsv21Binary.test.ts:15-22 (fact base ts-codec §5).
const (
	pkhHex   = "0102030405060708090a0b0c0d0e0f1011121314"
	p2pkhHex = "76a914" + pkhHex + "88ac"
)

var (
	testTxid   = strings.Repeat("ab", 31) + "cd"
	testID     = testTxid + "_0"
	testIDWire = "cd" + strings.Repeat("ab", 31)
)

func codecErr(t *testing.T, err error) string {
	t.Helper()
	ce, ok := err.(*CodecError)
	if !ok {
		t.Fatalf("error %v (%T) is not a *CodecError", err, err)
	}
	return ce.Message
}

func TestAmountChunkTable(t *testing.T) {
	for _, c := range []struct {
		amount uint64
		hex    string
	}{
		{0, "00"}, {1, "51"}, {5, "55"}, {16, "60"}, {17, "0111"}, {127, "017f"}, {128, "028000"},
		{255, "02ff00"}, {256, "020001"}, {5000, "028813"}, {math.MaxUint64, "09ffffffffffffffff00"},
	} {
		if got := hex.EncodeToString(SerializeChunk(EncodeAmountChunk(c.amount))); got != c.hex {
			t.Errorf("encode %d = %s, want %s", c.amount, got, c.hex)
		}
	}
}

func TestAmountChunkWidthBoundaries(t *testing.T) {
	for b := 5; b <= 64; b++ {
		values := []uint64{math.MaxUint64 >> (64 - b)}
		if b < 64 {
			values = append(values, uint64(1)<<b)
		}
		for _, v := range values {
			c := EncodeAmountChunk(v)
			if want := byte(bits.Len64(v)/8 + 1); c.Op != want || len(c.Data) != int(c.Op) {
				t.Errorf("%d: op %d len %d, want op %d", v, c.Op, len(c.Data), want)
			}
			if got, err := DecodeAmountChunk(c); err != nil || got != v {
				t.Errorf("%d: round trip %d, %v", v, got, err)
			}
		}
	}
}

func TestDecodeAmountChunkRejects(t *testing.T) {
	const direct = "amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes"
	for _, c := range []struct {
		name  string
		chunk Chunk
		want  string
	}{
		{"data push of 5", Chunk{Op: 1, Data: []byte{0x05}}, "amounts 0..16 must use OP_0/OP_1..OP_16"},
		{"data push of 16", Chunk{Op: 1, Data: []byte{0x10}}, "amounts 0..16 must use OP_0/OP_1..OP_16"},
		{"data push of 0", Chunk{Op: 1, Data: []byte{0x00}}, "amount is not minimally encoded"},
		{"empty PUSHDATA1", Chunk{Op: 0x4c, Data: []byte{}}, direct},
		{"negative", Chunk{Op: 1, Data: []byte{0x81}}, "amount must not be negative"},
		{"negative zero", Chunk{Op: 1, Data: []byte{0x80}}, "amount must not be negative"},
		{"negative multi-byte", Chunk{Op: 2, Data: []byte{0x11, 0x80}}, "amount must not be negative"},
		{"OP_1NEGATE", Chunk{Op: 0x4f}, direct},
		{"non-minimal padding", Chunk{Op: 2, Data: []byte{0x11, 0x00}}, "amount is not minimally encoded"},
		{"double padding", Chunk{Op: 3, Data: []byte{0xff, 0x00, 0x00}}, "amount is not minimally encoded"},
		{"PUSHDATA1 for 17", Chunk{Op: 0x4c, Data: []byte{0x11}}, direct},
		{"above 2^64-1", Chunk{Op: 9, Data: []byte{0, 0, 0, 0, 0, 0, 0, 0, 0x01}}, "amount exceeds 2^64-1"},
		{"10 bytes", Chunk{Op: 10, Data: []byte{1, 0, 0, 0, 0, 0, 0, 0, 0, 0}}, direct},
		{"length mismatch", Chunk{Op: 2, Data: []byte{0x11}}, direct},
		{"push without data", Chunk{Op: 1}, direct},
		{"opcode, not a push", Chunk{Op: 0x76}, direct},
	} {
		_, err := DecodeAmountChunk(c.chunk)
		if got := codecErr(t, err); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestTokenIDStrings(t *testing.T) {
	id, err := TokenIDFromString(testID)
	if err != nil || hex.EncodeToString(id[:]) != testIDWire {
		t.Fatalf("TokenIDFromString = %x, %v", id, err)
	}
	if TokenIDToString(id) != testID {
		t.Fatalf("TokenIDToString = %s", TokenIDToString(id))
	}
	for _, bad := range []string{"", testTxid, testTxid + "_1", testTxid + "_00", strings.ToUpper(testTxid) + "_0",
		testTxid + ".0", "x" + testTxid + "_0", testTxid[2:] + "_0", "zz" + testTxid[2:] + "_0"} {
		_, err := TokenIDFromString(bad)
		if got := codecErr(t, err); got != "token id must be <64 lowercase hex>_0" {
			t.Errorf("%q: %q", bad, got)
		}
	}
}

func TestIsTokenShapedTable(t *testing.T) {
	for _, c := range []struct {
		hex  string
		want bool
	}{
		{"00006d", true}, {"20" + testIDWire + "556d", true}, {"4f4f6d", true}, {"60606d51", true},
		{"", false}, {"0000", false}, {"000075", false}, {"76006d", false}, {"00766d", false},
		{"00616d", false}, {"00506d", false}, {p2pkhHex, false}, {"4e0100000001006d", true},
	} {
		if got := IsTokenShaped(mustHex(t, c.hex)); got != c.want {
			t.Errorf("IsTokenShaped(%s) = %v", c.hex, got)
		}
	}
	_, err := Decode(mustHex(t, p2pkhHex))
	if got := codecErr(t, err); got != "not a BRC-162 token output" {
		t.Errorf("plain P2PKH: %q", got)
	}
}

func lockHex(t *testing.T, p LockParams) string {
	t.Helper()
	b, err := Lock(p)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func TestLockAndDecode(t *testing.T) {
	pkh := mustHex(t, pkhHex)
	if got := lockHex(t, LockParams{PubKeyHash: pkh, Payload: []byte{0xa0}, HasPayload: true}); got != "00006d01a075"+p2pkhHex {
		t.Errorf("deploy lock = %s", got)
	}
	d, err := Decode(mustHex(t, "00006d01a075"+p2pkhHex))
	if err != nil || d.Role != RoleDeploy || d.Amount != 0 || !bytes.Equal(d.Payload, []byte{0xa0}) ||
		!d.PayloadCanonical || !bytes.Equal(d.RestPubKeyHash, pkh) || d.TokenID != nil || len(d.RestChunks) != 5 {
		t.Errorf("deploy decode = %+v, %v", d, err)
	}
	d, _ = Decode(mustHex(t, lockHex(t, LockParams{Amount: 5, PubKeyHash: pkh})))
	if d.Role != RoleDeploy || d.Amount != 5 || d.HasPayload {
		t.Errorf("fixed-supply deploy = %+v", d)
	}
	if got := lockHex(t, LockParams{TokenID: testID, Amount: 5000, PubKeyHash: pkh}); got != "20"+testIDWire+"0288136d"+p2pkhHex {
		t.Errorf("value 5000 = %s", got)
	}
	if got := lockHex(t, LockParams{TokenID: testID, Amount: 1, PubKeyHash: pkh}); got != "20"+testIDWire+"516d"+p2pkhHex {
		t.Errorf("value 1 = %s", got)
	}
	d, _ = Decode(mustHex(t, lockHex(t, LockParams{TokenID: testID, PubKeyHash: pkh})))
	if d.Role != RoleAuthority {
		t.Errorf("amount 0 role = %s", d.Role)
	}
	d, _ = Decode(mustHex(t, lockHex(t, LockParams{TokenID: testID, Amount: math.MaxUint64, PubKeyHash: pkh})))
	if d.Amount != math.MaxUint64 || TokenIDToString(*d.TokenID) != testID {
		t.Errorf("max amount = %+v", d)
	}
}

func TestLockPayloadChunks(t *testing.T) {
	pkh := mustHex(t, pkhHex)
	fill := func(n int) []byte { return bytes.Repeat([]byte{0x11}, n) }
	for _, c := range []struct {
		payload  []byte
		op       byte
		withData bool
	}{
		{[]byte{}, 0x00, false}, {[]byte{0x01}, 0x51, false}, {[]byte{0x05}, 0x55, false}, {[]byte{0x10}, 0x60, false},
		{[]byte{0x81}, 0x4f, false}, {[]byte{0x00}, 0x01, true}, {[]byte{0x11}, 0x01, true}, {[]byte{0x80}, 0x01, true},
		{fill(75), 75, true}, {fill(76), 0x4c, true}, {fill(255), 0x4c, true}, {fill(256), 0x4d, true},
		{fill(65535), 0x4d, true}, {fill(65536), 0x4e, true},
	} {
		script, err := Lock(LockParams{TokenID: testID, Amount: 7, PubKeyHash: pkh, Payload: c.payload, HasPayload: true})
		if err != nil {
			t.Fatal(err)
		}
		chunks := ParseChunks(script)
		if chunks[3].Op != c.op || (chunks[3].Data != nil) != c.withData || chunks[4].Op != 0x75 {
			t.Errorf("payload len %d: chunk %+v then %x", len(c.payload), chunks[3].Op, chunks[4].Op)
		}
		d, err := Decode(script)
		if err != nil || !d.HasPayload || !bytes.Equal(d.Payload, c.payload) || !d.PayloadCanonical {
			t.Errorf("payload len %d: decode %v canonical %v", len(c.payload), err, d.PayloadCanonical)
		}
	}
}

func TestDecodePayloadsAndRest(t *testing.T) {
	near := "0102030405060708090a0b0c0d0e0f1011121314"
	for _, c := range []struct {
		name       string
		hex        string
		hasPayload bool
		payload    string
		canonical  bool
		restLen    int
		pkh        bool
	}{
		{"leading push OP_DROP", "00006d010175" + p2pkhHex, true, "01", false, 5, true},
		{"PUSHDATA1 of 05", "00006d4c010575" + p2pkhHex, true, "05", false, 5, true},
		{"PUSHDATA1 empty", "00006d4c0075" + p2pkhHex, true, "", false, 5, true},
		{"data push of 81", "00006d018175" + p2pkhHex, true, "81", false, 5, true},
		{"PUSHDATA1 4 bytes", "00006d4c04a161610175" + p2pkhHex, true, "a1616101", false, 5, true},
		{"PUSHDATA2 76 bytes", "00006d4d4c00" + strings.Repeat("11", 76) + "75" + p2pkhHex, true, strings.Repeat("11", 76), false, 5, true},
		{"PUSHDATA4 256 bytes", "00006d4e00010000" + strings.Repeat("11", 256) + "75" + p2pkhHex, true, strings.Repeat("11", 256), false, 5, true},
		{"OP_1NEGATE payload", "00006d4f75" + p2pkhHex, true, "81", true, 5, true},
		{"first push OP_DROP only", "00006d51755275", true, "01", true, 2, false},
		{"no rest", "00006d", false, "", true, 0, false},
		{"one rest chunk", "00006d51", false, "", true, 1, false},
		{"two rest chunks", "00006d5151", false, "", true, 2, false},
		{"OP_DUP OP_DROP", "00006d7675", false, "", true, 2, false},
		{"DUP to NOP", "00006d61a914" + near + "88ac", false, "", true, 5, false},
		{"HASH160 to SHA256", "00006d76a814" + near + "88ac", false, "", true, 5, false},
		{"19-byte hash", "00006d76a913" + near[2:] + "88ac", false, "", true, 5, false},
		{"EQUAL", "00006d76a914" + near + "87ac", false, "", true, 5, false},
		{"CHECKSIGVERIFY", "00006d76a914" + near + "88ad", false, "", true, 5, false},
		{"trailing OP_1", "00006d76a914" + near + "88ac51", false, "", true, 6, false},
		{"PUSHDATA1 of 20", "00006d76a94c14" + near + "88ac", false, "", true, 5, false},
	} {
		d, err := Decode(mustHex(t, c.hex))
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if d.HasPayload != c.hasPayload || hex.EncodeToString(d.Payload) != c.payload || d.PayloadCanonical != c.canonical ||
			len(d.RestChunks) != c.restLen || (d.RestPubKeyHash != nil) != c.pkh {
			t.Errorf("%s: has %v payload %x canonical %v rest %d pkh %x", c.name, d.HasPayload, d.Payload, d.PayloadCanonical, len(d.RestChunks), d.RestPubKeyHash)
		}
	}
	d, _ := Decode(mustHex(t, "00006d51755275"))
	if d.RestChunks[0].Op != 0x52 || d.RestChunks[1].Op != 0x75 {
		t.Errorf("rest = %+v", d.RestChunks)
	}
}

func TestDecodeTokenShapedButInvalid(t *testing.T) {
	ones := strings.Repeat("11", 32)
	for _, c := range []struct{ hex, want string }{
		{"24" + strings.Repeat("11", 36) + "01056d", "token id must be a direct 32-byte push"},
		{"1f" + strings.Repeat("11", 31) + "01056d", "token id must be a direct 32-byte push"},
		{"4f556d", "token id must be a direct 32-byte push"},
		{"51556d", "token id must be a direct 32-byte push"},
		{"20" + ones + "0205006d", "amount is not minimally encoded"},
		{"20" + ones + "01056d", "amounts 0..16 must use OP_0/OP_1..OP_16"},
		{"20" + ones + "01006d", "amount is not minimally encoded"},
		{"20" + ones + "4f6d", "amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes"},
		{"20" + ones + "038813ff6d", "amount must not be negative"},
		{"4c20" + ones + "556d", "token id must be a direct 32-byte push"},
		{"00006d4c050102", "truncated push"},
		{"20" + testIDWire + "516d4c050102", "truncated push"},
	} {
		_, err := Decode(mustHex(t, c.hex))
		if got := codecErr(t, err); got != c.want {
			t.Errorf("%s: %q, want %q", c.hex, got, c.want)
		}
	}
}

func TestLockInputValidation(t *testing.T) {
	pkh := mustHex(t, pkhHex)
	for _, c := range []struct {
		p    LockParams
		want string
	}{
		{LockParams{TokenID: testID, Amount: 1, PubKeyHash: pkh[:19]}, "pubKeyHash must be 20 bytes"},
		{LockParams{TokenID: testID, Amount: 1, PubKeyHash: append(append([]byte{}, pkh...), 0x15)}, "pubKeyHash must be 20 bytes"},
		{LockParams{TokenID: testTxid + "_1", Amount: 1, PubKeyHash: pkh}, "token id must be <64 lowercase hex>_0"},
		{LockParams{TokenID: testTxid + "_1", Amount: 1, PubKeyHash: pkh[:19]}, "pubKeyHash must be 20 bytes"},
	} {
		_, err := Lock(c.p)
		if got := codecErr(t, err); got != c.want {
			t.Errorf("%+v: %q, want %q", c.p, got, c.want)
		}
	}
	payload := []byte{0x11, 0x22}
	script, _ := Lock(LockParams{TokenID: testID, Amount: 1, PubKeyHash: pkh, Payload: payload, HasPayload: true})
	payload[0] = 0xff
	d, _ := Decode(script)
	if d.Payload[0] != 0x11 {
		t.Error("Lock aliased the caller's payload")
	}
}

// Fact base ts-codec §1.1-§1.2: go-sdk's DecodeScript accepts the first probe as
// a valid deploy and drops the truncated chunk of the second; TS refuses both.
func TestChunkerProbesDivergeFromGoSDK(t *testing.T) {
	for _, h := range []string{"00006d686a4c0501", "00006d4c050102", "00006d4c", "00006d4d01"} {
		script := mustHex(t, h)
		if !IsTokenShaped(script) {
			t.Errorf("%s: IsTokenShaped = false, want true", h)
		}
		_, err := Decode(script)
		if ce, ok := err.(*CodecError); !ok || ce.Message != "truncated push" {
			t.Errorf("%s: Decode error = %v, want truncated push", h, err)
		}
	}
	if IsTokenShaped(mustHex(t, "00004c0501")) {
		t.Error("00004c0501: shaped, want not shaped (the truncated chunk is the third)")
	}
}

func TestCodecNeverImportsTheGoSDKScriptPackage(t *testing.T) {
	for _, file := range []string{"chunks.go", "codec.go"} {
		f, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range f.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			if path == "github.com/bsv-blockchain/go-sdk/script" {
				t.Errorf("%s imports %s: the token path must use the TS-parity chunker only", file, path)
			}
		}
	}
}

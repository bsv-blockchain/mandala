package brc162

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"math/big"
	"reflect"
	"runtime"
	"testing"
)

func cborErr(t *testing.T, err error) string {
	t.Helper()
	se, ok := err.(*StrictCborError)
	if !ok {
		t.Fatalf("error %v (%T) is not a *StrictCborError", err, err)
	}
	return se.Message
}

func TestVectorStrictCbor(t *testing.T) {
	for _, row := range loadBRC162Vectors(t).StrictCbor {
		t.Run(row.ID, func(t *testing.T) {
			input := mustHex(t, row.Hex)
			m, err := DecodeStrictCbor(input)
			if row.Valid {
				if err != nil {
					t.Fatalf("decode: %v", err)
				}
				again, err := EncodeStrictCbor(m)
				if err != nil || !bytes.Equal(again, input) {
					t.Fatalf("re-encode = %x, %v", again, err)
				}
				if _, ok := TryDecodeStrictCbor(input); !ok {
					t.Fatal("TryDecodeStrictCbor = false on a valid row")
				}
				return
			}
			if row.Error == nil {
				t.Fatal("reject row without error")
			}
			if got := cborErr(t, err); got != *row.Error {
				t.Fatalf("error %q, want %q", got, *row.Error)
			}
			if _, ok := TryDecodeStrictCbor(input); ok {
				t.Fatal("TryDecodeStrictCbor = true on a reject row")
			}
		})
	}
}

func TestVectorCommitments(t *testing.T) {
	for _, row := range loadBRC162Vectors(t).Commitments {
		t.Run(row.ID, func(t *testing.T) {
			details := mustHex(t, row.DetailsHex)
			sum := sha256.Sum256(details)
			if hex.EncodeToString(sum[:]) != row.Commitment {
				t.Fatalf("sha256 = %x, want %s", sum, row.Commitment)
			}
			m, err := DecodeStrictCbor(details)
			if err != nil {
				t.Fatal(err)
			}
			again, err := EncodeStrictCbor(m)
			if err != nil || !bytes.Equal(again, details) {
				t.Fatalf("re-encode = %x, %v", again, err)
			}
		})
	}
}

func TestEncodeStrictCborTable(t *testing.T) {
	minus2p64, _ := new(big.Int).SetString("-18446744073709551616", 10)
	deep := CborMap{"a": CborMap{"b": CborMap{"c": CborMap{"d": CborMap{"e": uint64(1)}}}}}
	for _, c := range []struct {
		name string
		m    CborMap
		hex  string
	}{
		{"spec vector", CborMap{"sym": "USD", "dec": uint64(2)}, "a263646563026373796d63555344"},
		{"23", CborMap{"a": uint64(23)}, "a1616117"},
		{"24", CborMap{"a": uint64(24)}, "a161611818"},
		{"0", CborMap{"a": uint64(0)}, "a1616100"},
		{"255", CborMap{"a": uint64(255)}, "a1616118ff"},
		{"256", CborMap{"a": uint64(256)}, "a161611901" + "00"},
		{"65535", CborMap{"a": uint64(65535)}, "a1616119ffff"},
		{"65536", CborMap{"a": uint64(65536)}, "a161611a00010000"},
		{"2^32-1", CborMap{"a": uint64(4294967295)}, "a161611affffffff"},
		{"2^32", CborMap{"a": uint64(4294967296)}, "a161611b0000000100000000"},
		{"2^64-1", CborMap{"a": uint64(math.MaxUint64)}, "a161611bffffffffffffffff"},
		{"MAX_SAFE_INTEGER as int64", CborMap{"a": int64(9007199254740991)}, "a161611b001fffffffffffff"},
		{"int and uint32", CborMap{"a": 1, "b": uint32(2)}, "a2616101616202"},
		{"negative int", CborMap{"a": -1}, "a1616120"},
		{"negative int64 -256", CborMap{"a": int64(-256)}, "a1616138ff"},
		{"min int64", CborMap{"a": int64(math.MinInt64)}, "a161613b7fffffffffffffff"},
		{"big -1", CborMap{"a": big.NewInt(-1)}, "a1616120"},
		{"big -2^64", CborMap{"a": minus2p64}, "a161613bffffffffffffffff"},
		{"big 2^64-1", CborMap{"a": new(big.Int).SetUint64(math.MaxUint64)}, "a161611bffffffffffffffff"},
		{"float 1.5", CborMap{"a": 1.5}, "a16161fb3ff8000000000000"},
		{"integral float stays a float", CborMap{"a": 1.0}, "a16161fb3ff0000000000000"},
		{"array", CborMap{"a": []any{uint64(1), -1, 1.5, []any{}}}, "a16161840120fb3ff800000000000080"},
		{"link", CborMap{"a": CborLink{CID: []byte{0}}}, "a16161d82a4100"},
		{"every kind, keys sorted", CborMap{"b": []byte{1, 2}, "n": nil, "t": true, "f": false, "m": CborMap{"x": uint64(1)}},
			"a561624201026166f4616da1617801616ef66174f5"},
		{"euro", CborMap{"€": "€"}, "a163e282ac63e282ac"},
		{"emoji", CborMap{"a": "😀"}, "a1616164f09f9880"},
		{"depth 5", deep, "a16161a16162a16163a16164a1616501"},
		{"length-first keys", CborMap{"bb": uint64(1), "c": uint64(2)}, "a261630262626201"},
	} {
		got, err := EncodeStrictCbor(c.m)
		if err != nil || hex.EncodeToString(got) != c.hex {
			t.Errorf("%s: %x, %v; want %s", c.name, got, err, c.hex)
		}
	}
	out, err := EncodeStrictCbor(CborMap{"a": make([]byte, 4091)})
	if err != nil || len(out) != 4097 {
		t.Fatalf("4091-byte value: len %d, %v (the codec has no size cap)", len(out), err)
	}
}

func TestEncodeStrictCborRefusals(t *testing.T) {
	below, _ := new(big.Int).SetString("-18446744073709551617", 10)
	above, _ := new(big.Int).SetString("18446744073709551616", 10)
	tooDeep := any(uint64(1))
	for i := 0; i < StrictCborMaxDepth; i++ {
		tooDeep = []any{tooDeep}
	}
	for _, c := range []struct {
		name string
		m    CborMap
		want string
	}{
		{"nil top level", nil, "top level must be a map"},
		{"depth 1025", CborMap{"a": tooDeep}, "nesting deeper than 1024"},
		{"big below -2^64", CborMap{"a": below}, "integer outside -2^64..2^64-1"},
		{"big at 2^64", CborMap{"a": above}, "integer outside -2^64..2^64-1"},
		{"nil big", CborMap{"a": (*big.Int)(nil)}, "unsupported value type"},
		{"NaN", CborMap{"a": math.NaN()}, "number must be a safe integer or a finite float"},
		{"+Inf", CborMap{"a": math.Inf(1)}, "number must be a safe integer or a finite float"},
		{"float32", CborMap{"a": float32(1.5)}, "unsupported value type"},
		{"invalid CID: empty", CborMap{"a": CborLink{}}, "invalid CID"},
		{"invalid CID: prefix", CborMap{"a": CborLink{CID: []byte{1}}}, "invalid CID"},
		{"array of strings", CborMap{"a": []string{"x"}}, "unsupported value type"},
		{"invalid UTF-8 value", CborMap{"a": "\xff"}, "invalid UTF-8"},
		{"invalid UTF-8 key", CborMap{"\xff": uint64(1)}, "invalid UTF-8"},
		{"invalid UTF-8 in an array", CborMap{"a": []any{"\xff"}}, "invalid UTF-8"},
	} {
		_, err := EncodeStrictCbor(c.m)
		if got := cborErr(t, err); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

// TestDecodeStrictCborFullTypes: every decoded value type, and every decoded value re-encodes to
// its input bytes.
func TestDecodeStrictCborFullTypes(t *testing.T) {
	cases := []struct {
		hex   string
		check func(any) bool
	}{
		{"a1616120", func(v any) bool { b, ok := v.(*big.Int); return ok && b.Cmp(big.NewInt(-1)) == 0 }},
		{"a161613bffffffffffffffff", func(v any) bool {
			b, ok := v.(*big.Int)
			want, _ := new(big.Int).SetString("-18446744073709551616", 10)
			return ok && b.Cmp(want) == 0
		}},
		{"a16161fb3ff8000000000000", func(v any) bool { f, ok := v.(float64); return ok && f == 1.5 }},
		{"a16161fb3ff0000000000000", func(v any) bool { f, ok := v.(float64); return ok && f == 1 }},
		{"a16161fb8000000000000000", func(v any) bool { f, ok := v.(float64); return ok && f == 0 && math.Signbit(f) }},
		{"a16161d82a420001", func(v any) bool { l, ok := v.(CborLink); return ok && bytes.Equal(l.CID, []byte{0, 1}) }},
		{"a161618201a0", func(v any) bool {
			a, ok := v.([]any)
			if !ok || len(a) != 2 || a[0] != uint64(1) {
				return false
			}
			m, ok := a[1].(CborMap)
			return ok && len(m) == 0
		}},
		{"a1616180", func(v any) bool { a, ok := v.([]any); return ok && len(a) == 0 }},
	}
	for _, c := range cases {
		in := mustHex(t, c.hex)
		m, err := DecodeStrictCbor(in)
		if err != nil || !c.check(m["a"]) {
			t.Fatalf("%s: %v %#v", c.hex, err, m)
		}
		again, err := EncodeStrictCbor(m)
		if err != nil || !bytes.Equal(again, in) {
			t.Fatalf("%s: re-encode %x %v", c.hex, again, err)
		}
	}
}

func TestDecodeStrictCborLimit(t *testing.T) {
	nest := func(n int) []byte {
		b := []byte{0xa1, 0x61, 0x61}
		for i := 0; i < n-1; i++ {
			b = append(b, 0x81)
		}
		return append(b, 0x01)
	}
	if _, err := DecodeStrictCborLimit(nest(64), 64); err != nil {
		t.Fatalf("depth 64: %v", err)
	}
	if _, err := DecodeStrictCborLimit(nest(65), 64); cborErr(t, err) != "nesting deeper than 64" {
		t.Fatal(err)
	}
	if _, err := DecodeStrictCbor(nest(1024)); err != nil {
		t.Fatalf("depth 1024: %v", err)
	}
	if _, err := DecodeStrictCbor(nest(1025)); cborErr(t, err) != "nesting deeper than 1024" {
		t.Fatal(err)
	}
}

// TestDecodeStrictCborDoesNotPreallocateClaimedCounts: a container count is checked against the
// whole input, so a nested chain of large claimed counts must not reserve memory per level.
func TestDecodeStrictCborDoesNotPreallocateClaimedCounts(t *testing.T) {
	for name, level := range map[string][]byte{
		"arrays": {0x99, 0xff, 0xff},             // an array of 65535 entries
		"maps":   {0xb9, 0xff, 0xff, 0x61, 0x61}, // a map of 65535 entries, first key "a"
	} {
		in := []byte{0xa1, 0x61, 0x61}
		for i := 0; i < 1000; i++ {
			in = append(in, level...)
		}
		in = append(in, make([]byte, 65535)...)
		var ms runtime.MemStats
		runtime.ReadMemStats(&ms)
		before := ms.TotalAlloc
		_, err := DecodeStrictCbor(in)
		runtime.ReadMemStats(&ms)
		if err == nil {
			t.Fatalf("%s: accepted a truncated chain", name)
		}
		if grew := ms.TotalAlloc - before; grew > 64<<20 {
			t.Fatalf("%s: decode allocated %d bytes for a %d-byte input", name, grew, len(in))
		}
	}
}

func TestDecodeStrictCborValueTypes(t *testing.T) {
	m, err := DecodeStrictCbor(mustHex(t, "a561624201026166f4616da1617801616ef66174f5"))
	if err != nil {
		t.Fatal(err)
	}
	want := CborMap{"b": []byte{1, 2}, "f": false, "m": CborMap{"x": uint64(1)}, "n": nil, "t": true}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("decoded %#v", m)
	}
	m, err = DecodeStrictCbor(mustHex(t, "a1616164efbbbf78"))
	if err != nil || m["a"] != "\xef\xbb\xbfx" {
		t.Fatalf("BOM kept: %#v, %v", m, err)
	}
	m, err = DecodeStrictCbor(mustHex(t, "a1695f5f70726f746f5f5fa1616101"))
	if err != nil || !reflect.DeepEqual(m["__proto__"], CborMap{"a": uint64(1)}) {
		t.Fatalf("__proto__ key: %#v, %v", m, err)
	}
	if m, ok := TryDecodeStrictCbor(mustHex(t, "a1616101")); !ok || m["a"] != uint64(1) {
		t.Fatalf("TryDecodeStrictCbor = %#v, %v", m, ok)
	}
}

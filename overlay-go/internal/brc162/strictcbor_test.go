package brc162

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"reflect"
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
		{"every kind, keys sorted", CborMap{"b": []byte{1, 2}, "n": nil, "t": true, "f": false, "m": CborMap{"x": uint64(1)}},
			"a561624201026166f4616da1617801616ef66174f5"},
		{"euro", CborMap{"€": "€"}, "a163e282ac63e282ac"},
		{"emoji", CborMap{"a": "😀"}, "a1616164f09f9880"},
		{"depth 4", CborMap{"a": CborMap{"b": CborMap{"c": CborMap{"d": uint64(1)}}}}, "a16161a16162a16163a1616401"},
		{"length-first keys", CborMap{"bb": uint64(1), "c": uint64(2)}, "a261630262626201"},
	} {
		got, err := EncodeStrictCbor(c.m)
		if err != nil || hex.EncodeToString(got) != c.hex {
			t.Errorf("%s: %x, %v; want %s", c.name, got, err, c.hex)
		}
	}
}

func TestEncodeStrictCborRefusals(t *testing.T) {
	deep := CborMap{"a": CborMap{"b": CborMap{"c": CborMap{"d": CborMap{"e": uint64(1)}}}}}
	for _, c := range []struct {
		name string
		m    CborMap
		want string
	}{
		{"nil top level", nil, "top level must be a map"},
		{"depth 5", deep, "map nesting deeper than 4"},
		{"negative int", CborMap{"a": -1}, "integer outside 0..2^64-1"},
		{"negative int64", CborMap{"a": int64(-1)}, "integer outside 0..2^64-1"},
		{"float", CborMap{"a": 1.5}, "unsupported value type"},
		{"array", CborMap{"a": []any{uint64(1)}}, "unsupported value type"},
		{"invalid UTF-8 value", CborMap{"a": "\xff"}, "invalid UTF-8"},
		{"invalid UTF-8 key", CborMap{"\xff": uint64(1)}, "invalid UTF-8"},
		{"4091-byte bytes", CborMap{"a": make([]byte, 4091)}, "encoding exceeds 4096 bytes"},
	} {
		_, err := EncodeStrictCbor(c.m)
		if got := cborErr(t, err); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
	out, err := EncodeStrictCbor(CborMap{"a": make([]byte, 4090)})
	if err != nil || len(out) != 4096 {
		t.Fatalf("4090-byte value: len %d, %v", len(out), err)
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

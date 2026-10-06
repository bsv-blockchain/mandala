package brc162

import (
	"encoding/hex"
	"reflect"
	"testing"
)

func TestParseChunks(t *testing.T) {
	cases := []struct {
		name string
		hex  string
		want []Chunk
	}{
		{"empty", "", []Chunk{}},
		{"OP_0 has no data", "00", []Chunk{{Op: 0x00}}},
		{"direct push", "0102", []Chunk{{Op: 0x01, Data: []byte{0x02}}}},
		{"PUSHDATA1", "4c0105", []Chunk{{Op: 0x4c, Data: []byte{0x05}}}},
		{"PUSHDATA1 empty", "4c00", []Chunk{{Op: 0x4c, Data: []byte{}}}},
		{"PUSHDATA2", "4d0100aa", []Chunk{{Op: 0x4d, Data: []byte{0xaa}}}},
		{"PUSHDATA4", "4e01000000aa", []Chunk{{Op: 0x4e, Data: []byte{0xaa}}}},
		{"small ints carry no data", "4f5160", []Chunk{{Op: 0x4f}, {Op: 0x51}, {Op: 0x60}}},
		{"truncated direct push", "0501", []Chunk{{Op: 0x05, Data: []byte{0x01}, InvalidLength: true}}},
		{"PUSHDATA1 missing length", "4c", []Chunk{{Op: 0x4c, Data: []byte{}, InvalidLength: true}}},
		{"PUSHDATA1 short data", "4c0501", []Chunk{{Op: 0x4c, Data: []byte{0x01}, InvalidLength: true}}},
		{"PUSHDATA2 half length", "4d01", []Chunk{{Op: 0x4d, Data: []byte{}, InvalidLength: true}}},
		{"PUSHDATA4 short length", "4e010000", []Chunk{{Op: 0x4e, Data: []byte{}, InvalidLength: true}}},
		{"OP_RETURN at depth 0 swallows the rest", "006a0102", []Chunk{{Op: 0x00}, {Op: 0x6a, Data: []byte{0x01, 0x02}}}},
		{"OP_RETURN as last byte", "6a", []Chunk{{Op: 0x6a, Data: []byte{}}}},
		{"OP_RETURN inside IF is plain", "636a68", []Chunk{{Op: 0x63}, {Op: 0x6a}, {Op: 0x68}}},
		{"OP_RETURN after unbalanced ENDIF is plain", "686a01", []Chunk{{Op: 0x68}, {Op: 0x6a}, {Op: 0x01, Data: []byte{}, InvalidLength: true}}},
		{"NOTIF VERIF VERNOTIF raise depth", "6465666a", []Chunk{{Op: 0x64}, {Op: 0x65}, {Op: 0x66}, {Op: 0x6a}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseChunks(mustHex(t, c.hex))
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("ParseChunks(%s) = %+v\nwant %+v", c.hex, got, c.want)
			}
		})
	}
}

func TestSerializeChunkRoundTripsWithoutReminimising(t *testing.T) {
	for _, h := range []string{
		"76a9140102030405060708090a0b0c0d0e0f101112131488ac",
		"4c0105", "4c00", "4d0100aa", "4e01000000aa", "006a0102", "6a", "00006d4f75",
	} {
		chunks := ParseChunks(mustHex(t, h))
		if got := hex.EncodeToString(serializeChunks(chunks)); got != h {
			t.Errorf("serialize(parse(%s)) = %s", h, got)
		}
	}
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("hex %q: %v", s, err)
	}
	return b
}

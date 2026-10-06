package brc162

import (
	"bytes"
	"fmt"
	"sort"
	"unicode/utf8"
)

// Strict DAG-CBOR subset (design §3.5), a line-for-line port of @bsv/templates
// strictCbor.ts (ts-stack 37468f290). The messages and the order the checks run
// in are a cross-engine contract (fact base ts-codec §6.3, §6.5).
const (
	StrictCborMaxBytes = 4096
	StrictCborMaxDepth = 4
)

// StrictCborError is TS StrictCborError; Message is the exact contract string.
type StrictCborError struct{ Message string }

func (e *StrictCborError) Error() string { return e.Message }

func cborFail(message string) error { return &StrictCborError{Message: message} }

// CborMap values from DecodeStrictCbor are exactly: uint64 (major 0), []byte (2), string (3), nil (f6), bool (f4/f5),
// CborMap (5). EncodeStrictCbor also accepts int, int64 and uint32 >= 0. Go-only encoder messages: a string that is not
// valid UTF-8 -> "invalid UTF-8"; an unsupported Go type -> "unsupported value type"; a negative integer -> "integer
// outside 0..2^64-1"; plus the TS "map nesting deeper than 4" (checked first) and "encoding exceeds 4096 bytes" (last).
type CborMap map[string]any

// cborHeader is the minimal definite-length header (strictCbor.ts:45-52).
func cborHeader(major byte, v uint64) []byte {
	m := major << 5
	switch {
	case v < 24:
		return []byte{m | byte(v)}
	case v < 0x100:
		return []byte{m | 24, byte(v)}
	case v < 0x10000:
		return []byte{m | 25, byte(v >> 8), byte(v)}
	case v < 0x100000000:
		return []byte{m | 26, byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
	default:
		return []byte{m | 27, byte(v >> 56), byte(v >> 48), byte(v >> 40), byte(v >> 32), byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}
	}
}

// encodeText: TS refuses a lone surrogate; the Go equivalent is invalid UTF-8.
func encodeText(s string) ([]byte, error) {
	if !utf8.ValidString(s) {
		return nil, cborFail("invalid UTF-8")
	}
	return append(cborHeader(3, uint64(len(s))), s...), nil
}

func encodeValue(v any, depth int) ([]byte, error) {
	switch x := v.(type) {
	case uint64:
		return cborHeader(0, x), nil
	case uint32:
		return cborHeader(0, uint64(x)), nil
	case int:
		if x < 0 {
			return nil, cborFail("integer outside 0..2^64-1")
		}
		return cborHeader(0, uint64(x)), nil
	case int64:
		if x < 0 {
			return nil, cborFail("integer outside 0..2^64-1")
		}
		return cborHeader(0, uint64(x)), nil
	case string:
		return encodeText(x)
	case nil:
		return []byte{0xf6}, nil
	case bool:
		if x {
			return []byte{0xf5}, nil
		}
		return []byte{0xf4}, nil
	case []byte:
		return append(cborHeader(2, uint64(len(x))), x...), nil
	case CborMap:
		return encodeMap(x, depth+1)
	default:
		return nil, cborFail("unsupported value type")
	}
}

// encodeMap (strictCbor.ts:97-107): depth first, then every key, then the
// entries sorted by encoded key bytes (equals DAG-CBOR length-first order).
func encodeMap(m CborMap, depth int) ([]byte, error) {
	if depth > StrictCborMaxDepth {
		return nil, cborFail("map nesting deeper than 4")
	}
	type entry struct {
		key   []byte
		value any
	}
	entries := make([]entry, 0, len(m))
	for k, v := range m {
		key, err := encodeText(k)
		if err != nil {
			return nil, err
		}
		entries = append(entries, entry{key, v})
	}
	sort.Slice(entries, func(i, j int) bool { return bytes.Compare(entries[i].key, entries[j].key) < 0 })
	out := cborHeader(5, uint64(len(entries)))
	for _, e := range entries {
		value, err := encodeValue(e.value, depth)
		if err != nil {
			return nil, err
		}
		out = append(append(out, e.key...), value...)
	}
	return out, nil
}

// EncodeStrictCbor ports encodeStrictCbor (strictCbor.ts:109-116); keys sorted
// by encoded bytes (length-first); the 4096-byte limit is checked last.
func EncodeStrictCbor(m CborMap) ([]byte, error) {
	if m == nil {
		return nil, cborFail("top level must be a map")
	}
	out, err := encodeMap(m, 1)
	if err != nil {
		return nil, err
	}
	if len(out) > StrictCborMaxBytes {
		return nil, cborFail("encoding exceeds 4096 bytes")
	}
	return out, nil
}

type cborReader struct {
	b   []byte
	pos int
}

func (r *cborReader) next() (byte, error) {
	if r.pos >= len(r.b) {
		return 0, cborFail("truncated input")
	}
	r.pos++
	return r.b[r.pos-1], nil
}

func (r *cborReader) take(n int) ([]byte, error) {
	if n > len(r.b)-r.pos {
		return nil, cborFail("truncated input")
	}
	r.pos += n
	return r.b[r.pos-n : r.pos], nil
}

var cborMinimum = [4]uint64{24, 0x100, 0x10000, 0x100000000}

// head returns [major, value]; refuses indefinite/reserved and non-minimal
// headers for every major type, before the caller looks at the major type
// (strictCbor.ts:139-150).
func (r *cborReader) head() (byte, uint64, error) {
	b, err := r.next()
	if err != nil {
		return 0, 0, err
	}
	major, info := b>>5, b&0x1f
	if info < 24 {
		return major, uint64(info), nil
	}
	if info > 27 {
		if info == 31 {
			return 0, 0, cborFail("indefinite length")
		}
		return 0, 0, cborFail("reserved additional info")
	}
	raw, err := r.take(1 << (info - 24))
	if err != nil {
		return 0, 0, err
	}
	var v uint64
	for _, x := range raw {
		v = v<<8 | uint64(x)
	}
	if v < cborMinimum[info-24] {
		return 0, 0, cborFail("non-minimal header")
	}
	return major, v, nil
}

// count compares with the TOTAL input length, not the remaining bytes
// (strictCbor.ts:153-156): "length exceeds input" vs "truncated input".
func (r *cborReader) count(v uint64) (int, error) {
	if v > uint64(len(r.b)) {
		return 0, cborFail("length exceeds input")
	}
	return int(v), nil
}

// decodeText: strict RFC 3629 UTF-8. utf8.Valid is exactly the TS hand
// validator's accept set (fact base ts-codec §6.4, brute-force verified).
func decodeText(b []byte) (string, error) {
	if !utf8.Valid(b) {
		return "", cborFail("invalid UTF-8")
	}
	return string(b), nil
}

func (r *cborReader) value(depth int) (any, error) {
	major, v, err := r.head()
	if err != nil {
		return nil, err
	}
	switch major {
	case 0:
		return v, nil
	case 2:
		n, err := r.count(v)
		if err != nil {
			return nil, err
		}
		raw, err := r.take(n)
		if err != nil {
			return nil, err
		}
		return append([]byte{}, raw...), nil
	case 3:
		n, err := r.count(v)
		if err != nil {
			return nil, err
		}
		raw, err := r.take(n)
		if err != nil {
			return nil, err
		}
		return decodeText(raw)
	case 5:
		n, err := r.count(v)
		if err != nil {
			return nil, err
		}
		return r.mapBody(n, depth+1)
	case 7:
		switch v {
		case 20:
			return false, nil
		case 21:
			return true, nil
		case 22:
			return nil, nil
		}
		return nil, cborFail("simple value or float not allowed")
	default:
		return nil, cborFail(fmt.Sprintf("major type %d not allowed", major))
	}
}

// mapBody (strictCbor.ts:229-249): depth, then per entry key header, text key,
// UTF-8, strict key order, value.
func (r *cborReader) mapBody(count, depth int) (CborMap, error) {
	if depth > StrictCborMaxDepth {
		return nil, cborFail("map nesting deeper than 4")
	}
	out := make(CborMap, count)
	var previous []byte
	for i := 0; i < count; i++ {
		start := r.pos
		major, n, err := r.head()
		if err != nil {
			return nil, err
		}
		if major != 3 {
			return nil, cborFail("map key must be text")
		}
		size, err := r.count(n)
		if err != nil {
			return nil, err
		}
		raw, err := r.take(size)
		if err != nil {
			return nil, err
		}
		key, err := decodeText(raw)
		if err != nil {
			return nil, err
		}
		encodedKey := r.b[start:r.pos]
		if previous != nil && bytes.Compare(previous, encodedKey) >= 0 {
			return nil, cborFail("map keys unsorted or duplicated")
		}
		previous = encodedKey
		value, err := r.value(depth)
		if err != nil {
			return nil, err
		}
		out[key] = value
	}
	return out, nil
}

// DecodeStrictCbor ports decodeStrictCbor (strictCbor.ts:251-265), check order:
// input size, top header, top major type, map body, trailing bytes, re-encode guard.
func DecodeStrictCbor(input []byte) (CborMap, error) {
	if len(input) > StrictCborMaxBytes {
		return nil, cborFail("input exceeds 4096 bytes")
	}
	r := &cborReader{b: input}
	major, v, err := r.head()
	if err != nil {
		return nil, err
	}
	if major != 5 {
		return nil, cborFail("top level must be a map")
	}
	n, err := r.count(v)
	if err != nil {
		return nil, err
	}
	m, err := r.mapBody(n, 1)
	if err != nil {
		return nil, err
	}
	if r.pos != len(input) {
		return nil, cborFail("trailing bytes")
	}
	again, err := EncodeStrictCbor(m)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(again, input) {
		return nil, cborFail("non-canonical encoding")
	}
	return m, nil
}

// TryDecodeStrictCbor returns false only for a *StrictCborError (the only error
// DecodeStrictCbor returns).
func TryDecodeStrictCbor(input []byte) (CborMap, bool) {
	m, err := DecodeStrictCbor(input)
	if err != nil {
		return nil, false
	}
	return m, true
}

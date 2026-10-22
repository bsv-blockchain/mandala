package brc162

import (
	"bytes"
	"fmt"
	"math"
	"math/big"
	"sort"
	"unicode/utf8"
)

// Strict DAG-CBOR (the IPLD profile), which BRC-162 requires payloads to be read as (0162:148):
// definite lengths, minimal integer arguments, text keys in canonical order (shorter first, then
// bytewise) without duplicates, floats only as finite 64-bit values, no simple values beyond
// false/true/null, and tag 42 (a CID link) as the only tag. A check-for-check port of @bsv/templates
// strictCbor.ts at ts-stack cbdccfe5b: the messages and the order the checks run in are a
// cross-engine contract, and every refusal reaches a Mandala reject reason byte for byte.
//
// The spec sets no size limit, and neither does the codec. StrictCborMaxDepth bounds container
// nesting only, so hostile input cannot exhaust the stack. Size and depth limits that are Mandala
// policy live in internal/mandala (contract §4.1, D14).
const StrictCborMaxDepth = 1024

// StrictCborError is TS StrictCborError; Message is the exact contract string.
type StrictCborError struct{ Message string }

func (e *StrictCborError) Error() string { return e.Message }

func cborFail(message string) error { return &StrictCborError{Message: message} }

// CborMap is a strict-CBOR map. Values from DecodeStrictCbor are exactly: uint64 (major 0), *big.Int
// (major 1; always negative, = -1-arg, down to -2^64), []byte (2), string (3), []any (4), CborMap
// (5), CborLink (tag 42), float64 (finite, from 0xfb only), bool and nil.
//
// EncodeStrictCbor / EncodeStrictCborValue accept that set plus int, int64 and uint32, and any
// *big.Int in -2^64..2^64-1. A float64 always encodes as 0xfb plus 8 bytes, so every decoded value
// re-encodes to its input bytes. This differs from TS on purpose: TS encodes an integral number (1.0,
// -0.0) as an integer, because JS cannot keep the distinction; Go keeps the float. Go-only encoder
// messages: invalid UTF-8 text -> "invalid UTF-8" (TS: a lone surrogate), a NaN or infinite float ->
// "number must be a safe integer or a finite float", any other Go type -> "unsupported value type".
type CborMap map[string]any

// CborLink is a tag 42 link: the CID bytes, which begin with the 0x00 identity multibase prefix.
type CborLink struct{ CID []byte }

const cidTag = 42

var (
	cborMinInteger = new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), 64)) // -2^64
	cborMaxInteger = new(big.Int).SetUint64(math.MaxUint64)                // 2^64-1
)

func tooDeep(maxDepth int) error { return cborFail(fmt.Sprintf("nesting deeper than %d", maxDepth)) }

func isCid(b []byte) bool { return len(b) > 0 && b[0] == 0 }

// cborHeader is the minimal definite-length header (strictCbor.ts header()).
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

// encodeSigned: a negative int64 is major 1 with argument -1-v, which is always in range.
func encodeSigned(v int64) []byte {
	if v >= 0 {
		return cborHeader(0, uint64(v))
	}
	return cborHeader(1, uint64(-1-v))
}

// encodeBig ports encodeInteger (strictCbor.ts): -2^64..2^64-1.
func encodeBig(v *big.Int) ([]byte, error) {
	if v.Cmp(cborMinInteger) < 0 || v.Cmp(cborMaxInteger) > 0 {
		return nil, cborFail("integer outside -2^64..2^64-1")
	}
	if v.Sign() >= 0 {
		return cborHeader(0, v.Uint64()), nil
	}
	arg := new(big.Int).Neg(v)
	arg.Sub(arg, big.NewInt(1))
	return cborHeader(1, arg.Uint64()), nil
}

func encodeFloat(f float64) ([]byte, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil, cborFail("number must be a safe integer or a finite float")
	}
	bits := math.Float64bits(f)
	return []byte{0xfb, byte(bits >> 56), byte(bits >> 48), byte(bits >> 40), byte(bits >> 32), byte(bits >> 24), byte(bits >> 16), byte(bits >> 8), byte(bits)}, nil
}

func encodeLink(l CborLink) ([]byte, error) {
	if !isCid(l.CID) {
		return nil, cborFail("invalid CID")
	}
	return append(append([]byte{0xd8, cidTag}, cborHeader(2, uint64(len(l.CID)))...), l.CID...), nil
}

func encodeValue(v any, depth int) ([]byte, error) {
	switch x := v.(type) {
	case uint64:
		return cborHeader(0, x), nil
	case uint32:
		return cborHeader(0, uint64(x)), nil
	case int:
		return encodeSigned(int64(x)), nil
	case int64:
		return encodeSigned(x), nil
	case *big.Int:
		if x == nil {
			return nil, cborFail("unsupported value type")
		}
		return encodeBig(x)
	case float64:
		return encodeFloat(x)
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
	case CborLink:
		return encodeLink(x)
	case []any:
		return encodeArray(x, depth+1)
	case CborMap:
		return encodeMap(x, depth+1)
	default:
		return nil, cborFail("unsupported value type")
	}
}

// encodeArray (strictCbor.ts encodeArray): depth first, then each item in order.
func encodeArray(items []any, depth int) ([]byte, error) {
	if depth > StrictCborMaxDepth {
		return nil, tooDeep(StrictCborMaxDepth)
	}
	out := cborHeader(4, uint64(len(items)))
	for _, item := range items {
		b, err := encodeValue(item, depth)
		if err != nil {
			return nil, err
		}
		out = append(out, b...)
	}
	return out, nil
}

// encodeMap (strictCbor.ts encodeMap): depth first, then every key, then the entries sorted by
// encoded key bytes (equals DAG-CBOR length-first order).
func encodeMap(m CborMap, depth int) ([]byte, error) {
	if depth > StrictCborMaxDepth {
		return nil, tooDeep(StrictCborMaxDepth)
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

// EncodeStrictCbor ports encodeStrictCbor (strictCbor.ts): a map, keys sorted by encoded bytes
// (length-first). There is no size limit.
func EncodeStrictCbor(m CborMap) ([]byte, error) {
	if m == nil {
		return nil, cborFail("top level must be a map")
	}
	return encodeMap(m, 1)
}

// EncodeStrictCborValue encodes any single value of the encodable set (see CborMap) at the top
// level, where a map or an array counts as depth 1.
func EncodeStrictCborValue(v any) ([]byte, error) { return encodeValue(v, 0) }

type cborReader struct {
	b        []byte
	pos      int
	maxDepth int
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

// head returns (major, additional info, argument); it refuses indefinite/reserved and non-minimal
// headers before the caller looks at the major type (strictCbor.ts Reader.head). A float's argument
// is its IEEE 754 bits and is not subject to minimality; a one-byte simple value must be 32 or
// more, as smaller ones have a one-byte form.
func (r *cborReader) head() (byte, byte, uint64, error) {
	b, err := r.next()
	if err != nil {
		return 0, 0, 0, err
	}
	major, info := b>>5, b&0x1f
	if info < 24 {
		return major, info, uint64(info), nil
	}
	if info > 27 {
		if info == 31 {
			return 0, 0, 0, cborFail("indefinite length")
		}
		return 0, 0, 0, cborFail("reserved additional info")
	}
	raw, err := r.take(1 << (info - 24))
	if err != nil {
		return 0, 0, 0, err
	}
	var v uint64
	for _, x := range raw {
		v = v<<8 | uint64(x)
	}
	if major == 7 {
		if info == 24 && v < 32 {
			return 0, 0, 0, cborFail("non-minimal header")
		}
		return major, info, v, nil
	}
	if v < cborMinimum[info-24] {
		return 0, 0, 0, cborFail("non-minimal header")
	}
	return major, info, v, nil
}

// count compares with the TOTAL input length, not the remaining bytes (strictCbor.ts
// Reader.count): "length exceeds input" vs "truncated input". A count is never used as an
// allocation hint: each of a chain of nested containers may claim up to the whole input length.
func (r *cborReader) count(v uint64) (int, error) {
	if v > uint64(len(r.b)) {
		return 0, cborFail("length exceeds input")
	}
	return int(v), nil
}

func (r *cborReader) counted(v uint64) ([]byte, error) {
	n, err := r.count(v)
	if err != nil {
		return nil, err
	}
	return r.take(n)
}

// decodeText: strict RFC 3629 UTF-8. utf8.Valid is exactly the TS hand validator's accept set (no
// overlongs, no surrogates, max U+10FFFF; fact base ts-codec §6.4, brute-force verified).
func decodeText(b []byte) (string, error) {
	if !utf8.Valid(b) {
		return "", cborFail("invalid UTF-8")
	}
	return string(b), nil
}

// simpleOrFloat ports decodeSimpleOrFloat (strictCbor.ts).
func simpleOrFloat(info byte, v uint64) (any, error) {
	if info == 27 {
		f := math.Float64frombits(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, cborFail("non-finite float")
		}
		return f, nil
	}
	if info == 25 || info == 26 {
		return nil, cborFail("float must be 64-bit")
	}
	switch v {
	case 20:
		return false, nil
	case 21:
		return true, nil
	case 22:
		return nil, nil
	}
	return nil, cborFail("simple value not allowed")
}

// link ports decodeLink (strictCbor.ts): the tag number first, then the content at the same depth,
// then the CID check.
func (r *cborReader) link(tag uint64, depth int) (any, error) {
	if tag != cidTag {
		return nil, cborFail("only tag 42 is allowed")
	}
	content, err := r.value(depth)
	if err != nil {
		return nil, err
	}
	cid, ok := content.([]byte)
	if !ok || !isCid(cid) {
		return nil, cborFail("invalid CID")
	}
	return CborLink{CID: cid}, nil
}

// value ports decodeValue (strictCbor.ts).
func (r *cborReader) value(depth int) (any, error) {
	major, info, v, err := r.head()
	if err != nil {
		return nil, err
	}
	switch major {
	case 0:
		return v, nil
	case 1:
		n := new(big.Int).SetUint64(v)
		return n.Sub(big.NewInt(-1), n), nil
	case 2:
		raw, err := r.counted(v)
		if err != nil {
			return nil, err
		}
		return append([]byte{}, raw...), nil
	case 3:
		raw, err := r.counted(v)
		if err != nil {
			return nil, err
		}
		return decodeText(raw)
	case 4:
		n, err := r.count(v)
		if err != nil {
			return nil, err
		}
		return r.arrayBody(n, depth+1)
	case 5:
		n, err := r.count(v)
		if err != nil {
			return nil, err
		}
		return r.mapBody(n, depth+1)
	case 6:
		return r.link(v, depth)
	default:
		return simpleOrFloat(info, v)
	}
}

// arrayBody ports decodeArrayBody (strictCbor.ts): depth, then each item.
func (r *cborReader) arrayBody(count, depth int) ([]any, error) {
	if depth > r.maxDepth {
		return nil, tooDeep(r.maxDepth)
	}
	out := []any{}
	for i := 0; i < count; i++ {
		item, err := r.value(depth)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

// mapBody ports decodeMapBody (strictCbor.ts): depth, then per entry key header, text key, UTF-8,
// strict key order, value.
func (r *cborReader) mapBody(count, depth int) (CborMap, error) {
	if depth > r.maxDepth {
		return nil, tooDeep(r.maxDepth)
	}
	out := CborMap{}
	var previous []byte
	for i := 0; i < count; i++ {
		start := r.pos
		major, _, n, err := r.head()
		if err != nil {
			return nil, err
		}
		if major != 3 {
			return nil, cborFail("map key must be text")
		}
		raw, err := r.counted(n)
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

// DecodeStrictCbor ports decodeStrictCbor (strictCbor.ts), check order: top header, top major
// type, map body, trailing bytes. Canonical form is enforced inline; there is no re-encode guard and
// no size limit. The depth bound is StrictCborMaxDepth.
func DecodeStrictCbor(input []byte) (CborMap, error) {
	return DecodeStrictCborLimit(input, StrictCborMaxDepth)
}

// DecodeStrictCborLimit is DecodeStrictCbor with the caller's container depth bound (the top map
// is depth 1, each nested array or map adds 1); the refusal is "nesting deeper than <maxDepth>".
func DecodeStrictCborLimit(input []byte, maxDepth int) (CborMap, error) {
	r := &cborReader{b: input, maxDepth: maxDepth}
	major, _, v, err := r.head()
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
	return m, nil
}

// TryDecodeStrictCbor returns false only for a *StrictCborError (the only error DecodeStrictCbor
// returns).
func TryDecodeStrictCbor(input []byte) (CborMap, bool) {
	m, err := DecodeStrictCbor(input)
	if err != nil {
		return nil, false
	}
	return m, true
}

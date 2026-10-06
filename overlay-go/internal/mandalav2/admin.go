package mandalav2

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/bsv-blockchain/go-sdk/script"
)

type AdminDecoded struct {
	PubKeyHash [20]byte
	PublicData map[string]any
}

func DecodeAdmin(s *script.Script) (*AdminDecoded, error) {
	chunks, err := s.Chunks()
	if err != nil {
		return nil, err
	}
	d := &AdminDecoded{}
	p2pkh := chunks
	if len(chunks) == 7 { // publicData variant: <push json> OP_DROP <p2pkh...>
		if chunks[1].Op != script.OpDROP || len(chunks[0].Data) == 0 {
			return nil, fmt.Errorf("not a mandala admin output")
		}
		var pd map[string]any
		if err := json.Unmarshal(chunks[0].Data, &pd); err != nil {
			return nil, fmt.Errorf("admin publicData: %w", err)
		}
		d.PublicData = pd
		p2pkh = chunks[2:]
	} else if len(chunks) != 5 {
		return nil, fmt.Errorf("not a mandala admin output: %d chunks", len(chunks))
	}
	if p2pkh[0].Op != script.OpDUP || p2pkh[1].Op != script.OpHASH160 ||
		p2pkh[3].Op != script.OpEQUALVERIFY || p2pkh[4].Op != script.OpCHECKSIG ||
		len(p2pkh[2].Data) != 20 {
		return nil, fmt.Errorf("not a mandala admin output: p2pkh shape")
	}
	copy(d.PubKeyHash[:], p2pkh[2].Data)
	return d, nil
}

// LockAdmin builds a MandalaAdmin locking script (Appendix A §1.4): a plain
// 5-chunk P2PKH when publicData is nil, or the 7-chunk publicData-prefixed
// form (minimal push of JSON.stringify(publicData), OP_DROP, then P2PKH)
// otherwise. Round-trips through DecodeAdmin.
func LockAdmin(pubKeyHash []byte, publicData map[string]any) (*script.Script, error) {
	if len(pubKeyHash) != 20 {
		return nil, fmt.Errorf("pubKeyHash must be 20 bytes")
	}
	s := &script.Script{}
	if publicData != nil {
		data, err := json.Marshal(publicData)
		if err != nil {
			return nil, fmt.Errorf("lock admin: marshal publicData: %w", err)
		}
		if err := s.AppendPushData(data); err != nil {
			return nil, fmt.Errorf("lock admin: append publicData: %w", err)
		}
		if err := s.AppendOpcodes(script.OpDROP); err != nil {
			return nil, fmt.Errorf("lock admin: append OP_DROP: %w", err)
		}
	}
	if err := s.AppendOpcodes(script.OpDUP, script.OpHASH160); err != nil {
		return nil, fmt.Errorf("lock admin: append DUP/HASH160: %w", err)
	}
	if err := s.AppendPushData(pubKeyHash); err != nil {
		return nil, fmt.Errorf("lock admin: append pubKeyHash: %w", err)
	}
	if err := s.AppendOpcodes(script.OpEQUALVERIFY, script.OpCHECKSIG); err != nil {
		return nil, fmt.Errorf("lock admin: append EQUALVERIFY/CHECKSIG: %w", err)
	}
	return s, nil
}

// encodeJSONString replicates JS `JSON.stringify` string-escaping semantics
// EXACTLY (this differs from Go's encoding/json, which HTML-escapes `<` `>`
// `&` and U+2028/U+2029 even with SetEscapeHTML(false)). Only `"`, `\`, and
// control characters below 0x20 are escaped; every other rune — including
// `<` `>` `&`, non-ASCII letters, line/paragraph separators, and emoji —
// passes through as raw UTF-8, matching JS.
func encodeJSONString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// encodeJSONNumber replicates JS `Number.prototype.toString()` as used by
// `JSON.stringify` for a float64. Go's strconv 'g'/'f' formatting diverges
// from JS in the exponential-notation threshold and exponent rendering, so
// this reimplements the JS rules directly.
func encodeJSONNumber(x float64) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		// JSON.stringify(NaN) === JSON.stringify(Infinity) === "null"
		return "null"
	}
	if x == 0 {
		// JSON.stringify(-0) === "0"
		return "0"
	}
	abs := math.Abs(x)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	// Outside JS's decimal-notation range: format like JS's exponential form,
	// e.g. Go "5e-07" -> JS "5e-7", Go "1e+21" -> JS "1e+21".
	s := strconv.FormatFloat(x, 'e', -1, 64)
	idx := strings.IndexByte(s, 'e')
	mantissa, expPart := s[:idx], s[idx+1:]
	sign, digits := expPart[:1], strings.TrimLeft(expPart[1:], "0")
	if digits == "" {
		digits = "0"
	}
	return mantissa + "e" + sign + digits
}

// canonicalize matches the TS commitment() canonical form: objects get
// byte-sorted keys, arrays keep order, primitives use JS JSON.stringify
// formatting (Appendix A §1.4).
func canonicalize(v any, b *strings.Builder) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		b.WriteString(encodeJSONString(x))
	case float64:
		b.WriteString(encodeJSONNumber(x))
	case json.Number:
		b.WriteString(x.String())
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := canonicalize(e, b); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(encodeJSONString(k))
			b.WriteByte(':')
			if err := canonicalize(x[k], b); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("commitment: unsupported type %T", v)
	}
	return nil
}

func Commitment(details map[string]any) (string, error) {
	var b strings.Builder
	if err := canonicalize(details, &b); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:]), nil
}

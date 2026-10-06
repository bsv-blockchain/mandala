package wiring

import (
	"reflect"
	"strings"
	"testing"
)

// Two real secp256k1 points: G and 2G, compressed lowercase.
const (
	keyG  = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
	key2G = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
)

// jsTrimSet is every BMP code point JS String.prototype.trim strips, probed on Node v24.15.0
// (String.fromCharCode(c).trim() === "" for c in 0..0xffff, surrogates skipped).
const jsTrimSet = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
	"\u2028\u2029\u202f\u205f\u3000\ufeff"

// TestParseIssuerKeys pins every TS parseIssuerKeys string (overlay/src/bootConfig.ts:30-46, F/p2-parity §6) and the
// check order: shape (upper case allowed) -> lowercase -> on-curve -> duplicate.
func TestParseIssuerKeys(t *testing.T) {
	const (
		required = "MANDALA_ISSUER_KEYS is required (JSON array of compressed identity public keys)"
		notArray = "MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys"
		empty    = "MANDALA_ISSUER_KEYS must name at least one issuer key"
	)
	notOnCurve := "02" + strings.Repeat("00", 32) // x = 0: y^2 = 7 has no root mod p
	cases := []struct {
		name string
		raw  string
		want []string
		err  string
	}{
		{"unset", "", nil, required},
		{"blank", " \t\n ", nil, required},
		{"not json", "nope", nil, notArray},
		{"json object", `{"a":"` + keyG + `"}`, nil, notArray},
		{"json null", "null", nil, notArray},
		{"json string", `"` + keyG + `"`, nil, notArray},
		{"empty array", "[]", nil, empty},
		{"number element", `[1]`, nil, "MANDALA_ISSUER_KEYS[0] is not a compressed public key (02/03 + 64 hex)"},
		{"uncompressed prefix", `["04` + keyG[2:] + `"]`, nil, "MANDALA_ISSUER_KEYS[0] is not a compressed public key (02/03 + 64 hex)"},
		{"too short", `["02abc"]`, nil, "MANDALA_ISSUER_KEYS[0] is not a compressed public key (02/03 + 64 hex)"},
		{"second element upper case", `["` + keyG + `","` + strings.ToUpper(key2G) + `"]`, nil, "MANDALA_ISSUER_KEYS[1] must be lowercase hex"},
		{"not on the curve", `["` + notOnCurve + `"]`, nil, "MANDALA_ISSUER_KEYS[0] is not a valid public key"},
		{"duplicate", `["` + keyG + `","` + key2G + `","` + keyG + `"]`, nil, "MANDALA_ISSUER_KEYS[2] is a duplicate"},
		{"valid keeps input order", `["` + key2G + `","` + keyG + `"]`, []string{key2G, keyG}, ""},
		{"surrounding whitespace", "  [\"" + keyG + "\"]  ", []string{keyG}, ""},
		// JSON.parse reads 1e400 as Infinity, a non-string element, not a parse failure.
		{"number overflowing to Infinity", `[1e400]`, nil, "MANDALA_ISSUER_KEYS[0] is not a compressed public key (02/03 + 64 hex)"},
		// JS trim() strips U+FEFF (strings.TrimSpace keeps it) and keeps U+0085 NEL (strings.TrimSpace strips it).
		{"only a byte order mark", "\ufeff", nil, required},
		{"only NEL", "\u0085", nil, notArray},
		{"every JS trim code point", jsTrimSet, nil, required},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseIssuerKeys(tc.raw)
			if tc.err != "" {
				if err == nil || err.Error() != tc.err {
					t.Fatalf("err = %v, want %q", err, tc.err)
				}
				if got != nil {
					t.Fatalf("keys = %v, want nil on error", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("keys = %v, want %v", got, tc.want)
			}
		})
	}
}

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

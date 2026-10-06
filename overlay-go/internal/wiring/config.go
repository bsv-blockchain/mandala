package wiring

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
)

// issuerKeyShape is TS parseIssuerKeys's shape test (/^0[23][0-9a-fA-F]{64}$/). Upper case passes it and is refused
// by the separate lowercase check, so the two TS errors stay distinct.
var issuerKeyShape = regexp.MustCompile(`^0[23][0-9a-fA-F]{64}$`)

// isJSTrimSpace is the set JS String.prototype.trim strips (ECMAScript WhiteSpace and LineTerminator: TAB, LF, VT, FF,
// CR, SP, NBSP, U+1680, U+2000-U+200A, LS, PS, U+202F, U+205F, U+3000, ZWNBSP), probed on Node v24.15.0.
// strings.TrimSpace differs on two code points: it keeps U+FEFF and strips U+0085 (NEL), which JS keeps.
func isJSTrimSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// ParseIssuerKeys ports TS parseIssuerKeys (overlay/src/bootConfig.ts:30-46): MANDALA_ISSUER_KEYS is the trusted-issuer
// set, a JSON array of compressed identity keys in canonical lowercase hex. The checks run in the TS order with
// byte-identical errors, and the keys come back in input order. The managers re-check the set at construction; failing
// here names the env var instead.
func ParseIssuerKeys(raw string) ([]string, error) {
	if strings.TrimFunc(raw, isJSTrimSpace) == "" {
		return nil, errors.New("MANDALA_ISSUER_KEYS is required (JSON array of compressed identity public keys)")
	}
	// Elements are decoded one by one so a number that is no float64 (1e400, which JSON.parse reads as Infinity) is a
	// non-string element, as in TS, not an unparseable array. JSON null decodes to a nil slice: not an array.
	var list []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &list); err != nil || list == nil {
		return nil, errors.New("MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys")
	}
	if len(list) == 0 {
		return nil, errors.New("MANDALA_ISSUER_KEYS must name at least one issuer key")
	}
	seen := make(map[string]bool, len(list))
	keys := make([]string, 0, len(list))
	for i, elem := range list {
		var k string
		if err := json.Unmarshal(elem, &k); err != nil || !issuerKeyShape.MatchString(k) {
			return nil, fmt.Errorf("MANDALA_ISSUER_KEYS[%d] is not a compressed public key (02/03 + 64 hex)", i)
		}
		if k != strings.ToLower(k) {
			return nil, fmt.Errorf("MANDALA_ISSUER_KEYS[%d] must be lowercase hex", i)
		}
		if _, err := ec.PublicKeyFromString(k); err != nil {
			return nil, fmt.Errorf("MANDALA_ISSUER_KEYS[%d] is not a valid public key", i)
		}
		if seen[k] {
			return nil, fmt.Errorf("MANDALA_ISSUER_KEYS[%d] is a duplicate", i)
		}
		seen[k] = true
		keys = append(keys, k)
	}
	return keys, nil
}

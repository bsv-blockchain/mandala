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

// ParseIssuerKeys ports TS parseIssuerKeys (overlay/src/bootConfig.ts:30-46): MANDALA_ISSUER_KEYS is the trusted-issuer
// set, a JSON array of compressed identity keys in canonical lowercase hex. The checks run in the TS order with
// byte-identical errors, and the keys come back in input order. The managers re-check the set at construction; failing
// here names the env var instead.
func ParseIssuerKeys(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, errors.New("MANDALA_ISSUER_KEYS is required (JSON array of compressed identity public keys)")
	}
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, errors.New("MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys")
	}
	list, ok := parsed.([]any)
	if !ok {
		return nil, errors.New("MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys")
	}
	if len(list) == 0 {
		return nil, errors.New("MANDALA_ISSUER_KEYS must name at least one issuer key")
	}
	seen := make(map[string]bool, len(list))
	keys := make([]string, 0, len(list))
	for i, v := range list {
		k, isString := v.(string)
		if !isString || !issuerKeyShape.MatchString(k) {
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

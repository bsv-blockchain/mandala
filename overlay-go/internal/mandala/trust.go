package mandala

import "fmt"

// TrustedSet ports TS trustedSet (F/ts-layers §0, Q2/mandala/MandalaTopicManager.ts:68-85): the
// configured trusted issuers, each a canonical compressed lowercase key, listed once. A bad list is
// a configuration fault, so a plain error at construction, never a per-transaction refusal. owner
// names the Go manager type in the message.
func TrustedSet(keys []string, owner string) (map[string]bool, error) {
	if len(keys) == 0 {
		return nil, fmt.Errorf("%s: trustedIssuers must be a non-empty array", owner)
	}
	trusted := make(map[string]bool, len(keys))
	for _, key := range keys {
		if !IsCanonicalKey(key) {
			return nil, fmt.Errorf("%s: trusted issuer %s is not a compressed lowercase public key", owner, key)
		}
		if trusted[key] {
			return nil, fmt.Errorf("%s: trusted issuer %s is listed more than once", owner, key)
		}
		trusted[key] = true
	}
	return trusted, nil
}

// ExemptKeys ports TS exemptKeys (Q2/mandala/MandalaTopicManager.ts:92-103): the configured
// membership-exempt keys (the overlay identity in production), held to the trusted issuers'
// spelling. nil is no exemption. The result is a copy.
func ExemptKeys(keys []string, owner string) ([]string, error) {
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if !IsCanonicalKey(key) {
			return nil, fmt.Errorf("%s: membership-exempt key %s is not a compressed lowercase public key", owner, key)
		}
		out = append(out, key)
	}
	return out, nil
}

// managerExemptSet is trusted ∪ exempt: the keys layer D exempts from access mode and membership.
func managerExemptSet(trusted map[string]bool, exempt []string) map[string]bool {
	set := make(map[string]bool, len(trusted)+len(exempt))
	for key := range trusted {
		set[key] = true
	}
	for _, key := range exempt {
		set[key] = true
	}
	return set
}

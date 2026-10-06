package mandala

import (
	"errors"
	"regexp"
	"slices"
)

// Topic and lookup names (token-topics design §3; Q2/mandala/topics.ts:4-7).
const (
	MandalaTopic  = "tm_mandala"     // token registry: deploys only
	MandalaLookup = "ls_mandala"     // token registry lookup
	KYCTopic      = "tm_mandala_kyc" // identity registry
	KYCLookup     = "ls_mandala_kyc" // identity registry lookup
)

// Go's $ matches only at the end of the text (RE2 without the m flag), like
// JS $ without /m, so "tm_<hex>\n" is not a token topic on either engine.
var (
	tokenIDPattern    = regexp.MustCompile(`^([0-9a-f]{64})_0$`)
	tokenTopicPattern = regexp.MustCompile(`^tm_([0-9a-f]{64})$`)
	txidPattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// IsTokenID reports whether s is a canonical Mandala token id: ^[0-9a-f]{64}_0$.
func IsTokenID(s string) bool { return tokenIDPattern.MatchString(s) }

func txidOfTokenID(tokenID string) (string, error) {
	m := tokenIDPattern.FindStringSubmatch(tokenID)
	if m == nil {
		return "", errors.New("not a canonical Mandala token id: " + tokenID)
	}
	return m[1], nil
}

// TokenTopic maps "<hex>_0" to "tm_<hex>"; any other id is refused with
// "not a canonical Mandala token id: <tokenID>".
func TokenTopic(tokenID string) (string, error) {
	hex, err := txidOfTokenID(tokenID)
	if err != nil {
		return "", err
	}
	return "tm_" + hex, nil
}

// TokenLookup maps "<hex>_0" to "ls_<hex>", with TokenTopic's error.
func TokenLookup(tokenID string) (string, error) {
	hex, err := txidOfTokenID(tokenID)
	if err != nil {
		return "", err
	}
	return "ls_" + hex, nil
}

// IsTokenTopic reports whether name is ^tm_[0-9a-f]{64}$.
func IsTokenTopic(name string) bool { return tokenTopicPattern.MatchString(name) }

// TokenIDOfTopic maps "tm_<hex>" to "<hex>_0", true; any other name gives "", false.
func TokenIDOfTopic(name string) (string, bool) {
	m := tokenTopicPattern.FindStringSubmatch(name)
	if m == nil {
		return "", false
	}
	return m[1] + "_0", true
}

// IsSigmaTopic reports whether a STEAK entry for name carries σI (A1.2):
// tm_mandala and every token topic, never tm_mandala_kyc.
func IsSigmaTopic(name string) bool { return name == MandalaTopic || IsTokenTopic(name) }

// DeployTokenOf reports the deploy hook's token: ok iff txid is 64 lowercase hex and topics contain
// both MandalaTopic and "tm_"+txid; tokenID = txid + "_0".
func DeployTokenOf(topics []string, txid string) (tokenID string, ok bool) {
	if !txidPattern.MatchString(txid) {
		return "", false
	}
	if !slices.Contains(topics, MandalaTopic) || !slices.Contains(topics, "tm_"+txid) {
		return "", false
	}
	return txid + "_0", true
}

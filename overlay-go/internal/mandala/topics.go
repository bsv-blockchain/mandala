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

// Per-asset topic and lookup prefixes (contract §0; 0207:700-705): tm_color_<assetId> / ls_color_<assetId>.
const (
	colorTopicPrefix  = "tm_color_"
	colorLookupPrefix = "ls_color_"
)

// Go's $ matches only at the end of the text (RE2 without the m flag), like
// JS $ without /m, so "tm_color_<hex>_0\n" is not a color topic on either engine.
var (
	tokenIDPattern    = regexp.MustCompile(`^([0-9a-f]{64})_0$`)
	colorTopicPattern = regexp.MustCompile(`^tm_color_([0-9a-f]{64})_0$`)
	txidPattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// IsTokenID reports whether s is a canonical Mandala token id: ^[0-9a-f]{64}_0$.
func IsTokenID(s string) bool { return tokenIDPattern.MatchString(s) }

func checkTokenID(tokenID string) error {
	if !tokenIDPattern.MatchString(tokenID) {
		return errors.New("not a canonical Mandala token id: " + tokenID)
	}
	return nil
}

// TokenTopic maps "<hex>_0" to "tm_color_<hex>_0"; any other id is refused with
// "not a canonical Mandala token id: <tokenID>".
func TokenTopic(tokenID string) (string, error) {
	if err := checkTokenID(tokenID); err != nil {
		return "", err
	}
	return colorTopicPrefix + tokenID, nil
}

// TokenLookup maps "<hex>_0" to "ls_color_<hex>_0", with TokenTopic's error.
func TokenLookup(tokenID string) (string, error) {
	if err := checkTokenID(tokenID); err != nil {
		return "", err
	}
	return colorLookupPrefix + tokenID, nil
}

// TokenTopicOfTxid maps a deploy txid to its asset topic "tm_color_<txid>_0"; it is "" unless txid is
// 64 lowercase hex.
func TokenTopicOfTxid(txid string) string {
	if !txidPattern.MatchString(txid) {
		return ""
	}
	return colorTopicPrefix + txid + "_0"
}

// IsColorTopic reports whether name is a Mandala per-asset topic: ^tm_color_([0-9a-f]{64})_0$.
func IsColorTopic(name string) bool { return colorTopicPattern.MatchString(name) }

// IsTokenTopic is IsColorTopic (contract §3/§6 keep both names).
func IsTokenTopic(name string) bool { return IsColorTopic(name) }

// TokenIDOfTopic maps "tm_color_<hex>_0" to "<hex>_0", true; any other name gives "", false.
func TokenIDOfTopic(name string) (string, bool) {
	m := colorTopicPattern.FindStringSubmatch(name)
	if m == nil {
		return "", false
	}
	return m[1] + "_0", true
}

// AdmissionScheme is the admission signature a STEAK entry for a topic carries (contract §3, D16).
type AdmissionScheme int

const (
	// SchemeNone: no admission signature (tm_mandala_kyc and anything unknown).
	SchemeNone AdmissionScheme = iota
	// SchemeAttestedV1: BRC-207 attested admission signature (tm_color_<assetId>).
	SchemeAttestedV1
	// SchemeMandalaV3: σI v3 with the bare overlay key (tm_mandala).
	SchemeMandalaV3
)

// AdmissionSchemeOf picks the admission scheme by topic: a color topic is attested v1, tm_mandala is
// σI v3, everything else (tm_mandala_kyc included) is unsigned.
func AdmissionSchemeOf(topic string) AdmissionScheme {
	switch {
	case IsColorTopic(topic):
		return SchemeAttestedV1
	case topic == MandalaTopic:
		return SchemeMandalaV3
	default:
		return SchemeNone
	}
}

// DeployTokenOf reports the deploy hook's token: ok iff txid is 64 lowercase hex and topics contain
// both MandalaTopic and TokenTopicOfTxid(txid); tokenID = txid + "_0".
func DeployTokenOf(topics []string, txid string) (tokenID string, ok bool) {
	own := TokenTopicOfTxid(txid)
	if own == "" {
		return "", false
	}
	if !slices.Contains(topics, MandalaTopic) || !slices.Contains(topics, own) {
		return "", false
	}
	return txid + "_0", true
}

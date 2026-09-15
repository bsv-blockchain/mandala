package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
)

// admissionDigestPrefix is the σ_I message prefix, shared with the TS engine.
const admissionDigestPrefix = "mandala-admit:"

// ErrNoAdmittedOutputs is returned instead of a digest/signature when the
// admitted output set is empty. Wire contract §1: the set is "never empty —
// no admitted outputs ⇒ no signature", and a registry-only admission never
// yields a token σ_I.
var ErrNoAdmittedOutputs = errors.New("admission: no admitted outputs to sign over")

// AdmissionDigestV2 is the σ_I message of wire contract §1, byte-identical on
// both engines:
//
//	SHA-256("mandala-admit:" + txid + ":" + outputsToAdmit.sort(asc).join(","))
//
// txid is 64 lowercase hex; the output indexes are the tm_mandala topic's own
// admitted set, rendered as ascending decimal and comma-joined ("0", "0,2,3").
// The set is CANONICALISED first — sorted ascending and de-duplicated — so
// neither the caller's ordering nor a repeated index can change the digest.
// De-duplication matters for parity, not for the engine: the engine never
// emits a duplicate index, but lib's verifier (canonicalOutputs) and the TS
// signer (outputSetString) both collapse them, so a verifier handed
// "[2,0,2]" by some other producer must compute the same digest the signer
// did.
//
// The v1 message (SHA-256("mandala-admit:"+txid), no output set) is gone: it
// bound a signature to a transaction id rather than to the set of outputs the
// overlay actually admitted, which is exactly what let an un-admitted token
// output ride along under a valid σ_I (FIX A). There is no live token traffic
// to migrate, so there is no v1 fallback anywhere.
func AdmissionDigestV2(txid string, outputsToAdmit []uint32) ([32]byte, error) {
	canonical := canonicalOutputs(outputsToAdmit)
	if len(canonical) == 0 {
		return [32]byte{}, ErrNoAdmittedOutputs
	}
	parts := make([]string, len(canonical))
	for i, v := range canonical {
		parts[i] = strconv.FormatUint(uint64(v), 10)
	}
	return sha256.Sum256([]byte(admissionDigestPrefix + txid + ":" + strings.Join(parts, ","))), nil
}

// canonicalOutputs is the one canonical form of an admitted output set —
// ascending, no duplicates — shared by the digest, the wire `outputsToAdmit`
// the dupe path and GET /admin/admission serve, and the record they are
// persisted in, so the set a verifier reads is always exactly the set that
// was signed. Mirrors lib's canonicalOutputs and TS's outputSetString.
func canonicalOutputs(outputs []uint32) []uint32 {
	if len(outputs) == 0 {
		return nil
	}
	sorted := slices.Clone(outputs)
	slices.Sort(sorted)
	return slices.Compact(sorted)
}

// AdmissionSigner produces σ_I over an admitted (txid, outputsToAdmit) pair.
// Optional: submit still succeeds if signing fails; the STEAK just omits the
// fields.
type AdmissionSigner interface {
	SignAdmission(txid string, outputsToAdmit []uint32) (sigDERHex, identityKeyHex string, err error)
}

// ECAdmissionSigner signs AdmissionDigestV2 with the overlay identity key
// (the same secp256k1 key the node was booted with). Signing is RFC6979
// deterministic, so re-signing the same admission on the idempotent dupe path
// reproduces byte-identical σ_I.
type ECAdmissionSigner struct {
	priv *ec.PrivateKey
}

// NewECAdmissionSigner parses a hex-encoded overlay private key.
func NewECAdmissionSigner(privHex string) (*ECAdmissionSigner, error) {
	priv, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		return nil, fmt.Errorf("admission signer: %w", err)
	}
	return &ECAdmissionSigner{priv: priv}, nil
}

// SignAdmission returns DER-hex of the overlay signature over
// AdmissionDigestV2(txid, outputsToAdmit) and the compressed identity public
// key. An empty output set is refused (ErrNoAdmittedOutputs).
func (s *ECAdmissionSigner) SignAdmission(txid string, outputsToAdmit []uint32) (string, string, error) {
	if s == nil || s.priv == nil {
		return "", "", fmt.Errorf("admission signer: nil")
	}
	msg, err := AdmissionDigestV2(txid, outputsToAdmit)
	if err != nil {
		return "", "", err
	}
	sig, err := s.priv.Sign(msg[:])
	if err != nil {
		return "", "", err
	}
	der, err := sig.ToDER()
	if err != nil {
		return "", "", err
	}
	return hex.EncodeToString(der), hex.EncodeToString(s.priv.PubKey().Compressed()), nil
}

package mandala

import (
	"errors"
	"fmt"
	"math/big"
)

// Code is a Mandala verdict code (design §6.3; TS MandalaRejectCode).
type Code string

const (
	CodeShape        Code = "ERR_SHAPE"
	CodeSatoshis     Code = "ERR_SATOSHIS"
	CodeLinkage      Code = "ERR_LINKAGE"
	CodeConservation Code = "ERR_CONSERVATION"
	CodeAuthority    Code = "ERR_AUTHORITY"
	CodeUntrusted    Code = "ERR_UNTRUSTED"
	CodePaused       Code = "ERR_PAUSED"
	CodeFrozen       Code = "ERR_FROZEN"
	CodeAccess       Code = "ERR_ACCESS"
	CodeSanctioned   Code = "ERR_SANCTIONED"
	CodeMembership   Code = "ERR_MEMBERSHIP"
	CodeUnavailable  Code = "ERR_UNAVAILABLE"
	CodeInputSpent   Code = "ERR_INPUT_SPENT" // Go-only: the token manager's conflicting-spend guard
)

// RejectError is every Mandala manager refusal. Code "" = untyped (a plain manager fault, e.g. txid not in BEEF).
type RejectError struct {
	Code      Code
	Reason    string // byte-exact catalogue text
	Topic     string // the refusing topic, stamped by WithTopic
	SpendTxid string // ERR_INPUT_SPENT only
	Cause     error  // the dependency fault behind an ERR_UNAVAILABLE, else nil
}

func (e *RejectError) Error() string { return e.Reason }

func (e *RejectError) Unwrap() error { return e.Cause }

// WithTopic: nil -> nil; a *RejectError (errors.As) -> a copy with Topic = topic; any other error ->
// &RejectError{Code: "", Reason: err.Error(), Topic: topic, Cause: err}.
func WithTopic(err error, topic string) error {
	if err == nil {
		return nil
	}
	var re *RejectError
	if errors.As(err, &re) {
		stamped := *re
		stamped.Topic = topic
		return &stamped
	}
	return &RejectError{Reason: err.Error(), Topic: topic, Cause: err}
}

const kycRegistryLabel = "tm_mandala_registry" // the KYC reasons keep the 2.0.0 label (final at Q2 37468f290)

func newReject(code Code, format string, args ...any) *RejectError {
	return &RejectError{Code: code, Reason: fmt.Sprintf(format, args...)}
}

// The catalogue: one constructor per TS Reasons key (ts-stack 37468f290
// packages/overlays/topics/src/mandala/reject.ts:83-148; fact base ts-layers §8),
// plus the Go-only rInputSpent. Every Reason is a cross-engine contract: never
// reword. *big.Int amounts print via String(), so a negative delta prints "-40".

func rInvalidTokenOutput(i uint32, detail string) *RejectError {
	return newReject(CodeShape, "output %d: token-shaped output is not a valid BRC-162 token output (%s)", i, detail)
}

func rNonP2pkhRemainder(i uint32) *RejectError {
	return newReject(CodeShape, "output %d: token output remainder must be a P2PKH lock", i)
}

func rOneSat(i uint32) *RejectError {
	return newReject(CodeSatoshis, "output %d: token output must carry exactly 1 satoshi", i)
}

func rAmountCap(i uint32) *RejectError {
	return newReject(CodeShape, "output %d: token amount exceeds 2^53-1", i)
}

func rSumCap(tokenID string) *RejectError {
	return newReject(CodeShape, "token %s: value sum exceeds 2^53-1", tokenID)
}

func rSupplyCap(tokenID string) *RejectError {
	return newReject(CodeShape, "token %s: circulating supply would exceed 2^53-1", tokenID)
}

func rNoLinkage(i uint32) *RejectError {
	return newReject(CodeLinkage, "output %d: token output with no verified linkage", i)
}

func rInputLinkageControl(i uint32) *RejectError {
	return newReject(CodeLinkage, "input %d: linkage does not control the coin being spent", i)
}

func rInputLinkageOwner(i uint32, named, owner string) *RejectError {
	return newReject(CodeLinkage, "input %d: linkage names %s but the coin is owned by %s", i, named, owner)
}

func rOwnerIndexUnavailable(outpoint string) *RejectError {
	return newReject(CodeUnavailable, "owner index unavailable for %s", outpoint)
}

func rStoreUnavailable(what string, cause error) *RejectError {
	e := newReject(CodeUnavailable, "%s could not be read; retry", what)
	e.Cause = cause
	return e
}

func rStoreWriteUnavailable(what string, cause error) *RejectError {
	e := newReject(CodeUnavailable, "%s could not be written; retry", what)
	e.Cause = cause
	return e
}

func rUntrustedOwner(i uint32, key string) *RejectError {
	return newReject(CodeUntrusted, "output %d: owner %s is not a trusted issuer", i, key)
}

func rUntrustedProver(i uint32, key string) *RejectError {
	return newReject(CodeUntrusted, "output %d: linkage prover %s is not a trusted issuer", i, key)
}

func rUntrustedAuthorityInput(i uint32, key string) *RejectError {
	return newReject(CodeUntrusted, "input %d: authority owner %s is not a trusted issuer", i, key)
}

func rFixedSupply() *RejectError {
	return newReject(CodeAuthority, "output 0: fixed-supply deploys are not allowed")
}

func rDeploySig() *RejectError {
	return newReject(CodeAuthority, "output 0: deploy requires a valid deploySig over this txid")
}

func rDeployNotAtZero(i uint32) *RejectError {
	return newReject(CodeShape, "output %d: a deploy must be output 0", i)
}

func rAuthorityWithoutInput(i uint32, tokenID string) *RejectError {
	return newReject(CodeAuthority, "output %d: authority output without an admitted authority input of token %s", i, tokenID)
}

func rContinuity(tokenID string) *RejectError {
	return newReject(CodeAuthority, "token %s: spends an authority but creates none", tokenID)
}

func rTwoCommitments(tokenID string) *RejectError {
	return newReject(CodeAuthority, "token %s: more than one authority output carries an action commitment", tokenID)
}

func rCommitmentMismatch(i uint32) *RejectError {
	return newReject(CodeAuthority, "output %d: admin details do not match the payload commitment", i)
}

func rMissingDetails(i uint32) *RejectError {
	return newReject(CodeShape, "output %d: committed authority output has no admin details", i)
}

// rOrphanDetails takes the envelope index, which may exceed uint32 (up to 2^53-1).
func rOrphanDetails(i uint64) *RejectError {
	return newReject(CodeShape, "admin entry %d does not name a committed authority output", i)
}

func rDetailsSchema(i uint32, detail string) *RejectError {
	return newReject(CodeShape, "output %d: admin details violate the schema (%s)", i, detail)
}

func rDeployPayload(detail string) *RejectError {
	return newReject(CodeShape, "output 0: deploy payload is not a valid Mandala deploy map (%s)", detail)
}

func rEnvelope(detail string) *RejectError {
	return newReject(CodeShape, "Mandala payload %s", detail)
}

func rHolderConservation(tokenID string, vin, vout *big.Int) *RejectError {
	return newReject(CodeConservation, "token %s: value in %s != value out %s without an authority", tokenID, vin.String(), vout.String())
}

func rDeltaRule(tokenID, kind, rule string, delta *big.Int) *RejectError {
	return newReject(CodeConservation, "token %s: %s requires delta %s but delta is %s", tokenID, kind, rule, delta.String())
}

func rReissue(tokenID, detail string) *RejectError {
	return newReject(CodeShape, "token %s: reissue %s", tokenID, detail)
}

func rFrozenInput(i uint32, outpoint string) *RejectError {
	return newReject(CodeFrozen, "input %d: coin %s is frozen", i, outpoint)
}

func rEvictedInput(i uint32, outpoint string) *RejectError {
	return newReject(CodeFrozen, "input %d: coin %s was evicted by a reissue", i, outpoint)
}

func rPaused(tokenID string) *RejectError {
	return newReject(CodePaused, "token %s is paused", tokenID)
}

func rBlocked(tokenID, key string) *RejectError {
	return newReject(CodeAccess, "token %s: %s is blocked (denylist)", tokenID, key)
}

func rNotAllowed(tokenID, key string) *RejectError {
	return newReject(CodeAccess, "token %s: %s is not allowlisted (allowlist)", tokenID, key)
}

func rSanctioned(key string) *RejectError {
	return newReject(CodeSanctioned, "identity %s is sanctioned", key)
}

func rNotMember(key string) *RejectError {
	return newReject(CodeMembership, "identity %s is not an admitted registry member", key)
}

func rRegistryExists() *RejectError {
	return newReject(CodeShape, "%s: registration chain already exists; register is genesis-only", kycRegistryLabel)
}

func rRegistryValue(i uint32) *RejectError {
	return newReject(CodeShape, "output %d: %s does not admit value outputs", i, kycRegistryLabel)
}

// rInputSpent is Go-only (V-4): the TS P2 spentGuard text.
func rInputSpent(outpoint, spendTxid string) *RejectError {
	e := newReject(CodeInputSpent, "input %s: already spent by %s", outpoint, spendTxid)
	e.SpendTxid = spendTxid
	return e
}

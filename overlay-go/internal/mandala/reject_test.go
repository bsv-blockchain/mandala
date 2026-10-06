package mandala

import (
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"
	"testing"
)

func TestRejectCatalogue(t *testing.T) {
	id := strings.Repeat("ab", 32) + "_0"
	op := strings.Repeat("cd", 32) + ".1"
	k := "02" + strings.Repeat("11", 32)
	k2 := "03" + strings.Repeat("22", 32)
	huge, _ := new(big.Int).SetString("36893488147419103230", 10)
	cases := []struct {
		name   string
		err    *RejectError
		code   Code
		reason string
	}{
		{"invalidTokenOutput", rInvalidTokenOutput(2, "truncated push"), CodeShape, "output 2: token-shaped output is not a valid BRC-162 token output (truncated push)"},
		{"nonP2pkhRemainder", rNonP2pkhRemainder(1), CodeShape, "output 1: token output remainder must be a P2PKH lock"},
		{"oneSat", rOneSat(1), CodeSatoshis, "output 1: token output must carry exactly 1 satoshi"},
		{"amountCap", rAmountCap(0), CodeShape, "output 0: token amount exceeds 2^53-1"},
		{"sumCap", rSumCap(id), CodeShape, "token " + id + ": value sum exceeds 2^53-1"},
		{"supplyCap", rSupplyCap(id), CodeShape, "token " + id + ": circulating supply would exceed 2^53-1"},
		{"noLinkage", rNoLinkage(3), CodeLinkage, "output 3: token output with no verified linkage"},
		{"inputLinkageControl", rInputLinkageControl(0), CodeLinkage, "input 0: linkage does not control the coin being spent"},
		{"inputLinkageOwner", rInputLinkageOwner(1, k, k2), CodeLinkage, "input 1: linkage names " + k + " but the coin is owned by " + k2},
		{"ownerIndexUnavailable", rOwnerIndexUnavailable(op), CodeUnavailable, "owner index unavailable for " + op},
		{"storeUnavailable", rStoreUnavailable("the owner index", io.EOF), CodeUnavailable, "the owner index could not be read; retry"},
		{"storeWriteUnavailable", rStoreWriteUnavailable("the owner journal", io.EOF), CodeUnavailable, "the owner journal could not be written; retry"},
		{"untrustedOwner", rUntrustedOwner(0, k), CodeUntrusted, "output 0: owner " + k + " is not a trusted issuer"},
		{"untrustedProver", rUntrustedProver(0, k), CodeUntrusted, "output 0: linkage prover " + k + " is not a trusted issuer"},
		{"untrustedAuthorityInput", rUntrustedAuthorityInput(1, k), CodeUntrusted, "input 1: authority owner " + k + " is not a trusted issuer"},
		{"fixedSupply", rFixedSupply(), CodeAuthority, "output 0: fixed-supply deploys are not allowed"},
		{"deploySig", rDeploySig(), CodeAuthority, "output 0: deploy requires a valid deploySig over this txid"},
		{"deployNotAtZero", rDeployNotAtZero(1), CodeShape, "output 1: a deploy must be output 0"},
		{"authorityWithoutInput", rAuthorityWithoutInput(0, id), CodeAuthority, "output 0: authority output without an admitted authority input of token " + id},
		{"continuity", rContinuity(id), CodeAuthority, "token " + id + ": spends an authority but creates none"},
		{"twoCommitments", rTwoCommitments(id), CodeAuthority, "token " + id + ": more than one authority output carries an action commitment"},
		{"commitmentMismatch", rCommitmentMismatch(0), CodeAuthority, "output 0: admin details do not match the payload commitment"},
		{"missingDetails", rMissingDetails(0), CodeShape, "output 0: committed authority output has no admin details"},
		{"orphanDetails", rOrphanDetails(9007199254740991), CodeShape, "admin entry 9007199254740991 does not name a committed authority output"},
		{"detailsSchema", rDetailsSchema(0, "missing key kind"), CodeShape, "output 0: admin details violate the schema (missing key kind)"},
		{"deployPayload", rDeployPayload("missing payload"), CodeShape, "output 0: deploy payload is not a valid Mandala deploy map (missing payload)"},
		{"envelope", rEnvelope("must be an object"), CodeShape, "Mandala payload must be an object"},
		{"holderConservation", rHolderConservation(id, big.NewInt(100), huge), CodeConservation, "token " + id + ": value in 100 != value out 36893488147419103230 without an authority"},
		{"deltaRule", rDeltaRule(id, "redeem", "< 0", big.NewInt(40)), CodeConservation, "token " + id + ": redeem requires delta < 0 but delta is 40"},
		{"deltaRule negative", rDeltaRule(id, "plain authority", "= 0", big.NewInt(-40)), CodeConservation, "token " + id + ": plain authority requires delta = 0 but delta is -40"},
		{"reissue", rReissue(id, "target is not frozen"), CodeShape, "token " + id + ": reissue target is not frozen"},
		{"frozenInput", rFrozenInput(0, op), CodeFrozen, "input 0: coin " + op + " is frozen"},
		{"evictedInput", rEvictedInput(0, op), CodeFrozen, "input 0: coin " + op + " was evicted by a reissue"},
		{"paused", rPaused(id), CodePaused, "token " + id + " is paused"},
		{"blocked", rBlocked(id, k), CodeAccess, "token " + id + ": " + k + " is blocked (denylist)"},
		{"notAllowed", rNotAllowed(id, k), CodeAccess, "token " + id + ": " + k + " is not allowlisted (allowlist)"},
		{"sanctioned", rSanctioned(k), CodeSanctioned, "identity " + k + " is sanctioned"},
		{"notMember", rNotMember(k), CodeMembership, "identity " + k + " is not an admitted registry member"},
		{"registryExists", rRegistryExists(), CodeShape, "tm_mandala_registry: registration chain already exists; register is genesis-only"},
		{"registryValue", rRegistryValue(1), CodeShape, "output 1: tm_mandala_registry does not admit value outputs"},
		{"inputSpent", rInputSpent(op, strings.Repeat("ef", 32)), CodeInputSpent, "input " + op + ": already spent by " + strings.Repeat("ef", 32)},
	}
	if len(cases) != 41 {
		t.Fatalf("catalogue table has %d rows, want 41 (40 constructors, deltaRule twice)", len(cases))
	}
	for _, c := range cases {
		if c.err.Code != c.code || c.err.Reason != c.reason || c.err.Error() != c.reason || c.err.Topic != "" {
			t.Errorf("%s: %q %q topic %q\nwant %q %q", c.name, c.err.Code, c.err.Reason, c.err.Topic, c.code, c.reason)
		}
	}
	if spent := rInputSpent(op, "ff"); spent.SpendTxid != "ff" {
		t.Errorf("rInputSpent SpendTxid = %q", spent.SpendTxid)
	}
	if rNoLinkage(0).SpendTxid != "" || rNoLinkage(0).Cause != nil {
		t.Error("a non-spend, non-infra refusal carries SpendTxid or Cause")
	}
	if kycRegistryLabel != "tm_mandala_registry" {
		t.Errorf("kycRegistryLabel = %q", kycRegistryLabel)
	}
}

func TestRejectErrorUnwrapsItsCause(t *testing.T) {
	e := rStoreUnavailable("the asset state", io.ErrUnexpectedEOF)
	if !errors.Is(e, io.ErrUnexpectedEOF) || e.Unwrap() != io.ErrUnexpectedEOF {
		t.Fatal("ERR_UNAVAILABLE must unwrap to its cause")
	}
	if rStoreWriteUnavailable("the owner index", io.EOF).Cause != io.EOF {
		t.Fatal("write refusal lost its cause")
	}
}

func TestWithTopic(t *testing.T) {
	if WithTopic(nil, "tm_x") != nil {
		t.Fatal("WithTopic(nil) != nil")
	}
	orig := rNoLinkage(0)
	stamped := WithTopic(orig, "tm_a")
	var re *RejectError
	if !errors.As(stamped, &re) || re.Topic != "tm_a" || re.Code != CodeLinkage || re.Reason != orig.Reason {
		t.Fatalf("stamped = %+v", re)
	}
	if orig.Topic != "" || re == orig {
		t.Fatal("WithTopic must return a copy and leave the original unstamped")
	}
	restamped := WithTopic(stamped, "tm_mandala")
	if !errors.As(restamped, &re) || re.Topic != "tm_mandala" {
		t.Fatalf("restamped = %+v", re)
	}
	wrapped := fmt.Errorf("layer: %w", rSanctioned("02aa"))
	if !errors.As(WithTopic(wrapped, "tm_b"), &re) || re.Code != CodeSanctioned || re.Topic != "tm_b" {
		t.Fatalf("wrapped = %+v", re)
	}
	plain := errors.New("txid not in BEEF")
	got := WithTopic(plain, "tm_c")
	if !errors.As(got, &re) || re.Code != "" || re.Reason != "txid not in BEEF" || re.Topic != "tm_c" || !errors.Is(got, plain) {
		t.Fatalf("plain = %+v", re)
	}
}

package mandala

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"strings"
	"testing"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	mt "github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

var (
	acTokA = strings.Repeat("aa", 32) + "_0"
	acTokB = strings.Repeat("bb", 32) + "_0"
	acTx   = strings.Repeat("cc", 32) // the transaction under test
)

func acTrusted() map[string]bool { return map[string]bool{mt.Issuer.Identity: true} }

func acValue(i uint32, tok string, amount uint64) brc162.Output {
	return brc162.Output{Index: i, Satoshis: 1, Role: brc162.RoleValue, TokenID: tok, Amount: amount, PayloadCanonical: true, RestPubKeyHash: make([]byte, 20)}
}

// acAuthority is an authority output; details != nil commits to them (payload {adm: sha256(details)}).
func acAuthority(i uint32, tok string, details []byte) brc162.Output {
	o := brc162.Output{Index: i, Satoshis: 1, Role: brc162.RoleAuthority, TokenID: tok, PayloadCanonical: true, RestPubKeyHash: make([]byte, 20)}
	if details != nil {
		o.Payload, o.HasPayload = mt.AdmPayload(sha256.Sum256(details)), true
	}
	return o
}

func acIn(i uint32, tok string, amount uint64) brc162.Input {
	role := brc162.RoleValue
	if amount == 0 {
		role = brc162.RoleAuthority
	}
	return brc162.Input{Index: i, Role: role, TokenID: tok, Amount: amount, SourceTxid: strings.Repeat("dd", 32), SourceVout: i, SourceRole: role}
}

// acOwnedBy: every output owned by owner, proved by prover.
func acOwnedBy(outs []brc162.Output, owner, prover string) []VerifiedOwner {
	owners := make([]VerifiedOwner, 0, len(outs))
	for _, o := range outs {
		owners = append(owners, VerifiedOwner{Index: o.Index, TokenID: o.TokenID, Role: o.Role, Amount: o.Amount, IdentityKey: owner, Prover: prover})
	}
	return owners
}

func acEnv(entries ...AdminEntry) *Envelope { return &Envelope{Admin: entries} }

func acDetails(t *testing.T, m brc162.CborMap) []byte {
	t.Helper()
	b, err := brc162.EncodeStrictCbor(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type acCase struct {
	outs        []brc162.Output
	ins         []brc162.Input
	owners      []VerifiedOwner   // nil: every output owned and proved by the issuer
	inputOwners map[uint32]string // nil: every input owned by the issuer
	env         *Envelope
	store       *memStore
	registry    bool
	trusted     map[string]bool
}

func (c acCase) run(t *testing.T) (*AuthorityResult, error) {
	t.Helper()
	if c.owners == nil {
		c.owners = acOwnedBy(c.outs, mt.Issuer.Identity, mt.Issuer.Identity)
	}
	if c.inputOwners == nil {
		c.inputOwners = map[uint32]string{}
		for _, in := range c.ins {
			c.inputOwners[in.Index] = mt.Issuer.Identity
		}
	}
	if c.env == nil {
		c.env = &Envelope{}
	}
	if c.store == nil {
		c.store = newMemStore()
	}
	if c.trusted == nil {
		c.trusted = acTrusted()
	}
	return CheckAuthority(context.Background(), acTx, brc162.BuildLedger(acTx, c.outs, c.ins), c.outs, c.owners, c.inputOwners, c.env,
		AuthorityDeps{Trusted: c.trusted, Store: c.store, Registry: c.registry})
}

// acDeploy runs layer C on a real kit deploy (real deploySig) after editing its spec.
func acDeploy(t *testing.T, b *mt.Built, owners []VerifiedOwner) error {
	t.Helper()
	outs := brc162.ClassifyOutputs(b.Tx).Outputs
	if owners == nil {
		owners = acOwnedBy(outs, mt.Issuer.Identity, mt.Issuer.Identity)
	}
	_, err := CheckAuthority(context.Background(), b.Txid, brc162.BuildLedger(b.Txid, outs, nil), outs, owners, map[uint32]string{}, envOf(t, b.OffChain),
		AuthorityDeps{Trusted: acTrusted(), Store: newMemStore()})
	return err
}

func TestCheckAuthorityStep1Deploys(t *testing.T) {
	issuer := mt.Issuer
	if err := acDeploy(t, mt.Deploy(t, issuer, "USD"), nil); err != nil {
		t.Fatalf("a signed deploy: %v", err)
	}
	payload := mt.DeployPayload("USD", 2, "US Dollar")
	fixed := mt.Build(t, nil, []mt.Out{{Owner: issuer, Prover: issuer, Amount: 5, Payload: payload, HasPayload: true}}, nil) // also unsigned
	requireReject(t, acDeploy(t, fixed, nil), CodeAuthority, "output 0: fixed-supply deploys are not allowed")
	noPayload := mt.Build(t, nil, []mt.Out{{Owner: issuer, Prover: issuer}}, &issuer)
	requireReject(t, acDeploy(t, noPayload, nil), CodeShape, "output 0: deploy payload is not a valid Mandala deploy map (missing payload)")
	unsigned := mt.Build(t, nil, []mt.Out{{Owner: issuer, Prover: issuer, Payload: payload, HasPayload: true}}, nil)
	requireReject(t, acDeploy(t, unsigned, nil), CodeAuthority, "output 0: deploy requires a valid deploySig over this txid")
	rogue := mt.Rogue
	signedByRogue := mt.Build(t, nil, []mt.Out{{Owner: issuer, Prover: issuer, Payload: payload, HasPayload: true}}, &rogue)
	requireReject(t, acDeploy(t, signedByRogue, nil), CodeAuthority, "output 0: deploy requires a valid deploySig over this txid")
	// Step 1 runs before the trust check: a rogue-owned unsigned deploy fails on its signature.
	rogueOwned := mt.Build(t, nil, []mt.Out{{Owner: rogue, Prover: rogue, Payload: payload, HasPayload: true}}, nil)
	requireReject(t, acDeploy(t, rogueOwned, acOwnedBy(brc162.ClassifyOutputs(rogueOwned.Tx).Outputs, rogue.Identity, rogue.Identity)),
		CodeAuthority, "output 0: deploy requires a valid deploySig over this txid")
}

func TestCheckAuthorityStep2TrustIsPerOutputOwnerThenProver(t *testing.T) {
	rogue := mt.Rogue
	signed := mt.Build(t, nil, []mt.Out{{Owner: rogue, Prover: rogue, Payload: mt.DeployPayload("USD", 2, "US Dollar"), HasPayload: true}}, &rogue)
	requireReject(t, acDeploy(t, signed, acOwnedBy(brc162.ClassifyOutputs(signed.Tx).Outputs, rogue.Identity, rogue.Identity)),
		CodeUntrusted, "output 0: owner "+rogue.Identity+" is not a trusted issuer")
	outs := []brc162.Output{acAuthority(0, acTokA, nil), acAuthority(1, acTokA, nil), acValue(2, acTokA, 5)}
	owners := []VerifiedOwner{
		{Index: 0, TokenID: acTokA, Role: brc162.RoleAuthority, IdentityKey: mt.Issuer.Identity, Prover: rogue.Identity},
		{Index: 1, TokenID: acTokA, Role: brc162.RoleAuthority, IdentityKey: rogue.Identity, Prover: mt.Issuer.Identity},
		{Index: 2, TokenID: acTokA, Role: brc162.RoleValue, Amount: 5, IdentityKey: rogue.Identity, Prover: rogue.Identity},
	}
	_, err := acCase{outs: outs, ins: []brc162.Input{acIn(0, acTokA, 0)}, owners: owners}.run(t)
	requireReject(t, err, CodeUntrusted, "output 0: linkage prover "+rogue.Identity+" is not a trusted issuer")
	// Value outputs are never trust-checked; an uppercase trusted key still matches.
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, nil)}, ins: []brc162.Input{acIn(0, acTokA, 0)},
		trusted: map[string]bool{strings.ToUpper(mt.Issuer.Identity): true}}.run(t)
	if err != nil {
		t.Fatalf("lowercased trust: %v", err)
	}
}

func TestCheckAuthorityStep3AuthorityInputsInInputOrder(t *testing.T) {
	ins := []brc162.Input{acIn(1, acTokB, 0), acIn(2, acTokA, 0)}
	outs := []brc162.Output{acAuthority(0, acTokA, nil), acAuthority(1, acTokB, nil)}
	_, err := acCase{outs: outs, ins: ins, inputOwners: map[uint32]string{1: mt.Rogue.Identity, 2: mt.Rogue.Identity}}.run(t)
	requireReject(t, err, CodeUntrusted, "input 1: authority owner "+mt.Rogue.Identity+" is not a trusted issuer")
}

func TestCheckAuthoritySteps4And5(t *testing.T) {
	_, err := acCase{outs: []brc162.Output{acValue(0, acTokA, 5), acAuthority(1, acTokA, nil)}}.run(t)
	requireReject(t, err, CodeAuthority, "output 1: authority output without an admitted authority input of token "+acTokA)
	// Ledger order: token A (outputs) before token B (inputs only); step 5 fires before A's step 8 fault.
	_, err = acCase{outs: []brc162.Output{acValue(0, acTokA, 5)}, ins: []brc162.Input{acIn(0, acTokB, 0)}}.run(t)
	requireReject(t, err, CodeAuthority, "token "+acTokB+": spends an authority but creates none")
}

func TestCheckAuthorityStep6Commitments(t *testing.T) {
	issue := acDetails(t, brc162.CborMap{"kind": "issue"})
	pause := acDetails(t, brc162.CborMap{"kind": "pause"})
	authIn := []brc162.Input{acIn(0, acTokA, 0)}
	entry := func(i uint64, d []byte) AdminEntry { return AdminEntry{Index: i, Details: hex.EncodeToString(d)} }
	_, err := acCase{outs: []brc162.Output{acAuthority(0, acTokA, issue), acAuthority(1, acTokA, pause)}, ins: authIn, env: acEnv(entry(0, issue), entry(1, pause))}.run(t)
	requireReject(t, err, CodeAuthority, "token "+acTokA+": more than one authority output carries an action commitment")
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, pause)}, ins: authIn}.run(t)
	requireReject(t, err, CodeShape, "output 0: committed authority output has no admin details")
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, pause)}, ins: authIn, env: acEnv(entry(0, acDetails(t, brc162.CborMap{"kind": "mint"})))}.run(t)
	requireReject(t, err, CodeShape, "output 0: admin details violate the schema (kind mint is not allowed)")
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, issue)}, ins: authIn, env: acEnv(entry(0, pause))}.run(t)
	requireReject(t, err, CodeAuthority, "output 0: admin details do not match the payload commitment")
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, pause)}, ins: authIn, env: acEnv(entry(5, pause), entry(0, pause), entry(7, pause))}.run(t)
	requireReject(t, err, CodeShape, "admin entry 5 does not name a committed authority output")
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, nil)}, ins: authIn, env: acEnv(entry(4294967296, pause))}.run(t)
	requireReject(t, err, CodeShape, "admin entry 4294967296 does not name a committed authority output")
	res, err := acCase{outs: []brc162.Output{acAuthority(0, acTokA, pause)}, ins: authIn, env: acEnv(entry(0, pause))}.run(t)
	if err != nil || len(res.Actions) != 1 || res.Actions[0].Details.Kind != "pause" || res.Actions[0].DetailsHex != hex.EncodeToString(pause) || res.Actions[0].Commitment != sha256.Sum256(pause) {
		t.Fatalf("a committed pause: %+v %v", res, err)
	}
}

func TestCheckAuthorityStep7Registry(t *testing.T) {
	admit := acDetails(t, brc162.CborMap{"kind": "admitIdentity", "identityKey": dtKey(t, mt.Holder)})
	authIn := []brc162.Input{acIn(0, acTokA, 0)}
	_, err := acCase{outs: []brc162.Output{acAuthority(0, acTokA, admit), acValue(1, acTokA, 1)}, ins: append(authIn, acIn(1, acTokA, 1)),
		env: acEnv(AdminEntry{Index: 0, Details: hex.EncodeToString(admit)}), registry: true}.run(t)
	requireReject(t, err, CodeShape, "output 1: tm_mandala_registry does not admit value outputs")
	issue := acDetails(t, brc162.CborMap{"kind": "issue"})
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, issue)}, ins: authIn, env: acEnv(AdminEntry{Index: 0, Details: hex.EncodeToString(issue)}), registry: true}.run(t)
	requireReject(t, err, CodeShape, "output 0: admin details violate the schema (kind issue is not allowed)")
	res, err := acCase{outs: []brc162.Output{acAuthority(0, acTokA, admit)}, ins: authIn, env: acEnv(AdminEntry{Index: 0, Details: hex.EncodeToString(admit)}), registry: true}.run(t)
	if err != nil || res.Actions[0].Details.IdentityKey != mt.Holder.Identity {
		t.Fatalf("a registry admit: %+v %v", res, err)
	}
}

func TestCheckAuthorityStep8DeltaRules(t *testing.T) {
	commit := func(kind string) ([]brc162.Output, *Envelope) {
		d := acDetails(t, brc162.CborMap{"kind": kind})
		return []brc162.Output{acAuthority(0, acTokA, d)}, acEnv(AdminEntry{Index: 0, Details: hex.EncodeToString(d)})
	}
	authIn := acIn(0, acTokA, 0)
	_, err := acCase{outs: []brc162.Output{acValue(0, acTokA, 7)}, ins: []brc162.Input{acIn(0, acTokA, 10)}}.run(t)
	requireReject(t, err, CodeConservation, "token "+acTokA+": value in 10 != value out 7 without an authority")
	_, err = acCase{outs: []brc162.Output{acValue(0, acTokA, 5)}}.run(t)
	requireReject(t, err, CodeConservation, "token "+acTokA+": value in 0 != value out 5 without an authority")
	_, err = acCase{outs: []brc162.Output{acAuthority(0, acTokA, nil), acValue(1, acTokA, 5)}, ins: []brc162.Input{authIn}}.run(t)
	requireReject(t, err, CodeConservation, "token "+acTokA+": plain authority requires delta = 0 but delta is 5")
	outs, env := commit("issue")
	_, err = acCase{outs: outs, ins: []brc162.Input{authIn}, env: env}.run(t)
	requireReject(t, err, CodeConservation, "token "+acTokA+": issue requires delta > 0 but delta is 0")
	outs, env = commit("redeem")
	_, err = acCase{outs: append(outs, acValue(1, acTokA, 5)), ins: []brc162.Input{authIn}, env: env}.run(t)
	requireReject(t, err, CodeConservation, "token "+acTokA+": redeem requires delta < 0 but delta is 5")
	res, err := acCase{outs: append(outs, acValue(1, acTokA, 10)), ins: []brc162.Input{authIn, acIn(1, acTokA, 50)}, env: env}.run(t)
	if err != nil || res.Deltas[acTokA].String() != "-40" {
		t.Fatalf("a redeem of 40: %+v %v", res, err)
	}
	outs, env = commit("pause")
	_, err = acCase{outs: append(outs, acValue(1, acTokA, 10)), ins: []brc162.Input{authIn, acIn(1, acTokA, 50)}, env: env}.run(t)
	requireReject(t, err, CodeConservation, "token "+acTokA+": pause requires delta = 0 but delta is -40")
}

func TestCheckAuthorityStep9Caps(t *testing.T) {
	commit := func(kind string) ([]brc162.Output, *Envelope) {
		d := acDetails(t, brc162.CborMap{"kind": kind})
		return []brc162.Output{acAuthority(0, acTokA, d)}, acEnv(AdminEntry{Index: 0, Details: hex.EncodeToString(d)})
	}
	authIn := acIn(0, acTokA, 0)
	outs, env := commit("redeem")
	_, err := acCase{outs: append(outs, acValue(1, acTokA, MaxSafeAmount)), ins: []brc162.Input{authIn, acIn(1, acTokA, MaxSafeAmount), acIn(2, acTokA, MaxSafeAmount)}, env: env}.run(t)
	requireReject(t, err, CodeShape, "token "+acTokA+": value sum exceeds 2^53-1")
	outs, env = commit("issue")
	near := newMemStore()
	near.putToken(TokenRecord{Txid: strings.Repeat("ee", 32), TokenID: acTokA, Amount: Amount(MaxSafeAmount - 50), IdentityKey: mt.Holder.Identity})
	_, err = acCase{outs: append(outs, acValue(1, acTokA, 100)), ins: []brc162.Input{authIn}, env: env, store: near}.run(t)
	requireReject(t, err, CodeShape, "token "+acTokA+": circulating supply would exceed 2^53-1")
	if _, err := (acCase{outs: append(outs, acValue(1, acTokA, 50)), ins: []brc162.Input{authIn}, env: env, store: near}).run(t); err != nil {
		t.Fatalf("an issue up to exactly 2^53-1: %v", err)
	}
	faulty := newMemStore()
	faulty.failNext("CirculatingSupply", errStoreDown)
	pauseOuts, pauseEnv := commit("pause")
	if _, err := (acCase{outs: pauseOuts, ins: []brc162.Input{authIn}, env: pauseEnv, store: faulty}).run(t); err != nil {
		t.Fatalf("the supply is read only when the delta is positive: %v", err)
	}
	_, err = acCase{outs: append(outs, acValue(1, acTokA, 5)), ins: []brc162.Input{authIn}, env: env, store: faulty}.run(t)
	requireReject(t, err, CodeUnavailable, "the circulating supply could not be read; retry")
}

func TestCheckAuthorityStep10Reissue(t *testing.T) {
	target := strings.Repeat("ab", 32) + ".0"
	reissue := acDetails(t, brc162.CborMap{"kind": "reissue", "outpoint": dtOutpoint36(0xab, 0), "recipient": dtKey(t, mt.Holder)})
	env := acEnv(AdminEntry{Index: 0, Details: hex.EncodeToString(reissue)})
	frozenStore := func(amount Amount) *memStore {
		s := newMemStore()
		st := DefaultAssetState(acTokA, nil)
		st.FrozenOutpoints = []FrozenRef{{Outpoint: strings.ToUpper(target[:64]) + ".0", Amount: amount, Owner: mt.Rogue.Identity}}
		s.putState(st)
		return s
	}
	authIn := acIn(0, acTokA, 0)
	outs := []brc162.Output{acAuthority(0, acTokA, reissue), acValue(1, acTokA, 30)}
	toHolder := func(outs []brc162.Output) []VerifiedOwner {
		o := acOwnedBy(outs, mt.Issuer.Identity, mt.Issuer.Identity)
		for i := range o {
			if o[i].Role == brc162.RoleValue {
				o[i].IdentityKey = mt.Holder.Identity
			}
		}
		return o
	}
	res, err := acCase{outs: outs, owners: toHolder(outs), ins: []brc162.Input{authIn}, env: env, store: frozenStore(30)}.run(t)
	if err != nil || res.Actions[0].Details.Kind != "reissue" {
		t.Fatalf("a valid reissue (frozen outpoint matched case-insensitively): %+v %v", res, err)
	}
	reason := func(d string) string { return "token " + acTokA + ": reissue " + d }
	_, err = acCase{outs: outs, owners: toHolder(outs), ins: []brc162.Input{authIn}, env: env}.run(t)
	requireReject(t, err, CodeShape, reason("target is not frozen"))
	_, err = acCase{outs: outs, owners: toHolder(outs), ins: []brc162.Input{authIn}, env: env, store: frozenStore(31)}.run(t)
	requireReject(t, err, CodeShape, reason("amount does not match the frozen row"))
	spends := []brc162.Output{acAuthority(0, acTokA, reissue), acValue(1, acTokA, 40)}
	_, err = acCase{outs: spends, owners: toHolder(spends), ins: []brc162.Input{authIn, acIn(1, acTokA, 10)}, env: env, store: frozenStore(30)}.run(t)
	requireReject(t, err, CodeShape, reason("must not spend value inputs"))
	_, err = acCase{outs: outs, ins: []brc162.Input{authIn}, env: env, store: frozenStore(30)}.run(t) // value output owned by the issuer
	requireReject(t, err, CodeShape, reason("outputs must go to the recipient"))
	faulty := frozenStore(30)
	faulty.failNext("GetAssetState", errStoreDown)
	_, err = acCase{outs: outs, owners: toHolder(outs), ins: []brc162.Input{authIn}, env: env, store: faulty}.run(t)
	requireReject(t, err, CodeUnavailable, "the asset state could not be read; retry")
}

func TestCheckAuthorityResult(t *testing.T) {
	issue := acDetails(t, brc162.CborMap{"kind": "issue"})
	outs := []brc162.Output{acAuthority(0, acTokA, issue), acValue(1, acTokA, 100), acValue(2, acTokB, 3)}
	res, err := acCase{outs: outs, ins: []brc162.Input{acIn(0, acTokA, 0), acIn(1, acTokB, 3)}, env: acEnv(AdminEntry{Index: 0, Details: hex.EncodeToString(issue)})}.run(t)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Actions) != 1 || res.Actions[0].TokenID != acTokA || res.Actions[0].OutputIndex != 0 {
		t.Fatalf("actions %+v", res.Actions)
	}
	if res.Deltas[acTokA].Cmp(big.NewInt(100)) != 0 || res.Deltas[acTokB].Sign() != 0 || len(res.Deltas) != 2 {
		t.Fatalf("deltas %v", res.Deltas)
	}
	if !res.AdminTokens[acTokA] || res.AdminTokens[acTokB] {
		t.Fatalf("admin tokens %v", res.AdminTokens)
	}
	if _, err := ReadAssetState(context.Background(), newMemStore(), acTokA); err != nil {
		t.Fatal(err)
	}
}

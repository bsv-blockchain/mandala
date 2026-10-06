package mandala

// Layer C (D §4.3; TS authority.ts, F/ts-layers §3): deploys are signed genesis, every deploy and
// authority output belongs to and is revealed by a trusted issuer, a spent authority is
// re-created, at most one authority output per token commits to an action, and each token's
// supply delta follows its action's rule. Steps 1-11 run in TS order, each over every output or
// token (ledger order) before the next.

import (
	"context"
	"fmt"
	"math/big"
	"slices"
	"strings"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// AuthorityDeps are layer C's dependencies.
type AuthorityDeps struct {
	Trusted  map[string]bool // lowercase compressed keys
	Store    StateStore
	Registry bool // KYC: RegistryKinds and value outputs forbidden
}

// CommittedAction is one verified admin action: the details its authority output commits to.
type CommittedAction struct {
	TokenID     string
	OutputIndex uint32
	Details     AdminDetails
	DetailsHex  string
	Commitment  [32]byte
}

// AuthorityResult is what layer D and the lookups read from layer C.
type AuthorityResult struct {
	Actions     []CommittedAction   // <= 1 per token, ledger order
	Deltas      map[string]*big.Int // every ledger's valueOut - valueIn
	AdminTokens map[string]bool     // tokens with >= 1 authority input
}

const authPlain = "plain authority"

var authMaxSafe = new(big.Int).SetUint64(MaxSafeAmount)

// ReadAssetState reads the token's admin state; a fault is the retryable ERR_UNAVAILABLE.
func ReadAssetState(ctx context.Context, s StateStore, tokenID string) (AssetAdminState, error) {
	st, err := s.GetAssetState(ctx, tokenID)
	if err != nil {
		return AssetAdminState{}, rStoreUnavailable("the asset state", err)
	}
	return st, nil
}

func authReadSupply(ctx context.Context, s StateStore, tokenID string) (*big.Int, error) {
	v, err := s.CirculatingSupply(ctx, tokenID)
	if err != nil {
		return nil, rStoreUnavailable("the circulating supply", err)
	}
	return v, nil
}

func authOwnerAt(owners []VerifiedOwner, index uint32) (VerifiedOwner, error) {
	for _, o := range owners {
		if o.Index == index {
			return o, nil
		}
	}
	return VerifiedOwner{}, fmt.Errorf("no verified owner for output %d", index)
}

func authDelta(l *brc162.TokenLedger) *big.Int { return new(big.Int).Sub(l.ValueOut, l.ValueIn) }

// 1. deploys (layer B already put any deploy at output 0).
func authRequireDeploys(ctx context.Context, txid string, outputs []brc162.Output, owners []VerifiedOwner, env *Envelope) error {
	for _, o := range outputs {
		if o.Role != brc162.RoleDeploy {
			continue
		}
		if o.Amount > 0 {
			return rFixedSupply()
		}
		if _, err := ParseDeployMetadata(o.Payload, o.HasPayload, o.PayloadCanonical); err != nil {
			return err
		}
		owner, err := authOwnerAt(owners, o.Index)
		if err != nil {
			return err
		}
		if !VerifyDeploySig(ctx, txid, env.DeploySig, env.HasDeploySig, owner.IdentityKey) {
			return rDeploySig()
		}
	}
	return nil
}

// 2. per output, owner then prover, before the next output; value outputs are skipped.
func authRequireTrustedOutputs(owners []VerifiedOwner, trusted map[string]bool) error {
	for _, o := range owners {
		if o.Role == brc162.RoleValue {
			continue
		}
		if !trusted[strings.ToLower(o.IdentityKey)] {
			return rUntrustedOwner(o.Index, o.IdentityKey)
		}
		if !trusted[strings.ToLower(o.Prover)] {
			return rUntrustedProver(o.Index, o.Prover)
		}
	}
	return nil
}

// 3. every authority input owner, in ascending input order.
func authRequireTrustedInputs(ledgers []*brc162.TokenLedger, inputOwners map[uint32]string, trusted map[string]bool) error {
	var indices []uint32
	for _, l := range ledgers {
		indices = append(indices, l.AuthorityIn...)
	}
	slices.Sort(indices)
	for _, i := range indices {
		owner, ok := inputOwners[i]
		if !ok {
			return fmt.Errorf("no resolved owner for input %d", i)
		}
		if !trusted[strings.ToLower(owner)] {
			return rUntrustedAuthorityInput(i, owner)
		}
	}
	return nil
}

type authCommitment struct {
	index uint32
	value [32]byte
}

// authCommitmentsOf: authority outputs (never a deploy) of the token whose payload commits.
func authCommitmentsOf(outputs []brc162.Output, tokenID string) []authCommitment {
	var out []authCommitment
	for _, o := range outputs {
		if o.Role != brc162.RoleAuthority || o.TokenID != tokenID {
			continue
		}
		if c, ok := CommitmentOf(o.Payload, o.HasPayload, o.PayloadCanonical); ok {
			out = append(out, authCommitment{index: o.Index, value: c})
		}
	}
	return out
}

func authVerifyCommitted(tokenID string, c authCommitment, env *Envelope, allowed []string) (CommittedAction, error) {
	var entry *AdminEntry
	for i := range env.Admin {
		if env.Admin[i].Index == uint64(c.index) {
			entry = &env.Admin[i]
			break
		}
	}
	if entry == nil {
		return CommittedAction{}, rMissingDetails(c.index)
	}
	details, sum, err := DecodeAdminDetails(entry.Details, allowed, c.index)
	if err != nil {
		return CommittedAction{}, err
	}
	if sum != c.value {
		return CommittedAction{}, rCommitmentMismatch(c.index)
	}
	return CommittedAction{TokenID: tokenID, OutputIndex: c.index, Details: details, DetailsHex: entry.Details, Commitment: c.value}, nil
}

// 6. commitments per ledger, then the first orphan admin entry in envelope order.
func authCommittedActions(ledgers []*brc162.TokenLedger, outputs []brc162.Output, env *Envelope, registry bool) ([]CommittedAction, error) {
	allowed := AdminKinds
	if registry {
		allowed = RegistryKinds
	}
	var actions []CommittedAction
	for _, l := range ledgers {
		cs := authCommitmentsOf(outputs, l.TokenID)
		if len(cs) > 1 {
			return nil, rTwoCommitments(l.TokenID)
		}
		if len(cs) == 1 {
			a, err := authVerifyCommitted(l.TokenID, cs[0], env, allowed)
			if err != nil {
				return nil, err
			}
			actions = append(actions, a)
		}
	}
	committed := map[uint64]bool{}
	for _, a := range actions {
		committed[uint64(a.OutputIndex)] = true
	}
	for _, e := range env.Admin {
		if !committed[e.Index] {
			return nil, rOrphanDetails(e.Index)
		}
	}
	return actions, nil
}

func authActionOf(actions []CommittedAction, tokenID string) *CommittedAction {
	for i := range actions {
		if actions[i].TokenID == tokenID {
			return &actions[i]
		}
	}
	return nil
}

// 8. a token with no authority input conserves exactly; otherwise its action's rule holds
// (issue > 0, redeem < 0, reissue checked in 10, anything else = 0).
func authRequireDeltaRule(l *brc162.TokenLedger, action *CommittedAction) error {
	delta := authDelta(l)
	if len(l.AuthorityIn) == 0 {
		if delta.Sign() != 0 {
			return rHolderConservation(l.TokenID, l.ValueIn, l.ValueOut)
		}
		return nil
	}
	kind := authPlain
	if action != nil {
		kind = action.Details.Kind
	}
	if kind == "reissue" {
		return nil
	}
	rule, holds := "= 0", delta.Sign() == 0
	switch kind {
	case "issue":
		rule, holds = "> 0", delta.Sign() > 0
	case "redeem":
		rule, holds = "< 0", delta.Sign() < 0
	}
	if !holds {
		return rDeltaRule(l.TokenID, kind, rule, delta)
	}
	return nil
}

// 9. sums and, only for Δ > 0, the circulating supply against 2^53-1.
func authRequireCaps(ctx context.Context, ledgers []*brc162.TokenLedger, s StateStore) error {
	for _, l := range ledgers {
		if l.ValueIn.Cmp(authMaxSafe) > 0 || l.ValueOut.Cmp(authMaxSafe) > 0 {
			return rSumCap(l.TokenID)
		}
		delta := authDelta(l)
		if delta.Sign() <= 0 {
			continue
		}
		supply, err := authReadSupply(ctx, s, l.TokenID)
		if err != nil {
			return err
		}
		if new(big.Int).Add(supply, delta).Cmp(authMaxSafe) > 0 {
			return rSupplyCap(l.TokenID)
		}
	}
	return nil
}

// 10. a reissue: the target is frozen, Δ equals the frozen amount, no value inputs, and every value
// output of the token goes to the recipient.
func authRequireReissue(ctx context.Context, l *brc162.TokenLedger, a *CommittedAction, owners []VerifiedOwner, s StateStore) error {
	target := strings.ToLower(a.Details.Outpoint)
	st, err := ReadAssetState(ctx, s, l.TokenID)
	if err != nil {
		return err
	}
	var frozen *FrozenRef
	for i := range st.FrozenOutpoints {
		if strings.ToLower(st.FrozenOutpoints[i].Outpoint) == target {
			frozen = &st.FrozenOutpoints[i]
			break
		}
	}
	if frozen == nil {
		return rReissue(l.TokenID, "target is not frozen")
	}
	delta := authDelta(l)
	safe := frozen.Amount >= -Amount(MaxSafeAmount) && frozen.Amount <= Amount(MaxSafeAmount) // TS Number.isSafeInteger
	if !safe || big.NewInt(int64(frozen.Amount)).Cmp(delta) != 0 {
		return rReissue(l.TokenID, "amount does not match the frozen row")
	}
	if len(l.ValueInIndices) > 0 {
		return rReissue(l.TokenID, "must not spend value inputs")
	}
	recipient := strings.ToLower(a.Details.Recipient)
	for _, o := range owners {
		if o.TokenID == l.TokenID && o.Role == brc162.RoleValue && strings.ToLower(o.IdentityKey) != recipient {
			return rReissue(l.TokenID, "outputs must go to the recipient")
		}
	}
	return nil
}

func authLowered(keys map[string]bool) map[string]bool {
	out := make(map[string]bool, len(keys))
	for k, v := range keys {
		if v {
			out[strings.ToLower(k)] = true
		}
	}
	return out
}

// CheckAuthority is layer C for one transaction, steps 1-11 of F/ts-layers §3 in order: deploys,
// trusted outputs, trusted authority inputs, authority inputs, continuity, commitments, registry
// value outputs, delta rule, caps, reissues, result.
func CheckAuthority(ctx context.Context, txid string, l *brc162.Ledger, outputs []brc162.Output, owners []VerifiedOwner,
	inputOwners map[uint32]string, env *Envelope, d AuthorityDeps) (*AuthorityResult, error) {
	ledgers := l.Tokens()
	trusted := authLowered(d.Trusted)
	if err := authRequireDeploys(ctx, txid, outputs, owners, env); err != nil {
		return nil, err
	}
	if err := authRequireTrustedOutputs(owners, trusted); err != nil {
		return nil, err
	}
	if err := authRequireTrustedInputs(ledgers, inputOwners, trusted); err != nil {
		return nil, err
	}
	for _, t := range ledgers { // 4. authority outputs need an authority input (or are the genesis)
		if !brc162.SpecVerdicts(t).AuthorityOutputsValid {
			return nil, rAuthorityWithoutInput(t.AuthorityOut[0], t.TokenID)
		}
	}
	for _, t := range ledgers { // 5. a spent authority is re-created
		if len(t.AuthorityIn) > 0 && len(t.AuthorityOut) == 0 {
			return nil, rContinuity(t.TokenID)
		}
	}
	actions, err := authCommittedActions(ledgers, outputs, env, d.Registry)
	if err != nil {
		return nil, err
	}
	if d.Registry { // 7. the KYC registry admits no value outputs
		for _, o := range outputs {
			if o.Role == brc162.RoleValue {
				return nil, rRegistryValue(o.Index)
			}
		}
	}
	for _, t := range ledgers {
		if err := authRequireDeltaRule(t, authActionOf(actions, t.TokenID)); err != nil {
			return nil, err
		}
	}
	if err := authRequireCaps(ctx, ledgers, d.Store); err != nil {
		return nil, err
	}
	for _, t := range ledgers {
		if a := authActionOf(actions, t.TokenID); a != nil && a.Details.Kind == "reissue" {
			if err := authRequireReissue(ctx, t, a, owners, d.Store); err != nil {
				return nil, err
			}
		}
	}
	res := &AuthorityResult{Actions: actions, Deltas: map[string]*big.Int{}, AdminTokens: map[string]bool{}}
	for _, t := range ledgers {
		res.Deltas[t.TokenID] = authDelta(t)
		if len(t.AuthorityIn) > 0 {
			res.AdminTokens[t.TokenID] = true
		}
	}
	return res, nil
}

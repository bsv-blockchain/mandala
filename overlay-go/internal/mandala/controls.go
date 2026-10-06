package mandala

import (
	"context"
	"fmt"
	"strings"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// ControlDeps is what layer D (issuer controls, D §4.4) reads.
type ControlDeps struct {
	Store      StateStore
	Screening  ScreeningProvider
	Membership MembershipProvider // nil = no membership gate
	Exempt     map[string]bool    // trusted ∪ membershipExempt, lowercase
}

type ctlParties struct {
	inputs      []brc162.Input
	inputOwners map[uint32]string
	owners      []VerifiedOwner
	exempt      map[string]bool // lowercased
}

func ctlLowerSet(keys []string) map[string]bool {
	set := make(map[string]bool, len(keys))
	for _, k := range keys {
		set[strings.ToLower(k)] = true
	}
	return set
}

func ctlOwnerOfInput(inputOwners map[uint32]string, index uint32) (string, error) {
	owner, ok := inputOwners[index]
	if !ok {
		return "", fmt.Errorf("no resolved owner for input %d", index)
	}
	return owner, nil
}

// ctlSpendable: per input in order, frozen before evicted; the reason prints the input's own
// outpoint spelling (Q2/mandala/controls.ts:36-44).
func ctlSpendable(state AssetAdminState, inputs []brc162.Input) error {
	frozen := make(map[string]bool, len(state.FrozenOutpoints))
	for _, f := range state.FrozenOutpoints {
		frozen[strings.ToLower(f.Outpoint)] = true
	}
	evicted := ctlLowerSet(state.EvictedOutpoints)
	for _, in := range inputs {
		op := strings.ToLower(in.Outpoint)
		if frozen[op] {
			return rFrozenInput(in.Index, in.Outpoint)
		}
		if evicted[op] {
			return rEvictedInput(in.Index, in.Outpoint)
		}
	}
	return nil
}

// ctlTokenParties: this token's output owners (index order), then its input owners (input
// order), lowercased, minus the exempt set; not deduplicated (Q2/mandala/controls.ts:56-62).
func ctlTokenParties(tokenID string, tokenInputs []brc162.Input, p ctlParties) ([]string, error) {
	var all []string
	for _, o := range p.owners {
		if o.TokenID == tokenID {
			all = append(all, strings.ToLower(o.IdentityKey))
		}
	}
	for _, in := range tokenInputs {
		owner, err := ctlOwnerOfInput(p.inputOwners, in.Index)
		if err != nil {
			return nil, err
		}
		all = append(all, strings.ToLower(owner))
	}
	parties := make([]string, 0, len(all))
	for _, party := range all {
		if !p.exempt[party] {
			parties = append(parties, party)
		}
	}
	return parties, nil
}

// ctlAccess: "denylist" refuses the first blocked party; any other mode is an allowlist and fails
// closed on the first party not allowed.
func ctlAccess(tokenID string, state AssetAdminState, parties []string) error {
	if state.AccessMode == "denylist" {
		blocked := ctlLowerSet(state.BlockedIdentities)
		for _, party := range parties {
			if blocked[party] {
				return rBlocked(tokenID, party)
			}
		}
		return nil
	}
	allowed := ctlLowerSet(state.AllowedIdentities)
	for _, party := range parties {
		if !allowed[party] {
			return rNotAllowed(tokenID, party)
		}
	}
	return nil
}

func ctlTokenControls(ctx context.Context, tokenID string, isAdmin bool, p ctlParties, store StateStore) error {
	var tokenInputs []brc162.Input
	for _, in := range p.inputs {
		if in.TokenID == tokenID {
			tokenInputs = append(tokenInputs, in)
		}
	}
	state, err := ReadAssetState(ctx, store, tokenID)
	if err != nil {
		return err
	}
	if err := ctlSpendable(state, tokenInputs); err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	if state.IsPaused {
		return rPaused(tokenID)
	}
	parties, err := ctlTokenParties(tokenID, tokenInputs, p)
	if err != nil {
		return err
	}
	return ctlAccess(tokenID, state, parties)
}

// ctlIdentities: every output owner (index order), then every input owner (input order),
// lowercased and deduplicated, first occurrence wins (a JS Set).
func ctlIdentities(p ctlParties) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	add := func(key string) {
		key = strings.ToLower(key)
		if !seen[key] {
			seen[key] = true
			out = append(out, key)
		}
	}
	for _, o := range p.owners {
		add(o.IdentityKey)
	}
	for _, in := range p.inputs {
		owner, err := ctlOwnerOfInput(p.inputOwners, in.Index)
		if err != nil {
			return nil, err
		}
		add(owner)
	}
	return out, nil
}

// CheckControls is layer D for one transaction (F/ts-layers §4, Q2/mandala/controls.ts:145-163):
// per token in ledger order the frozen/evicted inputs (admin txs too), then pause and access
// (skipped for a token whose authority the tx spends); then sanctions over every identity, exempt
// ones included; then membership over every non-exempt identity. A provider fault is
// ERR_UNAVAILABLE, never a verdict.
func CheckControls(ctx context.Context, l *brc162.Ledger, inputs []brc162.Input, inputOwners map[uint32]string,
	owners []VerifiedOwner, auth *AuthorityResult, d ControlDeps) error {
	exempt := make(map[string]bool, len(d.Exempt))
	for key := range d.Exempt {
		exempt[strings.ToLower(key)] = true
	}
	p := ctlParties{inputs: inputs, inputOwners: inputOwners, owners: owners, exempt: exempt}
	for _, tl := range l.Tokens() {
		isAdmin := auth != nil && auth.AdminTokens[tl.TokenID]
		if err := ctlTokenControls(ctx, tl.TokenID, isAdmin, p, d.Store); err != nil {
			return err
		}
	}
	identities, err := ctlIdentities(p)
	if err != nil {
		return err
	}
	for _, key := range identities {
		sanctioned, err := d.Screening.IsSanctioned(ctx, key)
		if err != nil {
			return rStoreUnavailable("the screening provider", err)
		}
		if sanctioned {
			return rSanctioned(key)
		}
	}
	if d.Membership == nil {
		return nil
	}
	active, err := d.Membership.IsActive(ctx)
	if err != nil {
		return rStoreUnavailable("the membership provider", err)
	}
	if !active {
		return nil
	}
	for _, key := range identities {
		if exempt[key] {
			continue
		}
		admitted, err := d.Membership.IsAdmitted(ctx, key)
		if err != nil {
			return rStoreUnavailable("the membership provider", err)
		}
		if !admitted {
			return rNotMember(key)
		}
	}
	return nil
}

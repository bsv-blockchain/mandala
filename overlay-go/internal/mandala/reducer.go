package mandala

import (
	"context"
	"strconv"
	"strings"
)

// FoldContext is what a fold needs from outside the action: the frozen row's amount and owner
// (Q2/mandala/AssetStateReducer.ts:29-32). nil = absent.
type FoldContext struct {
	FrozenAmount *Amount
	FrozenOwner  *string
}

func foldAddUnique(xs []string, x string) []string {
	canonical := strings.ToLower(x)
	for _, v := range xs {
		if strings.ToLower(v) == canonical {
			return xs
		}
	}
	out := make([]string, 0, len(xs)+1)
	return append(append(out, xs...), canonical)
}

func foldRemove(xs []string, x string) []string {
	canonical := strings.ToLower(x)
	out := make([]string, 0, len(xs))
	for _, v := range xs {
		if strings.ToLower(v) != canonical {
			out = append(out, v)
		}
	}
	return out
}

func foldIsFrozen(frozen []FrozenRef, outpoint string) bool {
	for _, f := range frozen {
		if strings.ToLower(f.Outpoint) == outpoint {
			return true
		}
	}
	return false
}

func foldUnfrozen(frozen []FrozenRef, outpoint string) []FrozenRef {
	out := make([]FrozenRef, 0, len(frozen))
	for _, f := range frozen {
		if strings.ToLower(f.Outpoint) != outpoint {
			out = append(out, f)
		}
	}
	return out
}

func foldCloneInt64(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// FoldAction ports TS foldAction (F/ts-layers §9): a copy of prev with one admitted action applied.
// Keys and outpoints are lowercased; a re-freeze is a no-op; issue, redeem, registry and unknown
// kinds change nothing; the fold position fields are never touched; prev's slices are never written.
func FoldAction(prev AssetAdminState, d AdminDetails, fc FoldContext) AssetAdminState {
	s := prev
	switch d.Kind {
	case "pause":
		s.IsPaused = true
	case "unpause":
		s.IsPaused = false
	case "blockIdentity":
		if d.IdentityKey != "" {
			s.BlockedIdentities = foldAddUnique(s.BlockedIdentities, d.IdentityKey)
		}
	case "unblockIdentity":
		if d.IdentityKey != "" {
			s.BlockedIdentities = foldRemove(s.BlockedIdentities, d.IdentityKey)
		}
	case "allowIdentity":
		if d.IdentityKey != "" {
			s.AllowedIdentities = foldAddUnique(s.AllowedIdentities, d.IdentityKey)
		}
	case "unallowIdentity":
		if d.IdentityKey != "" {
			s.AllowedIdentities = foldRemove(s.AllowedIdentities, d.IdentityKey)
		}
	case "setAccessMode":
		if d.Mode == "denylist" || d.Mode == "allowlist" {
			s.AccessMode = d.Mode
		}
	case "freezeOutput":
		if d.Outpoint == "" {
			break
		}
		op := strings.ToLower(d.Outpoint)
		if foldIsFrozen(s.FrozenOutpoints, op) {
			break
		}
		ref := FrozenRef{Outpoint: op}
		if fc.FrozenAmount != nil {
			ref.Amount = *fc.FrozenAmount
		}
		if fc.FrozenOwner != nil {
			ref.Owner = strings.ToLower(*fc.FrozenOwner)
		}
		next := make([]FrozenRef, 0, len(s.FrozenOutpoints)+1)
		s.FrozenOutpoints = append(append(next, s.FrozenOutpoints...), ref)
	case "unfreezeOutput":
		if d.Outpoint != "" {
			s.FrozenOutpoints = foldUnfrozen(s.FrozenOutpoints, strings.ToLower(d.Outpoint))
		}
	case "reissue":
		if d.Outpoint != "" {
			op := strings.ToLower(d.Outpoint)
			s.FrozenOutpoints = foldUnfrozen(s.FrozenOutpoints, op)
			s.EvictedOutpoints = foldAddUnique(s.EvictedOutpoints, op)
		}
	case "setFeeRate":
		if d.HasFeeRatePerKb {
			s.FeeRatePerKb = foldCloneInt64(d.FeeRatePerKb)
		}
	}
	return s
}

// foldEntry is TS folded(): FoldAction plus the entry's fold position.
func foldEntry(prev AssetAdminState, d AdminDetails, e AdminHistoryEntry, fc FoldContext) AssetAdminState {
	s := FoldAction(prev, d, fc)
	s.LastProcessedHeight = e.Height
	s.LastProcessedOffset = e.Offset
	s.LastAdmitSeq = e.AdmitSeq
	return s
}

// foldOutpoint splits a details outpoint "<txid>.<vout>".
func foldOutpoint(s string) (string, uint32, bool) {
	dot := strings.LastIndexByte(s, '.')
	if dot <= 0 {
		return "", 0, false
	}
	vout, err := strconv.ParseUint(s[dot+1:], 10, 32)
	if err != nil {
		return "", 0, false
	}
	return s[:dot], uint32(vout), true
}

// liveFoldContext ports TS liveFoldContext (Q2/mandala/MandalaLookupService.ts:350-357): only a
// freeze reads context; it freezes the live value row's amount and owner, or {0, ""} when the row is
// gone or belongs to another token.
func liveFoldContext(ctx context.Context, s StateStore, d AdminDetails, tokenID string) (FoldContext, error) {
	if d.Kind != "freezeOutput" || d.Outpoint == "" {
		return FoldContext{}, nil
	}
	zero, none := Amount(0), ""
	txid, vout, ok := foldOutpoint(d.Outpoint)
	if !ok {
		return FoldContext{FrozenAmount: &zero, FrozenOwner: &none}, nil
	}
	row, err := s.GetTokenRow(ctx, txid, vout)
	if err != nil {
		return FoldContext{}, err
	}
	if row == nil || row.TokenID != tokenID {
		return FoldContext{FrozenAmount: &zero, FrozenOwner: &none}, nil
	}
	amount, owner := row.Amount, row.IdentityKey
	return FoldContext{FrozenAmount: &amount, FrozenOwner: &owner}, nil
}

// recordedFoldContext: the context the history row was folded with; a row written without one
// reads it live.
func recordedFoldContext(ctx context.Context, s StateStore, d AdminDetails, e AdminHistoryEntry) (FoldContext, error) {
	if e.FrozenAmount == nil {
		return liveFoldContext(ctx, s, d, e.TokenID)
	}
	amount := *e.FrozenAmount
	owner := ""
	if e.FrozenOwner != nil {
		owner = *e.FrozenOwner
	}
	return FoldContext{FrozenAmount: &amount, FrozenOwner: &owner}, nil
}

package mandala

import "context"

// PickAssetAuthHead returns the per-asset admin-auth head (A10): the newest
// admitted admin output of the asset by (height, offset, admitSeq). Unmined
// actions carry height = Number.MAX_SAFE_INTEGER (see txOrdering), so they
// sort after every mined one. Input order is irrelevant. Same rule as
// overlay/src/assetAuth.ts pickAssetAuthHead.
func PickAssetAuthHead(rows []AdminHistoryEntry) (AdminHistoryEntry, bool) {
	var head AdminHistoryEntry
	found := false
	for _, r := range rows {
		if !found || later(r, head) {
			head, found = r, true
		}
	}
	return head, found
}

func later(a, b AdminHistoryEntry) bool {
	if a.Height != b.Height {
		return a.Height > b.Height
	}
	if a.Offset != b.Offset {
		return a.Offset > b.Offset
	}
	return a.AdmitSeq > b.AdmitSeq
}

// TokenRowReader is the one lookup AnnotateFrozenRows needs; *Store and the
// topic manager's StateStore both satisfy it.
type TokenRowReader interface {
	GetTokenRow(ctx context.Context, txid string, vout uint32) (*TokenRow, error)
}

// AnnotateFrozenRows marks each frozen ref with HasFrozenRow (A16): whether
// the frozen coin still has a live token row, i.e. whether a reissue of it can
// succeed. Read at request time so a freeze that raced the coin's spend is
// reported as it stands now. The input state is not mutated.
func AnnotateFrozenRows(ctx context.Context, st AssetAdminState, rows TokenRowReader) (AssetAdminState, error) {
	refs := make([]FrozenRef, len(st.FrozenOutpoints))
	for i, ref := range st.FrozenOutpoints {
		ref.HasFrozenRow = false
		if txid, vout, ok := splitOutpoint(ref.Outpoint); ok {
			row, err := rows.GetTokenRow(ctx, txid, vout)
			if err != nil {
				return AssetAdminState{}, err
			}
			ref.HasFrozenRow = row != nil
		}
		refs[i] = ref
	}
	st.FrozenOutpoints = refs
	return st, nil
}

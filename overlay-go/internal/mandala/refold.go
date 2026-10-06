package mandala

import (
	"context"
	"slices"
)

// The package eviction/refold API (F/ts-storage §4.5). Callers hold the maintenance gate's
// exclusive section: RebuildState reads and then writes the state, so it must never run beside a
// live fold.

// RebuildState refolds tokenID's state from its history in fold order, leaving out excludeTxid
// ("" leaves out nothing), from the deploy's fee rate (fees off once the metadata is gone), with each
// freeze's recorded fold context. A history row whose details no longer decode aborts the rebuild
// before anything is written. An empty history writes the default state.
func RebuildState(ctx context.Context, store *Store, tokenID, excludeTxid string) error {
	md, err := store.FindMetadata(ctx, tokenID)
	if err != nil {
		return err
	}
	var fee *int64
	if md != nil {
		fee = foldCloneInt64(md.FeeRatePerKb)
	}
	state := DefaultAssetState(tokenID, fee)
	history, err := store.FindAdminHistory(ctx, tokenID, 0, 0)
	if err != nil {
		return err
	}
	for _, e := range history {
		if excludeTxid != "" && e.Txid == excludeTxid {
			continue
		}
		d, _, err := DecodeAdminDetails(e.DetailsHex, AdminKinds, e.OutputIndex)
		if err != nil {
			return err
		}
		fc, err := recordedFoldContext(ctx, store, d, e)
		if err != nil {
			return err
		}
		state = foldEntry(state, d, e, fc)
	}
	return store.PutAssetState(ctx, state)
}

// PurgeAndRefold refolds every token txid has history for without it, THEN deletes txid's history,
// so an interrupted run can be repeated. Returns the refolded token ids (sorted).
func PurgeAndRefold(ctx context.Context, store *Store, txid string) ([]string, error) {
	ids, err := store.TokensTouchedBy(ctx, txid)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if err := RebuildState(ctx, store, id, txid); err != nil {
			return nil, err
		}
	}
	if err := store.DeleteAdminHistoryByTxid(ctx, txid); err != nil {
		return nil, err
	}
	return ids, nil
}

// RestoreInputRow restores a spent input's row from its journal row, credited once. It does not
// check liveness: the caller confirms the engine holds the coin unspent on journal.Topic first.
func RestoreInputRow(ctx context.Context, store *Store, journal OwnerRecord) (bool, error) {
	return store.RepairOwnerRow(ctx, journal)
}

// RetireOutputs (D-10) takes the value or authority row of every indexed vout of txid plus vout 0;
// at vout 0 it also drops the deploy metadata and the registry record of <txid>_0. KYC rows are
// kept (nothing records what they replaced). Idempotent; returns how many vouts had a row.
func RetireOutputs(ctx context.Context, store *Store, txid string) (int, error) {
	vouts, err := store.IndexedVoutsByTxid(ctx, txid)
	if err != nil {
		return 0, err
	}
	if !slices.Contains(vouts, 0) {
		vouts = append([]uint32{0}, vouts...)
	}
	retired := 0
	for _, vout := range vouts {
		took, err := takeRow(ctx, store, txid, vout)
		if err != nil {
			return retired, err
		}
		if took {
			retired++
		}
		if vout == 0 {
			tokenID := txid + "_0"
			if err := store.DeleteMetadata(ctx, tokenID); err != nil {
				return retired, err
			}
			if err := store.DeleteRegistryRecord(ctx, tokenID); err != nil {
				return retired, err
			}
		}
	}
	return retired, nil
}

// takeRow removes the outpoint's value row (debiting its owner once) or else its authority row.
func takeRow(ctx context.Context, store *Store, txid string, vout uint32) (bool, error) {
	row, err := store.TakeToken(ctx, txid, vout)
	if err != nil {
		return false, err
	}
	if row != nil {
		return true, store.AdjustBalance(ctx, row.IdentityKey, -int64(row.Amount))
	}
	a, err := store.TakeAuthority(ctx, txid, vout)
	if err != nil {
		return false, err
	}
	return a != nil, nil
}

package fuel

import (
	"context"
	"fmt"
	"sort"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/storage"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wdk"
)

// listLimit is the toolbox ListOutputs maximum page size.
const listLimit = uint32(10000)

// WalletSource is the production Source over a go-wallet-toolbox wallet and
// the storage client it writes through (for the row-level FindOutputsAuth
// view the BRC-100 surface does not expose: tx status and spent_by).
type WalletSource struct {
	w       *wallet.Wallet
	storage *storage.WalletStorageProviderClient
	kd      *sdk.KeyDeriver
	auth    wdk.AuthID
}

var _ Source = (*WalletSource)(nil)

// NewWalletSource wires a Source over the keeper's toolbox wallet. kd must be
// the key deriver of the wallet's own identity key.
func NewWalletSource(w *wallet.Wallet, sc *storage.WalletStorageProviderClient, kd *sdk.KeyDeriver) *WalletSource {
	return &WalletSource{w: w, storage: sc, kd: kd, auth: wdk.AuthID{IdentityKey: kd.IdentityKeyHex()}}
}

// IdentityKeyHex is the wallet's identity public key (compressed DER hex).
func (s *WalletSource) IdentityKeyHex() string { return s.kd.IdentityKeyHex() }

// ListProven intersects the basket listing (which carries BEEF) with the
// storage rows that are spendable and belong to a completed (proven) tx.
func (s *WalletSource) ListProven(ctx context.Context, basket string, max int) ([]Row, error) {
	if max <= 0 {
		return nil, nil
	}
	limit := listLimit
	list, err := s.w.ListOutputs(ctx, sdk.ListOutputsArgs{Basket: basket, Include: sdk.OutputIncludeEntireTransactions, Limit: &limit}, originator)
	if err != nil {
		return nil, fmt.Errorf("list fuel: %w", err)
	}
	inBasket := make(map[string]struct{}, len(list.Outputs))
	for _, o := range list.Outputs {
		inBasket[o.Outpoint.String()] = struct{}{} // "<txid>.<vout>" (go-sdk 1.5.1)
	}
	if len(inBasket) == 0 {
		return nil, nil
	}
	spendable := true
	rows, err := s.storage.FindOutputsAuth(ctx, s.auth, wdk.FindOutputsArgs{Spendable: &spendable, TxStatus: []wdk.TxStatus{wdk.TxStatusCompleted}})
	if err != nil {
		return nil, fmt.Errorf("find proven outputs: %w", err)
	}
	var beef *transaction.Beef
	if len(list.BEEF) > 0 {
		beef, err = transaction.NewBeefFromBytes(list.BEEF)
		if err != nil {
			return nil, fmt.Errorf("basket beef: %w", err)
		}
	}
	var out []Row
	for _, r := range rows {
		if r.TxID == nil || r.SpentBy != nil || !r.Spendable || r.Satoshis <= 0 {
			continue
		}
		op := fmt.Sprintf("%s.%d", *r.TxID, r.Vout)
		if _, ok := inBasket[op]; !ok {
			continue
		}
		var srcBeef []byte
		if beef != nil {
			// Only a tx carrying its own BUMP is proof material; a txid-only
			// or unproven entry is skipped rather than failing the listing.
			if tx := beef.FindTransaction(*r.TxID); tx != nil && tx.MerklePath != nil {
				srcBeef, err = tx.BEEF()
				if err != nil {
					return nil, fmt.Errorf("beef for %s: %w", op, err)
				}
			}
		}
		if len(srcBeef) == 0 {
			continue // no proof material → not usable as fuel (spec §4.3 step 4)
		}
		out = append(out, Row{
			Outpoint:         op,
			Txid:             *r.TxID,
			Vout:             r.Vout,
			Satoshis:         uint64(r.Satoshis),
			OutputID:         r.OutputID,
			LockingScript:    []byte(r.LockingScript),
			DerivationPrefix: deref(r.DerivationPrefix),
			DerivationSuffix: deref(r.DerivationSuffix),
			Beef:             srcBeef,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OutputID > out[j].OutputID })
	if len(out) > max {
		out = out[:max]
	}
	return out, nil
}

// Detach relinquishes the output from whatever basket holds it. The storage
// clears basket_name and drops the unreserved user-UTXO row; the output
// stays spendable, and relinquishing an already-detached output succeeds.
func (s *WalletSource) Detach(ctx context.Context, outpoint string) error {
	op, err := transaction.OutpointFromString(outpoint)
	if err != nil {
		return fmt.Errorf("detach %q: %w", outpoint, err)
	}
	if _, err = s.w.RelinquishOutput(ctx, sdk.RelinquishOutputArgs{Basket: "", Output: *op}, originator); err != nil {
		return fmt.Errorf("detach %s: %w", outpoint, err)
	}
	return nil
}

// StillSpendable reads the storage row: spendable && spent_by IS NULL. An
// unknown outpoint is reported as not spendable.
func (s *WalletSource) StillSpendable(ctx context.Context, outpoint string) (bool, error) {
	op, err := transaction.OutpointFromString(outpoint)
	if err != nil {
		return false, fmt.Errorf("still spendable %q: %w", outpoint, err)
	}
	txid := op.Txid.String()
	vout := op.Index
	rows, err := s.storage.FindOutputsAuth(ctx, s.auth, wdk.FindOutputsArgs{TxID: &txid, Vout: &vout})
	if err != nil {
		return false, fmt.Errorf("still spendable %s: %w", outpoint, err)
	}
	if len(rows) != 1 {
		return false, nil
	}
	return rows[0].Spendable && rows[0].SpentBy == nil, nil
}

// FeePubKeyHash derives the issuer-side fee key via the wallet (spec §1.2).
func (s *WalletSource) FeePubKeyHash(ctx context.Context, keyID string, requester *ec.PublicKey) ([]byte, error) {
	return feePubKeyHash(ctx, s.w, keyID, requester)
}

// Unlocker signs a toolbox change output (self→self BRC-29) with FuelSigHash.
func (s *WalletSource) Unlocker(prefix, suffix string) (transaction.UnlockingScriptTemplate, error) {
	return unlocker(s.IdentityKeyHex(), prefix, suffix, s.kd)
}

// Internalize hands a transaction to the wallet (e.g. a sweep's change).
func (s *WalletSource) Internalize(ctx context.Context, args sdk.InternalizeActionArgs) error {
	if _, err := s.w.InternalizeAction(ctx, args, originator); err != nil {
		return fmt.Errorf("internalize: %w", err)
	}
	return nil
}

// BalanceSats is the spendable total of the wallet's default change basket.
func (s *WalletSource) BalanceSats(ctx context.Context) (uint64, error) {
	b, err := s.w.Balance(ctx)
	if err != nil {
		return 0, fmt.Errorf("balance: %w", err)
	}
	return b, nil
}

package fuel

import (
	"context"
	"fmt"
	"log/slog"
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

// The in-process GORM provider is the production OutputsReader.
var _ OutputsReader = (*storage.Provider)(nil)

// WalletSource is the production Source. Wallet operations go through the
// toolbox wallet (HTTP storage); row-level reads go through reader, which
// must see the same storage the wallet writes to.
type WalletSource struct {
	w      *wallet.Wallet
	reader OutputsReader
	kd     *sdk.KeyDeriver
	auth   wdk.AuthID
	logger *slog.Logger
}

var _ Source = (*WalletSource)(nil)

// NewWalletSource wires a Source over the keeper's toolbox wallet. kd must be
// the key deriver of the wallet's own identity key and userID that identity's
// storage user (provider.FindOrInsertUser): Provider.FindOutputsAuth rejects
// an AuthID without a UserID. A nil logger means slog.Default().
func NewWalletSource(w *wallet.Wallet, reader OutputsReader, kd *sdk.KeyDeriver, userID int, logger *slog.Logger) *WalletSource {
	if logger == nil {
		logger = slog.Default()
	}
	uid := userID
	return &WalletSource{
		w:      w,
		reader: reader,
		kd:     kd,
		auth:   wdk.AuthID{IdentityKey: kd.IdentityKeyHex(), UserID: &uid},
		logger: logger,
	}
}

// IdentityKeyHex is the wallet's identity public key (compressed DER hex).
func (s *WalletSource) IdentityKeyHex() string { return s.kd.IdentityKeyHex() }

// ListProven intersects the basket listing (which carries BEEF) with the
// storage rows that are self-owned change, spendable, unspent, worth at least
// minSats and belong to a completed (proven) tx.
func (s *WalletSource) ListProven(ctx context.Context, basket string, max int, minSats uint64) ([]Row, error) {
	if max <= 0 {
		return nil, nil
	}
	limit := listLimit
	list, err := s.w.ListOutputs(ctx, sdk.ListOutputsArgs{Basket: basket, Include: sdk.OutputIncludeEntireTransactions, Limit: &limit}, originator)
	if err != nil {
		return nil, fmt.Errorf("list fuel: %w", err)
	}
	inBasket := make(map[string]sdk.Output, len(list.Outputs))
	for _, o := range list.Outputs {
		inBasket[o.Outpoint.String()] = o // "<txid>.<vout>" (go-sdk 1.5.1)
	}
	if len(inBasket) == 0 {
		return nil, nil
	}
	spendable, change := true, true
	rows, err := s.reader.FindOutputsAuth(ctx, s.auth, wdk.FindOutputsArgs{
		Spendable: &spendable,
		Change:    &change,
		TxStatus:  []wdk.TxStatus{wdk.TxStatusCompleted},
	})
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
	out, skipped := selectProven(rows, inBasket, beef, s.IdentityKeyHex(), minSats)
	if skipped > 0 {
		s.logger.WarnContext(ctx, "fuel rows skipped: no proof material in basket BEEF",
			slog.String("basket", basket),
			slog.Int("skipped", skipped),
			slog.Int("basket_size", len(inBasket)),
			slog.Int("usable", len(out)),
		)
	}
	if len(out) > max {
		out = out[:max]
	}
	return out, nil
}

// selectProven keeps the storage rows usable as fuel, sorted OutputID desc:
// in the basket listing, spendable, unspent, change, positive value of at
// least minSats, with a BRC-29 derivation, not locked by a foreign sender (the
// unlocker assumes a self→self lock) and with the tx and its own BUMP present
// in beef. skipped counts otherwise-eligible rows dropped only for missing
// proof material (absent, txid-only or unproven BEEF entry); a row under
// minSats is not otherwise eligible and is not counted.
func selectProven(rows wdk.TableOutputs, inBasket map[string]sdk.Output, beef *transaction.Beef, self string, minSats uint64) (out []Row, skipped int) {
	for _, r := range rows {
		if r.TxID == nil || r.SpentBy != nil || !r.Spendable || !r.Change || r.Satoshis <= 0 || uint64(r.Satoshis) < minSats {
			continue
		}
		if r.SenderIdentityKey != nil && *r.SenderIdentityKey != self {
			continue
		}
		prefix, suffix := deref(r.DerivationPrefix), deref(r.DerivationSuffix)
		if prefix == "" || suffix == "" {
			continue
		}
		op := fmt.Sprintf("%s.%d", *r.TxID, r.Vout)
		if _, ok := inBasket[op]; !ok {
			continue
		}
		var srcBeef []byte
		if beef != nil {
			if tx := beef.FindTransaction(*r.TxID); tx != nil && tx.MerklePath != nil {
				if b, err := tx.BEEF(); err == nil {
					srcBeef = b
				}
			}
		}
		if len(srcBeef) == 0 {
			skipped++ // no proof material → not usable as fuel (spec §4.3 step 4)
			continue
		}
		out = append(out, Row{
			Outpoint:         op,
			Txid:             *r.TxID,
			Vout:             r.Vout,
			Satoshis:         uint64(r.Satoshis),
			OutputID:         r.OutputID,
			LockingScript:    []byte(r.LockingScript),
			DerivationPrefix: prefix,
			DerivationSuffix: suffix,
			Beef:             srcBeef,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OutputID > out[j].OutputID })
	return out, skipped
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

// StillSpendable reads the storage row: true only when exactly one row
// exists and it is spendable with spent_by NULL. Zero or several rows are an
// error, so an output the reader cannot see is never treated as spent.
func (s *WalletSource) StillSpendable(ctx context.Context, outpoint string) (bool, error) {
	op, err := transaction.OutpointFromString(outpoint)
	if err != nil {
		return false, fmt.Errorf("still spendable %q: %w", outpoint, err)
	}
	txid := op.Txid.String()
	vout := op.Index
	rows, err := s.reader.FindOutputsAuth(ctx, s.auth, wdk.FindOutputsArgs{TxID: &txid, Vout: &vout})
	if err != nil {
		return false, fmt.Errorf("still spendable %s: %w", outpoint, err)
	}
	if len(rows) != 1 {
		return false, fmt.Errorf("still spendable %s: storage returned %d rows, want 1", outpoint, len(rows))
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

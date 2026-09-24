// Package fuel is the keeper's view of its own fuel: the proven, spendable
// satoshi outputs held by the go-wallet-toolbox wallet, the fee key it derives
// per requester, and the unlocker it signs fuel inputs with.
package fuel

import (
	"context"
	"errors"
	"fmt"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/brc29"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wdk"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

// Row is one spendable, proven fuel output as the toolbox storage sees it.
type Row struct {
	Outpoint         string // "<txid>.<vout>"
	Txid             string
	Vout             uint32
	Satoshis         uint64
	OutputID         uint
	LockingScript    []byte
	DerivationPrefix string
	DerivationSuffix string
	Beef             []byte // BEEF (with BUMPs) of the source tx
}

// Source is everything the keeper needs from its wallet.
type Source interface {
	IdentityKeyHex() string
	// ListProven returns at most max rows that are in basket, spendable,
	// unspent and belong to a completed (proven) tx, sorted OutputID desc.
	ListProven(ctx context.Context, basket string, max int) ([]Row, error)
	// Detach removes the output from every basket (RelinquishOutput with
	// basket "") so the toolbox never selects it as change. It stays
	// spendable; Detach is idempotent.
	Detach(ctx context.Context, outpoint string) error
	// StillSpendable reports spendable && spent_by IS NULL for the output.
	// An unknown (or ambiguous) output is an error, never "spent": a caller
	// must not drop fuel it cannot see.
	StillSpendable(ctx context.Context, outpoint string) (bool, error)
	// FeePubKeyHash is the issuer-side fee key hash for requester (spec §1.2).
	FeePubKeyHash(ctx context.Context, keyID string, requester *ec.PublicKey) ([]byte, error)
	// Unlocker signs a fuel input locked by the toolbox as self→self BRC-29
	// change, with SINGLE|ANYONECANPAY|FORKID.
	Unlocker(prefix, suffix string) (transaction.UnlockingScriptTemplate, error)
	Internalize(ctx context.Context, args sdk.InternalizeActionArgs) error
	BalanceSats(ctx context.Context) (uint64, error)
}

// OutputsReader is the row-level storage view (tx status, spent_by, change)
// the BRC-100 surface does not expose. In production it is the in-process
// *storage.Provider: the toolbox HTTP storage client's FindOutputsAuth is a
// stub that always returns no rows (go-wallet-toolbox v0.186.3).
type OutputsReader interface {
	FindOutputsAuth(ctx context.Context, auth wdk.AuthID, filters wdk.FindOutputsArgs) (wdk.TableOutputs, error)
}

// FuelSigHash is the sighash every fuel input is signed with (0xC3): the
// fuel input commits only to its paired output and lets the requester add
// the rest of the transaction.
var FuelSigHash = sighash.SingleForkID | sighash.AnyOneCanPay // 0xC3

// originator is the BRC-100 originator the keeper presents to its wallet.
const originator = "fuelkeeper"

// feePubKeyHash derives the issuer-side fee key for a requester (spec §1.2).
func feePubKeyHash(ctx context.Context, pw interface {
	GetPublicKey(context.Context, sdk.GetPublicKeyArgs, string) (*sdk.GetPublicKeyResult, error)
}, keyID string, requester *ec.PublicKey) ([]byte, error) {
	if requester == nil {
		return nil, errors.New("fee key: requester public key is required")
	}
	forSelf := true
	res, err := pw.GetPublicKey(ctx, sdk.GetPublicKeyArgs{
		EncryptionArgs: sdk.EncryptionArgs{
			ProtocolID:   token.FTProtocol,
			KeyID:        keyID,
			Counterparty: sdk.Counterparty{Type: sdk.CounterpartyTypeOther, Counterparty: requester},
		},
		ForSelf: &forSelf,
	}, originator)
	if err != nil {
		return nil, fmt.Errorf("fee key: %w", err)
	}
	if res == nil || res.PublicKey == nil {
		return nil, errors.New("fee key: wallet returned no public key")
	}
	return res.PublicKey.Hash(), nil
}

// unlocker builds the toolbox change-input unlocker with the fuel sighash.
// The toolbox locks change with brc29.LockForCounterparty(kd, keyID, kd), so
// the sender is our own identity key and the recipient is our own deriver.
func unlocker(identityHex, prefix, suffix string, kd *sdk.KeyDeriver) (transaction.UnlockingScriptTemplate, error) {
	f := FuelSigHash
	tpl, err := brc29.Unlock(brc29.PubHex(identityHex), brc29.KeyID{DerivationPrefix: prefix, DerivationSuffix: suffix}, kd, brc29.WithSigHash(&f))
	if err != nil {
		return nil, fmt.Errorf("fuel unlocker: %w", err)
	}
	return tpl, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

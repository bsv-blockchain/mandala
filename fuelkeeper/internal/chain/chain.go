// Package chain is the keeper's on-chain spend check for sweeper rules 2 and
// 4 (spec §4.7): is a fuel output still unspent on chain?
//
// An error is never an answer. Callers must leave a row unchanged when the
// check fails, so a missing or rate-limited chain service delays a release
// but can never cause one.
package chain

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

// Checker reports whether outpoint ("<txid>.<vout>"), locked by the hex
// locking script fuelScriptHex, is unspent on chain.
type Checker interface {
	IsUnspent(ctx context.Context, fuelScriptHex, outpoint string) (bool, error)
}

// ErrDisabled is what Disabled returns for every check.
var ErrDisabled = errors.New("chain check disabled: set FK_WOC_API_KEY")

// Disabled is the Checker used when no chain service is configured. It
// always fails, so rows awaiting a chain check stay pending (never released).
type Disabled struct{}

// IsUnspent always returns ErrDisabled.
func (Disabled) IsUnspent(context.Context, string, string) (bool, error) { return false, ErrDisabled }

// UTXOLookup is the one toolbox services call the checker needs; the
// production value is go-wallet-toolbox's *services.WalletServices (its
// IsUtxo is the WhatsOnChain script-hash UTXO lookup; ARC has none). Taking
// the interface keeps pkg/services, and its large dependency graph, out of
// this package: only the process wiring imports it.
type UTXOLookup interface {
	IsUtxo(ctx context.Context, scriptHash string, outpoint *transaction.Outpoint) (bool, error)
}

type servicesChecker struct{ u UTXOLookup }

// NewServicesChecker checks through s.IsUtxo (pass a non-nil toolbox
// *services.WalletServices; a typed nil pointer is not detected here). A nil
// interface yields Disabled.
func NewServicesChecker(s UTXOLookup) Checker {
	if s == nil {
		return Disabled{}
	}
	return servicesChecker{u: s}
}

// IsUnspent validates both arguments, then asks
// IsUtxo(token.ScriptHash(script), outpoint).
func (c servicesChecker) IsUnspent(ctx context.Context, fuelScriptHex, outpoint string) (bool, error) {
	lock, err := hex.DecodeString(fuelScriptHex)
	if err != nil || len(lock) == 0 {
		return false, fmt.Errorf("chain check %s: fuel script is empty or not hex", outpoint)
	}
	op, err := transaction.OutpointFromString(outpoint)
	if err != nil || op.String() != outpoint {
		return false, fmt.Errorf("chain check: outpoint %q is not canonical <txid>.<vout>", outpoint)
	}
	unspent, err := c.u.IsUtxo(ctx, token.ScriptHash(lock), op)
	if err != nil {
		return false, fmt.Errorf("chain check %s: %w", outpoint, err)
	}
	return unspent, nil
}

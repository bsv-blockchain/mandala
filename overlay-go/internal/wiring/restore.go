package wiring

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/bsv-blockchain/go-sdk/chainhash"

	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// inputRestoreError is every error restoreLiveInputs returns. It names the spent outpoint whose owner row could not be
// restored, so eviction can answer "could not restore the owner row for <op>; retry" (overlay/src/eviction.ts).
type inputRestoreError struct {
	Outpoint string
	Err      error
}

func (e *inputRestoreError) Error() string {
	return fmt.Sprintf("restore input %s: %v", e.Outpoint, e.Err)
}

func (e *inputRestoreError) Unwrap() error { return e.Err }

// restoreLiveInputs hands back the owner rows of spent inputs from the owner journal (D-7, TT §6.5). For each outpoint
// it reads every journal row (one per topic that admitted the coin) and restores a row only while the engine shows the
// coin unspent on THAT row's topic: a coin another live transaction has spent since, or one the engine no longer
// holds, keeps no row (the TS never-clobber rule). mandala.RestoreInputRow upserts and credits on insert only, so a
// repeat is harmless; the count is of rows actually inserted. Every read or write fault fails closed. A malformed
// outpoint names no coin and is skipped.
func restoreLiveInputs(ctx context.Context, es *enginestore.Store, store *mandala.Store, spentOutpoints []string) (int, error) {
	restored := 0
	for _, op := range spentOutpoints {
		txid, vout, ok := parseOutpoint(op)
		if !ok {
			continue
		}
		label := fmt.Sprintf("%s.%d", txid, vout)
		rows, err := store.OwnerJournalByOutpoint(ctx, txid, vout)
		if err != nil {
			return restored, &inputRestoreError{Outpoint: label, Err: err}
		}
		for _, row := range rows {
			live, err := es.IsUnspent(ctx, row.Topic, txid, vout)
			if err != nil {
				return restored, &inputRestoreError{Outpoint: label, Err: err}
			}
			if !live {
				continue
			}
			inserted, err := mandala.RestoreInputRow(ctx, store, row)
			if err != nil {
				return restored, &inputRestoreError{Outpoint: label, Err: err}
			}
			if inserted {
				restored++
			}
		}
	}
	return restored, nil
}

// parseOutpoint splits a "<64-hex txid>.<vout>" outpoint, lowercasing the txid; anything else is not an outpoint.
func parseOutpoint(s string) (string, uint32, bool) {
	dot := strings.LastIndexByte(s, '.')
	if dot != 64 {
		return "", 0, false
	}
	txid := strings.ToLower(s[:dot])
	if _, err := chainhash.NewHashFromHex(txid); err != nil {
		return "", 0, false
	}
	n, err := strconv.ParseUint(s[dot+1:], 10, 32)
	if err != nil {
		return "", 0, false
	}
	return txid, uint32(n), true
}

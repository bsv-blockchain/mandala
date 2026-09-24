// Package settle credits the issuer's fee outputs (spec §4.6, POST /settle):
// every fuel pair a consumed transaction spent is internalized into the
// keeper wallet's token basket, then its reservation row is marked settled.
//
// Settle is idempotent. A repeat re-internalizes (the toolbox merges a known
// tx) and leaves already-settled rows as they are; an unknown txid is a
// no-op. Nothing is internalized unless every row of the txid matches the
// transaction: the subject txid, an input spending the row's fuel outpoint,
// and the committed fee script at the paired output index. A request that can
// never succeed (malformed txid or BEEF, a BEEF that does not carry the txid,
// a transaction that does not match its rows) fails with ErrInvalid; every
// other failure is transient and worth a retry.
package settle

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

// Basket is the keeper wallet basket fee outputs are inserted into.
const Basket = "mandala-tokens"

// txidRe is the only txid form stored rows carry (the overlay lowercases).
var txidRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ErrInvalid wraps every permanent settle failure: a txid that is not 64
// lowercase hex, BEEF bytes that do not parse, a BEEF whose subject or
// content is not the txid, a transaction that does not spend a row's fuel
// outpoint, or a paired output that is not the committed fee script. The same
// request can never succeed, so the API answers 400 and alerts instead of
// inviting a retry.
var ErrInvalid = errors.New("settle: invalid request")

func invalid(format string, a ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, a...))
}

// Settler runs §4.6. Safe for concurrent use: two settles of one txid both
// internalize (the toolbox merges) and the row CAS converges. settled_at is
// stamped by the store's own clock.
type Settler struct {
	st  *store.Store
	src fuel.Source
}

// New returns a Settler.
func New(st *store.Store, src fuel.Source) *Settler {
	return &Settler{st: st, src: src}
}

// customInstructions is the token output bookkeeping the issuer wallet needs
// to spend the fee later: walletMandalaUnlock(keyID, counterparty) under
// FT_PROTOCOL (the same shape the lib writes for its own token outputs).
type customInstructions struct {
	ProtocolID   [2]any `json:"protocolID"`
	KeyID        string `json:"keyID"`
	Counterparty string `json:"counterparty"`
}

// plan is one row's resolved internalize target.
type plan struct {
	row  store.Reservation
	vout uint32
}

// Settle internalizes the fee output of every reservation row carrying txid
// in consumed | released | spent_external, then CAS-marks it consumed with
// settled_at (which also repairs a wrongful release). It returns the number
// of rows internalized. beefBytes may be AtomicBEEF (used as is) or plain
// BEEF (re-framed as AtomicBEEF for txid). An unknown txid returns (0, nil).
func (s *Settler) Settle(ctx context.Context, txid string, beefBytes []byte) (int, error) {
	if !txidRe.MatchString(txid) {
		return 0, invalid("txid %q is not 64 lowercase hex", txid)
	}
	atomic, tx, err := atomicBeef(txid, beefBytes)
	if err != nil {
		return 0, err
	}
	rows, err := s.st.ByTxid(ctx, txid)
	if err != nil {
		return 0, fmt.Errorf("settle: rows: %w", err)
	}

	// Resolve every row before touching the wallet: one mismatch means the
	// rows and the transaction disagree, and nothing is credited.
	var plans []plan
	for _, r := range rows {
		switch r.Status {
		case store.StatusConsumed, store.StatusReleased, store.StatusSpentExternal:
		default:
			continue
		}
		vout, err := feeOutputIndex(tx, r)
		if err != nil {
			return 0, fmt.Errorf("settle %s: %w", txid, err) // ErrInvalid for a mismatch
		}
		plans = append(plans, plan{row: r, vout: vout})
	}

	n := 0
	for _, p := range plans {
		r := p.row
		ci, err := json.Marshal(customInstructions{
			ProtocolID:   [2]any{int(token.FTProtocol.SecurityLevel), token.FTProtocol.Protocol},
			KeyID:        r.KeyID,
			Counterparty: r.Requester,
		})
		if err != nil {
			return n, fmt.Errorf("settle %s: custom instructions: %w", r.Outpoint, err)
		}
		args := sdk.InternalizeActionArgs{
			Tx: atomic,
			Outputs: []sdk.InternalizeOutput{{
				OutputIndex: p.vout,
				Protocol:    sdk.InternalizeProtocolBasketInsertion,
				InsertionRemittance: &sdk.BasketInsertion{
					Basket:             Basket,
					CustomInstructions: string(ci),
					Tags:               []string{"mandala", "fee", r.AssetID},
				},
			}},
			Description: "Fee for " + txid,
		}
		if err := s.src.Internalize(ctx, args); err != nil {
			return n, fmt.Errorf("settle %s: internalize: %w", r.Outpoint, err)
		}
		// An already-settled row keeps its original settled_at; the repeat
		// internalize above was the harmless known-tx merge.
		if !(r.Status == store.StatusConsumed && r.SettledAt != nil) {
			if _, err := s.st.MarkSettled(ctx, r.Outpoint, txid); err != nil {
				return n, fmt.Errorf("settle %s: mark settled: %w", r.Outpoint, err)
			}
			// A row carrying this txid only ever moves between consumed,
			// released and spent_external (no re-drafting, spec §13 rev 3),
			// all of which MarkSettled matches, so a CAS miss is not
			// expected; the fee is real and is credited above either way.
		}
		n++
	}
	return n, nil
}

// atomicBeef returns AtomicBEEF bytes whose subject is txid, and the subject
// transaction. AtomicBEEF input is passed through unchanged after checking
// its subject; anything else is parsed as BEEF and re-framed.
func atomicBeef(txid string, beefBytes []byte) ([]byte, *transaction.Transaction, error) {
	h, err := chainhash.NewHashFromHex(txid)
	if err != nil {
		return nil, nil, invalid("txid: %v", err)
	}
	var (
		b      *transaction.Beef
		atomic []byte
	)
	if len(beefBytes) >= 4 && binary.LittleEndian.Uint32(beefBytes[:4]) == transaction.ATOMIC_BEEF {
		var subject *chainhash.Hash
		b, subject, err = transaction.NewBeefFromAtomicBytes(beefBytes)
		if err != nil {
			return nil, nil, invalid("atomic beef: %v", err)
		}
		if !subject.IsEqual(h) {
			return nil, nil, invalid("atomic beef subject %s is not %s", subject, txid)
		}
		atomic = beefBytes
	} else {
		b, err = transaction.NewBeefFromBytes(beefBytes)
		if err != nil {
			return nil, nil, invalid("beef: %v", err)
		}
		atomic, err = b.AtomicBytes(h)
		if err != nil {
			return nil, nil, invalid("atomic: %v", err)
		}
	}
	tx := b.FindTransactionByHash(h)
	if tx == nil {
		return nil, nil, invalid("beef does not carry transaction %s", txid)
	}
	return atomic, tx, nil
}

// feeOutputIndex finds the input spending r's fuel outpoint; its paired
// output (same index, SIGHASH_SINGLE) must carry the committed fee script.
// Normally that index is r.PairIndex; the fuel signatures commit to the
// pairing, not to the position, so the pair's actual index is what is
// credited.
func feeOutputIndex(tx *transaction.Transaction, r store.Reservation) (uint32, error) {
	fee, err := hex.DecodeString(r.FeeScript)
	if err != nil || len(fee) == 0 {
		return 0, fmt.Errorf("row %s has no fee script", r.Outpoint)
	}
	vin := -1
	for i, in := range tx.Inputs {
		if in.SourceTXID != nil && fmt.Sprintf("%s.%d", in.SourceTXID, in.SourceTxOutIndex) == r.Outpoint {
			vin = i
			break
		}
	}
	if vin < 0 {
		return 0, invalid("transaction does not spend fuel %s", r.Outpoint)
	}
	if vin >= len(tx.Outputs) || tx.Outputs[vin].LockingScript == nil {
		return 0, invalid("fuel %s at input %d has no paired output", r.Outpoint, vin)
	}
	if !bytes.Equal(*tx.Outputs[vin].LockingScript, fee) {
		return 0, invalid("output %d is not the fee output committed for %s", vin, r.Outpoint)
	}
	return uint32(vin), nil
}

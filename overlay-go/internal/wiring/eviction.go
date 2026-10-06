package wiring

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/maintenance"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// evictDeps are the stores eviction mutates and the quiesce that keeps it off every live fold and reconcile.
type evictDeps struct {
	es      *enginestore.Store
	store   *mandala.Store
	quiesce func(ctx context.Context, fn func(context.Context) error) error
}

// evictError's Error() is the retry text of overlay/src/eviction.ts exactly (the /arc-ingest 503 carries it); Unwrap()
// is the dependency fault behind it.
type evictError struct {
	msg   string
	cause error
}

func (e *evictError) Error() string { return e.msg }
func (e *evictError) Unwrap() error { return e.cause }

// evictTx is the /arc-ingest terminal-status eviction (TT §6.5): the exact inverse of admission for inputs, per topic.
// The whole run holds the reconcile lock and then the submit gate exclusively. Order:
//  1. read the admission record (fails closed: an unreadable record means we do not know what to restore);
//  2. unless already evicted, unmark every engine-side spend by this txid (all topics) and restore the owner rows of
//     its inputs from the owner journal, per journal row and only where the engine shows the coin live again on that
//     row's topic (D-7);
//  3. stamp evictedAt — only now, so a failed restore never publishes "its inputs are spendable again" over coins that
//     are still marked spent;
//  4. retire the evicted tx's own index rows (D-10: value rows debit their owner, authority rows go, and at vout 0 the
//     deploy metadata and registry record), which also covers tokens this overlay no longer hosts;
//  5. delete its engine outputs on every topic;
//  6. delete its applied records on every topic;
//  7. purge its history rows and refold every token they touched.
//
// Steps 3–7 run on a repeat callback too (all idempotent), so a retry after any failure converges.
func evictTx(d evictDeps) func(ctx context.Context, txid string) (mandala.EvictionOutcome, error) {
	return func(ctx context.Context, txid string) (mandala.EvictionOutcome, error) {
		var out mandala.EvictionOutcome
		run := func(ctx context.Context) error {
			o, err := evictOnce(ctx, d, txid)
			out = o
			return err
		}
		if d.quiesce == nil {
			err := run(ctx)
			return out, err
		}
		err := d.quiesce(ctx, run)
		var busy *maintenance.BusyError
		if errors.As(err, &busy) {
			return mandala.EvictionOutcome{}, &evictError{msg: fmt.Sprintf("the overlay is busy with maintenance, so %s could not be evicted; retry", txid), cause: err}
		}
		return out, err
	}
}

func evictOnce(ctx context.Context, d evictDeps, txid string) (mandala.EvictionOutcome, error) {
	var out mandala.EvictionOutcome
	rec, err := d.store.GetAdmission(ctx, txid)
	if err != nil {
		return out, &evictError{msg: fmt.Sprintf("the admission record for %s could not be read, so its inputs cannot be restored; retry", txid), cause: err}
	}
	out.AlreadyEvicted = rec != nil && rec.EvictedAt != ""

	if !out.AlreadyEvicted {
		unmarked, err := d.es.UnmarkSpentBySpendTxid(ctx, txid)
		if err != nil {
			return out, &evictError{msg: fmt.Sprintf("could not restore the spent inputs of %s; retry", txid), cause: err}
		}
		out.RestoredOutpoints = int(unmarked)
		var spent []string
		if rec != nil && rec.Restore != nil {
			spent = rec.Restore.SpentOutpoints
		} else {
			log.Printf("wiring: evicting %s with no restore snapshot on record: spends unmarked, no owner row to restore", txid)
		}
		restored, err := restoreLiveInputs(ctx, d.es, d.store, spent)
		if err != nil {
			op := txid
			var ie *inputRestoreError
			if errors.As(err, &ie) {
				op = ie.Outpoint
			}
			return out, &evictError{msg: fmt.Sprintf("could not restore the owner row for %s; retry", op), cause: err}
		}
		out.RestoredTokenRows = restored
	}

	if err := d.store.MarkEvicted(ctx, txid); err != nil {
		return out, &evictError{msg: fmt.Sprintf("the eviction of %s could not be recorded; retry", txid), cause: err}
	}
	if _, err := mandala.RetireOutputs(ctx, d.store, txid); err != nil {
		return out, &evictError{msg: fmt.Sprintf("could not retire the index rows of %s; retry", txid), cause: err}
	}
	if err := d.es.DeleteOutputsByTxid(ctx, txid); err != nil {
		return out, &evictError{msg: fmt.Sprintf("could not delete the engine records of %s; retry", txid), cause: err}
	}
	if err := d.es.DeleteAppliedTransactionsByTxid(ctx, txid); err != nil {
		return out, &evictError{msg: fmt.Sprintf("could not delete the engine records of %s; retry", txid), cause: err}
	}
	if _, err := mandala.PurgeAndRefold(ctx, d.store, txid); err != nil {
		return out, &evictError{msg: fmt.Sprintf("could not refold the tokens touched by %s; retry", txid), cause: err}
	}
	return out, nil
}

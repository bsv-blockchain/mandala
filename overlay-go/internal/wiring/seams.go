package wiring

import (
	"context"
	"fmt"
	"log"
	"regexp"

	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

var lowerTxid = regexp.MustCompile(`^[0-9a-f]{64}$`)

// spendCheckerFunc adapts a func to mandala.SpendChecker.
type spendCheckerFunc func(ctx context.Context, topic, txid string, vout uint32) (string, error)

func (f spendCheckerFunc) SpentBy(ctx context.Context, topic, txid string, vout uint32) (string, error) {
	return f(ctx, topic, txid, vout)
}

var _ mandala.SpendChecker = spendCheckerFunc(nil)

// spendChecker is the conflicting-spend guard's view (D-6), shared by every token topic: the engine says which
// transaction marked (topic, txid.vout) spent, and the admission record says whether that transaction was later
// evicted, in which case its spend was undone and the coin reads live. "" means live or absent.
func spendChecker(es *enginestore.Store, store *mandala.Store) mandala.SpendChecker {
	return spendCheckerFunc(func(ctx context.Context, topic, txid string, vout uint32) (string, error) {
		spendTxid, err := es.SpendStateOf(ctx, topic, txid, vout)
		if err != nil {
			return "", fmt.Errorf("wiring: spend state of %s.%d on %s: %w", txid, vout, topic, err)
		}
		if spendTxid == "" {
			return "", nil
		}
		rec, err := store.GetAdmission(ctx, spendTxid)
		if err != nil {
			return "", fmt.Errorf("wiring: admission record of %s: %w", spendTxid, err)
		}
		if rec != nil && rec.EvictedAt != "" {
			return "", nil
		}
		return spendTxid, nil
	})
}

// appliedAdmissionProof is the engine's own durable proof of admission, per topic: every topic with an applied record
// for txid, mapped to the output indexes it holds for it (ascending, spent included; [] when none). A non-txid has
// nothing applied. /submit's known-verdict rule (D-8) and GET /admin/admission/:txid read it.
func appliedAdmissionProof(es *enginestore.Store) func(ctx context.Context, txid string) (map[string][]uint32, error) {
	return func(ctx context.Context, txid string) (map[string][]uint32, error) {
		proof := map[string][]uint32{}
		if !lowerTxid.MatchString(txid) {
			return proof, nil
		}
		topics, err := es.AppliedTopics(ctx, txid)
		if err != nil {
			return nil, fmt.Errorf("wiring: applied topics of %s: %w", txid, err)
		}
		for _, topic := range topics {
			outs, err := es.AdmittedOutputIndexes(ctx, topic, txid)
			if err != nil {
				return nil, fmt.Errorf("wiring: admitted outputs of %s on %s: %w", txid, topic, err)
			}
			proof[topic] = outs
		}
		return proof, nil
	}
}

// prepareSubmitCompensation snapshots, before Submit, every input the transaction spends (the restore snapshot the
// admission record keeps, D-7) and returns the compensation /submit runs only on a broadcast failure: the pinned engine
// marks inputs spent before it broadcasts and never unwinds. A named topic that already has an applied record means
// this is a duplicate resubmit of a committed transaction, so nothing is undone. Otherwise the transaction's spends are
// unmarked (every topic) and the owner rows of coins that are live again come back from the journal.
func prepareSubmitCompensation(es *enginestore.Store, store *mandala.Store) func(ctx context.Context, beef []byte, topics []string) (func(context.Context) error, *mandala.RestoreSnapshot, error) {
	return func(ctx context.Context, beefBytes []byte, topics []string) (func(context.Context) error, *mandala.RestoreSnapshot, error) {
		_, tx, id, err := transaction.ParseBeef(beefBytes)
		if err != nil || tx == nil {
			// Engine.Submit parses the same bytes first and refuses them before marking anything.
			return nil, nil, nil
		}
		if id == nil {
			id = tx.TxID()
		}
		spendTxid := id.String()
		spent := make([]string, 0, len(tx.Inputs))
		for _, in := range tx.Inputs {
			if in.SourceTXID == nil {
				continue
			}
			spent = append(spent, fmt.Sprintf("%s.%d", in.SourceTXID.String(), in.SourceTxOutIndex))
		}
		restore := &mandala.RestoreSnapshot{SpentOutpoints: spent}
		named := append([]string(nil), topics...)
		return func(ctx context.Context) error {
			for _, topic := range named {
				applied, err := es.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: id, Topic: topic})
				if err != nil {
					return fmt.Errorf("wiring: applied-transaction record of %s on %s: %w", spendTxid, topic, err)
				}
				if applied {
					log.Printf("wiring: skipping compensation: %s is already applied on %s (duplicate resubmit)", spendTxid, topic)
					return nil
				}
			}
			if _, err := es.UnmarkSpentBySpendTxid(ctx, spendTxid); err != nil {
				return fmt.Errorf("wiring: unmark spends of %s: %w", spendTxid, err)
			}
			if _, err := restoreLiveInputs(ctx, es, store, restore.SpentOutpoints); err != nil {
				return fmt.Errorf("wiring: restore inputs spent by %s: %w", spendTxid, err)
			}
			return nil
		}, restore, nil
	}
}

// journalTokenIDs is the boot union's second source (TT §6.2.1): every token whose topic appears in the owner journal,
// which covers a token whose tm_mandala record write failed after its token topic admitted outputs. KYC and malformed
// topics are filtered out.
func journalTokenIDs(store *mandala.Store) TokenIDSource {
	return func(ctx context.Context) ([]string, error) {
		topics, err := store.DistinctOwnerTopics(ctx)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(topics))
		for _, topic := range topics {
			if id, ok := mandala.TokenIDOfTopic(topic); ok {
				ids = append(ids, id)
			}
		}
		return ids, nil
	}
}

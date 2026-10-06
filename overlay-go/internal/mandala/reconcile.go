package mandala

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// DefaultReconcileBatch is the engine page size when ReconcileDeps.BatchSize is 0 (TS DEFAULT_BATCH).
const DefaultReconcileBatch = 200

// ReconcileResult is one topic's pass.
type ReconcileResult struct {
	Scanned      int      // admitted outputs the engine listed
	Repaired     int      // rows inserted or corrected from the journal (a take-back is not counted)
	Unrepairable []string // "<txid>.<vout>" of every output whose row is wrong and the journal cannot repair
}

// ReconcileStore is the slice of the store the reconciler reads, repairs and undoes.
type ReconcileStore interface {
	GetTokenRow(ctx context.Context, txid string, vout uint32) (*TokenRecord, error)
	GetAuthorityRow(ctx context.Context, txid string, vout uint32) (*AuthorityRecord, error)
	GetOwnerJournal(ctx context.Context, txid string, vout uint32, topic string) (*OwnerRecord, error)
	RepairOwnerRow(ctx context.Context, journal OwnerRecord) (bool, error)
	RepairUndoStore
}

// ReconcileDeps configures one topic's pass.
type ReconcileDeps struct {
	Store     ReconcileStore
	Engine    EngineOutputReader
	Topic     string
	BatchSize int                                  // 0 -> DefaultReconcileBatch; < 0 -> error
	OnRepair  func(outpoint string, inserted bool) // nil -> LogOwnerRepair("reconcileOwnerIndex")
}

var errReconcileBatchSize = errors.New("reconcileOwnerIndex: batchSize must be a positive integer")

type reconcileOutcome int

const (
	reconcileOK reconcileOutcome = iota
	reconcileRepaired
	reconcileUnrepairable
)

// reconcileToken is what the engine's own copy of the output says.
type reconcileToken struct {
	tokenID string
	role    brc162.Role
	amount  uint64
}

// ReconcileOwnerIndex is D §4.2a rule 5, a port of reconcile.ts (F/ts-layers §11): it pages the engine's unspent
// admitted outputs of d.Topic in keyset order and reconciles each one — ok when the row agrees or the engine no longer
// reads the output; repaired from an agreeing owner-journal row (taken back when the engine spent the coin meanwhile);
// otherwise unrepairable. Every engine or store fault propagates and the caller reruns; repairs are idempotent upserts.
func ReconcileOwnerIndex(ctx context.Context, d ReconcileDeps) (ReconcileResult, error) {
	limit := d.BatchSize
	if limit == 0 {
		limit = DefaultReconcileBatch
	}
	if limit < 0 {
		return ReconcileResult{}, errReconcileBatchSize
	}
	onRepair := d.OnRepair
	if onRepair == nil {
		onRepair = LogOwnerRepair("reconcileOwnerIndex")
	}
	result := ReconcileResult{Unrepairable: []string{}}
	var cursor *transaction.Outpoint
	for {
		page, err := d.Engine.ListUnspentAdmittedOutputs(ctx, d.Topic, cursor, limit)
		if err != nil {
			return ReconcileResult{}, err
		}
		// A page that ends where the last one did would be read forever.
		if cursor != nil && len(page) > 0 && page[len(page)-1] == *cursor {
			return ReconcileResult{}, fmt.Errorf("reconcileOwnerIndex: the engine listing did not advance past %s", reconcileLabel(*cursor))
		}
		for _, op := range page {
			result.Scanned++
			outcome, err := reconcileOne(ctx, d, op, onRepair)
			if err != nil {
				return ReconcileResult{}, err
			}
			switch outcome {
			case reconcileRepaired:
				result.Repaired++
			case reconcileUnrepairable:
				result.Unrepairable = append(result.Unrepairable, reconcileLabel(op))
			}
		}
		if len(page) < limit {
			return result, nil
		}
		last := page[len(page)-1]
		cursor = &last
	}
}

func reconcileLabel(op transaction.Outpoint) string {
	return fmt.Sprintf("%s.%d", op.Txid.String(), op.Index)
}

func reconcileOne(ctx context.Context, d ReconcileDeps, op transaction.Outpoint, onRepair func(string, bool)) (reconcileOutcome, error) {
	txid := op.Txid.String()
	script, _, found, err := d.Engine.FindAdmittedOutput(ctx, txid, op.Index, d.Topic)
	if err != nil {
		return reconcileOK, err
	}
	if !found {
		return reconcileOK, nil // spent or evicted since it was listed: no longer the index's concern
	}
	tok, ok := reconcileScriptToken(script, txid, op.Index)
	if !ok {
		return reconcileUnrepairable, nil
	}
	agrees, err := reconcileRowAgrees(ctx, d.Store, txid, op.Index, tok)
	if err != nil {
		return reconcileOK, err
	}
	if agrees {
		return reconcileOK, nil
	}
	journal, err := d.Store.GetOwnerJournal(ctx, txid, op.Index, d.Topic)
	if err != nil {
		return reconcileOK, err
	}
	if journal == nil || !journalAgrees(journal, tok.tokenID, tok.role, tok.amount) {
		return reconcileUnrepairable, nil
	}
	inserted, err := d.Store.RepairOwnerRow(ctx, *journal)
	if err != nil {
		return reconcileOK, err
	}
	// A spend after the first read may already have taken the row this insert put back. A correction needs no check:
	// the row it corrected is still there for that spend to take.
	if inserted {
		_, _, still, err := d.Engine.FindAdmittedOutput(ctx, txid, op.Index, d.Topic)
		if err != nil {
			return reconcileOK, err
		}
		if !still {
			if err := TakeBackRepair(ctx, d.Store, txid, op.Index, tok.role); err != nil {
				return reconcileOK, err
			}
			return reconcileOK, nil
		}
	}
	onRepair(reconcileLabel(op), inserted)
	return reconcileRepaired, nil
}

// reconcileScriptToken decodes the engine's script: not a token, or a deploy anywhere but vout 0, has no token id.
func reconcileScriptToken(script []byte, txid string, vout uint32) (reconcileToken, bool) {
	if !brc162.IsTokenShaped(script) {
		return reconcileToken{}, false
	}
	dec, err := brc162.Decode(script)
	if err != nil {
		return reconcileToken{}, false
	}
	if dec.TokenID != nil {
		return reconcileToken{tokenID: brc162.TokenIDToString(*dec.TokenID), role: dec.Role, amount: dec.Amount}, true
	}
	if vout == 0 {
		return reconcileToken{tokenID: txid + "_0", role: dec.Role, amount: dec.Amount}, true
	}
	return reconcileToken{}, false
}

// reconcileRowAgrees reads the row by the script's role: authority (deploy included) by token id and key, value by
// token id, amount and key. The authority row's topic is not compared (F/ts-layers §14.7).
func reconcileRowAgrees(ctx context.Context, s ReconcileStore, txid string, vout uint32, tok reconcileToken) (bool, error) {
	if tok.role != brc162.RoleValue {
		row, err := s.GetAuthorityRow(ctx, txid, vout)
		if err != nil {
			return false, err
		}
		return row != nil && row.TokenID == tok.tokenID && IsIdentity(row.IdentityKey), nil
	}
	row, err := s.GetTokenRow(ctx, txid, vout)
	if err != nil {
		return false, err
	}
	// sameAmount (Task 12): a safe, non-negative stored amount equal to the script's (TS Number.isSafeInteger).
	return row != nil && row.TokenID == tok.tokenID && sameAmount(row.Amount, tok.amount) && IsIdentity(row.IdentityKey), nil
}

// SweepStore is the slice of the store the sweep lists and takes back.
type SweepStore interface {
	ListTokenRowsByTokenID(ctx context.Context, tokenID string, limit, skip int64) ([]TokenRecord, error)
	ListAuthorities(ctx context.Context, topic, tokenID string) ([]AuthorityRecord, error)
	RepairUndoStore
}

// AppliedTopicsReader lists every topic with an engine applied record for txid (*enginestore.Store).
type AppliedTopicsReader interface {
	AppliedTopics(ctx context.Context, txid string) ([]string, error)
}

// SweepDeps configures one sweep.
type SweepDeps struct {
	Store     SweepStore
	Engine    EngineOutputReader
	Spends    SpendChecker        // required: who marked a dead row's coin spent on its topic ("" = no document, or an evicted spender)
	Applied   AppliedTopicsReader // required: whether that spender is committed on the row's topic
	TokenIDs  []string            // the registered tokens (TokenTopics.Registered); no other token's rows are read or taken
	BatchSize int                 // page size of the engine listing and the value rows: 0 -> DefaultReconcileBatch; < 0 -> error
}

var (
	errSweepBatchSize = errors.New("sweepOwnerIndex: batchSize must be a positive integer")
	errSweepDeps      = errors.New("sweepOwnerIndex: Spends and Applied are required")
)

// SweepOwnerIndex is the other half of the index invariant ruling V-13 maintains: ReconcileOwnerIndex puts back the
// row of an unspent admitted output, the sweep takes back a row whose output is not one. A row can outlive its coin
// when a repair's insert (or its take-back) faults while a conflicting spend lands; nothing else would ever remove it,
// and CirculatingSupply and RebuildBalances would count it. For each token in d.TokenIDs (never tm_mandala, never
// tm_mandala_kyc) it lists the unspent admitted outpoints of the token's own topic tm_<deploy txid>, then takes back,
// through TakeBackRepair, every value row of the token (ListTokenRowsByTokenID: a plain {tokenId} listing, so a dead
// row is seen even when its outpoint is in the asset state's evictedOutpoints) and every authority row on that topic
// (ListAuthorities) whose outpoint is not listed; a value row's owner is debited. Rows of a listed outpoint stay
// whatever the asset state says (a reissued coin that is still live keeps its row).
//
// One kind of unlisted row is not dead (final review §C11): a row whose coin is marked spent on tm_<id> by a
// transaction that has no engine applied record ON tm_<id> and was never evicted. That spend is not committed on this
// topic — the engine marks inputs spent (step 7) before its lookups take their rows, broadcasts and writes the applied
// record last, so a fault or crash in between leaves exactly this — and the transaction's resubmit, which only the
// conflicting-spend guard's self rule lets through, still spends the coin through the row. Taking it would turn a
// recoverable state into a locked coin. The check is per topic, not "applied anywhere": a two-token transaction
// applied on tm_A whose tm_B commit faulted holds tm_B's coins uncommitted. Such rows are kept.
//
// Every row is listed before the first take, so the caller must hold the maintenance gate's exclusive section: no
// submit or eviction may change the engine or the rows meanwhile. It returns the number of rows taken (before a fault,
// if any); every engine or store fault propagates and the caller reruns.
func SweepOwnerIndex(ctx context.Context, d SweepDeps) (int, error) {
	limit := d.BatchSize
	if limit == 0 {
		limit = DefaultReconcileBatch
	}
	if limit < 0 {
		return 0, errSweepBatchSize
	}
	if d.Spends == nil || d.Applied == nil {
		return 0, errSweepDeps
	}
	taken := 0
	for _, tokenID := range d.TokenIDs {
		topic, err := TokenTopic(tokenID)
		if err != nil {
			return taken, err
		}
		live, err := sweepUnspent(ctx, d.Engine, topic, limit)
		if err != nil {
			return taken, err
		}
		values, err := sweepValueRows(ctx, d.Store, tokenID, limit, live)
		if err != nil {
			return taken, err
		}
		authorities, err := d.Store.ListAuthorities(ctx, topic, tokenID)
		if err != nil {
			return taken, err
		}
		for _, r := range authorities {
			if !live[sweepKey(r.Txid, r.OutputIndex)] {
				values = append(values, sweepRow{Outpoint: Outpoint{Txid: r.Txid, OutputIndex: r.OutputIndex}, role: brc162.RoleAuthority})
			}
		}
		for _, r := range values {
			pending, err := sweepUncommittedSpend(ctx, d, topic, r.Txid, r.OutputIndex)
			if err != nil {
				return taken, err
			}
			if pending {
				continue
			}
			if err := TakeBackRepair(ctx, d.Store, r.Txid, r.OutputIndex, r.role); err != nil {
				return taken, err
			}
			taken++
		}
	}
	return taken, nil
}

// sweepRow is one unlisted row: its outpoint and the role TakeBackRepair takes it by.
type sweepRow struct {
	Outpoint
	role brc162.Role
}

// sweepUncommittedSpend reports whether the coin of (txid, vout) is marked spent on topic by a transaction that is not
// committed on topic: a spender the checker names (an evicted one reads live, so "") with no applied record there.
func sweepUncommittedSpend(ctx context.Context, d SweepDeps, topic, txid string, vout uint32) (bool, error) {
	spender, err := d.Spends.SpentBy(ctx, topic, txid, vout)
	if err != nil || spender == "" {
		return false, err
	}
	applied, err := d.Applied.AppliedTopics(ctx, spender)
	if err != nil {
		return false, err
	}
	return !slices.Contains(applied, topic), nil
}

// sweepKey is "<lowercase txid>.<vout>", the form reconcileLabel gives an engine outpoint.
func sweepKey(txid string, vout uint32) string {
	return fmt.Sprintf("%s.%d", strings.ToLower(txid), vout)
}

// sweepUnspent lists every unspent admitted outpoint of topic in keyset pages, with the reconciler's progress guard.
func sweepUnspent(ctx context.Context, e EngineOutputReader, topic string, limit int) (map[string]bool, error) {
	live := map[string]bool{}
	var cursor *transaction.Outpoint
	for {
		page, err := e.ListUnspentAdmittedOutputs(ctx, topic, cursor, limit)
		if err != nil {
			return nil, err
		}
		if cursor != nil && len(page) > 0 && page[len(page)-1] == *cursor {
			return nil, fmt.Errorf("sweepOwnerIndex: the engine listing did not advance past %s", reconcileLabel(*cursor))
		}
		for _, op := range page {
			live[reconcileLabel(op)] = true
		}
		if len(page) < limit {
			return live, nil
		}
		last := page[len(page)-1]
		cursor = &last
	}
}

// sweepValueRows pages every value row of the token and keeps the outpoints that are not live. Nothing is taken while
// it pages, so the skip offsets stay valid.
func sweepValueRows(ctx context.Context, s SweepStore, tokenID string, limit int, live map[string]bool) ([]sweepRow, error) {
	var dead []sweepRow
	for skip := int64(0); ; {
		page, err := s.ListTokenRowsByTokenID(ctx, tokenID, int64(limit), skip)
		if err != nil {
			return nil, err
		}
		for _, r := range page {
			if !live[sweepKey(r.Txid, r.OutputIndex)] {
				dead = append(dead, sweepRow{Outpoint: Outpoint{Txid: r.Txid, OutputIndex: r.OutputIndex}, role: brc162.RoleValue})
			}
		}
		if len(page) < limit {
			return dead, nil
		}
		skip += int64(len(page))
	}
}

package mandala

import (
	"context"
	"fmt"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

const RegistryLookup = "ls_mandala_registry"

type RegistryLookupService struct {
	store *Store
}

var _ engine.LookupService = (*RegistryLookupService)(nil)

func NewRegistryLookupService(store *Store) *RegistryLookupService {
	return &RegistryLookupService{store: store}
}

func (l *RegistryLookupService) OutputAdmittedByTopic(ctx context.Context, p *engine.OutputAdmittedByTopic) error {
	if p.Topic != RegistryTopic {
		return nil
	}
	_, tx, txidHash, err := transaction.ParseBeef(p.AtomicBEEF)
	if err != nil {
		return fmt.Errorf("ls_mandala_registry: parse beef: %w", err)
	}
	if tx == nil || int(p.OutputIndex) >= len(tx.Outputs) {
		return fmt.Errorf("ls_mandala_registry: missing output")
	}
	payload, err := DecodeLinkagePayload(p.OffChainValues)
	if err != nil {
		return fmt.Errorf("ls_mandala_registry: payload: %w", err)
	}
	var details ActionDetails
	for _, a := range payload.Admin {
		if a.Index == p.OutputIndex {
			details = a.ActionDetails
			break
		}
	}
	if details == nil {
		return nil
	}
	seq, err := l.store.NextAdmitSeq(ctx)
	if err != nil {
		return err
	}
	row, ok := FoldRegistry(details, txidHash.String(), p.OutputIndex, seq)
	if !ok {
		return nil
	}
	return l.store.UpsertRegistry(ctx, row)
}

func (l *RegistryLookupService) OutputSpent(context.Context, *engine.OutputSpent) error {
	return nil
}
func (l *RegistryLookupService) OutputNoLongerRetainedInHistory(context.Context, *transaction.Outpoint, string) error {
	return nil
}
func (l *RegistryLookupService) OutputEvicted(context.Context, *transaction.Outpoint) error {
	return nil
}
func (l *RegistryLookupService) OutputBlockHeightUpdated(context.Context, *chainhash.Hash, uint32, uint64) error {
	return nil
}

func (l *RegistryLookupService) Lookup(ctx context.Context, q *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	rows, err := l.store.ListRegistry(ctx)
	if err != nil {
		return nil, err
	}
	// LookupAnswer outputs are UTXO-shaped; registry identities are not
	// UTXOs. Served via GET /admin/registry instead. Keep this path empty.
	_ = rows
	_ = q
	return &lookup.LookupAnswer{Type: lookup.AnswerTypeFreeform, Result: []any{}}, nil
}

func (l *RegistryLookupService) GetDocumentation() string {
	return "ls_mandala_registry folds admit/revoke into mandalaRegistry. Query via GET /admin/registry."
}
func (l *RegistryLookupService) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{Name: RegistryLookup, Description: "Identity registration cache"}
}

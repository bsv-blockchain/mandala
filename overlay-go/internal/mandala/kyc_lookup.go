package mandala

import (
	"context"
	"fmt"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// KYCLookupService is ls_mandala_kyc (Q2/mandala-registry/RegistryLookupService.ts): it claims the
// registry token on the first deploy, folds the claimed chain's admit/revoke actions into
// mandalaRegistry, and keeps the registry authority rows. Lookup answers nothing.
type KYCLookupService struct{ store *Store }

var _ engine.LookupService = (*KYCLookupService)(nil)

func NewKYCLookupService(store *Store) *KYCLookupService { return &KYCLookupService{store: store} }

// OutputAdmittedByTopic is sequential: membership first (the security-relevant write), then the
// authority row, which the next spend can repair from the journal.
func (l *KYCLookupService) OutputAdmittedByTopic(ctx context.Context, p *engine.OutputAdmittedByTopic) error {
	if p == nil || p.Topic != KYCTopic {
		return nil
	}
	a, err := admittedOutputOf(p.AtomicBEEF, p.OutputIndex)
	if err != nil {
		return fmt.Errorf("%s: %w", KYCLookup, err)
	}
	if a == nil || a.output.Role == brc162.RoleValue {
		return nil // the topic admits no value output
	}
	if a.output.Role == brc162.RoleDeploy {
		if _, err := l.store.ClaimKYCRegistryTokenID(ctx, a.output.TokenID); err != nil {
			return err
		}
	}
	env, err := DecodeEnvelope(p.OffChainValues)
	if err != nil {
		return err
	}
	if err := l.foldAction(ctx, a, env); err != nil {
		return err
	}
	return l.indexAuthority(ctx, a)
}

// foldAction folds the committed action into the identity's row, only for the claimed registry.
// The first action of a chain claims again (a lost deploy claim); a rival chain moves nothing.
func (l *KYCLookupService) foldAction(ctx context.Context, a *lookupAdmitted, env *Envelope) error {
	action, err := committedActionOf(a.output, env, RegistryKinds)
	if err != nil || action == nil {
		return err
	}
	if _, err := l.store.ClaimKYCRegistryTokenID(ctx, a.output.TokenID); err != nil {
		return err
	}
	claimed, ok, err := l.store.KYCRegistryTokenID(ctx)
	if err != nil {
		return err
	}
	if !ok || claimed != a.output.TokenID {
		return nil
	}
	d := action.Details
	if d.IdentityKey == "" {
		return fmt.Errorf("registry action %s has no identityKey", d.Kind)
	}
	status := "revoked"
	if d.Kind == "admitIdentity" {
		status = "admitted"
	}
	return l.store.ApplyKYC(ctx, d.IdentityKey, status, a.txid, a.output.Index)
}

// indexAuthority stores the authority row owned by the journalled identity; with no agreeing
// journal row it is left (no linkage fallback, unlike the token lookup).
func (l *KYCLookupService) indexAuthority(ctx context.Context, a *lookupAdmitted) error {
	o := a.output
	j, err := l.store.GetOwnerJournal(ctx, a.txid, o.Index, KYCTopic)
	if err != nil {
		return err
	}
	if j == nil || !journalAgrees(j, o.TokenID, o.Role, o.Amount) {
		return nil
	}
	_, err = l.store.StoreAuthorityIfAbsent(ctx, AuthorityRecord{Txid: a.txid, OutputIndex: o.Index, Topic: KYCTopic,
		TokenID: o.TokenID, IdentityKey: j.IdentityKey, CreatedAt: time.Now().UTC()})
	return err
}

func (l *KYCLookupService) OutputSpent(ctx context.Context, p *engine.OutputSpent) error {
	if p == nil || p.Topic != KYCTopic || p.Outpoint == nil {
		return nil
	}
	_, err := l.store.TakeAuthority(ctx, p.Outpoint.Txid.String(), p.Outpoint.Index)
	return err
}

// OutputEvicted takes the authority row; the registry row is kept (nothing records what it replaced).
func (l *KYCLookupService) OutputEvicted(ctx context.Context, op *transaction.Outpoint) error {
	if op == nil {
		return nil
	}
	_, err := l.store.TakeAuthority(ctx, op.Txid.String(), op.Index)
	return err
}

func (l *KYCLookupService) OutputNoLongerRetainedInHistory(context.Context, *transaction.Outpoint, string) error {
	return nil
}

func (l *KYCLookupService) OutputBlockHeightUpdated(context.Context, *chainhash.Hash, uint32, uint64) error {
	return nil
}

// Lookup answers nothing: the registry is served by GET /admin/registry.
func (l *KYCLookupService) Lookup(context.Context, *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	return &lookup.LookupAnswer{Type: lookup.AnswerTypeFormula, Formulas: []lookup.LookupFormula{}}, nil
}

func (l *KYCLookupService) GetDocumentation() string { return docKYCLookup }

func (l *KYCLookupService) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{Name: KYCLookup, Description: "Mandala identity registry index: folds admit and revoke actions into the membership cache and tracks the registry authority."}
}

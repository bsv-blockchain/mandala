package mandala

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// committedActionOf is the lookup-side reading of a committed admin action (Q2/mandala/
// MandalaLookupService.ts:199-210): an authority output with a commitment and an env.admin entry
// at its index that decodes under kinds. Anything missing is no action (nil, nil); a schema error
// is returned. The manager already proved the commitment matches.
func committedActionOf(o brc162.Output, env *Envelope, kinds []string) (*CommittedAction, error) {
	if o.Role != brc162.RoleAuthority {
		return nil, nil
	}
	if _, ok := CommitmentOf(o.Payload, o.HasPayload, o.PayloadCanonical); !ok {
		return nil, nil
	}
	for _, entry := range env.Admin {
		if entry.Index != uint64(o.Index) {
			continue
		}
		d, commitment, err := DecodeAdminDetails(entry.Details, kinds, o.Index)
		if err != nil {
			return nil, err
		}
		return &CommittedAction{TokenID: o.TokenID, OutputIndex: o.Index, Details: d, DetailsHex: entry.Details, Commitment: commitment}, nil
	}
	return nil, nil
}

type lookupAdmitted struct {
	tx      *transaction.Transaction
	txid    string
	output  brc162.Output
	outputs []brc162.Output
}

func admittedOutputOf(atomicBEEF []byte, vout uint32) (*lookupAdmitted, error) {
	beef, _, txid, err := transaction.ParseBeef(atomicBEEF)
	if err != nil {
		return nil, err
	}
	if beef == nil || txid == nil {
		return nil, errors.New("admitted BEEF has no subject transaction")
	}
	tx := beef.FindTransactionForSigningByHash(txid)
	if tx == nil {
		return nil, fmt.Errorf("transaction %s not found in the admitted BEEF", txid)
	}
	outputs := brc162.ClassifyOutputs(tx).Outputs
	for _, o := range outputs {
		if o.Index == vout {
			return &lookupAdmitted{tx: tx, txid: txid.String(), output: o, outputs: outputs}, nil
		}
	}
	return nil, nil
}

func lookupFormulas(ops ...Outpoint) (*lookup.LookupAnswer, error) {
	formulas := make([]lookup.LookupFormula, 0, len(ops))
	for _, op := range ops {
		h, err := chainhash.NewHashFromHex(op.Txid)
		if err != nil {
			return nil, fmt.Errorf("outpoint %s.%d: %w", op.Txid, op.OutputIndex, err)
		}
		formulas = append(formulas, lookup.LookupFormula{Outpoint: &transaction.Outpoint{Txid: *h, Index: op.OutputIndex}})
	}
	return &lookup.LookupAnswer{Type: lookup.AnswerTypeFormula, Formulas: formulas}, nil
}

// lookupEveryStep runs every step even when one fails and returns the first fault (TS everyStep).
func lookupEveryStep(steps ...func() error) error {
	var first error
	for _, step := range steps {
		if err := step(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// lookupDelta is Δ = value out − value in of the output's token over every token input of the tx
// (TS deltaOf), clamped to the JS safe range Amount can persist.
func lookupDelta(a *lookupAdmitted) Amount {
	all := make([]uint32, len(a.tx.Inputs))
	for i := range all {
		all[i] = uint32(i)
	}
	tl, ok := brc162.BuildLedger(a.txid, a.outputs, brc162.ClassifyAdmittedInputs(a.tx, all)).Get(a.output.TokenID)
	if !ok {
		return 0
	}
	d := new(big.Int).Sub(tl.ValueOut, tl.ValueIn)
	limit := big.NewInt(maxSafeInteger)
	if d.Cmp(limit) > 0 {
		return Amount(maxSafeInteger)
	}
	if d.Cmp(new(big.Int).Neg(limit)) < 0 {
		return Amount(-maxSafeInteger)
	}
	return Amount(d.Int64())
}

var (
	tokenLookupTokenKeys = []string{"metadataTokenId", "assetStateTokenId", "adminHistoryTokenId", "authoritiesTokenId", "tokenId"}
	tokenLookupQueryKeys = append(slices.Clone(tokenLookupTokenKeys), "txid", "outputIndex", "limit", "skip")
)

// TokenLookupService is ls_<deploy txid> (Q2/mandala/MandalaLookupService.ts), answering formulas
// only (D-9).
type TokenLookupService struct {
	tokenID, topic, name string
	verifier             LinkageVerifier
	store                *Store
}

var _ engine.LookupService = (*TokenLookupService)(nil)

func NewTokenLookupService(tokenID string, v LinkageVerifier, store *Store) (*TokenLookupService, error) {
	topic, err := TokenTopic(tokenID)
	if err != nil {
		return nil, err
	}
	name, err := TokenLookup(tokenID)
	if err != nil {
		return nil, err
	}
	return &TokenLookupService{tokenID: tokenID, topic: topic, name: name, verifier: v, store: store}, nil
}

func (l *TokenLookupService) Name() string  { return l.name }
func (l *TokenLookupService) Topic() string { return l.topic }

func (l *TokenLookupService) OutputAdmittedByTopic(ctx context.Context, p *engine.OutputAdmittedByTopic) error {
	if p == nil || p.Topic != l.topic {
		return nil
	}
	a, err := admittedOutputOf(p.AtomicBEEF, p.OutputIndex)
	if err != nil {
		return fmt.Errorf("%s: %w", l.name, err)
	}
	if a == nil {
		return nil
	}
	env, err := DecodeEnvelope(p.OffChainValues)
	if err != nil {
		return err
	}
	return lookupEveryStep(
		func() error { return l.recordAction(ctx, a, env) },
		func() error { return l.indexDeploy(ctx, a) },
		func() error { return l.indexOwner(ctx, a, env) },
	)
}

// recordAction appends the committed action to the history with its fold position, Δ and (for a
// freeze) the live fold context, and folds it on that first append only.
func (l *TokenLookupService) recordAction(ctx context.Context, a *lookupAdmitted, env *Envelope) error {
	action, err := committedActionOf(a.output, env, AdminKinds)
	if err != nil || action == nil {
		return err
	}
	height, offset := TxOrdering(a.tx, a.txid)
	fc, readErr := liveFoldContext(ctx, l.store, action.Details, a.output.TokenID)
	seq, err := l.store.NextAdmitSeq(ctx)
	if err != nil {
		return err
	}
	entry := AdminHistoryEntry{
		TokenID:     a.output.TokenID,
		Txid:        a.txid,
		OutputIndex: a.output.Index,
		Kind:        action.Details.Kind,
		DetailsHex:  action.DetailsHex,
		Commitment:  hex.EncodeToString(action.Commitment[:]),
		Delta:       lookupDelta(a),
		Height:      height,
		Offset:      offset,
		AdmitSeq:    seq,
		CreatedAt:   time.Now().UTC(),
	}
	if readErr == nil {
		entry.FrozenAmount, entry.FrozenOwner = fc.FrozenAmount, fc.FrozenOwner
	}
	inserted, err := l.store.AppendAdminHistory(ctx, entry)
	if err != nil || !inserted {
		return err
	}
	if readErr != nil {
		return readErr // the row is kept without a context; the boot refold folds it
	}
	state, err := l.store.GetAssetState(ctx, a.output.TokenID)
	if err != nil {
		return err
	}
	return l.store.PutAssetState(ctx, foldEntry(state, action.Details, entry, fc))
}

// indexDeploy stores the decoded deploy payload and the token's first state with its fee rate.
func (l *TokenLookupService) indexDeploy(ctx context.Context, a *lookupAdmitted) error {
	o := a.output
	if o.Role != brc162.RoleDeploy {
		return nil
	}
	md, err := ParseDeployMetadata(o.Payload, o.HasPayload, o.PayloadCanonical)
	if err != nil {
		return err
	}
	if err := l.store.StoreMetadata(ctx, MetadataRecord{TokenID: o.TokenID, Txid: a.txid, OutputIndex: 0,
		Sym: md.Sym, Dec: md.Dec, Label: md.Label, FeeRatePerKb: md.FeeRatePerKb}); err != nil {
		return err
	}
	_, err = l.store.PutAssetStateIfAbsent(ctx, DefaultAssetState(o.TokenID, md.FeeRatePerKb))
	return err
}

// ownerOf: the journalled owner when the journal row describes this very script, else the owner
// the output's linkage proves, else none.
func (l *TokenLookupService) ownerOf(ctx context.Context, a *lookupAdmitted, env *Envelope) (string, error) {
	o := a.output
	j, err := l.store.GetOwnerJournal(ctx, a.txid, o.Index, l.topic)
	if err != nil {
		return "", err
	}
	if j != nil && journalAgrees(j, o.TokenID, o.Role, o.Amount) {
		return j.IdentityKey, nil
	}
	owners, err := VerifyOutputOwners(ctx, []brc162.Output{o}, env, l.verifier)
	if err != nil || len(owners) == 0 {
		return "", nil
	}
	return owners[0].IdentityKey, nil
}

// indexOwner writes the linkage record and the owner row (with its credit on insert); with no
// owner nothing is written and the reconciler repairs the row from the journal.
func (l *TokenLookupService) indexOwner(ctx context.Context, a *lookupAdmitted, env *Envelope) error {
	identityKey, err := l.ownerOf(ctx, a, env)
	if err != nil || identityKey == "" {
		return err
	}
	createdAt := time.Now().UTC()
	return lookupEveryStep(
		func() error { return l.storeLinkage(ctx, a, identityKey, env, createdAt) },
		func() error { return l.storeOwnerRow(ctx, a, identityKey, createdAt) },
	)
}

func (l *TokenLookupService) storeLinkage(ctx context.Context, a *lookupAdmitted, identityKey string, env *Envelope, createdAt time.Time) error {
	raw, ok := env.OutputLinkage(a.output.Index)
	if !ok {
		return nil
	}
	linkage, err := ParseLinkage(raw)
	if err != nil {
		return nil // D-13: an untyped linkage is not storable and proved no owner here
	}
	return l.store.StoreLinkage(ctx, LinkageRecord{Txid: a.txid, OutputIndex: a.output.Index, IdentityKey: identityKey,
		Linkage: *linkage, CreatedAt: createdAt})
}

func (l *TokenLookupService) storeOwnerRow(ctx context.Context, a *lookupAdmitted, identityKey string, createdAt time.Time) error {
	o := a.output
	if o.Role != brc162.RoleValue {
		_, err := l.store.StoreAuthorityIfAbsent(ctx, AuthorityRecord{Txid: a.txid, OutputIndex: o.Index, Topic: l.topic,
			TokenID: o.TokenID, IdentityKey: identityKey, CreatedAt: createdAt})
		return err
	}
	inserted, err := l.store.StoreTokenIfAbsent(ctx, TokenRecord{Txid: a.txid, OutputIndex: o.Index, TokenID: o.TokenID,
		Amount: Amount(o.Amount), IdentityKey: identityKey, CreatedAt: createdAt})
	if err != nil || !inserted {
		return err // credit on insert only: a replay never credits twice
	}
	return l.store.AdjustBalance(ctx, identityKey, int64(o.Amount))
}

func (l *TokenLookupService) OutputSpent(ctx context.Context, p *engine.OutputSpent) error {
	if p == nil || p.Topic != l.topic || p.Outpoint == nil {
		return nil
	}
	_, err := takeRow(ctx, l.store, p.Outpoint.Txid.String(), p.Outpoint.Index)
	return err
}

// OutputEvicted has no topic guard: rows are keyed by outpoint, so every instance taking the same
// row is idempotent. Only the deploy at vout 0 wrote metadata.
func (l *TokenLookupService) OutputEvicted(ctx context.Context, op *transaction.Outpoint) error {
	if op == nil {
		return nil
	}
	txid := op.Txid.String()
	if _, err := takeRow(ctx, l.store, txid, op.Index); err != nil {
		return err
	}
	if op.Index == 0 {
		return l.store.DeleteMetadata(ctx, txid+"_0")
	}
	return nil
}

func (l *TokenLookupService) OutputNoLongerRetainedInHistory(context.Context, *transaction.Outpoint, string) error {
	return nil
}

func (l *TokenLookupService) OutputBlockHeightUpdated(context.Context, *chainhash.Hash, uint32, uint64) error {
	return nil
}

// Lookup validates every key before answering any (TS order: the token keys, txid, outputIndex,
// limit, skip), refuses any token key naming another token (Q2 ac8d82732), then answers the first
// token key present, else txid + outputIndex.
func (l *TokenLookupService) Lookup(ctx context.Context, q *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	query, err := RequireLookupQuery(q, l.name, tokenLookupQueryKeys)
	if err != nil {
		return nil, err
	}
	type askedKey struct{ field, tokenID string }
	var asked []askedKey // the token keys present, in TS order; each must name l.tokenID
	for _, field := range tokenLookupTokenKeys {
		id, present, err := query.TokenID(field)
		if err != nil {
			return nil, err
		}
		if present {
			asked = append(asked, askedKey{field: field, tokenID: id})
		}
	}
	txid, hasTxid, err := query.Txid("txid")
	if err != nil {
		return nil, err
	}
	var vout int64
	_, hasVout := query["outputIndex"] // TS: query.outputIndex === undefined (null reads the default 0)
	if hasVout {
		if vout, err = query.Integer("outputIndex", 0, 0, 4294967295); err != nil {
			return nil, err
		}
	}
	limit, err := query.Integer("limit", 100, 1, 100)
	if err != nil {
		return nil, err
	}
	skip, err := query.Integer("skip", 0, 0, 100000)
	if err != nil {
		return nil, err
	}
	// ls_<id> answers for its own token only: the store is shared, and another token's rows go stale
	// once that token is no longer hosted (TT §6.3).
	for _, k := range asked {
		if k.tokenID != l.tokenID {
			return nil, lookupInvalid(k.field + " must be " + l.tokenID + ", the token " + l.name + " serves")
		}
	}
	firstField := ""
	if len(asked) > 0 {
		firstField = asked[0].field
	}
	switch firstField {
	case "metadataTokenId":
		md, err := l.store.FindMetadata(ctx, l.tokenID)
		if err != nil {
			return nil, err
		}
		if md == nil {
			return lookupFormulas()
		}
		return lookupFormulas(Outpoint{Txid: md.Txid, OutputIndex: md.OutputIndex})
	case "authoritiesTokenId":
		rows, err := l.store.ListAuthorities(ctx, l.topic, l.tokenID)
		if err != nil {
			return nil, err
		}
		start := min(int(skip), len(rows))
		end := min(start+int(limit), len(rows))
		ops := make([]Outpoint, 0, end-start)
		for _, r := range rows[start:end] {
			ops = append(ops, Outpoint{Txid: r.Txid, OutputIndex: r.OutputIndex})
		}
		return lookupFormulas(ops...)
	case "tokenId":
		rows, err := l.store.FindTokensByTokenID(ctx, l.tokenID, limit, skip)
		if err != nil {
			return nil, err
		}
		ops := make([]Outpoint, 0, len(rows))
		for _, r := range rows {
			ops = append(ops, Outpoint{Txid: r.Txid, OutputIndex: r.OutputIndex})
		}
		return lookupFormulas(ops...)
	case "assetStateTokenId", "adminHistoryTokenId":
		return nil, errors.New("Unsupported query") // D-9: served over HTTP, not /lookup
	}
	if !hasTxid || !hasVout {
		return nil, errors.New("Unsupported query")
	}
	// The value row at the outpoint, else the authority row (TS ??: a value row present ends the
	// search), answered only when it is of this lookup's token.
	idx := uint32(vout)
	row, err := l.store.GetTokenRow(ctx, txid, idx)
	if err != nil {
		return nil, err
	}
	if row != nil {
		if row.TokenID != l.tokenID {
			return lookupFormulas()
		}
		return lookupFormulas(Outpoint{Txid: row.Txid, OutputIndex: row.OutputIndex})
	}
	a, err := l.store.GetAuthorityRow(ctx, txid, idx)
	if err != nil {
		return nil, err
	}
	if a != nil && a.TokenID == l.tokenID {
		return lookupFormulas(Outpoint{Txid: a.Txid, OutputIndex: a.OutputIndex})
	}
	return lookupFormulas()
}

func (l *TokenLookupService) GetDocumentation() string { return docTokenLookup }

func (l *TokenLookupService) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{Name: l.name, Description: "Mandala BRC-162 token index by tokenId and outpoint: metadata, admin state and history, authorities. No identity-balance query."}
}

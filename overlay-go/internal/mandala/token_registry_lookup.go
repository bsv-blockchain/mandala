package mandala

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

var tokenRegistryLookupQueryKeys = []string{"tokenId", "list", "limit", "skip"}

// TokenRegistryLookupService is ls_mandala (Q2/mandala/MandalaRegistryLookupService.ts): one
// permanent record per deploy tm_mandala admitted. A spend keeps the record (T7); only an eviction
// deletes it. Lookup answers deploy outpoints (D-9); the records are served by GET /admin/tokens.
type TokenRegistryLookupService struct {
	verifier LinkageVerifier
	store    *Store
}

var _ engine.LookupService = (*TokenRegistryLookupService)(nil)

func NewTokenRegistryLookupService(v LinkageVerifier, store *Store) *TokenRegistryLookupService {
	return &TokenRegistryLookupService{verifier: v, store: store}
}

// OutputAdmittedByTopic records the deploy at output 0 of a tm_mandala admission: its decoded
// payload and its verified owner (the trusted issuer). First write wins.
func (l *TokenRegistryLookupService) OutputAdmittedByTopic(ctx context.Context, p *engine.OutputAdmittedByTopic) error {
	if p == nil || p.Topic != MandalaTopic || p.OutputIndex != 0 {
		return nil
	}
	a, err := admittedOutputOf(p.AtomicBEEF, 0)
	if err != nil {
		return fmt.Errorf("%s: %w", MandalaLookup, err)
	}
	if a == nil || a.output.Role != brc162.RoleDeploy {
		return nil
	}
	env, err := DecodeEnvelope(p.OffChainValues)
	if err != nil {
		return err
	}
	owners, err := VerifyOutputOwners(ctx, []brc162.Output{a.output}, env, l.verifier)
	if err != nil {
		return err
	}
	if len(owners) != 1 {
		return fmt.Errorf("%s: no verified owner for %s.0", MandalaLookup, a.txid)
	}
	md, err := ParseDeployMetadata(a.output.Payload, a.output.HasPayload, a.output.PayloadCanonical)
	if err != nil {
		return err
	}
	_, err = l.store.StoreRegistryRecord(ctx, TokenRegistryRecord{
		TokenID:      a.output.TokenID,
		DeployTxid:   a.txid,
		Sym:          md.Sym,
		Dec:          md.Dec,
		Label:        md.Label,
		Issuer:       owners[0].IdentityKey,
		FeeRatePerKb: md.FeeRatePerKb,
		CreatedAt:    time.Now().UTC(),
	})
	return err
}

// RestoreMissingRecords is the registry's boot repair, a host duty before submissions start (Q2
// 258180169; D-21). The engine notifies this lookup once and only logs an error, so a record whose
// write failed, or a deploy tm_mandala refused only transiently while tm_<deploy txid> admitted it,
// would be missing from GET /admin/tokens for good although the token is hosted. For every token
// with deploy metadata (written by its own ls_<id>) and an agreeing owner-journal row of the deploy at
// output 0 on tm_<deploy txid>, it writes the record: the issuer is the journalled owner, createdAt
// the journal row's. First write wins, so an existing record never changes and a rerun is harmless.
// It returns the token ids it restored, in tokenId order.
func (l *TokenRegistryLookupService) RestoreMissingRecords(ctx context.Context) ([]string, error) {
	all, err := l.store.AllMetadata(ctx)
	if err != nil {
		return nil, err
	}
	restored := []string{}
	for _, md := range all {
		rec, err := l.recordFromJournal(ctx, md)
		if err != nil {
			return restored, err
		}
		if rec == nil {
			continue
		}
		inserted, err := l.store.StoreRegistryRecord(ctx, *rec)
		if err != nil {
			return restored, err
		}
		if inserted {
			restored = append(restored, rec.TokenID)
		}
	}
	return restored, nil
}

// recordFromJournal is the record of a deploy its own token topic admitted, or nil without an
// agreeing journal row (TS recordFromJournal): tm_<txid> must name the metadata's token, and the
// journal row at output 0 on that topic must be a deploy of the token owned by a compressed key.
func (l *TokenRegistryLookupService) recordFromJournal(ctx context.Context, md MetadataRecord) (*TokenRegistryRecord, error) {
	topic := "tm_" + md.Txid
	if id, ok := TokenIDOfTopic(topic); !ok || id != md.TokenID {
		return nil, nil
	}
	j, err := l.store.GetOwnerJournal(ctx, md.Txid, 0, topic)
	if err != nil || j == nil {
		return nil, err
	}
	if j.Role != brc162.RoleDeploy || j.TokenID != md.TokenID || !IsIdentity(j.IdentityKey) {
		return nil, nil
	}
	createdAt := j.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	return &TokenRegistryRecord{TokenID: md.TokenID, DeployTxid: md.Txid, Sym: md.Sym, Dec: md.Dec, Label: md.Label,
		Issuer: j.IdentityKey, FeeRatePerKb: md.FeeRatePerKb, CreatedAt: createdAt}, nil
}

// OutputSpent keeps the record: the first issue spends the deploy output (T7).
func (l *TokenRegistryLookupService) OutputSpent(context.Context, *engine.OutputSpent) error {
	return nil
}

func (l *TokenRegistryLookupService) OutputNoLongerRetainedInHistory(context.Context, *transaction.Outpoint, string) error {
	return nil
}

// OutputEvicted drops the record of the deploy at vout 0 of the evicted txid.
func (l *TokenRegistryLookupService) OutputEvicted(ctx context.Context, op *transaction.Outpoint) error {
	if op == nil || op.Index != 0 {
		return nil
	}
	return l.store.DeleteRegistryRecord(ctx, op.Txid.String()+"_0")
}

func (l *TokenRegistryLookupService) OutputBlockHeightUpdated(context.Context, *chainhash.Hash, uint32, uint64) error {
	return nil
}

// Lookup: every key validated first; {tokenId} answers the deploy outpoint or nothing; {list:
// true} answers a page of deploy outpoints in record order; anything else is "Unsupported query".
func (l *TokenRegistryLookupService) Lookup(ctx context.Context, q *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	query, err := RequireLookupQuery(q, MandalaLookup, tokenRegistryLookupQueryKeys)
	if err != nil {
		return nil, err
	}
	tokenID, hasToken, err := query.TokenID("tokenId")
	if err != nil {
		return nil, err
	}
	list, err := query.Bool("list", false)
	if err != nil {
		return nil, err
	}
	limit, err := query.Integer("limit", 100, 1, 100)
	if err != nil {
		return nil, err
	}
	skip, err := query.Integer("skip", 0, 0, 100000)
	if err != nil {
		return nil, err
	}
	if hasToken {
		r, err := l.store.FindRegistryRecord(ctx, tokenID)
		if err != nil {
			return nil, err
		}
		if r == nil {
			return lookupFormulas()
		}
		return lookupFormulas(Outpoint{Txid: r.DeployTxid, OutputIndex: 0})
	}
	if !list {
		return nil, errors.New("Unsupported query")
	}
	records, err := l.store.ListRegistryRecords(ctx, limit, skip)
	if err != nil {
		return nil, err
	}
	ops := make([]Outpoint, 0, len(records))
	for _, r := range records {
		ops = append(ops, Outpoint{Txid: r.DeployTxid, OutputIndex: 0})
	}
	return lookupFormulas(ops...)
}

func (l *TokenRegistryLookupService) GetDocumentation() string { return docTokenRegistryLookup }

func (l *TokenRegistryLookupService) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{Name: MandalaLookup, Description: "Mandala token registry: every BRC-162 token ever deployed, by tokenId or as a list."}
}

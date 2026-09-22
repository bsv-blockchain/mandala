package mandala

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

// maxSafeHeight is the "unconfirmed" ordering sentinel (JS
// Number.MAX_SAFE_INTEGER) used when a tx carries no merkle path yet
// (Appendix A §4.1 step 5).
const maxSafeHeight = int64(9007199254740991)

// LookupService is the Go port of MandalaLookupService (ls_mandala): the
// projection layer that folds admitted tm_mandala outputs into the token,
// balance, linkage, metadata, admin-history, and asset-state collections,
// and serves outpoint-shaped queries back out (Appendix A §4).
type LookupService struct {
	verifier *Verifier
	store    *Store
}

var _ engine.LookupService = (*LookupService)(nil)

// NewLookupService wires the ls_mandala dependencies together.
func NewLookupService(v *Verifier, store *Store) *LookupService {
	return &LookupService{verifier: v, store: store}
}

// OutputAdmittedByTopic implements §4.1. Only tm_mandala admissions are
// indexed; everything else is ignored.
func (l *LookupService) OutputAdmittedByTopic(ctx context.Context, p *engine.OutputAdmittedByTopic) error {
	if p.Topic != "tm_mandala" {
		return nil
	}
	_, tx, txidHash, err := transaction.ParseBeef(p.AtomicBEEF)
	if err != nil {
		return fmt.Errorf("ls_mandala: parse beef: %w", err)
	}
	if tx == nil {
		return fmt.Errorf("ls_mandala: atomic tx not found in beef")
	}
	if int(p.OutputIndex) >= len(tx.Outputs) {
		return fmt.Errorf("ls_mandala: output index %d out of range", p.OutputIndex)
	}
	txid := txidHash.String()
	out := tx.Outputs[p.OutputIndex]

	if d, err := DecodeToken(out.LockingScript); err == nil {
		return l.indexTokenOutput(ctx, txid, p.OutputIndex, d, p.OffChainValues)
	}
	return l.indexAdminOutput(ctx, tx, txid, p.OutputIndex, p.OffChainValues)
}

// indexTokenOutput implements the FT case of §4.1: store the token row, and
// — when the off-chain payload carries a matching, verified output linkage —
// credit the balance and retain the linkage record. A linkage verification
// ERROR propagates (TS parity: the engine call fails outright rather than
// silently skipping the credit).
func (l *LookupService) indexTokenOutput(ctx context.Context, txid string, outputIndex uint32, d *TokenDecoded, offChainValues []byte) error {
	payload, err := DecodeLinkagePayload(offChainValues)
	if err != nil {
		return fmt.Errorf("ls_mandala: linkage payload: %w", err)
	}
	identity := ""
	var matched *SpecificLinkage
	for _, o := range payload.Outputs {
		if o.Index == outputIndex {
			id, _, err := l.verifier.VerifyKeyLinkage(ctx, o.Linkage)
			if err != nil {
				return fmt.Errorf("ls_mandala: output %d linkage verification: %w", outputIndex, err)
			}
			identity, matched = id, o.Linkage
			break
		}
	}
	if err := l.store.StoreToken(ctx, TokenRow{
		Txid: txid, OutputIndex: outputIndex, AssetID: d.AssetID, Amount: d.Amount,
		IdentityKey: identity, CreatedAt: time.Now(),
	}); err != nil {
		return err
	}
	if identity == "" {
		return nil
	}
	if err := l.store.AdjustBalance(ctx, identity, d.Amount); err != nil {
		return err
	}
	if matched != nil {
		if err := l.store.StoreLinkage(ctx, LinkageRow{
			Txid: txid, OutputIndex: outputIndex, IdentityKey: identity,
			Linkage: *matched, CreatedAt: time.Now(),
		}); err != nil {
			return err
		}
	}
	return nil
}

// indexAdminOutput implements the admin case of §4.1: DecodeAdmin failure
// means the output is not mandala-shaped at all (return nil, not an error).
// publicData (when present) is served under the output's own outpoint,
// independent of whatever assetId the action details carry. A missing
// payload.admin entry stops here too — the metadata write above may already
// have happened.
func (l *LookupService) indexAdminOutput(ctx context.Context, tx *transaction.Transaction, txid string, outputIndex uint32, offChainValues []byte) error {
	decoded, err := DecodeAdmin(tx.Outputs[outputIndex].LockingScript)
	if err != nil {
		return nil // not a mandala output at all
	}
	if decoded.PublicData != nil {
		if err := l.store.StoreMetadata(ctx, MetadataRow{
			Txid: txid, OutputIndex: outputIndex, AssetID: fmtOutpoint(txid, outputIndex),
		}); err != nil {
			return err
		}
	}

	payload, err := DecodeLinkagePayload(offChainValues)
	if err != nil {
		return fmt.Errorf("ls_mandala: linkage payload: %w", err)
	}
	var details ActionDetails
	found := false
	for _, a := range payload.Admin {
		if a.Index == outputIndex {
			details, found = a.ActionDetails, true
			break
		}
	}
	if !found {
		return nil // metadata may already have been stored above
	}

	assetID, ok := details.Str("assetId")
	if !ok || assetID == "" {
		assetID = fmtOutpoint(txid, outputIndex)
	}

	height, offset := txOrdering(tx, txid)
	admitSeq, err := l.store.NextAdmitSeq(ctx)
	if err != nil {
		return err
	}
	if err := l.store.AppendAdminHistory(ctx, AdminHistoryEntry{
		AssetID: assetID, Txid: txid, OutputIndex: outputIndex,
		Height: height, Offset: offset, AdmitSeq: admitSeq,
		ActionDetails: details, CreatedAt: time.Now(),
	}); err != nil {
		return err
	}

	fctx, err := l.foldContext(ctx, details)
	if err != nil {
		return err
	}
	prev, err := l.store.GetAssetState(ctx, assetID)
	if err != nil {
		return err
	}
	next := FoldAction(prev, details, fctx)
	next.LastProcessedHeight = height
	next.LastProcessedOffset = offset
	next.LastAdmitSeq = admitSeq
	return l.store.PutAssetState(ctx, next)
}

// foldContext sources the ctx.issuer / ctx.frozenAmount / ctx.frozenOwner
// fields FoldAction needs from persisted actionDetails and current token
// rows — never from the raw publicData — so live admission and a later
// rebuildState agree (§4.1 step 8 / §4.2).
func (l *LookupService) foldContext(ctx context.Context, details ActionDetails) (FoldContext, error) {
	var fctx FoldContext
	switch details.Kind() {
	case "register":
		if issuer, ok := details.Str("issuer"); ok {
			fctx.Issuer = issuer
		}
	case "freezeOutput":
		if op, ok := details.Str("outpoint"); ok {
			if ftxid, vout, ok := splitOutpoint(op); ok {
				row, err := l.store.GetTokenRow(ctx, ftxid, vout)
				if err != nil {
					return fctx, err
				}
				if row != nil {
					fctx.FrozenAmount = row.Amount
					fctx.FrozenOwner = row.IdentityKey
					fctx.HasFrozenRow = true
				}
			}
		}
	}
	return fctx, nil
}

// RebuildState replays the asset's surviving admin history from the default
// state and persists the result — the TS MandalaLookupService.rebuildState
// counterpart, used after an eviction has deleted rows (the incremental fold
// in OutputAdmittedByTopic cannot un-apply an action). The ordering cursor
// follows the last surviving row; with no rows left it is the default state.
func (l *LookupService) RebuildState(ctx context.Context, assetID string) (AssetAdminState, error) {
	rows, err := l.store.FindAdminHistoryByAssetID(ctx, assetID)
	if err != nil {
		return AssetAdminState{}, err
	}
	state := DefaultAssetState(assetID)
	for _, e := range rows {
		fctx, err := l.foldContext(ctx, e.ActionDetails)
		if err != nil {
			return AssetAdminState{}, err
		}
		state = FoldAction(state, e.ActionDetails, fctx)
		state.LastProcessedHeight = e.Height
		state.LastProcessedOffset = e.Offset
		state.LastAdmitSeq = e.AdmitSeq
	}
	if err := l.store.PutAssetState(ctx, state); err != nil {
		return AssetAdminState{}, err
	}
	return state, nil
}

// OutputSpent implements §4.3: decrement the identity's balance (if the spent
// token row had one) and delete the row, unconditionally.
func (l *LookupService) OutputSpent(ctx context.Context, p *engine.OutputSpent) error {
	if p.Topic != "tm_mandala" || p.Outpoint == nil {
		return nil
	}
	txid := p.Outpoint.Txid.String()
	vout := p.Outpoint.Index
	row, err := l.store.GetTokenRow(ctx, txid, vout)
	if err != nil {
		return err
	}
	if row != nil && row.IdentityKey != "" {
		if err := l.store.AdjustBalance(ctx, row.IdentityKey, -row.Amount); err != nil {
			return err
		}
	}
	return l.store.DeleteToken(ctx, txid, vout)
}

// OutputEvicted implements §4.4: legal eviction removes the token row and any
// metadata for the outpoint. No balance adjustment.
func (l *LookupService) OutputEvicted(ctx context.Context, outpoint *transaction.Outpoint) error {
	if outpoint == nil {
		return nil
	}
	txid := outpoint.Txid.String()
	if err := l.store.DeleteToken(ctx, txid, outpoint.Index); err != nil {
		return err
	}
	return l.store.DeleteMetadata(ctx, txid, outpoint.Index)
}

// OutputNoLongerRetainedInHistory is a no-op: ls_mandala keeps no
// history-retention state keyed on this notification.
func (l *LookupService) OutputNoLongerRetainedInHistory(context.Context, *transaction.Outpoint, string) error {
	return nil
}

// OutputBlockHeightUpdated is a no-op: admin-history ordering is fixed at
// admission time (§4.1 step 5) and is not revised on confirmation.
func (l *LookupService) OutputBlockHeightUpdated(context.Context, *chainhash.Hash, uint32, uint64) error {
	return nil
}

// lookupQuery is the parsed shape of a LookupQuestion.Query for ls_mandala.
// OutputIndex is a pointer so an explicit 0 is distinguishable from "absent".
type lookupQuery struct {
	MetadataAssetID string  `json:"metadataAssetId"`
	AssetID         string  `json:"assetId"`
	Txid            string  `json:"txid"`
	OutputIndex     *uint32 `json:"outputIndex"`
}

// Lookup implements §4.5, narrowed per the Go-port controller decision: only
// the outpoint-shaped query forms are served here (metadataAssetId, assetId,
// txid+outputIndex). assetStateAssetId/adminHistoryAssetId — the two
// non-UTXO shapes in the original TS precedence order — are intentionally
// NOT served through this protocol path in the Go port; the app's HTTP
// surface (Appendix B §1c) reaches asset state and admin history through
// dedicated endpoints instead, never via /lookup. See GetDocumentation.
func (l *LookupService) Lookup(ctx context.Context, q *lookup.LookupQuestion) (*lookup.LookupAnswer, error) {
	if q == nil {
		return nil, errors.New("Unsupported query")
	}
	var query lookupQuery
	if len(q.Query) > 0 {
		if err := json.Unmarshal(q.Query, &query); err != nil {
			return nil, fmt.Errorf("ls_mandala: invalid query: %w", err)
		}
	}
	switch {
	case query.MetadataAssetID != "":
		ops, err := l.store.FindMetadataByAssetID(ctx, query.MetadataAssetID)
		if err != nil {
			return nil, err
		}
		return outpointAnswer(ops)
	case query.AssetID != "":
		ops, err := l.store.FindByAssetID(ctx, query.AssetID) // already evicted-filtered
		if err != nil {
			return nil, err
		}
		return outpointAnswer(ops)
	case query.Txid != "" && query.OutputIndex != nil:
		ops, err := l.store.FindByOutpoint(ctx, query.Txid, *query.OutputIndex)
		if err != nil {
			return nil, err
		}
		return outpointAnswer(ops)
	default:
		return nil, errors.New("Unsupported query")
	}
}

// outpointAnswer builds the formula-shaped LookupAnswer the engine hydrates
// into BEEF-bearing OutputListItems (go-overlay-services@v1.3.2
// engine.go:734-745: any Type other than "output-list"/"freeform" runs
// hydrateFormulas over .Formulas using each Outpoint).
func outpointAnswer(ops []Outpoint) (*lookup.LookupAnswer, error) {
	formulas := make([]lookup.LookupFormula, 0, len(ops))
	for _, op := range ops {
		outpoint, err := transaction.OutpointFromString(fmtOutpoint(op.Txid, op.OutputIndex))
		if err != nil {
			return nil, fmt.Errorf("ls_mandala: outpoint %s.%d: %w", op.Txid, op.OutputIndex, err)
		}
		formulas = append(formulas, lookup.LookupFormula{Outpoint: outpoint})
	}
	return &lookup.LookupAnswer{Type: lookup.AnswerTypeFormula, Formulas: formulas}, nil
}

// txOrdering implements §4.1 step 5 / the brief's txOrdering rule: a tx with
// no merkle path yet orders after everything confirmed (MAX_SAFE_INTEGER
// height, offset 0); otherwise the offset is that of the level-0 leaf whose
// hash matches txid (display hex) AND carries the txid flag, defaulting to 0
// if no such leaf is found.
func txOrdering(tx *transaction.Transaction, txid string) (height, offset int64) {
	mp := tx.MerklePath
	if mp == nil || len(mp.Path) == 0 {
		return maxSafeHeight, 0
	}
	height = int64(mp.BlockHeight)
	for _, el := range mp.Path[0] {
		if el == nil || el.Hash == nil || el.Txid == nil || !*el.Txid {
			continue
		}
		if el.Hash.String() == txid {
			return height, int64(el.Offset)
		}
	}
	return height, 0
}

// splitOutpoint parses the "<txid>.<vout>" outpoint/assetId string form
// (Appendix A §0.2), returning ok=false if malformed.
func splitOutpoint(s string) (txid string, vout uint32, ok bool) {
	dot := strings.LastIndexByte(s, '.')
	if dot < 0 {
		return "", 0, false
	}
	n, err := strconv.ParseUint(s[dot+1:], 10, 32)
	if err != nil {
		return "", 0, false
	}
	return s[:dot], uint32(n), true
}

// GetDocumentation describes ls_mandala's projection rules and the
// intentional Lookup narrowing to outpoint-shaped queries.
func (l *LookupService) GetDocumentation() string {
	return "ls_mandala projects tm_mandala admissions into per-outpoint token " +
		"rows, per-identity balances, retained BRC-72 linkage records, admin " +
		"metadata, ordered admin-history entries, and folded per-asset admin " +
		"state; it decrements balances and deletes the token row when an output " +
		"is spent, and deletes both token and metadata rows on legal eviction. " +
		"Lookup is intentionally narrowed to outpoint-shaped queries only " +
		"(metadataAssetId, assetId, and txid+outputIndex, each answered as a " +
		"UTXO reference list) — asset-state and admin-history queries are NOT " +
		"served via this protocol path in the Go port; the application reaches " +
		"them through dedicated HTTP endpoints instead."
}

// GetMetaData names the lookup service.
func (l *LookupService) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{
		Name:        "ls_mandala",
		Description: "Projections and outpoint lookups for BRC-92 Mandala regulated fungible tokens and admin actions.",
	}
}

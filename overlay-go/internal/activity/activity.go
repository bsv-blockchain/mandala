// Package activity is a case-for-case Go port of overlay/src/activity.ts —
// the overlay-wide transaction activity feed that backs GET /admin/activity
// (Appendix B §3e).
//
// Built entirely from data the overlay operator already holds:
//   - mandalaLinkageRecords (append-only): every FT output ever admitted,
//     with the identityKey proven via revealSpecificKeyLinkage at
//     submission time (mandalav2.Store.ListLinkage / FindLinkageByOutpoints).
//   - the engine's raw transaction store: lets us decode amounts/assetIds
//     for every output — including spent ones — and walk each tx's inputs
//     back to their source outpoints to identify the sender (Deps.FindRawTxs,
//     wired over the enginestore's per-output BEEFs).
//
// Each transaction is summarised semantically (sender -> recipient, net
// units moved) rather than per-output: outputs are a technical detail (one
// is usually change back to the sender). Classification falls out of token
// conservation:
//   - no FT inputs                          -> issue   (minted to recipient)
//   - outputs to someone other than sender  -> transfer (amount = external outs)
//   - all outputs to sender, in > out       -> redeem  (amount = burned units)
//   - all outputs to sender, in = out       -> self    (0 units transferred)
package activity

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalav2"
)

// groupOverlap is GROUP_OVERLAP from activity.ts: extra linkage rows fetched
// past the page size so a tx whose outputs straddle the boundary can be
// dropped whole and re-served complete on the next page. Must be >= the
// most linkage rows one tx can carry: a transfer writes up to 9 (recipient +
// 8 split change outputs — MAX_FT_CHANGE_OUTPUTS in the app), or a limit-1
// page filled by one such tx never advances its cursor.
const groupOverlap = 9

// Deps are the overlay operator's data sources buildActivity reads from —
// the Go mirror of TS ActivityDeps.
type Deps struct {
	// ListLinkage returns newest-first linkage records, capped at limit;
	// when before is set, only rows with createdAt <= before (inclusive —
	// see Page.NextCursor).
	ListLinkage func(ctx context.Context, limit int64, before *time.Time) ([]mandalav2.LinkageRow, error)
	// FindLinkageByOutpoints returns linkage records for specific outpoints
	// (senders of spent outputs).
	FindLinkageByOutpoints func(ctx context.Context, outpoints []mandalav2.Outpoint) ([]mandalav2.LinkageRow, error)
	// FindRawTxs returns raw tx hex by txid, for every txid the engine has
	// seen. Missing txids are simply absent from the returned map.
	FindRawTxs func(ctx context.Context, txids []string) (map[string]string, error)
}

// Opts mirrors buildActivity's options bag. Limit's zero value doubles as
// "unspecified" (mapped to the 100 default) since Go has no cheap way to
// distinguish an omitted HTTP query param from an explicit 0 without a
// pointer — the same divergence mandalav2.Store.PageAdminHistory already makes
// from TS's `Number(x) || 100`.
type Opts struct {
	AssetID string
	Limit   int64
	Before  *time.Time
}

// Proof is the Go mirror of TS ActivityProof.
type Proof struct {
	OutputIndex  uint32 `json:"outputIndex"`
	IdentityKey  string `json:"identityKey"`
	KeyID        string `json:"keyID"`
	Counterparty string `json:"counterparty"`
	ProofType    int    `json:"proofType"`
}

// Entry is the Go mirror of TS ActivityEntry. From/To are nullable
// (recipient/sender may not exist for issue/redeem); Proofs is never nil —
// callers always populate it with make([]Proof, 0, ...).
type Entry struct {
	Txid    string  `json:"txid"`
	When    string  `json:"when"`
	AssetID string  `json:"assetId"`
	Kind    string  `json:"kind"`
	From    *string `json:"from"`
	To      *string `json:"to"`
	Amount  int64   `json:"amount"`
	Proofs  []Proof `json:"proofs"`
}

// Page is the Go mirror of TS ActivityPage. NextCursor is inclusive
// (createdAt <= cursor) so a tx group dropped at this page's boundary is
// re-served complete — consumers must dedupe entries by txid across pages
// (keep the first occurrence).
type Page struct {
	Entries    []Entry `json:"entries"`
	NextCursor *string `json:"nextCursor"`
}

// FtInput is one FT-carrying input, resolved by joining the input's source
// outpoint against linkage rows (identityKey) and the source raw tx
// (amount/assetId) — TS's inline ftInputs element type.
type FtInput struct {
	IdentityKey string
	Amount      int64
	AssetID     string
}

// FtOutput is one decoded MandalaToken output, owner attached from the
// group's linkage rows — TS's FtOutput interface.
type FtOutput struct {
	OutputIndex uint32
	IdentityKey string
	Amount      int64
	AssetID     string
}

// SummarizeParams is summarizeTx's parameter object in TS.
type SummarizeParams struct {
	Txid      string
	When      string
	FtInputs  []FtInput
	FtOutputs []FtOutput
	Proofs    []Proof
}

// SummarizeTx is the pure classifier — case-for-case port of TS summarizeTx.
// Exported for tests, exactly as in TS.
func SummarizeTx(p SummarizeParams) *Entry {
	if len(p.FtInputs) == 0 && len(p.FtOutputs) == 0 {
		return nil // no FT movement (pure admin tx)
	}

	assetID := ""
	if len(p.FtOutputs) > 0 {
		assetID = p.FtOutputs[0].AssetID
	} else if len(p.FtInputs) > 0 {
		assetID = p.FtInputs[0].AssetID
	}

	var inTotal, outTotal int64
	for _, i := range p.FtInputs {
		inTotal += i.Amount
	}
	for _, o := range p.FtOutputs {
		outTotal += o.Amount
	}

	proofs := p.Proofs
	if proofs == nil {
		proofs = []Proof{}
	}

	var sender string
	hasSender := false
	if len(p.FtInputs) > 0 {
		sender = p.FtInputs[0].IdentityKey
		hasSender = sender != ""
	}

	if !hasSender {
		// Nothing verifiably spent — minted supply. Recipient = largest
		// output. (largestOutputIdentity returns nil only when FtOutputs is
		// empty, matching TS's `to?.identityKey ?? null` on an undefined
		// array[0].)
		to := largestOutputIdentity(p.FtOutputs)
		return &Entry{Txid: p.Txid, When: p.When, AssetID: assetID, Kind: "issue", From: nil, To: to, Amount: outTotal, Proofs: proofs}
	}

	var external []FtOutput
	for _, o := range p.FtOutputs {
		if o.IdentityKey != sender && o.IdentityKey != "" {
			external = append(external, o)
		}
	}
	if len(external) > 0 {
		best := 0
		var sum int64
		for i, o := range external {
			if o.Amount > external[best].Amount {
				best = i
			}
			sum += o.Amount
		}
		from, to := sender, external[best].IdentityKey
		return &Entry{Txid: p.Txid, When: p.When, AssetID: assetID, Kind: "transfer", From: &from, To: &to, Amount: sum, Proofs: proofs}
	}
	if inTotal > outTotal {
		from := sender
		return &Entry{Txid: p.Txid, When: p.When, AssetID: assetID, Kind: "redeem", From: &from, To: nil, Amount: inTotal - outTotal, Proofs: proofs}
	}
	from, to := sender, sender
	return &Entry{Txid: p.Txid, When: p.When, AssetID: assetID, Kind: "self", From: &from, To: &to, Amount: 0, Proofs: proofs}
}

// largestOutputIdentity picks the identityKey of the largest-amount output,
// first occurrence winning ties (mirrors TS's stable
// `[...outs].sort((a,b) => b.amount - a.amount)[0]`). Returns nil only when
// outs is empty.
func largestOutputIdentity(outs []FtOutput) *string {
	if len(outs) == 0 {
		return nil
	}
	best := 0
	for i, o := range outs {
		if o.Amount > outs[best].Amount {
			best = i
		}
	}
	id := outs[best].IdentityKey
	return &id
}

// decodeFtOutputs decodes every MandalaToken output of tx, attaching owner
// identities from the linkage-derived owners map (outputIndex ->
// identityKey; missing entries default to "" exactly like TS's
// `owners.get(i) ?? ”`). Non-FT outputs are silently skipped, matching
// TS's per-output try/catch.
func decodeFtOutputs(tx *transaction.Transaction, owners map[uint32]string) []FtOutput {
	out := make([]FtOutput, 0, len(tx.Outputs))
	for i, o := range tx.Outputs {
		decoded, err := mandalav2.DecodeToken(o.LockingScript)
		if err != nil {
			continue
		}
		out = append(out, FtOutput{
			OutputIndex: uint32(i),
			IdentityKey: owners[uint32(i)],
			Amount:      decoded.Amount,
			AssetID:     decoded.AssetID,
		})
	}
	return out
}

// isoMillis formats t exactly like JS's Date.prototype.toISOString(): UTC,
// millisecond precision, trailing 'Z'.
func isoMillis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// newestISO returns the ISO-8601 (millisecond, UTC) form of the newest
// createdAt among rows — TS's
// `rows.map(r => new Date(r.createdAt).toISOString()).sort().at(-1)`.
// Precondition: rows is non-empty (every call site derives it from a
// non-empty tx group).
func newestISO(rows []mandalav2.LinkageRow) string {
	max := rows[0].CreatedAt
	for _, r := range rows[1:] {
		if r.CreatedAt.After(max) {
			max = r.CreatedAt
		}
	}
	return isoMillis(max)
}

// Build is the case-for-case port of TS buildActivity.
func Build(ctx context.Context, deps Deps, opts Opts) (Page, error) {
	limit := opts.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}

	rows, err := deps.ListLinkage(ctx, limit+groupOverlap, opts.Before)
	if err != nil {
		return Page{}, err
	}
	hasMore := int64(len(rows)) == limit+groupOverlap

	// Group output-linkage rows by txid, newest first. order tracks
	// first-seen insertion order — the Go stand-in for a JS Map's iteration
	// order, since Go maps have none.
	order := make([]string, 0, len(rows))
	byTx := make(map[string][]mandalav2.LinkageRow, len(rows))
	for _, r := range rows {
		if _, ok := byTx[r.Txid]; !ok {
			order = append(order, r.Txid)
		}
		byTx[r.Txid] = append(byTx[r.Txid], r)
	}

	// When more rows exist past this page, the last (oldest) group may be
	// missing outputs that fall on the next page — drop it whole and let the
	// cursor re-serve it complete. Its newest row's createdAt is the cursor.
	var nextCursor *string
	if hasMore && len(order) > 1 {
		lastTxid := order[len(order)-1]
		dropped := byTx[lastTxid]
		delete(byTx, lastTxid)
		order = order[:len(order)-1]
		cursor := newestISO(dropped)
		nextCursor = &cursor
	}

	rawTxs, err := deps.FindRawTxs(ctx, order)
	if err != nil {
		return Page{}, err
	}

	// Collect every input's source outpoint across all txs (senders +
	// amounts). Parse failures on the *group* txs propagate (mirrors TS's
	// uncaught `Transaction.fromHex(raw)` in this loop).
	var sourceOutpoints []mandalav2.Outpoint
	parsed := make(map[string]*transaction.Transaction, len(order))
	for _, txid := range order {
		raw, ok := rawTxs[txid]
		if !ok {
			continue
		}
		tx, err := transaction.NewTransactionFromHex(raw)
		if err != nil {
			return Page{}, fmt.Errorf("activity: parse raw tx %s: %w", txid, err)
		}
		parsed[txid] = tx
		for _, in := range tx.Inputs {
			if in.SourceTXID != nil {
				sourceOutpoints = append(sourceOutpoints, mandalav2.Outpoint{
					Txid:        in.SourceTXID.String(),
					OutputIndex: in.SourceTxOutIndex,
				})
			}
		}
	}

	senderRows, err := deps.FindLinkageByOutpoints(ctx, sourceOutpoints)
	if err != nil {
		return Page{}, err
	}
	senderByOutpoint := make(map[string]mandalav2.LinkageRow, len(senderRows))
	for _, r := range senderRows {
		senderByOutpoint[fmt.Sprintf("%s.%d", r.Txid, r.OutputIndex)] = r
	}

	srcTxidSeen := make(map[string]bool, len(sourceOutpoints))
	srcTxids := make([]string, 0, len(sourceOutpoints))
	for _, o := range sourceOutpoints {
		if !srcTxidSeen[o.Txid] {
			srcTxidSeen[o.Txid] = true
			srcTxids = append(srcTxids, o.Txid)
		}
	}
	sourceRaw, err := deps.FindRawTxs(ctx, srcTxids)
	if err != nil {
		return Page{}, err
	}

	entries := make([]Entry, 0, len(order))
	for _, txid := range order {
		tx, ok := parsed[txid]
		if !ok {
			continue
		}
		linkRows := byTx[txid]

		owners := make(map[uint32]string, len(linkRows))
		for _, r := range linkRows {
			owners[r.OutputIndex] = r.IdentityKey
		}
		ftOutputs := decodeFtOutputs(tx, owners)

		// FT inputs: source outpoints whose linkage we hold, amounts decoded
		// from the source tx (the linkage row proves ownership; the raw tx
		// carries value).
		var ftInputs []FtInput
		for _, in := range tx.Inputs {
			if in.SourceTXID == nil {
				continue
			}
			link, ok := senderByOutpoint[fmt.Sprintf("%s.%d", in.SourceTXID.String(), in.SourceTxOutIndex)]
			if !ok {
				continue
			}
			srcRaw, ok := sourceRaw[in.SourceTXID.String()]
			if !ok {
				continue
			}
			srcTx, err := transaction.NewTransactionFromHex(srcRaw)
			if err != nil {
				continue // unparseable source raw tx — matches TS's catch
			}
			if int(in.SourceTxOutIndex) >= len(srcTx.Outputs) {
				continue
			}
			decoded, err := mandalav2.DecodeToken(srcTx.Outputs[in.SourceTxOutIndex].LockingScript)
			if err != nil {
				continue // source output not an FT
			}
			ftInputs = append(ftInputs, FtInput{IdentityKey: link.IdentityKey, Amount: decoded.Amount, AssetID: decoded.AssetID})
		}

		when := newestISO(linkRows)
		proofs := make([]Proof, 0, len(linkRows))
		for _, r := range linkRows {
			proofs = append(proofs, Proof{
				OutputIndex:  r.OutputIndex,
				IdentityKey:  r.IdentityKey,
				KeyID:        r.Linkage.KeyID,
				Counterparty: r.Linkage.Counterparty,
				ProofType:    r.Linkage.ProofType,
			})
		}

		entry := SummarizeTx(SummarizeParams{Txid: txid, When: when, FtInputs: ftInputs, FtOutputs: ftOutputs, Proofs: proofs})
		if entry == nil {
			continue
		}
		if opts.AssetID != "" && entry.AssetID != opts.AssetID {
			continue
		}
		entries = append(entries, *entry)
	}

	sort.SliceStable(entries, func(i, j int) bool { return entries[i].When > entries[j].When })

	return Page{Entries: entries, NextCursor: nextCursor}, nil
}

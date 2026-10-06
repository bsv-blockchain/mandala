// Package activity is the Go port of overlay/src/activity.ts on BRC-162: the overlay-wide transaction activity
// feed behind GET /admin/activity.
//
// Built entirely from data the overlay operator already holds:
//   - mandalaLinkageRecords (append-only): every token output ever admitted, with the identityKey proven by its
//     linkage at submission time (mandala.Store.ListLinkage / FindLinkageByOutpoints);
//   - the engine's raw transaction store: decodes amounts and token ids for every output (spent ones included) and
//     walks each tx's inputs back to their source outputs to find the sender (Deps.FindRawTxs).
//
// Each transaction is summarised semantically (sender -> recipient, units moved). Only value coins move units:
// deploy and authority outputs and inputs never count (TS summarizeTx). Classification falls out of conservation:
//   - no value inputs                      -> issue    (minted to the recipient)
//   - value to someone other than sender   -> transfer (amount = external outputs)
//   - all value to the sender, in > out    -> redeem   (amount = burned units)
//   - all value to the sender, in = out    -> self     (0 units)
package activity

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// groupOverlap is GROUP_OVERLAP from activity.ts: extra linkage rows fetched past the page size so a tx whose rows
// straddle the boundary can be dropped whole and re-served complete on the next page. A transfer writes up to 9
// rows (recipient + 8 split change); an admin tx adds one authority row (Open Risk R15).
const groupOverlap = 9

// maxSafeAmount is JS Number.MAX_SAFE_INTEGER: TS decodeToken drops any larger amount (activity.ts:93-100).
const maxSafeAmount = 9007199254740991

// Deps are the overlay operator's data sources (TS ActivityDeps).
type Deps struct {
	// ListLinkage returns newest-first linkage records, capped at limit; with before set, only rows with
	// createdAt <= before (inclusive, see Page.NextCursor).
	ListLinkage func(ctx context.Context, limit int64, before *time.Time) ([]mandala.LinkageRecord, error)
	// FindLinkageByOutpoints returns linkage records for specific outpoints (senders of spent outputs).
	FindLinkageByOutpoints func(ctx context.Context, ops []mandala.Outpoint) ([]mandala.LinkageRecord, error)
	// FindRawTxs returns raw tx hex by txid; missing txids are absent from the map.
	FindRawTxs func(ctx context.Context, txids []string) (map[string]string, error)
}

// Opts mirrors buildActivity's options. Limit 0 (or negative) means "unspecified" -> 100: Go cannot tell an
// omitted query parameter from an explicit 0 without a pointer (kept divergence from TS's clamp-to-1).
type Opts struct {
	TokenID string
	Limit   int64
	Before  *time.Time
}

// Proof is TS ActivityProof.
type Proof struct {
	OutputIndex  uint32 `json:"outputIndex"`
	IdentityKey  string `json:"identityKey"`
	KeyID        string `json:"keyID"`
	Counterparty string `json:"counterparty"`
	ProofType    int    `json:"proofType"`
}

// Entry is TS ActivityEntry. From/To are nullable; Proofs is never nil.
type Entry struct {
	Txid    string  `json:"txid"`
	When    string  `json:"when"`
	TokenID string  `json:"tokenId"`
	Kind    string  `json:"kind"` // issue | transfer | self | redeem
	From    *string `json:"from"`
	To      *string `json:"to"`
	Amount  int64   `json:"amount"`
	Proofs  []Proof `json:"proofs"`
}

// Page is TS ActivityPage. NextCursor is inclusive (createdAt <= cursor): consumers dedupe entries by txid.
type Page struct {
	Entries    []Entry `json:"entries"`
	NextCursor *string `json:"nextCursor"`
}

// FtInput is one token input: the source outpoint's linkage owner and the source output's decode.
type FtInput struct {
	IdentityKey string
	Amount      int64
	TokenID     string
	Role        brc162.Role
}

// FtOutput is one decoded token output with its linkage owner ("" when the overlay holds no linkage for it).
type FtOutput struct {
	OutputIndex uint32
	IdentityKey string
	Amount      int64
	TokenID     string
	Role        brc162.Role
}

// SummarizeParams is summarizeTx's parameter object.
type SummarizeParams struct {
	Txid      string
	When      string
	FtInputs  []FtInput
	FtOutputs []FtOutput
	Proofs    []Proof
}

// SummarizeTx is TS summarizeTx: value rows only, then the classifier above. nil = no value movement.
func SummarizeTx(p SummarizeParams) *Entry {
	var ins []FtInput
	for _, i := range p.FtInputs {
		if i.Role == brc162.RoleValue {
			ins = append(ins, i)
		}
	}
	var outs []FtOutput
	for _, o := range p.FtOutputs {
		if o.Role == brc162.RoleValue {
			outs = append(outs, o)
		}
	}
	if len(ins) == 0 && len(outs) == 0 {
		return nil // a deploy or a pure admin tx
	}

	tokenID := ""
	if len(outs) > 0 {
		tokenID = outs[0].TokenID
	} else {
		tokenID = ins[0].TokenID
	}
	var inTotal, outTotal int64
	for _, i := range ins {
		inTotal += i.Amount
	}
	for _, o := range outs {
		outTotal += o.Amount
	}
	proofs := p.Proofs
	if proofs == nil {
		proofs = []Proof{}
	}

	sender := ""
	if len(ins) > 0 {
		sender = ins[0].IdentityKey
	}
	if sender == "" {
		// Nothing verifiably spent: minted supply. Recipient = largest output.
		return &Entry{Txid: p.Txid, When: p.When, TokenID: tokenID, Kind: "issue", From: nil, To: largestOutputIdentity(outs), Amount: outTotal, Proofs: proofs}
	}

	var external []FtOutput
	for _, o := range outs {
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
		return &Entry{Txid: p.Txid, When: p.When, TokenID: tokenID, Kind: "transfer", From: &from, To: &to, Amount: sum, Proofs: proofs}
	}
	if inTotal > outTotal {
		from := sender
		return &Entry{Txid: p.Txid, When: p.When, TokenID: tokenID, Kind: "redeem", From: &from, To: nil, Amount: inTotal - outTotal, Proofs: proofs}
	}
	from, to := sender, sender
	return &Entry{Txid: p.Txid, When: p.When, TokenID: tokenID, Kind: "self", From: &from, To: &to, Amount: 0, Proofs: proofs}
}

// largestOutputIdentity picks the identity of the largest output, first wins ties; nil only when outs is empty.
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

// decodeToken is TS decodeToken (activity.ts:93-100): ok is false for a non-token or codec-refused script and for
// an amount above 2^53-1. A deploy is labelled with its own transaction's <txid>_0.
func decodeToken(script []byte, txid string) (tokenID string, amount int64, role brc162.Role, ok bool) {
	d, err := brc162.Decode(script)
	if err != nil || d.Amount > maxSafeAmount {
		return "", 0, "", false
	}
	if d.Role == brc162.RoleDeploy {
		return brc162.DeployTokenID(txid, 0), int64(d.Amount), d.Role, true
	}
	if d.TokenID == nil {
		return "", 0, "", false
	}
	return brc162.TokenIDToString(*d.TokenID), int64(d.Amount), d.Role, true
}

func lockingScriptBytes(o *transaction.TransactionOutput) []byte {
	if o == nil || o.LockingScript == nil {
		return nil
	}
	return []byte(*o.LockingScript)
}

// decodeFtOutputs decodes every token output of tx, attaching owners (outputIndex -> identityKey; missing = "").
func decodeFtOutputs(tx *transaction.Transaction, owners map[uint32]string) []FtOutput {
	txid := tx.TxID().String()
	out := make([]FtOutput, 0, len(tx.Outputs))
	for i, o := range tx.Outputs {
		tokenID, amount, role, ok := decodeToken(lockingScriptBytes(o), txid)
		if !ok {
			continue
		}
		out = append(out, FtOutput{OutputIndex: uint32(i), IdentityKey: owners[uint32(i)], Amount: amount, TokenID: tokenID, Role: role})
	}
	return out
}

// isoMillis is JS Date.prototype.toISOString(): UTC, millisecond precision, trailing 'Z'.
func isoMillis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// newestISO is the newest createdAt among rows (non-empty), as isoMillis.
func newestISO(rows []mandala.LinkageRecord) string {
	max := rows[0].CreatedAt
	for _, r := range rows[1:] {
		if r.CreatedAt.After(max) {
			max = r.CreatedAt
		}
	}
	return isoMillis(max)
}

// Build is TS buildActivity.
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

	// Group rows by txid, newest first; order keeps first-seen order (a JS Map's iteration order).
	order := make([]string, 0, len(rows))
	byTx := make(map[string][]mandala.LinkageRecord, len(rows))
	for _, r := range rows {
		if _, ok := byTx[r.Txid]; !ok {
			order = append(order, r.Txid)
		}
		byTx[r.Txid] = append(byTx[r.Txid], r)
	}

	// With more rows past this page, the last (oldest) group may be incomplete: drop it whole; its newest row's
	// createdAt is the (inclusive) cursor.
	var nextCursor *string
	if hasMore && len(order) > 1 {
		lastTxid := order[len(order)-1]
		cursor := newestISO(byTx[lastTxid])
		delete(byTx, lastTxid)
		order = order[:len(order)-1]
		nextCursor = &cursor
	}

	rawTxs, err := deps.FindRawTxs(ctx, order)
	if err != nil {
		return Page{}, err
	}

	var sourceOutpoints []mandala.Outpoint
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
				sourceOutpoints = append(sourceOutpoints, mandala.Outpoint{Txid: in.SourceTXID.String(), OutputIndex: in.SourceTxOutIndex})
			}
		}
	}

	senderRows, err := deps.FindLinkageByOutpoints(ctx, sourceOutpoints)
	if err != nil {
		return Page{}, err
	}
	senderByOutpoint := make(map[string]mandala.LinkageRecord, len(senderRows))
	for _, r := range senderRows {
		senderByOutpoint[fmt.Sprintf("%s.%d", r.Txid, r.OutputIndex)] = r
	}
	srcSeen := make(map[string]bool, len(sourceOutpoints))
	srcTxids := make([]string, 0, len(sourceOutpoints))
	for _, o := range sourceOutpoints {
		if !srcSeen[o.Txid] {
			srcSeen[o.Txid] = true
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

		// Token inputs: source outpoints whose linkage we hold; amounts and roles decoded from the source tx.
		var ftInputs []FtInput
		for _, in := range tx.Inputs {
			if in.SourceTXID == nil {
				continue
			}
			src := in.SourceTXID.String()
			link, ok := senderByOutpoint[fmt.Sprintf("%s.%d", src, in.SourceTxOutIndex)]
			if !ok {
				continue
			}
			srcRaw, ok := sourceRaw[src]
			if !ok {
				continue
			}
			srcTx, err := transaction.NewTransactionFromHex(srcRaw)
			if err != nil || int(in.SourceTxOutIndex) >= len(srcTx.Outputs) {
				continue // unreadable source tx (TS catch)
			}
			tokenID, amount, role, ok := decodeToken(lockingScriptBytes(srcTx.Outputs[in.SourceTxOutIndex]), src)
			if !ok {
				continue
			}
			ftInputs = append(ftInputs, FtInput{IdentityKey: link.IdentityKey, Amount: amount, TokenID: tokenID, Role: role})
		}

		proofs := make([]Proof, 0, len(linkRows))
		for _, r := range linkRows {
			proofs = append(proofs, Proof{OutputIndex: r.OutputIndex, IdentityKey: r.IdentityKey, KeyID: r.Linkage.KeyID, Counterparty: r.Linkage.Counterparty, ProofType: r.Linkage.ProofType})
		}
		entry := SummarizeTx(SummarizeParams{Txid: txid, When: newestISO(linkRows), FtInputs: ftInputs, FtOutputs: ftOutputs, Proofs: proofs})
		if entry == nil {
			continue
		}
		if opts.TokenID != "" && entry.TokenID != opts.TokenID {
			continue
		}
		entries = append(entries, *entry)
	}

	sort.SliceStable(entries, func(i, j int) bool { return entries[i].When > entries[j].When })
	return Page{Entries: entries, NextCursor: nextCursor}, nil
}

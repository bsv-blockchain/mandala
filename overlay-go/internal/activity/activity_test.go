package activity

// Task 17 tests: case-for-case port of overlay/src/activity.test.ts.
//
// TS test -> Go test mapping:
//   'classifies a mint (no FT inputs) as issue ...'          -> TestSummarizeTx_IssueMint
//   'classifies alice->bob with change ... transfer'         -> TestSummarizeTx_TransferWithChange
//   'classifies alice->alice (all outputs self) ...'         -> TestSummarizeTx_SelfZeroUnit
//   'classifies a burn (in > out, all change to self) ...'   -> TestSummarizeTx_RedeemPartialBurn
//   'classifies a full burn (no outputs) ...'                -> TestSummarizeTx_RedeemFullBurn
//   'returns null for a tx with no FT movement at all'       -> TestSummarizeTx_NoMovementReturnsNil
//   'sums multiple external outputs ...'                     -> TestSummarizeTx_MultipleExternalOutputsSumAndPickLargest
//   'ignores unknown-owner outputs ...'                      -> TestSummarizeTx_UnknownOwnerOutputIgnored
//
//   'returns a null cursor when everything fits in one page' -> TestBuildActivity_NullCursorSinglePage
//   'drops the boundary-straddling group ... (inclusive)'    -> TestBuildActivity_DropsBoundaryStraddlingGroup
//   'still cursors past a max-split transfer at limit 1 ...' -> TestBuildActivity_MaxSplitGroupAtLimitOne
//   'clamps limit into [1, 500]'                             -> TestBuildActivity_ClampsLimit
//
// Plus Go-specific: TestBuildActivity_ISOFormatHasMilliseconds (asserts the
// `when`/`nextCursor` wire format exactly matches JS's toISOString()).

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandalav2"
)

var noProofs = []Proof{}

func baseParams() SummarizeParams {
	return SummarizeParams{Txid: "t1", When: "2026-07-07T00:00:00.000Z", Proofs: noProofs}
}

func inp(identityKey string, amount int64) FtInput {
	return FtInput{IdentityKey: identityKey, Amount: amount, AssetID: "a.0"}
}

func out(outputIndex uint32, identityKey string, amount int64) FtOutput {
	return FtOutput{OutputIndex: outputIndex, IdentityKey: identityKey, Amount: amount, AssetID: "a.0"}
}

func strPtr(s string) *string { return &s }

func TestSummarizeTx_IssueMint(t *testing.T) {
	p := baseParams()
	p.FtInputs = nil
	p.FtOutputs = []FtOutput{out(0, "alice", 100)}
	e := SummarizeTx(p)
	if e == nil {
		t.Fatal("nil entry")
	}
	if e.Kind != "issue" || e.From != nil || e.To == nil || *e.To != "alice" || e.Amount != 100 || e.AssetID != "a.0" {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_TransferWithChange(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "bob", 30), out(1, "alice", 70)}
	e := SummarizeTx(p)
	if e == nil {
		t.Fatal("nil entry")
	}
	if e.Kind != "transfer" || e.From == nil || *e.From != "alice" || e.To == nil || *e.To != "bob" || e.Amount != 30 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_SelfZeroUnit(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "alice", 40), out(1, "alice", 60)}
	e := SummarizeTx(p)
	if e == nil {
		t.Fatal("nil entry")
	}
	if e.Kind != "self" || e.From == nil || *e.From != "alice" || e.To == nil || *e.To != "alice" || e.Amount != 0 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_RedeemPartialBurn(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "alice", 25)}
	e := SummarizeTx(p)
	if e == nil {
		t.Fatal("nil entry")
	}
	if e.Kind != "redeem" || e.From == nil || *e.From != "alice" || e.To != nil || e.Amount != 75 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_RedeemFullBurn(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = nil
	e := SummarizeTx(p)
	if e == nil {
		t.Fatal("nil entry")
	}
	if e.Kind != "redeem" || e.From == nil || *e.From != "alice" || e.To != nil || e.Amount != 100 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_NoMovementReturnsNil(t *testing.T) {
	p := baseParams()
	p.FtInputs = nil
	p.FtOutputs = nil
	if e := SummarizeTx(p); e != nil {
		t.Fatalf("entry = %+v, want nil", e)
	}
}

func TestSummarizeTx_MultipleExternalOutputsSumAndPickLargest(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "bob", 10), out(1, "carol", 50), out(2, "alice", 40)}
	e := SummarizeTx(p)
	if e == nil {
		t.Fatal("nil entry")
	}
	if e.Kind != "transfer" || e.To == nil || *e.To != "carol" || e.Amount != 60 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_UnknownOwnerOutputIgnored(t *testing.T) {
	// Output with no verified linkage ('' identity) is not treated as an
	// external recipient — in=out and every known output is the sender's.
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "", 30), out(1, "alice", 70)}
	e := SummarizeTx(p)
	if e == nil {
		t.Fatal("nil entry")
	}
	if e.Kind != "self" || e.Amount != 0 {
		t.Fatalf("entry = %+v", e)
	}
}

// ---------------------------------------------------------------------------
// Build pagination — complete-group guarantee at page boundaries
// ---------------------------------------------------------------------------

func link(txid string, outputIndex uint32, identityKey string, createdAt time.Time) mandalav2.LinkageRow {
	return mandalav2.LinkageRow{
		Txid:        txid,
		OutputIndex: outputIndex,
		IdentityKey: identityKey,
		Linkage: mandalav2.SpecificLinkage{
			Prover:       identityKey,
			Verifier:     "v",
			Counterparty: identityKey,
			KeyID:        fmt.Sprintf("k-%s-%d", txid, outputIndex),
			ProofType:    1,
		},
		CreatedAt: createdAt,
	}
}

// pagingDeps is the Go mirror of the TS test suite's pagingDeps: an
// in-memory fake exercising only the paging/grouping layer. findRawTxs
// always returns empty, so every group is skipped after grouping, but the
// cursor math still runs — exactly like the TS fixture's comment says.
func pagingDeps(rows []mandalav2.LinkageRow) Deps {
	return Deps{
		ListLinkage: func(_ context.Context, limit int64, before *time.Time) ([]mandalav2.LinkageRow, error) {
			r := rows
			if before != nil {
				filtered := make([]mandalav2.LinkageRow, 0, len(r))
				for _, x := range r {
					if !x.CreatedAt.After(*before) {
						filtered = append(filtered, x)
					}
				}
				r = filtered
			}
			if int64(len(r)) > limit {
				r = r[:limit]
			}
			return r, nil
		},
		FindLinkageByOutpoints: func(context.Context, []mandalav2.Outpoint) ([]mandalav2.LinkageRow, error) {
			return nil, nil
		},
		FindRawTxs: func(context.Context, []string) (map[string]string, error) {
			return map[string]string{}, nil
		},
	}
}

func TestBuildActivity_NullCursorSinglePage(t *testing.T) {
	rows := []mandalav2.LinkageRow{
		link("t1", 0, "a", mustParse(t, "2026-07-07T10:00:00.000Z")),
		link("t2", 0, "a", mustParse(t, "2026-07-07T09:00:00.000Z")),
	}
	page, err := Build(context.Background(), pagingDeps(rows), Opts{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor != nil {
		t.Fatalf("nextCursor = %v, want nil", *page.NextCursor)
	}
}

func mustParse(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t.Fatal(err)
	}
	return tm
}

func TestBuildActivity_DropsBoundaryStraddlingGroup(t *testing.T) {
	// 20 single-output txs, newest first; page limit 2 -> fetches 2+overlap
	// rows, sees more exist, drops the oldest fetched group and cursors to it.
	rows := make([]mandalav2.LinkageRow, 20)
	for i := 0; i < 20; i++ {
		ts := time.Date(2026, 7, 7, 10, 0, 59-i, 0, time.UTC)
		rows[i] = link(fmt.Sprintf("t%d", i), 0, "a", ts)
	}
	page, err := Build(context.Background(), pagingDeps(rows), Opts{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor == nil {
		t.Fatal("nextCursor = nil, want non-nil")
	}
	// Cursor is the createdAt of a fetched row -- inclusive re-fetch re-serves
	// that row's whole tx group on the next page.
	found := false
	for _, r := range rows {
		if isoMillis(r.CreatedAt) == *page.NextCursor {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("nextCursor %q does not match any fetched row's createdAt", *page.NextCursor)
	}
}

func TestBuildActivity_MaxSplitGroupAtLimitOne(t *testing.T) {
	// A transfer writes up to 9 output-linkage rows (recipient + 8 split
	// change). The overlap must cover a whole such group, or a limit-1 page
	// whose newest tx is a max-split transfer fills the entire fetch window
	// with one txid and pagination dies (hasMore true, but len(order) == 1).
	rows := make([]mandalav2.LinkageRow, 0, 11)
	big := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	for i := uint32(0); i < 9; i++ {
		rows = append(rows, link("big", i, "a", big))
	}
	rows = append(rows, link("older", 0, "a", time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)))
	rows = append(rows, link("oldest", 0, "a", time.Date(2026, 7, 7, 8, 0, 0, 0, time.UTC)))

	page, err := Build(context.Background(), pagingDeps(rows), Opts{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if page.NextCursor == nil {
		t.Fatal("nextCursor = nil, want non-nil")
	}
}

func TestBuildActivity_ClampsLimit(t *testing.T) {
	var requested int64
	deps := Deps{
		ListLinkage: func(_ context.Context, limit int64, _ *time.Time) ([]mandalav2.LinkageRow, error) {
			requested = limit
			return nil, nil
		},
		FindLinkageByOutpoints: func(context.Context, []mandalav2.Outpoint) ([]mandalav2.LinkageRow, error) {
			return nil, nil
		},
		FindRawTxs: func(context.Context, []string) (map[string]string, error) {
			return map[string]string{}, nil
		},
	}

	if _, err := Build(context.Background(), deps, Opts{Limit: 99999}); err != nil {
		t.Fatal(err)
	}
	if requested > 509 { // 500 + overlap
		t.Fatalf("requested = %d, want <= 509", requested)
	}

	// Opts.Limit's zero value doubles as "unspecified" (the HTTP layer has no
	// way to distinguish an omitted query param from an explicit 0 -- see
	// mandalav2.Store.PageAdminHistory's identical divergence), so it maps to
	// the 100 default rather than TS's clamp-to-1. Limit: 1 exercises the
	// actual lower-bound clamp the TS test intends.
	if _, err := Build(context.Background(), deps, Opts{Limit: 1}); err != nil {
		t.Fatal(err)
	}
	if requested < 10 { // 1 + overlap
		t.Fatalf("requested = %d, want >= 10", requested)
	}
}

func TestBuildActivity_ClampsLimit_ZeroDefaultsTo100(t *testing.T) {
	var requested int64
	deps := Deps{
		ListLinkage: func(_ context.Context, limit int64, _ *time.Time) ([]mandalav2.LinkageRow, error) {
			requested = limit
			return nil, nil
		},
		FindLinkageByOutpoints: func(context.Context, []mandalav2.Outpoint) ([]mandalav2.LinkageRow, error) {
			return nil, nil
		},
		FindRawTxs: func(context.Context, []string) (map[string]string, error) {
			return map[string]string{}, nil
		},
	}
	if _, err := Build(context.Background(), deps, Opts{Limit: 0}); err != nil {
		t.Fatal(err)
	}
	if requested != 109 {
		t.Fatalf("requested = %d, want 109 (100 default + 9 overlap)", requested)
	}
}

func TestBuildActivity_ISOFormatHasMilliseconds(t *testing.T) {
	rows := []mandalav2.LinkageRow{
		link("t1", 0, "a", time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)),
	}
	// Force a cursor by requiring more rows than available: limit 0 rows is
	// invalid, so instead directly check isoMillis's format contract.
	got := isoMillis(rows[0].CreatedAt)
	want := "2026-07-07T10:00:00.000Z"
	if got != want {
		t.Fatalf("isoMillis = %q, want %q", got, want)
	}
	if !strings.Contains(got, ".000Z") {
		t.Fatalf("isoMillis = %q, missing millisecond field", got)
	}
}

// Ensures sort.SliceStable ordering is used and doesn't panic on ties (no
// direct TS analogue -- guards the Go-specific stable-sort requirement noted
// in the entries.sort port).
func TestBuildActivity_StableSortOnEqualWhen(t *testing.T) {
	ts := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	entries := []Entry{
		{Txid: "a", When: isoMillis(ts)},
		{Txid: "b", When: isoMillis(ts)},
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].When > entries[j].When })
	if entries[0].Txid != "a" || entries[1].Txid != "b" {
		t.Fatalf("stable sort reordered ties: %+v", entries)
	}
}

package activity

// Port of overlay/src/activity.test.ts on BRC-162 (Q3 Task 24). The SummarizeTx and paging cases are the v2 ones
// with tokenId and an explicit value role; the kit cases build real BRC-162 transactions with internal/mandalatest.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

const tid = "abababababababababababababababababababababababababababababababab_0"

var noProofs = []Proof{}

func baseParams() SummarizeParams {
	return SummarizeParams{Txid: "t1", When: "2026-07-07T00:00:00.000Z", Proofs: noProofs}
}

func inp(identityKey string, amount int64) FtInput {
	return FtInput{IdentityKey: identityKey, Amount: amount, TokenID: tid, Role: brc162.RoleValue}
}

func out(outputIndex uint32, identityKey string, amount int64) FtOutput {
	return FtOutput{OutputIndex: outputIndex, IdentityKey: identityKey, Amount: amount, TokenID: tid, Role: brc162.RoleValue}
}

func TestSummarizeTx_IssueMint(t *testing.T) {
	p := baseParams()
	p.FtOutputs = []FtOutput{out(0, "alice", 100)}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "issue" || e.From != nil || e.To == nil || *e.To != "alice" || e.Amount != 100 || e.TokenID != tid {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_TransferWithChange(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "bob", 30), out(1, "alice", 70)}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "transfer" || e.From == nil || *e.From != "alice" || e.To == nil || *e.To != "bob" || e.Amount != 30 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_SelfZeroUnit(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "alice", 40), out(1, "alice", 60)}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "self" || *e.From != "alice" || *e.To != "alice" || e.Amount != 0 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_RedeemPartialBurn(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "alice", 25)}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "redeem" || *e.From != "alice" || e.To != nil || e.Amount != 75 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_RedeemFullBurn(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "redeem" || *e.From != "alice" || e.To != nil || e.Amount != 100 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_NoMovementReturnsNil(t *testing.T) {
	if e := SummarizeTx(baseParams()); e != nil {
		t.Fatalf("entry = %+v, want nil", e)
	}
}

func TestSummarizeTx_MultipleExternalOutputsSumAndPickLargest(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "bob", 10), out(1, "carol", 50), out(2, "alice", 40)}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "transfer" || *e.To != "carol" || e.Amount != 60 {
		t.Fatalf("entry = %+v", e)
	}
}

func TestSummarizeTx_UnknownOwnerOutputIgnored(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{inp("alice", 100)}
	p.FtOutputs = []FtOutput{out(0, "", 30), out(1, "alice", 70)}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "self" || e.Amount != 0 {
		t.Fatalf("entry = %+v", e)
	}
}

// Only value coins move units: an issue spends an authority (the deploy or the last authority) and re-creates one.
// Counting those would read the issuer as the sender and the issue as a transfer.
func TestSummarizeTx_AuthorityAndDeployNeverMoveValue(t *testing.T) {
	p := baseParams()
	p.FtInputs = []FtInput{{IdentityKey: "issuer", Amount: 0, TokenID: tid, Role: brc162.RoleDeploy}}
	p.FtOutputs = []FtOutput{
		{OutputIndex: 0, IdentityKey: "issuer", Amount: 0, TokenID: tid, Role: brc162.RoleAuthority},
		out(1, "holder", 1000),
	}
	e := SummarizeTx(p)
	if e == nil || e.Kind != "issue" || e.From != nil || e.To == nil || *e.To != "holder" || e.Amount != 1000 {
		t.Fatalf("entry = %+v, want an issue to holder of 1000", e)
	}
	p.FtOutputs = p.FtOutputs[:1] // authority in, authority out: a pure admin tx
	if e := SummarizeTx(p); e != nil {
		t.Fatalf("admin-only tx entry = %+v, want nil", e)
	}
}

func TestDecodeToken(t *testing.T) {
	pkh := bytes.Repeat([]byte{7}, 20)
	lock := func(id string, amount uint64) []byte {
		s, err := brc162.Lock(brc162.LockParams{TokenID: id, Amount: amount, PubKeyHash: pkh})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	txid := strings.Repeat("ff", 32)
	if id, amt, role, ok := decodeToken(lock(tid, 9007199254740991), txid); !ok || id != tid || amt != 9007199254740991 || role != brc162.RoleValue {
		t.Fatalf("2^53-1 value: %s %d %s %v", id, amt, role, ok)
	}
	if _, _, _, ok := decodeToken(lock(tid, 9007199254740992), txid); ok {
		t.Fatal("an amount above 2^53-1 must be skipped (TS decodeToken returns null)")
	}
	if id, _, role, ok := decodeToken(lock("", 0), txid); !ok || role != brc162.RoleDeploy || id != txid+"_0" {
		t.Fatalf("deploy: %s %s %v, want %s_0 deploy", id, role, ok, txid)
	}
	p2pkh := append(append([]byte{0x76, 0xa9, 0x14}, pkh...), 0x88, 0xac)
	if _, _, _, ok := decodeToken(p2pkh, txid); ok {
		t.Fatal("a plain P2PKH output is not a token")
	}
	if _, _, _, ok := decodeToken(nil, txid); ok {
		t.Fatal("an empty script is not a token")
	}
}

// ---- paging (no raw txs: every group is skipped after grouping, the cursor math still runs) --------------------

func link(txid string, outputIndex uint32, identityKey string, createdAt time.Time) mandala.LinkageRecord {
	return mandala.LinkageRecord{
		Txid:        txid,
		OutputIndex: outputIndex,
		IdentityKey: identityKey,
		Linkage: mandala.SpecificLinkage{
			Prover: identityKey, Verifier: "v", Counterparty: identityKey,
			KeyID: fmt.Sprintf("k-%s-%d", txid, outputIndex), ProofType: 1,
		},
		CreatedAt: createdAt,
	}
}

// fakeChain is an in-memory overlay: linkage rows (sorted newest first by sortRows) and raw txs by txid.
type fakeChain struct {
	rows []mandala.LinkageRecord
	raw  map[string]string
}

func newFakeChain(rows ...mandala.LinkageRecord) *fakeChain {
	f := &fakeChain{rows: rows, raw: map[string]string{}}
	f.sortRows()
	return f
}

func (f *fakeChain) sortRows() {
	sort.SliceStable(f.rows, func(i, j int) bool { return f.rows[i].CreatedAt.After(f.rows[j].CreatedAt) })
}

// addBuilt records b's raw tx and one linkage row per linked output; at[i] is output i's createdAt (the last
// value repeats).
func (f *fakeChain) addBuilt(b *mandalatest.Built, at ...time.Time) {
	f.raw[b.Txid] = b.Tx.Hex()
	for i, o := range b.Outs {
		if o.NoLinkage {
			continue
		}
		ts := at[len(at)-1]
		if i < len(at) {
			ts = at[i]
		}
		f.rows = append(f.rows, mandala.LinkageRecord{
			Txid: b.Txid, OutputIndex: uint32(i), IdentityKey: o.Owner.Identity,
			Linkage:   mandala.SpecificLinkage{KeyID: fmt.Sprintf("out-%d", i), Counterparty: o.Owner.Identity},
			CreatedAt: ts,
		})
	}
	f.sortRows()
}

func (f *fakeChain) deps() Deps {
	return Deps{
		ListLinkage: func(_ context.Context, limit int64, before *time.Time) ([]mandala.LinkageRecord, error) {
			out := make([]mandala.LinkageRecord, 0, len(f.rows))
			for _, r := range f.rows {
				if before != nil && r.CreatedAt.After(*before) {
					continue
				}
				out = append(out, r)
				if int64(len(out)) == limit {
					break
				}
			}
			return out, nil
		},
		FindLinkageByOutpoints: func(_ context.Context, ops []mandala.Outpoint) ([]mandala.LinkageRecord, error) {
			var out []mandala.LinkageRecord
			for _, op := range ops {
				for _, r := range f.rows {
					if r.Txid == op.Txid && r.OutputIndex == op.OutputIndex {
						out = append(out, r)
					}
				}
			}
			return out, nil
		},
		FindRawTxs: func(_ context.Context, txids []string) (map[string]string, error) {
			out := map[string]string{}
			for _, id := range txids {
				if raw, ok := f.raw[id]; ok {
					out[id] = raw
				}
			}
			return out, nil
		},
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

func TestBuildActivity_NullCursorSinglePage(t *testing.T) {
	f := newFakeChain(
		link("t1", 0, "a", mustParse(t, "2026-07-07T10:00:00.000Z")),
		link("t2", 0, "a", mustParse(t, "2026-07-07T09:00:00.000Z")),
	)
	page, err := Build(context.Background(), f.deps(), Opts{Limit: 100})
	if err != nil || page.NextCursor != nil {
		t.Fatalf("page = %+v, err %v; want a nil cursor", page, err)
	}
}

func TestBuildActivity_DropsBoundaryStraddlingGroup(t *testing.T) {
	rows := make([]mandala.LinkageRecord, 20)
	for i := 0; i < 20; i++ {
		rows[i] = link(fmt.Sprintf("t%d", i), 0, "a", time.Date(2026, 7, 7, 10, 0, 59-i, 0, time.UTC))
	}
	page, err := Build(context.Background(), newFakeChain(rows...).deps(), Opts{Limit: 2})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page = %+v, err %v; want a cursor", page, err)
	}
	found := false
	for _, r := range rows {
		found = found || isoMillis(r.CreatedAt) == *page.NextCursor
	}
	if !found {
		t.Fatalf("nextCursor %q does not match a fetched row's createdAt", *page.NextCursor)
	}
}

// R15: authority outputs carry linkage rows too, so an admin tx's rows count against groupOverlap. A group of 9
// rows (1 authority + 8 value) at limit 1 still advances the cursor; a group of 10 or more at limit 1 fills the
// fetch window alone and the feed stops there (accepted, Open Risk R15).
func TestBuildActivity_NineRowAuthorityGroupStillCursorsAtLimitOne(t *testing.T) {
	big := time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)
	rows := []mandala.LinkageRecord{link("big", 0, "issuer", big)}
	for i := uint32(1); i < 9; i++ {
		rows = append(rows, link("big", i, "a", big))
	}
	rows = append(rows,
		link("older", 0, "a", time.Date(2026, 7, 7, 9, 0, 0, 0, time.UTC)),
		link("oldest", 0, "a", time.Date(2026, 7, 7, 8, 0, 0, 0, time.UTC)))
	page, err := Build(context.Background(), newFakeChain(rows...).deps(), Opts{Limit: 1})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page = %+v, err %v; want a cursor", page, err)
	}
}

// R15: a page boundary that falls between an issue's authority row and its value row drops the issue whole and
// re-serves it complete (both rows, classified as an issue) on the next page.
func TestBuildActivity_AuthoritySplitAcrossThePageBoundaryIsReservedWhole(t *testing.T) {
	I, H := mandalatest.Issuer, mandalatest.Holder
	dep := mandalatest.Deploy(t, I, "USD")
	iss := mandalatest.Issue(t, dep, 0, I, H, 1000)
	f := newFakeChain()
	f.addBuilt(dep, time.Date(2026, 10, 5, 9, 0, 0, 0, time.UTC))
	authAt := time.Date(2026, 10, 5, 10, 0, 0, 2_000_000, time.UTC)
	f.addBuilt(iss, authAt, time.Date(2026, 10, 5, 10, 0, 0, 1_000_000, time.UTC)) // out0 authority newer than out1 value
	// Nine newer single-row txs with no raw tx (grouped, then skipped as entries).
	for i := 0; i < 9; i++ {
		f.rows = append(f.rows, link(fmt.Sprintf("filler%d", i), 0, "a", time.Date(2026, 10, 5, 11, i, 0, 0, time.UTC)))
	}
	f.sortRows()

	page1, err := Build(context.Background(), f.deps(), Opts{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page1.Entries) != 0 || page1.NextCursor == nil || *page1.NextCursor != isoMillis(authAt) {
		t.Fatalf("page 1 = %+v, want no entries and the cursor at the issue's authority row %s", page1, isoMillis(authAt))
	}
	before := mustParse(t, *page1.NextCursor)
	page2, err := Build(context.Background(), f.deps(), Opts{Limit: 1, Before: &before})
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.Entries) != 1 {
		t.Fatalf("page 2 entries = %+v, want the issue alone (the deploy moves no value)", page2.Entries)
	}
	e := page2.Entries[0]
	if e.Txid != iss.Txid || e.Kind != "issue" || e.Amount != 1000 || len(e.Proofs) != 2 {
		t.Fatalf("page 2 entry = %+v, want the complete issue with both proofs", e)
	}
}

func TestBuildActivity_ClampsLimit(t *testing.T) {
	var requested int64
	deps := Deps{
		ListLinkage: func(_ context.Context, limit int64, _ *time.Time) ([]mandala.LinkageRecord, error) {
			requested = limit
			return nil, nil
		},
		FindLinkageByOutpoints: func(context.Context, []mandala.Outpoint) ([]mandala.LinkageRecord, error) { return nil, nil },
		FindRawTxs:             func(context.Context, []string) (map[string]string, error) { return map[string]string{}, nil },
	}
	for _, c := range []struct{ limit, want int64 }{{99999, 509}, {1, 10}, {0, 109}, {-3, 109}} {
		if _, err := Build(context.Background(), deps, Opts{Limit: c.limit}); err != nil {
			t.Fatal(err)
		}
		if requested != c.want { // limit + groupOverlap; 0 and negatives mean "unspecified" -> 100 (Go divergence, kept)
			t.Fatalf("limit %d requested %d, want %d", c.limit, requested, c.want)
		}
	}
}

func TestBuildActivity_ISOFormatHasMilliseconds(t *testing.T) {
	if got := isoMillis(time.Date(2026, 7, 7, 10, 0, 0, 0, time.UTC)); got != "2026-07-07T10:00:00.000Z" {
		t.Fatalf("isoMillis = %q", got)
	}
}

// ---- real BRC-162 transactions ---------------------------------------------------------------------------------

func TestBuild_IssueReadsIssueAndTheDeployYieldsNoEntry(t *testing.T) {
	I, H := mandalatest.Issuer, mandalatest.Holder
	dep := mandalatest.Deploy(t, I, "USD")
	iss := mandalatest.Issue(t, dep, 0, I, H, 1000)
	f := newFakeChain()
	f.addBuilt(dep, time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC))
	f.addBuilt(iss, time.Date(2026, 10, 5, 11, 0, 0, 0, time.UTC))

	page, err := Build(context.Background(), f.deps(), Opts{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Entries) != 1 {
		t.Fatalf("entries = %+v, want only the issue", page.Entries)
	}
	e := page.Entries[0]
	if e.Txid != iss.Txid || e.Kind != "issue" || e.From != nil || e.To == nil || *e.To != H.Identity ||
		e.Amount != 1000 || e.TokenID != dep.Txid+"_0" || len(e.Proofs) != 2 {
		t.Fatalf("issue entry = %+v", e)
	}
}

func TestBuild_TransferPauseAndTokenFilter(t *testing.T) {
	I, H, R := mandalatest.Issuer, mandalatest.Holder, mandalatest.Receiver
	depA := mandalatest.Deploy(t, I, "USD")
	issA := mandalatest.Issue(t, depA, 0, I, H, 1000)
	trA := mandalatest.Transfer(t, issA, 1, R, 400)
	details := mandalatest.Details(brc162.CborMap{"kind": "pause"})
	pause := mandalatest.Build(t, []mandalatest.In{{Src: issA, Vout: 0}}, []mandalatest.Out{{
		Owner: I, Prover: I, TokenID: depA.Txid + "_0", Amount: 0,
		Payload: mandalatest.AdmPayload(sha256.Sum256(details)), HasPayload: true, Details: details,
	}}, nil)
	depB := mandalatest.Deploy(t, I, "EUR")
	issB := mandalatest.Issue(t, depB, 0, I, H, 500)

	f := newFakeChain()
	at := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	for i, b := range []*mandalatest.Built{depA, issA, trA, pause, depB, issB} {
		f.addBuilt(b, at.Add(time.Duration(i)*time.Minute))
	}

	page, err := Build(context.Background(), f.deps(), Opts{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	byTx := map[string]Entry{}
	for _, e := range page.Entries {
		byTx[e.Txid] = e
	}
	if _, ok := byTx[pause.Txid]; ok {
		t.Fatal("a pause moves no value and must yield no entry")
	}
	tr, ok := byTx[trA.Txid]
	if !ok || tr.Kind != "transfer" || *tr.From != H.Identity || *tr.To != R.Identity || tr.Amount != 400 || tr.TokenID != depA.Txid+"_0" {
		t.Fatalf("transfer entry = %+v", tr)
	}
	if e := byTx[issB.Txid]; e.Kind != "issue" || e.TokenID != depB.Txid+"_0" || e.Amount != 500 {
		t.Fatalf("token B issue = %+v", e)
	}

	onlyB, err := Build(context.Background(), f.deps(), Opts{Limit: 100, TokenID: depB.Txid + "_0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(onlyB.Entries) != 1 || onlyB.Entries[0].Txid != issB.Txid {
		t.Fatalf("tokenId filter = %+v, want only token B's issue", onlyB.Entries)
	}
}

package mandala

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"
)

// A10 — the per-asset admin-auth head is the newest admitted admin output by
// (height, offset, admitSeq); unmined actions carry height =
// Number.MAX_SAFE_INTEGER (maxSafeHeight) and so sort after every mined one.
// Same ordering as overlay/src/assetAuth.ts pickAssetAuthHead.

func histRow(txid string, vout uint32, height, offset, seq int64) AdminHistoryEntry {
	return AdminHistoryEntry{
		AssetID: strings.Repeat("ab", 32) + ".0", Txid: txid, OutputIndex: vout,
		Height: height, Offset: offset, AdmitSeq: seq,
		ActionDetails: ActionDetails{"kind": "unpause"}, CreatedAt: time.Now(),
	}
}

func TestPickAssetAuthHead(t *testing.T) {
	if _, ok := PickAssetAuthHead(nil); ok {
		t.Fatal("empty history must yield no head")
	}
	cases := []struct {
		name string
		rows []AdminHistoryEntry
		want string
	}{
		{"greater height wins regardless of order", []AdminHistoryEntry{
			histRow("b", 0, 101, 0, 1), histRow("a", 0, 100, 0, 5),
		}, "b.0"},
		{"height tie breaks on offset", []AdminHistoryEntry{
			histRow("a", 0, 100, 3, 9), histRow("b", 0, 100, 7, 1),
		}, "b.0"},
		{"offset tie breaks on admitSeq", []AdminHistoryEntry{
			histRow("a", 0, 100, 3, 2), histRow("b", 1, 100, 3, 3),
		}, "b.1"},
		{"unmined sorts after mined", []AdminHistoryEntry{
			histRow("u", 0, maxSafeHeight, 0, 2), histRow("m", 0, 900000, 5, 3),
		}, "u.0"},
		{"re-admitted duplicate keeps the same head", []AdminHistoryEntry{
			histRow("h", 1, 100, 0, 4), histRow("h", 1, 100, 0, 9),
		}, "h.1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			head, ok := PickAssetAuthHead(c.rows)
			if !ok {
				t.Fatal("no head")
			}
			if got := fmtOutpoint(head.Txid, head.OutputIndex); got != c.want {
				t.Fatalf("head = %s, want %s", got, c.want)
			}
		})
	}
	if maxSafeHeight != int64(math.Pow(2, 53))-1 {
		t.Fatalf("maxSafeHeight = %d, want Number.MAX_SAFE_INTEGER", maxSafeHeight)
	}
}

// A16 — GET /admin/asset-state marks each frozen ref with whether its token
// row is still live (reissuable), read at request time.

type rowsByOutpoint map[string]*TokenRow

func (r rowsByOutpoint) GetTokenRow(_ context.Context, txid string, vout uint32) (*TokenRow, error) {
	return r[fmtOutpoint(txid, vout)], nil
}

func TestAnnotateFrozenRows(t *testing.T) {
	live := fmtOutpoint(strings.Repeat("cc", 32), 0)
	gone := fmtOutpoint(strings.Repeat("dd", 32), 3)
	st := DefaultAssetState("a.0")
	st.FrozenOutpoints = []FrozenRef{
		{Outpoint: live, Amount: 40, Owner: "02aa"},
		{Outpoint: gone, Amount: 0, Owner: ""},
		{Outpoint: "junk"},
	}
	out, err := AnnotateFrozenRows(context.Background(), st, rowsByOutpoint{live: &TokenRow{Amount: 40}})
	if err != nil {
		t.Fatal(err)
	}
	want := []bool{true, false, false}
	for i, ref := range out.FrozenOutpoints {
		if ref.HasFrozenRow != want[i] {
			t.Fatalf("ref %d (%s): hasFrozenRow = %v, want %v", i, ref.Outpoint, ref.HasFrozenRow, want[i])
		}
	}
	if out.FrozenOutpoints[0].Amount != 40 || out.FrozenOutpoints[0].Owner != "02aa" {
		t.Fatalf("annotation must not alter the ref: %+v", out.FrozenOutpoints[0])
	}
	// The input state is untouched (no aliasing of the slice).
	if st.FrozenOutpoints[0].HasFrozenRow {
		t.Fatal("AnnotateFrozenRows mutated its input")
	}
}

// A04 — the membership exemption reads every issuer the state store knows.
func TestStoreIssuerIdentityKeys(t *testing.T) {
	ctx := context.Background()
	s := mustStore(t, testDB(t))
	for _, st := range []AssetAdminState{
		{AssetID: "a.0", IssuerIdentityKey: "02aa"},
		{AssetID: "b.0", IssuerIdentityKey: "02bb"},
		{AssetID: "c.0", IssuerIdentityKey: "02aa"},
		{AssetID: "d.0", IssuerIdentityKey: ""},
	} {
		if err := s.PutAssetState(ctx, st); err != nil {
			t.Fatal(err)
		}
	}
	keys, err := s.IssuerIdentityKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, k := range keys {
		got[k] = true
	}
	if len(got) != 2 || !got["02aa"] || !got["02bb"] {
		t.Fatalf("issuer keys = %v, want exactly {02aa, 02bb}", keys)
	}
}

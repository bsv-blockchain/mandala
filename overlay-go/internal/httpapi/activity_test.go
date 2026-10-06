package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/sirdeggen/mandala/overlay-go/internal/activity"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// actFixture is an in-memory ActivityLinkage plus raw txs.
type actFixture struct {
	rows []mandala.LinkageRecord // newest first
	raw  map[string]string
}

var _ ActivityLinkage = (*actFixture)(nil)

func (f *actFixture) add(b *mandalatest.Built, at time.Time) {
	f.raw[b.Txid] = b.Tx.Hex()
	var rows []mandala.LinkageRecord
	for i, o := range b.Outs {
		rows = append(rows, mandala.LinkageRecord{
			Txid: b.Txid, OutputIndex: uint32(i), IdentityKey: o.Owner.Identity,
			Linkage:   mandala.SpecificLinkage{KeyID: fmt.Sprintf("out-%d", i), Counterparty: o.Owner.Identity},
			CreatedAt: at,
		})
	}
	f.rows = append(rows, f.rows...) // callers add oldest first
}

func (f *actFixture) ListLinkage(_ context.Context, limit int64, before *time.Time) ([]mandala.LinkageRecord, error) {
	var out []mandala.LinkageRecord
	for _, r := range f.rows {
		if before != nil && r.CreatedAt.After(*before) {
			continue
		}
		if int64(len(out)) == limit {
			break
		}
		out = append(out, r)
	}
	return out, nil
}

func (f *actFixture) FindLinkageByOutpoints(_ context.Context, ops []mandala.Outpoint) ([]mandala.LinkageRecord, error) {
	var out []mandala.LinkageRecord
	for _, op := range ops {
		for _, r := range f.rows {
			if r.Txid == op.Txid && r.OutputIndex == op.OutputIndex {
				out = append(out, r)
			}
		}
	}
	return out, nil
}

func (f *actFixture) findRawTxs(_ context.Context, txids []string) (map[string]string, error) {
	out := map[string]string{}
	for _, id := range txids {
		if raw, ok := f.raw[id]; ok {
			out[id] = raw
		}
	}
	return out, nil
}

// actTwoTokens: token A and token B each deployed and issued to the holder.
func actTwoTokens(t *testing.T) (*actFixture, *mandalatest.Built, *mandalatest.Built, *mandalatest.Built, *mandalatest.Built) {
	t.Helper()
	I, H := mandalatest.Issuer, mandalatest.Holder
	depA := mandalatest.Deploy(t, I, "USD")
	issA := mandalatest.Issue(t, depA, 0, I, H, 1000)
	depB := mandalatest.Deploy(t, I, "EUR")
	issB := mandalatest.Issue(t, depB, 0, I, H, 500)
	f := &actFixture{raw: map[string]string{}}
	at := time.Date(2026, 10, 5, 10, 0, 0, 0, time.UTC)
	for i, b := range []*mandalatest.Built{depA, issA, depB, issB} {
		f.add(b, at.Add(time.Duration(i)*time.Minute))
	}
	return f, depA, issA, depB, issB
}

func actGet(t *testing.T, f *fiber.App, path string, headers map[string]string) (int, []byte) {
	t.Helper()
	code, _, body := tokGet(t, f, path, headers)
	return code, body
}

func TestActivityRouteValidatesTokenID(t *testing.T) {
	fx, _, _, _, _ := actTwoTokens(t)
	f := newServer(nil, nil, nil, nil, WithActivity(fx, fx.findRawTxs))
	hex := strings.Repeat("ab", 32)
	for _, q := range []string{"?tokenId=", "?tokenId=abc", "?tokenId=" + hex + ".0", "?tokenId=" + strings.ToUpper(hex) + "_0", "?tokenId=" + hex + "_1"} {
		code, body := actGet(t, f, "/admin/activity"+q, nil)
		tokRequireJSON(t, code, body, 400, `{"error":"invalid tokenId"}`)
	}
	code, body := actGet(t, f, "/admin/activity?before=yesterday", nil)
	tokRequireJSON(t, code, body, 400, `{"error":"invalid before: must be an RFC3339 timestamp"}`)
}

func TestActivityRouteFiltersByTokenID(t *testing.T) {
	fx, depA, issA, _, issB := actTwoTokens(t)
	f := newServer(nil, nil, nil, nil, WithActivity(fx, fx.findRawTxs))
	decode := func(body []byte) activity.Page {
		var p activity.Page
		if err := json.Unmarshal(body, &p); err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		return p
	}
	code, body := actGet(t, f, "/admin/activity", nil)
	if p := decode(body); code != 200 || len(p.Entries) != 2 || p.Entries[0].Txid != issB.Txid || p.Entries[1].Txid != issA.Txid {
		t.Fatalf("unfiltered: %d %s", code, body)
	}
	code, body = actGet(t, f, "/admin/activity?tokenId="+depA.Txid+"_0", nil)
	p := decode(body)
	if code != 200 || len(p.Entries) != 1 || p.Entries[0].Txid != issA.Txid || p.Entries[0].Kind != "issue" || p.Entries[0].TokenID != depA.Txid+"_0" {
		t.Fatalf("?tokenId=A: %d %s", code, body)
	}
}

func TestActivityRouteIsGatedAndMountedOnlyWithWithActivity(t *testing.T) {
	fx, _, _, _, _ := actTwoTokens(t)
	f := newServer(nil, nil, nil, nil, WithActivity(fx, fx.findRawTxs), WithAdminAPIToken("console-secret"))
	code, body := actGet(t, f, "/admin/activity", nil)
	tokRequireJSON(t, code, body, 401, `{"error":"unauthorized"}`)
	if code, body = actGet(t, f, "/admin/activity", map[string]string{"Authorization": "Bearer console-secret"}); code != http.StatusOK {
		t.Fatalf("with the bearer token: %d %s", code, body)
	}
	bare := newServer(nil, nil, nil, nil)
	if code, _ = actGet(t, bare, "/admin/activity", nil); code != 404 {
		t.Fatalf("without WithActivity: %d, want the 404 catch-all", code)
	}
}

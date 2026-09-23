package wiring

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// Rebuild-first eviction: assets → rebuild each (excluding the txid) → delete.
// The rows are the only record of which assets need a rebuild, so a delete
// before a failed rebuild would strand the asset's stale state forever.
func TestRebuildThenPurgeAdminHistoryOrder(t *testing.T) {
	var order []string
	rows := map[string]bool{"tx": true}
	failB := true
	deps := evictHistoryDeps{
		assetsTouched: func(_ context.Context, txid string) ([]string, error) {
			order = append(order, "assets")
			if rows[txid] {
				return []string{"a.0", "b.0"}, nil
			}
			return []string{}, nil
		},
		rebuildExcluding: func(_ context.Context, assetID, txid string) error {
			order = append(order, "rebuild("+assetID+","+txid+")")
			if failB && assetID == "b.0" {
				return errors.New("mongo down")
			}
			return nil
		},
		purge: func(_ context.Context, txid string) error {
			order = append(order, "purge")
			delete(rows, txid)
			return nil
		},
	}

	err := rebuildThenPurgeAdminHistory(context.Background(), "tx", deps)
	if err == nil || !strings.HasPrefix(err.Error(), "wiring: rebuild asset state b.0 after evicting tx") {
		t.Fatalf("err = %v, want wiring rebuild error", err)
	}
	if want := []string{"assets", "rebuild(a.0,tx)", "rebuild(b.0,tx)"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v (no purge after a failed rebuild)", order, want)
	}
	if !rows["tx"] {
		t.Fatal("rows deleted despite failed rebuild")
	}

	// The retry finds the rows still there and runs the whole sequence.
	failB = false
	order = nil
	if err := rebuildThenPurgeAdminHistory(context.Background(), "tx", deps); err != nil {
		t.Fatal(err)
	}
	if want := []string{"assets", "rebuild(a.0,tx)", "rebuild(b.0,tx)", "purge"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("retry order = %v, want %v", order, want)
	}
	if rows["tx"] {
		t.Fatal("rows not purged on successful retry")
	}
}

func TestRebuildThenPurgeAdminHistoryErrors(t *testing.T) {
	boom := errors.New("boom")
	purged := false
	err := rebuildThenPurgeAdminHistory(context.Background(), "tx", evictHistoryDeps{
		assetsTouched:    func(context.Context, string) ([]string, error) { return nil, boom },
		rebuildExcluding: func(context.Context, string, string) error { t.Fatal("rebuild called"); return nil },
		purge:            func(context.Context, string) error { purged = true; return nil },
	})
	if !errors.Is(err, boom) || !strings.HasPrefix(err.Error(), "wiring: find assets touched by tx") || purged {
		t.Fatalf("assets failure: err=%v purged=%v", err, purged)
	}
	err = rebuildThenPurgeAdminHistory(context.Background(), "tx", evictHistoryDeps{
		assetsTouched:    func(context.Context, string) ([]string, error) { return []string{"a.0"}, nil },
		rebuildExcluding: func(context.Context, string, string) error { return nil },
		purge:            func(context.Context, string) error { return boom },
	})
	if !errors.Is(err, boom) || !strings.HasPrefix(err.Error(), "wiring: purge admin history of tx") {
		t.Fatalf("purge failure: err=%v", err)
	}
}

package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func openAll(t *testing.T) []struct {
	name string
	s    *Store
	c    *clock
} {
	t.Helper()
	c1 := &clock{t: time.Unix(1_758_500_000, 0)}
	s1, err := Open("sqlite", filepath.Join(t.TempDir(), "fk.sqlite"), c1.now)
	require.NoError(t, err)
	t.Cleanup(func() { _ = s1.Close() })
	all := []struct {
		name string
		s    *Store
		c    *clock
	}{{"sqlite", s1, c1}}
	if url := os.Getenv("FK_TEST_PG_URL"); url != "" {
		c2 := &clock{t: c1.t}
		s2, err := Open("postgres", url, c2.now)
		require.NoError(t, err)
		require.NoError(t, s2.truncateForTests(context.Background()))
		t.Cleanup(func() { _ = s2.Close() })
		all = append(all, struct {
			name string
			s    *Store
			c    *clock
		}{"postgres", s2, c2})
	}
	return all
}

func cand(op string) Candidate {
	return Candidate{Outpoint: op, Satoshis: 200, FuelScript: "76a914", FuelBeef: "0100beef", DerivationPrefix: "p", DerivationSuffix: "s"}
}

func TestClaimCommitConsumeLifecycle(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			ok, err := s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			require.NoError(t, err)
			require.True(t, ok)
			ok, err = s.Claim(ctx, cand("aa.0"), "req2", "02bb", "asset.0", 0, 60)
			require.NoError(t, err)
			require.False(t, ok, "second claim of a reserving row must lose")

			n, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0", FeeScript: "fee", KeyID: "fee-aa.0", FeeAmount: "20"}}, 600)
			require.NoError(t, err)
			require.EqualValues(t, 1, n)
			rows, _ := s.ByRequest(ctx, "req1")
			require.Equal(t, StatusReserved, rows[0].Status)
			require.Equal(t, e.c.t.Unix()+600, rows[0].ExpiresAt)

			ref, err := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req2"}})
			require.NoError(t, err)
			require.Equal(t, &ConsumeRefusal{Outpoint: "aa.0", Reason: "reserved by another request"}, ref)
			ref, err = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.NoError(t, err)
			require.Nil(t, ref)
			ref, _ = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.Nil(t, ref, "same txid is idempotent")
			ref, _ = s.Consume(ctx, "tx2", []ConsumeItem{{"aa.0", "req1"}})
			require.Equal(t, "consumed by another txid", ref.Reason)
			ref, _ = s.Consume(ctx, "tx1", []ConsumeItem{{"zz.9", "req1"}})
			require.Equal(t, "unknown", ref.Reason)

			n, err = s.ReleaseRequest(ctx, "req1")
			require.NoError(t, err)
			require.EqualValues(t, 0, n, "release never touches consumed rows")
			ok, err = s.MarkSettled(ctx, "aa.0", "tx1")
			require.NoError(t, err)
			require.True(t, ok)
			rows, _ = s.ByTxid(ctx, "tx1")
			require.NotNil(t, rows[0].SettledAt)
		})
	}
}

func TestConsumeIsAllOrNothing(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			for i, op := range []string{"aa.0", "aa.1"} {
				ok, _ := s.Claim(ctx, cand(op), "req1", "02aa", "asset.0", i, 60)
				require.True(t, ok)
			}
			_, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}, {Outpoint: "aa.1"}}, 600)
			require.NoError(t, err)
			ref, err := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}, {"aa.1", "other"}})
			require.NoError(t, err)
			require.Equal(t, "aa.1", ref.Outpoint)
			rows, _ := s.ByRequest(ctx, "req1")
			for _, r := range rows {
				require.Equal(t, StatusReserved, r.Status, "refused batch must roll back %s", r.Outpoint)
			}
		})
	}
}

func TestReleaseExpiryRecheckAndDeny(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			ok, _ := s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			require.True(t, ok)
			_, _ = s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}}, 600)
			e.c.t = e.c.t.Add(601 * time.Second)
			n, err := s.ExpireReserved(ctx)
			require.NoError(t, err)
			require.EqualValues(t, 1, n)
			pend, _ := s.RecheckPending(ctx, 10)
			require.Len(t, pend, 1)
			ok, err = s.SetRechecked(ctx, "aa.0", true)
			require.NoError(t, err)
			require.True(t, ok)
			c, _ := s.ReleasedCandidates(ctx, 10)
			require.Len(t, c, 1)
			require.Equal(t, "0100beef", c[0].FuelBeef)
			require.Equal(t, "p", c[0].DerivationPrefix)

			// Late submit of a released, not re-drafted row is allowed for its last holder.
			ref, _ := s.Consume(ctx, "tx9", []ConsumeItem{{"aa.0", "req1"}})
			require.Nil(t, ref)
			// Eviction release puts it back to recheck; a chain "spent" verdict denies the requester.
			n, _ = s.ReleaseEvicted(ctx, "tx9", []string{"aa.0"})
			require.EqualValues(t, 1, n)
			ok, err = s.SetRechecked(ctx, "aa.0", false)
			require.NoError(t, err)
			require.True(t, ok)
			rows, _ := s.ByTxid(ctx, "tx9")
			require.Equal(t, StatusSpentExternal, rows[0].Status)
			require.NoError(t, s.Deny(ctx, "02aa", "spent_external", "aa.0"))
			d, _ := s.IsDenied(ctx, "02aa")
			require.True(t, d)
			ok, _ = s.Undeny(ctx, "02aa")
			require.True(t, ok)
			// /settle repairs a wrongful release/spent_external for the matching txid.
			ok, _ = s.MarkSettled(ctx, "aa.0", "tx9")
			require.True(t, ok)
		})
	}
}

func TestReservingExpiryAndDrop(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			_, _ = s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			_, _ = s.Claim(ctx, cand("aa.1"), "req1", "02aa", "asset.0", 1, 60)
			require.NoError(t, s.Drop(ctx, "aa.1", "req1"))
			e.c.t = e.c.t.Add(61 * time.Second)
			exp, _ := s.ExpiredReserving(ctx)
			require.Len(t, exp, 1)
			require.Equal(t, "aa.0", exp[0].Outpoint)
			n, _ := s.ReleaseReserving(ctx, "req1", false)
			require.EqualValues(t, 1, n)
			ok, _ := s.Claim(ctx, cand("aa.1"), "req2", "02bb", "asset.0", 0, 60)
			require.False(t, ok, "dropped is terminal")
		})
	}
}

func TestQuotas(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			q := Quotas{MaxOutstanding: 1, DailyPairs: 3, PairsPerMinute: 100}
			v, err := s.BeginRequest(ctx, "n1", "02aa", e.c.t.Unix(), q)
			require.NoError(t, err)
			require.Equal(t, VerdictOK, v)
			v, _ = s.BeginRequest(ctx, "n1", "02aa", e.c.t.Unix(), q)
			require.Equal(t, VerdictNonceUsed, v)
			_, _ = s.Claim(ctx, cand("aa.0"), "n1", "02aa", "asset.0", 0, 60)
			_, _ = s.Commit(ctx, "n1", []CommitPair{{Outpoint: "aa.0"}}, 600)
			v, _ = s.BeginRequest(ctx, "n2", "02aa", e.c.t.Unix(), q)
			require.Equal(t, VerdictQuota, v, "outstanding reserved drafts ≥ MaxOutstanding")
			v, _ = s.BeginRequest(ctx, "n3", "02bb", e.c.t.Unix(), q)
			require.Equal(t, VerdictOK, v, "quota is per requester")
			v, _ = s.BeginRequest(ctx, "n4", "02cc", e.c.t.Unix(), Quotas{MaxOutstanding: 5, DailyPairs: 5, PairsPerMinute: 1})
			require.Equal(t, VerdictUnavailable, v, "global per-minute cap counts pairs created in the last minute")
		})
	}
}

func TestCounts(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			_, _ = e.s.Claim(ctx, cand("aa.0"), "r", "02aa", "a.0", 0, 60)
			m, recheck, unsettled, denied, err := e.s.Counts(ctx)
			require.NoError(t, err)
			require.Equal(t, 1, m[StatusReserving])
			require.Zero(t, recheck+unsettled+denied)
		})
	}
}

package store

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Supplements the brief's store_test.go: the Postgres rebind (which cannot run
// on a host without Postgres), the claim reset path, batch edge cases and
// concurrent CAS races.

func TestRebindDollar(t *testing.T) {
	require.Equal(t, `a=$1 AND b='x?''?' AND c=$2`, rebindDollar(`a=? AND b='x?''?' AND c=?`))
	got := rebindDollar(claimSQL)
	require.NotContains(t, got, "?")
	require.Contains(t, got, "$13)")
	require.NotContains(t, got, "$14")
	require.Contains(t, got, "'reserving'")
	sq := &Store{driver: DriverSQLite}
	require.Equal(t, claimSQL, sq.q(claimSQL))
	require.Equal(t, "", sq.forUpdate())
	pg := &Store{driver: DriverPostgres}
	require.True(t, strings.HasSuffix(pg.q(`SELECT 1 WHERE x=?`+pg.forUpdate()), "$1 FOR UPDATE"))
}

func TestOpenRejectsBadInput(t *testing.T) {
	_, err := Open("mysql", "x", nil)
	require.Error(t, err)
	_, err = Open(DriverSQLite, "fk.sqlite?mode=ro", nil)
	require.Error(t, err)
}

func TestSQLiteDSNApplied(t *testing.T) {
	s := openAll(t)[0].s
	var mode string
	require.NoError(t, s.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode))
	require.Equal(t, "wal", mode)
	var busy int
	require.NoError(t, s.db.QueryRow(`PRAGMA busy_timeout`).Scan(&busy))
	require.Equal(t, 5000, busy)
}

func TestReclaimResetsPreviousHolder(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			ok, _ := s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			require.True(t, ok)
			_, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0", FeeScript: "fee", KeyID: "fee-aa.0", FeeAmount: "20"}}, 600)
			require.NoError(t, err)
			ref, _ := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.Nil(t, ref)
			ok, _ = s.MarkSettled(ctx, "aa.0", "tx1")
			require.True(t, ok)
			n, _ := s.ReleaseEvicted(ctx, "tx1", []string{"aa.0"})
			require.EqualValues(t, 1, n)

			ok, err = s.Claim(ctx, cand("aa.0"), "req2", "02bb", "asset.1", 3, 60)
			require.NoError(t, err)
			require.False(t, ok, "released awaiting recheck is not claimable")
			ok, err = s.SetRechecked(ctx, "aa.0", true)
			require.NoError(t, err)
			require.True(t, ok)

			e.c.t = e.c.t.Add(time.Hour)
			c := cand("aa.0")
			c.FuelBeef, c.DerivationPrefix = "ffff", "other"
			ok, err = s.Claim(ctx, c, "req2", "02bb", "asset.1", 3, 60)
			require.NoError(t, err)
			require.True(t, ok)
			rows, _ := s.ByRequest(ctx, "req2")
			require.Len(t, rows, 1)
			r := rows[0]
			require.Equal(t, StatusReserving, r.Status)
			require.Equal(t, "02bb", r.Requester)
			require.Equal(t, "asset.1", r.AssetID)
			require.Equal(t, 3, r.PairIndex)
			require.Empty(t, r.Txid)
			require.Empty(t, r.FeeScript+r.KeyID+r.FeeAmount)
			require.Nil(t, r.SettledAt, "a stale settled_at would hide the next consume from the sweeper")
			require.False(t, r.NeedsRecheck)
			require.Equal(t, "0100beef", r.FuelBeef, "stored BEEF kept on the update path")
			require.Equal(t, "p", r.DerivationPrefix)
			require.Equal(t, e.c.t.Unix(), r.CreatedAt, "re-claim counts toward quotas")
			require.Equal(t, e.c.t.Unix()+60, r.ExpiresAt)
		})
	}
}

func TestConsumeEdgeCases(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			for i, op := range []string{"aa.0", "aa.1"} {
				ok, _ := s.Claim(ctx, cand(op), "req1", "02aa", "asset.0", i, 60)
				require.True(t, ok)
			}
			ref, _ := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.Equal(t, &ConsumeRefusal{Outpoint: "aa.0", Reason: "unknown"}, ref, "reserving is not consumable")
			_, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}, {Outpoint: "aa.1"}}, 600)
			require.NoError(t, err)

			ref, err = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.1", "req1"}, {"aa.1", "req1"}, {"aa.0", "req1"}})
			require.NoError(t, err)
			require.Nil(t, ref, "a repeated outpoint in one batch is idempotent")
			rows, _ := s.ByTxid(ctx, "tx1")
			require.Len(t, rows, 2)

			_, err = s.Consume(ctx, "", []ConsumeItem{{"aa.0", "req1"}})
			require.Error(t, err)

			n, _ := s.ReleaseEvicted(ctx, "tx1", []string{"aa.0", "aa.1"})
			require.EqualValues(t, 2, n)
			ref, _ = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.Equal(t, "unknown", ref.Reason, "released awaiting recheck is not consumable")
			ok, err := s.SetRechecked(ctx, "aa.0", true)
			require.NoError(t, err)
			require.True(t, ok)
			ref, _ = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "someone-else"}})
			require.Equal(t, "unknown", ref.Reason, "late submit only for the last holder")
		})
	}
}

func TestCommitConflictRollsBack(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			_, _ = s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			_, _ = s.Claim(ctx, cand("aa.1"), "req1", "02aa", "asset.0", 1, 60)
			require.NoError(t, s.Drop(ctx, "aa.1", "req1"))
			n, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}, {Outpoint: "aa.1"}}, 600)
			require.True(t, errors.Is(err, ErrCommitConflict))
			require.Zero(t, n)
			rows, _ := s.ByRequest(ctx, "req1")
			require.Equal(t, StatusReserving, rows[0].Status, "aa.0 must not be committed alone")
			n, _ = s.Commit(ctx, "req2", []CommitPair{{Outpoint: "aa.0"}}, 600)
			require.Zero(t, n)
		})
	}
}

func TestBeginRequestRefusalDoesNotBurnNonce(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			v, err := e.s.BeginRequest(ctx, "n1", "02aa", 1, Quotas{})
			require.NoError(t, err)
			require.Equal(t, VerdictQuota, v, "zero limits fail closed")
			v, err = e.s.BeginRequest(ctx, "n1", "02aa", 1, Quotas{MaxOutstanding: 1, DailyPairs: 1, PairsPerMinute: 1})
			require.NoError(t, err)
			require.Equal(t, VerdictOK, v)
		})
	}
}

func TestClaimRejectsUnsafeSatoshis(t *testing.T) {
	s := openAll(t)[0].s
	c := cand("aa.0")
	c.Satoshis = math.MaxUint64
	_, err := s.Claim(context.Background(), c, "req1", "02aa", "asset.0", 0, 60)
	require.Error(t, err)
}

func TestConcurrentCASHasOneWinner(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			const n = 16
			type claimResult struct {
				req string
				ok  bool
				err error
			}
			claims := make(chan claimResult, n)
			var wg sync.WaitGroup
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					req := "req" + string(rune('a'+i))
					ok, err := s.Claim(ctx, cand("aa.0"), req, "02aa", "asset.0", 0, 60)
					claims <- claimResult{req, ok, err}
				}(i)
			}
			wg.Wait()
			close(claims)
			var winners []string
			for c := range claims {
				require.NoError(t, c.err, "a losing claim must be refused, never errored")
				if c.ok {
					winners = append(winners, c.req)
				}
			}
			require.Len(t, winners, 1)
			_, err := s.Commit(ctx, winners[0], []CommitPair{{Outpoint: "aa.0"}}, 600)
			require.NoError(t, err)

			type consumeResult struct {
				txid string
				ref  *ConsumeRefusal
				err  error
			}
			consumes := make(chan consumeResult, n)
			for i := 0; i < n; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					txid := "tx" + string(rune('a'+i))
					ref, err := s.Consume(ctx, txid, []ConsumeItem{{"aa.0", winners[0]}})
					consumes <- consumeResult{txid, ref, err}
				}(i)
			}
			wg.Wait()
			close(consumes)
			var consumed []string
			for c := range consumes {
				require.NoError(t, c.err, "a losing consume must be refused, never errored")
				if c.ref == nil {
					consumed = append(consumed, c.txid)
					continue
				}
				require.Equal(t, &ConsumeRefusal{Outpoint: "aa.0", Reason: "consumed by another txid"}, c.ref)
			}
			require.Len(t, consumed, 1)
			rows, _ := s.ByTxid(ctx, consumed[0])
			require.Len(t, rows, 1)
		})
	}
}

func TestSetRecheckedMissesMovedRow(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			ok, _ := s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
			require.True(t, ok)
			_, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}}, 600)
			require.NoError(t, err)
			ref, _ := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}})
			require.Nil(t, ref)
			before, _ := s.ByTxid(ctx, "tx1")
			require.Len(t, before, 1)

			e.c.t = e.c.t.Add(time.Minute)
			for _, unspent := range []bool{false, true} {
				ok, err := s.SetRechecked(ctx, "aa.0", unspent)
				require.NoError(t, err)
				require.False(t, ok, "no transition on a consumed row (unspent=%v)", unspent)
			}
			after, _ := s.ByTxid(ctx, "tx1")
			require.Equal(t, before, after, "row unchanged, including updated_at")
		})
	}
}

func TestInputGuards(t *testing.T) {
	s := openAll(t)[0].s
	ctx := context.Background()
	_, err := s.Claim(ctx, cand(""), "req1", "02aa", "asset.0", 0, 60)
	require.Error(t, err)
	_, err = s.Claim(ctx, cand("aa.0"), "req1", "", "asset.0", 0, 60)
	require.Error(t, err)
	_, err = s.Claim(ctx, cand("aa.0"), "", "02aa", "asset.0", 0, 60)
	require.Error(t, err)

	ok, err := s.Claim(ctx, cand("aa.0"), "req1", "02aa", "asset.0", 0, 60)
	require.NoError(t, err)
	require.True(t, ok)
	_, err = s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}}, 600)
	require.NoError(t, err)
	ref, err := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}, {"", "req1"}})
	require.Error(t, err)
	require.Nil(t, ref)
	ref, err = s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", ""}})
	require.Error(t, err)
	require.Nil(t, ref)
	rows, _ := s.ByRequest(ctx, "req1")
	require.Equal(t, StatusReserved, rows[0].Status, "a rejected batch changes nothing")
}

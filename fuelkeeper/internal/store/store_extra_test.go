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

// A released row is never issued again (spec §13 rev 3, §4.5: no
// `released → reserving`): its earlier holder still holds a valid fuel
// signature. Claim loses on every known outpoint, whatever its state, and
// leaves the row exactly as it was; the last holder's late submit still works.
func TestClaimNeverReissuesAnIssuedRow(t *testing.T) {
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
			before, _ := s.ByRequest(ctx, "req1")
			require.Len(t, before, 1)
			require.Equal(t, StatusReleased, before[0].Status)
			require.False(t, before[0].NeedsRecheck)

			e.c.t = e.c.t.Add(time.Hour)
			c := cand("aa.0")
			c.FuelBeef, c.DerivationPrefix = "ffff", "other"
			ok, err = s.Claim(ctx, c, "req2", "02bb", "asset.1", 3, 60)
			require.NoError(t, err, "a lost claim is a refusal, never an error")
			require.False(t, ok, "a released row with needs_recheck=0 is never re-drafted")
			after, _ := s.ByRequest(ctx, "req1")
			require.Equal(t, before, after, "the lost claim changed nothing (holder, txid, settled_at, updated_at)")
			none, _ := s.ByRequest(ctx, "req2")
			require.Empty(t, none)

			// Every other state loses too: reserving (released by rule 0 with
			// needs_recheck=0), dropped, spent_external.
			for i, op := range []string{"bb.0", "bb.1", "bb.2"} {
				ok, _ := s.Claim(ctx, cand(op), "req3", "02cc", "asset.0", i, 60)
				require.True(t, ok)
			}
			require.NoError(t, s.Drop(ctx, "bb.1", "req3"))
			ok, _ = s.ReleaseReservingOutpoint(ctx, "bb.0", "req3", false)
			require.True(t, ok)
			_, err = s.Commit(ctx, "req3", []CommitPair{{Outpoint: "bb.2"}}, 600)
			require.NoError(t, err)
			n, _ = s.ReleaseRequest(ctx, "req3")
			require.EqualValues(t, 1, n)
			ok, _ = s.SetRechecked(ctx, "bb.2", false)
			require.True(t, ok)
			for _, op := range []string{"bb.0", "bb.1", "bb.2"} {
				ok, err := s.Claim(ctx, cand(op), "req4", "02dd", "asset.0", 0, 60)
				require.NoError(t, err)
				require.False(t, ok, op)
			}
			none, _ = s.ByRequest(ctx, "req4")
			require.Empty(t, none)

			// The late-submit rule is unchanged: the last holder may still
			// consume its released, rechecked row.
			ref, err = s.Consume(ctx, "tx9", []ConsumeItem{{"aa.0", "req1"}})
			require.NoError(t, err)
			require.Nil(t, ref)
			rows, _ := s.ByTxid(ctx, "tx9")
			require.Len(t, rows, 1)
			require.Equal(t, StatusConsumed, rows[0].Status)
			require.Nil(t, rows[0].SettledAt, "consume clears the old settled_at")
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

func TestReleaseReservingOutpoint(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			_, err := s.ReleaseReservingOutpoint(ctx, "", "req1", false)
			require.Error(t, err)
			_, err = s.ReleaseReservingOutpoint(ctx, "aa.0", "", false)
			require.Error(t, err)

			for i, op := range []string{"aa.0", "aa.1"} {
				ok, err := s.Claim(ctx, cand(op), "req1", "02aa", "asset.0", i, 60)
				require.NoError(t, err)
				require.True(t, ok)
			}
			e.c.t = e.c.t.Add(61 * time.Second)

			ok, err := s.ReleaseReservingOutpoint(ctx, "aa.0", "req-other", false)
			require.NoError(t, err)
			require.False(t, ok, "CAS carries the holding request")

			ok, err = s.ReleaseReservingOutpoint(ctx, "aa.0", "req1", false)
			require.NoError(t, err)
			require.True(t, ok)
			rows, _ := s.ByRequest(ctx, "req1")
			require.Equal(t, StatusReleased, rows[0].Status)
			require.False(t, rows[0].NeedsRecheck)
			require.Equal(t, e.c.t.Unix(), rows[0].UpdatedAt)
			require.Equal(t, StatusReserving, rows[1].Status, "only the named outpoint moves")

			ok, err = s.ReleaseReservingOutpoint(ctx, "aa.0", "req1", false)
			require.NoError(t, err)
			require.False(t, ok, "second call misses: row is no longer reserving")

			// No ABA: the released row cannot be re-claimed by a newer
			// request (§13 rev 3), so a stale rule-0 verdict for req1 finds
			// the row exactly as req1's release left it.
			ok, err = s.Claim(ctx, cand("aa.0"), "req2", "02bb", "asset.0", 0, 60)
			require.NoError(t, err)
			require.False(t, ok, "a released row is never re-claimed")
			ok, err = s.ReleaseReservingOutpoint(ctx, "aa.0", "req1", false)
			require.NoError(t, err)
			require.False(t, ok)
			rows, _ = s.ByRequest(ctx, "req2")
			require.Empty(t, rows)

			ok, err = s.ReleaseReservingOutpoint(ctx, "aa.1", "req1", true)
			require.NoError(t, err)
			require.True(t, ok)
			rows, _ = s.ByRequest(ctx, "req1")
			require.Len(t, rows, 2, "req1 still owns both rows: nothing was re-claimed")
			require.Equal(t, "aa.1", rows[1].Outpoint)
			require.Equal(t, StatusReleased, rows[1].Status)
			require.True(t, rows[1].NeedsRecheck)
		})
	}
}

func TestReleaseByRule4SkipsSettledRows(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			_, err := s.ReleaseByRule4(ctx, "")
			require.Error(t, err)
			for i, op := range []string{"aa.0", "aa.1"} {
				ok, err := s.Claim(ctx, cand(op), "req1", "02aa", "asset.0", i, 60)
				require.NoError(t, err)
				require.True(t, ok)
			}
			_, err = s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}, {Outpoint: "aa.1"}}, 600)
			require.NoError(t, err)
			ref, err := s.Consume(ctx, "tx1", []ConsumeItem{{"aa.0", "req1"}, {"aa.1", "req1"}})
			require.NoError(t, err)
			require.Nil(t, ref)
			ok, err := s.MarkSettled(ctx, "aa.0", "tx1")
			require.NoError(t, err)
			require.True(t, ok)
			settled, _ := s.ByTxid(ctx, "tx1")
			require.NotNil(t, settled[0].SettledAt)

			e.c.t = e.c.t.Add(time.Minute)
			n, err := s.ReleaseByRule4(ctx, "tx1")
			require.NoError(t, err)
			require.EqualValues(t, 1, n, "only the unsettled row is released")
			rows, _ := s.ByTxid(ctx, "tx1")
			require.Len(t, rows, 2)
			require.Equal(t, settled[0], rows[0], "the settled row is untouched, including updated_at")
			require.Equal(t, StatusReleased, rows[1].Status)
			require.True(t, rows[1].NeedsRecheck)
			require.Equal(t, "tx1", rows[1].Txid, "txid kept for a /settle repair")

			n, err = s.ReleaseByRule4(ctx, "tx1")
			require.NoError(t, err)
			require.Zero(t, n)
		})
	}
}

func TestTouchRecheckRotatesThePendingQueue(t *testing.T) {
	for _, e := range openAll(t) {
		t.Run(e.name, func(t *testing.T) {
			ctx := context.Background()
			s := e.s
			require.Error(t, s.TouchRecheck(ctx, ""))
			for i, op := range []string{"aa.0", "aa.1", "aa.2"} {
				ok, err := s.Claim(ctx, cand(op), "req1", "02aa", "asset.0", i, 60)
				require.NoError(t, err)
				require.True(t, ok)
			}
			_, err := s.Commit(ctx, "req1", []CommitPair{{Outpoint: "aa.0"}, {Outpoint: "aa.1"}, {Outpoint: "aa.2"}}, 600)
			require.NoError(t, err)
			n, err := s.ReleaseRequest(ctx, "req1")
			require.NoError(t, err)
			require.EqualValues(t, 3, n)
			ok, err := s.SetRechecked(ctx, "aa.2", true) // released, needs_recheck=0: not pending
			require.NoError(t, err)
			require.True(t, ok)
			pend, err := s.RecheckPending(ctx, 1)
			require.NoError(t, err)
			require.Equal(t, "aa.0", pend[0].Outpoint, "oldest (then outpoint) first")
			before, _ := s.ByRequest(ctx, "req1")

			e.c.t = e.c.t.Add(time.Second)
			require.NoError(t, s.TouchRecheck(ctx, "aa.0"))
			pend, err = s.RecheckPending(ctx, 1)
			require.NoError(t, err)
			require.Equal(t, "aa.1", pend[0].Outpoint, "a touched row goes to the back of the queue")
			after, _ := s.ByRequest(ctx, "req1")
			require.Equal(t, e.c.t.Unix(), after[0].UpdatedAt)
			touched := after[0]
			touched.UpdatedAt = before[0].UpdatedAt
			require.Equal(t, before[0], touched, "only updated_at changes")
			require.Equal(t, StatusReleased, after[0].Status)
			require.True(t, after[0].NeedsRecheck)

			// CAS: a row not awaiting a recheck is never touched.
			e.c.t = e.c.t.Add(time.Second)
			require.NoError(t, s.TouchRecheck(ctx, "aa.2"))
			require.NoError(t, s.TouchRecheck(ctx, "zz.9"))
			again, _ := s.ByRequest(ctx, "req1")
			require.Equal(t, after[2], again[2], "released, needs_recheck=0 is left alone")
		})
	}
}

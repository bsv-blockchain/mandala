package sweeper

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
)

const (
	reservingTTL = 60
	draftTTL     = 600
	assetID      = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.0"
)

// ---------------------------------------------------------------------------
// fakes

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

type checkResult struct {
	unspent bool
	err     error
}

// fakeChecker answers per outpoint; an outpoint with no answer is an error.
type fakeChecker struct {
	mu      sync.Mutex
	res     map[string]checkResult
	calls   map[string]int
	onCheck func(outpoint string) // runs before answering (simulates a concurrent writer)
}

func newFakeChecker() *fakeChecker {
	return &fakeChecker{res: map[string]checkResult{}, calls: map[string]int{}}
}

func (f *fakeChecker) set(op string, unspent bool, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.res[op] = checkResult{unspent, err}
}

func (f *fakeChecker) IsUnspent(_ context.Context, script, op string) (bool, error) {
	f.mu.Lock()
	f.calls[op]++
	r, ok := f.res[op]
	hook := f.onCheck
	f.mu.Unlock()
	if script == "" {
		return false, errors.New("fake checker: empty script")
	}
	if hook != nil {
		hook(op)
	}
	if !ok {
		return false, errors.New("fake checker: no answer")
	}
	return r.unspent, r.err
}

type overlayResult struct {
	code  int
	final bool
	err   error
}

type fakeOverlay struct {
	mu        sync.Mutex
	status    map[string]overlayResult
	asked     map[string]int
	resettles []string
}

func newFakeOverlay() *fakeOverlay {
	return &fakeOverlay{status: map[string]overlayResult{}, asked: map[string]int{}}
}

func (f *fakeOverlay) set(txid string, code int, final bool, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status[txid] = overlayResult{code, final, err}
}

func (f *fakeOverlay) AdmissionStatus(_ context.Context, txid string) (int, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked[txid]++
	r, ok := f.status[txid]
	if !ok {
		return 0, false, errors.New("fake overlay: no answer")
	}
	return r.code, r.final, r.err
}

func (f *fakeOverlay) Resettle(_ context.Context, txid string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.resettles = append(f.resettles, txid)
	return nil
}

func (f *fakeOverlay) resettleCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.resettles...)
}

func (f *fakeOverlay) askedCount(txid string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.asked[txid]
}

// flakySource wraps the fuel Fake with a StillSpendable error and a Detach
// panic, which the Fake itself cannot produce.
type flakySource struct {
	*fuel.Fake
	mu          sync.Mutex
	verifyErr   error
	detachPanic bool
	onDetach    func(outpoint string) // runs after a successful detach (simulates a concurrent writer)
}

func (f *flakySource) StillSpendable(ctx context.Context, op string) (bool, error) {
	f.mu.Lock()
	err := f.verifyErr
	f.mu.Unlock()
	if err != nil {
		return false, err
	}
	return f.Fake.StillSpendable(ctx, op)
}

func (f *flakySource) Detach(ctx context.Context, op string) error {
	f.mu.Lock()
	p := f.detachPanic
	f.mu.Unlock()
	if p {
		panic("flaky source: detach exploded")
	}
	if err := f.Fake.Detach(ctx, op); err != nil {
		return err
	}
	if f.onDetach != nil {
		f.onDetach(op)
	}
	return nil
}

type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// ---------------------------------------------------------------------------
// environment

type env struct {
	ctx    context.Context
	st     *store.Store
	dbPath string
	fake   *fuel.Fake
	src    *flakySource
	c      *clock
	chk    *fakeChecker
	ov     *fakeOverlay
	logs   *logBuf
	sw     *Sweeper
	reqNo  int
}

func newEnv(t *testing.T) *env { return newEnvWith(t, true) }

func newEnvWith(t *testing.T, withOverlay bool) *env {
	t.Helper()
	c := &clock{t: time.Unix(1_758_700_000, 0)}
	dbPath := filepath.Join(t.TempDir(), "fk.sqlite")
	st, err := store.Open(store.DriverSQLite, dbPath, c.now)
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	fake := fuel.NewFake(priv)
	e := &env{ctx: context.Background(), st: st, dbPath: dbPath, fake: fake, src: &flakySource{Fake: fake}, c: c,
		chk: newFakeChecker(), ov: newFakeOverlay(), logs: &logBuf{}}
	var ov OverlayClient
	if withOverlay {
		ov = e.ov
	}
	logger := slog.New(slog.NewJSONHandler(e.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	e.sw = New(st, e.src, e.chk, ov, c.now, logger, reservingTTL)
	return e
}

func requester(t *testing.T) string {
	t.Helper()
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	return priv.PubKey().ToDERHex()
}

func randTxid(t *testing.T) string {
	t.Helper()
	b := make([]byte, 32)
	_, err := rand.Read(b)
	require.NoError(t, err)
	return hex.EncodeToString(b)
}

// claim takes n new fuel rows as reserving for a fresh request.
func (e *env) claim(t *testing.T, who string, n int) (string, []fuel.Row) {
	t.Helper()
	e.reqNo++
	reqID := "req" + string(rune('a'+e.reqNo))
	rows := make([]fuel.Row, n)
	for i := range rows {
		r := e.fake.AddFuel(t, 1000)
		ok, err := e.st.Claim(e.ctx, store.Candidate{
			Outpoint: r.Outpoint, Satoshis: r.Satoshis, FuelScript: hex.EncodeToString(r.LockingScript),
			FuelBeef: hex.EncodeToString(r.Beef), DerivationPrefix: r.DerivationPrefix, DerivationSuffix: r.DerivationSuffix,
		}, reqID, who, assetID, i, reservingTTL)
		require.NoError(t, err)
		require.True(t, ok)
		rows[i] = r
	}
	return reqID, rows
}

// draft claims and commits n rows (reserved).
func (e *env) draft(t *testing.T, who string, n int) (string, []fuel.Row) {
	t.Helper()
	reqID, rows := e.claim(t, who, n)
	pairs := make([]store.CommitPair, n)
	for i, r := range rows {
		pairs[i] = store.CommitPair{Outpoint: r.Outpoint, FeeScript: "76a914" + hex.EncodeToString([]byte(r.Outpoint))[:40] + "88ac", KeyID: "fee-" + r.Outpoint, FeeAmount: "20"}
	}
	_, err := e.st.Commit(e.ctx, reqID, pairs, draftTTL)
	require.NoError(t, err)
	return reqID, rows
}

// consumed drafts n rows and consumes them all by txid.
func (e *env) consumed(t *testing.T, who, txid string, n int) (string, []fuel.Row) {
	t.Helper()
	reqID, rows := e.draft(t, who, n)
	items := make([]store.ConsumeItem, n)
	for i, r := range rows {
		items[i] = store.ConsumeItem{Outpoint: r.Outpoint, RequestID: reqID}
	}
	ref, err := e.st.Consume(e.ctx, txid, items)
	require.NoError(t, err)
	require.Nil(t, ref)
	return reqID, rows
}

// released drafts one row and releases it (released, needs_recheck=1).
func (e *env) released(t *testing.T, who string) (string, fuel.Row) {
	t.Helper()
	reqID, rows := e.draft(t, who, 1)
	n, err := e.st.ReleaseRequest(e.ctx, reqID)
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	return reqID, rows[0]
}

func (e *env) rows(t *testing.T, reqID string) []store.Reservation {
	t.Helper()
	rows, err := e.st.ByRequest(e.ctx, reqID)
	require.NoError(t, err)
	return rows
}

func (e *env) row(t *testing.T, reqID, op string) store.Reservation {
	t.Helper()
	for _, r := range e.rows(t, reqID) {
		if r.Outpoint == op {
			return r
		}
	}
	t.Fatalf("no row %s under %s", op, reqID)
	return store.Reservation{}
}

// sqlExec runs stmt over a second connection to the store's SQLite file.
// Tests use it for fault injection: a trigger that fails one kind of write
// while every other store call keeps working.
func (e *env) sqlExec(t *testing.T, stmt string) {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+e.dbPath+"?_busy_timeout=5000")
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	_, err = db.Exec(stmt)
	require.NoError(t, err)
}

func (e *env) tick(t *testing.T) {
	t.Helper()
	require.NoError(t, e.sw.Tick(e.ctx))
}

func (e *env) denied(t *testing.T, who string) bool {
	t.Helper()
	d, err := e.st.IsDenied(e.ctx, who)
	require.NoError(t, err)
	return d
}

func (e *env) inBasket(t *testing.T, op string) bool {
	t.Helper()
	rows, err := e.fake.ListProven(e.ctx, "fuel", 1000)
	require.NoError(t, err)
	for _, r := range rows {
		if r.Outpoint == op {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// rule 0

func TestRule0_VerifiedReservationReturnsToPool(t *testing.T) {
	e := newEnv(t)
	req, rows := e.claim(t, requester(t), 2)
	require.True(t, e.inBasket(t, rows[0].Outpoint))

	e.tick(t)
	for _, r := range e.rows(t, req) {
		require.Equal(t, store.StatusReserving, r.Status, "not expired yet")
	}

	e.c.add((reservingTTL + 1) * time.Second)
	fresh, _ := e.claim(t, requester(t), 1) // claimed now: not expired
	e.tick(t)
	for _, r := range e.rows(t, req) {
		require.Equal(t, store.StatusReleased, r.Status, r.Outpoint)
		require.False(t, r.NeedsRecheck, "rule 0 releases with needs_recheck=0")
		require.False(t, e.inBasket(t, r.Outpoint), "rule 0 detached the row")
	}
	require.Equal(t, store.StatusReserving, e.rows(t, fresh)[0].Status)
}

func TestRule0_UnspendableReservationIsDropped(t *testing.T) {
	e := newEnv(t)
	req, rows := e.claim(t, requester(t), 2)
	e.fake.SpendAfterDetach(rows[0].Outpoint) // funder took it just before the detach
	e.fake.SpendExternally(rows[1].Outpoint)
	e.c.add((reservingTTL + 1) * time.Second)
	e.tick(t)
	for _, r := range e.rows(t, req) {
		require.Equal(t, store.StatusDropped, r.Status, r.Outpoint)
	}
}

func TestRule0_ErrorLeavesRowReserving(t *testing.T) {
	e := newEnv(t)
	req, rows := e.claim(t, requester(t), 1)
	op := rows[0].Outpoint
	e.c.add((reservingTTL + 1) * time.Second)

	e.fake.FailNextDetach(errors.New("wallet unreachable"))
	e.tick(t)
	require.Equal(t, store.StatusReserving, e.row(t, req, op).Status, "detach error: never dropped")

	e.src.verifyErr = errors.New("storage reader: 0 rows for outpoint")
	e.tick(t)
	e.tick(t)
	require.Equal(t, store.StatusReserving, e.row(t, req, op).Status, "verify error: never dropped")
	require.Contains(t, e.logs.String(), "left reserving for the next tick")

	e.src.verifyErr = nil
	e.tick(t)
	r := e.row(t, req, op)
	require.Equal(t, store.StatusReleased, r.Status)
	require.False(t, r.NeedsRecheck)
}

func TestRule0_RowTakenByNewerRequestIsUntouched(t *testing.T) {
	e := newEnv(t)
	who := requester(t)
	req, rows := e.claim(t, who, 1)
	op := rows[0].Outpoint
	e.c.add((reservingTTL + 1) * time.Second)
	// While the sweeper is inside detach+verify for the expired row, the
	// late drafter releases it and a newer request re-claims it.
	e.src.onDetach = func(string) {
		n, err := e.st.ReleaseReserving(e.ctx, req, false)
		require.NoError(t, err)
		require.EqualValues(t, 1, n)
		ok, err := e.st.Claim(e.ctx, store.Candidate{Outpoint: op, Satoshis: 1000, FuelScript: "00", FuelBeef: "00",
			DerivationPrefix: "p", DerivationSuffix: "s"}, "req-newer", who, assetID, 0, reservingTTL)
		require.NoError(t, err)
		require.True(t, ok)
	}
	e.tick(t)
	r := e.rows(t, "req-newer")
	require.Len(t, r, 1)
	require.Equal(t, store.StatusReserving, r[0].Status, "the stale rule-0 verdict must not release the newer claim")
	require.Contains(t, e.logs.String(), "moved on meanwhile")
}

// ---------------------------------------------------------------------------
// rule 1

func TestRule1_ExpiredDraftReleasedNeedsRecheck(t *testing.T) {
	e := newEnv(t)
	req, rows := e.draft(t, requester(t), 2)
	e.c.add(draftTTL * time.Second)
	e.tick(t)
	for _, r := range e.rows(t, req) {
		require.Equal(t, store.StatusReserved, r.Status, "expires_at is not yet passed")
	}
	e.c.add(time.Second)
	live, _ := e.draft(t, requester(t), 1)
	e.tick(t)
	for _, r := range e.rows(t, req) {
		require.Equal(t, store.StatusReleased, r.Status)
		require.True(t, r.NeedsRecheck)
	}
	require.Equal(t, store.StatusReserved, e.rows(t, live)[0].Status)
	// Rule 2 ran in the same tick; the checker had no answer, so the rows
	// stay pending instead of being cleared.
	require.Equal(t, 1, e.chk.calls[rows[0].Outpoint])
}

// ---------------------------------------------------------------------------
// rule 2

func TestRule2_UnspentClearsRecheck(t *testing.T) {
	e := newEnv(t)
	who := requester(t)
	req, fr := e.released(t, who)
	e.chk.set(fr.Outpoint, true, nil)
	e.tick(t)
	r := e.row(t, req, fr.Outpoint)
	require.Equal(t, store.StatusReleased, r.Status)
	require.False(t, r.NeedsRecheck)
	require.False(t, e.denied(t, who))
	cands, err := e.st.ReleasedCandidates(e.ctx, 10)
	require.NoError(t, err)
	require.Len(t, cands, 1, "claimable again")
}

func TestRule2_SpentMarksSpentExternalAndDenies(t *testing.T) {
	e := newEnv(t)
	who, bystander := requester(t), requester(t)
	req, fr := e.released(t, who)
	_, other := e.released(t, bystander)
	e.chk.set(fr.Outpoint, false, nil)
	e.chk.set(other.Outpoint, true, nil)
	e.tick(t)
	r := e.row(t, req, fr.Outpoint)
	require.Equal(t, store.StatusSpentExternal, r.Status)
	require.False(t, r.NeedsRecheck)
	require.Empty(t, r.Txid, "a draft released unconsumed: only such rows deny")
	require.True(t, e.denied(t, who))
	require.False(t, e.denied(t, bystander))
	require.Contains(t, e.logs.String(), `"alert":"spent_external"`)
}

func TestRule2_CheckerErrorLeavesRowAndNeverDenies(t *testing.T) {
	e := newEnv(t)
	who := requester(t)
	req, fr := e.released(t, who)
	before := e.row(t, req, fr.Outpoint)
	e.chk.set(fr.Outpoint, false, errors.New("woc: 429"))
	e.c.add(time.Minute)
	e.tick(t)
	e.tick(t)
	after := e.row(t, req, fr.Outpoint)
	require.Equal(t, e.c.now().Unix(), after.UpdatedAt, "only moved to the back of the recheck queue")
	after.UpdatedAt = before.UpdatedAt
	require.Equal(t, before, after, "otherwise unchanged: still released, needs_recheck=1")
	require.False(t, e.denied(t, who))
	require.Contains(t, e.logs.String(), "rows stay pending")
}

// A row whose chain check keeps failing goes to the back of the queue on
// every failure, so it cannot starve the rows behind it (rule 2 checks at
// most recheckBatch rows per tick; lowered to 1 here).
func TestRule2_FailingRowDoesNotStarveTheQueue(t *testing.T) {
	e := newEnv(t)
	e.sw.recheckBatch = 1
	reqA, a := e.released(t, requester(t)) // oldest: head of the queue
	e.c.add(time.Second)
	reqB, b := e.released(t, requester(t))
	e.chk.set(a.Outpoint, false, errors.New("woc: 429"))
	e.chk.set(b.Outpoint, true, nil)
	e.c.add(time.Minute)

	e.tick(t)
	require.Equal(t, 1, e.chk.calls[a.Outpoint])
	require.Zero(t, e.chk.calls[b.Outpoint], "a batch of one checks only the head")
	e.tick(t)
	require.Equal(t, 1, e.chk.calls[a.Outpoint], "the failing row moved to the back")
	require.Equal(t, 1, e.chk.calls[b.Outpoint], "the row behind it is reached on the next tick")
	rb := e.row(t, reqB, b.Outpoint)
	require.Equal(t, store.StatusReleased, rb.Status)
	require.False(t, rb.NeedsRecheck, "cleared: claimable again")
	ra := e.row(t, reqA, a.Outpoint)
	require.Equal(t, store.StatusReleased, ra.Status)
	require.True(t, ra.NeedsRecheck, "the failing row stays pending")
}

// A released row that carries a txid came from an eviction or a rule-4
// release after its tx was consumed, so a chain spend is most likely that tx
// having mined anyway. The row goes spent_external with an alert (a /settle
// still repairs it) but its requester is never denied.
func TestRule2_SpentRowWithTxidAlertsWithoutDeny(t *testing.T) {
	e := newEnv(t)
	evictedBy, rule4By := requester(t), requester(t)

	evictedTxid := randTxid(t)
	reqE, rowsE := e.consumed(t, evictedBy, evictedTxid, 1)
	n, err := e.st.ReleaseEvicted(e.ctx, evictedTxid, []string{rowsE[0].Outpoint})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)

	rule4Txid := randTxid(t)
	req4, rows4 := e.consumed(t, rule4By, rule4Txid, 1)
	e.ov.set(rule4Txid, http.StatusGone, false, nil)
	e.pastRule4(t)
	e.tick(t) // rule 4 releases rule4Txid's row; the evicted row's check has no answer yet
	r := e.row(t, req4, rows4[0].Outpoint)
	require.Equal(t, store.StatusReleased, r.Status)
	require.True(t, r.NeedsRecheck)
	require.Equal(t, rule4Txid, r.Txid)
	require.NotContains(t, e.logs.String(), `"alert":"spent_external"`)

	e.chk.set(rowsE[0].Outpoint, false, nil)
	e.chk.set(rows4[0].Outpoint, false, nil)
	e.tick(t)
	for req, want := range map[string]struct{ op, txid string }{
		reqE: {rowsE[0].Outpoint, evictedTxid},
		req4: {rows4[0].Outpoint, rule4Txid},
	} {
		r := e.row(t, req, want.op)
		require.Equal(t, store.StatusSpentExternal, r.Status, want.op)
		require.False(t, r.NeedsRecheck, want.op)
		require.Equal(t, want.txid, r.Txid, "txid kept for a /settle repair")
	}
	require.False(t, e.denied(t, evictedBy), "the evicted tx most likely mined: never denied")
	require.False(t, e.denied(t, rule4By), "the rule-4 released tx most likely mined: never denied")
	require.Contains(t, e.logs.String(), `"alert":"spent_external"`)
	require.Contains(t, e.logs.String(), "requester is not denied")

	ok, err := e.st.MarkSettled(e.ctx, rowsE[0].Outpoint, evictedTxid)
	require.NoError(t, err)
	require.True(t, ok, "/settle repairs the spent_external row")
}

func TestRule2_NilCheckerIsDisabled(t *testing.T) {
	e := newEnv(t)
	sw := New(e.st, e.src, nil, nil, e.c.now, nil, reservingTTL)
	who := requester(t)
	req, fr := e.released(t, who)
	require.NoError(t, sw.Tick(e.ctx))
	r := e.row(t, req, fr.Outpoint)
	require.Equal(t, store.StatusReleased, r.Status)
	require.True(t, r.NeedsRecheck, "a disabled chain check never clears a row")
	require.False(t, e.denied(t, who))
}

func TestRule2_CASMissDoesNotDeny(t *testing.T) {
	e := newEnv(t)
	who := requester(t)
	txid := randTxid(t)
	req, rows := e.consumed(t, who, txid, 1)
	op := rows[0].Outpoint
	n, err := e.st.ReleaseEvicted(e.ctx, txid, []string{op})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	require.True(t, e.row(t, req, op).NeedsRecheck)

	// /settle repairs the row while the chain check is in flight; the chain
	// then (correctly) reports the fuel spent — by the settled tx itself.
	e.chk.onCheck = func(string) {
		ok, err := e.st.MarkSettled(e.ctx, op, txid)
		require.NoError(t, err)
		require.True(t, ok)
	}
	e.chk.set(op, false, nil)
	e.tick(t)

	r := e.row(t, req, op)
	require.Equal(t, store.StatusConsumed, r.Status, "the settle repair wins")
	require.NotNil(t, r.SettledAt)
	require.False(t, e.denied(t, who), "a stale spent verdict must not deny")
	require.NotContains(t, e.logs.String(), `"alert":"spent_external"`)
	require.Contains(t, e.logs.String(), "verdict discarded")
}

// ---------------------------------------------------------------------------
// rule 3

func TestRule3_UnsettledConsumedIsLogOnly(t *testing.T) {
	e := newEnv(t)
	txid := randTxid(t)
	req, _ := e.consumed(t, requester(t), txid, 2)
	e.c.add(6 * time.Minute)
	before := e.rows(t, req)
	e.tick(t)
	require.Equal(t, before, e.rows(t, req), "nothing changed")
	require.Zero(t, e.ov.askedCount(txid), "rule 4 is not due yet")
	require.Contains(t, e.logs.String(), "not yet settled")
	require.Contains(t, e.logs.String(), txid)
}

// ---------------------------------------------------------------------------
// rule 4

func (e *env) pastRule4(t *testing.T) { t.Helper(); e.c.add(Rule4Age + time.Second) }

func TestRule4_AdmittedNeverReleasesAndResettlesOncePerTick(t *testing.T) {
	e := newEnv(t)
	txid := randTxid(t)
	req, _ := e.consumed(t, requester(t), txid, 2)
	e.pastRule4(t)
	e.ov.set(txid, http.StatusOK, false, nil)
	before := e.rows(t, req)

	e.tick(t)
	require.Equal(t, before, e.rows(t, req), "an admitted tx is never released")
	require.Equal(t, []string{txid}, e.ov.resettleCalls(), "once per txid per tick, not per row")
	require.Contains(t, e.logs.String(), `"alert":"consumedUnsettled"`)

	e.tick(t)
	require.Equal(t, []string{txid, txid}, e.ov.resettleCalls())
	require.Equal(t, before, e.rows(t, req))
}

func TestRule4_EvictedOrFinalRefusalReleases(t *testing.T) {
	e := newEnv(t)
	evicted, refused, retryable := randTxid(t), randTxid(t), randTxid(t)
	reqE, _ := e.consumed(t, requester(t), evicted, 2)
	reqR, _ := e.consumed(t, requester(t), refused, 1)
	reqX, _ := e.consumed(t, requester(t), retryable, 1)
	e.pastRule4(t)
	e.ov.set(evicted, http.StatusGone, true, nil)
	e.ov.set(refused, http.StatusBadRequest, true, nil)
	e.ov.set(retryable, http.StatusBadRequest, false, nil)
	beforeX := e.rows(t, reqX)

	e.tick(t)
	for _, req := range []string{reqE, reqR} {
		for _, r := range e.rows(t, req) {
			require.Equal(t, store.StatusReleased, r.Status, r.Outpoint)
			require.True(t, r.NeedsRecheck, "a rule-4 release never sets needs_recheck=0")
			require.Equal(t, r.Txid, map[string]string{reqE: evicted, reqR: refused}[req], "txid kept for a /settle repair")
		}
	}
	require.Equal(t, beforeX, e.rows(t, reqX), "a non-final 400 releases nothing")
	require.Empty(t, e.ov.resettleCalls())
}

func TestRule4_NotFoundReleasesAfterTwoUnspentObservations(t *testing.T) {
	e := newEnv(t)
	txid := randTxid(t)
	req, rows := e.consumed(t, requester(t), txid, 2)
	e.pastRule4(t)
	e.ov.set(txid, http.StatusNotFound, false, nil)
	for _, r := range rows {
		e.chk.set(r.Outpoint, true, nil)
	}
	before := e.rows(t, req)

	e.tick(t) // first observation
	require.Equal(t, before, e.rows(t, req), "never on the first observation")
	e.c.add(Rule4ObserveGap - time.Second)
	e.tick(t)
	require.Equal(t, before, e.rows(t, req), "observations less than 10 min apart")

	e.c.add(time.Second)
	e.tick(t) // second observation, 10 min after the first
	for _, r := range e.rows(t, req) {
		require.Equal(t, store.StatusReleased, r.Status, r.Outpoint)
		require.True(t, r.NeedsRecheck, "a rule-4 release never sets needs_recheck=0")
	}
	require.Empty(t, e.ov.resettleCalls())
}

func TestRule4_NotFoundWithSpentFuelNeverReleases(t *testing.T) {
	e := newEnv(t)
	txid := randTxid(t)
	req, rows := e.consumed(t, requester(t), txid, 2)
	e.pastRule4(t)
	e.ov.set(txid, http.StatusNotFound, false, nil)
	e.chk.set(rows[0].Outpoint, true, nil)
	e.chk.set(rows[1].Outpoint, true, nil)
	before := e.rows(t, req)

	e.tick(t) // first unspent observation
	e.chk.set(rows[1].Outpoint, false, nil)
	e.c.add(Rule4ObserveGap)
	e.tick(t) // spent: observation discarded
	require.Equal(t, before, e.rows(t, req))
	require.Contains(t, e.logs.String(), "spent on chain")

	// Unspent again (e.g. a reorg): the gap starts over.
	e.chk.set(rows[1].Outpoint, true, nil)
	e.c.add(time.Minute)
	e.tick(t)
	require.Equal(t, before, e.rows(t, req), "a fresh first observation, not a release")
	e.c.add(Rule4ObserveGap)
	e.tick(t)
	require.Equal(t, store.StatusReleased, e.rows(t, req)[0].Status)
}

func TestRule4_NotFoundCheckerErrorIsNoObservation(t *testing.T) {
	e := newEnv(t)
	txid := randTxid(t)
	req, rows := e.consumed(t, requester(t), txid, 1)
	e.pastRule4(t)
	e.ov.set(txid, http.StatusNotFound, false, nil)
	e.chk.set(rows[0].Outpoint, false, errors.New("woc down"))
	before := e.rows(t, req)
	for range 3 {
		e.tick(t)
		e.c.add(Rule4ObserveGap)
	}
	require.Equal(t, before, e.rows(t, req), "an error is never an unspent observation")

	e.chk.set(rows[0].Outpoint, true, nil)
	e.tick(t)
	require.Equal(t, before, e.rows(t, req))
	e.c.add(Rule4ObserveGap)
	e.tick(t)
	require.Equal(t, store.StatusReleased, e.rows(t, req)[0].Status)
}

func TestRule4_NoVerdictDoesNothing(t *testing.T) {
	e := newEnv(t)
	cases := map[string]overlayResult{
		randTxid(t): {code: http.StatusServiceUnavailable},
		randTxid(t): {code: http.StatusInternalServerError},
		randTxid(t): {code: http.StatusUnauthorized, final: true},
		randTxid(t): {err: context.DeadlineExceeded},
	}
	var reqs []string
	for txid, r := range cases {
		req, rows := e.consumed(t, requester(t), txid, 1)
		e.chk.set(rows[0].Outpoint, true, nil)
		e.ov.set(txid, r.code, r.final, r.err)
		reqs = append(reqs, req)
	}
	e.pastRule4(t)
	before := map[string][]store.Reservation{}
	for _, req := range reqs {
		before[req] = e.rows(t, req)
	}
	for range 3 {
		e.tick(t)
		e.c.add(Rule4ObserveGap)
	}
	for _, req := range reqs {
		require.Equal(t, before[req], e.rows(t, req))
	}
	require.Empty(t, e.ov.resettleCalls())
	for txid := range cases {
		require.Equal(t, 3, e.ov.askedCount(txid))
	}
}

func TestRule4_OnlyRowsPast30MinAreAsked(t *testing.T) {
	e := newEnv(t)
	txid := randTxid(t)
	e.consumed(t, requester(t), txid, 1)
	e.ov.set(txid, http.StatusGone, true, nil)
	e.c.add(Rule4Age - time.Minute)
	e.tick(t)
	require.Zero(t, e.ov.askedCount(txid))
}

func TestRule4_MalformedTxidIsNeverSent(t *testing.T) {
	e := newEnv(t)
	req, _ := e.consumed(t, requester(t), "not-a-txid", 1)
	e.pastRule4(t)
	before := e.rows(t, req)
	e.tick(t)
	require.Zero(t, e.ov.askedCount("not-a-txid"))
	require.Equal(t, before, e.rows(t, req))
	require.Contains(t, e.logs.String(), "malformed txid")
}

func TestRule4_NilOverlayIsANoOpWithWarning(t *testing.T) {
	e := newEnvWith(t, false)
	require.Contains(t, e.logs.String(), "rule 4 is disabled")
	txid := randTxid(t)
	req, rows := e.consumed(t, requester(t), txid, 1)
	e.chk.set(rows[0].Outpoint, true, nil)
	e.pastRule4(t)
	before := e.rows(t, req)
	for range 3 {
		e.tick(t)
		e.c.add(Rule4ObserveGap)
	}
	require.Equal(t, before, e.rows(t, req))
	require.Contains(t, e.logs.String(), "no overlay client")
}

func TestRule4_ObservationsAreForgottenWhenTheTxLeavesScope(t *testing.T) {
	e := newEnv(t)
	txid := randTxid(t)
	_, rows := e.consumed(t, requester(t), txid, 1)
	e.pastRule4(t)
	e.ov.set(txid, http.StatusNotFound, false, nil)
	e.chk.set(rows[0].Outpoint, true, nil)
	e.tick(t)
	require.Contains(t, e.sw.firstUnspent, txid)
	ok, err := e.st.MarkSettled(e.ctx, rows[0].Outpoint, txid)
	require.NoError(t, err)
	require.True(t, ok)
	e.tick(t)
	require.NotContains(t, e.sw.firstUnspent, txid)
}

// ---------------------------------------------------------------------------
// Tick / Run

// A failing rule is reported and the tick moves on: the rules after it still
// run in the same tick. Rules 0 and 2 are made to fail by SQLite triggers on
// their own writes (Drop, SetRechecked); rules 1, 3 and 4 are untouched.
func TestTickContinuesPastAFailingRule(t *testing.T) {
	e := newEnv(t)
	// rule 0: an expired reservation that is no longer spendable → Drop.
	req0, rows0 := e.claim(t, requester(t), 1)
	e.fake.SpendExternally(rows0[0].Outpoint)
	// rule 1: an expired draft.
	req1, _ := e.draft(t, requester(t), 1)
	// rule 2: a released row whose unspent verdict is written by SetRechecked.
	req2, row2 := e.released(t, requester(t))
	e.chk.set(row2.Outpoint, true, nil)
	// rule 4: an unsettled consumed tx the overlay reports evicted.
	txid := randTxid(t)
	req4, _ := e.consumed(t, requester(t), txid, 1)
	e.ov.set(txid, http.StatusGone, false, nil)
	e.pastRule4(t) // also expires the reservation and the draft

	e.sqlExec(t, `CREATE TRIGGER inject_drop_failure BEFORE UPDATE OF status ON fuel_reservations
  WHEN NEW.status='dropped' BEGIN SELECT RAISE(ABORT, 'injected drop failure'); END`)
	e.sqlExec(t, `CREATE TRIGGER inject_recheck_failure BEFORE UPDATE OF needs_recheck ON fuel_reservations
  WHEN OLD.status='released' AND OLD.needs_recheck=1 AND NEW.needs_recheck=0
  BEGIN SELECT RAISE(ABORT, 'injected recheck failure'); END`)

	err := e.sw.Tick(e.ctx)
	require.Error(t, err)
	require.ErrorContains(t, err, "sweeper rule0:")
	require.ErrorContains(t, err, "injected drop failure")
	require.ErrorContains(t, err, "sweeper rule2:")
	require.ErrorContains(t, err, "injected recheck failure")
	for _, ok := range []string{"rule1", "rule3", "rule4"} {
		require.NotContains(t, err.Error(), "sweeper "+ok+":", "only the failing rules are reported")
	}
	// The failed writes changed nothing...
	require.Equal(t, store.StatusReserving, e.rows(t, req0)[0].Status)
	r2 := e.row(t, req2, row2.Outpoint)
	require.Equal(t, store.StatusReleased, r2.Status)
	require.True(t, r2.NeedsRecheck)
	// ...and the rules after each failure still ran in the same tick.
	require.Equal(t, store.StatusReleased, e.rows(t, req1)[0].Status, "rule 1 ran after rule 0 failed")
	require.Equal(t, 1, e.ov.askedCount(txid), "rule 4 asked the overlay after rule 2 failed")
	require.Equal(t, store.StatusReleased, e.rows(t, req4)[0].Status, "rule 4 acted on the overlay's answer")

	// Once the faults clear, the next tick completes the failed rules.
	e.sqlExec(t, `DROP TRIGGER inject_drop_failure`)
	e.sqlExec(t, `DROP TRIGGER inject_recheck_failure`)
	e.tick(t)
	require.Equal(t, store.StatusDropped, e.rows(t, req0)[0].Status)
	require.False(t, e.row(t, req2, row2.Outpoint).NeedsRecheck)
}

// A cancelled context fails every rule; each failure is reported, nothing
// changes, and the next tick does the work.
func TestTickReportsEveryFailedRule(t *testing.T) {
	e := newEnv(t)
	req, _ := e.draft(t, requester(t), 1)
	e.c.add((draftTTL + 1) * time.Second)
	ctx, cancel := context.WithCancel(e.ctx)
	cancel()
	err := e.sw.Tick(ctx)
	require.Error(t, err, "every rule sees the cancelled context")
	for _, rule := range []string{"rule0", "rule1", "rule2", "rule3", "rule4"} {
		require.ErrorContains(t, err, "sweeper "+rule+":")
	}
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, store.StatusReserved, e.rows(t, req)[0].Status)
	e.tick(t)
	require.Equal(t, store.StatusReleased, e.rows(t, req)[0].Status)
}

func TestRunTicksUntilCancelledAndSurvivesAPanic(t *testing.T) {
	e := newEnv(t)
	req, _ := e.draft(t, requester(t), 1)
	e.claim(t, requester(t), 1) // reserving: rule 0 will hit the panicking detach
	e.c.add((draftTTL + 1) * time.Second)
	e.src.mu.Lock()
	e.src.detachPanic = true
	e.src.mu.Unlock()

	ctx, cancel := context.WithCancel(e.ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.sw.Run(ctx, 5*time.Millisecond)
	}()
	require.Eventually(t, func() bool { return strings.Contains(e.logs.String(), "tick panicked") }, 5*time.Second, 5*time.Millisecond)

	e.src.mu.Lock()
	e.src.detachPanic = false
	e.src.mu.Unlock()
	require.Eventually(t, func() bool {
		rows, err := e.st.ByRequest(e.ctx, req)
		return err == nil && len(rows) == 1 && rows[0].Status == store.StatusReleased
	}, 5*time.Second, 5*time.Millisecond, "the loop keeps ticking after a panic")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}

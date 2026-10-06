package wiring

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	"github.com/sirdeggen/mandala/overlay-go/internal/maintenance"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// Deterministic error classes: the readiness text carries type names only, never messages (which may carry hosts or
// credentials).
type refoldBoom struct{}

func (refoldBoom) Error() string { return "refold boom" }

type reconcileBoom struct{}

func (*reconcileBoom) Error() string { return "reconcile boom at mongodb://user:secret@db" }

type genericBoom[T any] struct{}

func (genericBoom[T]) Error() string { return "generic boom" }

// ownerIndexFake records, in order, the calls OwnerIndexMaintenance makes.
type ownerIndexFake struct {
	mu           sync.Mutex
	calls        []string
	ids          []string
	idsErr       error
	refoldErr    map[string]error
	results      map[string]mandala.ReconcileResult
	reconcileErr map[string]error
	topics       []string
	onRefold     func()
	onReconcile  func()
	swept        int
	sweepErr     error
	rebuilt      mandala.BalanceRebuild
	rebuildErr   error
	onSweep      func()
	onRebuild    func()
}

func newOwnerIndexFake() *ownerIndexFake {
	return &ownerIndexFake{
		ids: []string{"a_0", "b_0"}, topics: []string{"tm_a", mandala.KYCTopic},
		refoldErr: map[string]error{}, results: map[string]mandala.ReconcileResult{}, reconcileErr: map[string]error{},
	}
}

func (f *ownerIndexFake) record(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, s)
}

func (f *ownerIndexFake) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *ownerIndexFake) deps(gate, lock *maintenance.Gate) OwnerIndexDeps {
	return OwnerIndexDeps{
		Gate:          gate,
		ReconcileLock: lock,
		TokenIDsWithHistory: func(context.Context) ([]string, error) {
			f.record("ids")
			return f.ids, f.idsErr
		},
		RebuildState: func(_ context.Context, id string) error {
			f.record("refold " + id)
			if f.onRefold != nil {
				f.onRefold()
			}
			return f.refoldErr[id]
		},
		Reconcile: func(_ context.Context, topic string) (mandala.ReconcileResult, error) {
			f.record("reconcile " + topic)
			if f.onReconcile != nil {
				f.onReconcile()
			}
			if err := f.reconcileErr[topic]; err != nil {
				return mandala.ReconcileResult{}, err
			}
			return f.results[topic], nil
		},
		Topics: func() []string { return f.topics },
		Logf:   func(string, ...any) {},
		SweepOwnerIndex: func(context.Context) (int, error) {
			if f.onSweep != nil {
				f.onSweep()
			}
			return f.swept, f.sweepErr
		},
		RebuildBalances: func(context.Context) (mandala.BalanceRebuild, error) {
			if f.onRebuild != nil {
				f.onRebuild()
			}
			return f.rebuilt, f.rebuildErr
		},
	}
}

func testGates() (*maintenance.Gate, *maintenance.Gate) {
	return maintenance.NewGate(time.Second), maintenance.NewGate(time.Second)
}

func delayOf(m *OwnerIndexMaintenance) time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.nextDelay()
}

func TestOwnerIndexRefoldsThenReconcilesEveryTopic(t *testing.T) {
	f := newOwnerIndexFake()
	gate, lock := testGates()
	m := NewOwnerIndexMaintenance(f.deps(gate, lock))
	if s, msg := m.Readiness(); s != "degraded" || msg != "owner index not yet reconciled" {
		t.Fatalf("before the first run: %q %q", s, msg)
	}
	m.RunOnce(context.Background())
	want := []string{"ids", "refold a_0", "refold b_0", "reconcile tm_a", "reconcile " + mandala.KYCTopic}
	if got := f.seen(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	if st := m.Status(); !st.Ran || st.LastError != "" || len(st.Unrepairable) != 0 || st.LastRunAt.IsZero() {
		t.Fatalf("status = %+v", st)
	}
	if s, msg := m.Readiness(); s != "ok" || msg != "" {
		t.Fatalf("readiness = %q %q, want ok", s, msg)
	}
}

// Lock order: the refold holds only the submit gate, the reconcile only the reconcile lock; they never nest.
func TestOwnerIndexNeverNestsTheLocks(t *testing.T) {
	f := newOwnerIndexFake()
	gate, lock := testGates()
	var bad atomic.Int32
	f.onRefold = func() {
		if lock.Busy() || !gate.Busy() {
			bad.Add(1)
		}
	}
	f.onReconcile = func() {
		if gate.Busy() || !lock.Busy() {
			bad.Add(1)
		}
	}
	NewOwnerIndexMaintenance(f.deps(gate, lock)).RunOnce(context.Background())
	if bad.Load() != 0 {
		t.Fatalf("%d step(s) ran under the wrong lock or with both held", bad.Load())
	}
}

func TestOwnerIndexReadinessSummaries(t *testing.T) {
	kyc := mandala.KYCTopic
	cases := []struct {
		name         string
		setup        func(f *ownerIndexFake)
		status       string
		message      string
		unrepairable []string
		reconciled   bool
	}{
		{"clean", func(*ownerIndexFake) {}, "ok", "", []string{}, true},
		{"unrepairable rows", func(f *ownerIndexFake) {
			f.results["tm_a"] = mandala.ReconcileResult{Scanned: 3, Unrepairable: []string{"x.0"}}
			f.results[kyc] = mandala.ReconcileResult{Scanned: 1, Unrepairable: []string{"y.1"}}
		}, "degraded", "2 owner index rows unrepairable", []string{"x.0", "y.1"}, true},
		{"a refold fault still reconciles", func(f *ownerIndexFake) { f.refoldErr["a_0"] = refoldBoom{} },
			"degraded", "refold failed for 1 token(s) (refoldBoom)", []string{}, true},
		{"a reconcile fault names topic and class only", func(f *ownerIndexFake) { f.reconcileErr[kyc] = &reconcileBoom{} },
			"degraded", "reconcile " + kyc + " failed (reconcileBoom)", []string{}, true},
		{"both", func(f *ownerIndexFake) {
			f.refoldErr["b_0"] = refoldBoom{}
			f.reconcileErr["tm_a"] = &reconcileBoom{}
		}, "degraded", "refold failed for 1 token(s) (refoldBoom); reconcile tm_a failed (reconcileBoom)", []string{}, true},
		{"the token listing fails the run", func(f *ownerIndexFake) { f.idsErr = errors.New("mongo down") },
			"degraded", "owner index run failed (errorString)", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newOwnerIndexFake()
			c.setup(f)
			gate, lock := testGates()
			m := NewOwnerIndexMaintenance(f.deps(gate, lock))
			m.RunOnce(context.Background())
			s, msg := m.Readiness()
			if s != c.status || msg != c.message {
				t.Fatalf("readiness = %q %q, want %q %q", s, msg, c.status, c.message)
			}
			if strings.Contains(msg, "secret") || strings.Contains(msg, "mongodb://") {
				t.Fatalf("readiness leaks an error message: %q", msg)
			}
			if c.unrepairable != nil && !reflect.DeepEqual(m.Status().Unrepairable, c.unrepairable) {
				t.Fatalf("unrepairable = %v, want %v", m.Status().Unrepairable, c.unrepairable)
			}
			if got := slices.Contains(f.seen(), "reconcile "+kyc); got != c.reconciled {
				t.Fatalf("reconciled = %v, want %v (calls %v)", got, c.reconciled, f.seen())
			}
		})
	}
}

// A gate that cannot drain fails the whole run (nothing refolds or reconciles) and the next run comes sooner.
func TestOwnerIndexBusyGateFailsTheRunAndBacksOff(t *testing.T) {
	ctx := context.Background()
	f := newOwnerIndexFake()
	gate, lock := maintenance.NewGate(30*time.Millisecond), maintenance.NewGate(time.Second)
	release, err := gate.Enter(ctx)
	if err != nil {
		t.Fatal(err)
	}
	m := NewOwnerIndexMaintenance(f.deps(gate, lock))
	m.RunOnce(ctx)
	release()
	if st := m.Status(); st.Ran || st.LastError != "owner index run failed (BusyError)" {
		t.Fatalf("status = %+v", st)
	}
	if got := f.seen(); len(got) != 0 {
		t.Fatalf("calls = %v, want none while the gate cannot drain", got)
	}
	if d := delayOf(m); d != OwnerIndexRetryBase {
		t.Fatalf("next delay = %v, want %v", d, OwnerIndexRetryBase)
	}
	m.RunOnce(ctx)
	if s, _ := m.Readiness(); s != "ok" || delayOf(m) != OwnerIndexInterval {
		t.Fatalf("after recovery: readiness %q, delay %v", s, delayOf(m))
	}
}

func TestOwnerIndexFailuresCountUntilARunSucceeds(t *testing.T) {
	ctx := context.Background()
	f := newOwnerIndexFake()
	f.idsErr = errors.New("mongo down")
	gate, lock := testGates()
	m := NewOwnerIndexMaintenance(f.deps(gate, lock))
	m.RunOnce(ctx)
	m.RunOnce(ctx)
	if d := delayOf(m); d != 2*OwnerIndexRetryBase {
		t.Fatalf("after two failures: delay %v, want 20s", d)
	}
	f.idsErr = nil
	m.RunOnce(ctx)
	if d := delayOf(m); d != OwnerIndexInterval {
		t.Fatalf("after a success: delay %v, want the interval", d)
	}
}

func TestOwnerIndexBackoffTable(t *testing.T) {
	m := NewOwnerIndexMaintenance(newOwnerIndexFake().deps(testGates()))
	for _, c := range []struct {
		failures int
		interval time.Duration
		want     time.Duration
	}{
		{0, OwnerIndexInterval, OwnerIndexInterval},
		{1, OwnerIndexInterval, 10 * time.Second},
		{2, OwnerIndexInterval, 20 * time.Second},
		{3, OwnerIndexInterval, 40 * time.Second},
		{8, OwnerIndexInterval, 1280 * time.Second},
		{9, OwnerIndexInterval, OwnerIndexInterval},
		{40, OwnerIndexInterval, OwnerIndexInterval},
		{1, 50 * time.Millisecond, 50 * time.Millisecond},
	} {
		m.mu.Lock()
		m.failures, m.interval = c.failures, c.interval
		got := m.nextDelay()
		m.mu.Unlock()
		if got != c.want {
			t.Errorf("failures %d interval %v: delay %v, want %v", c.failures, c.interval, got, c.want)
		}
	}
}

// The refold takes the gate exclusively, so it waits for a submit already holding a shared slot.
func TestOwnerIndexRefoldWaitsForAnInFlightSubmit(t *testing.T) {
	f := newOwnerIndexFake()
	gate, lock := maintenance.NewGate(5*time.Second), maintenance.NewGate(time.Second)
	release, err := gate.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m := NewOwnerIndexMaintenance(f.deps(gate, lock))
	done := make(chan struct{})
	go func() {
		m.RunOnce(context.Background())
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	if got := f.seen(); len(got) != 0 {
		t.Fatalf("the refold ran beside an in-flight submit: %v", got)
	}
	release()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the run never finished after the submit drained")
	}
	if got := f.seen(); len(got) == 0 || got[0] != "ids" {
		t.Fatalf("calls = %v", got)
	}
}

func TestOwnerIndexRunOnceDedupsAnInFlightRun(t *testing.T) {
	f := newOwnerIndexFake()
	entered, unblock := make(chan struct{}), make(chan struct{})
	var once sync.Once
	f.onRefold = func() {
		once.Do(func() { close(entered) })
		<-unblock
	}
	gate, lock := testGates()
	m := NewOwnerIndexMaintenance(f.deps(gate, lock))
	done := make(chan struct{})
	go func() {
		m.RunOnce(context.Background())
		close(done)
	}()
	<-entered
	start := time.Now()
	m.RunOnce(context.Background())
	if time.Since(start) > time.Second {
		t.Fatal("a second RunOnce waited for the in-flight run instead of returning")
	}
	close(unblock)
	<-done
	ids := 0
	for _, c := range f.seen() {
		if c == "ids" {
			ids++
		}
	}
	if ids != 1 {
		t.Fatalf("token listing ran %d times, want 1", ids)
	}
}

func TestOwnerIndexErrorClasses(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{refoldBoom{}, "refoldBoom"},
		{&reconcileBoom{}, "reconcileBoom"},
		{errors.New("x"), "errorString"},
		{fmt.Errorf("wrap: %w", refoldBoom{}), "wrapError"},
		{&maintenance.BusyError{InFlight: 1}, "BusyError"},
		{context.DeadlineExceeded, "deadlineExceededError"},
		{genericBoom[int]{}, "Error"},
	} {
		if got := errorClass(c.err); got != c.want {
			t.Errorf("errorClass(%T) = %q, want %q", c.err, got, c.want)
		}
	}
	many := []error{refoldBoom{}, &reconcileBoom{}, errors.New("x"), fmt.Errorf("w: %w", refoldBoom{}),
		&maintenance.BusyError{}, context.DeadlineExceeded, genericBoom[int]{}, refoldBoom{}}
	if got, want := errorClasses(many), "BusyError, Error, deadlineExceededError, errorString, reconcileBoom, +2 more"; got != want {
		t.Fatalf("errorClasses = %q, want %q", got, want)
	}
}

func TestOwnerIndexStartRunsOnTheIntervalWithoutOverlapAndStopEndsIt(t *testing.T) {
	f := newOwnerIndexFake()
	var inflight, maxInflight, reconciles atomic.Int32
	f.onReconcile = func() {
		n := inflight.Add(1)
		for {
			cur := maxInflight.Load()
			if n <= cur || maxInflight.CompareAndSwap(cur, n) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		inflight.Add(-1)
		reconciles.Add(1)
	}
	gate, lock := testGates()
	m := NewOwnerIndexMaintenance(f.deps(gate, lock))
	m.Start(20 * time.Millisecond)
	if !m.armed() {
		t.Fatal("Start must arm a timer")
	}
	deadline := time.Now().Add(3 * time.Second)
	for reconciles.Load() < 6 {
		if time.Now().After(deadline) {
			t.Fatalf("only %d reconciles in 3 s", reconciles.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
	m.Stop()
	time.Sleep(60 * time.Millisecond) // a run already in flight finishes
	n := reconciles.Load()
	time.Sleep(150 * time.Millisecond)
	if reconciles.Load() != n {
		t.Fatal("runs continued after Stop")
	}
	if maxInflight.Load() != 1 {
		t.Fatalf("runs overlapped (max %d in flight)", maxInflight.Load())
	}
	if m.armed() {
		t.Fatal("Stop must disarm the timer")
	}
}

// C10: every registered token topic plus KYC, sorted; tm_mandala is never reconciled (the registry never journals).
func TestOwnerIndexTopicsAreTheRegisteredTokensPlusKYC(t *testing.T) {
	eng := engine.NewEngine(&engine.Config{})
	tokens := NewTokenTopics(eng, nil, false, func(string) (engine.TopicManager, engine.LookupService, error) {
		return &probeTM{}, &probeLS{}, nil
	})
	a, b := strings.Repeat("a", 64), strings.Repeat("b", 64)
	for _, id := range []string{b + "_0", a + "_0"} {
		if ok, err := tokens.Ensure(id); err != nil || !ok {
			t.Fatalf("Ensure(%s): %v %v", id, ok, err)
		}
	}
	got := ownerIndexTopics(tokens)()
	if want := []string{"tm_" + a, "tm_" + b, mandala.KYCTopic}; !reflect.DeepEqual(got, want) {
		t.Fatalf("topics = %v, want %v", got, want)
	}
	if slices.Contains(got, mandala.MandalaTopic) {
		t.Fatal("tm_mandala must never be reconciled")
	}
}

// App.Start: the boot union registers the token first, then the boot run refolds and reconciles its topic, then the
// interval is armed; Close disarms it.
func TestAppStartReconcilesTheBootUnionThenArmsTheInterval(t *testing.T) {
	app := buildV3App(t, v3Config("mandala3_test_wiring_ownerindex"))
	ctx := context.Background()
	if app.OwnerIndex == nil {
		t.Fatal("Build must wire the owner index")
	}
	if s, _ := app.OwnerIndex.Readiness(); s != "degraded" {
		t.Fatalf("readiness before Start = %q, want degraded", s)
	}
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	tokenID, topic := dep.Txid+"_0", "tm_"+dep.Txid
	if _, err := app.Store.StoreRegistryRecord(ctx, mandala.TokenRegistryRecord{
		TokenID: tokenID, DeployTxid: dep.Txid, Sym: "USD", Dec: 2, Label: "US Dollar", Issuer: mandalatest.Issuer.Identity, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	beef, _, _, err := transaction.ParseBeef(iss.Beef)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.EngineStore.InsertOutputs(ctx, topic, iss.Tx.TxID(), []uint32{0, 1}, nil, beef, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := app.Store.RecordOwners(ctx, []mandala.OwnerRecord{
		{Txid: iss.Txid, OutputIndex: 0, Topic: topic, TokenID: tokenID, Role: brc162.RoleAuthority, IdentityKey: mandalatest.Issuer.Identity, CreatedAt: now},
		{Txid: iss.Txid, OutputIndex: 1, Topic: topic, TokenID: tokenID, Role: brc162.RoleValue, Amount: 100, IdentityKey: mandalatest.Holder.Identity, CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}

	if err := app.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if row, _ := app.Store.GetTokenRow(ctx, iss.Txid, 1); row == nil || row.Amount != 100 || row.IdentityKey != mandalatest.Holder.Identity {
		t.Fatalf("value row = %+v: the boot reconcile did not cover the topic the boot union registered", row)
	}
	if auth, _ := app.Store.GetAuthorityRow(ctx, iss.Txid, 0); auth == nil || auth.IdentityKey != mandalatest.Issuer.Identity {
		t.Fatalf("authority row = %+v", auth)
	}
	if st := app.OwnerIndex.Status(); !st.Ran || st.LastError != "" || len(st.Unrepairable) != 0 {
		t.Fatalf("status = %+v", st)
	}
	if s, msg := app.OwnerIndex.Readiness(); s != "ok" || msg != "" {
		t.Fatalf("readiness = %q %q", s, msg)
	}
	if !app.OwnerIndex.armed() {
		t.Fatal("Start must arm the interval")
	}
	app.Close()
	if app.OwnerIndex.armed() {
		t.Fatal("Close must stop the timer")
	}
}

type sweepBoom struct{}

func (sweepBoom) Error() string { return "sweep boom" }

type rebuildBoom struct{}

func (rebuildBoom) Error() string { return "rebuild boom" }

// Rulings V-13 and V-11: after the refold loop, inside the same exclusive section, the sweep runs and then the balance
// rebuild; no submit can take a shared slot meanwhile and the reconcile lock is not held. Their counts and the unsafe
// identity keys are logged; an unsafe key never fails the run.
func TestOwnerIndexSweepsThenRebuildsBalancesInsideTheExclusiveSection(t *testing.T) {
	f := newOwnerIndexFake()
	f.swept = 2
	f.rebuilt = mandala.BalanceRebuild{Changed: 3, Unsafe: []string{"02aa"}}
	gate, lock := testGates()
	var bad []string
	exclusiveStep := func(step string) {
		f.record(step)
		if !gate.Busy() || lock.Busy() {
			bad = append(bad, step+" ran outside the gate's exclusive section or under the reconcile lock")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		if release, err := gate.Enter(ctx); err == nil {
			release()
			bad = append(bad, "a submit took a shared slot during "+step)
		}
	}
	f.onSweep = func() { exclusiveStep("sweep") }
	f.onRebuild = func() { exclusiveStep("rebuild balances") }
	var logs []string
	d := f.deps(gate, lock)
	d.Logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
	m := NewOwnerIndexMaintenance(d)
	m.RunOnce(context.Background())

	want := []string{"ids", "refold a_0", "refold b_0", "sweep", "rebuild balances", "reconcile tm_a", "reconcile " + mandala.KYCTopic}
	if got := f.seen(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls = %v, want %v", got, want)
	}
	if len(bad) != 0 {
		t.Fatal(strings.Join(bad, "; "))
	}
	for _, line := range []string{
		"[mandala] owner index sweep: 2 row(s) taken back",
		"[mandala] owner index balances: 3 rebuilt",
		"[mandala] owner index balance of 02aa exceeds the safe amount and was left as it is",
	} {
		if !slices.Contains(logs, line) {
			t.Fatalf("log %q missing from %q", line, logs)
		}
	}
	if s, msg := m.Readiness(); s != "ok" || msg != "" {
		t.Fatalf("readiness = %q %q, want ok (an unsafe balance never fails the run)", s, msg)
	}
}

// A sweep or balance-rebuild fault is recorded like a refold fault (V-11/V-13 "the refold's error class and retry
// backoff"): readiness carries the step and its class only, the run still reconciles every topic and counts as
// reconciled, and the next run comes sooner. A sweep fault skips the rebuild; a rebuild fault follows the sweep.
func TestOwnerIndexSweepAndRebuildFaultsStillReconcileAndBackOff(t *testing.T) {
	ctx := context.Background()
	kyc := mandala.KYCTopic
	for _, c := range []struct {
		name    string
		setup   func(f *ownerIndexFake)
		message string
		calls   []string
		logged  string
	}{
		{"sweep", func(f *ownerIndexFake) { f.sweepErr = sweepBoom{} }, "sweep failed (sweepBoom)",
			[]string{"ids", "refold a_0", "refold b_0", "sweep", "reconcile tm_a", "reconcile " + kyc},
			"[mandala] owner index error: sweep: sweepBoom: sweep boom"},
		{"rebuild", func(f *ownerIndexFake) { f.rebuildErr = rebuildBoom{} }, "balance rebuild failed (rebuildBoom)",
			[]string{"ids", "refold a_0", "refold b_0", "sweep", "rebuild balances", "reconcile tm_a", "reconcile " + kyc},
			"[mandala] owner index error: balance rebuild: rebuildBoom: rebuild boom"},
		{"sweep after a refold fault", func(f *ownerIndexFake) {
			f.refoldErr["a_0"] = refoldBoom{}
			f.sweepErr = sweepBoom{}
		}, "refold failed for 1 token(s) (refoldBoom); sweep failed (sweepBoom)",
			[]string{"ids", "refold a_0", "refold b_0", "sweep", "reconcile tm_a", "reconcile " + kyc},
			"[mandala] owner index error: sweep: sweepBoom: sweep boom"},
		{"rebuild beside a reconcile fault", func(f *ownerIndexFake) {
			f.rebuildErr = rebuildBoom{}
			f.reconcileErr["tm_a"] = &reconcileBoom{}
		}, "balance rebuild failed (rebuildBoom); reconcile tm_a failed (reconcileBoom)",
			[]string{"ids", "refold a_0", "refold b_0", "sweep", "rebuild balances", "reconcile tm_a", "reconcile " + kyc},
			"[mandala] owner index error: balance rebuild: rebuildBoom: rebuild boom"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newOwnerIndexFake()
			c.setup(f)
			f.swept = 1
			f.onSweep = func() { f.record("sweep") }
			f.onRebuild = func() { f.record("rebuild balances") }
			gate, lock := testGates()
			var logs []string
			deps := f.deps(gate, lock)
			deps.Logf = func(format string, args ...any) { logs = append(logs, fmt.Sprintf(format, args...)) }
			m := NewOwnerIndexMaintenance(deps)
			m.RunOnce(ctx)
			if s, msg := m.Readiness(); s != "degraded" || msg != c.message {
				t.Fatalf("readiness = %q %q, want degraded %q", s, msg, c.message)
			}
			if got := f.seen(); !reflect.DeepEqual(got, c.calls) {
				t.Fatalf("calls = %v, want %v", got, c.calls)
			}
			if st := m.Status(); !st.Ran || st.LastRunAt.IsZero() || st.Unrepairable == nil {
				t.Fatalf("status = %+v, want a reconciled run", st)
			}
			for _, line := range []string{c.logged, "[mandala] owner index sweep: 1 row(s) taken back"} {
				if !slices.Contains(logs, line) {
					t.Fatalf("log %q missing from %q", line, logs)
				}
			}
			if d := delayOf(m); d != OwnerIndexRetryBase {
				t.Fatalf("next delay = %v, want %v", d, OwnerIndexRetryBase)
			}
			m.RunOnce(ctx)
			if d := delayOf(m); d != 2*OwnerIndexRetryBase {
				t.Fatalf("after two faulted runs: delay %v, want %v", d, 2*OwnerIndexRetryBase)
			}
			f.refoldErr, f.sweepErr, f.rebuildErr, f.reconcileErr = map[string]error{}, nil, nil, map[string]error{}
			m.RunOnce(ctx)
			if s, _ := m.Readiness(); s != "ok" || delayOf(m) != OwnerIndexInterval {
				t.Fatalf("after recovery: readiness %q, delay %v", s, delayOf(m))
			}
		})
	}
}

// A reconcile lock that cannot drain fails the run after a faulted sweep: the run-failure text keeps the sweep's part.
func TestOwnerIndexRunFailureKeepsTheSweepFault(t *testing.T) {
	ctx := context.Background()
	f := newOwnerIndexFake()
	f.sweepErr = sweepBoom{}
	gate, lock := maintenance.NewGate(time.Second), maintenance.NewGate(30*time.Millisecond)
	release, err := lock.Enter(ctx)
	if err != nil {
		t.Fatal(err)
	}
	m := NewOwnerIndexMaintenance(f.deps(gate, lock))
	m.RunOnce(ctx)
	release()
	if st := m.Status(); st.Ran || st.LastError != "owner index run failed (BusyError); sweep failed (sweepBoom)" {
		t.Fatalf("status = %+v", st)
	}
	if got := f.seen(); slices.Contains(got, "reconcile tm_a") {
		t.Fatalf("calls = %v, want no reconcile while the lock cannot drain", got)
	}
	if d := delayOf(m); d != OwnerIndexRetryBase {
		t.Fatalf("next delay = %v, want %v", d, OwnerIndexRetryBase)
	}
}

// Both steps are required: a nil one is a wiring bug, refused at construction.
func TestNewOwnerIndexMaintenanceRequiresTheSweepAndTheBalanceRebuild(t *testing.T) {
	for _, c := range []struct {
		name string
		drop func(d *OwnerIndexDeps)
	}{
		{"SweepOwnerIndex", func(d *OwnerIndexDeps) { d.SweepOwnerIndex = nil }},
		{"RebuildBalances", func(d *OwnerIndexDeps) { d.RebuildBalances = nil }},
	} {
		d := newOwnerIndexFake().deps(testGates())
		c.drop(&d)
		func() {
			defer func() {
				if r := recover(); r != "wiring: OwnerIndexDeps.SweepOwnerIndex and OwnerIndexDeps.RebuildBalances are required" {
					t.Errorf("nil %s: recovered %v, want the required-deps panic", c.name, r)
				}
			}()
			NewOwnerIndexMaintenance(d)
		}()
	}
}

// Build wires V-13 and V-11: App.Start's boot run takes back the registered token's phantom row (debited), leaves an
// unregistered token's row alone, rebuilds the drifted balance from the rows, and then the reconcile credits the row
// it repairs.
func TestAppStartSweepsPhantomRowsAndRebuildsBalances(t *testing.T) {
	app := buildV3App(t, v3Config("mandala3_test_wiring_ownerindex_sweep"))
	ctx := context.Background()
	holder := mandalatest.Holder.Identity
	dep := mandalatest.Deploy(t, mandalatest.Issuer, "USD")
	iss := mandalatest.Issue(t, dep, 0, mandalatest.Issuer, mandalatest.Holder, 100)
	tokenID, topic := dep.Txid+"_0", "tm_"+dep.Txid
	phantom, unhosted := strings.Repeat("9", 64), strings.Repeat("8", 64)
	if _, err := app.Store.StoreRegistryRecord(ctx, mandala.TokenRegistryRecord{
		TokenID: tokenID, DeployTxid: dep.Txid, Sym: "USD", Dec: 2, Label: "US Dollar", Issuer: mandalatest.Issuer.Identity, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	beef, _, _, err := transaction.ParseBeef(iss.Beef)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.EngineStore.InsertOutputs(ctx, topic, iss.Tx.TxID(), []uint32{0, 1}, nil, beef, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := app.Store.RecordOwners(ctx, []mandala.OwnerRecord{
		{Txid: iss.Txid, OutputIndex: 0, Topic: topic, TokenID: tokenID, Role: brc162.RoleAuthority, IdentityKey: mandalatest.Issuer.Identity, CreatedAt: now},
		{Txid: iss.Txid, OutputIndex: 1, Topic: topic, TokenID: tokenID, Role: brc162.RoleValue, Amount: 100, IdentityKey: holder, CreatedAt: now},
	}); err != nil {
		t.Fatal(err)
	}
	for _, r := range []mandala.TokenRecord{
		{Txid: phantom, OutputIndex: 0, TokenID: tokenID, Amount: 11, IdentityKey: holder, CreatedAt: now},
		{Txid: unhosted, OutputIndex: 0, TokenID: unhosted + "_0", Amount: 13, IdentityKey: holder, CreatedAt: now},
	} {
		if _, err := app.Store.StoreTokenIfAbsent(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := app.Store.AdjustBalance(ctx, holder, 999); err != nil {
		t.Fatal(err)
	}

	if err := app.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if row, err := app.Store.GetTokenRow(ctx, phantom, 0); err != nil || row != nil {
		t.Fatalf("phantom row = %+v (%v), want it taken back", row, err)
	}
	if row, err := app.Store.GetTokenRow(ctx, unhosted, 0); err != nil || row == nil {
		t.Fatalf("unregistered token's row = %+v (%v), want it untouched", row, err)
	}
	if row, err := app.Store.GetTokenRow(ctx, iss.Txid, 1); err != nil || row == nil || row.Amount != 100 {
		t.Fatalf("reconciled row = %+v (%v)", row, err)
	}
	if bal, err := app.Store.GetBalance(ctx, holder); err != nil || bal != 13+100 {
		t.Fatalf("holder balance = %d (%v), want 113 (rebuilt from the rows, then credited by the repair)", bal, err)
	}
	if s, msg := app.OwnerIndex.Readiness(); s != "ok" || msg != "" {
		t.Fatalf("readiness = %q %q", s, msg)
	}
}

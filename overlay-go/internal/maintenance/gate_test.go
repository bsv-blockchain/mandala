package maintenance

// Ports overlay/src/maintenanceGate.test.ts (the gateSubmits/express cases are
// HTTP-layer and belong to Task 23) plus the Go-only ctx cases.

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// state reads the gate's counters under its mutex (test-only).
func (g *Gate) state() (inFlight, waiting int, active bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inFlight, g.exclusiveWaiting, g.exclusiveActive
}

// waitFor polls cond every millisecond for up to 5 s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func mustEnter(t *testing.T, g *Gate) func() {
	t.Helper()
	release, err := g.Enter(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return release
}

// recorder is a mutex-guarded event log.
type recorder struct {
	mu  sync.Mutex
	log []string
}

func (r *recorder) add(e string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.log = append(r.log, e)
}

func (r *recorder) get() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.log...)
}

func TestNewGateDefaultsTheDrainTimeout(t *testing.T) {
	for in, want := range map[time.Duration]time.Duration{0: DefaultDrainTimeout, -time.Second: DefaultDrainTimeout, 5 * time.Second: 5 * time.Second} {
		if got := NewGate(in).drainTimeout; got != want {
			t.Fatalf("NewGate(%v).drainTimeout = %v, want %v", in, got, want)
		}
	}
	if DefaultDrainTimeout != 60*time.Second {
		t.Fatalf("DefaultDrainTimeout = %v, want 60s (TS DEFAULT_DRAIN_TIMEOUT_MS)", DefaultDrainTimeout)
	}
}

func TestBusyErrorText(t *testing.T) {
	err := error(&BusyError{InFlight: 3})
	if err.Error() != "maintenance gate busy: 3 in-flight submit(s) did not drain" {
		t.Fatalf("text = %q", err.Error())
	}
}

func TestSharedSlotsCoexist(t *testing.T) {
	g := NewGate(0)
	r1, r2 := mustEnter(t, g), mustEnter(t, g)
	if n, _, _ := g.state(); n != 2 {
		t.Fatalf("inFlight = %d, want 2", n)
	}
	if g.Busy() {
		t.Fatal("shared slots alone must not make the gate Busy")
	}
	r1()
	r2()
	if n, _, _ := g.state(); n != 0 {
		t.Fatalf("inFlight = %d, want 0", n)
	}
}

func TestExclusiveWaitsForInFlightSubmitsToDrain(t *testing.T) {
	g := NewGate(0)
	release := mustEnter(t, g)
	var ran atomic.Bool
	done := make(chan error, 1)
	go func() {
		done <- g.Exclusive(context.Background(), func(context.Context) error { ran.Store(true); return nil })
	}()
	waitFor(t, "the exclusive to wait", g.Busy)
	time.Sleep(20 * time.Millisecond)
	if ran.Load() {
		t.Fatal("exclusive fn ran while a shared slot was held")
	}
	release()
	if err := <-done; err != nil || !ran.Load() {
		t.Fatalf("Exclusive = %v, ran = %v; want nil, true", err, ran.Load())
	}
}

func TestEnterWaitsForAnActiveExclusive(t *testing.T) {
	g := NewGate(0)
	rec := &recorder{}
	finish := make(chan struct{})
	started := make(chan struct{})
	exDone := make(chan error, 1)
	go func() {
		exDone <- g.Exclusive(context.Background(), func(context.Context) error {
			close(started)
			<-finish
			rec.add("maint")
			return nil
		})
	}()
	<-started
	entered := make(chan struct{})
	go func() {
		release, err := g.Enter(context.Background())
		if err == nil {
			rec.add("submit")
			release()
		}
		close(entered)
	}()
	time.Sleep(20 * time.Millisecond)
	if got := rec.get(); len(got) != 0 {
		t.Fatalf("log = %v, want nothing before the exclusive finishes", got)
	}
	close(finish)
	if err := <-exDone; err != nil {
		t.Fatal(err)
	}
	<-entered
	if got := rec.get(); len(got) != 2 || got[0] != "maint" || got[1] != "submit" {
		t.Fatalf("log = %v, want [maint submit]", got)
	}
}

// Writer preference: a waiting exclusive blocks new submits (no starvation).
func TestWaitingExclusiveBlocksNewSubmits(t *testing.T) {
	g := NewGate(0)
	rec := &recorder{}
	r1 := mustEnter(t, g)
	exDone := make(chan error, 1)
	go func() {
		exDone <- g.Exclusive(context.Background(), func(context.Context) error { rec.add("maint"); return nil })
	}()
	waitFor(t, "the exclusive to wait", g.Busy)
	lateDone := make(chan struct{})
	go func() {
		release, err := g.Enter(context.Background())
		if err == nil {
			rec.add("late")
			release()
		}
		close(lateDone)
	}()
	time.Sleep(20 * time.Millisecond)
	if got := rec.get(); len(got) != 0 {
		t.Fatalf("log = %v: a new submit got in while maintenance waited", got)
	}
	r1()
	if err := <-exDone; err != nil {
		t.Fatal(err)
	}
	<-lateDone
	if got := rec.get(); len(got) != 2 || got[0] != "maint" || got[1] != "late" {
		t.Fatalf("log = %v, want [maint late]", got)
	}
}

func TestReleaseIsIdempotentAndAFailingExclusiveFreesTheGate(t *testing.T) {
	g := NewGate(0)
	r := mustEnter(t, g)
	r()
	r()
	if n, _, _ := g.state(); n != 0 {
		t.Fatalf("inFlight = %d after a double release, want 0", n)
	}
	boom := errors.New("x")
	if err := g.Exclusive(context.Background(), func(context.Context) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("Exclusive = %v, want fn's error", err)
	}
	if g.Busy() {
		t.Fatal("gate still Busy after a failing exclusive")
	}
	mustEnter(t, g)()
}

func TestExclusivesNeverOverlap(t *testing.T) {
	g := NewGate(0)
	var active, maxActive atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = g.Exclusive(context.Background(), func(context.Context) error {
				n := active.Add(1)
				for {
					m := maxActive.Load()
					if n <= m || maxActive.CompareAndSwap(m, n) {
						break
					}
				}
				time.Sleep(2 * time.Millisecond)
				active.Add(-1)
				return nil
			})
		}()
	}
	wg.Wait()
	if m := maxActive.Load(); m != 1 {
		t.Fatalf("max concurrent exclusive sections = %d, want 1", m)
	}
}

func TestDrainTimeoutReturnsBusyErrorSkipsFnAndUnblocksQueuedSubmits(t *testing.T) {
	g := NewGate(50 * time.Millisecond)
	_ = mustEnter(t, g) // never released
	exDone := make(chan error, 1)
	var ran atomic.Bool
	go func() {
		exDone <- g.Exclusive(context.Background(), func(context.Context) error { ran.Store(true); return nil })
	}()
	waitFor(t, "the exclusive to wait", g.Busy)
	lateDone := make(chan error, 1)
	go func() {
		release, err := g.Enter(context.Background())
		if err == nil {
			release()
		}
		lateDone <- err
	}()
	err := <-exDone
	var busy *BusyError
	if !errors.As(err, &busy) || busy.InFlight != 1 {
		t.Fatalf("Exclusive = %v, want *BusyError{InFlight: 1}", err)
	}
	if err.Error() != "maintenance gate busy: 1 in-flight submit(s) did not drain" {
		t.Fatalf("text = %q", err.Error())
	}
	if ran.Load() {
		t.Fatal("fn ran after the drain timeout")
	}
	select {
	case err := <-lateDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("the queued submit stayed blocked after the exclusive gave up")
	}
	if _, waiting, active := g.state(); waiting != 0 || active {
		t.Fatalf("waiting = %d, active = %v after the timeout; want 0, false", waiting, active)
	}
}

func TestEnterHonoursCtxWhileWaiting(t *testing.T) {
	g := NewGate(0)
	finish := make(chan struct{})
	started := make(chan struct{})
	exDone := make(chan error, 1)
	go func() {
		exDone <- g.Exclusive(context.Background(), func(context.Context) error { close(started); <-finish; return nil })
	}()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	enterErr := make(chan error, 1)
	go func() {
		release, err := g.Enter(ctx)
		if err == nil {
			release()
		}
		enterErr <- err
	}()
	time.Sleep(10 * time.Millisecond)
	cancel()
	if err := <-enterErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("Enter = %v, want context.Canceled", err)
	}
	close(finish)
	if err := <-exDone; err != nil {
		t.Fatal(err)
	}
	if n, _, _ := g.state(); n != 0 {
		t.Fatalf("inFlight = %d, want 0: a cancelled Enter must not leak a slot", n)
	}
}

func TestExclusiveHonoursCtxWhileWaiting(t *testing.T) {
	g := NewGate(0)
	release := mustEnter(t, g)
	ctx, cancel := context.WithCancel(context.Background())
	var ran atomic.Bool
	exDone := make(chan error, 1)
	go func() {
		exDone <- g.Exclusive(ctx, func(context.Context) error { ran.Store(true); return nil })
	}()
	waitFor(t, "the exclusive to wait", g.Busy)
	cancel()
	if err := <-exDone; !errors.Is(err, context.Canceled) || ran.Load() {
		t.Fatalf("Exclusive = %v, ran = %v; want context.Canceled, false", err, ran.Load())
	}
	if g.Busy() {
		t.Fatal("gate still Busy after the cancelled exclusive")
	}
	r2 := mustEnter(t, g) // writer preference lifted: a new submit gets in at once
	r2()
	release()
}

func TestReconcileThenSubmitTakesTheReconcileLockFirst(t *testing.T) {
	reconcileLock, gate := NewGate(0), NewGate(0)
	slot := mustEnter(t, gate) // makes the inner Exclusive wait, so the order is observable
	var seen [2]bool
	done := make(chan error, 1)
	go func() {
		done <- ReconcileThenSubmit(reconcileLock, gate)(context.Background(), func(context.Context) error {
			seen = [2]bool{reconcileLock.Busy(), gate.Busy()}
			return nil
		})
	}()
	waitFor(t, "the submit gate's exclusive to wait", gate.Busy)
	if _, _, active := reconcileLock.state(); !active {
		t.Fatal("the submit gate is being waited on before the reconcile lock is held")
	}
	slot()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if seen != [2]bool{true, true} {
		t.Fatalf("inside fn: reconcileLock busy = %v, gate busy = %v; want both", seen[0], seen[1])
	}
	if reconcileLock.Busy() || gate.Busy() {
		t.Fatal("a lock is still held after ReconcileThenSubmit returned")
	}
}

func TestReconcileThenSubmitLeavesTheGateAloneWhileTheReconcileLockIsHeld(t *testing.T) {
	reconcileLock, gate := NewGate(0), NewGate(0)
	held := make(chan struct{})
	started := make(chan struct{})
	holderDone := make(chan error, 1)
	go func() {
		holderDone <- reconcileLock.Exclusive(context.Background(), func(context.Context) error { close(started); <-held; return nil })
	}()
	<-started
	ran := make(chan struct{})
	evDone := make(chan error, 1)
	go func() {
		evDone <- ReconcileThenSubmit(reconcileLock, gate)(context.Background(), func(context.Context) error { close(ran); return nil })
	}()
	waitFor(t, "the eviction to queue on the reconcile lock", func() bool { _, w, _ := reconcileLock.state(); return w == 1 })
	if gate.Busy() {
		t.Fatal("the submit gate was touched while the reconcile lock is held elsewhere")
	}
	mustEnter(t, gate)() // a submit is not blocked by a reconcile-lock holder
	close(held)
	if err := <-holderDone; err != nil {
		t.Fatal(err)
	}
	if err := <-evDone; err != nil {
		t.Fatal(err)
	}
	<-ran
}

func TestReconcileThenSubmitBusyReconcileLock(t *testing.T) {
	reconcileLock, gate := NewGate(20*time.Millisecond), NewGate(0)
	held := make(chan struct{})
	started := make(chan struct{})
	holderDone := make(chan error, 1)
	go func() {
		holderDone <- reconcileLock.Exclusive(context.Background(), func(context.Context) error { close(started); <-held; return nil })
	}()
	<-started
	var ran atomic.Bool
	err := ReconcileThenSubmit(reconcileLock, gate)(context.Background(), func(context.Context) error { ran.Store(true); return nil })
	var busy *BusyError
	if !errors.As(err, &busy) || ran.Load() {
		t.Fatalf("ReconcileThenSubmit = %v, ran = %v; want *BusyError, false", err, ran.Load())
	}
	if gate.Busy() {
		t.Fatal("the submit gate was touched")
	}
	close(held)
	if err := <-holderDone; err != nil {
		t.Fatal(err)
	}
}

func TestReconcileThenSubmitBusySubmitGateFreesTheReconcileLock(t *testing.T) {
	reconcileLock, gate := NewGate(0), NewGate(20*time.Millisecond)
	slot := mustEnter(t, gate)
	err := ReconcileThenSubmit(reconcileLock, gate)(context.Background(), func(context.Context) error { return nil })
	var busy *BusyError
	if !errors.As(err, &busy) || busy.InFlight != 1 {
		t.Fatalf("ReconcileThenSubmit = %v, want *BusyError{InFlight: 1}", err)
	}
	if reconcileLock.Busy() {
		t.Fatal("the reconcile lock is still held after the submit gate gave up")
	}
	slot()
}

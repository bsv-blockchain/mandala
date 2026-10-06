// Package maintenance holds the submit gate and the reconcile lock (a port of
// overlay/src/maintenanceGate.ts; F/p2-parity row 1).
//
// A Gate is shared/exclusive. Submits take a shared slot (Enter); state
// maintenance (owner-index refold, eviction) takes the exclusive section,
// which waits for in-flight submits to drain and, while it waits, holds back
// new ones (writer preference, so a busy overlay cannot starve maintenance).
// Unlike the TS overlay, Go submits really run concurrently (v1.3.7 Submit
// takes no lock), so the shared slots genuinely overlap.
//
// Lock order (Q3 Global Constraints, G14): reconcile lock -> submit gate
// (ReconcileThenSubmit, the eviction quiesce, is the only place both are
// held). A submit holds its shared slot -> then the TokenTopics registrar
// mutex, never the reverse; the registrar mutex is never held across a gate
// wait. A Gate is NOT re-entrant: never call Enter or Exclusive from inside an
// exclusive fn, and never call Exclusive while holding a shared slot (it waits
// for itself until the drain timeout returns *BusyError). Exclusive sections
// never call TokenTopics.Ensure; submits never take the reconcile lock.
package maintenance

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// DefaultDrainTimeout is TS DEFAULT_DRAIN_TIMEOUT_MS (60_000).
const DefaultDrainTimeout = 60 * time.Second

// BusyError is TS MaintenanceBusyError: an exclusive section could not start
// within the drain timeout; fn was not run.
type BusyError struct{ InFlight int }

// Error returns fmt.Sprintf("maintenance gate busy: %d in-flight submit(s) did not drain", e.InFlight).
func (e *BusyError) Error() string {
	return fmt.Sprintf("maintenance gate busy: %d in-flight submit(s) did not drain", e.InFlight)
}

// errDrainTimedOut is internal: the drain timer fired while Exclusive waited.
var errDrainTimedOut = errors.New("maintenance: drain timeout")

// Gate is a shared/exclusive gate with writer preference and a bounded drain.
type Gate struct {
	mu               sync.Mutex
	inFlight         int
	exclusiveActive  bool
	exclusiveWaiting int
	drainTimeout     time.Duration
	changed          chan struct{} // closed and replaced on every state change that can unblock a waiter
}

// NewGate returns a Gate whose Exclusive gives up after drainTimeout (<= 0 -> DefaultDrainTimeout).
func NewGate(drainTimeout time.Duration) *Gate {
	if drainTimeout <= 0 {
		drainTimeout = DefaultDrainTimeout
	}
	return &Gate{drainTimeout: drainTimeout, changed: make(chan struct{})}
}

// broadcastLocked wakes every waiter; callers hold g.mu.
func (g *Gate) broadcastLocked() {
	close(g.changed)
	g.changed = make(chan struct{})
}

// Enter takes a shared slot. It waits while an exclusive section is active or waiting (writer preference);
// ctx done -> ctx.Err(). release is idempotent.
func (g *Gate) Enter(ctx context.Context) (release func(), err error) {
	g.mu.Lock()
	for g.exclusiveActive || g.exclusiveWaiting > 0 {
		ch := g.changed
		g.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		g.mu.Lock()
	}
	g.inFlight++
	g.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			g.inFlight--
			if g.inFlight == 0 {
				g.broadcastLocked()
			}
		})
	}, nil
}

// Exclusive waits for every shared slot to drain, then runs fn alone. After drainTimeout it returns
// &BusyError{InFlight: n} WITHOUT running fn; ctx done -> ctx.Err(). Not re-entrant.
func (g *Gate) Exclusive(ctx context.Context, fn func(context.Context) error) error {
	timer := time.NewTimer(g.drainTimeout)
	defer timer.Stop()

	g.mu.Lock()
	g.exclusiveWaiting++
	for g.exclusiveActive || g.inFlight > 0 {
		ch := g.changed
		g.mu.Unlock()
		var stop error
		select {
		case <-ch:
		case <-timer.C:
			stop = errDrainTimedOut
		case <-ctx.Done():
			stop = ctx.Err()
		}
		g.mu.Lock()
		if stop != nil && (g.exclusiveActive || g.inFlight > 0) {
			inFlight := g.inFlight
			g.exclusiveWaiting--
			g.broadcastLocked() // queued Enters may proceed now
			g.mu.Unlock()
			if errors.Is(stop, errDrainTimedOut) {
				return &BusyError{InFlight: inFlight}
			}
			return stop
		}
	}
	g.exclusiveWaiting--
	g.exclusiveActive = true
	g.mu.Unlock()

	defer func() {
		g.mu.Lock()
		g.exclusiveActive = false
		g.broadcastLocked()
		g.mu.Unlock()
	}()
	return fn(ctx)
}

// Busy reports whether an exclusive section is active or waiting, i.e. whether
// Enter would block now. (TS `busy` is `shared > 0 || exclusiveActive` and is
// read only by tests; the Go tests need "maintenance has asked for the gate"
// to sequence races without sleeps, which this definition gives.)
func (g *Gate) Busy() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.exclusiveActive || g.exclusiveWaiting > 0
}

// ReconcileThenSubmit = reconcileLock.Exclusive(ctx, func(ctx) error { return submitGate.Exclusive(ctx, fn) }).
// Each wait is bounded by its own gate's drain timeout, so the whole acquisition gives up within the sum
// of the two with *BusyError and fn not run (TS reconcileThenSubmitGate).
func ReconcileThenSubmit(reconcileLock, submitGate *Gate) func(ctx context.Context, fn func(context.Context) error) error {
	return func(ctx context.Context, fn func(context.Context) error) error {
		return reconcileLock.Exclusive(ctx, func(ctx context.Context) error {
			return submitGate.Exclusive(ctx, fn)
		})
	}
}

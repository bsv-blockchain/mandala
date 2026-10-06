package wiring

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/maintenance"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

const (
	// OwnerIndexInterval is the period of the refold + reconcile run (overlay/src/ownerIndex.ts OWNER_INDEX_INTERVAL_MS).
	OwnerIndexInterval = 30 * time.Minute
	// OwnerIndexRetryBase is the first retry after a failed run; it doubles per consecutive failure, capped at the interval.
	OwnerIndexRetryBase = 10 * time.Second
	maxErrorClasses     = 5
)

// OwnerIndexStatus is the last run's outcome. LastError is the public summary (counts and error classes only).
type OwnerIndexStatus struct {
	Ran          bool
	LastRunAt    time.Time
	LastError    string
	Unrepairable []string
}

// OwnerIndexDeps are the run's collaborators.
type OwnerIndexDeps struct {
	Gate                *maintenance.Gate
	ReconcileLock       *maintenance.Gate
	TokenIDsWithHistory func(ctx context.Context) ([]string, error)
	RebuildState        func(ctx context.Context, tokenID string) error
	Reconcile           func(ctx context.Context, topic string) (mandala.ReconcileResult, error)
	Topics              func() []string // registered tm_<id> (sorted) + mandala.KYCTopic; never tm_mandala
	Logf                func(format string, args ...any)
	// SweepOwnerIndex takes back the index rows of the registered tokens whose coin is not unspent admitted and
	// returns how many it took (ruling V-13, mandala.SweepOwnerIndex). Required.
	SweepOwnerIndex func(ctx context.Context) (int, error)
	// RebuildBalances recomputes mandalaBalances from mandalaTokens (ruling V-11, (*mandala.Store).RebuildBalances).
	// Required.
	RebuildBalances func(ctx context.Context) (mandala.BalanceRebuild, error)
}

// OwnerIndexMaintenance is D §4.2a rule 5 on the host: at boot and on the interval it (1) refolds every token with
// admin history inside the exclusive submit gate (a refold must never run beside a live fold), then, in the same
// exclusive section, sweeps the phantom index rows (V-13) and rebuilds the balances (V-11), then (2) reconciles each
// topic under the reconcile lock only, beside live submits. The two steps never nest, so with eviction taking the lock
// and then the gate there is no wait-for cycle. A run never fails the caller: faults are recorded, readiness degrades,
// and the next run comes sooner (10 s, doubling, capped at the interval).
type OwnerIndexMaintenance struct {
	d          OwnerIndexDeps
	mu         sync.Mutex
	status     OwnerIndexStatus
	running    bool
	timer      *time.Timer
	generation int
	interval   time.Duration
	failures   int
}

// NewOwnerIndexMaintenance builds the maintenance; nothing runs until RunOnce or Start. A nil SweepOwnerIndex or
// RebuildBalances is a wiring bug and panics: a run without them would leave phantom rows and drifted balances.
func NewOwnerIndexMaintenance(d OwnerIndexDeps) *OwnerIndexMaintenance {
	if d.SweepOwnerIndex == nil || d.RebuildBalances == nil {
		panic("wiring: OwnerIndexDeps.SweepOwnerIndex and OwnerIndexDeps.RebuildBalances are required")
	}
	if d.Logf == nil {
		d.Logf = func(string, ...any) {}
	}
	return &OwnerIndexMaintenance{d: d, interval: OwnerIndexInterval}
}

// ownerIndexTopics is the production Topics: every registered token topic, then KYC. tm_mandala is never in it: the
// registry never journals, so there is nothing to reconcile there (C10).
func ownerIndexTopics(tokens *TokenTopics) func() []string {
	return func() []string {
		ids := tokens.Registered()
		topics := make([]string, 0, len(ids)+1)
		for _, id := range ids {
			if topic, err := mandala.TokenTopic(id); err == nil {
				topics = append(topics, topic)
			}
		}
		return append(topics, mandala.KYCTopic)
	}
}

var errorClassName = regexp.MustCompile(`^[A-Za-z_$][\w$]{0,63}$`)

// errorClass is the error's Go type name without pointer or package, the only part readiness publishes (TS F2: a
// driver's message can carry hosts and credentials). A name that is not a plain identifier reads "Error".
func errorClass(err error) string {
	name := strings.TrimLeft(fmt.Sprintf("%T", err), "*")
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		name = name[i+1:]
	}
	if !errorClassName.MatchString(name) {
		return "Error"
	}
	return name
}

// errorClasses lists the distinct classes sorted, at most five, then ", +N more".
func errorClasses(errs []error) string {
	set := map[string]bool{}
	for _, err := range errs {
		set[errorClass(err)] = true
	}
	all := make([]string, 0, len(set))
	for name := range set {
		all = append(all, name)
	}
	sort.Strings(all)
	if len(all) <= maxErrorClasses {
		return strings.Join(all, ", ")
	}
	return strings.Join(all[:maxErrorClasses], ", ") + fmt.Sprintf(", +%d more", len(all)-maxErrorClasses)
}

type topicError struct {
	topic string
	err   error
}

func summarizeOwnerIndex(refold []error, reconcile []topicError) string {
	var parts []string
	if len(refold) > 0 {
		parts = append(parts, fmt.Sprintf("refold failed for %d token(s) (%s)", len(refold), errorClasses(refold)))
	}
	for _, r := range reconcile {
		parts = append(parts, fmt.Sprintf("reconcile %s failed (%s)", r.topic, errorClass(r.err)))
	}
	return strings.Join(parts, "; ")
}

// RunOnce runs one refold + reconcile pass. It never fails the caller, and a call while a run is in flight returns at
// once without starting another.
func (m *OwnerIndexMaintenance) RunOnce(ctx context.Context) {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return
	}
	m.running = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.running = false
		m.mu.Unlock()
	}()
	m.run(ctx)
}

func (m *OwnerIndexMaintenance) run(ctx context.Context) {
	var refoldErrs []error
	// Step 1, submit gate only.
	err := m.d.Gate.Exclusive(ctx, func(ctx context.Context) error {
		started := time.Now()
		ids, err := m.d.TokenIDsWithHistory(ctx)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if err := m.d.RebuildState(ctx, id); err != nil {
				refoldErrs = append(refoldErrs, err)
				m.d.Logf("[mandala] owner index error: refold %s: %s: %v", id, errorClass(err), err)
			}
		}
		m.d.Logf("[mandala] owner index refold: %d token(s) in %dms", len(ids), time.Since(started).Milliseconds())
		// Rulings V-13 then V-11. The sweep's debits come first, so the rebuild sums the rows that remain. A fault in
		// either fails the run like a token-listing fault: the next run comes sooner.
		swept, err := m.d.SweepOwnerIndex(ctx)
		if err != nil {
			return err
		}
		m.d.Logf("[mandala] owner index sweep: %d row(s) taken back", swept)
		rebuilt, err := m.d.RebuildBalances(ctx)
		if err != nil {
			return err
		}
		m.d.Logf("[mandala] owner index balances: %d rebuilt", rebuilt.Changed)
		for _, key := range rebuilt.Unsafe {
			m.d.Logf("[mandala] owner index balance of %s exceeds the safe amount and was left as it is", key)
		}
		return nil
	})
	// Step 2, reconcile lock only.
	if err == nil {
		err = m.d.ReconcileLock.Exclusive(ctx, func(ctx context.Context) error {
			var reconcileErrs []topicError
			unrepairable := []string{}
			for _, topic := range m.d.Topics() {
				r, err := m.d.Reconcile(ctx, topic)
				if err != nil {
					reconcileErrs = append(reconcileErrs, topicError{topic: topic, err: err})
					m.d.Logf("[mandala] owner index error: reconcile %s: %s: %v", topic, errorClass(err), err)
					continue
				}
				unrepairable = append(unrepairable, r.Unrepairable...)
				m.d.Logf("[mandala] owner index %s: scanned %d, repaired %d, unrepairable %d", topic, r.Scanned, r.Repaired, len(r.Unrepairable))
			}
			for _, op := range unrepairable {
				m.d.Logf("[mandala] owner index UNREPAIRABLE outpoint %s", op)
			}
			m.mu.Lock()
			m.status = OwnerIndexStatus{Ran: true, LastRunAt: time.Now(), LastError: summarizeOwnerIndex(refoldErrs, reconcileErrs), Unrepairable: unrepairable}
			m.mu.Unlock()
			return nil
		})
	}
	if err != nil {
		m.d.Logf("[mandala] owner index run failed: %v", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err != nil {
		failed := fmt.Sprintf("owner index run failed (%s)", errorClass(err))
		if refold := summarizeOwnerIndex(refoldErrs, nil); refold != "" {
			failed += "; " + refold
		}
		m.status.LastError = failed
	}
	if m.status.LastError == "" {
		m.failures = 0
	} else {
		m.failures++
	}
}

// nextDelay is the wait before the next scheduled run: the interval after a success, else 10 s doubling per
// consecutive failure (exponent capped at 30), never above the interval. The caller holds m.mu.
func (m *OwnerIndexMaintenance) nextDelay() time.Duration {
	if m.failures == 0 {
		return m.interval
	}
	backoff := OwnerIndexRetryBase
	for i := 0; i < m.failures-1 && i < 30 && backoff < m.interval; i++ {
		backoff *= 2
	}
	if backoff > m.interval {
		return m.interval
	}
	return backoff
}

// Start arms a timer chain: each run is scheduled only after the previous one finished, so runs never overlap.
func (m *OwnerIndexMaintenance) Start(interval time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
	m.interval = interval
	m.armLocked(m.generation)
}

func (m *OwnerIndexMaintenance) armLocked(generation int) {
	if generation != m.generation {
		return
	}
	m.timer = time.AfterFunc(m.nextDelay(), func() {
		m.RunOnce(context.Background())
		m.mu.Lock()
		defer m.mu.Unlock()
		m.armLocked(generation)
	})
}

// Stop ends the chain; a run already in flight finishes and does not re-arm. Idempotent.
func (m *OwnerIndexMaintenance) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked()
}

func (m *OwnerIndexMaintenance) stopLocked() {
	m.generation++
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
}

func (m *OwnerIndexMaintenance) armed() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.timer != nil
}

// Status is a copy of the last outcome.
func (m *OwnerIndexMaintenance) Status() OwnerIndexStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.status
	s.Unrepairable = slices.Clone(m.status.Unrepairable) // keeps [] as [] (a nil slice only before the first full run)
	return s
}

// Readiness is the mandala-owner-index check (critical: false, so it degrades readiness but never fails it).
func (m *OwnerIndexMaintenance) Readiness() (string, string) {
	s := m.Status()
	switch {
	case !s.Ran && s.LastError == "":
		return "degraded", "owner index not yet reconciled"
	case s.LastError != "":
		return "degraded", s.LastError
	case len(s.Unrepairable) > 0:
		return "degraded", fmt.Sprintf("%d owner index rows unrepairable", len(s.Unrepairable))
	default:
		return "ok", ""
	}
}

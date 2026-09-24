// Package sweeper is the fuelKeeper housekeeping loop (spec §4.7). Every
// tick runs rules 0-4 in order against the reservation store:
//
//	0  reserving past expires_at → re-run detach+verify: spendable →
//	   released(needs_recheck=0); definitively not spendable → dropped; any
//	   error → left reserving for the next tick (never drop unseen fuel).
//	1  reserved past expires_at → released(needs_recheck=1).
//	2  released(needs_recheck=1) → chain check: unspent → needs_recheck=0;
//	   spent → spent_external + deny the last requester, only when that CAS
//	   actually moved the row; checker error → unchanged.
//	3  consumed, unsettled > 5 min → log only (the overlay owns settle
//	   retries).
//	4  consumed, unsettled > 30 min → ask the overlay's admission record:
//	   200 → never release, alert, POST /fuel/resettle; 410 or a final 400 →
//	   released(needs_recheck=1); 404 → released(needs_recheck=1) only after
//	   two unspent chain observations ≥ 10 min apart; anything else → nothing.
//
// Every transition is a store CAS, so a tick racing /consume, /settle or a
// draft converges: whichever write lands first wins and the other misses.
// A rule that fails logs and the tick moves on to the next rule.
package sweeper

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/chain"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
)

// Rule thresholds and batch sizes (spec §4.7).
const (
	Rule3Age        = 5 * time.Minute
	Rule4Age        = 30 * time.Minute
	Rule4ObserveGap = 10 * time.Minute

	// recheckBatch bounds rule 2's chain lookups per tick (WhatsOnChain is
	// rate limited; the rest wait for the next tick).
	recheckBatch = 100
	// tickTimeout bounds one Run tick so a hung dependency cannot stall the
	// loop; anything cut short is simply retried next tick.
	tickTimeout     = 5 * time.Minute
	defaultInterval = 30 * time.Second
	// denyAttempts: the spent_external CAS is terminal, so its deny must not
	// be lost to one transient store error.
	denyAttempts = 3
	cleanupWait  = 10 * time.Second
)

// Alert names, logged at Error with attribute alert=<name> (spec §4.8).
const (
	AlertSpentExternal     = "spent_external"
	AlertConsumedUnsettled = "consumedUnsettled"
)

// DenyReason is the fuel_denylist reason rule 2 writes.
const DenyReason = "spent_external"

// txidRe is the only txid shape sent to the overlay. Anything else would draw
// a 400 ERR_SHAPE, which says nothing about the transaction.
var txidRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// OverlayClient is the overlay surface rule 4 needs.
type OverlayClient interface {
	// AdmissionStatus is GET /admin/admission/{txid}: the HTTP status, and
	// for a 4xx whether its body is a final refusal (retryable:false). err
	// is set only when no HTTP answer arrived (transport error, timeout).
	AdmissionStatus(ctx context.Context, txid string) (code int, finalReject bool, err error)
	// Resettle is POST /fuel/resettle {txid}; non-2xx is an error.
	Resettle(ctx context.Context, txid string) error
}

// Sweeper runs the §4.7 rules. Tick is serialized; Run drives it.
type Sweeper struct {
	st           *store.Store
	src          fuel.Source
	checker      chain.Checker
	overlay      OverlayClient
	now          func() time.Time
	logger       *slog.Logger
	reservingTTL int64

	mu sync.Mutex // serializes Tick and guards firstUnspent
	// firstUnspent is rule 4's first 404+unspent observation per txid. It is
	// in-process only: a restart forgets it, which only delays a release by
	// one more observation gap and can never cause one.
	firstUnspent map[string]time.Time
}

// New returns a Sweeper. A nil checker means chain.Disabled (rule 2 then
// leaves every row pending); a nil overlay disables rule 4 (warned here and
// on every tick that has rows for it). A nil now means time.Now; a nil logger
// discards. reservingTTL is informational: rule 0 uses each row's own
// expires_at, which the claim stamped with the same TTL.
func New(st *store.Store, src fuel.Source, checker chain.Checker, overlay OverlayClient, now func() time.Time, logger *slog.Logger, reservingTTL int64) *Sweeper {
	if now == nil {
		now = time.Now
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if checker == nil {
		checker = chain.Disabled{}
	}
	if overlay == nil {
		logger.Warn("sweeper: no overlay client (FK_OVERLAY_URL unset); rule 4 is disabled and consumed rows that never settle stay consumed")
	}
	return &Sweeper{
		st: st, src: src, checker: checker, overlay: overlay, now: now, logger: logger,
		reservingTTL: reservingTTL, firstUnspent: map[string]time.Time{},
	}
}

// Run ticks immediately and then every interval (≤ 0 means 30 s) until ctx
// is done. Each tick is bounded by a timeout, and a panic inside a tick is
// logged instead of killing the process.
func (s *Sweeper) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = defaultInterval
	}
	s.logger.Info("sweeper: started", "every", every.String(), "reservingTTLSeconds", s.reservingTTL, "rule4", s.overlay != nil)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		s.runOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Sweeper) runOnce(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			s.logger.Error("sweeper: tick panicked", "panic", fmt.Sprint(r))
		}
	}()
	tctx, cancel := context.WithTimeout(ctx, tickTimeout)
	defer cancel()
	_ = s.Tick(tctx) // every rule logs its own failure
}

// Tick runs rules 0-4 once, in order. A failing rule is logged and the next
// rule still runs; the joined rule errors are returned.
func (s *Sweeper) Tick(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rules := []struct {
		name string
		fn   func(context.Context) error
	}{
		{"rule0", s.rule0}, {"rule1", s.rule1}, {"rule2", s.rule2}, {"rule3", s.rule3}, {"rule4", s.rule4},
	}
	var errs []error
	for _, r := range rules {
		if err := r.fn(ctx); err != nil {
			s.logger.Error("sweeper: rule failed", "rule", r.name, "err", err)
			errs = append(errs, fmt.Errorf("sweeper %s: %w", r.name, err))
		}
	}
	return errors.Join(errs...)
}

// rule0: reserving past expires_at → detach+verify again (spec §4.3 steps
// 6-7). The drafter never hands out a signature before Commit moves the row
// to reserved, so a verified row goes back to the pool with needs_recheck=0.
func (s *Sweeper) rule0(ctx context.Context) error {
	rows, err := s.st.ExpiredReserving(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, r := range rows {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		log := s.logger.With("rule", 0, "outpoint", r.Outpoint, "requestId", r.RequestID)
		if err := s.src.Detach(ctx, r.Outpoint); err != nil {
			log.Warn("sweeper: detach failed; row left reserving for the next tick", "err", err)
			continue
		}
		spendable, err := s.src.StillSpendable(ctx, r.Outpoint)
		if err != nil {
			log.Warn("sweeper: verify failed; row left reserving for the next tick", "err", err)
			continue
		}
		if !spendable {
			if err := s.st.Drop(ctx, r.Outpoint, r.RequestID); err != nil {
				errs = append(errs, fmt.Errorf("drop %s: %w", r.Outpoint, err))
				continue
			}
			log.Warn("sweeper: expired reservation is no longer spendable (taken by the storage funder); dropped")
			continue
		}
		moved, err := s.st.ReleaseReservingOutpoint(ctx, r.Outpoint, r.RequestID, false)
		if err != nil {
			errs = append(errs, fmt.Errorf("release %s: %w", r.Outpoint, err))
			continue
		}
		if moved {
			log.Info("sweeper: expired reservation verified and returned to the pool")
		} else {
			log.Info("sweeper: expired reservation moved on meanwhile; left as is")
		}
	}
	return errors.Join(errs...)
}

// rule1: reserved past expires_at → released, needs_recheck=1 (the holder
// may have broadcast the bare draft).
func (s *Sweeper) rule1(ctx context.Context) error {
	n, err := s.st.ExpireReserved(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		s.logger.Info("sweeper: expired drafts released pending a chain recheck", "rule", 1, "rows", n)
	}
	return nil
}

// rule2: released, needs_recheck=1 → chain check. A checker error is never
// an answer; a spent verdict denies the requester only when the CAS moved
// the row (a concurrent /settle repair wins the race and nobody is denied).
func (s *Sweeper) rule2(ctx context.Context) error {
	rows, err := s.st.RecheckPending(ctx, recheckBatch)
	if err != nil {
		return err
	}
	var (
		errs      []error
		failed    int
		firstFail error
	)
	for _, r := range rows {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		unspent, err := s.checker.IsUnspent(ctx, r.FuelScript, r.Outpoint)
		if err != nil {
			failed++
			if firstFail == nil {
				firstFail = err
			}
			continue
		}
		moved, err := s.st.SetRechecked(ctx, r.Outpoint, unspent)
		if err != nil {
			errs = append(errs, fmt.Errorf("recheck %s: %w", r.Outpoint, err))
			continue
		}
		log := s.logger.With("rule", 2, "outpoint", r.Outpoint, "requester", r.Requester, "txid", r.Txid)
		switch {
		case !moved:
			log.Info("sweeper: row moved on during the chain check; verdict discarded", "unspent", unspent)
		case unspent:
			log.Info("sweeper: released fuel is unspent on chain; claimable again")
		default:
			log.Error("sweeper: released fuel was spent outside the keeper", "alert", AlertSpentExternal)
			if err := s.deny(ctx, r); err != nil {
				log.Error("sweeper: could not deny the requester; deny manually", "alert", AlertSpentExternal, "err", err)
				errs = append(errs, err)
			}
		}
	}
	if failed > 0 {
		s.logger.Warn("sweeper: chain check failed; rows stay pending", "rule", 2, "rows", failed, "err", firstFail)
	}
	return errors.Join(errs...)
}

// deny writes the rule-2 deny entry. The row is already terminal, so the
// write is retried and outlives a cancelled tick.
func (s *Sweeper) deny(ctx context.Context, r store.Reservation) error {
	if r.Requester == "" {
		return fmt.Errorf("deny %s: row has no requester", r.Outpoint)
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupWait)
	defer cancel()
	var err error
	for range denyAttempts {
		if err = s.st.Deny(cctx, r.Requester, DenyReason, r.Outpoint); err == nil {
			return nil
		}
	}
	return fmt.Errorf("deny %s for %s: %w", r.Requester, r.Outpoint, err)
}

// txGroup is the unsettled consumed rows of one txid, oldest update first.
type txGroup struct {
	txid   string
	rows   []store.Reservation
	oldest int64 // min updated_at
}

func groupByTxid(rows []store.Reservation) []txGroup {
	idx := map[string]int{}
	var out []txGroup
	for _, r := range rows {
		i, ok := idx[r.Txid]
		if !ok {
			i = len(out)
			idx[r.Txid] = i
			out = append(out, txGroup{txid: r.Txid, oldest: r.UpdatedAt})
		}
		out[i].rows = append(out[i].rows, r)
		out[i].oldest = min(out[i].oldest, r.UpdatedAt)
	}
	return out
}

// rule3: consumed without settled_at for more than 5 min → log only. Rows
// past 30 min are rule 4's and are not logged twice.
func (s *Sweeper) rule3(ctx context.Context) error {
	rows, err := s.st.UnsettledConsumed(ctx, Rule3Age)
	if err != nil {
		return err
	}
	now := s.now().Unix()
	for _, g := range groupByTxid(rows) {
		age := time.Duration(now-g.oldest) * time.Second
		if age >= Rule4Age {
			continue
		}
		s.logger.Warn("sweeper: consumed fuel not yet settled; the overlay owns settle retries",
			"rule", 3, "txid", g.txid, "rows", len(g.rows), "age", age.String())
	}
	return nil
}

// rule4: consumed without settled_at for more than 30 min → the overlay's
// admission record decides. A rule-4 release is always needs_recheck=1.
func (s *Sweeper) rule4(ctx context.Context) error {
	rows, err := s.st.UnsettledConsumed(ctx, Rule4Age)
	if err != nil {
		return err
	}
	groups := groupByTxid(rows)
	seen := make(map[string]bool, len(groups))
	defer func() {
		// Forget observations for txids that left rule 4's scope (settled,
		// released, or re-claimed) so the map cannot grow without bound.
		for txid := range s.firstUnspent {
			if !seen[txid] {
				delete(s.firstUnspent, txid)
			}
		}
	}()
	if len(groups) == 0 {
		return nil
	}
	if s.overlay == nil {
		for _, g := range groups {
			seen[g.txid] = true
		}
		s.logger.Warn("sweeper: consumed fuel unsettled past 30 min but rule 4 is disabled (no overlay client)",
			"rule", 4, "txids", len(groups), "alert", AlertConsumedUnsettled)
		return nil
	}
	var errs []error
	for _, g := range groups {
		if err := ctx.Err(); err != nil {
			// Keep observations of txids this tick did not reach.
			for _, rest := range groups {
				seen[rest.txid] = true
			}
			return errors.Join(append(errs, err)...)
		}
		seen[g.txid] = true
		if err := s.rule4Txid(ctx, g); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *Sweeper) rule4Txid(ctx context.Context, g txGroup) error {
	log := s.logger.With("rule", 4, "txid", g.txid, "rows", len(g.rows))
	if !txidRe.MatchString(g.txid) {
		log.Error("sweeper: consumed rows carry a malformed txid; never released automatically", "alert", AlertConsumedUnsettled)
		return nil
	}
	code, final, err := s.overlay.AdmissionStatus(ctx, g.txid)
	if err != nil {
		log.Warn("sweeper: overlay admission lookup failed; nothing this pass", "err", err)
		return nil
	}
	switch {
	case code == http.StatusOK:
		delete(s.firstUnspent, g.txid)
		log.Error("sweeper: overlay admitted this tx but its fuel never settled; asking the overlay to resettle", "alert", AlertConsumedUnsettled)
		if err := s.overlay.Resettle(ctx, g.txid); err != nil {
			log.Warn("sweeper: overlay resettle failed; retried next tick", "err", err)
		}
		return nil
	case code == http.StatusGone, code == http.StatusBadRequest && final:
		delete(s.firstUnspent, g.txid)
		n, err := s.st.ReleaseByRule4(ctx, g.txid)
		if err != nil {
			return fmt.Errorf("release %s: %w", g.txid, err)
		}
		log.Warn("sweeper: overlay reports the tx evicted or finally refused; fuel released pending a chain recheck", "status", code, "released", n)
		return nil
	case code == http.StatusNotFound:
		return s.rule4NotFound(ctx, g.txid, log)
	default:
		log.Warn("sweeper: no usable overlay verdict; nothing this pass", "status", code, "final", final)
		return nil
	}
}

// rule4NotFound: the overlay has no record of the tx. Release only when every
// consumed row of the txid is unspent on chain on two observations at least
// Rule4ObserveGap apart; a spent input or a settled row means the tx (or
// something else) did reach the chain, so the rows are never released here.
func (s *Sweeper) rule4NotFound(ctx context.Context, txid string, log *slog.Logger) error {
	all, err := s.st.ByTxid(ctx, txid)
	if err != nil {
		return fmt.Errorf("rows %s: %w", txid, err)
	}
	var consumed []store.Reservation
	for _, r := range all {
		if r.Status != store.StatusConsumed {
			continue
		}
		if r.SettledAt != nil {
			delete(s.firstUnspent, txid)
			log.Error("sweeper: overlay has no admission yet part of this tx was settled; not releasing", "alert", AlertConsumedUnsettled, "settled", r.Outpoint)
			return nil
		}
		consumed = append(consumed, r)
	}
	if len(consumed) == 0 {
		delete(s.firstUnspent, txid)
		return nil
	}
	for _, r := range consumed {
		unspent, err := s.checker.IsUnspent(ctx, r.FuelScript, r.Outpoint)
		if err != nil {
			log.Warn("sweeper: chain check failed; no observation this pass", "outpoint", r.Outpoint, "err", err)
			return nil
		}
		if !unspent {
			delete(s.firstUnspent, txid)
			log.Error("sweeper: overlay has no admission but this tx's fuel is spent on chain; not releasing",
				"alert", AlertConsumedUnsettled, "outpoint", r.Outpoint)
			return nil
		}
	}
	now := s.now()
	first, ok := s.firstUnspent[txid]
	if !ok {
		s.firstUnspent[txid] = now
		log.Info("sweeper: overlay has no admission and the fuel is unspent; first observation recorded")
		return nil
	}
	if now.Sub(first) < Rule4ObserveGap {
		return nil
	}
	n, err := s.st.ReleaseByRule4(ctx, txid)
	if err != nil {
		return fmt.Errorf("release %s: %w", txid, err)
	}
	delete(s.firstUnspent, txid)
	log.Warn("sweeper: overlay has no admission and the fuel stayed unspent; released pending a chain recheck",
		"released", n, "firstObservation", first.UTC().Format(time.RFC3339))
	return nil
}

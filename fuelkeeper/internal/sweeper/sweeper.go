// Package sweeper is the fuelKeeper housekeeping loop (spec §4.7). Every
// tick runs rules 0-4 in order against the reservation store, then the §4.8
// pool watch:
//
//	0  reserving past expires_at → re-run detach+verify: spendable →
//	   released(needs_recheck=0); definitively not spendable → dropped; any
//	   error → left reserving for the next tick (never drop unseen fuel).
//	1  reserved past expires_at → released(needs_recheck=1).
//	2  released(needs_recheck=1) → chain check, gated by a canary: the chain
//	   service must first call a proven pool row (one the wallet lists as
//	   spendable) unspent, or rule 2 is skipped for the tick (an error or a
//	   "spent" canary answer also raises alert=chain_check_untrusted).
//	   unspent → needs_recheck=0; spent → acted on only after a second "spent"
//	   reading at least 10 min after the first (in-process memory; a later
//	   unspent reading clears it): spent_external + alert, and deny the last
//	   requester only when that CAS actually moved the row and the row carries
//	   no txid (a row with a txid came from an eviction or a rule-4 release:
//	   its consumed tx most likely mined anyway, so nobody is denied); checker
//	   error or a first reading → the row only moves to the back of the queue
//	   (updated_at bumped).
//	3  consumed, unsettled > 5 min → log only (the overlay owns settle
//	   retries).
//	4  consumed, unsettled > 30 min → ask the overlay's admission record:
//	   200 → never release, alert, POST /fuel/resettle; 410 or a final 400 →
//	   released(needs_recheck=1) (settled rows never); the overlay's own 404
//	   "no admission on record" → released(needs_recheck=1) only after two
//	   unspent chain observations ≥ 10 min apart; anything else (including a
//	   404 that is not the overlay's answer) → nothing.
//
// The pool watch (WithPoolWatch) logs alert=low_water, issuer_balance_low and
// pool_drain_unexplained (spec §4.8).
//
// Every transition is a store CAS, so a tick racing /consume, /settle or a
// draft converges: whichever write lands first wins and the other misses.
// A rule that fails logs and the tick moves on to the next rule.
//
// All in-process memory (rule 2's first "spent" readings, rule 4's first
// unspent observations, the pool watch's previous snapshot) assumes a single
// keeper replica; a restart forgets it, which only delays a transition or an
// alert and can never cause one.
package sweeper

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
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
	// Rule2ConfirmGap is the minimum spacing of the two "spent" readings
	// rule 2 needs before it marks a row spent_external (or denies anyone).
	Rule2ConfirmGap = 10 * time.Minute
	// spentMemoryTTL bounds how long a first "spent" reading is kept for a
	// row rule 2 has not come back to (only reachable with a recheck queue
	// longer than one batch). Forgetting a reading only delays a verdict.
	spentMemoryTTL = 24 * time.Hour
	// poolWatchLimit is the pool listing size the §4.8 watch counts.
	poolWatchLimit = 10000

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
	AlertSpentExternal        = "spent_external"
	AlertConsumedUnsettled    = "consumedUnsettled"
	AlertChainCheckUntrusted  = "chain_check_untrusted"
	AlertLowWater             = "low_water"
	AlertIssuerBalanceLow     = "issuer_balance_low"
	AlertPoolDrainUnexplained = "pool_drain_unexplained"
)

// DenyReason is the fuel_denylist reason rule 2 writes.
const DenyReason = "spent_external"

// txidRe is the only txid shape sent to the overlay. Anything else would draw
// a 400 ERR_SHAPE, which says nothing about the transaction.
var txidRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// OverlayClient is the overlay surface rule 4 needs.
type OverlayClient interface {
	// AdmissionStatus is GET /admin/admission/{txid}: the HTTP status, and
	// for a 400 whether its body is a final refusal (retryable:false; never
	// set for any other status). err is set when no usable answer arrived: a
	// transport error, a timeout, or a 404 that is not the overlay's own
	// "no admission on record" body (a proxy, a route not mounted).
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
	recheckBatch int // rule 2's rows per tick (recheckBatch; tests lower it)

	// Pool watch (WithPoolWatch). basket is also where rule 2's canary row
	// comes from; with no basket, rule 2 and the pool watch never run.
	basket                                    string
	poolTarget, lowWaterPercent, denomination uint64

	mu sync.Mutex // serializes Tick and guards the in-process memory below
	// firstUnspent is rule 4's first 404+unspent observation per txid. It is
	// in-process only: a restart forgets it, which only delays a release by
	// one more observation gap and can never cause one.
	firstUnspent map[string]time.Time
	// firstSpent is rule 2's first "spent" reading per outpoint, with the
	// same restart property: forgetting it only delays a spent_external.
	firstSpent map[string]time.Time
	// lastWatch is the pool watch's previous successful snapshot (nil until
	// the first one).
	lastWatch *poolSnapshot
}

// poolSnapshot is what the pool-drain check compares tick to tick.
type poolSnapshot struct {
	available int // proven pool rows listed
	rows      int // reservation rows in the store (every status)
}

// Option configures a Sweeper at New.
type Option func(*Sweeper)

// WithPoolWatch names the pool basket and the §4.8 thresholds: the watch
// alerts when the proven pool is below poolTarget·lowWaterPercent/100, when
// the issuer balance is below 20·denomination·poolTarget, and when the pool
// shrank by more than the keeper's own claims explain. The basket is also
// where rule 2 takes its canary row from, so without this option rule 2
// never acts.
func WithPoolWatch(basket string, poolTarget, lowWaterPercent, denomination uint64) Option {
	return func(s *Sweeper) {
		s.basket, s.poolTarget, s.lowWaterPercent, s.denomination = basket, poolTarget, lowWaterPercent, denomination
	}
}

// New returns a Sweeper. A nil checker means chain.Disabled (rule 2 then
// leaves every row pending); a nil overlay disables rule 4 (warned here and
// on every tick that has rows for it). A nil now means time.Now; a nil logger
// discards. Without WithPoolWatch rule 2 and the pool watch are off (warned
// here). Rule 0 uses each row's own expires_at, which the claim stamped with
// the reserving TTL, so the sweeper needs no TTL of its own.
func New(st *store.Store, src fuel.Source, checker chain.Checker, overlay OverlayClient, now func() time.Time, logger *slog.Logger, opts ...Option) *Sweeper {
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
	s := &Sweeper{
		st: st, src: src, checker: checker, overlay: overlay, now: now, logger: logger,
		recheckBatch: recheckBatch, firstUnspent: map[string]time.Time{}, firstSpent: map[string]time.Time{},
	}
	for _, o := range opts {
		o(s)
	}
	if s.basket == "" {
		logger.Warn("sweeper: no pool basket (WithPoolWatch); rule 2 cannot vet the chain service and never acts, and the §4.8 pool alerts are off")
	}
	return s
}

// Run ticks immediately and then every interval (≤ 0 means 30 s) until ctx
// is done. Each tick is bounded by a timeout, and a panic inside a tick is
// logged instead of killing the process.
func (s *Sweeper) Run(ctx context.Context, every time.Duration) {
	if every <= 0 {
		every = defaultInterval
	}
	s.logger.Info("sweeper: started", "every", every.String(), "rule4", s.overlay != nil, "poolBasket", s.basket)
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

// Tick runs rules 0-4 once, in order, then the pool watch. A failing step is
// logged and the next one still runs; the joined errors are returned.
func (s *Sweeper) Tick(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	rules := []struct {
		name string
		fn   func(context.Context) error
	}{
		{"rule0", s.rule0}, {"rule1", s.rule1}, {"rule2", s.rule2}, {"rule3", s.rule3}, {"rule4", s.rule4},
		{"poolwatch", s.poolWatch},
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

// rule2: released, needs_recheck=1 → chain check. Nothing is read from the
// chain service unless the canary vouches for it this tick (chainTrusted). A
// checker error is never an answer: the row is only touched to the back of
// the queue, so a row whose check keeps failing cannot starve the rows behind
// it. An unspent reading clears the row (and any earlier "spent" reading of
// it). A spent reading is acted on only when an earlier spent reading of the
// same outpoint is at least Rule2ConfirmGap old: the first one is recorded
// and the row touched. WhatsOnChain reports an output it has never indexed
// exactly like a spent one (see package chain), and a spent_external is
// terminal and may deny someone. The confirmed verdict moves the row to
// spent_external; the requester is denied only when that CAS moved the row
// (a concurrent /settle repair wins the race and nobody is denied) and the
// row carries no txid. A txid means the row was released by an eviction or
// by rule 4 after the requester's tx was consumed: the chain spend is most
// likely that very tx having mined anyway, so the keeper alerts (a /settle
// repairs the row) but does not punish the requester.
func (s *Sweeper) rule2(ctx context.Context) error {
	rows, err := s.st.RecheckPending(ctx, s.recheckBatch)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		clear(s.firstSpent) // nothing pending: no remembered reading can matter
		return nil
	}
	if !s.chainTrusted(ctx) {
		return nil
	}
	now := s.now()
	seen := make(map[string]bool, len(rows))
	var (
		errs      []error
		failed    int
		firstFail error
	)
	for i, r := range rows {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			for _, rest := range rows[i:] {
				seen[rest.Outpoint] = true // keep readings of rows not reached
			}
			break
		}
		seen[r.Outpoint] = true
		unspent, err := s.checker.IsUnspent(ctx, r.FuelScript, r.Outpoint)
		if err != nil {
			failed++
			if firstFail == nil {
				firstFail = err
			}
			if terr := s.st.TouchRecheck(ctx, r.Outpoint); terr != nil {
				errs = append(errs, fmt.Errorf("touch %s: %w", r.Outpoint, terr))
			}
			continue
		}
		log := s.logger.With("rule", 2, "outpoint", r.Outpoint, "requester", r.Requester, "txid", r.Txid)
		first, seenSpent := s.firstSpent[r.Outpoint]
		if unspent {
			delete(s.firstSpent, r.Outpoint)
		} else if !seenSpent || now.Sub(first) < Rule2ConfirmGap {
			if !seenSpent {
				s.firstSpent[r.Outpoint] = now
				log.Warn("sweeper: chain reports released fuel spent; first reading recorded, acting only on a second reading",
					"confirmAfter", Rule2ConfirmGap.String())
			}
			if terr := s.st.TouchRecheck(ctx, r.Outpoint); terr != nil {
				errs = append(errs, fmt.Errorf("touch %s: %w", r.Outpoint, terr))
			}
			continue
		}
		moved, err := s.st.SetRechecked(ctx, r.Outpoint, unspent)
		if err != nil {
			errs = append(errs, fmt.Errorf("recheck %s: %w", r.Outpoint, err))
			continue // a confirmed spent reading is kept for the next tick
		}
		delete(s.firstSpent, r.Outpoint)
		switch {
		case !moved:
			log.Info("sweeper: row moved on during the chain check; verdict discarded", "unspent", unspent)
		case unspent:
			log.Info("sweeper: released fuel is unspent on chain; cleared (its last holder may still submit late)")
		case r.Txid != "":
			log.Error("sweeper: fuel released after its tx was consumed (eviction or rule 4) is spent on chain; "+
				"the tx most likely mined anyway, so the requester is not denied; /settle repairs the row",
				"alert", AlertSpentExternal, "firstReading", first.UTC().Format(time.RFC3339))
		case r.FeeScript == "":
			// The draft never reached Commit (a short draft's survivors or a
			// rule-0 release): no signed skeleton was ever handed out, so the
			// requester cannot have spent this fuel. Two "spent" readings here
			// mean the wallet's own funder or an operator moved it.
			log.Error("sweeper: fuel released before any draft was issued is spent on chain; not attributable to the requester",
				"alert", AlertSpentExternal, "firstReading", first.UTC().Format(time.RFC3339))
		default:
			log.Error("sweeper: released fuel was spent outside the keeper", "alert", AlertSpentExternal,
				"firstReading", first.UTC().Format(time.RFC3339))
			if err := s.deny(ctx, r); err != nil {
				log.Error("sweeper: could not deny the requester; deny manually", "alert", AlertSpentExternal, "err", err)
				errs = append(errs, err)
			}
		}
	}
	if failed > 0 {
		s.logger.Warn("sweeper: chain check failed; rows stay pending (moved to the back of the queue)", "rule", 2, "rows", failed, "err", firstFail)
	}
	// Forget readings of rows that left the recheck queue (every pending row
	// was listed when the batch was not full) or that went unvisited for too
	// long; forgetting only ever delays a verdict.
	complete := len(rows) < s.recheckBatch
	for op, at := range s.firstSpent {
		if !seen[op] && (complete || now.Sub(at) > spentMemoryTTL) {
			delete(s.firstSpent, op)
		}
	}
	return errors.Join(errs...)
}

// chainTrusted is rule 2's canary. Before any verdict is taken from the chain
// service, it must call a proven pool row, one the wallet lists as spendable
// right now, unspent. No pool row (or no basket, or a failed listing) skips
// rule 2 for the tick. A checker error, or a "spent" answer for a row the
// wallet still holds as spendable, means the service cannot be trusted this
// tick (not indexed yet, the wrong network, an outage): alert
// chain_check_untrusted and skip. A disabled checker skips quietly (main
// warned at startup).
func (s *Sweeper) chainTrusted(ctx context.Context) bool {
	log := s.logger.With("rule", 2)
	if s.basket == "" {
		log.Warn("sweeper: no pool basket configured; rule 2 skipped (the chain service cannot be vetted)")
		return false
	}
	pool, err := s.src.ListProven(ctx, s.basket, 1, 0)
	if err != nil {
		log.Warn("sweeper: cannot list a pool row for the chain canary; rule 2 skipped this tick", "err", err)
		return false
	}
	if len(pool) == 0 {
		log.Info("sweeper: no proven pool row to vet the chain service with; rule 2 skipped this tick", "basket", s.basket)
		return false
	}
	canary := pool[0]
	unspent, err := s.checker.IsUnspent(ctx, hex.EncodeToString(canary.LockingScript), canary.Outpoint)
	switch {
	case errors.Is(err, chain.ErrDisabled):
		log.Debug("sweeper: chain check disabled; rule 2 skipped")
		return false
	case err != nil:
		log.Error("sweeper: chain service failed on a proven pool row; rule 2 skipped this tick",
			"alert", AlertChainCheckUntrusted, "canary", canary.Outpoint, "err", err)
		return false
	case unspent:
		return true
	}
	// "Spent" for a row the wallet just listed: unless the wallet itself spent
	// it in the meantime, the chain service is answering wrongly.
	if still, serr := s.src.StillSpendable(ctx, canary.Outpoint); serr == nil && !still {
		log.Info("sweeper: the chain canary was spent by the wallet meanwhile; rule 2 skipped this tick", "canary", canary.Outpoint)
		return false
	}
	log.Error("sweeper: chain service reports a spendable pool row as spent; rule 2 skipped this tick",
		"alert", AlertChainCheckUntrusted, "canary", canary.Outpoint)
	return false
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

// poolWatch is the §4.8 alerting pass, run after the rules. Each alert is
// computed from what could be read; a failed read skips only the alerts that
// need it (and is returned). The drain check compares cumulative levels, so a
// skipped tick only widens the window of the next comparison.
func (s *Sweeper) poolWatch(ctx context.Context) error {
	if s.basket == "" {
		return nil
	}
	log := s.logger.With("check", "poolwatch", "basket", s.basket)
	var errs []error

	available, rows := -1, -1
	if pool, err := s.src.ListProven(ctx, s.basket, poolWatchLimit, 0); err != nil {
		errs = append(errs, fmt.Errorf("list pool: %w", err))
	} else {
		available = len(pool)
		if low := s.poolTarget * s.lowWaterPercent / 100; uint64(available) < low {
			log.Error("sweeper: proven fuel is below the low-water mark", "alert", AlertLowWater,
				"available", available, "lowWater", low, "poolTarget", s.poolTarget)
		}
	}
	if counts, _, _, _, err := s.st.Counts(ctx); err != nil {
		errs = append(errs, fmt.Errorf("counts: %w", err))
	} else {
		rows = 0
		for _, n := range counts {
			rows += n
		}
	}
	if bal, err := s.src.BalanceSats(ctx); err != nil {
		errs = append(errs, fmt.Errorf("balance: %w", err))
	} else if floor := balanceFloor(s.denomination, s.poolTarget); bal < floor {
		log.Error("sweeper: issuer balance is below 20 × D × pool target", "alert", AlertIssuerBalanceLow,
			"issuerBsvSats", bal, "floor", floor)
	}

	if available >= 0 && rows >= 0 {
		// The keeper takes fuel out of the pool only by claiming it: every
		// claim inserts a reservation row (outpoints are never re-claimed)
		// and detaches that output at claim time, well before it is consumed
		// or settled. So the drop the keeper explains is the growth in rows;
		// anything beyond it left the pool some other way.
		if prev := s.lastWatch; prev != nil {
			drop, explained := prev.available-available, rows-prev.rows
			if drop > 0 && drop > explained {
				log.Error("sweeper: the pool shrank by more than the keeper's own claims explain", "alert", AlertPoolDrainUnexplained,
					"available", available, "previous", prev.available, "drop", drop, "claimed", explained)
			}
		}
		s.lastWatch = &poolSnapshot{available: available, rows: rows}
	}
	return errors.Join(errs...)
}

// balanceFloor is 20·d·target, saturating instead of wrapping.
func balanceFloor(d, target uint64) uint64 {
	if d == 0 || target == 0 {
		return 0
	}
	if d > math.MaxUint64/20/target {
		return math.MaxUint64
	}
	return 20 * d * target
}

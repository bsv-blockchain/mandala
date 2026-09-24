// Package httpapi is fuelKeeper's overlay-facing HTTP surface (spec §3.1,
// §4.5, §4.6, §4.8): the internal API the TS/Go overlay engines call to draft
// fuel pairs, apply the reservation state machine at submit time, settle a
// broadcast tx, watch pool health and manage the deny list.
//
// Every route except GET /health requires the shared secret X-Fuel-Key,
// compared to Deps.APIKey with crypto/subtle.ConstantTimeCompare so a wrong
// guess costs no more time than a right one. A missing or wrong key is
// answered 401 ERR_UNAUTHORIZED before the body is even read.
//
// This package owns no business logic: /draft delegates to a Drafter
// (internal/draft), /consume and /release to the reservation Store
// (internal/store), /settle to a Settler the caller supplies (Task 8's
// internal/settle, kept out of this package's import graph behind a small
// interface so the two can be implemented independently), and /health reads
// Store.Counts plus the fuel Source. Every handler's job is shape validation,
// status-code mapping and JSON framing only.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/draft"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
)

// maxBodyBytes bounds every request body (1 MiB).
const maxBodyBytes = 1 << 20

// requestTimeout bounds every request end to end.
const requestTimeout = 15 * time.Second

// timeoutBody is the body http.TimeoutHandler sends if a handler overruns
// requestTimeout. It is written directly (TimeoutHandler does not run our
// writeJSON), so it is pre-serialized.
const timeoutBody = `{"status":"error","code":"ERR_TIMEOUT","retryable":true,"description":"request timed out"}`

// Deps are the collaborators New wires into the mux. Drafter and Settler are
// narrow interfaces so this package depends on neither internal/draft's full
// surface nor Task 8's settle/sweeper/chain packages directly.
type Deps struct {
	APIKey string

	Drafter interface {
		Draft(ctx context.Context, req draft.Request) (*draft.Response, *draft.Refusal, error)
	}
	Store *store.Store
	Settler interface {
		Settle(ctx context.Context, txid string, beef []byte) (int, error)
	}
	Source fuel.Source
	Cfg    config.Config
	Logger *slog.Logger
}

// server holds the wired dependencies for the route handlers.
type server struct {
	deps Deps
	log  *slog.Logger
}

// New returns the overlay-facing HTTP handler (spec §3.1, §4.5, §4.6, §4.8).
func New(deps Deps) http.Handler {
	log := deps.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	s := &server{deps: deps, log: log}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /draft", s.guard(s.handleDraft))
	mux.HandleFunc("POST /consume", s.guard(s.handleConsume))
	mux.HandleFunc("POST /release", s.guard(s.handleRelease))
	mux.HandleFunc("POST /settle", s.guard(s.handleSettle))
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("DELETE /deny/{requester}", s.guard(s.handleDeny))

	return http.TimeoutHandler(mux, requestTimeout, timeoutBody)
}

// guard requires header X-Fuel-Key to equal Deps.APIKey, in constant time.
func (s *server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Fuel-Key")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.deps.APIKey)) != 1 {
			writeErr(w, http.StatusUnauthorized, "ERR_UNAUTHORIZED", false, "missing or invalid X-Fuel-Key")
			return
		}
		next(w, r)
	}
}

// ---------------------------------------------------------------------------
// JSON framing

// errBody is the uniform refusal/error shape used by every route.
type errBody struct {
	Status      string `json:"status"`
	Code        string `json:"code"`
	Retryable   bool   `json:"retryable"`
	Description string `json:"description"`
}

func writeErr(w http.ResponseWriter, status int, code string, retryable bool, desc string) {
	writeJSON(w, status, errBody{Status: "error", Code: code, Retryable: retryable, Description: desc})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeJSON bounds the body to maxBodyBytes and decodes it into v.
// DisallowUnknownFields is deliberately not set: the overlay may add fields
// this version does not know about yet. Any decode error (including an empty
// body or a body over the limit) is a 400 ERR_SHAPE; the caller should return
// immediately when this reports false.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "malformed JSON body: "+err.Error())
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// POST /draft (spec §3.1)

func (s *server) handleDraft(w http.ResponseWriter, r *http.Request) {
	var req draft.Request
	if !decodeJSON(w, r, &req) {
		return
	}
	resp, refusal, err := s.deps.Drafter.Draft(r.Context(), req)
	if err != nil {
		s.log.Error("httpapi: draft infra error", "err", err)
		writeErr(w, http.StatusServiceUnavailable, "ERR_FUEL_UNAVAILABLE", true, "fuel keeper temporarily unavailable")
		return
	}
	if refusal != nil {
		writeErr(w, refusal.HTTP, refusal.Code, refusal.Retryable, refusal.Description)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ---------------------------------------------------------------------------
// POST /consume (spec §4.5)

type consumePair struct {
	Outpoint  string `json:"outpoint"`
	RequestID string `json:"requestId"`
}

type consumeReq struct {
	Txid  string        `json:"txid"`
	Pairs []consumePair `json:"pairs"`
}

type consumeResp struct {
	OK       bool   `json:"ok"`
	Outpoint string `json:"outpoint,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

func (s *server) handleConsume(w http.ResponseWriter, r *http.Request) {
	var req consumeReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Txid == "" || len(req.Pairs) == 0 {
		writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "txid and a non-empty pairs array are required")
		return
	}
	items := make([]store.ConsumeItem, len(req.Pairs))
	for i, p := range req.Pairs {
		if p.Outpoint == "" || p.RequestID == "" {
			writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "every pair needs outpoint and requestId")
			return
		}
		items[i] = store.ConsumeItem{Outpoint: p.Outpoint, RequestID: p.RequestID}
	}
	refusal, err := s.deps.Store.Consume(r.Context(), req.Txid, items)
	if err != nil {
		s.log.Error("httpapi: consume store error", "err", err, "txid", req.Txid)
		writeErr(w, http.StatusServiceUnavailable, "ERR_UNAVAILABLE", true, "store temporarily unavailable")
		return
	}
	if refusal != nil {
		writeJSON(w, http.StatusOK, consumeResp{OK: false, Outpoint: refusal.Outpoint, Reason: refusal.Reason})
		return
	}
	writeJSON(w, http.StatusOK, consumeResp{OK: true})
}

// ---------------------------------------------------------------------------
// POST /release (spec §4.5)

type releaseReq struct {
	RequestID string   `json:"requestId"`
	Txid      string   `json:"txid"`
	Outpoints []string `json:"outpoints"`
}

type releaseResp struct {
	OK       bool  `json:"ok"`
	Affected int64 `json:"affected"`
}

func (s *server) handleRelease(w http.ResponseWriter, r *http.Request) {
	var req releaseReq
	if !decodeJSON(w, r, &req) {
		return
	}
	byRequest := req.RequestID != ""
	byEviction := req.Txid != "" || len(req.Outpoints) > 0
	switch {
	case byRequest && byEviction:
		writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "requestId and {txid, outpoints} are mutually exclusive")
		return
	case !byRequest && !byEviction:
		writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "either requestId or {txid, outpoints} is required")
		return
	case byRequest:
		affected, err := s.deps.Store.ReleaseRequest(r.Context(), req.RequestID)
		if err != nil {
			s.log.Error("httpapi: release store error", "err", err, "requestId", req.RequestID)
			writeErr(w, http.StatusServiceUnavailable, "ERR_UNAVAILABLE", true, "store temporarily unavailable")
			return
		}
		writeJSON(w, http.StatusOK, releaseResp{OK: true, Affected: affected})
		return
	default: // byEviction
		if req.Txid == "" || len(req.Outpoints) == 0 {
			writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "eviction release needs both txid and outpoints")
			return
		}
		affected, err := s.deps.Store.ReleaseEvicted(r.Context(), req.Txid, req.Outpoints)
		if err != nil {
			s.log.Error("httpapi: release store error", "err", err, "txid", req.Txid)
			writeErr(w, http.StatusServiceUnavailable, "ERR_UNAVAILABLE", true, "store temporarily unavailable")
			return
		}
		writeJSON(w, http.StatusOK, releaseResp{OK: true, Affected: affected})
	}
}

// ---------------------------------------------------------------------------
// POST /settle (spec §4.6)

type settleReq struct {
	Txid       string `json:"txid"`
	AtomicBeef string `json:"atomicBeef"`
}

type settleResp struct {
	Settled int `json:"settled"`
}

func (s *server) handleSettle(w http.ResponseWriter, r *http.Request) {
	var req settleReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Txid == "" || req.AtomicBeef == "" {
		writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "txid and atomicBeef are required")
		return
	}
	beef, err := hex.DecodeString(req.AtomicBeef)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "ERR_SHAPE", false, "atomicBeef must be hex")
		return
	}
	settled, err := s.deps.Settler.Settle(r.Context(), req.Txid, beef)
	if err != nil {
		s.log.Error("httpapi: settle error", "err", err, "txid", req.Txid)
		writeErr(w, http.StatusServiceUnavailable, "ERR_UNAVAILABLE", true, "settle temporarily unavailable")
		return
	}
	writeJSON(w, http.StatusOK, settleResp{Settled: settled})
}

// ---------------------------------------------------------------------------
// GET /health (spec §4.8) — no X-Fuel-Key required.

type healthPool struct {
	Available         int `json:"available"`
	Reserving         int `json:"reserving"`
	Reserved          int `json:"reserved"`
	ConsumedUnsettled int `json:"consumedUnsettled"`
	Released          int `json:"released"`
	RecheckPending    int `json:"recheckPending"`
	Dropped           int `json:"dropped"`
	SpentExternal     int `json:"spentExternal"`
}

type healthResp struct {
	Pool          healthPool `json:"pool"`
	IssuerBsvSats *uint64    `json:"issuerBsvSats"`
	LowWater      uint64     `json:"lowWater"`
	Denomination  uint64     `json:"denomination"`
	ProvenFuel    int        `json:"provenFuel"`
	Denied        int        `json:"denied"`
	Errors        []string   `json:"errors,omitempty"`
}

// handleHealth never fails the request over a wallet or listing error: it
// degrades to null/zero fields and reports the failure in errors, so a
// flaky wallet call cannot take the health probe itself down.
func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var errs []string

	counts, recheckPending, consumedUnsettled, denied, err := s.deps.Store.Counts(ctx)
	if err != nil {
		s.log.Error("httpapi: health store counts", "err", err)
		errs = append(errs, "store counts: "+err.Error())
		counts = map[store.Status]int{}
	}

	available := 0
	if rows, err := s.deps.Source.ListProven(ctx, s.deps.Cfg.PoolBasket, 10000); err != nil {
		s.log.Error("httpapi: health list proven", "err", err)
		errs = append(errs, "list proven fuel: "+err.Error())
	} else {
		available = len(rows)
	}

	var issuerBsvSats *uint64
	if bal, err := s.deps.Source.BalanceSats(ctx); err != nil {
		s.log.Error("httpapi: health balance", "err", err)
		errs = append(errs, "issuer balance: "+err.Error())
	} else {
		issuerBsvSats = &bal
	}

	body := healthResp{
		Pool: healthPool{
			Available:         available,
			Reserving:         counts[store.StatusReserving],
			Reserved:          counts[store.StatusReserved],
			ConsumedUnsettled: consumedUnsettled,
			Released:          counts[store.StatusReleased],
			RecheckPending:    recheckPending,
			Dropped:           counts[store.StatusDropped],
			SpentExternal:     counts[store.StatusSpentExternal],
		},
		IssuerBsvSats: issuerBsvSats,
		LowWater:      s.deps.Cfg.PoolTarget * s.deps.Cfg.LowWaterPercent / 100,
		Denomination:  s.deps.Cfg.Denomination,
		ProvenFuel:    available,
		Denied:        denied,
		Errors:        errs,
	}
	writeJSON(w, http.StatusOK, body)
}

// ---------------------------------------------------------------------------
// DELETE /deny/{requester} (spec §4.8)

type denyResp struct {
	Removed bool `json:"removed"`
}

// handleDeny lowercases the path value before Undeny: the drafter keys the
// deny list by the requester's canonical lowercase compressed-DER hex, and an
// operator-pasted key may carry any case.
func (s *server) handleDeny(w http.ResponseWriter, r *http.Request) {
	requester := strings.ToLower(r.PathValue("requester"))
	removed, err := s.deps.Store.Undeny(r.Context(), requester)
	if err != nil {
		s.log.Error("httpapi: deny store error", "err", err, "requester", requester)
		writeErr(w, http.StatusServiceUnavailable, "ERR_UNAVAILABLE", true, "store temporarily unavailable")
		return
	}
	writeJSON(w, http.StatusOK, denyResp{Removed: removed})
}

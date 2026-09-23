// Package store is fuelKeeper's reservation database (spec §4.4, §4.5): the
// fuel_reservations compare-and-set state machine, the all-or-nothing
// /consume batch, the per-requester quota gate (§4.3 step 2) and the deny
// list (§4.8).
//
// One query set serves SQLite and Postgres: every statement is written once
// with `?` placeholders and rebound to `$1..$n` by q when the driver is
// Postgres. Time comes only from the clock injected at Open (unix seconds);
// SQL now() is never used, so tests and both engines agree on every
// timestamp.
//
// Every transition is a CAS: the UPDATE carries the expected current status
// (and the owning request or txid) in its WHERE clause, so a lost race
// affects zero rows instead of overwriting another actor's state.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // registers "pgx"
	_ "github.com/mattn/go-sqlite3"    // registers "sqlite3" (CGO)
)

// Driver names accepted by Open (the FK_DB_DRIVER values).
const (
	DriverSQLite   = "sqlite"
	DriverPostgres = "postgres"
)

// Status is a fuel_reservations.status value (spec §4.5).
type Status string

const (
	StatusReserving     Status = "reserving"
	StatusReserved      Status = "reserved"
	StatusConsumed      Status = "consumed"
	StatusReleased      Status = "released"
	StatusDropped       Status = "dropped"
	StatusSpentExternal Status = "spent_external"
)

var allStatuses = []Status{StatusReserving, StatusReserved, StatusConsumed, StatusReleased, StatusDropped, StatusSpentExternal}

// QuotaVerdict is the outcome of BeginRequest (spec §4.3 step 2).
type QuotaVerdict string

const (
	VerdictOK          QuotaVerdict = "ok"
	VerdictNonceUsed   QuotaVerdict = "nonce_used"
	VerdictQuota       QuotaVerdict = "quota"
	VerdictUnavailable QuotaVerdict = "unavailable"
)

// Consume refusal reasons. Byte-exact: they travel verbatim to the overlay.
const (
	ReasonConsumedByOther = "consumed by another txid"
	ReasonReservedByOther = "reserved by another request"
	ReasonUnknown         = "unknown"
)

// ErrCommitConflict means at least one pair was no longer `reserving` for the
// committing request (the sweeper or another request got there first). The
// whole commit was rolled back.
var ErrCommitConflict = errors.New("store: commit conflict: a pair is no longer reserving for this request")

// Store is the reservation database handle. Safe for concurrent use.
type Store struct {
	db     *sql.DB
	driver string
	now    func() time.Time
}

// Reservation is one fuel_reservations row.
type Reservation struct {
	Outpoint         string
	Satoshis         uint64
	FuelScript       string
	FuelBeef         string
	DerivationPrefix string
	DerivationSuffix string
	RequestID        string
	Requester        string
	AssetID          string
	PairIndex        int
	FeeScript        string
	KeyID            string
	FeeAmount        string
	Status           Status
	NeedsRecheck     bool
	Txid             string
	ExpiresAt        int64
	SettledAt        *int64
	CreatedAt        int64
	UpdatedAt        int64
}

// Quotas are the per-requester and global draft limits (spec §4.3 step 2).
// A limit ≤ 0 refuses every request (fail closed).
type Quotas struct {
	MaxOutstanding int
	DailyPairs     int
	PairsPerMinute int
}

// Candidate is a fuel output that may be claimed for a draft.
type Candidate struct {
	Outpoint         string
	Satoshis         uint64
	FuelScript       string
	FuelBeef         string
	DerivationPrefix string
	DerivationSuffix string
}

// CommitPair carries the per-pair values written at commit (§4.3 step 10).
type CommitPair struct {
	Outpoint  string
	FeeScript string
	KeyID     string
	FeeAmount string
}

// ConsumeItem is one outpoint of a /consume batch with the request the
// submitter claims to hold it under.
type ConsumeItem struct {
	Outpoint  string
	RequestID string
}

// ConsumeRefusal names the first refused outpoint (in caller order) and why.
type ConsumeRefusal struct {
	Outpoint string
	Reason   string
}

// Open connects, applies the schema (idempotent) and returns the store.
// driver is "sqlite" (dsn is a file path) or "postgres" (dsn is a pgx URL).
func Open(driver, dsn string, now func() time.Time) (*Store, error) {
	if now == nil {
		now = time.Now
	}
	var sqlDriver, sqlDSN string
	switch driver {
	case DriverSQLite:
		path := strings.TrimPrefix(dsn, "file:")
		if path == "" || strings.ContainsAny(path, "?#") {
			return nil, fmt.Errorf("store: sqlite dsn must be a plain file path, got %q", dsn)
		}
		sqlDriver = "sqlite3"
		// _txlock=immediate: every BeginTx is BEGIN IMMEDIATE, which takes the
		// write lock up front; this is what serializes BeginRequest and
		// Consume on SQLite (also across processes sharing the file).
		sqlDSN = "file:" + path + "?_txlock=immediate&_busy_timeout=5000&_journal_mode=WAL"
	case DriverPostgres:
		if dsn == "" {
			return nil, errors.New("store: empty postgres dsn")
		}
		sqlDriver, sqlDSN = "pgx", dsn
	default:
		return nil, fmt.Errorf("store: unsupported driver %q (want %q or %q)", driver, DriverSQLite, DriverPostgres)
	}
	db, err := sql.Open(sqlDriver, sqlDSN)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}
	if driver == DriverSQLite {
		// One connection: SQLite has one writer anyway, and a single
		// connection makes in-process serialization exact.
		db.SetMaxOpenConns(1)
	}
	s := &Store{db: db, driver: driver, now: now}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the underlying database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate(ctx context.Context) error {
	schema := schemaSQLite
	if s.driver == DriverPostgres {
		schema = schemaPostgres
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: migrate: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if s.driver == DriverPostgres {
		// Two processes starting at once would race CREATE ... IF NOT EXISTS
		// on the catalog; DDL is transactional in Postgres, so serialize it.
		if _, err := tx.ExecContext(ctx, s.q(`SELECT pg_advisory_xact_lock(hashtext(?))`), "fuelkeeper.store.migrate"); err != nil {
			return fmt.Errorf("store: migrate lock: %w", err)
		}
	}
	for _, stmt := range strings.Split(schema, ";") {
		if stmt = strings.TrimSpace(stmt); stmt == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("store: migrate: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: migrate commit: %w", err)
	}
	return nil
}

// q rebinds `?` placeholders to `$1..$n` for Postgres; SQLite takes the query
// unchanged. A `?` inside a single-quoted SQL literal is left alone (an
// escaped quote, written as two quotes, toggles the state twice and stays
// balanced).
func (s *Store) q(query string) string {
	if s.driver != DriverPostgres {
		return query
	}
	return rebindDollar(query)
}

func rebindDollar(query string) string {
	var b strings.Builder
	b.Grow(len(query) + 16)
	n, inQuote := 0, false
	for i := 0; i < len(query); i++ {
		c := query[i]
		switch {
		case c == '\'':
			inQuote = !inQuote
			b.WriteByte(c)
		case c == '?' && !inQuote:
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// forUpdate is the row-lock suffix for reads inside a Postgres write
// transaction. SQLite has no FOR UPDATE; its BEGIN IMMEDIATE already holds
// the database write lock.
func (s *Store) forUpdate() string {
	if s.driver == DriverPostgres {
		return " FOR UPDATE"
	}
	return ""
}

func (s *Store) unix() int64 { return s.now().Unix() }

func satsToDB(v uint64) (int64, error) {
	if v > math.MaxInt64 {
		return 0, fmt.Errorf("store: satoshis %d exceeds int64", v)
	}
	return int64(v), nil
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

const reservationCols = `outpoint, satoshis, fuel_script, fuel_beef, derivation_prefix, derivation_suffix,
  request_id, requester, asset_id, pair_index, fee_script, key_id, fee_amount,
  status, needs_recheck, txid, expires_at, settled_at, created_at, updated_at`

func scanReservations(rows *sql.Rows) ([]Reservation, error) {
	defer rows.Close()
	var out []Reservation
	for rows.Next() {
		var (
			r                                 Reservation
			sats                              int64
			reqID, requester, assetID         sql.NullString
			feeScript, keyID, feeAmount, txid sql.NullString
			status                            string
			needsRecheck                      int64
			settledAt                         sql.NullInt64
		)
		if err := rows.Scan(&r.Outpoint, &sats, &r.FuelScript, &r.FuelBeef, &r.DerivationPrefix, &r.DerivationSuffix,
			&reqID, &requester, &assetID, &r.PairIndex, &feeScript, &keyID, &feeAmount,
			&status, &needsRecheck, &txid, &r.ExpiresAt, &settledAt, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("store: scan reservation: %w", err)
		}
		if sats < 0 {
			return nil, fmt.Errorf("store: negative satoshis on %s", r.Outpoint)
		}
		r.Satoshis = uint64(sats)
		r.RequestID, r.Requester, r.AssetID = reqID.String, requester.String, assetID.String
		r.FeeScript, r.KeyID, r.FeeAmount, r.Txid = feeScript.String, keyID.String, feeAmount.String, txid.String
		r.Status = Status(status)
		r.NeedsRecheck = needsRecheck != 0
		if settledAt.Valid {
			v := settledAt.Int64
			r.SettledAt = &v
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: rows: %w", err)
	}
	return out, nil
}

func (s *Store) selectReservations(ctx context.Context, where string, args ...any) ([]Reservation, error) {
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT `+reservationCols+` FROM fuel_reservations WHERE `+where), args...)
	if err != nil {
		return nil, fmt.Errorf("store: query: %w", err)
	}
	return scanReservations(rows)
}

func (s *Store) exec(ctx context.Context, query string, args ...any) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.q(query), args...)
	if err != nil {
		return 0, fmt.Errorf("store: exec: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: rows affected: %w", err)
	}
	return n, nil
}

// ---------------------------------------------------------------------------
// §4.3 step 2: nonce + quota gate

// BeginRequest records the request nonce and applies the quotas in one
// transaction serialized per requester (SQLite: BEGIN IMMEDIATE via the DSN;
// Postgres: pg_advisory_xact_lock(hashtext(requester))). Any verdict other
// than ok rolls back, so the nonce is only kept for requests that proceed.
func (s *Store) BeginRequest(ctx context.Context, nonce, requester string, ts int64, q Quotas) (QuotaVerdict, error) {
	if nonce == "" || requester == "" {
		return "", errors.New("store: BeginRequest needs nonce and requester")
	}
	now := s.unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("store: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if s.driver == DriverPostgres {
		if _, err := tx.ExecContext(ctx, s.q(`SELECT pg_advisory_xact_lock(hashtext(?))`), requester); err != nil {
			return "", fmt.Errorf("store: requester lock: %w", err)
		}
	}
	res, err := tx.ExecContext(ctx, s.q(`INSERT INTO fuel_requests(nonce, requester, ts, created_at) VALUES(?, ?, ?, ?)
  ON CONFLICT(nonce) DO NOTHING`), nonce, requester, ts, now)
	if err != nil {
		return "", fmt.Errorf("store: insert nonce: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return "", fmt.Errorf("store: rows affected: %w", err)
	} else if n == 0 {
		return VerdictNonceUsed, nil
	}
	count := func(query string, args ...any) (int, error) {
		var c int
		if err := tx.QueryRowContext(ctx, s.q(query), args...).Scan(&c); err != nil {
			return 0, fmt.Errorf("store: quota count: %w", err)
		}
		return c, nil
	}
	outstanding, err := count(`SELECT COUNT(DISTINCT request_id) FROM fuel_reservations
  WHERE requester=? AND status='reserved' AND expires_at>?`, requester, now)
	if err != nil {
		return "", err
	}
	if outstanding >= q.MaxOutstanding {
		return VerdictQuota, nil
	}
	daily, err := count(`SELECT COUNT(*) FROM fuel_reservations WHERE requester=? AND created_at>?`, requester, now-86400)
	if err != nil {
		return "", err
	}
	if daily >= q.DailyPairs {
		return VerdictQuota, nil
	}
	perMinute, err := count(`SELECT COUNT(*) FROM fuel_reservations WHERE created_at>?`, now-60)
	if err != nil {
		return "", err
	}
	if perMinute >= q.PairsPerMinute {
		return VerdictUnavailable, nil
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("store: commit: %w", err)
	}
	return VerdictOK, nil
}

// ---------------------------------------------------------------------------
// §4.3 steps 4-10: candidates, claim, drop, release, commit

// ReleasedCandidates lists re-draftable rows: released with needs_recheck=0,
// oldest first.
func (s *Store) ReleasedCandidates(ctx context.Context, limit int) ([]Candidate, error) {
	if limit <= 0 { // Postgres rejects a negative LIMIT; SQLite reads it as "all"
		return nil, nil
	}
	rows, err := s.selectReservations(ctx, `status='released' AND needs_recheck=0 ORDER BY updated_at, outpoint LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	out := make([]Candidate, 0, len(rows))
	for _, r := range rows {
		out = append(out, Candidate{Outpoint: r.Outpoint, Satoshis: r.Satoshis, FuelScript: r.FuelScript,
			FuelBeef: r.FuelBeef, DerivationPrefix: r.DerivationPrefix, DerivationSuffix: r.DerivationSuffix})
	}
	return out, nil
}

// claimSQL is one statement for both claim paths. A new outpoint is inserted
// as reserving. An existing row is taken only when it is released with
// needs_recheck=0 (the DO UPDATE ... WHERE); in every other state the WHERE
// fails and both engines report 0 rows affected. On the update path
// fuel_script/satoshis/fuel_beef/derivation_* keep the stored values (the row
// already holds the proven BEEF from its first claim; a released row is no
// longer in the toolbox basket). Everything owned by the previous holder is
// reset: txid, fee_*, settled_at, needs_recheck. created_at is set to the claim
// time so the pair counts toward the new requester's daily and the global
// per-minute quota (otherwise re-drafted rows would be invisible to both).
const claimSQL = `INSERT INTO fuel_reservations
  (outpoint, satoshis, fuel_script, fuel_beef, derivation_prefix, derivation_suffix,
   request_id, requester, asset_id, pair_index, status, needs_recheck, expires_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving', 0, ?, ?, ?)
  ON CONFLICT(outpoint) DO UPDATE SET status='reserving', request_id=excluded.request_id,
    requester=excluded.requester, asset_id=excluded.asset_id, pair_index=excluded.pair_index,
    expires_at=excluded.expires_at, created_at=excluded.created_at, updated_at=excluded.updated_at,
    txid=NULL, fee_script=NULL, key_id=NULL, fee_amount=NULL, settled_at=NULL, needs_recheck=0
  WHERE fuel_reservations.status='released' AND fuel_reservations.needs_recheck=0`

// Claim atomically takes c for requestID (§4.3 step 5): true when this call
// now holds the row as reserving, false when another holder has it (or it is
// dropped/spent_external/awaiting recheck). Committed on its own.
func (s *Store) Claim(ctx context.Context, c Candidate, requestID, requester, assetID string, pairIndex int, reservingTTL int64) (bool, error) {
	if c.Outpoint == "" || requestID == "" {
		return false, errors.New("store: Claim needs outpoint and requestID")
	}
	sats, err := satsToDB(c.Satoshis)
	if err != nil {
		return false, err
	}
	now := s.unix()
	n, err := s.exec(ctx, claimSQL, c.Outpoint, sats, c.FuelScript, c.FuelBeef, c.DerivationPrefix, c.DerivationSuffix,
		requestID, requester, assetID, pairIndex, now+reservingTTL, now, now)
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// Drop marks a row this request holds as reserving → dropped (terminal; the
// funder took it between detach and verify). No-op if the CAS misses.
func (s *Store) Drop(ctx context.Context, outpoint, requestID string) error {
	_, err := s.exec(ctx, `UPDATE fuel_reservations SET status='dropped', updated_at=?
  WHERE outpoint=? AND request_id=? AND status='reserving'`, s.unix(), outpoint, requestID)
	return err
}

// ReleaseReserving moves this request's reserving rows → released with the
// given needs_recheck flag.
func (s *Store) ReleaseReserving(ctx context.Context, requestID string, needsRecheck bool) (int64, error) {
	return s.exec(ctx, `UPDATE fuel_reservations SET status='released', needs_recheck=?, updated_at=?
  WHERE request_id=? AND status='reserving'`, b2i(needsRecheck), s.unix(), requestID)
}

// Commit moves every pair reserving → reserved for requestID in one
// transaction (§4.3 step 10). If any row misses the CAS, nothing changes and
// ErrCommitConflict is returned.
func (s *Store) Commit(ctx context.Context, requestID string, pairs []CommitPair, ttl int64) (int64, error) {
	if requestID == "" {
		return 0, errors.New("store: Commit needs requestID")
	}
	if len(pairs) == 0 {
		return 0, nil
	}
	now := s.unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	// Same global lock order as Consume (sorted outpoints): no Postgres deadlock.
	sorted := append([]CommitPair(nil), pairs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Outpoint < sorted[j].Outpoint })
	stmt := s.q(`UPDATE fuel_reservations SET status='reserved', fee_script=?, key_id=?, fee_amount=?, expires_at=?, updated_at=?
  WHERE outpoint=? AND request_id=? AND status='reserving'`)
	for _, p := range sorted {
		res, err := tx.ExecContext(ctx, stmt, p.FeeScript, p.KeyID, p.FeeAmount, now+ttl, now, p.Outpoint, requestID)
		if err != nil {
			return 0, fmt.Errorf("store: commit %s: %w", p.Outpoint, err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("store: rows affected: %w", err)
		}
		if n != 1 {
			return 0, ErrCommitConflict
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit: %w", err)
	}
	return int64(len(pairs)), nil
}

// ---------------------------------------------------------------------------
// overlay-facing: consume, release

type rowState struct {
	found        bool
	status       Status
	requestID    string
	txid         string
	needsRecheck bool
}

// decideConsume is the §4.5 consume table for one row. It returns write=true
// when the row must move to consumed(txid), or a non-empty refusal reason.
// write=false with no reason is an idempotent ok (already consumed by txid).
func decideConsume(st rowState, txid, requestID string) (write bool, reason string) {
	if !st.found {
		return false, ReasonUnknown
	}
	switch st.status {
	case StatusConsumed:
		if st.txid == txid {
			return false, ""
		}
		return false, ReasonConsumedByOther
	case StatusReserved:
		if st.requestID == requestID {
			return true, ""
		}
		return false, ReasonReservedByOther
	case StatusReleased:
		// Late submit of a released row that has not been re-drafted: only its
		// last holder, and only once the chain recheck cleared it.
		if !st.needsRecheck && st.requestID == requestID {
			return true, ""
		}
		return false, ReasonUnknown
	default: // reserving, dropped, spent_external, anything unexpected
		return false, ReasonUnknown
	}
}

// Consume applies the batch all-or-nothing in one transaction (§4.5
// POST /consume). A nil refusal means every row is now consumed(txid). Any
// refusal rolls the whole batch back and names the first refused outpoint in
// caller order; the error is nil in that case.
//
// Rows are locked in sorted outpoint order before any decision (Postgres
// SELECT ... FOR UPDATE; SQLite already holds the write lock from BEGIN
// IMMEDIATE). Commit and ReleaseEvicted use the same order, so overlapping
// multi-row transactions cannot deadlock each other.
func (s *Store) Consume(ctx context.Context, txid string, items []ConsumeItem) (*ConsumeRefusal, error) {
	if txid == "" {
		return nil, errors.New("store: Consume needs txid")
	}
	if len(items) == 0 {
		return nil, nil
	}
	now := s.unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("store: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	order := make([]string, 0, len(items))
	states := make(map[string]*rowState, len(items))
	for _, it := range items {
		if _, ok := states[it.Outpoint]; !ok {
			states[it.Outpoint] = &rowState{}
			order = append(order, it.Outpoint)
		}
	}
	sort.Strings(order)
	read := s.q(`SELECT status, request_id, txid, needs_recheck FROM fuel_reservations WHERE outpoint=?` + s.forUpdate())
	for _, op := range order {
		var (
			status         string
			reqID, rowTxid sql.NullString
			needsRecheck   int64
		)
		err := tx.QueryRowContext(ctx, read, op).Scan(&status, &reqID, &rowTxid, &needsRecheck)
		if errors.Is(err, sql.ErrNoRows) {
			continue // found=false → unknown
		}
		if err != nil {
			return nil, fmt.Errorf("store: consume read %s: %w", op, err)
		}
		*states[op] = rowState{found: true, status: Status(status), requestID: reqID.String, txid: rowTxid.String, needsRecheck: needsRecheck != 0}
	}

	write := s.q(`UPDATE fuel_reservations SET status='consumed', txid=?, settled_at=NULL, updated_at=?
  WHERE outpoint=? AND status=?`)
	for _, it := range items {
		st := states[it.Outpoint]
		doWrite, reason := decideConsume(*st, txid, it.RequestID)
		if reason != "" {
			return &ConsumeRefusal{Outpoint: it.Outpoint, Reason: reason}, nil // deferred rollback
		}
		if !doWrite {
			continue
		}
		res, err := tx.ExecContext(ctx, write, txid, now, it.Outpoint, string(st.status))
		if err != nil {
			return nil, fmt.Errorf("store: consume %s: %w", it.Outpoint, err)
		}
		if n, err := res.RowsAffected(); err != nil {
			return nil, fmt.Errorf("store: rows affected: %w", err)
		} else if n != 1 {
			// Unreachable while the row lock holds; refuse to guess.
			return nil, fmt.Errorf("store: consume %s: row changed under lock", it.Outpoint)
		}
		// A repeated outpoint later in the same batch now sees consumed(txid).
		st.status, st.txid, st.needsRecheck = StatusConsumed, txid, false
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("store: commit: %w", err)
	}
	return nil, nil
}

// ReleaseRequest is POST /release {requestId}: reserved rows of the request →
// released, needs_recheck=1. Never touches consumed rows.
func (s *Store) ReleaseRequest(ctx context.Context, requestID string) (int64, error) {
	return s.exec(ctx, `UPDATE fuel_reservations SET status='released', needs_recheck=1, updated_at=?
  WHERE request_id=? AND status='reserved'`, s.unix(), requestID)
}

// ReleaseEvicted is POST /release {outpoints, txid} (eviction only):
// consumed(txid) → released, needs_recheck=1 for each listed outpoint, in one
// transaction. txid is kept on the row so /settle can still repair it.
func (s *Store) ReleaseEvicted(ctx context.Context, txid string, outpoints []string) (int64, error) {
	if txid == "" {
		return 0, errors.New("store: ReleaseEvicted needs txid")
	}
	if len(outpoints) == 0 {
		return 0, nil
	}
	now := s.unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	sorted := append([]string(nil), outpoints...)
	sort.Strings(sorted) // same global lock order as Consume
	stmt := s.q(`UPDATE fuel_reservations SET status='released', needs_recheck=1, updated_at=?
  WHERE outpoint=? AND txid=? AND status='consumed'`)
	var total int64
	for _, op := range sorted {
		res, err := tx.ExecContext(ctx, stmt, now, op, txid)
		if err != nil {
			return 0, fmt.Errorf("store: release %s: %w", op, err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("store: rows affected: %w", err)
		}
		total += n
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit: %w", err)
	}
	return total, nil
}

// ReleaseByRule4 is sweeper rule 4 with overlay proof: every consumed(txid)
// row → released, needs_recheck=1.
func (s *Store) ReleaseByRule4(ctx context.Context, txid string) (int64, error) {
	if txid == "" {
		return 0, errors.New("store: ReleaseByRule4 needs txid")
	}
	return s.exec(ctx, `UPDATE fuel_reservations SET status='released', needs_recheck=1, updated_at=?
  WHERE txid=? AND status='consumed'`, s.unix(), txid)
}

// ByTxid returns every row whose txid is txid, by pair index.
func (s *Store) ByTxid(ctx context.Context, txid string) ([]Reservation, error) {
	return s.selectReservations(ctx, `txid=? ORDER BY pair_index, outpoint`, txid)
}

// ByRequest returns every row whose request_id is requestID, by pair index.
func (s *Store) ByRequest(ctx context.Context, requestID string) ([]Reservation, error) {
	return s.selectReservations(ctx, `request_id=? ORDER BY pair_index, outpoint`, requestID)
}

// MarkSettled records a successful settle (§4.6): a consumed, released or
// spent_external row carrying this txid → consumed with settled_at. The
// released/spent_external cases repair a wrongful release.
func (s *Store) MarkSettled(ctx context.Context, outpoint, txid string) (bool, error) {
	if txid == "" {
		return false, errors.New("store: MarkSettled needs txid")
	}
	now := s.unix()
	n, err := s.exec(ctx, `UPDATE fuel_reservations SET status='consumed', needs_recheck=0, settled_at=?, updated_at=?
  WHERE outpoint=? AND txid=? AND status IN ('consumed','released','spent_external')`, now, now, outpoint, txid)
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// ---------------------------------------------------------------------------
// sweeper (§4.7)

// ExpiredReserving lists reserving rows past expires_at (rule 0).
func (s *Store) ExpiredReserving(ctx context.Context) ([]Reservation, error) {
	return s.selectReservations(ctx, `status='reserving' AND expires_at<? ORDER BY expires_at, outpoint`, s.unix())
}

// ExpireReserved moves reserved rows past expires_at → released,
// needs_recheck=1 (rule 1: the holder may have broadcast the bare draft).
func (s *Store) ExpireReserved(ctx context.Context) (int64, error) {
	now := s.unix()
	return s.exec(ctx, `UPDATE fuel_reservations SET status='released', needs_recheck=1, updated_at=?
  WHERE status='reserved' AND expires_at<?`, now, now)
}

// RecheckPending lists released rows awaiting a chain check (rule 2), oldest
// first.
func (s *Store) RecheckPending(ctx context.Context, limit int) ([]Reservation, error) {
	if limit <= 0 {
		return nil, nil
	}
	return s.selectReservations(ctx, `status='released' AND needs_recheck=1 ORDER BY updated_at, outpoint LIMIT ?`, limit)
}

// SetRechecked records a rule-2 verdict: unspent → needs_recheck=0 (claimable
// again); spent → spent_external (terminal). CAS on released,
// needs_recheck=1; a miss is a no-op.
func (s *Store) SetRechecked(ctx context.Context, outpoint string, unspent bool) error {
	query := `UPDATE fuel_reservations SET status='spent_external', needs_recheck=0, updated_at=?
  WHERE outpoint=? AND status='released' AND needs_recheck=1`
	if unspent {
		query = `UPDATE fuel_reservations SET needs_recheck=0, updated_at=?
  WHERE outpoint=? AND status='released' AND needs_recheck=1`
	}
	_, err := s.exec(ctx, query, s.unix(), outpoint)
	return err
}

// UnsettledConsumed lists consumed rows without settled_at whose last update
// is older than olderThan (rules 3 and 4), oldest first.
func (s *Store) UnsettledConsumed(ctx context.Context, olderThan time.Duration) ([]Reservation, error) {
	cutoff := s.unix() - int64(olderThan/time.Second)
	return s.selectReservations(ctx, `status='consumed' AND settled_at IS NULL AND updated_at<? ORDER BY updated_at, outpoint`, cutoff)
}

// ---------------------------------------------------------------------------
// deny list + health (§4.8)

// Deny adds requester to the deny list. Idempotent: an existing entry keeps
// its original reason and outpoint.
func (s *Store) Deny(ctx context.Context, requester, reason, outpoint string) error {
	if requester == "" {
		return errors.New("store: Deny needs requester")
	}
	_, err := s.exec(ctx, `INSERT INTO fuel_denylist(requester, reason, outpoint, created_at) VALUES(?, ?, ?, ?)
  ON CONFLICT(requester) DO NOTHING`, requester, reason, outpoint, s.unix())
	return err
}

// IsDenied reports whether requester is on the deny list.
func (s *Store) IsDenied(ctx context.Context, requester string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, s.q(`SELECT 1 FROM fuel_denylist WHERE requester=?`), requester).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("store: deny lookup: %w", err)
	}
	return true, nil
}

// Undeny removes requester from the deny list; true if an entry was removed.
func (s *Store) Undeny(ctx context.Context, requester string) (bool, error) {
	n, err := s.exec(ctx, `DELETE FROM fuel_denylist WHERE requester=?`, requester)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// Counts returns rows per status (every status present, zero if none), the
// released rows awaiting recheck, the consumed rows not yet settled, and the
// deny-list size.
func (s *Store) Counts(ctx context.Context) (map[Status]int, int, int, int, error) {
	m := make(map[Status]int, len(allStatuses))
	for _, st := range allStatuses {
		m[st] = 0
	}
	rows, err := s.db.QueryContext(ctx, s.q(`SELECT status, COUNT(*) FROM fuel_reservations GROUP BY status`))
	if err != nil {
		return nil, 0, 0, 0, fmt.Errorf("store: counts: %w", err)
	}
	for rows.Next() {
		var st string
		var c int
		if err := rows.Scan(&st, &c); err != nil {
			_ = rows.Close()
			return nil, 0, 0, 0, fmt.Errorf("store: counts scan: %w", err)
		}
		m[Status(st)] = c
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, 0, 0, 0, fmt.Errorf("store: counts rows: %w", err)
	}
	_ = rows.Close()
	scalar := func(query string) (int, error) {
		var c int
		if err := s.db.QueryRowContext(ctx, s.q(query)).Scan(&c); err != nil {
			return 0, fmt.Errorf("store: counts: %w", err)
		}
		return c, nil
	}
	recheck, err := scalar(`SELECT COUNT(*) FROM fuel_reservations WHERE status='released' AND needs_recheck=1`)
	if err != nil {
		return nil, 0, 0, 0, err
	}
	unsettled, err := scalar(`SELECT COUNT(*) FROM fuel_reservations WHERE status='consumed' AND settled_at IS NULL`)
	if err != nil {
		return nil, 0, 0, 0, err
	}
	denied, err := scalar(`SELECT COUNT(*) FROM fuel_denylist`)
	if err != nil {
		return nil, 0, 0, 0, err
	}
	return m, recheck, unsettled, denied, nil
}

// truncateForTests empties all three tables (Postgres test path).
func (s *Store) truncateForTests(ctx context.Context) error {
	for _, t := range []string{"fuel_reservations", "fuel_requests", "fuel_denylist"} {
		if _, err := s.db.ExecContext(ctx, `DELETE FROM `+t); err != nil {
			return fmt.Errorf("store: truncate %s: %w", t, err)
		}
	}
	return nil
}

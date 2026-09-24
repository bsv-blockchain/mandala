package store

// Spec §4.4 plus three columns this implementation needs: fuel_beef (the
// proven source BEEF captured at claim, which the relink follow-up needs once
// the row has left the toolbox basket), derivation_prefix/suffix (to sign
// it), and pair_index (the fee output's vout inside its draft, needed by
// /settle).
const schemaSQLite = `
CREATE TABLE IF NOT EXISTS fuel_requests (
  nonce TEXT PRIMARY KEY, requester TEXT NOT NULL, ts INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_requests_requester ON fuel_requests(requester, created_at);
CREATE TABLE IF NOT EXISTS fuel_denylist (
  requester TEXT PRIMARY KEY, reason TEXT, outpoint TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fuel_reservations (
  outpoint TEXT PRIMARY KEY, satoshis INTEGER NOT NULL, fuel_script TEXT NOT NULL, fuel_beef TEXT NOT NULL DEFAULT '',
  derivation_prefix TEXT NOT NULL DEFAULT '', derivation_suffix TEXT NOT NULL DEFAULT '',
  request_id TEXT, requester TEXT, asset_id TEXT, pair_index INTEGER NOT NULL DEFAULT 0,
  fee_script TEXT, key_id TEXT, fee_amount TEXT,
  status TEXT NOT NULL, needs_recheck INTEGER NOT NULL DEFAULT 0, txid TEXT,
  expires_at INTEGER NOT NULL, settled_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_reservations_status ON fuel_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS fuel_reservations_request ON fuel_reservations(request_id);
CREATE INDEX IF NOT EXISTS fuel_reservations_txid ON fuel_reservations(txid);
CREATE INDEX IF NOT EXISTS fuel_reservations_requester ON fuel_reservations(requester, created_at);
`

// Postgres: identical shape; INTEGER → BIGINT, BOOLEAN kept as INTEGER 0/1 for
// one query set across both engines.
const schemaPostgres = `
CREATE TABLE IF NOT EXISTS fuel_requests (
  nonce TEXT PRIMARY KEY, requester TEXT NOT NULL, ts BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_requests_requester ON fuel_requests(requester, created_at);
CREATE TABLE IF NOT EXISTS fuel_denylist (
  requester TEXT PRIMARY KEY, reason TEXT, outpoint TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS fuel_reservations (
  outpoint TEXT PRIMARY KEY, satoshis BIGINT NOT NULL, fuel_script TEXT NOT NULL, fuel_beef TEXT NOT NULL DEFAULT '',
  derivation_prefix TEXT NOT NULL DEFAULT '', derivation_suffix TEXT NOT NULL DEFAULT '',
  request_id TEXT, requester TEXT, asset_id TEXT, pair_index INTEGER NOT NULL DEFAULT 0,
  fee_script TEXT, key_id TEXT, fee_amount TEXT,
  status TEXT NOT NULL, needs_recheck INTEGER NOT NULL DEFAULT 0, txid TEXT,
  expires_at BIGINT NOT NULL, settled_at BIGINT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS fuel_reservations_status ON fuel_reservations(status, expires_at);
CREATE INDEX IF NOT EXISTS fuel_reservations_request ON fuel_reservations(request_id);
CREATE INDEX IF NOT EXISTS fuel_reservations_txid ON fuel_reservations(txid);
CREATE INDEX IF NOT EXISTS fuel_reservations_requester ON fuel_reservations(requester, created_at);
`

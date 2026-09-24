# fuelkeeper

The Mandala fuel service: it signs issuer-paid fee drafts ("fuel pairs"),
keeps the issuer's fuel UTXO pool topped up, tracks every issued fuel output
through the reservation state machine, and credits the issuer's fee outputs
once the overlay reports a broadcast. Design:
[`docs/design/2026-09-22-mandala-token-fee-design.md`](../docs/design/2026-09-22-mandala-token-fee-design.md)
§4, with the P2 implementation notes in §13 (Revision 3).

## What runs in the process

One binary, one replica (see "Single replica" below):

- **Storage server** — an in-process go-wallet-toolbox storage server
  (BRC-103/104) started from the infra yaml at `FK_STORAGE_CONFIG`, listening
  on the yaml's `http.port`.
- **Issuer wallet** — a toolbox wallet for `ISSUER_ROOT_KEY` that talks to that
  server over loopback (`FK_STORAGE_URL`), plus a read-only in-process storage
  provider on the same DB for row-level fuel reads.
- **Pool keeper** — fans reserve funds out into `FUEL_D`-sized fuel outputs in
  the pool basket and keeps the pool between the low- and high-water marks.
- **Draft signer** (`POST /draft`) — verifies the requester's signed request,
  applies the deny list and quotas, reserves `k` proven fuel outputs and
  returns the SIGHASH_SINGLE|ANYONECANPAY fuel-pair skeleton. A fuel output
  is issued at most once: a released draft's fuel is never re-drafted.
- **Reservation API** — `POST /consume` (all-or-nothing at submit time),
  `POST /release` (by `requestId`, or eviction by `{txid, outpoints}`),
  `POST /settle` (internalizes the fee outputs of a broadcast tx; a request
  that can never settle is a final `400 ERR_SETTLE_INVALID`),
  `DELETE /deny/{requester}`.
- **Sweeper** (every `FK_SWEEPER_INTERVAL_SECONDS`) — spec §4.7 rules 0–4
  (expired reservations, chain rechecks of released fuel, unsettled consumed
  fuel via the overlay's admission record) and the §4.8 alerts, logged at
  Error with an `alert` attribute: `low_water`, `issuer_balance_low`,
  `pool_drain_unexplained`, `spent_external`, `consumedUnsettled`,
  `chain_check_untrusted` (and `settle_invalid` from `/settle`).
- **Probes** — `GET /health` (pool, reservation and deny-list counts, issuer
  balance; the pool listing and counts are cached for 10 s) and `GET /livez`
  (`{"ok":true}`, no I/O).

Every route except `/health` and `/livez` requires the `X-Fuel-Key` header: a
shared secret between the overlay and the keeper, compared in constant time
to `FK_API_KEY`. It is not a bearer token of any identity; treat it like a
password and rotate it on both sides together.

## Required environment

| Var | Purpose |
| --- | --- |
| `ISSUER_ROOT_KEY` | Issuer wallet root private key, 32 bytes hex. |
| `FK_API_KEY` | The `X-Fuel-Key` shared secret; at least 32 characters. |
| `FK_NETWORK` | BSV network: `main`, `test`, `ttn` or `tstn`. The sweeper's chain check only runs on `main` and `test` (see below). |
| `FK_STORAGE_CONFIG` | Path to the infra yaml handed to `infra.NewServer` (see below). |
| `FUEL_ASSET_IDS` | Comma-separated operator allowlist of `<64-hex-txid>.<vout>` asset ids. May be empty (allows nothing). |

## Optional environment (defaults)

| Var | Default |
| --- | --- |
| `FK_STORAGE_URL` | `http://127.0.0.1:8100` |
| `FK_API_PORT` | `8090` (must be in `[1025, 65535]`) |
| `FK_DB_DRIVER` | `sqlite` (`sqlite` or `postgres`) |
| `FK_DB_DSN` | `fuelkeeper.sqlite` (relative: resolves in the working directory, `/data` in the image) |
| `FUEL_D` | `200` (denomination, satoshis) |
| `FUEL_BSV_RATE` | `100` (sat/kb) |
| `FUEL_K_MAX` | `4` |
| `FUEL_N_MAX` | `20` |
| `FUEL_M_MAX` | `10` |
| `FUEL_TTL_SECONDS` | `600` |
| `FUEL_RESERVING_TTL_SECONDS` | `60` |
| `FUEL_MAX_OUTSTANDING` | `2` |
| `FUEL_DAILY_PAIRS` | `20` |
| `FUEL_PAIRS_PER_MIN` | `60` |
| `FK_OVERLAY_URL` | `""` (unset disables sweeper rule 4) |
| `FK_OVERLAY_ADMIN_TOKEN` | `""` |
| `FK_POOL_BASKET` | `fuel` |
| `FK_RESERVE_BASKET` | `reserve` |
| `FK_POOL_TARGET` | `100` |
| `FK_LOW_WATER_PERCENT` | `60` |
| `FK_HIGH_WATER_PERCENT` | `100` |
| `FK_FANOUT_OUTPUTS_PER_TX` | `20` |
| `FK_FANOUT_MAX_TXS_PER_ROUND` | `5` |
| `FK_KEEPER_INTERVAL_SECONDS` | `30` |
| `FK_SWEEPER_INTERVAL_SECONDS` | `30` |
| `FK_WOC_API_KEY` | `""` (enables the WhatsOnChain `IsUtxo` chain check on `main`/`test`; ignored on `ttn`/`tstn`) |

Without a chain check (no key, or `ttn`/`tstn`, where the toolbox would ask
public testnet and read every fuel output as spent) sweeper rule 2 never acts:
released rows awaiting a recheck stay pending, and nobody is marked
`spent_external` or denied.

## Infra yaml requirements

`FK_STORAGE_CONFIG` must point at an infra yaml where:

- `utxo_management.strategy: throughput`
- the resolved denomination (`utxo_management.throughput.denomination_satoshis`)
  equals `FUEL_D`
- `utxo_management.throughput.pool_basket` equals `FK_POOL_BASKET` (`fuel`)
- `utxo_management.throughput.reserve_basket` equals `FK_RESERVE_BASKET` (`reserve`)
- `utxo_management.throughput.fanout_outputs_per_tx` equals
  `FK_FANOUT_OUTPUTS_PER_TX` (the toolbox default is 100, the keeper's 20)
- `bsv_network` equals `FK_NETWORK`
- `observability.metrics.enabled: false` (the read-only provider would register
  a second set of the same gauges)
- `http.port` equals the port in `FK_STORAGE_URL`

The keeper checks all of these at startup and exits 1 on a mismatch, except
`http.port`, which it only warns about (the wallet then retries for two
minutes and gives up).

## Container

`Dockerfile` builds a CGO binary onto `gcr.io/distroless/base-debian12:nonroot`
and runs it as `nonroot` with working directory `/data`. Mount the persistent
volume at `/data`: the `FK_DB_DSN` default (`fuelkeeper.sqlite`) and any
relative sqlite `connection_string` in the infra yaml resolve there. Point
Kubernetes liveness at `/livez` and readiness at `/health`.

## Single replica

Run exactly one keeper per issuer. Sweeper rule 2's "spent" readings, rule 4's
observations and the pool-drain snapshot live in process memory, the pool
keeper assumes it is the only one fanning out, and the default store is a
SQLite file. Both the storage port and `FK_API_PORT` must be reachable only
from inside the cluster (NetworkPolicy), never from a public ingress.

## Test

```
cd fuelkeeper && GOTOOLCHAIN=auto go test ./... -count=1 -race
```

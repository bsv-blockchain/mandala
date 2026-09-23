# fuelkeeper

Standalone service that signs and settles issuer-paid transaction fee
("fuel pair") requests on behalf of an issuer's fuel key, and keeps the
issuer's fuel UTXO pool topped up. Design: see
[`docs/design/2026-09-22-mandala-token-fee-design.md`](../docs/design/2026-09-22-mandala-token-fee-design.md)
§4 ("fuelKeeper service (`FK/`, new Go module)").

This module (Task 1 of the fuelKeeper build-out) currently only wires up
process configuration; the HTTP service, draft signer, and pool
keeper/sweeper land in later tasks (see Task 10).

## Required environment

| Var | Purpose |
| --- | --- |
| `ISSUER_ROOT_KEY` | Issuer's fuel root private key, 32 bytes hex. |
| `FK_API_KEY` | Bearer key clients must present; at least 32 characters. |
| `FK_NETWORK` | BSV network: `main`, `test`, `ttn`, or `tstn`. |
| `FK_STORAGE_CONFIG` | Path to the infra yaml handed to `infra.NewServer` (see below). |
| `FUEL_ASSET_IDS` | Comma-separated operator allowlist of `<64-hex-txid>.<vout>` asset ids. May be empty (allows nothing). |

## Optional environment (defaults)

| Var | Default |
| --- | --- |
| `FK_STORAGE_URL` | `http://127.0.0.1:8100` |
| `FK_API_PORT` | `8090` (must be in `[1025, 65535]`) |
| `FK_DB_DRIVER` | `sqlite` (`sqlite` or `postgres`) |
| `FK_DB_DSN` | `fuelkeeper.sqlite` |
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
| `FK_OVERLAY_URL` | `""` |
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
| `FK_WOC_API_KEY` | `""` (optional; enables the WhatsOnChain `IsUtxo` chain check) |

## Infra yaml requirement

`FK_STORAGE_CONFIG` must point at an infra yaml where:

- `utxo_management.strategy: throughput`
- `utxo_management.throughput.denomination_satoshis` equals `FUEL_D`
- `pool_basket: fuel`
- `reserve_basket: reserve`
- `http.port` matches the port in `FK_STORAGE_URL`

## Test

```
cd fuelkeeper && GOTOOLCHAIN=auto go test ./...
```

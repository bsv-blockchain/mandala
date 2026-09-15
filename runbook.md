# Mandala demo runbook (agent pickup)

Last updated: 2026-09-15. TS overlay (`:8080`) rebuilt from `overlay/dist` and restarted **~23:44 local** (superseding the earlier ~22:35 restart below — this rebuild ships wire contract v2: digest v2, the `/submit` verdict taxonomy, `GET /admin/admission/:txid`, reject-not-skip, eviction restore, admission records; see "Settlement contract (2026-09-15)" below). Restart log: `/private/tmp/claude-502/-Users-personal-git-demos-mandala/1d8c5cb1-3448-49bc-b255-3df7840f24b8/scratchpad/overlay.log`. `overlay/vitest.config.ts` now scopes vitest to `src/**/*.test.ts` (excludes the stale compiled copies `npm run build` emits into `dist/`). App (`:5173`) and Mongo `local-mongo-1` already running. `overlay-go` (`:8081`) is **not** running. Registry head unchanged through this restart (`dc810603…:0`, admitSeq 2) — that sequence is now persisted in Mongo (`mandalaCounters`), so it survives a restart. Resume by continuing the identity-admin admit.

Do **not** print `SERVER_PRIVATE_KEY` (or any other hex private key) in chat.

---

## STATE RESET — 2026-09-15 (read before anything below)

All overlay state was wiped on request to start fresh: Mongo `mandala_lookup_services`, the Go engine databases `overlay_local` / `overlay_validation_20260909`, and the TS engine SQLite (`/tmp/mandala-overlay.sqlite`, recreated empty by the migrations on restart). The live TS overlay on :8080 was restarted and is empty.

Consequences:
- Every "do not open a new genesis" warning below is obsolete: the registry chain (`dc810603…` / `ec5584b5…`) and both assets (`7cf8d33c…`, `e1c664af…`) no longer exist on the overlay. The next `registerAsset` and the next `registerIdentities` ARE the new geneses.
- The issuer's MetaNet wallet still holds the old admin/registry/token outputs in its basket. The console will list them as assets the overlay does not know; relinquish them in MetaNet (or ignore them) before registering fresh assets so `listAdminAssets` does not pick a stale prior.
- The historical txids quoted in the sections below are kept for context only.

## What we were doing

Issuer console Identities page: mock-KYC admit of an arbitrary compressed pubkey onto the **overlay-wide identity registration chain** (`tm_mandala_registry`).

That chain is **not** the per-asset allow/block list in Operations. Two independent gates:

| Gate | Topic / UI | Live head |
| --- | --- | --- |
| Per-asset admin (issue/redeem/allow/block) | `tm_mandala` · Operations | `mandala-admin` CI in basket `mandala-tokens` |
| Overlay-wide identity (KYC) | `tm_mandala_registry` · Identities | overlay `GET /admin/registry` + 1-sat auth UTXO |

Asset genesis does **not** create the identity chain.

Correct admit pattern (copy per-asset `submitAdminAction` / `buildAdminActionArgs` in `lib/src/assets.ts`):

1. Spend the **live identity-admin outpoint** as a `createAction` **input**.
2. Create a **new** 1-sat identity-admin **output** (next head).
3. Submit **only** to `tm_mandala_registry` with off-chain `admin: [{ index, actionDetails }]`.
4. Next admit/revoke spends **that new outpoint**, not the old one.

Genesis (`registerIdentities`) is the only `createAction` with **no inputs**.

---

## Live identity-admin head (do not open a new genesis)

Overlay cache (last known):

```
GET /admin/registry →
[{
  identityKey: 0215643bc656ca42007faa32e94f70050f64a566ffd9e3a2ebc098389936dea57e,
  status: admitted,
  txid: dc810603d764fd843fb979ad9b4412f0dbeb03eeaa6124a3af097f3316046179,
  outputIndex: 0,
  admitSeq: 2
}]
```

- On-chain, unspent: [dc810603…](https://whatsonchain.com/tx/dc810603d764fd843fb979ad9b4412f0dbeb03eeaa6124a3af097f3316046179) vout 0 (1 sat P2PKH `044fd4ce…` / `1PoLYQJz6zuYUu3HebkwtVkQL65LqYmcU`).
- A **second** 1-sat to the same PKH also exists and is unspent: [ec5584b5…](https://whatsonchain.com/tx/ec5584b53916cd01bcdd125bb66c0d163a978716d41997715364239542302cd1) vout 0. That was a mistaken extra genesis. **Spend `dc810603…0`**, not `ec5584b5…0`.
- Overlay BEEF for the live head: `GET /admin/registry/beef/dc810603d764fd843fb979ad9b4412f0dbeb03eeaa6124a3af097f3316046179?vout=0` (AtomicBEEF, parent `0b0177c6…` + `dc810603…`).

Target admit key the user was testing:

`0299e59759c5b1460ec80fa9cde787d4c57ae9f85337f853a7d211b0da6c687c38`

Issuer / overlay identity (MetaNet wallet = `overlay-go/.env` `SERVER_PRIVATE_KEY`, **not** `overlay/.env` originally):

`0215643bc656ca42007faa32e94f70050f64a566ffd9e3a2ebc098389936dea57e`

App treats `identityKey === VITE_OVERLAY_IDENTITY_KEY` as issuer. Overlay admin lock/verify uses BRC-42; overlay `adminWallet` must share that same root key (`counterparty: 'self'` is not cross-party).

---

## Local services

| Piece | How | URL |
| --- | --- | --- |
| Mongo | Existing Docker `local-mongo-1` replica set. **Do not stop it.** | `127.0.0.1:27017` |
| Overlay | **Native Node**, not Compose. Rebuilt from `overlay/dist` + restarted ~23:44 local (2026-09-15, wire contract v2 build; supersedes an earlier ~22:35 restart same day). | `http://localhost:8080` (`HOSTING_URL=https://deggen.ngrok.app`) |
| overlay-go | Not running this session. Compose service in `overlay/docker-compose.yml`, published on host `:8081`. | `http://localhost:8081` |
| Vite app | `app/` | `http://127.0.0.1:5173/` (`VITE_OVERLAY_URL=https://deggen.ngrok.app`) |
| ngrok | User runs it | `https://deggen.ngrok.app` → `http://localhost:8080` |
| MessageBox | hosted | `https://gmb.bsvblockchain.tech` |
| Network | main / Arcade | real mainnet txs |

**Do not** `docker compose up` from repo root (no compose file there). Compose lives at `overlay/docker-compose.yml` and the overlay container cannot talk to this replica set (`mongodb://mongodb:27017` vs advertised `127.0.0.1:27017`). Native overlay + host Mongo is the working setup.

Start:

```bash
docker start local-mongo-1   # if exited

# overlay
cd overlay
MONGO_URL=mongodb://127.0.0.1:27017/mandala \
SQLITE_FILE=/tmp/mandala-overlay.sqlite \
npm start
# after code changes: npm run build && npm start  (start runs dist/index.js)

# app
cd app
VITE_OVERLAY_URL=https://deggen.ngrok.app npm run dev -- --host 127.0.0.1 --port 5173
```

Logs used this session:

- Overlay (current, 2026-09-15 restart): `/private/tmp/claude-502/-Users-personal-git-demos-mandala/1d8c5cb1-3448-49bc-b255-3df7840f24b8/scratchpad/overlay.log`
- Prior session logs (historical, may be stale/rotated):
  - `/Users/personal/.grok/long-running-background-tasks/mandala-overlay-native.log`
  - `/Users/personal/.grok/long-running-background-tasks/mandala-app.log`

Health: `GET http://127.0.0.1:8080/health` (not `/api/v1/info`). Topics: `tm_mandala` + `tm_mandala_registry`.

Advertiser warning `https://https://deggen.ngrok.app` (double scheme) disables SHIP/SLAP; not blocking.

SQLite overlay DB: `/tmp/mandala-overlay.sqlite`. Earlier `@bsv/overlay` migrations needed `INSERT OR IGNORE` instead of `INSERT IGNORE` (patched in the installed package).

After `lib/` changes: `cd lib && npm test && npm run build` (app imports `@bsv/mandala` from `lib/dist`). Hard-reload the Vite app.

---

## Identity registry code (where to look)

| File | Role |
| --- | --- |
| `lib/src/registry.ts` | `registerIdentities` (no inputs), `buildRegistrySpendArgs` (must list live outpoint as input), `admitOrRevokeIdentity`, `mockKycAdmit` / `Open` / `Revoke` |
| `lib/src/registryRecover.ts` | Overlay BEEF fetch, `loadRegistryInputBeef` (**only** the live tx, not basket BEEF), `recoverRegistryAuth`, `abortStuckRegistryActions` |
| `lib/src/assets.ts` | **Correct** per-asset spend-and-replace: `buildAdminActionArgs` + `submitAdminAction` |
| `overlay/src/registry.ts` | `RegistryTopicManager`, Mongo `mandalaRegistry` cache, `foldRegistry` |
| `overlay/src/index.ts` | `GET /admin/registry`, `GET /admin/registry/beef/:txid?vout=` |
| `overlay/src/assetAuth.ts` | Per-asset admin-auth head: `GET /admin/asset-auth/:assetId`, `GET /admin/asset-auth/beef/:txid?vout=`, `hasFrozenRow` annotation on `/admin/asset-state` |
| `overlay/src/adminChainGuard.ts` | Admin-chain anchoring wrapper for `tm_mandala` (closes the admin-forgery gap until upstream ships it) + `freezeOutput`-with-no-token-row refusal |
| `lib/src/assetRecover.ts` | `recoverAdminAuth` — per-asset admin-head recovery from the overlay, mirror of `registryRecover.ts` |
| `app/src/components/issuer/IdentityRegistry.tsx` | Identities UI |
| `app/src/hooks/useRegistryMutations.ts` | Open / admit / revoke |

Lock script: BRC-42 `REGISTRY_PROTOCOL` + `MandalaAdmin.commitment(details)`, 1 sat. New outputs add an OP_DROP `{t:mandala-registry}` prefix so they are not vanilla P2PKH (wallet was dropping basket CI on refresh). **Live head `dc810603` is still vanilla P2PKH.**

Unlock must use the details that **locked** the head (`{ kind: 'register', issuer, identityKey }` for this first spend).

Submit topics: `[REGISTRY_TOPIC]` only. Submitting to `tm_mandala` as well yields `conservation violated` (noise in overlay logs from other txs).

---

## New overlay routes (2026-09-15)

On both stacks (TS `overlay/src/index.ts`, Go `overlay-go/internal/httpapi/admin.go`) unless marked otherwise:

- `GET /admin/asset-auth/:assetId` → `{authOutpoint, authDetails}` — the asset's admin-auth chain head by `(height, offset, admitSeq)`. Same re-attach idea as `/admin/registry`, but per-asset; powers the new "Re-attach asset authority" card (`app/src/hooks/useAssetAuth.ts`).
- `GET /admin/asset-auth/beef/:txid?vout=` — BEEF for a specific admin-auth output.
- `GET /admin/registry/beef/:txid?vout=` — Go now has this too (parity with TS).
- `GET /admin/admission/:txid` — **now on both stacks** (updated 2026-09-15 ~23:44 build; an earlier note in this file said TS-only, that is stale — Go wires it in `overlay-go/internal/httpapi/admin.go`'s `registerAdmissionRoute`/`admissionHandler`, called from `server.go`). See "Settlement contract" below for the response shapes.
- `GET /admin/asset-state/:assetId` — each frozen ref now carries `hasFrozenRow` (both stacks): whether the frozen coin still has a live token row, i.e. whether a reissue of it can succeed.

New admission gates (both stacks): an admin action must spend a **recorded** admin output of the asset (chain anchoring by spend history, not key re-derivation — see `overlay/src/adminChainGuard.ts` / Go `topic_manager.go`); registry `register` is genesis-only; `freezeOutput` of an outpoint with no token row is refused (identical error string on both stacks); membership screening exempts asset issuers + the overlay's own identity on both stacks. **Known/accepted mismatch:** TS's membership refusal surfaces the upstream `@bsv/overlay-topics` string `"sanctioned party involved in transfer"`; Go's dedicated gate says `"identity not admitted: <key>"`. Different strings, same effect — not yet reconciled.

---

## Settlement contract (2026-09-15)

Wire contract v2 is now binding on both stacks — spec of record: `docs/design/2026-09-15-mandala-wire-contract-v2.md` (companions: `2026-09-15-mandala-offline-settlement-design.md`, `2026-09-15-mandala-stablecoin-ux-design.md`; admin plan `docs/design/2026-09-14-admin-plan.md`). This is the build the ~23:44 overlay restart above shipped.

**σI digest v2** — `SHA-256("mandala-admit:" + txid + ":" + outputsToAdmit.sort(asc).dedupe.join(","))`, attached only to the `tm_mandala` STEAK entry (never a registry-only admission). The v1 digest (txid-only) is removed on both stacks: TS `overlay/src/admission.ts`, Go `overlay-go/internal/httpapi/admission.go`.

**`POST /submit` error taxonomy** (TS `overlay/src/submitVerdict.ts`, Go `overlay-go/internal/httpapi/verdict.go`) — body always `{status, code, retryable, description, message, spendTxid?}`:

| Code | HTTP | Retryable | Final (persisted) |
| --- | --- | --- | --- |
| `ERR_CONSERVATION` / `ERR_LINKAGE` / `ERR_SHAPE` / `ERR_SATOSHIS` / `ERR_INPUT_SPENT` | 400 | no | yes — persisted per txid |
| `ERR_PAUSED` / `ERR_FROZEN` / `ERR_SANCTIONED` / `ERR_ACCESS` / `ERR_MEMBERSHIP` | 409 | yes | no (liftable) |
| `ERR_EVICTED` | 410 | no | yes |
| `ERR_UNAVAILABLE` | 503 | yes | no |

Codes come only from a genuine topic-manager reject reason, matched by a shared substring table (same strings, same order, on both stacks) — anything else (SPV/chaintracker, storage, broadcast/Arcade, sanctions-provider fault) is `ERR_UNAVAILABLE`.

**Known quirk on BOTH stacks (this file previously risked implying TS-only; it is not): `ERR_FROZEN` is effectively unreachable in practice.** The pinned TS `@bsv/overlay-topics` manager collapses gates 1 (frozen/evicted input), 2 (paused) and 3 (access-mode) into one thrown string, `"control gate rejected the transaction (paused asset or access mode)"` (`MandalaTopicManager.js` in `overlay/node_modules/@bsv/overlay-topics/dist/mandala/`). Go's own native `topic_manager.go` deliberately reproduces the identical collapsed string for wire parity (`errors.New("control gate rejected the transaction (paused asset or access mode)")`). Since the substring table checks `"paused"` before `"frozen"` on both stacks, and the fixed string always contains `"paused"`, a genuinely frozen-input rejection reports `ERR_PAUSED` on both engines. HTTP behavior (409, retryable) is identical either way, so no wallet-visible bug — only the `code` field is misleading.

**`GET /admin/admission/:txid`** (both stacks now, gated by `ADMIN_API_TOKEN` like `/admin/registry`):
- `200 {txid, outputsToAdmit, admissionSignature, admissionIdentityKey, at}`
- `410 {status:"error", code:"ERR_EVICTED", ...}` · `400 {status:"error", code:<final code>, ...}` (persisted final refusal) · `404 {status:"error", message:"no admission on record for <txid>"}`
- Idempotent dupe re-signs from the engine's own applied-transaction proof even when the `mandalaAdmissions` record is missing (FIX C).
- Live-verified this session: `GET /admin/admission/e1c664af…` (a tx admitted before the admission-record mechanism existed) returned a σI the lib's `verifyAdmission` accepts (see `/private/tmp/claude-502/-Users-personal-git-demos-mandala/1d8c5cb1-3448-49bc-b255-3df7840f24b8/scratchpad/adm.json`). `7cf8d33c…` (a genesis) 404s on the TS engine because it was admitted through overlay-go's separate engine store, not TS's.

**Reject-not-skip** — an un-linked MandalaToken-decodable output rejects the whole submission (was silently skipped before): `"output <idx>: MandalaToken-decodable output with no verified linkage"`, identical on both stacks (TS `overlay/src/tokenLinkageGuard.ts` wrapper around the pinned manager; Go native in `topic_manager.go`). Phantom-coin regression tests exist on both (`overlay/src/tokenLinkageGuard.test.ts` / `wrapperStack.test.ts`; `overlay-go/internal/mandala/topic_manager_test.go`).

**Eviction restore (FIX E) + conflicting spend (FIX L):** eviction now restores inputs from the admission record's snapshot before deleting the evicted outputs (TS `overlay/src/eviction.ts`; Go `wiring/engine.go`'s `evictTx`). `/arc-ingest` is not mounted at all when `ARCADE_CALLBACK_TOKEN` is empty, on both stacks (logs an error and skips mounting; server still starts). A conflicting spend is refused `ERR_INPUT_SPENT{spendTxid}` (compare-and-swap mark-spent, naming the competing still-admitted tx); a storage CAS conflict itself is `ERR_UNAVAILABLE` (503, retryable), never surfaced as a policy refusal.

**Admission record** — new Mongo collection `mandalaAdmissions` on both stacks (`overlay/src/index.ts`'s `admissionsCol`; Go `overlay-go/internal/mandala/admissions.go`'s `AdmissionsCollection`), carrying the restore snapshot plus `refusedCode`/`refusedDescription`/`refusedSpendTxid`/`evictedAt`. Written synchronously **before** the `/submit` response is sent, so a client that got a 200 is guaranteed the very next `GET /admin/admission/:txid` succeeds.

**Env (non-secret):** `ADMIN_API_TOKEN`, `ADMIN_CORS_ORIGINS`, `ARCADE_CALLBACK_TOKEN` — documented in `overlay/.env.example` and `overlay-go/.env.example`.

**`lib/` (`@bsv/mandala`) additions:** `admission.ts` (`admissionDigestV2`, `verifyAdmission`), `bundle.ts` (`AdmissionBundle`, `canonicalBundleId`, pure `cover()`), `OverlayRefusedError` + `createOverlayFacilitator` in `overlay.ts`; σI is now captured on every admin/registry/transfer pipeline call and journaled; `receive.ts` verifies an optional `admission` body field (unverifiable ⇒ treated as absent, not rejected); `configureMandala({basket, storage})` is new. `lib/dist` has been rebuilt.

**Still pending — do not treat as done:** the ts-stack PR to make `@bsv/overlay-topics`' `verifyFtOutputs` throw instead of silently skip (the repo-local `tokenLinkageGuard.ts` wrapper is a mitigation, not a substitute — see its file header); publishing `@bsv/mandala` to npm (the wallet still consumes it via the `file:../lib` symlink in `app/package.json`); the stuck identity admit of `0299e597…` above (still not retried).

---

## Failures already seen (do not repeat)

1. **Operations allowlist ≠ KYC.** Per-asset allow/block still requires every party if mode is allowlist (including the issuer).
2. **Token launch did not create the identity chain.** User opened Identities later; first admit/open wrote `dc810603` to overlay + chain.
3. **Wallet lost CI on refresh.** 1-sat P2PKH reclassified; Identities showed issuer on overlay list but “this wallet does not hold live registry authorization.”
4. **Second genesis `ec5584b5`.** Opening again while overlay was already live. Do not create a third.
5. **`createAction` missing `sourceTransaction`.** Basket-wide `listOutputs` BEEF did not contain `dc810603`. Fix: overlay/WoC BEEF for that txid.
6. **`no live registry auth — call registerIdentities first`.** `admitIdentity` re-listed the basket after recover and threw. Fix: `recoverRegistryAuth` overlay-first; pass `live` into `admitOrRevokeIdentity`.
7. **`already consumed by this action batch` (latest).** `inputBEEF` was a merge of the **entire** `mandala-tokens` basket (USD-BSV genesis, etc.). A previous noSend admit still held `dc810603…0`. Fix in tree (needs lib rebuild + hard reload):
   - `loadRegistryInputBeef` = **only** overlay/WoC BEEF for that tx
   - `abortStuckRegistryActions` before createAction
   - `noSend: true` on the spend `createAction`

If admit fails again with “consumed by this action batch”: abort/reject any hanging MetaNet noSend/unsigned action that spends `dc810603…0`, then retry once. Do not open a new chain.

---

## What to do next

1. Services are already up (overlay rebuilt + restarted 2026-09-15 ~23:44 with the wire-contract-v2 build, app + Mongo already running — see Local services). If not: start Mongo, native overlay (`npm run build` in `overlay/` if `dist/` is stale), Vite, ngrok.
2. Confirm `GET /admin/registry` still points at `dc810603…0` (it did as of the ~23:44 restart — admitSeq 2, now Mongo-persisted so a restart cannot desync it).
3. Hard-reload `http://127.0.0.1:5173/issuer/identities` with MetaNet on the overlay-go identity.
4. If UI says re-attach, click **Re-attach identity chain** (internalize `dc810603…0`). Do **not** Open a new genesis.
5. Admit `0299e597…` — **still not retried**. Wallet prompt must spend `dc810603…0` and create a new 1-sat registry output.
6. Overlay registry row should move to the new txid; next admit spends **that**.
7. Bring `overlay-go` up (`:8081`, currently not running) and re-run the settlement-contract checks against it too — the wire-contract-v2 parity work above was verified by reading both codebases, not by an equivalent live GET/submit pass against Go the way `e1c664af…` was checked against TS.
8. Land the still-pending items: the ts-stack PR to make `verifyFtOutputs` throw instead of skip; publish `@bsv/mandala` to npm (drop the `file:../lib` symlink in `app/package.json` once published).

If createAction still rejects the input as unknown: the wallet does not have `dc810603…0` as a spendable basket output. `recoverRegistryAuth` / `internalizeAction` with overlay BEEF is the path. `trustSelf: 'known'` is already set.

If unlock/overlay PKH fails: overlay `RegistryTopicManager` derives with `REGISTRY_PROTOCOL` and `forSelf: false`; client lock/unlock must stay on that protocol, not `ADMIN_PROTOCOL`.

Note: this identity-chain re-attach (step 4) is separate from the new **per-asset** "Re-attach asset authority" card on the Issuer Dashboard (`app/src/hooks/useAssetAuth.ts`, overlay `GET /admin/asset-auth/:assetId`) — that one recovers a single asset's admin-auth outpoint into the wallet basket, not the overlay-wide identity chain. Use whichever matches what actually went missing.

---

## Tests / verify

```bash
cd lib && npm test -- src/registry.test.ts src/registryRecover.test.ts && npm run build
cd overlay && npx tsc --noEmit && npm test
cd app && npx vitest run src/components/issuer/IdentityRegistry.test.ts src/robustness.wiring.test.ts
```

`overlay/vitest.config.ts` scopes `npm test` to `src/**/*.test.ts` only — `npm run build` emits compiled `*.test.js` into `dist/`, which the default vitest include would otherwise also pick up and run stale.

Lib tests covering spend args: `buildRegistrySpendArgs` must include `inputs[0].outpoint === priorOutpoint`.

Settlement-contract tests (wire contract v2): `cd overlay && npm test -- src/submitVerdict.test.ts src/admission.test.ts src/admissionRoute.test.ts src/tokenLinkageGuard.test.ts src/eviction.test.ts`; Go equivalent `cd overlay-go && go test ./internal/httpapi/... ./internal/mandala/... ./internal/wiring/...`; lib equivalent `cd lib && npm test -- src/admission.test.ts src/bundle.test.ts`.

---

## Env (non-secret)

- `overlay/.env`: `HOSTING_URL=https://deggen.ngrok.app`, `SERVER_PRIVATE_KEY` copied from **`overlay-go/.env`** (so overlay signs as `0215643b…`).
- `app/.env`: `VITE_OVERLAY_URL=https://deggen.ngrok.app`, `VITE_OVERLAY_IDENTITY_KEY=0215643bc656ca42007faa32e94f70050f64a566ffd9e3a2ebc098389936dea57e`.
- `ADMIN_API_TOKEN`, `ADMIN_CORS_ORIGINS`, `ARCADE_CALLBACK_TOKEN` (documented in both `overlay/.env.example` and `overlay-go/.env.example`) are **unset** in this session's running overlay — confirmed from the ~23:44 restart log: `/admin/registry`, `/admin/activity` and `/admin/admission/:txid` are unauthenticated, and `/arc-ingest` is not mounted. Fine for local dev; set before any public demo.
- Cancelled earlier: do not try to set admin from pubkey `02210a518b6accdc…` alone.

Network is **main**. Overlay-first, then broadcast (Arcade).

### Contract amendment v2.1 (2026-09-15, post-review) — overrides the section above where they differ

- Final refusals are persisted per `(txid, payloadHash)` (`sha256` of the exact off-chain payload bytes; empty → `e3b0c442…b855`); a different payload is evaluated fresh. `ERR_INPUT_SPENT` is never persisted.
- Admission record is written provisionally (`pending:true`, with the restore snapshot) BEFORE the engine broadcasts, finalised after; finalise failure → 503; boot aborts if the `mandalaAdmissions` index cannot be created.
- `GET /admin/admission/:txid?payloadHash=<hex>` — a persisted refusal is served only on a matching hash; malformed txid → `400 ERR_SHAPE`; empty stored set → 404.
- Store/provider faults inside any gate → `503 ERR_UNAVAILABLE`, never a final code (fail closed). Guard order both engines: unlinked-token → conflicting-spend → admin-chain → manager; unanchored admin actions reject the whole submission on Go too.
- TS: per-request verdict scope (AsyncLocalStorage) + in-flight outpoint set (concurrent conflicting spends → one 200, one 503). Eviction stamps `evictedAt` only after the restore succeeded.
- lib: `cover(tip, bundle, { expectedSignerKey })` — third arg required; `payloadHash()`, `fetchAdmission(url, txid, {payloadHash})`, `'retryable'`/`'stranded'` journal stages, `journalListStranded()`.
- Live overlay on :8080 restarted ~00:05 on the v2.1 build (payload hash verified identical across lib/TS/Go). Suites: lib 467, app 53, overlay 339, Go 294 (all green).
- bsv-wallet: full toolbox suite 3143/3144 (the one failure is `services/capWalletArgs.test.ts`, the maintainer's separate in-flight vault work). `@bsv/mandala` consumed via `file:../demos/mandala/lib` (symlink + lockfile) until published.

---

## Flux deployment (testnet, 2026-09-15)

Cluster `bsva-us-1`, namespace `mandala-test`, manifests in
`bsva-infra-flux/apps/base/mandala-test` (PR bsv-blockchain/bsva-infra-flux#348).

| Piece | Image | URL |
| --- | --- | --- |
| overlay-go | `ghcr.io/bsv-blockchain/mandala-overlay-go:0.1.0` (`overlay-go/Dockerfile`) | `https://mandala-test-overlay.bsvblockchain.tech` |
| console | `ghcr.io/bsv-blockchain/mandala-app:0.1.0` (`app/Dockerfile`, context = repo root) | `https://mandala-test.bsvblockchain.tech` |
| Mongo | `mongo:8` in-cluster, gp3-retain PVC | `mongodb:27017` (cluster-internal) |

- `NETWORK=test`; Arcade = `https://arcade-v2-testnet-us-1.bsvblockchain.tech` (broadcast + chaintracks). `/arc-ingest` gated by `ARCADE_CALLBACK_TOKEN`.
- Secrets: SSM us-east-2 `/apps/mandala-test/{SERVER_PRIVATE_KEY,ARCADE_CALLBACK_TOKEN,MONGO_URL,MONGO_ROOT_PASSWORD}` (profile `bsva`). `SERVER_PRIVATE_KEY` is the same key as `overlay-go/.env`, so issuer identity stays `0215643b…`.
- Images are built by `.github/workflows/docker-publish.yml` on every `v*` tag (both images, linux/amd64, GHCR). Console `VITE_*` are baked at build time from repository variables (defaults = testnet values above). Release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Then bump the tags in the flux manifests. `ADMIN_API_TOKEN` is deliberately unset (would have to be baked into the public bundle).

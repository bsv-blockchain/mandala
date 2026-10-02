All call sites and SDK internals are read. Here is the complete wire contract.

# Mandala frontend ↔ overlay wire contract

Overlay base URL: `OVERLAY_URL = import.meta.env.VITE_OVERLAY_URL` (`app/src/lib/mandala/constants.ts:10`). Topic `tm_mandala`, lookup service `ls_mandala` (`constants.ts:3-4`). SDK: `@bsv/sdk` **2.1.6**. There is **no auth of any kind** on any overlay call — no BRC-31/Authrite, no cookies, no credentials, no signature headers. Plain `fetch`.

The frontend makes exactly **7 distinct overlay calls**: 2 via `@bsv/sdk` clients (`/submit`, `/lookup`) and 5 bespoke JSON GETs (`/admin/*`).

---

## 1. `POST /submit` — transaction submission (the commit point of every mutating flow)

**Client path:** `submitToOverlay()` (`app/src/lib/mandala/overlay.ts:9-19`) → `new HTTPSOverlayBroadcastFacilitator(undefined, true).send(OVERLAY_URL, taggedBEEF)` (`overlay.ts:12,15`). The `true` = `allowHTTP`, so plain `http://` overlay URLs work for submit. The app never uses `TopicBroadcaster.broadcast()` / SHIP host discovery — it hits `OVERLAY_URL` directly, so `ls_ship` lookup is **not** part of the contract.

**SDK request encoding** (`app/node_modules/@bsv/sdk/dist/esm/src/overlay-tools/SHIPBroadcaster.js:13-44`):

- URL: `${OVERLAY_URL}/submit`, method `POST`
- Headers:
  - `Content-Type: application/octet-stream`
  - `X-Topics: ["tm_mandala"]` — literally `JSON.stringify(topics)` (line 19)
  - `x-includes-off-chain-values: true` — **only** when `offChainValues` is present (line 23). The app always sends offChainValues (every flow calls `encodeLinkagePayload`).
- Body (binary):
  - Without off-chain values: raw BEEF bytes (line 31).
  - With off-chain values (lines 24-28): `varint(beef.byteLength) ‖ beef ‖ offChainValues` — Bitcoin VarInt framing, then BEEF, then the off-chain payload occupying the remainder of the body (server reads it with `r.read()` to end — `overlay/node_modules/@bsv/overlay-express/src/OverlayExpress.ts:1473-1477`).

**Off-chain values payload** — UTF-8 bytes of a JSON `MandalaLinkagePayload` (`app/src/lib/mandala/encoding.ts:16-23`):

```json
{
  "inputs":  [{ "index": 0, "linkage": SpecificLinkage }, ...],
  "outputs": [{ "index": 0, "linkage": SpecificLinkage }, ...],
  "admin":   [{ "index": 1, "actionDetails": MandalaActionDetails }, ...]   // optional
}
```

`SpecificLinkage` (`encoding.ts:5-14`) = `{ prover, verifier, counterparty, protocolID: [2,"mandala token"], keyID, encryptedLinkage: number[], encryptedLinkageProof: number[], proofType }` — the verbatim result of `wallet.revealSpecificKeyLinkage({ counterparty, verifier: OVERLAY_IDENTITY_KEY, protocolID: FT_PROTOCOL, keyID })` (`app/src/lib/mandala/tokens.ts:49-59`).

Per-flow payload shapes:
- **register** (genesis): `{ inputs: [], outputs: [], admin: [{index:0, actionDetails}] }` (`app/src/lib/mandala/issuerOps.ts:61-66`)
- **issue**: `{ inputs: [], outputs: [{index:0, linkage}], admin: [{index:1, actionDetails}] }` (`issuerOps.ts:163-167`)
- **redeem**: `{ inputs: [], outputs: [FT-change linkage at index 1, if change>0], admin: [{index:0, actionDetails}] }` (`issuerOps.ts:263-272`)
- **transfer**: `{ inputs: [one linkage per FT input, index = input position], outputs: [recipient + every change output linkage at real (shuffled) vouts] }` — no `admin` key (`app/src/lib/mandala/transfer.ts:148-161`)
- **admin actions / reissue**: `{ inputs: [], outputs: [FT linkage at 0 iff reissue], admin: [{index: adminVout, actionDetails}] }` (`app/src/lib/mandala/assets.ts:244-252`)
- **global admin fan-out**: `admin: [{index:i, actionDetails[i]} for each asset]` (`assets.ts:315-319`)

**Response the app parses:** HTTP 200 with JSON STEAK: `Record<topic, AdmittanceInstructions>` where `AdmittanceInstructions = { outputsToAdmit: number[], coinsToRetain: number[], coinsRemoved?: number[] }` (`app/node_modules/@bsv/sdk/dist/types/src/overlay-tools/SHIPBroadcaster.d.ts:17-39`). The app reads only `steak['tm_mandala']?.outputsToAdmit` (`app/src/lib/mandala/overlay.ts:16`).

**Error handling the app expects** (`SHIPBroadcaster.js:38-43`, `overlay.ts:16-17`, `overlay.ts:58-73`):
- Non-2xx → SDK throws generic `'Failed to facilitate broadcast'` (**response body is discarded** — error messages in the body never reach the app).
- 200 with empty/missing `outputsToAdmit` for `tm_mandala` → app throws `'overlay rejected the transaction'`.
- Either failure ⇒ `submitAndBroadcast` calls `wallet.abortAction({reference})` to release inputs (`overlay.ts:61-72`); success ⇒ journaled, then broadcast via `wallet.createAction({ options: { sendWith:[txid] } })` in the background (`overlay.ts:26-31,79-87`). **So a rejection MUST be either non-2xx or an empty-admit STEAK; a rewrite must never return 200 + non-empty admit for a tx it didn't fold in.**
- TS reference server behavior: rejects with `400 {"status":"error","message":...}` (`OverlayExpress.ts:1494-1500`); reads topics from lowercase `x-topics` header, throws if missing (`OverlayExpress.ts:1465-1470`).
  - *Note (2026-10-01, BRC-162 P0):* the line numbers above are from the pre-2.7.3 overlay-express of the original port. On overlay-express 2.7.3 the route's catch-all masks every non-public error message as `"Request could not be processed"`, and `x-topics` also accepts a comma-separated list. Mandala's `/submit` wrapper rewrites that answer into the wire contract v2 taxonomy (`{status, code, retryable, description, spendTxid?}`), and manager verdicts reach it through the side channel, not the message. So the masking changes only `description` text (an infrastructure 503 may now read "Request could not be processed"), never codes (wire contract v2.3 §11.5).

---

## 2. `POST /lookup` — asset metadata resolution (only lookup query the app makes)

**Client path:** `resolveAssetMetadata()` (`app/src/lib/mandala/metadata.ts:25-45`): `new LookupResolver({ networkPreset: 'mainnet', hostOverrides: { ls_mandala: [OVERLAY_URL] } })` then `resolver.query({ service: 'ls_mandala', query: { metadataAssetId: assetId } })`. `hostOverrides` pins the host list to exactly `[OVERLAY_URL]` (`LookupResolver.js:278-279`) — **no SLAP tracker traffic for this service**.

⚠️ `networkPreset: 'mainnet'` means the lookup facilitator is constructed with `allowHTTP = false` (`LookupResolver.js:208`), so `OVERLAY_URL` **must be `https:` for lookups** (unlike submit, which passes `allowHTTP: true`). The facilitator throws before any request otherwise (`LookupResolver.js:110-112`).

**Request** (`HTTPSOverlayLookupFacilitator.performLookupRequest`, `LookupResolver.js:133-150`):
- URL: `${OVERLAY_URL}/lookup`, method `POST`
- Headers: `Content-Type: application/json`, `X-Aggregation: yes`
- Body: `JSON.stringify({ service: "ls_mandala", query: { metadataAssetId: "<txid>.<vout>" } })`
- Client-side timeout: **2000 ms** default (`LookupResolver.js:109`), AbortController + hard deadline race; timeout → `Error('Request timed out')`.

**Response — two accepted encodings**, switched on the response `Content-Type` (`LookupResolver.js:146-149`, base-type match ignoring params, `LookupResolver.js:92-97`):

1. **Aggregated binary** (what the TS server returns when `x-aggregation: yes`; `OverlayExpress.ts:1512-1562`) — `Content-Type: application/octet-stream`:
   ```
   varint  nOutpoints
   repeat nOutpoints times:
     32 bytes  txid  — tx.id(): double-SHA256 REVERSED, i.e. bytes hex-encode
                        directly to the display txid (Transaction.js:707-714)
     varint    outputIndex
     varint    contextLength   (0 if none)
     bytes     context         (contextLength bytes)
   bytes  merged BEEF of all listed transactions (Beef.toBinary())
   ```
   Client parse (`LookupResolver.js:152-187`): reads outpoints, `Beef.fromBinary(rest)`, then per outpoint `beefObj.toBinaryAtomic(txid)` → each output becomes `{ outputIndex, context, beef: <AtomicBEEF bytes>, txid }`. The merged BEEF must therefore contain every listed txid (with its ancestry/merkle paths) or `toBinaryAtomic` throws and the whole answer fails.

2. **JSON fallback** (no aggregation): body must be a `LookupAnswer`: `{ "type": "output-list", "outputs": [{ "beef": number[], "outputIndex": number, "context"?: number[] }] }` (`LookupResolver.d.ts:19-27`, server JSON branch `OverlayExpress.ts:1527-1529`).

**Resolver post-processing the contract must satisfy** (`LookupResolver.js:239-259,320-321,588-598`): answer must have `type === 'output-list'` and an `outputs` array or the host is recorded as failed; outputs are deduped by `txid.outputIndex`; `query()` returns `{ type:'output-list', outputs }`.

**What the app then does with each output** (`metadata.ts:31-39`): `Transaction.fromBEEF(out.beef)` (AtomicBEEF), **SPV-verifies via WhatsOnChain('main')** (separate non-overlay network call — so the returned BEEF must carry real merkle paths on mainnet), takes `out.outputIndex` (falls back to the vout parsed from the assetId), decodes `MandalaAdmin` publicData from that output's locking script (`metadata.ts:10-21`). Any throw / no match → metadata `null`, memoized (`metadata.ts:40-44`).

**Error handling:** non-2xx → `Failed to facilitate lookup (HTTP <status>)` (`LookupResolver.js:144-145`); all errors swallowed to `null` in the app.

---

## 3. Bespoke JSON admin endpoints (plain `fetch`, GET, no headers beyond defaults)

All five are CORS-dependent (browser origin ≠ overlay origin). TS server sets `Access-Control-Allow-Origin: *` per-route (`overlay/src/index.ts:82,94,121,156,179`) plus the global wildcard CORS middleware with `OPTIONS` → `200` short-circuit (`OverlayExpress.ts:1318-1329`).

### 3a. `GET /admin/asset-state/{assetId}` (URL-encoded path segment)
`app/src/lib/mandala/adminState.ts:22`. Response JSON parsed as:
```ts
{ assetId, issuerIdentityKey, isPaused: boolean, accessMode: 'denylist'|'allowlist',
  blockedIdentities: string[], allowedIdentities: string[],
  frozenOutpoints: [{ outpoint, amount, owner }], evictedOutpoints: string[] }
```
(`adminState.ts:3-12`). Errors: non-ok or throw → `null`, cached 10 s per assetId (`adminState.ts:14-26`). Server: `sharedStorage.getAssetState()` → `res.json(state)`, 500 `{error}` on throw (`overlay/src/index.ts:81-91`).

### 3b. `GET /admin/admin-history/{assetId}` (full export, unpaged)
`app/src/lib/mandala/adminHistory.ts:16`. Response: **JSON array** of rows
`{ assetId, txid, outputIndex, height, offset, actionDetails: MandalaActionDetails }` (`adminHistory.ts:18-25`). Non-ok or throw → `[]` (`adminHistory.ts:17,34-36`).

### 3c. `GET /admin/admin-history-page/{assetId}?limit=<n>&offset=<n>`
`adminHistory.ts:44-48`. `limit` defaults 100, `offset` 0 (always sent). Response: same row array, newest-first by `admitSeq`; server clamps limit to [1,500], strips Mongo `_id` (`overlay/src/index.ts:159-166`). Non-ok / non-array / throw → `[]` (`adminHistory.ts:49-54`).

### 3d. `GET /admin/admin-summary/{assetId}`
`adminHistory.ts:70`. Response: `{ totalIssued: number, totalRedeemed: number, actionCount: number }` — app coerces each with `Number(x) || 0` (`adminHistory.ts:72-77`). Semantics: sums of `actionDetails.amount` grouped by `actionDetails.kind`, counting **only** `'issue'` and `'redeem'` for the totals (`'reissue'` excluded), `actionCount` = all kinds (`overlay/src/index.ts:182-193`). Non-ok / throw → `null`.

### 3e. `GET /admin/activity?assetId=<id>&limit=<n>&before=<cursor>`
`app/src/lib/mandala/overlayActivity.ts:39-52`. Query params: `assetId` omitted when empty; `limit` always sent (default **100**, `overlayActivity.ts:37,45`); `before` only on subsequent pages — it is the `nextCursor` string from the previous page, an **inclusive** cursor (server queries `createdAt <= new Date(before)`, `overlay/src/index.ts:127-128`), so the app dedupes across pages by txid, first occurrence wins (`overlayActivity.ts:59-70`). Response:
```ts
{ entries: [{ txid, when: string, assetId, kind: 'issue'|'transfer'|'self'|'redeem',
              from: string|null, to: string|null, amount: number,
              proofs: [{ outputIndex, identityKey, keyID, counterparty, proofType: number }] }],
  nextCursor: string | null }
```
(`overlayActivity.ts:10-35`). Error handling: **non-ok throws** `activity fetch failed: <status>` (surfaces through react-query with its retries, `app/src/hooks/useOverlayActivity.ts:12-23`); null body / missing `entries` array → `{entries:[], nextCursor:null}` (`overlayActivity.ts:48-51`).

---

## 4. Server-side invariants a Go rewrite must reproduce

- **Routing/verbs:** `POST /submit`, `POST /lookup`, `GET /admin/{asset-state,admin-history,admin-history-page,admin-summary}/{assetId}`, `GET /admin/activity`. AssetIds arrive URL-encoded (`encodeURIComponent`, contain a literal `.` — e.g. `txid.0`).
- **Headers read case-insensitively:** `x-topics` (JSON array, required on submit), `x-includes-off-chain-values === 'true'`, `x-aggregation === 'yes'` (`OverlayExpress.ts:1465-1466,1513-1514`).
- **CORS:** wildcard `Access-Control-Allow-Origin/Headers/Methods/Expose-Headers: *`, `Access-Control-Allow-Private-Network: true`, `OPTIONS` preflight answered `200` (`OverlayExpress.ts:1318-1329`) — mandatory or every browser call fails preflight (custom headers on both POSTs).
- **Body parsing:** `application/octet-stream` raw and `application/json`, limits 1 GB (`OverlayExpress.ts:1310-1311`).
- **Submit success = 200 + STEAK JSON** whose `tm_mandala.outputsToAdmit` is non-empty exactly when the tx was folded into state; **rejection = 4xx/5xx (body ignored) or empty-admit STEAK**. Overlay must accept **before** the app broadcasts to the network (overlay-first ordering; the reference deployment has the overlay itself broadcast via Arcade before folding, `overlay/src/index.ts:34-47`).
- **Lookup binary txid byte order:** display order (reversed hash) — bytes must hex to the txid string, and the trailing merged BEEF must round-trip `Beef.fromBinary` + `toBinaryAtomic(txid)` for every listed txid, with merkle paths valid against mainnet (client SPV-verifies via WhatsOnChain).
- **`/lookup` request validation:** body must have string `service` + defined `query`, else 400 (`OverlayExpress.ts:1517-1523`); the only query shape used is `{ metadataAssetId: string }` against `ls_mandala`, and it must return the genesis output.

**Not overlay traffic** (for completeness): WhatsOnChain SPV verification (`metadata.ts:35`), MessageBox client at `MESSAGEBOX_URL` (`constants.ts:12`, `assets.ts:255-261`, `transfer.ts` notify), and all `wallet.*` calls (local wallet substrate). `history.ts`/`reconcile.ts`/`banking.ts` make **no** overlay HTTP calls (wallet-only / pure).
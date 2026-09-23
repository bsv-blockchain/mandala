# Issuer-paid transaction fees ("fuel pairs") — design spec

Date: 2026-09-22. Status: DEFINITIVE — maintainer decisions in §11 are settled;
implementation phases in §12. Revision 2, after an adversarial review (three
lenses, 27 findings, 23 confirmed against code; §13 lists what changed).
Companions: `2026-09-15-mandala-wire-contract-v2.md` (amended by §3 of this
document), `2026-09-15-mandala-offline-settlement-design.md`.

Path legend: `L/` = `/Users/personal/git/demos/mandala/lib/src/`,
`O/` = `/Users/personal/git/demos/mandala/overlay/src/`,
`OG/` = `/Users/personal/git/demos/mandala/overlay-go/internal/`,
`FK/` = `/Users/personal/git/demos/mandala/fuelkeeper/` (new Go module),
`W/` = `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/core/mandala/`,
`WT/` = `/Users/personal/git/bsv-wallet/node_modules/@bsv/wallet-toolbox-mobile/out/src/`,
`GWT/` = `/Users/personal/git/go/go-wallet-toolbox/` (at or after commit
`f53f8caf`, which ships `pkg/wallet/fuelkeeper`),
`TPL/` = `/Users/personal/git/ts-stack/packages/helpers/ts-templates/src/`.

All file:line citations were read from the trees on 2026-09-22.

## 0. Summary

A holder with no BSV can pay the network fee of a token transfer in the token
itself. The payer, while online, asks the overlay for a **fuel pair draft**: a
skeleton transaction whose input *i* is one of the issuer's pre-minted fuel
outputs, already signed `SIGHASH_SINGLE|ANYONECANPAY|FORKID`, and whose output
*i* is a MandalaToken output paying the fee to the issuer. The payer appends
its own token inputs and outputs, signs them as today (plain `SIGHASH_ALL`),
and submits. The txid is final at build time, so every existing mechanism —
σ_I, journals, hand-over bodies, COVER, `/submit` idempotency, eviction — is
untouched.

Goals: (1) no BSV balance required for a holder send; (2) no change to the
settlement/evidence model; (3) reuse go-wallet-toolbox's fuel pool machinery
verbatim; (4) TS ≡ Go on every new wire shape; (5) bulletproof under the
stability mandate (crash at every await, double submit, second tab, overlay /
keeper divergence, replicas).

Non-goals (v1): issuer operations (issue/redeem/reissue/admin/registry) keep
paying BSV; offline sends keep paying BSV from the wallet's own balance; no fuel
cache on devices; no multi-issuer pools; no threshold admin.

Guiding rule for every fuel-state decision below: **fuel is cheap, a wrongly
reused fuel output is not.** When in doubt a row stays locked and a sweeper
with proof frees it; nothing is ever released on an ambiguous outcome.

### 0.1 Why not "overlay adds inputs after submit"

The original proposal (token inputs `ANYONECANPAY`, overlay appends a funding
input at `/submit`, returns it to the submitter) was rejected on code facts:

- wallet-toolbox `createAction` funds unconditionally
  (`WT/storage/methods/createAction.js` ~603-645 → `fundNewTransactionSdk` →
  `WERR_INSUFFICIENT_FUNDS`); an unfunded tx cannot come out of the wallet
  without bypassing action bookkeeping.
- An unfunded token tx is *negative in satoshis* (1-sat outputs outnumber 1-sat
  inputs); both engines' SPV verify reject `outputTotal > inputTotal`
  (`@bsv/sdk Transaction.ts:957-968`), so funding would have to be a pre-engine
  body rewrite (TS: raw-body shadow `/submit`, because OverlayExpress installs
  its body parser inside `start()`).
- The txid changes after funding. σ_I would sign `txid_post`; the client's
  `requireVerifiedAdmission` (`L/overlay.ts:275-295`) verifies against the
  submitted beef and would throw after the overlay broadcast — the phantom-state
  class of the 2026-09-21 incident. Every journal, blinding, notify and hand-over
  key is `txid_pre`.
- `ANYONECANPAY` token signatures let any bytes-holder fund and broadcast a
  different variant; eviction would then restore inputs that are spent on-chain.
- Offline chaining of a fee-paid tip is impossible while its txid is provisional.

## 1. The fuel pair

### 1.1 Skeleton

```
version   = 1
lockTime  = 0
inputs[i] = { outpoint: fuel_i, sequence: 0xffffffff,
              unlockingScript: <sig SINGLE|ANYONECANPAY|FORKID (0xC3)> <pubkey> }   i ∈ [0,k)
outputs[i]= { satoshis: 1, lockingScript: MandalaToken.lock(assetId, F, issuerFeePkh_i) }  i ∈ [0,k)
```

`SIGHASH_SINGLE|ANYONECANPAY` commits input *i* to: its own outpoint, amount,
subscript and sequence; output *i* (value + script); `version`; `lockTime`
(`@bsv/sdk TransactionSignature.format`: `hashPrevouts`, `hashSequence` zeroed,
`hashOutputs` = hash of output *i*). It commits to nothing else. The payer may
append any inputs after index k-1 and any outputs after index k-1, and may
drop trailing pairs, but never reorder.

The fuel signature is a **bearer instrument**: whoever holds the signed
skeleton can spend fuel *i* in any tx whose output *i* is the committed fee
output. See §10.

Wallet-toolbox preserves caller input order (`WT/signer/methods/buildSignableTransaction.js:76-96`,
user inputs first by `vin`, allocated change after) and, with
`randomizeOutputs:false`, caller output order with change appended
(`WT/storage/methods/createAction.js:353`). Defaults `version 1`, `lockTime 0`
(`@bsv/sdk validationHelpers.js:367-368`) match the skeleton.

Token inputs keep plain `SIGHASH_ALL|FORKID` via `walletMandalaUnlock`
(`L/unlock.ts:42-72`, `anyoneCanPay=false`).

### 1.2 Fee output key

The fee output is byte-identical to an ordinary payer→issuer transfer output:

- fuelKeeper computes `pkh = hash160(getPublicKey({ protocolID: FT_PROTOCOL,
  keyID, counterparty: requester, forSelf: true }))` and builds the script with
  the 8-chunk MandalaToken layout (`TPL/MandalaToken.ts:62-78`; Go
  `OG/mandala/token.go:150-184` `LockToken`). **Not `lockBRC29`** — that
  derives the *counterparty's* child key (`TPL/MandalaToken.ts:17-23`,
  `forSelf` never passed) and would lock the fee to the payer.
- The payer produces the linkage with `revealLinkage(wallet, keyID, issuerIdentityKey)`
  (`L/tokens.ts:49-58`), exactly as for a change output. The overlay
  reconstructs `counterpartyPub + L·G` and credits `identityKey =
  linkage.counterparty` (`@bsv/overlay-topics dist/mandala/verifyKeyLinkage.js:2-22`;
  `OG/mandala/linkage.go:50-90`) — the issuer.
- The issuer spends with `walletMandalaUnlock(issuerWallet, keyID, requester)`.
- `keyID = "fee-" + fuelOutpoint`, chosen by the keeper; the payer cannot
  influence it.

Unauthenticated requests are refused (§3.1); there is no `'self'` fallback.

### 1.3 Economics

Config (fuelKeeper; mirrored read-only on the overlay via `GET /fuel/info`):

| name | default | meaning |
|---|---|---|
| `D` | 200 sat | fuel denomination (= throughput `denomination_satoshis`) |
| `BSV_RATE` | 100 sat/kB | rate the fuel is sized for; MUST be ≥ the payer wallet's fee model (wallet-toolbox default 100, `W/../context/WalletContext.tsx:1281`) |
| `K_MAX` | 4 | max pairs per draft |
| `N_MAX` / `M_MAX` | 20 / 10 | request bounds |
| `TTL` | 600 s | reservation window |
| `RESERVING_TTL` | 60 s | claim-to-sign window (§4.3) |

Per-asset parameter (§2): `feeRatePerKb` — token base units per 1000 bytes.

```
coveredBytes = floor(D * 1000 / BSV_RATE)                      // 2000 for defaults
F            = ceil(feeRatePerKb * coveredBytes / 1000)         // tokens per pair
```

The fee is prepaid per pair; the actual tx may be smaller than k·coveredBytes.

Sizing a draft — request carries `n` (token inputs) and `m` (token outputs
the payer will add: recipient + change):

```
estSize(k)    = 10 + 150*n + 148*k + 85*(m + k) + 34
satDeficit(k) = (m + k) - n
changeDust    = 2 * ceil(192 * BSV_RATE / 1000)                // 40 at defaults
need(k)       = ceil(estSize(k) * BSV_RATE / 1000) + satDeficit(k) + changeDust
k             = min { k ≥ 1 : k*D ≥ need(k) }, refused if k > K_MAX
```

Byte constants: tx overhead 10; token input 150 (41 + varint + 108 unlock
estimate, `L/unlock.ts:70`); fuel input 148 (41 + varint + ~107 P2PKH unlock);
token output 85 (upper bound of 73 + amount bytes); one toolbox BSV change
output 34. `estSize` MUST upper-bound wallet-toolbox's own `transactionSize()`
for the inputs the lib actually passes (§7.2 step 2).

`changeDust` is not optional. wallet-toolbox **never folds a positive excess
into the fee**: `generateChangeSdk` creates change outputs only at or above
`dustFloor = 2·ceil(192·rate/1000)` (`WT/storage/methods/generateChange.js:123-124`,
`:240-262`) and, when no BSV change input can be allocated and the excess is
positive with zero change outputs, throws `WERR_INSUFFICIENT_FUNDS`
(`generateChange.js:293-305`, `:339-342`). For a payer with no BSV that is
fatal and a retry cannot help (same shape). Reserving `changeDust` guarantees
one change output of at least the dust floor always fits.

Worked example (defaults, `feeRatePerKb = 10`): `n=1, m=3` → `estSize(1)=682`,
fee 69, deficit 3, dust 40, `need=112 ≤ 200` → `k=1`, `F = 20` tokens. The
payer's toolbox sees 200 sats in, 4 sats of token outputs + 69 fee; the excess
becomes one BSV change output to the payer. The lib MUST NOT depend on the
exact change amount.

All arithmetic is integer; TS uses `Number.isSafeInteger` guards, Go `uint64`
with overflow checks (per the 2026-09-21 `>2^53` incident).

### 1.4 What the overlay checks at `/submit`

Script validity of the fuel input already proves the pairing (a tx whose
output *i* differs from the signed one fails script verification in the
engine before any topic manager runs). The repo-local guard (§5.3/§6.3) adds:

1. input *i* is a known drafted fuel outpoint (recognizer, §3.4), matched to
   the draft row whose `feeScript` byte-equals `outputs[i].lockingScript` and
   `outputs[i].satoshis == 1`;
2. a durable fuel intent is written on the admission record (§3.4);
3. one batch `POST /consume {outpoints, txid}` on the keeper succeeds
   (all-or-nothing, §4.5).

No fee-amount or size re-check at submit time: the draft is authoritative. No
BSV sufficiency check: the engine enforces `out ≤ in`; miner policy applies at
broadcast. The guard does not pin which asset the tx moves: conservation is
per asset on both engines, so a fee output in asset X inside a tx moving asset
Y simply costs the payer X tokens for nothing.

## 2. Asset parameter `feeRatePerKb`

- `register` action details gain optional `feeRatePerKb: number` (integer ≥ 1
  base units; absent = disabled). It is committed in the keyID of the genesis
  admin lock (`TPL/MandalaAdmin.ts:104-160`) — a key the payload-named
  counterparty can also derive, so this is **not** authentication (§2.1).
  Also copied into `publicData` for display.
- New admin kind `setFeeRate` with `{ kind: 'setFeeRate', feeRatePerKb: number | null }`
  (`null` disables), submitted through `submitAdminAction` (`L/assets.ts:242-358`).
  Neither engine whitelists kinds: TS `verifyAdminOutput` admits any anchored
  kind with a matching pkh (`@bsv/overlay-topics MandalaTopicManager.js:86-123`),
  Go `FoldAction` falls through unknown kinds (`OG/mandala/reducer.go:73-121`).
- **Go fold (native):** `AssetAdminState.FeeRatePerKb *int64`
  (`OG/mandala/reducer.go:14-26`, nil in `DefaultAssetState` :35-41);
  `case "register"` reads `details.Num("feeRatePerKb")`; `case "setFeeRate"`
  sets/clears it. `assetStateHandler` (`OG/httpapi/admin.go:297-317`)
  serializes the struct, so the field appears on `GET /admin/asset-state/:assetId`.
- **TS fold (repo-local):** the pinned reducer ignores unknown kinds and
  `register` copies only `issuer` (`AssetStateReducer.ts:56-61`). A wrapper on
  the lookup service's `outputAdmittedByTopic` folds `register.feeRatePerKb`
  and `setFeeRate` into `mandalaFeeRates { assetId (unique), feeRatePerKb,
  setByOutpoint, admitSeq }`; `GET /admin/asset-state/:assetId` merges it like
  `withFrozenRowFlags` (`O/index.ts:436-446`, `O/assetAuth.ts:113-122`). The
  fold applies only to outputs that decode as `MandalaAdmin` (as the pinned
  service and Go's `DecodeAdmin` gate do). Eviction does NOT roll the rate
  back: neither engine rolls admin state (pause, freeze, rate) back on
  eviction today and the pinned TS service never deletes admin history, so a
  recompute would resurrect evicted rates (P1 review, 2026-09-22). An upstream ts-stack PR (kind union in
  `TPL/MandalaAdmin.ts:25-38`, reducer field + handler) is desirable, NOT a
  blocker (PR only, per the ts-stack workflow).
- Lib: `RegisterParams.feeRatePerKb?: number` (`L/issuerOps.ts:30-36`),
  `AssetAdminStateView.feeRatePerKb?: number | null` (`L/adminState.ts:3`),
  `setFeeRate(asset, feeRatePerKb | null)` over `submitAdminAction`.
- One-submit lag applies as for every admin action.

### 2.1 Eligibility is an operator allowlist, not the asset's issuer field

`register` is not authenticated on either engine today: it skips admin-chain
anchoring (`O/adminChainGuard.ts:88`, `OG/mandala/topic_manager.go:519`) and
the admin lock pkh is re-derived against the payload-supplied
`details.counterparty` (`MandalaTopicManager.js:99-104`, `OG/mandala/adminwallet.go:44-52`),
so any third party can register an asset whose `details.issuer` names the
operator's key and whose `feeRatePerKb` is 1. Therefore:

- Overlay env and keeper config both carry `FUEL_ASSET_IDS` — a comma-separated
  list of genesis outpoints. A draft is issued only when `assetId ∈ FUEL_ASSET_IDS`
  AND the folded `feeRatePerKb != null` AND the asset is not paused. The
  operator adds an asset only after confirming its genesis tx came from its
  own wallet. `assetState.issuerIdentityKey == FUEL_ISSUER_KEY` remains a
  secondary sanity check, never the gate.
- **P0 (prerequisite, both engines):** reject any `register` whose details
  carry a non-empty `assetId` (TS `O/adminChainGuard.ts:88` →
  `details.assetId === undefined || details.assetId === ''`, parity with
  ts-stack master `MandalaTopicManager.ts:202`; Go `topic_manager.go:519` and
  `:567`), and key a register's history/state rows by its own outpoint. This
  closes the "re-register an existing asset" variant of the forgery; it does
  not make `register` authenticated, which is why the allowlist stays.

## 3. Wire contract additions (binding, TS ≡ Go) — wire-contract v2.2

### 3.1 `POST /fuel/draft`

Request:
```json
{ "assetId": "<hex>", "n": 1, "m": 3,
  "requester": "<66 hex identity key>", "nonce": "<32 random bytes hex>", "ts": 1758500000,
  "sig": "<DER hex>" }
```
```
msg = utf8("mandala-fuel-draft:" + assetId + ":" + n + ":" + m + ":" + requester + ":" + nonce + ":" + ts)
sig = wallet.createSignature({ protocolID: [1, 'mandala fuel'], keyID: nonce, counterparty: 'anyone', data: msg })
```
Signing with counterparty `'anyone'` makes the signature verifiable by any
party from public data: the overlay AND the keeper each verify it with a
`ProtoWallet('anyone')` (`@bsv/sdk KeyDeriver.js:19-20`; go-sdk
`wallet.NewKeyDeriver(nil)` → `AnyoneKey()`, `key_deriver.go:38-45`) calling
`verifySignature({ protocolID, keyID: nonce, counterparty: requester, data: msg, signature })`.

Verification succeeds only on a positive result. TS: the call resolves with
`valid:true`; any throw (`ERR_INVALID_SIGNATURE`, DER parse, derivation) is
`ERR_FUEL_AUTH`. Go: `err == nil && res != nil && res.Valid`; go-sdk returns
`Valid:false` with a nil error on a bad signature (`proto_wallet.go` ~253-272),
so an err-only check is a forgery bypass. Parse boundary, checked first as
`ERR_SHAPE` on both engines: `requester` is 66 hex chars decoding to a valid
compressed point; `sig` parses as DER; `nonce` is 64 hex.

Rejections, in order (first wins); body `{status:"error", code, retryable, description}`:

| code | HTTP | retryable | when |
|---|---|---|---|
| `ERR_FUEL_DISABLED` | 404 | false | overlay has no `FUELKEEPER_URL`, or the registry is not active (fee mode requires admitted identities) |
| `ERR_SHAPE` | 400 | false | malformed body / parse boundary; `\|ts − now\| > 300 s`; `n ∉ [1, N_MAX]`; `m ∉ [1, M_MAX]` |
| `ERR_FUEL_AUTH` | 401 | false | signature invalid, or `nonce` already used (overlay `mandalaFuelNonces` unique hit) |
| `ERR_MEMBERSHIP` | 409 | true | requester not registry-admitted (`O/registry.ts:64-67`; `OG/mandala/registry.go:74-95`) |
| `ERR_FUEL_INELIGIBLE` | 409 | true | `assetId ∉ FUEL_ASSET_IDS`, `feeRatePerKb` null, or asset paused |
| `ERR_FUEL_DENIED` | 403 | false | keeper deny list (§4.8): a fuel output this requester held went `spent_external` |
| `ERR_FUEL_QUOTA` | 429 | true | keeper: outstanding `reserved` drafts ≥ `FUEL_MAX_OUTSTANDING` (default 2), or pairs in the last 24 h ≥ `FUEL_DAILY_PAIRS` (default 20) |
| `ERR_FUEL_TOO_LARGE` | 400 | false | `k > K_MAX` |
| `ERR_FUEL_UNAVAILABLE` | 503 | true | keeper unreachable, global `FUEL_PAIRS_PER_MIN` exceeded, pool empty, no proven fuel, or overlay recognizer write failed (after a best-effort keeper release) |

Response 200:
```json
{ "requestId": "<nonce>", "assetId": "<hex>", "k": 1, "feePerPair": "20",
  "expiresAt": 1758500600,
  "draftTx": "<hex, skeleton with k inputs + k outputs, fuel inputs signed>",
  "fuelBeef": "<hex BEEF: every fuel source tx with its BUMP>",
  "pairs": [ { "vin": 0, "vout": 0, "fuelOutpoint": "<txid.vout>", "fuelSatoshis": 200,
               "keyID": "fee-<txid.vout>", "counterparty": "<issuer identity key>",
               "feeScript": "<hex>", "feeAmount": "20" } ] }
```
Amounts are decimal strings.

### 3.2 `GET /fuel/info` (public)

`200 { enabled, issuerIdentityKey, assetIds, denomination, bsvRatePerKb, kMax, nMax, mMax,
ttlSeconds, maxOutstanding, dailyPairs }`; `enabled:false` alone when no keeper
is configured.

### 3.3 `POST /fuel/release`

Request `{ requestId, requester, ts, sig }`,
`sig = createSignature({ protocolID:[1,'mandala fuel'], keyID: requestId, counterparty:'anyone',
data: utf8("mandala-fuel-release:" + requestId + ":" + requester + ":" + ts) })`, verified as in
§3.1 (±300 s; replay is harmless, release is idempotent).

- Rows for `requestId` absent or owned by another requester → `404 ERR_FUEL_UNKNOWN`
  (same body for both cases).
- Otherwise: recognizer rows of that draft with no `consumedTxid` get
  `releasedAt` (compare-and-swap; rows are never deleted — §5.3 still needs
  them for a late submit), then keeper `POST /release {requestId}`, which
  only moves rows still `reserved` under that request (§4.5); consumed rows
  are untouched, so a release racing a successful submit is a no-op.
- `200 { released: <count> }`; keeper unreachable → `503 ERR_FUEL_UNAVAILABLE`
  (TTL is the backstop); no keeper configured → `ERR_FUEL_DISABLED`.

### 3.4 `/submit` verdict row and records

| code | HTTP | retryable | persisted | when |
|---|---|---|---|---|
| `ERR_FUEL` | 400 | false | **never** (re-derived from live keeper state per submit, like `ERR_INPUT_SPENT` §9.2) | a drafted fuel outpoint is spent by this tx and (a) no draft row's `feeScript` matches the paired output, or (b) the batch `/consume` refused (`consumed by another txid`, `reserved by another request`, `unknown`) |

Manager reason strings (byte-identical), matched by the substring
`"fuel input"` inserted at the head of the reason tables
(`O/submitVerdict.ts:102-113`; `OG/httpapi/verdict.go:95-114`):
```
fuel input <i>: paired output is not the drafted fee output
fuel input <i>: consume refused: <keeperReason>
```
Keeper unreachable / 5xx / intent-write failure → `InfraError` → `503
ERR_UNAVAILABLE`, nothing consumed, nothing persisted (§9.5 fail-closed).
`ERR_FUEL` is never persisted because a draft that was re-issued and then
released again makes the same bytes admissible later (§4.5); a persisted
verdict would poison a valid resubmit. Clients treat it as final and rebuild.

Guard order (amends §9.6): unlinked-token → conflicting-spend → admin-chain
anchoring → **fuel** → topic manager.

**Admission record** (`O/admission.ts:176-203`; `OG/mandala/admissions.go:64-92`)
gains `fuel?: { outpoints: string[], settled: boolean, settledAt?: string }`.
It is written by the fuel guard **before** `/consume` as a durable intent
(upsert on `txid`, `$set: {fuel}`, `$setOnInsert: {txid, at, pending:true}`,
never touching `pending`/`admissionSignature`/`restore` of an existing row;
a write failure is `InfraError` → 503 with nothing consumed). Both engines'
finalize writers include `fuel` explicitly in their `$set` lists when present
(`O/index.ts:138-165` `putAdmitted`; Go `RecordAdmission`). Only a dedicated
`markFuelSettled(txid)` (`updateOne({txid,'fuel.settled':false}, {$set:{'fuel.settled':true,'fuel.settledAt':now}})`)
flips the flag.

**Recognizer** `mandalaFuelDrafts` (both engines, Mongo):
`{ _id: outpoint + ':' + requestId, outpoint, requestId, requester, assetId, feeScript, keyID,
expiresAt, createdAt, consumedTxid?, releasedAt? }`, non-unique index on
`outpoint`, index on `requestId`. Written with an idempotent upsert
(`$setOnInsert`), so a re-draft of a released outpoint never collides and a
retried draft is a no-op. **No TTL**: the recognizer is the only fuel gate; a
row is deleted only by a GC job after the keeper reports that outpoint
terminal (`spent_external`, or `consumed` with `settled_at`) and 7 days have
passed. Row count is bounded by the keeper's reservation table.
`mandalaFuelNonces { _id: nonce, createdAt }` has a 24 h TTL index.
Index creation failure aborts startup (§9.9 pattern).

### 3.5 Amendment to §9.13 (hand-over-first)

A send in fee mode (`feeMode:'issuer'`) is **submit-first**: the payer submits
while online, then hands over. The recipient's body carries `admission` for the
tip (FIX H field, `L/transfer.ts:421-430`) and credits via COVER as for any
legacy v1 body. Reason: the reservation is consumed at the payer's `/submit`
within seconds; a hand-over-first fee-mode send could sit unsubmitted on an
offline recipient past the reservation window (§11 D3). All non-fee sends stay
hand-over-first.

### 3.6 `GET /admin/asset-state/:assetId`

Gains `feeRatePerKb: number | null` (§2).

## 4. fuelKeeper service (`FK/`, new Go module)

### 4.1 Reuse map

| need | reused from go-wallet-toolbox (verbatim) |
|---|---|
| pool maintenance | `pkg/wallet/fuelkeeper` — `New(wallet, FromThroughput(cfg, D), logger).Run(ctx)` (`GWT/pkg/wallet/fuelkeeper/keeper.go:164-183`, mint loop :246-496) |
| storage + strategy | `pkg/infra` storage server with `utxo_management.strategy: throughput`, `denomination_satoshis: D`, `pool_basket: fuel`, `reserve_basket: reserve`, pool target from `target_tps × expected_confirmation_seconds` (`GWT/pkg/defs/utxo_management.go:63-103`) |
| wallet with issuer key | `wallet.New(network, <issuer root key>, storageClient, ...)`; `syncwallet.New` as in `GWT/cmd/throughput_dashboard/main.go:75-111` |
| fuel row lookup | `WalletStorageProvider.FindOutputsAuth` (`GWT/pkg/wdk/storage.interface.go:91-93`) → `DerivationPrefix/Suffix`, `LockingScript`, `Spendable`, `SpentBy` |
| signing a fuel row | `pkg/brc29.Unlock(PubHex(issuerIdentity), KeyID{prefix,suffix}, keyDeriver, WithSigHash(&f))`, `f = sighash.SingleForkID \| sighash.AnyOneCanPay` (`GWT/pkg/brc29/brc29_template.go:139-171`, `brc29_opts.go:27-30`) |
| detaching a row from the funder | `RelinquishOutput` (`GWT/pkg/wallet/wallet.go:691-718` → `UnlinkOutputFromBasketByOutpoint`, own gorm transaction, `GWT/pkg/internal/storage/repo/outputs.go:239-296`) |
| crediting the fee | `InternalizeAction` basket insertion with `CustomInstructions`/`Tags` (`GWT/pkg/storage/internal/actions/internalize.go:609-628`); requires **AtomicBEEF** with full ancestry (`internalize.go:91,103`) |
| chain check | `services.IsUtxo(ctx, scriptHash, outpoint)` with `scriptHash = HashOutputScript(fuelScript)` (WhatsOnChain script-hash UTXO endpoint; ARC has no UTXO lookup) |
| fee script | 8-chunk MandalaToken layout reproduced in `FK/token` (overlay-go's `internal/` is not importable and pins go-sdk 1.2.24); parity test against `overlay-go/testdata/vectors.json` `tokenScripts` |
| request verification | go-sdk `ProtoWallet` over `AnyoneKey()` (§3.1) |

Facts that shape the design: fuel rows are ordinary storage change with a
fresh derivation per output (`GWT/pkg/storage/internal/actions/create.go:1029-1048`)
— there is no fixed fuel pkh, hence the recognizer. `InternalizeAction` never
marks the wallet's own inputs spent (`internalize.go:76-332`) — hence the
reservation table is authoritative. Under the throughput strategy the issuer
wallet's *own* actions (console issue/admin, keeper fan-outs) also fund from
the pool (`create.go:275-290`), selecting lowest `(satoshis, id)` first and
marking `spendable=false, spent_by` in one DB transaction — hence the
claim/verify protocol in §4.3.

### 4.2 Process

One binary: (1) `infra.NewServer` storage server (BRC-104, BRC-103 auth) on
`FK_STORAGE_PORT`; (2) an in-process wallet client with the issuer root key
(`ISSUER_ROOT_KEY`, SSM) connected to that server over loopback; (3) the
keeper goroutine; (4) the Mandala HTTP API on `FK_API_PORT` (≥1025), guarded
by `FK_API_KEY` (header `X-Fuel-Key`, constant-time compare) — only the
overlay calls it; (5) the sweeper goroutine. DB for the reservation tables:
the same engine as the storage (SQLite on a PVC for mandala-test, Postgres for
production), separate schema.

Toolchain: go 1.26.x, go-sdk 1.3.4, plus the three `replace` directives in
`GWT/README.md:124-136`. Separate module = no impact on overlay-go's pins.

Keeper config: `D`, `BSV_RATE`, `K_MAX`, `N_MAX`, `M_MAX`, `TTL`,
`RESERVING_TTL`, `FUEL_ASSET_IDS`, `FUEL_MAX_OUTSTANDING`, `FUEL_DAILY_PAIRS`,
`FUEL_PAIRS_PER_MIN`, `FK_OVERLAY_URL` + `FK_OVERLAY_ADMIN_TOKEN` (for §4.7
rule 4), throughput settings.

### 4.3 Draft signer (`POST /draft`)

Input (from the overlay): the verbatim §3.1 request body plus
`{ feeRatePerKb, issuerIdentityKey }` from the overlay's asset state. Steps:

1. **Verify independently.** Signature (§3.1, `ProtoWallet(anyone)`),
   `ts` window, `nonce` unused (`fuel_requests` PK), `assetId ∈ FUEL_ASSET_IDS`,
   deny list (§4.8). The keeper never relies on the overlay for identity or
   eligibility (§10: the overlay is trusted for fuel, not for identity).
2. **Quota**, inside one DB transaction serialized per requester (SQLite
   `BEGIN IMMEDIATE`; Postgres `pg_advisory_xact_lock(hashtext(requester))`):
   `COUNT(DISTINCT request_id) WHERE requester=? AND status='reserved' AND expires_at>now`
   ≥ `FUEL_MAX_OUTSTANDING` → `quota`; pairs created in the last 24 h ≥
   `FUEL_DAILY_PAIRS` → `quota`; global pairs in the last minute ≥
   `FUEL_PAIRS_PER_MIN` → `unavailable`. Insert `fuel_requests(nonce, requester, ts)`.
3. Compute `k`, `F` (§1.3); `too_large` if `k > K_MAX`.
4. **Pick candidates**: first from `released` rows with `needs_recheck=0`
   (oldest first), then `ListOutputs(basket: fuel)` rows whose source tx is
   proven (`FindOutputsAuth` → transaction status `completed`), taken from
   the high-id end (the storage funder takes the low end, which cuts
   collisions). Never unproven fuel: the payer's `inputBEEF` would need the
   fan-out ancestry. None → `no_proven_fuel`.
5. **Claim** (committed on its own): `INSERT INTO fuel_reservations
   (outpoint, status='reserving', request_id, requester, asset_id, fuel_script,
   satoshis, expires_at = now + RESERVING_TTL) ON CONFLICT(outpoint) DO NOTHING`,
   or CAS `released(needs_recheck=0) → reserving`. Rows-affected 0 → another
   draft holds it; pick another. No DB transaction stays open across storage
   or signing calls.
6. **Detach**: `RelinquishOutput({ output: outpoint, basket: "" })` (empty
   basket: with a basket name the call is not idempotent on rows already
   unlinked, e.g. re-drafted `released` rows).
7. **Verify**: `FindOutputsAuth(outpoint)` must return `spendable=true` and
   `spent_by IS NULL`. `RelinquishOutput` succeeds silently on a row the
   funder has already reserved (the UserUTXO delete is conditioned on
   `reserved_by_id IS NULL`), and the funder marks `spendable=false` when it
   allocates, so this read closes the race. Failure → CAS `reserving → dropped`
   (terminal; never reused) and pick a replacement from step 4. Fewer than k
   survivors after `K_MAX·2` attempts → CAS survivors `reserving → released,
   needs_recheck=1`, refuse `no_proven_fuel`.
8. For each pair: `keyID = "fee-" + outpoint`; fee pkh via
   `GetPublicKey({FT_PROTOCOL, keyID, counterparty: requester, ForSelf:true})`;
   `feeScript = LockToken(assetId, F, pkh)`.
9. Build the skeleton (§1.1); sign input *i* with
   `brc29.Unlock(..., WithSigHash(SINGLE|ANYONECANPAY|FORKID)).Sign(tx, i)`.
   Build `fuelBeef` from storage with BUMPs.
10. **Commit**: one DB transaction CAS each row `reserving → reserved` writing
    `fee_script, key_id, fee_amount, expires_at = now + TTL`. Respond.

Crash windows: before 5 — nothing claimed; between 5 and 10 — rows sit
`reserving` and the sweeper resolves them (§4.7 rule 0); after 10 but before
the overlay persisted its recognizer — the overlay answers 503 after a
best-effort `/release {requestId}`, else the TTL frees them.

### 4.4 Reservation tables

```
fuel_requests   ( nonce TEXT PRIMARY KEY, requester TEXT NOT NULL, ts INTEGER NOT NULL, created_at INTEGER NOT NULL )
fuel_denylist   ( requester TEXT PRIMARY KEY, reason TEXT, outpoint TEXT, created_at INTEGER NOT NULL )
fuel_reservations (
  outpoint        TEXT PRIMARY KEY,   -- "txid.vout"
  satoshis        INTEGER NOT NULL,
  fuel_script     TEXT NOT NULL,      -- hex locking script of the fuel output (for chain checks)
  request_id      TEXT,               -- nonce of the draft that holds it
  requester       TEXT,
  asset_id        TEXT,
  fee_script      TEXT, key_id TEXT, fee_amount TEXT,
  status          TEXT NOT NULL,      -- reserving | reserved | consumed | released | dropped | spent_external
  needs_recheck   INTEGER NOT NULL DEFAULT 0,
  txid            TEXT,               -- consuming txid once known
  expires_at      INTEGER NOT NULL,
  settled_at      INTEGER,
  created_at      INTEGER NOT NULL, updated_at INTEGER NOT NULL
)
INDEX (status, expires_at), INDEX (request_id), INDEX (txid), INDEX (requester, created_at)
```

### 4.5 State machine

```
reserving --commit (§4.3 step 10)----------------------------> reserved
reserving --verify failed----------------------------------> dropped                (terminal)
reserving --sweeper rule 0, detach+verify ok--------------> released, needs_recheck=0
reserving --sweeper rule 0, detach/verify failed---------> dropped
reserved  --consume(txid)----------------------------------> consumed(txid)
reserved  --release(requestId) [§3.3] / expiry (rule 1)-----> released, needs_recheck=1
released (needs_recheck=0, unassigned) --consume(txid)-----> consumed(txid)        (late submit)
released  --claim (§4.3 step 5)----------------------------> reserving
consumed  --consume(same txid)-----------------------------> consumed              (idempotent)
consumed  --consume(other txid)----------------------------> refused "consumed by another txid"
reserved(other request) --consume--------------------------> refused "reserved by another request"
unknown / dropped / spent_external --consume---------------> refused "unknown"
consumed  --release(outpoints, txid) [eviction only, §5.4/§6.4]--> released, needs_recheck=1
consumed  --sweeper rule 4 (with overlay proof)-----------> released, needs_recheck=1
consumed  --settle(txid)-----------------------------------> consumed, settled_at
released | spent_external --settle(txid matches)----------> consumed, settled_at   (repairs a wrongful release)
released  --sweeper rule 2: chain spent-------------------> spent_external         (terminal; deny requester)
released  --sweeper rule 2: chain unspent-----------------> released, needs_recheck=0
```

`POST /consume { outpoints: string[], txid }` applies every row's CAS in ONE
DB transaction, all-or-nothing: any refused row rolls back the batch and
returns `{ ok:false, outpoint, reason }` with nothing changed (same rule as
`InFlightOutpoints.hold`, `O/spentGuard.ts`). A same-txid resubmit is
idempotent because every row is already `consumed(txid)`.

`POST /release` has two forms with different authority:
- `{ requestId }` — from the overlay's public §3.3 route or its own
  recognizer-failure path: CAS `status='reserved' AND request_id=?` →
  `released, needs_recheck=1`. Never touches consumed rows; `ok, affected`.
- `{ outpoints, txid }` — overlay-internal (`X-Fuel-Key`), **eviction only**:
  CAS `status='consumed' AND txid=?` → `released, needs_recheck=1`.

**No release on refusal or broadcast failure.** A topic-manager refusal after
a successful consume, an `InfraError`, or a broadcast failure (both engines'
broadcast happens after the guard returned; TS `Engine.js` PHASE 2 with
`throwOnBroadcastFailure` defaulted true by OverlayExpress; Go
`arcade.IsBroadcastFailureErr` also covers ambiguous transport errors,
`OG/arcade/broadcaster.go:164-166`) all leave the rows `consumed(txid)`.
A resubmit of the same bytes re-consumes idempotently; any other txid gets
`ERR_FUEL` and the client rebuilds from a fresh draft; a never-resubmitted tx
is freed by rule 4 with proof. Rationale: two concurrent submits of the same
txid are not serialized by either engine (the applied record is written last),
so a refusal seen by one request cannot be taken as proof that the fuel is not
live for the other.

### 4.6 Settle (`POST /settle { txid, atomicBeef }`)

Input MUST be AtomicBEEF (`transaction.NewBeefFromAtomicBytes`, `internalize.go:91`,
rejects any other framing). The overlay normalizes before calling (TS
`Transaction.fromBEEF(beef).toAtomicBEEF()`; Go `ParseBeef` + `AtomicBytes(txid)`);
the keeper re-frames defensively if the version byte is not ATOMIC_BEEF.

For every reservation with this `txid` in `consumed | released | spent_external`:
`InternalizeAction({ tx: atomicBeef, outputs: [{ outputIndex: vout, protocol:
'basket insertion', insertionRemittance: { basket: 'mandala-tokens',
customInstructions: JSON{ protocolID: FT_PROTOCOL, keyID, counterparty: requester },
tags: ['mandala','fee', assetId] } }], description: "Fee for <txid>" })`, then
CAS the row to `consumed, settled_at` (this repairs a wrongful release). The
internalize broadcasts only if storage has never seen the tx
(`internalize.go:463-491`); the overlay already broadcast it, so this is a
harmless "already known" post. Idempotent on repeat (known-tx merge,
`isAllowedMergeStatus`, `internalize.go:659-668`).

### 4.7 Sweeper (every 30 s)

0. `reserving` past `expires_at` → re-run §4.3 steps 6-7; both pass →
   `released, needs_recheck=0`; else `dropped`.
1. `reserved` past `expires_at` → `released, needs_recheck=1` (the holder may
   have broadcast the bare draft).
2. `released, needs_recheck=1` → `IsUtxo(scriptHash(fuel_script), outpoint)`:
   `true` → `needs_recheck=0`; `false` → `spent_external` and add the last
   `requester` to `fuel_denylist`; error → unchanged, retry next tick. Never
   treat an error as unspent.
3. `consumed` without `settled_at` older than 5 min → log only; the overlay
   owns settle retries (§5.4/§6.4).
4. `consumed` without `settled_at` older than 30 min → ask the overlay
   `GET /admin/admission/:txid` (bearer `FK_OVERLAY_ADMIN_TOKEN`):
   - `200` (admitted, record or applied proof): the tx WAS broadcast. Never
     release. Alert `consumedUnsettled`; POST the overlay's internal
     `/fuel/resettle {txid}` so it re-attaches the fuel record (derived from
     tx inputs ∩ recognizer) and settles.
   - `410 ERR_EVICTED` or `400` with a final code → `released, needs_recheck=1`.
   - `404` → only if `IsUtxo` reports unspent on two observations ≥ 10 min
     apart → `released, needs_recheck=1`.
   - 5xx / timeout → nothing this pass.
   A rule-4 release never sets `needs_recheck=0`.

### 4.8 `GET /health` and deny list

`{ pool: {available, reserving, reserved, consumedUnsettled, released, recheckPending, dropped,
spentExternal}, issuerBsvSats, lowWater, denomination, provenFuel, denied }`.
Alerts on `provenFuel < lowWater`, `issuerBsvSats < 20 × D × targetPoolSize`,
any `spent_external` transition, and when the pool drops faster than
`consumed + settled` rows explain. `fuel_denylist` is cleared by an operator
(`DELETE /deny/:requester`, `X-Fuel-Key`).

## 5. TS overlay (`O/`)

### 5.1 Config

`FUELKEEPER_URL`, `FUELKEEPER_API_KEY`, `FUEL_ISSUER_KEY`, `FUEL_ASSET_IDS`,
read next to `ARCADE_URL` (`O/index.ts:69-86`). Empty `FUELKEEPER_URL` →
feature disabled: `/fuel/*` answer `ERR_FUEL_DISABLED`, guard not installed.

### 5.2 Routes

Mounted with `server.app.post/get` between `O/index.ts:427` and `:607`
(before `server.start()` at :609, after `configureEngine` :353).
`POST /fuel/draft`: parse boundary → ts window → signature via a
`ProtoWallet('anyone')` inside try/catch (any throw → 401) → nonce insert
into `mandalaFuelNonces` (duplicate → 401) → `registryActive` else
`ERR_FUEL_DISABLED`; `registryStore.isAdmitted` → asset state
(`sharedStorage.getAssetState` + `mandalaFeeRates`) and `FUEL_ASSET_IDS` →
keeper `/draft` (forwarding the signed body) → upsert k recognizer rows → 200.
Recognizer upsert failure → best-effort keeper `/release {requestId}` → 503.
`POST /fuel/release` per §3.3. `GET /fuel/info` per §3.2. CORS wildcard like
the open `/admin/*` routes (`O/index.ts:45-51`). Internal
`POST /fuel/resettle {txid}` under `X-Fuel-Key` for §4.7 rule 4.

### 5.3 `withFuelGuard`

New wrapper `O/fuelGuard.ts`, shaped like `withAdminChainAnchor`
(`O/adminChainGuard.ts:103-140`). Stack position (`O/index.ts:292-338`):
`withAdminChainAnchor(withFuelGuard(new MandalaTopicManager(...), fuelDeps), adminChainStore)`.

```
identifyAdmissibleOutputs(beef, previousCoins, offChainValues):
  tx = Transaction.fromBEEF(beef); txid = tx.id('hex')
  rows = infra('fuel recognizer', () => drafts.findByOutpoints(tx.inputs.map(outpoint)))
  if rows.length === 0: return inner.identifyAdmissibleOutputs(...)
  matched = []
  for each input i that has rows:
    row = rows.find(r => r.outpoint == outpoint_i && tx.outputs[i]?.satoshis === 1
                         && tx.outputs[i].lockingScript.toHex() === r.feeScript)
    if !row: throw new Error(`tm_mandala: fuel input ${i}: paired output is not the drafted fee output`)
    matched.push(row)
  outpoints = matched.map(r => r.outpoint)
  infra('fuel intent', () => admissions.recordFuelIntent(txid, outpoints))          // §3.4
  r = infra('fuel consume', () => keeper.consume(outpoints, txid))                  // batch, all-or-nothing
  if !r.ok: throw new Error(`tm_mandala: fuel input ${vinOf(r.outpoint)}: consume refused: ${r.reason}`)
  drafts.markConsumed(outpoints, txid)   // best-effort, recognizer bookkeeping only
  return inner.identifyAdmissibleOutputs(...)   // NO catch/release: §4.5
```
Verdict wiring: add `ERR_FUEL` to the union (`O/submitVerdict.ts:29-45`),
`SHAPES` (:52-65, `{httpStatus:400, retryable:false}`), the `"fuel input"`
row at the head of `REASON_TABLE` (:102-113); NOT in `FINAL_CODES` (:83-85).

### 5.4 Settle hook, dupe path, sweeper, eviction

- Happy path: after `persist()` (`O/admission.ts:671-694`) and once
  `origJson(signed)` is queued (:593), call `keeper.settle(txid, atomicBeef)`
  best-effort (pattern `finalizePending`, :703-712); on success
  `markFuelSettled(txid)`.
- Dupe path (:622-634) and `finalizePending`: if `prior.fuel?.settled === false`
  (or `prior.fuel` missing but the tx's inputs intersect the recognizer —
  derive `outpoints` and write the intent), fire settle + `markFuelSettled`.
- `setInterval` 60 s `settleUnsettled()`: `{ 'fuel.settled': false, evictedAt: null }`
  with no `pending` filter; for `pending:true` rows settle only when
  `deps.applied.wasApplied(txid)` is true.
- Eviction (`O/eviction.ts` arc-ingest terminal) → after the input restore,
  `keeper.release({ outpoints: rec.fuel.outpoints, txid })`.
- Broadcast failure: nothing (§4.5).

### 5.5 Asset state

`mandalaFeeRates` fold wrapper around the lookup service (§2); merged into
`GET /admin/asset-state/:assetId` next to `withFrozenRowFlags`.

## 6. Go overlay (`OG/`)

### 6.1 Config / wiring

`Config` (`OG/wiring/engine.go:42-64`) gains `FuelKeeperURL`, `FuelKeeperAPIKey`,
`FuelIssuerKey`, `FuelAssetIDs`; loaded in `cmd/overlay/main.go` `loadConfig`.
New package `OG/fuelkeeper` (HTTP client: `Draft`, `Consume`, `Release`,
`Settle`, `Info`) wired conditionally in `Build` like Arcade
(`engine.go:188-207`) with a `WithFuelKeeper` option. `Store` gains
`fuelDrafts` (indexes: `outpoint`, `requestId`) and `fuelNonces` (24 h TTL)
created in `NewStore` (`OG/mandala/storage.go:93-160`), plus
`RecordFuelIntent`, `MarkFuelSettled`, `FindFuelDraftsByOutpoints`.

### 6.2 Routes

`registerFuelRoutes` in `OG/httpapi/fuel.go`: `POST /fuel/draft`,
`POST /fuel/release`, `GET /fuel/info`, internal `POST /fuel/resettle`.
Signature check with a go-sdk `ProtoWallet` over `AnyoneKey()`; accept only
`err == nil && res != nil && res.Valid`. Membership via `Store.IsAdmitted` /
`RegistryActive` (`OG/mandala/registry.go:74-95`). Eligibility via
`Store.GetAssetState` + `FuelAssetIDs`.

### 6.3 Guard

`TopicManager` gains an optional `FuelGuard` invoked in
`IdentifyAdmissibleOutputs` after `adminChainAnchored`
(`OG/mandala/topic_manager.go:165-168`) and before the manager's own rules
(:170). Same logic as §5.3, one batch `Consume(outpoints, txid)`; refusals are
`*RejectError` (:381-394) with the §3.4 strings; keeper faults are
`infraError` (:402-408); no release on later refusal. Verdict:
`CodeFuel = "ERR_FUEL"`, `verdictFuel{400, retryable:false, final:false}`
(`OG/httpapi/verdict.go:22-61`), `"fuel input"` row at the head of
`rejectReasonTable` (:95-114).

### 6.4 Settle hook, dupe path, sweeper, eviction

After the finalize `RecordAdmission` write (`OG/httpapi/submit.go:229-243`)
and the 200 (:245): detached goroutine with a 10 s timeout calls `Settle`,
then `MarkFuelSettled`. `serveKnownVerdict` (:261-312) fires the same when
`prior.Fuel != nil && !prior.Fuel.Settled` (or derives the intent from the
recognizer). 60 s ticker retries unsettled records (pending rows only when
`AppliedAdmissionProof` confirms). `EvictTx` → `Release(outpoints, txid)`.
Broadcast failure (`:195-199`) → nothing (§4.5). `AdmissionRecord` gains
`Fuel *FuelRecord` (`OG/mandala/admissions.go:64-92`), included in the
finalize `$set`.

### 6.5 Reducer

§2: `FeeRatePerKb *int64`, `register`/`setFeeRate` cases in `FoldAction`
(`OG/mandala/reducer.go:73-121`).

### 6.6 Parity tests

Golden fixtures shared under `overlay-go/testdata/` and `overlay/src/__fixtures__/`:
signed draft/release messages with positive AND negative verify cases (bad
sig, wrong requester, malformed point, stale ts, reused nonce); the `k/F`
sizing table over `n ≤ N_MAX, m ≤ M_MAX`; `ERR_FUEL` and `/fuel/*` bodies;
fee script vectors; a wallet-toolbox `generateChangeSdk` run (real code,
allocator returning nothing, `changeInitialSatoshis 32`, `changeFirstSatoshis
8`, `targetNetCount 144`, fee `BSV_RATE`) over every `(n, m)` asserting no
throw and no allocated change input.

## 7. Lib (`@bsv/mandala`, `L/`)

### 7.1 API

```ts
interface TransferParams { ...; feeMode?: 'bsv' | 'issuer' }   // default 'bsv'
interface TransferResult { ...; fuel?: { requestId: string, pairs: number, feePaid: string } }
export async function fuelInfo(): Promise<FuelInfo>
export async function requestFuelDraft(wallet, identityKey, assetId, n, m): Promise<FuelDraft>
export async function releaseFuelDraft(wallet, identityKey, requestId): Promise<void>
export function feeForPairs(info: FuelInfo, feeRatePerKb: number, k: number): number
```
`requestFuelDraft` signs per §3.1 (`counterparty:'anyone'`) and throws
`OverlayRefusedError` with the §3.1 codes (parsed by `overlayErrorFromResponse`,
`L/overlay.ts:117`). `feeMode:'issuer'` with `mode:'handover'` is rejected
(§3.5).

### 7.2 Pipeline diff (`L/transfer.ts`, line refs against 2026-09-22 master)

1. `:184-185` — selection target `amount + k·F`, starting with `k=1`; after
   the draft returns `k`, if `k·F` exceeds what was gathered, release the
   draft (`releaseFuelDraft`) and re-select/re-request; ≤ 3 rounds, then throw.
2. `:186-188` — `beef.mergeBeef(draft.fuelBeef)`; `inputs = [...fuelInputs, ...tokenInputs]`
   where a fuel input is `{ outpoint, unlockingScriptLength: Lf, inputDescription: 'issuer fuel' }`,
   `Lf = draftTx.inputs[i].unlockingScript.toBinary().length`. The lib MUST
   NOT pass `unlockingScript` on `createAction`: `removeUnlockScripts`
   (`WT/signer/methods/createAction.js:85-100`) overwrites the length with the
   hex *character* count, doubling what the fee model charges.
3. `:190` — `change = gathered - amount - k·F`.
4. `:224-255` — `outputs = [...feeOutputs, ...shuffledPayerOutputs]` where a
   fee output is `{ satoshis:1, lockingScript: pair.feeScript, outputDescription:'FT fee to issuer',
   customInstructions: JSON{ keyID: pair.keyID, counterparty: issuerIdentityKey, feeAmount } }`
   and `shuffledPayerOutputs` is `[recipient, ...change]` shuffled by the lib
   (Fisher–Yates over `@bsv/sdk` `Random`, RN-safe).
5. `:270-281` — `options: { randomizeOutputs: false }` in fee mode; the
   toolbox keeps the order and appends BSV change (`createAction.js:353`).
   `matchOutputIndices` (:289-291) recovers indices as today.
6. `:294-304` — sign token inputs at `tx.inputs[k + i]`; `spends` carry
   `String(i) → { unlockingScript: draftTx.inputs[i].unlockingScript.toHex() }`
   for `i < k` AND `String(k + i)` for token inputs.
7. `:316-328` — `outLinks` gain `{ index: i, linkage: revealLinkage(wallet, pair.keyID, issuerIdentityKey) }`
   per pair; `inLinks` indices become `k + i` (fuel inputs are P2PKH, never
   token-decodable; COVER's FIX K exclusion `L/bundle.ts:342` skips them).
8. `:331` — txid unchanged; journals, blinding, notify, receipt unchanged.
9. Release policy: `releaseFuelDraft` is called only when (a) no `/submit`
   was ever attempted with bytes spending the draft's fuel (createAction /
   signAction failure, k re-request), or (b) `submitAndBroadcast` threw a
   FINAL `OverlayRefusedError` and `abortAction` succeeded. Never on a
   retryable refusal, transport error or timeout: some 503s arrive after the
   engine broadcast (`FINALIZE_FAILED`, `SPEND_CONFLICT`), the journaled
   resubmit takes the dupe path, and the TTL/sweeper are the backstop.

`issuerIdentityKey` comes from `resolveAssetState` (`L/adminState.ts:25`);
the lib refuses fee mode when `feeRatePerKb == null` or `fuelInfo().assetIds`
lacks the asset.

### 7.3 Receive side

Unchanged. The recipient's output index arrives in the body (`outputIndex`,
`:410`); it is some index ≥ k chosen by the shuffle.

### 7.4 RN safety

`requestFuelDraft`/`releaseFuelDraft` use `wallet.createSignature`; HTTP via
the injected `OverlayFetch` (`L/overlay.ts:166-178`). No new storage; no
`import.meta`.

## 8. Wallet and console

### 8.1 bsv-wallet (`W/`)

- `createRuntime.ts` `sendToHandle` (`:2204-2246`) and the nearby-rail send
  gain a pre-flight: BSV balance below the fee floor (`TOKEN_FEE_FLOOR_SATS`,
  ux spec) AND `fuelInfo().enabled` AND asset in `fuelInfo().assetIds` AND
  `feeRatePerKb != null` AND online → `feeMode:'issuer'`, `mode:'submit'`
  (§3.5); else the current path. Fee-mode sends use the `accepted` journal
  path (`submitAndBroadcast`), not `handed_over`.
- UI: "Network fee: <k·F> <ticker> (paid to issuer)"; the existing "needs a
  little BSV" copy stays for offline and ineligible assets.
- Re-vendor `@bsv/mandala` (`scripts/sync-mandala.sh`; vendored tarball is
  0.2.0, master is 0.2.2).

### 8.2 Issuer console (`app/`)

- Operations → "Network fee rate" control (`setFeeRate`, "disabled" when
  null); register-asset strip gains the field.
- Treasury shows fee income: outputs tagged `fee` in basket `mandala-tokens`,
  visible because the console's wallet shares the fuelKeeper's storage.
- Console wallet = a wallet-toolbox client (Metanet Desktop or embedded
  `@bsv/wallet-toolbox-client`) configured with the issuer root key and the
  fuelKeeper storage server URL. Migrating the test issuer's wallet storage is
  an ops step (§12 P5); until then fee outputs accrue in the keeper's storage.

## 9. Failure matrix

| event | outcome |
|---|---|
| draft fetched, wallet crashes before submit | `reserved` expires → `released, needs_recheck=1` → sweeper rule 2 clears it; token inputs never left the wallet (noSend action swept by existing reconcile) |
| createAction/signAction fails after draft | lib `releaseFuelDraft` (signed) → keeper releases `reserved` rows; TTL backstop |
| toolbox `WERR_INSUFFICIENT_FUNDS` after draft | unreachable by construction (`changeDust` in `need(k)`, §6.6 test); if it ever happens: release + surface error |
| same bytes submitted twice (retry, second tab) | recognizer hit both times; batch consume idempotent for the same txid; second `/submit` takes the normal dupe path |
| two tabs build two sends | two drafts, distinct fuel; `mandala.send` web lock still serializes (`L/transfer.ts:169`) |
| concurrent submits of the same txid, one refused after the other consumed | rows stay `consumed(txid)`; no release (§4.5); the admitted one settles |
| overlay crashes after intent write, before consume | nothing consumed; retry re-writes intent and consumes |
| overlay crashes after consume, before broadcast | same-bytes retry → idempotent consume → admitted; never retried → rule 4 (404 + two unspent observations) releases |
| TM refuses after consume (paused, frozen, conservation) | rows stay `consumed`; client gets 409/400, rebuilds later with a fresh draft; rule 4 frees the old fuel after 30 min with a 400-final/404 proof |
| broadcast fails after admission decision | both engines: rows stay `consumed`; 503 retryable; same-bytes retry re-consumes and re-broadcasts; never retried → rule 4 |
| retryable 503 after `/submit` (incl. `FINALIZE_FAILED`, `SPEND_CONFLICT` after broadcast) | lib does NOT release; journaled resubmit takes the dupe path; dupe path settles |
| ARC terminal failure later (eviction) | existing restore + `release(outpoints, txid)` → `needs_recheck=1`; rule 2 decides `spent_external` vs reusable |
| late submit of an expired draft | `released(needs_recheck=0) → consumed` allowed if not re-drafted; else `ERR_FUEL` (never persisted), client rebuilds |
| re-draft of a released outpoint | recognizer row keyed per draft, upsert; guard matches by `feeScript` |
| keeper down at draft | 503 `ERR_FUEL_UNAVAILABLE`; wallet offers BSV path or retry |
| keeper down at submit | intent may be written; consume not attempted or failed → `InfraError` 503; nothing consumed; retry |
| keeper down at settle | `fuel.settled:false` persisted; overlay sweeper retries every 60 s; fee output is on-chain regardless |
| admission persisted without `fuel` (legacy/derived) | dupe path and `settleUnsettled` derive outpoints from inputs ∩ recognizer; rule 4 `/fuel/resettle` |
| pool empty / no proven fuel | 503 `ERR_FUEL_UNAVAILABLE`; `/health` alert |
| funder allocates a row the keeper is drafting | §4.3 step 7 verify fails → `dropped`, replacement picked |
| asset rate changed between draft and submit | draft is authoritative; new rate applies to later drafts |
| payer adds more inputs than declared | tx larger than sized; admitted if the miner fee still suffices, else broadcast-failure path; payer's loss |
| payer broadcasts the bare draft or a non-admitted variant | issuer loses ≤ D per pair; rule 2 marks `spent_external`, requester auto-denied |

## 10. Security analysis

- **Fuel is a bearer instrument.** Whoever holds a signed draft (the
  requester, an interceptor of the response, or the overlay that relays it)
  can move up to `k·(D − 1 − minerFee)` sats of issuer BSV outside the overlay
  per draft. The linkage requirement stops overlay *admission* only; it does
  not stop an external BSV spend. Bounds: per-requester outstanding and
  rolling-24 h caps, a global per-minute cap, registry membership, the
  reservation audit trail, and automatic denial on the first `spent_external`.
- **Malicious or compromised overlay.** Trusted for fuel: it relays drafts and
  holds `FK_API_KEY`. It cannot mint drafts for identities it does not
  control (the keeper verifies the requester's `'anyone'` signature and
  nonce itself), cannot redirect fees (output *i* is committed by the keeper's
  signature and keyed issuer-side), and cannot exceed the keeper's own caps.
  It can still relay every legitimately requested draft to a thief it
  colludes with; accepted because overlay and keeper share one operator (D4),
  and `/health` alerts when the pool drops faster than settled rows explain.
- **Forged draft requests.** Signature over the canonical message with the
  requester's identity key; nonce uniqueness (24 h, on both overlay and
  keeper) and ±300 s window stop replay. `assetId` (a genesis outpoint) binds
  the message to one asset and therefore one chain.
- **Pool drain by a hostile issuer.** `register` is forgeable (§2.1);
  eligibility is the operator's `FUEL_ASSET_IDS` allowlist on both overlay
  and keeper, so the operator only ever funds assets it chose.
- **Fee governance.** `setFeeRate` rides the anchored admin chain (P0 closes
  the re-register hole); a forged rate on a non-allowlisted asset is inert.
- **Key custody.** The issuer root key lives only in the fuelKeeper process
  (SSM) and in the console's wallet client. The overlay identity key is
  unchanged and separate.
- **Privacy.** On-chain a fee output looks like any Mandala transfer output
  (`<assetId> <F> OP_2DROP` + P2PKH): assetId and F are public. Every
  fee-mode tx is fingerprinted — inputs `[0,k)` carry sighash `0xC3` and spend
  keeper-funded UTXOs from the issuer's fan-out tree — so it is linkable to
  the issuer. Payer outputs after index k are shuffled by the lib, so position
  does not reveal recipient vs change. The overlay learns the requester's real
  identity key (it already does for every linked output).

## 11. Maintainer decisions (2026-09-22)

- **D1** Fuel pairs, not post-submit funding (§0.1).
- **D2** Fuel signed `SIGHASH_SINGLE|ANYONECANPAY|FORKID`, pair `vin_i/vout_i`
  from 0; the fee output is committed by the keeper.
- **D3** Online only; no fuel cache on devices; just-in-time draft with a
  reservation window and release. Fee-mode sends are submit-first (§3.5).
- **D4** Issuer key = fuel key. fuelKeeper is the issuer's go-wallet-toolbox
  wallet; fee outputs are internalized on the overlay's settle hook; no
  MessageBox path.
- **D5** Fee lock derived with the requester as BRC-29 counterparty
  (`forSelf:true` issuer-side); no `'self'` fallback.
- **D6** One wallet, shared BRC-104 storage between fuelKeeper and console.
- **D7** Reuse `pkg/wallet/fuelkeeper` and the throughput strategy verbatim.
- **D8** (spec author's calls, open to override) requests signed with
  counterparty `'anyone'` so overlay and keeper both verify; operator
  allowlist `FUEL_ASSET_IDS` as the eligibility gate plus the P0 register fix;
  `ERR_FUEL` never persisted; no fuel release on refusal or broadcast failure;
  `randomizeOutputs:false` with a lib-side shuffle of payer outputs.

## 12. Implementation order

Each phase is its own plan → implement → review cycle; parity tests land with
their phase.

- **P0 — register hardening (both engines).** Reject `register` with a
  non-empty `assetId`; key register history/state by its own outpoint;
  regression tests (§2.1). — done 2026-09-22, commits 83b4e15…d03b7c0
- **P1 — asset parameter.** Go reducer + tests; TS repo-local fold +
  asset-state merge + tests; lib `RegisterParams.feeRatePerKb`, `setFeeRate`,
  `AssetAdminStateView.feeRatePerKb`; console controls; ts-stack PR opened
  (non-blocking). — done 2026-09-22, commits 48db465…26401db
- **P2 — fuelKeeper.** New module: storage server + wallet + keeper wiring
  (dashboard pattern), fee script encoder + parity vectors, request
  verification (`anyone`), claim/detach/verify/sign/commit draft flow with a
  go-sdk verification test (skeleton extended by a token tx must verify),
  reservation CAS + batch consume + sweeper tests (SQLite and Postgres),
  routes, deny list, Dockerfile, `/health`.
- **P3 — overlays.** TS: routes (draft/release/info/resettle), `withFuelGuard`
  with intent write, settle hook + dupe path + sweeper, verdict row,
  recognizer/nonce collections, `putAdmitted` `fuel` field; Go: the same;
  shared golden fixtures; end-to-end test against a fake keeper on both.
- **P4 — lib + wallet.** `feeMode:'issuer'` pipeline, draft/release client,
  tests with a mocked wallet (input/output ordering, `unlockingScriptLength`
  path, signing offsets, spends for fuel inputs, linkage indices, shuffle,
  release policy) plus the real `generateChangeSdk` sweep (§6.6);
  bsv-wallet pre-flight + UI + re-vendor; testnet smoke.
- **P5 — deploy.** flux `apps/base/mandala-test/fuelkeeper.yaml` (Deployment
  + Service, ports ≥1025, PVC), ExternalSecret entries
  `/apps/mandala-test/ISSUER_ROOT_KEY`, `/apps/mandala-test/FUEL_API_KEY`,
  `/apps/mandala-test/FUEL_OVERLAY_ADMIN_TOKEN`; overlay env
  `FUELKEEPER_URL/FUELKEEPER_API_KEY/FUEL_ISSUER_KEY/FUEL_ASSET_IDS`; keeper
  config `FUEL_ASSET_IDS`; console wallet re-pointed at the shared storage;
  fund the issuer wallet; runbook section; confirm `BSV_RATE`/`D` against the
  testnet Arcade policy.

## 13. Revision log

Revision 2 (2026-09-22, after adversarial review; all items verified against
code before adoption):

- §1.3: `changeDust` added to `need(k)`; "excess folded into fee" removed —
  wallet-toolbox throws instead. Fuel input constant 148.
- §7.2: fuel inputs passed with `unlockingScriptLength`, scripts supplied in
  `signAction` spends (hex-length doubling in `removeUnlockScripts`).
- §4.5, §5.3, §6.3, §9: no fuel release on refusal or broadcast failure
  (concurrent same-txid submits; TS broadcast happens after the guard
  returned; Go broadcast failure is ambiguous). Eviction and the proof-gated
  sweeper are the only `consumed → released` paths; `/settle` repairs a
  wrongful release.
- §3.4, §5.4, §6.4: fuel intent written before consume; dupe path and sweeper
  settle regardless of `pending`; explicit `fuel` in finalize writers;
  `markFuelSettled`; `/settle` takes AtomicBEEF; Go settles after the 200.
- §4.3, §4.4: claim → detach (empty basket) → verify → commit protocol with
  `reserving`/`dropped` states; `fuel_script` + `needs_recheck` columns;
  high-id candidate selection; chain checks via `IsUtxo(scriptHash)`.
- §3.4: recognizer keyed per draft, upsert, no TTL; guard matches by
  `feeScript`; `consumedTxid`/`releasedAt` bookkeeping.
- §2 (P1 implementation review): TS fee fold gated on `MandalaAdmin.decode`;
  no eviction recompute (parity with Go; admin state is never rolled back on
  eviction on either engine).
- §3.3, §7.2 step 9: signed `/fuel/release` route; lib releases only when no
  submit was attempted or after a final refusal + abort.
- §3.1, §4.3 step 2: quotas moved to the keeper (outstanding drafts, daily
  pairs, global per-minute), `N_MAX`, registry-active requirement, deny list.
- §2.1, §10: `register` is unauthenticated → `FUEL_ASSET_IDS` allowlist on
  both sides and P0 engine fix; theft bound restated as a rate.
- §3.1: requests signed with counterparty `'anyone'`; keeper verifies
  independently; verify-result semantics pinned per SDK; parse boundary.
- §10, §7.2 step 4: privacy claims corrected; lib-side shuffle of payer outputs.

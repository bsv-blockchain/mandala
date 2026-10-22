# 1Color / BRC-207: shared interface contract (plan 00)

Date: 2026-10-22. Author: integration architect (overnight run, user unavailable, all calls recorded under **Decisions**).

**Revision 2** (builder-check gaps 01-07, 04-G*, 05-A*): §0 remittance input rule; §1 `readOneColorAttributes` never-throw table, `reqMatchesDeploy` fail-closed order, `reqBytes` wire span; §2.1 store layout internal + `isSettled`, internals list; §2.2 `checkExt`/`checkReceiptData`, `ReceiptGraph.tip` object, admitReceipt on every receipt, handler cardinality, 0.2.0 limits (non-empty module-built req, attested `ISSUE`, `lifecycles`), exact per-tx AtomicBEEF; §2.3 `dispose()`/`isSettled()`, D24 sendWith semantics; §2.4 `[ClassName]` message prefix, `ColorConsentDeclinedError`, runtime exports, A.143 message; §2.5 `seekPermission`, `signers[]`, `handoff:true`, display metadata; §3 HMAC tweak in every C.0 suite, `IsTokenTopic` alias; §4 F-REQ schema, deploy reason strings, KYC/non-deploy req rule, 36-byte id, limits, issuer-v1 local hop checks; §5.1 owned-output envelope rule; §6 lookup txid/AtomicBEEF, spendability/admission semantics, 503 faults, query errors; §7.2/§7.3 decline handling, SESSION_VERSION 2; §8.1 ADMIN_PROTOCOL, journal stages, PayoutResult, signAttestation, formatAmount, submitToOverlay/postLookup/fetchDeployTx, actionDescription, sendHandover/deliverHandover, loadHistory, retained subpaths, exports; §8.2 default provider, host broadcast guard, store location, HTTP bridge errors; §9 tarball commit ownership, host peerDeps; §10 step 0, V2/V3 owners, worktree discipline, envelope fixture; D13/D14/D22/D24 amended.
Authority: the design `docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (incl. §8 B1-B6) wins over this file; this file wins over any per-repo plan on every seam below. A planner who finds this contract impossible to implement records the conflict in its plan and implements the closest shape that keeps the seam byte-compatible. It does not invent a new seam.

Specs cited by line: **0162** = `docs/design/brc-0162-1color.pinned.md`, **0207** = `docs/design/brc-0207-1color-wallet-module.pinned.md`, **0175** = bitcoin-sv/BRCs `payments/0175.md` (local copy `/Users/personal/git/docs/BRCs/payments/0175.md`, BRCs 5119a9b).

Baselines read: ts-stack worktree `feat/1color-profiles` @ cbdccfe (origin/main), mandala `feat/1color` @ 45deec9, overlay-go same tree, bsv-desktop-wt @ 361778c, bsv-wallet-wt @ ae9dec61.

Seven planners: **P-T1** ts-stack templates, **P-T2** ts-stack color module, **P-GO** overlay-go, **P-LIB** mandala lib, **P-APP** mandala app console, **P-DESK** bsv-desktop, **P-WAL** bsv-wallet.

---

## 0. Global conventions and constants (every planner)

| Item | Exact value |
|---|---|
| Asset id string | `^[0-9a-f]{64}_(0\|[1-9][0-9]{0,9})$` (vout ≤ 2^32-1). **Mandala policy:** only `_0` (32-byte wire id). The id is the token id; the dot form is never used for an id. |
| Outpoint string | `<64 lowercase hex txid>.<canonical decimal vout>` (BRC-36 dot form). Never use an underscore for an outpoint. |
| assetTag (derivation and baskets) | `<64hex>v<vout>`, e.g. `…edb4fv0` (0207:540-546) |
| Per-asset topic / lookup | `tm_color_<assetId>` / `ls_color_<assetId>`, e.g. `tm_color_<64hex>_0` (0207:700-705) |
| Registry topics (unchanged names, C1) | token registry `tm_mandala` / `ls_mandala`; identity registry (KYC) `tm_mandala_kyc` / `ls_mandala_kyc` |
| Deploy submit topics | `["tm_mandala", "tm_color_<txid>_0"]` (exactly these two, any order; overlay pairing rule unchanged otherwise) |
| Holder token tx submit topics | `["tm_color_<assetId>"]`. **Exactly one Mandala asset per holder transaction** (D1). |
| Token amount domain | per output: value `1..2^64-1`, authority `0`; JS `bigint`, Go `uint64` / `*big.Int` for sums. Sums, supply and balances are unbounded exact integers. |
| Amounts in JSON (every repo, every wire) | canonical decimal **string**: `0\|[1-9][0-9]*`; a signed field (`delta`) may start with `-`, never `-0`. Never a JSON number. `dec`, `vout`, `outputIndex`, `version`, `feeRatePerKb` stay JSON numbers (they are not token amounts). |
| Hex | lowercase everywhere (txids, keys, DER, offChainValues, raw tx). |
| Identity keys | 66-hex compressed, lowercase, on curve. |
| Carrier satoshis | Mandala token outputs are exactly 1 sat (overlay policy unchanged). |
| Remittance strings (derivationPrefix/Suffix) | default: base64 of 16 random bytes (24 chars); caller-supplied values (≤ 48 UTF-8 bytes, no whitespace) are accepted. Maximum accepted by Mandala code: 48 UTF-8 bytes each, so `p color <assetTag> <hex> <hex>` stays ≤ 280 chars (0207:548) and `specific linkage revelation 2 <that>` ≤ 310. |
| Sighash | module signs `SIGHASH_ALL\|FORKID` (0x41). BSV Chronicle: verifiers never normalize S and accept high-S (attestations and tx signatures). |
| tx version | whatever the wallet produces (module/toolbox default). No component may reject a valid version-2 tx. |

---

## 1. T1: `@bsv/templates` 2.2.0 (P-T1)

`Bsv21Token.ts` is **not modified** (also not reformatted). Existing exports are unchanged. New file `src/OneColorAttributes.ts`, re-exported from `mod.ts`.

```ts
// ---- src/OneColorAttributes.ts ----
import type { StrictCborMap, StrictCborValue } from './strictCbor.js'
import type { LockingScript, ScriptChunk } from '@bsv/sdk/script'

/** 0162:178-183: case-sensitive ASCII URI, 1..200 bytes, ^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$ */
export function isProfileId (id: string): boolean

export interface OneColorProfileDescriptor {
  /** positive uint32: 1..4294967295 */
  version: number
  /** any DAG-CBOR value, including null (0162:182-183) */
  params: StrictCborValue
}

/** Absent and malformed are distinct (0207:88-93). */
export type OneColorField<T> =
  | { status: 'absent' }
  | { status: 'valid', value: T }
  | { status: 'malformed', reason: string }

export interface OneColorAttributes {
  /** 'absent' = no payload push; 'empty' = zero-byte payload (OP_0 OP_DROP);
   *  'opaque' = nonzero bytes that are not a strictly valid DAG-CBOR map (no partial recovery, 0207:82-87);
   *  'map' = strictly valid DAG-CBOR map. Every field below is { status: 'absent' } unless payload === 'map'. */
  payload: 'absent' | 'empty' | 'opaque' | 'map'
  dec: OneColorField<number>                       // uint 0..18 (0162:246-252); anything else malformed
  sym: OneColorField<string>                       // text
  icon: OneColorField<{ mediaType: string, bytes: Uint8Array }>  // exactly [text, bytes]; display MUST treat malformed as absent (0162:240)
  req: OneColorField<ReadonlyMap<string, OneColorProfileDescriptor>>  // map; keys isProfileId; values exactly {params, version}
  ext: OneColorField<ReadonlyMap<string, StrictCborValue>>            // map; keys isProfileId
  /** Exact wire span of the `req` VALUE inside the payload (not the whole payload); canonical because only strictly
   *  decoded payloads reach 'map'. Set iff req.status === 'valid'. A Go reader keeps Float distinct from Int. */
  reqBytes?: Uint8Array
  /** The decoded map, iff payload === 'map'. */
  map?: StrictCborMap
}

/** Pure reader. Never throws on any input. `undefined` ⇒ 'absent'; zero-length array/Uint8Array ⇒ 'empty';
 *  anything else that is not a strictly valid DAG-CBOR map (null, non-iterables, strings, entries outside 0..255,
 *  decoder exceptions) ⇒ 'opaque'. */
export function readOneColorAttributes (payload: readonly number[] | Uint8Array | undefined): OneColorAttributes

/**
 * 0162:188-191. Fixed fail-closed evaluation order:
 * 1. deploy.req malformed ⇒ false (for every later output, including one that omits req);
 * 2. later.req absent (incl. later payload 'opaque'/'empty'/'absent', 0207:85-87) ⇒ true;
 * 3. later.req malformed ⇒ false;
 * 4. else later.reqBytes == deploy.reqBytes (deploy req absent ⇒ `a0`).
 */
export function reqMatchesDeploy (deploy: OneColorAttributes, later: OneColorAttributes): boolean

/** 0162:105: true iff remainder chunk 0 is a push and chunk 1 is OP_DROP. */
export function needsEmptyPayloadMarker (remainder: readonly ScriptChunk[]): boolean

// ---- additions to src/OneColor.ts (class OneColor) ----
/** `<id|OP_0> <amount> OP_2DROP [<payload> OP_DROP | OP_0 OP_DROP] <remainder>`.
 *  payload undefined and needsEmptyPayloadMarker(remainder.chunks) ⇒ writes OP_0 OP_DROP. */
static lockRemainder (tokenId: string | null, amount: bigint, remainder: LockingScript, payload?: readonly number[]): LockingScript

// ---- mod.ts additions ----
export { isProfileId, readOneColorAttributes, reqMatchesDeploy, needsEmptyPayloadMarker } from './src/OneColorAttributes.js'
export type { OneColorAttributes, OneColorField, OneColorProfileDescriptor } from './src/OneColorAttributes.js'
/** 36-byte-aware id helpers (preferred names; the 32-byte-only tokenIdToString/FromString stay as they are). */
export const oneColorTokenIdFromString: (id: string) => number[]           // = OneColor.tokenIdFromString
export const oneColorTokenIdToString: (tokenId: readonly number[]) => string // = OneColor.tokenIdToString
```

Rules: `version` decoded as CBOR uint (bigint in strictCbor) and converted to `number` only when `1 ≤ v ≤ 2^32-1`, else malformed. Duplicate keys, non-canonical encodings and non-map payloads are already rejected by `decodeStrictCbor`; `readOneColorAttributes` uses `tryDecodeStrictCbor`. README documents "prefer `oneColorTokenId*`". Package version 2.2.0 (contains the unpublished 2.1.0 `OneColor` work).

---

## 2. T2: `@bsv/color-permission-module` 0.2.0 (P-T2)

Profile-free assets keep the 0.1.0 behaviour **byte for byte** (existing tests stay green, unchanged). Everything below is additive.

### 2.1 Options, store, provider

```ts
import type { AdmittanceInstructions, LookupAnswer, Transaction, WalletInterface } from '@bsv/sdk'
import type { StrictCborValue } from '@bsv/templates'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue } // already in strictJson.ts; now exported
/** profileData: profile id → (assetId | 'ISSUE') → leaf (0207:154-164) */
export type ProfileData = Record<string, Record<string, JsonValue>>

/** BRC-22 admittance with the BRC-175 attestation fields (0175:79). */
export type AttestedAdmittance = AdmittanceInstructions & {
  admissionSignature?: string     // lowercase strict-DER hex, no sighash byte
  admissionIdentityKey?: string   // signer's ROOT identity key (66 hex), not the derived child
}
export type AttestedSTEAK = Record<string, AttestedAdmittance>

export interface ColorOverlayProvider {
  spendability: (assetId: string, outpoints: string[]) => Promise<LookupAnswer>   // unchanged
  admission: (assetId: string, outpoints: string[]) => Promise<LookupAnswer>      // unchanged
  /** CHANGED (backwards compatible): optional raw off-chain bytes for the BRC-22 submit; returns attestation fields when the service provides them. */
  submit: (topics: string[], beef: number[], offChainValues?: number[]) => Promise<AttestedSTEAK>
}

/** Thrown by providers (and re-thrown by the module) for overlay or transport failure. */
export class ColorProviderError extends Error {
  readonly name = 'ColorProviderError'
  constructor (readonly code: string,           // overlay verdict code, or 'ERR_UNAVAILABLE' for transport
               readonly retryable: boolean,
               readonly transport: boolean,     // true: no typed verdict (network, timeout, 5xx, typed ERR_UNAVAILABLE)
               message: string)
}

/** Durable async KV the host injects. Required when `profiles` is non-empty (constructor TypeError otherwise). */
export interface ColorModuleStore {
  get: (key: string) => Promise<string | undefined>
  set: (key: string, value: string) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: (prefix: string) => Promise<string[]>
}
// All module keys start with 'color.v1.'. Layout color.v1.{tx,deploy,settled,refused,intent,unsent}.<id> is T2-internal
// (documented in the README); hosts never read it and use settle(), handoffEvidence(), isSettled(txid) (07-gap9).
// Store location and namespace are host choices (desktop: ~/.bsv-desktop/color-store/<identityKey>-<chain>/, accepting only 'color.v1.' keys).

export interface ColorPermissionModuleOptions {
  wallet: WalletInterface                       // underlying wallet (unchanged rule)
  provider: ColorOverlayProvider                // default provider (baseline assets)
  requestTokenAccess: ColorTokenAccessHandler   // unchanged + new message type, §2.5
  profiles?: Record<string, RequiredProfileHandler> // key MUST equal handler.id, else constructor TypeError
  store?: ColorModuleStore
}
```
Additive internals (`ListedOutput.transaction`, optional read params, `TokenOutput.attributes`, protected `resolveAsset`/`ResolvedAsset`, `TrustMode`/`AttestedParams`, the `actionConsent` handoff param) are T2-internal. Of these only `readProfiledTokenOutput` and `TokenReader` are exported; hosts must not depend on the rest.

### 2.2 Required-profile handler interface

```ts
export interface ProfileDescriptor { version: number, params: StrictCborValue }   // = OneColorProfileDescriptor

export interface ProfileAssetContext {
  assetId: string                                    // resolved id (never 'ISSUE' except in checkDescriptor for a new deploy)
  profileId: string
  descriptor: ProfileDescriptor                      // this handler's own entry
  req: ReadonlyMap<string, ProfileDescriptor>        // the authenticated deploy req (canonical order)
  declarationTx: Transaction                         // authenticated deploy tx, id === assetId txid
  wallet: WalletInterface                            // the UNDERLYING wallet (privileged: not the manager)
  identityKey: string                                // this wallet's identity key
  originator: string
}

export interface ProfileTxView {
  /** undefined at createAction (only args exist then); set at signAction (final layout, every input has
   *  sourceTransaction, still unsigned for submissionData) and at receipt. `inputs`/`outputs` are always populated. */
  tx?: Transaction
  assetId: string
  inputs: Array<{ inputIndex: number, outpoint: string, role: 'value' | 'authority', amount: bigint, custody?: Custody /* set iff a managed p color input */ }>
  outputs: Array<{ outputIndex: number, role: 'value' | 'authority', amount: bigint, custody?: Custody /* set iff wallet-owned: token change or plan.ownedOutputs */ }>
  planLeaf?: JsonValue                               // plan.profileData[profileId][assetId] if present
}

export interface ColorAttestation { txid: string, outputs: number[], signer: string, signature: string } // 0207:257-261, exact members

export interface ReceiptGraph {
  assetId: string
  /** Always present, also when the tip is already attested (D7). */
  tip: { txid: string, atomicBEEF: number[], offChainValues: number[] }
  outputIndexes: number[]                            // receipt outputs of this asset in the tip
  /** Txs not yet covered by a verified attestation, parents first, tip last, each with exact submit bytes. */
  pending: Array<{ txid: string, atomicBEEF: number[], offChainValues: number[] }>
  attestations: ColorAttestation[]                  // verified, deduplicated by (signer, txid, output)
}

export type ReceiptAdmission =
  | { status: 'admitted', attestations: ColorAttestation[] }  // verified, cover graph.outputIndexes of the tip
  | { status: 'unavailable' }                                 // transport failure only; module may then apply offline acceptance

export interface RequiredProfileHandler {
  readonly id: string                                // profile URI
  readonly versions: readonly number[]               // exact versions supported (0207:95-106)
  /** Validates this descriptor against the full req (cross-profile rules). Throws ProfileParamsError. Pure, sync. */
  checkDescriptor: (descriptor: ProfileDescriptor, req: ReadonlyMap<string, ProfileDescriptor>) => void
  /** (d) provider routing: the provider for every query/submit of assets requiring this profile. */
  provider?: (assetId: string, descriptor: ProfileDescriptor) => ColorOverlayProvider
  /** (d) providers asked, in order, for an unknown asset's deploy (color-admission of `<txid>.0`). */
  deployProviders?: () => ColorOverlayProvider[]
  /** (b) B2: 'plain-nosend' ⇒ every token createAction moving this asset MUST have options.noSend === true and
   *  MUST NOT carry a BRC-177 'p nosend expiry ' label; module keeps token change inside the tx (no split),
   *  tags that change `color_offline`, and never submits the action in onResponse. */
  readonly sendPolicy?: 'plain-nosend'
  /** Operations a holder may declare for this asset through the module; absent = all. Mandala: ['transfer']. */
  readonly operations?: readonly ColorOperationName[]
  /** B1-i / A.157 / A.159: checks the caller's plan leaf (undefined = absent). Called in createAction AND again in signAction. Throws ProfileDataError. */
  checkPlanData?: (ctx: ProfileAssetContext, leaf: JsonValue | undefined, view: ProfileTxView) => Promise<void>
  /** B1-ii: offChainValues bytes for tm_color_<assetId>; called in signAction BEFORE signing. Non-empty result required when present. */
  submissionData?: (ctx: ProfileAssetContext, view: ProfileTxView) => Promise<number[]>
  /** (a) receipt: called for EVERY receipt (incl. attested tips) before crediting, after base receipt checks and
   *  attested-leaf parsing. Throw ⇒ no credit. Honoured only if the asset also declares attested v1 (else ProfileParamsError at resolution). */
  admitReceipt?: (ctx: ProfileAssetContext, graph: ReceiptGraph) => Promise<ReceiptAdmission>
  /** Validates this profile's own `ext` value (undefined = absent). Absent hook ⇒ the profile's ext entry must be absent (ProfileParamsError). */
  checkExt?: (value: StrictCborValue | undefined) => void
  /** Validates a receipt profileData leaf for this profile. Absent hook ⇒ any receipt leaf for this profile is rejected (ProfileDataError). */
  checkReceiptData?: (ctx: ProfileAssetContext, leaf: JsonValue) => Promise<void>
  /** Receipt customInstructions limit for assets requiring this profile (default 1000; attested: 16 MiB). */
  readonly maxReceiptBytes?: number
}
```

Module obligations (P-T2):
1. **Deploy resolution** (0207:68-80), memoized by assetId, verified by `hash256(rawTx) == txid`: (i) `profileData[ATTESTED_PROFILE_ID][assetId].declarationTx` of the current request, (ii) `color.v1.` store cache, (iii) default `provider.admission`, (iv) each handler's `deployProviders()` in registration order. All fail ⇒ error, no fallback.
2. **Support check**: read `req` with T1 `readOneColorAttributes`; malformed `req`/`ext` in a valid map ⇒ fail (0207:88-91); every id registered and `versions.includes(version)` else `UnsupportedProfileError` (A.142/A.143/A.148); then `checkDescriptor` per entry. Non-deploy outputs with `!reqMatchesDeploy` ⇒ fail. `ext` naming a non-required profile ⇒ ignored (advisory) unless that handler rejects it. A required profile's own `ext` entry goes to `checkExt` (absent hook ⇒ entry must be absent).
3. **Routing**: distinct `provider()` results across an asset's handlers: 0 ⇒ default provider; 1 ⇒ that provider for spendability, admission, submit, resubmit, settle; ≥2 distinct objects ⇒ `ProfileParamsError`. Cardinality: at most one handler per asset defines `submissionData`, and at most one `admitReceipt` (else `ProfileParamsError`).
3a. **0.2.0 limits**: module-built deploys with a non-empty `req`, and attested `'ISSUE'` leaves in plans and receipts, are refused (Mandala deploys are lib-built, B4). An attested leaf carrying `lifecycles` ⇒ `AttestationEvidenceError` 'lifecycles are not supported' (D28).
4. **Plan profileData**: every profile id in `plan.profileData` must be in the asset's `req` and every asset key must be in `plan.assets` (A.154 `ProfileDataError`), then `checkPlanData`. The 0.1.0 "profileData is not supported" refusal is removed only for declared profiles.
5. **Receipts**: `parseCustody` becomes two-stage (0207:1442-1448): structural parse bounded at 16 MiB; after the asset is authenticated, enforce `max(handler.maxReceiptBytes)` over the asset's handlers (default 1000). `profileData` members validated as in 4. **The underlying wallet never sees the large string.** In `onRequest(internalizeAction)` the module parses the full receipt, durably stores the receipt tx, the attested leaf and the submissions under `color.v1.` **before** calling the wallet, then forwards `insertionRemittance.customInstructions` = the 5-member custody JSON only (`{version, assetId, derivationPrefix, derivationSuffix, senderIdentityKey}`, ≤ 1000 bytes; toolbox validation and storage unchanged), plus the module-authored tags.
5a. **SDK validator exception (part of the T2 PR set, @bsv/sdk 4.0.0 is unpublished):** `validateBasketInsertion` in `packages/sdk/src/wallet/validationHelpers.ts` allows `customInstructions` up to 16 MiB (16 777 216 UTF-8 bytes) when `basket` starts with `p color ` (1000 otherwise, unchanged). Reason: `WalletClient.internalizeAction` validates client-side, so an attested receipt cannot leave the app without it (0207:1444 "apply that exception before ordinary string-length rejection"). The wallet-side limit is then enforced by the module (5). No wallet-toolbox change (T3 stays empty). P-T2 also adds a test that a `colorHandoff` member on a `signAction` result survives `validateWalletResult` (JSON substrate). Both the sdk exception and that test live in plan 02 Task 16 (T2 PR set).
6. **Offline state**: stored tag `color_offline` is written by the module on (a) receipts credited without verified current admission (internalize `insertionRemittance.tags`), (b) token change of a `plain-nosend` hand-over (createAction output tags). Caller-supplied `color_*` tags on outputs/insertions are stripped. The view tag `color_offline` (inventory, tag filters, balances) = stored tag AND no `color.v1.settled.<txid>` record. A settled record is written ONLY after a verified attestation (identity K for Mandala) covering that output was obtained. Store loss ⇒ coins re-show as offline (fail-safe), `settle()` restores. A final refusal writes `color.v1.refused.<txid>`: affected outputs show `color_state_restricted`, contribute no balance (C55).
7. **Spending attested assets** (advisor note 4): a `color_offline` output of an attested asset is selectable and signable with no overlay contact, using stored frontier evidence. A settled output: live spendability via the routed provider; transport failure ⇒ proceed on stored attestation; reachable and not listed ⇒ resubmit through the settle path (stored exact bytes and stored offChainValues, never empty bytes when a handler supplied `submissionData`), recheck, else exclude.
8. **Durability**: before `signAction` returns a signed `plain-nosend` hand-over, and before the underlying `internalizeAction` of a receipt, the module has durably stored everything `settle()` and onward hand-overs need: raw tx, unattested ancestors, per-asset offChainValues and attestations. The TxRecord keeps the **exact AtomicBEEF** per tx (receipt-time or signAction-time bytes); settle/resubmit send those bytes verbatim. Store loss on an unsettled receipt loses the bytes needed to settle it. Recovery is the sender's resend (`handoffEvidence`, lib journal) or the sender's own post-ACK settle. The coin stays `color_offline` and never shows as settled.
9. **signAction result extension** (D4): for an action whose assets include any profile asset, the result is `SignActionResult & { colorHandoff?: ColorHandoffResult }`:

```ts
export interface ColorHandoffResult {
  version: 1
  txid: string
  /** Receipt-ready profileData for the transaction's recipients: per attested asset, the full attested leaf (§7.1). No issuer-v1 leaf. */
  profileData: ProfileData
}
```
   The same object is returned by the in-process method `handoffEvidence(txid): Promise<ColorHandoffResult | undefined>` (resend after a lost ACK, C51).

### 2.3 Settle API (c)

```ts
export interface ColorSettleResult {
  txid: string
  assetId: string
  status: 'admitted' | 'retry' | 'refused'
  outputs?: number[]        // attested outputs when admitted
  code?: string             // overlay verdict / 'ERR_UNAVAILABLE'
  description?: string
}
export interface ColorSettleReport { results: ColorSettleResult[] }

class ColorPermissionModule {
  settle (request?: { txids?: string[], assetIds?: string[] }, originator?: string): Promise<ColorSettleReport>
  handoffEvidence (txid: string): Promise<ColorHandoffResult | undefined>
  /** true iff color.v1.settled.<txid> exists. Host broadcast guards use this (§8.2). */
  isSettled (txid: string): Promise<boolean>
  /** Sync, idempotent. Clears selections, asset memo, per-txid latches, pendingHandoffs. In-flight settle() promises
   *  resolve, but no new submit starts after dispose. */
  dispose (): void
}
```
Semantics: single-flight per module instance, plus a per-txid in-flight latch. Submit order: parents first, exact stored bytes, `provider.submit([tm_color_<assetId>], atomicBEEF, offChainValues)`. Each attestation is verified (§3); `settled.<txid>` is recorded only then. A failed parent stops its descendants (`retry`). Overlay refusals never throw; they are reported. Already published members stay published (0207:420-423).
- No `txids`: (1) every offline-credited **receipt** is submitted (the recipient's duty); (2) every own `plain-nosend` hand-over: query `color-admission` for its token outputs; only if they are admitted, replay-submit to fetch the attestation and clear `color_offline`. **Never submit an own hand-over without host intent.**
- `txids` named: also submits named own hand-overs (post-ACK intent; the intent is persisted, so a later bare `settle()` retries it).
- After a verified admission of a tx that is an own `nosend` action, the module calls `wallet.createAction({ description: 'Settle token hand-over', options: { sendWith: [txid] } })` on the underlying wallet. A `createAction` that resolves is success regardless of `sendWithResults`, except an entry for this txid with status `'failed'` (⇒ `unsent` marker). Thrown errors of the form already broadcast / known / mined count as success; any other thrown error ⇒ `unsent` marker (D24). Host guards may hold the broadcast.

### 2.4 Built-in attested profile, exports, errors

```ts
export const ATTESTED_PROFILE_ID = 'https://brc.dev/207/attested'
export const ATTESTATION_PROTOCOL_ID: [2, 'color admission attestation']
export const ATTESTATION_KEY_ID = '1'
export const COLOR_OFFLINE_TAG = 'color_offline'
export function attestationMessage (assetId: string, txid: string, outputs: readonly number[]): string   // §3, throws on non-canonical outputs
export function attestationSigningKey (signer: string): PublicKey                                     // derived child (§3)
export function parseAttestation (value: JsonValue): ColorAttestation                                 // exact members, canonical; throws AttestationEvidenceError
export function verifyAttestation (att: ColorAttestation, assetId: string): boolean                   // never throws
export function attestationFromSteak (txid: string, topic: string, entry: AttestedAdmittance): ColorAttestation | undefined
export function createAttestedProfile (options?: {
  /** BRC-189 snapshot for any/same/all; absent ⇒ those modes fail closed. `identity` mode never calls it. */
  trustedIdentities?: () => Promise<{ snapshot: string, identityKeys: string[] }>
}): RequiredProfileHandler   // id ATTESTED_PROFILE_ID, versions [1], maxReceiptBytes 16 MiB
export function createColorModule (options: ColorPermissionModuleOptions): ColorPermissionModule  // unchanged name
```
Attested `checkDescriptor`: params exactly a map with optional `trustMode` ∈ {any, same, all, identity} (default any), `identityKey` (present iff identity), `evidenceProfile` (URI; when present, trustMode/identityKey absent and req contains it, 0207:435-445). `null` params invalid. Its own `ext` entry must be absent. It cannot be combined with BRC-209 in one asset. Capabilities: the module adds `brc207-color-attested: '1'` iff this handler is registered.

Error classes (all `extends Error`, `name` = class name, every message starts with `'[<ClassName>] '`; all exported as runtime values; hosts and lib match on `.name`, then the `[ClassName]` prefix, never `instanceof` across bundles):
`UnsupportedProfileError(message?)` (existing; keeps its default message; A.143 version mismatch uses 'BRC-207: the required processing profile version is unsupported'), `ProfileParamsError`, `ProfileDataError` (A.154 description "Profile data names an undeclared profile"), `AttestationEvidenceError` (`reason: string`; frontier/graph/signature failure), `ColorProviderError` (above), **`ColorConsentDeclinedError`** (thrown whenever `requestTokenAccess` returns false).

### 2.5 Consent message added

`requestTokenAccess(originator, JSON)` gets one new `type`. It is shown before an offline credit, and the host may answer from a continuing grant:
```json
{"type":"color_receive_offline","assetId":"<id>","outputs":[{"outputIndex":0,"amount":"1500"}],
 "unsettledTransactions":2,"signer":"<66hex K>","profiles":["https://brc.dev/207/attested","<issuer-v1 uri>"],"seekPermission":true}
```
`signer` is present in `identity` mode; `any`/`same`/`all` modes carry `signers: string[]` (sorted, deduplicated) instead. Declined ⇒ `ColorConsentDeclinedError`, internalize fails (no credit). Hosts may prompt every time (desktop D-DESK-3) or use a continuing grant (D19).
Every consent message type (new and existing) carries `seekPermission: boolean` (= originating `args.seekPermission !== false`). `color_send` carries `handoff: true` for plain-nosend assets (plan 02 Task 12; pin only). Otherwise `color_send`, `color_signature`, `color_access`, `color_relinquish` are unchanged. Display metadata (sym/label/icon) stays host-resolved (`color-admission` + `readDeploy`, untrusted, full asset id always shown); no T2 field in 0.2.0.

### 2.6 RN

The module is ESM-only and imports `@bsv/wallet-toolbox-client` values (`encryptMetadata`, `maybeDecryptMetadata`, `sdk.specOpBasketPrefixOutputs`) and `@bsv/sdk/primitives/*` subpaths. P-WAL aliases `@bsv/wallet-toolbox-client` → `@bsv/wallet-toolbox-mobile` in Metro and in jest `moduleNameMapper`, and enables Metro package exports (D21). P-T2 adds one test asserting that those symbols exist in `@bsv/wallet-toolbox-mobile` (export parity). A missing symbol is a T2 fix (import from a shared path), never a fork.

---

## 3. Attested statement (P-T2, P-LIB, P-GO byte-for-byte)

- Message (UTF-8, no newline): `"1color-admit:v1:" + "tm_color_" + assetId + ":" + txid + ":" + outputs.join(",")`.
  `assetId` `<64hex>_<vout>`; `txid` 64 lowercase hex; `outputs` non-empty, unique, strictly ascending uint32 in canonical decimal. **Signers sign the complete admitted set** of that topic for that tx (0175:83). The overlay already signs `CanonicalOutputs(outputsToAdmit)`.
- Digest: `SHA-256(message)` once.
- Key: BRC-42 child of the signer's identity key. Protocol `[2, "color admission attestation"]`, keyID `"1"`, counterparty `anyone`; invoice `2-color admission attestation-1`.
- Sign (TS): `new ProtoWallet(priv).createSignature({ data: utf8(message), protocolID: [2,'color admission attestation'], keyID: '1', counterparty: 'anyone' })` → DER → lowercase hex.
  Sign (Go): `ProtoWallet.CreateSignature(ctx, wallet.CreateSignatureArgs{EncryptionArgs: wallet.EncryptionArgs{ProtocolID: wallet.Protocol{SecurityLevel: 2, Protocol: "color admission attestation"}, KeyID: "1", Counterparty: wallet.Counterparty{Type: wallet.CounterpartyTypeAnyone}}, Data: []byte(message)}, "")`, with the overlay's `SERVER_PRIVATE_KEY`. A Go output that differs from the C.0 bytes is a bug (RFC 6979).
- Verify: child = `PublicKey.fromString(signer).deriveChild(new PrivateKey(1), '2-color admission attestation-1')`; ECDSA-verify the digest; **accept low- and high-S**; strict DER. Equivalent: `new ProtoWallet('anyone').verifySignature({data, signature, protocolID, keyID:'1', counterparty: signer, forSelf: false})`. Verified against @bsv/sdk 4.0.0 (ts-stack cbdccfe): both forms accept both C.0 signatures. **Never** verify against the bare key or a caller-supplied child.
- JSON attestation: exactly `{txid, outputs, signer, signature}` (0207:257-261). Unknown or duplicate members, an unsorted or duplicate `outputs`, uppercase hex or an invalid point ⇒ invalid.
- BRC-22 carrier (0175:79): STEAK entry `tm_color_<assetId>` → `{outputsToAdmit, coinsToRetain, coinsRemoved?, admissionSignature, admissionIdentityKey}`. Mapping: `{txid: <submitted tx id>, outputs: outputsToAdmit (must already be canonical), signer: admissionIdentityKey, signature: admissionSignature}`.
- Coverage: a Mandala asset requires `signer === descriptor.params.identityKey` (identity mode, K). Coverage is per `(signer, txid, vout)`.
- **Test vectors (every C.0 suite — T2, LIB, GO, WAL — asserts all five plus the HMAC tweak, plus the negatives)**: 0207:10224-10264 (C.0): priv 5555, signer `02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046`, HMAC tweak `6ef21748a4f6f5034842184e25f68e8df8663e036622ad9b3d061c6dd81ea93b`, child `033520aaa77b6914019796e974d1737acc890c5283c0921ddcfc2d5c815db8fb90`, digest `9f61b417ec979c3c057313fe56f3c6056d2962b6bceaaa8272377bb9a80d8f9d`, low-S `3045022100d1f48fc1…cc56758a` (signing MUST reproduce it), high-S `3046022100d1f48fc1…03dfcbb7` (verify only). Negatives: reordered outputs, missing index 2, other topic, keyID `2`, trailing newline, bare-key verify ⇒ all fail.
- `tm_mandala` (registry) keeps σI v3 `mandala-admit:v3:` signed by the **bare** overlay key (B1; unchanged). `tm_mandala_kyc` stays unsigned. Overlay predicates: `IsColorTopic(name)` (attested v1) and `name == "tm_mandala"` (v3); `IsSigmaTopic` is removed (internal `AdmissionSchemeOf` replaces it); `IsTokenTopic` stays as an alias of `IsColorTopic`.

---

## 4. Profiles and the Mandala deploy (P-T2, P-LIB, P-GO, P-APP)

| Profile | Id | version | params (DAG-CBOR) |
|---|---|---|---|
| attested | `https://brc.dev/207/attested` | `1` | `{"trustMode":"identity","identityKey":K}` (exactly these 2 members for Mandala) |
| Mandala issuer | `https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md` (80 bytes) | `1` | `{"identityKey":K}` (exactly) |

K = the Mandala overlay's identity key (`SERVER_PRIVATE_KEY` pub), lowercase compressed hex, DAG-CBOR **text**.

**Issuer-v1 semantics** (P-LIB writes `docs/profiles/issuer-v1.md`): replaces the baseline "receipt admission" procedure (receipt submit-then-verify, 0207:126-141, 0207:1479 named as replaced). A wallet credits only (a) after its own submit to the configured overlay for K returns a verified attestation covering the output, or (b) under attested offline evidence. This requires attested v1 in `identity` mode with the same K in the same `req`, otherwise `ProfileParamsError`. Every holder token action is a plain-noSend hand-over (`sendPolicy`). `operations: ['transfer']` only (holder I==O; no holder burn/mint/authority through the module). 1-sat token outputs. One Mandala asset per tx. Each tx's submission data (§5) is required and non-empty for every unattested tx (C42). The overlay URL is wallet configuration; params carry only K (0207 A.21). Fail closed when no overlay endpoint is configured for K (S5). Issuer-v1 defines **no `ext` state** (own `ext` entry must be absent). Its **profileData leaf exists only in action plans** (§5.2). In receipts and hand-overs the leaf MUST be absent (no `checkReceiptData`).
Local hop checks: before offline acceptance (transport-only `unavailable`), `admitReceipt` checks every unanchored hop locally for Mandala policy — per-asset I==O unless an authority input is present, 1-sat token outputs, single asset, no non-deploy `req`/`ext`, envelope covers exactly the token outputs with verifier K and keyID `'color'` — and throws `ProfileDataError` otherwise.

**Mandala deploy payload** (DAG-CBOR map; canonical key order is length-first, then bytewise): `dec` (uint 0..18), `req` (above), `sym` (text 1..32 chars), `icon` (optional `[text, bytes]`), `label` (text 1..64 chars), `feeRatePerKb` (optional, the console no longer writes it by default, B6). `ext` MUST be absent. Diagnostic: `{"dec":2,"req":{…},"sym":"TUSD","label":"Test Dollar"}`.

**Fixture F-REQ** (K = C.0 signer `02798b81…124046`). Generated with @bsv/templates `encodeStrictCbor` at ts-stack cbdccfe. P-LIB checks it in at `lib/src/__fixtures__/1color-deploy.json` with the fixed schema `{identityKey, sym, dec, label, reqHex, payloadHex, lockingScriptHex}`; P-GO copies the file byte-for-byte to `overlay-go/internal/mandala/testdata/1color-deploy.json`. Both suites compare against the hex below.
- `req` VALUE (328 bytes):
`a2781c68747470733a2f2f6272632e6465762f3230372f6174746573746564a266706172616d73a26974727573744d6f6465686964656e746974796b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01785068747470733a2f2f6769746875622e636f6d2f6273762d626c6f636b636861696e2f6d616e64616c612f626c6f622f6d61737465722f646f63732f70726f66696c65732f6973737565722d76312e6d64a266706172616d73a16b6964656e746974794b657978423032373938623831393531613661386337656638626564613039623036613233303331643765666166333762363633323635653031383861623337383132343034366776657273696f6e01`
- Whole payload `{"dec":2,"req":…,"sym":"TUSD","label":"Test Dollar"}` (365 bytes) = `a4636465630263726571` + req value + `6373796d6454555344656c6162656c6b5465737420446f6c6c6172`.
- Deploy locking script with pkh = hash160(K) (test only): `00006d4d6d01` + payload + `7576a914a1d8edf2f9ebd6d2fe4728e0eb3bd369ab78d76a88ac`.

**Overlay deploy policy** (P-GO, on `tm_mandala` + `tm_color_<txid>_0` deploy submits; all failures are ERR_SHAPE, final):
0. A 36-byte id ⇒ ERR_SHAPE `output N: legacy 36-byte token id <id> is refused by Mandala policy (32-byte ids only)`, checked before token scoping.
1. The payload is a canonical push of a strictly valid DAG-CBOR map (full DAG-CBOR reader, D14). Size ≤ 65536 bytes; depth ≤ 64.
2. Existing sym/dec/label/feeRatePerKb/deploySig/trusted-issuer rules are unchanged and run first. Then `req` is present and, decoded, is exactly the 2-entry map above with K == this overlay's identity key. Equality is checked by re-encoding the expected map and comparing bytes with the decoded `req` re-encoded (no normalization of the input: a non-canonical input already fails step 1).
3. `ext` is absent. `icon`, if present, is exactly `[text, bytes]`.
4. Pinned reason strings (after sym/dec/label/feeRate): `missing key req`, `req does not match this overlay's Mandala profiles`, `req must be a map`, `ext is not allowed on a Mandala deploy`, `icon must be [mediaType, bytes]`. KYC deploys (`tm_mandala_kyc`) do not require `req`. Admin details/authority keep the 4096-byte policy limit; `feeRatePerKb` keeps the JS safe-integer bound (not a token amount).
5. Non-deploy outputs on every Mandala token topic (`tm_color_*` and `tm_mandala_kyc`): a payload that is a valid map containing `req` or `ext` ⇒ ERR_SHAPE `output N: req and ext are deploy-only under Mandala policy` (D14). Authority `{adm}` payloads are unchanged.
6. Vector replays: the brc162.json `id-*` rejectScripts rows are remapped to OneColor messages in a documented table (vector file unchanged). `mandala-rejects.json` stays byte-pinned; its replay remaps `tm_<hex>`→`tm_color_<hex>_0` plus a reviewed override table.

---

## 5. Mandala envelope (owner linkage) as submission data (P-T2 hook, P-LIB, P-GO)

### 5.1 Bytes (unchanged overlay semantics)

`offChainValues` = UTF-8 JSON of the existing v3 envelope (`envelope.go DecodeEnvelope`, lib `encoding.ts`), renamed in TS to `MandalaEnvelope`:
```ts
interface SpecificLinkage {            // BRC-72; arrays are JSON number arrays (0..255)
  prover: string; verifier: string; counterparty: string
  protocolID: [2, string]; keyID: string
  encryptedLinkage: number[]; encryptedLinkageProof: number[]; proofType: 0
}
interface MandalaEnvelope {
  inputs?: Array<{ index: number, linkage: SpecificLinkage }>   // optional for overlay (ownership.go:239)
  outputs?: Array<{ index: number, linkage: SpecificLinkage }>  // REQUIRED for every token output of the asset (rNoLinkage)
  admin?: Array<{ index: number, details: string }>             // issuer/admin txs only (lib-built)
  deploySig?: string                                            // deploys only (lib-built)
}
```
Holder transactions (module path) carry **`{"outputs":[…]}` only**: entries sorted by `index`, inputs omitted (D3). Issuer and admin txs keep the full shape, built by the lib exactly as today. Only the protocol tuples change.

Linkage for a `p color` output: `protocolID = [2, "p color <assetTag> <hex(utf8(prefix))> <hex(utf8(suffix))>"]`, `keyID = "color"`, `verifier = K`, `prover` = the **real** identity key of the party that derived the key (sender A, even when the receipt says A′). `counterparty` = the owner's identity key (recipient B, or the sender's own key for change). The overlay derives `hash160(counterparty + L·G)` (linkage.go) unchanged. `encryptedLinkage` = `wallet.encrypt({plaintext: L, protocolID: [2, 'specific linkage revelation 2 <protocol name>'], keyID: 'color', counterparty: K})` by the prover. `encryptedLinkageProof` = same encrypt of `[0x00]`, `proofType: 0`.

Who produces what:
| Output | Producer | How |
|---|---|---|
| recipient output (blinded or not) | sending app via lib `recipientLinkage()` (§8) | `L = HMAC(S′ or S, invoice)`, `S` from `rootSharedSecret(wallet, B)`, `S′ = S + r·B` (blinding.ts math unchanged). Never `revealSpecificKeyLinkage` on a `p color` protocol through the manager: the module refuses it (0207:597-600). |
| wallet-owned output (token change, plan.ownedOutputs) | Mandala handler `submissionData`, via `ctx.wallet` (underlying) | `revealSpecificKeyLinkage({counterparty: custody.senderIdentityKey, verifier: K, protocolID, keyID: 'color'})`; envelope entry: `counterparty` = owner identity key (`ctx.identityKey`, the overlay's base key), `prover` = the reveal result's `prover`, other members from the reveal result |
| issuer/admin outputs, holder payouts by issuer | lib in the console | as today, plus the p color tuple for payouts (B4) |

Receipt `senderIdentityKey` = A′ when blinded (B3) while the envelope `prover` = A. **This mismatch is intended.** Do not "fix" it.

### 5.2 Carriage

- **Action plan (sender app → wallet module)**: `plan.profileData["<issuer-v1 uri>"]["<assetId>"] = {"outputs":[{"index":n,"linkage":{…}}]}`, exactly covering the plan's **non-owned** token outputs of that asset (indices = requested-output indices; `randomizeOutputs:false`). `checkPlanData` rejects: an extra or missing index, an index that is not a token output of the asset, `verifier ≠ K`, `prover ≠ ctx.identityKey`, `keyID ≠ 'color'`, a protocolID that is not a valid `p color <assetTag of this asset> …` name (0207:540-548), `proofType ≠ 0`, byte arrays empty or > 1024 entries, unknown members. Absent leaf with ≥1 non-owned token output ⇒ `ProfileDataError`.
- **Handler output**: `submissionData` = plan leaf entries ∪ owned-output entries ⇒ `{"outputs":[…sorted]}` UTF-8 bytes.
- **Receipts / hand-over / settle**: inside the attested leaf `submissions: [{txid, offChainValues: <lowercase hex of those bytes>}]` (0207:313-322), one entry per unattested tx incl. the tip. **Required and non-empty** for Mandala.
- **Submit**: `ColorOverlayProvider.submit([tm_color_<assetId>], atomicBEEF, offChainValues)`. The Mandala provider frames the body as below.

---

## 6. Overlay HTTP / BRC-22 / BRC-24 after the change (P-GO serves; P-LIB and P-T2 consume)

**POST /submit** (unchanged framing): headers `Content-Type: application/octet-stream`, `X-Topics: <JSON array>`, and `x-includes-off-chain-values: true` iff offChainValues non-empty. Body = `CompactSize(len(beef)) ‖ beef ‖ offChainValues` (Bitcoin varint), else bare beef. beef = AtomicBEEF (BRC-95) of the subject tx.
- 200: `Record<topic, {outputsToAdmit: number[], coinsToRetain: number[], coinsRemoved?: number[], admissionSignature?: string, admissionIdentityKey?: string}>`. `tm_color_*` entries are signed per §3; `tm_mandala` entries per v3; KYC entries are unsigned. Idempotent replay of an applied tx returns the same entries, re-signed deterministically.
- Error: HTTP per verdict table (unchanged: 400 final, 409 retryable policy, 410 evicted, 503 ERR_UNAVAILABLE). Body `{"status":"error","code":"ERR_*","retryable":bool,"description":str,"message":str,"spendTxid"?:str}`. Codes unchanged: ERR_CONSERVATION, ERR_LINKAGE, ERR_SHAPE, ERR_SATOSHIS, ERR_AUTHORITY, ERR_INPUT_SPENT, ERR_UNTRUSTED, ERR_PAUSED, ERR_FROZEN, ERR_SANCTIONED, ERR_ACCESS, ERR_MEMBERSHIP, ERR_EVICTED, ERR_UNAVAILABLE. Unhosted topic: 400 `unknown-topic: <name>` (e.g. `tm_color_<id>_1`).
- Provider error mapping (P-LIB Mandala provider): fetch failure, timeout, non-JSON, or 5xx/503 ⇒ `ColorProviderError(code 'ERR_UNAVAILABLE', retryable true, transport true)`. A typed 4xx/409/410 ⇒ `(code, body.retryable, transport false)`. Message: `'[ColorProviderError] mandala overlay refused (<CODE>[, retryable]): <description>'`. Receivers classify on `name`, then the `[ClassName]` prefix, then `(ERR_` code.

**POST /lookup** body `{"service": "...", "query": {...}}` → `{"type":"output-list","outputs":[{"beef":number[],"outputIndex":n,"txid":"<64hex>"}]}`. `txid` is **required** from overlay-go, derived from the AtomicBEEF subject (`01010101` header): the module passes it to `Transaction.fromBEEF(beef, txid)`. A non-atomic BEEF answer is a 500 fail-closed; engine formula hydration always yields AtomicBEEF. Store/engine faults ⇒ 503 `ERR_UNAVAILABLE` retryable (the Mandala provider maps them to transport errors); other lookup errors stay 400.

**Renames the topic change forces in overlay-go** (topics.go and httpapi): `tokenTopicPattern` → `^tm_color_([0-9a-f]{64})_0$`; `TokenTopic(id)` → `tm_color_<id>`; `TokenLookup(id)` → `ls_color_<id>`; `TokenIDOfTopic`/`IsTokenTopic` follow; the `DeployTokenOf`/`hostRuleTopics` pairing becomes `tm_mandala` + `tm_color_<txid>_0`; `IsSigmaTopic` is split as in §3; the activity feed and admin routes key by the same id.
- `ls_color_<assetId>`, `color-spendability` / `color-admission` (0207:743-775). The query object has exactly these members: `{"type":"color-spendability"|"color-admission","version":1,"assetId":"<id>","topic":"tm_color_<id>","outpoints":["<txid>.<vout>",…]}`. assetId = service asset, topic = `tm_color_<assetId>`, outpoints 1..1000, unique, canonical dot form; anything else ⇒ "Invalid lookup query: …" (family pinned in plan 03 Task 11). The answer contains exactly the queried outpoints that are: **spendability** = admitted AND unspent AND not frozen AND not reissued (`evictedOutpoints`); paused assets are not filtered, and the module's resubmit-recheck-exclude on such outputs is expected (at most one replay per spend attempt). **admission** = engine output on `tm_color_<id>` (spent or not) AND an admission record that is not evicted; a provisional (pending) record counts (**P-GO must verify that the engine resolves spent outputs into the output-list**). The deploy `<txid>.0` is admitted to its asset topic, so `color-admission` answers it (the module's deploy resolution depends on this).
- Discriminator: a query containing `type` takes the color branch only; without `type`, the existing Mandala keys (`metadataTokenId`, `authoritiesTokenId`, `tokenId`, `txid`, `outputIndex`, `limit`, `skip`; `assetStateTokenId`/`adminHistoryTokenId` still "Unsupported query") behave as today, with `tokenId` values = assetId. Mixing ⇒ invalid.
- `ls_mandala`, `ls_mandala_kyc`: unchanged.
- **Not** advertised as a conforming `color` service (no SHIP/SLAP, design §3). The shapes exist for interface compatibility only.

**Admin HTTP**: routes unchanged (`:tokenId` = assetId). `/admin/admission/:txid?payloadHash=` → `{txid, admissions:{<topic>:{outputsToAdmit, admissionSignature}}, admissionIdentityKey, at}`, topics now `tm_color_<id>` (attested sig) and `tm_mandala` (v3). Every token amount in any JSON body (`amount`, `delta`, `frozenAmount`, supplies, balances, activity `amount`) is a decimal string (§0).

**Storage (P-GO internal)**: per-output amounts and aggregates are Mongo **Decimal128** (exact to 34 digits; bound 10^34-1 enforced at submit on supply+Δ and |Δ| with ERR_SHAPE "amount aggregate exceeds storage range"; per-identity balances beyond it are reported by `RebuildBalances.Unsafe`, D13). In-memory sums use `*big.Int`. Removed: the `MaxSafeAmount` 2^53 cap on outputs, sums and supply. Fresh `NODE_NAME` for any live boot.

---

## 7. Hand-over carriers (P-LIB builds/parses; P-WAL, P-DESK, P-APP transport)

### 7.1 Receipt instruction (BRC-207 internalize, 0207:1431-1440)

```json
{"version":1,"assetId":"<id>","derivationPrefix":"<b64>","derivationSuffix":"<b64>","senderIdentityKey":"<A or A′>",
 "profileData":{"https://brc.dev/207/attested":{"<id>":{
    "declarationTx":"<deploy raw tx hex>",
    "transactions":["<raw hex of each unattested token ancestor, parents first; excludes the tip>"],
    "attestations":[{"txid":"…","outputs":[0],"signer":"<K>","signature":"<der hex>"}],
    "submissions":[{"txid":"<each unattested ancestor and the tip>","offChainValues":"<envelope hex>"}]}}}}
```
- Exactly these members (no `lifecycles`: Mandala uses no BRC-177). The attested leaf is **required** on every Mandala receipt, including issuer payouts. For an already-admitted tip, the tip's attestation is in `attestations` and its submission is still in `submissions`. Custominstructions limit: 16 MiB (attested). `internalizeAction` args: `outputs[i] = {outputIndex, protocol: 'basket insertion', insertionRemittance: {basket: 'p color <assetTag>', customInstructions: JSON.stringify(receipt)}}`. The tx is AtomicBEEF.
- Mandala `admitReceipt` (recipient wallet): always submits online (idempotent), in `graph.pending` order, or `graph.tip` when `pending` is empty (attested tip, D7). A typed verdict (any code, retryable or not) ⇒ throw ⇒ no credit. Transport failure ⇒ `unavailable` ⇒ attested offline acceptance + `color_receive_offline` consent ⇒ credit `color_offline` (D6/D7).

### 7.2 MessageBox body (box name `mandala-color`, D11)

```json
{"v":3,"kind":"handover","assetId":"<id>","outputIndex":0,"tx":"<AtomicBEEF hex>","receipt":{…§7.1 object…},"note":"optional"}
```
No amount field: the amount is read from the script (0175:129). The recipient passes `receipt` to `internalizeAction` verbatim (`JSON.stringify`) and acknowledges the message only after the internalize resolves (credited or definitively refused). A v1/v2 body ⇒ refused and acknowledged (no back-compat). A `ColorConsentDeclinedError` receipt is **not** acknowledged; the receiver records it in `processed` and does not re-prompt it in the same session. Nearby (localpay) treats a decline as final (no retry channel). "ACK" for sender post-ACK settlement = MessageBox `sendMessage` success, or the localpay `settlementAck` frame.

### 7.3 localpay frame (P-WAL): `FRAME_VERSION = 6`

`PaymentFrame` keeps `version, kind, senderIdentityKey (A or A′), outputIndex, derivationPrefix, derivationSuffix, note?, transaction (AtomicBEEF)`.
`TokenPayment` v6 = `{ assetId: string /* underscore form <64hex>_0 */, certificates: Uint8Array[] /* unchanged opaque */, profileData: string /* UTF-8 JSON of the receipt's profileData object */ }`. **Removed:** `overlayUrl`, `overlayIdentityKey`, `linkage`, `admissions`. The payee uses its own configured overlay (0175:129). The payee builds §7.1 from the frame fields. A frame with version < 6 ⇒ CodecError. Session codec: `SESSION_VERSION = 2`; the token amount `a` is a canonical decimal string and the session asset drops overlay url/key (`u`/`k`); a v1 session ⇒ CodecError.

---

## 8. `@bsv/mandala` 0.5.0 public API (P-LIB provides; P-APP, P-DESK, P-WAL consume)

Package: ESM. `peerDependencies`: `@bsv/sdk ^4.0.0`, `@bsv/templates ^2.2.0`, `@bsv/message-box-client ^2.5.4`, `@bsv/color-permission-module ^0.2.0` (**optional**, only `./profile` imports it). `devDependencies`: the vendored tarballs (§9). No `dependencies` on @bsv packages (D9). The core entry stays RN-safe and does not import the color module.

### 8.1 `@bsv/mandala` (core)
```ts
// constants / naming
export const TOPIC = 'tm_mandala', LOOKUP = 'ls_mandala', REGISTRY_TOPIC = 'tm_mandala_kyc', REGISTRY_LOOKUP = 'ls_mandala_kyc'
export const MESSAGEBOX = 'mandala-color'
export const ATTESTED_PROFILE_ID = 'https://brc.dev/207/attested'
export const MANDALA_PROFILE_ID = 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md'
export const TREASURY_BASKET = 'mandala treasury'           // console issuer/admin outputs (non-P basket, D18)
export const ADMIN_PROTOCOL: [2, 'mandala admin']           // Mandala-key outputs (treasury, authority, deploy, registry, payout change); FT_PROTOCOL stays removed
export function actionDescription (text: string): string     // every lib-built createAction description; 5..50 chars; 'Redeem <amount>' prefix preserved
export function colorTopic (assetId: string): string; export function colorLookup (assetId: string): string
export function assetTag (assetId: string): string;   export function colorProtocolID (assetId: string, prefix: string, suffix: string): [2, string]
export function colorBasket (assetId: string, role?: 'value' | 'authority'): string
export function configureMandala (e: { overlayUrl?: string, overlayIdentityKey?: string, messageBoxUrl?: string, adminApiToken?: string, storage?: MandalaStorage }): void  // `basket` option removed
// amounts
export const MAX_UINT64: bigint
export function formatAmount (units: bigint, dec: number): string      // exact plain decimal, trailing fractional zeros trimmed, no grouping, '-' for negatives; RangeError if dec ∉ 0..18
export function parseAmount (text: string, dec: number): bigint        // throws on >dec places, negative, > MAX_UINT64
export function parseDecimalAmount (v: string, signed?: boolean): bigint // JSON decimal strings (§0)
// formatAmountGrouped / formatCurrency stay (bigint); formatAmountPlain is removed
// deploy / req
export function mandalaReq (identityKey: string): Record<string, { version: 1, params: Record<string, string> }>
export function deployPayload (m: { sym: string, dec: number, label: string, identityKey: string, icon?: { mediaType: string, bytes: number[] }, feeRatePerKb?: number }): number[]
  // TypeError unless dec 0..18, sym 1..32 and label 1..64 code points (the console validates the same bounds locally)
export function readDeploy (lockingScript: LockingScript | string, txid: string): { assetId: string, sym?: string, dec: number, label?: string, mandalaKey?: string /* K iff req == mandalaReq(K) */ } | null
// tokens
export interface DecodedToken { role: 'deploy' | 'authority' | 'value', assetId?: string, amount: bigint, payload?: number[] }
export function decodeToken (script: LockingScript | string, txid?: string, vout?: number): DecodedToken | null   // no 2^53 logic
// attestation (own implementation, §3; tested on C.0)
export interface Attestation { txid: string, outputs: number[], signer: string, signature: string }
export function attestationMessage (assetId: string, txid: string, outputs: number[]): string
export function verifyAttestation (a: Attestation, assetId: string, expectedSigner: string): boolean
export function attestationFromSteak (txid: string, assetId: string, steak: Record<string, any>): Attestation | undefined
export function signAttestation (wallet: WalletInterface, assetId: string, txid: string, outputs: number[]): Promise<string> // ProtoWallet.createSignature; reproduces C.0
// overlay transport
export function submitToOverlay (beef: number[], offChainValues: number[] | undefined, facilitator: unknown | undefined, topics: string[], expectedSigner?: string): Promise<Record<string, any> /* STEAK */>
  // throws OVERLAY_IDENTITY_KEY_UNSET before sending
export function postLookup (service: string, query: unknown): Promise<LookupAnswer>   // throws LookupError
export class LookupError extends Error { code: string; retryable: boolean; transport: boolean }
export function fetchDeployTx (assetId: string): Promise<Transaction>   // hash-verified; memoizes only verified answers
// registry σI v3 (tm_mandala only): admissionMessageV3, verifyAdmission, payloadHash, fetchAdmission (topic regex now ^tm_color_[0-9a-f]{64}_0$|^tm_mandala$)
// envelope + linkage
export type { SpecificLinkage, MandalaEnvelope }
export function encodeEnvelope (e: MandalaEnvelope): number[]; export function decodeEnvelope (b: number[]): MandalaEnvelope
export function recipientLinkage (wallet: WalletInterface, a: {
  identityKey: string, recipientKey: string, assetId: string, derivationPrefix: string, derivationSuffix: string,
  overlayIdentityKey: string, blind: boolean
}): Promise<{ pubKeyHash: number[] /* caller locks: new OneColor().lock(assetId, amount, pubKeyHash), 1 sat, no payload */,
              senderIdentityKey: string /* A′ or A */, r?: string, linkage: SpecificLinkage }>
// plan (own encoder; vector-checked against 0207 A.159 and ColorPlan.toLabels)
export interface ColorPlanV1 { version: 1, assets: string[], ownedOutputs: Array<{ outputIndex: number, assetId: string, derivationPrefix: string, derivationSuffix: string, senderIdentityKey: string }>, operations: Array<{ assetId: string, operation: string }>, inputPositions: [], changePositions: [], sighashTypes: [], profileData?: Record<string, Record<string, unknown>> }
export function planLabels (plan: ColorPlanV1): string[]               // 'p color plan <i> <n> <200-hex chunk>'
// holder send (any BRC-100 wallet hosting the color module + Mandala profile)
export interface HandoverResult { txid: string, tx: number[] /* AtomicBEEF */, reference: string, outputIndex: number, receipt: ReceiptInstruction, offChainValues: number[] }
export function sendHandover (p: { wallet: WalletInterface, identityKey: string, assetId: string, amount: bigint, recipientKey: string,
  blind?: boolean /* default true; false forced when recipient === identityKey */, note?: string,
  derivationPrefix?: string, derivationSuffix?: string /* both or neither; ≤48 UTF-8 bytes, no whitespace */,
  journal?: boolean /* default true */ }): Promise<HandoverResult>
export function deliverHandover (p: { messageBoxClient: MessageBoxSender, recipientKey: string, handover: Pick<HandoverResult, 'txid' | 'tx' | 'outputIndex' | 'receipt'>, note?: string }): Promise<void>
export type { MessageBoxSender, MessageBoxLike }
// hand-over journal: stages 'signed' (not delivered; never auto-submitted, aborted or swept) and 'delivered' (ACKed; reconcile resubmits). 'handed_over' is removed.
// The app uses these, never a second queue (05-A1).
export function markHandoverDelivered (txid: string): Promise<void>
export function journalListHandovers (): Promise<HandoverJournalEntry[]>
export function resubmitDelivered (wallet: WalletInterface, entry: HandoverJournalEntry, overlayIdentityKey: string): Promise<void>
export function settleHandover (p: { wallet: WalletInterface, handover: Pick<HandoverResult, 'txid' | 'tx' | 'offChainValues'>, assetId: string, overlayIdentityKey: string }):
  Promise<{ status: 'admitted', attestation: Attestation } | { status: 'retry' | 'refused', code: string }>   // post-ACK sender submit + verified attestation + sendWith
// receive
export function receiveHandovers (p: { wallet: WalletInterface, messageBoxClient: MessageBoxLike, assetId?: string, processed?: Set<string> }):
  Promise<{ accepted: Array<{ messageId: string, txid: string, assetId: string, amount: bigint, outputIndex: number, offline: boolean }>, failed: Array<{ messageId: string, error: unknown, code?: string }> }>
export function parseHandoverBody (body: unknown): { assetId: string, outputIndex: number, tx: number[], receipt: ReceiptInstruction, note?: string }   // throws InvalidTransferError
export type ReceiptInstruction = { version: 1, assetId: string, derivationPrefix: string, derivationSuffix: string, senderIdentityKey: string, profileData: Record<string, unknown> }
// issuer / admin / registry (console; Mandala keys, overlay-first noSend→submit→sendWith, TREASURY_BASKET)
export function registerAsset (p: { wallet, identityKey: string, label: string, ticker: string, decimals: number, icon?: { mediaType: string, bytes: number[] }, feeRatePerKb?: number /* console omits it, B6 */ }): Promise<RegisterResult>  // deploy carries mandalaReq(OVERLAY_IDENTITY_KEY)
export function issueTokens (p: { wallet, identityKey: string, asset: AdminAsset, amount: bigint, depositHash?: string }): Promise<IssuerOpResult>  // mint into treasury (Mandala keys, TREASURY_BASKET), as today
export function payoutTokens (p: { wallet, identityKey: string, asset: AdminAsset, amount: bigint, recipientKey: string, blind?: boolean /* default false */,
  messageBoxClient: MessageBoxSender, note?: string }): Promise<PayoutResult>
export interface PayoutResult extends AdmissionReceipt { txid: string, receipt: ReceiptInstruction, outputIndex: 0, notified: boolean } // no nextAuth* fields
  // B4: treasury inputs (Mandala keys) → holder p color output via recipientLinkage (+ treasury change), overlay-first noSend→submit→sendWith,
  // attestation verified, then §7.2 body delivered on MESSAGEBOX (receipt attested leaf: attestations=[tip], submissions=[tip]).
  // The `reissue` admin action builds its recipient output through the same payout path.
export function redeemTokens (p: { wallet, identityKey: string, asset: AdminAsset, amount: bigint, balance?: bigint }): Promise<IssuerOpResult>
export function loadHistory (wallet: WalletInterface, o?: { scope?: 'treasury' | 'holder' | 'all' }): Promise<HistoryRow[]>
  // treasury kinds plus holder transfer/receive actions (labels 'mandala' + 'transfer'/'receive'); HistoryRow.amount is bigint
export function submitAdminAction (p: SubmitAdminActionParams /* amounts bigint */): Promise<SubmitAdminActionResult>
export function listAdminAssets (wallet: WalletInterface): Promise<AdminAsset[]>
export function createMandalaClient (o: MandalaClientOptions): MandalaClient   // send=sendHandover+deliverHandover(+settleHandover when online), receive=receiveHandovers; amounts bigint
// storage (unchanged interface)
export interface MandalaStorage { getItem (k: string): Promise<string | null>; setItem (k: string, v: string): Promise<void>; removeItem (k: string): Promise<void>; keys (prefix: string): Promise<string[]> }
// blinding: r is stored sender-side keyed by OUTPOINT `<txid>.<vout>` of the recipient output (BlindingRecord {outpoint, r, senderBlinded, recipient, assetId, at}); never sent.
```
`sendHandover` steps: build the recipient output via `recipientLinkage` + `OneColor.lock(assetId, amount, pkh)`, then `createAction({description, outputs:[{lockingScript, satoshis:1, outputDescription}], labels: planLabels({…operations:[{assetId,operation:'transfer'}], profileData:{[MANDALA_PROFILE_ID]:{[assetId]:{outputs:[{index:0,linkage}]}}}}), options:{noSend:true, randomizeOutputs:false}})`. Then `signAction({reference, spends:{}})`, read `result.colorHandoff` (absent ⇒ throw: the wallet lacks the T2 0.2.0 Mandala profile), and journal before returning (stage `signed`). A send to self uses `ownedOutputs` and no plan leaf. Multi-tab: web lock `mandala.send` kept.

**Retained subpath modules** (amounts `bigint`): `history`, `metadata`, `adminState` (incl. `resolveAssetState`, `frozenOutpoints[].amount`), `adminHistory` (`delta`), `overlayActivity` (`amount`), `banking` (`MockTransfer.amount`, reconcile), `submitGuards` (inputs), `singleFlight`, `adminAuthGate`, `contacts`, `contactsStore`, `registry` (`fetchRegistry`, `registryIsLive`), `reconcile` (`ReconcileOptions { sweep?: boolean }`; the sweep is skipped automatically while any `signed`/`delivered` hand-over entry exists), `notifyJournal` (`reconcileNotifications`), `feeRate` (`setFeeRate`), `assetRecover`, `assets` (`submitAdminAction` with `ftOutput.amount` bigint and `messageBoxClient`). The lib-source invariants removed from `app/src/robustness.wiring.test.ts` are owned by P-LIB's suite.

**Holder rules**: D1 (one Mandala asset per tx) and the 1-sat/linkage-script checks are enforced at `signAction` (`view.tx` set); createAction views are per asset. The `p color assets` / `p color balance <assetTag>` selectors and state tags are built by hosts from `assetTag` (0207:606-697); no lib helper. `p color balance` includes `color_offline` available outputs (0207:396-404, C40): hosts show the unsettled portion as a subset of the balance and `color_state_pending` as separate incoming value, never summed.

**Removed exports** (compile errors are intended): `FT_PROTOCOL`, `BASKET`, `MAX_SAFE_AMOUNT`, `tokenTopic`, `tokenLookup`, `tokenTopicOrEmpty`, `isSigmaTopic`, `deployTopics` (→ `[TOPIC, colorTopic(id)]` inline), `decodeValue`, `lockToken`, `transferTokens`, `TransferParams/Result`, `receiveTokens`, `defaultSettle`, `SettleFn/SettleArgs`, `IncomingTransfer`, `cover`, `AdmissionBundle`, `canonicalBundleId`, `collectHandoverEvidence`, `journalEvidenceSource`, `EvidenceSource`, `HandoverBody` (v2), `WireAdmission`, `WireLinkage`, `admissionDigestV3` for token topics, the `ftSelect`/`ftChange`/`ftCandidates`/`unlock` subpaths, `MandalaLinkagePayload` (→ `MandalaEnvelope`), `encodeLinkagePayload` (→ `encodeEnvelope`).

### 8.2 `@bsv/mandala/profile` (imports `@bsv/color-permission-module`)
```ts
export interface MandalaProfileOptions {
  overlays: Array<{ identityKey: string, url: string }>   // wallet configuration; K absent ⇒ assets fail closed (S5)
  fetch?: typeof fetch
  timeoutMs?: number                                       // default 15000
}
export function createMandalaProfile (o: MandalaProfileOptions): RequiredProfileHandler
  // id MANDALA_PROFILE_ID, versions [1], sendPolicy 'plain-nosend', operations ['transfer'], maxReceiptBytes 16 MiB,
  // checkDescriptor (§4), provider (routes by K), deployProviders (all configured), checkPlanData / submissionData (§5), admitReceipt (§7.1)
export function createMandalaOverlayProvider (o: { url: string, identityKey: string, fetch?: typeof fetch, timeoutMs?: number }): ColorOverlayProvider & { readonly url: string, readonly identityKey: string }
export { MANDALA_PROFILE_ID }
```
Host registration (P-DESK, P-WAL; identical shape):
```ts
const color = createColorModule({
  wallet: underlyingWallet, provider: defaultProvider /* SDK LookupResolver/SHIP-based for baseline assets */,
  requestTokenAccess, store,
  profiles: { [ATTESTED_PROFILE_ID]: createAttestedProfile(), [MANDALA_PROFILE_ID]: createMandalaProfile({ overlays: [{ identityKey, url }] }) }
})
new WalletPermissionsManager(underlyingWallet, adminOriginator, { permissionModules: { color } })
```
P-DESK calls `color.settle()` at unlock, every 5 min while unlocked and on the `online` event (single-flight, D17). P-WAL's runtime calls `settle({txids:[txid]})` after a hand-over ACK and bare `settle()` on reconnect/foreground. Hosts call `color.dispose()` at teardown.

Host rules (P-DESK, P-WAL):
- **Default provider**: may be a host SHIP/LookupResolver wrapper with a capturing facilitator that returns the host STEAK; `offChainValues` are refused on it; a chain with no preset fails closed. A Mandala-only host MAY pass the Mandala provider as the default (profile-free assets then fail closed against the Mandala overlay).
- **Broadcast guard**: hosts MUST hold toolbox broadcast of any tx with a BRC-162 output until `module.isSettled(txid)`; an `internalizeAction` of a receipt must not reach the network before verified admission. Guards key on host-owned journals or `isSettled`, never on `color.v1.*` keys.
- **HTTP bridges** (BRC-100 over HTTP) MUST forward errors as `{message, name, code?, retryable?, transport?}`; receivers match on `name` or the `[ClassName]` message prefix (D22).

---

## 9. Vendoring unpublished packages (P-T1/P-T2 produce; every consumer installs)

Nothing is published to npm (all six are unpublished as of 2026-10-22: npm has sdk 3.2.1, toolbox 2.14.9, templates 2.0.0, no color module).

**Build and pack** (after T1/T2 commits on `feat/1color-profiles`; clean tree required, `git status --porcelain` empty):
```bash
TS=/Users/personal/git/ts-stack-wt/1color
OUT=/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack
SHA=$(git -C $TS rev-parse --short=7 HEAD)
cd $TS && pnpm install --frozen-lockfile
pnpm --filter "@bsv/color-permission-module..." --filter "@bsv/wallet-toolbox-mobile..." --filter "@bsv/wallet-toolbox..." run build
mkdir -p $OUT
for p in @bsv/sdk @bsv/templates @bsv/wallet-toolbox @bsv/wallet-toolbox-client @bsv/wallet-toolbox-mobile @bsv/color-permission-module; do
  pnpm --filter "$p" pack --pack-destination "$OUT"; done
cd $OUT && for f in bsv-*.tgz; do case $f in *-$SHA.tgz) ;; *) mv "$f" "${f%.tgz}-$SHA.tgz";; esac; done
```
Result names: `bsv-sdk-4.0.0-<sha>.tgz`, `bsv-templates-2.2.0-<sha>.tgz`, `bsv-wallet-toolbox-2.15.0-<sha>.tgz`, `bsv-wallet-toolbox-client-2.15.0-<sha>.tgz`, `bsv-wallet-toolbox-mobile-2.15.0-<sha>.tgz`, `bsv-color-permission-module-0.2.0-<sha>.tgz`. `pnpm pack` rewrites `workspace:^` to real ranges. Toolbox is unchanged upstream; sdk gains only the §2.2-5a validator exception. An early pack of all six at cbdccfe is allowed for compile bring-up; re-pack after T1/T2 (sdk included). `vendor-ts-stack/` is committed on `feat/1color` (tarballs are build inputs for the draft PRs). Producers (P-T1 Task 9, P-T2 Task 19, orchestrator V0) only **write** tarballs into `vendor-ts-stack/`; they never commit in the mandala worktree. P-LIB commits them (Task 1 for V0/V1, Task 18 for V2, Task 23 for V3) or the orchestrator does, always with a pathspec commit.

**Mandala lib**: `cd lib && npm run build && npm pack --pack-destination ../vendor-ts-stack` → rename `bsv-mandala-0.5.0-<mandala short sha>.tgz` (sha of the commit that built it).

**Consumers** copy the tarballs they need into their own vendor dir: desktop `/Users/personal/git/ts/bsv-desktop-wt/1color/vendor/`, wallet `/Users/personal/git/bsv-wallet-wt/1color/vendor/` (root, already used). mandala `lib/` and `app/` reference `../vendor-ts-stack/`. In each consumer package.json:
- every vendored package that is used, directly or transitively, is a **direct dependency** `"file:vendor/<tarball>"` (lib: devDependencies; app: dependencies; `@bsv/mandala` in the app stays `file:../lib`);
- `"overrides": { "@bsv/sdk": "$@bsv/sdk", "@bsv/templates": "$@bsv/templates", "@bsv/wallet-toolbox-client": "$@bsv/wallet-toolbox-client", … }` for every vendored name, so transitive users (message-box-client, btms, identity-react, …) resolve to the tarball;
- re-vendoring = new sha file name + update specs + `npm install` (lockfile integrity changes; no cache reuse by path).
- bsv-wallet: the root package.json holds the file specs and overrides. Publishable host packages (`packages/expo-wallet-toolbox`) keep semver `peerDependencies`; `file:` specs and overrides live only in the host root package.json.

**Publish order** (PR descriptions list it; the user publishes manually): 1 `@bsv/sdk` 4.0.0 → 2 `@bsv/templates` 2.2.0 → 3 `@bsv/wallet-toolbox`, `-client`, `-mobile` 2.15.0 → 4 `@bsv/color-permission-module` 0.2.0 → 5 `@bsv/mandala` 0.5.0 → then swap `file:` specs for registry ranges in desktop, wallet, app and remove `overrides`.

---

## 10. Cross-repo implementation order

```
V0  step 0 (ORCHESTRATOR): run the §9 pack script at cbdccfe BEFORE plan 01 Task 1 commits anything; record the sha.
    sdk 4.0.0 + toolbox 2.15.0 (+client,+mobile) + templates 2.1.0 + module 0.1.0 (bring-up only). Missing V0 ⇒ consumers report BLOCKED, never pack.
T1  templates 2.2.0 ──────────────┬──> V1 re-pack templates ──> LIB-core (req read, decode)  ──> APP
                                  └──> T2 (support check uses readOneColorAttributes)
T2  color module 0.2.0 + sdk validator patch (5a) ──> V2 re-pack module + sdk ──> LIB-profile ──> V3 pack @bsv/mandala ──> DESK, WAL
GO  overlay-go: independent; codes against §3/§4/§5/§6 + F-REQ + C.0 vectors only
LIB-core needs only V0/V1 (sdk, templates); LIB-core may start on V0 using encodeStrictCbor (2.1.0) and swap the reader in at V1.
V2 = plan 02 Task 19; V3 = plan 04 Task 23.
ENVELOPE seam (must-pass): P-LIB produces lib/src/__fixtures__/1color-envelope.json (deterministic keys); an overlay-go engine-flow test admits it.
E2E (optional, after GO + LIB-core + LIB-profile): lib integration test against a local overlay-go (Mongo) — deploy → issue payout → hand-over → recipient admitReceipt → sender settle.
```
Must-land-before edges: V0→everything; T1→T2; T1→LIB-core(reader); T2→LIB-profile; P-LIB Task 23 (built `lib/dist` + V3 tarball)→APP; LIB-profile+T2→DESK; LIB-profile+T2→WAL (DESK/WAL V2/V3-gated tasks start only after those reports; V0-only tasks may run earlier, e.g. a `vendor-1color.mjs --allow-missing` mode, rerun strict once V3 exists); GO+LIB→envelope seam. **No plan waits on another plan's tests; seams are this file.** P-LIB owns F-REQ and the envelope fixture (checks them in); P-GO copies them. P-T2, P-LIB, P-WAL each own a C.0 test, P-GO a Go C.0 test.

**Mandala worktree discipline** (`/Users/personal/git/demos/mandala-wt/1color`, P-GO, P-LIB, P-APP share one branch): every commit is pathspec-scoped (`git commit -m … -- overlay-go/` | `-- lib/ docs/profiles vendor-ts-stack/` | `-- app/`) and stages nothing outside its own tree; otherwise serialize GO → LIB → APP. P-APP never runs `npm install` in `lib/`; on an `index.lock` collision, wait and retry.

---

## Decisions (architect calls on cross-repo seams; for morning review)

- **D1** One Mandala asset per holder transaction (handler and lib refuse more). This keeps the per-tx envelope = per-topic offChainValues.
- **D2** The issuer-v1 profileData leaf exists only in action plans (`{outputs:[{index,linkage}]}`). In receipts and hand-overs the leaf is absent; the envelope rides in the attested `submissions`.
- **D3** Holder envelopes carry `outputs` only. Input linkage is optional on the overlay (ownership.go:239) and the overlay knows prior owners from its owner index. Overlay semantics are unchanged.
- **D4** Wallet → app channel for hand-over evidence: a `colorHandoff` member on the `signAction` result plus the in-process `handoffEvidence(txid)`. BRC-100 defines no carrier. This is non-standard, survives JSON substrates (desktop HTTP, XDM) and is lost on the binary substrate. Flagged in the T2 PR.
- **D5** The `color_offline` representation is fail-safe: a stored wallet tag written atomically with the output, cleared in views only by a `color.v1.settled.<txid>` store record after a verified attestation. `ColorModuleStore` is injected by the host. Receipt evidence lives in the store, not in output customInstructions (the wallet keeps a ≤ 1000-byte custody JSON). Store loss on an unsettled receipt is recovered only from the sender's copy.
- **D6** The Mandala `admitReceipt` treats only transport failure as "unavailable". Any typed overlay verdict, including the retryable ERR_FROZEN/ERR_PAUSED/…, refuses the credit. This prevents offline-crediting a payment the issuer is actively blocking.
- **D7** The recipient always submits on receive, even when the tip is already attested (idempotent). The attested leaf is mandatory on every Mandala receipt.
- **D8** The lib implements plan labels and attestation verification itself (small, vector-tested), so the lib core and app console never load the color module. Only `@bsv/mandala/profile` imports it (optional peer).
- **D9** The lib declares @bsv packages as peerDependencies and vendored tarballs as devDependencies. This avoids `file:` paths leaking into the packed lib.
- **D10** Tarball names carry the source commit sha. Consumers use `$name` overrides.
- **D11** The MessageBox box is renamed `mandala-color`; the body is `v:3 kind:'handover'` and wraps a BRC-207 receipt; there is no amount field.
- **D12** localpay `FRAME_VERSION` 6. The token block becomes `{assetId (underscore), certificates, profileData}`; overlay url/key, linkage and admissions are removed.
- **D13** Overlay amounts use Mongo Decimal128. The bound 10^34-1 is enforced at submit on supply+Δ and |Δ| (deterministic ERR_SHAPE; a storage bound, not a token rule); per-identity balances beyond it are reported by `RebuildBalances.Unsafe`. JSON uses decimal strings.
- **D14** Overlay-go gets a full DAG-CBOR strict reader (codec depth bound 1024 = templates parity; depth 64, deploy payload ≤ 65536 B and admin-details/authority ≤ 4096 B are Mandala policy limits). It rejects `ext` on deploys and `req`/`ext` on non-deploy outputs; a malformed `icon` on a Mandala deploy ⇒ ERR_SHAPE.
- **D15** `color-*` lookup queries are discriminated by the presence of `type`. Legacy Mandala query keys stay on the same `ls_color_<id>` service.
- **D16** `tm_color_*` uses attested v1 (child key). `tm_mandala` keeps σI v3 with the bare key. `tm_mandala_kyc` stays unsigned.
- **D17** Desktop runs a periodic `settle()` (unlock, 5 min, online event). This is not a runtime: settle only replays admitted own hand-overs and submits offline receipts.
- **D18** Console issuer/admin outputs move to the non-P basket `mandala treasury` (the `p mandala` P-basket has no module after deletion).
- **D19** Offline credit asks consent with the new `color_receive_offline` message (0207:387, 406). Hosts may grant continuing approval.
- **D20** Recipient-output linkage is computed by the lib from the root shared secret (`revealCounterpartyKeyLinkage` + `encrypt`). Wallet-owned linkage comes from the handler via the underlying wallet's `revealSpecificKeyLinkage`. No `p color` linkage operation passes through the manager.
- **D21** bsv-wallet aliases `@bsv/wallet-toolbox-client` → `-mobile` (Metro + jest). There is no fork; any export gap is fixed in T2.
- **D22** Errors are matched by `.name`, then the `'[ClassName] '` message prefix. The new T2 classes are `ProfileParamsError`, `ProfileDataError`, `AttestationEvidenceError`, `ColorConsentDeclinedError` and `ColorProviderError {code, retryable, transport}`, all exported as runtime values. BRC-100 HTTP bridges MUST forward `{message, name, code?, retryable?, transport?}`.
- **D23** Deploy resolution order: request evidence → store → default provider → handler `deployProviders()`. Each source is checked by txid hash. Provider routing is per asset via `handler.provider()`; conflicting providers fail closed.
- **D24** After a verified admission of an own hand-over, the settler calls `sendWith:[txid]`. A createAction that resolves is success regardless of `sendWithResults`, except a `'failed'` entry for that txid (⇒ `unsent` marker); thrown "already broadcast/known/mined" counts as success. Host guards may hold the broadcast. This moves the toolbox action out of `nosend`.
- **D25** Remittance strings are base64 of 16 random bytes; Mandala code caps them at ≤ 48 UTF-8 bytes each.
- **D26** The Mandala handler allows only the `transfer` operation for holders. Mint, redeem, reissue and freeze stay lib-built issuer/admin txs under Mandala keys (B4).
- **D27** `settle()` never submits an own hand-over without host intent (`txids`) unless the overlay already reports it admitted. This guards against resurrecting an aborted, undelivered hand-over.
- **D29** `@bsv/sdk` 4.0.0 `validateBasketInsertion` gets the 0207:1444 exception: ≤ 16 MiB for `p color ` baskets. It ships in the T2 PR set because WalletClient validates internalize args client-side. No toolbox change.
- **D30** P-DESK raises its BRC-100 HTTP JSON body limit to ≥ 32 MiB (attested receipts up to 16 MiB of customInstructions plus AtomicBEEF), or fails explicitly if it cannot. P-WAL is in-process.
- **D28** The receipt `transactions` array excludes the tip (the tip is the receipt `tx`). `submissions` includes the tip. `lifecycles` is never used by Mandala; 0.2.0 rejects an attested leaf carrying it (`AttestationEvidenceError` 'lifecycles are not supported').

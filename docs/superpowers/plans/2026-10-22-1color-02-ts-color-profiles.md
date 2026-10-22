# `@bsv/color-permission-module` 0.2.0: required profiles and attested admission. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended, and the mode this overnight run uses) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Model tiering: sonnet for Tasks 0, 1, 16, 17, 18 and 19. Opus for the rest, which are security-relevant or touch several files.

**Goal:** Ship `@bsv/color-permission-module` 0.2.0 in the ts-stack worktree. It adds a required-profile handler registry that fails closed, the built-in `https://brc.dev/207/attested` v1 profile with full frontier validation, `color_offline` credit and an explicit `settle()` API, B1 submission data, B2 plain-noSend hand-overs and per-asset provider routing. Every 0.1.0 behaviour stays byte for byte for hosts that register no profiles, except the two consent-surface changes the contract pins for every host (Decision 15). The plan ends by cutting the **V2** vendored tarballs (Task 19, contract §9/§10), which every V2-gated consumer task waits for.

**Architecture:** The new behaviour lives in new focused files: `errors.ts`, `profiles.ts`, `attestation.ts`, `attested.ts`, `frontier.ts`, `store.ts` and `settle.ts`. Edits to the 2380-line `ColorPermissionModule.ts` are confined to a few seams: the constructor, asset resolution, plan checks, funding change tags, the receipt path, signAction/onResponse, spendability and the read views. The free token readers get an optional trailing `read` parameter. Its default, `readTokenOutput`, still rejects every `req`, so a host without profiles takes exactly the 0.1.0 path. The module passes a profile-aware reader only when `profiles` is non-empty. Durable state goes through an injected `ColorModuleStore` under the key prefix `color.v1.`.

**Tech Stack:** TypeScript (ESM), `@bsv/sdk` 4.0.0 (workspace), `@bsv/templates` 2.2.0 (workspace, from plan 01), `@bsv/wallet-toolbox-client` 2.15.0 (workspace), jest 30 + ts-jest (ESM preset), pnpm 10.33.2, Node ≥ 24.11.

**Spec:** `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (§4.1 T2, §8 B1/B2/B5). The authoritative seam is `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/plans/2026-10-22-1color-00-interfaces.md` §2, §3, §4, §5.2, §7.1 and D1–D30. Spec text is cited by line from `docs/design/brc-0207-1color-wallet-module.pinned.md` (**0207**) and `docs/design/brc-0162-1color.pinned.md` (**0162**) in the mandala worktree. The audit is `docs/design/2026-10-21-brc162-brc207-conformance-audit.md` (S1 is closed by Task 8).

---

## Global Constraints

- Work only in `/Users/personal/git/ts-stack-wt/1color` on branch `feat/1color-profiles`. This plan depends on plan 01, whose `@bsv/templates` 2.2.0 commits land earlier on the same branch. Never touch `/Users/personal/git/ts-stack` or any other checkout. The single exception is Task 19, which **writes** (never commits, never deletes other files in) `/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack/` per contract §9.
- Commit locally after each task. Do not push, merge, tag or publish to npm. Do not open BotBoard threads: the later draft-PR stage owns those, because a public post on the user's behalf is not authorized overnight.
- Every commit message uses conventional-commit form (`feat(color-permission): …`, `test(color-permission): …`, `fix(sdk): …`, `docs(color-permission): …`) and ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Do not modify `packages/helpers/ts-templates/src/Bsv21Token.ts`. Do not reformat it either.
- Keep profile-free behaviour unchanged. The 197 existing tests in 12 suites stay green **and unedited**. The only permitted fixture edits are additive: new optional parameters and new fields with 0.1.0 defaults. The one permitted edit to an existing assertion is `ColorPermissionModule.paths.test.ts:472-474`, whose exact `color_relinquish` message gains `seekPermission: true` (contract §2.5, Task 12, Decision 15). With no `profiles` option, the module must not call the store, the profile reader or any new provider method.
- Amounts are `bigint`. JSON amounts are canonical decimal strings, and `outputIndex`/`version` stay numbers. Hex is lowercase. Asset ids match `^[0-9a-f]{64}_(0|[1-9][0-9]{0,9})$` and outpoints use the dot form `<txid>.<vout>` (contract §0).
- BSV Chronicle: never normalize S. Accept both low-S and high-S attestation signatures, and require strict DER, meaning `Signature.fromDER(hex,'hex').toDER('hex') === hex`.
- Error identity: hosts match on `.name`, then the `'[ClassName] '` message prefix, never `instanceof` (D22, contract §2.4). Every new error class (`ProfileParamsError`, `ProfileDataError`, `AttestationEvidenceError`, `ColorProviderError`, `ColorConsentDeclinedError`) prefixes its message with `[<ClassName>] ` in its constructor, unless the given message already starts with that prefix (a provider-built `ColorProviderError` is not double-prefixed). `UnsupportedProfileError` keeps its two contract-pinned messages unprefixed (0.1.0 class, Decision 12). In this plan a quoted message `'BRC-207: …'` for a new class means the text after the prefix; tests assert `.name` plus the message with the prefix.
- Store keys all start with `color.v1.`. The layout is fixed in Task 9 and nothing else writes the store.
- Stability mandate: every pipeline step must be crash-safe (store writes are ordered so that a partial write fails closed), idempotent on retry (same bytes, same keys), single-flight where it submits, and fail-safe on store loss (a coin shows `color_offline` and never settled).
- Package gates (run from the worktree root): `pnpm --filter @bsv/color-permission-module typecheck`, `… lint`, `… format:check` and `… test:coverage`. Coverage thresholds stay at branches 85, functions/lines/statements 90.
- Test command for a single file: `cd /Users/personal/git/ts-stack-wt/1color/packages/wallet/color-permission-module && pnpm exec jest src/__tests__/<file>.test.ts`. The jest config has `bail: 1`.

## Review Focus

These five failure modes are implied by the spec, but no spec vector exercises them. Each is pinned by a test in the task that owns the code.

1. **Two concurrent `settle()` calls** (double-click, multi-tab host, periodic timer plus the `online` event). Each txid must be submitted exactly once, and the second call must report `admitted` from the settled record. Pinned in Task 14 (`concurrent settle submits each txid once`).
2. **Crash between the durable receipt store and the underlying `internalizeAction`.** The record stays `staged` and the wallet does not hold the output. A bare `settle()` must not submit it. A retried internalize of the same receipt credits once. Pinned in Task 10 (`idempotent receipt retry writes one record and credits once`) and Task 14 (`staged receipt the wallet does not hold is never submitted`).
3. **Store loss after an offline credit.** The coin must still show `color_offline`, never settled, and must still count toward the balance as offline value. Pinned in Task 9 (`store loss keeps the coin offline`).
4. **Stale or tampered deploy cache.** A store entry whose bytes do not hash to the asset id must be deleted and ignored, and resolution must fall through to the provider. Pinned in Task 4 (`tampered deploy cache is discarded`).
5. **Consent declined after the frontier validates.** There must be no store record, no credit and no submit. Pinned in Task 10 (`declined offline consent writes nothing`).

---

## File Structure

All paths are relative to `packages/wallet/color-permission-module/` unless they are absolute.

| File | Responsibility |
|---|---|
| `src/errors.ts` (new) | `ProfileParamsError`, `ProfileDataError`, `AttestationEvidenceError`, `ColorProviderError`, `ColorConsentDeclinedError`, plus `isNamedError(e, name)` |
| `src/profiles.ts` (new) | Contract §2.2 types, `validateProfileHandlers`, `resolveRequirements` (support check), `routeProvider` |
| `src/attestation.ts` (new) | §3 statement, child key, parse/verify, `attestationFromSteak`, constants |
| `src/attested.ts` (new) | `createAttestedProfile`, `parseAttestedParams`, `parseAttestedLeaf`, `assertCoverage`, `qualifyingSigner` |
| `src/frontier.ts` (new) | `validateFrontier`: the pure complete-graph validator (0207:328-357) |
| `src/store.ts` (new) | `ColorStore`: typed records over `ColorModuleStore` (`color.v1.*`) |
| `src/settle.ts` (new) | `ColorSettler`: single-flight settle, per-txid latch, parents first, sendWith |
| `src/types.ts` (modify) | `ColorOverlayProvider.submit` offChainValues, `AttestedAdmittance`/`AttestedSTEAK`, `ColorModuleStore`, options `profiles`/`store`, `ProfileData` |
| `src/tokenOutputs.ts` (modify) | `TokenReader`, `readProfiledTokenOutput`, the `TokenOutput.attributes?` field, the optional `read` parameter, and an optional message on `UnsupportedProfileError` |
| `src/overlay.ts` (modify) | `ListedOutput.transaction` (additive) |
| `src/strictJson.ts` (modify) | Export `JsonValue`, `jsonString`, `jsonHex` helpers |
| `src/ColorPermissionModule.ts` (modify) | Seams listed above, plus `settle()` and `handoffEvidence()` |
| `src/index.ts` (modify) | New exports (contract §2.4) |
| `src/__tests__/fixtures.ts` (modify, additive) | FakeWallet tags, `sendWith`, `includeTags`. FakeProvider `offChainValues` recording and an optional third parameter |
| `src/__tests__/profileFixtures.ts` (new) | `FakeStore`, `AttestingProvider`, A.141a scripts, the C.0 constants, `exampleProfile`, `issuerLikeProfile`, graph builders |
| `src/__tests__/*.test.ts` (new) | One suite per task, named in each task |
| `packages/sdk/src/wallet/validationHelpers.ts` (modify) | The 16 MiB `p color ` exception (contract §2.2-5a, D29) |
| `README.md`, `package.json`, `browser-budget.json`, `governance/package-release-notes.json` (root) | Release (Task 18) |

---

### Task 0: Baseline

**Files:** none modified (no commit).

**Interfaces:**
- Consumes: plan 01 exports from `@bsv/templates`: `readOneColorAttributes`, `reqMatchesDeploy`, `isProfileId` and the types `OneColorAttributes` and `OneColorProfileDescriptor`, plus `StrictCborValue` (already exported).
- Produces: the recorded baseline numbers used by every later task.

- [ ] **Step 1: Confirm the branch and a clean tree**

Run: `cd /Users/personal/git/ts-stack-wt/1color && git status --porcelain && git branch --show-current && git log --oneline -8`
Expected: an empty status, `feat/1color-profiles`, and plan 01's templates commits on top of `cbdccfe5b`. If plan 01's commits are absent, stop and report "plan 01 not landed".

- [ ] **Step 2: Install and build the workspace dependencies the module resolves through `dist/`**

Run: `cd /Users/personal/git/ts-stack-wt/1color && pnpm install --frozen-lockfile && pnpm --filter @bsv/templates build && pnpm --filter @bsv/sdk build && pnpm --filter @bsv/wallet-toolbox-client build`
Expected: exit 0.

- [ ] **Step 3: Assert that the plan-01 exports are in the built templates**

Run: `cd /Users/personal/git/ts-stack-wt/1color/packages/wallet/color-permission-module && node --input-type=module -e "const m=await import('@bsv/templates');for(const k of ['readOneColorAttributes','reqMatchesDeploy','isProfileId'])if(typeof m[k]!=='function')throw new Error(k);console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Record the module baseline**

Run: `pnpm --filter @bsv/color-permission-module test 2>&1 | tail -6; pnpm --filter @bsv/color-permission-module typecheck; pnpm --filter @bsv/color-permission-module lint`
Expected: `Test Suites: 12 passed, 12 total` and `Tests: 197 passed, 197 total` (about 17 s at cbdccfe). Typecheck and lint exit 0. Record any deviation in the task report as pre-existing.

- [ ] **Step 5: Record the sdk validator baseline**

Run: `cd /Users/personal/git/ts-stack-wt/1color/packages/sdk && pnpm exec jest src/wallet/__tests/validationHelpers.test.ts src/wallet/__tests/WalletResultValidation.security.test.ts 2>&1 | tail -5`
Expected: both files pass. Note the counts.

---

### Task 1: Errors, option types, store contract, constructor checks

**Files:**
- Create: `src/errors.ts`, `src/profiles.ts` (types only in this task), `src/__tests__/profileFixtures.ts`, `src/__tests__/errors.test.ts`, `src/__tests__/ColorPermissionModule.profiles.test.ts`
- Modify: `src/types.ts`, `src/tokenOutputs.ts:66-71` (`UnsupportedProfileError` gets an optional message), `src/strictJson.ts` (no change beyond exporting `JsonValue`, which is already exported), `src/ColorPermissionModule.ts:840-867` (fields and constructor), `src/index.ts`

**Interfaces:**
- Produces (exact, contract §2.1/§2.2/§2.4):
```ts
// errors.ts
// every constructor: super(message.startsWith(`[${Name}] `) ? message : `[${Name}] ${message}`)
export class ProfileParamsError extends Error { readonly name = 'ProfileParamsError' }
export class ProfileDataError extends Error { readonly name = 'ProfileDataError' }
export class AttestationEvidenceError extends Error {
  readonly name = 'AttestationEvidenceError'
  constructor (readonly reason: string)          // message: `[AttestationEvidenceError] BRC-207: attested evidence rejected (${reason})`
}
export class ColorProviderError extends Error {
  readonly name = 'ColorProviderError'
  constructor (readonly code: string, readonly retryable: boolean, readonly transport: boolean, message: string)
}
export class ColorConsentDeclinedError extends Error {
  readonly name = 'ColorConsentDeclinedError'
  constructor (readonly requestType: string)     // message: `[ColorConsentDeclinedError] BRC-207: the user declined the ${requestType} request`
}
export function isNamedError (error: unknown, name: string): boolean   // error?.name === name, else message starts with `[${name}] `; never instanceof
// tokenOutputs.ts
export class UnsupportedProfileError extends Error { constructor (message?: string) } // default message unchanged
// types.ts
export type ProfileData = Record<string, Record<string, JsonValue>>
export type AttestedAdmittance = AdmittanceInstructions & { admissionSignature?: string, admissionIdentityKey?: string }
export type AttestedSTEAK = Record<string, AttestedAdmittance>
export interface ColorOverlayProvider {
  spendability: (assetId: string, outpoints: string[]) => Promise<LookupAnswer>
  admission: (assetId: string, outpoints: string[]) => Promise<LookupAnswer>
  submit: (topics: string[], beef: number[], offChainValues?: number[]) => Promise<AttestedSTEAK>
}
export interface ColorModuleStore { get(key): Promise<string|undefined>; set(key, value): Promise<void>; delete(key): Promise<void>; keys(prefix): Promise<string[]> }
export interface ColorPermissionModuleOptions { wallet; provider; requestTokenAccess; profiles?: Record<string, RequiredProfileHandler>; store?: ColorModuleStore }
// profiles.ts: the contract §2.2 types verbatim: ProfileDescriptor, ProfileAssetContext, ProfileTxView,
// ColorAttestation, ReceiptGraph, ReceiptAdmission, RequiredProfileHandler (+ the two additions below),
// ColorHandoffResult, ColorSettleResult, ColorSettleReport
export function validateProfileHandlers (profiles: Record<string, RequiredProfileHandler> | undefined): ReadonlyMap<string, RequiredProfileHandler>
```
- Optional `RequiredProfileHandler` members used from Task 3 onward (in contract §2.2 since Revision 2):
```ts
/** Validates this profile's own `ext` entry in a payload (deploy or later output); undefined = entry absent.
 *  When the hook is absent the module requires the entry to be absent (ProfileParamsError). */
checkExt?: (value: StrictCborValue | undefined) => void
/** Validates this profile's leaf in receipt `profileData`. Absent ⇒ a leaf for this profile in a receipt is rejected (ProfileDataError). */
checkReceiptData?: (ctx: ProfileAssetContext, leaf: JsonValue) => Promise<void>
```

- [ ] **Step 1: Write the failing tests**

`errors.test.ts`:
```ts
it('names every error class for cross-bundle matching', () => {
  expect(new ProfileParamsError('x').name).toBe('ProfileParamsError')
  expect(new ProfileDataError('x').name).toBe('ProfileDataError')
  const evidence = new AttestationEvidenceError('duplicate spend')
  expect(evidence.name).toBe('AttestationEvidenceError'); expect(evidence.reason).toBe('duplicate spend')
  const provider = new ColorProviderError('ERR_UNAVAILABLE', true, true, 'down')
  expect([provider.name, provider.code, provider.retryable, provider.transport]).toEqual(['ColorProviderError','ERR_UNAVAILABLE',true,true])
  expect(isNamedError(provider, 'ColorProviderError')).toBe(true)
  expect(isNamedError({ name: 'ColorProviderError' }, 'ColorProviderError')).toBe(true)
  expect(isNamedError(new Error('[ColorProviderError] bridged'), 'ColorProviderError')).toBe(true)   // HTTP bridge lost .name
  expect(new UnsupportedProfileError().message).toBe('BRC-207: the asset requires processing profiles this wallet does not support')
})
it('prefixes every new error message with its class name exactly once', () => {
  expect(new ProfileParamsError('BRC-207: x').message).toBe('[ProfileParamsError] BRC-207: x')
  expect(new ProfileDataError('BRC-207: x').message).toBe('[ProfileDataError] BRC-207: x')
  expect(new AttestationEvidenceError('duplicate spend').message).toBe('[AttestationEvidenceError] BRC-207: attested evidence rejected (duplicate spend)')
  expect(new ColorProviderError('ERR_FROZEN', true, false, '[ColorProviderError] mandala overlay refused (ERR_FROZEN, retryable): frozen').message)
    .toBe('[ColorProviderError] mandala overlay refused (ERR_FROZEN, retryable): frozen')
  const declined = new ColorConsentDeclinedError('color_send')
  expect([declined.name, declined.requestType, declined.message]).toEqual(['ColorConsentDeclinedError', 'color_send', '[ColorConsentDeclinedError] BRC-207: the user declined the color_send request'])
})
it('throws ColorConsentDeclinedError on every declined consent, keeping the 0.1.0 message text', async () => {
  // createModule(wallet, provider, async () => false); a profile-free send ⇒ rejects { name: 'ColorConsentDeclinedError' }
  // and the message still contains 'declined the color_send request' (the existing substring assertions stay green)
})
```
`ColorPermissionModule.profiles.test.ts` (`describe('profile registry construction')`):
```ts
it('requires a store when profiles are registered', () => {
  expect(() => new ColorPermissionModule({ wallet, provider, requestTokenAccess, profiles: { [ex.id]: ex } }))
    .toThrow(new TypeError('BRC-207: a store is required when profiles are registered'))
})
it('requires each profiles key to equal its handler id', () => {
  expect(() => new ColorPermissionModule({ wallet, provider, requestTokenAccess, store, profiles: { 'urn:example:other': ex } }))
    .toThrow(new TypeError('BRC-207: profiles key must equal its handler id'))
})
it('rejects an invalid handler id or version list', () => {
  // id 'Not-A-URI', versions [], versions [0], versions [2**32] each ⇒ TypeError matching /BRC-207: invalid profile handler/
})
it('keeps the 0.1.0 capabilities without profiles', () => {
  expect(createModule(new FakeWallet(), new FakeProvider()).capabilities).toEqual({ 'brc207-color': '5' })
})
```
`ex` is `exampleProfile()` from `profileFixtures.ts`. It is the A.141a revision profile: `id 'urn:example:color:revision'`, `versions [1]`, `checkDescriptor` that throws `ProfileParamsError` unless `params === null`, and a `checkExt` that accepts `{revision: uint}`. `FakeStore` is a Map-backed `ColorModuleStore`. Its `keys(prefix)` returns the keys sorted, and it has `clear()` and a `writes: string[]` log.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec jest src/__tests__/errors.test.ts src/__tests__/ColorPermissionModule.profiles.test.ts`
Expected: FAIL. Cannot find module `../errors.js`.

- [ ] **Step 3: Implement**

Create `errors.ts`. Change `approve()` (ColorPermissionModule.ts:2365-2369) to throw `new ColorConsentDeclinedError(String(request.type))` instead of the plain `Error`; the text after the prefix is the 0.1.0 message, so the existing `toThrow('declined the … request')` assertions stay green unedited. Add the types to `types.ts` and `profiles.ts` exactly as in the Interfaces block. `validateProfileHandlers` checks four things: `isProfileId(id)`, a non-empty `versions` of integers in 1..2^32-1, `key === handler.id`, and `checkDescriptor` being a function. Each failure throws a `TypeError` starting `BRC-207: invalid profile handler`, except for the key rule, which has its own exact message. The constructor stores `this.profiles` (a ReadonlyMap) and `this.store` (wrapped later). It throws the store `TypeError` when `profiles.size > 0 && store == null`. Export the new types and errors from `index.ts`. `ColorOverlayProvider.submit` gains the optional third parameter, and the module keeps calling it with two arguments for profile-free assets.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec jest src/__tests__/errors.test.ts src/__tests__/ColorPermissionModule.profiles.test.ts && pnpm --filter @bsv/color-permission-module test && pnpm --filter @bsv/color-permission-module typecheck`
Expected: PASS. 197 existing tests plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): add profile handler types, errors and store contract" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Attestation statement, key, parse and verify (C.0)

**Files:**
- Create: `src/attestation.ts`, `src/__tests__/attestation.test.ts`
- Modify: `src/index.ts`, `src/__tests__/profileFixtures.ts` (C.0 constants, `signAttestation(priv, assetId, txid, outputs)`)

**Interfaces:**
- Consumes: `ColorAttestation`, `AttestedAdmittance`, `AttestationEvidenceError` (Task 1), `JsonValue`.
- Produces (contract §2.4, §3):
```ts
export const ATTESTED_PROFILE_ID = 'https://brc.dev/207/attested'
export const ATTESTATION_PROTOCOL_ID: [2, 'color admission attestation']
export const ATTESTATION_KEY_ID = '1'
export const COLOR_OFFLINE_TAG = 'color_offline'
export function attestationMessage (assetId: string, txid: string, outputs: readonly number[]): string
export function attestationSigningKey (signer: string): PublicKey
export function parseAttestation (value: JsonValue): ColorAttestation
export function verifyAttestation (att: ColorAttestation, assetId: string): boolean
export function attestationFromSteak (txid: string, topic: string, entry: AttestedAdmittance): ColorAttestation | undefined
```

- [ ] **Step 1: Write the failing tests** (`describe('C.0 attestation vectors')`)

These constants are pinned from 0207:10224-10264:
```ts
const PRIV = new PrivateKey(5555)
const SIGNER = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const CHILD = '033520aaa77b6914019796e974d1737acc890c5283c0921ddcfc2d5c815db8fb90'
const DIGEST = '9f61b417ec979c3c057313fe56f3c6056d2962b6bceaaa8272377bb9a80d8f9d'
const TWEAK = '6ef21748a4f6f5034842184e25f68e8df8663e036622ad9b3d061c6dd81ea93b'   // 0207:10230, BRC-42 HMAC tweak
const ASSET = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0'
const TXID = '05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931'
const LOW_S = '3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a'
const HIGH_S = '3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7'
const MESSAGE = `1color-admit:v1:tm_color_${ASSET}:${TXID}:0,2`
```
Tests:
```ts
it('builds the exact message and digest', () => {
  expect(attestationMessage(ASSET, TXID, [0, 2])).toBe(MESSAGE)
  expect(toHex(sha256(toArray(MESSAGE, 'utf8')))).toBe(DIGEST)
})
it('derives the BRC-42 child for invoice 2-color admission attestation-1', () => {
  expect(PRIV.toPublicKey().toString()).toBe(SIGNER)
  expect(attestationSigningKey(SIGNER).toString()).toBe(CHILD)
})
it('reproduces the BRC-42 HMAC tweak (contract §3: every C.0 suite)', () => {
  const shared = new PrivateKey(1).deriveSharedSecret(PublicKey.fromString(SIGNER))   // counterparty 'anyone'
  expect(toHex(Hash.sha256hmac(shared.encode(true), toArray('2-color admission attestation-1', 'utf8')))).toBe(TWEAK)
})
it('reproduces the low-S signature with ProtoWallet (RFC 6979)', async () => {
  const { signature } = await new ProtoWallet(PRIV).createSignature({ data: toArray(MESSAGE, 'utf8'),
    protocolID: [2, 'color admission attestation'], keyID: '1', counterparty: 'anyone' })
  expect(toHex(signature)).toBe(LOW_S)
})
it('accepts both low-S and high-S without normalizing', () => {
  for (const signature of [LOW_S, HIGH_S])
    expect(verifyAttestation({ txid: TXID, outputs: [0, 2], signer: SIGNER, signature }, ASSET)).toBe(true)
})
it.each([
  ['reordered outputs', { outputs: [2, 0] }], ['missing index 2', { outputs: [0] }],
])('fails for %s', (_, patch) => expect(verifyAttestation({ txid: TXID, outputs: [0, 2], signer: SIGNER, signature: LOW_S, ...patch }, ASSET)).toBe(false))
it('fails for another topic, key ID 2, a trailing newline and the bare key', () => {
  expect(verifyAttestation({ txid: TXID, outputs: [0, 2], signer: SIGNER, signature: LOW_S }, `${'11'.repeat(32)}_0`)).toBe(false)
  // keyID 2: sign MESSAGE with keyID '2' via ProtoWallet ⇒ verifyAttestation false
  // newline: sign `${MESSAGE}\n` with the right tuple ⇒ verifyAttestation false
  // bare key: PRIV.sign(MESSAGE) DER hex ⇒ verifyAttestation false
})
it('parses exact canonical JSON and rejects everything else', () => {
  expect(parseAttestation({ txid: TXID, outputs: [0, 2], signer: SIGNER, signature: LOW_S })).toEqual({ txid: TXID, outputs: [0, 2], signer: SIGNER, signature: LOW_S })
  // each throws AttestationEvidenceError: unknown member, outputs [2,0], outputs [0,0], outputs [], uppercase txid,
  // uppercase signature, signer not on curve ('02' + 'ff'.repeat(32)), non-strict DER (LOW_S + '00'), outputs [1.5]
})
it('maps a BRC-22 STEAK entry', () => {
  expect(attestationFromSteak(TXID, `tm_color_${ASSET}`, { outputsToAdmit: [0, 2], coinsToRetain: [], admissionSignature: LOW_S, admissionIdentityKey: SIGNER }))
    .toEqual({ txid: TXID, outputs: [0, 2], signer: SIGNER, signature: LOW_S })
  expect(attestationFromSteak(TXID, `tm_color_${ASSET}`, { outputsToAdmit: [0], coinsToRetain: [] })).toBeUndefined()
  expect(() => attestationFromSteak(TXID, `tm_color_${ASSET}`, { outputsToAdmit: [2, 0], coinsToRetain: [], admissionSignature: LOW_S, admissionIdentityKey: SIGNER })).toThrow(expect.objectContaining({ name: 'AttestationEvidenceError' }))
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/attestation.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/attestation.ts`**

`attestationMessage` validates `assetId` (`parseAssetId`), the txid (64 lowercase hex) and the outputs (non-empty, strictly ascending, integers 0..2^32-1). It throws `AttestationEvidenceError` otherwise. `attestationSigningKey(signer)` is `PublicKey.fromString(signer).deriveChild(new PrivateKey(1), '2-color admission attestation-1')`. `verifyAttestation` wraps everything in try/catch and returns false on any throw. It requires strict DER by round-trip equality and checks `child.verify(message, sig, 'utf8')` (`PublicKey.verify` hashes SHA-256 once). It never uses the bare key. `parseAttestation` uses `exactMembers` with all four members required and validates each one with `validateIdentityKey` and the rules above. `attestationFromSteak` returns undefined when either attestation field is absent. Otherwise it returns `parseAttestation({txid, outputs: outputsToAdmit, signer, signature})`.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/attestation.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): add BRC-207 attested statement, child key and verification (C.0)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Requirement resolution and the profile-aware reader (pure)

**Files:**
- Modify: `src/profiles.ts` (add `resolveRequirements`, `routeProvider`), `src/tokenOutputs.ts`, `src/ColorPermissionModule.ts:551-603, 654-675, 789-799` (the free reader functions get an optional `read`), `src/__tests__/profileFixtures.ts` (A.141a scripts)
- Create: `src/__tests__/profiles.test.ts`

**Interfaces:**
- Consumes: T1 `readOneColorAttributes` and `OneColorAttributes`. Task 1 handler types and errors.
- Produces:
```ts
// tokenOutputs.ts
export type TokenReader = (lockingScript: LockingScript, outpoint: Outpoint) => TokenOutput | undefined
export interface TokenOutput { /* existing fields */ attributes?: OneColorAttributes }   // set by readProfiledTokenOutput for BRC-162 outputs
export function readProfiledTokenOutput (lockingScript: LockingScript, outpoint: Outpoint): TokenOutput | undefined
export function readAnyTokenOutput (lockingScript, outpoint, read: TokenReader = readTokenOutput): TokenOutput | undefined
export function isDeployOutput (lockingScript, outpoint, read: TokenReader = readTokenOutput): boolean
// ColorPermissionModule.ts (free functions, additive trailing parameter, default readTokenOutput)
export function tryReadTokenOutput (lockingScript, outpoint, read?: TokenReader): TokenOutput | undefined
export function readSentToken (lockingScript, outpoint, read?: TokenReader): TokenOutput | undefined
export function tokenSources (tx, managed, json?: boolean, read?: TokenReader)
export function submissionAssets (tx, inputs?: Transaction, read?: TokenReader)
export function transactionTokens (tx, json?: boolean, read?: TokenReader): TransactionTokens
// profiles.ts
export interface ResolvedRequirements {
  req: ReadonlyMap<string, ProfileDescriptor>
  handlers: ReadonlyArray<{ handler: RequiredProfileHandler, descriptor: ProfileDescriptor }>   // canonical req order
}
export function resolveRequirements (attributes: OneColorAttributes | undefined, handlers: ReadonlyMap<string, RequiredProfileHandler>): ResolvedRequirements
export function routeProvider (assetId: string, resolved: ResolvedRequirements, fallback: ColorOverlayProvider): ColorOverlayProvider
```

- [ ] **Step 1: Write the failing tests** (`profiles.test.ts`)

Copy the A.141a deploy scripts verbatim from 0207:9372-9380 into `profileFixtures.ts` as `A141A.U`, `A141A.V`, `A141A.C`, `A141A.D`, `A141A.M`, `A141A.L`, `A141A.X` and `A141A.N` (hex strings). Add a helper `fixtureDeploy(hex): { tx: Transaction, assetId: string }` that builds a one-output transaction with 1000 sats and returns `${txid}_0`. Read attributes with `readProfiledTokenOutput(LockingScript.fromHex(hex), { txid, vout: 0 })!.attributes`.
```ts
const registry = new Map([[ex.id, ex]])          // exampleProfile(): revision v1
it('A.142 unknown required profile fails closed', () =>
  expect(() => resolveRequirements(attrs(A141A.U), registry)).toThrow(expect.objectContaining({ name: 'UnsupportedProfileError' })))
it('A.143 known identifier with an unsupported version fails', () =>
  expect(() => resolveRequirements(attrs(A141A.V), registry)).toThrow(expect.objectContaining({ name: 'UnsupportedProfileError', message: 'BRC-207: the required processing profile version is unsupported' })))
it('A.147 malformed req fails rather than reading as absent', () =>
  expect(() => readProfiledTokenOutput(script(A141A.M), op)).toThrow(expect.objectContaining({ name: 'ProfileParamsError', message: '[ProfileParamsError] BRC-207: malformed required processing profile map' })))
it('A.148 every required profile must be supported', () =>
  expect(() => resolveRequirements(attrs(A141A.X), registry)).toThrow(expect.objectContaining({ name: 'UnsupportedProfileError' })))
it('A.155 a no-overlay declaration is not a bypass', () =>
  expect(() => resolveRequirements(attrs(A141A.N), registry)).toThrow(expect.objectContaining({ name: 'UnsupportedProfileError' })))
it('A.144 advisory ext of a non-required profile is ignored', () =>
  expect(resolveRequirements(attrs(A141A.D), registry).handlers).toEqual([]))
it('C supported: revision v1 with its own valid ext', () =>
  expect(resolveRequirements(attrs(A141A.C), registry).handlers.map(h => h.handler.id)).toEqual(['urn:example:color:revision']))
it('own ext entry without a checkExt hook fails', () => {
  // A handler like ex but without checkExt, and fixture C ⇒ ProfileParamsError /own ext/
})
it('A.156 legacy JSON deploy declares no profiles', () => {
  const token = readAnyTokenOutput(script(A141A.L), op, readProfiledTokenOutput)!
  expect(token.deploy).toBe(true); expect(token.attributes).toBeUndefined()
  expect(resolveRequirements(undefined, registry).handlers).toEqual([])
})
it('opaque and empty payloads declare an empty req', () => { /* OneColor.lock(null, 9n, pkh, [0xff]) and [] ⇒ handlers [] */ })
it('the default reader is unchanged: readTokenOutput still throws UnsupportedProfileError on U', () =>
  expect(() => readTokenOutput(script(A141A.U), op)).toThrow(expect.objectContaining({ name: 'UnsupportedProfileError' })))
it('rejects two handlers that both define submissionData or both define admitReceipt', () => { /* ProfileParamsError */ })
describe('routeProvider', () => {
  it('0 distinct providers ⇒ fallback; 1 ⇒ it; 2 distinct objects ⇒ ProfileParamsError', () => { /* identity comparison (===) */ })
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/profiles.test.ts`. Expected: FAIL (`resolveRequirements` is not a function).

- [ ] **Step 3: Implement**

`readProfiledTokenOutput` mirrors `readTokenOutput`. It skips `assertNoRequiredProfiles` and sets `attributes = readOneColorAttributes(decoded.payload)` when a payload push exists. When `attributes.payload === 'map'` and `req.status` or `ext.status` is `'malformed'`, it throws `ProfileParamsError`: `'BRC-207: malformed required processing profile map'` for `req` and `'BRC-207: malformed processing profile extension map'` for `ext`. `tryReadTokenOutput` rethrows the errors named `UnsupportedProfileError` and `ProfileParamsError` and returns undefined for everything else, so the 0.1.0 reader keeps its behaviour. `resolveRequirements` works as follows:
- An absent payload, or an empty or opaque one, gives an empty req.
- For each `req` entry in canonical order: if no handler is registered, throw `UnsupportedProfileError()`. If the version is missing from `versions`, throw `UnsupportedProfileError('BRC-207: the required processing profile version is unsupported')`.
- Then call `checkDescriptor(descriptor, req)` for each entry.
- For each required id: an own `ext` entry with no `checkExt` hook throws `ProfileParamsError('BRC-207: <id> defines no own ext entry')`. Otherwise call `checkExt(value)`.
- At most one handler may define `submissionData`, and at most one may define `admitReceipt`. A second one throws `ProfileParamsError`.

`routeProvider` collects the distinct `handler.provider?.(assetId, descriptor)` objects and applies the 0/1/≥2 rule from contract §2.2 obligation 3.

- [ ] **Step 4: Run to pass and confirm no regressions**

Run: `pnpm exec jest src/__tests__/profiles.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS, with all 197 existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): resolve required profiles and read profiled token payloads" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Asset resolution in the module: deploy sources, cache, routing, successors

**Files:**
- Modify: `src/ColorPermissionModule.ts` (`assertSupportedAsset` at 2197-2216, `balance` at 2051-2067, the new `resolveAsset`, `assertConformingTokens` and `read` field, plus every `this.provider.` call site at 1627, 1888, 2203 and 2224, which become routed), `src/overlay.ts` (`ListedOutput.transaction`)
- Create: `src/store.ts` with only `class ColorStore { constructor(store: ColorModuleStore); getDeploy(assetId): Promise<string|undefined>; putDeploy(assetId, hex): Promise<void>; deleteDeploy(assetId): Promise<void> }` (key `color.v1.deploy.<assetId>`). Task 9 extends this class.
- Modify (additive): `src/__tests__/fixtures.ts`. `FakeProvider` counts `calls = { spendability, admission, submit }` and records a third `offChainValues` argument in `submissions`. `src/__tests__/profileFixtures.ts` gets `class TestModule extends ColorPermissionModule`, which exposes `resolveAssetForTest(id, evidence?)` and `providerForTest(id)`.
- Create: `src/__tests__/ColorPermissionModule.resolve.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 3. `parseAttestedParams` is added in Task 5. Until then, set `attested` to undefined.
- Produces (protected; later tasks call these). The two attested parameter types live in `profiles.ts` so that this task can name them:
```ts
export type TrustMode = 'any' | 'same' | 'all' | 'identity'
export interface AttestedParams { trustMode: TrustMode, identityKey?: string, evidenceProfile?: string }
export interface ResolvedAsset {
  assetId: string
  declarationTx?: Transaction             // undefined on the no-profiles (0.1.0) path
  attributes?: OneColorAttributes         // deploy attributes
  req: ReadonlyMap<string, ProfileDescriptor>
  handlers: ReadonlyArray<{ handler: RequiredProfileHandler, descriptor: ProfileDescriptor }>
  provider: ColorOverlayProvider
  attested?: AttestedParams               // set in Task 5 when the attested profile is declared without evidenceProfile
  sendPolicy?: 'plain-nosend'
  operations?: ReadonlySet<ColorOperationName>   // intersection of handlers' operations; undefined = all
  maxReceiptBytes: number                 // max over handlers' maxReceiptBytes, default 1000
}
protected readonly read: TokenReader       // readTokenOutput when profiles is empty, else readProfiledTokenOutput
protected async resolveAsset (assetId: string, evidence?: { declarationTx?: string }): Promise<ResolvedAsset>
protected async assertSupportedAsset (assetId: string): Promise<void>     // = resolveAsset, result discarded (kept for subclassers)
protected async assertConformingTokens (tokens: Iterable<TokenOutput>): Promise<void>
protected async providerFor (assetId: string): Promise<ColorOverlayProvider>
```
- `ListedOutput` gains `transaction: Transaction`, the decoded transaction of the listed output.

- [ ] **Step 1: Write the failing tests** (`describe('asset resolution with profiles')`)

```ts
it('A.142/A.143 balance fails for an unsupported asset when profiles are registered', async () => {
  // fixtureDeploy(A141A.U) admitted to FakeProvider; wallet holds output 0 in its value basket
  await expect(module.handleRequest({ method: 'listOutputs', originator: APP,
    args: { basket: `p color balance ${assetTag(u.assetId)}` } }, next)).rejects.toMatchObject({ name: 'UnsupportedProfileError' })
})
it('resolution order: request evidence, then store, then default provider, then deployProviders', async () => {
  // a: evidence {declarationTx: tx.toHex()} resolves with zero provider calls
  // b: a second module sharing the FakeStore resolves from color.v1.deploy.<assetId> with zero provider calls
  // c: empty store ⇒ provider.admission called once with [`${txid}.0`], then the store holds the hex
  // d: default provider has nothing ⇒ handler.deployProviders()[0].admission is asked; none ⇒ /no admitted deploy/
})
it('each source is checked by txid hash', async () => {
  // evidence hex of a different tx ⇒ rejects /does not match the asset/ and does not fall back
})
it('tampered deploy cache is discarded', async () => {   // Review Focus 4
  await store.set(`color.v1.deploy.${assetId}`, otherTx.toHex())
  await module.resolveAssetForTest(assetId)              // test subclass exposing the protected method
  expect(await store.get(`color.v1.deploy.${assetId}`)).toBe(deployTx.toHex())
  expect(provider.calls.admission).toBe(1)
})
it('memoizes per asset and forgets failures', async () => { /* two concurrent resolves ⇒ one admission call; a failed one retries next time */ })
it('routes spendability, admission and submit through the single handler provider', async () => { /* handler.provider returns p2; default untouched */ })
it('A.146/C04 a successor whose req differs from the deploy fails', async () => {
  // asset deployed with fixture C's payload; output with payload {"req":{}} ⇒ assertConformingTokens rejects
  // { name: 'ProfileParamsError', message: '[ProfileParamsError] BRC-207: successor requirements differ from the deploy' }
})
it('C03 a successor that omits req inherits the deploy policy', async () => { /* no payload ⇒ passes */ })
it('without profiles the 0.1.0 path is untouched', async () => {
  // createModule (no profiles): balance of a profile-free asset makes zero admission calls and the store is never constructed
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.resolve.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`resolveAsset` behaves as follows:
- **No profiles:** run the existing body of `assertSupportedAsset` unchanged, keep the same messages and the same single `provider.admission` call, and return a `ResolvedAsset` with an empty `req`, `provider: this.provider` and `maxReceiptBytes: 1000`.
- **Profiles registered:** keep a memo `Map<string, Promise<ResolvedAsset>>` and delete the entry on rejection. Sources are tried in the D23 order:
  1. request evidence,
  2. `color.v1.deploy.<assetId>` (delete the key when the hash mismatches),
  3. `this.provider.admission`, using the new `ListedOutput.transaction`,
  4. each handler's `deployProviders()`. Read these candidates from the deploy attributes of the first verified body. Before verification, iterate over every registered handler's `deployProviders()` in registration order.

  Each candidate needs `Transaction.fromHex(hex).id('hex') === txid` and `isDeployOutput(out.lockingScript, {txid, vout}, this.read)`. A mismatching request body throws `Error('BRC-207: the supplied declarationTx does not match the asset')`. After the first verified deploy, store the hex. Then call `resolveRequirements` and `routeProvider`, and derive `sendPolicy`, `operations` and `maxReceiptBytes`.

`assertConformingTokens(tokens)` resolves each distinct asset. For every token with `attributes`, it fails unless `reqMatchesDeploy(resolved.attributes, token.attributes)`. It also runs each handler's `checkExt` (or the absent-rule) on the token's own `ext` entry.

Replace `this.provider.X` at the four call sites with `(await this.providerFor(assetId)).X`. Submits that span several assets group topics by provider, and the discovery topic `tm_color` always uses the default provider. When every topic routes to the default, the call is the same single 0.1.0 call. `balance()` calls `this.resolveAsset(assetId)` first only when profiles are registered.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.resolve.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): resolve deploys from evidence, store and providers with per-asset routing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Built-in attested profile: descriptor and capability

**Files:**
- Create: `src/attested.ts`, `src/__tests__/attested.test.ts`
- Modify: `src/ColorPermissionModule.ts` (capabilities, and `ResolvedAsset.attested`), `src/index.ts`

**Interfaces:**
- Consumes: Tasks 1-4 and `ATTESTED_PROFILE_ID` (Task 2).
- Produces (`TrustMode` and `AttestedParams` are imported from `profiles.ts`, Task 4):
```ts
export function parseAttestedParams (params: StrictCborValue): AttestedParams     // throws ProfileParamsError
export function createAttestedProfile (options?: {
  trustedIdentities?: () => Promise<{ snapshot: string, identityKeys: string[] }>
}): RequiredProfileHandler          // id ATTESTED_PROFILE_ID, versions [1], maxReceiptBytes 16_777_216
export const TRUSTED_IDENTITIES: unique symbol   // internal property under which the handler carries options.trustedIdentities
```

- [ ] **Step 1: Write the failing tests** (`describe('attested profile descriptor (C05, C38, C39)')`)

```ts
const K = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const attested = createAttestedProfile()
const req = (params: StrictCborValue) => new Map([[ATTESTED_PROFILE_ID, { version: 1, params }]])
it('accepts {} (any), identity with a key, and evidenceProfile naming a declared companion', () => {
  expect(parseAttestedParams({})).toEqual({ trustMode: 'any' })
  expect(parseAttestedParams({ trustMode: 'identity', identityKey: K })).toEqual({ trustMode: 'identity', identityKey: K })
  // evidenceProfile 'urn:example:evidence' with that id in req ⇒ { trustMode: 'any', evidenceProfile } ; checkDescriptor passes
})
it.each([
  ['null params', null], ['unknown member', { trustMode: 'any', extra: 1 }], ['bad mode', { trustMode: 'some' }],
  ['identity without key', { trustMode: 'identity' }], ['key without identity', { trustMode: 'any', identityKey: K }],
  ['uppercase key', { trustMode: 'identity', identityKey: K.toUpperCase() }], ['off-curve key', { trustMode: 'identity', identityKey: '02' + 'ff'.repeat(32) }],
  ['evidenceProfile with trustMode', { evidenceProfile: 'urn:example:evidence', trustMode: 'any' }],
  ['evidenceProfile naming itself', { evidenceProfile: ATTESTED_PROFILE_ID }],
])('C05/C39 rejects %s', (_, params) =>
  expect(() => attested.checkDescriptor({ version: 1, params }, req(params))).toThrow(expect.objectContaining({ name: 'ProfileParamsError' })))
it('C39 evidenceProfile not in req fails', () => { /* ProfileParamsError /evidenceProfile/ */ })
it('C05 version 2 fails through the registry and its own ext entry fails', () => { /* resolveRequirements ⇒ UnsupportedProfileError; ext {attested: 1} ⇒ ProfileParamsError */ })
it('Mandala F-REQ payload resolves both profiles in canonical order', () => {
  // payload = 'a4636465630263726571' + F_REQ_HEX + '6373796d6454555344656c6162656c6b5465737420446f6c6c6172' (contract §4, 365 bytes)
  // registry: attested + stub { id: MANDALA_ISSUER_ID, versions: [1], checkDescriptor: () => {} }
  // ⇒ handler ids [ATTESTED_PROFILE_ID, 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md']
  // ⇒ parseAttestedParams(attested descriptor.params) equals { trustMode: 'identity', identityKey: K }
})
it('advertises brc207-color-attested=1 only when registered', () => {
  expect(moduleWith({ [ATTESTED_PROFILE_ID]: attested }).capabilities).toEqual({ 'brc207-color': '5', 'brc207-color-attested': '1' })
})
```
Copy the 328-byte `req` hex (F-REQ) verbatim from contract §4 into `profileFixtures.ts` as `F_REQ_HEX`. Also add `MANDALA_ISSUER_ID = 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md'` there as a plain test constant: the module itself never names Mandala.

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/attested.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`parseAttestedParams` requires a CBOR map, meaning a plain object that is not an array, `Uint8Array` or `StrictCborLink`. Members are limited to `{trustMode, identityKey, evidenceProfile}`, all text, with the 0207:181-189 rules. The identity key is validated with `validateIdentityKey`, and `evidenceProfile` must pass `isProfileId` and differ from `ATTESTED_PROFILE_ID`. `checkDescriptor` additionally requires `req.has(evidenceProfile)` when it is set. There is no `checkExt`, so the generic rule rejects an own `ext` entry. BRC-209 needs no code: no BRC-209 handler is registered, so any `req` naming it already fails closed. Record that in the README in Task 18. `resolveAsset` sets `attested` from the attested descriptor when `evidenceProfile` is absent. Capabilities become a per-instance object.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/attested.test.ts src/__tests__/profiles.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): add the BRC-207 attested profile descriptor and capability" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Trust coverage (C06-C16)

**Files:**
- Modify: `src/attested.ts`
- Test: `src/__tests__/attested.test.ts` (new `describe('trust coverage')`)

**Interfaces:**
- Produces:
```ts
export interface FrontierAnchor { outpoint: string, signers: readonly string[] }   // signers deduplicated, verified
export function qualifyingSigner (params: AttestedParams, snapshot: readonly string[] | undefined): (signer: string) => boolean
export function assertCoverage (params: AttestedParams, anchors: readonly FrontierAnchor[], snapshot: readonly string[] | undefined): void   // throws AttestationEvidenceError
export async function trustSnapshot (handler: RequiredProfileHandler, params: AttestedParams): Promise<{ snapshot: string, identityKeys: string[] } | undefined>
// identity ⇒ undefined (never calls the callback); list mode without a callback ⇒ AttestationEvidenceError('trust list unavailable')
```

- [ ] **Step 1: Write the failing tests**

P, Q and R are three fresh identity keys, and X and Y are two outpoints. `a(outpoint, ...signers)` builds an anchor.
```ts
const any = { trustMode: 'any' } as const, same = { trustMode: 'same' } as const, all = { trustMode: 'all' } as const
it('C06 any: distributed signers pass', () => expect(() => assertCoverage(any, [a(X, P), a(Y, Q)], [P, Q])).not.toThrow())
it('C07 any: an untrusted-only anchor fails', () => expect(() => assertCoverage(any, [a(X, P), a(Y, R)], [P, Q])).toThrow(/AttestationEvidenceError|attested evidence/))
it.each([any, same, all])('C08 empty snapshot fails %o', mode => expect(() => assertCoverage(mode, [a(X, P)], [])).toThrow())
it('C09 same with no common signer fails', () => expect(() => assertCoverage(same, [a(X, P), a(Y, Q)], [P, Q])).toThrow())
it('C10 same with a common signer passes', () => expect(() => assertCoverage(same, [a(X, P, Q), a(Y, P)], [P, Q])).not.toThrow())
it('C11 all with a missing signer fails', () => expect(() => assertCoverage(all, [a(X, P, Q), a(Y, P)], [P, Q])).toThrow())
it('C12 all passes when every listed identity signs every anchor', () => expect(() => assertCoverage(all, [a(X, P, Q), a(Y, P, Q)], [P, Q])).not.toThrow())
it('C13 identity passes with an empty list', () => expect(() => assertCoverage({ trustMode: 'identity', identityKey: R }, [a(X, R), a(Y, R)], undefined)).not.toThrow())
it('C14 identity rejects other signers', () => expect(() => assertCoverage({ trustMode: 'identity', identityKey: R }, [a(X, P, Q)], undefined)).toThrow())
it('C15 duplicate signatures do not inflate coverage', () => expect(() => assertCoverage(all, [a(X, P, P)], [P, Q])).toThrow())
it('list modes without trustedIdentities fail closed; identity never calls it', async () => {
  await expect(trustSnapshot(createAttestedProfile(), any)).rejects.toMatchObject({ name: 'AttestationEvidenceError', reason: 'trust list unavailable' })
  const spy = jest.fn(); await trustSnapshot(createAttestedProfile({ trustedIdentities: spy }), { trustMode: 'identity', identityKey: R }); expect(spy).not.toHaveBeenCalled()
})
it('qualifyingSigner: identity ⇒ exactly the key; list ⇒ snapshot membership', () => { /* … */ })
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/attested.test.ts -t 'trust coverage'`. Expected: FAIL.

- [ ] **Step 3: Implement** the four modes exactly as in 0207:215-222. Deduplicate signers per anchor with a `Set`. A snapshot is the distinct valid keys from `identityKeys`.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/attested.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): evaluate attested trust coverage for any, same, all and identity modes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Attested evidence leaf parsing

**Files:**
- Modify: `src/attested.ts`, `src/strictJson.ts` (add `jsonString(value, label)` and `jsonHex(value, label, maxBytes)`, which take lowercase even-length hex and return bytes)
- Test: `src/__tests__/attested.test.ts` (`describe('attested leaf')`)

**Interfaces:**
- Produces:
```ts
export interface AttestedLeaf {
  declarationTx: Transaction
  transactions: Transaction[]                 // input order preserved (claimed topological), distinct txids
  attestations: ColorAttestation[]            // parsed, NOT yet verified
  submissions: Map<string, number[]>          // txid ⇒ offChainValues bytes ([] for "")
}
export function parseAttestedLeaf (value: JsonValue, assetId: string): AttestedLeaf   // throws AttestationEvidenceError / ProfileDataError
```

- [ ] **Step 1: Write the failing tests** (C36, carrier rules from 0207:301-318)

```ts
it('parses the exact carrier', () => { /* {declarationTx, transactions:[hex], attestations:[att], submissions:[{txid, offChainValues:'7b7d'}]} ⇒ submissions.get(txid) = [0x7b,0x7d] */ })
it.each([
  'unknown member', 'lifecycles present (not supported by 0.2.0)', 'declarationTx of another tx', 'declarationTx uppercase hex',
  'duplicate transaction body', 'transaction hex with trailing bytes', 'attestation with an unknown member',
  'submissions duplicate txid', 'submissions odd-length hex', 'submissions noncanonical txid',
])('C36 rejects %s', name => expect(() => parseAttestedLeaf(variants[name], assetId)).toThrow())
it('rejects ISSUE as an asset key (module-built profile deploys are unsupported in 0.2.0)', () => { /* ProfileDataError */ })
```
The `variants` record is built in the test from one valid leaf. `lifecycles` is rejected with `AttestationEvidenceError('lifecycles are not supported')`. That is a recorded decision: BRC-177 protected batches are out of scope, and Mandala never sends them (D28).

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/attested.test.ts -t 'attested leaf'`. Expected: FAIL.

- [ ] **Step 3: Implement**

`exactMembers(['declarationTx','transactions','attestations'], ['submissions'])`. Then:
- Each hex string must be lowercase and must decode to exactly one transaction: `Transaction.fromHex(hex).toHex() === hex`.
- `declarationTx.id('hex') === parseAssetId(assetId).txid`.
- Every attestation goes through `parseAttestation`.
- Submissions must have unique canonical txids and lowercase even-length hex.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/attested.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): parse the attested profileData carrier strictly" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Complete-frontier validator (closes audit S1)

**Files:**
- Create: `src/frontier.ts`, `src/__tests__/frontier.test.ts`
- Modify: `src/__tests__/profileFixtures.ts`. Add a graph builder `graph()` with `deploy(amount|0n)`, `spend(inputs, outputs)` and `attest(priv, tx, vouts)`. It produces real BRC-162 transactions with P2PKH keys from a `ProtoWallet`, so script validation runs.

**Interfaces:**
- Consumes: `FrontierAnchor`, `qualifyingSigner` (Task 6), `verifyAttestation`, `readSentToken`, `assertUnlocks`.
- Produces:
```ts
export interface FrontierInput {
  assetId: string
  declarationTx: Transaction
  tip: Transaction                         // from AtomicBEEF (inputs carry sourceTransaction)
  start: { outputs: number[] }            // outputs of tip whose validity is needed (receipt outputs, or a stored record's held outputs)
  bodies: ReadonlyMap<string, Transaction> // leaf.transactions ∪ every tx in the tip's BEEF, keyed by txid
  attestations: readonly ColorAttestation[]
  qualifies: (signer: string) => boolean
  maxTransactions?: number                 // default 10_000
}
export interface FrontierResult {
  anchors: FrontierAnchor[]                // terminal anchors, outpoint dot form
  pending: string[]                        // txids validated by local transition, parents first; tip last when unanchored
}
export function validateFrontier (input: FrontierInput): FrontierResult    // throws AttestationEvidenceError(reason)
```

- [ ] **Step 1: Write the failing tests** (`describe('complete token frontier')`)

`K` is a ProtoWallet(5555) signer, and `qualifies = s => s === K`. The attestations are produced with `signAttestation`.
```ts
it('anchors an attested parent and validates the unattested tip', () => { /* deploy(1000)→A attested[0]; tip spends A.0 → 600+400 ⇒ anchors [A.0], pending [tip] */ })
it('C19 diamond: a shared ancestor is validated once', () => { /* tip spends B.0 and C.0, both spending different outputs of D (unattested), D's input attested ⇒ pending contains D once, parents before children */ })
it('C20 competing branches consuming one outpoint are rejected', () => { /* B and C both spend D.0 ⇒ reason 'duplicate spend' */ })
it('C21 an omitted branch is rejected even if the other input suffices', () => { /* tip spends anchored A.0 (1000) and unanchored E.0 whose body is absent ⇒ reason /missing/ */ })
it('C22 a mined but unattested parent is not an anchor', () => { /* parent with merklePath set, no attestation, its parent body absent ⇒ /missing/ */ })
it('C24 an attestation for output 0 does not cover output 2', () => { /* att(T,[0]); tip spends T.2 ⇒ T expanded; T's parents absent ⇒ rejects */ })
it('C25 no quantity bypass', () => { /* anchored inputs 20, tip outputs 21, no authority ⇒ reason 'value outputs exceed inputs' */ })
it('C26 an authority branch is validated as well', () => { /* mint tip: authority input from unanchored F whose parent is attested; tampered F script fails assertUnlocks */ })
it('C27 consuming an anchor in this graph is normal ancestry', () => { /* no error */ })
it('an unanchored deploy fails', () => { /* reaching <assetTxid>.0 without coverage ⇒ reason 'unanchored deploy' */ })
it('a deploy body that differs from declarationTx fails', () => { /* … */ })
it('an attestation naming a missing or foreign-asset output fails', () => { /* reason /names an output/ */ })
it('an invalid signature fails instead of being ignored', () => { /* corrupt DER ⇒ reason 'invalid attestation' */ })
it('a non-qualifying valid signer is ignored for coverage', () => { /* R signs; qualifies(R)=false ⇒ expands ⇒ missing ⇒ rejects */ })
it('bounds work by maxTransactions', () => { /* maxTransactions 2 on a 3-hop chain ⇒ reason 'graph exceeds work limit' */ })
it('S1: COVER cannot accept value minted from nothing', () => { /* holder tip with outputs > inputs and no authority, all inputs anchored ⇒ rejects */ })
it('S1 intermediate fabricated mint', () => {
  // unattested parent P: no token inputs (one plain P2PKH funding input, body present), output 0 = value 500 of assetId to a
  // validly signed P2PKH; tip spends P.0 → 500 (I==O, no authority). P is reached through the tip's input and expanded.
  expect(() => validateFrontier(input)).toThrow(expect.objectContaining({ name: 'AttestationEvidenceError', reason: 'value outputs exceed inputs' }))
  // the tip conserves (500 in, 500 out), so the only failing hop is P: the reject is on P, not on the tip
})
it('F7 fabricated authority parent', () => {
  // unattested parent F: no authority input (no token inputs at all), output 0 = authority (amount 0) of assetId;
  // tip spends F.0 (authority) and mints 1000 value. Without the F check the tip's mint would pass on F's authority.
  expect(() => validateFrontier(input)).toThrow(expect.objectContaining({ name: 'AttestationEvidenceError', reason: 'authority outputs need an authority input' }))
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/frontier.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `validateFrontier`**

The signature does not settle the algorithm, so here it is (0207:328-357):
```text
verify every attestation (verifyAttestation(att, assetId)); any false ⇒ 'invalid attestation'
an attestation whose txid has no body in bodies (and is not the tip) ⇒ 'attestation names an output that cannot be verified'
for each verified att with qualifies(att.signer): for each vout: check body(att.txid).outputs[vout] is a token of assetId
  (readSentToken, deploy allowed) else 'attestation names an output that is not this asset'; covered[txid.vout] add signer
spentBy = Map<outpoint, txid>; validated = Set<txid>; order = [] ; visiting = Set<txid>
visitOutput(txid, vout): if covered has it ⇒ anchors.push({outpoint, signers}) ; return
    if txid == assetTxid && vout == 0 ⇒ 'unanchored deploy'
    expand(txid)
expand(txid): if validated has txid return; if visiting has txid ⇒ 'cycle'; if count > max ⇒ 'graph exceeds work limit'
    T = bodies.get(txid) ?? (txid == tip ? tip : ⊥ 'missing transaction <txid>'); visiting.add
    for each input i: src = bodies.get(input source txid) else 'missing source for <txid>:<i>'; hydrate input.sourceTransaction;
        record spentBy (a different txid for the same outpoint ⇒ 'duplicate spend'); assertUnlocks(T, i)
        token = readSentToken(src output); if token?.assetId == assetId ⇒ visitOutput(src txid, src vout)
    transition check for assetId on T (0162:298-306), run for EVERY expanded T, including a hop with zero token inputs
        (ΣI = 0, no authority input): authority outputs without an authority input ⇒ 'authority outputs need an authority input';
        value outputs need an authority input or ΣI ≥ ΣO, else 'value outputs exceed inputs'; json/binary both read via readSentToken.
        The deploy tx is never expanded (it is an anchor or 'unanchored deploy'), so the check never sees a genesis output.
    visiting.delete; validated.add; order.push(txid)          // post-order ⇒ parents first
start: visitOutput(tip, vout) for each start output (the tip is always a fully signed transaction)
deploy anchors: body(assetTxid) must equal declarationTx bytes
return { anchors (deduped by outpoint), pending: order }
```

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/frontier.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): validate the complete attested token frontier" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Store records and the offline/restricted read views

**Files:**
- Create: `src/__tests__/ColorPermissionModule.views.test.ts`
- Modify: `src/store.ts` (extend the Task 4 `ColorStore`)
- Modify: `src/ColorPermissionModule.ts` (`inventoryView` at 802-809, `inventory` at 2070-2102, `balance`, `candidates` at 1635-1650), `src/__tests__/fixtures.ts` (additive: `FakeWallet.store(tx, vout, basket?, ci?, tags?)` keeps the tags, `listOutputs` returns the stored tags when `includeTags`, and `createAction`/`internalizeAction` persist output and insertion `tags`)

**Interfaces:**
- Produces:
```ts
export interface TxRecord {
  v: 1; assetId: string; rawTx: string                    // lowercase hex
  atomicBEEF: string                                      // lowercase hex: the EXACT BRC-95 bytes settle/resubmit send verbatim (contract §2.2-8):
                                                          //   receipt tip = the internalize args.tx; receipt ancestor = receiptBeef.toBinaryAtomic(txid);
                                                          //   own hand-over = signAction res.tx. Never rebuilt from rawTx.
  role: 'receipt' | 'handover' | 'ancestor'
  state?: 'staged' | 'credited' | 'aborted'               // staged/credited: receipts; aborted: own hand-overs whose wallet action is gone (Task 14)
  labels?: string[]                                       // handover only: the createAction labels, used to find the action in listActions (Task 14)
  inputs: string[]                                        // same-asset token input outpoints
  outputs: number[]                                       // wallet-held outputs of this asset ([] for ancestors)
  offChainValues: string                                  // lowercase hex, '' when none
  attestations: ColorAttestation[]                        // verified + qualifying, covering outputs of this tx
}
export class ColorStore {
  constructor (store: ColorModuleStore)
  getTx (txid: string): Promise<TxRecord | undefined>; putTx (txid: string, r: TxRecord): Promise<void>; txids (): Promise<string[]>
  getDeploy (assetId: string): Promise<string | undefined>; putDeploy (assetId: string, hex: string): Promise<void>; deleteDeploy (assetId: string): Promise<void>
  settled (txid: string): Promise<{ outputs: number[], signer: string } | undefined>; markSettled (txid: string, v: { outputs: number[], signer: string }): Promise<void>
  refused (txid: string): Promise<{ code: string, description: string } | undefined>; markRefused (txid: string, v: { code: string, description: string }): Promise<void>
  intents (): Promise<string[]>; addIntent (txid: string): Promise<void>; removeIntent (txid: string): Promise<void>
  unsent (): Promise<string[]>; addUnsent (txid: string): Promise<void>; removeUnsent (txid: string): Promise<void>
  settledSet (): Promise<Set<string>>; refusedSet (): Promise<Set<string>>
}
// keys: color.v1.tx.<txid> | color.v1.deploy.<assetId> | color.v1.settled.<txid> | color.v1.refused.<txid> | color.v1.intent.<txid> | color.v1.unsent.<txid>
```
Unparseable JSON reads as absent, which is fail-safe. A record whose `atomicBEEF` is missing, not lowercase even-length hex, or whose AtomicBEEF header names another subject also reads as absent (a torn or tampered write never reaches a submit). The read-time check is the header only (`01010101` magic, then the 32-byte subject txid; match the byte order `Beef.toBinaryAtomic` writes), because settle enumerates every record; the full `Transaction.fromAtomicBEEF` parse happens once, right before a submit, and a failure there is reported `retry` with code `'ERR_EVIDENCE'`. The deploy methods from Task 4 are unchanged.

- [ ] **Step 1: Write the failing tests** (`describe('offline and restricted views')`)

```ts
it('C40 an offline output is available with color_offline and counts in the balance', async () => {
  // wallet holds outputs 40 (no tag, settled record), 60 (stored tag color_offline), 25 (reserved by an action)
  // listOutputs 'p color assets' includeTags ⇒ tags for 60: ['color_offline', 'color_state_available']; for 40: ['color_state_available']
  // C.3: listOutputs `p color balance ${assetTag(id)}` ⇒ { totalOutputs: '100', outputs: [] }
})
it('C54 a settled record removes color_offline from views', async () => { /* markSettled(txid of 60) ⇒ tags ['color_state_available'] */ })
it('C55 a refused record restricts the output and removes it from the balance', async () => {
  // markRefused(txid of 60) ⇒ tags include 'color_state_restricted', spendable false, balance '40'; candidates() exclude it
})
it('store loss keeps the coin offline', async () => {   // Review Focus 3
  // after markSettled then store.clear(): tags for 60 again include 'color_offline'; balance still '100'
})
it('a tx record with a missing or mismatching atomicBEEF reads as absent', async () => {
  // putTx(T, {...valid, atomicBEEF: ''}) ⇒ getTx(T) undefined; atomicBEEF of another tx ⇒ undefined; valid ⇒ round-trips byte-identical
})
it('views are unchanged without profiles', async () => { /* createModule() inventory equals the 0.1.0 shape exactly */ })
it('A.142 inventory omits an unsupported asset\'s outputs', async () => {
  // wallet holds a fixture-U deploy output and a supported asset's output; 'p color assets' lists only the supported one;
  // a second listing makes no further admission call for U (memoized failure within one listing; resolution retried on the next listing)
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.views.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`InventoryState` gains `'restricted'`, but only when profiles are registered. `inventoryView` takes the settled and refused sets, which are loaded once per listing:
- The stored `color_offline` tag is kept iff the txid is not settled.
- A refused txid gives `color_state_restricted` and `spendable: false`.

`balance()` and `candidates()` drop refused txids. When profiles are registered, `inventory` also resolves each distinct asset once per listing and omits the outputs of any asset whose resolution fails with `UnsupportedProfileError` or `ProfileParamsError`, as 0.1.0 omitted them through the reader. With no profiles, no set is loaded and the code path is identical.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.views.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): persist attested state and show offline and restricted holdings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Receipt path, part 1: limits, profileData, offline credit, durable store

**Files:**
- Modify: `src/ColorPermissionModule.ts` (`onRequest` internalize at 911-915, `internalizeAction` at 991-1011, `verifyReceipt` at 1032-1070, `parseCustody` at 167-195)
- Create: `src/__tests__/ColorPermissionModule.receipt.test.ts`
- Modify: `src/__tests__/profileFixtures.ts`. Add `attestedAsset(K)`, which deploys with `req = {attested: {version:1, params:{trustMode:'identity', identityKey:K}}}` and is admitted. Add `attestedReceipt(...)`, which builds tip, ancestors, leaf and receipt JSON.

**Interfaces:**
- Consumes: Tasks 4-9.
- Produces:
```ts
protected async internalizeAction (args: InternalizeActionArgs, originator: string): Promise<InternalizeActionArgs>   // was Promise<void>; returns forwarded args
protected async verifyReceipt (tx, outputIndex, remittance, originator): Promise<ReceiptDecision>
interface ReceiptDecision { outputIndex: number, insertion: BasketInsertion /* 5-member custody JSON + tags */, records: Array<[string, TxRecord]>, settled?: { outputs: number[], signer: string } }
function parseCustody (text: string, maxBytes: number | undefined, label: string, allowProfileData = false): Custody & { profileData?: ProfileData }
```
- The `color_receive_offline` consent message is exact (contract §2.5). The members appear in this order: `type, assetId, outputs:[{outputIndex, amount}], unsettledTransactions, signer, profiles, seekPermission`. When the mode is not identity, `signers: string[]` (sorted, deduplicated) replaces `signer` in the same position (contract §2.5). `seekPermission` is `args.seekPermission !== false` of the originating `internalizeAction` args. A decline throws `ColorConsentDeclinedError` (Task 1).
- `ReceiptGraph` (contract §2.2) is built for every attested receipt: `tip = { txid, atomicBEEF: args.tx (verbatim), offChainValues: leaf.submissions.get(tip) ?? [] }`, always present, also when the tip is attested; `pending` = the frontier's unattested txs parents first, each `{ txid, atomicBEEF, offChainValues }` with `atomicBEEF` = `args.tx` for the tip and `receiptBeef.toBinaryAtomic(txid)` for an ancestor (that call serializes exactly the subject and its recursive dependencies, Beef.ts:1214-1226, so unmined attested anchors and their BUMPs ride along).

- [ ] **Step 1: Write the failing tests** (`describe('attested receipts')`)

```ts
it('A.116/C37 bounds receipt instructions at 16 MiB before parsing, then by the asset limit', async () => {
  // profile-free asset, 1001-byte instructions ⇒ 'BRC-207: receipt customInstructions exceeds 1000 bytes' (0.1.0 text)
  // attested asset, 200 KB leaf ⇒ accepted; 16 MiB + 1 byte ⇒ /exceeds 16777216 bytes/ before any provider call
})
it('A.154 receipt profileData naming an undeclared profile fails', async () =>
  /* ⇒ { name: 'ProfileDataError', message: '[ProfileDataError] BRC-207: profile data names an undeclared profile' } (A.154 description 'Profile data names an undeclared profile', 0207:9868) */)
it('a leaf for a profile without checkReceiptData fails', async () => { /* ProfileDataError */ })
it('an attested asset requires the attested leaf', async () => { /* AttestationEvidenceError reason 'missing attested evidence' */ })
it('C01/C40 accepts offline with consent, stores evidence first, forwards 5-member custody and color_offline', async () => {
  // first sight of the asset, fully offline: the default provider's admission AND spendability throw ColorProviderError('ERR_UNAVAILABLE', true, true)
  // tip unattested, parent attested by K ⇒ resolves from the leaf's declarationTx: expect(provider.calls.admission).toBe(0); expect(provider.calls.spendability).toBe(0)
  // prompts: exactly one {type:'color_receive_offline', assetId, outputs:[{outputIndex:0, amount:'600'}], unsettledTransactions:1, signer:K, profiles:[ATTESTED_PROFILE_ID], seekPermission:true}
  //   (Object.keys order asserted: ['type','assetId','outputs','unsettledTransactions','signer','profiles','seekPermission'])
  // store: color.v1.tx.<tip> {role:'receipt', state:'staged', outputs:[0], …} written BEFORE wallet.internalizeAction (FakeStore.writes order vs wallet call log)
  // wallet received customInstructions === JSON.stringify({version:1, assetId, derivationPrefix, derivationSuffix, senderIdentityKey}) and tags ['color_offline']
})
it('an attested-only asset whose tip is attested in the leaf credits settled without consent', async () => {
  // asset declares only attested v1 (no handler defines admitReceipt): settled record written; no color_offline tag; no prompt
})
it('stores byte-identical AtomicBEEF per tx', async () => {
  // receipt with unattested ancestor A whose parent anchor is UNMINED (no merklePath; attested by K):
  // getTx(tip).atomicBEEF === toHex(args.tx); getTx(A).atomicBEEF === toHex(Beef.fromBinary(args.tx).toBinaryAtomic(A))
  // and Transaction.fromAtomicBEEF(fromHex(getTx(A).atomicBEEF)) carries the anchor as sourceTransaction
})
it('non-identity offline consent lists sorted signers instead of signer', async () => {
  // 'any' mode, anchors signed by Q and P ⇒ message has signers [min(P,Q), max(P,Q)] and no 'signer' member; seekPermission false when args.seekPermission === false
})
it('declined offline consent writes nothing', async () => {   // Review Focus 5
  // requestTokenAccess false ⇒ rejects { name: 'ColorConsentDeclinedError' } /declined the color_receive_offline/; FakeStore.writes contains no 'color.v1.tx.' and no 'color.v1.settled.' key
  // (only the deploy cache from resolution may exist); wallet.internalizeAction not called; provider.submissions []
})
it('idempotent receipt retry writes one record and credits once', async () => {   // Review Focus 2, A.83
  // internalize the same receipt twice ⇒ one color.v1.tx.<tip> key, identical content; wallet holds one output
})
it('strips caller color_* tags from insertions', async () => { /* caller tags ['color_offline','color_state_available','mine'] ⇒ forwarded ['mine'] (+ color_offline only if offline) */ })
it('A.79 never submits during internalization without a handler', async () => { /* provider.submissions [] */ })
it('C16 a trust snapshot change during the decision fails', async () => { /* list mode; trustedIdentities returns snapshot 'a' then 'b' ⇒ AttestationEvidenceError reason 'trust snapshot changed' */ })
it('profile-free receipts are unchanged', async () => { /* existing verifyReceipt path, forwarded args === input args */ })
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.receipt.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

With no profiles, `internalizeAction` runs the existing code and returns `args` untouched. With profiles:
1. Bound every `p color` instruction string to 16 777 216 UTF-8 bytes each and in aggregate.
2. **Before any asset resolution**, call `parseCustody(text, 16 MiB, …, true)` for every receipt and parse each attested leaf structurally (`parseAttestedLeaf`). Collect `{assetId → declarationTx hex}` from those leaves.
3. Resolve every involved asset with that evidence (D23 source (i), so a never-seen asset resolves with no connectivity). Then parse the tx, run `assertCompletedTransaction` with `this.read` and `assertConformingTokens` using the same evidence, and enforce `resolved.maxReceiptBytes` per receipt.
4. Validate `profileData`: keys must be in `req`, and the asset key must equal the resolved id. A non-attested leaf goes to `checkReceiptData` or is rejected.
5. Check basket, role and `assertOwned`.
6. For an attested asset (`resolved.attested`):
   - parse the leaf;
   - take the snapshot;
   - build `bodies` from the leaf plus `Beef.fromBinary(args.tx)`;
   - run `validateFrontier({start:{outputs:[i]}})` and `assertCoverage`;
   - build `ReceiptGraph` (`tip`, `pending`, `outputIndexes`, `attestations`) as in the Interfaces block. A `pending` txid that is not in the receipt BEEF has no exact submit bytes ⇒ `AttestationEvidenceError('no submit bytes for <txid>')` (a complete AtomicBEEF always contains it).
7. Decide (Task 11 inserts the `admitReceipt` call here, **before** this decision and whatever the tip's coverage): settled when every receipt output of the tip is covered by a qualifying attestation. Otherwise call `approve(originator, color_receive_offline)`. Recheck the snapshot string before writing anything.
8. Write the records in order: anchor txs and their attestations, the pending ancestors (`role:'ancestor'`), the deploy, then the tip (`role:'receipt', state:'staged'`). Every tx record carries its exact `atomicBEEF` from step 6 (anchor records: `receiptBeef.toBinaryAtomic(txid)`). Write the settled record only after the verification in step 7.
9. Return the forwarded insertion: the 5-member custody JSON, caller tags without `color_*`, plus `color_offline` iff not settled.

A profile asset without the attested profile uses the baseline current-spendability check, as in 0.1.0.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.receipt.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): accept attested receipts offline with consent and durable evidence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Receipt path, part 2: `admitReceipt` hook and the manager integration

**Files:**
- Modify: `src/ColorPermissionModule.ts` (`verifyReceipt`)
- Test: `src/__tests__/ColorPermissionModule.receipt.test.ts` (`describe('admitReceipt')`), `src/__tests__/WalletPermissionsManager.integration.test.ts` (one new `it`, existing tests untouched)
- Modify: `src/__tests__/profileFixtures.ts`. Add `issuerLikeProfile({ K, provider, requireOffChain })`. It has `id 'urn:example:color:issuer'`, `versions [1]`, `sendPolicy 'plain-nosend'`, `operations ['transfer']`, `maxReceiptBytes 16 MiB` and `provider` returning the given provider. Its `checkDescriptor` requires the attested profile in identity mode with the same K. Its `admitReceipt` mirrors the Mandala rule (contract §7.1, D7): it submits each `graph.pending` entry in order, then `graph.tip` when the tip's txid is not in `pending`, through the provider with the entry's exact `atomicBEEF` and `offChainValues`, and maps the tip's STEAK to `admitted` (transport `ColorProviderError` ⇒ `unavailable`, any other throw propagates). Its `checkPlanData`/`submissionData` echo the leaf.

**Interfaces:**
- Consumes: `ReceiptGraph` and `ReceiptAdmission` (contract §2.2), plus `AttestingProvider` from `profileFixtures.ts`, which signs STEAK entries with priv 5555 per contract §3 and can be told to `failTransport()` or `refuse(code, retryable)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('admitted ⇒ verified attestation covers the tip ⇒ settled credit, no offline tag', async () => { /* store.settled(tip) = {outputs:[0], signer:K}; tags [] */ })
it('admitReceipt runs for an attested tip', async () => {
  // issuer-like asset; receipt leaf: attestations=[tip attested by K for [0]], submissions=[{txid: tip, offChainValues}] (an issuer payout shape)
  // ⇒ admitReceipt called once with graph.pending [] and graph.tip = { txid: tip, atomicBEEF: args.tx, offChainValues: <bytes> }
  // ⇒ provider.submissions has exactly one entry: the tip, with byte-identical atomicBEEF and offChainValues; credit settled, no prompt
})
it('admitReceipt runs before the coverage decision even when the hook refuses an attested tip', async () => {
  // same receipt; provider.refuse('ERR_FROZEN', true) ⇒ rejects { name: 'ColorProviderError' }; no color.v1.tx key; wallet.internalizeAction not called
})
it('unavailable ⇒ offline credit with consent', async () => { /* provider.failTransport() ⇒ color_offline + prompt */ })
it('a typed verdict thrown by the handler ⇒ no credit, nothing stored', async () => { /* ColorProviderError('ERR_FROZEN', true, false) ⇒ rejects name ColorProviderError; no color.v1.tx key */ })
it('admitted with attestations that do not cover the output ⇒ AttestationEvidenceError', async () => {})
it('admitted with a high-S attestation is accepted (BSV Chronicle)', async () => {})
it('C42 a companion requiring off-chain values rejects empty submissions', async () => { /* requireOffChain ⇒ handler throws ProfileDataError ⇒ no credit */ })
it('handler hooks receive the underlying wallet and identity key in ctx', async () => {})
it('an attested receipt larger than 1000 bytes passes through WalletPermissionsManager', async () => {
  // manager.internalizeAction with a 4 KB attested receipt ⇒ accepted; stored customInstructions decrypt to the 5-member JSON
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.receipt.test.ts -t admitReceipt`. Expected: FAIL.

- [ ] **Step 3: Implement**

When a handler defines `admitReceipt`, call it for **every** receipt of the asset (contract §2.2: also when the tip is already attested), after the frontier validation and before the Task 10 step 7 decision, with `ctx` (`wallet` is the underlying wallet and `identityKey` comes from `this.identity()`) and the graph. A leaf attestation of the tip never short-circuits the hook.
- `admitted`: verify each attestation (`verifyAttestation` plus `qualifies`) and require coverage of the tip's receipt outputs. Settled.
- `unavailable`: take the offline path from Task 10.
- A throw propagates.

Resolution fails with `ProfileParamsError('BRC-207: admitReceipt requires the attested profile')` when a handler with `admitReceipt` sits on an asset without attested. That check belongs in `resolveAsset` (Task 4 file), and its test is added here.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.receipt.test.ts src/__tests__/WalletPermissionsManager.integration.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): let required profiles admit receipts before credit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Send planning: plan profileData, operations, plain-noSend hand-over, refusals

**Files:**
- Modify: `src/ColorPermissionModule.ts` (`assertPlanSupported` at 464-492, `createAction` at 1077-1121, `settleFunding` at 1441-1462, `newManagedOutput`, `deployOutput`, `createSignature` at 1902-2021 incl. the `color_signature` message at 1999-2011, `actionConsent` at 338-367, the `color_relinquish` message at 889-894)
- Modify (the one permitted existing-assertion edit, Global Constraints): `src/__tests__/ColorPermissionModule.paths.test.ts:472-474` gains `seekPermission: true` in the expected `color_relinquish` object
- Create: `src/__tests__/ColorPermissionModule.handover.test.ts`, `src/__tests__/ColorPermissionModule.consent.test.ts`

**Interfaces:**
- Produces:
```ts
protected async assertPlanSupported (plan: ColorPlan, args: CreateActionArgs, resolved: ReadonlyMap<string, ResolvedAsset>): Promise<void>   // was the module-private free function at 464-492
protected txView (assetId: string, plan: ColorPlan, layout: { inputs: ProfileTxView['inputs'], outputs: ProfileTxView['outputs'], tx?: Transaction }): ProfileTxView   // adds planLeaf per profile at call time
export function actionConsent (plan, createArgs, tx, tokens, managed, scopes, handoff?: boolean): Record<string, unknown>  // new optional trailing parameter
// every consent message (contract §2.5) carries seekPermission: boolean = originating args.seekPermission !== false.
// CreateActionArgs, SignActionArgs and RelinquishOutputArgs declare no seekPermission (sdk Wallet.interfaces.ts:398-450, 661),
// so those two read it untyped and are `true` for standard args; a host extension member still flows through:
//   color_send      ← (createArgs as { seekPermission?: boolean }).seekPermission !== false   (member added after `handoff`)
//   color_relinquish← (relinquish args as { seekPermission?: boolean }).seekPermission !== false
//   color_signature ← CreateSignatureArgs.seekPermission (typed, WalletEncryptionArgs)        (member added after `inputIndex`)
//   color_access    ← unchanged (already carries it)
//   color_receive_offline ← internalizeAction args (Task 10)
// color_send.handoff = true for a plain-nosend action (pin), else the 0.1.0 BRC-177-label expression
```

- [ ] **Step 1: Write the failing tests** (`describe('plain-noSend hand-over planning')`)

```ts
it('A.154 plan profileData naming an undeclared profile fails', async () => { /* { name: 'ProfileDataError', message: '[ProfileDataError] BRC-207: profile data names an undeclared profile' } */ })
it('plan profileData asset keys must be in plan.assets', async () => { /* ProfileDataError */ })
it('without profiles the 0.1.0 refusal stays', async () => { /* 'BRC-207: plan.profileData is not supported' */ })
it('operations outside the handler list fail', async () => { /* burn on the issuer-like asset ⇒ ProfileParamsError */ })
it('plain-nosend requires noSend and refuses a BRC-177 label', async () => {
  // noSend false ⇒ ProfileParamsError /plain noSend hand-over/ ; label 'p nosend expiry …' ⇒ same
})
it('B2: no split, change stays in the tx, tagged color_offline', async () => {
  // holder has 1000 in one output; send 600 ⇒ createAction args: 1 token input, outputs [recipient 600, change 400 with basket p color …, tags ['color_offline']]
  // FakeWallet saw exactly one createAction (no split action); provider.submissions []
})
it('a plain-nosend action cannot mix with a baseline asset', async () => { /* ProfileParamsError */ })
it('A.157 checkPlanData runs at createAction with the leaf and the view', async () => {
  // spy: leaf deepEquals plan.profileData[id][assetId]; view.outputs[1].custody defined for change; view.tx undefined
  // a handler throwing ProfileDataError ⇒ createAction rejects, no reservation remains (this.selected empty)
})
it('a module-built deploy with a non-empty req fails explicitly', async () => { /* ProfileParamsError /built outside this module/ */ })
it('createSignature refuses assets whose profiles define sendPolicy or submissionData', async () => {})
it('the BRC-177 handoff path is unchanged for profile-free assets', async () => { /* existing handoff test scenario: split still happens */ })
it('a plain-nosend color_send carries handoff true', async () => { /* issuer-like asset, noSend, no BRC-177 label ⇒ prompt.handoff === true */ })
it('forwards the plan labels to the underlying createAction unchanged', async () => {
  // issuer-like hand-over: FakeWallet's recorded createAction labels contain every ColorPlan.toLabels(plan) label byte-identical
  // (Task 14's abort check queries listActions by exactly these labels)
})
```

`ColorPermissionModule.consent.test.ts` (`describe('consent seekPermission')`):
```ts
it.each(['color_send', 'color_signature', 'color_relinquish', 'color_access', 'color_receive_offline'])(
  '%s carries seekPermission and honours false', async type => {
  // drive the request that prompts `type` twice: once without seekPermission ⇒ prompt.seekPermission === true,
  // once with args.seekPermission false ⇒ prompt.seekPermission === false. For color_send and color_relinquish the false
  // member is passed as an untyped extension (`{ ...args, seekPermission: false } as CreateActionArgs`), since the BRC-100
  // types lack it. color_receive_offline uses the Task 10 attestedReceipt fixture; the others a profile-free asset.
  expect(typeof prompt.seekPermission).toBe('boolean')
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.handover.test.ts src/__tests__/ColorPermissionModule.consent.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`createAction` does the following when profiles are registered:
1. Resolve `plan.assets` (excluding `ISSUE`) before running `assertPlanSupported`.
2. Validate the plan profileData. The `ISSUE` key throws `ProfileDataError`. An attested leaf is parsed, and its `declarationTx` is used as resolution evidence.
3. Apply the policy rules above. A plain-nosend asset skips the 0.1.0 "BRC-177 label required" refusal.
4. After `fund`, build the per-asset `ProfileTxView` and call each `checkPlanData`.

Consent members: add `seekPermission` to `color_send` (in `actionConsent`, from `createArgs`), `color_signature` and `color_relinquish` for every host, profiles or not (contract §2.5; Decision 15). `settleFunding`: the split branch stays keyed on the BRC-177 label. For plain-nosend, the change output from `newManagedOutput` gets `tags: [COLOR_OFFLINE_TAG]`. Caller `color_*` tags on requested outputs are stripped when profiles are registered. `deployOutput` throws for a proposed deploy whose `attributes.req` is valid and non-empty. `actionConsent` gets `handoff: true` for a plain-nosend action.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.handover.test.ts src/__tests__/ColorPermissionModule.consent.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS; the 197 existing tests pass with only the `paths.test.ts:472-474` expectation edited.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): plan plain-noSend hand-overs with profile data and operation limits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: signAction for profile assets: submission data, durable hand-over, `colorHandoff`

**Files:**
- Modify: `src/ColorPermissionModule.ts` (`signAction` at 1808-1843, `onResponse` at 929-941, the new `handoffEvidence`, the new private `pendingHandoffs: Map<string, PendingHandoff>`)
- Test: `src/__tests__/ColorPermissionModule.handover.test.ts` (`describe('signed hand-over')`)

**Interfaces:**
- Produces:
```ts
async handoffEvidence (txid: string): Promise<ColorHandoffResult | undefined>
protected async buildAttestedLeaf (assetId: string, tipTxid: string): Promise<JsonValue>
// leaf = {declarationTx, transactions: unattested ancestors parents-first excl. tip, attestations: anchors', submissions: every unattested tx incl. tip}
// signAction result for a profile action: SignActionResult & { colorHandoff?: ColorHandoffResult }
```

- [ ] **Step 1: Write the failing tests**

```ts
it('re-runs checkPlanData at signAction with view.tx set', async () => {})
it('requires non-empty submissionData before signing', async () => { /* handler returns [] ⇒ ProfileDataError; no signature released (FakeWallet.signAction not called) */ })
it('fails before signing when input evidence is unavailable', async () => { /* store.clear() after receipt, then send ⇒ AttestationEvidenceError reason /evidence for input/ */ })
it('forces returnTXIDOnly false', async () => {})
it('stores the hand-over durably and returns colorHandoff', async () => {
  // result.colorHandoff = {version:1, txid, profileData:{[ATTESTED_PROFILE_ID]:{[assetId]: leaf}}} and no issuer-like leaf
  // leaf.transactions = [receipt tip hex] (unattested parent), leaf.attestations = [anchor attestation], leaf.submissions = [{txid: receipt tip, offChainValues}, {txid, offChainValues: hex(submissionData)}]
  // store tx record {role:'handover', inputs:[receipt.0], outputs:[1], offChainValues: hex, atomicBEEF: toHex(result.tx), labels: ColorPlan.toLabels(plan)}
  // provider.submissions [] (never submitted at signAction)
})
it('handoffEvidence(txid) returns the same object after a lost ACK', async () => {})
it('C41 an offline parent selected into a child is never double-counted', async () => {
  // before sign: balance '1000'; after hand-over of 600 (change 400, color_offline): balance '400'; inventory never lists both parent and change as available
})
it('a second hand-over spends offline change and forwards the whole unattested chain', async () => {
  // leaf.transactions = [receipt tip, first hand-over] parents-first; submissions has all three txids
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.handover.test.ts -t 'signed hand-over'`. Expected: FAIL.

- [ ] **Step 3: Implement**

In `signAction`, for actions with any profile asset:
1. Re-run the plan and `checkPlanData` with the `ProfileTxView` (`tx` = `action.transaction`; custody of change comes from `createArgs.outputs[i].customInstructions`, which is plaintext there).
2. For attested assets, pre-build the evidence from stored records for every same-asset input and throw if any record is missing.
3. Call `submissionData` (non-empty required).
4. Stash `{assetId → {offChainValues, inputs, ownedOutputs}}` in `pendingHandoffs` under `args.reference`.
5. Set `args.options.returnTXIDOnly = false`.

In `onResponse(signAction)` with a stash:
1. Parse `res.tx` (AtomicBEEF; `Transaction.fromAtomicBEEF(res.tx).id('hex') === res.txid`, else throw before writing).
2. Write the tip record (`role:'handover'`, `atomicBEEF: toHex(res.tx)` verbatim, `labels` = the `p color plan …` labels of the plan, which Task 12 forwards to the underlying createAction byte-identical; never other caller labels).
3. Build `colorHandoff` with `buildAttestedLeaf`.
4. Delete the stash.
5. Return `{...res, colorHandoff}`.

`buildAttestedLeaf` walks `inputs` recursively. An input outpoint covered by its record's attestations becomes an anchor. Otherwise the record is included and its parents are walked; the walk is post-order and deduped. A missing record, or a record with `state: 'aborted'` (its outputs no longer exist), throws `AttestationEvidenceError` (`'evidence for input <outpoint> is unavailable'`).

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.handover.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): sign plain-noSend hand-overs with durable evidence and colorHandoff" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: `settle()`: single-flight settlement of receipts and own hand-overs

**Files:**
- Create: `src/settle.ts`, `src/__tests__/ColorPermissionModule.settle.test.ts`
- Modify: `src/ColorPermissionModule.ts` (`settle`, `isSettled`, `dispose` and the wiring), `src/__tests__/fixtures.ts` (additive: `FakeWallet.createAction` with `options.sendWith` records `sentWith: string[]` and returns `{ sendWithResults: [{ txid, status: sendWithStatus ?? 'unproven' }] }`, with an optional `sendWithError` to throw and `sendWithStatus` to return `'failed'`; `FakeWallet` records each signed action's `{ reference, txid, labels, status: 'nosend' }`; `abortAction({ reference })` sets that action's status to `'failed'`; `listActions({ labels, labelQueryMode })` returns the matching actions whose status is not `'failed'`, as the toolbox does, with an optional `listActionsError` to throw)

**Interfaces:**
- Produces (contract §2.3):
```ts
export class ColorSettler {
  constructor (deps: {
    store: ColorStore
    resolve: (assetId: string) => Promise<ResolvedAsset>
    qualifies: (assetId: string) => Promise<(signer: string) => boolean>
    wallet: WalletInterface                                   // underlying
    holds: (outpoint: string, assetId: string) => Promise<boolean>   // wallet basket lookup for staged receipts
  })
  settle (request?: { txids?: string[], assetIds?: string[] }, originator?: string): Promise<ColorSettleReport>
  settleTx (txid: string, originator?: string): Promise<ColorSettleResult>   // latch-guarded; used by Task 15
  dispose (): void                                                            // clears latches; sets `disposed` so no new submit starts
}
// ColorPermissionModule (contract §2.3)
settle (request?: { txids?: string[], assetIds?: string[] }, originator?: string): Promise<ColorSettleReport>   // no profiles ⇒ { results: [] }
isSettled (txid: string): Promise<boolean>   // true iff color.v1.settled.<txid> exists; no profiles ⇒ false (never touches a store)
dispose (): void                             // sync, idempotent: clears selections, the asset memo, settler latches and pendingHandoffs
```

- [ ] **Step 1: Write the failing tests** (`describe('settle')`)

```ts
it('submits an offline receipt chain parents first with exact bytes and offChainValues', async () => {
  // receipt R with an unattested ancestor A: submissions order [A, R]; atomicBEEF bytes equal the stored ones; offChainValues equal the receipt submissions
  // result {txid:R, assetId, status:'admitted', outputs:[0]}; color_offline gone from views (C54)
})
it('settle submits byte-identical AtomicBEEF to what internalize received, for an unmined attested anchor', async () => {
  // receipt R → unattested A → anchor N attested by K, N has NO merklePath (unmined); internalize offline, then settle online:
  // provider.submissions[0].beef deepEquals Beef.fromBinary(receiptArgs.tx).toBinaryAtomic(A)
  // provider.submissions[1].beef deepEquals receiptArgs.tx; neither is rebuilt from rawTx
})
it('a failed parent stops its descendants', async () => { /* A refused (ERR_CONSERVATION, final) ⇒ A 'refused', R 'refused' code 'ERR_PARENT_REFUSED'; nothing after A submitted (C50) */ })
it('a transport failure reports retry and keeps color_offline', async () => { /* status 'retry', code 'ERR_UNAVAILABLE' */ })
it('a retryable typed verdict reports retry, never refused', async () => { /* ERR_PAUSED retryable ⇒ 'retry' */ })
it('an admitted response without an attestation reports retry', async () => { /* code 'ERR_NO_ATTESTATION' */ })
it('C51 retrying after a lost response is idempotent', async () => { /* first submit throws transport after the overlay applied; second settle ⇒ admitted, same bytes */ })
it('D27 a bare settle never submits an own hand-over the overlay has not admitted', async () => {
  // own hand-over H, overlay color-admission empty ⇒ provider.submissions excludes H; no result for H
  // overlay admitted H (recipient settled) ⇒ replay submit, settled, sendWith [H]
})
it('named txids submit an own hand-over and persist the intent', async () => {
  // settle({txids:[H]}) with transport failure ⇒ color.v1.intent.<H> kept; later bare settle() submits H
})
it('D24 sendWith "already broadcast" counts as success; other errors leave an unsent marker that the next settle retries', async () => {})
it('D24 a resolved sendWith is success unless its entry for this txid is failed', async () => {
  // sendWithStatus 'sending' ⇒ no color.v1.unsent key; sendWithStatus 'failed' ⇒ color.v1.unsent.<H> written; next settle retries sendWith once
})
it('aborted hand-over is no longer polled by bare settle', async () => {
  // own hand-over H signed (record role 'handover'), intent persisted via a transport-failed settle({txids:[H]});
  // wallet.abortAction({reference}) ⇒ bare settle(): listActions shows no live action for H ⇒ record state 'aborted',
  // color.v1.intent.<H> and color.v1.unsent.<H> removed, no color-admission query and no submit for H, no result for H.
  // A second bare settle makes zero provider calls for H. settle({txids:[H]}) ⇒ {status:'refused', code:'ERR_ABORTED'}, still no submit.
  // listActionsError (wallet unreachable) ⇒ H is NOT marked aborted (fail-safe: keep polling)
})
it('a live nosend hand-over is never marked aborted', async () => {
  // own hand-over H2 signed, not aborted (FakeWallet status 'nosend', listed by the forwarded plan labels); three bare settle() runs
  // ⇒ getTx(H2).state undefined, color.v1.intent.<H2> kept, color-admission still queried for H2 each run
})
it('isSettled reflects the settled record and dispose stops new submits', async () => {
  // before settle: isSettled(R) false; after admitted: true; store.clear(): false.
  // dispose() twice does not throw; a settle() started after dispose resolves { results: [] } with zero provider calls
})
it('concurrent settle submits each txid once', async () => {   // Review Focus 1
  const [a, b] = await Promise.all([module.settle(), module.settle()])
  expect(provider.submissions.filter(s => s.txid === R).length).toBe(1)
  expect([...a.results, ...b.results].every(r => r.status === 'admitted')).toBe(true)
})
it('staged receipt the wallet does not hold is never submitted', async () => {   // Review Focus 2
  // tx record state 'staged', wallet basket lacks the outpoint ⇒ no submission; once the wallet holds it ⇒ promoted to 'credited' and submitted
})
it('verifies the attestation with the descriptor key and accepts high-S', async () => {})
it('assetIds filter limits the run', async () => {})
it('without profiles settle returns no results', async () => { expect(await createModule(w, p).settle()).toEqual({ results: [] }) })
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.settle.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `ColorSettler`**

- **Concurrency:** `settle` chains on `this.running` (`this.running = this.running.then(() => run(req))`, with errors isolated per run), and `settleTx` uses a `Map<txid, Promise<ColorSettleResult>>` latch.
- **Pass order for `run`:**
  1. Promote `staged` receipts the wallet holds.
  2. Detect aborted own hand-overs: for each `role:'handover'` record not yet settled or aborted, call the underlying `wallet.listActions({ labels: record.labels, labelQueryMode: 'all' })` (grouped by identical label sets). When it resolves and lists no action whose `txid` equals the record's, write `state: 'aborted'` and remove its intent and unsent markers. A thrown `listActions` changes nothing (fail-safe). The manager never routes `abortAction` to modules, so this check is the module's only abort signal (Decision 16).
  3. Retry `sendWith` for unsent markers (aborted records excluded).
  4. Collect candidates: credited receipts, persisted intents, named txids (persist each intent first; a named aborted record reports `{status:'refused', code:'ERR_ABORTED'}` and is never submitted), and own non-aborted hand-overs whose same-asset token outputs `color-admission` lists. A transport failure there skips the item.
  5. Settle each candidate's unsettled ancestor closure, ordered parents first and deduplicated across candidates.
- **Per tx:** call `provider.submit([colorTopic(assetId)], fromHex(record.atomicBEEF), fromHex(record.offChainValues))` with the stored bytes verbatim (contract §2.2-8) and verify the attestation (qualifying signer, covering the record's `outputs`, or every same-asset token output for ancestors).
  - Verified: write `markSettled` and update the record's attestations. For a handover record, call `wallet.createAction({ description: 'Settle token hand-over', options: { sendWith: [txid] } }, originator)` (D24, contract §2.3). A resolved call is success regardless of `sendWithResults`, except an entry for this txid with status `'failed'`, which writes `addUnsent`. A thrown error matching `/already (?:been )?(?:broadcast|sent|known|mined|in (?:the )?mempool)|txn-already-known/i` counts as success; any other thrown error writes `addUnsent`. Remove the intent.
  - `ColorProviderError` with `transport === false && retryable === false`: write `markRefused`, mark pending descendants in this run refused with `ERR_PARENT_REFUSED`, and remove the intent.
  - Anything else: `retry`.

Overlay refusals never throw out of `settle`. After `dispose()`, `run` returns `{ results: [] }` before any provider or wallet call; an in-flight run finishes its current submit and resolves.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.settle.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): settle offline receipts and hand-overs with single-flight submission" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Spending attested assets and routed submission with off-chain values

**Files:**
- Modify: `src/ColorPermissionModule.ts` (`spendable` at 2219-2238, `checkChosen` at 1564-1593, `ownInput` at 1178-1200, `resubmitHeld` at 1599-1632, `submitSigned` at 1870-1874, `submit` at 1883-1895)
- Create: `src/__tests__/ColorPermissionModule.spend.test.ts`

**Interfaces:**
- Consumes: `ColorStore` (Task 9) and `ColorSettler.settleTx(txid)` (Task 14), whose per-txid latch also guards these resubmits.
- Produces:
```ts
protected async spendable (assetId: string, outputs: readonly SourceOutput[]): Promise<Set<string>>   // same signature; attested branch added
protected async submit (assetIds: string[], beef: AtomicBEEF, deploy?: boolean, offChainValues?: ReadonlyMap<string, number[]>): Promise<AttestedSTEAK[]>
```

- [ ] **Step 1: Write the failing tests** (`describe('spending attested assets')`)

```ts
it('an offline output is selectable and signable with no overlay contact', async () => { /* provider.calls === 0 across createAction+signAction */ })
it('a settled output uses live spendability; a transport failure proceeds on the stored attestation', async () => {})
it('a settled output that is reachable but unlisted is resubmitted with stored bytes and offChainValues', async () => {
  // provider.submissions[0] = { topics:[tm_color_<id>], txid, beef: fromHex(record.atomicBEEF) byte-identical, offChainValues: stored bytes (non-empty) }; then listed ⇒ selected
})
it('an unlisted output that stays unlisted after resubmission is excluded', async () => {})
it('a refused output is never selected', async () => {})
it('C17 list-mode trust loss excludes offline outputs from new spends', async () => { /* trustedIdentities drops P ⇒ insufficient balance */ })
it('a broadcast attested action submits offChainValues and records a returned attestation as settled', async () => {})
it('profile-free spending is unchanged', async () => { /* submit called with exactly 2 arguments */ })
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.spend.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

`spendable`, for an asset with `resolved.attested` and per output, in order:
1. A refused txid is excluded.
2. A settled txid gets a routed `spendability` batch. `ColorProviderError` with `transport` means spendable. Listed means spendable. Unlisted means `settler.settleTx(txid)`, which resubmits `record.atomicBEEF` verbatim plus the stored offChainValues through the latch, then a recheck.
3. A stored record whose frontier re-validates against the current snapshot (list modes; identity mode skips the re-run) means spendable offline.
4. Otherwise, the baseline live check.

`resubmitHeld` delegates attested txids to the same path. `submit` groups topics by routed provider and passes `offChainValues` only for profile assets. Each returned STEAK entry for `tm_color_<id>` goes through `attestationFromSteak`, `verifyAttestation` and `qualifies`; when it covers the owned outputs, the module writes `markSettled` and stores the tx record with `atomicBEEF` = the exact bytes it just submitted. Profile-free calls stay `provider.submit(topics, beef)`.

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/ColorPermissionModule.spend.test.ts && pnpm --filter @bsv/color-permission-module test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/src
git commit -m "feat(color-permission): spend attested tokens offline and resubmit with stored off-chain values" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: sdk `p color` receipt limit and `colorHandoff` survival (contract §2.2-5a, D29)

**Files:**
- Modify: `packages/sdk/src/wallet/validationHelpers.ts:937-951` (`validateBasketInsertion`), `packages/sdk/src/wallet/__tests/validationHelpers.test.ts` (new `it`s in `describe('validateBasketInsertion')`), `packages/sdk/src/wallet/__tests/WalletResultValidation.security.test.ts` (one new `it`), `governance/package-release-notes.json` (append one sentence to the `@bsv/sdk` summary and migration; `releaseType` stays `major`, 3.2.1→4.0.0)

**Interfaces:**
- Produces: `validateBasketInsertion` with the limit `basket.startsWith('p color ') ? 16_777_216 : 1000` UTF-8 bytes. The signature is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it('allows p color receipt instructions up to 16 MiB', () => {
  expect(validateBasketInsertion({ basket: 'p color ' + 'ab'.repeat(32) + 'v0', customInstructions: 'x'.repeat(1001) })!.customInstructions).toHaveLength(1001)
  expect(() => validateBasketInsertion({ basket: 'p color ' + 'ab'.repeat(32) + 'v0', customInstructions: 'x'.repeat(16_777_217) })).toThrow(WERR_INVALID_PARAMETER)
})
it('keeps 1000 bytes for every other basket, including p colorful', () => {
  expect(() => validateBasketInsertion({ basket: 'default', customInstructions: 'x'.repeat(1001) })).toThrow(WERR_INVALID_PARAMETER)
  expect(() => validateBasketInsertion({ basket: 'p colorful', customInstructions: 'x'.repeat(1001) })).toThrow(WERR_INVALID_PARAMETER)
})
// WalletResultValidation.security.test.ts
it('keeps a colorHandoff member on a signAction result', () => {
  const r = validateWalletResult('signAction', { txid: '00'.repeat(32), colorHandoff: { version: 1, txid: '00'.repeat(32), profileData: {} } }, { reference: 'x', spends: {}, options: { returnTXIDOnly: true } })
  expect(r).toMatchObject({ colorHandoff: { version: 1, profileData: {} } })
})
```

- [ ] **Step 2: Run to fail**

Run: `cd /Users/personal/git/ts-stack-wt/1color/packages/sdk && pnpm exec jest src/wallet/__tests/validationHelpers.test.ts src/wallet/__tests/WalletResultValidation.security.test.ts`
Expected: FAIL on the 16 MiB case only. The `colorHandoff` test already passes: it was verified on the cbdccfe dist on 2026-10-22 and only pins the behaviour.

- [ ] **Step 3: Implement** the one-line limit selection and add a doc comment citing 0207:1442-1448.

- [ ] **Step 4: Run to pass, then typecheck and run the color module integration**

Run: `cd /Users/personal/git/ts-stack-wt/1color/packages/sdk && pnpm exec jest src/wallet/__tests/validationHelpers.test.ts src/wallet/__tests/WalletResultValidation.security.test.ts && cd /Users/personal/git/ts-stack-wt/1color && pnpm --filter @bsv/sdk typecheck && pnpm --filter @bsv/sdk build && pnpm --filter @bsv/color-permission-module test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/wallet governance/package-release-notes.json
git commit -m "fix(sdk): allow 16 MiB customInstructions for p color basket insertions (BRC-207)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: React Native export parity (contract §2.6, D21)

**Files:**
- Modify: `packages/wallet/color-permission-module/package.json` (devDependency `"@bsv/wallet-toolbox-mobile": "workspace:^"`), `pnpm-lock.yaml` (via `pnpm install`)
- Create: `src/__tests__/toolboxMobile.test.ts`

**Interfaces:**
- Consumes: the built `@bsv/wallet-toolbox-mobile` (`pnpm --filter @bsv/wallet-toolbox-mobile build` if `mobile/out` is stale).

- [ ] **Step 1: Write the failing test**

```ts
import * as mobile from '@bsv/wallet-toolbox-mobile'
import * as client from '@bsv/wallet-toolbox-client'
it('exports every toolbox value the module imports', () => {
  expect(typeof mobile.encryptMetadata).toBe('function')
  expect(typeof mobile.maybeDecryptMetadata).toBe('function')
  expect(mobile.sdk.specOpBasketPrefixOutputs).toBe(client.sdk.specOpBasketPrefixOutputs)
})
```

- [ ] **Step 2: Run to fail**

Run: `pnpm exec jest src/__tests__/toolboxMobile.test.ts`. Expected: FAIL (cannot resolve `@bsv/wallet-toolbox-mobile`).

- [ ] **Step 3: Add the devDependency**

Run: `cd /Users/personal/git/ts-stack-wt/1color && pnpm install` (not frozen; the lockfile changes). If a symbol is missing, the fix goes into `wallet-toolbox/src/index.mobile.ts` as a named export, never as a fork (D21).

- [ ] **Step 4: Run to pass**

Run: `pnpm exec jest src/__tests__/toolboxMobile.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module/package.json packages/wallet/color-permission-module/src/__tests__/toolboxMobile.test.ts pnpm-lock.yaml
git commit -m "test(color-permission): pin toolbox-mobile export parity for React Native hosts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: Exports, README, version 0.2.0, release notes, full gates

**Files:**
- Modify: `src/index.ts`, `package.json` (`"version": "0.2.0"`, `pack:check --exports ColorPermissionModule,ColorPlan,createColorModule,createAttestedProfile,verifyAttestation`), `browser-budget.json` (`requiredExports` += `createAttestedProfile`), `README.md`, `governance/package-release-notes.json` (the `@bsv/color-permission-module` entry: `publishedVersion` stays `0.0.0` and `releaseType` stays `minor`; rewrite `summary` and `migration`), plus the generated package docs via `pnpm docs:packages`
- Create: `src/__tests__/index.test.ts` additions (existing file; add an `it`)

**Interfaces:**
- Produces the public surface (contract §2.4):
  - **Constants:** `ATTESTED_PROFILE_ID`, `ATTESTATION_PROTOCOL_ID`, `ATTESTATION_KEY_ID`, `COLOR_OFFLINE_TAG`.
  - **Functions:** `attestationMessage`, `attestationSigningKey`, `parseAttestation`, `verifyAttestation`, `attestationFromSteak`, `createAttestedProfile`, `createColorModule`.
  - **Errors (runtime values):** `ProfileParamsError`, `ProfileDataError`, `AttestationEvidenceError`, `ColorProviderError`, `ColorConsentDeclinedError`, `UnsupportedProfileError`.
  - **Module methods:** `settle`, `handoffEvidence`, `isSettled`, `dispose` (contract §2.3).
  - **Types:** `ColorModuleStore`, `RequiredProfileHandler`, `ProfileDescriptor`, `ProfileAssetContext`, `ProfileTxView`, `ReceiptGraph`, `ReceiptAdmission`, `ColorAttestation`, `ColorHandoffResult`, `ColorSettleResult`, `ColorSettleReport`, `AttestedAdmittance`, `AttestedSTEAK`, `ProfileData`, `JsonValue`, `TokenReader`.
  - **Also exported:** `readProfiledTokenOutput`.

- [ ] **Step 1: Write the failing export test**

```ts
it('exports the 0.2.0 profile surface', async () => {
  const m = await import('../index.js')
  for (const name of ['ATTESTED_PROFILE_ID','ATTESTATION_KEY_ID','COLOR_OFFLINE_TAG','attestationMessage','attestationSigningKey',
    'parseAttestation','verifyAttestation','attestationFromSteak','createAttestedProfile','ProfileParamsError','ProfileDataError',
    'AttestationEvidenceError','ColorProviderError','ColorConsentDeclinedError','UnsupportedProfileError','readProfiledTokenOutput'])
    expect(m).toHaveProperty(name)
  for (const method of ['settle','handoffEvidence','isSettled','dispose'])
    expect(typeof (m.ColorPermissionModule.prototype as any)[method]).toBe('function')
  expect(m.ATTESTATION_PROTOCOL_ID).toEqual([2, 'color admission attestation'])
})
```

- [ ] **Step 2: Run to fail** (whichever names are not yet exported)

Run: `pnpm exec jest src/__tests__/index.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the exports and documentation**

The README gains a "Required profiles" section covering:
- registration (contract §8.2 host shape) and the `store` requirement;
- each hook's contract and when it runs (`checkDescriptor`, `provider`, `deployProviders`, `sendPolicy`, `operations`, `checkPlanData`, `submissionData`, `admitReceipt`, `maxReceiptBytes`, `checkExt`, `checkReceiptData`);
- the attested profile, with the C.0 vector and trust modes;
- `color_offline` semantics and `color_receive_offline` consent;
- `settle()`, `handoffEvidence()`, `isSettled()` and `dispose()`, and that the `color.v1.*` store layout is internal (hosts never read it);
- the `[ClassName]` message prefix, `ColorConsentDeclinedError`, and `seekPermission` on every consent message;
- the `colorHandoff` result member (non-standard, JSON substrates only, D4);
- the provider `submit` third argument.

Rewrite "Limits of this version" to cover:
- module-built deploys with a non-empty `req` refused;
- BRC-177 `lifecycles` unsupported;
- foreign token inputs of attested assets use live spendability (plan or envelope frontier evidence is not consumed);
- `createSignature` refused for assets whose profiles define `sendPolicy`/`submissionData`;
- BRC-209 unsupported, so it fails closed.

The release-notes summary covers the same features in one paragraph. The migration says: "No migration for hosts that register no profiles: behaviour is byte-for-byte 0.1.0. ColorOverlayProvider.submit receives an optional third offChainValues argument; existing providers ignore it. Hosts that register profiles must supply a durable ColorModuleStore and call settle()."

- [ ] **Step 4: Run every gate**

Run, from the worktree root:
```bash
pnpm --filter @bsv/color-permission-module typecheck && pnpm --filter @bsv/color-permission-module lint && \
pnpm --filter @bsv/color-permission-module format:check && pnpm --filter @bsv/color-permission-module test:coverage && \
pnpm --filter @bsv/color-permission-module build && pnpm --filter @bsv/color-permission-module pack:check && \
pnpm --filter @bsv/color-permission-module test:browser && pnpm docs:packages && pnpm docs:facts:check && pnpm health:check
```
Expected: all exit 0. Coverage is at or above 85/90/90/90. If `docs:facts:check` reports drift, run `pnpm docs:facts` and re-check. If `test:browser` exceeds the budget only because of new code, raise `maximumBytes` to the measured size plus 5% and state the before and after numbers in the release-notes summary. A failing `health:check` item that also fails at the baseline (check with `git stash`) is recorded as pre-existing, not fixed here.

- [ ] **Step 5: Commit**

```bash
git add packages/wallet/color-permission-module governance/package-release-notes.json docs/packages
git commit -m "feat(color-permission): release 0.2.0 with required profiles and attested admission" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: V2 vendored tarballs (contract §9, §10 "V2 = plan 02 Task 19")

Every V2-gated consumer task (plan 04 Task 18 Step 0, plan 06 Task 10, and through V3 plan 07 Task 4) stops until this task reports. The sdk carrying the D29 validator patch (Task 16) exists for consumers only in these tarballs.

**Files:**
- Create (in the mandala worktree, **not committed by this plan**): `/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack/` `bsv-sdk-4.0.0-<sha>.tgz`, `bsv-templates-2.2.0-<sha>.tgz`, `bsv-wallet-toolbox-2.15.0-<sha>.tgz`, `bsv-wallet-toolbox-client-2.15.0-<sha>.tgz`, `bsv-wallet-toolbox-mobile-2.15.0-<sha>.tgz`, `bsv-color-permission-module-0.2.0-<sha>.tgz` (`<sha>` = `git rev-parse --short=7` of the Task 18 commit)

**Interfaces:**
- Consumes: the Task 18 commit (all gates green).
- Produces: the six V2 tarballs. P-LIB commits them (plan 04 Task 18, pathspec `vendor-ts-stack/`); this plan never commits in the mandala worktree, so two plans never commit there at once (contract §9). Existing V0/V1 tarballs in `vendor-ts-stack/` are left untouched.

- [ ] **Step 1: Confirm the preconditions**

Run: `cd /Users/personal/git/ts-stack-wt/1color && test -z "$(git status --porcelain)" && git log -1 --format=%s && git rev-parse --short=7 HEAD`
Expected: clean tree; subject `feat(color-permission): release 0.2.0 with required profiles and attested admission`; record the sha. Anything else ⇒ stop and report `BLOCKED: V2 needs a clean tree at the Task 18 commit`.

- [ ] **Step 2: Build and pack (contract §9 script, staged)**

The §9 build and pack commands run verbatim, but `--pack-destination` is a fresh staging dir: the §9 rename loop renames *every* `bsv-*.tgz` in `$OUT` that lacks the new `-$SHA` suffix, so running it in `vendor-ts-stack/` would corrupt the V0/V1 file names consumers already reference (Decision 18).
```bash
TS=/Users/personal/git/ts-stack-wt/1color
OUT=/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack
SHA=$(git -C $TS rev-parse --short=7 HEAD)
STAGE=$(mktemp -d)
cd $TS && pnpm install --frozen-lockfile
pnpm --filter "@bsv/color-permission-module..." --filter "@bsv/wallet-toolbox-mobile..." --filter "@bsv/wallet-toolbox..." run build
mkdir -p $OUT
for p in @bsv/sdk @bsv/templates @bsv/wallet-toolbox @bsv/wallet-toolbox-client @bsv/wallet-toolbox-mobile @bsv/color-permission-module; do
  pnpm --filter "$p" pack --pack-destination "$STAGE"; done
cd $STAGE && for f in bsv-*.tgz; do mv "$f" "$OUT/${f%.tgz}-$SHA.tgz"; done
ls -1 $OUT/*-$SHA.tgz
```
Expected: exactly six files listed, with the six names in **Files**. A rerun at the same sha overwrites identical names (idempotent).

- [ ] **Step 3: Verify every tarball** (same shell as Step 2; in a new shell re-export `TS`, `OUT` and `SHA` first)

```bash
cd $OUT; fail=0
for spec in sdk:4.0.0 templates:2.2.0 wallet-toolbox:2.15.0 wallet-toolbox-client:2.15.0 wallet-toolbox-mobile:2.15.0 color-permission-module:0.2.0; do
  n=${spec%%:*}; v=${spec#*:}; t="bsv-$n-$v-$SHA.tgz"
  tar -xOzf "$t" package/package.json | grep -q "\"version\": \"$v\"" || { echo "BAD VERSION $t"; fail=1; }
  tar -xOzf "$t" package/package.json | grep -q 'workspace:' && { echo "WORKSPACE SPEC $t"; fail=1; }
done
M="bsv-color-permission-module-0.2.0-$SHA.tgz"
for name in createAttestedProfile ColorProviderError ProfileParamsError ProfileDataError AttestationEvidenceError ColorConsentDeclinedError; do
  tar -xOzf "$M" package/dist/index.mjs | tr '\n' ' ' | grep -Eq "export \{[^}]*\b$name\b" || { echo "MISSING EXPORT $name"; fail=1; }
done
S="bsv-sdk-4.0.0-$SHA.tgz"
VH=$(tar -tzf "$S" | grep -E '^package/dist/esm/.*wallet/validationHelpers\.js$')
tar -xOzf "$S" "$VH" | grep -Eq '16_?777_?216' || { echo "SDK LIMIT MISSING"; fail=1; }
tar -xOzf "$S" "$VH" | grep -Eq "[\"']p color [\"']" || { echo "SDK p color PREFIX MISSING"; fail=1; }
[ $fail = 0 ] && echo V2-OK
```
Expected: `V2-OK` and no other line. The module's dist entry is `./dist/index.mjs` (package.json `main`/`exports`), built by tsdown with one trailing `export { … }` statement. If `grep` finds no `export {` because the bundler changed shape, check the same six names in `package/dist/index.d.mts` instead and say so in the report. Any failure ⇒ do not report V2; fix in the owning task, recommit, and rerun Task 19 (a new sha).

- [ ] **Step 4: Report (no commit)**

Report to the orchestrator: `V2 READY <sha>` and the six absolute tarball paths. Do not `git add` or commit in the mandala worktree, do not push, do not publish. `git -C /Users/personal/git/ts-stack-wt/1color status --porcelain` must still be empty (packing writes nothing in the ts-stack tree).

---

## Decisions recorded for morning review

1. The reader is parameterized (an optional `read`, defaulting to `readTokenOutput`) instead of moving fail-closed into async resolution. A host with no profiles therefore keeps every 0.1.0 code path, including where A.142's error fires.
2. Module-built deploys that declare a non-empty `req` are refused in 0.2.0. Mandala deploys are lib-built (B4), and C29/C30 ISSUE evidence has no consumer. Plan and receipt `ISSUE` attested leaves are refused for the same reason.
3. `admitReceipt` is honoured only for assets that also declare attested v1, because offline acceptance needs a declared evidence policy. Any other combination fails at resolution.
4. At most one handler per asset may define `submissionData`, and at most one may define `admitReceipt`: one topic carries one `offChainValues` blob.
5. Only a typed, non-retryable `ColorProviderError` makes `settle()` mark a tx refused. Missing attestations, empty admittances and unknown errors stay `retry`, which is fail-safe because the coin stays offline.
6. The anchor rule for list modes: an output with at least one valid attestation from a snapshot member is a terminal anchor, and the mode test then runs over the whole frontier (0207:215-222). An `all`-mode anchor missing a signer therefore fails rather than expanding further.
7. Every input of every unanchored hop must have its source body (leaf `transactions` ∪ tip BEEF), and all its scripts are validated. This is consistent with a complete AtomicBEEF and makes C21/C22 hold.
8. Caller `color_*` tags are stripped from p color outputs and insertions whenever profiles are registered, for all assets. This is a deliberate change for profile-free assets on profile-enabled hosts only, and it stops a forged `color_offline`.
9. The `color_receive_offline` message uses `signers: string[]` instead of `signer` outside identity mode (adopted into contract §2.5 in Revision 2).
10. `lifecycles` (BRC-177 protected batches) in attested leaves are rejected. That is out of scope, and Mandala never uses them (D28).
11. No BotBoard thread or PR is opened from this plan. Commits stay local on `feat/1color-profiles`.
12. `UnsupportedProfileError` keeps its default message (contract §2.4) and gains an optional constructor message, used only for the version-mismatch case (A.143). Hosts match on `.name` (D22).
13. `validateFrontier` takes only `start: { outputs }`. Hand-over evidence for unsigned transactions is built from stored records (`buildAttestedLeaf`), never by validating an unsigned tip.
14. An attestation whose txid has no supplied body fails the decision rather than being ignored.
15. (`seekPermission` on `color_send`/`color_relinquish` is read from an untyped member because BRC-100 `CreateActionArgs`/`RelinquishOutputArgs` declare none, so it is `true` unless a host extends the args; reported as a contract §2.5 note.) Two consent-surface changes apply to every host, profiles or not, because contract §2.4/§2.5 pin them for "every consent message type" and "whenever requestTokenAccess returns false": `seekPermission` is added to `color_send`, `color_signature` and `color_relinquish`, and a decline throws `ColorConsentDeclinedError` whose message is `[ColorConsentDeclinedError] ` + the unchanged 0.1.0 text. Existing substring and `toMatchObject` assertions stay green; the one exact `toEqual` on a `color_relinquish` message (`paths.test.ts:472-474`) is the only existing assertion edited. This closes plan 06 gap 1 (desktop honours A.27 for spends).
16. Aborted own hand-overs are detected inside `settle()` by the plan labels (forwarded unchanged, Task 12 test), because the manager never routes `abortAction` to permission modules (WalletPermissionsManager.ts:5086-5105 calls the underlying wallet directly). A record is marked `aborted` only when the underlying `listActions` by its labels **resolves** without its txid; the toolbox lists `nosend` actions and omits `failed` (aborted) ones (wallet-toolbox `listActionsKnex.ts:167`, `listActionsIdb.ts:143`). A thrown `listActions` changes nothing, so a wallet outage never drops a live hand-over. A named settle of an aborted record reports `refused`/`ERR_ABORTED` without submitting (D27).
17. Each `TxRecord` keeps the exact AtomicBEEF the module received or produced (receipt `args.tx`, `receiptBeef.toBinaryAtomic(ancestor)`, signAction `res.tx`), and settle/resubmit send it verbatim; bytes are never rebuilt from `rawTx`. A receipt whose frontier has a pending txid that its BEEF does not contain is rejected (no exact submit bytes). A record whose `atomicBEEF` is malformed or names another txid reads as absent.
18. Task 19 runs the contract §9 build and pack commands verbatim but packs into a fresh staging dir and moves with the `-<sha>` suffix, because the §9 rename loop, run in `vendor-ts-stack/`, would re-suffix the V0/V1 tarballs that consumers already reference. Result names are exactly the §9 names. Reported to the contract owner as a §9 script gap.
19. `admitReceipt` runs for every receipt of an asset whose handler defines it, including attested tips (contract §2.2, D7); the leaf attestation never short-circuits it. An asset that declares attested v1 but no `admitReceipt` handler still credits an attested tip as settled without a submit: the recipient-submit duty belongs to the profile that defines it (issuer-v1), not to the generic attested profile.
20. New error classes prefix messages with `[ClassName] ` in their constructors (idempotent for provider-built messages). `UnsupportedProfileError` keeps its two contract-pinned messages unprefixed, because it is the 0.1.0 class and contract §2.4 pins those texts verbatim.

---

## Self-review (revision 2, against contract Revision 2 and the builder-check issues)

- **Spec coverage:**

  | Requirement | Task |
  |---|---|
  | §2.1 options, store, provider `submit` third arg | 1, 4, 15 |
  | §2.1 `isSettled`, internal store layout | 9, 14, 18 (README) |
  | §2.2 handler interface incl. `checkExt`/`checkReceiptData`, cardinality | 1, 3 |
  | §2.2 `ReceiptGraph.tip`, `admitReceipt` on every receipt | 10, 11 |
  | §2.2-3a 0.2.0 limits (module-built `req`, attested `ISSUE`, `lifecycles`) | 7, 12 |
  | §2.2-5/5a receipt limits, sdk 16 MiB exception | 10, 16 |
  | §2.2-6 `color_offline`, settled/refused views | 9, 10, 12 |
  | §2.2-7 spending attested assets | 15 |
  | §2.2-8 exact per-tx AtomicBEEF | 9, 10, 13, 14, 15 |
  | §2.2-9 `colorHandoff`, `handoffEvidence` | 13 |
  | §2.3 `settle`, D24 sendWith semantics, `dispose` | 14 |
  | §2.4 attested profile, exports, `[ClassName]` prefix, `ColorConsentDeclinedError`, A.143 message | 1, 2, 3, 5, 18 |
  | §2.5 `color_receive_offline`, `seekPermission` on all five types, `signers[]`, `handoff:true` | 10, 12 |
  | §2.6 RN export parity | 17 |
  | §3 C.0 vectors incl. HMAC tweak | 2 |
  | Audit S1 / F7 (unanchored fabricated mint and authority hops) | 8 |
  | Abort of plain-nosend hand-overs | 14 |
  | §9/§10 V2 tarballs | 19 |

- **Step scan:** every new test has a name and its assertions; Task 19 has exact commands and the output that means pass (`V2-OK`, `V2 READY <sha>`).
- **Type consistency:** `TxRecord.atomicBEEF`/`labels`/`state: 'aborted'` (Task 9) are the fields Tasks 10, 13, 14 and 15 read and write; `ReceiptGraph.tip` matches contract §2.2; `ColorConsentDeclinedError` (Task 1) is the class Tasks 10 and 12 assert and Task 18/19 export-check; `isSettled`/`dispose` (Task 14) are the methods Task 18 asserts.
- **Review Focus:** unchanged five; the new failure modes (abort, byte-identical resubmit, fabricated hops) are pinned by named tests in Tasks 8, 14 and 10.
- **Out of this plan:** the plan-04 G2 removal, plan-04 Task 22 scenario 7 and the contract §2.2/§2.5/§10 text belong to other owners; contract Revision 2 already carries §2.2 `tip`, obligation 8 and §10 "V2 = plan 02 Task 19".

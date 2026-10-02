# BRC-162 P2 — TS overlay on overlay-topics 2.0.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the mandala TS overlay (`overlay/`) from `@bsv/overlay-topics` 1.6.0 / `@bsv/templates` 1.10.3 to the merged BRC-162 packages (ts-stack #738: topics 2.0.0, templates 2.0.0), with typed verdicts, v3 routes, `MANDALA_ISSUER_KEYS`, the §4.2a owner-index reconciler, and readiness reporting.

**Architecture:** The package now owns every token rule (layers A–D), the owner journal, the reducer and the registry topic. The overlay keeps only host duties: the `/submit` wrapper (σI, admission record, verdict persistence), the conflicting-spend guard, eviction with input restore, admin routes, and the new pieces the package leaves to the host. Those new pieces are an `EngineOutputReader` over the engine's `outputs` table, a maintenance gate that quiesces submissions while refold, reconcile or eviction runs, and a `mandala-owner-index` readiness check.

**Tech Stack:** Node 24, TypeScript 5.9 (NodeNext ESM), `@bsv/overlay` 2.6.2, `@bsv/overlay-express` 2.7.3, `@bsv/sdk` 2.8.11, MongoDB 7 driver, sqlite3/knex, vitest 4.

**Spec:** [`docs/superpowers/specs/2026-10-01-mandala-brc162-design.md`](../specs/2026-10-01-mandala-brc162-design.md): §4.2a, §5.1, §6.3–§6.6, §7.1, §9 P2. Pinned format: [`docs/design/brc-0162-bsv21-binary.pinned.md`](../../design/brc-0162-bsv21-binary.pinned.md).

## Global Constraints

- Node `>=24 <25`. Pins: `@bsv/overlay` 2.6.2, `@bsv/overlay-express` 2.7.3, `@bsv/sdk` 2.8.11. Do not bump them in P2.
- Topics/templates come from **vendored tarballs** packed from ts-stack `origin/main` (merge commit `0211fd965`, packed at `a038f83c8` or later). npm has neither 2.0.0. Switch to the npm versions only after the maintainer publishes. Never publish anything yourself.
- `@bsv/overlay` is forced to 2.6.2 by an npm `overrides` entry. The topics tarball asks for `^2.6.3`, which is unpublished and differs from 2.6.2 only in a widened `@bsv/sdk` peer range (verified: ts-stack `20c761568` touches `package.json` only).
- Clean break (D13): no data migration. The live local overlay runs on **mainnet** with old-format state. Never wipe it. P2 boots on a **fresh** `NODE_NAME` (Mongo db `${NODE_NAME}_lookup_services`) and a fresh `SQLITE_FILE`.
- `MANDALA_ISSUER_KEYS`: a JSON array of compressed identity public keys (lowercase hex, `02`/`03` + 64 hex), non-empty, unique. Empty, missing or invalid → boot fails (§5.1).
- Single overlay key: `SERVER_PRIVATE_KEY` signs σI and decrypts linkages (§5.1). No admin or verifier private keys.
- Verdict table (§6.3), exactly:

  | code | HTTP | retryable | persisted |
  |---|---|---|---|
  | `ERR_AUTHORITY` | 400 | false | yes |
  | `ERR_UNTRUSTED` | 409 | true | never |

  All v2 codes keep their shapes. `ERR_INPUT_SPENT` stays unpersisted. `ERR_UNAVAILABLE` (503) is never persisted.
- Reason strings come verbatim from the package (`MandalaReject.reason`). The overlay never rewrites or re-classifies them. The substring `REASON_TABLE` is deleted.
- Token id is `<64 lowercase hex>_0` (regex `^[0-9a-f]{64}_0$`). Outpoints stay `<txid>.<vout>`.
- Wire contract v2 §1/§3/§4/§5/§7 and the v2.1–v2.3 amendments are unchanged unless this plan says otherwise. In particular the §9.12 `/arc-ingest` body keys (`restoredOutpoints`, `restoredTokenRows`, `alreadyEvicted`) are unchanged.
- Never print `SERVER_PRIVATE_KEY` or any private key hex in chat or logs.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branch: `feat/brc162` (a user-approved exception to the master rule). It already has master merged in (`f6b6563`).

## Already done in P0 (verified 2026-10-02, nothing to do)

§7.1 also lists two deletions P0 already made. The CAS monkeypatch is gone: only the negative test `indexWiring.test.ts:90-96` remains, and it is kept. The token-less `/arc-ingest` stub is gone too. What remains in `eviction.ts` is the real restoring handler, which Task 7 adapts.

## Build state across tasks

`tsc` compiles `src/**` including tests, and Task 1 removes the 1.6.0 API everything imports. **`npm run build` is red from Task 1 until Task 10.** Per-task gates are therefore `npx vitest run <files>` on the task's own test files (vitest type-strips, so it runs without a green `tsc`). Task 10 restores a green `npm run build` and full `npm test`. A reviewer must not reject Tasks 2–9 for a red `tsc` in files those tasks do not own.

## Review Focus

1. **A package throw that is not a `MandalaReject`** (an unreadable BEEF, a `TypeError` from a package bug) used to default to a *persisted* final `ERR_SHAPE`. It must now answer `400 ERR_SHAPE` **without persisting**, so a later fixed build can admit the same payload. Pinned in Task 2.
2. **A refold, reconcile or eviction running beside a live submit**: `rebuildState` reads and then writes state, so an interleaved fold is lost. Every maintenance run must wait for in-flight submits to drain, and new submits must wait for it. Both directions are pinned in Task 5.
3. **Eviction of a tx whose input was an authority coin**: the old restore only re-inserted *value* rows from the snapshot. Restore now goes through the owner journal for every role, and only for coins the engine shows live again. Pinned in Task 7.
4. **Malformed `:tokenId` path params** (`txid.0`, uppercase hex, `_1`): these must answer `400`, never reach Mongo, and never answer `200 []`. That would tell an old-format client "no authorities", and it would start a new genesis. Pinned in Task 8.
5. **Reconciler failure at boot** (Mongo blip): boot must not hang or crash-loop. It logs, reports readiness `degraded`, and the interval retries. Pinned in Task 6.

---

### Task 1: Vendor the 2.0.0 packages; delete modules the package replaces

**Files:**
- Create: `overlay/vendor/bsv-templates-2.0.0.tgz`, `overlay/vendor/bsv-overlay-topics-2.0.0.tgz`, `overlay/vendor/README.md`
- Modify: `overlay/package.json`, `overlay/package-lock.json`, `overlay/Dockerfile`
- Delete: `overlay/src/tokenLinkageGuard.ts` (+`.test.ts`), `overlay/src/adminChainGuard.ts` (+`.test.ts`), `overlay/src/pinnedReducer.ts` (+`.test.ts`), `overlay/src/feeRates.ts` (+`.test.ts`), `overlay/src/registry.ts` (+`registry.test.ts`, `membership.test.ts`)

**Interfaces:**
- Produces: `@bsv/overlay-topics` 2.0.0 and `@bsv/templates` 2.0.0 resolvable from `overlay/`, plus exactly one `@bsv/overlay` (2.6.2) in the tree.

- [ ] **Step 1: Pack both packages from ts-stack main**

```bash
cd /Users/personal/git/ts-stack && git fetch -q origin && git status --porcelain && git rev-parse HEAD origin/main
```
Expected: clean tree, and HEAD equals origin/main (a descendant of `0211fd965`). If HEAD differs, run `git checkout --detach origin/main`. Do not touch any other branch or worktree.

```bash
cd /Users/personal/git/ts-stack && pnpm install --frozen-lockfile \
  && pnpm --filter @bsv/templates build && pnpm --filter @bsv/overlay-topics build \
  && mkdir -p /Users/personal/git/demos/mandala/overlay/vendor \
  && pnpm --filter @bsv/templates pack --pack-destination /Users/personal/git/demos/mandala/overlay/vendor \
  && pnpm --filter @bsv/overlay-topics pack --pack-destination /Users/personal/git/demos/mandala/overlay/vendor \
  && ls -la /Users/personal/git/demos/mandala/overlay/vendor
```
Expected: `bsv-templates-2.0.0.tgz` and `bsv-overlay-topics-2.0.0.tgz`. Long command: run it with `run_in_background` and wait on the notification.

- [ ] **Step 2: Check the tarball manifests**

```bash
cd /Users/personal/git/demos/mandala/overlay/vendor && tar -xOf bsv-overlay-topics-2.0.0.tgz package/package.json | node -e "const p=JSON.parse(require('fs').readFileSync(0));console.log(p.version,p.dependencies,p.peerDependencies)"
```
Expected: `2.0.0`, with `dependencies` `@bsv/overlay ^2.6.3`, `@bsv/templates ^2.0.0`, `mongodb ^7.5.0`. No `workspace:` strings may remain; pnpm rewrites them on pack. If any do, stop and report.

- [ ] **Step 3: Write `overlay/vendor/README.md`**

```markdown
# Vendored packages (BRC-162 P2)

Packed from bsv-blockchain/ts-stack `origin/main` at <PASTE `git -C /Users/personal/git/ts-stack rev-parse HEAD`>
(contains #738, merge commit 0211fd965) with `pnpm --filter <pkg> pack`.

- bsv-templates-2.0.0.tgz       — @bsv/templates 2.0.0 (Bsv21Binary, strict CBOR)
- bsv-overlay-topics-2.0.0.tgz  — @bsv/overlay-topics 2.0.0 (Mandala on BRC-162)

Neither is on npm yet. When the maintainer publishes them, replace the `file:` specs in
package.json with `^2.0.0`, drop the `@bsv/templates` override, delete this directory, and
re-lock. The `@bsv/overlay` override stays until 2.6.3 is published: topics asks for ^2.6.3,
which only widens the @bsv/sdk peer range over 2.6.2 (ts-stack 20c761568).
```

- [ ] **Step 4: Point `package.json` at the tarballs and pin overlay**

In `overlay/package.json`, set:
```json
"@bsv/overlay-topics": "file:vendor/bsv-overlay-topics-2.0.0.tgz",
"@bsv/templates": "file:vendor/bsv-templates-2.0.0.tgz",
```
and add at top level:
```json
"overrides": {
  "@bsv/overlay": "$@bsv/overlay",
  "@bsv/templates": "$@bsv/templates"
}
```
(`$name` makes npm reuse the root dependency spec: `^2.6.2`, which resolves to 2.6.2 because 2.6.3 is unpublished, and the templates tarball.)

- [ ] **Step 5: Install and verify the tree**

```bash
cd /Users/personal/git/demos/mandala/overlay && npm install && node -e "require('sqlite3')" && npm ls @bsv/overlay @bsv/templates @bsv/overlay-topics
```
Expected: one `@bsv/overlay@2.6.2` (topics' copy shown `deduped`/`overridden`), `@bsv/templates@2.0.0`, and `@bsv/overlay-topics@2.0.0`. If `require('sqlite3')` fails, run `npm rebuild sqlite3 --foreground-scripts` (runbook: npm 12 `allowScripts`).

```bash
cd /Users/personal/git/demos/mandala/overlay && node --input-type=module -e "const t=await import('@bsv/overlay-topics');const s=await import('@bsv/templates');console.log(['MandalaTopicManager','MandalaStorageManager','createMandalaLookupService','reconcileOwnerIndex','isMandalaReject','RegistryTopicManager','RegistryStorage','registryMembership','createRegistryLookupService','REGISTRY_TOPIC','MANDALA_TOPIC'].map(k=>k+':'+typeof t[k]).join(' '));console.log(typeof s.Bsv21Binary, typeof s.tokenIdToString, 'MandalaToken' in s)"
```
Expected: every name `function` or `string`, and the last line `function function false`.

- [ ] **Step 6: Delete the replaced modules and their tests**

```bash
cd /Users/personal/git/demos/mandala/overlay && git rm -q src/tokenLinkageGuard.ts src/tokenLinkageGuard.test.ts src/adminChainGuard.ts src/adminChainGuard.test.ts src/pinnedReducer.ts src/pinnedReducer.test.ts src/feeRates.ts src/feeRates.test.ts src/registry.ts src/registry.test.ts src/membership.test.ts
```

- [ ] **Step 7: Dockerfile**

In `overlay/Dockerfile`, copy the vendor dir before `npm ci`, and replace the stale 1.6.0 comment:
```dockerfile
COPY package.json package-lock.json ./
# BRC-162 P2: overlay-topics/templates 2.0.0 are vendored tarballs until published (vendor/README.md).
COPY vendor ./vendor
RUN npm ci
```

- [ ] **Step 8: Commit**

```bash
cd /Users/personal/git/demos/mandala && git add overlay/vendor overlay/package.json overlay/package-lock.json overlay/Dockerfile && git commit -m "build(overlay): vendor overlay-topics/templates 2.0.0; delete modules the package replaces

tokenLinkageGuard, adminChainGuard, pinnedReducer, feeRates and registry
now live in @bsv/overlay-topics 2.0.0 (BRC-162). @bsv/overlay is pinned to
2.6.2 by override (2.6.3 only widens the sdk peer range). tsc is red until
the index rewiring task.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Typed verdicts (`MandalaReject.code`), delete `REASON_TABLE`

**Files:**
- Modify: `overlay/src/submitVerdict.ts:29-122`, `overlay/src/submitSideChannel.ts:139-264`, `overlay/src/admission.ts:33,486-511,571-573,606-614`
- Test: `overlay/src/submitVerdict.test.ts`, `overlay/src/submitSideChannel.test.ts`, `overlay/src/admission.test.ts`, `overlay/src/spentGuard.test.ts:8,179,289`

**Interfaces:**
- Produces:
  - `VerdictCode` (now including `'ERR_AUTHORITY' | 'ERR_UNTRUSTED'`).
  - `codeOfManagerError(e: unknown): VerdictCode | undefined`.
  - `ManagerOutcome.code?: VerdictCode`.
  - `refuse(txid, code: VerdictCode | undefined, reason, spendTxid, topic, payloadHash)` (internal to `wrapSubmitJson`).

- [ ] **Step 1: Write the failing tests** (`submitVerdict.test.ts`)

First delete the `classifyManagerReason` describe block (`:46-56`), the `:105` assertion, and `:171`. Then add:

```ts
import { MandalaReject } from '@bsv/overlay-topics'
import { codeOfManagerError, verdictFor, FINAL_CODES, InputSpentError, InfraError } from './submitVerdict.js'

describe('typed manager codes (spec §6.3)', () => {
  it('reads .code from a MandalaReject', () => {
    expect(codeOfManagerError(new MandalaReject('ERR_AUTHORITY', 'output 0: deploy signature is missing or invalid'))).toBe('ERR_AUTHORITY')
    expect(codeOfManagerError(new MandalaReject('ERR_UNTRUSTED', 'x'))).toBe('ERR_UNTRUSTED')
  })
  it('accepts a structurally-equal reject from a second package copy', () => {
    const e = Object.assign(new Error('r'), { name: 'MandalaReject', code: 'ERR_FROZEN', reason: 'r' })
    expect(codeOfManagerError(e)).toBe('ERR_FROZEN')
  })
  it('maps InputSpentError structurally', () => {
    expect(codeOfManagerError(new InputSpentError('a'.repeat(64) + '.0', 'b'.repeat(64)))).toBe('ERR_INPUT_SPENT')
  })
  it('leaves untyped errors and infra errors untyped', () => {
    expect(codeOfManagerError(new Error('conservation violated'))).toBeUndefined()
    expect(codeOfManagerError(new TypeError('x is undefined'))).toBeUndefined()
    expect(codeOfManagerError(new InfraError('store', new Error('down')))).toBeUndefined()
  })
  it('shapes the two new codes', () => {
    expect(verdictFor('ERR_AUTHORITY')).toEqual({ httpStatus: 400, retryable: false })
    expect(verdictFor('ERR_UNTRUSTED')).toEqual({ httpStatus: 409, retryable: true })
    expect(FINAL_CODES.has('ERR_AUTHORITY')).toBe(true)
    expect(FINAL_CODES.has('ERR_UNTRUSTED')).toBe(false)
    expect(FINAL_CODES.has('ERR_UNAVAILABLE')).toBe(false)
  })
})
```
In `spentGuard.test.ts`, replace both `classifyManagerReason(...)` asserts with `expect(codeOfManagerError(err)).toBe('ERR_INPUT_SPENT')` at `:179`. Delete the `:289` case: it pinned a substring false-positive that no longer exists. Fix the import at `:8`.

- [ ] **Step 2: Run, expect FAIL**

Run: `cd overlay && npx vitest run src/submitVerdict.test.ts src/spentGuard.test.ts`
Expected: FAIL, `codeOfManagerError` is not exported.

- [ ] **Step 3: Implement in `submitVerdict.ts`**

- Add `| 'ERR_AUTHORITY'` under the 400 group and `| 'ERR_UNTRUSTED'` under the 409 group of `VerdictCode`.
- Add `ERR_AUTHORITY: { httpStatus: 400, retryable: false }` and `ERR_UNTRUSTED: { httpStatus: 409, retryable: true }` to `SHAPES`.
- Add `'ERR_AUTHORITY'` to `FINAL_CODES`.
- Delete `REASON_TABLE`, its doc comment and `classifyManagerReason`. Update the file header comment, which says the table is duplicated in Go: Go P3 drops it too.
- Add:

```ts
import { isMandalaReject, type MandalaRejectCode } from '@bsv/overlay-topics'

// Every package code is a contract code; this line stops compiling if topics adds one we do not shape.
const _packageCodesAreContractCodes: MandalaRejectCode extends VerdictCode ? true : never = true
void _packageCodesAreContractCodes

/**
 * The contract code a topic-manager throw carries STRUCTURALLY (spec §6.3), or
 * undefined. Never derived from wording: a MandalaReject carries `.code`
 * (isMandalaReject is name-based, so a second package copy still matches), and
 * the spent-input guard's InputSpentError is ERR_INPUT_SPENT by type. Anything
 * else (a package bug, an unreadable BEEF) is untyped: answered 400 ERR_SHAPE
 * but never persisted (see admission.ts `refuse`).
 */
export const codeOfManagerError = (e: unknown): VerdictCode | undefined => {
  if (isMandalaReject(e)) return e.code
  if (e instanceof InputSpentError) return 'ERR_INPUT_SPENT'
  return undefined
}
```

- [ ] **Step 4: Side channel carries the code**

In `submitSideChannel.ts`:
- Add `code?: VerdictCode` to `ManagerOutcome`, documented as "the structural contract code of `reason`, when it has one (codeOfManagerError)".
- In `noteReject`, after `reason`, add `const code = codeOfManagerError(error)` and pass `code` into `this.upsert(txid, { reason, code, spendTxid, verdict, topic })`.
- Import `codeOfManagerError`.
- `reason` stays `error.message`. A MandalaReject's `message === reason` by construction.

Add to `submitSideChannel.test.ts`:
```ts
it('records the MandalaReject code next to the reason', () => {
  const ch = new SubmitSideChannel()
  ch.noteReject('t'.repeat(64), new MandalaReject('ERR_UNTRUSTED', 'output 1: authority owner k is not a trusted issuer'))
  const o = ch.take('t'.repeat(64))
  expect(o?.code).toBe('ERR_UNTRUSTED')
  expect(o?.reason).toBe('output 1: authority owner k is not a trusted issuer')
})
it('leaves code undefined for an untyped throw', () => {
  const ch = new SubmitSideChannel()
  ch.noteReject('u'.repeat(64), new Error('boom'))
  expect(ch.take('u'.repeat(64))?.code).toBeUndefined()
})
```
Before writing the second argument of `take`, check its real signature at `submitSideChannel.ts` (`take(txid, scope?)`) and match the existing tests' call style.

- [ ] **Step 5: `refuse` takes the code; untyped is never persisted**

In `admission.ts`:
- Drop `classifyManagerReason` from the import at `:33`.
- Replace `refuse` (`:486-511`) with:

```ts
    const refuse = async (
      txid: string, code: VerdictCode | undefined, reason: string, spendTxid: string | undefined,
      refusingTopic: string | undefined, payloadHash: string
    ): Promise<void> => {
      // An untyped throw (no MandalaReject code) is answered as ERR_SHAPE but is
      // NEVER persisted: it may be a package fault rather than a content verdict,
      // and a persisted final would outlive the fix.
      const answered: VerdictCode = code ?? 'ERR_SHAPE'
      if (deps.store != null && code != null && refusingTopic === TOKEN_TOPIC && FINAL_CODES.has(code)) {
        try {
          await deps.store.putRefusal({
            txid,
            refusedCode: code,
            refusedDescription: reason,
            refusedAt: nowIso(),
            refusedPayloadHash: payloadHash
          })
        } catch (e) {
          console.warn('[mandala] refusal persist failed:', e)
        }
      }
      send(verdictFor(answered).httpStatus, errorBody(answered, reason, spendTxid))
    }
```
- Update both call sites, `refuse(txid, outcome.reason, …)` → `refuse(txid, outcome.code, outcome.reason, outcome.spendTxid, outcome.topic, payloadHash)`.
- Import `type VerdictCode` if it is not already imported.

- [ ] **Step 6: Admission tests for persistence**

In `admission.test.ts`, find the verdict-table tests around `:260-300` (they feed a captured `reason` through the side channel). Re-express each row as a `MandalaReject` with an explicit code; the old string at `:273` goes. Add:

```ts
it('persists a final MandalaReject (ERR_AUTHORITY) keyed by payload hash', async () => { /* same harness as the existing ERR_CONSERVATION persistence test, rejecting with new MandalaReject('ERR_AUTHORITY', 'output 0: deploy signature is missing or invalid'); expect putRefusal called once with refusedCode 'ERR_AUTHORITY' and status 400 */ })
it('never persists ERR_UNTRUSTED and answers 409 retryable', async () => { /* expect putRefusal not called; body.code 'ERR_UNTRUSTED', retryable true */ })
it('answers an untyped manager throw 400 ERR_SHAPE without persisting', async () => { /* reject with new Error('conservation violated'); expect status 400, body.code 'ERR_SHAPE', putRefusal NOT called */ })
```
Copy the harness and fake store setup from the existing persistence test in the same file, so each case is a full, runnable test with no placeholders left in it. The comments above say what each case must set up and assert.

- [ ] **Step 7: Run, expect PASS**

Run: `cd overlay && npx vitest run src/submitVerdict.test.ts src/submitSideChannel.test.ts src/admission.test.ts src/spentGuard.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add overlay/src/submitVerdict.ts overlay/src/submitSideChannel.ts overlay/src/admission.ts overlay/src/*.test.ts && git commit -m "feat(overlay): typed verdicts from MandalaReject.code; delete REASON_TABLE

Adds ERR_AUTHORITY (400, persisted) and ERR_UNTRUSTED (409, never
persisted). An untyped manager throw answers 400 ERR_SHAPE but is never
persisted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `MANDALA_ISSUER_KEYS` boot config

**Files:**
- Modify: `overlay/src/bootConfig.ts`, `overlay/.env.example`
- Test: `overlay/src/bootConfig.test.ts`

**Interfaces:**
- Produces: `BootConfig.issuerKeys: readonly string[]` (canonical lowercase compressed keys, input order, non-empty) and `parseIssuerKeys(raw: string | undefined): string[]`.

- [ ] **Step 1: Failing tests** (append to `bootConfig.test.ts`; reuse its existing `baseEnv` helper, or whatever the file calls its valid-env fixture)

```ts
import { PrivateKey } from '@bsv/sdk'
import { parseIssuerKeys } from './bootConfig.js'
const K1 = PrivateKey.fromHex('66'.repeat(32)).toPublicKey().toString()
const K2 = PrivateKey.fromHex('44'.repeat(32)).toPublicKey().toString()

describe('MANDALA_ISSUER_KEYS (spec §5.1)', () => {
  it('parses a JSON array of compressed keys', () => {
    expect(parseIssuerKeys(JSON.stringify([K1, K2]))).toEqual([K1, K2])
  })
  it.each([
    [undefined, /MANDALA_ISSUER_KEYS is required/],
    ['', /MANDALA_ISSUER_KEYS is required/],
    ['[]', /at least one/],
    ['not json', /JSON array/],
    ['{"a":1}', /JSON array/],
    [JSON.stringify([K1, K1]), /duplicate/],
    [JSON.stringify([K1.toUpperCase()]), /lowercase/],
    [JSON.stringify(['04' + 'ab'.repeat(64)]), /compressed/],
    [JSON.stringify(['02' + '00'.repeat(32)]), /not a valid public key/],
    [JSON.stringify([7]), /compressed/]
  ])('refuses %j', (raw, msg) => {
    expect(() => parseIssuerKeys(raw as string | undefined)).toThrow(msg)
  })
  it('readBootConfig exposes issuerKeys and fails boot without them', () => {
    expect(readBootConfig({ ...baseEnv, MANDALA_ISSUER_KEYS: JSON.stringify([K1]) }).issuerKeys).toEqual([K1])
    const { MANDALA_ISSUER_KEYS: _drop, ...without } = { ...baseEnv, MANDALA_ISSUER_KEYS: '' }
    expect(() => readBootConfig(without)).toThrow(/MANDALA_ISSUER_KEYS is required/)
  })
})
```
Also add `MANDALA_ISSUER_KEYS: JSON.stringify([K1])` to the file's base valid env, so the existing 28 cases keep passing.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run src/bootConfig.test.ts`

- [ ] **Step 3: Implement** (in `bootConfig.ts`)

```ts
import { PublicKey } from '@bsv/sdk'

/**
 * MANDALA_ISSUER_KEYS (spec §5.1): the trusted-issuer set, a JSON array of
 * compressed identity keys in canonical lowercase hex. The package refuses a
 * non-canonical set at construction; failing here names the env var instead.
 */
export const parseIssuerKeys = (raw: string | undefined): string[] => {
  if (raw == null || raw.trim() === '') throw new Error('MANDALA_ISSUER_KEYS is required (JSON array of compressed identity public keys)')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys') }
  if (!Array.isArray(parsed)) throw new Error('MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys')
  if (parsed.length === 0) throw new Error('MANDALA_ISSUER_KEYS must name at least one issuer key')
  const seen = new Set<string>()
  for (const [i, k] of parsed.entries()) {
    if (typeof k !== 'string' || !/^0[23][0-9a-fA-F]{64}$/.test(k)) throw new Error(`MANDALA_ISSUER_KEYS[${i}] is not a compressed public key (02/03 + 64 hex)`)
    if (k !== k.toLowerCase()) throw new Error(`MANDALA_ISSUER_KEYS[${i}] must be lowercase hex`)
    try { PublicKey.fromString(k) } catch { throw new Error(`MANDALA_ISSUER_KEYS[${i}] is not a valid public key`) }
    if (seen.has(k)) throw new Error(`MANDALA_ISSUER_KEYS[${i}] is a duplicate`)
    seen.add(k)
  }
  return [...seen]
}
```
Add `issuerKeys: string[]` to `BootConfig`, and set `issuerKeys: parseIssuerKeys(env.MANDALA_ISSUER_KEYS)` in `readBootConfig`, next to the other required vars.

Check `02 + 00…` really throws in `PublicKey.fromString`. If it does not, drop that vector rather than weaken the parser. Note the deletion in the commit message.

- [ ] **Step 4: `.env.example`**

Add after `NETWORK`:
```bash
# Trusted issuers (BRC-162 §5.1): JSON array of compressed identity public keys,
# lowercase hex. Gates deploys, authority outputs and the registry. Required.
# `npm run gen-key` prints IDENTITY_PUBLIC_KEY for a key you control.
MANDALA_ISSUER_KEYS=["02replace_with_issuer_identity_key"]
```
Also update the ADMIN_API_TOKEN comment's public route list: `asset-auth*` → `authorities*`.

- [ ] **Step 5: Run, expect PASS**: `npx vitest run src/bootConfig.test.ts`
- [ ] **Step 6: Commit** `feat(overlay): MANDALA_ISSUER_KEYS boot config (spec §5.1)`, with the trailer.

---

### Task 4: `EngineOutputReader` over the engine `outputs` table

**Files:**
- Create: `overlay/src/engineOutputs.ts`
- Test: `overlay/src/engineOutputs.test.ts`

**Interfaces:**
- Consumes: `KnexLike` from `spentGuard.ts`; `EngineOutputReader` type from `@bsv/overlay-topics`.
- Produces: `knexEngineOutputs(knex: KnexLike): EngineOutputReader`.

Contract (package `types.ts`):
- `findAdmittedOutput(txid, outputIndex, topic)` → `{lockingScript: number[], satoshis}`, or `null` when the output is absent **or spent**.
- `listUnspentAdmittedOutputs(topic, after, limit)` → unspent `{txid, outputIndex}` in keyset order `(txid, outputIndex)` ascending, strictly after `after`.

- [ ] **Step 1: Failing test** (real engine tables via the harness)

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createHarness, HARNESS_TOPIC, type Harness } from './testkit/engineHarness.js'
import { knexEngineOutputs } from './engineOutputs.js'

let h: Harness | undefined
afterEach(async () => { await h?.close(); h = undefined })

describe('knexEngineOutputs', () => {
  it('reads an admitted unspent output and nulls it once spent', async () => {
    h = await createHarness()
    const a = await h.spend(900)
    await h.submit(a)
    const r = knexEngineOutputs(h.knex)
    const got = await r.findAdmittedOutput(a.id('hex'), 0, HARNESS_TOPIC)
    expect(got).toEqual({ lockingScript: a.outputs[0].lockingScript.toBinary(), satoshis: 900 })
    expect(await r.findAdmittedOutput(a.id('hex'), 0, 'tm_other')).toBeNull()
    expect(await r.findAdmittedOutput(a.id('hex'), 1, HARNESS_TOPIC)).toBeNull()
    const b = await h.spend(800, a, 0)
    await h.submit(b)
    expect(await r.findAdmittedOutput(a.id('hex'), 0, HARNESS_TOPIC)).toBeNull()
  })
  it('pages unspent outputs in (txid, outputIndex) keyset order', async () => {
    h = await createHarness()
    const txs = []
    let src = undefined as any
    for (let i = 0; i < 3; i++) { const t = await h.spend(900 - i, src ?? h.root, 0); await h.submit(t); src = t; txs.push(t) }
    const r = knexEngineOutputs(h.knex)
    const all = await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, null, 10)
    expect(all).toEqual([{ txid: txs[2].id('hex'), outputIndex: 0 }])  // earlier ones are spent by the chain
    const page1 = await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, null, 1)
    expect(await r.listUnspentAdmittedOutputs(HARNESS_TOPIC, page1[0], 1)).toEqual([])
  })
  it('throws (never nulls) on an unreadable spent column', async () => {
    h = await createHarness()
    const a = await h.spend(900); await h.submit(a)
    await h.knex('outputs').where({ txid: a.id('hex') }).update({ spent: 7 })
    await expect(knexEngineOutputs(h.knex).findAdmittedOutput(a.id('hex'), 0, HARNESS_TOPIC)).rejects.toThrow(/outputs.spent/)
  })
})
```
Add one more keyset case with two unspent outputs in the same tx (`h.spend` makes one output; build a two-output tx inline with `new Transaction(...)`, signing as `h.spend` does), and assert the page order `[{t,0}], then [{t,1}]`.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run src/engineOutputs.test.ts`

- [ ] **Step 3: Implement**

```ts
import type { EngineOutputReader } from '@bsv/overlay-topics'
import type { KnexLike } from './spentGuard.js'

// The host side of the package's §4.2a repair and reconciler: the engine's own
// admitted outputs, read from KnexStorage's `outputs` table. A spent output reads
// as null (package contract), and an unreadable `spent` throws rather than
// guessing (§9.5): a guess either way repairs a row for a coin that is gone or
// hides a live one.

const spentOf = (raw: unknown): boolean => {
  if (typeof raw === 'boolean') return raw
  const n = typeof raw === 'bigint' ? Number(raw) : raw
  if (n === 0 || n === 1) return n === 1
  throw new Error(`outputs.spent has an unexpected value of type ${raw === null ? 'null' : typeof raw}`)
}

const bytesOf = (raw: unknown): number[] => {
  if (raw instanceof Uint8Array) return Array.from(raw)
  if (Array.isArray(raw)) return raw as number[]
  throw new Error('outputs.outputScript is not binary')
}

export const knexEngineOutputs = (knex: KnexLike): EngineOutputReader => ({
  findAdmittedOutput: async (txid, outputIndex, topic) => {
    const row = await knex('outputs').where({ txid, outputIndex, topic }).first('outputScript', 'satoshis', 'spent')
    if (row == null || spentOf(row.spent)) return null
    return { lockingScript: bytesOf(row.outputScript), satoshis: Number(row.satoshis) }
  },
  listUnspentAdmittedOutputs: async (topic, after, limit) => {
    const q = knex('outputs').where({ topic, spent: false })
    if (after != null) {
      q.andWhere((w: any) => w.where('txid', '>', after.txid)
        .orWhere((x: any) => x.where('txid', after.txid).andWhere('outputIndex', '>', after.outputIndex)))
    }
    const rows = await q.orderBy([{ column: 'txid' }, { column: 'outputIndex' }]).limit(limit).select('txid', 'outputIndex')
    return rows.map((r: any) => ({ txid: String(r.txid), outputIndex: Number(r.outputIndex) }))
  }
})
```
If `KnexLike` (spentGuard.ts) is too narrow for `.first(cols)`, `.orderBy`, `.limit` and `.select`, widen it there. Keep it structural, and keep the test using the real knex.

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(overlay): EngineOutputReader over the engine outputs table (§4.2a host side)`.

---

### Task 5: Maintenance gate: quiesce submissions for refold, reconcile and eviction

**Files:**
- Create: `overlay/src/maintenanceGate.ts`
- Test: `overlay/src/maintenanceGate.test.ts`

**Interfaces:**
- Produces:
  - `class MaintenanceGate { enter(): Promise<() => void>; exclusive<T>(fn: () => Promise<T>): Promise<T>; get busy(): boolean }`
  - `gateSubmits(gate: MaintenanceGate): express.RequestHandler`. It holds a shared slot until the response `finish` or `close` fires; the release is idempotent.

Semantics: submits share the gate. `exclusive` waits for all in-flight shared holders to drain. While an exclusive is waiting or running, new `enter()` calls queue behind it (writer preference, so the interval cannot starve). Exclusives run one at a time. The package README requires this: "`rebuildState` reads then writes the state and must never run beside a live fold."

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { MaintenanceGate, gateSubmits } from './maintenanceGate.js'

const tick = () => new Promise(r => setImmediate(r))

describe('MaintenanceGate', () => {
  it('exclusive waits for in-flight submits to drain', async () => {
    const g = new MaintenanceGate(); const log: string[] = []
    const release = await g.enter()
    const ex = g.exclusive(async () => { log.push('maint') })
    await tick(); expect(log).toEqual([])
    release(); await ex; expect(log).toEqual(['maint'])
  })
  it('submits arriving during maintenance wait for it', async () => {
    const g = new MaintenanceGate(); const log: string[] = []
    let finish!: () => void
    const ex = g.exclusive(() => new Promise<void>(r => { finish = () => { log.push('maint'); r() } }))
    await tick()
    const entered = g.enter().then(rel => { log.push('submit'); rel() })
    await tick(); expect(log).toEqual([])
    finish(); await ex; await entered
    expect(log).toEqual(['maint', 'submit'])
  })
  it('a waiting exclusive blocks new submits (no starvation)', async () => {
    const g = new MaintenanceGate(); const log: string[] = []
    const r1 = await g.enter()
    const ex = g.exclusive(async () => { log.push('maint') })
    const late = g.enter().then(rel => { log.push('late'); rel() })
    await tick(); r1(); await ex; await late
    expect(log).toEqual(['maint', 'late'])
  })
  it('release is idempotent and an exclusive that throws frees the gate', async () => {
    const g = new MaintenanceGate()
    const r = await g.enter(); r(); r()
    await expect(g.exclusive(async () => { throw new Error('x') })).rejects.toThrow('x')
    const r2 = await g.enter(); r2(); expect(g.busy).toBe(false)
  })
  it('gateSubmits releases on finish and on close (client abort)', async () => {
    const g = new MaintenanceGate(); const mw = gateSubmits(g)
    for (const ev of ['finish', 'close']) {
      const res = new EventEmitter() as any; let nexted = false
      await new Promise<void>(r => mw({} as any, res, () => { nexted = true; r() }))
      expect(nexted).toBe(true); expect(g.busy).toBe(true)
      res.emit(ev); res.emit('close'); expect(g.busy).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
import type { RequestHandler } from 'express'

/**
 * Quiesces /submit while state maintenance runs (package README "Boot refold",
 * "Eviction"): refold reads then writes asset state and must never interleave
 * with a live fold. Submits share the gate; maintenance is exclusive, waits for
 * in-flight submits to drain, and blocks new ones while it waits (writer
 * preference, so a busy overlay cannot starve the reconciler).
 */
export class MaintenanceGate {
  private shared = 0
  private exclusiveActive = false
  private exclusiveWaiting = 0
  private readonly waiters: Array<() => void> = []

  get busy (): boolean { return this.shared > 0 || this.exclusiveActive }

  private wake (): void {
    const ws = this.waiters.splice(0)
    for (const w of ws) w()
  }

  async enter (): Promise<() => void> {
    while (this.exclusiveActive || this.exclusiveWaiting > 0) {
      await new Promise<void>(r => this.waiters.push(r))
    }
    this.shared++
    let released = false
    return () => {
      if (released) return
      released = true
      this.shared--
      if (this.shared === 0) this.wake()
    }
  }

  async exclusive<T> (fn: () => Promise<T>): Promise<T> {
    this.exclusiveWaiting++
    try {
      while (this.exclusiveActive || this.shared > 0) {
        await new Promise<void>(r => this.waiters.push(r))
      }
    } finally {
      this.exclusiveWaiting--
    }
    this.exclusiveActive = true
    try {
      return await fn()
    } finally {
      this.exclusiveActive = false
      this.wake()
    }
  }
}

/** Holds a shared slot for the life of one /submit response. */
export const gateSubmits = (gate: MaintenanceGate): RequestHandler => (req, res, next) => {
  gate.enter().then(release => {
    res.once('finish', release)
    res.once('close', release)
    next()
  }, next)
}
```
Note the `finally` on `exclusiveWaiting--`. Without it, a waiter that wakes and finds another exclusive active would leave the count wrong. Add a test with two concurrent `exclusive` calls asserting they serialize (`log` `['a-start','a-end','b-start','b-end']`).

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(overlay): maintenance gate quiesces /submit for refold, reconcile and eviction`.

---

### Task 6: Owner-index maintenance (boot refold, reconcile, interval, readiness)

**Files:**
- Create: `overlay/src/ownerIndex.ts`
- Test: `overlay/src/ownerIndex.test.ts`

**Interfaces:**
- Consumes: `MaintenanceGate` (Task 5); `reconcileOwnerIndex`, `MANDALA_TOPIC`, `REGISTRY_TOPIC` from `@bsv/overlay-topics`; an `EngineOutputReader` (Task 4).
- Produces:

```ts
export interface OwnerIndexDeps {
  gate: MaintenanceGate
  lookup: { tokenIdsWithHistory: () => Promise<string[]>, rebuildState: (tokenId: string) => Promise<void> }
  reconcile: (topic: string) => Promise<{ scanned: number, repaired: number, unrepairable: string[] }>
  topics: readonly string[]          // [MANDALA_TOPIC, REGISTRY_TOPIC]
  log?: (msg: string) => void
}
export interface OwnerIndexStatus { lastRunAt: string | null, lastError: string | null, unrepairable: string[] }
export class OwnerIndexMaintenance {
  constructor (deps: OwnerIndexDeps)
  status (): OwnerIndexStatus
  runOnce (): Promise<void>           // never throws; records lastError
  start (intervalMs: number): void    // setInterval(...).unref(); a run never overlaps the previous one
  stop (): void
  healthCheck (): { name: 'mandala-owner-index', scope: 'ready', critical: false, handler: () => Promise<{ status: 'ok' | 'degraded', message?: string, details?: unknown }> }
}
export const OWNER_INDEX_INTERVAL_MS = 300_000
```

- [ ] **Step 1: Failing tests** (fakes only: no Mongo)

```ts
import { describe, it, expect, vi } from 'vitest'
import { MaintenanceGate } from './maintenanceGate.js'
import { OwnerIndexMaintenance } from './ownerIndex.js'

const mk = (over: Partial<any> = {}) => {
  const calls: string[] = []
  const deps = {
    gate: new MaintenanceGate(),
    lookup: {
      tokenIdsWithHistory: async () => { calls.push('ids'); return ['a'.repeat(64) + '_0', 'b'.repeat(64) + '_0'] },
      rebuildState: async (id: string) => { calls.push('rebuild:' + id.slice(0, 1)) }
    },
    reconcile: async (topic: string) => { calls.push('reconcile:' + topic); return { scanned: 1, repaired: 0, unrepairable: [] as string[] } },
    topics: ['tm_mandala', 'tm_mandala_registry'],
    log: () => {},
    ...over
  }
  return { deps, calls, m: new OwnerIndexMaintenance(deps) }
}

describe('OwnerIndexMaintenance', () => {
  it('refolds every token, then reconciles each topic, inside the exclusive gate', async () => {
    const { deps, calls, m } = mk()
    const spy = vi.spyOn(deps.gate, 'exclusive')
    await m.runOnce()
    expect(calls).toEqual(['ids', 'rebuild:a', 'rebuild:b', 'reconcile:tm_mandala', 'reconcile:tm_mandala_registry'])
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await m.healthCheck().handler()).status).toBe('ok')
  })
  it('reports unrepairable outpoints as degraded (not critical)', async () => {
    const { m } = mk({ reconcile: async (t: string) => ({ scanned: 2, repaired: 0, unrepairable: t === 'tm_mandala' ? ['c'.repeat(64) + '.1'] : [] }) })
    await m.runOnce()
    const h = m.healthCheck()
    expect(h).toMatchObject({ name: 'mandala-owner-index', scope: 'ready', critical: false })
    const r = await h.handler()
    expect(r.status).toBe('degraded')
    expect(r.details).toEqual({ unrepairable: ['c'.repeat(64) + '.1'] })
  })
  it('a failing run never throws, reports degraded, and the next run recovers', async () => {
    let fail = true
    const { m } = mk({ reconcile: async () => { if (fail) throw new Error('mongo down'); return { scanned: 0, repaired: 0, unrepairable: [] } } })
    await expect(m.runOnce()).resolves.toBeUndefined()
    expect(m.status().lastError).toMatch(/mongo down/)
    expect((await m.healthCheck().handler()).status).toBe('degraded')
    fail = false; await m.runOnce()
    expect(m.status().lastError).toBeNull()
    expect((await m.healthCheck().handler()).status).toBe('ok')
  })
  it('one refold failure still reconciles (the index repair does not depend on state)', async () => {
    const { calls, m } = mk({ lookup: { tokenIdsWithHistory: async () => ['a'.repeat(64) + '_0'], rebuildState: async () => { throw new Error('fold') } } })
    await m.runOnce()
    expect(calls).toContain('reconcile:tm_mandala')
    expect(m.status().lastError).toMatch(/fold/)
  })
  it('degraded before the first run completes', async () => {
    const { m } = mk()
    expect((await m.healthCheck().handler()).status).toBe('degraded')
  })
  it('the interval never overlaps runs and stop() clears it', async () => {
    vi.useFakeTimers()
    let running = 0, maxRunning = 0, release!: () => void
    const { m } = mk({ reconcile: async () => { running++; maxRunning = Math.max(maxRunning, running); await new Promise<void>(r => { release = r }); running--; return { scanned: 0, repaired: 0, unrepairable: [] } } })
    m.start(1000)
    await vi.advanceTimersByTimeAsync(3500)
    expect(maxRunning).toBe(1)
    m.stop(); release?.()
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** `ownerIndex.ts`:
- `runOnce`: if a run is in flight, return that same promise (no overlap). Otherwise `gate.exclusive(async () => { … })`:
  1. Get `ids = await lookup.tokenIdsWithHistory()`. For each id, `try { await lookup.rebuildState(id) } catch (e) { errors.push(\`refold ${id}: ${msg(e)}\`) }`.
  2. For each topic, `try { const r = await reconcile(topic); unrepairable.push(...r.unrepairable); log(\`[mandala] owner index ${topic}: scanned ${r.scanned}, repaired ${r.repaired}, unrepairable ${r.unrepairable.length}\`) } catch (e) { errors.push(\`reconcile ${topic}: ${msg(e)}\`) }`.
  3. Store `status = { lastRunAt: now, lastError: errors.length ? errors.join('; ') : null, unrepairable }`.
  4. Wrap the whole thing in try/catch so `runOnce` never rejects.
  5. Log each unrepairable outpoint once per run (operator alert, §4.2a rule 5).
- `healthCheck().handler`: `status.lastRunAt == null` → `{status:'degraded', message:'owner index not yet reconciled'}`; `lastError` → `{status:'degraded', message: lastError}`; `unrepairable.length > 0` → `{status:'degraded', message: \`${n} owner index rows unrepairable\`, details: { unrepairable }}`; else `{status:'ok'}`. Never include anything secret.
- `start(ms)`: `this.timer = setInterval(() => { void this.runOnce() }, ms); this.timer.unref()`. `stop()`: `clearInterval`.
- Before writing the health definition, check that `HealthCheckDefinition` in `node_modules/@bsv/overlay-express/dist/types/src/` really has `{name, scope?, critical?, handler}` and that the handler result type is `{status:'ok'|'degraded'|'error', message?, details?}`. If it differs, match the real type.

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(overlay): owner-index refold + reconcile on boot and interval; mandala-owner-index readiness`.

---

### Task 7: Snapshot and eviction through the owner journal and `purgeAndRefold`

**Files:**
- Modify: `overlay/src/submitSideChannel.ts:30-137` (drop `AdmissionTokenRow` / `tokenRows`), `overlay/src/admissionStore.ts`, `overlay/src/eviction.ts:58-290`
- Test: `overlay/src/eviction.test.ts`, `overlay/src/submitSideChannel.test.ts`, `overlay/src/restoreSnapshot.test.ts`
- Delete: `overlay/src/tokenRestore.test.ts` (it tested `mongoRestoreTokenRow`, which this task deletes)

**Interfaces:**
- Consumes: the package `MandalaOwnerRecord`; `storage.getOwnerJournal(txid, vout, topic)`; `lookup.restoreInputRow(journal): Promise<boolean>`; `lookup.purgeAndRefold(txid): Promise<string[]>`; `MaintenanceGate.exclusive`.
- Produces:
  - `AdmissionRestore = { spentOutpoints: string[] }`
  - `snapshotRestore(tx: Transaction): AdmissionRestore` (sync, no store read)
  - `EvictionDeps` with `restoreInput(txid: string, vout: number): Promise<boolean>`, `purgeAndRefold(txid: string): Promise<string[]>`, and optional `quiesce?: <T>(fn: () => Promise<T>) => Promise<T>`. The `restoreTokenRow`, `assetsTouchedBy`, `rebuildAssetStateExcluding` and `purgeAdminHistory` deps are removed.
  - `journalRestoreInput(getJournal, restoreInputRow, topic): EvictionDeps['restoreInput']`.

Why: the owner journal is never purged and covers every role (§4.2a, §6.6), so it replaces the pre-spend token-row snapshot. Authority inputs are now restored too; the old snapshot only knew value rows. The restore still runs only for coins the engine shows live again (the `restorable` set). §9.12 keeps the body key `restoredTokenRows`, which now counts journal restores that inserted a row.

- [ ] **Step 1: Failing tests** (`eviction.test.ts`)

Rewrite the fixtures: asset ids `'a.0'` → token ids `'a'.repeat(64) + '_0'`. Replace the hooks `restoreTokenRow`, `assetsTouchedBy`, `rebuildAssetStateExcluding` and `purgeAdminHistory` in the shared deps factory with:
```ts
restoreInput: vi.fn(async (_txid: string, _vout: number) => true),
purgeAndRefold: vi.fn(async (_txid: string) => ['a'.repeat(64) + '_0']),
```
Port each existing case one-to-one: the rebuild-then-purge ordering cases become one `purgeAndRefold` call after `evict`. Add:

```ts
it('restores every live input through the journal (value and authority alike), never a coin still spent elsewhere', async () => {
  const live = `${'1'.repeat(64)}.0`, auth = `${'2'.repeat(64)}.1`, taken = `${'3'.repeat(64)}.0`
  const deps = mkDeps({ restore: { spentOutpoints: [live, auth, taken] } })
  deps.unmarkSpent = vi.fn(async (t: string) => (t === '3'.repeat(64) ? 0 : 1))
  deps.isUnspent = vi.fn(async () => false)
  const rep = await evictWithRestore('e'.repeat(64), 'REJECTED', deps)
  expect(deps.restoreInput).toHaveBeenCalledWith('1'.repeat(64), 0)
  expect(deps.restoreInput).toHaveBeenCalledWith('2'.repeat(64), 1)
  expect(deps.restoreInput).not.toHaveBeenCalledWith('3'.repeat(64), 0)
  expect(rep.restoredTokenRows).toBe(2)
})
it('counts only journal restores that inserted a row', async () => { /* restoreInput resolves false for one input → restoredTokenRows excludes it */ })
it('a restoreInput failure stamps nothing and answers InfraError', async () => { /* restoreInput rejects → rejects with InfraError, store.markEvicted not called, evict not called */ })
it('purgeAndRefold runs after evict, even when alreadyEvicted, and a failure is InfraError', async () => { /* order evict → purgeAndRefold; alreadyEvicted record still calls purgeAndRefold */ })
it('runs the whole eviction inside quiesce when provided', async () => { /* quiesce spy wraps; restoreInput/evict/purgeAndRefold all called inside it */ })
```
Write each commented case as a full test, built from the same `mkDeps` factory and `fakeStore` the file already uses.

Also add a `journalRestoreInput` unit test:
```ts
it('journalRestoreInput restores the journaled owner; a non-token input is a no-op', async () => {
  const j = { txid: '1'.repeat(64), outputIndex: 0, topic: 'tm_mandala', tokenId: 'a'.repeat(64) + '_0', role: 'authority', amount: 0, identityKey: '02'+'ab'.repeat(32), createdAt: new Date() }
  const restore = vi.fn(async () => true)
  const f = journalRestoreInput(async (t, v) => (t === j.txid && v === 0 ? j as any : null), restore, 'tm_mandala')
  expect(await f(j.txid, 0)).toBe(true); expect(restore).toHaveBeenCalledWith(j)
  expect(await f('9'.repeat(64), 0)).toBe(false); expect(restore).toHaveBeenCalledTimes(1)
})
```

In `submitSideChannel.test.ts`, replace the `snapshotRestoreFrom` tests with `snapshotRestore(tx)` → `{spentOutpoints:[every input]}` (no store read), and simplify the `mergeRestore` tests to union-of-outpoints. Port `restoreSnapshot.test.ts` (Mongo) the same way: the merge-only growth of `spentOutpoints` survives, and the `tokenRows`/`MandalaStorageManager` parts go.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run src/eviction.test.ts src/submitSideChannel.test.ts src/restoreSnapshot.test.ts`

- [ ] **Step 3: Implement**
- `submitSideChannel.ts`: delete `AdmissionTokenRow`, `TokenRowLike` and `snapshotRestoreFrom`. `AdmissionRestore` becomes `{ spentOutpoints: string[] }`. `mergeRestore` unions `spentOutpoints`, first-seen order kept. Add:
```ts
/** Every input of the transaction (overlay-go names every input too); owners come from the journal at eviction. */
export const snapshotRestore = (tx: Transaction): AdmissionRestore => ({
  spentOutpoints: tx.inputs.flatMap(inp => {
    const srcTxid = inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''
    return srcTxid === '' ? [] : [`${srcTxid}.${inp.sourceOutputIndex}`]
  })
})
```
`VerdictCaptureDeps.snapshotRestore` becomes `(tx: Transaction, previousCoins?: number[]) => AdmissionRestore | Promise<AdmissionRestore>`. Keep the existing await.
- `admissionStore.ts`: drop `tokenRows` from the persisted restore. A stored legacy record with `tokenRows` is ignored on read (clean break, fresh DB). Remove the field from any merge code.
- `eviction.ts`:
  - Delete `TokenRowsCollection` and `mongoRestoreTokenRow`.
  - In `EvictionDeps`, replace the four removed hooks with `restoreInput`, `purgeAndRefold` and `quiesce?`.
  - In `evictWithRestore`, replace the `tokenRows` loop with:
```ts
    for (const outpoint of restorable) {
      const [t, v] = outpoint.split('.')
      try {
        if (await deps.restoreInput(t, Number(v))) restoredTokenRows++
      } catch (e) {
        throw new InfraError(`could not restore the owner row for ${outpoint}; retry`, e)
      }
    }
```
  and replace the asset rebuild and purge block with:
```ts
  try {
    await deps.purgeAndRefold(txid)
  } catch (e) {
    throw new InfraError(`could not refold the tokens touched by ${txid}; retry`, e)
  }
```
  - Wrap the body: `const run = async () => { …existing body… }; return deps.quiesce != null ? await deps.quiesce(run) : await run()`.
  - Add:
```ts
export const journalRestoreInput = (
  getJournal: (txid: string, vout: number, topic: string) => Promise<MandalaOwnerRecord | null>,
  restoreInputRow: (journal: MandalaOwnerRecord) => Promise<boolean>,
  topic: string
): EvictionDeps['restoreInput'] => async (txid, vout) => {
  const journal = await getJournal(txid, vout, topic)
  return journal == null ? false : await restoreInputRow(journal)
}
```
  - Update the `evictWithRestore` doc comment to name the journal and `purgeAndRefold`.

- [ ] **Step 4: Run, expect PASS.** Also run `npx vitest run src/engineIntegration.test.ts`, which uses the eviction coins.
- [ ] **Step 5: Commit** `feat(overlay): eviction restores inputs from the owner journal and refolds via purgeAndRefold`.

---

### Task 8: v3 admin routes (authorities, asset state, history, summary)

**Files:**
- Create: `overlay/src/tokenRoutes.ts`
- Delete: `overlay/src/assetAuth.ts`, `overlay/src/assetAuth.test.ts`
- Test: `overlay/src/tokenRoutes.test.ts`

**Interfaces:**
- Produces (pure handlers over injected deps; index.ts mounts them in Task 10):

```ts
export const TOKEN_ID_RE = /^[0-9a-f]{64}_0$/
export const tokenIdParam: (raw: unknown) => string | null
export const voutParam: (raw: unknown) => number | null              // moved from assetAuth.ts unchanged
export const splitOutpoint: (o: string) => { txid: string, vout: number } | null
export interface RouteResult { status: number, body: unknown }

export const authoritiesResponse: (tokenId: unknown, deps: { listAuthorities: (tokenId: string) => Promise<Array<{ txid: string, outputIndex: number, identityKey: string }>> }) => Promise<RouteResult>
  // 200 {tokenId, authorities:[{outpoint:'<txid>.<vout>', identityKey}]} sorted by outpoint; 400 {error:'invalid tokenId'}
export const authoritiesBeefResponse: (txid: unknown, vout: unknown, deps: { findBeef: (txid: string, vout: number) => Promise<{ beef: number[], outputIndex: number } | null> }) => Promise<RouteResult>
  // same semantics as the old assetAuthBeefHandler; 404 'admin tx not in overlay storage'
export const assetStateResponse: (tokenId: unknown, deps: { getAssetState: (id: string) => Promise<AssetAdminState>, hasTokenRow: (txid: string, vout: number) => Promise<boolean> }) => Promise<RouteResult>
  // state with frozenOutpoints[i].hasFrozenRow (A16, kept); feeRatePerKb comes from the state itself
export const adminHistoryPageResponse: (tokenId: unknown, limit: unknown, offset: unknown, deps: { page: (id: string, limit: number, offset: number) => Promise<AdminHistoryEntry[]> }) => Promise<RouteResult>
  // limit clamp 1..500 default 100; offset ≥0 default 0; rows newest first (admitSeq desc), as before
export const summarizeHistory: (rows: ReadonlyArray<Pick<AdminHistoryEntry, 'txid' | 'outputIndex' | 'kind' | 'delta'>>) => { totalIssued: number, totalRedeemed: number, actionCount: number }
  // dedupe by (txid,outputIndex); totalIssued = Σ positive delta; totalRedeemed = Σ |negative delta|; actionCount = distinct actions
export const adminSummaryResponse: (tokenId: unknown, deps: { history: (id: string) => Promise<AdminHistoryEntry[]> }) => Promise<RouteResult>
```
Every response for a bad `tokenId` is `400 {error: 'invalid tokenId'}`, and the deps are never called.

Height on authorities: §6.5 makes `height?` optional. P2 omits it (YAGNI). The lib picks authorities by outpoint in P4.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { authoritiesResponse, authoritiesBeefResponse, assetStateResponse, adminHistoryPageResponse, adminSummaryResponse, summarizeHistory, tokenIdParam } from './tokenRoutes.js'
import { defaultAssetState } from '@bsv/overlay-topics'

const T = 'ab'.repeat(32) + '_0'
const K = '02' + 'cd'.repeat(32)

describe('tokenIdParam', () => {
  it.each([T])('accepts %s', id => expect(tokenIdParam(id)).toBe(id))
  it.each(['ab'.repeat(32) + '.0', 'AB'.repeat(32) + '_0', 'ab'.repeat(32) + '_1', 'ab'.repeat(31) + '_0', '', undefined, 7, [T]])('refuses %j', id => expect(tokenIdParam(id)).toBeNull())
})

describe('authoritiesResponse', () => {
  it('lists unspent authorities as outpoints, sorted', async () => {
    const r = await authoritiesResponse(T, { listAuthorities: async () => [
      { txid: 'ff'.repeat(32), outputIndex: 1, identityKey: K }, { txid: '00'.repeat(32), outputIndex: 2, identityKey: K }] })
    expect(r).toEqual({ status: 200, body: { tokenId: T, authorities: [
      { outpoint: '00'.repeat(32) + '.2', identityKey: K }, { outpoint: 'ff'.repeat(32) + '.1', identityKey: K }] } })
  })
  it('an old-format id is 400, not 200 []', async () => {
    const list = vi.fn()
    expect((await authoritiesResponse('ab'.repeat(32) + '.0', { listAuthorities: list })).status).toBe(400)
    expect(list).not.toHaveBeenCalled()
  })
  it('a known token with no authorities is 200 []', async () => {
    expect((await authoritiesResponse(T, { listAuthorities: async () => [] })).body).toEqual({ tokenId: T, authorities: [] })
  })
})

describe('summarizeHistory', () => {
  it('sums positive and negative deltas once per action', () => {
    expect(summarizeHistory([
      { txid: 'a', outputIndex: 1, kind: 'issue', delta: 500 },
      { txid: 'a', outputIndex: 1, kind: 'issue', delta: 500 },
      { txid: 'b', outputIndex: 1, kind: 'redeem', delta: -200 },
      { txid: 'c', outputIndex: 1, kind: 'pause', delta: 0 },
      { txid: 'd', outputIndex: 1, kind: 'reissue', delta: 50 }
    ])).toEqual({ totalIssued: 550, totalRedeemed: 200, actionCount: 4 })
  })
})

describe('assetStateResponse', () => {
  it('flags frozen outpoints that have a token row', async () => {
    const s = { ...defaultAssetState(T, 25), frozenOutpoints: [{ outpoint: 'aa'.repeat(32) + '.0', amount: 5, owner: K }] }
    const r = await assetStateResponse(T, { getAssetState: async () => s, hasTokenRow: async () => true })
    expect(r.status).toBe(200)
    expect((r.body as any).feeRatePerKb).toBe(25)
    expect((r.body as any).frozenOutpoints[0].hasFrozenRow).toBe(true)
  })
})
```
Add tests for:
- `adminHistoryPageResponse`: limit clamp 0 → 1, 9999 → 500, `'x'` → 100, offset `-1` → 0, and the deps are called with the clamped values.
- `authoritiesBeefResponse`: port the old `assetAuth.test.ts` beef cases verbatim, renaming only the handler.
- `adminSummaryResponse`: a 400 on a bad id.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** `tokenRoutes.ts`. Move `voutParam`, `splitOutpoint`, `ADMIN_TX_NOT_FOUND`, the beef handler body and `withFrozenRowFlags` from `assetAuth.ts`; keep their doc comments. Delete `pickAssetAuthHead`, `AdminHistoryRowLite` and `ASSET_AUTH_NOT_FOUND`. Type imports: `AssetAdminState` and `AdminHistoryEntry` from `@bsv/overlay-topics`. Then `git rm src/assetAuth.ts src/assetAuth.test.ts`.

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(overlay): v3 token routes — authorities, asset state, history page, delta summary (§6.5)`.

---

### Task 9: Activity feed decodes BRC-162

**Files:**
- Modify: `overlay/src/activity.ts:21,48,88-118,215,234`
- Test: `overlay/src/activity.test.ts`

**Interfaces:**
- Produces: `ActivityEntry.tokenId` (renamed from `assetId`); `FtOutput` → `{ index, tokenId, amount: number, role: 'value' | 'authority' }`; `buildActivity(deps, { tokenId?, limit?, before? })`.

Rules:
- Decode every output with `Bsv21Binary.decode`, inside try/catch; a non-token output is skipped.
- A deploy (`role === 'deploy'`) gets `tokenId = \`${txid}_0\``. Other roles get `tokenIdToString(decoded.tokenId!)`.
- `amount` is `Number(decoded.amount)`. The overlay caps amounts at 2^53−1 before admission, so it is safe; anything bigger is skipped.
- Value movement (`summarizeTx`) counts only `role === 'value'` outputs and inputs. Authority and deploy outputs never count as transfers.
- Apply the same decode to inputs (`:215`).

- [ ] **Step 1: Failing tests**: rewrite the `activity.test.ts` fixtures, building scripts with the real codec:

```ts
import { Bsv21Binary } from '@bsv/templates'
const codec = new Bsv21Binary()
const PKH = new Array(20).fill(7)
const TID = 'ab'.repeat(32) + '_0'
const valueScript = (amt: bigint) => codec.lock(TID, amt, PKH)
const authorityScript = () => codec.lock(TID, 0n, PKH)
const deployScript = () => codec.lock(null, 0n, PKH)
```
Port every existing case: same classification expectations, `assetId: 'a.0'` → `tokenId: TID`. Add:
- an authority output is not a value movement;
- a deploy output is labelled with the tx's own `_0` id;
- a non-token and a malformed token-shaped script are skipped without a throw;
- a filter by `tokenId` returns only matching entries.

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(overlay): activity feed decodes BRC-162 outputs, keyed by tokenId`.

---

### Task 10: Rewire `index.ts`; build and full suite green

**Files:**
- Modify: `overlay/src/index.ts` (boot wiring and routes), `overlay/src/adminAuth.ts` (comment/warn text `asset-auth*` → `authorities*`; check `adminAuth.test.ts` for asserted text first)
- Test: `overlay/src/indexWiring.test.ts` (rewrite), `overlay/src/wrapperStack.test.ts` (rewrite)

**Interfaces:**
- Consumes: everything from Tasks 2–9, plus the package `MandalaStorageManager`, `MandalaTopicManager`, `createMandalaLookupService`, `RegistryStorage`, `RegistryTopicManager`, `createRegistryLookupService`, `registryMembership`, `InMemoryScreeningProvider`, `reconcileOwnerIndex`, `MANDALA_TOPIC`, `REGISTRY_TOPIC` and `REGISTRY_LOOKUP`.

- [ ] **Step 1: Rewrite `indexWiring.test.ts`** (source-text assertions over `index.ts`, in the file's existing style). Keep the generic cases: boot index safety (§9.9), `readBootConfig`-only env reads (`ADMIN_CORS_ORIGINS` the only direct read), no `markUTXOAsSpent =`, `putPending` on the token manager only, and the registry wrapped in capture without persistence. Replace the format-specific ones with:

```ts
it('builds one MandalaStorageManager and shares it with the manager, the registry and the lookup', () => {
  expect(src.match(/new MandalaStorageManager\(/g)).toHaveLength(1)
  expect(src).toMatch(/stateStore: storage/)
  expect(src).toMatch(/createMandalaLookupService\(mandalaWallet, storage\)/)
  expect(src).toMatch(/createRegistryLookupService\(registryStorage, storage\)/)
})
it('passes the trusted-issuer set and the engine output reader to both managers', () => {
  expect(src.match(/trustedIssuers: cfg\.issuerKeys/g)).toHaveLength(2)
  expect(src.match(/engineOutputs/g)!.length).toBeGreaterThanOrEqual(3)
})
it('tm_mandala stack: capture → persisted verdict → spent guard → package manager (nothing between)', () => {
  expect(src).toMatch(/withVerdictCapture\(\s*withPersistedVerdict\(\s*withSpentInputGuard\(\s*new MandalaTopicManager\(/)
})
it('quiesces /submit and runs maintenance before start', () => {
  expect(src).toMatch(/app\.post\('\/submit', gateSubmits\(gate\)/)
  const boot = src.indexOf('await ownerIndex.runOnce()'), start = src.indexOf('await server.start()')
  expect(boot).toBeGreaterThan(0); expect(boot).toBeLessThan(start)
  expect(src).toMatch(/registerHealthCheck\(ownerIndex\.healthCheck\(\)\)/)
  expect(src).toMatch(/ownerIndex\.start\(OWNER_INDEX_INTERVAL_MS\)/)
})
it('drops every 1.x wrapper and the substring table', () => {
  for (const gone of ['withUnlinkedTokenReject', 'withAdminChainAnchor', 'withFeeRateFold', 'replayAssetState', 'classifyManagerReason', 'registryScreening', 'asset-auth', 'assetId'])
    expect(src).not.toContain(gone)
})
it('mounts the v3 routes, beef before :tokenId', () => {
  const beef = src.indexOf("'/admin/authorities/beef/:txid'"), id = src.indexOf("'/admin/authorities/:tokenId'")
  expect(beef).toBeGreaterThan(0); expect(beef).toBeLessThan(id)
  for (const r of ["'/admin/asset-state/:tokenId'", "'/admin/admin-history/:tokenId'", "'/admin/admin-history-page/:tokenId'", "'/admin/admin-summary/:tokenId'", "'/admin/registry'", "'/admin/registry/beef/:txid'"])
    expect(src).toContain(r)
})
```
Delete the case at `:386` that used `classifyManagerReason`.

- [ ] **Step 2: Rewrite `wrapperStack.test.ts`** around the real 2.0.0 manager. Use the same `ProtoWallet` / `revealSpecificKeyLinkage` / `Bsv21Binary` fixture pattern as ts-stack `packages/overlays/topics/src/mandala/__tests/MandalaTopicManager.test.ts:43-140` (`linkedLock`, `funding`, `txSpending`), copied into a new `src/testkit/brc162.ts` so Task 11 reuses it. Pin these cases:
- (a) an unlinked token output is refused with the package's reason (`Reasons.noLinkage(0)` text) and code `ERR_LINKAGE`, captured on the side channel with `code`;
- (b) an input already spent by another tx is refused `ERR_INPUT_SPENT` by the spent guard **before** the package runs (assert the inner manager spy is not called);
- (c) a persisted final verdict replays without calling inner.

The storage is a real `MandalaStorageManager` on `connectTestMongo('wrapper')`; skip the file when Mongo is unreachable, the same pattern as `restoreSnapshot.test.ts`.

- [ ] **Step 3: Run both, expect FAIL**: `npx vitest run src/indexWiring.test.ts src/wrapperStack.test.ts`

- [ ] **Step 4: Rewrite the `index.ts` wiring.** Keep the existing order and everything this list does not change (boot config, admin gate, Arcade/Chaintracks, knex/mongo, admission store, applied proof, side channel, advertiser clear, Arcade parity, `/admin/admission`, `/admin/activity`, shutdown).

```ts
import {
  MandalaTopicManager, MandalaStorageManager, createMandalaLookupService, MANDALA_TOPIC,
  RegistryStorage, RegistryTopicManager, createRegistryLookupService, registryMembership,
  REGISTRY_TOPIC, REGISTRY_LOOKUP, InMemoryScreeningProvider, reconcileOwnerIndex
} from '@bsv/overlay-topics'
import { knexEngineOutputs } from './engineOutputs.js'
import { MaintenanceGate, gateSubmits } from './maintenanceGate.js'
import { OwnerIndexMaintenance, OWNER_INDEX_INTERVAL_MS } from './ownerIndex.js'
import { journalRestoreInput } from './eviction.js'
import * as routes from './tokenRoutes.js'
```
Wiring, replacing index.ts `:100-105`, `:162-204`, `:244-282` and `:315-546`:

```ts
  const lookupDb = server.mongoDb!
  const storage = new MandalaStorageManager(lookupDb)      // ONE instance: manager, registry, lookup, routes
  const registryStorage = new RegistryStorage(lookupDb)
  const mandalaWallet = new ProtoWallet(PrivateKey.fromHex(cfg.serverPrivateKey))
  const engineOutputs = knexEngineOutputs(server.knex!)
  const gate = new MaintenanceGate()
  const overlayIdentityKey = PrivateKey.fromHex(cfg.serverPrivateKey).toPublicKey().toString()

  // ... admissionsCol / admissionStore / appliedProof / submitChannel unchanged ...

  server.app.use(normalizeDoubleSlash)
  server.app.post('/submit', gateSubmits(gate), wrapSubmitJson({ priv: overlayPriv, store: admissionStore, applied: appliedProof, channel: submitChannel }) as any)

  const spentInputStore = knexSpentInputStore(server.knex!, TOKEN_TOPIC, /* unchanged wasEvicted */)
  server.configureTopicManager(TOKEN_TOPIC, withVerdictCapture(
    withPersistedVerdict(
      withSpentInputGuard(
        new MandalaTopicManager({
          verifierWallet: mandalaWallet,
          trustedIssuers: cfg.issuerKeys,
          stateStore: storage,
          engineOutputs,
          screeningProvider: new InMemoryScreeningProvider([]),
          membership: registryMembership(registryStorage),
          membershipExempt: [overlayIdentityKey]
        }) as any,
        spentInputStore),
      admissionStore),
    { channel: submitChannel, putPending: async rec => { await admissionStore.putPending?.(rec) }, snapshotRestore }))

  let mandalaLookup: ReturnType<ReturnType<typeof createMandalaLookupService>> | undefined
  server.configureLookupServiceWithMongo('ls_mandala', db => (mandalaLookup = createMandalaLookupService(mandalaWallet, storage)(db)))

  server.configureTopicManager(REGISTRY_TOPIC, withVerdictCapture(new RegistryTopicManager({
    verifierWallet: mandalaWallet, trustedIssuers: cfg.issuerKeys, stateStore: storage, engineOutputs, registry: registryStorage
  }) as any, { channel: submitChannel, topic: REGISTRY_TOPIC }))
  server.configureLookupServiceWithMongo(REGISTRY_LOOKUP, db => createRegistryLookupService(registryStorage, storage)(db))
```
Before writing these calls:
- check `RegistryTopicManager`'s exact ctor shape and whether `createRegistryLookupService` needs `configureLookupServiceWithMongo` or `configureLookupService`;
- confirm `TOKEN_TOPIC === MANDALA_TOPIC` (`'tm_mandala'`), and use one name.

After `await configureEngine(false)`:
- If `mandalaLookup` is undefined, throw `new Error('ls_mandala lookup was not constructed')` so boot fails loudly.
- Then:

```ts
  const ownerIndex = new OwnerIndexMaintenance({
    gate,
    lookup: mandalaLookup,
    reconcile: async topic => await reconcileOwnerIndex({ storage, engine: engineOutputs, topic }),
    topics: [TOKEN_TOPIC, REGISTRY_TOPIC],
    log
  })
  server.registerHealthCheck(ownerIndex.healthCheck())
```
Mount `/arc-ingest` with the new eviction deps:
```ts
      restoreInput: journalRestoreInput((t, v, topic) => storage.getOwnerJournal(t, v, topic), j => mandalaLookup!.restoreInputRow(j), TOKEN_TOPIC),
      purgeAndRefold: txid => mandalaLookup!.purgeAndRefold(txid),
      quiesce: fn => gate.exclusive(fn),
```
Drop `restoreTokenRow`, `assetsTouchedBy`, `rebuildAssetStateExcluding` and `purgeAdminHistory`.

Routes, each a thin adapter `async (req, res) => { const r = await routes.X(...); res.status(r.status).json(r.body) }` behind the same gates and ACAO as their v2 counterparts:
- `GET /admin/asset-state/:tokenId` → `assetStateResponse(req.params.tokenId, { getAssetState: id => storage.getAssetState(id), hasTokenRow: async (t, v) => (await storage.getTokenRow(t, v)) != null })`
- `GET /admin/authorities/beef/:txid` (registered first) → `authoritiesBeefResponse(req.params.txid, req.query.vout, { findBeef: /* the old asset-auth KnexStorage.findOutput(txid, vout, TOKEN_TOPIC, undefined, true) adapter, unchanged */ })`
- `GET /admin/authorities/:tokenId` → `authoritiesResponse(req.params.tokenId, { listAuthorities: id => storage.listAuthorities(TOKEN_TOPIC, id) })`
- `GET /admin/admin-history/:tokenId` → `storage.findAdminHistory(id)` (validate with `routes.tokenIdParam`, 400 on null)
- `GET /admin/admin-history-page/:tokenId` → `adminHistoryPageResponse(..., { page: (id, limit, offset) => lookupDb.collection('mandalaAdminHistory').find({ tokenId: id }, { projection: { _id: 0 } }).sort({ admitSeq: -1 }).skip(offset).limit(limit).toArray() as any })`
- `GET /admin/admin-summary/:tokenId` → `adminSummaryResponse(..., { history: id => storage.findAdminHistory(id) })`
- `GET /admin/registry` (adminGate) → `registryStorage.list()`; `GET /admin/registry/beef/:txid` unchanged except the topic constant import.
- `GET /admin/activity`: pass `tokenId: req.query.tokenId`.
- Delete the `linkageCol`/`adminHistoryCol` `createIndex` block (`:452-456`); the package owns its indexes. Keep `linkageCol` only if `buildActivity` still reads it.

Boot tail:
```ts
  await ownerIndex.runOnce()           // boot refold + reconcile, before the first submit is accepted
  ownerIndex.start(OWNER_INDEX_INTERVAL_MS)
  await server.start()
```
Shutdown: change the `close` hook to `async () => { ownerIndex?.stop(); await overlay?.close() }`. Hoist `let ownerIndex: OwnerIndexMaintenance | undefined` next to `let overlay`.

Snapshot: pass `snapshotRestore` (the Task 7 export) instead of `snapshotRestoreFrom(...)`.

- [ ] **Step 5: Build and run the full suite**

```bash
cd /Users/personal/git/demos/mandala/overlay && npm run build && npm test
```
Expected: `tsc` exits 0 and every test passes. The Mongo-backed files run, since local Mongo `local-mongo-1` is up on :27017. Run in the background and wait for the notification. Fix only within this plan's files. If an unrelated pre-existing test fails, report it rather than editing around it.

- [ ] **Step 6: Commit** `feat(overlay): wire overlay-topics 2.0.0 — trusted issuers, engine reader, owner-index maintenance, v3 routes`.

---

### Task 11: End-to-end on the real engine: BRC-162 deploy → issue → transfer, plus refusals

**Files:**
- Create: `overlay/src/brc162Flow.test.ts`
- Modify: `overlay/src/testkit/brc162.ts` (from Task 10), `overlay/src/testkit/engineHarness.ts` (only if needed: an option to register named managers instead of `tm_harness`)

**Interfaces:**
- Consumes: the Task 10 wiring pieces (`MandalaTopicManager`, `MandalaStorageManager`, `createMandalaLookupService`, `knexEngineOutputs`, `withSpentInputGuard`, `withVerdictCapture`, `SubmitSideChannel`), on a real `Engine` with in-memory sqlite and a throwaway Mongo db.

This is the P2 proof that the overlay admits the new format. The lib and the wallet cannot produce these transactions until P4/P6.

- [ ] **Step 1: Fixture helpers in `testkit/brc162.ts`**

- `deployTx(issuer)`: a single token output at vout 0, `codec.lock(null, 0n, pkh, encodeStrictCbor({sym:'USD',dec:2,label:'US Dollar'}))`, locked to the issuer itself (`counterparty` = the issuer's identity key, §5.1a). The deploy (amount 0) **is** the token's first authority (pinned spec, "Authority supply" and the role table row "Deploy (authority)"). Its token id is `${deployTxid}_0`. The next admin tx spends vout 0 as its authority input.
- `deploySig(issuer, txid)`: `issuer.createSignature({ data: deployDigest(txid), protocolID: [2, 'mandala deploy'], keyID: '1', counterparty: 'anyone' })`, DER hex.
- `issueTx(authoritySpend, amount, recipientKey)`: the authority input; an authority output whose payload is `encodeStrictCbor({ adm: sha256(details) })` where `details = encodeAdminDetails({ kind: 'issue' })`; a value output `amount` to the recipient; envelope `admin: [{ index: <authority vout>, details: hex(details) }]`.
- `transferTx(valueSpend, to)`: I == O.
- Signing: real P2PKH unlocks of the derived child keys (`new KeyDeriver(priv).derivePrivateKey(FT, keyID, counterparty)` with `new Bsv21Binary().unlock(childPriv)`), so the engine's script verification passes. Every chain is rooted in the harness `root` (it has a merkle path).
- Submit with the off-chain envelope: `engine.submit({ beef, topics: ['tm_mandala'], offChainValues: encodeEnvelope(env) }, ...)`.

- [ ] **Step 2: Write the flow tests** (skip when Mongo is unreachable)

```ts
it('deploy → issue 1000 → transfer 400/600: admitted, rows indexed, journal written', async () => { /* assert outputsToAdmit per step; storage.findTokensByTokenId(tid) amounts [400,600]; storage.listAuthorities('tm_mandala', tid).length === 1; mandalaOwners has a row per admitted output; findAdminHistory(tid) has one 'issue' with delta 1000 */ })
it('untrusted deploy → ERR_UNTRUSTED, nothing admitted, nothing journaled', async () => { /* issuer not in trustedIssuers */ })
it('deploy without deploySig → ERR_AUTHORITY', async () => {})
it('holder implicit burn (I > O) → ERR_CONSERVATION', async () => {})
it('missing owner row is repaired inline and the spend is admitted (§4.2a rule 3)', async () => { /* after issue, delete the value row from mandalaTokens, then transfer → admitted; row present again */ })
it('reconciler restores a deleted row; an orphan output with no journal is reported unrepairable', async () => { /* reconcileOwnerIndex over knexEngineOutputs */ })
```
Each test asserts the side-channel `code` and that the package's `reason` matches `Reasons.<x>(...)` (import `Reasons`), not a hand-typed string. Write every body in full; the comments above give the assertions.

- [ ] **Step 3: Run until PASS**: `npx vitest run src/brc162Flow.test.ts`. A failure here is a real integration fault (between the package and the host, or in the fixture). Diagnose with superpowers:systematic-debugging. Never weaken an assertion to pass.
- [ ] **Step 4: Full suite again**: `npm run build && npm test`.
- [ ] **Step 5: Commit** `test(overlay): BRC-162 deploy/issue/transfer and refusals on the real engine`.

---

### Task 12: Live boot on a fresh database; runbook

**Files:**
- Modify: `runbook.md` (Local services: P2 overlay on a fresh node name; the `MANDALA_ISSUER_KEYS` env)
- Not committed: `overlay/.env` (gitignored)

- [ ] **Step 1: Do not disturb the old overlay's state.** Check what is on :8080: `lsof -nP -iTCP:8080 -sTCP:LISTEN`. If an old overlay is running, ask the user before stopping it.
- [ ] **Step 2: Fresh env.** In `overlay/.env`:
  - set `NODE_NAME=mandala162` and `SQLITE_FILE=/tmp/mandala162-overlay.sqlite`;
  - add `MANDALA_ISSUER_KEYS` with the issuer identity key the user will test with. **Ask the user for it.** `npm run gen-key` prints a fresh keypair if they want a throwaway, but the wallet's identity key is what P4/P6 testing needs;
  - leave `ARCADE_CALLBACK_TOKEN` / `ARCADE_URL` as the user set them. If boot refuses for the callback token (runbook), ask the user rather than inventing a token.

  Never echo `.env` contents; show names only (`cut -d= -f1`).
- [ ] **Step 3: Boot** with `preview_start` `mandala-overlay` (`.claude/launch.json`). Note that config hard-codes `MONGO_URL=mongodb://localhost:27017/mandala SQLITE_FILE=/tmp/mandala-overlay.sqlite`, which overrides `.env`. Edit the launch entry's `SQLITE_FILE` to `/tmp/mandala162-overlay.sqlite` first; the Mongo db name follows `NODE_NAME`. Expected log: `owner index tm_mandala: scanned 0, repaired 0, unrepairable 0`, then the listen line.
- [ ] **Step 4: Smoke**

```bash
curl -s localhost:8080/health/ready ; echo
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/admin/authorities/$(printf 'ab%.0s' {1..32}).0
curl -s localhost:8080/admin/authorities/$(printf 'ab%.0s' {1..32})_0 ; echo
```
Expected:
- readiness includes `mandala-owner-index` `ok`. Find the real readiness path in overlay-express 2.7.3's `configureHealth` docs first, since `/health/ready` is a guess;
- `400` for the old-format id;
- `{"tokenId":"abab…_0","authorities":[]}`.
- [ ] **Step 5: Runbook.** Update the Local services row for the overlay (fresh `mandala162` node, `MANDALA_ISSUER_KEYS` required, P2 build), and add a line: the old-format state in `mandala_lookup_services` / `/tmp/mandala-overlay.sqlite` is untouched and obsolete.
- [ ] **Step 6: Commit** `docs(runbook): P2 overlay on a fresh node name; MANDALA_ISSUER_KEYS`.

---

## Out of scope (later phases, do not start)

- Go overlay (P3), lib (P4), app (P5), wallet (P6), wire contract v3 doc (P7).
- `infra/overlay-server` wiring (P1b, after publish).
- Swapping the tarballs for npm versions (after the maintainer publishes).
- Registry-topic eviction (unchanged from today: `/arc-ingest` restores tm_mandala inputs only).
- `height` on `/admin/authorities` entries (optional in §6.5).

# 1Color T1: `@bsv/templates` 2.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan will be executed subagent-driven: one fresh implementer per task, one fresh reviewer per task, then a whole-branch review.

**Goal:** Add a BRC-162 1Color attribute reader (`dec`/`sym`/`icon`/`req`/`ext`), `req` equality, an `OP_0 OP_DROP`-aware encoder and preferred 36-byte-aware id exports to `@bsv/templates`, released in source as 2.2.0. It also drafts, as text only, the design I1 `Bsv21Token` issue and the §3 BRC spec feedback (Task 10). Nothing is published, posted or filed.

**Architecture:** One new pure module `src/OneColorAttributes.ts` sits on top of the existing strict DAG-CBOR decoder (`tryDecodeStrictCbor`) and the existing prefix splitter (`splitPayload`). `OneColor` gains a static `lockRemainder`. `mod.ts` re-exports these additively. No existing file's behaviour changes. `Bsv21Token.ts`, `Bsv21Binary.ts`, `strictCbor.ts` and `mandala-encoding.ts` are not modified. The last three are mutation-test targets (score ≥ 92), so all new logic lives in files outside the `mutate:` list.

**Tech Stack:** TypeScript (TS 6 via `typescript6`), Jest 30 + ts-jest, oxlint, prettier, pnpm 10.33.2 workspaces, Node ≥ 24.11, `@bsv/sdk` workspace (4.0.0).

**Spec:** `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (§4.1 T1). The shared interface contract is authoritative for names and types: `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/plans/2026-10-22-1color-00-interfaces.md` §1 (T1) and §9-§10 (vendoring V1). Pinned specs: **0162** = `docs/design/brc-0162-1color.pinned.md`, **0207** = `docs/design/brc-0207-1color-wallet-module.pinned.md` (both under the mandala worktree).

Paths below are relative to `/Users/personal/git/ts-stack-wt/1color` unless absolute. `PKG` = `packages/helpers/ts-templates`. **Every shell step starts with** `export R=/Users/personal/git/ts-stack-wt/1color PKG=/Users/personal/git/ts-stack-wt/1color/packages/helpers/ts-templates && cd "$R"` ("Run (root)" means `cd "$R"`), because agent shells reset their cwd between calls.

## Global Constraints

- **`PKG/src/Bsv21Token.ts` is never modified, reformatted or staged** (user rule; design §3). Every commit step runs the guard: `git diff --cached --name-only | grep -F 'Bsv21Token.ts' && { echo 'ABORT: Bsv21Token.ts staged'; exit 1; } || true`.
- Work only in the worktree `/Users/personal/git/ts-stack-wt/1color`, branch `feat/1color-profiles`. Never touch `/Users/personal/git/ts-stack`. Do not push, tag, publish to npm or open a PR (a later stage opens draft PRs).
- Additive only: every existing export, signature, error message and encoded byte stays unchanged (contract §1; ts-stack AGENTS.md "Preserve contracts first"). `PKG/test/vectors/brc162.json` must not change.
- Do not modify `PKG/src/strictCbor.ts`, `PKG/src/Bsv21Binary.ts` or `PKG/src/mandala-encoding.ts` (mutation targets in `governance/mutation-testing/targets.mjs:332-341`). Import their existing exports instead.
- No new runtime dependency. The package stays `sideEffects: false`, ESM + CJS, browser-safe (no `node:` imports, no `Buffer` in `src/`).
- Names and types come verbatim from contract §1: `isProfileId`, `OneColorProfileDescriptor`, `OneColorField<T>`, `OneColorAttributes`, `readOneColorAttributes`, `reqMatchesDeploy`, `needsEmptyPayloadMarker`, `OneColor.lockRemainder`, `oneColorTokenIdFromString`, `oneColorTokenIdToString`.
- Profile id rule (0162:178-181): ASCII, 1..200 bytes, `^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$`. Descriptor (0162:181-183): exactly `{params, version}`, `version` a CBOR uint `1..4294967295`, `params` any value including `null`.
- `dec` is a CBOR **unsigned integer** 0..18 (0162:246-252). `icon` is exactly `[text, bytes]`, and any other shape is malformed (0162:240). A malformed reserved field in a valid map is reported, never treated as absent (0207:88-93). The reader never recovers partial data from an invalid payload (0207:82-87).
- `req` equality is by canonical DAG-CBOR bytes, and an absent deploy map counts as empty `a0` (0162:188-191).
- Encoder rule 0162:101/105: when the remainder starts with `<push> OP_DROP` and no payload is intended, write `OP_0 OP_DROP`. A push is `OP_0`, `OP_1NEGATE`, `OP_1`-`OP_16` or any data push.
- Commits: conventional commits `feat(templates): …` / `chore(templates): …`, ending with the session's `Co-Authored-By` trailer. Commit only on `feat/1color-profiles`.
- Per-task gate (run from `PKG`): `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all clean. Fix formatting with `pnpm --workspace-root exec prettier --write <files>`.
- Stability mandate (user rule): every new function is pure and total. The reader never throws on any input. There is no state, cache or I/O, so crash, double-submit, multi-tab and stale-cache cases reduce to "same input ⇒ same output". Task tests pin determinism where it matters (exact byte spans).

## Review Focus

1. **Float-encoded integers.** `dec` written as float64 `2.0` (`fb4000000000000000`) or a descriptor `version` written as float64 `1.0` is **malformed**, never coerced to an integer. The boundaries are `version` `4294967295` valid, `4294967296` and `0` malformed. Pinned in Task 3 (RF1-dec) and Task 4 (RF1-version).
2. **Integral float inside `req.params`.** `reqBytes` is the exact wire span of the `req` value, not `encodeStrictCbor(map.req)`, because the TS encoder folds integral floats into integers. A deploy with `params: 1.0` and a later output with `params: 1` must **not** match. Pinned in Task 4 (RF2-span) and Task 5 (RF2-match).
3. **Hostile or garbage reader input.** Byte arrays with entries outside 0..255, a strictly valid CBOR non-map (array), trailing bytes, duplicate or unsorted keys, and runtime non-array values give `payload: 'opaque'` with every field absent, and the reader never throws. Pinned in Task 3 (RF3).
4. **Remainders whose first push is not a plain data push.** `OP_0`, `OP_1NEGATE`, `OP_1`..`OP_16` and a non-minimal `OP_PUSHDATA1` followed by `OP_DROP` all need the marker. `lockRemainder` writes it, and `OneColor.decode` returns `payload: []` with the remainder's bytes intact. Pinned in Task 6 (RF4).
5. **Malformed deploy `req` (fixture M, A.147).** `reqMatchesDeploy` returns `false` for every later output, including one with no `req`, which fails closed. Pinned in Task 5 (RF5).

---

### Task 0: Executor preflight note (BotBoard, no code)

Read-only. The executor reads this note before Task 1. Nothing is committed.

- [ ] **Step 1: BotBoard (ts-stack `AGENTS.md` "Maintainer BotBoard and Lockfile protocol").** This is maintainer-authorized ts-stack work for **`sirdeggen`**, so the BotBoard protocol applies. Invoke the `botboard` skill. Use the `gh` CLI (the GitHub MCP server failed to connect this session) and verify `gh api graphql -f query='query{viewer{login}}'` returns `sirdeggen`. Read every open BotBoard thread and its Lockfile, following every pagination cursor. Look for a live handle whose scope overlaps `packages/helpers/ts-templates`, `governance/package-release-notes.json`, `governance/repository-health/baselines.json`, `docs/packages/helpers/templates.md`, `docs/reference/stack-facts.md` or `docs/reference/package-api-migrations.md`.
  - Overlap found ⇒ stop and report it (do not message peers; the user is unavailable).
  - **Never open a BotBoard handle in this plan.** Opening one is a public post on the user's behalf, which is not authorized overnight (same rule as plan 02). Reading open threads is read-only and allowed. Record `BotBoard handle: NOT OPENED (required before push/PR)` in the task report. Local commits on the unpushed worktree branch proceed. The later draft-PR stage opens the handle (title `[BotBoard][active] sirdeggen / <agent> — 1Color templates 2.2.0`, the scope above, `branch: "feat/1color-profiles"`) before any push.
- [ ] **Step 2: Confirm the guard rails.** `git -C /Users/personal/git/ts-stack-wt/1color branch --show-current` prints `feat/1color-profiles`. Record `git -C … hash-object packages/helpers/ts-templates/src/Bsv21Token.ts` and `… hash-object packages/helpers/ts-templates/test/vectors/brc162.json`. Task 8 re-checks that both are unchanged.

---

### Task 1: Baseline

**Files:** none modified.

**Interfaces:** Produces the recorded baseline counts that later tasks compare against.

- [ ] **Step 1: Check the tree state**

Run: `cd /Users/personal/git/ts-stack-wt/1color && git status --porcelain && git log --oneline -1`
Expected: empty status and HEAD `cbdccfe5b` (or a later orchestrator commit; record it). If `node_modules` is missing, run `pnpm install --frozen-lockfile`. If `packages/sdk/dist` is missing, run `pnpm --filter @bsv/sdk build`.

- [ ] **Step 2: Run the package suites**

Run: `cd packages/helpers/ts-templates && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected (measured 2026-10-22 at cbdccfe): `Test Suites: 16 passed, 16 total`, `Tests: 668 passed, 668 total`, typecheck/lint silent, `All matched files use Prettier code style!`

- [ ] **Step 3: Run the repo-level checks this plan touches**

Run (repo root, each separately, recording its exit status): `pnpm docs:packages:check`, `pnpm check-versions`, `pnpm docs:facts:check`, `pnpm health:check`, `pnpm lint`, `pnpm format:check`, `pnpm --filter @bsv/templates build && pnpm -r --filter "...@bsv/templates" run typecheck`, `pnpm --filter @bsv/color-permission-module test 2>&1 | tail -5`
Expected (measured): `Verified docs/reference/package-api-migrations.md for 35 packages` and `All cross-package version references up to date.` The others were not measured at authoring time: record each exit status and the color-module pass/fail counts as found. Task 8 reruns all of them, and only a change from this baseline counts as a regression. Pre-existing failures are recorded, not fixed.

- [ ] **Step 4: Record**

Write the counts and the Task 0 hashes into the task report (not a file in the repo). No commit.

---

### Task 2: `isProfileId` and the module skeleton

**Files:**
- Create: `PKG/src/OneColorAttributes.ts`
- Test: `PKG/src/__tests/OneColorAttributes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (exported from `src/OneColorAttributes.ts`, exact contract §1 shapes):
  - `export function isProfileId (id: string): boolean`
  - `export interface OneColorProfileDescriptor { version: number; params: StrictCborValue }`
  - `export type OneColorField<T> = { status: 'absent' } | { status: 'valid', value: T } | { status: 'malformed', reason: string }`
  - `export interface OneColorAttributes { payload: 'absent' | 'empty' | 'opaque' | 'map'; dec: OneColorField<number>; sym: OneColorField<string>; icon: OneColorField<{ mediaType: string, bytes: Uint8Array }>; req: OneColorField<ReadonlyMap<string, OneColorProfileDescriptor>>; ext: OneColorField<ReadonlyMap<string, StrictCborValue>>; reqBytes?: Uint8Array; map?: StrictCborMap }` (types from `./strictCbor.js`)

- [ ] **Step 1: Write the failing test** (`describe('isProfileId')`)

```ts
const ATTESTED = 'https://brc.dev/207/attested'
const MANDALA = 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md'
it.each([ATTESTED, MANDALA, 'urn:example:color:revision', 'urn:example:color:unknown', 'a:b', 'a+b.c-d:x', 'a:' + 'x'.repeat(198)])(
  'accepts %s', id => expect(isProfileId(id)).toBe(true))
it.each(['', 'a:' + 'x'.repeat(199) /* 201 bytes */, 'Https://x', '1a:b', ':b', 'ab', 'a:', 'a:b c', 'a:b\x7f', 'a:bé', 'a:b\n', 'a:\tb'])(
  'rejects %j', id => expect(isProfileId(id)).toBe(false))
it('rejects non-strings at runtime', () => {
  for (const v of [undefined, null, 42, ['a:b']]) expect(isProfileId(v as never)).toBe(false)
})
expect(MANDALA.length).toBe(80) // contract §4
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts`
Expected: FAIL with `Cannot find module '../OneColorAttributes.js'`.

- [ ] **Step 3: Implement**

In `src/OneColorAttributes.ts`, declare the types above and `isProfileId`: `typeof id === 'string' && id.length <= 200 && /^[a-z][a-z0-9+.-]*:[\x21-\x7e]+$/.test(id)`. The regex admits only ASCII, so `length` equals the byte count. File header comment: BRC-162 1Color attribute reader, citing 0162:171-191 and 0207:82-93.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS, the other commands clean.

- [ ] **Step 5: Commit**

```bash
git add $PKG/src/OneColorAttributes.ts $PKG/src/__tests/OneColorAttributes.test.ts
# guard (Global Constraints), then:
git commit -m "feat(templates): add isProfileId for BRC-162 processing-profile identifiers"
```

---

### Task 3: `readOneColorAttributes`: payload classification, `dec`, `sym`, `icon`

**Files:**
- Modify: `PKG/src/OneColorAttributes.ts`
- Test: `PKG/src/__tests/OneColorAttributes.test.ts`

**Interfaces:**
- Consumes: `tryDecodeStrictCbor`, `StrictCborMap`, `StrictCborValue`, `StrictCborLink` from `./strictCbor.js`. Types from Task 2.
- Produces: `export function readOneColorAttributes (payload: readonly number[] | Uint8Array | undefined): OneColorAttributes`. This task leaves `req`/`ext` as `{ status: 'absent' }` and `reqBytes` unset. Task 4 fills them in.

- [ ] **Step 1: Write the failing tests** (`describe('readOneColorAttributes: payload and display fields')`)

Build test helpers: `hex(h) = Uint8Array.from(toArray(h.replace(/\s/g, ''), 'hex'))` (`toArray` from `@bsv/sdk/primitives/utils`), `cbor(m) = encodeStrictCbor(m)`, `ABSENT = { status: 'absent' }`, `PKH = Array.from({ length: 20 }, (_, i) => i + 1)`. Imports: `import { LockingScript, OP, P2PKH } from '@bsv/sdk/script'`, `import type { ScriptChunk } from '@bsv/sdk/script'`, `import { toArray, toHex } from '@bsv/sdk/primitives/utils'`, `import { encodeStrictCbor, StrictCborLink } from '../strictCbor.js'`, `import { OneColor } from '../OneColor.js'`. Also add a typed `valid<T>(f: OneColorField<T>): T` that throws unless `f.status === 'valid'`. The snippets below write `(x as any).value` for brevity; implement them with `valid(x)`. The fixture constants are the A.141a deploy scripts at 0207:9376-9383 (U, V, C, D, M, X), copied verbatim as hex. `payloadOf(scriptHex) = OneColor.decode(LockingScript.fromHex(scriptHex)).payload`.

```ts
it('classifies absent, empty and map payloads', () => {
  const absent = readOneColorAttributes(undefined)
  expect(absent).toEqual({ payload: 'absent', dec: ABSENT, sym: ABSENT, icon: ABSENT, req: ABSENT, ext: ABSENT })
  expect(readOneColorAttributes([]).payload).toBe('empty')
  expect(readOneColorAttributes(new Uint8Array(0)).payload).toBe('empty')
  const empty = readOneColorAttributes([0xa0])
  expect(empty.payload).toBe('map'); expect(empty.map).toEqual({}); expect(empty.dec).toEqual(ABSENT)
})
// RF3: hostile input is opaque, never throws, no partial recovery (0207:82-87)
it.each([
  ['uint not map', [0x01]], ['valid CBOR array', [0x80]], ['trailing bytes', [0xa0, 0x00]],
  ['duplicate keys', [...hex('a2 6164 01 6164 02')]], ['unsorted keys', [...hex('a2 6173 01 6164 02')]],
  ['indefinite map', [0xbf, 0xff]], ['entry > 255', [0xa0, 256]], ['negative entry', [-1]], ['fractional entry', [1.5]]
])('%s is opaque', (_, bytes) => {
  const a = readOneColorAttributes(bytes as number[])
  expect(a).toEqual({ payload: 'opaque', dec: ABSENT, sym: ABSENT, icon: ABSENT, req: ABSENT, ext: ABSENT })
})
it('never throws on runtime garbage', () => {
  for (const v of [null, 'a0', 42, {}, [[0xa0]]]) expect(readOneColorAttributes(v as never).payload).toBe('opaque')
})
// dec: uint 0..18 (0162:246-252)
it('reads dec', () => {
  expect(readOneColorAttributes(cbor({ dec: 0n })).dec).toEqual({ status: 'valid', value: 0 })
  expect(readOneColorAttributes(cbor({ dec: 18n })).dec).toEqual({ status: 'valid', value: 18 })
  for (const bad of [19n, -1n, 'two', null, new Uint8Array([2])])
    expect(readOneColorAttributes(cbor({ dec: bad })).dec.status).toBe('malformed')
})
it('RF1-dec: a float64 dec (2.0) is malformed, not coerced', () => {
  expect(readOneColorAttributes(hex('a1 63646563 fb4000000000000000')).dec.status).toBe('malformed')
})
it('reads sym as any text', () => {
  expect(readOneColorAttributes(cbor({ sym: 'TUSD' })).sym).toEqual({ status: 'valid', value: 'TUSD' })
  expect(readOneColorAttributes(cbor({ sym: '' })).sym).toEqual({ status: 'valid', value: '' })
  expect(readOneColorAttributes(cbor({ sym: new Uint8Array([1]) })).sym.status).toBe('malformed')
})
// icon: exactly [text, bytes] (0162:236-240)
it('reads icon', () => {
  const ok = readOneColorAttributes(cbor({ icon: ['image/png', new Uint8Array([0x89, 0x50])] })).icon
  expect(ok).toEqual({ status: 'valid', value: { mediaType: 'image/png', bytes: new Uint8Array([0x89, 0x50]) } })
  for (const bad of [['image/png'], ['image/png', new Uint8Array([1]), 'x'], [new Uint8Array([1]), 'image/png'], ['image/png', 'notbytes'], 'image/png', null])
    expect(readOneColorAttributes(cbor({ icon: bad as never })).icon.status).toBe('malformed')
})
it('fixture D (0207:9366): sym ITEM, advisory keys kept in map', () => {
  const a = readOneColorAttributes(payloadOf(FIXTURE.D))
  expect(a.payload).toBe('map'); expect(a.sym).toEqual({ status: 'valid', value: 'ITEM' })
  expect(Object.keys(a.map!)).toEqual(['ext', 'sym'])
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts -t 'payload and display'`
Expected: FAIL with `readOneColorAttributes is not a function` (or an import error).

- [ ] **Step 3: Implement `readOneColorAttributes` in `src/OneColorAttributes.ts`**

Classification order:
1. `undefined` ⇒ `'absent'`.
2. An array or `Uint8Array` of length 0 ⇒ `'empty'`.
3. Anything else that `tryDecodeStrictCbor` does not accept ⇒ `'opaque'`. This covers non-array input. Wrap the call in `try/catch` so that any thrown error (not only `StrictCborError`) also gives `'opaque'`.
4. Otherwise ⇒ `'map'`, with `map` set to the decoded map.

Field rules in this task:
- `dec`: `typeof v === 'bigint' && 0n <= v && v <= 18n` ⇒ valid as `Number(v)`. Any other present value is malformed. A float decodes as `number`, so it fails the `bigint` test.
- `sym`: `typeof v === 'string'`.
- `icon`: an array of length 2 with `[string, Uint8Array]`.

Read keys with `Object.hasOwn(map, key)`. If typecheck rejects that, use `map[key] !== undefined`: decoded maps have no prototype and CBOR has no `undefined`. Give each malformed field a short `reason`, e.g. `'dec must be an unsigned integer 0..18'`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS, the other commands clean.

- [ ] **Step 5: Commit** (with the guard): `feat(templates): read 1Color payload classification and display attributes`

---

### Task 4: `req`, `ext` and the exact `reqBytes` span

**Files:**
- Modify: `PKG/src/OneColorAttributes.ts`
- Test: `PKG/src/__tests/OneColorAttributes.test.ts`

**Interfaces:**
- Consumes: Task 3 `readOneColorAttributes`, Task 2 `isProfileId`.
- Produces: `readOneColorAttributes(...).req`, `.ext` and `.reqBytes` filled in per contract §1. `reqBytes` is set iff `req.status === 'valid'`.

**Decision (recorded):** `reqBytes` is the exact byte span of the `req` value inside the payload, not `encodeStrictCbor(map.req)`. A payload only reaches `'map'` after `decodeStrictCbor` accepted it, and that decoder rejects every non-canonical encoding, so the span *is* the canonical encoding. Re-encoding loses information because `encodeStrictCbor` folds an integral float (`1.0`) into an integer. A Go reader keeps Float ≠ Int, so a re-encode would make the TS and Go engines disagree.

- [ ] **Step 1: Write the failing tests** (`describe('readOneColorAttributes: req and ext')`)

The F-REQ constants are copied verbatim from contract §4. `REQ_HEX` is the 328-byte `req` value. `FREQ_PAYLOAD = 'a4636465630263726571' + REQ_HEX + '6373796d6454555344656c6162656c6b5465737420446f6c6c6172'` (365 bytes). `K = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'`.

```ts
it('F-REQ: Mandala deploy payload (req in the middle of the map)', () => {
  const a = readOneColorAttributes(hex(FREQ_PAYLOAD))
  expect(a.payload).toBe('map'); expect(a.dec).toEqual({ status: 'valid', value: 2 })
  expect(a.sym).toEqual({ status: 'valid', value: 'TUSD' }); expect(a.map!.label).toBe('Test Dollar')
  expect(a.req.status).toBe('valid')
  const req = (a.req as { value: ReadonlyMap<string, OneColorProfileDescriptor> }).value
  expect([...req.keys()]).toEqual([ATTESTED, MANDALA])
  expect(req.get(ATTESTED)).toEqual({ version: 1, params: { trustMode: 'identity', identityKey: K } })
  expect(req.get(MANDALA)).toEqual({ version: 1, params: { identityKey: K } })
  expect(toHex([...a.reqBytes!])).toBe(REQ_HEX); expect(a.reqBytes!.length).toBe(328)
  expect(a.ext).toEqual(ABSENT)
})
it('A.141a fixtures (req last in the map for C and X)', () => {
  const u = readOneColorAttributes(payloadOf(FIXTURE.U))
  expect([...(u.req as any).value.entries()]).toEqual([['urn:example:color:unknown', { version: 1, params: null }]])
  expect((readOneColorAttributes(payloadOf(FIXTURE.V)).req as any).value.get('urn:example:color:revision').version).toBe(2)
  const c = readOneColorAttributes(payloadOf(FIXTURE.C))
  expect((c.ext as any).value.get('urn:example:color:revision')).toEqual({ revision: 0n })
  expect(toHex([...c.reqBytes!])).toBe('a1781a75726e3a6578616d706c653a636f6c6f723a7265766973696f6ea266706172616d73f66776657273696f6e01')
  const x = readOneColorAttributes(payloadOf(FIXTURE.X))
  expect([...(x.req as any).value.keys()]).toEqual(['urn:example:color:unknown', 'urn:example:color:revision']) // canonical order
})
it('A.147 fixture M: req null is malformed, not absent', () => {
  const m = readOneColorAttributes(payloadOf(FIXTURE.M))
  expect(m.payload).toBe('map'); expect(m.req.status).toBe('malformed'); expect(m.reqBytes).toBeUndefined()
})
it('an empty req map is valid and its bytes are a0', () => {
  const a = readOneColorAttributes(cbor({ req: {} }))
  expect(a.req.status).toBe('valid'); expect([...a.reqBytes!]).toEqual([0xa0])
})
it.each([
  ['descriptor missing params', { 'a:b': { version: 1n } }],
  ['descriptor extra member', { 'a:b': { version: 1n, params: null, x: 1n } }],
  ['descriptor not a map', { 'a:b': [1n, null] }],
  ['version 0', { 'a:b': { version: 0n, params: null } }],
  ['version 2^32', { 'a:b': { version: 4294967296n, params: null } }],
  ['version negative', { 'a:b': { version: -1n, params: null } }],
  ['version text', { 'a:b': { version: '1', params: null } }],
  ['bad profile id', { 'Bad:x': { version: 1n, params: null } }],
])('req malformed: %s', (_, req) => {
  const a = readOneColorAttributes(cbor({ req: req as never }))
  expect(a.req.status).toBe('malformed'); expect(a.reqBytes).toBeUndefined()
})
it('req that is not a map (array, bytes) is malformed', () => {
  for (const req of [[], new Uint8Array([0xa0])]) expect(readOneColorAttributes(cbor({ req: req as never })).req.status).toBe('malformed')
})
it('RF1-version: boundaries and float', () => {
  expect((readOneColorAttributes(cbor({ req: { 'a:b': { version: 4294967295n, params: null } } })).req as any).value.get('a:b').version).toBe(4294967295)
  // version float64 1.0, hand-written (encodeStrictCbor cannot produce it)
  expect(readOneColorAttributes(hex('a1 63726571 a1 63613a62 a2 66706172616d73 f6 6776657273696f6e fb3ff0000000000000')).req.status).toBe('malformed')
})
it('RF2-span: an integral float in params is kept byte-exact', () => {
  const FLOAT_REQ = 'a163613a62a266706172616d73fb3ff00000000000006776657273696f6e01'
  const a = readOneColorAttributes(hex('a163726571' + FLOAT_REQ))
  expect(a.req.status).toBe('valid'); expect(toHex([...a.reqBytes!])).toBe(FLOAT_REQ)
})
it('span is exact through nested arrays, bytes, negative ints and tag-42 links', () => {
  const req = { 'a:b': { version: 1n, params: [new StrictCborLink(new Uint8Array([0, 1, 2])), new Uint8Array([1, 2]), -5n, 'x', true, { k: [null] }] } }
  const a = readOneColorAttributes(cbor({ req, sym: 'S' }))
  expect(toHex([...a.reqBytes!])).toBe(toHex(encodeStrictCbor(req))) // no floats here, so re-encoding is a valid oracle
  expect(a.sym).toEqual({ status: 'valid', value: 'S' })
})
it('ext: map of profile ids to any value', () => {
  expect((readOneColorAttributes(cbor({ ext: { 'a:b': null } })).ext as any).value.get('a:b')).toBeNull()
  for (const ext of [null, [], { nocolon: 1n }]) expect(readOneColorAttributes(cbor({ ext: ext as never })).ext.status).toBe('malformed')
})
it('req/ext malformed does not disturb the display fields', () => {
  const a = readOneColorAttributes(cbor({ req: null, ext: null, sym: 'S', dec: 2n }))
  expect(a.sym.status).toBe('valid'); expect(a.dec.status).toBe('valid')
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts -t 'req and ext'`
Expected: FAIL. `req.status` is `'absent'` where the tests expect `'valid'`/`'malformed'`, and `reqBytes` is undefined.

- [ ] **Step 3: Implement**

Field rules in `src/OneColorAttributes.ts`:
- `req`: the value must be a CBOR map, meaning a non-null object that is not an array, `Uint8Array` or `StrictCborLink`. Every key must pass `isProfileId`. Every value must be a map with exactly the own keys `params` and `version`, where `version` is a `bigint` in `1n..4294967295n` and is converted with `Number()`. Build a `Map` in decoded (canonical) key order.
- `ext`: a map whose keys all pass `isProfileId`. Values are kept as-is.
- `reqBytes`: computed only when `req` is valid, by a private span finder over the same bytes that `tryDecodeStrictCbor` already accepted. Because it only ever sees validated input, it does no validation itself.

Private helpers:

```text
headEnd(b, p) -> [major, arg: bigint, next]   // info<24: arg=info, width 0; info 24/25/26/27: width 1/2/4/8 big-endian
valueEnd(b, p): major 0,1,7 -> next; 2,3 -> next+arg; 4 -> skip arg values; 5 -> skip 2*arg values; 6 -> skip 1 value
topLevelSpan(b, keyUtf8) -> [start, end) | undefined: walk the top-level map's count entries; for each key compare
  the key's text bytes to keyUtf8; on match return [valueStart, valueEnd(b, valueStart)]
```

The key compared is `'req'` (bytes `72 65 71`). `reqBytes = b.slice(start, end)`. Convert `number[]` input with `Uint8Array.from` only after the decode succeeded.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS, the other commands clean.

- [ ] **Step 5: Commit** (with the guard): `feat(templates): read 1Color req and ext with the exact req byte span`

---

### Task 5: `reqMatchesDeploy`

**Files:**
- Modify: `PKG/src/OneColorAttributes.ts`
- Test: `PKG/src/__tests/OneColorAttributes.test.ts`

**Interfaces:**
- Consumes: Task 4 `OneColorAttributes.req` / `.reqBytes`.
- Produces: `export function reqMatchesDeploy (deploy: OneColorAttributes, later: OneColorAttributes): boolean`.

**Decision (recorded, fail closed):**
1. `deploy.req` malformed ⇒ `false`.
2. Otherwise `later.req` absent (any payload kind) ⇒ `true`.
3. Otherwise `later.req` malformed ⇒ `false`.
4. Otherwise compare `later.reqBytes` with the deploy bytes, where the deploy bytes are `deploy.reqBytes`, or `[0xa0]` when `deploy.req` is absent. This also covers a deploy payload that is absent, empty or opaque (0207:85-86).

This is exactly the fixed fail-closed evaluation order in contract §1 (Revision 2), so there is no contract gap left to report.

- [ ] **Step 1: Write the failing tests** (`describe('reqMatchesDeploy')`, `R = readOneColorAttributes`)

```ts
const deploy = R(hex(FREQ_PAYLOAD))
it('later outputs that omit req inherit it (0162:188-190, A.145)', () => {
  for (const later of [R(undefined), R([]), R([0x01]), R(cbor({ sym: 'X' }))]) expect(reqMatchesDeploy(deploy, later)).toBe(true)
})
it('a repeated req must be byte-identical', () => {
  expect(reqMatchesDeploy(deploy, R([...hex('a163726571' + REQ_HEX)]))).toBe(true)
  expect(reqMatchesDeploy(deploy, R(cbor({ req: {} })))).toBe(false)                  // A.146
  const otherKey = { [ATTESTED]: { version: 1n, params: { trustMode: 'identity', identityKey: K.replace(/^02/, '03') } }, [MANDALA]: { version: 1n, params: { identityKey: K } } }
  expect(reqMatchesDeploy(deploy, R(cbor({ req: otherKey })))).toBe(false)
})
it('an absent deploy req is the empty map a0', () => {
  for (const d of [R(cbor({ sym: 'X' })), R(undefined), R([]), R([0x01])]) {
    expect(reqMatchesDeploy(d, R(cbor({ req: {} })))).toBe(true)
    expect(reqMatchesDeploy(d, R(cbor({ req: { 'a:b': { version: 1n, params: null } } })))).toBe(false)
  }
})
it('a malformed later req never matches', () => {
  expect(reqMatchesDeploy(deploy, R(cbor({ req: null })))).toBe(false)
})
it('RF5: a malformed deploy req (fixture M) matches nothing, even an omitted req', () => {
  const m = R(payloadOf(FIXTURE.M))
  for (const later of [R(undefined), R(cbor({ sym: 'X' })), R(cbor({ req: {} })), R(cbor({ req: null }))]) expect(reqMatchesDeploy(m, later)).toBe(false)
})
it('RF2-match: Float 1.0 and Int 1 in params are different requirements', () => {
  const f = R(hex('a163726571 a163613a62a266706172616d73fb3ff00000000000006776657273696f6e01'))
  const i = R(cbor({ req: { 'a:b': { params: 1n, version: 1n } } }))
  expect(reqMatchesDeploy(f, i)).toBe(false); expect(reqMatchesDeploy(i, f)).toBe(false); expect(reqMatchesDeploy(f, f)).toBe(true)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts -t 'reqMatchesDeploy'`
Expected: FAIL with `reqMatchesDeploy is not a function`.

- [ ] **Step 3: Implement** `reqMatchesDeploy` per the decision above, with a private constant-shape byte comparison (length, then each byte).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS.

- [ ] **Step 5: Commit** (with the guard): `feat(templates): compare a repeated 1Color req with the deploy's canonical bytes`

---

### Task 6: `needsEmptyPayloadMarker` and `OneColor.lockRemainder`

**Files:**
- Modify: `PKG/src/OneColorAttributes.ts` (adds `needsEmptyPayloadMarker`)
- Modify: `PKG/src/OneColor.ts` (adds `static lockRemainder` and a module-private `prefixChunks` shared with `lock`)
- Test: `PKG/src/__tests/OneColorAttributes.test.ts`, `PKG/src/__tests/OneColor.test.ts`

**Interfaces:**
- Consumes: `splitPayload`, `payloadChunk`, `encodeAmountChunk` from `./Bsv21Binary.js` (already exported). `OneColor.tokenIdFromString`.
- Produces:
  - `export function needsEmptyPayloadMarker (remainder: readonly ScriptChunk[]): boolean`. It is true iff `splitPayload([...remainder]).payload !== undefined`, which is exactly the 0162:101 "single push followed by `OP_DROP`" detector the decoder uses. This keeps one definition of "push".
  - `static lockRemainder (tokenId: string | null, amount: bigint, remainder: LockingScript, payload?: readonly number[]): LockingScript`. It returns `<id|OP_0> <amount> OP_2DROP`, then `<payload> OP_DROP` when `payload` is given, else `OP_0 OP_DROP` when `needsEmptyPayloadMarker(remainder.chunks)`, else nothing, then the remainder's chunks copied unchanged.

- [ ] **Step 1: Write the failing tests**

In `OneColorAttributes.test.ts`, `describe('needsEmptyPayloadMarker')`:

```ts
const D = { op: OP.OP_DROP }
it.each([
  ['OP_0', [{ op: OP.OP_0 }, D]], ['OP_1NEGATE', [{ op: OP.OP_1NEGATE }, D]], ['OP_1', [{ op: OP.OP_1 }, D]],
  ['OP_16', [{ op: OP.OP_16 }, D]], ['direct push', [{ op: 2, data: [1, 2] }, D]],
  ['non-minimal PUSHDATA1', [{ op: OP.OP_PUSHDATA1, data: [7] }, D, { op: OP.OP_TRUE }]]
])('RF4: %s then OP_DROP needs the marker', (_, chunks) => expect(needsEmptyPayloadMarker(chunks as ScriptChunk[])).toBe(true))
it.each([
  ['empty', []], ['OP_DROP alone', [D]], ['push alone', [{ op: OP.OP_5 }]], ['push then 2DROP', [{ op: OP.OP_5 }, { op: OP.OP_2DROP }]],
  ['OP_DUP then OP_DROP', [{ op: OP.OP_DUP }, D]], ['P2PKH', new P2PKH().lock(PKH).chunks], ['P2PK', [{ op: 33, data: Array(33).fill(2) }, { op: OP.OP_CHECKSIG }]]
])('%s needs no marker', (_, chunks) => expect(needsEmptyPayloadMarker(chunks as ScriptChunk[])).toBe(false))
```

In `OneColor.test.ts`, `describe('OneColor.lockRemainder')` (`TXID`, `PKH` already defined there):

```ts
const pushDrop = new LockingScript([{ op: OP.OP_5 }, { op: OP.OP_DROP }, { op: OP.OP_TRUE }])
it('writes OP_0 OP_DROP before a remainder that starts with <push> OP_DROP (0162:105)', () => {
  const s = OneColor.lockRemainder(`${TXID}_0`, 500n, pushDrop)
  expect(s.toHex().endsWith('6d' + '0075' + '557551')).toBe(true)
  const d = OneColor.decode(s)
  expect(d.payload).toEqual([]); expect(d.amount).toBe(500n); expect(d.role).toBe('value')
  expect(new LockingScript(d.restChunks).toHex()).toBe(pushDrop.toHex())
})
it('RF4: keeps a non-minimal remainder byte-exact', () => {
  const r = LockingScript.fromHex('4c01077551') // OP_PUSHDATA1 0x07, OP_DROP, OP_1
  const s = OneColor.lockRemainder(null, 0n, r)
  expect(s.toHex()).toBe('00' + '00' + '6d' + '0075' + '4c01077551')
  expect(new LockingScript(OneColor.decode(s).restChunks).toHex()).toBe('4c01077551')
})
it('equals lock() for a P2PKH remainder (no marker)', () => {
  for (const [id, amt, payload] of [[`${TXID}_0`, 500n, undefined], [null, 7n, [1, 2]], [`${TXID}_258`, 0n, undefined]] as const)
    expect(OneColor.lockRemainder(id, amt, new P2PKH().lock(PKH), payload as never).toHex()).toBe(new OneColor().lock(id, amt, PKH, payload as never).toHex())
})
it('an explicit payload replaces the marker; an explicit [] writes OP_0 OP_DROP', () => {
  const d = OneColor.decode(OneColor.lockRemainder(`${TXID}_0`, 9n, pushDrop, [1, 2]))
  expect(d.payload).toEqual([1, 2]); expect(new LockingScript(d.restChunks).toHex()).toBe(pushDrop.toHex())
  expect(OneColor.lockRemainder(`${TXID}_0`, 9n, new P2PKH().lock(PKH), []).toHex()).toContain('6d0075')
})
it('validates id and amount like lock()', () => {
  expect(() => OneColor.lockRemainder(`${TXID}_0`, 1n << 64n, pushDrop)).toThrow(Bsv21BinaryError)
  expect(() => OneColor.lockRemainder('x_0', 1n, pushDrop)).toThrow('<64 lowercase hex>_<vout>')
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd "$PKG" && pnpm exec jest src/__tests/OneColorAttributes.test.ts src/__tests/OneColor.test.ts`
Expected: FAIL with `needsEmptyPayloadMarker is not a function` / `OneColor.lockRemainder is not a function`.

- [ ] **Step 3: Implement** both functions as described in the Interfaces block. In `OneColor.ts`, factor the existing id/amount/`OP_2DROP` prefix into a private `prefixChunks(tokenId, amount)` used by both `lock` and `lockRemainder`. All existing `OneColor` tests must stay byte-identical. `OneColor.ts` imports `needsEmptyPayloadMarker` from `./OneColorAttributes.js`. `OneColorAttributes.ts` must not import `OneColor.ts`, which would create a cycle. Copy each remainder chunk as `{ ...c, data: c.data === undefined ? undefined : [...c.data] }` (or omit `data` when undefined) so the result never aliases the caller's arrays.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd "$PKG" && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: PASS. Suite count 17 (one new file), and the original 668 tests are unchanged.

- [ ] **Step 5: Commit** (with the guard): `feat(templates): OneColor.lockRemainder writes the empty-payload marker before <push> OP_DROP`

---

### Task 7: Public exports, README, package checks, build

**Files:**
- Modify: `PKG/mod.ts`, `PKG/src/OneColor.ts` (two exported consts), `PKG/src/__tests/exports.test.ts`, `PKG/package.json` (`pack:check` export list only), `PKG/browser-budget.json` (`requiredExports`), `PKG/README.md`

**Interfaces:**
- Consumes: Tasks 2-6.
- Produces (public `@bsv/templates` surface, contract §1):
  - `export { isProfileId, readOneColorAttributes, reqMatchesDeploy, needsEmptyPayloadMarker } from './src/OneColorAttributes.js'`
  - `export type { OneColorAttributes, OneColorField, OneColorProfileDescriptor } from './src/OneColorAttributes.js'`
  - `export const oneColorTokenIdFromString: (id: string) => number[]` and `export const oneColorTokenIdToString: (tokenId: readonly number[]) => string`, defined in `src/OneColor.ts` as arrow functions delegating to `OneColor.tokenIdFromString` / `OneColor.tokenIdToString` and re-exported from `mod.ts` next to `OneColor`. The 32-byte `tokenIdFromString`/`tokenIdToString` exports are unchanged. A one-line comment in `mod.ts` says new 1Color code should prefer the `oneColorTokenId*` names.

- [ ] **Step 1: Write the failing test** (append to `exports.test.ts`)

```ts
it('exports the 1Color attribute reader and the 36-byte-aware id helpers', () => {
  for (const name of ['isProfileId', 'readOneColorAttributes', 'reqMatchesDeploy', 'needsEmptyPayloadMarker', 'oneColorTokenIdFromString', 'oneColorTokenIdToString'])
    expect(typeof (mod as Record<string, unknown>)[name]).toBe('function')
  expect(typeof mod.OneColor.lockRemainder).toBe('function')
  const id = `${'ab'.repeat(31)}cd_258`
  expect(mod.oneColorTokenIdFromString(id)).toEqual(mod.OneColor.tokenIdFromString(id))
  expect(mod.oneColorTokenIdToString(mod.oneColorTokenIdFromString(id))).toBe(id)
  expect(() => mod.tokenIdFromString(id)).toThrow('<64 lowercase hex>_0') // the old name stays 32-byte only
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd "$PKG" && pnpm exec jest src/__tests/exports.test.ts`
Expected: FAIL. The names are not exported.

- [ ] **Step 3: Implement the exports.** Then:
  - In `package.json` `pack:check`, extend `--exports` with `isProfileId,needsEmptyPayloadMarker,oneColorTokenIdFromString,oneColorTokenIdToString,readOneColorAttributes,reqMatchesDeploy`. Keep the list alphabetical after the existing names.
  - Add `readOneColorAttributes` and `oneColorTokenIdFromString` to `browser-budget.json` `requiredExports`.
  - In the README, add a `OneColor` row to the "Current Templates" table and a `### 1Color payload attributes` subsection after the BRC-162 section. It covers the four payload kinds, the absent/valid/malformed fields, `reqMatchesDeploy`, `lockRemainder` with the 0162:105 rule, and "prefer `oneColorTokenIdFromString`/`oneColorTokenIdToString`; `tokenIdFromString`/`tokenIdToString` accept 32-byte ids only". Include one short TS example using `readOneColorAttributes(OneColor.decode(script).payload)`. The README is not compiled by `docs:examples`, but the example must still be correct.

- [ ] **Step 4: Run, build and check the artifact**

Run: `cd "$PKG" && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build && ls dist/src/OneColorAttributes.js dist/src/OneColorAttributes.cjs dist/src/OneColorAttributes.d.ts && pnpm pack:check && pnpm test:browser`
Expected: all pass, and the three dist files exist. tsdown `--unbundle` emits them through the `mod.ts` import graph. If they are missing, add `src/OneColorAttributes.ts` to the `build` entry list. If `test:browser` exceeds `maximumBytes`, record the measured sizes and raise only the exceeded budget numbers by the measured delta plus ≤ 2 %, with a line in the commit body. Never lower other checks.

- [ ] **Step 5: Commit** (with the guard): `feat(templates): export the 1Color attribute reader and the preferred oneColorTokenId helpers`

---

### Task 8: Version 2.2.0, changelog, release notes, generated docs

**Files:**
- Modify: `PKG/package.json` (`"version": "2.2.0"`), `PKG/CHANGELOG.md`, `governance/package-release-notes.json` (`@bsv/templates` entry and `lastReviewed`), `governance/repository-health/baselines.json` (`publicPackageVersions["@bsv/templates"]` → `"2.2.0"`), `docs/packages/helpers/templates.md`
- Regenerate (never hand-edit): `docs/reference/stack-facts.md`, `docs/reference/package-api-migrations.md` (and whatever else `pnpm docs:facts` rewrites)

**Interfaces:**
- Consumes: Task 7's public surface.
- Produces: source version `@bsv/templates@2.2.0`. This is the version every consumer's vendored tarball carries (contract §9).

**Decisions (recorded):**
- `publishedVersion` stays `2.0.0` and `releaseType` stays `minor`. `scripts/package-documentation.mjs` computes 2.0.0 → 2.2.0 as minor.
- Follow #1243 (41a6edb43): append to the existing `summary` and `migration` strings rather than replacing them.
- Do not bump the dependents. #1243 bumped `@bsv/overlay-topics` 2.0.1 → 2.0.2 (verified: `git show 41a6edb43 -- packages/overlays/topics/package.json`). 2.0.2 is still an unpublished candidate (`publishedVersion` 2.0.1), so its `workspace:^` range moving to `^2.2.0` at pack time needs no further bump. `@bsv/color-permission-module` is bumped by T2. Run `git show 41a6edb43 -- governance/package-release-notes.json | grep -n -A3 overlay-topics` to see whether #1243 added a sentence to the overlay-topics summary for the templates change. If it did, append one sentence to that summary ("Packs against @bsv/templates ^2.2.0; no behaviour change.") and change nothing else.

- [ ] **Step 1: Write the version edits**
  - CHANGELOG: under `## [Unreleased]`, add `### 2.2.0 candidate` above `### 2.1.0 candidate`, with an `### Added` list covering `readOneColorAttributes`, `reqMatchesDeploy`, `isProfileId`, `needsEmptyPayloadMarker`, `OneColor.lockRemainder`, `oneColorTokenIdFromString`/`oneColorTokenIdToString`, and the line "`Bsv21Binary`, `Bsv21Token` and every existing export are unchanged."
  - Release-notes `summary` append: "Templates 2.2.0 adds the BRC-162 1Color attribute reader: readOneColorAttributes classifies a payload as absent, empty, opaque or a strict DAG-CBOR map and reports dec, sym, icon, req and ext as absent, valid or malformed; reqMatchesDeploy compares a repeated req with the deploy's canonical bytes (an absent deploy map is empty); isProfileId checks processing-profile identifiers; OneColor.lockRemainder writes the prefix in front of any locking script, with an explicit OP_0 OP_DROP when the remainder begins with <push> OP_DROP; oneColorTokenIdFromString and oneColorTokenIdToString are the preferred 36-byte-aware id helpers. Bsv21Binary, Bsv21Token and every existing export are unchanged."
  - Release-notes `migration` append: "2.2.0 is additive; no migration is required. tokenIdFromString and tokenIdToString remain 32-byte only; new 1Color code should use oneColorTokenIdFromString and oneColorTokenIdToString."
  - Set `lastReviewed` to `2026-10-22`.
  - `docs/packages/helpers/templates.md` frontmatter: `version: '2.2.0'`, `last_updated: '2026-10-22'`, `last_verified: '2026-10-22'`. Add one paragraph stating that the 2.2.0 source candidate adds the 1Color attribute reader and `lockRemainder`, with no migration required.

- [ ] **Step 2: Run the checks and confirm they flag the stale generated docs**

Run (root): `pnpm docs:facts:check`
Expected: FAIL, reporting stale `docs/reference/stack-facts.md` / `package-api-migrations.md` (templates `2.1.0` vs `2.2.0`). This proves the generated docs track the version.

- [ ] **Step 3: Regenerate**

Run: `pnpm docs:facts`, then `git diff --stat`. Expected: only the files listed above plus generated reference pages change. Revert any unrelated generated churn and report it.

- [ ] **Step 4: Full local gate**

Run (root):
```bash
pnpm docs:facts:check && pnpm check-versions && pnpm health:check && pnpm lint && pnpm format:check
pnpm --filter @bsv/templates build && pnpm -r --filter "...@bsv/templates" run typecheck
pnpm --filter @bsv/templates test && pnpm --filter @bsv/color-permission-module test
node scripts/ci-local-feedback.mjs --base origin/main
git hash-object $PKG/src/Bsv21Token.ts $PKG/test/vectors/brc162.json   # must equal the Task 0 hashes
git diff origin/main --stat -- $PKG/src/Bsv21Token.ts $PKG/src/strictCbor.ts $PKG/src/Bsv21Binary.ts $PKG/src/mandala-encoding.ts  # must be empty
```
Expected: every command succeeds. `health:check` and the color-module tests match or improve on the Task 1 baseline. The dependents' typecheck passes against the new templates `dist`. `ci-local-feedback` is advisory: run every check it lists for `@bsv/templates` (including `pnpm --filter @bsv/templates test:property` and, if listed, the `mandala-encoding` mutation target, which must stay ≥ 92 because its files are untouched). Record the results. `@bsv/overlay-topics` tests need MongoDB memory server. Run them if the environment allows, otherwise record "not run (environment)".

- [ ] **Step 5: Commit** (with the guard): `chore(templates): version 2.2.0 with release notes for the 1Color attribute reader`

---

### Task 9: V1 vendored tarball (contract §9, §10 "V1 re-pack templates")

**Files:**
- Create (in the mandala worktree, **not committed by this plan**): `/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack/bsv-templates-2.2.0-<sha>.tgz`

**Interfaces:**
- Consumes: Task 8's committed tree.
- Produces: the tarball P-LIB (LIB-core) and P-T2 consumers install as `file:` specs. P-LIB's own vendoring commit owns committing it, so two plans never commit in the mandala worktree at once.

- [ ] **Step 1: Confirm the preconditions**

Run: `cd /Users/personal/git/ts-stack-wt/1color && test -z "$(git status --porcelain)" && git log --oneline -1`
Expected: a clean tree with HEAD at the Task 8 commit. If P-T2 has already started editing this worktree, stop and report: the tarball must be cut from a clean T1 commit.

- [ ] **Step 2: Build and pack**

```bash
TS=/Users/personal/git/ts-stack-wt/1color; OUT=/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack
SHA=$(git -C $TS rev-parse --short=7 HEAD); mkdir -p $OUT
cd $TS && pnpm --filter @bsv/templates build && pnpm --filter @bsv/templates pack --pack-destination "$OUT"
mv "$OUT/bsv-templates-2.2.0.tgz" "$OUT/bsv-templates-2.2.0-$SHA.tgz"
```

- [ ] **Step 3: Verify the artifact**

Run: `TGZ="$OUT/bsv-templates-2.2.0-$SHA.tgz"; tar -xOzf "$TGZ" package/package.json | grep -q '"version": "2.2.0"' && ! tar -xOzf "$TGZ" package/package.json | grep -q 'workspace:' && [ "$(tar -tzf "$TGZ" | grep -cE 'dist/src/OneColorAttributes\.(js|cjs|d\.ts)$')" = 3 ] && echo OK`
Expected: version `2.2.0`, the peer `@bsv/sdk` range is a real range (no `workspace:`), and all three OneColorAttributes files are listed. Report the absolute tarball path and `$SHA` to the orchestrator. Do not commit in the mandala repo, push or publish.

---

### Task 10: Upstream text drafts (design I1 and §3 spec feedback; docs only, no code)

Design §4.1 I1 and §3 ("spec feedback … is drafted in a doc for the user") have no other owner, so this plan owns the text. Nothing is posted. No BRC spec PR is opened.

**Files:**
- Create (in the mandala worktree, **not committed by this plan**): `/Users/personal/git/demos/mandala-wt/1color/docs/design/2026-10-22-bsv21token-issue-draft.md`
- Create (same rule): `/Users/personal/git/demos/mandala-wt/1color/docs/design/2026-10-22-brc-spec-feedback.md`

**Interfaces:**
- Consumes: the baseline `PKG/src/Bsv21Token.ts` (read only, hash recorded in Task 0), pinned 0161/0162/0207, the audit (F1-F7, §8.1).
- Produces: two Markdown files. P-LIB's next pathspec commit window (or the orchestrator) commits them with `git -C /Users/personal/git/demos/mandala-wt/1color commit -- docs/design/2026-10-22-bsv21token-issue-draft.md docs/design/2026-10-22-brc-spec-feedback.md`, message `docs(design): draft Bsv21Token issue and BRC spec feedback`. This plan never commits in the mandala worktree, so two plans never commit there at once (same rule as Task 9).

Independence: Task 10 reads only baseline files and touches neither the ts-stack worktree nor `Bsv21Token.ts`, so it may run at any point after Task 0. A rerun overwrites both files with the same content (idempotent).

- [ ] **Step 1: Re-read the evidence.** Read `PKG/src/Bsv21Token.ts` (226 lines at cbdccfe; `decode` at :193-225, `parseDecimals` at :89-97, `fieldTag`/`pushedBytes` at :69-83), 0161:85-87, 0161:135, 0161:239-241, 0162:101, 0162:105-106, 0162:111, 0162:120, and audit lines 61-66 and §8.1. Each gap below is stated only if the code still shows it. Drop a bullet that the code already handles, and say so in the task report.

- [ ] **Step 2: Write `2026-10-22-bsv21token-issue-draft.md`.** Structure: a header that says `DRAFT, not filed. File with gh issue create --repo bsv-blockchain/ts-stack only at the draft-PR stage, after the user reviews it.`, then `Title:` and `Body:` sections. Title: `@bsv/templates Bsv21Token: decode accepts BRC-161 outputs the spec calls invalid`. The body lists each gap with its spec line, the current behaviour with a `Bsv21Token.ts:<line>` cite, the expected behaviour, and one failing example input:
  1. **`amt` bound and canonical form** (0161:239). `/^\d+$/` accepts `"18446744073709551616"` (2^64) and leading zeros (`"007"`). Expected: canonical decimal `0|[1-9][0-9]*`, value ≤ 2^64-1, and `> 0` for value ops if the spec intends that (raise as a question).
  2. **`dec`** (0161:87, 0161:241). A JSON number (`"dec": 2`) is accepted, and a number is not range-checked (`"dec": 99` returns 99). Expected: string `0..18` only. Also ask whether `"02"` is canonical.
  3. **`id` on non-deploy ops** (0161 `mint`/`auth`/`transfer`/`burn` tables). A missing or malformed `id` returns `id: ''` instead of failing. Expected: required, shape `<64hex>_<vout>`.
  4. **Unknown or missing `op`.** Any string (and `''`) is accepted and treated as a value op. Expected: reject anything outside `deploy+mint`, `deploy+auth`, `mint`, `auth`, `transfer`, `burn`.
  5. **Binary wins** (0162:106). `Bsv21Token.decode` on a script that also carries a valid 1Color prefix returns a JSON token. Expected: a precedence helper, or a documented call order (`OneColor.decode` first) in the README.
  6. **PUSHDATA-form ambiguity (for spec authors).** `fieldTag` accepts both `OP_1` and a one-byte data push `01` as the same envelope tag, and `pushedBytes` accepts any push form, so non-minimal pushes are read. 0161 does not say whether non-minimal pushes are valid. The matching 1Color question is under 0162:101: any push opcode counts as the payload push, with no minimality rule. Ask the spec authors to pin one rule and add a vector.
  The issue proposes no code. It notes that `Bsv21Token.ts` is unchanged by the 1Color work on purpose (user rule), so a fix is a separate change.

- [ ] **Step 3: Write `2026-10-22-brc-spec-feedback.md`.** Header: `DRAFT for the user. No BRC PR is opened from this run (design §3).` One section per item, each with the pinned line cite, the problem, a proposed wording and the Mandala impact:
  - **F1** topic/prefix fixed to `tm_color_` (audit :61).
  - **F2** `identity` mode has one key and no rotation (0207:222; audit :62).
  - **F3** (offline regression) Mandala rules beyond BRC-162 cannot be validated locally. Propose a companion-profile settlement-time check (audit :63).
  - **F4** behaviour when BRC-177 lifecycles are absent (design B2; audit :64).
  - **F5** a worked `evidenceProfile` example. **F6** define "known conflict" as wallet-local state. **F7** add a vector with a fabricated authority parent inside the bundle (audit :64).
  - **Editorial id form:** 0162:111 says the binary-native token id is `<deploy txid>.0` (BRC-36 dot form), while 0162:120 (and 0162:292) say the string form is `<txid>_<vout>`. The audit cites these as 0162:107 vs 0162:116 under the earlier pin; use the pinned numbers. Proposed fix: 0162:111 says "`<deploy txid>_0`", or says it names the deploy *outpoint* and not the token id. Mandala keeps ids `_0` and outpoints `.` (contract §0).
  - **PUSHDATA ambiguity:** 0162:101 counts any push opcode as the payload push, including non-minimal `OP_PUSHDATA1/2/4`, and 0162:105 makes encoders write `OP_0 OP_DROP`. Ask whether a non-minimal payload push is valid or should be canonical. Mandala's overlay already requires a canonical push on deploy (audit 2.2), and `needsEmptyPayloadMarker` treats every push form as a push (Task 6, RF4). Cross-reference the BRC-161 envelope question in the issue draft.

- [ ] **Step 4: Verify.**
Run: `D=/Users/personal/git/demos/mandala-wt/1color/docs/design; for f in $D/2026-10-22-bsv21token-issue-draft.md $D/2026-10-22-brc-spec-feedback.md; do test -s $f || echo MISSING $f; done; for n in 1 2 3 4 5 6 7; do grep -q "F$n" $D/2026-10-22-brc-spec-feedback.md || echo MISSING F$n; done; grep -q 'DRAFT, not filed' $D/2026-10-22-bsv21token-issue-draft.md && echo OK; git -C /Users/personal/git/ts-stack-wt/1color hash-object packages/helpers/ts-templates/src/Bsv21Token.ts`
Expected: no `MISSING` line (both files and F1-F7 present), `OK`, and the `Bsv21Token.ts` hash equals the Task 0 record. Do not run `gh issue create`, do not commit and do not push. Report both absolute paths to the orchestrator as "awaiting P-LIB/orchestrator pathspec commit; issue to be filed at the draft-PR stage".

---

## Self-review (done at authoring time)

- **Spec coverage (design §4.1 T1):**

  | Design requirement | Task |
  |---|---|
  | `dec`/`sym`/`icon` reader | 3 |
  | `req`/`ext`, descriptor shape, malformed ≠ absent | 4 |
  | `req` equality by canonical bytes, absent deploy = empty | 5 |
  | `OP_0 OP_DROP` encoder helper | 6 |
  | Export cleanup with old names kept | 7 |
  | Minor bump 2.2.0, changelog and release notes per ts-stack conventions | 8 |
  | No `Bsv21Token.ts` change | Global guard + Task 8 hash check |
  | BotBoard (read only; handle NOT OPENED overnight, required before push/PR) | Task 0 |
  | Baseline | Task 1 |
  | V1 tarball (contract §9) | Task 9 |
  | I1 `Bsv21Token` issue text (draft only; `gh issue create --repo bsv-blockchain/ts-stack` at the draft-PR stage) | Task 10 |
  | §3 spec feedback doc (F1-F7, 0162:111 vs :120, PUSHDATA) | Task 10 |

  Task 10 writes text only in the mandala worktree and never commits there. P-LIB's pathspec commit window or the orchestrator commits it, which matches the Task 9 ownership rule (contract §9). BotBoard handling matches plan 02: nothing public is posted overnight.
- **Contract Revision 2 re-check:** §1 never-throw input table (Task 3 RF3, runtime garbage), fixed `reqMatchesDeploy` fail-closed order (Task 5, now identical to the contract), `reqBytes` exact wire span (Task 4 RF2), §9 tarball commit ownership (Task 9), §10 V1 owner (Task 9 produces, P-LIB commits). No remaining contract gaps.
- **Contract consistency:** every exported name and type matches contract §1 verbatim. `oneColorTokenId*` are consts defined in `OneColor.ts` and re-exported from `mod.ts`, which gives the same public surface.
- **Review Focus:** RF1-RF5 each have a named test in Tasks 3, 4, 5 and 6.
- **Proportion:** bodies are given only for the span finder (an algorithm the signature does not determine). Everything else is a signature plus pinned assertions.

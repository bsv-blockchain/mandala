# Q1 — BRC-87 name widening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow overlay topic and lookup-service names of up to 150 characters that contain digits (so `tm_<64 hex>` / `ls_<64 hex>` are valid), in ts-stack and in the BRC-87 text, as two PRs the maintainer merges and publishes.

**Architecture:** One regex changes in four ts-stack source locations across three packages: `@bsv/sdk`, `@bsv/overlay` and `@bsv/overlay-discovery-services`. Every name valid today stays valid, so each package takes a MINOR bump. A separate PR to the BRCs repo amends BRC-87's master rules to match.

**Tech Stack:** ts-stack pnpm monorepo, TypeScript, jest (sdk, discovery-services), the overlay package's own test runner; markdown in `bsv-blockchain/BRCs`.

**Spec:** [`docs/superpowers/specs/2026-10-05-mandala-token-topics-design.md`](../specs/2026-10-05-mandala-token-topics-design.md) §2 T3, §5.

## Global Constraints

- New rule, exactly: `^(?=.{1,150}$)(?:tm_|ls_)[a-z0-9]+(?:_[a-z0-9]+)*$`. Per protocol it is `tm_`-only for SHIP (`^(?=.{1,150}$)tm_[a-z0-9]+(?:_[a-z0-9]+)*$`) and `ls_`-only for SLAP (`^(?=.{1,150}$)ls_[a-z0-9]+(?:_[a-z0-9]+)*$`).
- Unchanged: lower case only; no leading, trailing or doubled underscore after the prefix; the `tm_`/`ls_` prefixes.
- Every name valid under the old rule must stay valid.
- ts-stack changes ship as a PR only. Never merge, tag or publish; the user does that (memory: ts-stack PR & publish workflow).
- Never touch the user's ts-stack checkout at `/Users/personal/git/ts-stack`. It is on branch `claude/eqc-economic-query-client-9f9bde` with unmerged work. Work in a new worktree off `origin/main`.
- Follow ts-stack `AGENTS.md`, including the maintainer BotBoard and Lockfile protocol: invoke the `botboard` skill before starting ts-stack work.
- Versions (MINOR, backward-compatible per `docs/about/versioning.md`):
  - `@bsv/sdk` 3.0.0 → 3.1.0
  - `@bsv/overlay` 2.6.3 → 2.7.0
  - `@bsv/overlay-discovery-services` 2.2.7 → 2.3.0
  
  Re-read each `package.json` version on `origin/main` before bumping. If it moved, bump the minor of the version you find.
- **Plan decision (spec §5 step 1 deviation):** discovery-services and overlay keep their own local regex constant instead of importing a new export from `@bsv/sdk`. Importing one would force their `@bsv/sdk` peer ranges (`^2.4.0 || ^3.0.0` and `^2.1.6 || ^3.0.0`) up to `^3.1.0`, which is a breaking change for consumers. Each package's tests pin the identical vectors instead. Inside `@bsv/sdk`, the two copies merge into one exported constant.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

1. **A name valid today must not become invalid**, including the boundary at exactly 50 characters. Pinned by the old-vector table in every task.
2. **Digits must not open the prefix rule:** `tm_0`, `ls_9abc` and `tm_` + 64 hex are valid, but `tm0_x` and `9m_x` are not. Pinned in Task 1 and Task 3.
3. **Length is measured on the whole name, prefix included:** 150 is valid and 151 is not. Pinned in every task.
4. **Underscore rules still hold next to digits:** `tm_1__2` and `tm_1_` are invalid. Pinned in Task 3.
5. **`SHIPBroadcaster` still refuses `ls_` names, and SLAP still refuses `tm_` names**, since the per-protocol split survives. Pinned in Task 1 and Task 2.

---

### Task 1: `@bsv/sdk` — one exported name rule, widened

**Files:**
- Create: `packages/sdk/src/overlay-tools/overlayNames.ts`
- Modify:
  - `packages/sdk/src/overlay-tools/SHIPBroadcaster.ts:171`
  - `packages/sdk/src/overlay-tools/OverlayAdminTokenTemplate.ts:31-34`
  - `packages/sdk/src/overlay-tools/index.ts`
  - `packages/sdk/package.json` (version)
  - `packages/sdk/CHANGELOG.md` (Unreleased)
- Test: `packages/sdk/src/overlay-tools/__tests/overlayNames.test.ts`, plus one case appended to `packages/sdk/src/overlay-tools/__tests/SHIPBroadcaster.test.ts`

**Interfaces:**
- Produces:
  - `export const OVERLAY_TOPIC_NAME: RegExp`
  - `export const OVERLAY_SERVICE_NAME: RegExp`
  - `export const isValidOverlayTopicName: (name: string) => boolean`
  - `export const isValidOverlayServiceName: (name: string) => boolean`
  
  All four are exported from `@bsv/sdk` via `overlay-tools/index.ts`.

- [ ] **Step 0: Worktree and protocol**

```bash
cd /Users/personal/git/ts-stack && git fetch -q origin
git worktree add -b feat/brc87-wider-names /private/tmp/ts-stack-brc87 origin/main
cd /private/tmp/ts-stack-brc87 && pnpm install --frozen-lockfile
```
Then invoke the `botboard` skill and follow its Lockfile protocol for this branch.

- [ ] **Step 1: Write the failing test** (`overlayNames.test.ts`)

```ts
import {
  OVERLAY_TOPIC_NAME,
  OVERLAY_SERVICE_NAME,
  isValidOverlayTopicName,
  isValidOverlayServiceName
} from '../overlayNames'

const HEX64 = 'ab'.repeat(32)

describe('BRC-87 overlay names (widened)', () => {
  it('accepts every name the old rule accepted', () => {
    for (const n of ['tm_uhrp_files', 'tm_tempo_songs', 'tm_a', 'tm_a_b_c', 'tm_' + 'a'.repeat(47)]) {
      expect(isValidOverlayTopicName(n)).toBe(true)
    }
    for (const n of ['ls_uhrp_files', 'ls_tempo_songs_search', 'ls_a', 'ls_a_b']) {
      expect(isValidOverlayServiceName(n)).toBe(true)
    }
  })
  it('accepts digits and 64-hex token topics', () => {
    expect(isValidOverlayTopicName('tm_' + HEX64)).toBe(true)
    expect(isValidOverlayServiceName('ls_' + HEX64)).toBe(true)
    expect(isValidOverlayTopicName('tm_0')).toBe(true)
    expect(isValidOverlayTopicName('tm_uhrp_files2')).toBe(true)
  })
  it('measures length on the whole name: 150 ok, 151 refused', () => {
    expect(isValidOverlayTopicName('tm_' + 'a'.repeat(147))).toBe(true)
    expect(isValidOverlayTopicName('tm_' + 'a'.repeat(148))).toBe(false)
  })
  it('keeps the prefix and underscore rules', () => {
    for (const n of ['', 'tm_', 'tm0_x', '9m_x', 'tm__a', 'tm_a_', '_tm_a', 'tm_A', 'tm_a-b', 'ls_a']) {
      expect(isValidOverlayTopicName(n)).toBe(false)
    }
    for (const n of ['tm_a', 'ls__a', 'ls_a_']) {
      expect(isValidOverlayServiceName(n)).toBe(false)
    }
  })
  it('exposes the patterns', () => {
    expect(OVERLAY_TOPIC_NAME.source).toBe('^(?=.{1,150}$)tm_[a-z0-9]+(?:_[a-z0-9]+)*$')
    expect(OVERLAY_SERVICE_NAME.source).toBe('^(?=.{1,150}$)ls_[a-z0-9]+(?:_[a-z0-9]+)*$')
  })
})
```
Append to `SHIPBroadcaster.test.ts`, inside its `describe`:
```ts
  it('accepts a 64-hex token topic and still refuses an ls_ name', () => {
    expect(() => new SHIPCast(['tm_' + 'ab'.repeat(32)])).not.toThrow()
    expect(() => new SHIPCast(['ls_foo'])).toThrow('canonical tm_ topic names')
  })
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd packages/sdk && npx jest src/overlay-tools/__tests/overlayNames.test.ts src/overlay-tools/__tests/SHIPBroadcaster.test.ts`
Expected: FAIL. `overlayNames` cannot be resolved, and the 64-hex case throws.

- [ ] **Step 3: Implement**

`overlayNames.ts`:
```ts
/**
 * BRC-87 overlay names (widened 2026-10): `tm_`/`ls_` + lower-case letters and digits in
 * underscore-separated segments, at most 150 characters in total. Every name valid under the
 * original 50-character, letters-only rule stays valid. The width admits per-token topics such as
 * `tm_<64 hex txid>`.
 */
export const OVERLAY_TOPIC_NAME = /^(?=.{1,150}$)tm_[a-z0-9]+(?:_[a-z0-9]+)*$/
export const OVERLAY_SERVICE_NAME = /^(?=.{1,150}$)ls_[a-z0-9]+(?:_[a-z0-9]+)*$/

export const isValidOverlayTopicName = (name: string): boolean => OVERLAY_TOPIC_NAME.test(name)
export const isValidOverlayServiceName = (name: string): boolean => OVERLAY_SERVICE_NAME.test(name)
```
In `SHIPBroadcaster.ts`, import `isValidOverlayTopicName` from `./overlayNames.js` and replace
`!/^(?=.{1,50}$)tm_[a-z]+(?:_[a-z]+)*$/.test(topic) ||` with `!isValidOverlayTopicName(topic) ||`.

In `OverlayAdminTokenTemplate.ts`, import both patterns and set:
```ts
const canonicalNamePattern: Record<OverlayDiscoveryProtocol, RegExp> = {
  SHIP: OVERLAY_TOPIC_NAME,
  SLAP: OVERLAY_SERVICE_NAME
}
```
In `overlay-tools/index.ts`, add `export * from './overlayNames.js'`.

- [ ] **Step 4: Run, expect PASS.** Run the same command, then the whole overlay-tools folder: `npx jest src/overlay-tools`. Expected: all pass.

- [ ] **Step 5: Version and changelog.** Set `packages/sdk/package.json` `"version"` to `3.1.0`. Under `## [Unreleased]` in `CHANGELOG.md`, add:
```markdown
### Changed
- BRC-87 overlay names widened: `tm_`/`ls_` names may contain digits and be up to 150 characters (`tm_<64 hex>` per-token topics). Every previously valid name stays valid. New exports: `OVERLAY_TOPIC_NAME`, `OVERLAY_SERVICE_NAME`, `isValidOverlayTopicName`, `isValidOverlayServiceName`.
```

- [ ] **Step 6: Commit**
```bash
git add packages/sdk && git commit -m "feat(sdk): widen BRC-87 overlay names to 150 chars with digits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `@bsv/overlay` — discovery advertisement validation

**Files:**
- Modify:
  - `packages/overlays/overlay/src/DiscoveryAdvertisementValidation.ts:20-23`
  - `packages/overlays/overlay/package.json` (version)
  - `packages/overlays/overlay/CHANGELOG.md`
- Test: `packages/overlays/overlay/src/__tests/DiscoveryAdvertisementNames.test.ts`. Use the package's existing test location and runner: check `package.json` `scripts.test` and the nearest existing `__tests` folder, and mirror them.

**Interfaces:**
- Produces: the exported `discoveryNamePattern: Record<DiscoveryProtocol, RegExp>`, exported for tests only, with the same values as Task 1.

- [ ] **Step 1: Write the failing test**
```ts
import { discoveryNamePattern } from '../DiscoveryAdvertisementValidation.js'

const HEX64 = 'ab'.repeat(32)

describe('discovery advertisement names (BRC-87 widened)', () => {
  it('SHIP accepts old names and tm_<64 hex>, refuses ls_ and over-long', () => {
    expect(discoveryNamePattern.SHIP.test('tm_uhrp_files')).toBe(true)
    expect(discoveryNamePattern.SHIP.test('tm_' + 'a'.repeat(47))).toBe(true)
    expect(discoveryNamePattern.SHIP.test('tm_' + HEX64)).toBe(true)
    expect(discoveryNamePattern.SHIP.test('ls_' + HEX64)).toBe(false)
    expect(discoveryNamePattern.SHIP.test('tm_' + 'a'.repeat(148))).toBe(false)
  })
  it('SLAP accepts ls_<64 hex>, refuses tm_', () => {
    expect(discoveryNamePattern.SLAP.test('ls_' + HEX64)).toBe(true)
    expect(discoveryNamePattern.SLAP.test('tm_' + HEX64)).toBe(false)
  })
})
```

- [ ] **Step 2: Run, expect FAIL.** `discoveryNamePattern` is not exported.

- [ ] **Step 3: Implement.** Rename `namePattern` to `discoveryNamePattern`, export it, and widen it. Update its single use in this file.
```ts
/** BRC-87 names (widened): kept local so the @bsv/sdk peer range need not move. Same values as @bsv/sdk OVERLAY_TOPIC_NAME / OVERLAY_SERVICE_NAME. */
export const discoveryNamePattern: Record<DiscoveryProtocol, RegExp> = {
  SHIP: /^(?=.{1,150}$)tm_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  SLAP: /^(?=.{1,150}$)ls_[a-z0-9]+(?:_[a-z0-9]+)*$/
}
```

- [ ] **Step 4: Run the package's tests, expect PASS.**
- [ ] **Step 5: Version 2.7.0 and a changelog line** ("Discovery advertisements accept widened BRC-87 names (digits, ≤150 chars)").
- [ ] **Step 6: Commit** `feat(overlay): accept widened BRC-87 names in discovery advertisements`, with the trailer.

---

### Task 3: `@bsv/overlay-discovery-services` — `isValidTopicOrServiceName`

**Files:**
- Modify:
  - `packages/overlays/overlay-discovery-services/src/utils/isValidTopicOrServiceName.ts`
  - `packages/overlays/overlay-discovery-services/src/SHIP/SHIPTopic.docs.ts:34`
  - `packages/overlays/overlay-discovery-services/src/SLAP/SLAPTopic.docs.ts:29,53`
  - `package.json` (version)
  - `CHANGELOG.md`
- Test: `packages/overlays/overlay-discovery-services/src/utils/__tests/isValidTopicOrServiceName.test.ts`

**Interfaces:**
- Consumes: nothing new. Callers are unchanged: `SHIPLookupService.ts:110`, `SLAPLookupService.ts:113`, `WalletAdvertiser.ts:192,481` and `isAdmissibleDiscoveryOutput.ts:35`.

- [ ] **Step 1: Rewrite the tests.** Keep the existing valid cases, prefix cases, uppercase cases, edge-underscore cases, consecutive-underscore cases and the empty-string case. Then:
  - Replace the "non-alphabetic" block. `tm_uhrp_files2` is now valid; `ls_tempo_songs-search` and `tm_uhrp%files` stay invalid.
  - Replace both length tests.
```ts
  it('accepts digits, including 64-hex token topics', () => {
    expect(isValidTopicOrServiceName('tm_uhrp_files2')).toBe(true)
    expect(isValidTopicOrServiceName('tm_' + 'ab'.repeat(32))).toBe(true)
    expect(isValidTopicOrServiceName('ls_' + 'ab'.repeat(32))).toBe(true)
    expect(isValidTopicOrServiceName('tm_1_2')).toBe(true)
  })
  it('still refuses other non-alphanumeric characters and bad digit placements', () => {
    expect(isValidTopicOrServiceName('ls_tempo_songs-search')).toBe(false)
    expect(isValidTopicOrServiceName('tm_uhrp%files')).toBe(false)
    expect(isValidTopicOrServiceName('tm0_x')).toBe(false)
    expect(isValidTopicOrServiceName('tm_1__2')).toBe(false)
    expect(isValidTopicOrServiceName('tm_1_')).toBe(false)
  })
  it('keeps every name of exactly 50 characters valid (old boundary)', () => {
    expect(isValidTopicOrServiceName('tm_' + 'a'.repeat(47))).toBe(true)
  })
  it('validates exactly 150 characters and refuses 151', () => {
    expect(('tm_' + 'a'.repeat(147)).length).toBe(150)
    expect(isValidTopicOrServiceName('tm_' + 'a'.repeat(147))).toBe(true)
    expect(isValidTopicOrServiceName('tm_' + 'a'.repeat(148))).toBe(false)
  })
```

- [ ] **Step 2: Run, expect FAIL**: `cd packages/overlays/overlay-discovery-services && npx jest src/utils/__tests/isValidTopicOrServiceName.test.ts`

- [ ] **Step 3: Implement**
```ts
/**
 * Checks a topic manager or lookup service name against BRC-87 (widened 2026-10): `tm_`/`ls_` +
 * lower-case letters and digits in underscore-separated segments, at most 150 characters.
 * Kept local (same values as @bsv/sdk OVERLAY_TOPIC_NAME / OVERLAY_SERVICE_NAME) so the @bsv/sdk
 * peer range need not move.
 */
export const isValidTopicOrServiceName = (service: string): boolean => {
  const serviceRegex = /^(?=.{1,150}$)(?:tm_|ls_)[a-z0-9]+(?:_[a-z0-9]+)*$/
  return serviceRegex.test(service)
}
```
In `SLAPTopic.docs.ts:53`, change "Only letters (lowercase) and underscores are allowed" to "Only lower-case letters, digits and underscores are allowed, at most 150 characters". Check `SHIPTopic.docs.ts:34` and `SLAPTopic.docs.ts:29` for any stated length or charset, and update them the same way.

- [ ] **Step 4: Run the package suite, expect PASS**: `npx jest`
- [ ] **Step 5: Version 2.3.0 and a changelog line.**
- [ ] **Step 6: Commit** `feat(overlay-discovery-services): widen BRC-87 name check to 150 chars with digits`, with the trailer.

---

### Task 4: Repo checks and the ts-stack PR

**Files:** none new.

- [ ] **Step 1: Repo-wide gates**

```bash
cd /private/tmp/ts-stack-brc87 && node scripts/check-versions.mjs \
  && pnpm --filter @bsv/sdk build && pnpm --filter @bsv/overlay build && pnpm --filter @bsv/overlay-discovery-services build \
  && pnpm --filter @bsv/sdk test && pnpm --filter @bsv/overlay test && pnpm --filter @bsv/overlay-discovery-services test
```
Expected: all green. If `check-versions.mjs` reports that dependents need a bump, apply exactly what it asks for and note it in the PR. Run long commands in the background and wait for the notification.

- [ ] **Step 2: Push the branch and open the PR.** Only after the user says "open the PR"; until then, stop and report the branch name.
```bash
git push -u origin feat/brc87-wider-names
gh pr create --repo bsv-blockchain/ts-stack --base main --head feat/brc87-wider-names \
  --title "feat: widen BRC-87 overlay names (digits, ≤150 chars)" --body-file <scratch body file>
```
The PR body covers:
- the new regex;
- that every old name stays valid;
- why discovery-services and overlay keep local copies (peer ranges);
- the versions;
- the BRCs companion PR link;
- the closing line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

### Task 5: BRC-87 text (BRCs repo PR)

**Files:**
- Modify: `overlays/0087.md` in the BRCs repo (local clone `/Users/personal/git/docs/BRCs`, remote `bsv-blockchain/BRCs`). Work in a worktree, never on its `master` checkout.

- [ ] **Step 1: Worktree**
```bash
cd /Users/personal/git/docs/BRCs && git fetch -q origin
git worktree add -b brc87-wider-names /private/tmp/brcs-87 origin/master
```

- [ ] **Step 2: Edit `overlays/0087.md` "Master Rules"** to:
```markdown
### Master Rules

1. Only lower-case letters, digits and underscores.
2. Must not start or end with an underscore.
3. No consecutive underscores.
4. No longer than 150 characters, prefix included.
5. The prefix (`tm_` or `ls_`) is always letters; digits may appear anywhere after it.

Equivalent pattern: `^(?=.{1,150}$)(?:tm_|ls_)[a-z0-9]+(?:_[a-z0-9]+)*$`.
```
Add to the topic-manager examples: ``-   `tm_<64-hex-txid>` (a per-asset topic keyed by a deploy transaction id)``. Add a short `## Changelog` section at the end:
```markdown
## Changelog

- 2026-10: Rules 1 and 4 widened (digits allowed; 50 → 150 characters) so per-asset topics such as `tm_<64-hex txid>` are valid. Every previously valid name remains valid.
```

- [ ] **Step 3: Commit** `docs(brc-87): allow digits and names up to 150 characters`, with the trailer.

- [ ] **Step 4: Push and open the PR, only after the user says so.** Use `gh pr create --repo bsv-blockchain/BRCs --base master ...`, linking the ts-stack PR.

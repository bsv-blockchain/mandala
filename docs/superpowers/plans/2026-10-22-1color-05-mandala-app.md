# Mandala App Console: 1Color / @bsv/mandala 0.5.0 Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended; this plan is written for subagent-driven execution) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Vite/React console in `app/` to `@bsv/mandala` 0.5.0, so it works end to end with exact uint64 `bigint` amounts. Deploys carry the Mandala `req`, per-asset topics are `tm_color_<assetId>`, and holders send and receive through the wallet's BRC-207 module. The sender submits after the ACK (B5). The issuer pays holders through `p color` receipts (B4). Nothing writes to the old `'p mandala'` basket.

**Architecture:** The app keeps its shape: React Query hooks over lib calls, single-flight latches and optimistic caches. Every token amount becomes `bigint`. Pure logic moves into small, unit-tested modules under `app/src/lib/mandala/`, because the existing suite is smoke and source-scan tests with no DOM renderer. Holder balances come from the BRC-207 `p color` views. The treasury balance comes from the lib's `TREASURY_BASKET`. The lib hand-over journal (stages `signed` → `delivered`, contract §8.1) is the **only** durable store for the send pipeline (sign → deliver → post-ACK settle). The app owns no queue. It adds a thin scheduler (`drainHandovers`: single-flight, cross-tab web lock, in-memory backoff) that runs the lib's own recovery (`reconcileNotifications` redelivers, `reconcileWallet` settles), plus the immediate deliver-and-settle leg right after a send.

**Revision 2 (2026-10-22, against contract Revision 2):**
- Readiness gate is now P-LIB Task 23 (built `lib/dist` + V3 tarball), not the version string. P-APP never runs `npm install` in `lib/` (contract §10).
- The app hand-over queue (`mandala.app.handover.*`) is deleted. The lib journal is the single owner, and there is one redelivery path (`reconcileNotifications`) and one settle-recovery path (`reconcileWallet`), both reached only through `drainNow` (Tasks 8, 9, 11, 12).
- `payoutTokens` returns `PayoutResult` (no authority spent): no `advanceAdminAuth`, no `isAdminAuthInFlight` (Task 11).
- The holder "pending" line is split into `unsettled` (`color_offline` ∧ `color_state_available`, already inside the balance) and `incoming` (`color_state_pending`, not in the balance) (Tasks 5–7).
- `plainAmount` delegates to the pinned `formatAmount` (contract §8.1:493); `Sender` is the exported `MessageBoxSender` type; commits are pathspec-scoped `-- app/`.

**Tech Stack:** React 19, Vite 6, TypeScript 5.9 (`tsc -b`), Vitest 4 (node env), @tanstack/react-query 5, `@bsv/sdk` 4.0.0 and `@bsv/templates` 2.2.0 (vendored tarballs), `@bsv/mandala` 0.5.0 (`file:../lib`), `@bsv/message-box-client` 2.5.4.

**Spec:** `docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (§2 goals 2/4/5, §4.2 "app (console)", §8 B4/B5/B6). The seam contract is `docs/superpowers/plans/2026-10-22-1color-00-interfaces.md` (§0, §4, §7.2, §8.1, §9). Pinned specs: `docs/design/brc-0162-1color.pinned.md` (cited **0162**) and `docs/design/brc-0207-1color-wallet-module.pinned.md` (cited **0207**).

All paths below are relative to the worktree `/Users/personal/git/demos/mandala-wt/1color` (branch `feat/1color`). Unless stated otherwise, every command runs in `/Users/personal/git/demos/mandala-wt/1color/app`.

## Global Constraints

- Work only in `app/` of the worktree `/Users/personal/git/demos/mandala-wt/1color` on branch `feat/1color`. Do not touch `lib/`, `overlay-go/`, `overlay/`, `fuelkeeper/` or any other checkout. Do not modify `lib/` even when an app test exposes a lib gap. Record the gap in the task report instead.
- Commit locally after every task. Never push, tag, merge or publish. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree discipline (contract §10): P-GO, P-LIB and P-APP share the branch. Every commit is pathspec-scoped, `git commit -m "…" -- app/`, and stages nothing outside `app/`. On an `index.lock` collision, wait a few seconds and retry; never delete the lock. P-APP never runs `npm install` or `npm run build` in `lib/`. It only reads `lib/dist`, which P-LIB Task 23 builds.
- Token amounts are `bigint` everywhere: state, props, cache, guards, optimistic updates. Per output the range is 1..2^64-1 (`MAX_UINT64`). Sums, balances and supply are unbounded (0162:143). Never call `Number()`, `parseInt`, `parseFloat` or `Math.*` on an amount. The only exception is the final percentage in `reserveRatioPct`.
- When an amount crosses JSON (localStorage, query keys, logs) it is a canonical decimal string matching `0|[1-9][0-9]*` (contract §0). A `bigint` must never reach `JSON.stringify` or a React Query `queryKey`.
- `dec` is an integer from 0 to 18 (0162:246-252). `sym` is 1..32 code points and `label` is 1..64 code points. These are the overlay `detLabel` rules (`overlay-go/internal/mandala/details.go:289-335`).
- Import contract §8.1 names from the root `'@bsv/mandala'`. Keep subpath imports (`@bsv/mandala/history`, `/adminState`, `/overlayActivity`, `/adminHistory`, `/banking`, `/submitGuards`, `/singleFlight`, `/adminAuthGate`, `/contacts`, `/contactsStore`, `/registry`, `/reconcile`, `/notifyJournal`, `/feeRate`, `/assetRecover`, `/metadata`, `/assets`) only for modules the contract does not remove.
- **Lib-mismatch policy:** Task 2's surface test is the arbiter.
  - A missing contract §8.1 name means P-LIB Task 23 has not landed, or `lib/dist` is stale. Stop the whole plan and report BLOCKED.
  - A non-contract subpath name that only moved or was renamed: adapt the import and note it in the commit body.
  - A non-contract **pure** helper (`submitGuards`, `banking`) that still types an amount as `number`: implement the bigint equivalent app-local in `src/lib/mandala/compat.ts` with a unit test, and note it.
  - A **network reader** (`history`, `adminState`, `overlayActivity`, `adminHistory`, `metadata`) that still types an amount as `number`: stop that task and report BLOCKED with the field list. Do not widen it in the app.
- No backward compatibility. Do not keep or migrate the old `mandala-tokens` or `'p mandala'` baskets, `[2,'p mandala token']` keys, the old localStorage shapes or v1/v2 MessageBox bodies.
- S5: if the overlay identity key is missing or invalid, the app refuses to start its wallet flows.
- Stability mandate: reason through crash, double-click, multi-tab, stale cache and retry for every pipeline change. Every task that touches a pipeline states its reasoning in the commit body.
- `@bsv/templates` `Bsv21Token.ts` is not touched (it is not in this repo; listed for completeness). BSV Chronicle: the app never normalizes or rejects signatures. It only consumes lib verdicts.
- Do not add a fuel or fee path (B6). The console no longer writes `feeRatePerKb` at register. The admin `setFeeRate` control stays.

## Review Focus

1. **uint64 boundary input and display.** Typing `18446744073709551615` at `dec` 0, or pressing Max on a balance of `MAX_UINT64` at `dec` 18, must show, round-trip and submit the exact value. One more unit must be refused rather than wrapped or rounded. Pinned by Task 3 `round-trips MAX_UINT64 at dec 0 and 18` and `refuses 2^64`.
2. **Crash or tab close between sign → deliver, or between deliver → settle.** The lib journal already holds the exact bytes (stage `signed` or `delivered`). The next app load runs `drainNow`: `reconcileNotifications` redelivers a `signed` entry older than 60 s and promotes it, then `reconcileWallet` settles every `delivered` entry from the journaled bytes. Nothing re-signs, and the app keeps no second copy. Pinned by Task 8 `runs markSelf → redeliver → reconcile in that order, reconcile with sweep:false` and `never calls deliver, settle, abortAction or storage itself`.
3. **Double-click Send and two open tabs.** The result is one `sendHandover`, and at most one app-initiated settle per hand-over at a time. A second drain in the same tab or another tab is skipped, and the immediate send leg waits for the same web lock. Pinned by Task 8 `concurrent drains: the second is skipped`, Task 9 `deliver and settle run inside the handover lock`, and Task 9 `sendFlight is acquired before sendAndDeliver`.
4. **Overlay unreachable versus final refusal at post-ACK settle.**
   - A transport failure or `retry` leaves the journal entry `delivered`. The coin stays unsettled. The app's drain interval backs off (15 s doubling to 15 min) so the lib's `RETRY_CAP` (20) is not burned by a short outage.
   - A final `refused`: the lib aborts once and drops the entry (plan 04 Task 13). The app never calls `abortAction`. On the immediate send leg it shows the code. On the recovery path the restored balance shows the outcome (contract gap A14).
   - Pinned by Task 8 `backoff grows while hand-overs remain and resets when the journal empties`, and Task 9 `refused shows the code and does not abort`.
5. **A bigint reaching JSON.** The mock bank feed persists to localStorage, and React Query keys are hashed with `JSON.stringify`. A `bigint` there throws `TypeError`, which the user sees as a blank page or a lost record. Pinned by Task 13 `serializeTransfers round-trips MAX_UINT64 as a decimal string` and Task 6 `query keys are JSON-safe`. The app no longer persists hand-overs at all (Task 14 residue scan bans the old key prefix `mandala.app.handover.`).

## Contract assumptions (gaps in plan 00; reported upstream, numbered A1–A11)

- **A1** *Resolved in Revision 2 (§8.1:537-541).* The lib exports `journalListHandovers`, `markHandoverDelivered` and `resubmitDelivered`, and its journal is the only hand-over store. Decision: the app keeps no queue. `drainHandovers` (Task 8) only schedules the lib's recovery: `reconcileNotifications` is the single redelivery path, and `reconcileWallet` is the single settle-recovery path. The app's own per-entry work is limited to marking crashed self-sends delivered (A13). `journalListHandovers` is otherwise read-only, used for the backoff and the "awaiting" count. Why not iterate the journal in the app: `reconcileWallet` already resubmits every `delivered` entry (plan 04 Task 15). `reconcileNotifications` must keep running anyway, because it is the only retry for payout and reissue notifications (A2). An app iteration would therefore be a second engine over the same txids.
- **A2** *Resolved in Revision 2 (§8.1:553-554).* `payoutTokens` returns `PayoutResult extends AdmissionReceipt { txid, receipt, outputIndex: 0, notified }`, with no `nextAuth*` fields. A failed delivery is journaled and retried by `reconcileNotifications` (via `drainNow`).
- **A3** Contract §8.1 does not list the subpath modules the console uses. The app assumes their names and paths are unchanged and that every token amount in them is `bigint`:
  - `HistoryRow.amount`
  - `AssetAdminStateView.frozenOutpoints[].amount`
  - `ActivityEntry.amount`
  - `AdminHistoryRow.delta`
  - `AdminSummary.totalIssued` / `totalRedeemed`
  - `MockTransfer.amount`
  - the `reconcile()` fields
  - the guard inputs (`guardPositiveAmount`, `SendSubmitInput`, `IssueRedeemSubmitInput`)
  - `ftOutput.amount`

  Task 2 enforces this under the lib-mismatch policy.
- **A4** *Updated for Revision 2 (§8.1:493).* `formatAmount` is pinned: exact plain decimal, trailing zeros trimmed, no grouping, `-` for negatives, `RangeError` when dec is outside 0..18. `plainAmount` delegates to it. The app owns only grouping (`displayAmount`) and currency prefixes (Task 3). `parseAmount` throws, and the app wraps it as `safeParseAmount`.
- **A5** There is no lib helper for the `p color balance <assetTag>` / `p color assets` selectors or the state tags (§8.1:572). The app builds them from `assetTag` and 0207:606-697.
- **A6** *Resolved in Revision 2 (§8.1:572).* `p color balance` includes `color_offline` available outputs (0207:396-404, C40). `color_state_pending` records are excluded. The app shows `unsettled` (`color_offline` ∧ `color_state_available`) as "of which awaiting settlement" under the balance, and `incoming` (`color_state_pending`) as a separate "Incoming" line. It never sums either into the hero number.
- **A7** `robustness.wiring.test.ts` stops scanning `lib/src`. Those invariants are P-LIB's to test (§8.1:570).
- **A8** *Resolved in Revision 2 (§8.1:536).* `MessageBoxSender` is exported as a type. The app uses `type Sender = MessageBoxSender`.
- **A9** *Resolved in Revision 2 (§8.1:570).* `ReconcileOptions { sweep?: boolean }` is in the contract, and the sweep is skipped automatically while any `signed`/`delivered` entry exists. The app still passes `{ sweep: false }` (defence in depth), and only from `drainHandovers`.
- **A10** `registerAsset` has no `feeRatePerKb` (B6). `setFeeRate` in `@bsv/mandala/feeRate` stays.
- **A11** `guardRegisterSubmit` does not enforce dec ≤ 18 or the sym/label lengths, so the app validates them locally (Task 12).
- **A12** The contract types `resubmitDelivered(...)` as `Promise<void>`, while plan 04 Task 13 returns a verdict union. The app does not call it: `reconcileWallet` uses it internally, and the immediate leg uses `settleHandover`, whose verdict is pinned in both places.
- **A13** A self-send (`recipientKey === identityKey`) has no MessageBox leg. `sendAndDeliver` calls `markHandoverDelivered` before settling. If the tab dies between sign and that call, the entry stays `signed`. `reconcileNotifications` would then redeliver it to the sender's own box after 60 s, and `reconcileWallet` never settles a `signed` entry. Decision: `drainHandovers` first marks every `signed` entry with `recipientKey === identityKey` delivered. Reported upstream: the lib should treat self entries as delivered itself.
- **A14** `ReconcileResult` has no per-txid verdict for `delivered` entries (today: `rebroadcast`, `aborted`, `resubmitted`, `stranded`, `swept`, `skipped`; plan 04 Task 15 adds `handoversAwaitingDelivery`). A refusal found on the recovery path is therefore not shown with its code. The released coins reappear in the balance, and the drain logs the `ReconcileResult`. Reported upstream: a `refused: Array<{ txid, code }>` field.
- **A15** The app reads only `txid`, `stage`, `recipientKey` and `at` from `HandoverJournalEntry` (plan 04 Task 13 `JournalEntry`). It types entries as `Awaited<ReturnType<typeof journalListHandovers>>[number]`, so a type rename does not break it.
- **A16** Plan 04 Task 13 does not define what happens when `settleHandover` runs for a txid whose entry another path has already removed, for example a second final verdict with no `reference` left to abort. The app never creates that race. Its immediate settle and its drain run under one web lock, `mandala.app.handovers`, and the lib's `mandala.reconcile` lock serializes `reconcileWallet` across tabs.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/mandala/amountDisplay.ts` (new) | Pure bigint display and parse helpers: `plainAmount`, `displayAmount`, `formatCurrency`, `currencySymbol`, `safeParseAmount`, `reserveRatioPct`. |
| `src/lib/mandala/config.ts` (new) | Reads the env and fails closed (S5). |
| `src/lib/mandala/holderBalances.ts` (new) | BRC-207 selectors, `parseBalanceTotal`, inventory summary, frozen units, paginated `listAllOutputs`. |
| `src/lib/mandala/treasury.ts` (new) | Treasury sums over `TREASURY_BASKET`. |
| `src/lib/mandala/loadHolderData.ts` (new) | Assembles holder rows (exact balance, unsettled, incoming, metadata, holder-scope history). |
| `src/lib/mandala/handoverDrain.ts` (new) | No storage. The `drainHandovers` scheduler over the lib journal (single-flight, web lock, in-memory backoff), `withHandoverLock`, and `backoffMs`. |
| `src/lib/mandala/sendPipeline.ts` (new) | `sendAndDeliver` (send → deliver or mark self → post-ACK settle under the lock, B5) and `explainSendError`. |
| `src/lib/mandala/receiveView.ts` (new) | Pure presentation of received hand-overs. |
| `src/lib/mandala/registerForm.ts` (new) | Deploy field validation (dec, sym, label). |
| `src/lib/mandala/feeRateInput.ts` (new; moved from RegisterAssetStrip) | `parseFeeRateInput`. |
| `src/lib/mandala/mockBankStore.ts` (modify) | bigint feed persisted as decimal strings. |
| `src/hooks/useHolderData.ts`, `useTreasuryBalances.ts` (new), `useSendMutation.ts`, `usePayoutMutation.ts` (new), `useIssuerMutations.ts` | React Query wiring. |
| components (modify) | bigint props and display. `AccountsOverview.tsx` and its test are deleted (dead code: nothing imports it). |
| `src/libSurface.test.ts` (new) | Pins the lib 0.5.0 surface the app consumes. |
| `src/robustness.wiring.test.ts` (modify) | App-source wiring only. The lib-source scans move out (P-LIB owns them). |

---

### Task 1: Baseline and prerequisites (no code change)

**Files:** none.

**Interfaces:**
- Consumes: the P-LIB Task 23 landing (commit `chore(lib): @bsv/mandala 0.5.0 gate + vendored tarball`, a built `lib/dist`, and `vendor-ts-stack/bsv-mandala-0.5.0-*.tgz`; contract §10 "P-LIB Task 23 (built `lib/dist` + V3 tarball)→APP"), and the vendored tarballs in `vendor-ts-stack/` (contract §9).
- Produces: a baseline record in the task report (pass/fail per test file, `tsc` error count). Later tasks use it to tell regressions from pre-existing breakage.

The lib version string is **not** a readiness signal. P-LIB sets `0.5.0` in its first commit, but the API the app consumes lands in Tasks 12–17, and `lib/dist` is only guaranteed fresh after Task 23.

- [ ] **Step 1: Check branch and prerequisites**

Run:
```bash
cd /Users/personal/git/demos/mandala-wt/1color
git branch --show-current
git log --format=%s feat/1color -- lib vendor-ts-stack | grep -c -F 'chore(lib): @bsv/mandala 0.5.0 gate + vendored tarball'
git log --format=%s feat/1color -- lib | grep -c -F '0.5.0 client facade and export surface'
ls vendor-ts-stack/bsv-mandala-0.5.0-*.tgz vendor-ts-stack/bsv-sdk-4.0.0-*.tgz vendor-ts-stack/bsv-templates-2.2.0-*.tgz
```
Expected: `feat/1color`, both counts ≥ 1, and one tarball each for `bsv-mandala-0.5.0-*`, `bsv-sdk-4.0.0-*` and `bsv-templates-2.2.0-*`.
- If either count is 0, or any tarball is missing (a V0-only `2.1.0` templates tarball does not count), stop and report BLOCKED: "APP needs P-LIB Task 23 (built lib/dist + V3 tarball) and the V1 tarballs (contract §10: … LIB-profile → V3 → APP)".

- [ ] **Step 2: Verify the built lib the app resolves (read-only)**

The app resolves `@bsv/mandala` through the symlink `app/node_modules/@bsv/mandala -> ../lib`, with types and code from `lib/dist`. P-APP never installs or builds in `lib/` (contract §10).

Run:
```bash
cd /Users/personal/git/demos/mandala-wt/1color
test -f lib/dist/index.js && test -f lib/dist/index.d.ts && echo DIST_OK
node --input-type=module -e "const m = await import('./lib/dist/index.js'); const need = ['sendHandover','deliverHandover','settleHandover','receiveHandovers','journalListHandovers','markHandoverDelivered','payoutTokens','createMandalaClient','formatAmount']; const miss = need.filter(n => typeof m[n] !== 'function'); console.log(miss.length ? 'MISSING ' + miss.join(',') : 'SURFACE_OK')"
```
Expected: `DIST_OK` and `SURFACE_OK`.
- If `lib/dist` is missing, or any name is missing, stop and report BLOCKED with the missing list. Do not build the lib yourself.

- [ ] **Step 3: Record the app baseline**

Run: `npx vitest run 2>&1 | tail -40` and `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -c 'error TS'`

Record which files fail and the error count.
- Reference point: at `45deec9`, before lib 0.5.0, the result was **17 files / 59 tests, all passing**.
- After lib 0.5.0 lands, these failures are expected and pre-existing: files that import removed exports (`decodeValue`, `BASKET`, `/transfer`, `/receive`, `/tokens`, `formatAmountPlain`) and the lib-source scans in `robustness.wiring.test.ts`.

- [ ] **Step 4: No commit** (nothing changed). Paste the baseline into the task report.

---

### Task 2: Vendored dependencies, dedupe, Docker context, lib surface pin

**Files:**
- Modify: `app/package.json`, `app/package-lock.json`, `app/vite.config.ts`, `app/vitest.config.ts`, `app/Dockerfile`
- Create: `app/src/libSurface.test.ts`. Create `app/.npmrc` only if Step 4 hits ERESOLVE.
- Modify: `app/src/robustness.wiring.test.ts` (remove every assertion that reads `lib/src`: the `lib()` helper and its callers; keep the app-source ones)

**Interfaces:**
- Consumes: contract §8.1 and §9.
- Produces: an app that resolves exactly one `@bsv/sdk` (4.0.0) and one `@bsv/templates` (2.2.0); `libSurface.test.ts` as the arbiter under the lib-mismatch policy.

- [ ] **Step 1: Write the failing surface test** `src/libSurface.test.ts`

```ts
import * as M from '@bsv/mandala'
import { readFileSync } from 'node:fs'
// Read the installed manifests by path: an `exports` map may not expose ./package.json.
// app/src → ../node_modules (the @bsv/mandala entry is the symlink to ../lib).
const pkgOf = (name: string): { version: string } =>
  JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'))
const sdkPkg = pkgOf('@bsv/sdk'), tplPkg = pkgOf('@bsv/templates'), libPkg = pkgOf('@bsv/mandala')
const ID = 'a'.repeat(64) + '_0'
it('resolves the vendored stack', () => {
  expect(sdkPkg.version).toBe('4.0.0'); expect(tplPkg.version).toMatch(/^2\.2\./); expect(libPkg.version).toBe('0.5.0')
})
it('exposes the contract §8.1 constants verbatim', () => {
  expect(M.TOPIC).toBe('tm_mandala'); expect(M.REGISTRY_TOPIC).toBe('tm_mandala_kyc')
  expect(M.MESSAGEBOX).toBe('mandala-color'); expect(M.TREASURY_BASKET).toBe('mandala treasury')
  expect(M.MANDALA_PROFILE_ID).toBe('https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md')
  expect(M.ATTESTED_PROFILE_ID).toBe('https://brc.dev/207/attested')
  expect(M.colorTopic(ID)).toBe('tm_color_' + ID); expect(M.colorLookup(ID)).toBe('ls_color_' + ID)
  expect(M.assetTag(ID)).toBe('a'.repeat(64) + 'v0'); expect(M.MAX_UINT64).toBe(2n ** 64n - 1n)
  expect(M.parseAmount('1234.56', 2)).toBe(123456n); expect(() => M.parseAmount('18446744073709551616', 0)).toThrow()
  // §8.1:493 pins formatAmount: plain, trimmed, no grouping, RangeError outside 0..18
  expect(M.formatAmount(M.MAX_UINT64, 18)).toBe('18.446744073709551615'); expect(M.formatAmount(100n, 2)).toBe('1')
  expect(() => M.formatAmount(1n, 19)).toThrow(RangeError)
})
it('exposes the functions the app calls', () => {
  for (const f of ['configureMandala','decodeToken','sendHandover','deliverHandover','settleHandover','receiveHandovers',
    'journalListHandovers','markHandoverDelivered',
    'registerAsset','issueTokens','payoutTokens','redeemTokens','submitAdminAction','listAdminAssets','formatAmount'])
    expect(typeof (M as any)[f]).toBe('function')
})
it('keeps the lib recovery entry points drainHandovers schedules', async () => {
  expect(typeof (await import('@bsv/mandala/reconcile')).reconcileWallet).toBe('function')
  expect(typeof (await import('@bsv/mandala/notifyJournal')).reconcileNotifications).toBe('function')
})
it('no longer exports the removed names', () => {
  for (const n of ['BASKET','FT_PROTOCOL','MAX_SAFE_AMOUNT','tokenTopic','decodeValue','transferTokens','receiveTokens','cover'])
    expect((M as any)[n]).toBeUndefined()
})
it('keeps the non-contract subpaths the console uses, bigint-typed', async () => {
  const g = await import('@bsv/mandala/submitGuards')
  expect(g.guardPositiveAmount(1n as any).ok).toBe(true); expect(g.guardPositiveAmount(0n as any).ok).toBe(false)
  for (const p of ['history','metadata','adminState','adminHistory','overlayActivity','banking','singleFlight',
    'adminAuthGate','contacts','contactsStore','registry','reconcile','notifyJournal','feeRate','assetRecover','assets'])
    await expect(import(`@bsv/mandala/${p}`)).resolves.toBeDefined()
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/libSurface.test.ts`
Expected: FAIL. `sdkPkg.version` is `2.8.11` (app still on registry sdk) and `tplPkg.version` is `2.0.0`.

- [ ] **Step 3: Switch dependencies**

In `app/package.json` `dependencies`:
- `"@bsv/sdk": "file:../vendor-ts-stack/bsv-sdk-4.0.0-<sha>.tgz"`
- `"@bsv/templates": "file:../vendor-ts-stack/bsv-templates-2.2.0-<sha>.tgz"`

Use the exact file names from Task 1. Add the top-level `"overrides": { "@bsv/sdk": "$@bsv/sdk", "@bsv/templates": "$@bsv/templates" }`. `@bsv/mandala` stays `file:../lib`.

In both `vite.config.ts` and `vitest.config.ts`, add `resolve.dedupe: ['@bsv/sdk', '@bsv/templates', '@bsv/message-box-client']`. This makes lib code under `../lib/dist` use the app's single copy.

In `Dockerfile`, add `COPY vendor-ts-stack vendor-ts-stack` as the first `COPY` after `WORKDIR /src`. Both lib and app install from it.

- [ ] **Step 4: Install**

Run: `npm install`
Expected: exit 0.
- If npm reports ERESOLVE on the peer ranges of `@bsv/message-box-client` (`^2.8.6`) or `@bsv/authsocket-client`, create `app/.npmrc` with `legacy-peer-deps=true` and rerun. Record this in the commit body.

- [ ] **Step 5: Strip the lib-source scans**

In `src/robustness.wiring.test.ts`, delete the `libSrc`/`lib()` helpers and every assertion that calls `lib(...)`. Those invariants belong to P-LIB's suite. Keep each `it` whose remaining assertions read only `src(...)`; delete an `it` whose body becomes empty. Leave the app assertions that later tasks rewrite untouched for now.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `npx vitest run src/libSurface.test.ts`
Expected: PASS. If it does not, apply the lib-mismatch policy (Global Constraints).

Run: `npx vitest run src/robustness.wiring.test.ts`
Expected: only the app assertions that Tasks 9 and 12 rewrite fail. List them in the report.

- [ ] **Step 7: Commit**

```bash
cd /Users/personal/git/demos/mandala-wt/1color
git add app/package.json app/package-lock.json app/vite.config.ts app/vitest.config.ts app/Dockerfile app/src/libSurface.test.ts app/src/robustness.wiring.test.ts
git add app/.npmrc 2>/dev/null; git commit -m "build(app): vendored sdk 4.0.0 + templates 2.2.0, pin @bsv/mandala 0.5.0 surface" -- app/
```

Every later commit uses the same shape: `git add <app files>` then `git commit -m "<message>" -- app/` (Global Constraints).

---

### Task 3: bigint amount display and parse helpers

**Files:**
- Create: `src/lib/mandala/amountDisplay.ts`
- Test: `src/lib/mandala/amountDisplay.test.ts`

**Interfaces:**
- Consumes: `parseAmount(text: string, dec: number): bigint`, `formatAmount(units: bigint, dec: number): string` (§8.1:493-494) and `MAX_UINT64` from `'@bsv/mandala'`.
- Produces:
  - `currencySymbol(ticker?: string): string`
  - `plainAmount(units: bigint, dec: number): string`
  - `displayAmount(units: bigint, dec: number): string`
  - `formatCurrency(units: bigint, dec: number, ticker?: string): string`
  - `safeParseAmount(text: string, dec: number): bigint | null`
  - `reserveRatioPct(bank: bigint, circulation: bigint): number | null`

- [ ] **Step 1: Write the failing tests**

```ts
const MAX = 2n ** 64n - 1n
it('plainAmount trims the fraction and never groups', () => {
  expect(plainAmount(0n, 2)).toBe('0'); expect(plainAmount(123450n, 3)).toBe('123.45'); expect(plainAmount(5n, 2)).toBe('0.05')
  expect(plainAmount(-5n, 2)).toBe('-0.05'); expect(plainAmount(MAX, 0)).toBe('18446744073709551615')
  expect(plainAmount(MAX, 18)).toBe('18.446744073709551615')
})
it('displayAmount groups the whole part with commas, locale-independent', () => {
  expect(displayAmount(MAX, 0)).toBe('18,446,744,073,709,551,615'); expect(displayAmount(123456789n, 2)).toBe('1,234,567.89')
  expect(displayAmount(-100000n, 0)).toBe('-100,000'); expect(displayAmount(100n, 2)).toBe('1')
})
it('formatCurrency prefixes the ticker symbol', () => {
  expect(formatCurrency(150n, 2, 'usd')).toBe('$1.5'); expect(formatCurrency(1n, 0, 'TUSD')).toBe('TUSD 1'); expect(formatCurrency(1n, 0)).toBe('1')
})
it('rejects dec outside 0..18', () => { expect(() => plainAmount(1n, 19)).toThrow(RangeError); expect(() => displayAmount(1n, -1)).toThrow(RangeError) })
it('safeParseAmount returns null instead of throwing', () => {
  expect(safeParseAmount('1.5', 2)).toBe(150n); expect(safeParseAmount(' 7 ', 0)).toBe(7n)
  for (const bad of ['', '  ', 'abc', '1.555', '-1', '1e3']) expect(safeParseAmount(bad, 2)).toBeNull()
})
it('round-trips MAX_UINT64 at dec 0 and 18', () => {
  for (const d of [0, 2, 18]) for (const x of [0n, 1n, MAX]) expect(safeParseAmount(plainAmount(x, d), d)).toBe(x)
})
it('refuses 2^64', () => { expect(safeParseAmount('18446744073709551616', 0)).toBeNull(); expect(safeParseAmount('18.446744073709551616', 18)).toBeNull() })
it('reserveRatioPct uses integer math, clamps to 0..100, null without circulation', () => {
  expect(reserveRatioPct(50n, 100n)).toBe(50); expect(reserveRatioPct(1n, 3n)).toBe(33.33); expect(reserveRatioPct(200n, 100n)).toBe(100)
  expect(reserveRatioPct(-5n, 100n)).toBe(0); expect(reserveRatioPct(5n, 0n)).toBeNull(); expect(reserveRatioPct(MAX * 3n, MAX * 4n)).toBe(75)
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/amountDisplay.test.ts`
Expected: FAIL with "Failed to resolve import ./amountDisplay".

- [ ] **Step 3: Implement `src/lib/mandala/amountDisplay.ts`**

- Keep the symbol table `USD $`, `EUR €`, `GBP £`, `CHF 'CHF '`; any other ticker becomes `TICKER ` (uppercase plus a space).
- `plainAmount` is `formatAmount(units, dec)` from `'@bsv/mandala'` (pinned plain, trimmed, ungrouped, `RangeError` outside 0..18). The tests above double as a conformance check of the lib function.
- `displayAmount` = `plainAmount` with the whole part grouped by a regex every 3 digits.
- `safeParseAmount`: trim the text, return `null` when it is empty, otherwise `try { parseAmount(t, dec) } catch { null }`.
- `reserveRatioPct`: `circulation <= 0n` gives `null`. Otherwise compute `basisPoints = max(0n, bank) * 10000n / circulation`, cap it at `10000n`, and return `Number(basisPoints) / 100`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/amountDisplay.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/mandala/amountDisplay.ts app/src/lib/mandala/amountDisplay.test.ts
git commit -m "feat(app): exact bigint amount display/parse helpers"
```

---

### Task 4: Fail-closed configuration, no basket, registry topic copy

**Files:**
- Create: `src/lib/mandala/config.ts`, test `src/lib/mandala/config.test.ts`
- Modify: `src/main.tsx`, `src/context/WalletContext.tsx`, `src/components/issuer/IdentityRegistry.tsx` (copy only), `app/.env.example`, `src/robustness.wiring.test.ts` (one new `it`)

**Interfaces:**
- Consumes: `configureMandala(e: { overlayUrl?, overlayIdentityKey?, messageBoxUrl?, adminApiToken?, storage? })` from `'@bsv/mandala'` (there is no `basket` option), and `REGISTRY_TOPIC`.
- Produces:
  - `interface AppMandalaConfig { overlayUrl: string; overlayIdentityKey: string; messageBoxUrl: string; adminApiToken: string }`
  - `readMandalaConfig(env: Record<string, string | undefined>): { ok: true; config: AppMandalaConfig } | { ok: false; reason: string }`
  - `WalletProvider` gains the prop `configError?: string | null`. `WalletState` gains `overlayIdentityKey: string | null`, which Task 9 needs for settle.

- [ ] **Step 1: Write the failing tests**

```ts
const K = '02' + 'ab'.repeat(32)
const good = { VITE_OVERLAY_URL: 'http://localhost:8082', VITE_OVERLAY_IDENTITY_KEY: K, VITE_MESSAGEBOX_URL: 'https://mb.example' }
it('accepts a complete config', () => { const r = readMandalaConfig(good); expect(r).toEqual({ ok: true, config: { overlayUrl: 'http://localhost:8082', overlayIdentityKey: K, messageBoxUrl: 'https://mb.example', adminApiToken: '' } }) })
it.each([
  [{ ...good, VITE_OVERLAY_IDENTITY_KEY: undefined }, 'VITE_OVERLAY_IDENTITY_KEY'],
  [{ ...good, VITE_OVERLAY_IDENTITY_KEY: 'paste_identity_key_from_overlay-go_boot_log' }, 'VITE_OVERLAY_IDENTITY_KEY'],
  [{ ...good, VITE_OVERLAY_IDENTITY_KEY: K.toUpperCase() }, 'VITE_OVERLAY_IDENTITY_KEY'],
  [{ ...good, VITE_OVERLAY_IDENTITY_KEY: '04' + 'ab'.repeat(32) }, 'VITE_OVERLAY_IDENTITY_KEY'],
  [{ ...good, VITE_OVERLAY_URL: '' }, 'VITE_OVERLAY_URL'],
  [{ ...good, VITE_OVERLAY_URL: 'ftp://x' }, 'VITE_OVERLAY_URL'],
  [{ ...good, VITE_MESSAGEBOX_URL: undefined }, 'VITE_MESSAGEBOX_URL']
])('fails closed (S5): %#', (env, name) => { const r = readMandalaConfig(env); expect(r.ok).toBe(false); expect((r as any).reason).toContain(name) })
// in robustness.wiring.test.ts:
it('main.tsx configures no basket and gates on readMandalaConfig', () => {
  const m = src('main.tsx'); expect(m).not.toMatch(/basket\s*:/); expect(m).not.toContain("'p mandala'"); expect(m).toContain('readMandalaConfig(')
  expect(src('context/WalletContext.tsx')).toContain('configError')
  expect(src('components/issuer/IdentityRegistry.tsx')).not.toContain('tm_mandala_registry')
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/config.test.ts src/robustness.wiring.test.ts`
Expected: FAIL. `config.ts` is unresolved, and `main.tsx` still contains `basket:`.

- [ ] **Step 3: Implement the config gate**

- `readMandalaConfig` checks the key `/^0[23][0-9a-f]{64}$/` (lowercase, compressed; contract §0) and the URLs via `new URL()` with protocol `http:` or `https:`. It reports the first failing variable name in `reason`, e.g. `"VITE_OVERLAY_IDENTITY_KEY must be the overlay's 66-hex compressed identity key"`.
- `main.tsx` calls `readMandalaConfig(import.meta.env)`. On `ok` it calls `configureMandala(config)` with no `basket`. It renders `<WalletProvider configError={r.ok ? null : r.reason}>`.
- `WalletProvider`: with a non-null `configError`, set state `{ isInitialized: true, error: configError }` and never construct `WalletClient`. Otherwise:
  - `overlayIdentityKey = config key`, and `isIssuer = identityKey === overlayIdentityKey`.
  - Change the startup `reconcileWallet(wallet)` call to `reconcileWallet(wallet, { sweep: false })`. Hand-overs are long-lived `noSend` actions, and the sweep must never abort one (0207:418-423; contract D27, §8.1:570). This is temporary. Task 9 deletes both direct startup calls (`reconcileWallet` at `WalletContext.tsx:54` and `reconcileNotifications` at `:63`) and replaces them with one `drainNow()`, so the app has a single recovery path.
- `IdentityRegistry.tsx`: replace the literal `tm_mandala_registry` in the copy with `{REGISTRY_TOPIC}`.
- `.env.example`: comment above the key line, "REQUIRED. The app refuses to start without the overlay's identity key (fail closed)."

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/config.test.ts src/robustness.wiring.test.ts -t "config|main.tsx"`
Expected: PASS.

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'src/(main|context/WalletContext|lib/mandala/config)' || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

Commit message `feat(app): fail closed without overlay identity key; drop 'p mandala' basket config`. In the body, give the reasoning for `sweep: false`.

---

### Task 5: BRC-207 holder selectors, inventory summary, treasury sums

**Files:**
- Create: `src/lib/mandala/holderBalances.ts`, `src/lib/mandala/treasury.ts`
- Test: `src/lib/mandala/holderBalances.test.ts`, `src/lib/mandala/treasury.test.ts`

**Interfaces:**
- Consumes: `assetTag`, `decodeToken(script: string, txid?: string, vout?: number): DecodedToken | null`, `TREASURY_BASKET` from `'@bsv/mandala'`; `AssetAdminStateView` from `@bsv/mandala/adminState`.
- Produces:
  - `INVENTORY_SELECTOR = 'p color assets'` (0207:608-612)
  - `OFFLINE_TAG = 'color_offline'`, `AVAILABLE_TAG = 'color_state_available'`, `PENDING_TAG = 'color_state_pending'` (0207:396-404, 649)
  - `balanceSelector(assetId: string): string`, which returns `` `p color balance ${assetTag(assetId)}` `` (0207:611)
  - `parseBalanceTotal(total: unknown): bigint`
  - `interface InventoryRecord { outpoint: string; lockingScript?: string; tags?: string[] }`
  - `interface InventorySummary { unsettled: bigint /* color_offline AND color_state_available: already inside p color balance */; incoming: bigint /* color_state_pending: not in p color balance */ }`
  - `summarizeInventory(records: InventoryRecord[], decode?: typeof decodeToken): Map<string, InventorySummary>`

The two figures have different balance semantics (contract §8.1:572, 0207:396-404, C40). `p color balance` already counts `color_offline` available outputs, so `unsettled` is a **subset** of the balance. `color_state_pending` records are excluded from it, so `incoming` is **outside** the balance. They are never summed with each other or with the balance. A `color_offline` record that is reserved or restricted adds to neither. A pending one (with or without `color_offline`) counts only toward `incoming`.
  - `frozenUnitsFor(state: Pick<AssetAdminStateView, 'frozenOutpoints'> | null | undefined, identityKey: string | null): bigint`
  - `listAllOutputs(wallet: Pick<WalletInterface, 'listOutputs'>, args: ListOutputsArgs, pageSize?: number): Promise<WalletOutput[]>`
  - `sumTreasury(records: InventoryRecord[], decode?: typeof decodeToken): Record<string, bigint>`
  - `type TreasuryData = Record<string, bigint>`
  - `loadTreasuryBalances(wallet: Pick<WalletInterface, 'listOutputs'>): Promise<TreasuryData>`

- [ ] **Step 1: Write the failing tests**

Build fixture scripts with `new OneColor().lock(ID, amount, new Array(20).fill(7)).toHex()` from `@bsv/templates`.

```ts
const MAX = 2n ** 64n - 1n
it('parseBalanceTotal accepts the BRC-112 decimal string and plain counts (0207:687)', () => {
  expect(parseBalanceTotal('18446744073709551615')).toBe(MAX); expect(parseBalanceTotal('36893488147419103230')).toBe(2n * MAX)
  expect(parseBalanceTotal('0')).toBe(0n); expect(parseBalanceTotal(5)).toBe(5n)
  for (const bad of ['01', '-1', '1.0', '', ' 1', -1, 1.5, NaN, null, undefined]) expect(() => parseBalanceTotal(bad)).toThrow()
})
it('balanceSelector uses the assetTag form', () => { expect(balanceSelector(ID)).toBe(`p color balance ${'c'.repeat(64)}v0`) })
it('summarizeInventory splits unsettled (in balance) from incoming (not in balance)', () => {
  const m = summarizeInventory([
    { outpoint: `${'1'.repeat(64)}.0`, lockingScript: lock(ID, 7n), tags: ['color_state_available'] },                  // settled, neither
    { outpoint: `${'5'.repeat(64)}.0`, lockingScript: lock(ID, MAX), tags: ['color_state_available', 'color_offline'] }, // unsettled
    { outpoint: `${'6'.repeat(64)}.0`, lockingScript: lock(ID, 2n), tags: ['color_offline', 'color_state_available'] },  // unsettled (tag order irrelevant)
    { outpoint: `${'2'.repeat(64)}.1`, lockingScript: lock(ID, 5n), tags: ['color_state_pending', 'color_offline'] },    // incoming only
    { outpoint: `${'3'.repeat(64)}.0`, lockingScript: lock(ID2, 9n), tags: ['color_state_reserved', 'color_offline'] },  // neither
    { outpoint: `${'7'.repeat(64)}.0`, lockingScript: lock(ID2, 4n), tags: ['color_state_restricted'] },                 // neither
    { outpoint: `${'4'.repeat(64)}.0`, lockingScript: 'deadbeef', tags: ['color_offline', 'color_state_available'] }])  // undecodable: skipped
  expect(m.get(ID)).toEqual({ unsettled: MAX + 2n, incoming: 5n })
  expect(m.get(ID2)).toEqual({ unsettled: 0n, incoming: 0n }); expect(m.size).toBe(2)
})
it('summarizeInventory never mixes incoming into unsettled at uint64 max', () => {
  const m = summarizeInventory([
    { outpoint: `${'8'.repeat(64)}.0`, lockingScript: lock(ID, MAX), tags: ['color_state_pending'] },
    { outpoint: `${'9'.repeat(64)}.0`, lockingScript: lock(ID, MAX), tags: ['color_state_pending', 'color_offline'] }])
  expect(m.get(ID)).toEqual({ unsettled: 0n, incoming: 2n * MAX })
})
it('frozenUnitsFor sums only rows owned by the identity', () => {
  expect(frozenUnitsFor({ frozenOutpoints: [{ outpoint: 'a.0', amount: MAX, owner: 'me', reason: '' }, { outpoint: 'b.0', amount: 4n, owner: 'me', reason: '' }, { outpoint: 'c.0', amount: 9n, owner: 'x', reason: '' }] } as any, 'me')).toBe(MAX + 4n)
  expect(frozenUnitsFor(null, 'me')).toBe(0n); expect(frozenUnitsFor({ frozenOutpoints: [] } as any, null)).toBe(0n)
})
it('listAllOutputs pages until totalOutputs and errors instead of truncating', async () => {
  const w = fakeWallet(2500)            // returns slices by offset/limit, totalOutputs 2500
  expect((await listAllOutputs(w, { basket: 'x' }, 1000)).length).toBe(2500); expect(w.calls.map(c => c.offset)).toEqual([0, 1000, 2000])
  await expect(listAllOutputs(fakeWallet(100_001), { basket: 'x' }, 1000)).rejects.toThrow('exceeds 100000 outputs')
})
// treasury.test.ts
it('sumTreasury counts value outputs per asset only', () => {
  // deployScript = new OneColor().lock(null, 0n, PKH, payload) (role 'deploy'); garbage rows are skipped
  expect(sumTreasury([rec(lock(ID, MAX)), rec(lock(ID, 1n)), rec(deployScript), rec('00')])).toEqual({ [ID]: MAX + 1n })
  expect(sumTreasury([rec(lock(ID2, 5n))], () => ({ role: 'authority', assetId: ID2, amount: 0n }))).toEqual({})
})
it('loadTreasuryBalances lists TREASURY_BASKET with locking scripts', async () => {
  const w = fakeWallet([...]); await loadTreasuryBalances(w); expect(w.calls[0]).toMatchObject({ basket: 'mandala treasury', include: 'locking scripts' })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/holderBalances.test.ts src/lib/mandala/treasury.test.ts`
Expected: FAIL (modules unresolved).

- [ ] **Step 3: Implement both modules**

- `parseBalanceTotal`: a string must match `/^(0|[1-9][0-9]*)$/`; a number must be a safe non-negative integer (ordinary-basket count); anything else throws.
- Decode a record with `decode(lockingScript, txid, vout)`, splitting the BRC-36 outpoint `txid.vout` (contract §0). A failed decode or a `null` result skips the record. A decode of a deploy or an authority registers the asset with no value.
- For a `role === 'value'` record with tag set `t`: if `t` has `PENDING_TAG`, add the amount to `incoming`. Otherwise, if `t` has both `OFFLINE_TAG` and `AVAILABLE_TAG`, add it to `unsettled`. Otherwise add nothing. Every value record registers its asset.
- `listAllOutputs`: call `listOutputs({ ...args, limit: pageSize, offset })`. Stop when `collected >= Number(totalOutputs)` or a page is empty. Throw `Error('inventory exceeds 100000 outputs')` once 100 pages are reached; never truncate silently (0207:664-666).
- `sumTreasury` counts `role === 'value'` only.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/holderBalances.test.ts src/lib/mandala/treasury.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`feat(app): BRC-207 balance selectors, unsettled/incoming inventory summary, treasury sums`

---

### Task 6: Holder and treasury data hooks

**Files:**
- Create: `src/lib/mandala/loadHolderData.ts`, test `src/lib/mandala/loadHolderData.test.ts`
- Create: `src/hooks/useTreasuryBalances.ts`
- Modify: `src/hooks/useHolderData.ts` (becomes a thin `useQuery` wrapper; re-exports the types)

**Interfaces:**
- Consumes:
  - Task 5 (`INVENTORY_SELECTOR`, `balanceSelector`, `parseBalanceTotal`, `summarizeInventory`, `listAllOutputs`, `loadTreasuryBalances`, `TreasuryData`)
  - `loadHistory(wallet, o?: { scope?: 'treasury' | 'holder' | 'all' }): Promise<HistoryRow[]>` (§8.1; `HistoryRow.amount: bigint`). Holder data passes `{ scope: 'holder' }`, because treasury rows belong to the issuer views.
  - `listAdminAssets`
  - `resolveAssetMetadata(assetId): Promise<AssetMetadata | null>`
- Produces:
  - `interface AssetMeta { label: string; decimals: number; ticker?: string; issuer?: string }`
  - `interface AssetRow { assetId: string; balance: bigint | null; unsettled: bigint; incoming: bigint; meta: AssetMeta }`. `balance === null` means the balance view failed for that asset. `unsettled` is part of `balance`, and `incoming` is not (Task 5).
  - `interface HolderData { assets: AssetRow[]; history: HistoryRow[]; metas: Record<string, AssetMeta> }`
  - `interface HolderDataDeps { loadHistory: typeof loadHistory; listAdminAssets: typeof listAdminAssets; resolveAssetMetadata: typeof resolveAssetMetadata }`
  - `loadHolderData(wallet: Pick<WalletInterface, 'listOutputs'>, deps: HolderDataDeps): Promise<HolderData>`
  - `holderDataKey(identityKey: string | null)`: unchanged, `['holder-data', identityKey]`
  - `useHolderData()`, `useInvalidateHolderData()`: unchanged names
  - `treasuryKey(identityKey: string | null)`, which returns `['treasury', identityKey] as const`
  - `useTreasuryBalances(): UseQueryResult<TreasuryData>`. It is enabled only when `isIssuer`.
  - `useInvalidateTreasury(): () => Promise<void>`

- [ ] **Step 1: Write the failing tests**

Use a fake wallet that routes `listOutputs` by `basket`.

```ts
it('balance comes from the module view, unsettled/incoming from inventory tags, metadata from overlay', async () => {
  // availOffline = tags ['color_state_available','color_offline']; pend = tags ['color_state_pending']
  const w = routeWallet({ 'p color assets': { totalOutputs: 3, outputs: [avail(ID, 7n), availOffline(ID, 4n), pend(ID, 3n)] },
    [balanceSelector(ID)]: { totalOutputs: '18446744073709551615', outputs: [] } })
  const d = await loadHolderData(w, deps({ meta: { [ID]: { label: 'Test Dollar', decimals: 2, ticker: 'TUSD' } } }))
  expect(d.assets).toEqual([{ assetId: ID, balance: 2n ** 64n - 1n, unsettled: 4n, incoming: 3n, meta: { label: 'Test Dollar', decimals: 2, ticker: 'TUSD', issuer: undefined } }])
  expect(w.calls.find(c => c.basket === 'p color assets')).toMatchObject({ include: 'locking scripts', includeTags: true })
})
it('holder history is loaded with scope holder', async () => { const d = deps(); await loadHolderData(routeWallet({ 'p color assets': { totalOutputs: 0, outputs: [] } }), d); expect(d.loadHistory).toHaveBeenCalledWith(expect.anything(), { scope: 'holder' }) })
it('a failing balance view yields balance null for that asset only', async () => {
  const w = routeWallet({ 'p color assets': { totalOutputs: 2, outputs: [avail(ID, 1n), avail(ID2, 1n)] },
    [balanceSelector(ID)]: { totalOutputs: '5', outputs: [] }, [balanceSelector(ID2)]: new Error('ERR_ACCESS') })
  const d = await loadHolderData(w, deps())
  expect(d.assets.map(a => [a.assetId, a.balance])).toEqual([[ID, 5n], [ID2, null]])
})
it('history-only assets appear with balance 0n via the view; non-zero balances sort first', async () => { /* ID2 only in history, view '0' */ })
it('never touches the old baskets', async () => { const w = routeWallet({...}); await loadHolderData(w, deps()); expect(w.calls.map(c => c.basket)).not.toContain('p mandala'); expect(w.calls.map(c => c.basket)).not.toContain('mandala-tokens') })
it('query keys are JSON-safe', () => { expect(() => JSON.stringify(holderDataKey('02ab'))).not.toThrow(); expect(() => JSON.stringify(treasuryKey(null))).not.toThrow() })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/loadHolderData.test.ts`
Expected: FAIL (module unresolved).

- [ ] **Step 3: Implement**

- `loadHolderData` awaits `listAllOutputs(INVENTORY_SELECTOR, include 'locking scripts', includeTags true)` **first**. The first module read establishes the wallet's `color_access` grant, so two parallel reads must not race two consent prompts. Then it runs `loadHistory(wallet, { scope: 'holder' })` and the balance views in parallel.
  - `unsettled`/`incoming` come from `summarizeInventory`. An asset known only from history gets `0n` for both.
  - The asset set is the inventory assets plus the history assets.
  - It runs one balance-view call per asset in parallel; a rejection gives `null` for that asset.
  - Metadata merge is as today: own admin assets first, then `resolveAssetMetadata`. `decimals` uses `Number(meta?.decimals)` only when it is an integer from 0 to 18, otherwise 0.
  - Sort: `balance > 0n` first, then `label.localeCompare`.
- `useHolderData` keeps the same `queryKey` and `enabled`.
- `useTreasuryBalances` is `useQuery({ queryKey: treasuryKey(identityKey), enabled: wallet != null && isIssuer, queryFn: () => loadTreasuryBalances(wallet) })`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/loadHolderData.test.ts`
Expected: PASS.

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'src/(hooks/useHolderData|hooks/useTreasuryBalances|lib/mandala/loadHolderData)' || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

`feat(app): holder balances from p color views, treasury from TREASURY_BASKET`

---

### Task 7: Holder views on bigint

**Files:**
- Modify: `src/components/TokenWallet.tsx`, `src/components/holder/HolderHome.tsx`, `src/components/holder/AssetAccount.tsx`, `src/components/holder/TransactionHistory.tsx`, `src/components/holder/AlertBanners.tsx`
- Delete: `src/components/holder/AccountsOverview.tsx` and `src/components/holder/AccountsOverview.test.ts` (dead: nothing imports it)
- Create: `src/lib/mandala/holderLines.ts`, test `src/lib/mandala/holderLines.test.ts`
- Test: the existing smoke tests `HolderHome`/`AssetAccount`/`AlertBanners`/`TransactionHistory`, plus a new `it` in `src/robustness.wiring.test.ts`

**Interfaces:**
- Consumes: Task 3 (`displayAmount`, `formatCurrency`, `currencySymbol`), Task 5 (`frozenUnitsFor`), Task 6 (`AssetRow`, `HolderData`).
- Produces: `TokenWallet`'s `SelectedAsset.balance: bigint`; `HolderHome`'s `onSelect: (assetId: string, balance: bigint) => void`; `AssetAccount`'s prop `balance: bigint`.

- [ ] **Step 1: Write the failing wiring test**

```ts
it('holder views read no basket and format bigint amounts', () => {
  for (const f of ['components/holder/HolderHome.tsx', 'components/holder/AssetAccount.tsx', 'components/holder/TransactionHistory.tsx', 'components/holder/AlertBanners.tsx', 'components/TokenWallet.tsx']) {
    const s = src(f); expect(s).not.toMatch(/\bBASKET\b/); expect(s).not.toContain('decodeValue'); expect(s).not.toContain("'@bsv/mandala/amount'")
  }
  const a = src('components/holder/AlertBanners.tsx'); expect(a).toContain('frozenUnitsFor('); expect(a).not.toContain('listOutputs')
  const h = src('components/holder/HolderHome.tsx')
  expect(h).toContain('holderLines(')
  expect(h).not.toMatch(/balance\s*\+\s*(row\.|a\.|asset\.)?(incoming|unsettled)|(incoming|unsettled)\s*\+\s*(row\.|a\.|asset\.)?balance/)   // never summed
  expect(h).not.toMatch(/\.pending\b/)
})
// src/lib/mandala/holderLines.test.ts
it('holderLines keeps unsettled inside the balance and incoming outside it', () => {
  expect(holderLines({ balance: 10n, unsettled: 4n, incoming: 3n }, 0)).toEqual({ hero: '10', unsettled: 'of which awaiting settlement: 4', incoming: 'Incoming: 3' })
  expect(holderLines({ balance: 10n, unsettled: 0n, incoming: 0n }, 0)).toEqual({ hero: '10', unsettled: null, incoming: null })
  expect(holderLines({ balance: null, unsettled: 0n, incoming: 2n }, 0)).toEqual({ hero: '—', unsettled: null, incoming: 'Incoming: 2' })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/robustness.wiring.test.ts src/lib/mandala/holderLines.test.ts -t "holder"`
Expected: FAIL (`BASKET` is still present in AlertBanners; `holderLines` is unresolved).

- [ ] **Step 3: Port the views**

- All amounts go through `displayAmount`/`formatCurrency` from `src/lib/mandala/amountDisplay`.
- Comparisons use `> 0n` and `=== 0n`.
- A `balance === null` row shows `—` with the caption "Balance unavailable".
- New pure helper `src/lib/mandala/holderLines.ts`: `holderLines(row: Pick<AssetRow, 'balance' | 'unsettled' | 'incoming'>, dec: number): { hero: string; unsettled: string | null; incoming: string | null }`. The hero is `displayAmount(balance, dec)`, or `—` when `balance === null`. `unsettled` is `of which awaiting settlement: X` when `unsettled > 0n` and the balance is known. `incoming` is `Incoming: X` when `incoming > 0n`. Add both files to this task's commit.
- HolderHome renders the hero (the `p color balance` view, which already includes `unsettled`). Directly under it, in a smaller muted line, it shows "of which awaiting settlement: X". It shows a separate "Incoming: Y" line for `color_state_pending` value, which is not in the balance. Neither figure is ever added to the hero (contract §8.1:572; A6).
- AlertBanners drops the `listOutputs` scan. It computes `frozenUnitsFor(state, identityKey)` from `useAssetState` (no effect, no local state).
- Update the module mocks in the smoke tests only where an import path changed.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/holderLines.test.ts src/components/holder src/robustness.wiring.test.ts -t "holder|smoke"`
Expected: PASS.

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'src/components/(holder|TokenWallet)' || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

`feat(app): holder views on bigint balances with awaiting-settlement and incoming lines`

---

### Task 8: Hand-over drain over the lib journal (single owner, B5 recovery)

**Files:**
- Create: `src/lib/mandala/handoverDrain.ts`
- Test: `src/lib/mandala/handoverDrain.test.ts`

**Decision (A1, Revision 2):** the lib journal is the only hand-over store. This module persists nothing, never calls `deliverHandover`, `settleHandover`, `resubmitDelivered` or `abortAction` on journal entries, and never reads or writes `localStorage`. It schedules the lib's own recovery, which already covers every stage (plan 04 Task 15):
- `reconcileNotifications(messageBoxClient)` is the **only** redelivery path. It retries pending payout and reissue notifications, and redelivers every `signed` hand-over older than 60 s from the journal, promoting it to `delivered`.
- `reconcileWallet(wallet, { sweep: false })` is the **only** settle-recovery path. It resubmits every `delivered` entry with the exact journaled bytes. Admitted means `accepted` plus broadcast. Retryable means `attempts+1`, then `stranded` at `RETRY_CAP`. Final means abort once and drop. It also recovers the issuer journal (payout, issue, redeem, admin).

The app runs those two calls in that order (so an entry promoted this pass settles in the same pass), only from here, and never in parallel.

**Interfaces:**
- Consumes:
  - `journalListHandovers(): Promise<HandoverJournalEntry[]>` and `markHandoverDelivered(txid: string): Promise<void>` from `'@bsv/mandala'` (§8.1:539-540)
  - `reconcileNotifications(messageBoxClient)` from `@bsv/mandala/notifyJournal`, and `reconcileWallet(wallet, opts?: ReconcileOptions): Promise<ReconcileResult>` from `@bsv/mandala/reconcile` (§8.1:570)
  - `type MessageBoxSender` from `'@bsv/mandala'` (§8.1:536)
- Produces:
  - `type Sender = MessageBoxSender`
  - `type JournalHandover = Awaited<ReturnType<typeof journalListHandovers>>[number]` (fields read: `txid`, `stage`, `recipientKey`, `at`; A15)
  - `HANDOVER_LOCK = 'mandala.app.handovers'`, `SELF_GRACE_MS = 60_000` (mirrors the lib's 60 s redelivery gate), `IDLE_MS = 300_000`
  - `backoffMs(failures: number): number`, which is `min(15000 * 2 ** (failures - 1), 900000)` for n ≥ 1, and `0` for n ≤ 0
  - `interface DrainState { failures: number; nextAt: number }` (in memory, per tab; a reload resets it, which costs at most one early pass)
  - `withHandoverLock<T>(fn: () => Promise<T>, o: { wait: boolean }): Promise<{ ran: true; value: T } | { ran: false }>`. It uses `navigator.locks.request(HANDOVER_LOCK, { ifAvailable: !o.wait }, …)` when available, and otherwise only a module-level promise chain (same tab). `wait: false` with the lock held gives `{ ran: false }`.
  - `interface DrainDeps { wallet: WalletInterface; identityKey: string; messageBoxClient: Parameters<typeof reconcileNotifications>[0] /* the full client; Sender is only for deliverHandover */; now: () => number; state: DrainState; list: typeof journalListHandovers; markDelivered: typeof markHandoverDelivered; redeliver: typeof reconcileNotifications; reconcile: typeof reconcileWallet; withLock?: typeof withHandoverLock }`
  - `interface DrainReport { skipped: 'busy' | 'backoff' | null; markedSelf: string[]; redeliverError?: string; reconcile?: ReconcileResult; reconcileError?: string; awaiting: { signed: number; delivered: number } }`
  - `drainHandovers(deps: DrainDeps, o?: { force?: boolean }): Promise<DrainReport>`

Semantics, which the tests pin:
1. Same-tab single-flight: a call while another is in flight returns `skipped: 'busy'` without calling anything. Cross-tab: `withLock(…, { wait: false })` not acquired gives `skipped: 'busy'`.
2. Without `force`, `now() < state.nextAt` gives `skipped: 'backoff'` without calling anything. `force` (startup, `online`, right after a send or an issuer operation) ignores `nextAt`.
3. Inside the lock, in order:
   1. `list()`. For each `stage === 'signed'` entry with `recipientKey === identityKey` **and** `now() - at >= SELF_GRACE_MS`, call `markDelivered(txid)` (A13). A failure is warned and skipped. The age gate keeps a drain in another tab off a self-send that `sendAndDeliver` is still finishing: `send()` journals `signed` before that tab takes the lock (A16).
   2. `redeliver(messageBoxClient)`, in try/catch. An error is recorded in `redeliverError` and the pass continues.
   3. `reconcile(wallet, { sweep: false })`, in try/catch. An error is recorded in `reconcileError`.
   4. `list()` again gives `awaiting`.
4. Backoff: if `awaiting.signed + awaiting.delivered > 0`, or any call threw, then `state.failures += 1` and `state.nextAt = now() + backoffMs(state.failures)`. A short outage therefore costs a handful of `reconcileWallet` attempts, not one per minute, so `RETRY_CAP` (20) lasts hours.
5. Idle: otherwise set `state.failures = 0` and `state.nextAt = now() + IDLE_MS`. The 15 s tick then does nothing for 5 minutes. An idle app runs one slow recovery pass every 5 minutes, which still retries payout and reissue notifications that are not counted in `awaiting`. Forced triggers (startup, `online`, after any send, payout or issuer operation) bypass `nextAt`.
6. A `list()` rejection (store unavailable) skips step 3.1, still runs 3.2 and 3.3, and counts as a failure. If the second `list()` rejects, `awaiting` is `{ signed: -1, delivered: -1 }` (unknown), and the pass counts as a failure.

- [ ] **Step 1: Write the failing tests**

Use spies for every dep, a fake clock, and an injected `withLock` that is a pass-through or a "held" stub.

```ts
const A = '02' + 'aa'.repeat(32), B = '03' + 'bb'.repeat(32)
const signedTo = (txid: string, rk: string) => ({ txid, stage: 'signed', recipientKey: rk, at: 0 }) as any
it('runs markSelf → redeliver → reconcile in that order, reconcile with sweep:false', async () => {
  const order: string[] = []
  const d = deps({ list: vi.fn().mockResolvedValueOnce([signedTo('t1', A), signedTo('t2', B)]).mockResolvedValue([]),
    markDelivered: vi.fn(async (t) => { order.push('mark:' + t) }), redeliver: vi.fn(async () => { order.push('redeliver'); return [] }),
    reconcile: vi.fn(async (_w, o) => { order.push('reconcile:' + JSON.stringify(o)); return R0 }) })
  const r = await drainHandovers(d, { force: true })
  expect(order).toEqual(['mark:t1', 'redeliver', 'reconcile:{"sweep":false}']); expect(r.markedSelf).toEqual(['t1'])
  expect(r.awaiting).toEqual({ signed: 0, delivered: 0 }); expect(d.state).toEqual({ failures: 0, nextAt: 300_000 })   // deps() default now() = 0
})
it('marks a self entry only after the 60 s grace', async () => {
  const fresh = { txid: 'f', stage: 'signed', recipientKey: A, at: 100_000 - 10_000 }, old = { txid: 'o', stage: 'signed', recipientKey: A, at: 100_000 - 61_000 }
  const d = deps({ now: () => 100_000, list: vi.fn().mockResolvedValueOnce([fresh, old] as any).mockResolvedValue([]) })
  const r = await drainHandovers(d, { force: true }); expect(r.markedSelf).toEqual(['o']); expect(d.markDelivered).toHaveBeenCalledTimes(1)
})
it('never calls deliver, settle, abortAction or storage itself', async () => {
  const wallet = { abortAction: vi.fn(), listOutputs: vi.fn() } as any
  const ls = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), key: vi.fn(), length: 0, clear: vi.fn() }; vi.stubGlobal('localStorage', ls)
  await drainHandovers(deps({ wallet, list: async () => [{ txid: 't', stage: 'delivered', recipientKey: B, at: 0 } as any] }), { force: true })
  expect(wallet.abortAction).not.toHaveBeenCalled(); for (const f of [ls.getItem, ls.setItem, ls.removeItem]) expect(f).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
it('a redeliver failure still runs reconcile and counts as a failure', async () => {
  const d = deps({ redeliver: vi.fn().mockRejectedValue(new Error('mb down')) }); const r = await drainHandovers(d, { force: true })
  expect(d.reconcile).toHaveBeenCalledTimes(1); expect(r.redeliverError).toBe('mb down'); expect(d.state.failures).toBe(1)
})
it('backoff grows while hand-overs remain and resets when the journal empties', async () => {
  const left = [{ txid: 't', stage: 'delivered', recipientKey: B, at: 0 }] as any
  const d = deps({ now: () => 1000, list: vi.fn().mockResolvedValue(left) })
  await drainHandovers(d, { force: true }); expect(d.state).toEqual({ failures: 1, nextAt: 16000 })
  await drainHandovers(d, { force: true }); expect(d.state).toEqual({ failures: 2, nextAt: 31000 })
  d.list = vi.fn().mockResolvedValue([]); await drainHandovers(d, { force: true }); expect(d.state).toEqual({ failures: 0, nextAt: 1000 + 300_000 })
})
it('an idle app is not polled every tick', async () => {
  let t = 0; const d = deps({ now: () => t, list: vi.fn().mockResolvedValue([]) })
  await drainHandovers(d, { force: true }); t = 15_000; expect((await drainHandovers(d)).skipped).toBe('backoff')
  t = 300_000; expect((await drainHandovers(d)).skipped).toBeNull(); expect(d.reconcile).toHaveBeenCalledTimes(2)
})
it('skips without force while backing off; force ignores nextAt', async () => {
  const d = deps({ now: () => 5, state: { failures: 3, nextAt: 10 } })
  expect((await drainHandovers(d)).skipped).toBe('backoff'); expect(d.reconcile).not.toHaveBeenCalled()
  expect((await drainHandovers(d, { force: true })).skipped).toBeNull(); expect(d.reconcile).toHaveBeenCalledTimes(1)
})
it('concurrent drains: the second is skipped (same tab)', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r })
  const d = deps({ reconcile: vi.fn(async () => { await gate; return R0 }) })
  const p1 = drainHandovers(d, { force: true }); const r2 = await drainHandovers(d, { force: true }); release(); await p1
  expect(r2.skipped).toBe('busy'); expect(d.reconcile).toHaveBeenCalledTimes(1)
})
it('another tab holding the lock gives skipped busy', async () => {
  const d = deps({ withLock: async () => ({ ran: false }) as const }); const r = await drainHandovers(d, { force: true })
  expect(r.skipped).toBe('busy'); expect(d.redeliver).not.toHaveBeenCalled(); expect(d.reconcile).not.toHaveBeenCalled()
})
it('a list() failure skips self-marking but still reconciles', async () => {
  const d = deps({ list: vi.fn().mockRejectedValue(new Error('idb')) }); await drainHandovers(d, { force: true })
  expect(d.markDelivered).not.toHaveBeenCalled(); expect(d.reconcile).toHaveBeenCalledTimes(1); expect(d.state.failures).toBe(1)
})
it('withHandoverLock wait:false refuses while held, wait:true queues (no navigator.locks)', async () => {
  let release!: () => void; const held = withHandoverLock(() => new Promise<void>(r => { release = r }), { wait: true })
  expect(await withHandoverLock(async () => 1, { wait: false })).toEqual({ ran: false })
  const queued = withHandoverLock(async () => 2, { wait: true }); release(); await held
  expect(await queued).toEqual({ ran: true, value: 2 })
})
it('backoffMs caps at 15 minutes', () => { expect([0, 1, 2, 3, 7, 50].map(backoffMs)).toEqual([0, 15000, 30000, 60000, 900000, 900000]) })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/handoverDrain.test.ts`
Expected: FAIL (module unresolved).

- [ ] **Step 3: Implement `src/lib/mandala/handoverDrain.ts`** to the semantics above. Without `navigator.locks` (vitest node env, old browsers), `withHandoverLock` falls back to a module-level promise chain. `wait: false` checks a module-level `held` flag. `drainHandovers` wraps its body in `withLock(…, { wait: false })` and keeps a module-level in-flight promise for the same-tab check.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/handoverDrain.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/personal/git/demos/mandala-wt/1color
git add app/src/lib/mandala/handoverDrain.ts app/src/lib/mandala/handoverDrain.test.ts
git commit -m "feat(app): hand-over drain over the lib journal (single owner, B5 recovery)" -- app/
```

The commit body states the stability reasoning:
- **Crash.** The lib journals `signed` before `sendHandover` resolves, and `delivered` inside `deliverHandover`. The app holds no copy, so nothing can diverge or be lost by the app.
- **Double-submit and multi-tab.** There is one drain per tab (in-flight promise) and one across tabs (web lock `mandala.app.handovers`, plus the lib's own `mandala.reconcile` lock). The immediate send leg (Task 9) takes the same web lock in wait mode.
- **Stale cache.** Every pass re-reads `journalListHandovers()`. No entry list is cached.
- **Retry.** Interval backoff (15 s doubling to 15 min) protects `RETRY_CAP`. A final verdict is aborted once, by the lib only.
- Why not an app queue or an app journal iteration: see A1.

---

### Task 9: Holder send pipeline (sendHandover → deliver → post-ACK settle) and the single recovery entry

**Files:**
- Create: `src/lib/mandala/sendPipeline.ts`, test `src/lib/mandala/sendPipeline.test.ts`
- Modify: `src/hooks/useSendMutation.ts`, `src/components/SendTokens.tsx` (holder mode), `src/context/WalletContext.tsx` (`drainNow`, triggers, removal of the direct `reconcileWallet`/`reconcileNotifications` calls), `src/robustness.wiring.test.ts` (rewrite the send `it`s, add the single-recovery-path `it`)

**Interfaces:**
- Consumes:
  - Task 8 (`drainHandovers`, `withHandoverLock`, `DrainState`, `DrainReport`, `Sender`)
  - `sendHandover(p: { wallet, identityKey, assetId, amount: bigint, recipientKey, blind?, note? }): Promise<HandoverResult>`. It journals stage `signed` before resolving (§8.1:531-534, 568).
  - `deliverHandover(p: { messageBoxClient, recipientKey, handover: Pick<HandoverResult, 'txid' | 'tx' | 'outputIndex' | 'receipt'>, note? }): Promise<void>`. It promotes the journal entry to `delivered` on success. On failure the notify entry and stage `signed` stay for `reconcileNotifications` (§8.1:535; plan 04 Task 13).
  - `markHandoverDelivered(txid)` (§8.1:539), used for self-sends only.
  - `settleHandover(p: { wallet, handover: Pick<HandoverResult, 'txid' | 'tx' | 'offChainValues'>, assetId, overlayIdentityKey }): Promise<{ status: 'admitted', attestation } | { status: 'retry' | 'refused', code: string }>` (§8.1:542-543). The lib updates the journal: `accepted` and broadcast, `attempts+1`, or abort and drop on final.
  - Task 4 (`overlayIdentityKey` in `WalletState`)
  - Task 3 (`safeParseAmount`, `plainAmount`, `displayAmount`)
  - `guardSendSubmit`/`guardPositiveAmount` (bigint, `@bsv/mandala/submitGuards`)
- Produces:
  - `interface SendVars { assetId: string; amount: bigint; recipientKey: string; note?: string }`
  - `type SettleVerdict = Awaited<ReturnType<typeof settleHandover>>`
  - `interface SendOutcome { txid: string; delivered: boolean; self: boolean; settle: SettleVerdict | null /* null: not attempted (undelivered), lock unavailable, or settle threw */ }`
  - `interface SendDeps { wallet: WalletInterface; identityKey: string; overlayIdentityKey: string; messageBoxClient: Sender; send: typeof sendHandover; deliver: typeof deliverHandover; markDelivered: typeof markHandoverDelivered; settle: typeof settleHandover; withLock?: typeof withHandoverLock }`
  - `sendAndDeliver(deps: SendDeps, vars: SendVars): Promise<SendOutcome>`
  - `explainSendError(e: unknown): string`
  - `describeSettle(o: SendOutcome): { kind: 'success' | 'info' | 'warning' | 'error'; text: string }`
  - `useSendMutation(): UseMutationResult<SendOutcome, Error, SendVars, …>`
  - `drainNow(o?: { force?: boolean }): Promise<DrainReport | undefined>`, exported from WalletContext through `useWallet()`. This is the app's **only** caller of `reconcileWallet` and `reconcileNotifications`.

`sendAndDeliver` semantics:
1. `send({ wallet, identityKey, assetId, amount, recipientKey, note })`. On a throw it propagates. The lib has journaled nothing durable, or has aborted (plan 04 Task 13).
2. Inside `withLock(…, { wait: true })` (the same `mandala.app.handovers` lock as the drain, so no drain in any tab runs `reconcileWallet` over this txid concurrently; A16):
   1. Self (`recipientKey === identityKey`): `markDelivered(txid)`. Otherwise call `deliver({ messageBoxClient, recipientKey, handover: h, note })`. A deliver throw means `delivered: false`, no settle, and the lock is released. The entry stays `signed`, and `reconcileNotifications` redelivers it after 60 s.
   2. If delivered or self: `settle({ wallet, handover: { txid, tx, offChainValues }, assetId, overlayIdentityKey })`. A throw means `settle: null`. The entry stays `delivered`, and `reconcileWallet` retries it.
3. It never calls `abortAction`, never retries in a loop, and never writes storage.

- [ ] **Step 1: Write the failing tests**

```ts
it('signs, delivers, then settles inside the handover lock (B5)', async () => {
  const order: string[] = []
  const d = deps({ send: async () => { order.push('send'); return H }, deliver: async () => { order.push('deliver') },
    settle: async () => { order.push('settle'); return { status: 'admitted', attestation: ATT } as const },
    withLock: async (fn, o) => { order.push('lock:' + o.wait); return { ran: true, value: await fn() } } })
  const out = await sendAndDeliver(d, { assetId: ID, amount: 2n ** 64n - 1n, recipientKey: B, note: 'rent' })
  expect(order).toEqual(['send', 'lock:true', 'deliver', 'settle'])
  expect(out).toEqual({ txid: H.txid, delivered: true, self: false, settle: { status: 'admitted', attestation: ATT } })
  expect(d.settle).toHaveBeenCalledWith({ wallet: d.wallet, handover: { txid: H.txid, tx: H.tx, offChainValues: H.offChainValues }, assetId: ID, overlayIdentityKey: K })
})
it('passes amount as bigint and leaves blind to the lib default', async () => { const d = deps(); await sendAndDeliver(d, V); expect(d.send).toHaveBeenCalledWith({ wallet: d.wallet, identityKey: A, assetId: ID, amount: V.amount, recipientKey: B, note: undefined }) })
it('a failed delivery does not throw and does not settle', async () => {
  const d = deps({ deliver: vi.fn().mockRejectedValue(new Error('mb down')) }); const out = await sendAndDeliver(d, V)
  expect(out).toEqual({ txid: H.txid, delivered: false, self: false, settle: null }); expect(d.settle).not.toHaveBeenCalled()
})
it('self-send marks delivered instead of delivering, then settles', async () => {
  const d = deps(); const out = await sendAndDeliver(d, { ...V, recipientKey: A })
  expect(d.deliver).not.toHaveBeenCalled(); expect(d.markDelivered).toHaveBeenCalledWith(H.txid); expect(d.settle).toHaveBeenCalledTimes(1); expect(out.self).toBe(true)
})
it('refused shows the code and does not abort', async () => {
  const wallet = { abortAction: vi.fn() } as any
  const out = await sendAndDeliver(deps({ wallet, settle: async () => ({ status: 'refused', code: 'ERR_CONSERVATION' }) as const }), V)
  expect(wallet.abortAction).not.toHaveBeenCalled()
  expect(describeSettle(out)).toEqual({ kind: 'error', text: 'The overlay refused this send (ERR_CONSERVATION). The tokens were returned to your balance.' })
})
it('a thrown settle resolves with settle:null (recovery retries it)', async () => { const out = await sendAndDeliver(deps({ settle: vi.fn().mockRejectedValue(new Error('net')) }), V); expect(out.settle).toBeNull(); expect(out.delivered).toBe(true) })
it('sendHandover failure propagates; nothing else runs', async () => { const d = deps({ send: vi.fn().mockRejectedValue(new Error('x')) }); await expect(sendAndDeliver(d, V)).rejects.toThrow('x'); expect(d.deliver).not.toHaveBeenCalled(); expect(d.settle).not.toHaveBeenCalled() })
it('describeSettle covers every outcome', () => {
  expect(describeSettle({ txid: 't', delivered: true, self: false, settle: { status: 'admitted', attestation: ATT } })).toEqual({ kind: 'success', text: 'Sent and settled.' })
  expect(describeSettle({ txid: 't', delivered: true, self: false, settle: { status: 'retry', code: 'ERR_UNAVAILABLE' } }).kind).toBe('info')
  expect(describeSettle({ txid: 't', delivered: true, self: false, settle: null }).kind).toBe('info')
  expect(describeSettle({ txid: 't', delivered: false, self: false, settle: null })).toEqual({ kind: 'warning', text: 'Signed, but the recipient could not be reached yet — delivery will retry automatically.' })
})
it('explainSendError names a wallet without the Mandala profile', () => {
  const msg = 'Your wallet cannot send Mandala assets: it needs the 1Color module with the Mandala issuer profile.'
  expect(explainSendError(Object.assign(new Error('x'), { name: 'UnsupportedProfileError' }))).toBe(msg)
  expect(explainSendError(new Error('the wallet lacks @bsv/color-permission-module 0.2.0 with the Mandala issuer-v1 profile'))).toBe(msg)
  expect(explainSendError(new Error('boom'))).toBe('boom')
})
// robustness.wiring.test.ts — replaces the old transferTokens/note its
it('sendFlight is acquired before sendAndDeliver; the note reaches sendHandover', () => {
  const m = src('hooks/useSendMutation.ts')
  expect(m.indexOf('sendFlight.tryAcquire')).toBeGreaterThan(-1); expect(m).toContain('sendAndDeliver('); expect(m).not.toContain('transferTokens')
  expect(m).toMatch(/interface SendVars|SendVars/); expect(m).toContain('drainNow'); expect(m).not.toMatch(/reconcileBans/)
  const ui = src('components/SendTokens.tsx'); expect(ui).toContain('sendStartedRef'); expect(ui).toContain('safeParseAmount(')
  expect(ui).toMatch(/sendMutation\.mutate\(\s*\{[\s\S]*?note[\s\S]*?\}/); expect(ui).not.toMatch(/Number\(/)
  expect(src('context/WalletContext.tsx')).toMatch(/addEventListener\('online'/)
})
it('deliver and settle run inside the handover lock; the app never aborts a hand-over', () => {
  const p = src('lib/mandala/sendPipeline.ts'); expect(p).toMatch(/withLock[\s\S]*wait:\s*true[\s\S]*settle\(/); expect(p).not.toContain('abortAction')
  const dr = src('lib/mandala/handoverDrain.ts'); for (const banned of ['abortAction', 'deliverHandover', 'settleHandover', 'resubmitDelivered', 'localStorage']) expect(dr).not.toContain(banned)
  const w = src('context/WalletContext.tsx'); expect(w).toMatch(/setInterval\([\s\S]*drainNow\(\)/); expect(w).toMatch(/drainNow\(\{\s*force:\s*true\s*\}\)/)
})
it('one recovery path: reconcileWallet/reconcileNotifications are called only from handoverDrain via drainNow', () => {
  for (const f of listSrc().filter(f => f !== 'lib/mandala/handoverDrain.ts' && f !== 'context/WalletContext.tsx'))
    expect(src(f), f).not.toMatch(/reconcileWallet\(|reconcileNotifications\(/)
  const w = src('context/WalletContext.tsx'); expect(w).not.toMatch(/reconcileWallet\(|reconcileNotifications\(/); expect(w).toContain('drainHandovers(')
  for (const f of listSrc()) expect(src(f), f).not.toContain('mandala.app.handover.')
})
```

`listSrc()` is the helper Task 14 also uses: every `.ts`/`.tsx` under `src` except `*.test.ts`. Define it here in `robustness.wiring.test.ts`.

Add the single-recovery-path test as `it.skip` in this task. `useIssuerMutations.ts:32` still calls `reconcileWallet` until Task 12 routes it through `drainNow`. Task 12 Step 1 flips it to `it`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/sendPipeline.test.ts src/robustness.wiring.test.ts -t "send|lock|recovery"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`sendAndDeliver` and `describeSettle` follow the semantics above. `describeSettle` texts:
- `admitted`: success "Sent and settled."
- `retry`, or `settle === null` while delivered: info "Sent. Settlement with the overlay will complete automatically."
- `refused`: error "The overlay refused this send (CODE). The tokens were returned to your balance."
- Not delivered: the warning text in the test.

`useSendMutation`:
- Keep the current latch structure: `sendFlight.tryAcquire` in `onMutate`, release in `onSettled`, `BusyError` early return.
- `mutationFn` runs the bigint guard, then `sendAndDeliver` with `send: sendHandover, deliver: deliverHandover, markDelivered: markHandoverDelivered, settle: settleHandover`.
- Optimistic update: `balance - amount` when `balance != null`, plus a pending history row with `amount: bigint`.
- `onSuccess`: show the toast from `describeSettle(outcome)`, then `void drainNow({ force: true })`. Invalidate holder data and contacts after `onSuccess`, and once more when the drain resolves. A refusal restores coins that the optimistic cache had removed, so the refetch is needed.
- `onError`: roll back, then `toast.error(explainSendError(e))`.
- Remove the `reconcileWallet`, `reconcileNotifications` and `reconcileBans` calls (`useSendMutation.ts:122,124` today). The drain owns recovery, and the module owns spendability.

`SendTokens`:
- Add the prop `mode?: 'holder' | 'payout'`; the `'payout'` branch lands in Task 11.
- Amount uses `safeParseAmount(amountStr, decimals)` and gives `null` when invalid.
- Max uses `plainAmount(balance, decimals)`.
- Every comparison is bigint. `frozenNote` amounts are bigint.
- Drop the `reconcileBans` effect.

`WalletContext`:
- Delete the direct startup `reconcileWallet(...)` and `reconcileNotifications(...)` calls and their imports. Keep the toast on recovered work: `drainNow` logs and toasts from `report.reconcile` (`rebroadcast + aborted + resubmitted` > 0), as the startup call does today.
- Hold `drainState = useRef<DrainState>({ failures: 0, nextAt: 0 })`.
- `drainNow(o)`: when `wallet`, `messageBoxClient` and `identityKey` are set and `configError == null`, call `drainHandovers({ wallet, identityKey, messageBoxClient, now: Date.now, state: drainState.current, list: journalListHandovers, markDelivered: markHandoverDelivered, redeliver: reconcileNotifications, reconcile: reconcileWallet }, o)`. Otherwise return `undefined`.
- Triggers:
  - `drainNow({ force: true })` once after init.
  - `drainNow({ force: true })` on `window` `online`.
  - A 15 s `setInterval` tick calls `drainNow()` without force. `state.nextAt` gates it: backoff while hand-overs remain, otherwise 5 minutes idle (Task 8 semantics 4–5). It is never a fixed 15 s recovery loop.
  - `drainNow()` on `visibilitychange` to visible.
- Clean up the interval and listeners on unmount. A StrictMode double effect must not leave two intervals, so check this with the effect cleanup.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/sendPipeline.test.ts src/lib/mandala/handoverDrain.test.ts src/robustness.wiring.test.ts src/components/issuer/TreasurySection.test.ts`
Expected: PASS, with the single-recovery-path test reported as skipped.

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'src/(hooks/useSendMutation|components/SendTokens|context/WalletContext|lib/mandala/sendPipeline)' || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

```bash
cd /Users/personal/git/demos/mandala-wt/1color
git add app/src/lib/mandala/sendPipeline.ts app/src/lib/mandala/sendPipeline.test.ts app/src/hooks/useSendMutation.ts app/src/components/SendTokens.tsx app/src/context/WalletContext.tsx app/src/robustness.wiring.test.ts
git commit -m "feat(app): holder send via sendHandover, MessageBox delivery and post-ACK settle; drainNow is the single recovery path" -- app/
```

The commit body gives the stability reasoning:
- **Double-click.** `sendFlight` is acquired synchronously in `onMutate`, and the lib's `mandala.send` web lock covers other tabs.
- **Crash after sign.** The journal entry is `signed`. `reconcileNotifications` (via `drainNow`) redelivers it after 60 s, and `reconcileWallet` settles it.
- **Crash after deliver.** The entry is `delivered`, and `reconcileWallet` settles it from the journaled bytes.
- **Concurrent settle.** The immediate settle and every drain share the `mandala.app.handovers` lock, so one txid is never settled by two app paths at once.
- **Final refusal.** The lib aborts once. The app shows the code and never aborts.
- **Stale cache.** The optimistic decrement is followed by invalidation after the drain.

---

### Task 10: Receive via receiveHandovers

**Files:**
- Create: `src/lib/mandala/receiveView.ts`, test `src/lib/mandala/receiveView.test.ts`
- Modify: `src/components/ReceiveTokens.tsx`, `src/robustness.wiring.test.ts` (one `it`)

**Interfaces:**
- Consumes:
  - `receiveHandovers(p: { wallet, messageBoxClient, assetId?, processed?: Set<string> }): Promise<{ accepted: Array<{ messageId, txid, assetId, amount: bigint, outputIndex, offline: boolean }>, failed: Array<{ messageId, error, code? }> }>`
  - Task 6 `metas`
  - Task 3 `displayAmount`
- Produces:
  - `interface ReceivedView { key: string; label: string; amountText: string; title: string; pending: boolean }`
  - `describeAccepted(a: { messageId: string; assetId: string; amount: bigint; offline: boolean }, metas: Record<string, AssetMeta>): ReceivedView`
  - `describeFailed(f: { error: unknown; code?: string }): string`

- [ ] **Step 1: Write the failing tests**

```ts
it('formats exact amounts with the asset label', () => {
  expect(describeAccepted({ messageId: 'm1', assetId: ID, amount: 123456n, offline: false }, { [ID]: { label: 'Test Dollar', decimals: 2 } }))
    .toEqual({ key: 'm1', label: 'Test Dollar', amountText: '+1,234.56', title: 'Tokens received', pending: false })
})
it('marks offline credits as awaiting settlement (counted in the balance, unsettled)', () => {
  expect(describeAccepted({ messageId: 'm2', assetId: ID, amount: 1n, offline: true }, {}))
    .toMatchObject({ label: ID.slice(0, 10) + '…', amountText: '+1', title: 'Tokens received — awaiting settlement', pending: true })
})
it('failure text carries the overlay code', () => {
  expect(describeFailed({ error: new Error('frozen'), code: 'ERR_FROZEN' })).toBe('frozen (ERR_FROZEN)')
  expect(describeFailed({ error: 'x' })).toBe('Unexpected error')
})
it('ReceiveTokens uses receiveHandovers', () => { const s = src('components/ReceiveTokens.tsx'); expect(s).toContain('receiveHandovers('); expect(s).not.toContain('receiveTokens'); expect(s).not.toMatch(/Number\(/) })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/receiveView.test.ts`
Expected: FAIL (module unresolved).

- [ ] **Step 3: Implement**

- `ReceiveTokens` calls `receiveHandovers({ wallet, messageBoxClient, processed: processedRef.current })`.
- Rows are keyed by `messageId` and show an "Awaiting settlement" chip when `pending`. The wording matches HolderHome's "of which awaiting settlement" line: an `offline: true` credit is a `color_offline` available output, already inside the balance (Task 5, A6).
- Drop the "From" line: the receipt sender may be the blinded A′ (B3), so it is not an identity.
- Failure toasts use `describeFailed`.
- After any accepted entry, invalidate holder data.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/receiveView.test.ts src/robustness.wiring.test.ts -t "Receive"`
Expected: PASS.

Run the `tsc` grep for `src/components/ReceiveTokens`.
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

`feat(app): receive hand-overs through the wallet's BRC-207 module`

---

### Task 11: Issuer payouts to holders (B4)

**Files:**
- Create: `src/hooks/usePayoutMutation.ts`, `src/lib/mandala/payoutGuard.ts`, test `src/lib/mandala/payoutGuard.test.ts`
- Modify: `src/components/SendTokens.tsx` (`mode: 'payout'`), `src/components/issuer/TreasurySection.tsx`, `src/robustness.wiring.test.ts` (one `it`)

**Interfaces:**
- Consumes:
  - `payoutTokens(p: { wallet, identityKey, asset: AdminAsset, amount: bigint, recipientKey, blind?: boolean, messageBoxClient, note? }): Promise<PayoutResult>`, with `interface PayoutResult extends AdmissionReceipt { txid: string; receipt: ReceiptInstruction; outputIndex: 0; notified: boolean }` (§8.1:552-554; A2). A payout spends treasury inputs only, **no admin authority**, so it has no `nextAuthOutpoint`/`nextAuthKeyID`, and the admin-auth cache is not touched.
  - `createSingleFlight` and `BusyError` (`@bsv/mandala/singleFlight`)
  - Task 6 `useTreasuryBalances`, `treasuryKey`
  - Task 9 `drainNow` (from `useWallet()`)
- Produces:
  - `guardPayout(i: { amount: bigint | null; treasury: bigint | undefined; recipientKey: string; isPaused: boolean; pauseBypass: boolean }): { ok: true } | { ok: false; reason: string }`
  - `interface PayoutVars { asset: AdminAsset; amount: bigint; recipientKey: string; note?: string }`
  - `usePayoutMutation()`
  - `payoutFlight = createSingleFlight('payout')`

- [ ] **Step 1: Write the failing tests**

```ts
const B = '03' + '11'.repeat(32), MAX = 2n ** 64n - 1n
it.each([
  [{ amount: null, treasury: 5n, recipientKey: B }, 'Enter an amount'],
  [{ amount: 0n, treasury: 5n, recipientKey: B }, 'Amount must be greater than zero'],
  [{ amount: 6n, treasury: 5n, recipientKey: B }, 'Amount exceeds treasury balance'],
  [{ amount: 1n, treasury: undefined, recipientKey: B }, 'Treasury balance unavailable — refresh'],
  [{ amount: 1n, treasury: 5n, recipientKey: 'nope' }, 'Recipient must be a compressed identity key'],
  [{ amount: 1n, treasury: 5n, recipientKey: B, isPaused: true }, 'Transfers are temporarily disabled by the issuer']
])('guardPayout refuses %#', (i, reason) => { expect(guardPayout({ isPaused: false, pauseBypass: false, ...i } as any)).toEqual({ ok: false, reason }) })
it('guardPayout allows the whole treasury, even at uint64 max', () => { expect(guardPayout({ amount: MAX, treasury: MAX, recipientKey: B, isPaused: false, pauseBypass: false })).toEqual({ ok: true }) })
it('payout path uses payoutTokens unblinded with the MessageBox client', () => {
  const m = src('hooks/usePayoutMutation.ts'); expect(m).toMatch(/payoutTokens\(\{[\s\S]*blind:\s*false[\s\S]*messageBoxClient/); expect(m).toContain('payoutFlight')
  expect(m).toMatch(/notified\s*===\s*false/); expect(m).toContain('drainNow')
  // no authority is spent: nothing may read or advance the admin-auth cache from a payout
  for (const banned of ['nextAuthOutpoint', 'nextAuthKeyID', 'advanceAdminAuth', 'useAdvanceAdminAuth', 'isAdminAuthInFlight', 'reconcileWallet(']) expect(m).not.toContain(banned)
  const t = src('components/issuer/TreasurySection.tsx'); expect(t).toContain("mode=\"payout\""); expect(t).toContain('useTreasuryBalances'); expect(t).not.toContain('useHolderData')
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/payoutGuard.test.ts src/robustness.wiring.test.ts -t payout`
Expected: FAIL.

- [ ] **Step 3: Implement**

`usePayoutMutation`:
- Acquire `payoutFlight` synchronously in `onMutate` (a `BusyError` gives an early return with the existing "already in progress" toast). There is no `isAdminAuthInFlight` refusal: a payout spends no authority, so it cannot race an admin action over the authority output. Contention over treasury inputs is the lib's (`BusyError` from its payout lock, plan 04 Task 12).
- Decrement the treasury cache (`treasuryKey`) optimistically.
- `mutationFn` calls `payoutTokens({ wallet, identityKey, asset, amount, recipientKey, blind: false, messageBoxClient, note })` and consumes only `{ txid, notified }` from the `PayoutResult`.
- `onSuccess`: if `r.notified === false`, show the warning toast "Paid out; recipient notification pending — it will be retried automatically". Otherwise show a success toast that names the short txid. Never touch the admin-auth cache.
- `onError`: roll back, then `toast.error(e.message)`.
- `onSettled`: release the latch, invalidate the treasury and holder data, and call `void drainNow({ force: true })`. The drain's `reconcileNotifications` retries an undelivered payout notification, and its `reconcileWallet` recovers a half-finished payout from the issuer journal. The hook calls neither directly.

`SendTokens mode="payout"`:
- The balance source is `useTreasuryBalances().data?.[assetId]`.
- Submit runs `guardPayout` and then `usePayoutMutation`.
- The holder-only frozen note is hidden.

`TreasurySection`:
- The balance card reads the treasury.
- The Send tab renders `<SendTokens lockedAssetId={assetId} mode="payout" />`.
- The Receive tab keeps `ReceivePanel` with the caption "Tokens sent to this identity arrive in the wallet's 1Color balance, not the treasury."

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/payoutGuard.test.ts src/robustness.wiring.test.ts src/components/issuer/TreasurySection.test.ts`
Expected: PASS.

Run the `tsc` grep for `src/(hooks/usePayoutMutation|components/SendTokens|components/issuer/TreasurySection)`.
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

`feat(app): issuer payouts from treasury to holder p color receipts (B4)`. The body states:
- **Double-click.** `payoutFlight` is taken synchronously, and the lib's payout lock covers other tabs.
- **No admin-auth coupling.** `PayoutResult` has no `nextAuth*` fields. Reading them would put `undefined` into the admin-auth cache and break the next admin action.
- **Crash or undelivered notification.** Recovery goes through `drainNow` only.

---

### Task 12: Register (req via lib, no fee), issue and redeem on bigint

**Files:**
- Create: `src/lib/mandala/registerForm.ts` with test `src/lib/mandala/registerForm.test.ts`; `src/lib/mandala/feeRateInput.ts`
- Move: `src/components/issuer/RegisterAssetStrip.test.ts` → `src/lib/mandala/feeRateInput.test.ts` (unchanged assertions, new import path)
- Modify: `src/components/issuer/RegisterAssetStrip.tsx`, `src/components/issuer/RegulatoryControls.tsx` (import path only), `src/hooks/useIssuerMutations.ts`, `src/components/IssuerPanel.tsx`, `src/robustness.wiring.test.ts` (rewrite the redeem/register `it`s)

**Interfaces:**
- Consumes:
  - `registerAsset(p: { wallet, identityKey, label, ticker, decimals, icon? })`. The deploy carries `mandalaReq(OVERLAY_IDENTITY_KEY)` inside the lib, so the console does not build `req` itself (contract §4, §8.1).
  - `issueTokens(p: { wallet, identityKey, asset, amount: bigint, depositHash? })`
  - `redeemTokens(p: { wallet, identityKey, asset, amount: bigint })`
  - `guardIssueSubmit`/`guardRedeemSubmit`/`guardRegisterSubmit` (bigint)
  - Task 6 `treasuryKey`, `TreasuryData`; Task 3 `safeParseAmount`, `displayAmount`; Task 9 `drainNow` (from `useWallet()`)
- Produces:
  - `validateRegisterForm(i: { label: string; ticker: string; decimals: string }): { ok: true; value: { label: string; ticker: string; decimals: number } } | { ok: false; reason: string }`
  - `parseFeeRateInput(raw: string): FeeRateParse` (moved, unchanged)
  - `useIssuerMutations()` (same names; `register` vars `{ label, ticker, decimals }`)

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts the deploy-field limits (0162:246-252, overlay detLabel)', () => {
  expect(validateRegisterForm({ label: ' Test Dollar ', ticker: 'TUSD', decimals: '18' })).toEqual({ ok: true, value: { label: 'Test Dollar', ticker: 'TUSD', decimals: 18 } })
  expect(validateRegisterForm({ label: '🪙'.repeat(64), ticker: '€'.repeat(32), decimals: '0' }).ok).toBe(true)
})
it.each([
  [{ label: '', ticker: 'T', decimals: '2' }, 'Label must be 1–64 characters'],
  [{ label: 'x'.repeat(65), ticker: 'T', decimals: '2' }, 'Label must be 1–64 characters'],
  [{ label: 'L', ticker: '', decimals: '2' }, 'Ticker must be 1–32 characters'],
  [{ label: 'L', ticker: 'x'.repeat(33), decimals: '2' }, 'Ticker must be 1–32 characters'],
  [{ label: 'L', ticker: 'T', decimals: '19' }, 'Decimals must be a whole number from 0 to 18'],
  [{ label: 'L', ticker: 'T', decimals: '1.5' }, 'Decimals must be a whole number from 0 to 18'],
  [{ label: 'L', ticker: 'T', decimals: '02' }, 'Decimals must be a whole number from 0 to 18']
])('refuses %#', (i, reason) => { expect(validateRegisterForm(i)).toEqual({ ok: false, reason }) })
// robustness.wiring.test.ts (replaces the holder-cache redeem its)
it('register writes no fee rate; redeem gates on the treasury balance and does not pass it on', () => {
  const s = src('hooks/useIssuerMutations.ts'); const strip = src('components/issuer/RegisterAssetStrip.tsx')
  expect(s).not.toContain('feeRatePerKb'); expect(strip).not.toMatch(/feeRate/); expect(strip).toContain('validateRegisterForm(')
  expect(s).toContain('qc.getQueryData<TreasuryData>(treasuryKey'); expect(s).toMatch(/guardRedeemSubmit\(\{[\s\S]*balance/)
  const call = s.slice(s.indexOf('redeemTokens({')); expect(call.slice(0, call.indexOf('})'))).not.toContain('balance')
  const redeemBlock = s.slice(s.indexOf('const redeem = useMutation')); expect(redeemBlock).not.toMatch(/onMutate\s*:/)
  expect(redeemBlock.indexOf('guardRedeemSubmit(')).toBeLessThan(redeemBlock.indexOf('adjustTreasury('))
  expect(src('components/IssuerPanel.tsx')).toContain('safeParseAmount(')
})
```

Keep the existing A14 `it` (deposit hash) unchanged. Flip Task 9's `it.skip('one recovery path: …')` to `it`. It must pass at the end of this task.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/registerForm.test.ts src/robustness.wiring.test.ts -t "register|redeem"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `validateRegisterForm` trims both strings and counts code points via `[...s].length`. `decimals` must match `/^(0|[1-9][0-9]?)$/` and be ≤ 18.
- RegisterAssetStrip: remove the fee input and state; gate with `validateRegisterForm` and then `guardRegisterSubmit`; mutate with `value`.
- `useIssuerMutations`:
  - Rename `adjustBalance` to `adjustTreasury(assetId, delta: bigint)` over `treasuryKey`.
  - `issue` keeps optimistic `onMutate`.
  - `redeem` reads the treasury **before** its own decrement, gates, decrements and calls `redeemTokens` without `balance`.
  - `settle` invalidates treasury, admin assets and holder data, and calls `void drainNow({ force: true })` instead of `reconcileWallet` (`useIssuerMutations.ts:32` today). `drainNow` is the app's only caller of the lib recovery (Task 9).
  - Issue and redeem **do** spend admin authority (`IssuerOpResult`), so their `advanceAdminAuth(...)` calls and the `isAdminAuthInFlight` gates in `IssuerPanel.tsx` stay unchanged.
- IssuerPanel: `safeParseAmount` with the `null` message "Enter a valid amount"; the redeem balance comes from `useTreasuryBalances`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/registerForm.test.ts src/lib/mandala/feeRateInput.test.ts src/robustness.wiring.test.ts`
Expected: PASS.

Run the `tsc` grep for `src/(hooks/useIssuerMutations|components/IssuerPanel|components/issuer/RegisterAssetStrip|components/issuer/RegulatoryControls)`.
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

`feat(app): register with Mandala req via lib (no fee), bigint issue/redeem against treasury`

---

### Task 13: Admin and oversight views on bigint (reissue, overview, banking, activity, audit)

**Files:**
- Modify: `src/lib/mandala/mockBankStore.ts` (+ new test `src/lib/mandala/mockBankStore.test.ts`), `src/components/issuer/RegulatoryControls.tsx`, `src/components/issuer/OverviewSection.tsx`, `src/components/issuer/BankingMock.tsx`, `src/components/issuer/OverlayActivity.tsx`, `src/components/issuer/AuditLog.tsx`, `src/robustness.wiring.test.ts` (one `it`)

**Interfaces:**
- Consumes:
  - `MockTransfer` with `amount: bigint`, `makeTransfer`, and `reconcile(p: { deposits: bigint[], withdrawals: bigint[], issued: bigint, redeemed: bigint }): { bankBalance: bigint, netSupply: bigint, drift: bigint }` (`@bsv/mandala/banking`, assumed bigint)
  - `AdminSummary.totalIssued/totalRedeemed: bigint`
  - `ActivityEntry.amount: bigint`
  - `submitAdminAction(p: { asset, details, ftOutput?: { recipient: string, amount: bigint }, messageBoxClient, … })`
  - Task 3 `displayAmount`, `reserveRatioPct`, `safeParseAmount`
- Produces:
  - `MOCK_BANK_KEY = 'mandala.mockDeposits.v2'`
  - `serializeTransfers(ts: MockTransfer[]): string`
  - `deserializeTransfers(raw: string | null): MockTransfer[]`

- [ ] **Step 1: Write the failing tests**

```ts
const MAX = 2n ** 64n - 1n
const t = { id: 'x', assetId: ID, amount: MAX, direction: 'in' as const, originator: 'Q', timestamp: 1 }
it('serializeTransfers round-trips MAX_UINT64 as a decimal string', () => {
  const raw = serializeTransfers([t]); expect(raw).toContain('"amount":"18446744073709551615"'); expect(deserializeTransfers(raw)).toEqual([t])
})
it('deserializeTransfers drops non-canonical or non-string amounts and corrupt JSON', () => {
  expect(deserializeTransfers(JSON.stringify([{ ...t, amount: '01' }, { ...t, amount: 5 }, { ...t, amount: '-1' }]))).toEqual([])
  expect(deserializeTransfers('{')).toEqual([]); expect(deserializeTransfers(null)).toEqual([])
})
it('the legacy number-amount key is removed, not migrated', () => { /* seed localStorage 'mandala.mockDeposits' → load() → key gone, feed empty (stub globalThis.localStorage) */ })
it('admin views carry no Number() on amounts; reissue takes the frozen row amount', () => {
  const rc = src('components/issuer/RegulatoryControls.tsx'); expect(rc).not.toMatch(/Number\(reissueAmount\)/)
  expect(rc).toMatch(/ftOutput:\s*\{\s*recipient,\s*amount:\s*row\.amount\s*\}/); expect(rc).toContain('notified')
  expect(src('components/issuer/OverviewSection.tsx')).toContain('reserveRatioPct(')
  for (const f of ['OverviewSection', 'BankingMock', 'OverlayActivity', 'AuditLog', 'RegulatoryControls'])
    expect(src(`components/issuer/${f}.tsx`)).not.toContain("'@bsv/mandala/amount'")
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/mandala/mockBankStore.test.ts src/robustness.wiring.test.ts -t "admin views|Transfers"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `mockBankStore`: the key is `'mandala.mockDeposits.v2'`, stored as JSON with `amount` as a canonical decimal string. On load, remove the legacy key `'mandala.mockDeposits'` (no back-compat). All access is in try/catch.
- `RegulatoryControls` reissue:
  - Resolve `row = state.frozenOutpoints.find(r => r.outpoint === reissueOutpoint)` and refuse when it is missing.
  - The amount field becomes read-only display text `displayAmount(row.amount, decimals)`, keeping the existing "Locked to the frozen output's amount" note.
  - Submit `ftOutput: { recipient, amount: row.amount }` with `messageBoxClient`.
  - Freeze lists use `displayAmount`.
- `OverviewSection`: circulation `= totalIssued - totalRedeemed` (bigint); the ratio is `reserveRatioPct(recon.bankBalance, circulation)`.
- `BankingMock`: input through `safeParseAmount`, with "Enter a valid amount" on `null` or `<= 0n`; drift sign via `> 0n`.
- `OverlayActivity` and `AuditLog`: `displayAmount`; signed delta prefix via `< 0n`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/mandala/mockBankStore.test.ts src/components/issuer src/robustness.wiring.test.ts`
Expected: PASS.

Run the `tsc` grep for `src/(components/issuer|lib/mandala/mockBankStore)`.
Expected: `CLEAN`.

- [ ] **Step 5: Commit**

`feat(app): bigint admin, oversight and banking views; decimal-string mock bank feed`

---

### Task 14: Final gate: whole suite, typecheck, production build, residue scan

**Files:**
- Modify: whatever the gate exposes. Typically leftover imports, `src/robustness.wiring.test.ts` (one residue `it`), or `README`/`.env.example` comments.

**Interfaces:**
- Consumes: everything above. `listSrc()` from Task 9.
- Produces: a green app on `feat/1color`, ready for the draft-PR stage.

- [ ] **Step 1: Write the residue test**

```ts
it('no old Mandala token residue remains in app source', () => {
  const files = listSrc() // every .ts/.tsx under src except *.test.ts
  for (const f of files) {
    const s = src(f)
    for (const banned of ["'p mandala'", 'mandala-tokens', 'decodeValue', 'transferTokens', 'receiveTokens',
      "'@bsv/mandala/amount'", "'@bsv/mandala/transfer'", "'@bsv/mandala/receive'", "'@bsv/mandala/tokens'", 'formatAmountPlain', 'tm_mandala_registry',
      'mandala.app.handover.' /* the old queue key prefix; the lock name 'mandala.app.handovers' has no trailing dot */, 'handoverQueue', 'localQueueStore'])
      expect(s, `${f} contains ${banned}`).not.toContain(banned)
    expect(s, `${f} uses the removed BASKET`).not.toMatch(/\bBASKET\b/)   // TREASURY_BASKET is allowed (no word boundary after '_')
  }
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/robustness.wiring.test.ts -t residue`
Expected: PASS. If it fails, fix each named file and rerun.

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run`
Expected: all files pass, 0 failures. The file count is the Task 1 count minus the deleted `AccountsOverview.test.ts`, plus the new test files. Compare against the Task 1 record; any non-new failing file is a regression to fix.

- [ ] **Step 4: Typecheck and build**

Run: `npm run build`
Expected: `tsc -b` reports 0 errors and `vite build` exits 0.

- [ ] **Step 5: Docker build (only if docker is available)**

Run from the worktree root: `docker build -f app/Dockerfile --build-arg VITE_OVERLAY_URL=http://localhost:8082 --build-arg VITE_OVERLAY_IDENTITY_KEY=02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046 --build-arg VITE_MESSAGEBOX_URL=https://messagebox.bsvblockchain.tech .`
Expected: success. If `docker` is absent, record "skipped: no docker" in the report.

- [ ] **Step 6: Commit**

`test(app): residue gate for the 1Color port; build green`. The body summarizes the B5 pipeline: the lib journal as the single owner, `drainNow` as the single recovery path, and the immediate settle under the shared lock. It also lists the open contract assumptions (A5, A7, A10–A16) for the upstream report.

---

## Self-review notes (planner)

**Spec coverage (design §2 goals for the app, §4.2 app bullet, §8):**
- uint64 bigint (goal 2): Tasks 3, 5–7, 9, 11–13.
- Deploy with `req` (§4.2, contract §4): Task 12, through `registerAsset`. The lib writes `mandalaReq(K)`, and the app fails closed without K (Task 4).
- New topics: consumed only through the lib. The app pins them in Task 2 and fixes the registry copy in Task 4.
- Admission format: the app never parses STEAK. `settleHandover` and `receiveHandovers` return verified results (Tasks 9–10).
- Payouts (B4): Task 11, consuming `PayoutResult` (`{ txid, notified }`, no authority).
- Sender post-ACK submit (B5): Task 9 (immediate settle under the lock) and Task 8 (lib recovery scheduled by `drainHandovers`).
- Balance semantics (0207:396-404, C40; contract §8.1:572): Tasks 5–7. `unsettled` sits inside the balance, `incoming` sits outside it, and neither is summed.
- `'p mandala'` removal (goal 3, D18): Tasks 4, 6, 7, 14.
- Fee not written (B6): Task 12.
- S5: Task 4.
- Build and test gate: Task 14.

**Type consistency:** `bigint | null` for a holder `balance`; `InventorySummary { unsettled, incoming }` (Task 5) → `AssetRow.unsettled/incoming` (Task 6) → `holderLines` (Task 7); `TreasuryData = Record<string, bigint>`; `Sender = MessageBoxSender`; `DrainState`/`DrainReport`/`withHandoverLock` (Task 8) used by `sendAndDeliver` and `drainNow` (Task 9); `drainNow` used by `useSendMutation` (Task 9), `usePayoutMutation` (Task 11) and `useIssuerMutations` (Task 12); `SendOutcome.settle: SettleVerdict | null`; `PayoutResult` consumed as `{ txid, notified }`. Each is used by name in later tasks. No task references the deleted `QueuedHandover`, `QueueStore`, `toQueued` or `localQueueStore`, except as banned residue.

**Revision 2 issue check:**
- Readiness gate: Task 1 now checks the Task 17 and Task 23 commits, the V3 tarball and a `lib/dist` runtime probe. It does not install in `lib/`.
- Payout shape: Task 11 has no `advanceAdminAuth` and no `isAdminAuthInFlight`, and asserts that `nextAuthOutpoint` is absent.
- Two resume engines: no app queue. `drainHandovers` only schedules `reconcileNotifications` (the sole redelivery) and `reconcileWallet` (the sole settle recovery), plus the self-send mark (A13). No app path calls `abortAction`. A wiring `it` (Tasks 9/12) pins that neither lib recovery function is called anywhere else.
- Pending versus unsettled: Tasks 5–7, and Task 10 wording.

**Proportion:** 14 tasks. Code blocks are tests, and signatures are given only where they cross tasks.

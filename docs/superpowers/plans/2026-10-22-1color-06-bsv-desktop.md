# 1Color / BRC-207 — bsv-desktop (plan 06) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended; this plan is written for subagent-driven execution: one fresh implementer and one fresh reviewer per task) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BSV Desktop runs the upstream BRC-207 `@bsv/color-permission-module` 0.2.0 with the attested and Mandala issuer profiles. It runs on `@bsv/sdk` 4.0.0, `@bsv/wallet-toolbox(-client)` 2.15.0 and `@bsv/templates` 2.2.0. The old `p mandala` module is deleted. The host has exact-decimal consent prompts, a host read-grant policy, a linkage-grant policy for holder sends, a durable module store, periodic settlement, per-asset overlay routing, a broadcast hold for unadmitted 1Color transactions, and typed errors across the BRC-100 HTTP bridge.

**Architecture:** The desktop stays a wallet host. The upstream module does all token logic. Mandala issuer behaviour comes from `createMandalaProfile` in `@bsv/mandala/profile`, and the module routes Mandala assets to the overlay that handler names. The host supplies five pieces:
- a main-process file KV (`ColorModuleStore`), namespaced per identity and chain;
- a consent gate between the module and the React prompt (C10 / audit C6);
- an asset-display resolver, so amounts render with `dec`;
- a SHIP-based default provider for profile-free assets;
- a settle scheduler (D17);
- a broadcast guard in the main process and the monitor worker that holds every unreleased BRC-162 transaction, and a renderer release drain that releases a txid only after `module.isSettled(txid)` (contract §8.2).

Everything is built in `createHostColorModule` and registered under the scheme id `color`. Its lifecycle is bound to the wallet build in `PermissionQueueManager`.

**Tech Stack:** Electron 41, React 18 + MUI 6, TypeScript 5.6 (`strict: false`), Vite 6, Vitest 5 (`vitest.config.electron.ts`, node environment, no jsdom), npm with `file:` vendored tarballs and `$name` overrides.

**Spec:** `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (§4.3, §7 C10, §8 B5). The **authoritative seam contract** is `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/plans/2026-10-22-1color-00-interfaces.md`: §2 (T2 module API, incl. Revision 2 `isSettled`/`dispose`, `[ClassName]` message prefixes, `seekPermission` on every consent type), §5 (linkage), §8.2 (host registration, broadcast guard, HTTP bridge errors), §9 (vendoring), and D17/D19/D20/D22/D24/D29/D30. Audit: `/Users/personal/git/demos/mandala-wt/1color/docs/design/2026-10-21-brc162-brc207-conformance-audit.md` (C5, C6, S2, S3). Pinned specs: **0162** = `docs/design/brc-0162-1color.pinned.md`, **0207** = `docs/design/brc-0207-1color-wallet-module.pinned.md` (both under the mandala worktree). Executors read the design, the contract, and this plan.

**Worktree:** `/Users/personal/git/ts/bsv-desktop-wt/1color`, branch `feat/1color` (base `361778c`). Every path below is relative to it unless it is absolute.

---

## Global Constraints

- Touch only `/Users/personal/git/ts/bsv-desktop-wt/1color`. Never touch `/Users/personal/git/ts/bsv-desktop`, `/Users/personal/git/ts-stack`, `/Users/personal/git/bsv-wallet` or `/Users/personal/git/demos/mandala`. Read tarballs from `/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack/` and never write there.
- Commit on `feat/1color` only. No push, no tag, no npm publish, no merge (a later stage opens draft PRs).
- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (shown once here, required on every commit below).
- Vendoring (contract §9): copy the tarballs into `vendor/`, which is un-ignored by `.gitignore` `!vendor/**`. Each used package is a direct `"file:vendor/<tarball>"` dependency, and every vendored name gets an `"overrides"` entry `"<name>": "$<name>"`. Keep the existing `qs` and `app-builder-lib` overrides. Commit `vendor/*.tgz` and `package-lock.json`. Take all ts-stack tarballs from the same `<sha>` suffix. If a required tarball is missing, the task is **BLOCKED**: stop and report. Never substitute an older version (for example module 0.1.0 for 0.2.0).
- `@bsv/templates` `Bsv21Token.ts` is never modified. Nothing in this plan edits anything under `node_modules`.
- No backward compatibility (design §3): no migration of the `p mandala` basket, its outputs, the `[2,'p mandala token']` keys or the old prompt messages.
- Token amounts are bigint, or canonical decimal strings `^(0|[1-9][0-9]*)$`. Never `Number()`, `parseInt` or float on a token amount. A per-output amount is `0..18446744073709551615` (0162:139-141). Sums are unbounded exact integers (0162:143). `dec` is a uint `0..18`, default `0` (0162:246-252).
- Asset id: `^[0-9a-f]{64}_(0|[1-9][0-9]{0,9})$`. Outpoint: `<64 lowercase hex>.<canonical vout>`. Identity key: `^0[23][0-9a-f]{64}$` (contract §0).
- Profile ids: `ATTESTED_PROFILE_ID = 'https://brc.dev/207/attested'`. `MANDALA_PROFILE_ID = 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md'` (contract §4).
- Fail closed (S5). With no Mandala overlay configured, Mandala assets are refused. The desktop registers `createMandalaProfile({ overlays: [] })` and never invents an overlay.
- Host grant policy (design C10, audit C6): one 30-minute (`1_800_000` ms) **read** grant per originator, set only by approving `color_access`. Spend, signature, relinquish and offline-receive approvals never set or consume it. `seekPermission === false` with no applicable grant throws instead of prompting. The exact texts are `Colored Tokens inventory read permission is required` (0207:8027) and `Colored Tokens spending permission is required` (0207:3186).
- Errors are matched by `.name`, then by the `'[<ClassName>] '` message prefix, never `instanceof` across bundles (D22, contract §2.4). The BRC-100 HTTP bridge forwards `{ message, name, code?, retryable?, transport? }` (contract §8.2, Task 13).
- Broadcast guard (contract §8.2): no transaction with a BRC-162 output, and no child of one that this wallet holds, reaches ARC/Arcade before the renderer has released it after `module.isSettled(txid) === true`. The guard keys on a host-owned journal (`~/.bsv-desktop/color-guard/`), never on `color.v1.*` keys. Every guard fault holds (Task 14).
- Linkage grant (D20, Task 12): with the encrypt / linkage-revelation prompts enabled, approving a `Mandala token sending` prompt grants that originator, for 30 minutes, the security-level-2 protocols named `specific linkage revelation 2 p color …` toward a configured Mandala overlay key. `counterparty key linkage revelation <B>` toward that key prompts once per (originator, B) per 30 minutes.
- BSV Chronicle: never normalize S. The desktop adds no signature verification of its own.
- Settlement (D17): `module.settle()` runs once after wallet open (1 000 ms initial delay), every `300_000` ms, and on the window `online` event. It is single-flight and stops on wallet close.
- The BRC-100 HTTP JSON body limit stays at least 32 MiB (D30). The current limit is `'50mb'` at `electron/httpServer.ts:89-90`.
- Stability mandate: every pipeline change is reasoned through crash, double-click/double-submit, multi-window/concurrent requests, stale cache and retry. Each task's tests name the cases they pin.
- Test gate commands (run from the worktree root):
  - unit: `npm test`. This is an **explicit file list** in `package.json` `scripts.test`, so **every new test file must be appended to that list in the task that creates it**.
  - webrtc: runs as part of `npm test` via `test:webrtc`.
  - typecheck: `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.electron.json`.
  - build: `npm run build`.
  - single file: `npx vitest run --config vitest.config.electron.ts test/<file>.test.ts`.

## Review Focus

1. **Read/spend grant isolation and `seekPermission:false`.** An app that got a token spend approved, then lists `p color assets` with `seekPermission:false`, must get the A.115 error with no prompt. It must not get a free inventory read. Pinned by Task 6 `spend approval never grants reads` and `seekPermission false never prompts`.
2. **Exact amounts at the uint64 edge and beyond.** A prompt for `18446744073709551615` units at `dec 18` must read `18.446744073709551615`. A leg sum above 2^64 must render digit-exact. A non-canonical amount (`"01"`, `"1e3"`, a JSON number) must refuse the prompt instead of showing a wrong figure. Pinned by Task 7 `renders the A.38 maximum exactly` and `rejects non-canonical amounts`.
3. **Crash and concurrency in the module store.** A crash mid-write must leave the previous value and no phantom key. Fifty concurrent writes of one key must end with the last value and no temp files. Settlement evidence lives here (D5). Pinned by Task 5 `ignores and removes a crash-leftover temp file` and `serializes concurrent writes of one key`.
4. **Wallet rebuild (network switch, profile switch, logout).** The old module must be disposed, its settle timer and `online` listener removed, and its grants dropped. The new module must use the new identity/chain store namespace, and two schedulers must never run. Pinned by Task 9 `stop removes the timer and the online listener` and Task 12 `disposes the previous modules on rebuild and on close`.
5. **Large attested receipts and hand-over evidence through the HTTP bridge.** A 16 MiB `customInstructions` `internalizeAction` must reach the module unchanged and must not be rejected at 1 000 bytes or by the body limit. A `signAction` result's `colorHandoff` must survive the JSON bridge (D4, D29, D30). Pinned by Task 13 `routes a 2 MiB p color receipt through the manager to the module` and `colorHandoff survives the bridge round trip`.
6. **Error identity across the HTTP bridge.** A thrown `AttestationEvidenceError` must leave the bridge as `{ message: '[AttestationEvidenceError] …', name: 'AttestationEvidenceError' }`, and a `ColorProviderError` must also carry `code`, `retryable` and `transport`. Otherwise the Mandala lib cannot tell a final refusal from a retry and re-internalizes the same bad receipt on every poll. The body must never carry `isError`, because the sdk client then rejects the envelope. Pinned by Task 13 `forwards the error name and typed fields` and `no generic { message } error path remains`.
7. **Offline receipt with the overlay down and ARC up.** `internalizeAction` of a `color_offline` receipt must credit the output (the hold reports success to the toolbox) and must not post the transaction. It is posted only after `isSettled(txid)` and the release. Crash between release and post, a duplicate release, two drains, the worker's `TaskSendWaiting`, and a journal read fault must never post an unreleased tx. Pinned by Task 14 `holds an offline 1Color receipt and reports success`, `the worker postBeef wrapper withholds an unreleased token tx`, `a crash after the release write re-posts on the next release` and the Electron-node integration test `fake ARC never sees the receipt before release`.
8. **Linkage prompts per holder send.** Two holder sends from `app.example` must not produce one prompt per send. Neither `revealCounterpartyKeyLinkage` nor `encrypt` under `specific linkage revelation 2 p color …` may be refused by the module or the manager. Pinned by Task 12 `holder-send linkage: default config never prompts` and `holder-send linkage with prompts enabled: one grant covers later sends`.

---

## Prerequisites (orchestrator)

| Needed by | Tarballs in `/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack/` |
|---|---|
| Tasks 2-9 (V0, contract §10) | `bsv-sdk-4.0.0-<sha>.tgz`, `bsv-wallet-toolbox-2.15.0-<sha>.tgz`, `bsv-wallet-toolbox-client-2.15.0-<sha>.tgz`, `bsv-templates-2.1.0-<sha>.tgz` or `bsv-templates-2.2.0-<sha>.tgz` |
| Tasks 10-15 (V2 + V3) | the above re-packed after T1/T2, plus `bsv-templates-2.2.0-<sha>.tgz`, `bsv-color-permission-module-0.2.0-<sha>.tgz`, `bsv-mandala-0.5.0-<msha>.tgz` |

Tasks 2-9 depend only on V0. Tasks 5-9 do not import the color module at all: they use local structural types. Task 10 is the first task that needs 0.2.0 and `@bsv/mandala` 0.5.0. Task 14 needs `ColorPermissionModule.isSettled` (contract §2.3, Revision 2) and lib `decodeToken` (contract §8.1). If the vendored 0.2.0 has no `isSettled`, Task 14 is BLOCKED. Task 15 re-vendors whatever newest shas exist at that time.

---

### Task 1: Baseline

**Files:** none modified.

**Interfaces:** Consumes nothing. Produces the recorded baseline below, which every later task compares against.

Baseline measured by the planner on 2026-10-22 at `361778c` (sdk 2.8.11, toolbox 2.14.9, templates 2.0.0, Node v24.15.0):
- `npm test` gives `Test Files 51 passed | 3 skipped (54)` and `Tests 643 passed | 22 skipped (665)`. Then `test:webrtc` gives `Test Files 2 passed (2)` and `Tests 107 passed (107)`.
- Both `tsc --noEmit` configs exit 0.
- The 3 skipped files are `storageIdentity.integration`, `networkSwitch.integration` and `storageIdentity.test` (better-sqlite3 is built for Electron's ABI, so `canUseBetterSqlite3()` is false under plain Node).
- `test/mandalaPermissionModule.test.ts` and `test/mandalaPermissionModule.wiring.test.ts` are **not** in the `npm test` list. They import `@bsv/mandala/unlock`, which is not installed, and they fail if run.

- [ ] **Step 1: Confirm the worktree state**

Run: `git -C /Users/personal/git/ts/bsv-desktop-wt/1color status --porcelain && git -C /Users/personal/git/ts/bsv-desktop-wt/1color rev-parse --abbrev-ref HEAD`
Expected: empty status, then `feat/1color`.

- [ ] **Step 2: Run the unit gate**

Run: `npm test 2>&1 | grep -E "Test Files|Tests "`
Expected: the four summary lines above. Any difference is recorded in the task report as pre-existing, not fixed here.

- [ ] **Step 3: Run the typecheck gate**

Run: `npx tsc --noEmit -p tsconfig.json; echo $?; npx tsc --noEmit -p tsconfig.electron.json; echo $?`
Expected: `0` and `0`.

- [ ] **Step 4: Run the sqlite files under Electron's Node (best effort, recorded)**

Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run --config vitest.config.electron.ts test/storageIdentity.integration.test.ts test/storageIdentity.test.ts test/networkSwitch.integration.test.ts 2>&1 | grep -E "Test Files|Tests "`
Expected: a pass/skip count, which becomes the toolbox-storage baseline for Task 15. If the command itself cannot run, record "not runnable" and Task 15 skips this step (and Task 14's Electron-node integration test is reported as not run).

- [ ] **Step 5: Record**

No commit. Put the four numbers into the task report for the orchestrator.

---

### Task 2: Vendor sdk 4.0.0 / toolbox 2.15.0 / templates and fix every 2.x→4.0 break

**Files:**
- Create: `vendor/bsv-sdk-4.0.0-<sha>.tgz`, `vendor/bsv-wallet-toolbox-2.15.0-<sha>.tgz`, `vendor/bsv-wallet-toolbox-client-2.15.0-<sha>.tgz`, `vendor/bsv-templates-<2.1.0|2.2.0>-<sha>.tgz` (copied)
- Modify: `package.json` (dependencies `@bsv/sdk`, `@bsv/templates`, `@bsv/wallet-toolbox`, `@bsv/wallet-toolbox-client`; `overrides`), `package-lock.json`
- Create: `src/lib/utils/listOutputsCount.ts`
- Modify: `src/lib/utils/loadAccountBalance.ts:16`, `src/lib/pages/Dashboard/Settings/WalletDiagnosis.tsx:140,327,417`, `src/lib/services/walletCheck/ports.ts:12,84`, plus every other file `tsc` reports
- Test: `test/listOutputsCount.test.ts` (new, append to `scripts.test`), `test/loadAccountBalance.test.ts` (extend)

**Interfaces:**
- Consumes: V0 tarballs.
- Produces: `readCount(value: number | string, what: string): number` in `src/lib/utils/listOutputsCount.ts`. It returns a non-negative safe integer. It throws `Error(\`${what} is not a safe non-negative integer count\`)` for a non-integer, a negative value, a non-canonical decimal string, or a value above `Number.MAX_SAFE_INTEGER`.

Known 2.x→4.0 breaks, from the ts-stack `packages/sdk/CHANGELOG.md` Unreleased section:
- **(a)** `ListOutputsResult.totalOutputs` is `number | DecimalString` (BRC-112 module balances).
- **(b)** The DID token validation module is removed (`decodeCanonicalDIDToken` and friends). Grep found no desktop use, but confirm.
- **(c)** The binary BRC-100 `listOutputs` adds a `spendable` byte. `test/walletCreateActionWire.test.ts` exercises `WalletWireProcessor/Transceiver` with the same sdk on both sides.
- **(d)** Overlay topic/lookup name grammar is widened (no desktop impact).
- **(e)** Engines: `node >=22` (Electron 41 and dev Node 24 both satisfy it).

`tsc` is the authority for anything else. Forced transitive users of sdk 4.0.0 (all declare `^2 || ^3`): btms, btms-permission-module, identity-react, metanet-react-prompt, message-box-client, authsocket-client, uhrp-react, webrtpay, metanet-apps, auth/payment-express-middleware. `npm run build` and the full test run are the checks for them.

- [ ] **Step 1: Write the failing tests**

```ts
// test/listOutputsCount.test.ts
import { readCount } from '../src/lib/utils/listOutputsCount'
test('accepts numbers and canonical decimal strings', () => {
  expect(readCount(0, 'n')).toBe(0)
  expect(readCount(1_234_567, 'n')).toBe(1234567)
  expect(readCount('1234567', 'n')).toBe(1234567)
  expect(readCount('9007199254740991', 'n')).toBe(9007199254740991)
})
test('rejects anything that is not an exact safe count', () => {
  for (const bad of ['9007199254740992', '01', '-1', '1e3', '', ' 1', 1.5, -1, Number.NaN] as const)
    expect(() => readCount(bad as any, 'Outputs')).toThrow('Outputs is not a safe non-negative integer count')
})
// test/loadAccountBalance.test.ts, add:
test('accepts a decimal-string total from a 4.0 wallet', async () => {
  const listOutputs = vi.fn().mockResolvedValue({ totalOutputs: '1234567', outputs: [] })
  await expect(loadAccountBalance({ listOutputs } as any, 'wallet.internal')).resolves.toBe(1234567)
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/listOutputsCount.test.ts test/loadAccountBalance.test.ts`
Expected: FAIL. The module `listOutputsCount` does not exist, and the decimal-string case returns `'1234567'`.

- [ ] **Step 3: Vendor and install**

Copy the four tarballs. Set the four `file:vendor/...` specs. Add `"@bsv/sdk": "$@bsv/sdk"`, `"@bsv/templates": "$@bsv/templates"`, `"@bsv/wallet-toolbox": "$@bsv/wallet-toolbox"` and `"@bsv/wallet-toolbox-client": "$@bsv/wallet-toolbox-client"` to `overrides`. Then run `npm install --no-audit --no-fund`.
Check: `npm ls @bsv/sdk` shows only `4.0.0` (every entry `deduped` or overridden). `npm ls @bsv/wallet-toolbox-client` shows only `2.15.0`.

- [ ] **Step 4: Implement `readCount` and route every `totalOutputs` count through it**

Change `loadAccountBalance`, the `WalletDiagnosis.tsx` count reads and arithmetic (`:140`, `:327`, `:417`) and `walletCheck/ports.ts:84` to use `readCount(…)`. Run `grep -rn "DIDToken\|decodeCanonicalDIDToken" src electron`; expected no output. Then run both `tsc` configs and fix every remaining error at its source. Never use `as any` to silence a `number | string` count.

- [ ] **Step 5: Run the gate**

Run: `npm test 2>&1 | grep -E "Test Files|Tests "` then both `tsc` configs, then `npm run build`.
Expected: unit tests at baseline plus the new tests (52 passed | 3 skipped files), webrtc `107 passed`, `tsc` exits 0 twice, and `vite build` succeeds. A transitive package that fails to bundle or test under 4.0.0 is a STOP. Report the package and error. Do not patch `node_modules`.

- [ ] **Step 6: Commit**

```bash
git add vendor package.json package-lock.json src test
git commit -m "chore(deps): vendor @bsv/sdk 4.0.0, wallet-toolbox 2.15.0, templates; read totalOutputs as exact counts"
```

---

### Task 3: Delete the `p mandala` P-module

**Files:**
- Delete: `src/lib/permissionModules/mandala.ts`, `src/lib/permissionModules/mandala/permissionModule.ts`, `src/lib/permissionModules/mandala/Prompt.tsx`, `src/lib/permissionModules/mandala/token.ts`, `src/lib/permissionModules/mandala/types.ts`, `test/mandalaPermissionModule.test.ts`, `test/mandalaPermissionModule.wiring.test.ts`
- Modify: `src/lib/services/PermissionQueueManager.ts:27-28` (imports) and `:955-959` (drop the `wrapCreateActionForTokenInputs` proxy and return the plain `WalletPermissionsManager`); `src/main.tsx:9,33` (register `[btmsPermissionModule]` only; Task 12 adds `color`); `src/lib/permissionModules/registry.ts:24-28` (comment: drop the Mandala example)
- Test: `test/permissionModuleRegistry.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Consumes: `buildPermissionModuleRegistry(modules: PermissionModuleDefinition[])` (unchanged).
- Produces: `PermissionQueueManager.createPermissionsManager(wallet)` returns an unwrapped `WalletPermissionsManager`.

Why removing the input-routing wrapper is safe: `WalletPermissionsManager.createAction` routes by output baskets and labels only, not by inputs (toolbox `WalletPermissionsManager.ts` ~4417. An app can spend a wallet `p color` output only with a signature from a `p color` key. That `createSignature` is routed to the upstream module, which requires a BRC-207 envelope and consent (0207 A.13, 0207:2195). Task 12 pins this with a test.

- [ ] **Step 1: Write the failing test**

```ts
// test/permissionModuleRegistry.test.ts
import { buildPermissionModuleRegistry } from '../src/lib/permissionModules/registry'
import { btmsPermissionModule } from '../src/lib/permissionModules/btms'
test('a saved mandala id is dropped and defaults are restored', () => {
  const r = buildPermissionModuleRegistry([btmsPermissionModule])
  expect(r.restoreEnabledPermissionModules(['btms', 'mandala'])).toEqual(['btms'])
  expect(r.getPermissionModuleById('mandala')).toBeUndefined()
})
test('the Mandala module source is gone', async () => {
  await expect(import('../src/lib/permissionModules/mandala')).rejects.toThrow()
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run --config vitest.config.electron.ts test/permissionModuleRegistry.test.ts`
Expected: FAIL on the second test, because the mandala module still imports.

- [ ] **Step 3: Delete the files and unwrap the manager**

Delete the files listed above. Make the manager change in `PermissionQueueManager.ts`.

- [ ] **Step 4: Verify**

Run: `grep -rn "p mandala\|permissionModules/mandala\|MandalaTokenModule\|wrapCreateActionForTokenInputs" src electron test`. Expected: no output.
Then run `npx vitest run --config vitest.config.electron.ts test/permissionModuleRegistry.test.ts test/counterpartyPermissions.test.ts`, then `npm test` and both `tsc` configs.
Expected: PASS. Unit counts equal Task 2's plus this file.

- [ ] **Step 5: Commit**

```bash
git add -A src test package.json
git commit -m "refactor!: remove the p mandala permission module (replaced by the BRC-207 color module)"
```

---

### Task 4: Mandala overlay setting per network

**Files:**
- Modify: `src/lib/networkConfig.ts` and `electron/networkConfig.ts`. The two must stay identical except line 1 (`networkSettings.test.ts` asserts the default maps are equal).
- Modify: `src/lib/components/NetworkSettingsDialog.tsx` (two fields under the Message Box fields)
- Test: `test/networkSettings.test.ts` (extend)

**Interfaces:**
- Produces, exported from both `networkConfig.ts` files:
  - `interface MandalaOverlaySetting { url: string; identityKey: string }`
  - `NetworkSettings.mandalaOverlays: MandalaOverlaySetting[]` (default `[]` on every network, which fails closed per S5)
  - `normalizeMandalaOverlays(value: unknown, strict: boolean): MandalaOverlaySetting[]`
- `normalizeNetworkSettings` calls it with `strict = requireServices`. `restoreNetworkSettings` uses the lenient path: it drops invalid entries instead of throwing.
- Rules:
  - At most 4 entries.
  - `url` goes through the existing `serviceUrl(value, 'Mandala overlay URL', true)`.
  - `identityKey` is trimmed and lowercased, then must match `^0[23][0-9a-f]{64}$`.
  - No duplicate `identityKey`.
- Strict errors, exact text:
  - `At most 4 Mandala overlays`
  - `Mandala overlay identity key must be a 66-character compressed public key in hex`
  - `Each Mandala overlay identity key may appear once`
- Dialog: one URL field and one key field edit `mandalaOverlays[0]`. Both empty means `[]`. Exactly one empty shows the error `Mandala overlay URL and identity key must be set together`. Before saving, the dialog also checks the key on the curve with `PublicKey.fromString` from `@bsv/sdk` (renderer only). Saving goes through the existing `applyNetworkSettings`, which rebuilds the wallet, so the module picks up the new overlay.

- [ ] **Step 1: Write the failing tests** (in `test/networkSettings.test.ts`)

```ts
const K = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
it('defaults to no Mandala overlay on every network in both processes', () => {
  for (const { id } of frontend.NETWORKS) {
    expect(frontend.defaultNetworkSettings(id).mandalaOverlays).toEqual([])
    expect(backend.defaultNetworkSettings(id).mandalaOverlays).toEqual([])
  }
})
it('normalizes a valid overlay and rejects bad ones strictly', () => {
  for (const config of [frontend, backend]) {
    expect(config.normalizeNetworkSettings('test', { mandalaOverlays: [{ url: 'https://ov.example/', identityKey: ` ${K.toUpperCase()} ` }] }).mandalaOverlays)
      .toEqual([{ url: 'https://ov.example', identityKey: K }])
    expect(() => config.normalizeNetworkSettings('test', { mandalaOverlays: [{ url: 'https://ov.example', identityKey: '04' + 'ab'.repeat(32) }] }))
      .toThrow('Mandala overlay identity key must be a 66-character compressed public key in hex')
    expect(() => config.normalizeNetworkSettings('test', { mandalaOverlays: [{ url: 'https://a.example', identityKey: K }, { url: 'https://b.example', identityKey: K }] }))
      .toThrow('Each Mandala overlay identity key may appear once')
    expect(() => config.normalizeNetworkSettings('test', { mandalaOverlays: [{ url: 'ftp://x', identityKey: K }] })).toThrow('Mandala overlay URL')
  }
})
it('restoring saved settings drops an invalid overlay instead of failing', () => {
  expect(frontend.restoreNetworkSettings({ test: { mandalaOverlays: [{ url: 'nope', identityKey: 'x' }] } }).test.mandalaOverlays).toEqual([])
})
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/networkSettings.test.ts`
Expected: FAIL, `mandalaOverlays` is undefined.

- [ ] **Step 3: Implement `normalizeMandalaOverlays` and the new field in both files, then the two dialog fields**

- [ ] **Step 4: Run the tests**

Run: the same file, then `npm test` and both `tsc` configs.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/networkConfig.ts electron/networkConfig.ts src/lib/components/NetworkSettingsDialog.tsx test/networkSettings.test.ts
git commit -m "feat(settings): per-network Mandala overlay (url + identity key), empty by default"
```

---

### Task 5: Durable `ColorModuleStore` (main-process file KV over IPC)

**Files:**
- Create: `electron/colorStore.ts`
- Modify:
  - `electron/main.ts` (construct and register next to `registerFeeSettingsIpc` at `:267-271`)
  - `electron/preload.ts` (expose `colorStore` in `exposeInMainWorld` and in `interface ElectronAPI`)
  - `src/global.d.ts` (the `electronAPI` type, next to `fees` at `:27`)
- Create: `src/lib/permissionModules/color/store.ts`
- Test: `test/colorStore.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Produces, in `electron/colorStore.ts`:
  - `class ColorStoreService`, constructed with `options?: { root?: string /* default ~/.bsv-desktop/color-store */; maxValueBytes?: number /* default 33_554_432 */ }`. Methods:
    - `get(identityKey: unknown, chain: unknown, key: unknown): Promise<string | undefined>`
    - `set(identityKey: unknown, chain: unknown, key: unknown, value: unknown): Promise<void>`
    - `delete(identityKey: unknown, chain: unknown, key: unknown): Promise<void>`
    - `keys(identityKey: unknown, chain: unknown, prefix: unknown): Promise<string[]>` (sorted ascending)
  - `registerColorStoreIpc(ipcMain: { handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void }, service: ColorStoreService): void`. It registers the channels `color-store:get`, `color-store:set`, `color-store:delete` and `color-store:keys`, with the argument order of the methods above.
- Produces, in `src/lib/permissionModules/color/store.ts`:
  - `type ColorModuleStoreLike = { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void>; keys(prefix: string): Promise<string[]> }`. This is structurally the contract §2.1 `ColorModuleStore`.
  - `createIpcColorModuleStore(identityKey: string, chain: WalletNetwork, api?: Window['electronAPI']['colorStore']): ColorModuleStoreLike`
- Layout:
  - One directory per namespace: `<root>/<identityKey>-<chain>/`.
  - One file per key: `<sha256hex(utf8 key)>.json` containing `{"k": key, "v": value}`.
- Write path: write `<name>.<randomUUID>.tmp`, `fsync`, `rename` over the target, then a best-effort directory `fsync`.
- An in-memory index (key → file) per namespace is built lazily on first access. At the same time, leftover `*.tmp` files (crash leftovers) are deleted.
- `set` and `delete` are serialized per namespace through a promise chain. The main process is the single writer, and every renderer window goes through IPC.
- A file whose JSON does not parse, or whose `k` differs from the requested key, reads as absent.
- Validation, exact error text:
  - identity `^0[23][0-9a-f]{64}$`, else `Invalid color store identity`
  - chain in `main|test|ttn|tstn`, else `Invalid color store chain`
  - key is a string starting `color.v1.` with length ≤ 1024, else `Invalid color store key`
  - value is a string of at most `maxValueBytes` UTF-8 bytes, else `Color store value exceeds 32 MiB`
- Why not `localStorage`:
  - It is one origin shared by all identities.
  - "clear local wallet state" wipes it.
  - Its flushes are not crash-durable.
  - Contract D5 needs durable receipt evidence.

- [ ] **Step 1: Write the failing tests** (a temp `root` per test via `fs.mkdtempSync`)

```ts
const A = '02' + 'aa'.repeat(32), B = '03' + 'bb'.repeat(32)
test('round trip, overwrite, delete, missing', async () => {
  const s = new ColorStoreService({ root })
  await s.set(A, 'test', 'color.v1.settled.t1', '1'); await s.set(A, 'test', 'color.v1.settled.t1', '2')
  expect(await s.get(A, 'test', 'color.v1.settled.t1')).toBe('2')
  await s.delete(A, 'test', 'color.v1.settled.t1'); await s.delete(A, 'test', 'color.v1.settled.t1')
  expect(await s.get(A, 'test', 'color.v1.settled.t1')).toBeUndefined()
})
test('keys filters by prefix, sorted, per identity and chain', async () => { /* A/test: settled.b, settled.a, receipt.x; B/test and A/main: settled.z
  expect(await s.keys(A,'test','color.v1.settled.')).toEqual(['color.v1.settled.a','color.v1.settled.b']) */ })
test('survives a restart (new service, same root)', async () => { /* set with s1, read with new ColorStoreService({ root }) */ })
test('ignores and removes a crash-leftover temp file', async () => {
  /* set k=old; write `<dir>/<sha(k)>.json.123.tmp` with {"k":k,"v":"new"}; new service:
     get(k) === 'old'; keys('color.v1.') === [k]; no *.tmp left in dir */
})
test('serializes concurrent writes of one key', async () => {
  await Promise.all(Array.from({ length: 50 }, (_, i) => s.set(A, 'test', 'color.v1.k', String(i))))
  expect(await s.get(A, 'test', 'color.v1.k')).toBe('49')   // last enqueued wins
  expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
})
test('a 16 MiB value round-trips; 32 MiB + 1 is refused', async () => { /* 'x'.repeat(16*1024*1024+1024) ok; 'x'.repeat(33_554_433) -> 'Color store value exceeds 32 MiB' */ })
test('validates identity, chain and key', async () => {
  await expect(s.get('02zz', 'test', 'color.v1.a')).rejects.toThrow('Invalid color store identity')
  await expect(s.get(A, 'regtest', 'color.v1.a')).rejects.toThrow('Invalid color store chain')
  await expect(s.set(A, 'test', 'other.a', 'v')).rejects.toThrow('Invalid color store key')
})
test('registers the four IPC channels and delegates', async () => { /* fake ipcMain records handlers; call 'color-store:set' then 'color-store:get' */ })
test('renderer store passes identity and chain through', async () => { /* createIpcColorModuleStore(A, 'test', fakeApi).keys('color.v1.') -> fakeApi.keys(A,'test','color.v1.') */ })
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorStore.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `ColorStoreService`, `registerColorStoreIpc`, the preload exposure and types, the `main.ts` registration, and `createIpcColorModuleStore`**

- [ ] **Step 4: Run the tests**

Run: the same file, then `npm test` and both `tsc` configs.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/colorStore.ts electron/main.ts electron/preload.ts src/global.d.ts src/lib/permissionModules/color/store.ts test/colorStore.test.ts package.json
git commit -m "feat(color): durable per-identity/chain module store in the main process (atomic writes)"
```

---

### Task 6: Host consent gate (C10 / audit C6)

**Files:**
- Create: `src/lib/permissionModules/color/consentGate.ts`
- Test: `test/colorConsentGate.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Consumes: `PermissionPromptHandler` from `src/lib/permissionModules/types.ts`.
- Produces, in `consentGate.ts`:
  - `const READ_GRANT_MS = 1_800_000`
  - `class ColorPermissionRequiredError extends Error`, with `name = 'ColorPermissionRequiredError'`
  - `createColorConsentGate(o: { adminOriginator: string; prompt: PermissionPromptHandler; now?: () => number; enrich?: (message: string) => Promise<string> }): ((app: string, message: string) => Promise<boolean>) & { clear(): void }`. The returned function is structurally the module's `ColorTokenAccessHandler`.
- Rules, in order:
  1. The message is parsed as JSON. A non-object, or a `type` outside `color_access | color_send | color_signature | color_relinquish | color_receive_offline`, returns `false` with no prompt.
  2. `color_access`:
     - The admin originator gets `true` with no prompt and no grant.
     - A live read grant for that originator (`now() - grantedAt <= READ_GRANT_MS`) gives `true` with no prompt.
     - With no grant and `seekPermission === false`: throw `ColorPermissionRequiredError('Colored Tokens inventory read permission is required')` (0207:8027).
     - Otherwise prompt. Concurrent `color_access` calls for one originator join one in-flight prompt. Approval sets the grant at approval time. Denial returns `false` to every joined caller and sets nothing.
  3. `color_send | color_signature | color_relinquish`: never read or write the grant, and admin is not exempt. `seekPermission === false` throws `ColorPermissionRequiredError('Colored Tokens spending permission is required')` (0207:3186). Otherwise prompt every time.
  4. `color_receive_offline` (contract §2.5, D19): prompt every time, no continuing grant (decision recorded in the report). `seekPermission === false` throws `ColorPermissionRequiredError('Colored Tokens receive permission is required')`.
  5. Contract §2.5 (Revision 2): every consent type carries `seekPermission`. A missing `seekPermission` still means `true` (defensive; the value is never trusted to be present).
  6. The prompt receives `await enrich(message)` when `enrich` is set, else the raw message. An `enrich` failure falls back to the raw message.
  7. A prompt that rejects (throws) counts as `false`.
  8. `clear()` drops all grants. In-flight prompts resolve normally but grant nothing after `clear()`.

- [ ] **Step 1: Write the failing tests**

```ts
const access = (o: object = {}) => JSON.stringify({ type: 'color_access', basket: 'p color assets', seekPermission: true, ...o })
const send = (o: object = {}) => JSON.stringify({ type: 'color_send', assets: [], ...o })
test('an approved read grants 30 minutes of reads for that originator only', async () => { /* prompt->true once; 2nd call same app: no prompt; other app: prompts; now += 1_800_001 -> prompts again */ })
test('spend approval never grants reads', async () => {
  const prompt = vi.fn().mockResolvedValue(true); const gate = createColorConsentGate({ adminOriginator: 'admin', prompt })
  expect(await gate('app', send())).toBe(true)
  await expect(gate('app', access({ seekPermission: false }))).rejects.toThrow('Colored Tokens inventory read permission is required')
  expect(prompt).toHaveBeenCalledTimes(1)
})
test('a read grant never satisfies a spend', async () => { /* approve access, then send -> prompt called again (2 total) */ })
test('seekPermission false never prompts', async () => {
  await expect(gate('app', access({ seekPermission: false }))).rejects.toMatchObject({ name: 'ColorPermissionRequiredError' })
  await expect(gate('app', send({ seekPermission: false }))).rejects.toThrow('Colored Tokens spending permission is required')
  expect(prompt).not.toHaveBeenCalled()
})
test('concurrent reads join one prompt; denial rejects all and grants nothing', async () => { /* 3 parallel access calls with a deferred prompt -> prompt once; resolve false -> [false,false,false]; next call prompts again */ })
test('admin reads pass silently, admin spends still prompt', async () => { /* gate('admin', access()) true, prompt 0; gate('admin', send()) -> prompt 1 */ })
test('unknown or malformed messages are declined without a prompt', async () => { /* 'not json', '[]', {type:'mandala_access'} -> false, prompt 0 */ })
test('receive-offline prompts every time', async () => { /* two calls -> two prompts */ })
test('prompt sees the enriched message; enrich failure falls back', async () => { /* enrich adds hostDisplay; then enrich throws -> raw */ })
test('clear drops grants', async () => { /* approve, clear(), access prompts again */ })
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorConsentGate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createColorConsentGate` in `consentGate.ts`**

- [ ] **Step 4: Run the tests**

Run: the same file, then `npm test` and both `tsc` configs.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissionModules/color/consentGate.ts test/colorConsentGate.test.ts package.json
git commit -m "feat(color): host consent gate - 30-min read grant isolated from spends, seekPermission:false errors"
```

---

### Task 7: Consent view model and exact amount formatting

**Files:**
- Create: `src/lib/permissionModules/color/consentView.ts`
- Test: `test/colorConsentView.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Consumes: the JSON the module sends. `color_send`/`color_signature` follow upstream `actionConsent`/`transactionConsent` (`ColorPermissionModule.ts` 0.1.0 :338-460):
  - `assets[]` with `assetId`, `operations[]`, the decimal strings `inputAmount`, `foreignAmount`, `keptAmount`, `outgoingAmount`, `transferred`, `burned` and `minted`, and the integers `authorityInputs`, `foreignAuthorityInputs`, `keptAuthorities` and `outgoingAuthorities`;
  - optional `deploy{operation, amount, owned}`;
  - `destinations[]{outputIndex, satoshis, lockingScript, assetId?, role?, amount?}`;
  - `satoshis{inputs, outputs, fee}`, `signatures[]{outpoint, inputIndex, sighashType}`, `lockTime`, `handoff` (send only) and `inputIndex` (signature only).
  - `color_access{basket? | labels?, assetId?, role?, seekPermission}`; `color_relinquish{assetId, role, outpoint}`; `color_receive_offline` per contract §2.5.
  - An optional host member `hostDisplay: Record<assetId, AssetDisplay>` (Task 11).
- Produces:
  - `interface AssetDisplay { assetId: string; sym?: string; label?: string; dec: number; mandala: boolean }`
  - `class InvalidColorRequestError extends Error` (`name = 'InvalidColorRequestError'`)
  - `formatUnits(units: bigint, dec: number): string`. It is exact: it pads the fraction to `dec` digits and keeps trailing zeros. It throws `RangeError` for `units < 0n`, or `dec` that is not an integer `0..18`.
  - `formatTokenAmount(units: string, display?: AssetDisplay): string`:
    - with `display`: `formatUnits(BigInt(units), display.dec)` plus `' ' + sym` when `sym` is set;
    - without `display`: `` `${units} base units` ``.
  - `buildColorConsentView(message: string): ColorConsentView`, which throws `InvalidColorRequestError`.
  - `interface ColorConsentView` with:
    - `{ type; title: string; originatorNote?: string; handoff: boolean;`
    - `assets: Array<{ assetId: string; name: string; operations: string[]; lines: Array<{ label: string; amount: string }> }>;`
    - `destinations: Array<{ outputIndex: number; satoshis: number; token?: { assetId: string; role: string; amount: string } }>;`
    - `satoshis?: { inputs: number; outputs: number; fee: number }; signatures: Array<{ outpoint: string; inputIndex: number; sighashType: number }>; lockTime?: number;`
    - `access?: { basket?: string; labels?: string[]; assetId?: string; role?: string }; relinquish?: { assetId: string; role: string; outpoint: string };`
    - `offline?: { assetId: string; outputs: Array<{ outputIndex: number; amount: string }>; unsettledTransactions: number; signers: string[]; profiles: string[] } }`. Contract §2.5: `identity` mode sends `signer` (the view sets `signers = [signer]`); `any`/`same`/`all` send `signers: string[]`. Exactly one of the two must be present, each key must match `^0[23][0-9a-f]{64}$`, else `InvalidColorRequestError`.
- Titles, exact:
  - `color_send`: `Approve token transaction`, or `Approve token hand-over` when `handoff`. Contract §2.5 (Revision 2) pins `handoff: true` for `sendPolicy: 'plain-nosend'` assets (T2 0.2.0), so every Mandala holder send shows the hand-over title. The view just reads the flag.
  - `color_signature`: `Approve token signature`
  - `color_access`: `Share token holdings`
  - `color_relinquish`: `Remove a token holding`
  - `color_receive_offline`: `Accept tokens offline (pending settlement)`
- Asset line labels, exact. A line is shown only when its amount is non-zero, except `Sending`, which is always shown:
  - `Sending` (`outgoingAmount`)
  - `From this wallet` (`inputAmount`)
  - `From others` (`foreignAmount`)
  - `Kept as change` (`keptAmount`)
  - `Burned`
  - `Minted`
- Asset `name` is `` `${display.label ?? display.sym} (${assetId})` `` when display exists, else the `assetId`. The full asset id is always visible, because display metadata is untrusted (0207:960-962).
- Validation:
  - Every amount must match `^(0|[1-9][0-9]*)$` and be a string. A destination or offline per-output amount must also be ≤ `18446744073709551615`. Sums are unbounded.
  - Asset ids must match the global regex, except `ISSUE` in destinations.
  - `assets.length` ≤ 64 and `destinations.length` ≤ 1000.
  - Satoshi fields must be safe non-negative integers.
  - Failure throws `InvalidColorRequestError` with the field path in the message.
  - No `Number()` on any token amount: the tests grep the source for it.

- [ ] **Step 1: Write the failing tests**

```ts
test('renders the A.38 maximum exactly', () => {
  expect(formatUnits(18446744073709551615n, 18)).toBe('18.446744073709551615')   // 0207:3938
  expect(formatUnits(1500n, 2)).toBe('15.00'); expect(formatUnits(5n, 2)).toBe('0.05'); expect(formatUnits(1500n, 0)).toBe('1500')
  expect(formatUnits(36893488147419103232n, 0)).toBe('36893488147419103232')        // sum of two maxima + 2: no cap on sums
  expect(() => formatUnits(-1n, 0)).toThrow(RangeError); expect(() => formatUnits(1n, 19)).toThrow(RangeError)
})
test('send view shows every leg with exact decimals and sats', () => {
  const v = buildColorConsentView(JSON.stringify({ type: 'color_send', handoff: true,
    assets: [{ assetId: ID, operations: ['transfer'], inputAmount: '2000', foreignAmount: '0', authorityInputs: 0, foreignAuthorityInputs: 0,
      keptAmount: '500', keptAuthorities: 0, outgoingAmount: '1500', outgoingAuthorities: 0, transferred: '2000', burned: '0', minted: '0' }],
    destinations: [{ outputIndex: 0, satoshis: 1, lockingScript: '00', assetId: ID, role: 'value', amount: '1500' }],
    satoshis: { inputs: 1003, outputs: 2, fee: 1001 }, signatures: [{ outpoint: `${'c'.repeat(64)}.1`, inputIndex: 0, sighashType: 65 }], lockTime: 0,
    hostDisplay: { [ID]: { assetId: ID, sym: 'TUSD', label: 'Test Dollar', dec: 2, mandala: true } } }))
  expect(v.title).toBe('Approve token hand-over')
  expect(v.assets[0].lines).toEqual([{ label: 'Sending', amount: '15.00 TUSD' }, { label: 'From this wallet', amount: '20.00 TUSD' }, { label: 'Kept as change', amount: '5.00 TUSD' }])
  expect(v.assets[0].name).toBe(`Test Dollar (${ID})`)
  expect(v.satoshis).toEqual({ inputs: 1003, outputs: 2, fee: 1001 })
})
test('without display metadata amounts are base units', () => { /* outgoingAmount '1500' -> '1500 base units' */ })
test('rejects non-canonical amounts', () => {
  for (const bad of ['01', '1e3', '-1', '', 1500]) expect(() => buildColorConsentView(sendWith({ outgoingAmount: bad }))).toThrow(InvalidColorRequestError)
  expect(() => buildColorConsentView(sendWithDestinationAmount('18446744073709551616'))).toThrow(InvalidColorRequestError)
})
test('access, relinquish, signature and receive-offline views', () => { /* titles exact; offline.outputs amounts formatted; access.basket kept;
  offline signer K -> signers [K]; signers [K1,K2] kept; both or neither present -> InvalidColorRequestError */ })
test('consentView.ts never converts token amounts with Number()', () => {
  expect(fs.readFileSync('src/lib/permissionModules/color/consentView.ts', 'utf8')).not.toMatch(/Number\(|parseInt\(|parseFloat\(/)
})
```

(`ID` is `'a'.repeat(64) + '_0'`. `sendWith`/`sendWithDestinationAmount` are local helpers that build the message above with one field replaced.)

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorConsentView.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `formatUnits`, `formatTokenAmount` and `buildColorConsentView` in `consentView.ts`**

Use `Number.isSafeInteger` only for satoshi, index and count fields.

- [ ] **Step 4: Run the tests**

Run: the same file, then `npm test` and both `tsc` configs.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissionModules/color/consentView.ts test/colorConsentView.test.ts package.json
git commit -m "feat(color): consent view model with exact uint64/bigint decimal formatting"
```

---

### Task 8: Color consent prompt UI

**Files:**
- Create: `src/lib/permissionModules/color/Prompt.tsx`. Start from the FIFO queue, focus handling and theme of the deleted Mandala prompt: `git show 361778c:src/lib/permissionModules/mandala/Prompt.tsx`. Keep the queue/focus logic. Replace the parsing and rendering.
- Test: `test/colorPrompt.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Consumes: `buildColorConsentView`, `ColorConsentView` and `InvalidColorRequestError` (Task 7); `PermissionPromptProps` (types.ts).
- Produces:
  - `ColorPermissionPrompt: React.FC<PermissionPromptProps>`. It registers a handler via `props.onRegister(props.id, handler)` exactly as the old prompt did.
  - `ColorConsentDetails: React.FC<{ view: ColorConsentView }>`, a presentational body with no Dialog, so it can be rendered on the server.
- Behaviour:
  - The handler builds the view first. On `InvalidColorRequestError` it resolves `false` without opening a dialog and logs `console.warn` once.
  - The dialog shows: the title; the originating app; per-asset name and lines; operations (as chips); destinations; satoshis inputs/outputs/fee; signatures released (count plus outpoints); `lockTime` when non-zero; and for offline receive, the pending notice `Settles when the Mandala overlay admits it`. That exact text is checked by the test.
  - Buttons are `Deny` and `Approve`. Closing or Escape means `false`.
  - The queue is FIFO across concurrent app calls, and a second dialog never replaces an unanswered one (as before).

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup` from `react-dom/server`, node environment)

```ts
test('details render exact decimal legs, fee and released signatures', () => {
  const html = renderToStaticMarkup(createElement(ColorConsentDetails, { view: buildColorConsentView(SEND_MSG_WITH_DISPLAY_DEC18_MAX) }))
  expect(html).toContain('18.446744073709551615 G'); expect(html).toContain(ID); expect(html).toContain('1001')
  expect(html).toContain(`${'c'.repeat(64)}.1`)
})
test('offline receive shows the pending notice', () => { /* contains 'Settles when the Mandala overlay admits it' and every key of signers[] (one test with signer, one with signers: [K1, K2]) */ })
test('an invalid request is declined without a dialog', async () => {
  /* mount-free: export `handleColorPromptMessage(message, enqueue)`; enqueue never called; resolves false */
})
```

`handleColorPromptMessage(message: string, enqueue: (view: ColorConsentView) => Promise<boolean>): Promise<boolean>` is exported from `Prompt.tsx` so this path can be tested without a DOM. `SEND_MSG_WITH_DISPLAY_DEC18_MAX` is a Task 7-shaped `color_send` message with `outgoingAmount: '18446744073709551615'`, `satoshis.fee: 1001`, one signature on outpoint `${'c'.repeat(64)}.1`, and `hostDisplay[ID] = { assetId: ID, sym: 'G', dec: 18, mandala: false }` (0207 A.38).

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorPrompt.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `Prompt.tsx`**

- [ ] **Step 4: Run the tests**

Run: the same file, then `npm test`, both `tsc` configs and `npm run build`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissionModules/color/Prompt.tsx test/colorPrompt.test.ts package.json
git commit -m "feat(color): consent prompt for color_send/signature/access/relinquish/receive_offline"
```

---

### Task 9: Settle scheduler (D17)

**Files:**
- Create: `src/lib/permissionModules/color/settleScheduler.ts`
- Test: `test/colorSettleScheduler.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Produces:
  - `const SETTLE_INTERVAL_MS = 300_000`
  - `const SETTLE_INITIAL_DELAY_MS = 1_000`
  - `type SettleReportLike = { results: Array<{ txid: string; assetId: string; status: 'admitted' | 'retry' | 'refused'; code?: string; description?: string }> }`. This is structurally the contract §2.3 `ColorSettleReport`.
  - `startColorSettleScheduler(o: { settle: () => Promise<SettleReportLike>; intervalMs?: number; initialDelayMs?: number; events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>; onReport?: (r: SettleReportLike) => void; onError?: (e: unknown) => void }): { stop(): void; runNow(): Promise<void> }`
- Behaviour:
  - `events` defaults to `window`.
  - The first run happens after `initialDelayMs`, then every `intervalMs`, and on every `online` event.
  - Single-flight: a trigger while a run is in flight returns the in-flight promise and does not queue another run.
  - `settle` rejections go to `onError` (default `console.warn`) and never escape.
  - `onReport` defaults to logging each `refused` result as `console.warn('[color] settle refused', txid, code)`.
  - `stop()` clears both timers and removes the `online` listener. After `stop()`, no new run starts, and a report that arrives after `stop()` is ignored. Calling `stop()` twice is a no-op.

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`, `events = new EventTarget()`)

```ts
test('runs after the initial delay, then every 5 minutes, and on online', async () => {
  const settle = vi.fn().mockResolvedValue({ results: [] }); const s = startColorSettleScheduler({ settle, events })
  await vi.advanceTimersByTimeAsync(999); expect(settle).toHaveBeenCalledTimes(0)
  await vi.advanceTimersByTimeAsync(1); expect(settle).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(300_000); expect(settle).toHaveBeenCalledTimes(2)
  events.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0); expect(settle).toHaveBeenCalledTimes(3)
  s.stop()
})
test('single flight: overlapping triggers share one run', async () => { /* settle returns a deferred; online x3 + runNow -> settle called once until resolved */ })
test('a failing settle is reported, never thrown, and the next tick runs', async () => { /* settle rejects -> onError once; next interval runs again */ })
test('stop removes the timer and the online listener', async () => {
  /* stop(); advance 1h; dispatch online -> settle never called after stop; stop() twice ok */
})
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorSettleScheduler.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `startColorSettleScheduler`**

- [ ] **Step 4: Run the tests**

Run: the same file, then `npm test` and both `tsc` configs.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissionModules/color/settleScheduler.ts test/colorSettleScheduler.test.ts package.json
git commit -m "feat(color): single-flight settle scheduler (unlock, 5 min, online)"
```

---

### Task 10: Vendor module 0.2.0 + `@bsv/mandala` 0.5.0, and the default SHIP provider

**Files:**
- Create: `vendor/bsv-color-permission-module-0.2.0-<sha>.tgz`, `vendor/bsv-mandala-0.5.0-<msha>.tgz`, and re-copied `vendor/bsv-templates-2.2.0-<sha>.tgz` (plus a re-copied sdk/toolbox if the V2 sha is newer: the sdk must carry the T2 §2.2-5a validator patch). Delete the superseded `vendor/*.tgz`.
- Modify: `package.json` (add `"@bsv/color-permission-module"` and `"@bsv/mandala"` as `file:vendor/…` dependencies, add their `$name` overrides, update the re-vendored specs), `package-lock.json`
- Create: `src/lib/permissionModules/color/defaultProvider.ts`
- Test: `test/colorDefaultProvider.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Consumes, from the module:
  - `ColorOverlayProvider` (`spendability`, `admission`, `submit(topics, beef, offChainValues?) => Promise<AttestedSTEAK>`)
  - `ColorProviderError(code, retryable, transport, message)` (contract §2.1)
- Consumes, from the sdk: `LookupResolver`, `SHIPBroadcaster`, `HTTPSOverlayBroadcastFacilitator`, `OverlayBroadcastFacilitator`, `LookupNetworkPreset` and `Transaction`.
- Produces: `createShipColorProvider(o: { chain: WalletNetwork; networkPreset?: LookupNetworkPreset; resolver?: Pick<LookupResolver, 'query'>; facilitator?: OverlayBroadcastFacilitator; timeoutMs?: number /* 10_000 */ }): ColorOverlayProvider`. This is the default provider for profile-free assets. Mandala assets never reach it, because `handler.provider()` routes them (contract §2.1 obligation 3).
- Behaviour:
  - Preset: `main → 'mainnet'`, `test → 'testnet'`, `ttn → 'teratestnet'`, `tstn → none`. An explicit `networkPreset` overrides this.
  - With no preset: `spendability`/`admission` resolve `{ type: 'output-list', outputs: [] }`, and `submit` rejects with `ColorProviderError('ERR_UNAVAILABLE', false, true, 'No 1Color overlay network for this chain')`.
  - `spendability`/`admission` call `resolver.query({ service: \`ls_color_${assetId}\`, query: { type: 'color-spendability' | 'color-admission', version: 1, assetId, topic: \`tm_color_${assetId}\`, outpoints } }, timeoutMs)`, which is exactly the contract §6 query shape (0207:743-775). They return the answer unchanged. A throw maps to `ColorProviderError('ERR_UNAVAILABLE', true, true, message)`.
  - `submit`:
    - A non-empty `offChainValues` rejects with `ColorProviderError('ERR_UNSUPPORTED', false, false, 'Off-chain values need a profile provider')` without any network call.
    - Otherwise, `Transaction.fromAtomicBEEF(beef)`, then `new SHIPBroadcaster(topics, { networkPreset, resolver, facilitator: capturing, requireAcknowledgmentFromAnyHostForTopics: 'all' }).broadcast(tx)`.
    - `capturing` wraps `o.facilitator ?? new HTTPSOverlayBroadcastFacilitator()` and records each `(url, STEAK)`.
    - On `status === 'success'`, return the first captured STEAK that contains every requested topic. Otherwise reject with `ColorProviderError('ERR_UNAVAILABLE', true, true, description)`.
  - Why the capturing facilitator: the SDK's SHIP `broadcast()` returns `BroadcastResponse` and not a STEAK, and its host discovery is private.

- [ ] **Step 1: Vendor and install**

Do the copy, the specs and the overrides, then `npm install --no-audit --no-fund`.
Check: `node -e "import('@bsv/color-permission-module').then(m=>console.log(typeof m.createAttestedProfile, typeof m.ColorProviderError))"` prints `function function`. `node -e "import('@bsv/mandala/profile').then(m=>console.log(typeof m.createMandalaProfile, m.MANDALA_PROFILE_ID))"` prints `function https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md`. Either failing is BLOCKED (missing T2/LIB-profile output).

- [ ] **Step 2: Write the failing tests**

```ts
const ID = 'a'.repeat(64) + '_0'
test('tstn has no overlay network: empty answers, refused submit', async () => {
  const p = createShipColorProvider({ chain: 'tstn' })
  expect(await p.spendability(ID, [`${'a'.repeat(64)}.0`])).toEqual({ type: 'output-list', outputs: [] })
  await expect(p.submit([`tm_color_${ID}`], beef)).rejects.toMatchObject({ name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', transport: true })
})
test('queries use the BRC-207 color shapes on ls_color_<assetId>', async () => {
  const resolver = { query: vi.fn().mockResolvedValue({ type: 'output-list', outputs: [] }) }
  const p = createShipColorProvider({ chain: 'test', resolver }); await p.admission(ID, [`${'a'.repeat(64)}.0`])
  expect(resolver.query).toHaveBeenCalledWith({ service: `ls_color_${ID}`, query: { type: 'color-admission', version: 1, assetId: ID, topic: `tm_color_${ID}`, outpoints: [`${'a'.repeat(64)}.0`] } }, 10_000)
})
test('a resolver failure is a retryable transport error', async () => { /* query rejects -> ColorProviderError ERR_UNAVAILABLE retryable true transport true */ })
test('submit returns the host STEAK (local preset, stub facilitator)', async () => {
  const steak = { [`tm_color_${ID}`]: { outputsToAdmit: [0], coinsToRetain: [] } }
  const facilitator = { send: vi.fn().mockResolvedValue(steak) }
  const p = createShipColorProvider({ chain: 'test', networkPreset: 'local', facilitator })
  await expect(p.submit([`tm_color_${ID}`], atomicBeef)).resolves.toEqual(steak)
  expect(facilitator.send.mock.calls[0][0]).toBe('http://localhost:8080')
})
test('off-chain values are refused before any network call', async () => { /* submit(..., [1]) -> code ERR_UNSUPPORTED; facilitator.send not called */ })
test('a STEAK missing the topic fails the submit', async () => { /* facilitator returns {} -> rejects ColorProviderError */ })
```

(`atomicBeef`: a one-input tx whose input has a `sourceTransaction`, serialized with `toAtomicBEEF()`. Fixture source transactions carry no merkle proof. If the SDK refuses to serialize them, use the `allowPartial` argument (`toAtomicBEEF(true)` / `toBEEF(true)`); this applies to the fixtures in Tasks 10, 11 and 13 alike.)

- [ ] **Step 3: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorDefaultProvider.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `createShipColorProvider`**

- [ ] **Step 5: Run the tests and the gate**

Run: the same file, then `npm test`, both `tsc` configs and `npm run build`.
Expected: PASS. Unit counts are the previous ones plus this file.

- [ ] **Step 6: Commit**

```bash
git add vendor package.json package-lock.json src/lib/permissionModules/color/defaultProvider.ts test/colorDefaultProvider.test.ts
git commit -m "feat(color): vendor color-permission-module 0.2.0 + @bsv/mandala 0.5.0; SHIP default provider for profile-free assets"
```

---

### Task 11: Asset display resolver and consent enrichment

**Files:**
- Create: `src/lib/permissionModules/color/assetDisplay.ts`
- Test: `test/colorAssetDisplay.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Consumes: `ColorOverlayProvider` (module); `readDeploy(lockingScript, txid)` from `@bsv/mandala` (contract §8.1). It returns `{ assetId, sym?, dec, label?, mandalaKey? } | null`. Also `AssetDisplay` (Task 7).
- Produces:
  - `createAssetDisplayResolver(o: { providers: () => ColorOverlayProvider[]; timeoutMs?: number /* 3_000 */; maxEntries?: number /* 256 */ }): { resolve(assetIds: readonly string[]): Promise<Record<string, AssetDisplay>> }`
  - `enrichConsentMessage(message: string, resolver: { resolve(ids: readonly string[]): Promise<Record<string, AssetDisplay>> }): Promise<string>`
- Algorithm for each distinct, regex-valid asset id (`<txid>_<vout>`), with no fallback beyond this list:
  1. For each provider in order, call `admission(assetId, [\`${txid}.${vout}\`])` with a `timeoutMs` race.
  2. Pick the listed output with `txid === txid && outputIndex === vout`.
  3. `Transaction.fromBEEF(beef, txid)`, and require `tx.id('hex') === txid`.
  4. Call `readDeploy(tx.outputs[vout].lockingScript, txid)`.
  5. A non-null result becomes `{ assetId, sym, label, dec, mandala: mandalaKey !== undefined }`, the resolver caches it (deploys are immutable) and stops for that asset.
  6. A provider error, timeout, mismatch or `null` moves on to the next provider.
  7. If no provider resolves, the id is omitted (the prompt then shows base units).
- The cache is a Map, insertion-bounded to `maxEntries` (the oldest entry is evicted first).
- `enrichConsentMessage`:
  - collects asset ids from `assets[].assetId`, `destinations[].assetId` (not `ISSUE`) and the top-level `assetId`;
  - returns `JSON.stringify({ ...parsed, hostDisplay })`;
  - returns the message unchanged when it does not parse;
  - never removes or alters module members.

- [ ] **Step 1: Write the failing tests**

Fixture F-REQ (contract §4). Use the deploy locking script hex `00006d4d6d01` + the 365-byte payload hex (`a4636465630263726571` + req value + `6373796d6454555344656c6162656c6b5465737420446f6c6c6172`) + `7576a914a1d8edf2f9ebd6d2fe4728e0eb3bd369ab78d76a88ac`, copied verbatim from the contract into `test/fixtures/1color-deploy-script.hex`. Build a tx with output 0 = that script (1 sat) and one input with a `sourceTransaction`. Then `txid = tx.id('hex')`, `ID = \`${txid}_0\``.

```ts
const providerFor = (tx) => ({ admission: vi.fn().mockResolvedValue({ type: 'output-list', outputs: [{ beef: tx.toBEEF(), outputIndex: 0, txid: tx.id('hex') }] }), spendability: vi.fn(), submit: vi.fn() })
test('resolves a Mandala deploy from F-REQ', async () => {
  const r = createAssetDisplayResolver({ providers: () => [providerFor(deployTx)] })
  expect(await r.resolve([ID])).toEqual({ [ID]: { assetId: ID, sym: 'TUSD', label: 'Test Dollar', dec: 2, mandala: true } })
})
test('falls through a failing provider and caches the result', async () => { /* [throwing, good]; resolve twice -> good.admission called once total */ })
test('a timed-out provider is skipped', async () => { /* never-resolving provider, timeoutMs 20 -> {} within ~20ms */ })
test('an answer for a different transaction is ignored', async () => { /* BEEF of another tx labelled with ID's txid -> {} */ })
test('malformed ids are never queried', async () => { /* resolve(['abc', 'A'.repeat(64)+'_0']) -> {}; admission not called */ })
test('enrich adds hostDisplay and keeps every module member', async () => {
  const msg = { type: 'color_send', assets: [{ assetId: ID, outgoingAmount: '1500' }], destinations: [{ outputIndex: 0, assetId: 'ISSUE' }] }
  const out = JSON.parse(await enrichConsentMessage(JSON.stringify(msg), r))
  expect({ ...out, hostDisplay: undefined }).toEqual({ ...msg, hostDisplay: undefined }); expect(out.hostDisplay[ID].dec).toBe(2)
})
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorAssetDisplay.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `createAssetDisplayResolver` and `enrichConsentMessage`**

- [ ] **Step 4: Run the tests**

Run: the same file, then `npm test` and both `tsc` configs.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissionModules/color/assetDisplay.ts test/colorAssetDisplay.test.ts test/fixtures/1color-deploy-script.hex package.json
git commit -m "feat(color): resolve deploy display metadata (dec/sym) for exact consent amounts"
```

---

### Task 12: Register the color module and bind its lifecycle to the wallet

**Files:**
- Create: `src/lib/permissionModules/color.ts`
- Modify: `src/lib/permissionModules/types.ts` (context and dispose)
- Modify: `src/lib/services/PermissionQueueManager.ts`:
  - `createPermissionsManager(wallet, context?)` at `:941`;
  - a new `disposePermissionModules()`;
  - `setPermissionsManager(null)` disposes.
- Modify: `src/lib/services/WalletService.ts:847` (pass the context)
- Modify: `src/main.tsx` (register `[btmsPermissionModule, colorPermissionModule]`)
- Create: `src/lib/permissionModules/color/linkageGrant.ts` (holder-send linkage grant policy, D20)
- Modify: `src/lib/services/PermissionQueueManager.ts` `protocolPermissionCallback` (`:720`) and a new `approveColorLinkage(requestID)`; `src/lib/components/ProtocolPermissionHandler/index.tsx:70` (an item flagged `colorLinkage` is approved through `approveColorLinkage` and titled `Mandala token sending`)
- Test: `test/colorPermissionModule.wiring.test.ts` (new, append to `scripts.test`), `test/colorLinkageGrant.test.ts` (new, append to `scripts.test`), `test/permissionModuleRegistry.test.ts` (extend)

**Interfaces:**
- Consumes:
  - Task 4: `NetworkSettings.mandalaOverlays`
  - Task 5: `createIpcColorModuleStore`
  - Task 6: `createColorConsentGate`
  - Task 9: `startColorSettleScheduler`
  - Task 10: `createShipColorProvider`
  - Task 11: `createAssetDisplayResolver`, `enrichConsentMessage`
  - Task 8: `ColorPermissionPrompt`
  - from the module: `createColorModule`, `createAttestedProfile`, `ATTESTED_PROFILE_ID`
  - from `@bsv/mandala/profile`: `createMandalaProfile`, `createMandalaOverlayProvider`, `MANDALA_PROFILE_ID`
- Produces:
  - `types.ts`:
    - `type PermissionModuleContext = { identityKey: string; chain: WalletNetwork; settings: NetworkSettings }`
    - `PermissionModuleFactoryArgs` gains `context?: PermissionModuleContext`
    - `PermissionModuleDefinition` gains `dispose?: (module: unknown) => void`
  - `color.ts`:
    - `interface HostColorModuleDeps { createColorModule; createAttestedProfile; createMandalaProfile; createMandalaOverlayProvider; createStore: typeof createIpcColorModuleStore; createDefaultProvider: typeof createShipColorProvider; startScheduler: typeof startColorSettleScheduler }`
    - `createHostColorModule(args: PermissionModuleFactoryArgs, deps?: Partial<HostColorModuleDeps>): ColorPermissionModule`
    - `colorPermissionModule: PermissionModuleDefinition = { id: 'color', label: '1Color Token Module', enabledByDefault: true, createModule: createHostColorModule, dispose, Prompt: ColorPermissionPrompt }`
  - `PermissionQueueManager`:
    - `createPermissionsManager(wallet: WalletInterface, context?: PermissionModuleContext): WalletPermissionsManager`. It calls `disposePermissionModules()` first, passes `context` to every `createModule`, records `{definition, module}`, and creates a fresh linkage grant policy whose `overlayKeys` are `context?.settings.mandalaOverlays` identity keys (none without context).
    - `disposePermissionModules(): void`. It calls each recorded `definition.dispose?.(module)` once, catches and logs errors, clears the list, and calls `linkagePolicy.clear()`.
    - `approveColorLinkage(requestID: string): Promise<void>`: `grantPermission({ requestID, ephemeral: true })`, then `linkagePolicy.grant(item)`, then auto-grants (ephemerally, no prompt) every queued item of the same originator that `linkagePolicy.live` now covers. Unknown or non-flagged `requestID` throws `Error('Not a Mandala token sending request')`.
  - `linkageGrant.ts` (D20; contract §5 table rows "recipient output"):
    - `const LINKAGE_PROTOCOL_PREFIX = 'specific linkage revelation 2 p color '`, `const COUNTERPARTY_LINKAGE_PREFIX = 'counterparty key linkage revelation '`, `const LINKAGE_GRANT_MS = 1_800_000`
    - `createColorLinkageGrantPolicy(o: { overlayKeys: () => readonly string[]; now?: () => number }): { matches(r: LinkageRequest): boolean; live(r: LinkageRequest): boolean; grant(r: LinkageRequest): void; clear(): void }` with `type LinkageRequest = { originator: string; protocolID: [number, string]; counterparty?: string }`.
    - `matches` is true only for security level 2 and a `counterparty` that is (lowercased) one of `overlayKeys()`, and either (a) a name that starts with `LINKAGE_PROTOCOL_PREFIX` and is at most 310 characters (contract §0), or (b) a name equal to `COUNTERPARTY_LINKAGE_PREFIX + B` with `B` matching `^0[23][0-9a-f]{64}$`.
    - `live`: (a) a grant for the originator younger than `LINKAGE_GRANT_MS`; (b) a grant for `(originator, B)` younger than `LINKAGE_GRANT_MS`. `grant` records the family matching the request. `clear` drops everything. The admin originator is not special-cased: it never reaches the manager's protocol prompts.
  - `protocolPermissionCallback`: after `_acceptPermissionForHttpBridge`, when `linkagePolicy.matches(args)`: if `live(args)` then `grantPermission({ requestID, ephemeral: true })` with no queue item; otherwise queue the item with `colorLinkage: true` and description `Mandala token sending` (family a) or `Mandala token sending: reveal your link to <B> to the Mandala overlay` (family b). Denial is the ordinary deny path and grants nothing.
- `createHostColorModule` composition, in order:
  1. Without `context`, throw `Error('The 1Color module needs the wallet identity and network')`.
  2. `overlays` = `context.settings.mandalaOverlays` filtered to keys where `PublicKey.fromString` succeeds (an invalid entry is logged and skipped; none means `[]`, fail closed).
  3. `store = createStore(identityKey, chain)`; `provider = createDefaultProvider({ chain })`.
  4. `display = createAssetDisplayResolver({ providers: () => [...overlays.map(o => createMandalaOverlayProvider(o)), provider] })`.
  5. `gate = createColorConsentGate({ adminOriginator, prompt: promptHandler ?? (async () => false), enrich: m => enrichConsentMessage(m, display) })`.
  6. `module = createColorModule({ wallet, provider, requestTokenAccess: gate, store, profiles: { [ATTESTED_PROFILE_ID]: createAttestedProfile(), [MANDALA_PROFILE_ID]: createMandalaProfile({ overlays }) } })` (contract §8.2).
  7. `scheduler = startScheduler({ settle: () => module.settle(undefined, adminOriginator) })`.
  8. `dispose(module)` runs `scheduler.stop(); gate.clear(); module.dispose()` once. A module-level `WeakMap` maps module → cleanup.
- `WalletService` passes `{ identityKey: keyDeriver.identityKey, chain, settings: serviceSettings }`. Every wallet close path already calls `permissionQueue.setPermissionsManager(null)` (`_closeOpenWallet`, the build-failure path at `:907`, logout), which now disposes.

**Holder-send linkage (D20, contract §5).** The Mandala lib computes recipient linkage through the app's wallet, so on desktop these calls go through `WalletPermissionsManager` from the app's originator: `revealCounterpartyKeyLinkage({ counterparty: B, verifier: K })`, which the manager gates as protocol `[2, 'counterparty key linkage revelation <B>']` toward `K` (toolbox `WalletPermissionsManager.ts:5406-5418`), and two `encrypt` calls under `[2, 'specific linkage revelation 2 p color <tag> <hex(prefix)> <hex(suffix)>']`, `keyID 'color'`, `counterparty K`. The prefix and suffix are random per send, so the protocol name is new on every send. The manager prompts for these only when `seekPermissionsForKeyLinkageRevelation` / `seekProtocolPermissionsForEncrypting` are true (`:1995-1999`). The desktop defaults are `false` for both (`src/lib/WalletContext.tsx:84,88`), but the user can turn them on in Settings. The decision tree is fixed, so the executor never has to ask:
1. Run the two linkage tests below. With the default config, expect 0 prompts.
2. With both settings on and **no** policy, the planner predicts at least one prompt per send, because the toolbox keys protocol grants on the protocol name and counterparty. Record the measured count in the report. If it is more than one prompt per originator across two sends, the policy above ships (planned default). If the measurement shows at most one prompt in total, the policy still ships, because it is harmless, and the report says so.
3. If the module or the manager **refuses** either call outright (throws without prompting, or the underlying wallet is never reached), the task is BLOCKED and the report raises the contract change "the issuer-v1 plan leaf carries the linkage scalar `L` (hex) instead of `encryptedLinkage`, and the Mandala handler encrypts it for `K` with `ctx.wallet` (contract §5.2)". Do not work around it in the host.
4. Also pin that the color module does not intercept `encrypt` under a name that merely contains `p color` (its scheme match must be `^p color `): the underlying `encrypt` receives the exact args.

- [ ] **Step 1: Write the failing tests**

```ts
const K = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
test('registry: a saved mandala id becomes color', () => {
  expect(buildPermissionModuleRegistry([btmsPermissionModule, colorPermissionModule]).restoreEnabledPermissionModules(['btms', 'mandala'])).toEqual(['btms', 'color'])
})
test('needs a wallet context', () => { expect(() => createHostColorModule({ wallet, adminOriginator: 'admin' })).toThrow('The 1Color module needs the wallet identity and network') })
test('registers attested + Mandala issuer profiles with the configured overlay', () => {
  const deps = spyDeps()   // spies returning stubs; createColorModule returns { settle: vi.fn(), dispose: vi.fn() }
  createHostColorModule({ wallet, adminOriginator: 'admin', context: ctx([{ url: 'https://ov.example', identityKey: K }]) }, deps)
  const opts = deps.createColorModule.mock.calls[0][0]
  expect(Object.keys(opts.profiles).sort()).toEqual([ATTESTED_PROFILE_ID, MANDALA_PROFILE_ID].sort())
  expect(deps.createMandalaProfile).toHaveBeenCalledWith({ overlays: [{ url: 'https://ov.example', identityKey: K }] })
  expect(deps.createStore).toHaveBeenCalledWith(IDENTITY, 'test')
})
test('no configured overlay registers the Mandala profile with none (fail closed)', () => { /* ctx([]) -> createMandalaProfile({ overlays: [] }) */ })
test('disposes the previous modules on rebuild and on close', () => {
  /* fake definition {id:'x', createModule: () => ({}), dispose: vi.fn()}; queue.enabledPermissionModules=['x'];
     createPermissionsManager twice -> dispose called once with the first module;
     setPermissionsManager(null) -> dispose called for the second; total 2 */
})
describe('real module behind the real manager', () => {
  // window.electronAPI.colorStore = in-memory stub; fake underlying wallet (getPublicKey, getVersion, listOutputs, createSignature,
  // revealCounterpartyKeyLinkage, encrypt spies); pm = queue.createPermissionsManager(fakeWallet, ctx([{ url, identityKey: K }]));
  // protocolPrompts = items the queue enqueues from onProtocolPermissionRequested (read through the queue's existing pending-request accessor)
  test('advertises the BRC-207 capability', async () => { expect((await pm.getVersion({}, 'app.example')).version).toContain('brc207-color') })
  test('A.115: an inventory read with seekPermission false errors without a prompt', async () => {
    await expect(pm.listOutputs({ basket: 'p color assets', seekPermission: false }, 'app.example')).rejects.toThrow('Colored Tokens inventory read permission is required')
    expect(prompt).not.toHaveBeenCalled()
  })
  test('A.13: a bare digest under a p color key is refused without a prompt', async () => {
    await expect(pm.createSignature({ protocolID: [2, `p color ${'a'.repeat(64)}v0 41513d3d 41673d3d`], keyID: 'color', counterparty: 'self', hashToDirectlySign: Array(32).fill(1) }, 'app.example')).rejects.toThrow()
    expect(prompt).not.toHaveBeenCalled(); expect(fakeWallet.createSignature).not.toHaveBeenCalled()
  })
  // holder-send linkage: fake wallet also has revealCounterpartyKeyLinkage / encrypt spies; B = recipient key, K = overlay key (ctx overlay)
  const linkageName = (p: string, x: string) => `specific linkage revelation 2 p color ${'a'.repeat(64)}v0 ${Buffer.from(p).toString('hex')} ${Buffer.from(x).toString('hex')}`
  const holderSend = async (B: string, name: string) => {
    await pm.revealCounterpartyKeyLinkage({ counterparty: B, verifier: K }, 'app.example')
    await pm.encrypt({ plaintext: [1], protocolID: [2, name], keyID: 'color', counterparty: K }, 'app.example')
    await pm.encrypt({ plaintext: [0], protocolID: [2, name], keyID: 'color', counterparty: K }, 'app.example')
  }
  test('holder-send linkage: default config never prompts', async () => {
    await holderSend(B, linkageName('AAAA', 'BBBB')); await holderSend(B, linkageName('CCCC', 'DDDD'))
    expect(protocolPrompts).toHaveLength(0)                     // DEFAULT_PERMISSIONS_CONFIG: both seek* flags false
    expect(fakeWallet.encrypt).toHaveBeenCalledTimes(4)
    expect(fakeWallet.encrypt.mock.calls[0][0].protocolID).toEqual([2, linkageName('AAAA', 'BBBB')])   // module did not intercept
    expect(fakeWallet.revealCounterpartyKeyLinkage).toHaveBeenCalledTimes(2)
  })
  test('holder-send linkage with prompts enabled: one grant covers later sends', async () => {
    // queue.permissionsConfig = { ...DEFAULT_PERMISSIONS_CONFIG, seekPermissionsForKeyLinkageRevelation: true, seekProtocolPermissionsForEncrypting: true }
    // the test approves each queued colorLinkage item through queue.approveColorLinkage(requestID) as the UI would:
    // subscribe an auto-approver to the queue BEFORE the first call (approve colorLinkage items via approveColorLinkage,
    // others via grantPermission({ requestID, ephemeral: true })), otherwise `await holderSend` deadlocks on the pending prompt
    await holderSend(B, linkageName('AAAA', 'BBBB'))
    expect(protocolPrompts.map(p => p.description)).toEqual([expect.stringContaining('reveal your link to'), 'Mandala token sending'])
    await holderSend(B, linkageName('CCCC', 'DDDD'))             // new random name, same B: no prompt
    await holderSend(B2, linkageName('EEEE', 'FFFF'))            // new B: one counterparty-linkage prompt only
    expect(protocolPrompts).toHaveLength(3)
    expect(fakeWallet.encrypt).toHaveBeenCalledTimes(6)
  })
  test('the linkage grant never covers a non-overlay counterparty or another originator', async () => {
    /* prompts enabled, grant for app.example; encrypt under a linkage name toward a non-overlay key -> ordinary prompt;
       other.example with the same name toward K -> prompt; after disposePermissionModules() app.example prompts again */
  })
})
```

`test/colorLinkageGrant.test.ts` pins the policy alone: matching (level 2 only, overlay counterparty only, prefix, ≤ 310 chars, `B` regex), `live` per originator and per `(originator, B)`, expiry at `1_800_001` ms, `clear()`, and no grant from a denial. It also pins `approveColorLinkage`: two queued linkage items for one originator, one approval → both granted ephemerally, `grantPermission` called with `ephemeral: true` both times. The double-click case is covered too: approving the same `requestID` twice grants once and the second call throws `Not a Mandala token sending request`.

`afterEach` calls `queue.disposePermissionModules()` and `vi.useRealTimers()`. Tests that build the real module use `vi.useFakeTimers()`, so the first settle never fires against the fake wallet.

The scheduler attaches its `online` listener to `window` synchronously at module creation. In the "real module" describe block, the fake global therefore must be an `EventTarget`: `globalThis.window = Object.assign(new EventTarget(), { electronAPI: { colorStore: memoryStore } })`. A plain object without `addEventListener` throws at construction.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorPermissionModule.wiring.test.ts test/colorLinkageGrant.test.ts test/permissionModuleRegistry.test.ts`
Expected: FAIL, `../src/lib/permissionModules/color` and `color/linkageGrant` not found.

- [ ] **Step 3: Implement**

Change `types.ts`, write `color.ts` and `linkageGrant.ts`, add the PQM lifecycle, the linkage branch in `protocolPermissionCallback` and `approveColorLinkage`, the flagged approval in `ProtocolPermissionHandler`, add the `WalletService` context and register the module in `main.tsx`.
Verify the wiring:
- `grep -n "createPermissionsManager(wallet, {" src/lib/services/WalletService.ts` prints one line.
- `grep -n "setPermissionsManager(null)\|_closeOpenWallet()" src/lib/services/WalletService.ts` still shows the three disposal paths the planner found at `361778c`:
  - `_closeOpenWallet` (`:530`), which network switch (`:470`) and `logout()` (`:1374`) call;
  - the start of `_buildWallet` (`:741`, every rebuild including a profile switch);
  - the build-failure path (`:907`).

  A path that lost its call is fixed in this task.

- [ ] **Step 4: Run the tests and the gate**

Run: the three files, then `npm test`, both `tsc` configs and `npm run build`.
Expected: PASS, with the decision-tree outcome (prompt counts, policy shipped) recorded in the report. `counterpartyPermissions.test.ts` (`createPermissionsManager({} as any)` with no context and no enabled modules) is still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/permissionModules src/lib/services/PermissionQueueManager.ts src/lib/services/WalletService.ts src/lib/components/ProtocolPermissionHandler/index.tsx src/main.tsx test package.json
git commit -m "feat(color): register @bsv/color-permission-module with attested + Mandala issuer profiles; lifecycle bound to the wallet; holder-send linkage grant"
```

---

### Task 13: Large attested receipts, hand-over evidence and typed errors through the HTTP bridge (D4, D22, D29, D30)

**Files:**
- Create: `electron/httpLimits.ts`, containing `export const HTTP_JSON_BODY_LIMIT = '50mb'`
- Modify: `electron/httpServer.ts:89-90` (use the constant for both `express.json` and `express.text`)
- Modify: `src/onWalletReady.ts`. Every generic error path (`body: stringifyWalletPayload({ message: error instanceof Error ? error.message : String(error) })`, about 30 copies between `:240` and `:870`) goes through one helper. The WERR_REVIEW_ACTIONS duck-type branch (`:54-75` and its call sites) is kept unchanged. The `Wallet not ready` / `Origin header is required` bodies are unchanged.
- Test: `test/colorBridge.test.ts` (new, append to `scripts.test`)

**Interfaces:**
- Consumes: `stringifyWalletPayload` / `parseWalletPayload` (`src/walletByteJson.ts`); `onWalletReady` (`src/onWalletReady.ts`, use the harness pattern of `test/onWalletReady.test.ts`); `WalletPermissionsManager`; `HTTPWalletJSON` from the vendored `@bsv/sdk`.
- Produces:
  - `HTTP_JSON_BODY_LIMIT`.
  - `export function bridgeErrorBody(error: unknown): { message: string; name?: string; code?: string; retryable?: boolean; transport?: boolean }` in `src/onWalletReady.ts` (contract §8.2, D22).
- `bridgeErrorBody` rules:
  - A non-`Error` throw gives `{ message: String(error) }`.
  - An `Error` gives `message`, plus `name` when it is a non-empty string. The name is read as an own or inherited property, never from `constructor.name`, because Vite minification mangles class names (see the comment at `:54-70`). T2 classes set `name` explicitly (contract §2.4).
  - `code` is copied only when it is a string, and `retryable` / `transport` only when they are booleans. Nothing else is copied: no stack, no `cause`, no `isError`.
  - `isError` is never set. The sdk client treats a body with `isError` as a typed wallet-error envelope and throws `Invalid wallet error envelope` when `code` is not an integer (`HTTPWalletJSON.ts:262-269`).
- Status stays `400` for every path that used it.
- **Contract gap CG-DESK-ERR (recorded, not fixed here):** the vendored sdk 4.0.0 `HTTPWalletJSON` turns any 400 body without `isError` into `Error('HTTPWalletJSON <call> failed with HTTP status 400')` (`HTTPWalletJSON.ts:421-425`), so `message` and `name` are dropped on the client side. D22 "receivers match on name" over HTTP therefore also needs an sdk change: for a 400 body without `isError`, the client rebuilds `Error(body.message)` with `name`, `code`, `retryable` and `transport` copied after string/boolean checks. No plan owns `HTTPWalletJSON` today (the ts-stack sdk commits on the branch are `41a6edb43`, `df9f984c1`). The candidate owner is plan 02, which already patches the sdk validator (D29). The desktop half is complete without it.

- [ ] **Step 1: Write the failing tests**

```ts
test('the BRC-100 HTTP body limit stays at least 32 MiB', () => {
  expect(HTTP_JSON_BODY_LIMIT).toBe('50mb')
  expect(fs.readFileSync('electron/httpServer.ts', 'utf8')).toMatch(/express\.json\(\{ limit: HTTP_JSON_BODY_LIMIT \}\)/)
})
test('colorHandoff survives the bridge round trip', () => {
  const result = { txid: T, tx: [1, 2, 3], colorHandoff: { version: 1, txid: T, profileData: { 'https://brc.dev/207/attested': { [ID]: {
    declarationTx: '0100', transactions: ['0a0b'], attestations: [{ txid: T, outputs: [0], signer: K, signature: '3045' }], submissions: [{ txid: T, offChainValues: '7b7d' }] } } } } }
  expect(parseWalletPayload(stringifyWalletPayload(result))).toEqual(result)
})
test('a 16 MiB receipt reaches internalizeAction unchanged', async () => {
  /* onWalletReady harness; body = stringifyWalletPayload({ tx: [..], outputs: [{ outputIndex: 0, protocol: 'basket insertion',
     insertionRemittance: { basket: `p color ${'a'.repeat(64)}v0`, customInstructions: 'x'.repeat(16 * 1024 * 1024 + 10) } }], description: 'Receive tokens' });
     wallet.internalizeAction receives customInstructions.length === 16777226 */
})
test('routes a 2 MiB p color receipt through the manager to the module', async () => {
  const color = { onRequest: vi.fn(async (r) => ({ args: r.args })), onResponse: vi.fn(async (r) => r) }
  const underlying = { internalizeAction: vi.fn().mockResolvedValue({ accepted: true }), /* + getVersion etc. as the manager needs */ }
  const pm = new WalletPermissionsManager(underlying as any, 'admin.local', { permissionModules: { color } } as any)
  await pm.internalizeAction({ tx: atomicBeef, outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: `p color ${'a'.repeat(64)}v0`, customInstructions: 'y'.repeat(2 * 1024 * 1024) } }], description: 'Receive tokens' }, 'app.example')
  expect(color.onRequest.mock.calls[0][0].args.outputs[0].insertionRemittance.customInstructions.length).toBe(2 * 1024 * 1024)
})
```

Add the error tests to the same file:

```ts
class AttestationEvidenceError extends Error { name = 'AttestationEvidenceError'; constructor (readonly reason: string) { super(`[AttestationEvidenceError] BRC-207: attested evidence rejected (${reason})`) } }
class ColorProviderError extends Error { name = 'ColorProviderError'; constructor (readonly code: string, readonly retryable: boolean, readonly transport: boolean, m: string) { super(m) } }
test('forwards the error name and typed fields', async () => {
  /* onWalletReady harness; wallet.internalizeAction rejects with new AttestationEvidenceError('frontier') */
  expect(res.status).toBe(400)
  expect(parseWalletPayload(res.body)).toEqual({ message: '[AttestationEvidenceError] BRC-207: attested evidence rejected (frontier)', name: 'AttestationEvidenceError' })
  /* wallet.createAction rejects with new ColorProviderError('ERR_UNAVAILABLE', true, true, '[ColorProviderError] mandala overlay refused (ERR_UNAVAILABLE, retryable): down') */
  expect(parseWalletPayload(res2.body)).toEqual({ message: '[ColorProviderError] mandala overlay refused (ERR_UNAVAILABLE, retryable): down', name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', retryable: true, transport: true })
})
test('bridgeErrorBody never copies isError, stacks or non-typed fields', () => {
  const e = Object.assign(new Error('x'), { isError: true, code: 7, retryable: 'yes', stack: 's', cause: 'c' })
  expect(bridgeErrorBody(e)).toEqual({ message: 'x', name: 'Error' })
  expect(bridgeErrorBody('boom')).toEqual({ message: 'boom' })
})
test('no generic { message } error path remains', () => {
  const src = fs.readFileSync('src/onWalletReady.ts', 'utf8')
  expect(src).not.toMatch(/message: error instanceof Error \? error\.message : String\(error\)/)
  expect(src.match(/bridgeErrorBody\(/g)!.length).toBeGreaterThanOrEqual(20)
})
test('the name reaches an HTTPWalletJSON client (CG-DESK-ERR)', async () => {
  /* new HTTPWalletJSON('app.example', 'http://localhost:3321', fakeFetch) where fakeFetch drives the onWalletReady harness;
     internalizeAction rejects with AttestationEvidenceError -> the client error has name 'AttestationEvidenceError'
     or a message starting '[AttestationEvidenceError]' */
})
```

If the last test fails only because the client throws `HTTPWalletJSON internalizeAction failed with HTTP status 400`, mark it `test.fails` with the comment `CG-DESK-ERR: sdk HTTPWalletJSON drops non-envelope error bodies` and report the gap. Once the sdk is patched, `test.fails` turns red, which tells the executor to drop the marker. Any other failure is a real failure.

If the 2 MiB routing test fails with a 1000-byte `customInstructions` validation error, the vendored sdk lacks the T2 §2.2-5a / D29 patch. Report BLOCKED. Do not work around it.

Stability cases pinned: a retry of the same failing call yields the same body (pure helper); concurrent failing requests do not share state (no module-level error cache); a minified build keeps `name`, because the helper reads the property and never `constructor.name`.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorBridge.test.ts`
Expected: FAIL, `electron/httpLimits` not found.

- [ ] **Step 3: Implement the constant and use it in `httpServer.ts`; add `bridgeErrorBody` and route every generic error path in `onWalletReady.ts` through it**

- [ ] **Step 4: Run the tests and the gate**

Run: the same file, then `npm test` and both `tsc` configs.
Expected: PASS (`test/onWalletReady.test.ts` is still green; any assertion there on an exact `{ message }` body is updated to the new shape, and the report lists each one).

- [ ] **Step 5: Commit**

```bash
git add electron/httpLimits.ts electron/httpServer.ts src/onWalletReady.ts test/colorBridge.test.ts test/onWalletReady.test.ts package.json
git commit -m "feat(bridge): forward error name/code/retryable/transport; pin 16 MiB receipts and colorHandoff through the BRC-100 bridge"
```

---

### Task 14: Hold unadmitted 1Color txs from broadcast (contract §8.2 broadcast guard)

**Why.** wallet-toolbox 2.15.0 `internalizeAction` broadcasts a new, proof-less transaction before it persists ownership, and it aborts the credit when that broadcast does not report success (`storage/methods/internalizeAction.ts:779-801`: `ndr[0].status !== 'success'` ⇒ `restoreSpentInputs()` ⇒ WERR_REVIEW_ACTIONS). With the Mandala overlay down and ARC up, a `color_offline` receipt would therefore be mined without overlay admission. That breaks design goal 5 and 0207 ("Internalization records acceptance; it does not itself broadcast"). bsv-wallet holds such transactions in its storage (plan 07 Task 7, W1). Desktop runs the same toolbox and module, so it needs the same hold.

**Where broadcasts happen on desktop.**
- (a) Main process: `StorageKnex.attemptToPostReqsToNetwork` (method). `shareReqsWithWorld` reaches it for the forced broadcast inside `internalizeAction`, for non-delayed `createAction`, and for `sendWith` (including the module's D24 `sendWith` after admission). `noSendExpiryLifecycle.ts:688` also reaches it.
- (b) The monitor worker process (`electron/monitor-worker.ts`): `TaskSendWaiting.ts:243` calls the **module function** `attemptToPostReqsToNetwork(sp, reqs)` directly with the worker's own `StorageKnex`, so the method override in (a) does not intercept it. It handles `unsent`/`sending` reqs, which is where a delayed `createAction` lands.
- Both end in `services.postBeef` on a Services instance from `createArcadeServices` (`electron/storage.ts:375`, `electron/monitor-worker.ts:138`).

**Design (two layers, one host-owned journal):**
1. **Journal** (`ColorGuardJournal`, host-owned, contract §8.2 "guards key on host-owned journals or `isSettled`, never on `color.v1.*` keys"):
   - Root `~/.bsv-desktop/color-guard/<identityKey>-<chain>/`. The files are `<txid>.held` and `<txid>.released`, each written atomically (tmp + `fsync` + `rename` + best-effort directory `fsync`, the Task 5 pattern) with the content `{"txid":…, "at": <ms>}`.
   - Every read goes to disk with no cache, because the worker is another process and a cached answer would be stale.
   - `isReleased(txid)` is true iff `<txid>.released` exists. `held()` lists every `<txid>.held` (sorted), whether released or not. That way a crash between "released" and "posted" is redone by the next drain.
   - A read fault throws, and every caller turns a throw into "hold".
2. **Storage layer (main, primary).** `installColorBroadcastGuard(storage, o)` replaces the instance method `attemptToPostReqsToNetwork(reqs, trx?, logger?)`:
   - Classify each req. It is **held** iff its `rawTx` does not parse, or the tx has a BRC-162 output and `!isReleased(txid)`, or any input's `sourceTXID` is in `held()` and not released (a child of a tx this wallet holds, such as a plain payment spending a parked hand-over's BSV change), or any input's `sourceTXID` names a req **in this wallet's own storage** (`findProvenTxReqs({ partial: { txid } })`) that is at `nosend`, has a BRC-162 output and is not released. The last case is an own plain-nosend hand-over, which the toolbox (not the guard) parked, so it has no `.held` file. The own-storage lookup is what keeps foreign BEEF ancestors out: they are never `nosend` reqs of ours. Planner check: toolbox 2.15 `allocateChangeInput` selects only `['completed', 'unproven']` plus `'sending'` (`StorageKnex.ts:2359-2360`), so a `nosend` hand-over's change is not auto-selected today. The rule is kept anyway (fail closed), and the executor re-checks those lines in the vendored toolbox and records the answer.
   - Classification is on the **subject tx only**. Foreign proof-less ancestors inside a receipt's BEEF are never classified: they are the sender's chain, which the overlay admits.
   - A journal read fault holds the whole batch (bsv-wallet XR-045 pattern).
   - For a held req whose transaction row status is hold-safe (`['unproven', 'nosend']`, copied with its rationale from `/Users/personal/git/bsv-wallet-wt/1color/packages/expo-wallet-toolbox/core/offline/hold.ts` `holdSafeTxStatuses`): park it, in this order: `journal.markHeld(txid)` **first**, then `req.status = 'nosend'`, the history note `{ what: 'colorGuardHold' }`, `updateStorageDynamicProperties`, and `o.notifyHeld?.(txid)`. A crash after `markHeld` leaves a `.held` file for a req that was not parked. The drain then releases it normally (the release posts whatever the req status is), so no parked req can exist without a journal entry. Report `{ txid, req, status: 'success' }` for it, which is the `buildOfflineHoldResult` shape, so `internalizeAction` persists the credit.
   - A held req that is not hold-safe (e.g. a non-delayed `createAction` at `unprocessed`) is **not** parked. It goes to the original method together with the not-held reqs. There, layer 3 withholds it as `serviceError`, so the toolbox's own `updateReqsFromAggregateResults` moves it to `sending`/`sending` and `TaskFailAbandoned` never fails it (hold.ts rationale). It is also `markHeld`, so the drain releases it.
   - Not-held reqs go to the original method unchanged, and the result merges both detail lists. With nothing held, the original method is called with the original arguments: zero behaviour change for plain BSV.
3. **Services layer (main and worker, defence in depth).** `guardPostBeef(services, o)` wraps `services.postBeef(beef, txids, logger?)`:
   - Each `txid` is classified from `Beef.fromBinary(beef).findTxid(txid)?.tx`, by the same rule as layer 2, including the own-storage `nosend` lookup (the worker has its own `StorageKnex`, so it passes it in `o.storage`). A missing or unparseable tx counts as held.
   - Held txids are removed from the inner call. Each provider result gets `{ txid, status: 'error', serviceError: true }` for them. If no txid is left, the wrapper returns `[{ name: 'ColorBroadcastGuard', status: 'error', txidResults: [...] }]` without calling the inner function. Held txids are `markHeld`.
   - Repeated `serviceError` never flips a req to `invalid`: `applyAggregateStatus` only increments `attempts` (`attemptToPostReqsToNetwork.ts:213-215`), and the `attempts > 6 ⇒ invalid` rule applies only to validation errors (`:79-82`). The executor re-checks both lines in the vendored 2.15.0 and reports any change as BLOCKED.
4. **Release (renderer drain → main IPC).**
   - `createColorReleaseDrain({ isSettled, api, identityKey, chain })` → `{ drain(): Promise<{ released: string[] }> }` runs single-flight. For each txid in `api.held(identityKey, chain)` it calls `await isSettled(txid)` (contract §2.3 `ColorPermissionModule.isSettled`). Only `true` calls `api.release(identityKey, chain, txid)`. An `isSettled` throw, or `false`, leaves the txid held. A release IPC failure is logged, and the next tick retries.
   - Main `color-guard:release` runs serialized per namespace together with layer-2 parking (one promise chain per `<identityKey>-<chain>` in main), in this order:
     1. validate (identity / chain as Task 5, txid `^[0-9a-f]{64}$`, else `Invalid color guard txid`);
     2. write `<txid>.released`;
     3. find the req by txid; if its status is `nosend`, set it to `unsent`;
     4. `await storage.attemptToPostReqsToNetwork([req])`, which now passes both layers. "Already known", "already mined" and success all count as done. A `serviceError` leaves the req `sending` for `TaskSendWaiting`;
     5. delete `<txid>.held`.

     A crash before step 5 leaves `.held` in place, so the next drain repeats steps 2-5, all of which are idempotent. A second concurrent release of the same txid waits on the namespace chain and then finds the req no longer `nosend`.
   - `color-guard:held` (main → renderer event, all windows) is sent on every park. The renderer answers by calling `scheduler.runNow()`, which shares an in-flight run.
   - The scheduler's `settle` becomes `async () => { try { return await module.settle(undefined, adminOriginator) } finally { await drain.drain() } }`, so every tick (unlock + 1 s, 5 min, `online`, held event) ends with a release pass.
5. **Classifier.** `txHasColorOutput(tx)` is true iff some output satisfies `decodeToken(output.lockingScript) !== null` (lib, contract §8.1).
   - **Gap CG-DESK-CLS:** `decodeToken` returns `null` for a 1Color prefix with a non-P2PKH remainder (plan 04 Task 5), but 0162:102-104 makes any remainder a 1Color output. If `@bsv/templates` 2.2.0 exports a prefix-only decoder (grep `node_modules/@bsv/templates` for the `OneColor` decode API), use it as well: an output is BRC-162 if either says so. Otherwise record the gap in the report.
   - `@bsv/mandala` is ESM. The main process and the worker load it with a dynamic `import()`, as `monitor-worker.ts:17-20` loads the toolbox, and cache the promise. A load failure makes every classification "held" (fail closed) and logs `[color-guard] classifier unavailable` once. The build gate below proves the load path works, so this cannot silently hold every BSV transaction.
6. **Contract dependency.** The guard releases a token tx only when `isSettled(txid)` becomes true. If a profile-free (default-provider) asset send never gets a `settled` marker, it would stay held forever. The Electron-node integration test covers the Mandala receipt. The report records whether the vendored 0.2.0 marks profile-free sends settled; if it does not, that is a contract gap for plan 02, not a host workaround.

**Files:**
- Create: `electron/colorBroadcastGuard.ts` (`ColorGuardJournal`, `txHasColorOutput`, `loadColorClassifier`, `installColorBroadcastGuard`, `guardPostBeef`, `registerColorGuardIpc`)
- Modify: `electron/storage.ts` (install the guard on each `StorageKnex` at `:300`, wrap services at `:375`), `electron/monitor-worker.ts:138` (wrap the worker's services; journal root passed in the worker config), `electron/main.ts` (register the IPC next to `registerColorStoreIpc`), `electron/preload.ts` and `src/global.d.ts` (`colorGuard: { held(identityKey, chain): Promise<string[]>; release(identityKey, chain, txid): Promise<void>; onHeld(cb: (txid: string) => void): () => void }`)
- Create: `src/lib/permissionModules/color/releaseDrain.ts`
- Modify: `src/lib/permissionModules/color.ts` (drain in the scheduler's `settle`, `onHeld` → `runNow`, unsubscribe in `dispose`)
- Test: `test/colorBroadcastGuard.test.ts`, `test/colorReleaseDrain.test.ts` (both new, appended to `scripts.test`), `test/colorBroadcastGuard.integration.test.ts` (new, appended to `scripts.test`; `describe.skipIf(!await canUseBetterSqlite3())` like `test/feeSettings.wiring.test.ts:37-48`, so it is skipped under plain Node and runs under Electron's Node in Task 15 Step 3)

**Interfaces:**
- Consumes: `ColorPermissionModule.isSettled(txid)` (contract §2.3), `decodeToken` (contract §8.1), `Beef`/`Transaction` (sdk), `StorageKnex`/`EntityProvenTxReq` (toolbox), `startColorSettleScheduler` (Task 9), `createHostColorModule` (Task 12).
- Produces:
  - `class ColorGuardJournal { constructor(o?: { root?: string }); markHeld(id, chain, txid): Promise<void>; isReleased(id, chain, txid): Promise<boolean>; held(id, chain): Promise<string[]>; markReleased(id, chain, txid): Promise<void>; clearHeld(id, chain, txid): Promise<void> }`
  - `txHasColorOutput(tx: Transaction, classify: (script: LockingScript) => boolean): boolean`
  - `installColorBroadcastGuard(storage: { attemptToPostReqsToNetwork: Function; findTransactions: Function }, o: { identityKey: string; chain: WalletNetwork; journal: ColorGuardJournal; classify: () => Promise<(s: LockingScript) => boolean>; notifyHeld?: (txid: string) => void }): void`
  - `guardPostBeef(services: { postBeef: Function }, o: same as above minus notifyHeld): void`
  - `registerColorGuardIpc(ipcMain, journal, storageFor: (identityKey, chain) => Promise<StorageKnex>, broadcastHeld: (txid: string) => void): void` with the channels `color-guard:held` and `color-guard:release`
  - `createColorReleaseDrain(o: { isSettled(txid: string): Promise<boolean>; api: Window['electronAPI']['colorGuard']; identityKey: string; chain: WalletNetwork }): { drain(): Promise<{ released: string[] }> }`

- [ ] **Step 1: Write the failing tests**

`T` is a tx with output 0 = `new OneColor().lock(ID, 1500n, PKH)` (1 sat) and output 1 = P2PKH change. `P` is a plain P2PKH tx. `C` spends `T:1`. Fake reqs are `{ txid, rawTx, status, notify: { transactionIds: [1] }, inputBEEF: [..], addHistoryNote: vi.fn(), updateStorageDynamicProperties: vi.fn() }`. The fake storage's original `attemptToPostReqsToNetwork` is a spy, and `findTransactions` returns the transaction row status.

```ts
// test/colorBroadcastGuard.test.ts
test('holds an offline 1Color receipt and reports success', async () => {
  const r = await storage.attemptToPostReqsToNetwork([reqT /* tx status 'unproven' */])
  expect(r.details).toEqual([{ txid: T, req: reqT, status: 'success' }]); expect(original).not.toHaveBeenCalled()
  expect(reqT.status).toBe('nosend'); expect(await journal.held(A, 'test')).toEqual([T]); expect(notifyHeld).toHaveBeenCalledWith(T)
})
test('plain BSV passes through with the original arguments', async () => { /* [reqP] -> original called with ([reqP], trx, logger); journal empty */ })
test('a mixed batch splits: token parked, plain posted, details merged', async () => {})
test('an unparseable rawTx is held', async () => {})
test('a child of a held tx is held; a child of a released tx is not', async () => {})
test('a child spending an own nosend hand-over\'s change is held', async () => { /* storage has req H at 'nosend' with a BRC-162 output, no .held file; C spends H:1 -> C held */ })
test('a foreign proof-less ancestor in a receipt BEEF does not hold the receipt once released', async () => {})
test('a journal read fault holds the whole batch and posts nothing', async () => {})
test('a non-hold-safe token req is not parked but withheld by postBeef as serviceError', async () => {
  /* tx status 'unprocessed' -> original called; guarded services.postBeef returns serviceError for T; inner postBeef never sees T */
})
test('the worker postBeef wrapper withholds an unreleased token tx', async () => {
  /* guardPostBeef(services) ; postBeef(beef(T,P), [T,P]) -> inner called with [P]; T result serviceError; journal held [T] */
})
test('after release the same req posts', async () => { /* journal.markReleased(A, 'test', T); attemptToPost([reqT]) -> original called with [reqT] */ })
test('a crash after the release write re-posts on the next release', async () => {
  /* release IPC with storage.attemptToPost throwing once -> .released present, .held still present;
     second release -> req posted, .held removed; third release -> no-op */
})
test('two concurrent releases of one txid post once', async () => {})
test('classifier load failure holds every tx', async () => { /* classify() rejects -> [reqP] held */ })
test('IPC validates identity, chain and txid', async () => { /* 'Invalid color guard txid' etc. */ })
```

```ts
// test/colorReleaseDrain.test.ts
test('releases only settled txids', async () => { /* held [T,U]; isSettled T true, U false -> release(A,'test',T) once */ })
test('an isSettled throw keeps the txid held and the drain continues', async () => {})
test('single flight: overlapping drains share one pass', async () => {})
test('a release IPC failure is retried on the next drain', async () => {})
```

```ts
// test/colorBroadcastGuard.integration.test.ts (Electron Node only)
test('fake ARC never sees the receipt before release', async () => {
  /* real StorageKnex (sqlite temp file) + migrations; services = { postBeef: spy -> success } wrapped by guardPostBeef;
     installColorBroadcastGuard; wallet internalizeAction of an AtomicBEEF of T into basket 'p color <assetTag>' (overlay down)
     -> resolves accepted; the output is listed; fake ARC postBeef never received T; req status 'nosend'.
     Then a fake module { isSettled: async () => true } + createColorReleaseDrain over an in-process api -> drain()
     -> postBeef received [T] once (answer 'already known' => success); req 'unmined'; journal held() = [] */
})
test('a plain BSV internalize is unaffected', async () => {})
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run --config vitest.config.electron.ts test/colorBroadcastGuard.test.ts test/colorReleaseDrain.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

Write `electron/colorBroadcastGuard.ts` and `releaseDrain.ts`. Install the guard in `storage.ts` and wrap the worker's services in `monitor-worker.ts`. Register the IPC, expose `colorGuard` in preload and the types, and wire the drain and `onHeld` in `color.ts`.

- [ ] **Step 4: Run the tests and the gate**

Run: the two unit files, then `npm test`, both `tsc` configs and `npm run build`. Then run the integration file under Electron's Node:
`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/vitest/vitest.mjs run --config vitest.config.electron.ts test/colorBroadcastGuard.integration.test.ts`
Expected: PASS. The integration file is skipped under `npm test` and passes under Electron's Node. If Task 1 Step 4 was "not runnable", report the integration test as not run. The build must still pass. The classifier must load from the **built** main-process output, not just from Node resolution. Vitest transpiles `electron/colorBroadcastGuard.ts` itself, so the tests do not prove this.
- Read `module` in `tsconfig.electron.json` (the planner saw `"ESNext"`), and check how the built `monitor-worker` output emits its `import()`. A rewrite to `require()` fails with `ERR_REQUIRE_ESM` for the ESM-only `@bsv/mandala`.
- Smoke-load the built guard under Electron's Node and call `loadColorClassifier()`; it must resolve to a function: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "import('<built path of colorBroadcastGuard>').then(m => m.loadColorClassifier()).then(f => console.log(typeof f))"` prints `function`.
- If the emit breaks it, pick the fix that keeps `npm run build` green, in this order: a native dynamic import that the compiler leaves alone (`new Function('s', 'return import(s)')`), then a dual-format `@bsv/templates` decoder. Record the choice.
- A classifier that cannot load holds every BSV tx, so a failure here is BLOCKED.

Stability cases this task pins:
- crash: after `markHeld` and before parking (the drain releases normally); after the release write and before the post (`.held` stays, so the release is redone);
- double submit: a double release, and the same receipt internalized twice (the second internalize finds the txid already held: `markHeld` is idempotent);
- multi-window: two windows draining (release is idempotent and serialized per namespace in main);
- stale cache: none, because journal reads go to disk;
- retry: `serviceError` keeps the req `sending`, never `invalid`;
- guard fault: hold.

- [ ] **Step 5: Commit**

```bash
git add electron/colorBroadcastGuard.ts electron/storage.ts electron/monitor-worker.ts electron/main.ts electron/preload.ts src/global.d.ts src/lib/permissionModules/color.ts src/lib/permissionModules/color/releaseDrain.ts test/colorBroadcastGuard.test.ts test/colorReleaseDrain.test.ts test/colorBroadcastGuard.integration.test.ts package.json
git commit -m "fix(color): hold every unreleased 1Color tx from broadcast until the module reports it settled"
```

---

### Task 15: Re-vendor, final gate, docs

**Files:**
- Modify: `vendor/*.tgz`, `package.json` and `package-lock.json`, only if a newer `<sha>` exists in `vendor-ts-stack/`
- Modify: `docs/desktop-wallet-ux.md` (replace the "Mandala permissions" section, lines 27-47, with a "1Color tokens (BRC-207)" section) and `CHANGELOG.md` (Unreleased entry)

**Interfaces:** Consumes everything above. Produces the branch state handed to the draft-PR stage.

- [ ] **Step 1: Re-vendor if newer**

Run: `ls -t /Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack/*.tgz | head -20` and compare with `ls vendor/`.
If newer shas exist: copy them, update the specs, delete the superseded tarballs, run `npm install --no-audit --no-fund`, and confirm `npm ls @bsv/sdk @bsv/templates @bsv/wallet-toolbox-client @bsv/color-permission-module @bsv/mandala` shows one version each.

- [ ] **Step 2: Run the full gate**

Run: `npm test 2>&1 | grep -E "Test Files|Tests "`; both `tsc` configs; `npm run build`.
Expected:
- unit files = 51 baseline − 0 removed (the Mandala tests were never in the list) + 14 new passing (`listOutputsCount`, `permissionModuleRegistry`, `colorStore`, `colorConsentGate`, `colorConsentView`, `colorPrompt`, `colorSettleScheduler`, `colorDefaultProvider`, `colorAssetDisplay`, `colorPermissionModule.wiring`, `colorLinkageGrant`, `colorBridge`, `colorBroadcastGuard`, `colorReleaseDrain`) + 1 new skipped under plain Node (`colorBroadcastGuard.integration`) → `Test Files 65 passed | 4 skipped (69)`;
- webrtc `107 passed`;
- `tsc` exits 0 twice;
- build succeeds.

If the count differs, explain each difference in the report.

- [ ] **Step 3: Run toolbox 2.15 storage under Electron's Node**

Run the Task 1 Step 4 command with `test/colorBroadcastGuard.integration.test.ts` appended.
Expected: the Task 1 baseline pass count plus the guard integration tests. A new failure in the baseline files is a toolbox 2.15 storage regression: report it with the failing test names.

- [ ] **Step 4: Run the source checks**

Run: `grep -rn "p mandala\|'mandala'" src electron` (expected no output; `MANDALA_PROFILE_ID` imports are fine) and `grep -rnE "Number\(|parseFloat\(" src/lib/permissionModules/color` (expected no output).

- [ ] **Step 5: Write the docs**

The `docs/desktop-wallet-ux.md` section covers:
- the module and its two profiles;
- the Mandala overlay setting (fail closed when empty);
- the grant policy (30-min reads; spends always prompt; `seekPermission:false` errors);
- the settle cadence;
- the store location `~/.bsv-desktop/color-store/<identityKey>-<chain>/`;
- the broadcast hold: 1Color transactions wait in `~/.bsv-desktop/color-guard/<identityKey>-<chain>/` until the overlay admits them, and offline receipts show as pending meanwhile;
- the linkage grant: with the encrypt / linkage prompts enabled, one `Mandala token sending` approval covers an app's holder sends for 30 minutes;
- the HTTP bridge error shape `{ message, name, code?, retryable?, transport? }`;
- that old `p mandala` holdings are not migrated.

The `CHANGELOG.md` Unreleased entry carries the same summary plus the **publish prerequisites** (contract §9): 1 `@bsv/sdk` 4.0.0 → 2 `@bsv/templates` 2.2.0 → 3 `@bsv/wallet-toolbox` and `-client` 2.15.0 → 4 `@bsv/color-permission-module` 0.2.0 → 5 `@bsv/mandala` 0.5.0. After that, swap the `file:vendor/*` specs for registry ranges and remove the five `$name` overrides.

- [ ] **Step 6: Commit**

```bash
git add -A vendor package.json package-lock.json docs/desktop-wallet-ux.md CHANGELOG.md
git commit -m "docs(color): 1Color/BRC-207 wallet module notes and publish prerequisites"
```

---

## Self-review (planner)

**Spec coverage (design §4.3 plus this plan's scope):**

| Requirement | Task |
|---|---|
| sdk 4.0.0, toolbox(-client) 2.15.0, templates 2.2.0 via tarballs | 2, 10, 15 |
| 2.x→4.0 breaks (`totalOutputs`, DID removal, wire `spendable` byte, engines) | 2 |
| Module 0.2.0 registration with attested and Mandala issuer handlers | 10, 12 |
| Delete `permissionModules/mandala*` and its tests | 3 |
| Prompts for `color_send`/`signature`/`access`/`relinquish` (plus `color_receive_offline`, contract §2.5), exact decimals, legs, sats, fee, signatures | 7, 8, 11 |
| Grant policy C10/C6 and `seekPermission:false` | 6, 12 |
| Mandala routing to the configured overlay | 4, 12 (via `createMandalaProfile` / `handler.provider()`) |
| Settle (D17) | 9, 12 |
| Store (contract §2.1, D5) | 5 |
| Body limit (D30) | 13 |
| `colorHandoff` over JSON (D4) | 13 |
| Broadcast guard: no toolbox broadcast of a `p color` receipt or own hand-over before verified admission (contract §8.2, design goal 5, 0207 internalization) | 14 |
| `isSettled(txid)` as the only release signal (contract §2.3) | 14 |
| HTTP bridge errors `{message, name, code?, retryable?, transport?}` (contract §8.2, D22) | 13 |
| Holder-send linkage through the manager: no per-send prompt, no refusal (D20, contract §5) | 12 |
| Revision 2: `seekPermission` on every type, `handoff: true`, `signers[]`, `dispose()` | 6, 7, 12 |
| Gate (vitest, tsc, build) | every task, and 15 |

**Type consistency.** Two structural types stand in for contract types so that Tasks 5-9 run on V0: `ColorModuleStoreLike` (Task 5) for `ColorModuleStore`, and `SettleReportLike` (Task 9) for `ColorSettleReport`. Task 12 passes them where the contract types are expected; `tsc` checks the match. Two other names are fixed across tasks: `AssetDisplay` (defined in Task 7, produced in Task 11) and `PermissionModuleContext` (Task 12, built on Task 4's `NetworkSettings`). Task 14 uses `ColorGuardJournal`, `createColorReleaseDrain` and `window.electronAPI.colorGuard` with the same signatures in its Interfaces block, its tests and the `color.ts` wiring. Task 12's `approveColorLinkage` / `createColorLinkageGrantPolicy` are used under those names only.

**Decisions recorded for morning review:**
- **D-DESK-1:** the store is a main-process file KV, per `<identityKey>-<chain>`, keys `color.v1.*` only.
- **D-DESK-2:** admin originator: reads silent, spends prompt.
- **D-DESK-3:** `color_receive_offline` prompts every time (no continuing grant).
- **D-DESK-4:** the default provider is SHIP/LookupResolver with a capturing facilitator. `tstn` fails closed. `offChainValues` are refused on it.
- **D-DESK-5:** display metadata is resolved by the host through `color-admission` plus `readDeploy`, and is untrusted (the asset id is always shown).
- **D-DESK-6:** the old token-input wrapper is deleted; the upstream signing gate is pinned by the A.13 test.
- **D-DESK-7:** malformed or unknown consent messages are declined without a prompt.
- **D-DESK-8:** the broadcast hold has two layers. The storage method override in main parks hold-safe reqs at `nosend` and reports success, so offline receipts still credit. The `postBeef` wrapper in main and the worker withholds everything else as `serviceError`. Both key on a host-owned file journal released only by the renderer drain after `isSettled(txid)`. Classification is on subject txids plus children of own held txs, never on foreign BEEF ancestors.
- **D-DESK-9:** a 30-minute holder-send linkage grant per originator, limited to configured Mandala overlay keys as counterparty; counterparty-linkage revelation is granted per (originator, B). The policy ships even though the desktop defaults (`seekProtocolPermissionsForEncrypting` / `seekPermissionsForKeyLinkageRevelation` = false) never prompt. If the module or manager refuses either call, the task is BLOCKED with the §5.2 "leaf carries L" contract change.
- **D-DESK-10:** the bridge error body is `{ message, name?, code?, retryable?, transport? }`, built by one helper, never with `isError`.

**Contract gaps raised by this plan (for the orchestrator):**
- **CG-DESK-ERR:** sdk `HTTPWalletJSON` discards a 400 body without `isError` (`HTTPWalletJSON.ts:421-425`), so the name the bridge forwards does not reach an HTTP client. Needs an sdk client change; candidate owner plan 02. Task 13 pins it with a `test.fails` marker until it lands.
- **CG-DESK-CLS:** lib `decodeToken` ignores 1Color outputs with a non-P2PKH remainder (0162:102-104). The guard uses a templates prefix-only decoder too if 2.2.0 exports one.
- **CG-DESK-SETTLED:** if the vendored 0.2.0 never marks a profile-free (default-provider) send as settled, the guard holds such sends forever. Task 14 reports it; the fix belongs to plan 02.

## Execution record: whole-plan review fixes (2026-10-22, bsv-desktop `feat/1color` 3a45154, 457fe6f, 80d32ad)

**CG-DESK-SETTLED: confirmed, for plan 02 (Task 14 item 6).** Vendored `@bsv/color-permission-module` 0.2.0 does **not** mark a profile-free send settled unless its SHIP host returns an attested STEAK. `attestationFromSteak` (`node_modules/@bsv/color-permission-module/dist/index.mjs:1041-1053`) returns `undefined` when `admissionSignature` or `admissionIdentityKey` is absent. The settle submit path then returns `retry` with `ERR_NO_ATTESTATION` ("the overlay gave no admission" at `:1680`, "the admission is not attested" at `:1687`) and never reaches `store.markSettled` (`:1698`). A profile-free 1Color tx whose SHIP host returns an unattested STEAK, together with its parked BSV children, therefore stays in `~/.bsv-desktop/color-guard/<identityKey>-<chain>/` indefinitely. Nothing in the UI shows it and there is no way to release it. Per this plan the desktop does not work around it. It is recorded in bsv-desktop `CHANGELOG.md` (Known gaps) and `docs/desktop-wallet-ux.md` (Known limitations). Fix candidates for plan 02: SHIP hosts sign admissions for `tm_color_*`, or the module settles profile-free assets from an unattested admission it can verify some other way.

**Toolbox re-checks (Task 14 items 2-3), vendored `@bsv/wallet-toolbox` 2.15.0 (`out/src`), cross-checked against ts-stack worktree `4fa68e783` source. No change, nothing BLOCKED:**
- `attemptToPostReqsToNetwork.ts:79-82` (compiled `attemptToPostReqsToNetwork.js:59-66`): `attempts++` then `attempts > 6 ⇒ invalid` only inside the `validateReqError` catch (or `The txid parameter must be known to storage`).
- `attemptToPostReqsToNetwork.ts:213-215` (compiled `:188-190`): `applyAggregateStatus` `serviceError` only does `attempts++` and returns `sending`/`sending`.
- `StorageKnex.ts:2359-2360` `allocateChangeInput` (compiled `StorageKnex.js:1978-1981`): `['completed', 'unproven']`, plus `'sending'` unless `excludeSending`. The same list is at `:2032`, `:2072`, `:2112` and `:2333`. A `nosend` hand-over's change is never auto-selected, so the guard's own-storage `nosend` rule stays a fail-closed backstop.

**CG-DESK-REMOTE (new; contract note for §8.2, owner: interface contract).** §8.2's broadcast hold holds only where the host owns the storage that posts. On desktop the guard is installed on the main-process `StorageKnex` and its services. With remote active storage (`StorageClient`), the storage server runs `internalizeAction`/`createAction`/`sendWith` and posts with its own services, so nothing can be held. The desktop now fails closed:
- remote selected at build: a refusing module, `ColorLocalStorageRequiredError` / `ERR_COLOR_LOCAL_STORAGE_REQUIRED`, with no capability, no settle and no linkage grant;
- local selected: a live per-request and per-settle check (`isLocalStorageActive()`, which makes an unused manager available first);
- every backup sync first runs the re-park sweep.

Residuals the contract should state:
- (a) a remote storage provider gets no BRC-207 hold, so a host MUST refuse `p color` there;
- (b) only labelled `p color` requests are refused, so an app's unlabelled BRC-162 output through remote storage is not held;
- (c) a withhold that lands during a backup sync can reach a backup server at `sending`;
- (d) a request already past the live check when the user switches the primary runs on the storage it started on.

**Classifier shape (review finding, recorded, not changed).** `isOneColorShaped` holds any `<push> <push> OP_2DROP …` output even when `OneColor.decode` rejects it, for example a 2-field PushDrop with `lockPosition: 'after'`. Such a tx and its children are released only by `isSettled`, so this wallet never broadcasts them. This is documented as a known limitation. Neither a UI for held txids nor an `isSettled`-independent release for outputs that fail decode was added: the latter needs the design owner's agreement, and the project is close to a demo.

**Linkage keys (review finding).** The linkage policy now reads the overlay keys the color module accepted (`colorLinkageOverlayKeys(module)`), not raw `settings.mandalaOverlays`. An off-curve key the Mandala profile dropped gets no grant, and no key gets one while the module refuses requests or after it is disposed.

**Task 1 Step 4 baseline / network-switch.** The baseline numbers were not available to this run. The two `networkSwitch.integration` failures under Electron's Node (`window.addEventListener is not a function` at `directPaySettings.ts:249`) are pre-existing by code identity: `DirectPayManager.ts`, `directPaySettings.ts` and the test file are unchanged since `361778c`, and `_buildWallet` already called `_startDirectPay()` there (`WalletService.ts:885` at `361778c`). The stub is now an `EventTarget`, both services register the color module, and Electron-node gives `4 passed (4)` files / `14 passed` tests (storageIdentity ×2, networkSwitch, colorBroadcastGuard.integration).

**Gate after the fixes:**
- `npm test`: `Test Files 66 passed | 4 skipped (70)` and `Tests 885 passed | 1 expected fail | 25 skipped (911)`. The file count is +1 against Task 15's 65 because of the new `colorBackupSync`;
- webrtc: `107 passed`;
- both `tsc` configs exit 0;
- `npm run build` passes.

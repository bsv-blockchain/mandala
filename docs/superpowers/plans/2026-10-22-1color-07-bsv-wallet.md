# 1Color / BRC-207 in bsv-wallet (plan 07, P-WAL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execution is subagent-driven: one fresh implementer per task and one fresh reviewer per task. Sonnet handles routine tasks. Opus handles Tasks 3, 7, 8, 12, 13, 15, 16 and 17 (security, settlement and multi-file work). Fable is never used.

**Goal:** Move the bsv-wallet Expo wallet (`packages/expo-wallet-toolbox`) from the deleted `'p mandala'` P-module and its settlement machinery onto upstream `@bsv/color-permission-module` 0.2.0, with the attested and Mandala issuer-v1 profiles. Amounts are uint64/bigint end to end. Offline settlement uses the module settle API and `color_offline`.

**Architecture:** The color module is registered in the existing `SigningPolicyPermissionsManager` as `permissionModules.color`. It holds all token custody and evidence. Its store is a `ColorModuleStore` over the wallet's `key_value_store`. `MandalaRuntime` stays the UI's only door to tokens, but it becomes a thin host over three things: the module (`settle`, `handoffEvidence`), `@bsv/mandala` 0.5.0 (`sendHandover`, `deliverHandover`, `receiveHandovers`, `readDeploy`, amount helpers), and one wallet-owned SQLite journal, `color_transfers`. The journal replaces the four deleted settlement tables. It is the only key for the two incident guards: the broadcast hold in `StorageExpoSQLite` and the abort refusal. Nearby payments carry localpay frame v6 with a BRC-207 `profileData` carrier, and the payee builds a §7.1 receipt for `internalizeAction` into `p color <assetTag>`.

**Tech Stack:** TypeScript 6, React Native 0.86 / Expo 57, Metro, jest 29 + jest-expo (run from the repo root), node:sqlite for storage tests, patch-package, `@bsv/sdk` 4.0.0, `@bsv/wallet-toolbox-mobile` 2.15.0, `@bsv/templates` 2.2.0, `@bsv/color-permission-module` 0.2.0, `@bsv/mandala` 0.5.0 (all vendored tarballs).

**Spec:** `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (§4.4, §5, §8 B1–B6). The seam contract is authoritative: `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/plans/2026-10-22-1color-00-interfaces.md` (cited as **IC §n**). The pinned specs are cited as **0162:line** = `docs/design/brc-0162-1color.pinned.md` and **0207:line** = `docs/design/brc-0207-1color-wallet-module.pinned.md` (both in the mandala worktree).

## Global Constraints

- Work only in `/Users/personal/git/bsv-wallet-wt/1color` on branch `feat/1color`. Never touch `/Users/personal/git/bsv-wallet`, `/Users/personal/git/ts-stack`, `/Users/personal/git/ts/bsv-desktop` or `/Users/personal/git/demos/mandala`. Do not push, tag, merge, or `npm publish`. A later stage opens draft PRs.
- Commits use conventional-commit subjects. Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run jest from the repo root only: `cd /Users/personal/git/bsv-wallet-wt/1color && npx jest <paths>`. Running it from the package directory fails at Babel. Typecheck from the root with `npx tsc --noEmit -p .`.
- Do not modify `@bsv/templates` `Bsv21Token.ts`. This wallet does not import it.
- There is no backward compatibility with old Mandala assets, outputs, the `'p mandala'` basket, `[2,'p mandala token']` derivations, settlement tables, lib journals, frame versions below 6, session version 1, or MessageBox bodies v1/v2.
- Token amounts are JS `bigint` in every API. The per-output domain is `1..18446744073709551615` (0162:143). Sums are unbounded. Amounts on every wire and in every JSON or SQLite TEXT are canonical decimal strings matching `^(0|[1-9][0-9]*)$` (IC §0), never JSON numbers. Use `Number()` on a token amount only for `dec`, `vout` or `outputIndex`.
- Asset ids look like `<64 lowercase hex>_0` and outpoints look like `<txid>.<vout>` (IC §0). The value basket is `p color <assetTag>` from lib `colorBasket(assetId)`. Never hand-build these strings.
- BSV Chronicle: never normalize S when signing or comparing. Accept high-S signatures on verify (0207 C.0).
- Stability mandate: for every pipeline change, reason through a crash between steps, a double tap, two concurrent callers (the drain tick racing the screen), a stale cache, and a retry. Every guard fails closed: an unanswerable read means hold or refuse, never post or abort.
- Vendored tarballs come only from `/Users/personal/git/demos/mandala-wt/1color/vendor-ts-stack/` (IC §9). Pack level **V3** means all of these are present: `bsv-sdk-4.0.0-*`, `bsv-templates-2.2.0-*`, `bsv-wallet-toolbox-client-2.15.0-*`, `bsv-wallet-toolbox-mobile-2.15.0-*`, `bsv-color-permission-module-0.2.0-*`, `bsv-mandala-0.5.0-*`. Tasks 1–3 may run at **V0** (sdk 4.0.0, toolbox 2.15.0, templates ≥2.1.0, module ≥0.1.0). Task 4 onward requires V3. If V3 is missing when Task 4 starts, stop and report BLOCKED. Do not stub the packages.
- Contract names are used verbatim: `ColorPermissionModule`, `ColorModuleStore`, `ColorOverlayProvider`, `ColorSettleReport`, `ColorHandoffResult`, `createColorModule`, `createAttestedProfile`, `createMandalaProfile`, `createMandalaOverlayProvider`, `ATTESTED_PROFILE_ID`, `MANDALA_PROFILE_ID`, `COLOR_OFFLINE_TAG`, `MESSAGEBOX` (`'mandala-color'`). Errors are matched by `.name`, never `instanceof` (IC D22).

## Wallet-local decisions (calls made overnight, for morning review)

- **W1 Journal as the guard key.** A wallet-owned table `color_transfers` is the only durable host record. The broadcast hold applies when a req's raw tx contains a BRC-162 token output and the journal state for that txid is not `settled`. A missing row means hold. The guard never reads the module's `color.v1.*` keys, because IC §2.1 says that layout is T2-internal.
- **W2 Admin-originator consent.** `requestTokenAccess` auto-approves every message type for `adminOriginator`, because the wallet's own screens are the consent surface. This matches the old P-module admin pass-through. External originators prompt through the existing queue. The prompt queue keeps a 30-minute read grant per originator, and a spend approval never grants reads or the reverse (design C10). `seekPermission:false` without a grant returns false and never prompts.
- **W3 Default provider.** `provider` (the baseline-asset default) is the same `createMandalaOverlayProvider` instance as the profile's routed provider. Non-Mandala 1Color assets therefore fail closed against the Mandala overlay (unknown-topic). This wallet is a Mandala wallet.
- **W4 Hand-over = delivery attempt.** On the handle rail the journal row moves to `handed_over` before `deliverHandover` runs, because a lost MessageBox response may still have delivered. The abort guard then refuses aborts for it. A failed delivery sets `delivered = 0`, and the tick redelivers it from `handoffEvidence`.
- **W5 Nearby ACK.** The payee's positive `confirm(true)` is the ACK. After it the payer calls `settleNow(txid)`. The unused σI `settlementAck.ts` (`msa1:`) is deleted. No payee ever sent it.
- **W6 Session v2.** `SESSION_VERSION` becomes 2 for every session. A token session carries `a` as a decimal string and drops the asset's `u`/`k` (overlay url/key). The payer uses its own configured overlay (IC §7.3 rationale). A v1 session is a CodecError.
- **W7 Asset metadata.** Label, ticker and decimals come from lib `readDeploy` on the deploy tx. The tx is taken first from a received receipt's attested `declarationTx` (cached in KV as `bsvwallet.color.asset.<assetId>`), and otherwise from `provider.admission(assetId, ['<txid>.0'])`.
- **W8 Patch rebase.** `patches/@bsv+sdk+2.8.11.patch` (native secp) and `patches/@bsv+wallet-toolbox-mobile+2.14.9.patch` (Vault authorization, custom-instructions history, input-policy hook, minimal vault funding, shadow engine verify) are rebased to 4.0.0 / 2.15.0. The toolbox rebase is mandatory. If the sdk NativeSecp hunks cannot be placed in 4.0.0's primitives, the sdk patch is dropped and the native-routing assertions in `__tests__/nobleBackend.test.ts` are skipped with the reason in the test. Pure-JS ECDSA is byte-identical. `@bsv+mandala+0.4.1.patch` is deleted.
- **W9 Toolbox package deps.** `packages/expo-wallet-toolbox/package.json` keeps its established `peerDependencies` pattern with semver ranges. The `file:` specs and `overrides` live only in the root package.json. IC §9 asks for `file:../../vendor/…` in the package; a published package must not carry `file:` peers (reported as a contract gap).
- **W11 Audit S2/S3 regression pins through the published stack.** The old P-module bugs (S2 blind-sign prompt, S3 spoofable "change") die with `permissionModule.ts` in Task 10, but the wallet's own wrappers (`SigningPolicyPermissionsManager.createSignature` queue, `conformWalletResults`, `wrapAbortActionForSettlements`, `guardVaultAccess`) could re-route a call around the module. Task 10 therefore pins both through the exact stack WalletContext publishes, not the bare module. The S3 assertion is "refused before any prompt", because upstream `planOutput` throws for a `p color` basket output that is not in `plan.ownedOutputs` (ts-stack-wt `ColorPermissionModule.ts:1283-1286`) and `assertOwned` throws for an owned output not locked to the wallet's derived key (`:2186-2189`). If the vendored 0.2.0 dist no longer throws there, the test falls back to the other acceptable form: the `color_send` message reaching `prompt` has `keptAmount: '0'`, lists the output as a destination, and `describeColorRequest` shows no `Kept as change` line. The executor records which form ran.
- **W10 Pending vs settled.** `available` comes from the `p color balance <assetTag>` view (0207:674-697). `offline` is the sum of value records in the `p color assets` inventory that carry both `color_offline` and `color_state_available` (0207:396-404). `settled = available − offline`, clamped to ≥ 0 with a dev log, because the two views are separate snapshots (0207:657-660).

## Review Focus

1. **Mandala overlay unreachable while ARC is reachable during a receive.** The module credits `color_offline`, and the toolbox's forced broadcast inside `internalizeAction` must be held. Pinned in Task 7: `holds a 1Color receipt with no journal row even when online`.
2. **A drain tick and a screen settling the same txid concurrently, or a double-tapped Send.** One `color.settle` call per in-flight txid, and one journal transition. Pinned in Task 12: `coalesces concurrent settleNow(txid) onto one module call`. Pinned in Task 13: `a second sendToHandle while one is in flight for the same asset is refused`.
3. **App killed between `signAction` and hand-over delivery.** The row is `handed_over` with `delivered = 0`. The abort guard refuses, and the tick redelivers. Pinned in Task 8: `refuses abort for a handed_over row whatever delivered says`. Pinned in Task 13: `tick redelivers an undelivered hand-over from handoffEvidence`.
4. **Fresh install, store loss, or an externally internalized receipt with `color_offline` outputs.** Coins show as pending and never as settled. Their tx is never posted until settled. Pinned in Task 11: `offline units come only from color_offline-tagged available records`. Pinned in Task 12: `reconcileHeld journals an unjournaled tagged receipt as held, never settled`.
5. **Amounts above 2^53 on every hop.** Session, frame, receipt, journal, balance and display all stay exact. Pinned in Task 14: `round-trips 18446744073709551615 through a v2 token session`. Pinned in Task 18: `formats 2^64-1 at dec 2 exactly`. Pinned in Task 6: `stores and reads units 18446744073709551615 exactly`.
6. **A wallet wrapper re-routes a token-key signature or a fake "change" output around the module (audit S2/S3).** A bare digest under a `p color` key is refused with no prompt and never reaches the underlying wallet (0207 A.13, 0207:2195-2233). An app output placed in a `p color` basket but locked to a foreign key is never shown as kept change. Pinned in Task 10 `colorSigningGate.test.ts`: `A.13: a bare digest under a p color key is refused without a prompt` and `S3: a p color basket output not locked to a wallet key is never kept change`.

---

## File Structure (package paths are relative to `packages/expo-wallet-toolbox/`)

| File | Responsibility | Action |
|---|---|---|
| `package.json` (root) | `file:vendor/*.tgz` specs, `$name` overrides, jest config | Modify (T2, T4) |
| `packages/expo-wallet-toolbox/package.json` | peer ranges, version 0.21.0 | Modify (T2, T19) |
| `scripts/vendor-1color.mjs` (root) | copy newest tarballs, rewrite specs/overrides | Create (T2) |
| `patches/@bsv+sdk+4.0.0.patch`, `patches/@bsv+wallet-toolbox-mobile+2.15.0.patch` | rebased patches | Create (T3); delete the 2.8.11/2.14.9/mandala patches |
| `metro.config.js` (root) | toolbox-client→mobile alias, package exports, `mjs` | Modify (T4) |
| `core/mandala/kvStore.ts` | `MandalaStorage` + `ColorModuleStore` over `key_value_store` | Create (T5) |
| `core/storage/schema/createTables.ts` | drop 4 Mandala tables, create `color_transfers` | Modify (T6) |
| `core/mandala/transferJournal.ts` | `TransferJournal` over `color_transfers` | Create (T6) |
| `core/mandala/colorGuard.ts` | token-tx detection + held-txid predicate | Create (T7) |
| `core/storage/StorageExpoSQLite.ts`, `core/storage/methods/processOfflineActions.ts` | guards re-keyed to the journal | Modify (T7) |
| `core/mandala/abortGuard.ts` | abort refusal re-keyed to the journal | Rewrite (T8) |
| `core/mandala/accessPolicy.ts` | `ColorTokenAccessHandler` host policy | Create (T9) |
| `ui/components/ui/colorPrompt.ts`, `ui/components/ui/PermissionSheet.tsx` | color consent copy | Create/Modify (T9) |
| `core/mandala/colorModule.ts` | `buildColorModule` (module + provider + store) | Create (T10) |
| `core/context/WalletContext.tsx` | registration, runtime build, drain tick | Modify (T10, T17) |
| `core/mandala/types.ts`, `core/mandala/runtime.ts`, `core/mandala/createRuntime.ts` | journal types, runtime interface, runtime | Rewrite (T11–T13) |
| `core/mandala/assets.ts` | inventory, balances, deploy metadata cache | Create (T11) |
| `core/mandala/settle.ts` | settle mapping, single-flight, refusal handling | Create (T12) |
| `core/mandala/handle.ts` | handle send, redelivery, inbox receive | Create (T13) |
| `core/localpay/session.ts`, `core/localpay/codec.ts`, `core/localpay/pending.ts` | session v2, frame v6, receipt internalize | Modify (T14, T16) |
| `core/localpay/build.ts`, `core/offline/payerHold.ts`, `core/offline/cancelParked.ts` | nearby payer via the module | Modify (T15) |
| `core/localpay/verify.ts`, `core/mandala/receipt.ts` | payee structural verify, §7.1 receipt | Modify/Create (T16) |
| `ui/tokenFormat.ts` + UI sweep | bigint formatting, pending vs settled | Modify (T18) |
| Deleted | `core/mandala/{permissionModule,basketMigration,bundle,drain,inboxPrehold,settlementStore,token,resendTransfer}.ts`, `core/localpay/settlementAck.ts`, `core/offline/tokenFrames.ts` and their tests | T10–T16 |

**tsc during the plan:** Tasks 10–17 rewrite seams that ~40 files consume, so `npx tsc --noEmit -p .` is red between them. Each task records the error count and lists the files that are still red. Those files must belong to a later task's **Files** list. Task 19 requires the baseline count or fewer.

---

### Task 1: Baseline

**Files:**
- Create: `docs/superpowers/1color-baseline.md` (wallet repo)

**Interfaces:**
- Consumes: nothing
- Produces: recorded baseline counts. Every later "no regression" claim compares against this file.

- [ ] **Step 1: Confirm the worktree**

Run: `cd /Users/personal/git/bsv-wallet-wt/1color && git status --porcelain && git rev-parse --abbrev-ref HEAD`
Expected: empty status and `feat/1color`. If the status is not empty, stop and report.

- [ ] **Step 2: Install exactly the lockfile**

Run: `npm ci`
Expected: exit 0. patch-package prints `@bsv/sdk@2.8.11 ✔`, `@bsv/wallet-toolbox-mobile@2.14.9 ✔`, `@bsv/mandala@0.4.1 ✔`.

- [ ] **Step 3: Run the whole suite and typecheck**

Run: `npx jest 2>&1 | tail -n 40` then `npx tsc --noEmit -p . 2>&1 | grep -c "error TS"`
Expected: a `Tests:` summary line and an integer.

- [ ] **Step 4: Record the baseline**

Write `docs/superpowers/1color-baseline.md` with the HEAD sha, the `Test Suites:` and `Tests:` lines verbatim, every failing test file path, and the tsc error count with the files that carry errors (`npx tsc --noEmit -p . | grep "error TS" | cut -d'(' -f1 | sort | uniq -c`).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/1color-baseline.md
git commit -m "docs: record 1color baseline test and tsc counts"
```

---

### Task 2: Vendor the 1Color packages and install

**Files:**
- Create: `scripts/vendor-1color.mjs`, `__tests__/deps1color.test.ts`
- Modify: `package.json` (root), `packages/expo-wallet-toolbox/package.json`, `package-lock.json`
- Delete: `vendor/bsv-mandala-0.4.1.tgz`, `patches/@bsv+mandala+0.4.1.patch`

**Interfaces:**
- Consumes: tarballs in `vendor-ts-stack/` (IC §9).
- Produces: `node scripts/vendor-1color.mjs [--src <dir>]`, which can be re-run whenever a newer pack lands. Installed versions: `@bsv/sdk` 4.0.0, `@bsv/templates` 2.2.0, `@bsv/wallet-toolbox-client` and `-mobile` 2.15.0, `@bsv/color-permission-module` 0.2.0, `@bsv/mandala` 0.5.0.

- [ ] **Step 1: Write the failing test** `__tests__/deps1color.test.ts`

Read every package.json through `fs` (`node_modules/<name>/package.json`), because the color module's `exports` does not expose `./package.json`.

```ts
const VENDORED = {
  '@bsv/sdk': '4.0.0', '@bsv/templates': '2.2.0', '@bsv/wallet-toolbox-client': '2.15.0',
  '@bsv/wallet-toolbox-mobile': '2.15.0', '@bsv/color-permission-module': '0.2.0', '@bsv/mandala': '0.5.0'
}
it('pins every vendored package to a file: tarball that exists', () => {
  for (const name of Object.keys(VENDORED)) {
    const spec = rootPkg.dependencies[name]
    expect(spec).toMatch(/^file:vendor\/bsv-[a-z-]+-\d+\.\d+\.\d+-[0-9a-f]{7}\.tgz$/)
    expect(fs.existsSync(path.join(root, spec.slice(5)))).toBe(true)
    expect(rootPkg.overrides[name]).toBe(`$${name}`)
  }
})
it('installs exactly the vendored versions', () => {
  for (const [name, v] of Object.entries(VENDORED)) expect(installedVersion(name)).toBe(v)
})
it('has one @bsv/sdk in the tree', () => {
  expect(nestedCopies('@bsv/sdk').filter(p => installedVersionAt(p) !== '4.0.0')).toEqual([])
})
it('drops the old Mandala tarball and patch', () => {
  expect(fs.existsSync(path.join(root, 'vendor/bsv-mandala-0.4.1.tgz'))).toBe(false)
  expect(fs.readdirSync(path.join(root, 'patches')).filter(f => f.startsWith('@bsv+mandala+'))).toEqual([])
})
it('declares 1Color peer ranges on the toolbox package', () => {
  expect(toolboxPkg.peerDependencies).toMatchObject({ '@bsv/sdk': '^4.0.0', '@bsv/templates': '^2.2.0',
    '@bsv/wallet-toolbox-mobile': '^2.15.0', '@bsv/mandala': '^0.5.0', '@bsv/color-permission-module': '^0.2.0' })
})
```
`nestedCopies(name)` walks `node_modules/**/node_modules/<name>/package.json`, skipping `.bin`, with a depth limit of 6.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest __tests__/deps1color.test.ts`
Expected: FAIL. The spec is `^2.8.11`, not `file:`.

- [ ] **Step 3: Implement `scripts/vendor-1color.mjs`**

The script is plain Node with no dependencies. For each of the six names it selects the newest-mtime `bsv-<pkg>-<ver>-<sha>.tgz` in `--src` (default: the vendor-ts-stack path above). It copies the file to `vendor/`, deletes older tarballs of the same package from `vendor/`, and sets root `dependencies[name] = "file:vendor/<file>"` and `overrides[name] = "$<name>"`. It deletes `vendor/bsv-mandala-0.4.1.tgz`. It sets the toolbox package `peerDependencies` to the ranges in the test, adding `@bsv/color-permission-module`. It prints the chosen file per name and exits 1 when a name has no tarball. Delete `patches/@bsv+mandala+0.4.1.patch` with `git rm`.

- [ ] **Step 4: Run the script and install**

Run: `node scripts/vendor-1color.mjs && npm install`
Expected: exit 0. patch-package reports that the `@bsv/sdk@2.8.11` and `@bsv/wallet-toolbox-mobile@2.14.9` patches do not match the installed versions. That warning is expected and Task 3 fixes it.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx jest __tests__/deps1color.test.ts`
Expected: PASS. At V0, only the version assertions for the color module, templates and mandala may fail. Record that in the task report and rerun this step at the start of Task 4.

- [ ] **Step 6: Commit**

```bash
git add scripts/vendor-1color.mjs __tests__/deps1color.test.ts package.json package-lock.json packages/expo-wallet-toolbox/package.json vendor patches
git commit -m "chore(deps): vendor sdk 4.0.0, toolbox 2.15.0, templates 2.2.0, color module 0.2.0, mandala 0.5.0"
```

---

### Task 3: Rebase the patch-package patches

**Files:**
- Create: `patches/@bsv+sdk+4.0.0.patch`, `patches/@bsv+wallet-toolbox-mobile+2.15.0.patch`, `__tests__/chronicleAttestation.test.ts`
- Delete: `patches/@bsv+sdk+2.8.11.patch`, `patches/@bsv+wallet-toolbox-mobile+2.14.9.patch`
- Test (existing gates): `__tests__/nobleBackend.test.ts`, `packages/expo-wallet-toolbox/__tests__/vault/`, `packages/expo-wallet-toolbox/__tests__/storage/vaultGuardSql.test.ts`

**Interfaces:**
- Consumes: the installed 4.0.0 / 2.15.0 dist trees (`dist/{cjs,esm}/src/...` for the sdk, `out/index.mobile.{cjs,mjs}` for the toolbox).
- Produces: the same runtime hooks the wallet already relies on, unchanged in name. These are `NativeSecp` routing, the toolbox `__bsvVaultAdminAuthorized` flag, the `resolveInputScript` host policy hook, and the custom-instructions history and minimal-funding patches.

- [ ] **Step 1: Write the failing Chronicle gate** `__tests__/chronicleAttestation.test.ts`

This uses 0207 C.0 (0207:10224-10264) and goes through `@bsv/sdk`, so it exercises the patched ECDSA path, with noble active under jest.

```ts
const MSG = '1color-admit:v1:tm_color_c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0:05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931:0,2'
const LOW = '3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a'
const HIGH = '3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7'
const ARGS = { protocolID: [2, 'color admission attestation'] as [2, string], keyID: '1' }
it('signs C.0 byte-exactly (RFC 6979, low-S)', async () => {
  const { signature } = await new ProtoWallet(new PrivateKey(5555)).createSignature({ data: Utils.toArray(MSG, 'utf8'), ...ARGS, counterparty: 'anyone' })
  expect(Utils.toHex(signature)).toBe(LOW)
})
it.each([LOW, HIGH])('verifies %s with the derived child, never the bare key', async sig => {
  const signer = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
  const ok = await new ProtoWallet('anyone').verifySignature({ data: Utils.toArray(MSG, 'utf8'), signature: Utils.toArray(sig, 'hex'), ...ARGS, counterparty: signer })
  expect(ok.valid).toBe(true)
  const bare = PublicKey.fromString(signer).verify(MSG, Signature.fromDER(Utils.toArray(sig, 'hex')), 'utf8')   // hashes MSG once internally
  expect(bare).toBe(false)
})
```
`ProtoWallet.verifySignature` throws `ERR_INVALID_SIGNATURE` instead of returning `{valid:false}`, so only the positive cases use it. The bare-key check uses `PublicKey.verify(msg, sig, 'utf8')`, which hashes with SHA-256 once.

- [ ] **Step 2: Run the gates and confirm they fail**

Run: `npx jest __tests__/nobleBackend.test.ts __tests__/chronicleAttestation.test.ts packages/expo-wallet-toolbox/__tests__/vault packages/expo-wallet-toolbox/__tests__/storage/vaultGuardSql.test.ts`
Expected: FAIL in nobleBackend (no `NativeSecp.js`) and in the vault suites (no `__bsvVaultAdminAuthorized`). chronicleAttestation may already pass on pure JS. That is acceptable, because it is a regression gate for the rebase.

- [ ] **Step 3: Rebase the toolbox patch (mandatory)**

For each hunk in the 2.14.9 patch, locate the same function in 2.15.0 `out/index.mobile.cjs` and `out/index.mobile.mjs` by name: `verifyUnlockScriptsBatch`, `completeSignedTransaction`, `Wallet.listActions` custom-instructions redaction, `Wallet.createAction` vault authorization, `resolveInputScript`, `makeFundingParams`, and the `StorageProvider` hunk. Re-apply each hunk by hand, keeping every `PATCH(bsv-browser)` comment. Then run `npx patch-package @bsv/wallet-toolbox-mobile`. If patch-package cannot resolve the `file:` tarball, extract the tarball to a scratch dir and write the patch with `git diff --no-index`, with paths rewritten to `a/node_modules/@bsv/wallet-toolbox-mobile/...`. Delete the 2.14.9 file.

- [ ] **Step 4: Rebase the sdk patch (or drop it per W8)**

The sdk patch covers these 10 files in `dist/cjs` and `dist/esm`: ECDSA, Hash, NativeSecp (whole new file), PrivateKey, PublicKey, Schnorr, Signature, SymmetricKey, P2PKH, Transaction. Re-apply into 4.0.0 and regenerate with `npx patch-package @bsv/sdk`. If ECDSA/PublicKey in 4.0.0 have no equivalent sync sign/verify site, drop the patch. In that case add `it.skip` with the reason `"sdk 4.0.0: native secp patch dropped (W8); pure-JS ECDSA is byte-identical"` to the native-routing cases in `nobleBackend.test.ts`, and keep its byte-parity cases. Delete the 2.8.11 file either way.

- [ ] **Step 5: Run the gates and confirm they pass**

Run: `rm -rf node_modules/@bsv/sdk node_modules/@bsv/wallet-toolbox-mobile && npm install && npx jest __tests__/nobleBackend.test.ts __tests__/chronicleAttestation.test.ts packages/expo-wallet-toolbox/__tests__/vault packages/expo-wallet-toolbox/__tests__/storage/vaultGuardSql.test.ts packages/expo-wallet-toolbox/__tests__/vault/proofBar.railIsolation.test.ts`
Expected: patch-package prints `@bsv/sdk@4.0.0 ✔` and `@bsv/wallet-toolbox-mobile@2.15.0 ✔`. The sdk line may be absent if dropped. All listed suites PASS, with only W8 skips allowed.

- [ ] **Step 6: Commit**

```bash
git add patches __tests__/chronicleAttestation.test.ts __tests__/nobleBackend.test.ts
git commit -m "chore(patches): rebase native-secp and vault patches onto sdk 4.0.0 and toolbox-mobile 2.15.0"
```

---

### Task 4: ESM-only packages under Metro and jest-expo

**Files:**
- Modify: `metro.config.js`, root `package.json` (`jest` block)
- Create: `__tests__/colorEsmResolution.test.ts`, `__tests__/metroConfig1color.test.ts`

**Interfaces:**
- Consumes: V3 tarballs. Rerun Task 2 Step 4–5 first if the pack level changed.
- Produces: under jest and Metro, `@bsv/wallet-toolbox-client` resolves to `@bsv/wallet-toolbox-mobile` (IC D21). `@bsv/color-permission-module` (`.mjs`), `@bsv/mandala` and `@bsv/mandala/profile` load. Metro resolves package exports.

- [ ] **Step 1: Write the failing tests**

`__tests__/colorEsmResolution.test.ts`:
```ts
import * as color from '@bsv/color-permission-module'
import * as client from '@bsv/wallet-toolbox-client'
import * as mobile from '@bsv/wallet-toolbox-mobile'
import { createMandalaProfile, createMandalaOverlayProvider, MANDALA_PROFILE_ID } from '@bsv/mandala/profile'
import { MESSAGEBOX, formatAmount } from '@bsv/mandala'
it('loads the module with the 0.2.0 surface', () => {
  expect(typeof color.createColorModule).toBe('function')
  expect(typeof color.createAttestedProfile).toBe('function')
  expect(color.ATTESTED_PROFILE_ID).toBe('https://brc.dev/207/attested')
  expect(color.COLOR_OFFLINE_TAG).toBe('color_offline')
})
it('aliases toolbox-client to toolbox-mobile (D21)', () => {
  expect(client.WalletPermissionsManager).toBe(mobile.WalletPermissionsManager)
  expect(typeof (mobile as any).encryptMetadata).toBe('function')
  expect(typeof (mobile as any).maybeDecryptMetadata).toBe('function')
  expect(typeof (mobile as any).sdk.specOpBasketPrefixOutputs).toBe('string')
})
it('loads the lib core and profile entries', () => {
  expect(MESSAGEBOX).toBe('mandala-color')
  expect(MANDALA_PROFILE_ID).toBe('https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md')
  expect(formatAmount(18446744073709551615n, 2)).toBe('184467440737095516.15')
  expect(typeof createMandalaProfile).toBe('function'); expect(typeof createMandalaOverlayProvider).toBe('function')
})
it('ships no Node-only imports on the module path', () => {
  for (const f of [modDist('@bsv/color-permission-module'), modDist('@bsv/mandala', 'profile.js'), modDist('@bsv/mandala', 'index.js')])
    expect(fs.readFileSync(f, 'utf8')).not.toMatch(/from ['"](node:|fs['"]|path['"]|crypto['"])|require\(['"](node:|fs['"]|crypto['"])/)
})
```
`modDist(name, file?)` resolves the package directory via `path.join(root,'node_modules',name)` plus its `exports['.'].import.default` (or `dist/<file>`).

`__tests__/metroConfig1color.test.ts` loads `metro.config.js` with `expo/metro-config` mocked to return `{ resolver: { sourceExts: ['js','ts','tsx','json'], assetExts: [], extraNodeModules: {} }, transformer: {}, server: {} }`. It asserts `config.resolver.unstable_enablePackageExports === true` and that `sourceExts` contains `'mjs'` and `'cjs'`. It calls `config.resolver.resolveRequest(ctx, '@bsv/wallet-toolbox-client', 'ios')` with `ctx.resolveRequest = jest.fn((c, name) => ({ type: 'sourceFile', filePath: name }))` and expects the upstream call to receive `'@bsv/wallet-toolbox-mobile'`. It also asserts that `node:crypto` still maps to quick-crypto.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest __tests__/colorEsmResolution.test.ts __tests__/metroConfig1color.test.ts`
Expected: FAIL. `SyntaxError: Cannot use import statement outside a module` (the `.mjs` is untransformed) or `Cannot find module '@bsv/wallet-toolbox-client'`. The Metro test fails on `unstable_enablePackageExports`.

- [ ] **Step 3: Implement**

In the root `jest` block:
- Add `"transform": { "\\.mjs$": "babel-jest" }`. Jest merges the preset's transform.
- Add these `moduleNameMapper` entries: `"^@bsv/wallet-toolbox-client$": "<rootDir>/node_modules/@bsv/wallet-toolbox-mobile/out/index.mobile.cjs"`, and keep the existing `-mobile` entry (verify the path exists in 2.15.0).
- Extend the `transformIgnorePatterns` allowlist with `@bsv/color-permission-module|@bsv/templates|@bsv/mandala`.

In `metro.config.js`:
- Set `config.resolver.unstable_enablePackageExports = true`.
- Add `'mjs'` and `'cjs'` to `sourceExts` if missing.
- In `resolveRequest`, map `@bsv/wallet-toolbox-client` (exact name) to `@bsv/wallet-toolbox-mobile` before delegating.

- [ ] **Step 4: Run the tests and confirm they pass, then smoke-bundle**

Run: `npx jest __tests__/colorEsmResolution.test.ts __tests__/metroConfig1color.test.ts packages/expo-wallet-toolbox/__tests__/packageResolution.test.ts`
Expected: PASS.

Run: `npx expo export --platform ios --output-dir "$TMPDIR/1color-export" 2>&1 | tail -n 5`
Expected: `Exported: …` with exit 0. If the export fails only for environment reasons (no Xcode, network), record the exact error in the task report. A resolution error naming a `@bsv/*` package is a failure of this task.

- [ ] **Step 5: Commit**

```bash
git add metro.config.js package.json __tests__/colorEsmResolution.test.ts __tests__/metroConfig1color.test.ts
git commit -m "build: resolve ESM-only 1color packages under Metro and jest-expo"
```

---

### Task 5: Key-value adapters for the lib and the module store

**Files:**
- Create: `core/mandala/kvStore.ts`, `__tests__/mandala/kvStore.test.ts`, `__tests__/__helpers__/nodeSqlite.ts`

**Interfaces:**
- Consumes: `StorageExpoSQLite.getKeyValue/setKeyValue/sqliteDb`.
- Produces:
```ts
export interface WalletKv {               // = today's MandalaKvStorage (moved here; createRuntime re-exports nothing)
  getKeyValue(key: string): Promise<string | undefined>
  setKeyValue(key: string, value: string): Promise<void>
  readonly sqliteDb?: { runAsync(sql: string, params: (string|number|null)[]): Promise<{ changes: number }>; getAllAsync(sql: string, params: (string|number|null)[]): Promise<unknown[]> }
}
export function createMandalaKvStorage(kv: WalletKv): MandalaStorage      // behaviour unchanged from createRuntime.ts:203
export function createColorModuleStore(kv: WalletKv): ColorModuleStore    // IC §2.1
export function openTestDb(): { raw: DatabaseSync; db: ExpoLikeDb; kv: WalletKv }   // __helpers__/nodeSqlite.ts, tests only
```
`ExpoLikeDb` adapts node:sqlite to the expo-sqlite async surface the code uses: `execAsync`, `runAsync`, `getAllAsync`, `getFirstAsync`, and `withTransactionAsync` (as `BEGIN`/`COMMIT`, with `ROLLBACK` on throw). `kv` is a `WalletKv` over that db's `key_value_store`.

- [ ] **Step 1: Write the failing test**

`openTestDb()` builds `createTables` on `new DatabaseSync(':memory:')` through the `adapt()` shape in today's `__tests__/mandala/settlementStore.test.ts:16`. Move that helper here.
```ts
it('round-trips module keys and lists by literal prefix', async () => {
  const s = createColorModuleStore(openTestDb().kv)
  await s.set('color.v1.a_b', '1'); await s.set('color.v1.aXb', '2'); await s.set('other', '3')
  expect(await s.get('color.v1.a_b')).toBe('1'); expect(await s.get('missing')).toBeUndefined()
  expect((await s.keys('color.v1.a_')).sort()).toEqual(['color.v1.a_b'])   // '_' is not a wildcard
  await s.delete('color.v1.a_b'); expect(await s.get('color.v1.a_b')).toBeUndefined()
})
it('fails loudly when the database is closed', async () => {
  const s = createColorModuleStore({ getKeyValue: async () => undefined, setKeyValue: async () => {} })
  await expect(s.keys('color.v1.')).rejects.toThrow(/not open/)
  await expect(s.delete('k')).rejects.toThrow(/not open/)
})
it('keeps createMandalaKvStorage semantics (null for absent)', async () => {
  expect(await createMandalaKvStorage(openTestDb().kv).getItem('nope')).toBeNull()
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/kvStore.test.ts`
Expected: FAIL with `Cannot find module '../../core/mandala/kvStore'`.

- [ ] **Step 3: Implement `core/mandala/kvStore.ts`**

Move `escapeLike` and `createMandalaKvStorage` from `createRuntime.ts:176-224` into this file. `createColorModuleStore` uses `getKeyValue`/`setKeyValue` for get/set, and SQL `DELETE` / `SELECT key … LIKE ? ESCAPE '\\'` for delete/keys. Both go through `db()`, which throws `Error('Color module store: the wallet database is not open')`.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/kvStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/mandala/kvStore.ts packages/expo-wallet-toolbox/__tests__/mandala/kvStore.test.ts packages/expo-wallet-toolbox/__tests__/__helpers__/nodeSqlite.ts
git commit -m "feat(toolbox): key-value adapters for the Mandala lib and the color module store"
```

---

### Task 6: Guarded migration and the `color_transfers` journal

**Files:**
- Modify: `core/storage/schema/createTables.ts` (remove `createMandalaSettlementTables`, `ensureTokenSettlementColumns`, the `TOKEN_SETTLEMENT_COLUMNS` backfill; add the migration and the new table)
- Create: `core/mandala/transferJournal.ts`, `__tests__/mandala/transferJournal.test.ts`, `__tests__/storage/colorMigration.test.ts`
- Modify: `core/mandala/types.ts` (replace with the journal types below)

**Interfaces:**
- Consumes: `openTestDb()` (Task 5).
- Produces:
```ts
// core/mandala/types.ts
export type ColorTransferRole = 'sent' | 'received'
export type ColorTransferRail = 'handle' | 'nearby' | 'external'
/** sent: built → (parked ⇄) handed_over → settled | refused; built|parked → cancelled. received: held → settled | refused. */
export type ColorTransferState = 'built' | 'parked' | 'handed_over' | 'held' | 'settled' | 'refused' | 'cancelled'
export const TERMINAL_TRANSFER_STATES: readonly ColorTransferState[]   // ['settled','refused','cancelled']
export const STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000
export interface ColorTransferRow {
  txid: string; role: ColorTransferRole; assetId: string; units: bigint; outputIndex: number
  counterpartyKey?: string; reference?: string; rail: ColorTransferRail; state: ColorTransferState
  delivered: boolean; code?: string; note?: string
  derivationPrefix?: string; derivationSuffix?: string; senderIdentityKey?: string   // sent rows: receipt custody for resend (A′ when blinded)
  createdAt: string; updatedAt: string
}
export const MANDALA_ACTION_LABEL = 'mandala'   // plain (non-P) label; kept for home-screen row recognition
// core/mandala/transferJournal.ts
export interface JournalDb { runAsync(sql: string, p: (string|number|null)[]): Promise<{ changes: number }>; getAllAsync(sql: string, p: (string|number|null)[]): Promise<unknown[]> }
export interface TransferJournal {
  get(txid: string): Promise<ColorTransferRow | undefined>
  getByReference(reference: string): Promise<ColorTransferRow | undefined>
  list(filter?: { states?: ColorTransferState[]; role?: ColorTransferRole; limit?: number }): Promise<ColorTransferRow[]>  // newest createdAt first
  insert(row: Omit<ColorTransferRow, 'createdAt' | 'updatedAt'>): Promise<boolean>     // INSERT OR IGNORE; false = already existed
  advance(txid: string, from: readonly ColorTransferState[], to: ColorTransferState, patch?: { code?: string; delivered?: boolean }): Promise<boolean>  // single-statement CAS
  setDelivered(txid: string, delivered: boolean): Promise<void>
  statesOf(txids: readonly string[]): Promise<Map<string, ColorTransferState>>        // read faults propagate
}
export function createTransferJournal(db: JournalDb, now?: () => Date): TransferJournal
export async function migrateMandalaToColor(db: Pick<SQLiteDatabase, 'execAsync' | 'getAllAsync' | 'runAsync' | 'withTransactionAsync'>): Promise<'migrated' | 'already'>
```
Table: `color_transfers(txid TEXT PRIMARY KEY, role TEXT NOT NULL, assetId TEXT NOT NULL, units TEXT NOT NULL, outputIndex INTEGER NOT NULL, counterpartyKey TEXT, reference TEXT, rail TEXT NOT NULL, state TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, code TEXT, note TEXT, derivationPrefix TEXT, derivationSuffix TEXT, senderIdentityKey TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`, with indexes on `state`, `reference` and `createdAt`.

- [ ] **Step 1: Write the failing tests**

`transferJournal.test.ts`:
```ts
it('stores and reads units 18446744073709551615 exactly', async () => {
  const j = createTransferJournal(openTestDb().db as JournalDb)
  await j.insert(row({ units: 18446744073709551615n }))
  expect((await j.get(TXID))!.units).toBe(18446744073709551615n)
})
it('insert is idempotent and advance is a CAS', async () => {
  expect(await j.insert(row({ state: 'built' }))).toBe(true)
  expect(await j.insert(row({ state: 'settled' }))).toBe(false)
  expect(await j.advance(TXID, ['parked'], 'handed_over')).toBe(false)
  expect(await j.advance(TXID, ['built'], 'handed_over')).toBe(true)
  expect((await j.get(TXID))!.state).toBe('handed_over')
})
it('finds by reference and reports states for a batch', async () => { /* getByReference('ref1'); statesOf([TXID,'ff'.repeat(32)]) → Map{TXID:'built'} */ })
it('rejects a non-canonical units string read back from disk', async () => {
  raw.prepare("UPDATE color_transfers SET units='01'").run()
  await expect(j.get(TXID)).rejects.toThrow(/units/)
})
```
`colorMigration.test.ts`:
```ts
it('drops the four Mandala tables and old lib journals once, guarded by a marker', async () => {
  // seed: CREATE TABLE token_settlements(txid TEXT); … token_admissions, token_admission_edges, token_linkage_payloads;
  // key_value_store rows 'mandala.txJournal.x', 'mandala.notifyJournal.y', 'mandala.blindingJournal.z', 'keep.me'
  expect(await migrateMandalaToColor(db)).toBe('migrated')
  expect(tableNames(raw)).not.toEqual(expect.arrayContaining(['token_settlements']))
  expect(tableNames(raw)).toEqual(expect.arrayContaining(['color_transfers']))
  expect(kvKeys(raw)).toEqual(expect.arrayContaining(['keep.me', 'bsvwallet.migration.color.v1']))
  expect(kvKeys(raw).filter(k => k.startsWith('mandala.'))).toEqual([])
  raw.prepare("INSERT INTO key_value_store VALUES ('mandala.txJournal.new','{}','t')").run()
  expect(await migrateMandalaToColor(db)).toBe('already')                 // never wipes the new lib's journals
  expect(kvKeys(raw)).toContain('mandala.txJournal.new')
})
it('createTables on a fresh database runs the migration', async () => { /* openTestDb(); color_transfers exists; marker set */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/transferJournal.test.ts packages/expo-wallet-toolbox/__tests__/storage/colorMigration.test.ts`
Expected: FAIL. The modules are missing.

- [ ] **Step 3: Implement**

`migrateMandalaToColor` runs inside `withTransactionAsync`:
1. If the marker `bsvwallet.migration.color.v1` exists, return `'already'`.
2. Otherwise run `DROP TABLE IF EXISTS` for the four tables (their indexes drop with them).
3. Run `DELETE FROM key_value_store WHERE key LIKE 'mandala.%'`.
4. Create `color_transfers` and its indexes with `CREATE … IF NOT EXISTS`.
5. Write the marker.

After the guarded block, `createTables` calls it and then always runs `CREATE TABLE IF NOT EXISTS color_transfers`, so a re-run is harmless. `createTables` runs before the runtime or lib exist on every boot, so no 0.5.0 journal can be written before the one-time wipe.

Units are written with `units.toString()` and read with `BigInt` after a canonical-regex check. Delete `__tests__/mandala/settlementStore.test.ts` and `core/mandala/settlementStore.ts` in this task. Remove their exports from `core/index.ts`, and export `createTransferJournal`, the journal types and `migrateMandalaToColor` instead.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/transferJournal.test.ts packages/expo-wallet-toolbox/__tests__/storage/colorMigration.test.ts packages/expo-wallet-toolbox/__tests__/storage/walletBalanceSql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox/core/storage/schema packages/expo-wallet-toolbox/core/mandala packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/__tests__
git commit -m "feat(toolbox)!: replace Mandala settlement tables with a guarded migration and color_transfers journal"
```
Expected tsc red after this task: `core/mandala/{createRuntime,drain,abortGuard,runtime}.ts`, `core/storage/StorageExpoSQLite.ts`, `core/storage/methods/processOfflineActions.ts`, `core/offline/{payerHold,cancelParked}.ts` (Tasks 7, 8, 11–15).

---

### Task 7: Broadcast hold re-keyed to 1Color txs and the journal

**Files:**
- Create: `core/mandala/colorGuard.ts`, `__tests__/mandala/colorGuard.test.ts`
- Modify: `core/storage/StorageExpoSQLite.ts:2125-2360` (`holdTokenReqsForDrain`, `tokenSettlementTxids`, `processAction`, `heldTokenTxidsIn`, `attemptToPostReqsToNetwork`); delete `repairSettledTokenTransaction` (`:1958`) and `TokenTransactionRepair`
- Modify: `core/storage/methods/processOfflineActions.ts` (drop `OfflineTokenDeps`, `postTokenStep`, `reconcileSettlements`, `readSettlement`; one color branch)
- Test: rewrite `__tests__/storage/tokenPostGuard.test.ts` and `__tests__/storage/processOfflineActionsToken.test.ts`; delete `__tests__/storage/repairSettledToken.test.ts`

**Interfaces:**
- Consumes: `createTransferJournal` (Task 6), lib `decodeToken`.
- Produces:
```ts
export function txHasColorOutput(rawTx: readonly number[] | Uint8Array): boolean   // any output decodeToken(...) !== null; unparseable ⇒ true (fail closed)
export async function colorHeldTxids(reqs: ReadonlyArray<{ txid: string; rawTx?: readonly number[] }>, journal: Pick<TransferJournal, 'statesOf'>): Promise<Set<string>>
// held ⇔ txHasColorOutput(rawTx) && state !== 'settled' (a missing row counts as not settled); a req with no rawTx ⇒ held; journal faults propagate
// StorageExpoSQLite (public):
colorHeldTxids(reqs: ReadonlyArray<{ txid: string; rawTx?: readonly number[] }>): Promise<Set<string>>   // uses createTransferJournal(this.db)
// processOfflineActions(args: { storage; refetchBeef? })   — the `token` arg is removed
```

- [ ] **Step 1: Write the failing tests**

`colorGuard.test.ts` builds the token fixture with `new OneColor().lock(assetId, 1500n, pkh)` (from `@bsv/templates`) and a plain P2PKH tx:
```ts
it('holds a 1Color receipt with no journal row even when online', async () => {
  expect(await colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }], journalWith({}))).toEqual(new Set([T]))
})
it('releases only a settled 1Color tx', async () => {
  const j = journalWith({ [T]: 'settled', [U]: 'held' })
  expect(await colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }, { txid: U, rawTx: tokenTx2.toBinary() }], j)).toEqual(new Set([U]))
})
it('never holds a plain BSV tx and holds an unparseable one', async () => {
  expect(await colorHeldTxids([{ txid: P, rawTx: p2pkhTx.toBinary() }], journalWith({}))).toEqual(new Set())
  expect(txHasColorOutput([1, 2, 3])).toBe(true)
})
it('propagates a journal read fault', async () => {
  await expect(colorHeldTxids([{ txid: T, rawTx: tokenTx.toBinary() }], { statesOf: async () => { throw new Error('locked') } })).rejects.toThrow('locked')
})
```
In `tokenPostGuard.test.ts`, keep the existing scenarios (online hold, offline hold, whole-batch hold on a read fault per XR-045, sendWithResults omission), with the setup changed from inserting `token_settlements` rows to "a req whose rawTx carries a 1Color output and an absent or non-settled journal row". Add `it('posts a 1Color req once its journal row is settled')`.

In `processOfflineActionsToken.test.ts`, a held queue row whose tx is 1Color and unsettled yields outcome `serviceError` and stays `held`. After `journal.advance(T, ['held'], 'settled')` the next pass posts it and marks it `sent`. A journal read fault stalls the step (`serviceError`) and never posts.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/colorGuard.test.ts packages/expo-wallet-toolbox/__tests__/storage/tokenPostGuard.test.ts packages/expo-wallet-toolbox/__tests__/storage/processOfflineActionsToken.test.ts`
Expected: FAIL. `colorGuard` is missing, and the guard still reads `token_settlements`.

- [ ] **Step 3: Implement**

Replace `tokenSettlementTxids(txids)` with `colorHeldTxids(reqs)`, passing `{txid, rawTx}` from each `EntityProvenTxReq` (`req.rawTx`). Every caller keeps its fail-closed catch exactly as today. `heldTokenTxidsIn` becomes `colorHeldTxids` ∩ req status `'nosend'`. In `processOfflineActions`, the token branch reads `await storage.colorHeldTxids([{ txid: step.txid, rawTx }])`: held gives `serviceError`, not held gives the ordinary `broadcast()`, and a throw gives `serviceError`. Delete `repairSettledTokenTransaction`, because there is no `token_settlements` fingerprint any more.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox/core/mandala/colorGuard.ts packages/expo-wallet-toolbox/core/storage packages/expo-wallet-toolbox/__tests__/mandala/colorGuard.test.ts packages/expo-wallet-toolbox/__tests__/storage
git commit -m "fix(toolbox): hold every unsettled 1Color tx from broadcast, keyed on color_transfers"
```

---

### Task 8: Abort guard re-keyed to the journal

**Files:**
- Rewrite: `core/mandala/abortGuard.ts`
- Test: rewrite `__tests__/mandala/abortGuard.test.ts`; update `__tests__/context/permissionsManagerAdminAbort.test.ts` if it builds the guard

**Interfaces:**
- Consumes: `TransferJournal.getByReference` (Task 6).
- Produces:
```ts
export const ABORT_BLOCKED_TRANSFER_STATES: readonly ColorTransferState[] = ['handed_over', 'settled']
export function abortIsBlockedBy(row: ColorTransferRow | undefined): boolean
export type TransferJournalLookup = () => Pick<TransferJournal, 'getByReference'> | undefined
export function wrapAbortActionForSettlements<T extends AbortableManager>(manager: T, journal: TransferJournalLookup, tokenSettlementPossible: () => boolean): T
```
`AbortableManager` is unchanged. A refusal returns `{ aborted: false }` and never throws.

- [ ] **Step 1: Write the failing test**

```ts
it.each(['built', 'parked', 'refused', 'cancelled'] as const)('lets %s abort', async state => {
  expect(await wrap(rowWith({ state })).abortAction({ reference: 'r1' })).toEqual({ aborted: true })
})
it('refuses abort for a handed_over row whatever delivered says', async () => {
  for (const delivered of [true, false]) expect(await wrap(rowWith({ state: 'handed_over', delivered })).abortAction({ reference: 'r1' })).toEqual({ aborted: false })
})
it('refuses abort for a settled row', async () => { /* … */ })
it('fails closed when the journal is unavailable on a Mandala chain, open when Mandala is impossible', async () => {
  expect(await wrapAbortActionForSettlements(inner, () => undefined, () => true).abortAction({ reference: 'r' })).toEqual({ aborted: false })
  expect(await wrapAbortActionForSettlements(inner, () => undefined, () => false).abortAction({ reference: 'r' })).toEqual({ aborted: true })
})
it('fails closed on a journal read fault', async () => { /* getByReference rejects → { aborted:false }, inner not called */ })
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/abortGuard.test.ts`
Expected: FAIL. The types and imports from `./types` have changed.

- [ ] **Step 3: Implement** by keeping the Proxy structure and the comment history (the 2026-09-15 incident), and replacing the store lookup with `journal()?.getByReference(reference)`. `hasUnresolvedLegacyBlockedRows` is gone, because no legacy rows exist after Task 6.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/abortGuard.test.ts packages/expo-wallet-toolbox/__tests__/context/permissionsManagerAdminAbort.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/mandala/abortGuard.ts packages/expo-wallet-toolbox/__tests__/mandala/abortGuard.test.ts packages/expo-wallet-toolbox/__tests__/context/permissionsManagerAdminAbort.test.ts
git commit -m "fix(toolbox): refuse aborting a handed-over token action, keyed on color_transfers"
```

---

### Task 9: Consent policy and color prompt copy

**Files:**
- Create: `core/mandala/accessPolicy.ts`, `__tests__/mandala/accessPolicy.test.ts`, `ui/components/ui/colorPrompt.ts`, `__tests__/ui/colorPrompt.test.ts`
- Modify: `ui/components/ui/PermissionSheet.tsx` (the Mandala queue item renders `describeColorRequest`), `__tests__/ui/PermissionSheet.test.tsx`, `core/i18n/translations.tsx`

**Interfaces:**
- Consumes: `ColorTokenAccessHandler` (module type), lib `formatAmount`.
- Produces:
```ts
export type ColorPromptType = 'color_send' | 'color_signature' | 'color_access' | 'color_relinquish' | 'color_receive_offline'
export interface ColorAccessPolicyOptions { adminOriginator: string; prompt: (originator: string, message: string) => Promise<boolean>; now?: () => number; readGrantMs?: number /* default 1_800_000 */ }
export function createColorAccessPolicy(o: ColorAccessPolicyOptions): ColorTokenAccessHandler & { clearGrants(): void }
export interface ColorPromptView { type: ColorPromptType; title: string; lines: Array<{ label: string; value: string }>; warning?: string }
export function describeColorRequest(message: string, assetInfo: (assetId: string) => { ticker: string; decimals: number } | undefined, t: (key: string, o?: object) => string): ColorPromptView | null   // null = unparseable ⇒ the sheet shows a generic deny-only prompt
```

- [ ] **Step 1: Write the failing tests**

`accessPolicy.test.ts`:
```ts
it('approves every type for the admin originator without prompting', async () => {
  for (const type of TYPES) expect(await policy(msg({ type }), ADMIN)).toBe(true)
  expect(prompt).not.toHaveBeenCalled()
})
it('grants a color_access read for 30 minutes per originator only', async () => {
  prompt.mockResolvedValueOnce(true)
  expect(await policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))).toBe(true)
  expect(await policy('app.example', msg({ type: 'color_access', basket: 'p color assets' }))).toBe(true)
  expect(prompt).toHaveBeenCalledTimes(1)
  clock += 1_800_001
  prompt.mockResolvedValueOnce(false)
  expect(await policy('app.example', msg({ type: 'color_access' }))).toBe(false)
})
it('never lets a send approval grant reads or a read grant cover a send', async () => { /* approve color_send → next color_access prompts; read grant → color_send prompts */ })
it('returns false without prompting when seekPermission is false and no grant exists', async () => {
  expect(await policy('app.example', msg({ type: 'color_access', seekPermission: false }))).toBe(false)
  expect(prompt).not.toHaveBeenCalled()
})
it('refuses malformed JSON and unknown types', async () => {
  expect(await policy('app.example', '{')).toBe(false); expect(await policy('app.example', msg({ type: 'color_mint' }))).toBe(false)
})
```
The handler signature is `(app, message)`, so call it as `policy(originator, message)`.

`colorPrompt.test.ts` uses a recorded `color_send` message in which the asset leg amount is `"18446744073709551615"` and `dec` is 2, and asserts that a line value equals `'184467440737095516.15 USDX'`. A `color_receive_offline` message (IC §2.5 shape) with `outputs:[{outputIndex:0, amount:'1500'}]` and `unsettledTransactions:2` produces a warning containing the i18n key `color_prompt_offline_warning`. Copy the field names for `color_send`/`color_signature` from the vendored module's `transactionConsent` (`dist/index.mjs`). Do not invent new ones.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/accessPolicy.test.ts packages/expo-wallet-toolbox/__tests__/ui/colorPrompt.test.ts`
Expected: FAIL. The modules are missing.

- [ ] **Step 3: Implement** both files. Add the i18n keys `color_prompt_send_title`, `color_prompt_signature_title`, `color_prompt_access_title`, `color_prompt_relinquish_title`, `color_prompt_receive_offline_title` and `color_prompt_offline_warning` to every locale block in `core/i18n/translations.tsx` (English copy, with other locales copied in English). In `PermissionSheet.tsx`, the Mandala queue item renders `describeColorRequest(head.message, …)` in place of today's MandalaTokenModule promptData renderer.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/accessPolicy.test.ts packages/expo-wallet-toolbox/__tests__/ui/colorPrompt.test.ts packages/expo-wallet-toolbox/__tests__/ui/PermissionSheet.test.tsx packages/expo-wallet-toolbox/__tests__/i18n`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox/core/mandala/accessPolicy.ts packages/expo-wallet-toolbox/ui packages/expo-wallet-toolbox/__tests__ packages/expo-wallet-toolbox/core/i18n/translations.tsx
git commit -m "feat(toolbox): color module consent policy and prompt copy with exact amounts"
```

---

### Task 10: Register the color module; delete the `'p mandala'` P-module

**Files:**
- Create: `core/mandala/colorModule.ts`, `__tests__/mandala/colorModule.test.ts`, `__tests__/context/colorRegistration.test.ts`, `__tests__/mandala/colorSigningGate.test.ts` (audit S2/S3 regression pins, W11)
- Modify: `core/context/WalletContext.tsx:144-180, 1931-2200` (imports, migration call, `configureMandala`, module build, `permissionModules`, wrapper stack, teardown)
- Delete: `core/mandala/permissionModule.ts`, `core/mandala/basketMigration.ts`, `__tests__/mandala/permissionModule.test.ts`, `__tests__/mandala/basketMigration.test.ts`, `__tests__/context/mandalaPermissionRouting.test.ts`
- Modify: `core/services/vault/guard.ts:123-125` (comment now names `p color`)

**Interfaces:**
- Consumes: `createColorModuleStore` (Task 5), `createColorAccessPolicy` (Task 9), lib `createMandalaProfile`, `createMandalaOverlayProvider`, module `createColorModule`, `createAttestedProfile`.
- Produces:
```ts
export interface BuildColorModuleArgs { wallet: WalletInterface /* UNDERLYING wallet, never the manager */; endpoints: MandalaEndpointConfig; kv: WalletKv; requestTokenAccess: ColorTokenAccessHandler; fetch?: typeof fetch }
export interface BuiltColorModule { module: ColorPermissionModule; provider: ColorOverlayProvider & { readonly url: string; readonly identityKey: string }; store: ColorModuleStore }
export function buildColorModule(a: BuildColorModuleArgs): BuiltColorModule
// profiles = { [ATTESTED_PROFILE_ID]: createAttestedProfile(), [MANDALA_PROFILE_ID]: createMandalaProfile({ overlays: [{ identityKey: endpoints.overlayIdentityKey, url: endpoints.overlayUrl }], fetch }) }
// provider (W3) = createMandalaOverlayProvider({ url: endpoints.overlayUrl, identityKey: endpoints.overlayIdentityKey, fetch }) and is passed as the module's default provider
```
In WalletContext, only when `mandalaEndpoints` is set: `permissionModules: { btms: btmsModule, color: built.module }`. With no endpoints there is no `color` key, so `p color` calls fail closed with "Unsupported P-module scheme" (S5). Publish `colorRef.current = built` for the runtime (Task 11) and the tick (Task 17). Call `built.module.dispose()` wherever the wallet tears down (`:3145`, `:4056`).

- [ ] **Step 1: Write the failing tests**

`colorModule.test.ts`:
```ts
it('registers attested + Mandala issuer-v1 and advertises the attested capability', async () => {
  const { module } = buildColorModule({ wallet: fakeUnderlyingWallet(), endpoints: EP, kv: openTestDb().kv, requestTokenAccess: async () => true, fetch: refuseFetch })
  const manager = new WalletPermissionsManager(fakeUnderlyingWallet(), ADMIN, { permissionModules: { color: module } })
  expect((await manager.getVersion({}, ADMIN)).version).toMatch(/brc207-color-attested/)
})
it('routes the provider to the configured overlay and key', () => {
  const b = buildColorModule({ … }); expect(b.provider.url).toBe(EP.overlayUrl); expect(b.provider.identityKey).toBe(EP.overlayIdentityKey)
})
```
If `getVersion` does not carry the capability through the manager in 2.15.0, assert on `module` directly as the vendored README documents. Record which form was used.

`colorRegistration.test.ts` is a structural test over `WalletContext.tsx` source, in the same style as `mandalaDrainTick.test.ts`. It asserts that the code (comments stripped) contains `color: ` inside `permissionModules`, contains no `MandalaTokenModule`, `wrapCreateActionForTokenInputs`, `migrateMandalaBasketName` or `basket: MANDALA_BASKET`, and calls `buildColorModule({` with `wallet,` (the underlying wallet identifier), not `permissionsManager`.

Add `it('carries colorHandoff through the published manager stack')`. It wraps a fake manager whose `signAction` returns `{ txid, colorHandoff: { version: 1, txid, profileData: {} } }` in `guardVaultAccess(wrapAbortActionForSettlements(conformWalletResults(ADMIN, fake), …), ADMIN, { lookup })` and asserts that `colorHandoff` survives `signAction`.

`colorSigningGate.test.ts` (W11) runs through the stack WalletContext publishes, with the color module registered. The underlying wallet is a spy over `new ProtoWallet(new PrivateKey(7))`: `createSignature` and `createAction` are `jest.fn` spies that delegate, so key derivation in `assertOwned` is real. `prompt` is the `jest.fn` given to `createColorAccessPolicy`. `protocolPrompt` is bound with `inner.bindCallback('onProtocolPermissionRequested', protocolPrompt)`.
```ts
const TAG = `${'a'.repeat(64)}v0`, ID = `${'a'.repeat(64)}_0`
function publishedStack() {
  const underlying = spyUnderlying(new ProtoWallet(new PrivateKey(7)))
  const prompt = jest.fn(async () => true)
  const built = buildColorModule({ wallet: underlying, endpoints: EP, kv: openTestDb().kv,
    requestTokenAccess: createColorAccessPolicy({ adminOriginator: ADMIN, prompt }), fetch: refuseFetch })
  const inner = new SigningPolicyPermissionsManager(underlying, ADMIN, { seekProtocolPermissionsForSigning: true, permissionModules: { color: built.module } })
  const protocolPrompt = jest.fn(); inner.bindCallback('onProtocolPermissionRequested', protocolPrompt)
  const pm = guardVaultAccess(wrapAbortActionForSettlements(conformWalletResults(ADMIN, inner), () => undefined, () => true), ADMIN, { lookup })
  return { pm, underlying, prompt, protocolPrompt }
}
it('A.13: a bare digest under a p color key is refused without a prompt', async () => {
  const { pm, underlying, prompt, protocolPrompt } = publishedStack()
  const bare = { protocolID: [2, `p color ${TAG} 41513d3d 41673d3d`] as WalletProtocol, keyID: 'color', counterparty: 'self' as const }
  await expect(pm.createSignature({ ...bare, hashToDirectlySign: Array(32).fill(17) }, 'app.example')).rejects.toThrow(/hashToDirectlySign|envelope/)
  // 0207:2233: a bare serialized preimage as data is also insufficient
  await expect(pm.createSignature({ ...bare, data: Array(32).fill(17) }, 'app.example')).rejects.toThrow()
  // double tap: two concurrent bare digests both refuse, and the per-origin oneAtATime queue is not wedged
  const both = await Promise.allSettled([1, 2].map(() => pm.createSignature({ ...bare, hashToDirectlySign: Array(32).fill(17) }, 'app.example')))
  expect(both.map(r => r.status)).toEqual(['rejected', 'rejected'])
  expect(prompt).not.toHaveBeenCalled(); expect(protocolPrompt).not.toHaveBeenCalled()
  expect(underlying.createSignature).not.toHaveBeenCalled()
})
it('S3: a p color basket output not locked to a wallet key is never kept change', async () => {
  const { pm, underlying, prompt } = publishedStack()
  const foreign = new OneColor().lock(ID, 1500n, hash160(PrivateKey.fromRandom().toPublicKey().encode(true))).toHex()
  const out = { lockingScript: foreign, satoshis: 1, basket: `p color ${TAG}`, outputDescription: 'change' }
  const plan = (ownedOutputs: ColorRemittance[]) => ColorPlan.toLabels({ version: 1, assets: [ID], ownedOutputs, operations: [], inputPositions: [], changePositions: [], sighashTypes: [] })
  // (a) app puts a foreign-locked token output in p color without naming it as owned
  await expect(pm.createAction({ description: 'spoof change', outputs: [out], labels: plan([]) }, 'app.example')).rejects.toThrow(/ownedOutputs/)
  // (b) app names it as owned with a remittance the wallet key does not match
  const self = (await underlying.getPublicKey({ identityKey: true })).publicKey
  await expect(pm.createAction({ description: 'spoof change', outputs: [out],
    labels: plan([{ outputIndex: 0, assetId: ID, derivationPrefix: 'QUFBQUFBQUFBQUFBQUFBQQ==', derivationSuffix: 'QkJCQkJCQkJCQkJCQkJCQg==', senderIdentityKey: self }]) }, 'app.example')).rejects.toThrow(/locked to this wallet/)
  expect(prompt).not.toHaveBeenCalled(); expect(underlying.createAction).not.toHaveBeenCalled()
})
```
Fallback (W11), only if the vendored dist accepts case (a) or (b): capture the message passed to `prompt`, parse it, and assert `type === 'color_send'`, `assets[0].keptAmount === '0'`, `assets[0].outgoingAmount === '1500'`, a `destinations` entry with `outputIndex: 0`, and that `describeColorRequest(message, …).lines` has no `Kept as change` label. Record the form used in the commit body. Errors are matched by message text, because these upstream errors are plain `Error` (IC D22 forbids `instanceof`; a §2.4 `[ClassName]` prefix still matches the unanchored regex).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/colorModule.test.ts packages/expo-wallet-toolbox/__tests__/context/colorRegistration.test.ts packages/expo-wallet-toolbox/__tests__/mandala/colorSigningGate.test.ts`
Expected: FAIL. `colorModule` is missing, and the source still names `MandalaTokenModule`. `colorSigningGate.test.ts` fails at import of `buildColorModule`.

- [ ] **Step 3: Implement** `colorModule.ts`, then rewire WalletContext:
- Delete the basket migration call, `listMandalaTokenOutpoints`, `resolveMandalaOutputForRelinquish`, the `MandalaTokenModule` construction and `wrapCreateActionForTokenInputs`.
- Change `configureMandala({ overlayUrl, overlayIdentityKey, messageBoxUrl, storage: createMandalaKvStorage(phoneStorage) })` so it no longer passes `basket`.
- Set `requestTokenAccess: createColorAccessPolicy({ adminOriginator, prompt: mandalaPromptHandler })`.
- Point the abort wrapper at `() => mandalaRef.current?.journal`.

Delete the listed files and remove their exports from `core/index.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/colorModule.test.ts packages/expo-wallet-toolbox/__tests__/context/colorRegistration.test.ts packages/expo-wallet-toolbox/__tests__/mandala/colorSigningGate.test.ts packages/expo-wallet-toolbox/__tests__/vault`
Expected: PASS, including both `colorSigningGate` tests with no prompt and no underlying call.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox
git commit -m "feat(toolbox)!: register @bsv/color-permission-module with attested and Mandala profiles; delete the p mandala module"
```
Expected tsc red: `core/mandala/createRuntime.ts`, `core/localpay/{build,pending,verify}.ts`, `ui/components/pay/NearbyFlow.tsx` (Tasks 11–16).

---

### Task 11: Runtime surface and reads (assets, balances, activity)

**Files:**
- Rewrite: `core/mandala/runtime.ts`, `core/mandala/createRuntime.ts` (new construction, reads only. Settle, send and nearby members are stubs that throw `Error('not yet wired')` until Tasks 12–16, each listed below)
- Create: `core/mandala/assets.ts`, `__tests__/mandala/assets.test.ts`, `__tests__/mandala/createRuntime.test.ts` (replaces the old file)
- Delete: `core/mandala/{drain,bundle,inboxPrehold,token,resendTransfer}.ts` and tests `__tests__/mandala/{drain,inboxPrehold,receiveFromInboxPrehold,resendTransfer,fixI}.test.ts`, `__tests__/localpay/bundle.test.ts`
- Modify: `__tests__/__mocks__/fakeMandalaRuntime.ts`, `core/demo/{demoMandalaRuntime,demoAssets,demoLedger}.ts` to the new types

**Interfaces:**
- Consumes: `TransferJournal` (Task 6), `BuiltColorModule` (Task 10), lib `decodeToken`, `readDeploy`, `assetTag`, `colorBasket`, `COLOR_OFFLINE_TAG` (module).
- Produces (`runtime.ts`):
```ts
export interface TokenAssetInfo { assetId: string; label: string; ticker: string; decimals: number; issuerName?: string; resolved: boolean }
export interface TokenBalance { asset: TokenAssetInfo; units: bigint /* available */; offlineUnits: bigint /* ⊆ units, color_offline */ }
export type TokenActivityStatus = 'settling' | 'settled' | 'refused' | 'stuck'
export interface TokenActivityRow { txid: string; role: ColorTransferRole; asset: TokenAssetInfo; units: bigint; counterpartyKey?: string; status: TokenActivityStatus; at: string; refusedCode?: string; rail: ColorTransferRail }
export interface TokenAssetStatus { paused: boolean; frozenUnits: bigint; accessMode?: string; selfAdmitted: boolean | undefined; recipientAdmitted(identityKey: string): Promise<boolean | undefined>; metadataResolved: boolean; messageBoxUrl: string }
export type TokenSendResult = { kind: 'sent'; txid: string; settled: boolean; notified: boolean } | { kind: 'refused'; code: string; message: string } | { kind: 'unavailable'; message: string }
export type TokenSettleState = ColorTransferState | 'unavailable'
export interface TokenHoldingsReview { settled: number; refused: number; pending: number; unreachable: boolean }
export interface NearbyTokenDeps {
  handover(a: { assetId: string; units: bigint; recipientKey: string; derivationPrefix: string; derivationSuffix: string; note?: string }): Promise<HandoverResult>   // Task 15
  onHandedOver(txid: string, state: 'parked' | 'handed_over'): Promise<void>                                                                                          // Task 15
  onReceived(a: { txid: string; assetId: string; units: bigint; counterpartyKey: string; outputIndex: number; declarationTx?: string }, outcome: { ok: true } | { ok: false; code: string; final: boolean }): Promise<void>  // Task 16
}
export interface MandalaRuntime {
  available: boolean; endpoints: MandalaEndpointConfig; journal: TransferJournal
  listAssets(): Promise<TokenAssetInfo[]>; balances(): Promise<TokenBalance[]>; activity(limit?: number): Promise<TokenActivityRow[]>; stuck(): Promise<ColorTransferRow[]>
  assetStatus(assetId: string): Promise<TokenAssetStatus>; refreshAssetStatus(assetId: string): Promise<TokenAssetStatus>
  rememberDeploy(declarationTxHex: string): Promise<void>
  recipientRefusal(recipient: string): string | null; subscribe(listener: () => void): () => void
  settleNow(txid: string): Promise<TokenSettleState>; settleAll(): Promise<number>; reviewTokenHoldings(): Promise<TokenHoldingsReview>
  isHandoverAdmitted(txid: string): Promise<boolean | undefined>; reconcileHeld(txids: readonly string[]): Promise<void>                                              // Task 12
  sendToHandle(a: { assetId: string; recipientIdentityKey: string; units: bigint; note?: string }): Promise<TokenSendResult>
  receiveFromInbox(): Promise<{ credited: number; failed: number; incomplete?: true }>
  resendTransfer(txid: string): Promise<'resent' | 'not-found' | 'unavailable'>                                                                                    // Task 13
  tick(): Promise<void>                                                                                                                                              // Task 17
  nearby: NearbyTokenDeps
}
export interface CreateMandalaRuntimeArgs {
  wallet: WalletInterface /* published manager */; adminOriginator: string; storage: StorageExpoSQLite; chain: AppChain; endpoints: MandalaEndpointConfig | undefined
  color: Pick<ColorPermissionModule, 'settle' | 'handoffEvidence'> | undefined; provider: ColorOverlayProvider | undefined
  messageBox?: () => Promise<MandalaMessageBox>; refetchBeef?: (txid: string) => Promise<number[] | undefined>; isOnline?: () => Promise<boolean>; now?: () => Date
}
export type MandalaMessageBox = MessageBoxSender & MessageBoxLike
// assets.ts
export interface InventoryRecord { outpoint: string; assetId: string; role: 'value' | 'authority'; units: bigint; tags: string[] }
export async function readInventory(wallet: WalletInterface, originator: string): Promise<InventoryRecord[]>   // 'p color assets', include 'locking scripts', includeTags, pages of 1000 to completion (max 1000 pages ⇒ throw)
export async function readAvailable(wallet: WalletInterface, originator: string, assetId: string): Promise<bigint>   // 'p color balance <assetTag>' totalOutputs, canonical-decimal checked
export function offlineUnitsOf(records: readonly InventoryRecord[], assetId: string): bigint
export function createAssetMetadata(kv: WalletKv, provider: ColorOverlayProvider | undefined, overlayIdentityKey: string): { info(assetId: string): Promise<TokenAssetInfo>; remember(declarationTxHex: string): Promise<void> }
```
`available === endpoints !== undefined && color !== undefined && provider !== undefined && storage.sqliteDb !== undefined`. The runtime binds `wallet` to `adminOriginator` with the existing `bindOriginator`, which stays exported from `createRuntime.ts` (ProfileScreen uses it).

- [ ] **Step 1: Write the failing tests**

`assets.test.ts` uses a fake wallet whose `listOutputs` answers per basket:
```ts
it('offline units come only from color_offline-tagged available records', () => {
  const recs = [rec({ units: 100n, tags: ['color_state_available'] }), rec({ units: 40n, tags: ['color_state_available', 'color_offline'] }),
                rec({ units: 7n, tags: ['color_state_reserved', 'color_offline'] }), rec({ units: 9n, tags: ['color_state_available', 'color_offline'], assetId: OTHER })]
  expect(offlineUnitsOf(recs, ASSET)).toBe(40n)
})
it('reads the exact balance view as bigint', async () => {
  expect(await readAvailable(walletAnswering({ 'p color balance ' + assetTag(ASSET): { totalOutputs: '18446744073709551616', outputs: [] } }), ADMIN, ASSET)).toBe(18446744073709551616n)
})
it('rejects a non-canonical balance string', async () => { /* totalOutputs: 1000 (number) or '01' → throws */ })
it('pages the inventory to completion and decodes each record', async () => { /* 2 pages, 1000 + 3 records → 1003; totalOutputs drives paging */ })
it('caches deploy metadata from a declarationTx and reads it offline', async () => {
  const meta = createAssetMetadata(kv, refusingProvider, K)
  await meta.remember(F_REQ_DEPLOY_TX_HEX)   // a tx whose output 0 is the IC §4 F-REQ deploy script
  expect(await meta.info(F_REQ_ASSET)).toMatchObject({ ticker: 'TUSD', label: 'Test Dollar', decimals: 2, resolved: true })
})
it('falls back to an unresolved short id when no metadata is reachable', async () => { /* resolved:false, decimals 0, label = shortAssetId */ })
```
Build `F_REQ_DEPLOY_TX_HEX` in the test from the IC §4 deploy locking script (`00006d4d6d01` + 365-byte payload + `7576a914a1d8edf2f9ebd6d2fe4728e0eb3bd369ab78d76a88ac`) as output 0 of a 1-input tx.

`createRuntime.test.ts` (reads):
```ts
it('balances = available view with offline portion, one row per held asset', async () => {
  const rt = runtimeWith({ available: { [ASSET]: '1500' }, inventory: [rec({ units: 1000n, tags: ['color_state_available'] }), rec({ units: 500n, tags: ['color_state_available', 'color_offline'] })] })
  expect(await rt.balances()).toEqual([{ asset: expect.objectContaining({ assetId: ASSET }), units: 1500n, offlineUnits: 500n }])
})
it('is unavailable without endpoints, module or provider', () => { expect(runtimeWith({ color: undefined }).available).toBe(false) })
it('activity maps journal rows to statuses and hides cancelled sends', async () => { /* built/handed_over/held → settling; settled; refused(code); >STUCK_AFTER_MS non-terminal → stuck; cancelled omitted */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/assets.test.ts packages/expo-wallet-toolbox/__tests__/mandala/createRuntime.test.ts`
Expected: FAIL. `assets.ts` is missing and the runtime has the old shape.

- [ ] **Step 3: Implement**

The runtime keeps `subscribe/emit`, the lazy `identityKey()` and the lazy `messageBox()` patterns from today's `createRuntime.ts:508-541`. `assetStatus` keeps today's ~10 s cache and is built on lib `resolveAssetState` (`@bsv/mandala/adminState`) and `fetchRegistry`/`registryIsLive`, with `frozenUnits` as bigint. If 0.5.0 does not export them, return `{ paused:false, frozenUnits:0n, selfAdmitted: undefined, recipientAdmitted: async () => undefined, metadataResolved, messageBoxUrl }` and record that in the report (a contract gap).

`recipientRefusal` keeps today's copy, implemented locally: invalid hex or off-curve returns the existing refusal string. Sending to self is allowed.

Update the fake runtime and the demo runtime to the new interface (bigint units).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/assets.test.ts packages/expo-wallet-toolbox/__tests__/mandala/createRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox
git commit -m "feat(toolbox)!: Mandala runtime reads balances and inventory from p color views"
```
Expected tsc red: the UI files with `baseUnits` (Task 18), `core/pay/rails/handle.ts` (Task 13), localpay/offline (Tasks 14–16), `WalletContext.tsx` tick (Task 17).

---

### Task 12: Runtime settlement (settleNow, settleAll, admission check, held reconcile)

**Files:**
- Create: `core/mandala/settle.ts`, `__tests__/mandala/settle.test.ts`
- Modify: `core/mandala/createRuntime.ts` (wire the Task 12 members)

**Interfaces:**
- Consumes: `color.settle`, `TransferJournal`, `readInventory` (Task 11), the bound manager's `abortAction`, `provider.admission`.
- Produces:
```ts
export interface SettleDeps { color: Pick<ColorPermissionModule, 'settle'>; journal: TransferJournal; abort: (reference: string) => Promise<{ aborted: boolean }>; onChange: () => void }
export async function applySettleReport(report: ColorSettleReport, d: Pick<SettleDeps, 'journal' | 'abort'>): Promise<{ changed: number; settled: string[] }>
export function createSettler(d: SettleDeps): { settleNow(txid: string): Promise<TokenSettleState>; settleAll(): Promise<number> }
```
Mapping (IC §2.3):
- `admitted`: advance `['built','parked','handed_over','held']` → `settled`.
- `refused`: advance the same set → `refused` with `code`. For a `sent` row with a `reference`, call `abort(reference)` after the row reads `refused`, so the abort guard allows it. That releases the reserved inputs.
- `retry`: no change.

`settleNow(txid)` returns `'built'`/`'parked'` untouched (FIX F: a payment the user withheld is not settled by anyone else). Otherwise it calls `color.settle({ txids: [txid] })`. It is coalesced per txid through a `Map<string, Promise>`, and any thrown error resolves to the row's current state. `settleAll()` calls bare `color.settle()` and is single-flight. Both call `onChange` when anything changed.

`isHandoverAdmitted(txid)` takes the row's `assetId`/`outputIndex`, calls `provider.admission(assetId, [`${txid}.${outputIndex}`])`, and reads the answer locally, because the module does not export `readOutputList`. An `output-list` entry whose `txid` and `outputIndex` equal that outpoint means `true`. An empty list means `false`. Any other shape throws, and the caller treats a throw as `undefined`. A `ColorProviderError` with `transport` gives `undefined`. A missing row gives `false`.

`reconcileHeld(txids)`: for each txid with no journal row, read the inventory records of that txid. If there are none, skip. If any record carries `color_offline`, insert a `received` row in state `held`. Otherwise insert it as `settled`. Use `rail: 'external'`, sum the units, and take `outputIndex` from the first record. For each existing `held` row whose records no longer carry `color_offline`, advance it to `settled`.

- [ ] **Step 1: Write the failing tests**

```ts
it('coalesces concurrent settleNow(txid) onto one module call', async () => {
  const settle = jest.fn(async () => { await tick(); return { results: [{ txid: T, assetId: A, status: 'admitted', outputs: [0] }] } })
  const s = createSettler(deps({ settle, row: { state: 'handed_over' } }))
  const [a, b] = await Promise.all([s.settleNow(T), s.settleNow(T)])
  expect(settle).toHaveBeenCalledTimes(1); expect(a).toBe('settled'); expect(b).toBe('settled')
})
it('never settles a built or parked row', async () => { /* returns 'parked'; settle not called */ })
it('refused own hand-over is journaled refused, then aborted', async () => {
  const order: string[] = []
  // journal.advance spy pushes 'journal', abort pushes 'abort'
  await applySettleReport({ results: [{ txid: T, assetId: A, status: 'refused', code: 'ERR_FROZEN' }] }, d)
  expect(order).toEqual(['journal', 'abort']); expect((await d.journal.get(T))!.code).toBe('ERR_FROZEN')
})
it('retry changes nothing; a thrown settle reports the current state', async () => { /* … */ })
it('settleAll is single-flight', async () => { /* two overlapping calls → one color.settle() */ })
it('reconcileHeld journals an unjournaled tagged receipt as held, never settled', async () => {
  await rt.reconcileHeld([T])   // inventory: T.0 tagged color_offline
  expect((await journal.get(T))!.state).toBe('held')
})
it('isHandoverAdmitted is undefined on transport failure and false on an empty answer', async () => { /* … */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/settle.test.ts`
Expected: FAIL. `settle.ts` is missing.

- [ ] **Step 3: Implement** `settle.ts` and wire it in `createRuntime.ts`. `reviewTokenHoldings()` = `settleAll()` followed by counting journal rows into `{settled, refused, pending}`. `unreachable` is true when every result was `retry` with code `ERR_UNAVAILABLE`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/settle.test.ts packages/expo-wallet-toolbox/__tests__/mandala/createRuntime.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/mandala/settle.ts packages/expo-wallet-toolbox/core/mandala/createRuntime.ts packages/expo-wallet-toolbox/__tests__/mandala/settle.test.ts
git commit -m "feat(toolbox): settle token hand-overs and receipts through the color module"
```

---

### Task 13: Handle rail: send, redelivery and inbox receive

**Files:**
- Create: `core/mandala/handle.ts`, `__tests__/mandala/handle.test.ts`
- Modify: `core/mandala/createRuntime.ts`, `core/pay/rails/handle.ts:150-175, 835-895` (token URI amount as a decimal string; the runtime slice uses `units: bigint`), `__tests__/pay/tokenRails.test.ts`, `__tests__/pay/handleInbox.test.ts`

**Interfaces:**
- Consumes: lib `sendHandover`, `deliverHandover`, `receiveHandovers`, `HandoverResult`, `MESSAGEBOX`; module `handoffEvidence`; `createSettler` (Task 12); `TransferJournal`.
- Produces:
```ts
export interface HandleDeps { wallet: WalletInterface /* bound */; identityKey: () => Promise<string>; journal: TransferJournal; color: Pick<ColorPermissionModule, 'handoffEvidence'>; messageBox: () => Promise<MandalaMessageBox>; settleNow: (txid: string) => Promise<TokenSettleState>; isOnline: () => Promise<boolean>; rememberDeploy: (hex: string) => Promise<void>; refetch: (txid: string) => Promise<number[] | undefined> /* AtomicBEEF; WalletContext passes makeResendBeef, as today */; processed: Set<string>; now: () => Date }
export async function sendToHandle(d: HandleDeps, a: { assetId: string; recipientIdentityKey: string; units: bigint; note?: string }): Promise<TokenSendResult>
export async function redeliverPending(d: HandleDeps): Promise<number>    // handed_over && !delivered && rail 'handle'
export async function resendTransfer(d: HandleDeps, txid: string): Promise<'resent' | 'not-found' | 'unavailable'>
export async function receiveFromInbox(d: HandleDeps): Promise<{ credited: number; failed: number; incomplete?: true }>
export function tokenRequestUri(...)   // in core/pay/rails/handle.ts: `units=<decimal string>` param, never Math.round(Number())
```
`sendToHandle` steps, in this order:
1. Refuse when `units` < 1 or > `MAX_UINT64`, when another send is in flight for the same `assetId` (a per-asset latch, which covers the double tap), or when `recipientRefusal` is non-null.
2. `const h = await sendHandover({ wallet, identityKey, assetId, amount: units, recipientKey, note })`.
3. `journal.insert({ txid: h.txid, role: 'sent', state: 'handed_over', delivered: false, reference: h.reference, rail: 'handle', units, counterpartyKey: recipient, outputIndex: h.outputIndex, assetId, derivationPrefix: h.receipt.derivationPrefix, derivationSuffix: h.receipt.derivationSuffix, senderIdentityKey: h.receipt.senderIdentityKey })` (W4). The nearby `handover` (Task 15) writes the same three custody fields.
4. `deliverHandover({ messageBoxClient, recipientKey, handover: h, note })`. On success, `setDelivered(true)`.
5. If online, `settleNow(h.txid)`, raced against 8 000 ms.
6. Return `{ kind: 'sent', txid, settled: state === 'settled', notified: delivered }`.

A throw from step 2 maps on `.name`. `UnsupportedProfileError`, `ProfileParamsError`, `ProfileDataError` and `AttestationEvidenceError` give `refused` with `code = name`. A `ColorProviderError` with `!transport` gives `refused` with `code`. Anything else gives `unavailable`. A throw from step 4 still returns `sent` with `notified: false`.

`resendTransfer` rebuilds the §7.2 body from the row, `handoffEvidence(txid)` (profileData) and the AtomicBEEF from the injected `d.refetch(txid)` (WalletContext passes the existing `makeResendBeef`; no new storage API). It reuses lib `deliverHandover` with a `HandoverResult` built from those parts. The receipt custody fields (`derivationPrefix`, `derivationSuffix`, `senderIdentityKey` = A′) come from the row, which stores them at send time (`sendToHandle` step 3 writes them from `h.receipt`). `offChainValues: []`, because it is not part of the §7.2 body. It returns `'not-found'` when there is no row or no evidence.

`receiveFromInbox` calls lib `receiveHandovers({ wallet, messageBoxClient, processed })`. For each `accepted` entry it inserts a `received` row (`state: offline ? 'held' : 'settled'`, `rail: 'handle'`). The lib acks after internalize, and v1/v2 bodies are refused and acked by the lib (IC §7.2). An `incomplete: true` result means the MessageBox could not be read.

- [ ] **Step 1: Write the failing tests**

All lib calls are mocked with `jest.mock('@bsv/mandala', …)`, and the call order is recorded.
```ts
it('journals handed_over before delivering, then settles', async () => {
  const r = await sendToHandle(d, { assetId: A, recipientIdentityKey: B, units: 1500n })
  expect(order).toEqual(['sendHandover', 'journal.insert:handed_over', 'deliverHandover', 'setDelivered:true', 'settleNow'])
  expect(r).toEqual({ kind: 'sent', txid: T, settled: true, notified: true })
})
it('a second sendToHandle while one is in flight for the same asset is refused', async () => {
  const first = sendToHandle(d, a); const second = await sendToHandle(d, a)
  expect(second).toMatchObject({ kind: 'refused', code: 'ERR_SEND_IN_FLIGHT' }); await first
})
it('a delivery failure still reports sent, notified false, and stays handed_over', async () => { /* … */ })
it('tick redelivers an undelivered hand-over from handoffEvidence', async () => {
  // row handed_over, delivered false; handoffEvidence → { version:1, txid:T, profileData:{…} }
  expect(await redeliverPending(d)).toBe(1); expect(deliverHandover).toHaveBeenCalledWith(expect.objectContaining({ recipientKey: B }))
  expect((await d.journal.get(T))!.delivered).toBe(true)
})
it('maps module refusals by error name', async () => { /* sendHandover rejects {name:'UnsupportedProfileError'} → {kind:'refused', code:'UnsupportedProfileError'} */ })
it('journals inbox credits as held when offline and settled when admitted', async () => { /* accepted:[{offline:true…},{offline:false…}] */ })
it('never sends units above 2^64-1', async () => { expect(await sendToHandle(d, { …, units: 18446744073709551616n })).toMatchObject({ kind: 'refused' }) })
```
`tokenRails.test.ts` adds: `tokenRequestUri` with units `18446744073709551615n` contains `units=18446744073709551615`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/handle.test.ts packages/expo-wallet-toolbox/__tests__/pay/tokenRails.test.ts packages/expo-wallet-toolbox/__tests__/pay/handleInbox.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `handle.ts` and wire `sendToHandle`, `receiveFromInbox` and `resendTransfer` into the runtime. `WalletHomeScreen` calls `resendTransfer(txid)` with no deps now. Update the call site.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox/core/mandala packages/expo-wallet-toolbox/core/pay packages/expo-wallet-toolbox/__tests__ packages/expo-wallet-toolbox/ui/screens/WalletHomeScreen.tsx
git commit -m "feat(toolbox): handle-rail token send and receive over the mandala-color box"
```

---

### Task 14: Session v2 and localpay frame v6

**Files:**
- Modify: `core/localpay/session.ts`, `core/localpay/codec.ts`, `core/localpay/pending.ts:110-200` (wire serialization of the token block)
- Test: `__tests__/localpay/codec.test.ts`, `__tests__/localpay/session.test.ts`, `__tests__/localpay/pendingWire.test.ts`

**Interfaces:**
- Consumes: lib `MAX_UINT64`.
- Produces:
```ts
export const SESSION_VERSION = 2
export interface SessionAsset { id: string; label?: string; ticker?: string; decimals?: number }   // overlayUrl/overlayIdentityKey removed
export interface Session { …; amount?: number /* satoshis, BSV only */; units?: bigint /* token sessions only */; asset?: SessionAsset }
// wire: `a` = JSON number when no asset; canonical decimal string (1..MAX_UINT64) when asset present; asset block {i,n?,s?,d?}
export const FRAME_VERSION = 6
export interface TokenPayment { assetId: string /* <64hex>_0 */; certificates: Uint8Array[]; profileData: string /* UTF-8 JSON object */ }
```
`decodeSession`: a v1 session throws `CodecError('unsupported session version 1')`. A token session whose `a` is a number throws `CodecError('bad token amount')`. `mintSession` takes `units` for a token request and `amount` otherwise. Passing both throws. The frame decoder throws `CodecError` for version < 6. In the token block, `profileData` must parse to a JSON object (not an array) and be at most 16 777 216 bytes. `assetId` must match `^[0-9a-f]{64}_0$`.

- [ ] **Step 1: Write the failing tests**

```ts
it('round-trips 18446744073709551615 through a v2 token session', () => {
  const s = mintSession({ identityKey: K, units: 18446744073709551615n, asset: { id: ASSET, ticker: 'TUSD', decimals: 2 }, … })
  const back = decodeSession(encodeSession(s))
  expect(back.units).toBe(18446744073709551615n); expect(back.amount).toBeUndefined(); expect(back.asset).toEqual({ id: ASSET, ticker: 'TUSD', decimals: 2 })
  expect(JSON.parse(rawBody(encodeSession(s))).a).toBe('18446744073709551615')
})
it('refuses a v1 session and a numeric token amount', () => { /* v:1 → /unsupported session version 1/; asset + a:5 → /bad token amount/ */ })
it('round-trips a v6 token frame with a profileData carrier', () => {
  const f = frame({ version: 6, kind: 'token', token: { assetId: ASSET, certificates: [], profileData: JSON.stringify({ [ATTESTED]: { [ASSET]: LEAF } }) } })
  expect(decodeFrame(encodeFrame(f))).toEqual(f)
})
it('refuses frame version 5 and a non-object profileData', () => { /* … CodecError */ })
```
`pendingWire.test.ts` checks that a token frame survives `savePending` → reload with `profileData` intact. The `linkage`/`admissions` revival code is deleted.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/codec.test.ts packages/expo-wallet-toolbox/__tests__/localpay/session.test.ts packages/expo-wallet-toolbox/__tests__/localpay/pendingWire.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In the codec, the token block becomes `putStr(assetId)`, the certificates as today, then `putBytes(utf8(profileData))`. Remove the `AdmissionEntryWire` import. `isRequestableAmount` stays satoshi-only, and add `isRequestableUnits(u: unknown): u is bigint` (1..MAX_UINT64).

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/expo-wallet-toolbox/core/localpay packages/expo-wallet-toolbox/__tests__/localpay
git commit -m "feat(localpay)!: session v2 with decimal token units and frame v6 with a BRC-207 profileData carrier"
```

---

### Task 15: Nearby payer through the module

**Files:**
- Modify: `core/localpay/build.ts:12-25, 114-260, 441-870` (delete `selectTokenCoins`, `listTokenBasket`, `signTokenInput`, the linkage minting, `LockToPayee`; the token path calls `deps.handover`), `core/offline/payerHold.ts`, `core/offline/cancelParked.ts`, `core/pay/rails/nearby.ts` (re-exports), `ui/components/pay/NearbyFlow.tsx` (payer side: `:633-766`, `:1925-2440`)
- Modify: `core/mandala/createRuntime.ts` (`nearby.handover`, `nearby.onHandedOver`)
- Test: rewrite `__tests__/localpay/buildToken.test.ts`, `__tests__/localpay/pendingTokenHold.test.ts`, `__tests__/offline/payerHold.test.ts`, `__tests__/offline/cancelParked.test.ts` (`__tests__/localpay/nearbyOneCoinChangeShaping.test.ts` is a BSV-only regression and stays unchanged)

**Interfaces:**
- Consumes: `NearbyTokenDeps` (Task 11), lib `sendHandover` (with the IC extension below), `HandoverResult`.
- Produces:
```ts
export interface TokenBuildDeps { handover: NearbyTokenDeps['handover'] }
// buildPaymentFrame(wallet, session, originator, amount: number | bigint, token?: TokenBuildDeps, note?, queueFailedAbort?) — token sessions pass session.units
export interface TokenHandoverDeps { onHandedOver?: NearbyTokenDeps['onHandedOver'] }     // payerHold, replaces frame + onTokenHandedOver
export interface CancelParkedSettlementDeps { isHandoverAdmitted: (txid: string) => Promise<boolean | undefined>; journal: Pick<TransferJournal, 'get' | 'advance'>; isOnline: () => Promise<boolean> }
```
Runtime `nearby.handover(a)` calls `sendHandover({ wallet, identityKey, assetId, amount: a.units, recipientKey, derivationPrefix: a.derivationPrefix, derivationSuffix: a.derivationSuffix, note })`. The `derivationPrefix`/`derivationSuffix` parameters are a **contract extension** (see contractGaps): `createNonce` output is 44 chars, within the 48-byte cap. It then calls `journal.insert({ state: 'built', rail: 'nearby', delivered: false, reference, … })` and returns the result.

The frame is `{ version: 6, kind: 'token', senderIdentityKey: h.receipt.senderIdentityKey, outputIndex: h.outputIndex, derivationPrefix: h.receipt.derivationPrefix, derivationSuffix: h.receipt.derivationSuffix, transaction: Uint8Array.from(h.tx), token: { assetId, certificates: [], profileData: JSON.stringify(h.receipt.profileData) }, note }`. The builder asserts that `h.outputIndex === 0` and that the remittance strings equal the session's. A mismatch aborts the action and throws.

- `onHandedOver(txid, 'handed_over')` advances `built|parked` → `handed_over` and sets `delivered: true`. Then (W5) NearbyFlow calls `settleNow(txid)` after a positive ack, raced against 8 000 ms, and the receipt shows settled only on `'settled'`.
- A decline calls `abortAction(reference)` and advances `built` → `cancelled`.
- An uncertain delivery parks: `built` → `parked`. Release goes `parked` → `handed_over`.
- `cancelParkedPayment`: when online, if `isHandoverAdmitted(txid) === true`, the outcome is `'already-sent'` and the row advances to `handed_over`. `undefined` gives `'unverifiable-offline'`. `false` aborts and advances to `cancelled`.

`finalizeDelivery` keeps guard #1: a token payment is never broadcast at finalize.

- [ ] **Step 1: Write the failing tests**

```ts
it('builds a v6 token frame from the module hand-over bound to the session remittance', async () => {
  const handover = jest.fn(async () => H)   // H.receipt.derivationPrefix === SESSION.derivationPrefix, outputIndex 0
  const built = await buildPaymentFrame(wallet, TOKEN_SESSION, ADMIN, 1500n, { handover })
  expect(handover).toHaveBeenCalledWith({ assetId: ASSET, units: 1500n, recipientKey: SESSION.identityKey, derivationPrefix: SESSION.derivationPrefix, derivationSuffix: SESSION.derivationSuffix, note: undefined })
  expect(built.frame).toMatchObject({ version: 6, kind: 'token', outputIndex: 0, token: { assetId: ASSET, profileData: JSON.stringify(H.receipt.profileData) } })
  expect(built.tokenAmount).toBe(1500n); expect(wallet.createAction).not.toHaveBeenCalled()
})
it('aborts and throws when the hand-over does not carry the session remittance', async () => { /* … abortAction(H.reference) … */ })
it('finalizeDelivery never broadcasts a token payment', async () => { /* positive ack → broadcast: 'pending', no sendWith */ })
it('cancel of a parked token payment the overlay already admitted reports already-sent', async () => { /* isHandoverAdmitted → true; no abort; journal handed_over */ })
it('parks then releases through the journal', async () => { /* built→parked→handed_over */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/localpay/buildToken.test.ts packages/expo-wallet-toolbox/__tests__/localpay/pendingTokenHold.test.ts packages/expo-wallet-toolbox/__tests__/offline`
Expected: FAIL.

- [ ] **Step 3: Implement.** In NearbyFlow on the payer side:
- Replace the `known.asset.overlayIdentityKey !== session.asset.overlayIdentityKey` check with "the asset is in `mandala.balances`".
- Replace `readSettlementAck`/`tokenSendState` with `await runtime.settleNow(built.txid)` after `confirm(true)`.
- Pass `{ onHandedOver: runtime.nearby.onHandedOver }` to `holdSentPaymentOffline`/`parkSentPaymentOffline`.

Delete `core/offline/tokenFrames.ts`, its test, and the `rememberSessionPsk`/`sealedFramePayloadDecoder` exports and call sites. Delete `core/localpay/settlementAck.ts`, `__tests__/localpay/settlementAck.test.ts`, and their re-exports from `core/pay/rails/nearby.ts`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command, plus `npx jest packages/expo-wallet-toolbox/__tests__/localpay/build.test.ts packages/expo-wallet-toolbox/__tests__/pay/nearbyRail.test.ts packages/expo-wallet-toolbox/__tests__/offline/parkedAdvance.test.ts`
Expected: PASS. The BSV path tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox
git commit -m "feat(localpay)!: nearby token payments hand over through the color module"
```

---

### Task 16: Nearby payee: structural verify and §7.1 receipt internalize

**Files:**
- Create: `core/mandala/receipt.ts`, `__tests__/mandala/receipt.test.ts`
- Modify: `core/localpay/verify.ts` (token path), `core/localpay/pending.ts:460-640` (`internalizeOutput`, labels, hooks, retry classification), `ui/components/pay/NearbyFlow.tsx:1360-1425` (payee side), `core/mandala/createRuntime.ts` (`nearby.onReceived`)
- Test: `__tests__/localpay/verify.test.ts`, `__tests__/localpay/verifyFrameEndToEnd.test.ts`, `__tests__/localpay/pendingToken.test.ts`

**Interfaces:**
- Consumes: frame v6 (Task 14), `NearbyTokenDeps.onReceived` (Task 11), lib `decodeToken`, `colorBasket`, `colorProtocolID`, `ATTESTED_PROFILE_ID`, `ReceiptInstruction`; templates `OneColor`.
- Produces:
```ts
export function receiptFromFrame(frame: PaymentFrame): ReceiptInstruction        // {version:1, assetId, derivationPrefix, derivationSuffix, senderIdentityKey, profileData: JSON.parse(token.profileData)}
export function receiptInternalizeOutput(frame: PaymentFrame): { outputIndex: number; protocol: 'basket insertion'; insertionRemittance: { basket: string; customInstructions: string } }
export function declarationTxOf(receipt: ReceiptInstruction): string | undefined  // profileData[ATTESTED][assetId].declarationTx when a lowercase hex string
export function isRetriableReceiptFailure(e: unknown): boolean
// verify.ts
export type VerifiedPayment = { kind: 'bsv'; satoshis: number } | { kind: 'token'; assetId: string; units: bigint }
export async function verifyFramePayment(deps: FrameVerifyDeps, frame: PaymentFrame, originator: string, opts?: { assetId?: string }): Promise<VerifiedPayment>
// pending.ts
export type TokenReceiveHook = NearbyTokenDeps['onReceived']
export async function processPending(wallet, storage, originator, attribute?, onTokenReceived?: TokenReceiveHook): Promise<…>
```
Token verify order:
1. `decodeToken(output.lockingScript, txid, outputIndex)`: the role must be `value`, the `assetId` must equal both `frame.token.assetId` and `opts.assetId`, and `amount ≥ 1n`. Any failure is `not_mine`.
2. Pays-us: `getPublicKey({ protocolID: colorProtocolID(assetId, prefix, suffix), keyID: 'color', counterparty: frame.senderIdentityKey, forSelf: true })` through the published manager. The module's `handleRequest` passes `getPublicKey` through after validating the key args (ColorPermissionModule.ts:875-878, 0207:597), so no underlying-wallet route is needed. The test uses a real `WalletPermissionsManager` with the module registered, not a bare ProtoWallet, so that this path is exercised. Rebuild with `new OneColor().lock(assetId, amount, hash160(pub))` and compare to the output script hex. Inequality is `not_mine`.
3. `profileData` must be an object with exactly one key `ATTESTED_PROFILE_ID`, whose value has a key `assetId` with an object leaf. Anything else is `not_covered`.

There is no COVER and no conservation walk. The module validates the full frontier at internalize (IC §2.2.5, 0207:299-357).

`isRetriableReceiptFailure` returns:
- true for `ColorProviderError` with `retryable === true`;
- false for `ColorProviderError` with `retryable === false`, `AttestationEvidenceError`, `ProfileDataError`, `ProfileParamsError`, `UnsupportedProfileError`, and consent-declined errors (message matches the module's decline text; copy it from the vendored dist);
- true for anything else (storage faults).

Internalize labels become `[PEERPAY_LABEL, MANDALA_ACTION_LABEL]`. There is no `p mandala …` label and no caller tags.

`onReceived` runs after the internalize settles either way:
- `ok` reads the inventory for the txid (Task 11 `readInventory`) and journals `held` when `color_offline` is present, `settled` otherwise. It also calls `rememberDeploy(declarationTxOf(receipt))`.
- A `final` failure journals `refused` with the code.
- A retriable failure writes nothing.

- [ ] **Step 1: Write the failing tests**

```ts
it('builds the §7.1 receipt and the p color basket insertion verbatim', () => {
  const out = receiptInternalizeOutput(FRAME)
  expect(out.insertionRemittance.basket).toBe(`p color ${ASSET.replace('_', 'v')}`)
  expect(JSON.parse(out.insertionRemittance.customInstructions)).toEqual({ version: 1, assetId: ASSET, derivationPrefix: FRAME.derivationPrefix, derivationSuffix: FRAME.derivationSuffix, senderIdentityKey: FRAME.senderIdentityKey, profileData: JSON.parse(FRAME.token!.profileData) })
})
it.each([['ColorProviderError', true, true], ['ColorProviderError', false, false], ['AttestationEvidenceError', undefined, false], ['UnsupportedProfileError', undefined, false], ['Error', undefined, true]])(
  'classifies %s retryable=%s as retriable=%s', (name, retryable, expected) => expect(isRetriableReceiptFailure(err(name, retryable))).toBe(expected))
it('verifies a token frame that pays us under the p color derivation', async () => { /* payee = WalletPermissionsManager(ProtoWallet B, ADMIN, { permissionModules: { color } }); sender derives B's child via colorProtocolID (counterparty B) → kind token, units 1500n */ })
it('refuses a frame paying another key, another asset, or carrying a non-attested profileData', async () => { /* not_mine / not_mine / not_covered */ })
it('reads units above 2^53 from the script exactly', async () => { /* amount 9007199254740993n → units 9007199254740993n */ })
it('journals a credited offline receipt as held and a refused one as refused', async () => { /* processPending with onReceived spy; internalize rejects {name:'AttestationEvidenceError'} → outcome {ok:false, final:true} */ })
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/mandala/receipt.test.ts packages/expo-wallet-toolbox/__tests__/localpay/verify.test.ts packages/expo-wallet-toolbox/__tests__/localpay/pendingToken.test.ts packages/expo-wallet-toolbox/__tests__/localpay/verifyFrameEndToEnd.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In NearbyFlow on the payee side, remove `coverVerifier` and the `onTokenCredited`/`onTokenHeld` arguments. Pass `runtime.nearby.onReceived` and `{ assetId: session.asset.id }` to verify. Keep the "credited, not cleared by issuer" copy whenever the journal state is `held`. Delete `FT_PROTOCOL_ID` (verify.ts and pending.ts).

- [ ] **Step 4: Run the tests and confirm they pass**

Run the Step 2 command, plus `npx jest packages/expo-wallet-toolbox/__tests__/localpay packages/expo-wallet-toolbox/__tests__/ui/nearbyFlowToken.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox
git commit -m "feat(localpay)!: payee credits nearby tokens through a BRC-207 receipt into p color"
```

---

### Task 17: Drain tick and wallet wiring

**Files:**
- Modify: `core/context/WalletContext.tsx:2160-2480, 3400-3630` (runtime construction args, the `TaskSendOffline` tick, the processUnsent patch, foreground and online hooks)
- Test: rewrite `__tests__/context/mandalaDrainTick.test.ts`; update `__tests__/context/mandalaAvailability.test.tsx`, `__tests__/monitor/taskDrainOutbox.test.ts`

**Interfaces:**
- Consumes: `createMandalaRuntime({ …, color: colorRef.current?.module, provider: colorRef.current?.provider })`, `runtime.settleAll`, `runtime.reconcileHeld`, `redeliverPending` (through a runtime member `tick(): Promise<void>`), `storage.colorHeldTxids`.
- Produces: the implementation of `MandalaRuntime.tick(): Promise<void>` (declared in Task 11). It never throws, and it runs these steps in order:
  1. `redeliverPending`
  2. `settleAll()` (bare `color.settle()`, IC §8.2)
  3. `reconcileHeld` over `findOfflineActions(status 'held')` txids that carry 1Color outputs
  4. `emit`

The tick lambda reads `mandalaRef.current` on every pass. The order is `await mandalaRef.current?.tick()`, then `processOfflineActions({ storage, refetchBeef })` (which releases now-settled txids), then `drainMandalaInbox(mandalaRef.current)`. AppState `active` and NetInfo reconnect each call `mandalaRef.current?.settleAll()`. The processUnsent patch uses `phoneStorage.holdTokenReqsForDrain`, which is keyed by `colorHeldTxids` (Task 7).

- [ ] **Step 1: Write the failing test**

These are structural assertions over the tick body, in the existing style:
```ts
it('ticks the color runtime before the offline queue and reads the ref every pass', () => {
  expect(code(tick)).toMatch(/mandalaRef\.current\?\.tick\(\)[\s\S]*processOfflineActions\(/)
  expect(code(tick)).not.toMatch(/settlePendingSends|ensureAdmissionsForHoldings|reconcileJournals|recoverStaleAdmissions|repairAdmittedAborted|pruneBlindingReservations|tokenDeps/)
})
it('settles on foreground and reconnect', () => {
  expect(code(source)).toMatch(/AppState[\s\S]{0,400}mandalaRef\.current\?\.settleAll\(\)/)
  expect(code(source)).toMatch(/NetInfo[\s\S]{0,400}mandalaRef\.current\?\.settleAll\(\)/)
})
```
Add a unit test in `createRuntime.test.ts`: `tick() runs redeliver → settle → reconcileHeld and swallows each step's error`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/context/mandalaDrainTick.test.ts packages/expo-wallet-toolbox/__tests__/mandala/createRuntime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `tick()` and the WalletContext changes. Remove `decodeSealedFrame` from the runtime args. Keep `refetchBeef` (resend) and `isOnline` (send-time settle).

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/context packages/expo-wallet-toolbox/__tests__/monitor packages/expo-wallet-toolbox/__tests__/mandala`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox
git commit -m "feat(toolbox): drain tick settles through the color module before releasing held txs"
```

---

### Task 18: Exact bigint amounts and pending vs settled in the UI

**Files:**
- Modify: `ui/tokenFormat.ts`, `core/pay/tokenAmount.ts`, `core/profiles/assertProfileEmpty.ts:90-175`, `ui/hooks/useMandala.ts`, `ui/tokenStatus.ts`, `ui/screens/{WalletHomeScreen,PayScreen,WalletCheckScreen,tokenRowTitle}.tsx/ts`, `ui/components/pay/{UniversalSend,HandleReceive,AssetPicker,RequestHub,NearbyFlow,tokenSendCopy}.tsx/ts`, `ui/components/wallet/{AmountInput,AssetAmount,AssetSwitcherDropdown,ContactActivityList,ActivityRow,Balance}.tsx`, `ui/components/wallet/tokenEviction.ts` (delete if it only served `'reversed'`), `core/contacts/contactActivity.ts`
- Test: `__tests__/ui/tokenFormat.test.ts`, `__tests__/ui/tokenBalances.test.tsx`, `__tests__/ui/walletHomeTokens.test.tsx`, `__tests__/ui/tokenPay.test.tsx`, `__tests__/profiles/assertProfileEmpty.test.ts`, `__tests__/ui/tokenActivity.test.tsx`

**Interfaces:**
- Consumes: lib `formatAmount`, `parseAmount`, `MAX_UINT64`; `TokenBalance` (Task 11).
- Produces:
```ts
export function formatTokenAmount(units: bigint, decimals: number): string | null       // null when decimals outside 0..18
export function tokenAmountParts(units: bigint, decimals: number): { whole: string; fraction: string } | null
export function formatTokenAmountWithUnit(units: bigint, a: { decimals: number; ticker: string }): string | null
export function parseTokenAmount(text: string, decimals: number): bigint | null          // null on >dec places, negative, 0, > MAX_UINT64
export function tokenAmountInputText(units: bigint, decimals: number): string
// assertProfileEmpty deps: mandalaBalances?: () => Promise<ReadonlyArray<{ units: bigint; offlineUnits: bigint }>>
```
Balance rows show `formatTokenAmountWithUnit(units)`. When `offlineUnits > 0n` they add a second line, `t('token_balance_pending', { amount: formatTokenAmountWithUnit(offlineUnits) })`. The settled part is `units - offlineUnits`. Add the i18n keys `token_balance_pending` and `token_balance_settled`.

- [ ] **Step 1: Write the failing tests**

```ts
it('formats 2^64-1 at dec 2 exactly', () => expect(formatTokenAmount(18446744073709551615n, 2)).toBe('184467440737095516.15'))
it('parses the largest amount and refuses one above it', () => {
  expect(parseTokenAmount('184467440737095516.15', 2)).toBe(18446744073709551615n)
  expect(parseTokenAmount('184467440737095516.16', 2)).toBeNull(); expect(parseTokenAmount('1.234', 2)).toBeNull(); expect(parseTokenAmount('0', 2)).toBeNull()
})
it('shows the pending portion separately from the settled balance', async () => {
  render(withRuntime(fake({ balances: [balanceOf(USDX, 150000n, 50000n)] }), <WalletHomeScreen />)
  expect(screen.getByText('1,500.00 USDX')).toBeTruthy(); expect(screen.getByText(/500\.00 USDX.*pending/i)).toBeTruthy()
})
it('treats any unsettled token as non-empty', async () => { /* assertProfileEmpty with [{units:0n, offlineUnits:0n}] → empty; [{units:1n, offlineUnits:1n}] → not empty */ })
```
Use the grouping separator the existing `tokenFormat` tests already assert. If that is none, drop the comma from the expectation above.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui/tokenFormat.test.ts packages/expo-wallet-toolbox/__tests__/ui/walletHomeTokens.test.tsx packages/expo-wallet-toolbox/__tests__/profiles/assertProfileEmpty.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** `tokenFormat.ts` delegates digit math to lib `formatAmount`/`parseAmount` and keeps the existing grouping/locale rendering. Then sweep every remaining `baseUnits`/`unsettledBaseUnits`/`frozenBaseUnits` with `npx tsc --noEmit -p . | grep -E "baseUnits|units"` until none remain. `useMandala` keeps its "null is unknown, never zero" and runtime-identity rules.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx jest packages/expo-wallet-toolbox/__tests__/ui packages/expo-wallet-toolbox/__tests__/profiles packages/expo-wallet-toolbox/__tests__/contacts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/expo-wallet-toolbox
git commit -m "feat(ui)!: exact bigint token amounts with pending and settled balances"
```

---

### Task 19: Final sweep and gates

**Files:**
- Modify: `core/index.ts`, `ui/index.ts` (exports), `packages/expo-wallet-toolbox/package.json` (version `0.21.0`), `packages/expo-wallet-toolbox/CHANGELOG.md`, `packages/expo-wallet-toolbox/README.md` (Jest configuration section: the `.mjs` transform, the D21 alias and the allowlist)
- Create: `docs/superpowers/1color-wallet-report.md` (wallet repo)

**Interfaces:**
- Consumes: everything above.
- Produces: a green branch, plus a report carrying the publish prerequisites (IC §9 order) for the draft PR.

- [ ] **Step 1: Prove there are no leftovers**

Run: `cd packages/expo-wallet-toolbox && grep -rnE "p mandala|MANDALA_BASKET|token_settlements|FT_PROTOCOL|MandalaTokenModule|settlementAck|coverFromFrame|baseUnits|overlayIdentityKey.*session" core ui __tests__ | grep -v "^core/toolboxConfig.ts"`
Expected: no output. `toolboxConfig.ts` legitimately keeps `overlayIdentityKey` in `MandalaEndpointConfig`.

- [ ] **Step 2: Run the full suite and typecheck from the root**

Run: `cd /Users/personal/git/bsv-wallet-wt/1color && npx jest 2>&1 | tail -n 40 && npx tsc --noEmit -p . 2>&1 | grep -c "error TS"`
Expected: every failing test file was already failing in `docs/superpowers/1color-baseline.md`, and the tsc count is ≤ the baseline. Any new failure is fixed in the task that owns the file before continuing.

- [ ] **Step 3: Metro smoke**

Run: `npx expo export --platform ios --output-dir "$TMPDIR/1color-export" 2>&1 | tail -n 5` and `npx expo export --platform android --output-dir "$TMPDIR/1color-export-a" 2>&1 | tail -n 5`
Expected: `Exported:`. Record any environment-only failures verbatim.

- [ ] **Step 4: Write the report and bump the version**

`1color-wallet-report.md` contains: the counts versus baseline; decisions W1–W10; the contract gaps; the publish order (sdk → templates → toolbox ×3 → color module → mandala → swap `file:` specs for ranges and remove `overrides`); and the note that fuelkeeper is out of scope (B6). Add a CHANGELOG entry `0.21.0` (breaking: 1Color/BRC-207 tokens, no Mandala 0.4 compatibility).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(toolbox): release 0.21.0 — 1Color/BRC-207 tokens via @bsv/color-permission-module"
```

---

## Self-review notes

- **Spec coverage (design §4.4, §5, §8):**
  - Dependency upgrade: T2–T4.
  - Register the module and the attested + Mandala handlers: T10.
  - Delete `permissionModule.ts` and the `'p mandala'` basket/migration: T10, T6.
  - Settlement runtime re-plumbed: createRuntime T11–T13/T17, drain T7/T17, settlementStore T6, localpay build/verify T15/T16, inboxPrehold T11, MessageBox T13.
  - Guarded SQLite migration: T6.
  - `p color` balance views and pending vs settled: T11, T18.
  - RN/Metro/jest ESM: T4.
  - Jest from the root plus the tsc gate: T1, T19.
  - Audit S2 (blind-sign) and S3 (spoofable spend prompt) regression pins through the published manager stack: T10 `colorSigningGate.test.ts` (A.13 at 0207:2195-2233; W11).
  - B2 plain-noSend hand-over: T13/T15 via `sendHandover`. B3 blinding stays in the lib: T13 default `blind`. B5 mobile settle API: T12. S5 fail closed: T10 (no endpoints means no `color` module) and W3.
- **Type consistency:** the journal types are defined once in T6. `NearbyTokenDeps`/`MandalaRuntime` are defined once in T11, extended only by `tick()` in T17, and their consumers are named in T13, T15, T16 and T17.
- **Proportion:** bodies appear only for the C.0 vectors and the dependency checks. Everything else is signatures and assertions.

# @bsv/mandala 0.5.0 (1Color / BRC-207) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended; this plan is written for subagent-driven execution, one fresh implementer + one fresh reviewer per task) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `@bsv/mandala` into a 0.5.0 (breaking) library that writes plain BRC-162 1Color tokens with uint64 `bigint` amounts, keeps the issuer treasury and admin chain under Mandala keys, delivers holder value only through BRC-207 receipts, and ships the Mandala issuer-v1 required-profile handler that BRC-207 wallets register.

**Architecture:** Two entries. The core `@bsv/mandala` (RN-safe, never imports the color module) covers naming, amounts, codec and deploy `req`, attestation sign/verify, the Mandala envelope, issuer and admin flows (overlay-first, `mandala treasury` basket), payouts that create holder `p color` outputs with BRC-207 receipts, holder hand-over send, deliver and settle through a module-hosting wallet, and MessageBox receive. `@bsv/mandala/profile` (`src/profile*.ts`, optional peer `@bsv/color-permission-module` 0.2.0) holds the Mandala overlay provider and the issuer-v1 `RequiredProfileHandler`. The holder-side `'p mandala'` pipeline and `cover()` are deleted. S1 then holds through T2's attested frontier validator, and an integration test pins it. On the transport-only offline path the handler also checks every unanchored hop locally against Mandala policy (C§4 local hop checks), so the wallet never offline-credits value the overlay would deterministically refuse. TS-built envelopes are proven against overlay-go through a checked-in envelope fixture (C§10 ENVELOPE seam).

**Tech Stack:** TypeScript 5.9 (ESM, `tsc -p tsconfig.build.json`), vitest 4, `@bsv/sdk` 4.0.0, `@bsv/templates` 2.2.0 (`OneColor`, `encodeStrictCbor`/`decodeStrictCbor`), `@bsv/message-box-client` ^2.5.4, `@bsv/color-permission-module` 0.2.0 and `@bsv/wallet-toolbox-client` 2.15.0 (profile entry and tests only). All unpublished packages come from vendored tarballs.

**Spec:** `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/specs/2026-10-21-1color-brc207-conformance-design.md` (incl. §8 B1-B6). The **authoritative seam contract** is `/Users/personal/git/demos/mandala-wt/1color/docs/superpowers/plans/2026-10-22-1color-00-interfaces.md` (cited as **C§n**). Specs cited by line: **0162** = `docs/design/brc-0162-1color.pinned.md`, **0207** = `docs/design/brc-0207-1color-wallet-module.pinned.md`. Audit: `docs/design/2026-10-21-brc162-brc207-conformance-audit.md` (findings S1-S5). Executors read the contract sections named in each task before starting it.

Paths used below: `WT=/Users/personal/git/demos/mandala-wt/1color`, `LIB=$WT/lib`, `VEND=$WT/vendor-ts-stack`, `TS=/Users/personal/git/ts-stack-wt/1color`. Each command is run with absolute paths, e.g. `cd /Users/personal/git/demos/mandala-wt/1color/lib && npx vitest run src/x.test.ts`.

## Global Constraints

- Branch `feat/1color` in `$WT` only. This plan edits `lib/**`, `docs/profiles/issuer-v1.md` and adds tarballs under `vendor-ts-stack/`. Never touch `/Users/personal/git/ts-stack`, `/Users/personal/git/bsv-wallet`, `/Users/personal/git/ts/bsv-desktop`, `/Users/personal/git/demos/mandala` (main checkout), `app/`, `overlay/`, `overlay-go/`, `fuelkeeper/`. `$TS` is read-only for this plan. This plan never runs the C§9 pack script: V0 is the orchestrator's step 0, and V1/V2 are packed by P-T1/P-T2. A missing tarball means `BLOCKED`, never a local pack or stub (C§10).
- No `npm publish`, no tag push, no `git push`, no merges. Commit after every task on `feat/1color`. Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (shown once here; every commit step uses `-m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`).
- **Worktree discipline (C§10):** P-GO, P-LIB and P-APP share the `$WT` branch. Every commit is pathspec-scoped and stages nothing outside this plan's trees: `git -C $WT add -- <paths> && git -C $WT commit -m "<subject>" -m "Co-Authored-By: …" -- <paths>`, where `<paths>` is `lib/`, plus `vendor-ts-stack/` in Tasks 1, 5, 18 and 23, plus `docs/profiles/` from Task 19 on. Never `git add -A` or `git commit -a`. On an `index.lock` collision, wait and retry. A commit step below that names only a subject uses this form.
- Package: `@bsv/mandala` **0.5.0**, ESM. `peerDependencies`: `@bsv/sdk ^4.0.0`, `@bsv/templates ^2.2.0`, `@bsv/message-box-client ^2.5.4`, `@bsv/color-permission-module ^0.2.0` (optional, `peerDependenciesMeta`). No `@bsv/*` in `dependencies`. The vendored tarballs are `devDependencies` (`file:../vendor-ts-stack/<tarball>`), plus `overrides` `{ "<name>": "$<name>" }` for every vendored name (C§8, C§9, D9, D10).
- `@bsv/templates` `Bsv21Token.ts` is never modified, and the lib never imports `Bsv21Token`, `Bsv21Binary` or `tokenIdToString`/`tokenIdFromString`. It uses only `OneColor`, `encodeStrictCbor` and `decodeStrictCbor`.
- No backward compatibility: old `'p mandala'` derivations, the `mandala-tokens` basket, MessageBox `mandala-payments`, v1/v2 bodies, `tm_<txid>` topics and σI v3 on token topics are refused or deleted, never migrated.
- Token amounts: per output `0..2^64-1` (`MAX_UINT64 = 18446744073709551615n`). Every API, store and wire field carries a `bigint`. JSON carries canonical decimal strings `0|[1-9][0-9]*`, signed fields may lead with `-`, never `-0` (C§0). No `Number()` on token amounts and no 2^53 logic anywhere.
- Identifiers (C§0): asset id `^[0-9a-f]{64}_(0|[1-9][0-9]{0,9})$`, Mandala policy `_0` only. Outpoint `<txid>.<vout>`. assetTag `<64hex>v<vout>`. Topics `tm_color_<assetId>` / `ls_color_<assetId>`. Registry topics `tm_mandala`, `ls_mandala`, `tm_mandala_kyc`, `ls_mandala_kyc` keep their names. Deploy submit topics are exactly `["tm_mandala", "tm_color_<txid>_0"]`. Holder tx topics are exactly `["tm_color_<assetId>"]`, one Mandala asset per tx (D1). All hex is lowercase. Token outputs carry exactly 1 sat. Remittance strings are base64 of 16 random bytes by default. A caller-supplied value (≤ 48 UTF-8 bytes, no whitespace, e.g. a 44-char `createNonce` output) is accepted and used verbatim, and Mandala code accepts at most 48 UTF-8 bytes each (C§0, D25).
- Profile ids: `ATTESTED_PROFILE_ID = 'https://brc.dev/207/attested'`, `MANDALA_PROFILE_ID = 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md'` (80 bytes). Every Mandala deploy writes `req = mandalaReq(K)` exactly (C§4).
- BSV Chronicle: never normalize S. Verifiers accept low- and high-S signatures. Attestations verify only against the BRC-42 child `[2,'color admission attestation']`, keyID `'1'`, never against the bare key (C§3).
- Overlay-first for issuer, admin, registry and payout txs: `noSend` → `/submit` → `sendWith`. A holder hand-over is never submitted by its sender before the hand-over is acknowledged (B2, B5, D27).
- S5: every path that submits to, or verifies against, the overlay fails closed (throws before any wallet mutation or network call) when the overlay identity key is not configured.
- Stability mandate: before you change any pipeline, reason through crash (journal before each side effect), double-click and multi-tab (web lock plus intent marker), stale cache (verify `hash256(raw) == txid` on everything fetched), and retry (idempotent submit with exact journaled bytes). Each task names its case.
- Errors crossing package boundaries are matched by `.name` (and the `(ERR_*` code in the message), never by `instanceof` (D22).
- The core never imports `@bsv/color-permission-module`. Only files whose basename starts with `profile` may import it (D8).
- Every task ends with `npx tsc --noEmit` exit 0 and the full `npx vitest run` green, apart from the explicitly listed expected deltas.
- Subagent tiering: sonnet for Tasks 1-5, 8, 9, 11, 16, 17, 23. Opus for security and multi-file tasks 6, 7, 10, 12-15 and 18-22.

## Review Focus

1. **A plan leaf whose recipient linkage does not match the recipient locking script** (a lib bug, or tampered app data). The wallet must refuse at `signAction`, before signing. Otherwise an offline recipient credits a hand-over that the overlay later refuses for good with ERR_LINKAGE. Pinned in Task 20 (`checkPlanData rejects a leaf whose linkage does not derive the output's pubkey hash`).
2. **An online recipient whose overlay answers with a typed retryable verdict (ERR_FROZEN, ERR_PAUSED).** There must be no credit and no offline fallback, and the MessageBox message stays unacknowledged for retry. Only a transport failure may take the offline path (D6). Pinned in Task 21 (`typed retryable verdict refuses credit`) and Task 14 (`retryable verdict leaves the message unacknowledged`).
3. **Amounts at the uint64 boundary and their sums.** `2^64-1` must survive parse → lock → decode → format exactly, `2^64` must be rejected at every entry point, and treasury totals above `2^64` must be exact. Pinned in Task 3 (`parseAmount boundary`), Task 5 (`decodeToken reads MAX_UINT64`) and Task 8 (`selection total exceeds 2^64 exactly`).
4. **Double-click, multi-tab and crash around a hand-over.** A concurrent second send must fail fast. A crash between signing and the journal must leave the action protected (intent marker), and a crash after signing must not lose the bytes. Duplicate delivery or settle must be harmless. Pinned in Task 13 (`second concurrent sendHandover rejects BusyError`, `journal entry is durable before sendHandover resolves`, `concurrent settleHandover submits once`).
5. **No overlay identity key configured (S5).** register, payout, submit, settle, `recipientLinkage` and the profile provider must all fail closed with no wallet mutation. Pinned in Task 7 (`submitToOverlay refuses without an identity key`), Task 12 (`payout fails closed before listOutputs`) and Task 19 (`provider for an unconfigured key throws ProfileParamsError`).
6. **An offline receipt whose unanchored hop breaks Mandala policy** (implicit burn, a 2-sat token output, a second asset, a `req`/`ext` payload, an envelope that misses a token output). With the overlay unreachable, the wallet must refuse with `ProfileDataError` and must not credit `color_offline`. Otherwise it credits value the overlay will refuse for good (ERR_CONSERVATION, ERR_SATOSHIS, ERR_LINKAGE). Pinned in Task 21 (`offline burn hop ⇒ ProfileDataError`, `offline 2-sat hop ⇒ ProfileDataError`, `offline envelope missing an output ⇒ ProfileDataError`).
7. **A TS-built envelope that overlay-go reads differently** (linkage member shapes, `protocolID` tuple, the `specific linkage revelation 2 p color …` encryption, the G9 owner counterparty, varint framing). This would surface only when the first real hand-over is refused with ERR_LINKAGE. Pinned by the committed `1color-envelope.json` and its consistency test (Task 22 `envelope fixture is self-consistent`). Plan 03 replays the same bytes through its engine flow.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/package.json`, `lib/package-lock.json` | 0.5.0 manifest, peers, vendored devDeps, overrides | 1, 18, 23 |
| `lib/src/packageManifest.test.ts` (new) | manifest invariants | 1, 18 |
| `lib/src/removedExports.test.ts` (new) | contract removal list / presence list | 2, 17 |
| `lib/src/amount.ts` | bigint amounts, JSON decimal parsing | 3 |
| `lib/src/constants.ts` | endpoints, topics, MESSAGEBOX, profile ids, `TREASURY_BASKET`, `ADMIN_PROTOCOL` | 4 |
| `lib/src/naming.ts` (new) | `colorTopic`, `colorLookup`, `assetTag`, `colorProtocolID`, `colorBasket`, `isColorTopic` | 4 |
| `lib/src/brc162.ts` | OneColor codec boundary, admin details, deploy payload/`req`, `readDeploy` | 5, 7 |
| `lib/src/__fixtures__/1color-deploy.json` (new) | F-REQ fixture (C§4) | 5 |
| `lib/src/attestation.ts` (new) | attested v1 statement, sign/verify, STEAK mapping | 6 |
| `lib/src/admission.ts` | σI v3 for `tm_mandala` only, `fetchAdmission` | 6, 7 |
| `lib/src/overlay.ts` | `/submit` facilitator, per-topic verification, S5 | 7 |
| `lib/src/__fixtures__/overlaySigner.ts` (new) | priv-5555 overlay signer for STEAK fixtures | 7 |
| `lib/src/encoding.ts` | `SpecificLinkage`, `MandalaEnvelope`, `encodeEnvelope`, `decodeEnvelope` | 8 |
| `lib/src/treasury/{select,candidates,unlock,linkage}.ts` (moved) | issuer coin selection/unlock/linkage under `ADMIN_PROTOCOL` | 8 |
| `lib/src/authority.ts` | authority/deploy txs, foreign recipient outputs | 8, 12 |
| `lib/src/issuerOps.ts`, `assets.ts`, `registry.ts`, `assetRecover.ts`, `registryRecover.ts`, `reconcileBans.ts`, `feeRate.ts` | issuer/admin/registry flows | 9, 12 |
| `lib/src/linkage.ts` (new), `blinding.ts`, `blindingJournal.ts` | `recipientLinkage`, blinding math, r store keyed by outpoint | 10 |
| `lib/src/plan.ts` (new) | `ColorPlanV1`, `planLabels` | 11 |
| `lib/src/overlayLookup.ts` (new) | `postLookup`, `fetchDeployTx` | 12 |
| `lib/src/receipt.ts` (new) | `ReceiptInstruction`, attested leaf for issuer receipts, MessageBox v3 body | 12 |
| `lib/src/payout.ts` (new) | `payoutTokens` (B4) | 12 |
| `lib/src/handover.ts` (rewritten) | `sendHandover`, `deliverHandover`, `settleHandover`, `markHandoverDelivered` | 13 |
| `lib/src/txJournal.ts`, `notifyJournal.ts`, `reconcile.ts` | `signed`/`delivered` stages, redelivery, settle retry | 13, 15 |
| `lib/src/receive.ts` (rewritten) | `parseHandoverBody`, `receiveHandovers` | 14 |
| `lib/src/history.ts` | `loadHistory` with `scope` (treasury and holder rows), bigint | 16 |
| `lib/src/adminHistory.ts`, `adminState.ts`, `overlayActivity.ts`, `metadata.ts`, `contacts.ts`, `banking.ts`, `submitGuards.ts` | bigint read paths | 3, 16 |
| `lib/src/index.ts`, `lib/README.md` | facade + exports | 2, 17 |
| `lib/src/robustness.wiring.test.ts` (new) | lib-source invariants moved out of `app/src/robustness.wiring.test.ts` (C§8.1, plan 05 A7) | 17 |
| `lib/src/profileProvider.ts` (new) | `createMandalaOverlayProvider` | 18 |
| `lib/src/profile.ts` (new, entry `@bsv/mandala/profile`) | `createMandalaProfile` | 19-21 |
| `lib/src/profilePlanData.ts` (new) | `checkPlanData`/`submissionData` | 20 |
| `lib/src/profileReceipt.ts`, `lib/src/profileHopCheck.ts` (new) | `admitReceipt`; offline local hop checks (C§4) | 21 |
| `lib/src/__fixtures__/{fakeWallet,fakeMandalaOverlay}.ts` (new) | test-only underlying wallet and overlay | 22 |
| `lib/src/__fixtures__/1color-envelope.json` (new), `lib/src/envelopeFixture.test.ts` (new) | ENVELOPE seam fixture (C§10) and its consistency test; plan 03 copies the JSON byte for byte | 22 |
| `docs/profiles/issuer-v1.md` (new) | profile definition | 19 |

Deleted: `transfer.ts`, `receive.ts` (old), `handover.ts` (old), `bundle.ts`, `ftChange.ts`, `ftSelect.ts`, `ftCandidates.ts`, `unlock.ts` and their tests, plus `basket.test.ts`, `receiveHandover.test.ts`, `ftCandidatesBeef.test.ts` (moved), `issuerOps.redeem.test.ts` (merged).

---

### Task 1: Baseline, vendored tarballs, 0.5.0 manifest

**Files:**
- Modify: `lib/package.json`, `lib/package-lock.json`
- Create: `lib/src/packageManifest.test.ts`
- Commit (never create): the V0/V1 `vendor-ts-stack/*.tgz` the orchestrator and P-T1 wrote (C§9)

**Interfaces:**
- Consumes: C§8 package rules, C§9 vendoring.
- Produces: an installed tree with `@bsv/sdk` 4.0.0 and `@bsv/templates` ≥ 2.1.0 (`OneColor`) under `lib/node_modules`. Later tasks import `OneColor`, `encodeStrictCbor`, `decodeStrictCbor` from `@bsv/templates`.

- [ ] **Step 1: Record the baseline.** Run `cd $LIB && npx vitest run 2>&1 | tail -5; npx tsc --noEmit; echo TSC=$?`. Expected (measured 2026-10-22 on 45deec9): `Test Files 40 passed (40)`, `Tests 523 passed (523)`, `TSC=0`. If the numbers differ, use the actual numbers as the baseline and put them in this task's commit body.
- [ ] **Step 2: Tarball gate.** `ls $VEND/bsv-sdk-4.0.0-*.tgz $VEND/bsv-templates-2.*-*.tgz`. If both exist, use the newest sha (prefer `bsv-templates-2.2.0-*` (V1) over `2.1.0` (V0)). If either is missing, **STOP and report `BLOCKED: V0 tarballs missing (orchestrator step 0)`**. This plan never runs the pack script and never builds in `$TS` (C§10). Record in the commit body whether templates is V0 (2.1.0) or V1 (2.2.0). Tasks 2-4 run on V0; Task 5 needs V1.
- [ ] **Step 3: Write the failing manifest test** `src/packageManifest.test.ts` (read `../package.json?raw` as `packageExports.test.ts` does):

```ts
expect(pkg.version).toBe('0.5.0')
expect(Object.keys(pkg.dependencies ?? {}).filter(n => n.startsWith('@bsv/'))).toEqual([])
expect(pkg.peerDependencies).toEqual({ '@bsv/sdk': '^4.0.0', '@bsv/templates': '^2.2.0', '@bsv/message-box-client': '^2.5.4', '@bsv/color-permission-module': '^0.2.0' })
expect(pkg.peerDependenciesMeta).toEqual({ '@bsv/color-permission-module': { optional: true } })
for (const n of ['@bsv/sdk', '@bsv/templates']) expect(pkg.devDependencies[n]).toMatch(/^file:\.\.\/vendor-ts-stack\/bsv-[a-z-]+-\d+\.\d+\.\d+-[0-9a-f]{7,9}\.tgz$/)
expect(pkg.devDependencies['@bsv/message-box-client']).toBe('^2.5.4')
for (const n of Object.keys(pkg.devDependencies).filter(n => pkg.devDependencies[n].startsWith('file:'))) expect(pkg.overrides[n]).toBe(`$${n}`)
```

- [ ] **Step 4: Run it.** `cd $LIB && npx vitest run src/packageManifest.test.ts`. Expected: FAIL (`expected '0.4.1' to be '0.5.0'`).
- [ ] **Step 5: Edit `lib/package.json`** to match, keeping `scripts`, `exports` and `files`. Then run `cd $LIB && npm install --ignore-scripts` (`prepare` would run `tsc` and mask install errors). If npm reports ERESOLVE only because the V0 templates tarball is 2.1.0 and the peer says `^2.2.0`, set the peer to `>=2.1.0 <3` **temporarily**, note it in the commit body, and let Task 5 Step 0 restore `^2.2.0` (Task 23 re-checks it). Gate: `npm ls @bsv/sdk` lists exactly one version, 4.0.0 (the `overrides` must dedupe message-box-client's sdk), and `npm ls @bsv/templates` lists one.
- [ ] **Step 6: SDK 4 bring-up.** Run `npx tsc --noEmit` and `npx vitest run`. Fix **only** breakage caused by the sdk 2.8 → 4.0 and templates 2.0 → 2.1 bumps (API renames and type changes) without changing behaviour. Keep `Bsv21Binary` call sites compiling for now, since Task 5 replaces them. In the commit body, list each file touched for the bump. Expected: 523 passed (plus the manifest file), tsc 0.
- [ ] **Step 7: Commit.** `git -C $WT add -- lib/ vendor-ts-stack/ && git -C $WT commit -m "chore(lib): 0.5.0 manifest on vendored sdk 4.0.0 / templates" -m "Baseline: <files>/<tests> before; <files>/<tests> after" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- lib/ vendor-ts-stack/` (C§9: P-LIB commits the tarballs the producers wrote).

### Task 2: Delete the holder-side `'p mandala'` pipeline and `cover()`

**Files:**
- Delete: `lib/src/{transfer,receive,handover,bundle,ftChange}.ts` and `lib/src/{transfer,receive,receiveHandover,handover,bundle,ftChange}.test.ts`
- Modify: `lib/src/index.ts` (drop those `export *` lines, the `send`/`receive` client members, `SendArgs`, `ReceiveArgs`), `lib/src/robustness.recovery.test.ts` (delete the `describe('receive verification')` block, lines 149-217, **and** its `import { receiveTokens, InvalidTransferError } from './receive.js'` line 29, or the file fails to load), `lib/src/index.test.ts` if it references the facade members
- Create: `lib/src/removedExports.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: a lib with no holder credit path. `MandalaClient` temporarily loses `send`/`receive` (Task 17 re-adds them). The `InvalidTransferError` and `MessageBoxSender` names are re-created in Tasks 13/14.

- [ ] **Step 1: Write the failing test** `src/removedExports.test.ts`:

```ts
const mod = await import('./index.js')
it.each(['transferTokens', 'receiveTokens', 'defaultSettle', 'cover', 'canonicalBundleId',
  'collectHandoverEvidence', 'journalEvidenceSource', 'derHex'])('%s is gone', n => {
  expect(n in mod).toBe(false)
})
```

- [ ] **Step 2: Run it.** `npx vitest run src/removedExports.test.ts`. Expected: FAIL for every name.
- [ ] **Step 3: Delete the files and edit `index.ts`.** S1 reasoning for the reviewer: after this task the lib credits nothing itself, and the only offline acceptance path is T2's attested validator (pinned in Task 22). `reconcile.ts` keeps compiling: its `handed_over` branch only uses `txJournal`/`overlay`, and Task 15 rewrites it.
- [ ] **Step 4: Run** `npx vitest run && npx tsc --noEmit`. Expected: PASS. Test count = baseline − 86 (bundle 25, handover 15, receive 13, receiveHandover 8, transfer 15, ftChange 10) − the deleted robustness block (count it) + 8.
- [ ] **Step 5: Commit** `feat(lib)!: delete holder 'p mandala' transfer/receive pipeline and cover()`.

### Task 3: bigint amounts

**Files:**
- Modify: `lib/src/amount.ts`, `lib/src/submitGuards.ts`, `lib/src/banking.ts`
- Test: `lib/src/amount.test.ts` (rewrite), `lib/src/submitGuards.test.ts`, `lib/src/banking.test.ts`

**Interfaces:**
- Produces (exact):
  - `export const MAX_UINT64: bigint` (= `(1n << 64n) - 1n`)
  - `formatAmount(units: bigint, dec: number): string`: exact plain decimal, trailing fractional zeros trimmed, no grouping, leading `-` for negatives. `dec` must be an integer 0..18, else `RangeError`.
  - `formatAmountPlain` is removed (`formatAmount` is already plain; P-APP plan 05 assumes the removal).
  - `formatAmountGrouped(units: bigint, dec: number): string`: `,` thousands separators on the whole part, no locale APIs
  - `formatCurrency(units: bigint, dec: number, ticker?: string): string` = `currencySymbol(ticker) + formatAmountGrouped(units, dec)`; `currencySymbol` unchanged
  - `parseAmount(text: string, dec: number): bigint`: trims; accepts `/^(?:\d+(?:\.\d*)?|\.\d+)$/`; throws `RangeError` on empty or invalid text, more than `dec` fractional digits, a negative value, or a value above `MAX_UINT64`
  - `parseDecimalAmount(v: unknown, signed?: boolean): bigint | null`: canonical JSON decimal string per C§0; `null` for anything else (numbers, `'-0'`, `'01'`, `'+1'`, `''`)
  - `guardPositiveAmount(amount: bigint): GuardResult` (`0 < amount ≤ MAX_UINT64`, failure reason `'Amount exceeds the uint64 token range'` above max). `SendSubmitInput.{amount, balance}`, `IssueRedeemSubmitInput.{amount, balance?}` become `bigint`.
  - `banking.ts`: `MockTransfer.amount`, `bankBalance`, `reconcile` all `bigint`.

- [ ] **Step 1: Write failing tests** (`amount.test.ts`):

```ts
expect(parseAmount('18446744073709551615', 0)).toBe(MAX_UINT64)
expect(() => parseAmount('18446744073709551616', 0)).toThrow(RangeError)
expect(parseAmount('18.446744073709551615', 18)).toBe(MAX_UINT64)
expect(parseAmount('0.5', 2)).toBe(50n)
for (const bad of ['', '-1', '1.234', 'abc', '1e3']) expect(() => parseAmount(bad, 2)).toThrow(RangeError)
expect(formatAmount(1n, 18)).toBe('0.000000000000000001')
expect(formatAmount(MAX_UINT64, 18)).toBe('18.446744073709551615')
expect(formatAmount(150n, 2)).toBe('1.5'); expect(formatAmount(100n, 2)).toBe('1'); expect(formatAmount(-250n, 2)).toBe('-2.5')
expect(formatAmountGrouped(123456789n, 2)).toBe('1,234,567.89')
expect(formatCurrency(100n, 2, 'usd')).toBe('$1')
expect(() => formatAmount(1n, 19)).toThrow(RangeError)
expect(parseDecimalAmount('18446744073709551615')).toBe(MAX_UINT64)
expect(parseDecimalAmount('-5', true)).toBe(-5n)
for (const bad of [5, '-0', '01', '+1', '', '-5']) expect(parseDecimalAmount(bad)).toBeNull()
```

In `submitGuards.test.ts`, the cases become: `guardPositiveAmount(0n)` fails, `guardPositiveAmount(MAX_UINT64)` is ok, and `guardPositiveAmount(MAX_UINT64 + 1n)` fails with reason `'Amount exceeds the uint64 token range'`. Every existing number case is converted to bigint with the same expectations.
- [ ] **Step 2: Run** `npx vitest run src/amount.test.ts src/submitGuards.test.ts src/banking.test.ts`. Expected: FAIL (type/values).
- [ ] **Step 3: Implement** in the three files with string/bigint arithmetic only (no `Number`, no `toLocaleString`).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS (any other caller of these helpers compiles after `BigInt(...)` at its own boundary; list them in the commit body).
- [ ] **Step 5: Commit** `feat(lib)!: uint64 bigint amounts and exact decimal formatting`.

### Task 4: 1Color naming, constants and configuration

**Files:**
- Create: `lib/src/naming.ts`, `lib/src/naming.test.ts`
- Modify: `lib/src/constants.ts`, `lib/src/constants.test.ts`, and every source using `BASKET`/`FT_PROTOCOL` (`assets.ts`, `authority.ts`, `issuerOps.ts`, `ftCandidates.ts`, `history.ts`, `reconcileBans.ts`, `registry.ts`, `registryRecover.ts`, `assetRecover.ts`, `tokens.ts`, `unlock.ts`, `blinding.ts`), `index.ts`
- Delete: `lib/src/basket.test.ts` (3 tests)

**Interfaces:**
- Produces (C§8.1 verbatim, plus noted extensions):
  - `constants.ts`: `TOPIC='tm_mandala'`, `LOOKUP='ls_mandala'`, `REGISTRY_TOPIC='tm_mandala_kyc'`, `REGISTRY_LOOKUP='ls_mandala_kyc'`, `MESSAGEBOX='mandala-color'`, `ATTESTED_PROFILE_ID`, `MANDALA_PROFILE_ID`, `TREASURY_BASKET='mandala treasury'`, `ADMIN_PROTOCOL: WalletProtocol = [2, 'mandala admin']` (**contract gap G1**: the issuer, treasury, authority, deploy and registry derivation for every Mandala-key output, replacing `FT_PROTOCOL`), `REGISTRY_PROTOCOL` unchanged, `OVERLAY_IDENTITY_KEY_UNSET` (message `'@bsv/mandala: overlay identity key is not configured — call configureMandala({ overlayIdentityKey })'`). `configureMandala(e: { overlayUrl?, overlayIdentityKey?, messageBoxUrl?, adminApiToken?, storage? })`, with the `basket` option removed. `FT_PROTOCOL` and `BASKET` are removed.
  - `naming.ts`: `colorTopic(assetId: string): string`, `colorLookup(assetId: string): string`, `assetTag(assetId: string): string`, `colorProtocolID(assetId: string, prefix: string, suffix: string): [2, string]`, `colorBasket(assetId: string, role?: 'value' | 'authority'): string`, `isColorTopic(topic: string): boolean`, `isAssetId(id: string): boolean`, `assertRemittance(s: string, name: string): string` (non-empty, no whitespace, strict UTF-8, ≤ 48 UTF-8 bytes). Invalid input throws `TypeError` with a message starting `'@bsv/mandala:'`.

- [ ] **Step 1: Write failing tests** (`naming.test.ts`), using the 0207:551 example (prefix `AQ==`, suffix `Ag==`):

```ts
const ID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0'
expect(colorTopic(ID)).toBe(`tm_color_${ID}`); expect(colorLookup(ID)).toBe(`ls_color_${ID}`)
expect(assetTag(ID)).toBe('c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4fv0')
expect(colorProtocolID(ID, 'AQ==', 'Ag==')).toEqual([2, `p color ${assetTag(ID)} 41513d3d 41673d3d`])
expect(colorBasket(ID)).toBe(`p color ${assetTag(ID)}`); expect(colorBasket(ID, 'authority')).toBe(`p color ${assetTag(ID)} authority`)
for (const bad of ['ABC', ID.toUpperCase(), ID.replace('_0', '_01'), ID.replace('_0', '_4294967296')]) expect(() => colorTopic(bad)).toThrow(TypeError)
expect(() => colorProtocolID(ID, 'a'.repeat(49), 'Ag==')).toThrow(/48/)
expect(() => colorProtocolID(ID, 'a b', 'Ag==')).toThrow(TypeError)
expect(isColorTopic(`tm_color_${ID}`)).toBe(true); expect(isColorTopic('tm_mandala')).toBe(false)
```

In `constants.test.ts`, add: `MESSAGEBOX === 'mandala-color'`, `TREASURY_BASKET === 'mandala treasury'`, `new TextEncoder().encode(MANDALA_PROFILE_ID).length === 80`, and a source scan over `import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true })` (non-test files) asserting that no source contains `'p mandala'`, `'mandala-tokens'` or `'mandala-payments'`.
- [ ] **Step 2: Run** `npx vitest run src/naming.test.ts src/constants.test.ts`. Expected: FAIL (module missing; the scan finds `FT_PROTOCOL`).
- [ ] **Step 3: Implement.** Mechanically replace `BASKET` → `TREASURY_BASKET` and `FT_PROTOCOL` → `ADMIN_PROTOCOL` at every remaining call site. In `blinding.ts`, make `protocolID` a required parameter of `prepareBlindedPayment` (Task 10 rewrites it). Export `naming.ts` from `index.ts`. Delete `basket.test.ts`.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS (baseline after Task 3 − 3 + new).
- [ ] **Step 5: Commit** `feat(lib)!: 1Color topic/basket/protocol naming, mandala treasury basket, mandala-color box`.

### Task 5: OneColor codec, deploy `req`, F-REQ

**Files:**
- Modify: `lib/src/brc162.ts`, `lib/src/authority.ts` (lock call sites), `lib/src/metadata.ts` (`parseMetadataFromBeef`), `lib/src/__fixtures__/token.ts`, `lib/src/registry.ts` (`REGISTRY_DEPLOY_PAYLOAD`), `lib/src/issuerOps.ts` (minimal: `registerDetails` passes `identityKey: OVERLAY_IDENTITY_KEY`; Task 9 adds the S5 guard), `lib/src/registryRecover.test.ts` (`codec.lock` → `new OneColor().lock`)
- Create: `lib/src/__fixtures__/1color-deploy.json`, `lib/src/brc162.test.ts`
- Possibly modify: `lib/package.json`, `lib/package-lock.json` (repoint `@bsv/templates` to the V1 tarball, Step 0)

**Interfaces:**
- Consumes: `OneColor`, `encodeStrictCbor`, `decodeStrictCbor`, `readOneColorAttributes` (T1 2.2.0, C§1) from `@bsv/templates`; `ATTESTED_PROFILE_ID`, `MANDALA_PROFILE_ID`, `ADMIN_PROTOCOL` (Task 4).
- Produces (C§8.1):
  - `interface DecodedToken { role: 'deploy' | 'authority' | 'value', assetId?: string, amount: bigint, payload?: number[] }`
  - `decodeToken(script: LockingScript | string, txid?: string, vout?: number): DecodedToken | null`. It returns null for a non-token, a malformed token or a non-P2PKH remainder. A deploy's `assetId` is `${txid}_${vout ?? 0}` when `txid` is given. No amount cap.
  - `lockIssuerToken(wallet: WalletInterface, assetId: string | null, amount: bigint, keyID: string, counterparty: string, payload?: number[]): Promise<LockingScript>` (OneColor `lockBRC29` under `ADMIN_PROTOCOL`; it replaces `lockToken`)
  - `mandalaReq(identityKey: string): Record<string, { version: 1, params: Record<string, string> }>`
  - `deployPayload(m: { sym: string, dec: number, label: string, identityKey: string, icon?: { mediaType: string, bytes: number[] }, feeRatePerKb?: number }): number[]`. It validates sym 1..32 and label 1..64 Unicode code points (C§8.1), dec integer 0..18, identityKey a 66-hex lowercase on-curve key, icon mediaType non-empty. It throws `TypeError` otherwise.
  - `parseDeployPayload(payload?: number[]): { sym: string, dec: number, label: string, feeRatePerKb?: number | null, icon?: { mediaType: string, bytes: number[] } } | null`
  - `readDeploy(lockingScript: LockingScript | string, txid: string): { assetId: string, sym?: string, dec: number, label?: string, mandalaKey?: string } | null`. It reads the payload with `readOneColorAttributes(payload)` (never throws). `mandalaKey` is set iff `attrs.payload === 'map'`, `attrs.req.status === 'valid'`, K = `attrs.req.value.get(MANDALA_PROFILE_ID)?.params` is a map whose `identityKey` is a string, and `toHex(attrs.reqBytes) === toHex(encodeStrictCbor(mandalaReq(K)))`. It compares the exact wire span `reqBytes`, never a re-encoding of the decoded value: `encodeStrictCbor` folds an integral float64 into an integer, so a re-encode would call a deploy Mandala that T1, the module and overlay-go all refuse (plan 01 RF2). `dec`/`sym`/`label` come from `attrs.dec`/`attrs.sym` and the map's `label` text. An opaque payload or a malformed `dec` gives `dec: 0` with no sym/label (0162:221, 0207:82-87).
  - Removed from `brc162.ts`: `codec`, `lockToken`, `MAX_SAFE_AMOUNT` (exported), `DeployMetadata` (replaced by the parameter type above).
  - **Transitional:** `decodeValue(script, tokenId?): { tokenId: string, amount: number } | null` stays with today's exact semantics (null above 2^53), reimplemented over `decodeToken` and marked `@deprecated`, so its three callers (`tokens.ts`, `ftCandidates.ts`, `history.ts`) keep compiling. Task 8 migrates `tokens.ts` and the treasury candidates, Task 16 migrates `history.ts` and **deletes `decodeValue`**, and Task 17 asserts its absence. It is the only 2^53 logic left after this task. `registry.ts` `REGISTRY_DEPLOY_PAYLOAD()` encodes `{sym:'KYC', dec:0n, label:'Mandala identity registry'}` directly, with no `req` (the KYC deploy is on `tm_mandala_kyc`, which C§4 does not police).

- [ ] **Step 0: V1 gate.** `ls $VEND/bsv-templates-2.2.0-*.tgz`. If it is missing, **STOP and report `BLOCKED: V1 (templates 2.2.0) not packed`** (C§10 edge T1→LIB-core reader; never re-implement `readOneColorAttributes` locally). If `lib` is still on the V0 2.1.0 tarball, repoint the devDependency and override to V1, restore the peer to `^2.2.0` if Task 1 widened it, run `npm install --ignore-scripts`, and check that `node -e "import('@bsv/templates').then(m => console.log(typeof m.readOneColorAttributes))"` prints `function`. This task's commit then also stages `vendor-ts-stack/`.
- [ ] **Step 1: Check in the F-REQ fixture** `__fixtures__/1color-deploy.json` with members `identityKey` (`02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046`), `sym` `"TUSD"`, `dec` `2`, `label` `"Test Dollar"`, `reqHex` (the C§4 328-byte hex, copied verbatim), `payloadHex` (`a4636465630263726571` + reqHex + `6373796d6454555344656c6162656c6b5465737420446f6c6c6172`), `lockingScriptHex` (`00006d4d6d01` + payloadHex + `7576a914a1d8edf2f9ebd6d2fe4728e0eb3bd369ab78d76a88ac`).
- [ ] **Step 2: Write failing tests** (`brc162.test.ts`):

```ts
expect(Utils.toHex(encodeStrictCbor(mandalaReq(F.identityKey)))).toBe(F.reqHex)               // 328 bytes
expect(Utils.toHex(deployPayload({ sym: 'TUSD', dec: 2, label: 'Test Dollar', identityKey: F.identityKey }))).toBe(F.payloadHex) // 365 bytes
expect(new OneColor().lock(null, 0n, Hash.hash160(Utils.toArray(F.identityKey, 'hex')), Utils.toArray(F.payloadHex, 'hex')).toHex()).toBe(F.lockingScriptHex)
expect(readDeploy(F.lockingScriptHex, TXID)).toEqual({ assetId: `${TXID}_0`, sym: 'TUSD', dec: 2, label: 'Test Dollar', mandalaKey: F.identityKey })
// req with issuer K2 ≠ attested K, an extra third profile, or no req at all ⇒ mandalaKey undefined
// opaque payload [1,2] ⇒ { assetId, dec: 0 }
// float64 version is not Mandala: splice the issuer descriptor's version 01 into float64 1.0 (encodeStrictCbor cannot build this; it folds 1.0 → 1)
const floatHex = F.payloadHex.replace(/6776657273696f6e01(?![\s\S]*6776657273696f6e01)/, '6776657273696f6e' + 'fb3ff0000000000000')
const floatScript = new OneColor().lock(null, 0n, Hash.hash160(Utils.toArray(F.identityKey, 'hex')), Utils.toArray(floatHex, 'hex'))
expect(readDeploy(floatScript, TXID)?.mandalaKey).toBeUndefined()                                // req is 'malformed' to T1 (version not a uint)
const max = new OneColor().lock(ID, MAX_UINT64, PKH).toHex()
expect(decodeToken(max)).toEqual({ role: 'value', assetId: ID, amount: MAX_UINT64 })              // was null under 2^53
expect(decodeToken(new OneColor().lock(ID, 5n, PKH).toHex().replace(/76a914.*$/, '51'))).toBeNull() // non-P2PKH remainder
expect(decodeToken('00')).toBeNull()
for (const bad of [{ dec: 19 }, { sym: '' }, { label: 'x'.repeat(65) }, { identityKey: F.identityKey.toUpperCase() }]) expect(() => deployPayload({ ...OK, ...bad })).toThrow(TypeError)
expect(parseDeployPayload(deployPayload({ ...OK, icon: { mediaType: 'image/png', bytes: [0x89, 0x50] } }))?.icon).toEqual({ mediaType: 'image/png', bytes: [0x89, 0x50] })
```

- [ ] **Step 3: Run** `npx vitest run src/brc162.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Switch `authority.ts` and `__fixtures__/token.ts` to `lockIssuerToken`/`OneColor` with bigint (`MandalaToken.lock(tokenId, amount: bigint, pkh)`). `authorityKeyIdOf` compares `amount === 0n`. `metadata.ts` uses `parseDeployPayload` for `ticker/decimals`.
- [ ] **Step 5: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 6: Commit** `feat(lib)!: OneColor codec, uint64 decode, Mandala deploy req (F-REQ)`.

### Task 6: Attested admission statement (sign/verify) and σI v3 scope

**Files:**
- Create: `lib/src/attestation.ts`, `lib/src/attestation.test.ts`
- Modify: `lib/src/admission.ts` (doc + `fetchAdmission` default topic regex; σI v3 helpers stay for `tm_mandala`), `lib/src/admission.test.ts`, `lib/src/index.ts`

**Interfaces:**
- Consumes: `colorTopic`, `isAssetId` (Task 4).
- Produces (C§3, C§8.1):
  - `interface Attestation { txid: string, outputs: number[], signer: string, signature: string }`
  - `ATTESTATION_PROTOCOL_ID: [2, 'color admission attestation']`, `ATTESTATION_KEY_ID = '1'`
  - `attestationMessage(assetId: string, txid: string, outputs: number[]): string`. It throws `TypeError` on a bad id/txid or on outputs that are empty, unsorted, duplicated or outside uint32.
  - `verifyAttestation(a: Attestation, assetId: string, expectedSigner: string): boolean`. It never throws. It requires `a.signer === expectedSigner` (exact lowercase), canonical outputs and a lowercase strict-DER hex signature. It verifies the SHA-256 digest against `PublicKey.fromString(signer).deriveChild(new PrivateKey(1), '2-color admission attestation-1')`, accepting low- and high-S.
  - `attestationFromSteak(txid: string, assetId: string, steak: Record<string, any>): Attestation | undefined` (entry `steak[colorTopic(assetId)]`; requires string `admissionSignature`/`admissionIdentityKey` and canonical non-empty `outputsToAdmit`)
  - `signAttestation(wallet: WalletInterface, assetId: string, txid: string, outputs: number[]): Promise<string>` (**contract gap G5**, an extension for fixtures and E2E): `createSignature({ data: utf8(message), protocolID: ATTESTATION_PROTOCOL_ID, keyID: '1', counterparty: 'anyone' })` → lowercase DER hex
  - `admission.ts`: `fetchAdmission` default topic picks the first key matching `/^tm_color_[0-9a-f]{64}_0$|^tm_mandala$/`. `verifyFetchedAdmission(entry, expectedSigner)` verifies attested v1 when `isColorTopic(entry.topic)` (assetId = topic minus `tm_color_`), and σI v3 otherwise.

- [ ] **Step 1: Write failing tests** (`attestation.test.ts`), using C.0 (0207:10214-10264):

```ts
const ID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0'
const TX = '05fabadb4a03eb7d5e54713824a483161a82ecc7061b124e99a13e9778131931'
const SIGNER = '02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046'
const LOW = '3045022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be02203eff5870ae5215047d1d624733b29f563d5037660ce5c4ed0ce4ac52cc56758a'
const HIGH = '3046022100d1f48fc13a1ffd18196bcb6166aff936b8dc6cb7b0866fe9226ef1db89fb06be022100c100a78f51adeafb82e29db8cc4d60a87d5ea580a262db4eb2edb23a03dfcbb7'
expect(attestationMessage(ID, TX, [0, 2])).toBe(`1color-admit:v1:tm_color_${ID}:${TX}:0,2`)
expect(Utils.toHex(Hash.sha256(Utils.toArray(attestationMessage(ID, TX, [0, 2]), 'utf8')))).toBe('9f61b417ec979c3c057313fe56f3c6056d2962b6bceaaa8272377bb9a80d8f9d')
expect(PublicKey.fromString(SIGNER).deriveChild(new PrivateKey(1), '2-color admission attestation-1').toString()).toBe('033520aaa77b6914019796e974d1737acc890c5283c0921ddcfc2d5c815db8fb90')
// C§3: every C.0 suite also pins the BRC-42 HMAC tweak
expect(Utils.toHex(Hash.sha256hmac(PublicKey.fromString(SIGNER).deriveSharedSecret(new PrivateKey(1)).encode(true), Utils.toArray('2-color admission attestation-1', 'utf8')))).toBe('6ef21748a4f6f5034842184e25f68e8df8663e036622ad9b3d061c6dd81ea93b')
expect(await signAttestation(new ProtoWallet(new PrivateKey(5555)), ID, TX, [0, 2])).toBe(LOW)   // RFC 6979 reproduces C.0
expect(verifyAttestation({ txid: TX, outputs: [0, 2], signer: SIGNER, signature: LOW }, ID, SIGNER)).toBe(true)
expect(verifyAttestation({ txid: TX, outputs: [0, 2], signer: SIGNER, signature: HIGH }, ID, SIGNER)).toBe(true)
// negatives, each false: outputs [2,0]; outputs [0]; assetId `${TX_OF_ID}_1` (other topic); signature made with keyID '2';
// signature over message + '\n'; signature by the BARE key (new PrivateKey(5555).sign(digest)); expectedSigner = another key;
// signer uppercase; signature uppercase hex
expect(() => attestationMessage(ID, TX, [2, 0])).toThrow(TypeError)
expect(attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: { outputsToAdmit: [0, 2], coinsToRetain: [], admissionSignature: LOW, admissionIdentityKey: SIGNER } })).toEqual({ txid: TX, outputs: [0, 2], signer: SIGNER, signature: LOW })
expect(attestationFromSteak(TX, ID, { [`tm_color_${ID}`]: { outputsToAdmit: [0, 2], coinsToRetain: [] } })).toBeUndefined()
```

In `admission.test.ts`, add: `verifyFetchedAdmission` on an `admitted` entry with `topic: tm_color_<ID>` and the attested LOW signature returns true, and the same entry carrying a σI v3 signature returns false.
- [ ] **Step 2: Run** `npx vitest run src/attestation.test.ts src/admission.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `attestation.ts` (pure, RN-safe, `@bsv/sdk` primitives only) and the `admission.ts` edits. **The C.0 bytes are authoritative.** If `ProtoWallet.createSignature` (SHA-256 of `data`, then RFC 6979) does not reproduce `LOW`, sign the C.0 digest with the derived child private key (`PrivateKey.sign`) instead, keep `signAttestation`'s signature, and report it as a contract gap (overlay-go must then sign the same way). `verifyAttestation` is digest-based, so it is unaffected.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): BRC-207 attested admission statement sign/verify (C.0 vectors)`.

### Task 7: Overlay submit on `tm_color_*`, per-topic verification, S5 fail-closed

**Files:**
- Modify: `lib/src/brc162.ts` (remove `tokenTopic`, `tokenTopicOrEmpty`, `tokenLookup`, `isSigmaTopic`, `deployTopics`), `lib/src/overlay.ts`, `lib/src/constants.ts`, `lib/src/authority.ts` (default topics), `lib/src/issuerOps.ts` (deploy topics inline `[TOPIC, colorTopic(`${txid}_0`)]`), `lib/src/reconcile.ts` (topic use)
- Create: `lib/src/__fixtures__/overlaySigner.ts`
- Test: `lib/src/overlay.test.ts`, `lib/src/reconcile.test.ts`, `lib/src/storage.test.ts`, `lib/src/robustness.recovery.test.ts` (setups)

**Interfaces:**
- Consumes: `attestationFromSteak`, `verifyAttestation` (Task 6); `admissionMessageV3`/`verifyAdmission` (σI v3); `colorTopic`, `isColorTopic`.
- Produces:
  - `submitToOverlay(beef: number[], offChainValues?: number[], facilitator?: OverlayBroadcastFacilitator, topics: string[], expectedSigner?: string /* default OVERLAY_IDENTITY_KEY */): Promise<OverlayAdmitResult>`. It throws `Error(OVERLAY_IDENTITY_KEY_UNSET)` when the effective signer is `''`, **before** `facilitator.send`. `tm_color_*` entries require a verified attestation (missing ⇒ `OverlayRefusedError` `ERR_NO_ADMISSION`, unverifiable/other signer ⇒ `ERR_BAD_ADMISSION`, both retryable). `tm_mandala` requires σI v3 from the bare key. `tm_mandala_kyc` is unsigned. Every color topic and `tm_mandala` must admit ≥1 output. KYC must admit only when it is the sole topic. The primary topic is the first `tm_color_*`, else `topics[0]`.
  - `interface OverlayAdmitResult { topic?: string, outputsToAdmit: number[], admissionSignature?: string, admissionIdentityKey?: string, attestation?: Attestation /* set iff primary is a color topic */ }` (C§8.1 types the result as the raw STEAK; this plan keeps the verified primary result, G8)
  - Facilitator: `x-includes-off-chain-values: true` plus varint framing **iff** `offChainValues` is non-empty (C§6). Otherwise the body is the bare BEEF.
  - `submitAndBroadcast(..., topics)` signature unchanged (it uses the default signer).
  - Fixture `overlaySigner.ts`: `OVERLAY_PRIV = new PrivateKey(5555)`, `OVERLAY_KEY` (C.0 signer), `signedSteak(txid: string, entries: Record<string, number[]>): Promise<Record<string, any>>`. It signs `tm_color_*` with `signAttestation`, `tm_mandala` with σI v3 by the bare key, and leaves `tm_mandala_kyc` unsigned.

- [ ] **Step 1: Write failing tests** (append to `overlay.test.ts`):

```ts
it('submitToOverlay refuses without an identity key (S5)', async () => {
  configureMandala({ overlayUrl: OVERLAY, overlayIdentityKey: '' })
  const f = { send: vi.fn() }
  await expect(submitToOverlay(BEEF, [1], f as any, [colorTopic(ID)])).rejects.toThrow(/overlay identity key is not configured/)
  expect(f.send).not.toHaveBeenCalled()
})
// attested entry ⇒ result.attestation deep-equals { txid, outputs: [0, 1], signer: OVERLAY_KEY, signature }
// σI v3 signature on tm_color_<id> ⇒ rejects { code: 'ERR_BAD_ADMISSION', retryable: true }
// attestation by another key ⇒ ERR_BAD_ADMISSION; entry without signature ⇒ ERR_NO_ADMISSION
// tm_mandala entry carrying an attested-format signature ⇒ ERR_BAD_ADMISSION
// deploy topics [TOPIC, colorTopic(`${txid}_0`)] with tm_mandala admitting [] ⇒ rejects
// facilitator: offChainValues [] ⇒ no x-includes-off-chain-values header and body === beef;
//              [7,8] ⇒ header 'true' and body === [beef.length varint, ...beef, 7, 8]
```

In `brc162.test.ts` / `removedExports.test.ts`, assert that `tokenTopic`, `tokenLookup`, `tokenTopicOrEmpty`, `isSigmaTopic` and `deployTopics` are absent from `index.js`.
- [ ] **Step 2: Run** `npx vitest run src/overlay.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** Update the existing suites that configure only `overlayUrl`: `overlay.test.ts:23`, `reconcile.test.ts:263,570`, `storage.test.ts:219`, `robustness.recovery.test.ts`. They now configure `overlayIdentityKey: OVERLAY_KEY`, and their STEAK fixtures come from `signedSteak`. Old `tm_<txid>` topic literals in tests become `colorTopic(...)`. Retry reasoning: a retryable `ERR_BAD_ADMISSION` keeps the action and journals `retryable` exactly as before (unchanged `submitAndBroadcast` semantics).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib)!: tm_color_* topics, attested STEAK verification, fail closed without overlay key (S5)`.

### Task 8: Envelope codec and treasury primitives

**Files:**
- Modify: `lib/src/encoding.ts`, `lib/src/encoding.test.ts`, `lib/src/authority.ts`, `lib/src/tokens.ts` (drop `revealLinkage`; `decodeBalances` → bigint via `decodeToken`), `lib/src/tokens.test.ts`
- Move (git mv + edit): `ftSelect.ts` → `treasury/select.ts`, `ftCandidates.ts` → `treasury/candidates.ts`, `unlock.ts` → `treasury/unlock.ts`, and their tests (`ftCandidatesBeef.test.ts` merges into `treasury/candidates.test.ts`)
- Create: `lib/src/treasury/linkage.ts`
- Modify callers: `issuerOps.ts`, `assets.ts`, `registry.ts`, `assetRecover.ts`, `registryRecover.ts`

**Interfaces:**
- Produces (C§5.1):
  - `interface SpecificLinkage { prover: string, verifier: string, counterparty: string, protocolID: [2, string], keyID: string, encryptedLinkage: number[], encryptedLinkageProof: number[], proofType: 0 }`
  - `interface MandalaEnvelope { inputs?: Array<{ index: number, linkage: SpecificLinkage }>, outputs?: Array<{ index: number, linkage: SpecificLinkage }>, admin?: Array<{ index: number, details: string }>, deploySig?: string }`
  - `encodeEnvelope(e: MandalaEnvelope): number[]`: UTF-8 JSON. Absent members are omitted, and `inputs`/`outputs`/`admin` are sorted by `index`. Member order inside a linkage is `prover, verifier, counterparty, protocolID, keyID, encryptedLinkage, encryptedLinkageProof, proofType`.
  - `decodeEnvelope(b: number[]): MandalaEnvelope`: strict. It throws `TypeError` on unknown or duplicate-index members, non-integer bytes (0..255), `proofType ≠ 0` or invalid UTF-8.
  - `treasury/select.ts`: `interface TreasuryCandidate { outpoint: string, amount: bigint, keyID: string, counterparty: string, confirmed?: boolean }`, `selectTreasuryInputs(c: TreasuryCandidate[], target: bigint): { selected: TreasuryCandidate[], total: bigint }` (same confirmed-first, fewest-UTXO policy; throws `'insufficient treasury balance'`)
  - `treasury/candidates.ts`: `loadTreasuryCandidates(wallet: WalletInterface, assetId: string, opts?: { requireSpendable?: string }): Promise<{ candidates: TreasuryCandidate[], beef: number[] }>` (basket `TREASURY_BASKET`, value coins of `assetId` via `decodeToken`, frozen exclusion unchanged)
  - `treasury/unlock.ts`: `issuerUnlock(wallet: WalletInterface, keyID: string, counterparty: string)` (ADMIN_PROTOCOL)
  - `treasury/linkage.ts`: `revealIssuerLinkage(wallet: WalletInterface, keyID: string, counterparty: string, verifier?: string): Promise<SpecificLinkage>`. It throws `OVERLAY_IDENTITY_KEY_UNSET` when the verifier is `''`.
  - `authority.ts`: `ValueOut.amount: bigint`; the envelope is built with `encodeEnvelope` and omits `inputs`.
  - Removed: `MandalaLinkagePayload`, `encodeLinkagePayload`, `walletMandalaUnlock`, `selectFtInputs`, `loadFtCandidates`, `FtCandidate`. `tokens.ts` and `treasury/candidates.ts` stop using `decodeValue` (they use `decodeToken` with `role === 'value'` and bigint amounts). `issuerOps.redeemTokens` passes `BigInt(amount)` to `selectTreasuryInputs` until Task 9 makes `amount` a bigint.

- [ ] **Step 1: Write failing tests:**

```ts
// encoding.test.ts
const bytes = encodeEnvelope({ outputs: [{ index: 2, linkage: L2 }, { index: 0, linkage: L0 }] })
expect(JSON.parse(Utils.toUTF8(bytes))).toEqual({ outputs: [{ index: 0, linkage: L0 }, { index: 2, linkage: L2 }] })
expect('inputs' in JSON.parse(Utils.toUTF8(bytes))).toBe(false)
expect(decodeEnvelope(bytes)).toEqual({ outputs: [{ index: 0, linkage: L0 }, { index: 2, linkage: L2 }] })
for (const bad of ['{"outputs":[],"extra":1}', '{"outputs":[{"index":0,"linkage":{...L0,"proofType":1}}]}']) expect(() => decodeEnvelope(utf8(bad))).toThrow(TypeError)
// treasury/select.test.ts — selection total exceeds 2^64 exactly
const c = [{ outpoint: `${T}.0`, amount: MAX_UINT64, keyID: 'a', counterparty: K }, { outpoint: `${T}.1`, amount: MAX_UINT64, keyID: 'b', counterparty: K }]
expect(selectTreasuryInputs(c, MAX_UINT64 + 1n).total).toBe(2n * MAX_UINT64)
expect(() => selectTreasuryInputs(c, 2n * MAX_UINT64 + 1n)).toThrow(/insufficient/)
// fs: existsSync(new URL('./ftSelect.ts', import.meta.url)) === false (also ftCandidates.ts, unlock.ts, ftChange.ts)
```

The moved tests keep their assertions with bigint amounts.
- [ ] **Step 2: Run** `npx vitest run src/encoding.test.ts src/treasury`. Expected: FAIL.
- [ ] **Step 3: Implement** the moves and edits (`git mv` so history follows).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS, with test count unchanged apart from the new cases.
- [ ] **Step 5: Commit** `refactor(lib)!: MandalaEnvelope codec; treasury coin selection/unlock/linkage under mandala admin keys`.

### Task 9: Issuer and admin flows on 1Color

**Files:**
- Modify: `lib/src/issuerOps.ts`, `lib/src/assets.ts`, `lib/src/registry.ts`, `lib/src/feeRate.ts` (types only)
- Test: `lib/src/issuerOps.test.ts` (new; merges `issuerOps.redeem.test.ts`), `lib/src/robustness.recovery.test.ts` (A08/A15 blocks), `lib/src/registry.test.ts`

**Interfaces:**
- Consumes: `deployPayload`, `lockIssuerToken`, `submitAndBroadcast`, `colorTopic`, treasury primitives.
- Produces (C§8.1):
  - `registerAsset(p: { wallet: WalletInterface, identityKey: string, label: string, ticker: string, decimals: number, icon?: { mediaType: string, bytes: number[] }, feeRatePerKb?: number }): Promise<RegisterResult>`. It throws `OVERLAY_IDENTITY_KEY_UNSET` before any wallet call when `OVERLAY_IDENTITY_KEY === ''`. The deploy payload is `deployPayload({ sym, dec, label, identityKey: OVERLAY_IDENTITY_KEY, icon?, feeRatePerKb? })`, and the topics are `[TOPIC, colorTopic(`${txid}_0`)]`. `registerDetails` returns that payload.
  - `issueTokens(p: { wallet, identityKey, asset: AdminAsset, amount: bigint, depositHash?: string }): Promise<IssuerOpResult>`: the minted value goes to `TREASURY_BASKET` under `ADMIN_PROTOCOL`, and its customInstructions are `{"protocolID":[2,"mandala admin"],"keyID":…,"counterparty":…}`.
  - `redeemTokens(p: { wallet, identityKey, asset, amount: bigint, balance?: bigint }): Promise<IssuerOpResult>`
  - `submitAdminAction(p: SubmitAdminActionParams)` with `ftOutput?: { recipient: string, amount: bigint }`. Until Task 12 a provided `ftOutput` throws `Error('reissue builds its recipient output through the payout path')`.
  - `listAdminAssets(wallet)` lists `TREASURY_BASKET`.
  - BRC-100 `description` is 5..50 chars. Every lib-built description goes through `actionDescription(text: string): string` (new in `assets.ts`: trims, truncates to 50 chars with a trailing `…` inside the limit, pads to 5). `Issue ${amount} ${label}` with a 20-digit amount must not make `createAction` reject. Redeem keeps the fixed prefix `Redeem <amount>` so Task 16 can parse it.
- Precondition (record in the commit body; **risk R4**): these txs carry token outputs with no BRC-207 plan. They work only if the console's wallet does not route plan-less token outputs to the color module (toolbox 2.15.0 dispatches on `p color` names only). 0207:1209 says a conforming wallet MUST recognize token-encoded outputs.

- [ ] **Step 1: Write failing tests** (`issuerOps.test.ts`, mock wallet in the style of `robustness.recovery.test.ts`, `submitAndBroadcast` mocked to return a signed result):

```ts
configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: '' })
await expect(registerAsset({ wallet, identityKey: ISSUER, label: 'Test Dollar', ticker: 'tusd', decimals: 2 })).rejects.toThrow(/overlay identity key/)
expect(wallet.createAction).not.toHaveBeenCalled()
configureMandala({ overlayIdentityKey: OVERLAY_KEY })
await registerAsset({ ... })
const out = wallet.createAction.mock.calls[0][0].outputs[0]
expect(readDeploy(out.lockingScript, TXID)?.mandalaKey).toBe(OVERLAY_KEY)
expect(out.basket).toBe('mandala treasury')
expect(submitAndBroadcast.mock.calls[0][5]).toEqual(['tm_mandala', `tm_color_${TXID}_0`])
await issueTokens({ ..., amount: MAX_UINT64 })     // value output decodes amount === MAX_UINT64
await expect(issueTokens({ ..., amount: 0n })).rejects.toThrow(/greater than zero/)
expect(wallet.createAction.mock.calls.at(-1)[0].description.length).toBeLessThanOrEqual(50)   // MAX_UINT64 + 64-char label
expect(actionDescription(`Redeem ${MAX_UINT64} ${'L'.repeat(64)}`)).toMatch(/^Redeem 18446744073709551615 /)
// redeem: change output amount === gathered − amount (bigint); existing redeem cases ported
```

- [ ] **Step 2: Run** `npx vitest run src/issuerOps.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Double-submit reasoning: the existing `mandala.register` web lock, `withAdminAuthGate` and `withIntent` are kept unchanged. The robustness `A08` block (reissue notification) is deleted here and re-created against the payout path in Task 12; list its test names in the commit body.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib)!: issuer register/issue/redeem/admin on 1Color with Mandala req and uint64`.

### Task 10: Recipient linkage (`p color`) and blinding

**Files:**
- Create: `lib/src/linkage.ts`, `lib/src/linkage.test.ts`
- Modify: `lib/src/blinding.ts` (keep math helpers + `rootSharedSecret`; delete `prepareBlindedPayment`, `recipientCustomInstructions`, `changeCustomInstructions`), `lib/src/blinding.test.ts`, `lib/src/blindingJournal.ts`, `lib/src/blindingJournal.test.ts`

**Interfaces:**
- Consumes: `colorProtocolID`, `assertRemittance`, `SpecificLinkage`.
- Produces (C§8.1, C§5.1, B3, D20):
  - `recipientLinkage(wallet: WalletInterface, a: { identityKey: string, recipientKey: string, assetId: string, derivationPrefix: string, derivationSuffix: string, overlayIdentityKey: string, blind: boolean }): Promise<{ pubKeyHash: number[], senderIdentityKey: string, r?: string, linkage: SpecificLinkage }>`. It throws `TypeError` when `recipientKey === identityKey` (self uses owned outputs), `Error(OVERLAY_IDENTITY_KEY_UNSET)` when `overlayIdentityKey === ''`, and `TypeError` on invalid keys or remittances.
    - It computes: invoice `2-<protocol name>-color`. S = `rootSharedSecret(wallet, B)`. When blind: r random, `S′ = S + r·B`, `A′ = A + r·G`. `L = HMAC-SHA256(compressed(S′ or S), utf8(invoice))`, `P = B + L·G`, `pubKeyHash = hash160(P)`. `encryptedLinkage = wallet.encrypt({ plaintext: L, protocolID: [2, 'specific linkage revelation 2 ' + name], keyID: 'color', counterparty: K })`, and the proof is the same call over `[0]`. `linkage = { prover: A, verifier: K, counterparty: B, protocolID, keyID: 'color', …, proofType: 0 }`. `senderIdentityKey` is A′ when blind, else A.
  - `blindingJournal.ts`: `interface BlindingRecord { outpoint: string, r: string, senderBlinded: string, recipient: string, assetId: string, at: number }`; `blindingPut(r: BlindingRecord)`, `blindingGet(outpoint: string)`, `blindingList()`, `blindingClear()`, `blindingReserve(key: string, rec: Omit<BlindingRecord, 'outpoint'>)`, `blindingCommit(key: string, outpoint: string)`, `blindingListReserved()`, `blindingPruneReserved(olderThanMs: number)` (key = `derivationSuffix`)

- [ ] **Step 1: Write failing tests** (`linkage.test.ts`, real `ProtoWallet`s A, B and K, no mocks):

```ts
const res = await recipientLinkage(A, { identityKey: a, recipientKey: b, assetId: ID, derivationPrefix: P, derivationSuffix: S, overlayIdentityKey: k, blind: false })
expect(res.senderIdentityKey).toBe(a); expect(res.r).toBeUndefined()
const { publicKey } = await B.getPublicKey({ protocolID: colorProtocolID(ID, P, S), keyID: 'color', counterparty: a, forSelf: true })
expect(res.pubKeyHash).toEqual(Hash.hash160(Utils.toArray(publicKey, 'hex')))
const blind = await recipientLinkage(A, { ...args, blind: true })
expect(blind.senderIdentityKey).not.toBe(a); expect(blind.linkage.prover).toBe(a); expect(blind.linkage.counterparty).toBe(b)
const own = await B.getPublicKey({ protocolID: colorProtocolID(ID, P, S), keyID: 'color', counterparty: blind.senderIdentityKey, forSelf: true })
expect(blind.pubKeyHash).toEqual(Hash.hash160(Utils.toArray(own.publicKey, 'hex')))      // recipient derives with A′ (plain BRC-42)
// overlay-equivalent (overlay-go linkage.go VerifyKeyLinkage, base = counterparty):
const { plaintext: L } = await K.decrypt({ ciphertext: blind.linkage.encryptedLinkage, protocolID: [2, `specific linkage revelation 2 ${blind.linkage.protocolID[1]}`], keyID: 'color', counterparty: a })
expect(Hash.hash160(PublicKey.fromString(b).add(new PrivateKey(L).toPublicKey()).encode(true))).toEqual(blind.pubKeyHash)
expect(blind.linkage.keyID).toBe('color'); expect(blind.linkage.protocolID[1].startsWith('p color ')).toBe(true)
await expect(recipientLinkage(A, { ...args, recipientKey: a })).rejects.toThrow(/self/)
await expect(recipientLinkage(A, { ...args, overlayIdentityKey: '' })).rejects.toThrow(/overlay identity key/)
await expect(recipientLinkage(A, { ...args, derivationPrefix: 'a'.repeat(49) })).rejects.toThrow(/48/)
```

In `blindingJournal.test.ts`, the records are keyed by outpoint `${txid}.0`, and reserve → commit moves a reservation to its outpoint.
- [ ] **Step 2: Run** `npx vitest run src/linkage.test.ts src/blinding.test.ts src/blindingJournal.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Privacy reasoning: `r` never leaves the sender (it goes only into the journal), and the receipt shows A′. The envelope `prover` is A, and this mismatch is intended (C§5.1).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): p color recipient linkage with blinded counterparty A′ (B3)`.

### Task 11: BRC-207 action plan labels

**Files:**
- Create: `lib/src/plan.ts`, `lib/src/plan.test.ts`

**Interfaces:**
- Produces (C§8.1):
  - `interface ColorPlanV1 { version: 1, assets: string[], ownedOutputs: Array<{ outputIndex: number, assetId: string, derivationPrefix: string, derivationSuffix: string, senderIdentityKey: string }>, operations: Array<{ assetId: string, operation: string }>, inputPositions: [], changePositions: [], sighashTypes: [], profileData?: Record<string, Record<string, unknown>> }`
  - `planLabels(plan: ColorPlanV1): string[]`. It rebuilds the plan in canonical member order (`version, assets, ownedOutputs, operations, inputPositions, changePositions, sighashTypes, profileData?`; remittance members `outputIndex, assetId, derivationPrefix, derivationSuffix, senderIdentityKey`; operation members `assetId, operation`), then serializes it with `JSON.stringify`, as UTF-8 hex chunks of 200 characters: `p color plan <i> <n> <chunk>` (0207:1165-1186). It throws `TypeError` on empty or duplicate `assets` or a plan over 16 MiB.

- [ ] **Step 1: Write failing tests.** Copy the seven A.159 labels from 0207:10056-10062 verbatim into the test:

```ts
const plan = JSON.parse(Utils.toUTF8(Utils.toArray(A159.map(l => l.split(' ')[5]).join(''), 'hex')))
expect(planLabels(plan)).toEqual(A159)
const scrambled = Object.fromEntries(Object.entries(plan).reverse())       // caller order must not matter
expect(planLabels(scrambled as ColorPlanV1)).toEqual(A159)
const big = planLabels({ ...plan, profileData: { 'urn:x:y': { [plan.assets[0]]: { s: 'é'.repeat(300) } } } })
expect(big.slice(0, -1).every(l => l.split(' ')[5].length === 200)).toBe(true)
expect(() => planLabels({ ...plan, assets: [] })).toThrow(TypeError)
```

- [ ] **Step 2: Run** `npx vitest run src/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `plan.ts` and export it from `index.ts`.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): BRC-207 plan label encoder (A.159 vector)`.

### Task 12: Deploy lookup, receipts, issuer payouts (B4), reissue

**Files:**
- Create: `lib/src/overlayLookup.ts`, `lib/src/receipt.ts`, `lib/src/payout.ts`, `lib/src/payout.test.ts`, `lib/src/overlayLookup.test.ts`
- Modify: `lib/src/authority.ts` (`foreignOuts`), `lib/src/assets.ts` (reissue), `lib/src/index.ts`

**Interfaces:**
- Consumes: `recipientLinkage`, `revealIssuerLinkage`, `loadTreasuryCandidates`, `selectTreasuryInputs`, `issuerUnlock`, `submitAndBroadcast`, `encodeEnvelope`, `actionDescription` (Task 9), `notifyPut`/`notifyRemove`, `blindingReserve`/`blindingCommit`, `MESSAGEBOX`.
- Produces:
  - `overlayLookup.ts`: `interface LookupOutputList { type: 'output-list', outputs: Array<{ beef: number[], outputIndex: number, txid: string }> }`, `class LookupError extends Error { name = 'LookupError'; code: string; retryable: boolean; transport: boolean }`, `postLookup(service: string, query: unknown, o?: { url?: string /* default OVERLAY_URL */, fetch?: typeof fetch, timeoutMs?: number /* 15000 */ }): Promise<LookupOutputList>` (C§8.1 positional form; `o` is an extension; `LookupOutputList` is assignable to the sdk `LookupAnswer`; C§6 error mapping), `fetchDeployTx(assetId: string): Promise<Transaction>` (C§8.1). The latter uses `postLookup` with service `colorLookup(id)` and query `{type:'color-admission', version:1, assetId, topic: colorTopic(id), outpoints:[`${txid}.0`]}`. It parses with `Transaction.fromBEEF(beef, txid)` and requires `tx.id('hex') === txid` and output 0 to `decodeToken` as a deploy. It returns the `Transaction` and memoizes only verified answers (the memo stores raw bytes and returns a fresh `Transaction.fromBinary` per call, so a caller mutating the object cannot poison the cache).
  - `receipt.ts`: `interface MessageBoxSender { sendMessage: (a: { recipient: string, messageBox: string, body: object }) => Promise<unknown> }` (structural, shared by payout and hand-over), `type ReceiptInstruction = { version: 1, assetId: string, derivationPrefix: string, derivationSuffix: string, senderIdentityKey: string, profileData: Record<string, unknown> }` (C§8.1). Also `issuerAttestedLeaf(p: { declarationTx: number[] /* (await fetchDeployTx(id)).toBinary() */, attestation: Attestation, offChainValues: number[] }): Record<string, unknown>` → `{ declarationTx: hex, transactions: [], attestations: [attestation], submissions: [{ txid: attestation.txid, offChainValues: hex }] }`, `handoverBody(p: { assetId: string, outputIndex: number, tx: number[], receipt: ReceiptInstruction, note?: string }): object` → `{ v: 3, kind: 'handover', assetId, outputIndex, tx: hex, receipt, note? }` (C§7.2, no `amount`), and `newRemittance(): string` (base64 of 16 random bytes).
  - `payout.ts`: `interface PayoutResult extends AdmissionReceipt { txid: string, receipt: ReceiptInstruction, outputIndex: 0, notified: boolean }` (**contract gap G4**: a payout spends no authority, so `IssuerOpResult` fields do not exist), `payoutTokens(p: { wallet: WalletInterface, identityKey: string, asset: AdminAsset, amount: bigint, recipientKey: string, blind?: boolean /* false */, messageBoxClient: MessageBoxSender, note?: string }): Promise<PayoutResult>`
    - Order (crash and S5 reasoning): (1) S5 and `guardPositiveAmount`, `recipientKey !== identityKey`. (2) `fetchDeployTx`, **before** any coin is held. (3) Candidates and selection. (4) Remittances, plus `blindingReserve` if blind. (5) `createAction`: output 0 = recipient `OneColor.lock(assetId, amount, pkh)`, 1 sat, no basket; output 1 = treasury change when `change > 0n`; `options: { noSend: true, randomizeOutputs: false }`; labels `['mandala', 'payout']`; description `actionDescription(`Payout ${amount} ${asset.label}`)`. (6) `signAction` noSend. (7) Envelope `{ outputs: [{index:0, linkage: recipient}, {index:1, linkage: revealIssuerLinkage(change)}] }`. (8) `submitAndBroadcast(..., [colorTopic(assetId)])`, requiring `result.attestation` with outputs ⊇ [0]. (9) `blindingCommit` to `${txid}.0`. (10) Receipt with `profileData = { [ATTESTED_PROFILE_ID]: { [assetId]: issuerAttestedLeaf(...) } }`. (11) `notifyPut` of the `handoverBody`, then `sendMessage({ recipient, messageBox: MESSAGEBOX, body })`, then `notifyRemove`. A send failure gives `notified: false` (reconcileNotifications retries). The whole flow runs under `tryWithLock('mandala.payout')` and `withIntent`.
  - `authority.ts`: `runAuthorityTx(p & { foreignOuts?: Array<{ lockingScript: string, linkage: SpecificLinkage, outputDescription: string }> })`. Foreign outputs come first (index 0..), then value outs, then authorities.
  - `assets.ts`: `SubmitAdminActionParams` gains `messageBoxClient?: MessageBoxSender` (C§8.1 retained `assets` subpath; required when `ftOutput` is set, else `TypeError` before any wallet call). `submitAdminAction` with `ftOutput` builds the reissue recipient through `recipientLinkage` (blind false, counterparty = `details.recipient`) as `foreignOuts[0]`. After admission it builds and delivers the same receipt and body as a payout through `p.messageBoxClient`, and returns `notified`.

- [ ] **Step 1: Write failing tests** (`payout.test.ts`: mock wallet + real `ProtoWallet` issuer for linkage, `submitAndBroadcast` mocked to return `attestation` from `overlaySigner`, `fetchDeployTx` mocked; `overlayLookup.test.ts`: fake fetch):

```ts
// payout fails closed before listOutputs (S5)
configureMandala({ overlayIdentityKey: '' }); await expect(payoutTokens(P)).rejects.toThrow(/overlay identity key/); expect(wallet.listOutputs).not.toHaveBeenCalled()
const r = await payoutTokens(P)
const args = wallet.createAction.mock.calls[0][0]
expect(decodeToken(args.outputs[0].lockingScript)).toEqual({ role: 'value', assetId: ID, amount: P.amount }); expect(args.outputs[0].satoshis).toBe(1); expect(args.outputs[0].basket).toBeUndefined()
expect(args.outputs[1].basket).toBe('mandala treasury'); expect(args.options).toEqual({ noSend: true, randomizeOutputs: false })
expect(submitAndBroadcast.mock.calls[0][5]).toEqual([`tm_color_${ID}`])
const env = decodeEnvelope(submitAndBroadcast.mock.calls[0][2]); expect(env.outputs![0].linkage.counterparty).toBe(RECIPIENT); expect(env.outputs![0].linkage.prover).toBe(ISSUER)
expect(Object.keys(r.receipt)).toEqual(['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey', 'profileData'])
expect(Object.keys(r.receipt.profileData)).toEqual([ATTESTED_PROFILE_ID])
expect(r.receipt.profileData[ATTESTED_PROFILE_ID][ID]).toEqual({ declarationTx: DEPLOY_HEX, transactions: [], attestations: [ATT], submissions: [{ txid: TXID, offChainValues: Utils.toHex(submitAndBroadcast.mock.calls[0][2]) }] })
const sent = mb.sendMessage.mock.calls[0][0]; expect(sent.messageBox).toBe('mandala-color'); expect(Object.keys(sent.body)).toEqual(['v', 'kind', 'assetId', 'outputIndex', 'tx', 'receipt'])
// the notification is journaled before sendMessage: inside the sendMessage mock, (await notifyList()).map(n => n.txid) contains TXID
// amount MAX_UINT64 against two MAX_UINT64 coins ⇒ change output decodes amount MAX_UINT64
// reissue: submitAdminAction({ ftOutput: { recipient, amount }, messageBoxClient: mb }) ⇒ createAction outputs[0] is the p color recipient output; mb body v:3 sent
// reissue without messageBoxClient ⇒ TypeError, createAction not called
// overlayLookup.test.ts — stale or poisoned cache: an answer whose BEEF tx hashes to another txid ⇒ fetchDeployTx rejects; payoutTokens rejects before createAction
// postLookup: 503 ⇒ LookupError { code:'ERR_UNAVAILABLE', transport:true }; 400 {status:'error',code:'ERR_SHAPE',retryable:false} ⇒ { code:'ERR_SHAPE', transport:false }
```

- [ ] **Step 2: Run** `npx vitest run src/payout.test.ts src/overlayLookup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Double-submit: a second concurrent payout in another tab gets `BusyError`. Retry: the `accepted` journal entry and the notify journal are written before the broadcast and the send (existing commit-point rule).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): issuer payouts and reissues create p color outputs with BRC-207 receipts (B4)`.

### Task 13: Holder hand-over: send, deliver, settle

**Files:**
- Create: `lib/src/handover.ts` (new content), `lib/src/handover.test.ts`
- Modify: `lib/src/txJournal.ts` (stage union and fields), `lib/src/storage.test.ts` (stage literals), `lib/src/reconcile.ts` (minimal: its `'handed_over'` comparisons become `'delivered'` so tsc stays clean; Task 15 rewrites the branch)

**Interfaces:**
- Consumes: `recipientLinkage`, `planLabels`, `colorProtocolID`, `colorTopic`, `submitToOverlay`, `broadcastAcceptedTx`, `isAlreadyBroadcast`, `journal*`, `notify*`, `blindingReserve/Commit`, `handoverBody`, `newRemittance`, `MessageBoxSender`, `ReceiptInstruction` (Task 12), `tryWithLock`, `BusyError`.
- Produces (C§8.1):
  - `JournalEntry.stage`: `'intent' | 'accepted' | 'abort' | 'retryable' | 'stranded' | 'signed' | 'delivered'` (`handed_over` is removed; **contract gap G3**). New optional fields: `assetId`, `recipientKey`, `outputIndex`, `note`, `receipt` (JSON string). `export type HandoverJournalEntry = JournalEntry & { stage: 'signed' | 'delivered', assetId: string, recipientKey: string, outputIndex: number, receipt: string, reference: string, submit: { txHex: string, offChainHex: string, topics: string[] } }` (C§8.1 name). `journalListHandovers(): Promise<HandoverJournalEntry[]>` (signed + delivered).
  - `resubmitDelivered(wallet: WalletInterface, entry: HandoverJournalEntry, overlayIdentityKey: string): Promise<{ status: 'admitted', attestation: Attestation } | { status: 'retry' | 'refused', code: string }>` (C§8.1 types the result `Promise<void>`; the verdict is a superset that void-typed callers ignore, G8): the journal-driven core of `settleHandover` (exact `submit.txHex`/`offChainHex`, same verdict handling), reused by Task 15.
  - `interface HandoverResult { txid: string, tx: number[], reference: string, outputIndex: number, receipt: ReceiptInstruction, offChainValues: number[] }`
  - `sendHandover(p: { wallet: WalletInterface, identityKey: string, assetId: string, amount: bigint, recipientKey: string, blind?: boolean, note?: string, derivationPrefix?: string, derivationSuffix?: string, journal?: boolean /* default true */ }): Promise<HandoverResult>` (C§8.1)
    - Remittances: when both `derivationPrefix` and `derivationSuffix` are given, each passes `assertRemittance` (≤ 48 UTF-8 bytes, no whitespace) and is used verbatim in `colorProtocolID`, the plan and the receipt. A nearby payee binds its session nonces this way (plan 07, `createNonce` output, 44 chars). Exactly one given ⇒ `TypeError('@bsv/mandala: derivationPrefix and derivationSuffix must be given together')`. Neither ⇒ `newRemittance()` for each. All of this is checked before the lock and before any wallet call.
    - Self (`recipientKey === identityKey`, blind forced false): `getPublicKey({ protocolID, keyID: 'color', counterparty: identityKey, forSelf: true })` → pkh. The plan has `ownedOutputs: [{ outputIndex: 0, assetId, derivationPrefix, derivationSuffix, senderIdentityKey: identityKey }]` and no `profileData`.
    - Other recipient: `recipientLinkage` (blind default true). The plan has `ownedOutputs: []` and `profileData: { [MANDALA_PROFILE_ID]: { [assetId]: { outputs: [{ index: 0, linkage }] } } }`.
    - `createAction({ description: note (if 5..50 chars) ?? 'Send Mandala tokens', labels: [...planLabels(plan), 'mandala', 'transfer'], outputs: [{ lockingScript, satoshis: 1, outputDescription: 'Mandala token payment' }], options: { noSend: true, randomizeOutputs: false } })` with `plan = { version: 1, assets: [assetId], ownedOutputs, operations: [{ assetId, operation: 'transfer' }], inputPositions: [], changePositions: [], sighashTypes: [] , profileData? }`.
    - `signAction({ reference, spends: {} })`. `colorHandoff` must be `{ version: 1, txid === result.txid, profileData[ATTESTED_PROFILE_ID][assetId].submissions` containing the tip `}`, otherwise `abortAction({ reference })` and throw `Error('the wallet lacks @bsv/color-permission-module 0.2.0 with the Mandala issuer-v1 profile')`. `offChainValues` = bytes of the tip's `submissions[].offChainValues`. `receipt = { version: 1, assetId, derivationPrefix, derivationSuffix, senderIdentityKey, profileData: colorHandoff.profileData }`.
    - Durability with `journal !== false` (default): `tryWithLock('mandala.send')` (busy ⇒ `BusyError`), then `journalIntentBegin` before `createAction`, then `blindingReserve` before `createAction`. `journalPut({ txid, stage: 'signed', reference, at, assetId, recipientKey, outputIndex: 0, note, receipt: JSON.stringify(receipt), submit: { txHex, offChainHex, topics: [colorTopic(assetId)] } })` and `blindingCommit` are both **awaited before resolving**, and `journalIntentEnd` runs in `finally`.
    - Durability with `journal: false`: the lock and the blinding reserve/commit run as above, but **no txJournal key is written** (no intent marker, no `signed` entry). The caller owns durability. Plan 07 passes it because its `color_transfers` journal plus the module's `handoffEvidence` cover resume, and otherwise every send would leave a `delivered` entry of up to 16 MiB that nothing promotes, clears or redelivers. JSDoc states the precondition: a host using `journal: false` must run `reconcileWallet` with `{ sweep: false }`, because without an intent or `signed` entry the sweep cannot tell this live `noSend` action from an abandoned one. A reused caller suffix overwrites a stale blinding reservation with the same key (a retry of the same payment).
  - `deliverHandover(p: { messageBoxClient: MessageBoxSender, recipientKey: string, handover: Pick<HandoverResult, 'txid' | 'tx' | 'outputIndex' | 'receipt'>, note?: string }): Promise<void>` (C§8.1; plan 07 rebuilds the object without `reference`/`offChainValues`): `assetId = handover.receipt.assetId`. `notifyPut(body)` → `sendMessage` (box `MESSAGEBOX`) → `notifyRemove` → `markHandoverDelivered(txid)`. On a send failure it rethrows; the notify entry stays and the stage stays `signed`.
  - `markHandoverDelivered(txid: string): Promise<void>` (C§8.1): `signed` → `delivered`. Idempotent. With no entry (a `journal: false` send) or any other stage it resolves without writing.
  - `settleHandover(p: { wallet: WalletInterface, handover: Pick<HandoverResult, 'txid' | 'tx' | 'offChainValues'>, assetId: string, overlayIdentityKey: string }): Promise<{ status: 'admitted', attestation: Attestation } | { status: 'retry' | 'refused', code: string }>`. It throws only on S5 (`overlayIdentityKey === ''`). There is one in-flight promise per txid (a concurrent second call returns the same promise). On admitted it writes `journalPut stage 'accepted'` (with σ fields), then `broadcastAcceptedTx` in the background (posted or already-broadcast ⇒ `journalRemove`; per amended D24 a resolved `createAction` whose `sendWithResults` has `{ txid, status: 'failed' }` is not success and keeps the `accepted` entry for retry). A retryable verdict increments `attempts` on the existing entry and never aborts. A final verdict calls `abortAction({ reference })` from the journal entry (on failure: stage `abort`), removes the entry and returns `refused`.

- [ ] **Step 1: Write failing tests** (`handover.test.ts`; wallet mock whose `signAction` returns `{ txid, tx, colorHandoff }` built from a real tx; real `ProtoWallet` for linkage; `submitToOverlay` mocked via `vi.mock('./overlay.js')`):

```ts
const h = await sendHandover({ wallet, identityKey: A, assetId: ID, amount: 5n, recipientKey: B })
const ca = wallet.createAction.mock.calls[0][0]
expect(ca.options).toEqual({ noSend: true, randomizeOutputs: false }); expect(ca.outputs).toHaveLength(1); expect(ca.outputs[0].satoshis).toBe(1)
const plan = decodePlan(ca.labels)   // test helper: concat 'p color plan' chunks → JSON
expect(plan.operations).toEqual([{ assetId: ID, operation: 'transfer' }]); expect(plan.ownedOutputs).toEqual([])
expect(plan.profileData[MANDALA_PROFILE_ID][ID].outputs[0].index).toBe(0)
expect(h.receipt.senderIdentityKey).not.toBe(A)                                 // blinded by default
expect(h.offChainValues).toEqual(Utils.toArray(SUBMISSION_HEX, 'hex'))
expect((await journalList()).find(e => e.txid === h.txid)?.stage).toBe('signed')    // journal entry is durable before sendHandover resolves
// self-send: plan.ownedOutputs[0].senderIdentityKey === A, plan.profileData undefined, getPublicKey called with forSelf: true
// no colorHandoff ⇒ rejects /color-permission-module/, abortAction({ reference }) called, no journal entry
// second concurrent sendHandover rejects BusyError (both started before either resolves)
// caller remittances used verbatim: sendHandover({ ..., derivationPrefix: N1, derivationSuffix: N2 }) (N1, N2 = 44-char base64 nonces)
//   ⇒ h.receipt.derivationPrefix === N1, h.receipt.derivationSuffix === N2, plan leaf linkage.protocolID deep-equals colorProtocolID(ID, N1, N2)
// only derivationPrefix given ⇒ rejects TypeError /together/, createAction not called; a 49-byte suffix ⇒ TypeError /48/; 'a b' ⇒ TypeError
// journal: false writes no txJournal key: storage.keys('mandala.txJournal.') is unchanged by the call (no intent, no signed entry); blindingGet(`${h.txid}.0`) is set
// deliver after journal: false still sends: deliverHandover({ messageBoxClient: mb, recipientKey: B, handover: { txid, tx, outputIndex, receipt } }) resolves, sendMessage called once, journalList() still has no entry
// markHandoverDelivered(unknownTxid) resolves and writes nothing
await deliverHandover({ messageBoxClient: mb, recipientKey: B, handover: h })
expect(mb.sendMessage.mock.calls[0][0].body).toEqual({ v: 3, kind: 'handover', assetId: ID, outputIndex: 0, tx: Utils.toHex(h.tx), receipt: h.receipt })
expect((await journalList()).find(e => e.txid === h.txid)?.stage).toBe('delivered')
// send failure ⇒ rejects, notifyList has the txid, stage still 'signed'
await expect(settleHandover({ wallet, handover: h, assetId: ID, overlayIdentityKey: '' })).rejects.toThrow(/overlay identity key/)
// ERR_FROZEN (retryable) ⇒ { status: 'retry', code: 'ERR_FROZEN' }, abortAction not called
// ERR_CONSERVATION (final) ⇒ { status: 'refused', code: 'ERR_CONSERVATION' }, abortAction({ reference }) called
// admitted ⇒ { status: 'admitted', attestation }, stage 'accepted', wallet.createAction called with options.sendWith [txid]
// D24: createAction resolves with sendWithResults [{ txid, status: 'failed' }] ⇒ entry stays 'accepted', journalRemove not called; a thrown 'already broadcast' ⇒ journalRemove
// concurrent settleHandover submits once: two calls in parallel ⇒ submitToOverlay called once, both resolve equal
```

- [ ] **Step 2: Run** `npx vitest run src/handover.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reasoning to note in the code docs: a crash before `journalPut` leaves a fresh intent, and after the TTL the sweep may abort the undelivered action, which is safe because nobody has the bytes. A crash after `journalPut` leaves `signed`, which is never aborted and is redelivered by Task 15. Hand-over first, submit second: `settleHandover` is never called by `sendHandover`.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): holder hand-over through the color module (send/deliver/settle, journaled)`.

### Task 14: MessageBox receive into BRC-207 receipts

**Files:**
- Create: `lib/src/receive.ts` (new content), `lib/src/receive.test.ts`

**Interfaces:**
- Consumes: `colorBasket`, `decodeToken`, `MESSAGEBOX`, `ATTESTED_PROFILE_ID`, `MANDALA_PROFILE_ID`, `assertRemittance`, `ReceiptInstruction`.
- Produces (C§8.1, C§7.1-7.2):
  - `class InvalidTransferError extends Error { name = 'InvalidTransferError'; code?: string }`
  - `interface MessageBoxLike { listMessages: (a: { messageBox: string, acceptPayments?: boolean }) => Promise<unknown>, acknowledgeMessage: (a: { messageIds: string[] }) => Promise<unknown> }`
  - `parseHandoverBody(body: unknown): { assetId: string, outputIndex: number, tx: number[], receipt: ReceiptInstruction, note?: string }`. It is strict: the members are exactly `v, kind, assetId, outputIndex, tx, receipt, note?`, with `v === 3`, `kind === 'handover'`, assetId Mandala `_0`, uint32 index, even lowercase hex tx. The receipt has exactly 6 members, `version === 1`, `receipt.assetId === assetId`, remittances via `assertRemittance`, a valid `senderIdentityKey`, `profileData[ATTESTED_PROFILE_ID][assetId]` as an object, and no `MANDALA_PROFILE_ID` key (D2). Anything else throws `InvalidTransferError`.
  - `receiveHandovers(p: { wallet: WalletInterface, messageBoxClient: MessageBoxLike, assetId?: string, processed?: Set<string> }): Promise<{ accepted: Array<{ messageId: string, txid: string, assetId: string, amount: bigint, outputIndex: number, offline: boolean }>, failed: Array<{ messageId: string, error: unknown, code?: string }> }>`
    - Per message: parse. Then decode `tx` output `outputIndex` (value role, same assetId, `satoshis === 1`), else `InvalidTransferError`. Then `internalizeAction({ tx, description: note (5..50) ?? 'Receive Mandala tokens', labels: ['mandala', 'receive'], outputs: [{ outputIndex, protocol: 'basket insertion', insertionRemittance: { basket: colorBasket(assetId), customInstructions: JSON.stringify(receipt) } }] })`. Then `acknowledgeMessage`. `offline` is true iff `listOutputs({ basket: 'p color assets', includeTags: true, include: 'locking scripts', limit: 1000 })` returns the outpoint `${txid}.${outputIndex}` and its `tags` include `color_offline`. Only the `p color assets` selector carries the module's **view** tag (stored tag AND not settled, plan 02 Task 9); a direct `colorBasket(assetId)` listing returns the stored tag and would report a settled output as offline. One read per `receiveHandovers` call, after the internalizes, shared by every accepted message.
    - Classification of an internalize error `e` (the message is matched because names may not survive BRC-100 substrates; contract gap G13). `code = /\((ERR_[A-Z_]+)(, retryable)?\)/.exec(String(e?.message))`. **Acknowledge** (definitive) when: `InvalidTransferError`; a code without `, retryable` among `ERR_CONSERVATION|ERR_LINKAGE|ERR_SHAPE|ERR_SATOSHIS|ERR_INPUT_SPENT|ERR_EVICTED|ERR_AUTHORITY`; or `e.name` / message naming `AttestationEvidenceError` or `ProfileDataError`. **Declined consent** (`ColorConsentDeclinedError`, C§7.2): not acknowledged, and the message id **stays** in `processed`, so the same session does not prompt for it again (a new session, or a fresh `processed` set, retries it). **Leave unacknowledged** (`processed.delete`): everything else, including retryable verdicts, transport, `UnsupportedProfileError` and `ProfileParamsError`. Name matching follows D22: `e.name`, then the `'[<ClassName>] '` message prefix, then the `(ERR_` code.

- [ ] **Step 1: Write failing tests** (`receive.test.ts`):

```ts
// v2 body ⇒ failed[0].error.name === 'InvalidTransferError', acknowledgeMessage called, internalizeAction not called
// body with an extra 'amount' member ⇒ invalid; receipt carrying a MANDALA_PROFILE_ID leaf ⇒ invalid; missing attested leaf ⇒ invalid; prefix of 49 bytes ⇒ invalid
const r = await receiveHandovers({ wallet, messageBoxClient: mb })
expect(wallet.internalizeAction.mock.calls[0][0].outputs[0]).toEqual({ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: `p color ${assetTag(ID)}`, customInstructions: JSON.stringify(RECEIPT) } })
expect(r.accepted[0]).toEqual({ messageId: 'm1', txid: TXID, assetId: ID, amount: 5n, outputIndex: 0, offline: false })
expect(mb.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['m1'] })
// retryable verdict leaves the message unacknowledged: internalize rejects Error('mandala overlay refused (ERR_FROZEN, retryable): frozen') ⇒ not acked, failed[0].code === 'ERR_FROZEN', processed.has('m1') === false
// '(ERR_CONSERVATION)' ⇒ acked, code 'ERR_CONSERVATION'; error named 'AttestationEvidenceError' ⇒ acked; Error('fetch failed') ⇒ not acked
// offline: listOutputs({ basket: 'p color assets', includeTags: true, ... }) returns { outpoint: `${TXID}.0`, tags: ['color_offline'] } ⇒ offline true;
//   same outpoint with tags [] ⇒ offline false; listOutputs never called with basket colorBasket(ID)
// declined consent stays processed: internalize rejects { name: 'ColorConsentDeclinedError' } ⇒ not acked, processed.has('m1') === true,
//   a second receiveHandovers with the same Set ⇒ internalizeAction not called again; an Error('[ColorConsentDeclinedError] declined') without name ⇒ same
// processed dedup: two parallel calls sharing one Set ⇒ internalizeAction called once
```

- [ ] **Step 2: Run** `npx vitest run src/receive.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Retry reasoning: acknowledging only after internalize resolves makes a crash between internalize and ack a replay, and the module receipt path is idempotent (0207 A.83).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): receive Mandala hand-overs as BRC-207 receipts (v3 box, strict parse)`.

### Task 15: Reconcile and notification redelivery for hand-overs

**Files:**
- Modify: `lib/src/reconcile.ts`, `lib/src/notifyJournal.ts`, `lib/src/reconcile.test.ts`, `lib/src/robustness.recovery.test.ts`

**Interfaces:**
- Consumes: `settleHandover` internals (shared helper `resubmitDelivered(wallet, entry, overlayIdentityKey)` exported from `handover.ts`), `handoverBody`, `journalListHandovers`.
- Produces:
  - `reconcileWallet(wallet, opts?: ReconcileOptions)`: keeps `ReconcileOptions { sweep?: boolean }` unchanged (C§8.1; the app passes `{ sweep: false }`, plan 05 A9). It deletes the `handed_over` branch. `signed` entries are never submitted, aborted or swept, and are counted in `ReconcileResult.handoversAwaitingDelivery: number`. `delivered` entries are resubmitted with exact journaled bytes and `[colorTopic(assetId)]` and verified against `OVERLAY_IDENTITY_KEY`. Admitted ⇒ `accepted` + broadcast. Retryable ⇒ `attempts+1`, then `stranded` at `RETRY_CAP` (never aborted). Final ⇒ abort + drop. The bulk sweep is skipped while any `signed` or `delivered` entry exists. Without an identity key (S5), the `delivered` processing is skipped with one `console.warn`.
  - `reconcileNotifications(messageBoxClient)`: after a successful resend of a `mandala-color` body whose txid has a `signed` entry, the entry is promoted to `delivered`. It also redelivers every `signed` entry older than 60 000 ms that has no pending notification, with `handoverBody` rebuilt from the journal (duplicate delivery is harmless: the receipt path is idempotent).

- [ ] **Step 1: Write failing tests:**

```ts
// a 'signed' entry: reconcileWallet ⇒ no submit, no abortAction, sweep not run, result.handoversAwaitingDelivery === 1
// a 'delivered' entry + ERR_FROZEN ⇒ entry kept with attempts 1, abortAction not called; at RETRY_CAP ⇒ stage 'stranded'
// a 'delivered' entry + ERR_CONSERVATION ⇒ abortAction({ reference }) and entry removed
// a 'delivered' entry + admitted ⇒ stage 'accepted' then createAction({ options: { sendWith: [txid] } })
// reconcileNotifications: a 'signed' entry aged 61 s without a notification ⇒ sendMessage body.v === 3 and stage 'delivered'; aged 10 s ⇒ not sent
// overlayIdentityKey '' ⇒ the 'delivered' entry is untouched and submit is not called
```

Delete the old `handed_over` cases (list their names in the commit body).
- [ ] **Step 2: Run** `npx vitest run src/reconcile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Multi-tab: the existing cross-tab reconcile lock covers the new branches.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): reconcile signed/delivered hand-overs; redeliver undelivered hand-overs`.

### Task 16: bigint read paths

**Files:**
- Modify: `lib/src/brc162.ts` (delete `decodeValue`), `lib/src/history.ts` (holder scope), `lib/src/adminHistory.ts`, `lib/src/adminState.ts`, `lib/src/overlayActivity.ts`, `lib/src/metadata.ts`, `lib/src/contacts.ts`, `lib/src/reconcileBans.ts`, `lib/src/assetRecover.ts`, `lib/src/registryRecover.ts`, and their tests

**Interfaces:**
- Consumes: `parseDecimalAmount`, `decodeToken`, `formatAmount`.
- Produces: `decodeValue` is deleted from `brc162.ts` (its last caller, `history.ts`, moves to `decodeToken`). `HistoryRow.amount: bigint`.
  - `loadHistory(wallet: WalletInterface, o?: { scope?: 'treasury' | 'holder' | 'all' /* default 'all' */, assetId?: string }): Promise<HistoryRow[]>` (C§8.1; the positional `assetId` parameter is replaced by `o.assetId`). One `listActions({ labels: ['mandala'], labelQueryMode: 'any', includeLabels: true, includeOutputs: true, includeOutputLockingScripts: true, limit: 1000 })` serves every scope, and rows are filtered by kind. It never lists a `p color` basket (that would prompt the holder for `color_access`).
    - **treasury** kinds (issue/redeem/payout/reissue/register/admin): as today, joined with `listOutputs({ basket: TREASURY_BASKET, includeCustomInstructions: true })` for customInstructions. That listing runs only when the scope includes treasury. The redeem amount comes from the description's fixed prefix `/^Redeem (\d+)/` via `parseAmount(m[1], 0)`, never from the trailing label.
    - **holder** kinds from the labels: `transfer` ⇒ `direction: 'sent'`, `receive` ⇒ `direction: 'received'`. The amount is the decoded `p color` value output: for a send, the sum of the asset's value outputs that carry no `basket` (the recipient; the module's token change carries `p color <assetTag>`), falling back to output 0 when that set is empty (a listing without baskets, or a self-send whose output 0 is an owned `p color` output; lib hand-overs use `randomizeOutputs: false` with the recipient at 0). For a receive, the sum of the asset's value outputs whose `basket` starts with `'p color '`. `assetId` comes from `decodeToken`. `counterparty` is the receipt `senderIdentityKey` from the output's custody customInstructions when the listing carries it, else `''`. An action whose outputs decode no value of one asset is skipped with one `console.warn` per call. `AdminHistoryRow.delta: bigint`, `describeAction(d, delta?: bigint)`; `AssetAdminStateView.frozenOutpoints[].amount: bigint`; `ActivityEntry.amount: bigint`; CSV exports print `bigint.toString()`. A JSON row whose amount field is not a canonical decimal string is **dropped** with one `console.warn` per call (never coerced).

- [ ] **Step 1: Write failing tests** (extend the existing files):

```ts
// adminHistory: body row { delta: '18446744073709551615' } ⇒ row.delta === MAX_UINT64; { delta: '-5' } ⇒ -5n; { delta: 5 } ⇒ row dropped
// adminState: frozenOutpoints[0].amount '42' ⇒ 42n; overlayActivity: amount '7' ⇒ 7n, describeActivity ⇒ 'Transferred 7 units'
// history: an issue action whose minted output decodes MAX_UINT64 ⇒ row.amount === MAX_UINT64; exportTransactionsCsv contains '18446744073709551615'
// metadata.parseMetadataFromBeef of the F-REQ deploy ⇒ { label: 'Test Dollar', ticker: 'TUSD', decimals: 2 }
// history holder scope, one send and one receive (scripts from new OneColor().lock(ID, n, pkh)):
//   send action { labels: ['mandala','transfer'], outputs: [{ outputIndex: 0, lockingScript: lock(ID, 400n) }, { outputIndex: 1, basket: `p color ${assetTag(ID)}`, lockingScript: lock(ID, 600n) }] }
//   receive action { labels: ['mandala','receive'], outputs: [{ outputIndex: 0, basket: `p color ${assetTag(ID)}`, lockingScript: lock(ID, 250n) }] }
//   loadHistory(wallet, { scope: 'holder' }) ⇒ [{ direction: 'sent', kind: 'transfer', amount: 400n, assetId: ID }, { direction: 'received', kind: 'receive', amount: 250n, assetId: ID }] (toMatchObject)
//   listActions called with labels ['mandala'], labelQueryMode 'any'; listOutputs not called for scope 'holder'
//   scope 'treasury' drops both holder rows; default scope returns treasury and holder rows
```

- [ ] **Step 2: Run** the affected test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib)!: decimal-string amounts on every overlay read path`.

### Task 17: Client facade, export surface, README

**Files:**
- Modify: `lib/src/index.ts`, `lib/src/index.test.ts`, `lib/src/removedExports.test.ts`, `lib/README.md`
- Create: `lib/src/robustness.wiring.test.ts` (source invariants that plan 05 removes from `app/src/robustness.wiring.test.ts`, C§8.1)

**Interfaces:**
- Produces (C§8.1):
  - `interface MandalaClientOptions extends MandalaEndpoints { wallet?: WalletInterface }`
  - `createMandalaClient(o?: MandalaClientOptions): MandalaClient` with `send(a: { assetId: string, counterparty: string, amount: bigint, note?: string, blind?: boolean }): Promise<{ handover: HandoverResult, notified: boolean, settle?: Awaited<ReturnType<typeof settleHandover>> }>`. `send` calls `sendHandover`. For a non-self recipient it then calls `deliverHandover` (failure ⇒ `notified: false`, the redelivery covers it). If delivered, or if self, it calls `settleHandover` with `OVERLAY_IDENTITY_KEY` in a try/catch that never throws (a settle error leaves `settle` undefined). The rest of the client: `receive(a?: { assetId?: string })` → `receiveHandovers` (long-lived `processed` set), `payout(a)` → `payoutTokens`, `admin`, `register`, `issue` (`amount: bigint`), `redeem` (`amount: bigint`), `assets`, `reconcile`, `identityKey`, `wallet`.
  - `index.ts` exports every C§8.1 name, including the types `HandoverJournalEntry`, `MessageBoxSender`, `MessageBoxLike`, `ReceiptInstruction`, `HandoverResult`, `PayoutResult`. It never exports `./profile*`. The retained subpaths (`history`, `metadata`, `adminState`, `adminHistory`, `overlayActivity`, `banking`, `submitGuards`, `singleFlight`, `adminAuthGate`, `contacts`, `contactsStore`, `registry`, `reconcile`, `notifyJournal`, `feeRate`, `assetRecover`, `assets`) resolve through the existing `./*` export map. The removed `ftSelect`/`ftChange`/`ftCandidates`/`unlock` subpaths no longer exist in `dist/`.

- [ ] **Step 1: Write failing tests:**

```ts
// removedExports.test.ts — full C§8.1 removal list absent:
it.each(['FT_PROTOCOL','BASKET','MAX_SAFE_AMOUNT','tokenTopic','tokenLookup','tokenTopicOrEmpty','isSigmaTopic','deployTopics','decodeValue','lockToken','transferTokens','receiveTokens','defaultSettle','cover','canonicalBundleId','collectHandoverEvidence','journalEvidenceSource','encodeLinkagePayload','selectFtInputs','loadFtCandidates','walletMandalaUnlock','formatAmountPlain','createMandalaProfile'])('%s absent', n => expect(n in mod).toBe(false))
// presence list:
it.each(['TOPIC','LOOKUP','REGISTRY_TOPIC','REGISTRY_LOOKUP','MESSAGEBOX','ATTESTED_PROFILE_ID','MANDALA_PROFILE_ID','TREASURY_BASKET','ADMIN_PROTOCOL','actionDescription','signAttestation','postLookup','LookupError','fetchDeployTx','loadHistory','markHandoverDelivered','journalListHandovers','resubmitDelivered','submitToOverlay','colorTopic','colorLookup','assetTag','colorProtocolID','colorBasket','configureMandala','MAX_UINT64','formatAmount','parseAmount','mandalaReq','deployPayload','readDeploy','decodeToken','attestationMessage','verifyAttestation','attestationFromSteak','admissionMessageV3','verifyAdmission','payloadHash','fetchAdmission','encodeEnvelope','decodeEnvelope','recipientLinkage','planLabels','sendHandover','deliverHandover','settleHandover','receiveHandovers','parseHandoverBody','registerAsset','issueTokens','payoutTokens','redeemTokens','submitAdminAction','listAdminAssets','createMandalaClient'])('%s present', n => expect(mod[n]).toBeDefined())
// index.test.ts: client.send to self skips deliverHandover and calls settleHandover; deliver failure ⇒ notified false and send still resolves; settle throwing ⇒ send resolves with settle undefined
```

`robustness.wiring.test.ts` (lib) ports each lib-source `it` of the app file onto the new file layout, one `it` each: (1) `issuerOps.ts` and `assets.ts` use `withAdminAuthGate` and `assertSpendablePrior`, and in `redeemTokens` the prior assertion precedes the treasury BEEF load (`treasury/candidates.ts` replaces `ftCandidates.ts`); (2) `registry.ts` contains `recoverRegistryAuth`, `registryFlight.run`, `nextRegistryPlan`, `runAuthorityTx`; (3) `reconcile.ts` keeps accepted rebroadcast first, `tryWithLock('mandala.reconcile'`, `RETRY_CAP`, `ABORT_RETRY_CAP`, `BROADCAST_RETRY_CAP`, `stage: 'stranded'`, and its sweep block condition names `'signed'` and `'delivered'` besides `'accepted'` and fresh `'intent'`; (4) `txJournal.ts` stage union is exactly `'intent' | 'accepted' | 'abort' | 'retryable' | 'stranded' | 'signed' | 'delivered'`, has no `handed_over`, and keeps the `'mandala.txJournal.'` per-entry prefix; (5) `handover.ts` has `journalIntentBegin` and `tryWithLock('mandala.send'`, `payout.ts` has `tryWithLock('mandala.payout'` and `withIntent(`, `issuerOps.ts` has `tryWithLock('mandala.register'` and ≥ 3 `withIntent(`, `adminAuthGate.ts` has ``tryWithLock(`mandala.admin.``; (6) `receive.ts` calls `acknowledgeMessage` after `internalizeAction` (index order) and uses `InvalidTransferError`; (7) in `handover.ts`, `payout.ts` and `assets.ts`, `notifyPut(` precedes `messageBoxClient.sendMessage` and `notifyRemove(` is present; (8) `submitGlobalAdminAction` keeps `withAdminAuthGates(`, `withIntent(`, `spendableBeef(`; (9) D3c: `txJournal.ts`, `notifyJournal.ts`, `blindingJournal.ts` persist only via `getStorage()` from `./storage.js` with no memory mirror, and `constants.ts` calls `configureStorage(endpoints.storage)`; (10) D3c: the `'accepted'` `journalPut` in `overlay.ts` is awaited before `broadcastAcceptedTx`, and every journal call site in `overlay.ts`, `handover.ts`, `payout.ts`, `assets.ts`, `reconcile.ts`, `notifyJournal.ts` is awaited (site count ≥ the number measured when the test is written; record it in the commit body).

- [ ] **Step 2: Run** `npx vitest run src/removedExports.test.ts src/index.test.ts src/robustness.wiring.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Rewrite the README (usage for console issuer flows, holder send/receive through a BRC-207 wallet, the `@bsv/mandala/profile` registration snippet from C§8.2, vendoring note, breaking changes).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib)!: 0.5.0 client facade and export surface`.

### Task 18: Profile entry bring-up and the Mandala overlay provider

**Files:**
- Modify: `lib/package.json`, `lib/package-lock.json`, `lib/src/packageManifest.test.ts`
- Create: `lib/src/profileProvider.ts`, `lib/src/profileProvider.test.ts`, `lib/src/coreIsolation.test.ts`, `lib/src/profileParity.test.ts`

**Interfaces:**
- Consumes: `postLookup`, `LookupError` (Task 12), `colorLookup`, `colorTopic`; from the module: `ColorOverlayProvider`, `AttestedSTEAK`, `ColorProviderError`, `ColorPlan`, `colorProtocolID as moduleColorProtocolID`, `assetBasket`, `colorTopic as moduleColorTopic`, `attestationMessage as moduleAttestationMessage`, `verifyAttestation as moduleVerifyAttestation`.
- Produces: `createMandalaOverlayProvider(o: { url: string, identityKey: string, fetch?: typeof fetch, timeoutMs?: number }): ColorOverlayProvider & { readonly url: string, readonly identityKey: string }` (C§8.2).
  - `spendability`/`admission(assetId, outpoints)`: outpoints must be 1..1000, unique and canonical dot form (else `TypeError`, no fetch). The call is POST `${url}/lookup` with `{ service: colorLookup(assetId), query: { type: 'color-spendability' | 'color-admission', version: 1, assetId, topic: colorTopic(assetId), outpoints } }`, and the answer must be an `output-list` whose entries all carry `beef`, `outputIndex` and `txid`.
  - `submit(topics, beef, offChainValues?)` POSTs `/submit` with C§6 framing and returns the parsed STEAK object.
  - Errors are `ColorProviderError(code, retryable, transport, message)`: fetch failure, timeout (AbortController, default 15000 ms), non-JSON or 5xx give `('ERR_UNAVAILABLE', true, true)`. A typed 4xx/409/410 gives `(body.code, body.retryable, false)`. The final `.message` is exactly `[ColorProviderError] mandala overlay refused (${code}${retryable ? ', retryable' : ''}): ${description}` (C§6, C§2.4 prefix rule). If the module's constructor already adds the `'[ColorProviderError] '` prefix, pass the unprefixed text; never double it (G13: receive-side classification parses the code).

- [ ] **Step 0: Gate.** `ls $VEND/bsv-color-permission-module-0.2.0-*.tgz $VEND/bsv-wallet-toolbox-client-2.15.0-*.tgz`. If either is missing, **STOP: `BLOCKED: V2 tarballs (T2) not packed`**. Add both as devDependencies (`file:`) with `overrides`, run `npm install --ignore-scripts`, and require `npm ls @bsv/sdk` to show one version. Then `grep -c "createAttestedProfile\|ColorProviderError\|ProfileParamsError\|ProfileDataError\|AttestationEvidenceError" node_modules/@bsv/color-permission-module/dist/index.d.mts`. Each name must be present; otherwise **STOP: `BLOCKED: T2 0.2.0 lacks <names>`** (never stub module types locally).
- [ ] **Step 1: Write failing tests:**

```ts
// coreIsolation.test.ts — every non-test source under src/ whose basename does not start with 'profile' has no '@bsv/color-permission-module'; index.ts has no "./profile"
// profileParity.test.ts — planLabels(plan) deep-equals ColorPlan.toLabels(plan) for a sendHandover-shaped plan (ownedOutputs, profileData);
//   colorProtocolID/colorBasket/colorTopic equal the module's; lib verifyAttestation and the module's agree on C.0 LOW/HIGH and the six negatives
// profileProvider.test.ts
const f = fakeFetch(200, { type: 'output-list', outputs: [{ beef: [1], outputIndex: 0, txid: TXID }] })
await p.spendability(ID, [`${TXID}.0`])
expect(JSON.parse(f.calls[0].init.body)).toEqual({ service: `ls_color_${ID}`, query: { type: 'color-spendability', version: 1, assetId: ID, topic: `tm_color_${ID}`, outpoints: [`${TXID}.0`] } })
await expect(p.admission(ID, [`${TXID}_0`])).rejects.toThrow(TypeError)                  // no fetch
// 503 ⇒ rejects { name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', retryable: true, transport: true }
// 400 { status:'error', code:'ERR_CONSERVATION', retryable:false, description:'d' } ⇒ { code:'ERR_CONSERVATION', retryable:false, transport:false }, message === '[ColorProviderError] mandala overlay refused (ERR_CONSERVATION): d'
// 409 ERR_FROZEN retryable ⇒ message contains '(ERR_FROZEN, retryable)' and starts with '[ColorProviderError] ' exactly once; fetch throws ⇒ transport; never-resolving fetch with timeoutMs 10 ⇒ transport
// answer entry without txid ⇒ ERR_UNAVAILABLE transport; submit([], beef, []) ⇒ no 'x-includes-off-chain-values'; submit(.., [9]) ⇒ header 'true', varint framing
```

`packageManifest.test.ts` also asserts that the two new devDeps are `file:` specs with overrides.
- [ ] **Step 2: Run** `npx vitest run src/profileProvider.test.ts src/coreIsolation.test.ts src/profileParity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `profileProvider.ts`.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): Mandala overlay ColorOverlayProvider for @bsv/mandala/profile`.

### Task 19: issuer-v1 handler shell, routing, S5, and the profile document

**Files:**
- Create: `lib/src/profile.ts`, `lib/src/profile.test.ts`, `docs/profiles/issuer-v1.md`

**Interfaces:**
- Consumes: `createMandalaOverlayProvider`; module types `RequiredProfileHandler`, `ProfileDescriptor`, `ProfileParamsError`.
- Produces (C§8.2):
  - `interface MandalaProfileOptions { overlays: Array<{ identityKey: string, url: string }>, fetch?: typeof fetch, timeoutMs?: number }`
  - `createMandalaProfile(o: MandalaProfileOptions): RequiredProfileHandler` with `id = MANDALA_PROFILE_ID`, `versions = [1]`, `sendPolicy = 'plain-nosend'`, `operations = ['transfer']`, `maxReceiptBytes = 16_777_216`. The constructor throws `TypeError` on an invalid or duplicate overlay key or an empty url. `export { MANDALA_PROFILE_ID }`.
  - `checkDescriptor(descriptor, req)`: `version === 1`; params must be a map with exactly `{ identityKey: K }` (K is a 66-hex lowercase on-curve string); `req.size === 2`; `req.get(ATTESTED_PROFILE_ID)` must be `{ version: 1, params: exactly { trustMode: 'identity', identityKey: K } }`. Anything else throws `ProfileParamsError`.
  - `provider(assetId, descriptor)`: returns the memoized provider for K (the same object on every call). An unconfigured K throws `ProfileParamsError('no Mandala overlay configured for <K>')` (S5). `deployProviders()` returns all memoized providers in configuration order.
  - `docs/profiles/issuer-v1.md` sections, in order: `## Identifier and version`; `## Parameters` (DAG-CBOR `{identityKey: text}`, exact); `## Companion requirement` (attested v1, identity mode, same K, `req` exactly these two entries; F-REQ diagnostic); `## Replaced procedure` (baseline receipt admission 0207:126-141 and 0207:1476-1481, replaced for receipts only); `## Credit rule` (online: own submit and a verified attestation by K covering the output; transport failure only: attested offline evidence plus `color_receive_offline` consent ⇒ `color_offline`; any typed verdict ⇒ no credit; D6, D7); `## Operations and transaction shape` (transfer only, holder I==O, one Mandala asset per tx, 1-sat token outputs); `## Send policy` (plain noSend hand-over, no BRC-177, token change inside the tx, sender submits only after acknowledgement); `## Submission data` (C§5.1 envelope bytes, C§5.2 plan leaf schema and checks, carriage in attested `submissions`, required non-empty, C42); `## ext state` (none, own entry must be absent); `## Service configuration` (the overlay URL is wallet configuration, params carry only K, 0207 A.21; fail closed without an endpoint); `## Failure behaviour` (error names table); `## Security notes` (receipt `senderIdentityKey` A′ vs envelope `prover` A is intended; S1 via the attested frontier validator).

- [ ] **Step 1: Write failing tests** (`profile.test.ts`; `req` built as a `Map` from `decodeStrictCbor(F.reqHex)` with versions converted to numbers):

```ts
const h = createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }] })
expect(h.id).toBe(MANDALA_PROFILE_ID); expect(new TextEncoder().encode(h.id).length).toBe(80)
expect(h.versions).toEqual([1]); expect(h.sendPolicy).toBe('plain-nosend'); expect(h.operations).toEqual(['transfer']); expect(h.maxReceiptBytes).toBe(16777216)
expect((h as any).checkExt).toBeUndefined(); expect((h as any).checkReceiptData).toBeUndefined()   // own ext and receipt leaf rejected by T2's generic rule (G7)
expect(() => h.checkDescriptor(REQ.get(MANDALA_PROFILE_ID)!, REQ)).not.toThrow()
// each ⇒ throws with name 'ProfileParamsError': attested trustMode 'any'; attested identityKey ≠ K; issuer params with an extra member;
//   req with a third profile; attested entry missing; issuer identityKey uppercase
expect(h.provider!(ID, REQ.get(MANDALA_PROFILE_ID)!)).toBe(h.provider!(ID, REQ.get(MANDALA_PROFILE_ID)!))
// provider for an unconfigured key throws ProfileParamsError (S5): createMandalaProfile({ overlays: [] }).provider(ID, desc) ⇒ name 'ProfileParamsError', /no Mandala overlay configured/
expect(h.deployProviders!().map(p => (p as any).url)).toEqual(['https://o'])
const doc = readFileSync(fileURLToPath(new URL('../../docs/profiles/issuer-v1.md', import.meta.url)), 'utf8')
for (const s of [MANDALA_PROFILE_ID, '0207:126-141', '0207:1476-1481', '## Parameters', '## Credit rule', '## Submission data', '## Failure behaviour']) expect(doc).toContain(s)
```

- [ ] **Step 2: Run** `npx vitest run src/profile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `profile.ts` and write the doc.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): Mandala issuer-v1 required-profile handler (descriptor, routing, S5) + profile doc`.

### Task 20: `checkPlanData` and `submissionData` (B1)

**Files:**
- Create: `lib/src/profilePlanData.ts`, `lib/src/profilePlanData.test.ts`
- Modify: `lib/src/profile.ts` (wire hooks)

**Interfaces:**
- Consumes: module types `ProfileAssetContext`, `ProfileTxView`, `JsonValue`, `ProfileDataError`, `ProfileParamsError`; lib `decodeEnvelope`, `encodeEnvelope`, `colorProtocolID`, `assetTag`, `decodeToken`.
- Produces:
  - `checkPlanData(ctx: ProfileAssetContext, leaf: JsonValue | undefined, view: ProfileTxView): Promise<void>`. Rules (C§5.2): non-owned token outputs = `view.outputs` with `custody === undefined`. The leaf must be exactly `{ outputs: [...] }` whose indices equal that set (no extra, no missing). Each linkage must have exactly 8 members, `verifier === K`, `prover === ctx.identityKey`, `keyID === 'color'`, a protocolID that is a valid `p color <assetTag(ctx.assetId)> <hex> <hex>` name (≤ 280 chars, remittances ≤ 48 bytes), `proofType === 0`, and byte arrays of 1..1024 integers 0..255. If the leaf is absent and at least one non-owned output exists, it throws `ProfileDataError`. **When `view.tx` is set** (signAction), it also checks:
    - (a) every output of this asset has 1 sat (`ProfileParamsError`);
    - (b) no input or output token of any other asset is present (D1, `ProfileParamsError`);
    - (c) linkage-script binding: `ctx.wallet.decrypt({ ciphertext: encryptedLinkage, protocolID: [2, 'specific linkage revelation 2 ' + name], keyID: 'color', counterparty: K })` → L, and `hash160(counterparty + L·G)` must equal the output's P2PKH hash, else `ProfileDataError('linkage does not match output <i>')`.
  - The ENVELOPE seam fixture (C§10) that freezes these bytes for overlay-go is generated in Task 22 (G14); this task's tests are the unit-level check.
  - `submissionData(ctx: ProfileAssetContext, view: ProfileTxView): Promise<number[]>`: leaf entries ∪ owned entries. For each `view.outputs[i]` with `custody`: `ctx.wallet.revealSpecificKeyLinkage({ counterparty: custody.senderIdentityKey, verifier: K, protocolID: colorProtocolID(custody.assetId, custody.derivationPrefix, custody.derivationSuffix), keyID: 'color' })` mapped to `{ prover: result.prover, verifier: K, counterparty: ctx.identityKey /* owner: overlay base key, contract gap G9 */, protocolID, keyID: 'color', encryptedLinkage, encryptedLinkageProof, proofType: 0 }`. It returns `encodeEnvelope({ outputs: sorted })`, and throws `ProfileDataError` if any token output is uncovered or the result would be empty.

- [ ] **Step 1: Write failing tests** (real `ProtoWallet`s A (ctx.wallet, ctx.identityKey), B, K; output 0 from `recipientLinkage` (blinded), output 1 = A's own change locked to `A.getPublicKey({ protocolID, keyID: 'color', counterparty: a, forSelf: true })`, custody `{ assetId: ID, derivationPrefix, derivationSuffix, senderIdentityKey: a }`):

```ts
await expect(checkPlanData(ctx, LEAF, viewAtCreate)).resolves.toBeUndefined()
await expect(checkPlanData(ctx, LEAF, viewAtSign)).resolves.toBeUndefined()
it.each([['extra index 1'], ['missing leaf'], ['verifier ≠ K'], ['prover ≠ A'], ["keyID 'x'"], ['other asset tag'], ['proofType 1'], ['empty encryptedLinkage'], ['1025-byte encryptedLinkage'], ["unknown member 'foo'"]])('%s ⇒ ProfileDataError', async c => { await expect(checkPlanData(ctx, mutate(LEAF, c), viewAtSign)).rejects.toMatchObject({ name: 'ProfileDataError' }) })
// checkPlanData rejects a leaf whose linkage does not derive the output's pubkey hash: viewAtSign with output 0 relocked to another pkh ⇒ ProfileDataError /linkage does not match output 0/
// output 0 with 2 satoshis ⇒ ProfileParamsError; tx carrying another asset's token output ⇒ ProfileParamsError
const env = decodeEnvelope(await submissionData(ctx, { ...viewAtSign, planLeaf: LEAF }))
expect(env.outputs!.map(o => o.index)).toEqual([0, 1]); expect(env.outputs![1].linkage.counterparty).toBe(a); expect('inputs' in env).toBe(false)
// overlay-equivalent: K.decrypt(env.outputs[1].linkage.encryptedLinkage, counterparty: a) ⇒ L; hash160(A + L·G) === output 1 pkh
```

- [ ] **Step 2: Run** `npx vitest run src/profilePlanData.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire into `createMandalaProfile` (`checkPlanData`, `submissionData`).
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): issuer-v1 plan-data checks and owner-linkage submission data (B1)`.

### Task 21: `admitReceipt` (goal 4, D6, D7)

**Files:**
- Create: `lib/src/profileReceipt.ts`, `lib/src/profileReceipt.test.ts`, `lib/src/profileHopCheck.ts`, `lib/src/profileHopCheck.test.ts`
- Modify: `lib/src/profile.ts`

**Interfaces:**
- Consumes: `ReceiptGraph` (C§2.2: `tip` is always present with `{ txid, atomicBEEF, offChainValues }`), `ReceiptAdmission`, `AttestationEvidenceError`, `ProfileDataError`, `ColorProviderError` (by `.name`/`.transport`); lib `attestationFromSteak`, `verifyAttestation`, `colorTopic`, `decodeToken`, `decodeEnvelope`; `readOneColorAttributes` (`@bsv/templates`).
- Produces: `admitReceipt(ctx: ProfileAssetContext, graph: ReceiptGraph, provider: (k: string) => ColorOverlayProvider): Promise<ReceiptAdmission>` (wired as `admitReceipt: (ctx, g) => admitReceipt(ctx, g, providerFor)`).
  - The submit list is `graph.pending` (parents first, tip last), or `[graph.tip]` when `pending` is empty (an already-attested tip is still resubmitted, idempotent, so a freeze or eviction since its attestation is seen; C§7.1, D7). Any entry whose `offChainValues` is empty throws `ProfileDataError` (C42). It submits in order: `submit([colorTopic(assetId)], atomicBEEF, offChainValues)`. Any non-transport error is rethrown (no credit, D6). Each STEAK must yield `attestationFromSteak` + `verifyAttestation(…, K)`, else `AttestationEvidenceError('overlay admitted without a verifiable attestation')`. The verified attestations for `graph.tip.txid` (from this run and from `graph.attestations`) must cover every `graph.outputIndexes`, else `AttestationEvidenceError`. It returns `{ status: 'admitted', attestations }`.
  - **Transport failure** (`transport === true`) stops submitting. Before it returns `{ status: 'unavailable' }` it runs `checkOfflineHops(ctx, hops, K)` over `pending ∪ [tip]`, deduplicated by txid, and lets its `ProfileDataError` propagate (no credit). Only a policy-clean graph returns `unavailable`, which lets the module apply attested offline acceptance (C§4 local hop checks, design goal 4).
  - `profileHopCheck.ts`: `checkOfflineHops(ctx: ProfileAssetContext, hops: Array<{ txid: string, atomicBEEF: number[], offChainValues: number[] }>, K: string): void`. It throws `ProfileDataError('hop <txid>: <reason>')` on the first failure. Per hop:
    1. `Transaction.fromAtomicBEEF(atomicBEEF)` with `id('hex') === txid`. Every input needs `sourceTransaction` (missing ⇒ error, fail closed); its source output is read with `decodeToken(script, sourceTxid, vout)`. Σin and Σout are bigint sums over value tokens of `ctx.assetId`. Σin must equal Σout (no implicit burn, no mint) unless some input decodes as `role: 'authority'` of `ctx.assetId`.
    2. Every token output of `ctx.assetId` (value and authority) has exactly 1 satoshi.
    3. No input or output token of another asset, including a deploy output (`role: 'deploy'` names its own new asset) (D1).
    4. No non-deploy token output payload with `req` or `ext`: `readOneColorAttributes(payload)` with `payload === 'map'` and `req.status !== 'absent' || ext.status !== 'absent'` ⇒ error.
    5. `decodeEnvelope(offChainValues)` (a `TypeError` becomes `ProfileDataError`). Its `outputs` indices, sorted, deep-equal the sorted token-output indices of `ctx.assetId` (value and authority, the overlay's rNoLinkage set). Every linkage has `verifier === K` and `keyID === 'color'`.

- [ ] **Step 1: Write failing tests** (fake provider object, attestations from `overlaySigner`):

```ts
const r = await admitReceipt(ctx, GRAPH2 /* parent, tip */, () => prov)
expect(prov.submit.mock.calls.map(c => c[0])).toEqual([[`tm_color_${ID}`], [`tm_color_${ID}`]])
expect(prov.submit.mock.calls.map(c => c[1])).toEqual([PARENT_BEEF, TIP_BEEF]); expect(prov.submit.mock.calls[1][2]).toEqual(TIP_OFFCHAIN)
expect(r).toEqual({ status: 'admitted', attestations: [ATT_PARENT, ATT_TIP] })
// first submit throws ColorProviderError transport ⇒ { status: 'unavailable' } and one submit only (GRAPH2 hops are policy-clean)
// typed retryable verdict refuses credit: ColorProviderError('ERR_FROZEN', true, false, 'mandala overlay refused (ERR_FROZEN, retryable): x') ⇒ rejects, message contains '(ERR_FROZEN, retryable)'
// ERR_CONSERVATION typed ⇒ rejects
// STEAK attestation signed by another key ⇒ rejects { name: 'AttestationEvidenceError' }
// tip attestation covers [0] but graph.outputIndexes [0, 1] ⇒ AttestationEvidenceError
// pending [] (attested tip) ⇒ submit called once with [`tm_color_${ID}`], graph.tip.atomicBEEF, graph.tip.offChainValues; verified ⇒ admitted
// pending [] and the tip resubmit answers ERR_FROZEN typed ⇒ rejects (no credit even though graph.attestations cover the tip, D6)
// pending [] and transport failure ⇒ hop checks run on the tip ⇒ { status: 'unavailable' }
// unconfigured K ⇒ rejects { name: 'ProfileParamsError' }, submit not called (S5)
// pending entry with offChainValues [] ⇒ ProfileDataError
// offline burn hop ⇒ ProfileDataError: transport failure, tip spends a 10-unit coin into one 9-unit output (no authority input) ⇒ rejects { name: 'ProfileDataError' }, /does not conserve/
// offline 2-sat hop ⇒ ProfileDataError: transport failure, tip token output 0 carries 2 satoshis ⇒ /1 satoshi/
// offline envelope missing an output ⇒ ProfileDataError: transport failure, tip has token outputs [0, 1] but its envelope covers only [0]
// (profileHopCheck.test.ts) a second asset's token output, a non-deploy output whose payload map carries req, a linkage with verifier ≠ K,
//   keyID 'x', and an input without sourceTransaction each throw ProfileDataError; a conserving 1-sat hop with a full envelope passes;
//   a hop spending an authority input of the asset may mint (Σout > Σin) and passes
```

- [ ] **Step 2: Run** `npx vitest run src/profileReceipt.test.ts src/profileHopCheck.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and wire into the handler.
- [ ] **Step 4: Run** the full suite and tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lib): issuer-v1 admitReceipt: own submit, verified attestation, transport-only offline with local hop checks (D6/D7)`.

### Task 22: Integration with the real color module (S1, S4, S5, unsupported wallet) and the ENVELOPE seam fixture

**Files:**
- Create: `lib/src/__fixtures__/fakeWallet.ts`, `lib/src/__fixtures__/fakeMandalaOverlay.ts`, `lib/src/profile.integration.test.ts`, `lib/src/__fixtures__/1color-envelope.json`, `lib/src/envelopeFixture.test.ts`

**Interfaces:**
- Consumes: `createColorModule`, `createAttestedProfile` (module), `WalletPermissionsManager` (`@bsv/wallet-toolbox-client`), lib `createMandalaProfile`, `registerAsset`, `issueTokens`, `payoutTokens`, `sendHandover`, `receiveHandovers`, `signAttestation`, `encodeEnvelope`.
- Produces (test-only):
  - `FakeWallet` (underlying BRC-100 wallet over `ProtoWallet`): getPublicKey, createSignature, verifySignature, encrypt, decrypt, revealSpecificKeyLinkage, revealCounterpartyKeyLinkage, createHmac, listOutputs (basket, tags with `tagQueryMode`, include `'entire transactions'`/`'locking scripts'`, customInstructions, specOp inventory), listActions (minimal), createAction/signAction/abortAction (two-phase, script-verified, `noSend` held, `sendWith` marks sent; satoshi funding comes from a synthetic, unproven funding tx per wallet, so its AtomicBEEF carries no BUMPs), internalizeAction (basket insertion with tags), getNetwork, getVersion, isAuthenticated. It is written fresh in the lib (the pattern mirrors the module's test fixtures; nothing is imported from T2 `src`). It also provides `memoryColorStore(): ColorModuleStore`.
  - `fakeMandalaOverlay({ priv: PrivateKey }): { fetch: typeof fetch, offline: boolean, refuse(code: string, status: number, retryable: boolean): void, admitted: Set<string> }`. `/submit` parses the framing, requires the envelope to cover every token output of the topic asset, and requires transfers to conserve (Σin = Σout, bigint); otherwise it answers 400 ERR_CONSERVATION/ERR_LINKAGE. It signs the attestation with `signAttestation` and σI v3 for `tm_mandala`. `/lookup` answers `color-spendability`/`color-admission` with `txid`. `offline` makes fetch throw `TypeError('fetch failed')`. `submissions: Array<{ topics: string[], beef: number[], offChainValues: number[], steak: Record<string, any> }>` records every accepted `/submit` in order (used by the fixture regeneration below).
- Scenarios (one `it` each; holders use `new WalletPermissionsManager(fake, 'admin.test', { permissionModules: { color } })`; the issuer uses a bare `FakeWallet` with `configureMandala({ overlayUrl, overlayIdentityKey: K })` and `globalThis.fetch` stubbed to the fake overlay):
  1. **Unsupported wallet:** a module registered with only `createAttestedProfile()`, internalizing a payout receipt, rejects with name `UnsupportedProfileError`, and `p color balance` stays empty (0207 A.148).
  2. **Online payout receive:** `payoutTokens` → `receiveHandovers` on holder B ⇒ `accepted[0].offline === false`, and the balance equals the amount.
  3. **Offline hand-over then settle:** B `sendHandover` to C, the overlay goes offline, C `receiveHandovers` ⇒ `offline === true`, and a consent prompt of type `color_receive_offline` was shown. The overlay comes back, and `color.settle()` on C ⇒ the result `admitted` and the output is no longer tagged `color_offline`.
  4. **S1 forged mint (unanchored, policy-clean):** take scenario 3's receipt. Fabricate a grandparent G′ whose output 0 is a 1-sat value token of the asset owned by B (never submitted, never attested), and a parent P′ that spends G′.0 into one 1-sat output of the same amount with a full envelope (so P′ conserves and passes every Task 21 local hop check). Insert P′ into `transactions` and `submissions` (G′ only inside P′'s AtomicBEEF, not in `transactions`), rewire the tip input to P′.0 and re-sign it as B. C's internalize with the overlay offline rejects with name `AttestationEvidenceError` (T2's frontier validator: G′.0 is anchored by no attestation), and there is no credit. A forgery that does not conserve is now caught one layer earlier by the lib's hop checks (`ProfileDataError`, Task 21), so this scenario is shaped to reach T2's validator and keep S1 pinned there.
  5. **D6:** the overlay refuses `ERR_FROZEN` (409, retryable). C's internalize rejects, there is no credit and no `color_offline` output.
  6. **S5:** C's module with `createMandalaProfile({ overlays: [] })`: internalize rejects with name `ProfileParamsError`, and there is no credit.
  7. **Offline policy breach (layer order):** the non-conserving forgery (a fabricated parent that creates value with no token inputs, rewired as the tip's input) with the overlay offline: C's internalize rejects with name `ProfileDataError` (Task 21 hop checks, before T2's validator), C's `p color balance` is unchanged, and no output is tagged `color_offline`.
- **ENVELOPE seam fixture** (C§10 must-pass; plan 03 copies the file unchanged to `overlay-go/internal/mandala/testdata/1color-envelope.json` and replays it in `TestTSEnvelopeAdmitted`, expecting `outputsToAdmit [0,1]` for the hand-over). It is generated here, not in Task 20, because a chain overlay-go can admit needs real lib-built deploy, issue and payout txs that link by txid, satoshi funding, the payout's overlay-first attestation, and the module's `submissionData` for the owned change. Only this task has all of them.
  - Keys (deterministic): issuer `PrivateKey(1111)` (bare `FakeWallet`), holder `PrivateKey(2222)` (module-hosting), hand-over recipient `PrivateKey(3333)`, overlay K `PrivateKey(5555)` (= the C.0 signer `02798b81…124046`, so the deploy `req` is byte-equal to F-REQ's). Remittances, blinding `r` and the BRC-2 IVs are random, so only the keys are deterministic: the bytes are generated once, committed, and then frozen.
  - Flow: `registerAsset({ label: 'Test Dollar', ticker: 'TUSD', decimals: 2 })` → `issueTokens(1500n)` → `payoutTokens({ amount: 1000n, recipientKey: holder, blind: false })` (treasury change 500) → holder `sendHandover({ amount: 400n, recipientKey: 3333, derivationPrefix: 'AQ==', derivationSuffix: 'Ag==' })` (blind default true; output 0 = blinded recipient, output 1 = owned change 600). The hand-over bytes are `h.tx` and `h.offChainValues` (recipient linkage from `recipientLinkage`, owned linkage from the handler's `submissionData`), taken before any submit.
  - File schema (fixed; JSON, lowercase hex, amounts as decimal strings per C§0): `{ version: 1, keys: { issuer, holder, recipient, overlay } /* 66-hex pubkeys */, privateKeys: { issuer: 1111, holder: 2222, recipient: 3333, overlay: 5555 }, assetId, amounts: { issue: '1500', payout: '1000', handover: '400', handoverChange: '600' }, txs: Array<{ name: 'deploy' | 'issue' | 'payout' | 'handover', txid, topics: string[], rawTxHex, atomicBeefHex, offChainValuesHex, outputsToAdmit: Record<string, number[]> }> }`. Deploy, issue and payout come from `overlay.submissions` (their exact submitted bytes and the STEAK `outputsToAdmit`). The hand-over entry has `topics: ['tm_color_<assetId>']` and `outputsToAdmit: { 'tm_color_<assetId>': [0, 1] }`. All four entries carry `offChainValuesHex`, since overlay-go needs the issuer envelopes (admin details, deploySig, linkages) to admit the chain before the hand-over.
  - Regeneration: a `describe.skipIf(!process.env.MANDALA_REGEN_ENVELOPE)('envelope fixture regeneration')` block in `profile.integration.test.ts` writes the file. Run it once, commit the file, then never regenerate unless the C§5 envelope format changes; any regeneration must be reported to P-GO, who re-copies the file.
  - Always-on `envelopeFixture.test.ts` (`envelope fixture is self-consistent`): each `atomicBeefHex` parses with `Transaction.fromAtomicBEEF`, its subject id equals `txid`, and `toHex()` equals `rawTxHex`; the chain links by txid (issue spends a deploy-tx output, payout spends issue outputs, the hand-over input 0 spends payout output 0); every `offChainValuesHex` passes `decodeEnvelope`; the hand-over envelope `outputs` indices are `[0, 1]`, output 0 has `prover === keys.holder` and `counterparty === keys.recipient` (the real keys, although the receipt shows the blinded A′; C§5.1), output 1 has `counterparty === keys.holder` (G9); for every hand-over and payout linkage, `new ProtoWallet(new PrivateKey(5555)).decrypt({ ciphertext: encryptedLinkage, protocolID: [2, 'specific linkage revelation 2 ' + protocolID[1]], keyID: 'color', counterparty: prover })` yields L and `hash160(counterparty + L·G)` equals that output's P2PKH hash (the overlay's linkage.go rule); hand-over outputs decode as 400n and 600n of `assetId` with 1 sat each; `checkOfflineHops` passes on the hand-over hop with K = keys.overlay; `readDeploy(deploy output 0).mandalaKey === keys.overlay`.

- [ ] **Step 0: Gate:** Task 18 Step 0 passed (V2 present).
- [ ] **Step 1: Write the fixtures, the seven failing scenarios, the regeneration block and `envelopeFixture.test.ts`.**
- [ ] **Step 2: Run** `npx vitest run src/profile.integration.test.ts src/envelopeFixture.test.ts`. Expected: the scenarios FAIL until the handler is wired (the fixture test fails: file missing). If they already pass, check that each scenario's assertions really run.
- [ ] **Step 3: Fix lib code only.** If a failure's stack is inside `node_modules/@bsv/color-permission-module`, do **not** patch, stub or skip it. Stop and report `BLOCKED: upstream T2 defect` with the scenario name, the stack and the minimal repro, and leave the test failing on the branch for the T2 owner.
- [ ] **Step 4: Generate the seam fixture.** `cd $LIB && MANDALA_REGEN_ENVELOPE=1 npx vitest run src/profile.integration.test.ts -t "envelope fixture regeneration"`, then `npx vitest run src/envelopeFixture.test.ts`. Expected: PASS, and `git -C $WT status --porcelain -- lib/src/__fixtures__/1color-envelope.json` shows the new file.
- [ ] **Step 5: Run** the full suite and tsc. Expected: PASS (regeneration skipped).
- [ ] **Step 6: Commit** `test(lib): issuer-v1 profile end to end with @bsv/color-permission-module (S1/S4/S5) + 1color-envelope seam fixture`. The commit body lists the fixture's four txids and says that plan 03 must copy the file byte for byte.

### Task 23: Final gate, peer restore, lib tarball (V3), optional E2E (the envelope seam is the must-pass)

**Files:**
- Modify: `lib/package.json` (restore `@bsv/templates` peer `^2.2.0` if Task 1 widened it; repoint devDeps to the newest T1/T2 tarballs if re-packed)
- Create: `lib/src/e2e.overlay-go.test.ts`, `vendor-ts-stack/bsv-mandala-0.5.0-<sha>.tgz`

**Interfaces:**
- Consumes: everything above.
- Produces: `bsv-mandala-0.5.0-<mandala short sha>.tgz` for P-APP, P-DESK and P-WAL (C§9).

- [ ] **Step 1: Write the E2E test** `e2e.overlay-go.test.ts` with `describe.skipIf(!process.env.MANDALA_E2E_OVERLAY_URL)`. It reads `MANDALA_E2E_OVERLAY_URL` and `MANDALA_E2E_OVERLAY_KEY`, then runs register → issue → payout → recipient `admitReceipt` (`createMandalaProfile` against the live URL) → holder `sendHandover` → recipient receive → sender `settleHandover`. It asserts every attestation verifies under the configured key, and every amount round-trips as bigint (one payout of `MAX_UINT64 - 1n` after issuing `MAX_UINT64`).
- [ ] **Step 2: Run** `cd $LIB && npx vitest run src/envelopeFixture.test.ts` first (the C§10 must-pass seam; a failure here stops the task), then `npx vitest run && npx tsc --noEmit && npm run build`. Expected: all green, E2E skipped, `dist/` built. Then run `grep -l "color-permission-module" dist/*.js | grep -v '/profile'`. Expected: no output (the core dist never imports the module).
- [ ] **Step 3: Optional live E2E.** Only if P-GO reports overlay-go ready, and a local overlay-go with Mongo runs on `:8081` under a fresh `NODE_NAME`, run with the env set. Record the result in the commit body. Never wipe existing state.
- [ ] **Step 4: Pack.** `cd $LIB && npm pack --pack-destination ../vendor-ts-stack`, then rename the output to `bsv-mandala-0.5.0-$(git -C $WT rev-parse --short=7 HEAD).tgz`. Run `tar -tzf` on it and check that it contains `package/dist/index.js` and `package/dist/profile.js` and no `src/`.
- [ ] **Step 5: Commit** `chore(lib): @bsv/mandala 0.5.0 gate + vendored tarball` (include the final test counts against the Task 1 baseline).

---

## Contract gaps (recorded decisions)

Revision 2 of the contract closed G1, G2, G3, G4, G5 and G6: each is now contract text, and the plan follows it. The entries stay so the history is readable.

- **G1** (closed, C§8.1 `ADMIN_PROTOCOL`) Issuer/treasury/authority/deploy/registry/payout-change derivation is `ADMIN_PROTOCOL [2,'mandala admin']` (Task 4).
- **G2** (closed, C§2.2 `ReceiptGraph.tip`, C§7.1) The tip and its `offChainValues` are always in the graph. When `pending` is empty, `admitReceipt` resubmits the tip (D7) instead of trusting the stored attestation alone (Task 21).
- **G3** (closed, C§8.1 journal stages) `signed` → `delivered` replaces `handed_over`, and `markHandoverDelivered(txid)` serves external transports (Task 13).
- **G4** (closed, C§8.1 `PayoutResult`) (Task 12).
- **G5** (closed, C§8.1 `signAttestation`) (Task 6).
- **G6** (closed, C§8.1 `formatAmount`) Plain and exact, no grouping. `formatAmountPlain` is removed, `formatAmountGrouped`/`formatCurrency` are kept as bigint, and `parseDecimalAmount` is added (Task 3).
- **G7** The contract (C§2.2) now lists `checkExt`/`checkReceiptData`. Issuer-v1 defines neither, so its own `ext` entry and any receipt leaf are rejected by T2's generic rule (D2). Task 19 pins both `undefined`.
- **G8** Shapes that intentionally differ from C§8.1. No consumer plan (03, 05, 06, 07) calls any of them, so each keeps the richer shape the lib's internals need, and the morning review can force exact conformance:
  - `submitToOverlay(...)` resolves to the verified `OverlayAdmitResult` (primary topic plus `attestation`), not the raw STEAK record. Every per-topic STEAK entry is still verified before it resolves (Task 7).
  - `resubmitDelivered(...)` resolves to the settle verdict instead of `void`. Void-typed callers compile unchanged (Task 13).
  - Conformed in this revision: `postLookup(service, query, o?)` (positional, plus an optional transport bag), `fetchDeployTx(assetId): Promise<Transaction>`, `journalListHandovers(): Promise<HandoverJournalEntry[]>` (Tasks 12, 13).
- **G9** Owned-output envelope `counterparty` = owner (`ctx.identityKey`), not the `revealSpecificKeyLinkage` result's counterparty (overlay base key, linkage.go; C§5.1) (Task 20).
- **G10** D1 can only be enforced at `signAction` (`view.tx`). createAction views are per asset (Task 20). The offline receipt path re-checks D1 per hop (Task 21).
- **G11** `registerAsset.feeRatePerKb?` and `redeemTokens.balance?` kept as optional extensions.
- **G12** Profile errors imported from the module as values (Task 18 gate checks the exports).
- **G13** Error classification over BRC-100 substrates: `.name`, then the `'[ClassName] '` prefix, then the `(ERR_X[, retryable])` code set by the Mandala provider (Tasks 14, 18; C§2.4, C§6).
- **G14** The ENVELOPE seam fixture is generated in Task 22, not Task 20, and has **four** txs (deploy, issue, payout, hand-over), not three. The lib has no single-tx issue-to-holder path (issue mints into the treasury, payout moves value to the holder), and only Task 22 has real signing wallets, funding, the payout attestation and the module's `submissionData`. Only keys are deterministic; the committed bytes are frozen.
- **G15** `sendHandover({ journal: false })` writes no txJournal key at all (no intent marker, no `signed` entry), so the lib test "no txJournal key" holds. The lock and the blinding journal still run. Precondition (JSDoc): a host that passes `journal: false` runs `reconcileWallet` with `{ sweep: false }` (Task 13).
- **G16** `loadHistory(wallet, { scope, assetId? })`: `assetId` moves from a positional parameter into the options bag (extension). The holder send amount is the asset's value outputs without a basket (fallback: output 0), and the receive amount is the asset's value outputs in a `p color` basket (Task 16).
- **G17** A `ColorConsentDeclinedError` receipt stays in `processed` (no re-prompt in the same session) and is not acknowledged (C§7.2, Task 14).
- **G18** Offline hop checks (C§4) are implemented in the lib handler (`profileHopCheck.ts`) and run only on the transport-failure path. A missing input `sourceTransaction` in a hop's AtomicBEEF fails closed (Task 21).

### Risks

- **R1** FakeWallet funding is synthetic and unproven, so the fixture's AtomicBEEFs carry no BUMPs. Plan 03's `TestTSEnvelopeAdmitted` must run the engine with a permissive chain tracker and must configure the issuer key as trusted and the holder/recipient keys as KYC members where its policy needs them. This is flagged for plan 03, not solved here.
- **R4** Issuer, admin and payout txs carry token outputs with no BRC-207 plan (Task 9 precondition).
- **R5** Templates V1 is a hard gate for Task 5. If P-T1 is late, LIB-core stops after Task 4 with `BLOCKED: V1`.
- **R6** (Task 12 review, deferred to Task 15) Receipt inputs of an issuer payout or reissue are not durable before admission. `derivationPrefix`, `derivationSuffix`, `senderIdentityKey` (A′ when blinded), `recipientKey`, `outputIndex`, `note` and the deploy `declarationTx` live only in memory until `deliverIssuerReceipt` journals the finished v3 body (`notifyPut`). The retryable-refusal path is closed in Task 12: `submitAndBroadcast(..., { holdRetryable: false })` aborts on ERR_PAUSED/ERR_FROZEN instead of journaling `'retryable'`, so no receipt-bearing tx is ever re-POSTed by reconcile. What remains is a crash after `submitAndBroadcast` resolves and before `notifyPut` lands: the tx is admitted and broadcast, but its recipient output cannot be derived. That window is a few local storage writes and is narrower than the background broadcast. To close it, Task 15 should write a pre-submit notify-journal entry keyed by txid with `pending: true` and `{ assetId, recipientKey, outputIndex, derivationPrefix, derivationSuffix, senderIdentityKey, note?, declarationTxHex, txHex, offChainHex, topics }`. `notifyPut` warns instead of throwing, so this write needs a throwing variant that fails the payout before submit. The entry is removed on refusal or abort and overwritten by the final body after admission. `reconcileNotifications` must skip `pending` entries. The completion step rebuilds the attestation from the `'accepted'` txJournal entry (`admissionSignature`, `admissionIdentityKey`, `outputsToAdmit`) while it exists. It must NOT re-POST bytes of a tx with no `'accepted'` entry, because that could admit a tx whose action was aborted. A `pending` entry older than `INTENT_TTL_MS` with no `'accepted'` entry was never broadcast by this client and is dropped. Do not put the inputs on the `'accepted'` entry itself: the background broadcast's `journalRemove` can clear it before the payout reads it.

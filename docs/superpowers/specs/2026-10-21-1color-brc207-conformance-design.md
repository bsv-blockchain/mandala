# 1Color / BRC-207 conformance — design

Date: 2026-10-21. Status: approved for an autonomous overnight run (user, 2026-10-21: "conform it all to the published BRCs now", "go for an overnight run", no human interaction for 7 hours). Decisions marked **(user)** were made by the user in conversation; decisions marked **(call)** were made by Claude and are listed for morning review.

Inputs: final BRC-162 "1Color" (bitcoin-sv/BRCs `tokens/0162.md`), final BRC-207 "1Color Wallet Module" (`wallet/0207.md`), audit `docs/design/2026-10-21-brc162-brc207-conformance-audit.md`, ts-stack origin/main (fcdd44a85+, incl. #1243 `@bsv/color-permission-module` 0.1.0, `@bsv/templates` 2.1.0 `OneColor`, `@bsv/sdk` 4.0.0, `@bsv/wallet-toolbox(-client|-mobile)` 2.15.0, #1313 BRC-207 topic names).

## 1. Intent

Mandala tokens become plain **1Color** tokens on chain. Mandala is an **issuer-enforcement layer** on top: the overlay is the **Mandala Issuance Platform Overlay**, which admits only transactions that satisfy Mandala issuer policy. Wallets are standard **BRC-207** wallets (upstream `@bsv/color-permission-module`) plus a **Mandala required-profile handler**. A wallet that does not implement the Mandala profile must refuse Mandala assets (BRC-162 required profiles), instead of building transactions the overlay rejects.

Success = byte-level BRC-162 conformance of every token output we write; BRC-207 conformance of both wallets' module behaviour (naming, derivation, baskets, balances, consent, signatures, receipts, required profiles, attested admission); Mandala's offline settlement preserved; issuer policy unchanged on the overlay.

## 2. Goals

1. **On-chain format** — lib, overlay-go and app read/write the final BRC-162 wire format via `@bsv/templates` 2.1.0 `OneColor` (or Go equivalent); token ids `<txid>_<vout>`; uint64 amounts.
2. **uint64 end to end (user)** — per-output amount 0..2^64-1 everywhere (codec, lib, app, overlay, storage, wallets, prompts, balances). Sums and supply are unbounded exact integers (big.Int / bigint). No 2^53 cap anywhere. JSON carries amounts as decimal strings.
3. **Wallets adopt upstream `@bsv/color-permission-module` (user)** in bsv-desktop and bsv-wallet; the `'p mandala'` P-modules, `'p mandala'` basket and `[2,'p mandala token']` derivation are deleted (no back-compat, prior user decision 2026-10-13).
4. **Mandala required profile (user rule)** — a wallet MUST NOT credit a Mandala token unless:
   - **online**: the wallet itself submitted the transaction to the Mandala overlay and holds a verified admission attestation covering the received output; refusal ⇒ no credit;
   - **offline**: the received transaction is covered by BRC-207 attested-admission evidence (complete token frontier, local validation of every unanchored hop), credited as `color_offline` (pending), and submitted by the recipient as soon as it is online.
5. **Transfer flow (user)** — sender signs and hands the transaction over (online or offline) without broadcasting or submitting it; the **recipient** submits to the Mandala overlay (which broadcasts) and only then credits (or credits offline per 4); recipient ACKs; on ACK the **sender also submits** the same bytes (idempotent) so its change becomes admitted. Unadmitted change stays spendable in further hand-overs (evidence walks back through it).
6. **Attested admission = BRC-207 `https://brc.dev/207/attested` v1** — the overlay's admission signature (σI) adopts the BRC-207 statement `1color-admit:v1:tm_color_<assetId>:<txid>:<sorted outs>` signed with the BRC-42 child key `[2,"color admission attestation"]`, keyID `"1"`, counterparty `anyone`; evidence carrier = BRC-207 `profileData` shape; frontier validation per 0207:328-357 incl. authority inputs, local transition validation of unanchored hops, no duplicate spend in the graph. This closes audit finding S1 (COVER accepts value minted from nothing).
7. **ts-stack** — upstream changes needed by 3/4/6 land as PRs (user merges and publishes; never publish ourselves). A GitHub issue (not a PR) suggests the `Bsv21Token` fixes from the audit.
8. **Security findings S1–S5** of the audit are closed by construction (S1 by 6; S2/S3 by deleting our modules; S4 by goal 4; S5 by failing closed when no overlay key is configured).

## 3. Non-goals / anti-goals

- **The overlay is NOT made a conforming BRC-207 `color` service (user).** It keeps: 1-sat outputs, holder I==O (no holder burn), 32-byte ids only (no BRC-161/legacy assets), issuer/KYC gate, freeze/pause, admin chain, strict deploy payload rules, whole-tx rejection. It must not advertise itself as a conforming 1Color/`color` service.
- **Do not touch `Bsv21Token` (BRC-161 JSON) in any PR (user).** Issue only.
- No backward compatibility with existing Mandala assets, outputs, derivations, stores or wire formats. Fresh deploys. A fresh overlay `NODE_NAME` for any live boot; never wipe existing state.
- No publishing to npm, no tag pushes, no merges to default branches, no force-pushes to shared branches. Draft PRs only.
- No BRC spec PRs tonight; spec feedback (audit F1–F7, 0162:107 vs :116, PUSHDATA ambiguity) is drafted in a doc for the user.
- Anti-goal: a wallet that silently credits Mandala value the overlay never admitted (outside the explicit `color_offline` path), or that signs a digest it cannot interpret.
- Anti-goal: forking `@bsv/color-permission-module` into our repos. Extend upstream (PR) or subclass/register; never copy.

## 4. Architecture

### 4.1 ts-stack (PRs against bsv-blockchain/ts-stack main, from a worktree; base branch origin/main)

**T1 — `@bsv/templates`: 1Color attribute reader** (minor bump 2.2.0). A pure reader over a BRC-162 payload: `dec` (uint 0..18), `sym` (text), `icon` (`[mediaType text, bytes]`, else absent), `req` (map of profile id → descriptor; id = ASCII URI 1..200 bytes, lowercase scheme `[a-z][a-z0-9+.-]*`, `:`, visible ASCII no spaces; descriptor exactly `{version: uint32 ≥1, params: any}`), `ext` (map of profile id → any). Malformed reserved fields are reported distinctly from "absent" (BRC-207 rejects malformed reserved fields in a valid payload map; base admission unaffected). Helper to compare a repeated `req` to the deploy's by canonical DAG-CBOR bytes (absent deploy map = empty). Encoder helper that writes `OP_0 OP_DROP` when a non-P2PKH remainder starts with `<push> OP_DROP` (0162:101). Exports cleaned so 36-byte-aware id helpers are the obvious ones (keep old names working; no breaking change). **No change to `Bsv21Token.ts`.**

**T2 — `@bsv/color-permission-module`: required-profile handlers + attested profile** (minor bump 0.2.0).
- A `profiles` option: map of profile identifier → handler `{ versions, …hooks }`. An asset whose deploy `req` names any identifier/version not registered fails closed exactly as today (`UnsupportedProfileError`, A.142/A.143/A.148). Every required profile must be supported (A.148). Handlers may only add restrictions; they never weaken base BRC-207 checks (A.144, A.154).
- Hooks the Mandala handler needs (design them generically, documented in the README): (a) **receive**: before crediting, a handler may require/perform admission (e.g. submit to a designated overlay and verify an attestation) or accept attested offline evidence from `profileData`; (b) **send/handoff**: a handler may require that a token action is a hand-over (BRC-177 `noSend` handoff) that keeps token change inside the handed-over transaction (no pre-split broadcast), and that the module does not submit it; (c) **settle**: an explicit API for the host to submit a held transaction (recipient settlement, sender post-ACK settlement) and drop `color_offline` only after a verified admission; (d) **spendability**: handler may designate the overlay used for an asset's spendability/admission queries (provider routing per asset).
- **Built-in handler for `https://brc.dev/207/attested` v1** per 0207:162-450 and Appendix C: params (`trustMode` any/same/all/identity, `identityKey`, `evidenceProfile`), statement/signature (BRC-42 child key; bare-key verification must fail; low- and high-S accepted), `profileData` carrier (`declarationTx`, `transactions`, `attestations`, `submissions?`, `lifecycles?`), complete-frontier rules, offline credit as `color_offline`, settlement order (parents first, exact bytes, idempotent), replacement via `evidenceProfile`. Trust list: support `identity` mode fully; `any/same/all` need a BRC-189 trust snapshot from the host — implement against an injected `trustedIdentities()` callback; if absent, those modes fail closed. Appendix C vectors become tests.
- Keep the module's existing behaviour for profile-free assets byte-for-byte (existing tests stay green).

**T3 — wallet-toolbox**: only if T2 proves impossible without manager changes (e.g. a hook the `WalletPermissionsManager` does not pass through). Prefer none.

**I1 — GitHub issue** on bsv-blockchain/ts-stack: `Bsv21Token` (BRC-161) validation gaps (amt uint64 bound + canonical decimal, dec string 0..18, id required/validated for non-deploy ops, unknown op rejected, binary-wins precedence helper / documented call order), plus the PUSHDATA-form ambiguity for spec authors. Text only; no code.

### 4.2 Mandala (repo `bsv-blockchain/mandala`, branch `feat/1color`, worktree `mandala-wt/1color`)

**Profile definition — `docs/profiles/issuer-v1.md` (call)**: the Mandala issuer-enforcement profile, identifier `https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md` (a URI under BSVA's control; descriptor `version: 1`; `params: {identityKey: <66-hex compressed overlay identity key>}`). Semantics = goals 4 and 5: credit only after the wallet's own submit to the overlay identified by `identityKey` returns a verified attested admission covering the output, or via attested offline evidence (requires the attested profile also be declared, identity mode, same key); never pre-split; sender does not submit before hand-over; holder transactions must be I==O per asset (wallet refuses to build a holder burn); 1-sat token outputs. The overlay endpoint is wallet configuration (BRC-207 A.21: plans cannot select service URLs) — params carry only the key.

**Every new Mandala deploy declares (call):**
```
req = {
  "https://brc.dev/207/attested": {version: 1, params: {trustMode: "identity", identityKey: K}},
  "<issuer-v1 uri>":             {version: 1, params: {identityKey: K}}
}
```
The overlay **rejects** Mandala deploys whose `req` is not exactly this shape for its own key K (call: guarantees every Mandala asset is profile-protected).

**lib (`@bsv/mandala` → 0.5.0, breaking)**
- `@bsv/templates` ^2.2.0 (vendored tarball until published), `OneColor` everywhere; amounts `bigint` in every API, store and wire field (JSON as decimal string); remove `Number()`/2^53 logic; display helpers format bigint with `dec` 0..18.
- Naming: 1Color/`color` primitives — per-asset topic `tm_color_<assetId>` / lookup `ls_color_<assetId>` (assetId `<txid>_0`); registry/KYC topics keep Mandala names (`tm_mandala`, `tm_mandala_kyc` and their `ls_`) since they are Mandala-specific (call).
- Admission: new attested statement + child-key signing/verification (shared with T2 vectors).
- **Mandala profile handler** for `@bsv/color-permission-module` (registered by hosts): implements goals 4/5 on the T2 hooks; offline evidence uses T2's attested handler (no second COVER implementation — delete `cover()` in favour of the module's frontier validator, or reimplement only if T2 cannot be consumed by the lib; the security property S1 must hold either way).
- Deploy/issuance/admin/registry flows (app console, admin originator) stay in the lib and write `req` as above; derivations for issuer/admin keys may stay Mandala-specific (they are not `p color` keys). Holder-side token keys move to BRC-207 derivation (`[2,"p color <assetTag> <hexprefix> <hexsuffix>"]`, keyID `color`) — the lib must stop deriving holder token keys itself; holder send/receive go through the wallet's module.
- Blinded sends (prior user decision): A′ = A + rG stays default; receipt `senderIdentityKey` = A′ so the recipient derives with counterparty A′ (plain BRC-42); r kept sender-side only, wallet-internal table keyed by outpoint.
- Offline transports (localpay frames, MessageBox hand-over) carry BRC-207 `profileData`-shaped evidence.
- Fail closed when no overlay identity key is configured (S5).

**overlay-go**
- Codec: final BRC-162; 32-byte ids only remains policy (36-byte → policy reject, documented as Mandala policy not codec failure); strict DAG-CBOR reader able to parse the deploy `req` above (full DAG-CBOR per 0162:144 or a superset of the old subset sufficient for maps/text/uint/bytes/arrays; keep a payload size limit as policy).
- uint64 amounts: per-output ≤ 2^64-1, sums/supply big.Int, Mongo storage exact (Decimal128 or canonical decimal string — builder's choice; must round-trip 2^64-1 and compare/sort correctly where queries depend on it), HTTP JSON amounts as decimal strings.
- Topic rename to `tm_color_<assetId>` / `ls_color_<assetId>` (per-asset); registry topics unchanged.
- Admission signature = attested statement via the overlay identity key's BRC-42 child (goal 6); verdict taxonomy unchanged.
- Additive lookup query shapes `color-spendability` and `color-admission` on `ls_color_<assetId>` (0207:741-760) so a stock `ColorOverlayProvider` can talk to it (call). This is interface compatibility, not service conformance (1-sat/I==O/etc. remain).
- Deploy policy: require the `req` shape above.
- Keep TS overlay (`overlay/`) out of scope unless it is still used by tests the Go overlay depends on (call: Go is the stack).

**app (console)** — port to lib 0.5.0: bigint amounts, deploys with `req`, new topics, new admission format.

### 4.3 bsv-desktop (branch `feat/1color`, worktree off `BSV-Desktop/master`)
- Upgrade to `@bsv/sdk` 4.0.0, `@bsv/wallet-toolbox(-client)` 2.15.0, `@bsv/templates` 2.2.0, `@bsv/color-permission-module` 0.2.0 (vendored tarballs from the ts-stack PR branch until published; PR description lists publish prerequisites), `@bsv/mandala` 0.5.0 (vendored).
- Register `createColorModule({wallet, provider, requestTokenAccess, profiles: {attested, mandalaIssuer}})`; delete `permissionModules/mandala*`; prompt UI for `color_send`, `color_signature`, `color_access`, `color_relinquish` (exact decimal amounts, asset legs, sats, fee, released signatures). Host grant policy: BRC-207 says the module asks on every operation and the host decides grants — keep a per-originator read grant (30 min, as today) but never let a spend approval grant reads or vice versa (audit C6), and honour `seekPermission:false` by erroring instead of prompting.
- Overlay provider: routes Mandala assets (by required profile) to the configured Mandala overlay endpoint.

### 4.4 bsv-wallet (branch `feat/1color`, worktree off `master`; never touch the main checkout)
- Same as desktop for `packages/expo-wallet-toolbox` using `@bsv/wallet-toolbox-mobile` 2.15.0 and `@bsv/sdk` 4.0.0; RN-safe (no Node-only APIs in the module path; check `@bsv/color-permission-module` is ESM-only and works under Metro/jest-expo — if not, document and adapt via build config, not by forking).
- Settlement runtime (`settlementStore`, `drain`, localpay, MessageBox inbox) re-plumbed onto the module's settle API and `color_offline` state; SQLite tables may be reset (no back-compat), with a guarded migration that drops old Mandala tables.
- UI: balances from `p color balance` views (exact decimal strings), pending vs settled from `color_offline`.

## 5. Constraints

- Stability mandate: every pipeline change reasoned through crash, double-click, multi-tab, stale cache, retry; idempotent submit; exact-bytes retry; never double-count reserved parent and child.
- BSV Chronicle: never normalize S; accept high-S signatures (attested profile requires both).
- Overlay-first tx pattern applies to issuer/admin flows (noSend → submit → sendWith).
- Tests: every repo's existing suites stay green; new behaviour TDD; BRC-207 Appendix A/C examples relevant to each change become tests; Go gate (`go test ./...`), lib `npm test`, tsc clean, desktop vitest, wallet jest from repo root.
- Subagent model tiering per user memory (no Fable; sonnet routine, opus for security/multi-file).
- ts-stack conventions: its AGENTS.md, BotBoard lockfile protocol if required for maintainer PRs (check AGENTS.md), conventional commits, changesets/version bumps as the repo requires.
- Git: worktrees only; never disturb `/Users/personal/git/ts-stack` (user's checkout), `/Users/personal/git/bsv-wallet` main checkout, `/Users/personal/git/ts/bsv-desktop` main checkout, or mandala `master` working tree. Commit on feature branches; push and open **draft** PRs (mandala origin is a redirect: use `gh --repo bsv-blockchain/mandala`).

## 6. Left to the builder

Exact handler hook signatures in T2; Mongo amount representation; whether lib consumes T2's frontier validator directly or via a thin adapter; UI layout of prompts; test file organisation; how vendored tarballs are produced (pack from the ts-stack worktree build).

## 7. Calls made by Claude for morning review

C1 per-asset topics renamed to `tm_color_<assetId>`/`ls_color_<assetId>`, registry/KYC topics keep Mandala names · C2 Mandala profile URI under `github.com/bsv-blockchain/mandala`, params = overlay identity key only · C3 deploys must declare attested(identity)+issuer-v1, overlay enforces it · C4 generic profile-handler registry + attested profile implemented upstream in `@bsv/color-permission-module` (PR), Mandala handler in `@bsv/mandala` · C5 templates attribute reader upstream (PR) · C6 overlay adds `color-spendability`/`color-admission` lookup shapes · C7 mandala work on branch `feat/1color` (not master) because it spans an overnight multi-repo change · C8 draft PRs everywhere with vendored tarballs; publish order documented · C9 TS `overlay/` and ts-stack `overlays/topics` Mandala package left as follow-ups (parity reference now stale) · C10 desktop keeps a 30-min per-originator read grant in the host, separate from spend approvals.

## 8. Builder-check resolutions (all Claude calls, user unavailable overnight)

**B1 — Owner-linkage envelope (overlay layers B/D unchanged).** The Mandala envelope (per-output owner linkage proving each token output's key belongs to an identity, consumed by the overlay's KYC allow/deny/sanctions layers) becomes **companion-profile submission data** of the issuer-v1 profile, carried in the attested profile's `submissions[].offChainValues` (0207:309-318) and in hand-over `profileData`. Sources: (i) parts only the sending app knows (recipient outputs, incl. blinded-recipient linkage offsets) arrive as caller profile data in the action plan (`plan.profileData[issuer-uri][assetId]`, 0207 A.158/A.159) and are **checked, not trusted** by the handler (A.157: structure, coverage of exactly the tx's token outputs, keys match the locking scripts where checkable); (ii) parts only the wallet knows (its own change/owned outputs) are produced by the handler through the module's underlying wallet. T2 therefore adds: a handler hook that validates caller profile data and builds per-transaction submission data, and an `offChainValues` argument on `ColorOverlayProvider.submit` (backwards-compatible optional parameter). Registry/KYC topics (`tm_mandala*`) keep their current admission-signature format (builder's call, not BRC-207 surface).

**B2 — Hand-over without BRC-177.** Mandala hand-overs stay plain `noSend` actions (no prefunded anchor, no broadcast at hand-over, works fully offline). T2 lets a required-profile handler declare that its assets use plain `noSend` hand-over (module then skips the BRC-177 label requirement and the pre-split broadcast for those assets, keeps change inside the handed-over transaction, and does not submit). Profile-free assets keep upstream behaviour exactly. No wallet-toolbox change (T3 stays empty). Recorded as spec feedback (audit F4: define the no-BRC-177 case). Sender-side reservation of the spent inputs persists until abort or admission (existing abortGuard semantics).

**B3 — Blinding stays outside the module.** The sender's lib/runtime (app or wallet runtime) builds the recipient output itself (BRC-207: the caller supplies the recipient's output) with a blinded counterparty A′, writes receipt `senderIdentityKey = A′`, and supplies the blinded linkage offset for the envelope via plan profile data (B1-i). The module treats the recipient output as a destination; recipients derive with counterparty A′ (plain BRC-42) — no derivation-override hook in T2. r stays in the sender's wallet-internal/lib blinding store keyed by outpoint.

**B4 — Issuer treasury stays under Mandala keys (option B).** Minted value and authority outputs stay under Mandala issuer/admin derivations, built and signed by the lib in the admin console (overlay-first: noSend → submit → sendWith), exactly as today apart from wire-format, uint64 and naming changes. Issuer payouts to holders create recipient outputs under the holder's BRC-207 `p color` derivation (sender-side derivation by the lib, counterparty = holder or A′) with a BRC-207 receipt, so holders receive through the module. Holders never hold Mandala-derived token keys. The console does not see treasury in `p color balance` (it keeps its own view).

**B5 — Desktop settlement via the app.** Recipient settlement runs inside the wallet: `internalizeAction` → Mandala handler submits to the overlay and verifies attested admission before crediting (works over BRC-100). Sender post-ACK settlement: the app (lib, existing MessageBox ACK flow) submits the handed-over bytes to the overlay itself; the wallet learns admission lazily — upstream already checks spendability when spending and resubmits a held output from the wallet's copy. No desktop-hosted runtime. On mobile the in-wallet runtime does the same through the module's settle API.

**B6 — Fuel/token fees out of scope.** fuelkeeper is not ported tonight (follow-up). Overlay keeps parsing the optional `feeRatePerKb` deploy key; the console stops writing it by default. Note in PR descriptions that fuelkeeper is broken against the new wire format until ported.

> Source: `/private/tmp/claude-502/-Users-personal-git-demos-mandala/1d8c5cb1-3448-49bc-b255-3df7840f24b8/scratchpad/admin-plan.md` · Copied 2026-09-14.

# Mandala — administrative fixes: implementation sequencing plan

Repo: `/Users/personal/git/demos/mandala` (working tree, 2026-09-14, 46 uncommitted paths).
Companion repo referenced for D2/D3 obligations only: `/Users/personal/git/bsv-wallet`.

Locked decisions this plan is built inside: **D1** correctness first, P2MKH threshold and key rotation
deferred · **D2** blinded sender key `A' = A + rG` is canonical on every rail, `lib/src/blinding.ts` is the
reference implementation, the wallet's committed token-frame convention must move to it and the recipient
linkage must become payee-decryptable · **D3** `lib/` (`@bsv/mandala`) becomes React-Native safe and is
consumed as a package (no `import.meta`, a `default` export condition, an injected storage adapter) ·
**D4** no address rail for stablecoins; messagebox (handle) + nearby only.

Legend for each item: **ts-stack** = does it need a `@bsv/templates` / `@bsv/overlay-topics` PR (PR only,
maintainer publishes, demo-side consumption waits) · **parity** = the Go obligation · **stability** = the
four mandated questions (crash at each `await`, double-click, second tab, stale cache).

---

## 0. The P0 the gap analysis understates — verified, with the reproduction

The gap analysis files this under G13 as "exploitability is low today (the pkh re-derivation still requires
the issuer key)". **That sentence is wrong.** The re-derivation does not require the issuer key. Verified by
direct read of the four cited sites:

**Defect 1 — the expected lock key is derived against a counterparty the attacker chooses.**

```ts
// overlay/node_modules/@bsv/overlay-topics/src/mandala/MandalaTopicManager.ts:126-134
const counterparty = typeof details.counterparty === 'string' ? details.counterparty : 'self'
const { publicKey } = await this.deps.adminWallet.getPublicKey({
  protocolID: this.deps.adminProtocolID,
  keyID: MandalaAdmin.commitment(details),
  counterparty                                   // ← from the unauthenticated off-chain payload
})                                               // ← forSelf defaults to false
const expected = Hash.hash160(Utils.toArray(publicKey, 'hex'))
```

`forSelf: false` is BRC-42 *counterparty-child* derivation:
`expected = Counterparty + HMAC-SHA256(ECDH(serverRoot, Counterparty), "2-mandala admin-<keyID>")·G`.

`ECDH(serverRoot, X) = serverRoot·X = x·Q` where `x` is the attacker's own private key and `Q` is the
overlay's **public** identity key — published as `VITE_OVERLAY_IDENTITY_KEY` in `app/.env`, echoed on every
admission as `admissionIdentityKey` (`overlay/src/admission.ts`, `overlay-go/internal/httpapi/admission.go`).
So any third party reproduces `expected` byte-for-byte with public data plus their own key, **and holds the
private key** `x + HMAC(...)` for the output they just forged.

Same code, same defect, four places:
- TS per-asset: `MandalaTopicManager.ts:126-137` (`verifyAdminOutput`)
- Go per-asset: `overlay-go/internal/mandala/adminwallet.go:38-58` (`AdminWallet.ExpectedPKH` — the
  `details.Str("counterparty")` branch at `:52-56`)
- TS registry: `overlay/src/registry.ts:119-128` (inline in `RegistryTopicManager.identifyAdmissibleOutputs`)
- Go registry: `overlay-go/internal/mandala/registry.go:47-66` (`RegistryWallet.ExpectedPKH`)

**Defect 2 — the chain link is not a chain link.**

```ts
// MandalaTopicManager.ts:31-37 (called :138)
const priorOutpointSpent = (tx, details) => {
  if (details.kind === 'register') return true
  if (typeof details.priorOutpoint !== 'string') return false
  return tx.inputs.some(inp => `${inp.sourceTXID ?? …}.${inp.sourceOutputIndex}` === details.priorOutpoint)
}
```
Go identical at `overlay-go/internal/mandala/topic_manager.go:250-263`, registry at
`overlay/src/registry.ts:85-91` and `overlay-go/internal/mandala/registry_topic.go:65-67`.
It only asserts the named outpoint is **some input of the same transaction** — so the attacker points
`priorOutpoint` at their own funding UTXO and the gate passes. Nothing requires the prior to be an admitted
admin output, of that asset, or of any asset.

**Reproduction (both stacks).** Attacker with key `x`, `X = xG`:
1. `details = {kind:'issue', assetId:'<victim genesis outpoint>', amount: 1e12, priorOutpoint:'<their own
   UTXO>', counterparty: X}`
2. `keyID = MandalaAdmin.commitment(details)`; `pkh = hash160(X + HMAC(x·Q, "2-mandala admin-"+keyID)·G)`
3. one 1-sat P2PKH to `pkh`, one FT output of 1e12 units to themselves, their own UTXO as an input
4. `POST /submit` with `X-Topics: ["tm_mandala"]`, `admin:[{index, actionDetails: details}]`

Result: `verifyAdminOutput` → admitted; `authorizedIssuance[assetId] += 1e12`; conservation
(`MandalaTopicManager.ts:172-197`) passes; `ls_mandala.indexAdminOutput` folds it into `mandalaAssetStates`
and appends to `mandalaAdminHistory`; `GET /admin/admin-summary/:assetId` reports the inflated
`totalIssued`. **Nothing downstream checks authorship** — neither lookup service, reducer, nor any endpoint
asks "was this the issuer?". Substituting the kind gives `unpause`, `unfreeze`, `allowIdentity`,
`setAccessMode`, `reissue`. On `tm_mandala_registry`, where `register` is exempt from `priorSpent`
*entirely*, `{kind:'register', issuer: X, identityKey: X, counterparty: X}` folds an `admitted` row for the
attacker: **self-KYC**, which is also the way past the membership gate that `registryScreening`
(`overlay/src/registry.ts:179-188`) and Go `membershipHolds` (`topic_manager.go:537-605`) enforce.

**Why the fix is repo-local on both stacks despite living in the npm package.** `adminWallet` is an
*injected* dependency (`MandalaTopicManagerDeps.adminWallet`, `MandalaTopicManager.ts:9-18`), wired at
`overlay/src/index.ts:81-87`. Interposing a wallet shim that refuses to honour a payload-supplied
counterparty closes the hole without touching `@bsv/overlay-topics`. The ts-stack PR still gets written so
future consumers are safe, but the demo does not wait on it.

---

## 1. Dependency graph

```
A00 forensic sweep of live state  (must precede every acceptance change)
 │
 ├─► A01 pin admin/registry derivation to the issuer            ── P0, the lock
 │     ├─► A02 priorOutpoint must be a recorded admin output    ── defence in depth, shares the
 │     │        of that asset                                      assetAuthHead() helper with A10
 │     ├─► A03 registry `register` uniqueness (+ client refusal)
 │     └─► A04 one membership gate, issuer-exempt, TS ≡ Go
 │              └─► A05 spend-side identity from overlay state; prover-based input linkage
 │                    ├─► A11 access mode re-evaluated on state-resolved senders
 │                    └─► ✦ BLINDING ROLLOUT GATE ✦ ─► land L4 (blinding) ─► wallet D2 work
 │
 ├─► A06 persistent admitSeq  ──►  A07 registry head = chain head, not issuer row
 │        (A01+A03+A06+A07 all in ONE overlay build/restart + lib rebuild)
 │                    └─► ▶ RUNBOOK RETRY: admit 0299e597… spending dc810603…:0
 │
 ├─► A09 admin-auth on-chain marker      ─┐ complements
 ├─► A10 overlay-backed asset admin-auth ─┘ (A10 consumes A02's assetAuthHead())
 │        recovery (endpoint + lib + UI)
 │
 ├─► A08 reissue remittance journaled   ├─ independent stability fixes
 ├─► A15 gate+intent on register/global │
 ├─► A18 forceable asset-state fetch    ┘
 │
 ├─► A13 /admin/* auth + CORS   (before any public demo)
 ├─► A14 deposit-record hash on issue
 ├─► A12 σI captured/persisted/served/verified + payee-decryptable recipient linkage
 ├─► A16 zombie-freeze refusal
 ├─► A17 Go registry parity (actionDetails + /admin/registry/beef)
 └─► A19/A20/A21 confirmations, audit surfaces, dead code

D3a constants (no import.meta) ─► D3b package exports ─► D3c storage adapter (async journals)
        (D3c touches every journal call site — sequence AFTER A08/A15 so the ordering
         rules those items establish are the ones being made async)

D4 address-rail refusal contract + test  (independent, small)

A22 test backfill — rides with every item above, never a separate phase
```

**Deferred out of this plan (see §4):** G03 P2MKH threshold locks, G05 key rotation, G27 listen-only
replica, G12 collapsing the two membership lists, G13's strict single-head binding, G14's upstream balance
debit, and robustness items 1–8 — all bundled into one `@bsv/overlay-topics` PR that the demo does not wait
on.

---

## 2. Work items

### A00 — Forensic sweep of live overlay state (no code)

**Why (security).** A01 changes what the overlay will *accept from now on*; it does not undo a forgery
already folded into `mandalaAssetStates` / `mandalaAdminHistory` / `mandalaRegistry`. The mainnet asset and
the live registry chain (`dc810603…:0`, runbook.md:33-50) have been reachable by this attack for the whole
life of the deployment.

**Files.** None. Mongo `mandala_lookup_services`, read-only:
- `mandalaAdminHistory` — every row whose `actionDetails.counterparty` is a string (the only way the
  vulnerable branch is reached), and every row whose `txid` is not in the issuer's own wallet history
  (`lib/src/history.ts loadHistory` labels `mandala`).
- `mandalaRegistry` — every row with `status:'admitted'` not explained by an issuer-signed admit; in
  particular any row with `actionDetails.kind === 'register'` other than `dc810603…` and the known mistaken
  `ec5584b5…` (runbook.md:49).
- `GET /admin/admin-summary/:assetId` `totalIssued` vs the issuer's own record of issues.

**ts-stack.** No. **Parity.** Both backends share the database; one sweep covers both.

**Tests.** None (operational). Record the result in `runbook.md` under a new "Security posture" heading.

**Stability.** Read-only. Run it before the overlay is rebuilt so the numbers are the pre-fix numbers.

---

### A01 — Pin admin and registry key derivation to the issuer (P0)

**Why (security).** Defect 1 above. Without it any third party mints, unpauses, unfreezes and self-admits.

**Files + functions.**
- **New** `overlay/src/pinnedWallet.ts`: `pinnedAdminWallet(inner: WalletInterface, members?: string[])` and
  `pinnedRegistryWallet(...)` returning a `WalletInterface` proxy whose `getPublicKey` **overwrites**
  `counterparty` with `'self'` unless the caller-supplied counterparty is in `members`; an unknown
  counterparty **throws** (fail-closed — the throw propagates out of `identifyAdmissibleOutputs` and rejects
  the whole transaction, matching the existing "rejections are thrown" contract,
  `MandalaTopicManager.ts:344-369`). `members` defaults to `[]` → self only.
- `overlay/src/index.ts:81-90`: pass `adminWallet: pinnedAdminWallet(mandalaWallet, ADMIN_MEMBER_KEYS)` while
  leaving `verifierWallet: mandalaWallet` untouched — the shim must be a *separate instance*, because the
  same object is the BRC-72 linkage decrypt wallet and must keep its unmodified `decrypt`. Same for
  `new RegistryTopicManager(pinnedRegistryWallet(mandalaWallet, ADMIN_MEMBER_KEYS))` at `:89`.
- `overlay/src/registry.ts:119-128`: replace the inline `details.counterparty ?? 'self'` with the pinned
  derivation (the registry TM is repo-local, so fix it in place rather than only through the shim).
- `overlay-go/internal/mandala/adminwallet.go:38-58` `AdminWallet.ExpectedPKH`: delete the
  `details.Str("counterparty")` branch, or gate it on a new `AdminWallet.members map[string]bool` populated
  from config; unknown counterparty → return an error (Go already treats a derivation error as
  reject-the-tx, `topic_manager.go:126-131` + the comment at `:225-231`).
- `overlay-go/internal/mandala/registry.go:47-66` `RegistryWallet.ExpectedPKH`: identical change.
- Config: `ADMIN_MEMBER_KEYS` (comma-separated compressed hex) in `overlay/.env.example`,
  `overlay-go/.env.example`, `overlay-go/cmd/overlay/main.go loadConfig`, `internal/wiring/engine.go Config`.
  Default empty. Document in `runbook.md` that empty = self-only and that this is the safe default.
- `docs/PROJECT-STATE.md §12` "admin-rights transfer via `counterparty` — no UI yet": rewrite as "removed;
  a transfer of admin rights must name a key from the configured member set" (the feature was the hole).

**ts-stack.** **Yes, follow-up PR (does not block).** `@bsv/overlay-topics`
`MandalaTopicManager.verifyAdminOutput` should take an optional `adminCounterparties: string[]` dep and
default to `'self'`, so the package is not shipping an unauthenticated-counterparty derivation to other
consumers. Demo-side consumption waits; the shim covers the demo in the meantime.

**Parity.** TS and Go must reject the same vector with the same posture (reject the transaction, not skip
the output). Add the forged-admin case to `overlay-go/testdata/vectors.json` so both suites test the same
bytes.

**Tests.**
- `overlay/src/pinnedWallet.test.ts` (new): build the forgery exactly as §0 does — attacker `PrivateKey`,
  overlay `PublicKey`, `hash160(X + HMAC(x·Q, invoice)·G)` — assert `identifyAdmissibleOutputs` **throws**;
  assert an issuer-locked (`counterparty:'self'`) admin output is still admitted; assert a counterparty in
  `members` is admitted and one outside it throws.
- `overlay/src/registry.test.ts`: the same two cases against `RegistryTopicManager`, plus a forged
  `{kind:'register', issuer: X, counterparty: X}` self-admit.
- `overlay-go/internal/mandala/adminwallet_test.go`, `registry_test.go`: the golden forged vector, plus
  `TestExpectedPKHIgnoresPayloadCounterparty`.
- `overlay-go/internal/mandala/topic_manager_test.go`: `TestForgedAdminOutputRejected` (whole-tx reject).

**Stability.**
- *Crash at each await:* the shim adds no I/O and no state; a crash mid-verification is the existing
  reject-and-retry path.
- *Double-click:* no change (verification is pure).
- *Second tab:* no change.
- *Stale cache:* none — `members` is read once at boot; changing it requires a restart, which is the
  intended blast radius. **But the restart resets TS `admitSeq` (A06) — A01 and A06 must ship in the same
  build, see §3.**

---

### A02 — `priorOutpoint` must be a recorded admin output of that asset (P0, defence in depth)

**Why (security).** Defect 2 above; R7/R9 ("consumes authorized outpoint *n*, produces *n+1*"). With A01 in
place a forged prior is worthless, but the invariant the whitepaper leans on (R8, "rewriting history
requires a deep reorg") is only as strong as the link check, and the same helper is what A10 needs.

**Design.** Not the strict "must equal the single current head": the one-submit fold lag
(`docs/STABLECOIN-ADMIN.md:130-143`; Engine Phase 3 runs after `onSteakReady`) means two admin actions
submitted back-to-back would see a head one step behind and be rejected. The lag-tolerant rule that is still
a real lock: **`details.priorOutpoint` must be (i) an input of this transaction AND (ii) an outpoint
recorded in `mandalaAdminHistory` for `details.assetId`.** An attacker's own UTXO fails (ii); a genuine
earlier admin output of that asset fails on-chain double-spend if already spent. Strict single-head binding
is the deferred ts-stack item (G13).

**Files + functions.**
- **New** `overlay/src/assetAuth.ts`: `assetAuthHead(storage, assetId)` → newest
  `mandalaAdminHistory` row by `(height, offset, admitSeq)` as `{authOutpoint, authDetails}`, and
  `isAdminOutpoint(storage, assetId, outpoint)`. Backed by
  `MandalaStorageManager.findAdminHistoryByAssetId` (the method behind `overlay/src/index.ts:107-117`).
- **New** `overlay/src/mandalaGate.ts`: a `TopicManager` decorator around `MandalaTopicManager` — this file
  becomes the home of A02, A04, A05 and A11. For A02 it pre-checks every non-`register`
  `payload.admin[]` entry with `isAdminOutpoint` and throws
  `prior authorization outpoint is not an admin output of this asset`. Wired in `overlay/src/index.ts:81`.
- `overlay-go/internal/mandala/topic_manager.go:19-22` `StateStore`: add
  `IsAdminOutpoint(ctx, assetID, outpoint string) (bool, error)`; implement on
  `overlay-go/internal/mandala/storage.go` against `mandalaAdminHistory`; call it from `priorOutpointSpent`
  (`:250-263`), which must therefore become context- and error-aware (signature change rippling into
  `verifyAdminOutput` at `:232-245`).
- Registry side: `overlay/src/registry.ts:85-91` `priorSpent` and
  `overlay-go/internal/mandala/registry_topic.go:65-67` — the registry head is a single `mandalaRegistry`
  row, so the check is `prior === "<row.txid>.<row.outputIndex>"` for some row.
- Index: add `mandalaAdminHistory` index `(assetId, txid, outputIndex)` in
  `MandalaStorageManager` boot (`overlay/src/index.ts:159-160`) and `storage.go:95-138`. Without it this is
  a collection scan per admin output per submit.

**ts-stack.** No for the wrapper. The strict head binding + `authOutpoint` on `AssetAdminState` is the
deferred ts-stack PR.

**Parity.** Same rule, same error string on both stacks. Go's `IsAdminOutpoint` and the TS
`isAdminOutpoint` must agree on outpoint formatting (`"<txid>.<vout>"`, `fmtOutpoint` in Go).

**Tests.** TS wrapper test: admin action whose `priorOutpoint` is an unrelated funding UTXO → rejected;
whose prior is the genuine previous auth → admitted; whose prior is a *different asset's* admin output →
rejected. Go table test mirroring all three. Registry variants for both.

**Stability.**
- *Crash at each await:* one extra read before the inner TM runs; a crash leaves nothing written (the gate
  is read-only) and the client's `noSend` action is swept by `reconcileWallet`'s intent TTL.
- *Double-click:* the second submit names the same prior, which is now spent on-chain — the engine rejects
  it. Client-side `withAdminAuthGate` already serialises (`lib/src/adminAuthGate.ts:40-87`).
- *Second tab:* same; the web lock `mandala.admin.<assetId>` plus this server-side check is the backstop
  (`lib/src/webLocks.ts:7-8` explicitly delegates cross-device races here).
- *Stale cache:* the fold lag is exactly why the rule is "any recorded admin outpoint" rather than "the
  head". Document that choice in the file header so a future tightening does not reintroduce the lag bug.

---

### A03 — Registry `register` uniqueness, server and client (P0/P1)

**Why (security + runbook).** `register` is exempt from `priorSpent` on both stacks, so it is the one admin
kind with no chain binding at all; combined with `foldRegistry` upserting by `identityKey`
(`overlay/src/registry.ts:69-83`), a forged or accidental second genesis rewrites the issuer's row and
becomes a self-admit vector (§0) and the direct cause of the live duplicate `ec5584b5…`
(runbook.md:49, G16). The registration chain is issuer-level and singular by R25.

**Files + functions.**
- `overlay/src/registry.ts:99-137` `RegistryTopicManager.identifyAdmissibleOutputs`: reject a `register`
  when `await store.isActive()` (the TM must take the `RegistryStore`; it currently takes only the wallet —
  constructor change at `:94-97`, wiring at `overlay/src/index.ts:89`).
- `overlay-go/internal/mandala/registry_topic.go:29-78`: same, via the already-injected store
  (`RegistryActive`, `registry.go:84-90`).
- `lib/src/registry.ts:421-434` `mockKycOpen` and `:436-469` `mockKycAdmit`: call `fetchRegistry()` first and
  refuse to build a genesis when any row exists — today `mockKycAdmit` falls back to `registerIdentities`
  whenever `recoverRegistryAuth` returns null (`:446-460`), which is how the duplicate was created. Return a
  typed `RegistryAlreadyOpenError` so `app/src/components/issuer/IdentityRegistry.tsx:127-149` can keep
  showing **Re-attach** instead of **Open**.

**ts-stack.** No — both registry topic managers are repo-local (untracked).

**Parity.** Same gate, same error text (`tm_mandala_registry: registration chain already open`).

**Tests.** `overlay/src/registry.test.ts`: second `register` rejected when a row exists; first `register`
admitted on an empty store; `admitIdentity` unaffected. Go `registry_test.go` mirror.
`lib/src/registry.test.ts`: `mockKycOpen` with non-empty `fetchRegistry` does not call `createAction`;
`mockKycAdmit` with a null recover result and non-empty rows throws rather than opening a genesis.

**Stability.**
- *Crash at each await:* the client check is a read before `withIntent`, so a crash leaves no action.
- *Double-click:* `registryFlight` (`lib/src/singleFlight.ts`) plus the new server gate — the second
  genesis is refused even if both clicks reach the overlay.
- *Second tab:* the in-process `registryFlight` does **not** cover a second tab; the server gate does. Add
  the cross-tab web lock `mandala.registry` alongside `mandala.send` in the same change (cheap, and it is
  the same defect class as A15).
- *Stale cache:* `fetchRegistry()` is uncached; the server gate is authoritative regardless.

---

### A04 — One membership gate, issuer-exempt, TS ≡ Go (P1; G06)

**Why (requirement + availability).** R54/R55/R56/R57. Today TS enforces registry membership *through the
sanctions gate* (`registryScreening` wired as `screeningProvider`, `overlay/src/index.ts:83`), which is
universal with **no issuer exemption**; Go uses a separate `membershipHolds` with an issuer exemption
(`topic_manager.go:537-605`) and `NoSanctions{}` (`wiring/engine.go:185`). Two consequences: the same
transaction is admitted by one backend and refused by the other over one database; and on TS, a revoke of
the issuer row, a `mandalaRegistry` index loss, or the duplicate-genesis confusion locks the issuer out of
**every** admin action including `unpause` — an unrecoverable self-brick, the exact opposite of R56.

**Files + functions.**
- `overlay/src/index.ts:82-88`: `screeningProvider: new InMemoryScreeningProvider([])` (sanctions stays a
  distinct, currently-empty concern per R58).
- `overlay/src/mandalaGate.ts` (from A02): implement `membershipHolds` — active only when the registry has
  ≥1 row; issuer keys of every asset in the transaction's universe exempt (resolved from
  `AssetAdminState.issuerIdentityKey` via the injected `stateStore.getAssetState`); error
  `identity not admitted: <key>`.
- `overlay-go/internal/mandala/topic_manager.go:592-603`: change the input-linkage `continue` (tolerate) to
  a reject, so both stacks fail closed on an unverifiable linkage.
- `overlay/src/registry.ts:179-188` `registryScreening`: keep the export (it is a legitimate
  `ScreeningProvider` shape) but stop wiring it; add a header comment saying membership is enforced by the
  gate, not by screening.
- `app/src/components/issuer/RegulatoryControls.tsx:537-541` and
  `app/src/components/issuer/IdentityRegistry.tsx:16-20,121-125`: the two warning copies can now say one
  thing consistently.

**ts-stack.** Optional follow-up: a first-class `membershipProvider` dependency on `MandalaTopicManager`
with the issuer exemption baked in, so the wrapper can be deleted. Not blocking.

**Parity.** The point of the item. Align the error string so the client's regex-based UX is
backend-independent; add the string to the parity matrix in `docs/PROJECT-STATE.md §10`.

**Tests.** The gates that can silently fail open, per G19:
- Go table test `TestMembershipHolds`: issuer exempt · non-admitted recipient refused · revoked sender
  refused · inactive registry no-op · tampered input linkage now **refused** (was tolerated).
- TS `overlay/src/mandalaGate.test.ts` asserting case-for-case parity with those five.
- **The brick case, both stacks:** an issuer admin action (`unpause`) admitted while the issuer's own
  registry row is absent.

**Stability.**
- *Crash at each await:* read-only gate.
- *Double-click / second tab:* unchanged.
- *Stale cache:* membership reads `mandalaRegistry` live per submit; the fold of a just-submitted
  `admitIdentity` lands in Phase 3, so an admit and the first transfer to that identity inside one submit
  cycle still races. Accept and document (same one-submit lag as G20); the retry succeeds.

---

### A05 — Spend-side identity from overlay state; prover-based input linkage (P1) — **BLOCKS THE BLINDING ROLLOUT**

**Why (requirement + hard prerequisite for D2).** R49: "the same specific revelation is attached to every
fungible input, so a spend can be named from the identity bound when that coin was first accepted."

Today the overlay names the spender from the submitter-supplied `linkage.counterparty`
(`verifyKeyLinkage.ts:28` returns `identityKey: linkage.counterparty`; consumed at
`MandalaTopicManager.ts:205-208` `anySanctioned` and `:306-317` `resolveSenders`; Go
`topic_manager.go:341-370`, `:592-603`), with **no pkh comparison against the spent script**.

The lib reveals input linkages with `counterparty = customInstructions.counterparty`
(`lib/src/transfer.ts:208-224` → `lib/src/tokens.ts:49-59 revealLinkage`), i.e. *the coin's previous
sender*. Under D2 that value is `A'`, a one-time key that is never registry-admitted. **The moment blinding
ships, every spend of a blinded receipt is refused by the membership gate** (TS: non-admitted ⇒ "sanctioned";
Go: `identity not admitted: <A'>`).

The math also shows the current input linkage can never be pkh-checked as written, which is why nobody
checked it. The coin is locked to `P = B + k·G`. The spender B reveals
`L = HMAC(ECDH(b, A'), ι) = k` with `prover = B`, `counterparty = A'`.
`counterparty + L·G = A' + k·G ≠ P`. But **`prover + L·G = B + k·G = P`**.

So the universal, checkable rule is **`owner + L·G == pkh`, where `owner = linkage.counterparty` for
outputs and `owner = linkage.prover` for inputs** — in each case the party that holds the key. And note the
prover is already authenticated independently: `verifyKeyLinkage` decrypts with
`counterparty: linkage.prover` (`verifyKeyLinkage.ts:11-16`), so only the holder of the prover's private
key can produce a decryptable blob. Two independent locks, no new crypto.

**The rule to implement.** For each index in `previousCoins`:
1. `row = stateStore.getTokenRow(sourceTXID, sourceOutputIndex)` — `mandalaTokens.identityKey` is the
   identity bound at first acceptance, which is literally what R49 asks the linkage to reproduce, and it is
   **payload-independent**. `getTokenRow` is already a declared topic-manager dependency
   (`MandalaTopicManager.ts:16`; Go `StateStore.GetTokenRow`, `topic_manager.go:21`) and is currently unused
   by any gate.
2. If a `payload.inputs` entry exists for that index: require `linkage.prover === row.identityKey` **and**
   `hash160(prover + L·G) === ` the spent output's `pubKeyHash` (reuse `linkageControlsPubKeyHash`
   against `tx.inputs[i].sourceTransaction.outputs[vout].lockingScript`). Mismatch → reject.
3. If there is no row and no verified linkage → reject (this is G07's "coverage is not required" closed:
   omitting a linkage no longer buys anonymity, because the row names you anyway, and a coin with neither is
   simply unnameable).
4. The screened identity is `row.identityKey` (fallback: the verified `linkage.prover`). **Never
   `linkage.counterparty`.**

Under blinding the row holds the real `B` (the output linkage at admission carried
`counterparty: recipientKey` — `lib/src/blinding.ts:131-175` sets the real key, only `A'` is one-time), so
screening keeps working and `A'` never enters a membership decision. That is the unblock.

**Files + functions.**
- `overlay/src/mandalaGate.ts`: implement 1–4; feed the resolved identities into the A04 membership check
  and the A11 access-mode check.
- `overlay-go/internal/mandala/topic_manager.go`: `resolveSenders` (`:377-427` region, the lazy closure) and
  `membershipHolds` (`:537-605`) both switch to `GetTokenRow` + prover-based verification; `anySanctioned`
  (`:341-370`) likewise.
- `lib/src/issuerOps.ts:295-303` `redeemTokens`: reveal a linkage per burned FT input exactly as
  `lib/src/transfer.ts:208-224` does and include them in the payload — today `inputs: []`, so an issuer
  redeem is structurally unscreened and will now be **rejected** by rule 3 unless the rows exist. (They do
  for overlay-admitted coins; reveal them anyway so the rule is uniform.)
- `lib/src/assets.ts:259-267` `submitAdminAction` and `:331-336` `submitGlobalAdminAction`: they submit
  `inputs: []` while spending an admin UTXO — admin inputs are not FT inputs and are not in
  `previousCoins` for FT purposes, so no change is required; assert that in a test so a future reader does
  not "fix" it.

**ts-stack.** The in-package `anySanctioned` / `resolveSenders` keep reading `.counterparty`, but with the
screening provider emptied (A04) `anySanctioned` is inert and `resolveSenders` only feeds the inner Gate 3,
which A11 supersedes with a stricter wrapper check. So **no ts-stack PR blocks this.** The PR that moves the
same source-of-truth resolution into `@bsv/overlay-topics` is the deferred bundle.

**Parity.** Both stacks must resolve identity from the same row and reject the same four ways. Add a golden
vector to `overlay-go/testdata/vectors.json` for a blinded coin: output linkage (counterparty = B) at
admission, then input linkage (prover = B, counterparty = A') at spend, with the spent pkh.

**Tests.**
- `lib/src/blinding.test.ts` (extend): assert `hash160(prover + L·G) === outputPubKeyHash` for a linkage
  revealed the way `transfer.ts` reveals it — this is the invariant the overlay will rely on.
- TS wrapper + Go: blinded coin spent by an **admitted** B is admitted although the input linkage names an
  unknown `A'`; blinded coin spent by a **revoked** B is refused; an input linkage whose prover does not
  match the token row is refused; an FT input with neither row nor linkage is refused.
- `lib/src/issuerOps.redeem.test.ts`: the payload now carries one input linkage per burned FT input.

**Stability.**
- *Crash at each await:* one `getTokenRow` per previous coin, read-only, before any mutation; the engine's
  Phase 3 is untouched.
- *Double-click:* the second submit spends the same coins; the engine's applied-transaction check and the
  chain reject it. No new state.
- *Second tab:* `mandala.send` web lock unchanged; this gate is the server-side backstop.
- *Stale cache:* the token row is written in Phase 3 of the *admitting* submit, so a coin received and
  re-spent inside one submit cycle has no row yet. Rule 3 would then reject a legitimate spend. **Mitigation
  (required):** fall back to the verified prover-based linkage when the row is absent *and* the linkage
  verifies against the spent pkh — that is still a real authorship proof (§0's analysis), so the fallback is
  safe. Only "no row **and** no verifying linkage" rejects. Encode that precedence explicitly in both
  implementations and test the no-row-but-valid-linkage path.

---

### A06 — Persistent `admitSeq` on the TS registry store (P1; G09)

**Why (requirement).** R30 MUST: "the database is a cache — **not process memory**."
`overlay/src/registry.ts:36,63-66` is `private seq = 0; nextSeq() { this.seq += 1; return this.seq }`, while
`list()` sorts `{admitSeq: -1}` (`:59-61`). Every restart makes a fresh link sort *below* pre-restart rows,
so `GET /admin/registry` stops returning the chain head first — which is precisely what
`lib/src/registry.ts:66-71 listRegistryAuth` and A07 depend on. Go already does this right with the shared
Mongo counter (`registry_lookup.go:51`, `storage.go:504-518`), so the two backends also disagree on row
order over one database.

**Files + functions.** `overlay/src/registry.ts:34-67` `RegistryStore`: take the shared
`MandalaStorageManager` (or the `Db`) and replace `nextSeq()` with the atomic
`findOneAndUpdate({_id:'admitSeq'}, {$inc:{seq:1}}, {upsert:true, returnDocument:'after'})` on
`mandalaCounters` — `MandalaStorageManager.nextAdmitSeq` already implements exactly this; inject
`sharedStorage` from `overlay/src/index.ts:70-75`. `nextSeq` becomes async; update the one caller in
`createRegistryLookup` (`:148-176`).

**ts-stack.** No. **Parity.** Brings TS to Go's behaviour; add the counter to the parity matrix.

**Tests.** `overlay/src/registry.test.ts`: a second `RegistryStore` instance over the same db continues the
sequence (does not restart at 1); two concurrent folds get distinct sequence numbers.

**Stability.**
- *Crash at each await:* `$inc` is atomic; a crash between the increment and the upsert burns a sequence
  number, which is harmless (the order is what matters, not density).
- *Double-click / second tab:* two folds of the same output would produce two rows — but the upsert is keyed
  by `identityKey`, so it is idempotent in effect.
- *Stale cache:* **this is the item that makes restarts safe.** Without it, the A01 deploy restart itself
  corrupts head ordering — see §3.

---

### A07 — Registry head selection = chain head, not the issuer's row (P0 for the runbook; G02)

**Why (broken).** `lib/src/registryRecover.ts:65-72 pickRecoverableRegistryRow` prefers the **issuer's** row.
Rows are keyed by the *target* identity (`foldRegistry`, `overlay/src/registry.ts:69-83`), so after the first
peer admit the issuer's row still points at the genesis txid while the chain head is the admit tx's output 0.
`mockKycAdmit` always calls `recoverRegistryAuth` first (`lib/src/registry.ts:446`) and
`recoverRegistryAuth` returns the picked row's outpoint even when the basket disagrees
(`registryRecover.ts:177-180`). The **second** admit therefore builds `priorOutpoint = <genesis>.0`, which is
already spent: the overlay's `priorSpent` cannot pass and the wallet cannot fund the input.

**Files + functions.** `lib/src/registryRecover.ts:65-73`: return `rows.find(r => r.txid !== '')` — rows
arrive newest-first by `admitSeq` (`lib/src/registry.ts:66-71`; server sort `overlay/src/registry.ts:59-61`)
and status is irrelevant, because a `revokeIdentity` link is equally the head. Drop the issuer preference and
the `issuerIdentityKey` parameter. `lib/src/registry.ts:380-394 reconstructRegistryDetails` must then infer
`revokeIdentity` for a revoked head. Update `lib/src/registryRecover.test.ts` — the existing case "prefers
the admitted issuer row over a later peer" **inverts**.

**ts-stack.** No. **Parity.** Client-only.

**Tests.** `registryRecover.test.ts`: head is the newest row regardless of identity; a revoked head is
selected and `reconstructRegistryDetails` produces `revokeIdentity`; the issuer row is *not* preferred.

**Stability.**
- *Crash at each await:* `recoverRegistryAuth` is read + `internalizeAction` (already tolerant of
  `/already|duplicate|exists/i`).
- *Double-click:* `registryFlight` + `abortStuckRegistryActions` (runbook failure 7's fix, already in tree).
- *Second tab:* add the `mandala.registry` web lock with A03.
- *Stale cache:* **depends on A06.** "Newest by `admitSeq`" is only meaningful once `admitSeq` survives a
  restart — this is the reason A06 sequences before A07.

---

### A08 — Reissue remittance journaled, not awaited after commit (P1; G08)

**Why (stability mandate).** `lib/src/assets.ts:270-276` sends the reissue notification **after**
`submitAndBroadcast` has committed, inline, awaited, unjournaled. A MessageBox outage therefore throws
*after* the reissue is admitted and broadcast: the console reports failure for a succeeded action, the
operator retries, and the retry dies on a spent prior as `StaleAdminAuthError`. The recipient is never told
and `reconcileNotifications` cannot help because nothing was journaled. The body also omits `outputIndex`
(receive falls back to 0 — correct only because `randomizeOutputs:false`) and `senderMode`.

**Files + functions.** `lib/src/assets.ts:268-277` inside `submitAdminAction`: mirror
`lib/src/transfer.ts:248-280` exactly — build the body with `outputIndex: 0` and `senderMode: 'unblinded'`,
`notifyPut({txid, recipient, messageBox, body, at})` **before** the send, wrap `sendMessage` in a try/catch
that only `console.warn`s, `notifyRemove(txid)` on success, and return `notified: boolean` from
`submitAdminAction` so `app/src/components/issuer/RegulatoryControls.tsx:145-160 run()` can say "reissued;
recipient notification pending".

**ts-stack.** No. **Parity.** Client-only.

**Tests.** `lib/src/robustness.recovery.test.ts` (extend): journal written before `sendMessage`; a throwing
`sendMessage` leaves the journal entry and does **not** throw out of `submitAdminAction`;
`reconcileNotifications` retries it; the body carries `outputIndex` and `senderMode`.

**Stability.**
- *Crash at each await:* the only await after the commit point is now journaled-then-fire; a crash between
  `notifyPut` and `sendMessage` is recovered by `reconcileNotifications` at boot.
- *Double-click:* `withAdminAuthGate` serialises; a duplicate notification is safe because
  `receive.ts` acks by `messageId` and treats an already-internalized output as success.
- *Second tab:* `mandala.admin.<assetId>` web lock.
- *Stale cache:* `notifyJournal` is per-txid, so a stale entry for an already-delivered message costs one
  redundant send.

---

### A09 — On-chain marker on admin-auth outputs (P1; G10)

**Why (requirement + the recurring production failure).** R23 (H§05) allows a pushed-and-dropped JSON
prefix. Only `registerAsset` passes `publicData` (`lib/src/issuerOps.ts:42`); every subsequent auth output is
a bare 5-chunk P2PKH (`MandalaAdmin.lock`, `@bsv/templates/src/MandalaAdmin.ts:83-103`). That is the exact
shape wallets reclassify as vanilla P2PKH and strip customInstructions from — runbook.md:133 failure 3, and
the documented reason the registry lock grew an `OP_DROP` marker (`lib/src/registry.ts:80-81`). When it
happens to an asset, `listAdminAssets` returns nothing and **every** admin operation for that asset becomes
impossible.

**Files + functions.** `MandalaAdmin.decode` already accepts the 7-chunk form and `commitment(details)` does
**not** include `publicData`, so adding a marker changes no key and keeps every existing chain verifiable:
- `lib/src/assets.ts` `submitAdminAction` (the `MandalaAdmin.lock` call at `:217`) and
  `buildGlobalAdminActionArgs`: pass `publicData: { t: 'mandala-admin', assetId }`.
- `lib/src/issuerOps.ts` `issueTokens` (`:109` region) and `redeemTokens` (`:232` region): same.
- Caveat to carry in the PR description: `MandalaLookupService.indexAdminOutput`
  (`overlay/node_modules/@bsv/overlay-topics/src/mandala/MandalaLookupService.ts:90-97`) upserts a
  `mandalaMetadata` row keyed by the output's own outpoint whenever `publicData != null`. The asset's real
  metadata (queried as `{metadataAssetId: <genesis outpoint>}`, `lib/src/metadata.ts:29`) is unaffected, but
  each admin action adds a junk row. Either accept them or fold a `publicData.t !== 'mandala-admin'` guard
  into the deferred ts-stack PR.

**ts-stack.** No for the marker; the junk-metadata guard is a nice-to-have in the deferred PR.

**Parity.** None needed — `DecodeAdmin` (`overlay-go/internal/mandala/admin.go:21-48`) already accepts the
7-chunk form, but add a Go golden vector for `{t:'mandala-admin', assetId}` so the JSON-object requirement
(Go `json.Unmarshal` into `map[string]any`, stricter than TS `JSON.parse`) is proven.

**Tests.** `lib/src/assets.test.ts`: the marker is present, and `MandalaAdmin.commitment(details)` is
byte-identical with and without `publicData` (so existing chains stay spendable).
`overlay-go/internal/mandala/admin_test.go`: decode the new vector.

**Stability.**
- *Crash at each await:* no change to ordering.
- *Double-click / second tab:* unchanged.
- *Stale cache:* the marker is what **prevents** the stale-basket failure this whole item exists for.

---

### A10 — Overlay-backed recovery of the per-asset admin-auth head (P0-severity, L; G01)

**Why (availability).** The live admin outpoint is discovered **only** from the wallet basket
(`lib/src/assets.ts:75-84 listAdminAssets`, resolver `:62-72`), declared "the source of truth for the auth
chain (no localStorage, no on-chain marker)" (`lib/src/issuerOps.ts:53-55`). There is no counterpart to
`registryRecover.recoverRegistryAuth` for an asset. The registry spine already hit exactly this failure in
production (runbook.md:133). A09 stops the loss; A10 is the way back when it has already happened.

**Files + functions.**
1. `overlay/src/index.ts`: `GET /admin/asset-auth/:assetId` → `{authOutpoint, authDetails}` from
   `assetAuthHead()` (the helper introduced by A02); `GET /admin/asset-auth/beef/:txid?vout=` mirroring the
   existing registry BEEF route (`overlay/src/index.ts:130-147`) but against topic `tm_mandala`.
2. `overlay-go/internal/httpapi/admin.go`: both routes, in the same change set (so G15 does not recur);
   BEEF from `internal/enginestore` (`FindOutputsByTxid`, `RawTxHexByTxid`).
3. **New** `lib/src/assetRecover.ts` (or extend `lib/src/assets.ts`): `recoverAdminAuth({wallet, assetId})`
   as a near-copy of `lib/src/registryRecover.ts:147-181` — fetch the head, `internalizeAction` with
   `protocol:'basket insertion'` and `adminCustomInstructions(...)`, tolerate `/already|duplicate|exists/i`,
   and return the overlay head even when the basket still lacks CI.
4. `app/src/components/issuer/IssuerDashboard.tsx`: a "Re-attach asset authority" card when the overlay
   knows an asset the basket does not, mirroring `IdentityRegistry.tsx:127-149`; a new hook
   `app/src/hooks/useAssetAuth.ts` keyed `['asset-auth', assetId]`.

**ts-stack.** No — the data already exists in `mandalaAdminHistory`
(`MandalaLookupService.ts:108-110`), served by `GET /admin/admin-history/:assetId`.

**Parity.** Both routes on both backends in one change set, with the Appendix-B wire rules (camelCase,
arrays never null, `500 {error}` on admin errors).

**Tests.** `overlay/src/index` route test for head ordering `(height, offset, admitSeq)` and 404 shape; Go
`httpapi/admin_test.go` mirror including a URL-encoded assetId; `lib/src/assetRecover.test.ts` for
overlay-head recovery with `internalizeAction` mocked, already-exists tolerated, and the head returned even
when the basket listing stays empty.

**Stability.**
- *Crash at each await:* `internalizeAction` is idempotent by the already-exists regex; a crash before it
  leaves nothing.
- *Double-click:* two internalizes of the same output — second is an already-exists no-op.
- *Second tab:* both tabs converge on the same overlay head; no write ordering to protect.
- *Stale cache:* the endpoint reads history live; `useAssetAuth` should use `staleTime: 0` on the recovery
  path so a re-attach is not answered from the 15 s default.

---

### A11 — Access mode re-evaluated on state-resolved senders (P1 once blinding ships)

**Why (security hole opened by D2).** Gate 3 resolves parties from `payload.inputs` linkage
*counterparties* (`MandalaTopicManager.ts:301-317`; Go `topic_manager.go:457-476`). Under blinding a
denylisted sender's spend names `A'`, which is on no denylist, so the sender passes. Their *change* output is
locked to their real key and is screened as an admitted-FT recipient — so a blocked sender **with change** is
still caught, but a blocked sender spending exactly (no change) is not. That hole opens the day blinding
ships.

**Files + functions.** `overlay/src/mandalaGate.ts`: after delegating, re-run the access-mode decision with
the A05-resolved sender identities (a conjunction of gates is sound — the wrapper only ever *adds* refusals).
`overlay-go/internal/mandala/topic_manager.go:432-503` `assetGatePasses` / `accessModeRejects`: consume the
A05-resolved senders directly (Go is repo-local, so fix in place rather than wrapping).

**ts-stack.** The duplicated weak check inside `@bsv/overlay-topics` is deleted by the deferred PR; not
blocking.

**Parity.** Same party set on both stacks, including the issuer exemption (`state.issuerIdentityKey`).

**Tests.** Blinded, exact-amount (no change) spend by a **blocked** identity is refused on both stacks —
this test fails before A11 and is the regression guard for the hole.

**Stability.** Read-only; identical to A05's profile. *Stale cache:* uses the same `mandalaAssetStates` read
as the inner gate, so it inherits (and does not worsen) the one-submit fold lag.

---

### A12 — σI captured, persisted, served, verified; payee-decryptable recipient linkage (P2; G11 + D2 half)

**Why (requirement).** R62 MUST (σI returned on acceptance), R65 SHOULD (holders demand it at receipt), R69
MUST for offline. Today both backends produce σI (`overlay/src/admission.ts:8-22,55-98`;
`overlay-go/internal/httpapi/admission.go:34-48`, `submit.go:140-180`) and the client surfaces it only on the
holder path (`lib/src/overlay.ts:5-31` → `lib/src/transfer.ts:63,236,282`). Grep for `admissionSignature` in
`lib/src` and `app/src` returns only `transfer.ts` and `overlay.ts`: `registerAsset`, `issueTokens`,
`redeemTokens`, `submitAdminAction`, `submitGlobalAdminAction` and every registry action `await
submitAndBroadcast(...)` **without capturing the result**, so the acceptance proof for every administrative
spend is discarded at the call site.

**Files + functions.**
1. `lib/src/issuerOps.ts`, `lib/src/assets.ts`, `lib/src/registry.ts`: capture the `OverlayAdmitResult` and
   thread `{admissionSignature, admissionIdentityKey}` out of every return type.
2. `lib/src/txJournal.ts`: extend the `'accepted'` entry with the two fields — it is written before
   broadcast anyway (`lib/src/overlay.ts:72-116`), so this is a durable receipt at no extra I/O.
3. `overlay/src/index.ts` + `overlay-go/internal/httpapi/admin.go`: `GET /admin/admission/:txid`, backed by a
   new `mandalaAdmissions` collection `{txid, signature, identityKey, height, createdAt}` written where σI is
   generated (`overlay/src/admission.ts`, `overlay-go/internal/httpapi/admission.go`).
4. **New** `lib/src/admission.ts`: `verifyAdmission(txid, signature, identityKey)` (ECDSA over
   `SHA-256("mandala-admit:" + txid)`); call it from `lib/src/receive.ts:32-58 verifyIncoming`; show a
   "σI verified" chip in `app/src/components/issuer/AuditLog.tsx` / `OverlayActivity.tsx`.
5. **D2 obligation:** add `recipientLinkage` (a `SpecificLinkage` with `verifier` = the recipient) to the
   MessageBox body in `lib/src/transfer.ts:248-280` and verify it in `receive.ts verifyIncoming`, matching
   the nearby rail's existing `recipientLinkage` field
   (`/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/core/localpay/codec.ts:20`,
   verified by `…/localpay/verify.ts:150-199 verifyRecipientLinkage`). Without this the web rail's payee
   cannot check that the payer minted honest linkage — the whole point of D2's "payee-decryptable".
6. Delete the dead `signAdmission` variant (A21) in the same change.

**Out of scope here (deferred).** "verified against the key **live at the height** of the Merkle path"
(R34/R69) requires rotation; cap A12 at verification against the current key and say so in the code comment.

**ts-stack.** No.

**Parity.** New collection + route on both backends; same DER hex encoding and the same
`SHA-256("mandala-admit:"+txid)` digest (already byte-compatible per `admission.test.ts` /
`admission_test.go`).

**Tests.** `lib/src/admission.test.ts` round-trip against a known key; `receive.test.ts` rejects a message
whose σI does not verify **but only warns when σI is absent** (legacy messages must keep working);
`overlay/src/admission.test.ts` and Go `admission_test.go` extended to the persistence + re-serve path.

**Stability.**
- *Crash at each await:* the σI write happens where the signature is produced, before the HTTP response; a
  crash loses the row but the client still holds the signature in its `'accepted'` journal entry — two
  independent copies, which is the point.
- *Double-click:* `mandalaAdmissions` keyed by txid, upsert.
- *Second tab:* per-txid, no contention.
- *Stale cache:* none; the endpoint is a point lookup.

---

### A13 — `/admin/*` bearer auth and narrowed CORS (P2; G18)

**Why (privacy).** Every bespoke route sets `Access-Control-Allow-Origin: *` with no auth
(`overlay/src/index.ts:96,108,120,131,164,199,222`; Go `server.go:151-162` additionally sets
`Allow-Private-Network: true`). `GET /admin/registry` returns the complete list of KYC'd identity keys;
`GET /admin/activity` returns linkage-derived counterparties per transaction. R74 treats exactly this as the
sensitive asset, and D2's whole purpose (keeping the sender's identity from the recipient) is partly undone
by a public `/admin/activity`.

**Files + functions.** Gate the identity-bearing routes (`/admin/registry`, `/admin/activity`, and A12's
`/admin/admission/:txid`) behind `ADMIN_API_TOKEN` from env, CORS narrowed to `HOSTING_URL` / the console
origin. Leave `/admin/asset-state`, `/admin/admin-history*`, `/admin/admin-summary` and A10's
`/admin/asset-auth*` public — they are the public audit surface R29 wants. Client: add the token to
`app/.env` and to `configureMandala` in `lib/src/constants.ts` (which D3a is rewriting anyway — do them
together), consumed by `lib/src/registry.ts:367-371 fetchRegistry` and
`lib/src/overlayActivity.ts:39-52`.

**ts-stack.** No. **Parity.** Same route split, same `401` shape on both.

**Tests.** Route tests on both stacks: unauthenticated `/admin/registry` → 401; with token → 200;
`/admin/asset-state` unauthenticated → 200.

**Stability.** *Stale cache:* a rotated token must invalidate the react-query caches keyed
`['overlay-registry']` / `['overlay-activity']` — surface the 401 as an error state rather than an empty
list, or the Identities page silently shows "no identities admitted", which reads as a compliance event.

---

### A14 — `issue` commits a hash of the deposit record (P1; G04)

**Why (requirement).** R12 MUST: an issuance spend "commits a hash of the deposit record"; R22 lists "any
bank reference" in the committed canonical action object. Today `issueDetails` has exactly four fields
(`lib/src/issuerOps.ts:103-108`). `MandalaActionDetails.bankRef?: string` is declared
(`@bsv/templates/src/MandalaAdmin.ts:29`) and rendered for reissue only
(`lib/src/adminHistory.ts:106`), but nothing sets it. The console's "Backed by (optional)" input is
explicitly inert: `// UI-only state (not passed to any core function)`
(`app/src/components/IssuerPanel.tsx:26-28`, field at `:174-183`).

**Files + functions.** The commitment mechanism already exists — anything inside `details` is hashed into the
locking keyID, so adding a field *is* the on-chain commitment:
1. `lib/src/issuerOps.ts`: `IssueParams` gains `depositHash?: string`; build
   `withReason({kind:'issue', assetId, amount, priorOutpoint, bankRef: depositHash}, …)` using the existing
   omit-when-empty discipline (`lib/src/assets.ts:55-58`) so ref-less commitments stay byte-identical.
2. `lib/src/submitGuards.ts` `guardIssueSubmit`: require a 64-hex `bankRef` when a deposit ref is configured
   as mandatory; optional otherwise.
3. `app/src/components/IssuerPanel.tsx`: pass `issueRef` through `useIssuerMutations().issue`, hashed
   client-side (`Hash.sha256(utf8(ref))`) so the bank record stays off-chain — which is what "commits a
   **hash** of the deposit record" asks for.
4. `lib/src/adminHistory.ts:106 describeAction`: render `bankRef` for `issue` too; add the column to
   `exportAdminHistoryCsv` (`:113-132`).

**ts-stack.** No. **Parity.** None — the overlay hashes whatever is in `details`.

**Tests.** `lib/src/adminHistory.test.ts`: `describeAction` renders `bankRef` for issue; CSV column present.
`lib/src/submitGuards.test.ts`: the 64-hex requirement. A commitment-stability test: `issue` without a ref
produces the same `commitment` as before the change.

**Stability.** *Stale cache:* none. The only real risk is a commitment change breaking an existing chain —
covered by the byte-identity test.

---

### A15 — Gate + intent on `registerAsset` and `submitGlobalAdminAction` (P2; G17)

**Why (stability mandate).** Every other admin pipeline runs inside `withAdminAuthGate(assetId, prior, …)`
+ `withIntent(…)` (`lib/src/issuerOps.ts:92`, `lib/src/assets.ts:216`). `registerAsset`
(`lib/src/issuerOps.ts:36-73`) and `submitGlobalAdminAction` (`lib/src/assets.ts:286-339`) do neither. For
`registerAsset` there is no prior to serialise, but the missing `withIntent` means a crash between
`createAction` and `submitAndBroadcast` leaves a stuck `noSend` action that the reconcile bulk sweep may
abort or leave dangling, and there is no `reference` to abort on rejection (`issuerOps.ts:68-71`).
`submitGlobalAdminAction` spends N priors with no per-asset serialisation at all.

**Files + functions.** `lib/src/issuerOps.ts:36-73`: wrap the body in `withIntent` and capture
`created.signableTransaction?.reference` so `submitAndBroadcast` can abort on rejection.
`lib/src/assets.ts:286-339`: wrap in a composed gate over every asset it touches — **acquire in sorted
assetId order** to avoid deadlock — plus `withIntent`. `lib/src/webLocks.ts`: add the cross-tab
`mandala.register` lock next to `mandala.send`.

**ts-stack.** No. **Parity.** Client-only.

**Tests.** `lib/src/adminAuthGate.test.ts`: composed multi-asset acquisition is order-stable and releases on
throw. `lib/src/robustness.recovery.test.ts`: a crash after `createAction` in `registerAsset` leaves a
journal intent that the sweep respects until TTL.

**Stability.** This item *is* the stability answer for two pipelines: *crash at each await* → intent marker
+ abortable reference; *double-click* → `registerFlight` (in-process) plus the composed gate;
*second tab* → the new `mandala.register` web lock, which is what `registerFlight` cannot do;
*stale cache* → `assertSpendablePrior` on each asset in the composed gate.

---

### A16 — Refuse a freeze of an outpoint with no token row (P2; G14 repo-local half)

**Why.** The freeze fold reads `getTokenRow(txid, vout)` at fold time and, when the row is absent, records
`{amount: 0, owner: ''}` (`MandalaLookupService.ts:117-122`; `AssetStateReducer.ts:43-50`). Reissue guard (b)
then requires `details.amount === 0`, which `guardPositiveAmount` refuses in the console
(`RegulatoryControls.tsx:253-255`). The coin can only ever be unfrozen — a mis-timed freeze is a dead end
with no operator-visible explanation. Go computes `FoldContext.HasFrozenRow` (`reducer.go:28`) but nothing
acts on it.

**Files + functions.** `overlay/src/mandalaGate.ts` and `overlay-go/internal/mandala/topic_manager.go`:
refuse a `freezeOutput` at **admission** when `stateStore.getTokenRow(target)` is null (the state store is
already a topic-manager dependency). Surface `HasFrozenRow` in `GET /admin/asset-state` on both backends so
`app/src/components/issuer/RegulatoryControls.tsx:617-631` can grey out an un-reissuable ref.
The upstream half (debit the evicted owner inside the same storage operation that records the eviction) is
deferred to the ts-stack PR.

**ts-stack.** The balance-debit half: yes, deferred. The admission refusal: no.

**Parity.** Same refusal, same error string; `HasFrozenRow` in both `/admin/asset-state` payloads.

**Tests.** Both stacks: freezing an already-spent outpoint is refused; freezing a live one still works; the
state payload carries the flag. Deferred upstream test: "freeze → reissue → total balances unchanged".

**Stability.** *Stale cache:* the token row is deleted in Phase 3 of the spending tx, so a freeze submitted
in the same cycle as the spend may still see a row. That is a race the chain resolves (the spend wins); the
refusal only removes the *silent* dead end.

---

### A17 — Go registry parity: `actionDetails` + `/admin/registry/beef` (P2; G15)

**Why.** `RegistryRow` in Go has no `actionDetails` (`overlay-go/internal/mandala/registry.go:18-25`) whereas
TS stores it (`overlay/src/registry.ts:26-32`), and Go has **no** `/admin/registry/beef/:txid` — a hard
dependency of `lib/src/registryRecover.ts:53-63`. Against the Go backend, registry recovery falls back to
WhatsOnChain mainnet (`registryRecover.ts:30`, hard-coded) and to `reconstructRegistryDetails`'s heuristic
(`lib/src/registry.ts:380-394`) — and a heuristic that guesses wrong produces a wrong `keyID` and an
unspendable input.

**Files + functions.** `overlay-go/internal/mandala/registry.go`: add `ActionDetails map[string]any` to
`RegistryRow`, persist in `FoldRegistry` / `UpsertRegistry`. `overlay-go/internal/httpapi/admin.go`: add
`GET /admin/registry/beef/:txid?vout=` reading `engineOutputs` via `internal/enginestore`
(`FindOutputsByTxid`, `RawTxHexByTxid`). Do it in the same change as A10's `/admin/asset-auth/beef` so both
spines get the same recovery surface on both backends.

**ts-stack.** No. **Parity.** This item *is* the parity item.

**Tests.** Go `registry_test.go`: `actionDetails` round-trips through Mongo in the TS document shape (the
same discipline as `TestLinkageReadsTSShapeDocument`). Go `httpapi/admin_test.go`: BEEF route 200 + 404
shapes matching `overlay/src/index.ts:130-147`.

**Stability.** *Stale cache:* none. Removes a heuristic that can mint an unspendable input.

---

### A18 — Forceable asset-state fetch (P2; G20 client half)

**Why.** `lib/src/adminState.ts:14-15 resolveAssetState` memoises for 10 s, so
`RegulatoryControls.tsx:145-149`'s awaited `invalidateAssetState` can still return pre-action state and the
operator sees their freeze "not applied".

**Files + functions.** `lib/src/adminState.ts`: add `resolveAssetState(assetId, { force })`; pass `force`
from `app/src/hooks/useAssetState.ts` on the post-mutation path. (Alternatively drop the TTL to ~1 s; the
explicit flag is better because it does not increase steady-state load.) The overlay half — folding admin
admissions synchronously, or serialising fold + control gate per assetId under one mutex — is the deferred
ts-stack item.

**ts-stack.** Overlay half: yes, deferred. Client half: no.

**Tests.** `lib/src/adminState.test.ts`: `force` bypasses the memo; the memo still applies without it.

**Stability.** *Stale cache:* this item is the stale-cache answer. Note in the code that the remaining
one-submit *server* lag is separate and unfixed here.

---

### A19 / A20 / A21 — Operator safety and audit polish (P3)

- **A19** (`app/src/components/issuer/RegulatoryControls.tsx`, `IdentityRegistry.tsx:273-285`): typed
  confirmation on the destructive subset (pause, block, freeze, reissue, `setAccessMode`, registry revoke) —
  a freeze can strand a coin permanently (A16) and an allowlist switch can brick transfers. Replace the
  static "Verified issuer" chip (`IssuerDashboard.tsx:213-218`, backed only by
  `identityKey === VITE_OVERLAY_IDENTITY_KEY`, `WalletContext.tsx:48`) with either nothing or the actual
  registry status from `useOverlayRegistry`.
- **A20** (`lib/src/adminHistory.ts`, `app/src/hooks/useOverlayActivity.ts`): render the `reason` field
  (it is inside the commitment via `withReason` but never displayed); render `bankRef` for `issue` (A14);
  drop the removed `recover` kind from `describeAction:86-89` and `lib/src/history.ts:222`; fix
  `HistoryRow.when` (always 0, `history.ts:124-127`); invalidate `['overlay-activity', assetId]` after an
  admin mutation.
- **A21** (`overlay/src/admission.ts:24-39`): delete the unused `signAdmission`, which signs with a BRC-42
  child under `[2,'mandala admission']` while returning `getPublicKey({identityKey:true})` — a signature that
  would **not** verify against the returned key. Ship it with A12 so no future caller picks the broken one.

**ts-stack.** No. **Parity.** None (client/TS-overlay only). **Tests.** `adminHistory.test.ts` for the
`reason`/`bankRef` rendering; a source-string assertion in `app/src/robustness.wiring.test.ts` for the
confirmation handlers. **Stability.** A19 is the double-click answer for the destructive subset: the
confirmation is the second, deliberate click.

---

### A22 — Test backfill for every new gate (P1, continuous; G19)

Untested today, across both backends: Go `membershipHolds` / `WithRegistry` (zero test references), both
`RegistryTopicManager`s, `RegistryLookupService`, `/admin/registry`, TS `registryScreening`, TS
`wrapSubmitJson` / `txidFromSubmitBody` (the σI middleware's re-parsing of the varint framing), and
`overlay/src/index.ts` routes. Client-side: no test exercises `admitOrRevokeIdentity`, `mockKycAdmit`,
`registerIdentities`, `issueTokens`' happy path, or `submitAdminAction` end-to-end. App tests are
import-smoke plus source-string assertions with no component rendering.

**The green light is not evidence here** — all suites pass (app 46, lib 217, overlay TS 28, Go all ok) and
none of them cover a single new gate. Every item above carries its own tests; the standing rule is: a gate
that can fail *open* does not land without a test that fails before the fix. Priority order:
`membershipHolds` (Go table test) → the TS wrapper parity test → `RegistryTopicManager` per gate (kind
whitelist, pkh re-derivation, `priorSpent`, 1-sat, no-admissible-output throw) → `wrapSubmitJson` fed a real
framed body → mock-wallet tests for `admitOrRevokeIdentity` (prior == input, topic == registry only,
`noSend`) and `submitAdminAction`'s reissue path including A08's journal ordering.

---

### D3a / D3b / D3c — React-Native-safe `@bsv/mandala` (D3)

**D3a — remove `import.meta`.** `lib/src/constants.ts:16-17` reads
`(import.meta as unknown as {env?}).env ?? {}`. `import.meta` is a *parse-time* construct: Metro/Hermes
rejects the module outright, so the `?? {}` guard does not help. Delete the read; keep
`OVERLAY_URL` / `OVERLAY_IDENTITY_KEY` / `MESSAGEBOX_URL` as `export let` seeded to `''` and make
`configureMandala` the required entry point (it already mutates the live ESM bindings, `:30-34`). Move the
Vite read into the app: `app/src/main.tsx` calls `configureMandala({overlayUrl: import.meta.env.VITE_OVERLAY_URL, …})`
before mounting. Add a throwing guard in `lib/src/overlay.ts:16-32 submitToOverlay` when `OVERLAY_URL === ''`
so a missing `configureMandala` fails loudly instead of POSTing to `/submit`. Add `ADMIN_API_TOKEN` here at
the same time (A13).

**D3b — package exports.** `lib/package.json` `exports` declares only `types` + `import` for `"."` and
`"./*"`. Metro resolves `default` (and, in some configurations, `react-native`). Add `"default"` to both
entries, mirroring `import`. Keep `"type": "module"`. Verify with a minimal Metro resolution test rather than
by inspection.

**D3c — injected storage adapter.** `lib/src/txJournal.ts:47-53`, `lib/src/notifyJournal.ts:32`,
`lib/src/blindingJournal.ts:23` all hit `localStorage` behind a `typeof` guard with an in-memory fallback —
on RN that fallback means **the journals die with the process**, which breaks the entire recovery contract
(overlay-accepted-but-not-broadcast is unrecoverable). Introduce **new** `lib/src/storage.ts`:
`interface MandalaStorage { getItem(k), setItem(k, v), removeItem(k), keys(prefix) }` + `configureStorage()`,
default = the existing localStorage implementation; the wallet injects an adapter over
`StorageExpoSQLite.getKeyValue` / `setKeyValue`
(`/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/core/storage/StorageExpoSQLite.ts:215,223`),
which is the same pattern its own `localpay/pending.ts:56` and `pay/watchlist.ts:38` already use.

**The consequence to plan for: the journal API becomes async.** `journalPut` / `journalList` /
`journalRemove` / `journalIntentBegin|End` are synchronous today and are called at the exact points where
ordering is the safety property. Every call site must `await`:
`lib/src/overlay.ts:72-116` (the `'accepted'` write **before** the background broadcast — this is the commit
point, and it must now be an awaited write), `lib/src/transfer.ts:194,227-235,248-280`,
`lib/src/assets.ts` (A08's `notifyPut`), `lib/src/reconcile.ts:57-136`, `lib/src/issuerOps.ts` (`withIntent`).
Sequence D3c **after** A08 and A15 so that the ordering being made async is the corrected ordering, not the
broken one.

**ts-stack.** No. **Parity.** None. **Tests.** `lib/src/storage.test.ts` with a fake async adapter;
re-run `lib/src/robustness.recovery.test.ts` against it (intent TTL, abort retention/cap, already-broadcast);
a test that `submitAndBroadcast` does not call `createAction({sendWith})` until the `'accepted'` write has
resolved.

**Stability.** *Crash at each await:* the async journal makes the "journal before broadcast" ordering
explicitly awaitable — strictly better than today, provided every site awaits. *Double-click:* per-key
writes, last-writer-wins, idempotent. *Second tab:* RN is single-process, so `navigator.locks`'s absence
(`lib/src/webLocks.ts:28` in-process Set fallback) is *correct* there; on web the fallback is still the
documented cross-device gap. *Stale cache:* SQLite reads are authoritative; drop the in-memory Map mirror in
the three journals, or make it write-through, so a second reader cannot see a stale entry.

---

### D4 — Address rail refusal is a protocol fact, not a UI opinion

**Why.** D4 says the address rail shows as unavailable for stablecoins with a plain reason. The reason is
enforced, not editorial: a bare P2PKH address cannot receive a Mandala token because the output key is
ECDH-derived against the recipient identity key (`MandalaToken.lockBRC29`,
`@bsv/templates/src/MandalaToken.ts:33-44`) and the overlay refuses any FT output whose owner it cannot name
from a linkage (`MandalaTopicManager.ts:155-170 verifyFtOutputs` silently drops it →
`conservationHolds:172-197` fails → the whole transaction is refused).

**Files + functions.** `lib/src/submitGuards.ts`: a `guardTokenRecipient(recipient)` that accepts only a
compressed identity key (reuse `guardIdentityKey`'s `/^(02|03)[0-9a-fA-F]{64}$/`) and returns the plain
reason string the wallet's rail selector renders. Wallet-side consumption is
`/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/core/pay/rails/address.ts` (disable for token
assets) with `handle.ts` / `nearby.ts` remaining.

**ts-stack.** No. **Parity.** None.

**Tests.** `lib/src/submitGuards.test.ts` for the guard; an overlay test asserting that an FT output with no
payload linkage causes a **whole-transaction** rejection (the property the UI copy is claiming) — this is
the test that makes the reason true rather than asserted.

**Stability.** Pure guard.

---

## 3. Ordering, with rationale

### Phase 0 — before any code lands (hours)

**A00.** Know whether the mainnet asset and the live registry chain are already compromised *before* you
change what the overlay accepts. A01 is forward-looking only; a forged `issue` already folded into
`mandalaAssetStates` stays folded. Record the result in `runbook.md`.

### Phase 1 — one overlay build + restart, one lib rebuild (days)

**A01 → A02 → A03 → A06 → A07**, then **▶ the runbook retry**.

Rationale, in order:
- **A01 first** because it is the only item that closes an unbounded mint. Everything else is defence in
  depth or availability.
- **A02 next** because it is cheap once A01 lands and it introduces `assetAuthHead()` / `isAdminOutpoint`,
  which A10 consumes.
- **A03** before any registry traffic, so a mis-fired retry cannot create a third genesis (two already exist
  on mainnet, runbook.md:49) and so `mockKycAdmit`'s fallback-to-genesis path stops existing.
- **A06 in the same build as A01 — this is the non-obvious constraint.** A01 requires an overlay restart
  (`cd overlay && npm run build && npm start`, runbook.md:87). A restart with TS `admitSeq` still in process
  memory (`overlay/src/registry.ts:36`) resets the counter to 0, so a freshly folded link sorts *below* the
  pre-restart rows and `GET /admin/registry` stops returning the head first — which is exactly what the
  retry's head selection depends on. **Deploying A01 without A06 breaks the retry.**
- **A07 after A06**, because "newest by `admitSeq`" only means anything once `admitSeq` is durable.

**▶ The stuck identity admit (runbook.md:146-157) is retried here, at the end of Phase 1** — not before.
Sequence:
1. `docker start local-mongo-1`; `cd overlay && npm run build && npm start`; `cd lib && npm test && npm run build`;
   Vite; ngrok. (A01+A02+A03+A06 are in `dist/`; A07 is in `lib/dist/`.)
2. `GET /admin/registry` still points at `dc810603…:0`, `admitSeq` now from `mandalaCounters`.
3. Hard-reload `/issuer/identities` on the overlay-go identity `0215643b…`.
4. **Re-attach identity chain** (internalize `dc810603…:0`). Do **not** Open — and after A03 the Open path
   refuses anyway, which converts runbook failure 4 from a discipline problem into an impossible one.
5. Admit `0299e597…`: the wallet prompt must spend `dc810603…:0` and create a new 1-sat registry output
   carrying the `{"t":"mandala-registry"}` OP_DROP marker.
6. The overlay row moves to the new txid; **the next admit spends that** — which is now correct because A07
   picks the chain head rather than the issuer's row. Before A07, step 6 was the step that would have failed.

If it still fails with `already consumed by this action batch`: `abortStuckRegistryActions` and the
single-tx `loadRegistryInputBeef` are already in tree (runbook failure 7); abort any hanging MetaNet
`noSend` action spending `dc810603…:0` and retry once. Do not open a new chain.

### Phase 2 — unbrick and stabilise (≈1 week)

**A04** (removes the issuer self-brick and makes the two backends interchangeable again — do it before any
further identity is admitted, because every new admitted row increases the blast radius of a revoke) →
**A08**, **A15**, **A18** (the three stability defects, independent of each other) → **A09** then **A10**
(stop the CI loss, then build the way back; A10 consumes A02's helper).

### Phase 3 — the blinding gate (≈1 week)

**A05** → **A11** → **land L4 (blinding)** → hand off to the wallet for D2.

Nothing about blinding ships until A05 is **deployed on both overlays**. A05 is not a nicety: the working
tree already contains the blinded `transfer.ts`, and the registry is already active with one row, so landing
L4 first means every spend of a blinded receipt is refused the moment a peer is admitted. A11 closes the
denylist hole that D2 itself opens. Only then does the wallet-side D2 work (frame `senderIdentityKey` = A',
one opaque `keyID` on the wire, payee-decryptable recipient linkage on the web rail via A12 item 5) begin.

### Phase 4 — package delivery (≈3–4 days)

**D3a → D3b → D3c**, and **D4** anywhere. D3c is sequenced after A08/A15 so the journal ordering being made
async is the corrected ordering.

### Phase 5 — whitepaper MUSTs that are cheap, plus operator hygiene

**A13** (before any public demo), **A14**, **A12**, **A16**, **A17**.

### Phase 6 — polish

**A19**, **A20**, **A21**.

**A22 rides with every phase.** It is never its own phase, and no item that can fail *open* lands without a
test that fails before the fix.

---

## 4. Do not do (deferred, per D1)

### Deferred: P2MKH threshold admin locks (G03)

**Do not** build threshold locks, partial-signature collection, or the co-signer UX in this pass. It is XL
and it is not what is broken: after A01 the single-key lock is *bound to the issuer*, which removes the
forgery; a threshold removes a different risk (one compromised officer key). Building it now would also
couple the security fix to a ts-stack PR the demo would have to wait on.

*What a later spec must cover.* `@bsv/templates@1.9.0` already exports `P2MSKH` (`mod.ts:5`,
`src/P2MSKH.ts`) whose `lock()` writes `OP_DUP OP_HASH160 <hash160(concat(pubkeys))> OP_EQUALVERIFY
<threshold> OP_SWAP (33 OP_SPLIT)×(n−1) <n> OP_CHECKMULTISIG`, with `addressBRC29(wallet, counterparties,
keyID, threshold)` deriving the member keys BRC-29-style — that *is* the whitepaper's P2MKH (R20 MUST,
minimum 2-of-2; R21 SHOULD, 2-of-3/2-of-4 with an off-site recovery key that does not sign day to day), and
it needs **no `@bsv/templates` change**. The spec must state: (a) a new `lib/src/adminLock.ts`
`lockAdminThreshold({wallet, data, members, threshold})` keeping `keyID = MandalaAdmin.commitment(data)` so
R22 is unchanged and existing chains stay verifiable; (b) a `@bsv/overlay-topics` PR teaching
`verifyAdminOutput` to decode P2MSKH, re-derive the member set from the **configured** member list (never
from the payload — the A01 lesson), and compare `hash160(concat(pubkeys))`, keeping the P2PKH branch so
existing chains stay spendable ("P2MKH (or bound P2PKH)", H:483); (c) the Go port in
`overlay-go/internal/mandala/{admin.go,adminwallet.go}` with a golden vector in `testdata/vectors.json`;
(d) the partial-signature collection UX in `RegulatoryControls` / `IssuerPanel` (sign locally, export the
partially-signed action, import the co-signer's signature), which is the bulk of the work; (e) migration —
how an asset whose chain is single-key P2PKH moves to a threshold lock without a break in the auth chain;
(f) R72's fail-closed property and the operational consequence that losing a required key bricks the asset,
which is exactly why the off-site recovery key exists. A01's `ADMIN_MEMBER_KEYS` config is deliberately
shaped to become that member list. Note the deployment constraint this also unblocks: today the overlay must
hold the issuer's root key because verification uses `counterparty:'self'` (runbook.md:56-60); member-list
verification removes that coupling.

### Deferred: key rotation (G05)

**Do not** add a `rotate` action kind, a key-set collection, or height-bound verification in this pass.
Rotation is only meaningful once there is a key *set* to rotate (G03), and every one of its consumers —
σI "verified against the key live at the height of the Merkle path" (R69), client caching of every previous
set (R33/R34) — is in the offline-settlement path, which is entirely absent. A12 is therefore capped at
verification against the **current** key, and that cap must be a comment in `lib/src/admission.ts`, not a
silent omission.

*What a later spec must cover.* R32 MUST: a dedicated rotation spend on the relevant chain publishing the
new key set, the threshold, and the height *h* from which it is authoritative. The spec must settle what the
whitepaper leaves open (spec-requirements.md open questions 4 and 8): **which chain** rotates (the
registration chain is issuer-level and matches R25's "one admission covers every stablecoin", so
`RegistryActionDetails.kind` gaining `'rotate'` is the smaller change — and both registry topic managers are
repo-local, so it needs **no ts-stack PR**); whether the overlay's BRC-72 *decryption* identity key rotates
by the same spend (it must not rotate silently — every stored `mandalaLinkageRecords` blob was encrypted to
the old key, and that collection has no TTL and a ≥5-year retention); and what "the live issuer key" means
for σI once issuer ≠ overlay. Mechanically: fold rotations into an **append-only** `mandalaKeySets`
collection `{seq, members, threshold, effectiveHeight, txid}` (never upsert — R33 requires *every* previous
set), serve `GET /admin/key-sets` from both servers, add `lib/src/keySets.ts` with `keyLiveAtHeight(h)` for
R34, and consume it from A12's verifier. Console: a "Rotate signing set" card on the Identities page behind
A19's confirmation.

---

## 5. Landing the uncommitted working tree

46 paths, three half-finished features sharing one tree: the identity registry (lib + app + both overlays),
σI, and sender blinding. All suites pass and **none of them cover any of the new gates** — the green light
is not evidence.

### Risks of landing it as one commit

1. **Blinding bricks peer spends the moment a peer is admitted.** `lib/src/transfer.ts` already emits
   `sender: A'`, `senderMode:'blinded'`, and stores `counterparty: A'` in the recipient's CI, so the
   recipient's later input linkage names `A'`. `A'` is never registry-admitted. With `mandalaRegistry`
   already non-empty on mainnet (`dc810603…`, one row), the gate is *already live*. This is the hard
   blocker: **L4 must not land before A05 is deployed.**
2. **`overlay/src/index.ts` swaps `InMemoryScreeningProvider([])` → `registryScreening`** — live-fire. It
   turns on membership for *all* parties with **no issuer exemption**. With one row (the issuer's own) it is
   benign; a revoke of the issuer row, a `mandalaRegistry` index/row loss, or the duplicate-genesis confusion
   locks the issuer out of `unpause` and `revokeIdentity`. Land A04 in the same change.
3. **The tree publishes forgeable code.** `overlay/src/registry.ts:119-128` and
   `overlay-go/internal/mandala/registry.go:47-66` carry the payload-counterparty defect. Committing them
   before A01 puts the forgery into history and into any deployment built from that commit.
4. **A restart reorders `/admin/registry`** (A06). Any deploy of this tree is a restart.
5. **Second-admit head selection is wrong** (A07). Landing the registry feature without it means the feature
   works exactly once.
6. **`lib/dist` must move in lockstep.** The app consumes `@bsv/mandala` via `"file:../lib"`; committing
   `lib/src` without `npm run build` yields silent old behaviour with new tests passing against `src`. Bake
   `cd lib && npm test && npm run build` into each landing step (runbook.md:105).
7. **No test coverage for any new gate** (A22): Go `membershipHolds`, both `RegistryTopicManager`s, TS
   `registryScreening`, TS `wrapSubmitJson`/`txidFromSubmitBody`, `overlay/src/index.ts` routes,
   `admitOrRevokeIdentity`, `mockKycAdmit`, `submitAdminAction` end-to-end.
8. **`docs/whitepaper/` carries a Word lock file** `~$ndala-Stablecoin-Whitepaper.docx` (162 bytes) — do not
   commit it; add it to `.gitignore`.

### Safe landing order — four commits, not one

**L1 — security only (no behaviour change for honest users).** `overlay/src/pinnedWallet.ts` (new),
`overlay/src/index.ts` wiring, `overlay/src/registry.ts` (pinned derivation + `register` uniqueness +
persistent `admitSeq`), `overlay-go/internal/mandala/{adminwallet.go,registry.go,registry_topic.go,
topic_manager.go,storage.go}`, `overlay/src/assetAuth.ts` + `overlay/src/mandalaGate.ts` (A02 only), plus
every test from A01/A02/A03/A06. Build, restart, verify `GET /admin/registry` order survives the restart.
= **A01, A02, A03, A06.**

**L2 — the registry spine.** `lib/src/registry.ts`, `lib/src/registryRecover.ts` (**with A07's head-selection
fix and its inverted test**), `lib/src/constants.ts` registry constants, `lib/src/singleFlight.ts`
(`registryFlight`), `lib/src/submitGuards.ts` (`guardIdentityKey`), `lib/src/index.ts` re-exports;
`app/src/components/issuer/IdentityRegistry.tsx`, `app/src/hooks/useRegistry.ts`,
`app/src/hooks/useRegistryMutations.ts`, the `IssuerDashboard.tsx` nav item and its test;
`overlay-go/internal/mandala/registry_lookup.go`; `runbook.md`. Rebuild `lib/dist`.
**→ run the runbook retry here.** = **A07** + the registry feature.

**L3 — σI (additive, low risk).** `overlay/src/admission.ts` (minus the dead `signAdmission`),
`overlay-go/internal/httpapi/admission.go`, `overlay-go/internal/httpapi/submit.go`,
`overlay-go/internal/httpapi/server.go`, `overlay-go/internal/wiring/engine.go`, `lib/src/overlay.ts`
(`OverlayAdmitResult`, `topics` parameter), `lib/src/overlay.test.ts`. = the σI WIP + **A21**.

**L4 — blinding. Gated.** `lib/src/blinding.ts`, `lib/src/blindingJournal.ts`, `lib/src/transfer.ts`,
`lib/src/receive.ts` (`senderMode`), their tests. **Precondition: A05 (and A11) deployed and verified on
both overlays.** Verify with a live blinded transfer *followed by a spend of the received coin* by an
admitted identity — the spend is the test that matters, and it is the one nobody has run.

Docs (`docs/whitepaper/`, `runbook.md`) ride with whichever commit they describe. Everything in §2 that is
not listed above is new work layered on top of L1–L4, in the phase order of §3.

# BRC-162 (final, "1Color") + BRC-207 conformance audit — 2026-10-21

Read-only audit; no code changed, no tests run (desktop module tests could not run: `@bsv/mandala/unlock` unresolved in that checkout).

## Baseline

| Component | Version audited |
|---|---|
| Spec BRC-162 | bitcoin-sv/BRCs master `tokens/0162.md` (title "1Color"), fetched 2026-10-21 |
| Spec BRC-207 | bitcoin-sv/BRCs master `wallet/0207.md` (1Color Wallet Module, ~10.4k lines) |
| Pinned spec in repo | `docs/design/brc-0162-bsv21-binary.pinned.md` (8f36bdf, 2026-09-28) — **stale** |
| Mandala lib | `@bsv/mandala` 0.4.1, master 1718323 |
| Go overlay | `overlay-go/` local master |
| bsv-desktop P-module | `src/lib/permissionModules/mandala/` @ 9945d83 (= BSV-Desktop/master) |
| bsv-wallet P-module | `origin/master` 0f1aa3d3 `core/mandala/` (vendors lib 0.4.1). `feat/mandala-brc162` (lib 0.3.0) is stale. |
| Upstream reference | ts-stack origin/main fcdd44a85: `@bsv/color-permission-module` 0.1.0 (#1243, merged 2026-10-20), `@bsv/templates` OneColor (2.1.0), `packages/overlays/topics` |

Status vocabulary: **conform**, **gap** (we should change), **divergent-intended** (deliberate Mandala policy, cite design doc), **offline-regression→feedback** (conforming would hurt offline settlement — raise on the spec), **spec-editorial**.

## BRC-162: what changed between our pin and final

1. Renamed to **1Color**; naming section reserves "1Color" for conforming implementations only (0162:55-61). Generic primitives: `p color`, `tm_color`, `tm_color_<assetId>`, `ls_color_<assetId>`, capability `brc207-color`.
2. Payload keys **`req`** (required processing profiles, immutable in the deploy) and **`ext`** (per-output profile data) reserved (0162:146-214).
3. Encoder must write `OP_0 OP_DROP` when the remainder begins `<push> OP_DROP` and no payload is intended (0162:101).
4. uint64 limit is **per output**; validators MUST sum exactly in a wide integer domain (0162:139).
5. `icon` is now embedded `[mediaType, bytes]`, not a 4/36-byte outpoint pointer (0162:232-240).
6. BRC-207 `color` services MUST admit valid outputs regardless of satoshi value (0162:317) and MUST NOT ignore 36-byte legacy ids (0162:110).
7. Editorial inconsistency: 0162:107 says token id is `<deploy txid>.0` (BRC-36), 0162:116 says `<txid>_<vout>`. We use `_0` for ids, `.` for outpoints.

## Top findings (verified against code by me unless marked "agent")

### P0: security, independent of the spec
| # | Finding | Evidence | Status |
|---|---|---|---|
| S1 | **COVER does not validate unanchored hops.** `cover()` only checks that every token input traces to a σI-covered outpoint; it never checks conservation/authority on intermediate unadmitted txs. A parent tx that mints value from nothing (no token inputs) passes the walk. Design §1.2/§7.1 of the offline-settlement spec deliberately treats "no token ancestor" as base-case true and defers to the overlay — a known trade-off now contradicted by BRC-207. Public BRC-162 rules (conservation, authority) are locally checkable offline, so this is a gap, not feedback. Wallet localpay checks conservation on the **tip only** (`localpay/verify.ts:275,353-380`); lib `receive.ts` hand-over path does not check at all. Result: counterfeit value can be credited offline until the overlay refuses on submit. BRC-207 requires full local transition validation on unanchored hops and walking authority inputs (0207:332-345, C25/C26). | `lib/src/bundle.ts:318-350` | gap (security) |
| S2 | **Blind-sign prompt in both P-modules.** A `createSignature` digest not from an approved tx shows a content-free prompt (`{type:'mandala_signature'}`) and on approval signs any 32-byte digest with token keys. BRC-207 A.13: a digest is not spend authorization. | desktop `permissionModule.ts:552-560`; wallet same | gap (security) |
| S3 | **Spend prompt can be spoofed.** Any output an app places in the `p mandala` basket is counted as "change" without checking it is locked to a wallet-derived key; prompt also ignores inputs, implicit burn, sats/fee. | desktop `permissionModule.ts:745-756` | gap (security) |
| S4 | **Receive credits before admission (lib delegates).** `acceptOne` internalizes regardless of σI and only reports `admissionVerified`; no check that the output's P2PKH matches the derived key. The wallet consumer handles it: unverified → settlement row `held`, drained/submitted later (`createRuntime.ts:2120-2140`), which matches BRC-207's credit-before-admission (`color_offline`, 0207:381-403) — but for non-hand-over receives there is no COVER frontier behind that credit. Desktop/app consumers must handle `admissionVerified=false` themselves. | `lib/src/receive.ts:316-345` | gap (P1) |
| S5 | With no `overlayIdentityKey` configured, admission verification only warns (fail-open). | `lib/src/overlay.ts:314-320` | gap (minor; prod configures key) |

### P1: conformance gaps (BRC-162 / BRC-207)
| # | Finding | Evidence | Status |
|---|---|---|---|
| C1 | **Amounts capped at 2^53-1** per output, per-tx sum and supply in overlay; lib uses `number` and treats >2^53 outputs as non-tokens (invisible). Conflicts with the user's 2026-10-13 uint64/output decision. Wallet-side splitting does not help: overlay rejects any single large output. | `overlay-go/internal/mandala/ownership.go:73`, `authority.go:246-257`, `amount.go`; `lib/src/brc162.ts:13,60,90` | gap (decision already made) |
| C2 | **No `req` profile declared on deploys**, and nothing in lib/Go/wallet reads `req`/`ext`. A BRC-207 wallet treats Mandala assets as plain 1Color (will build txs our overlay rejects); our code would credit a foreign asset with an unknown required profile (A.142-A.148). `req` is immutable → existing assets can never opt in; new deploys needed (no back-compat accepted). | `lib/src/brc162.ts:213-220`; `overlay-go/internal/mandala/details.go:298-340` | gap |
| C3 | **Attestation wire differs from BRC-207 attested profile** (`https://brc.dev/207/attested` v1): spec message `1color-admit:v1:tm_color_<assetId>:<txid>:<outs>` signed by a BRC-42 child key (`[2,"color admission attestation"]`, keyID `1`, counterparty anyone; bare-key verify must fail). Ours: `mandala-admit:v3:tm_<deployTxid>:...` signed with the **bare** overlay identity key. Output-list rule and single SHA-256 match. Carrier shape differs (`profileData` vs our hand-over body); no `declarationTx`. | `lib/src/admission.ts:46,127-137`; `overlay-go/internal/mandala/admissions.go:86` (agent) | gap→conform |
| C4 | **1-sat rule** rejects whole tx; **32-byte ids only**. Final spec: a service doing either MUST NOT answer as that asset's conforming `color` service (0207:777-782). Pinned `@bsv/templates` 2.0.0 lacks OneColor (36-byte ids). | `ownership.go:70`; `overlay-go/internal/brc162/codec.go:88-97` | divergent-intended (design D2, §3) — now non-conforming (0207 cite: agent) |
| C5 | **P-module architecture** is an app-built consent gate: one global `p mandala` basket, fixed protocol `[2,'p mandala token']` with unique keyIDs. Spec: per-asset `p color <assetTag>` (+ `authority`) baskets, protocol `[2,"p color <assetTag> <hex(prefix)> <hex(suffix)>"]`, keyID `color`, `p color assets` / `p color balance` views (BRC-112, exact decimal strings), `brc207-color` capability, wallet-managed planning/selection/change, envelope-based `createSignature` (A.52-A.59). Upstream `@bsv/color-permission-module` implements this shape. | desktop `mandala.ts:8`; wallet `types.ts:318`; `lib/src/constants.ts:7` | gap (rename agreed; structure is the real work) |
| C6 | `seekPermission:false` ignored (module prompts anyway, A.27/A.115); a spend approval also unlocks inventory reads; `revealCounterpartyKeyLinkage`/`revealSpecificKeyLinkage` not in the refused set. | desktop/wallet `permissionModule.ts` (agent) | gap |
| C7 | Topics/lookup: `tm_mandala`, `tm_<txid>`, `ls_<txid>`; no `color-spendability` / `color-admission` query on `ls_color_<assetId>`; lib has no lookup client. | `lib/src/constants.ts:3-4`; `overlay-go/internal/mandala/topics.go` (agent) | gap (rename agreed) |
| C8 | Strict CBOR subset rejects arrays, negatives, tag 42, >4096 B, depth >4 → spec-valid `icon` and array `req` params fail on a deploy. No icon support anywhere. | `overlay-go/internal/brc162/strictcbor.go:12-16,209-255` | divergent-intended (design §3.5); blocks icon |
| C9 | Holder I==O: no explicit burn (A.35). | `authority.go:213-220` | divergent-intended (design D5) |
| C10 | Graph duplicate-spend check (0207:343, C20) and known-conflict check before credit (C28) absent from COVER. | `lib/src/bundle.ts` | gap |

### Module drift (desktop vs wallet)
- `token.ts` identical. Desktop newer: 30-min session window + concurrent-prompt dedupe (9945d83); wallet still 60 s (`SESSION_TIMEOUT_MS = 60_000`). Wallet has `abortGuard` + settlement runtime that desktop lacks.
- **Desktop test drift:** `test/mandalaPermissionModule.test.ts:137` still asserts "access expires after 60 seconds" against the 30-min constant → re-prompt after `advanceTimersByTime(61_000)` (expects 2 prompts); with the 30-min constant it fails by reading (not run here).

### Offline settlement: spec feedback candidates (the only area where we push back)
Our σI model maps closely onto the attested profile's `identity` trust mode: same output-list rule, per-token topic, no timestamp, recipient submits parents-first, idempotent retry, drop "offline" only after real admission, mined ≠ anchor (FIX B), per-vout coverage (FIX A). These parts conform. Feedback items:
- **F1** Topic/prefix hard-wired to `tm_color_`; allow the actual BRC-22 topic name or document `evidenceProfile` for other naming.
- **F2** `identity` mode is one fixed key with no rotation; allow an `identityKeys` set or authenticated rotation.
- **F3 (offline-regression)** Mandala rules beyond BRC-162 (linkage encrypted to overlay key, freeze/pause/KYC, I==O) cannot be validated locally. Proposal: a required companion profile may designate settlement-time checks, excluded from local step 2, gating removal of `color_offline`, with mandatory risk disclosure/policy.
- **F4** Define behaviour when BRC-177 lifecycles are absent. **F5** Worked `evidenceProfile` example. **F6** Define "known conflict" as wallet-local state. **F7** Add a vector with a fabricated authority parent inside the bundle (exactly S1).
- Freeze/pause/KYC fit best as an `evidenceProfile` replacement (carrier + overlay key set + admin-state epoch + verdict taxonomy); default attestation has no freshness, so an offline recipient cannot learn of a later freeze.
- Editorial: 0162:107 `.0` vs 0162:116 `_<vout>`.

## Suggested order
1. S1-S3 (security, no spec dependency). Per [[overguard-demo-first]], file as GH issues if a demo is near.
2. Fail closed on unknown/malformed `req` (C2 reader; port upstream guard `color-permission-module/src/tokenOutputs.ts:47-88`).
3. uint64 end-to-end (C1).
4. 1Color rename + attestation wire (C3) + new deploys with `req` declaring the attested profile (identity mode).
   C1/C4 also touch the Mandala policy layer in ts-stack `packages/overlays/topics` (Go parity reference) → PR-only, user publishes.
5. P-module restructure toward upstream `@bsv/color-permission-module` (C5-C7); decide whether to adopt upstream rather than maintain two forks.
6. Decide C4/C8/C9: keep as Mandala policy (then don't present as a conforming 1Color service; 0162:55-61) or conform.
7. Update the pinned spec file to the final BRC-162 and pin BRC-207.

---
Appendices below are the raw per-area audit tables (agent-produced, line refs spot-checked for the P0 items only).

---

## Appendix 1-brc162

### Findings 1 — BRC-162 "1Color" (final) conformance audit of Mandala lib 0.4.1 + overlay-go

Read-only audit. Paths: L = /Users/personal/git/demos/mandala/lib/src, G = /Users/personal/git/demos/mandala/overlay-go/internal, Spec = BRCs:0162.md, 207 = BRCs:0207.md, DD = docs/superpowers/specs/2026-10-01-mandala-brc162-design.md.
Method note: diff of pinned (8f36bdf) vs final shows these deltas: rename to 1Color + naming section (0162:32-63), encoder `OP_0 OP_DROP` rule (0162:101), 36-byte id not ignorable by BRC-207 color services (0162:110), uint64-per-output + wide summation (0162:139), reserved `req`/`ext` + wallet-processing-extensions section (0162:146-214), `icon` -> `[mediaType, bytes]` (0162:232-240), 1-sat conforming-service sentence (0162:227), removal of "binary-wins ... is ignored" nuance unchanged, `<deploy txid>.0` BRC-36 wording (0162:107). Everything else is unchanged from the pin.
Verified-by-reading only; no tests were run.

## 1. Reserved payload keys `req` / `ext` (0162:146-214; 207:85, ~9381 A.142, ~9592)

| # | Spec clause | Our behavior | Status | Note |
|---|---|---|---|---|
| 1.1 | `req`/`ext` reserved keys in payload map (0162:167-173) | Mandala deploy payload keys are `sym, dec, label, feeRatePerKb?` (L/brc162.ts:216-220; G/mandala/details.go:322-333); authority payload is `{adm}` (L/brc162.ts:188-189; G/details.go:354). No use of `req`/`ext`. | conform (no collision) | Admin action commitment lives in the authority output's DAG-CBOR `adm`, not `ext`; fine because other payload keys are advisory (0162:204-208). |
| 1.2 | Required-profile map in the deploy declares processing semantics (0162:175-190) | No Mandala deploy emits `req` (deployPayload L/brc162.ts:216-220). KYC/trusted-issuer/freeze/pause/allowlist semantics are enforced only by overlay (G/mandala/trust.go, controls.go, authority.go) and NOT declared on-chain. | gap (for BRC-207 interop) | A conforming BRC-207 wallet sees an empty `req` and treats Mandala tokens as plain 1Color assets: it may build/sign transfers that the Mandala overlay rejects (ERR_UNTRUSTED/ERR_FROZEN/ERR_PAUSED/ERR_ACCESS/ERR_LINKAGE), and cannot know a transfer needs a blinded/linkage envelope, since Mandala admission needs the off-chain envelope (L/encoding.ts:22-27; G/mandala/envelope.go). Its "spendable" answer must come from `ls_color_<assetId>`, which we do not serve (see 9). Also unknown `req` in a Mandala deploy is silently ignored by the overlay (ParseDeployMetadata ignores unknown keys, details.go:19). A third party could therefore deploy a Mandala token that DOES declare `req`; our wallet ignores it (unsafe vs 0162:149-152 "understanding without enforcing is not support"). |
| 1.3 | Malformed reserved fields rejected by BRC-207 wallet (0162:210-214); malformed extension data does not alter base admission (0162:210) | Overlay/lib neither parse nor reject `req`/`ext`; malformed ones pass as unknown keys (G/details.go:19-63). | gap (wallet-side); conform (indexer-side: base admission unaffected) | Only matters once we adopt BRC-207 wallet rules. |
| 1.4 | Later output repeating `req` must be byte-equal to deploy's (0162:180-183) | Not checked anywhere (no `req` handling in L or G). | gap (BRC-207 wallet obligation) | Mandala overlay only requires a strict-map payload on deploy and `adm` on authority; value outputs carry no payload at all (L/transfer.ts:238,249 pass no payload), so we never produce a repeat. Incoming third-party outputs repeating `req` are unchecked. |
| 1.5 | Profile requirements inherited by asset id across encodings (0162:192-199) | n/a, no profiles declared. | n/a | |
| 1.6 | Strict decode of `req` descriptors needs arrays/negatives/null/any DAG-CBOR in `params` (0162:174-176) | Our strict CBOR subset allows only uint, bytes, text, null, bool, map; no arrays, negatives, tag 42; depth<=4, <=4096 bytes (G/brc162/strictcbor.go:12-16, 209-255; TS strictCbor.ts same). | gap (if we ever parse `req`) | A spec-valid payload `{"req":{"u:x":{"version":1,"params":[1]}}}` is not decodable by our strict subset, so ParseDeployMetadata would refuse it as ERR_SHAPE on a Mandala topic; for a generic indexer it should merely yield "no attributes". |

## 2. Encoder rule: remainder starting `<push> OP_DROP` -> write `OP_0 OP_DROP` (0162:101, 0162:146)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 2.1 | Encoder must write explicit empty payload when remainder starts with `<push> OP_DROP` and no payload | Every output script we encode is prefix + canonical P2PKH remainder (L/brc162.ts:81-92 via Bsv21Binary.lockBRC29; G/brc162/codec.go:277-300 Lock). P2PKH starts with OP_DUP, which is not a push, so the collision cannot occur. Value, authority (payload `{adm}`), deploy (payload sym/dec/label), registry/admin (same deploy/authority templates, L/registry.ts:85-97, L/authority.ts:100-110,207) all go through this. | conform (vacuously) | No non-P2PKH remainder is ever encoded; decode rejects non-P2PKH remainders (L/brc162.ts:59 `restPubKeyHash == null` -> null; G/mandala/ownership.go:67 rNonP2pkhRemainder; DD D3). Neither Bsv21Binary (pinned 2.0.0 lock, ts-templates/src/Bsv21Binary.ts) nor OneColor.lock implements the rule explicitly; they only ever place P2PKH. If non-P2PKH remainders are ever supported (e.g. covenant/marketplace), the encoder rule must be added. |
| 2.2 | Decoder: first `<push> OP_DROP` after OP_2DROP is the payload (0162:98) | G/brc162/codec.go:240-246 splitPayload; upstream splitPayload identical. Also records `PayloadCanonical` (non-minimal push) and Mandala deploy requires canonical (details.go:26-28). | conform; Mandala stricter on deploy (non-canonical push rejected, DD §3.1) | |
| 2.3 | Empty payload as `OP_0 OP_DROP` | G Lock with HasPayload and empty bytes emits OP_0 (codec.go:219-225). | conform | |

## 3. uint64 per output, exact wide-integer summation (0162:136-139; 207 A.38 ~3873, A.110-113 ~7820-7925)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 3.1 | Wire decoder accepts 0..2^64-1 (0162:133-137) | G/brc162/codec.go:134-165 uint64; TS template bigint (Bsv21Binary decodeAmountChunk). Ledger sums with big.Int (G/brc162/ledger.go:63-64,235,244). | conform | |
| 3.2 | Validators MUST sum exactly in wide domain | Ledger uses *big.Int (ledger.go); CirculatingSupply big.Int (G/mandala/storage.go:335). | conform | |
| 3.3 | Each output <= uint64 max; no cap lower than that for a conforming service | Overlay rejects any output amount > 2^53-1 (G/mandala/ownership.go:73 + MaxSafeAmount amount.go:12), any per-token value sum > 2^53-1 and supply > 2^53-1 (authority.go:246-257), persists amounts as BSON double (amount.go:14-57), JSON number. | divergent-intended (DD D6; Unsafe-amount incident 2026-09-21) | Conflicts with 207 A.38/A.110-113 (max uint64 issue must be admitted and balance exact). Spec itself says cap applies per output, not supply: our *supply and sum caps* are also non-conforming, not just the per-output cap. User decision 2026-10-13: conform to uint64/output and split larger amounts. That decision splits *wallet* sends; it does NOT remove the overlay's 2^53 cap on a single output, so a conforming wallet depositing a >2^53 output would have the overlay reject it (whole tx). Needs Amount int64->uint64/Decimal128 or string storage change, sum/supply caps removed or raised to wide integers. |
| 3.4 | Lib amounts | `decodeToken` returns null (treats as non-token) for amount > MAX_SAFE_INTEGER (L/brc162.ts:13,60); `lockToken` throws for non-safe-integer (L/brc162.ts:90); DecodedToken.amount is `number` (L/brc162.ts:50); amount.ts format/parse use Number (L/amount.ts:7-51); `Number(d.amount)` loses precision silently only below the cap. | divergent-intended (DD D6); gap vs user's 2026-10-13 uint64 decision | Needs bigint (or decimal-string) amounts through lib, app and wallet; a received >2^53 output is invisible to the wallet (silently non-token, funds undisplayed). |
| 3.5 | Template (upstream) | Bsv21Binary: bigint, BSV21_MAX_AMOUNT=2^64-1 (ts-templates/src/Bsv21Binary.ts:18). topics/mandala ownership.ts:26 MAX_SAFE=9007199254740991n, same cap as Go. brc162/ledger.ts: bigint sums. | conform (template, ledger) / divergent-intended (mandala topic) | |
| 3.6 | `dec` range 0..18 | G/details.go:326-331 enforces 0-18; lib DeployMetadata comment 0-18. Display uses Number (L/amount.ts). | conform | Note `dec` 18 with Number toParts breaks above 2^53 anyway. |

## 4. `icon` = `[mediaType, bytes]` (0162:230-240)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 4.1 | Deploy display field `icon` | No icon anywhere: grep of lib/src, G, app (token context) shows none; deploy payload only sym/dec/label/feeRatePerKb (L/brc162.ts:206-220; G/details.go:3-8). Pinned spec's 4/36-byte pointer also never implemented. | gap (feature absent; not a violation: field optional, display fields do not affect validity) | |
| 4.2 | Embedded image fits payload | Strict CBOR rejects arrays (G/strictcbor.go:209-255, major 4 not allowed) and caps payloads at 4096 bytes (strictcbor.go:15). | gap / divergent | A third-party 1Color deploy with `icon` array fails Mandala strict decode (ERR_SHAPE on Mandala topics) and any real PNG exceeds 4 KiB. To support icons: allow major type 4, raise cap, and keep icon display-only (spec: invalid icon must not affect admission, 0162:316). `app` has no token icon display. |
| 4.3 | Upstream templates | Neither Bsv21Binary nor OneColor parse payload attributes; they expose payload bytes only. topics/bsv21 etc. do not reference icon. | n/a | |

## 5. 1-sat policy (0162:254; 207:777-780)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 5.1 | Conforming BRC-207 `color` services admit valid outputs regardless of carrier sats | G/mandala/ownership.go:70-71 rejects any token output with Satoshis != 1 (ERR_SATOSHIS, reject.go:14,75; httpapi/verdict.go:54); upstream topics/mandala/ownership.ts:96 identical. | divergent-intended (DD D2) | Spec allows the policy as a service filter but says a service enforcing it is not a conforming color service (207:777-782; also 207:1552). 207:780: "MUST NOT advertise or answer as that asset's conforming service". Lib/wallet emit 1-sat outputs always. |
| 5.2 | Deploy discovery without a one-sat filter (207:793-798) | tm_mandala has the same 1-sat rule via shared RequireValidTokenOutputs. | divergent | |

## 6. 36-byte legacy ids (0162:110; 207:775-777, 1552)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 6.1 | color service MUST recognize canonical 36-byte ids (vout != 0), reject 36-byte with vout 0 | G/brc162/codec.go:88-97 refuses any non-32-byte id push ("token id must be a direct 32-byte push") -> listed as Invalid -> whole-tx ERR_SHAPE (ownership.go:61); pinned Bsv21Binary same (ts-templates Bsv21Binary.ts:decodeTokenId). Lib: decodeToken catches and returns null (L/brc162.ts:67-69); TOKEN_ID_RE only `<hex>_0` (L/brc162.ts:15; G/topics.go:20). | divergent-intended (DD §3 "36-byte id is invalid for Mandala; no BRC-161 tokens exist here") | Final spec forbids this omission for BRC-207 color services. Upstream OneColor (ts-templates/src/OneColor.ts:8-9,34-50,61-82) adds 36-byte ids (`tokenIdFromString` `<txid>_<vout>`, vout 0 non-canonical). Mandala pins @bsv/templates ^2.0.0 (lib/package.json:35; app/package.json:16; installed 2.0.0) which lacks OneColor. |
| 6.2 | Deploy at non-zero vout is invalid for binary deploys | G/ownership.go:64 rDeployNotAtZero; ledger.go:253 deployValid. | conform | A legacy BRC-161 token with a binary 36-byte id can only be spent in binary form; we cannot. |

## 7. Holder I == O vs implicit burn (0162:277-286; 207 A.35 ~3675, A.36 ~3739)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 7.1 | Without authority admit value outs iff I >= O; I > O burns the difference (0162:283-286) | G/mandala/authority.go:213-220 holder tx with no authority must have delta == 0 else ERR_CONSERVATION (rHolderConservation, reject.go:180). Whole-tx reject instead of burning (DD §3.3, §4 "Whole-tx rejection ... nothing broadcast"). | divergent-intended (DD D5) | |
| 7.2 | BRC-207 explicit burn (A.35: spend token input, no token outputs, consent) is a valid wallet operation; implicit burn needs consent | A Mandala holder cannot burn: tx with I>O (incl. O=0) is rejected by overlay; the only destruction is issuer `redeem` (authority delta<0, authority.go:226-232). Lib has no burn op. | divergent (feature gap vs 207 burn operations) | A BRC-207 wallet implementing A.35 against a Mandala asset will have its burn tx rejected at the overlay; also its own incoming-accounting conflicts. Document as asset-level policy: burn only via issuer redeem. Offline-settlement angle: rejecting I>O prevents accidental burn, fine. |
| 7.3 | O > I invalid, input burned (0162:284) | Rejected whole-tx. | divergent-intended | |

## 8. Token id string forms (0162:107 vs 116, 0162:225)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 8.1 | 0162:107 says binary id "is always `<deploy txid>.0` (BRC-36)"; 0162:116, 0162:51, 0162:225 say string form is `<txid>_<vout>`, underscore, fixed for BSV-21/1Color and "not the general dual-form outpoint convention" | Token id string always `<64hex>_0` (L/brc162.ts:15,34,63 tokenIdToString; G/codec.go:174-183 TokenIDToString; G/topics.go:20). Outpoint strings (inputs, admin details, owner rows) always `<txid>.<vout>` (L/brc162.ts:126; G/ledger.go:44,210). | spec-editorial (internal inconsistency in 0162:107 vs :116) ; our usage conform to 0162:116 (+0207 asset id `_0`) | Recommend spec authors fix 0162:107 to `<deploy txid>_0` or clarify it names the deploy *outpoint* (dot) vs the *token id* (underscore). We keep the two forms separate. 207:524-548 uses assetId in underscore form with `v0` tags in baskets (A.142 basket `...v0`, assetTag derivation). |

## 9. Naming (0162:58-63; 207:524-575, 695-700, 1494)

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 9.1 | Registry/discovery topic `tm_color` / lookup `ls_color` (207:791) | `tm_mandala` / `ls_mandala` (L/constants.ts:3-4; G/topics.go:11-12) | divergent (rename agreed, memory brc207-alignment-decisions; not done) | |
| 9.2 | Per-asset `tm_color_<assetId>` / `ls_color_<assetId>` (207:698-700, assetId underscore form) | `tm_<64hex>` / `ls_<64hex>` (txid only, vout implicit) (L/brc162.ts:28,32; G/topics.go:36-65) | divergent | assetId `<txid>_0`; so required names are `tm_color_<txid>_0`. `isSigmaTopic` and σI keyed on these names. |
| 9.3 | Identity registry | `tm_mandala_kyc` / `ls_mandala_kyc` | n/a (Mandala-specific, not in spec) | A KYC/trusted-issuer registry has no spec analogue; would be a `req` profile service. |
| 9.4 | Key protocol `[2,'p color <assetTag> <prefixTag> <suffixTag>']` (207:524-548) | `[2, 'p mandala token']` (L/constants.ts:8), `mandala admin`, `mandala registry`, deploy `mandala deploy` (L/brc162.ts:238); derivation keyID/counterparty scheme differs | divergent (user: no backcompat, conform) | |
| 9.5 | Baskets `p color <assetTag>` and `... authority` (207:573-575) | Single basket `mandala-tokens` (L/constants.ts:22) (memory mentions app keeps console outputs in 'p mandala' basket, commit 95bee77); authority and value share one basket. | divergent | |
| 9.6 | `brc207-color` version capability (207:1494) | not advertised | gap | |
| 9.7 | `color-spendability` query on `ls_color_<assetId>` (207:741-760) | Not implemented; lookup service takes Mandala-specific queries (G/mandala/token_lookup.go, lookup_query.go). Not verified in depth. | gap | |
| 9.8 | Naming section: "1Color" reserved for conforming implementations (0162:55-61) | We call ourselves Mandala; not claiming 1Color. Note: claiming 1Color while enforcing 1-sat, 2^53 cap, no 36-byte id, I==O would violate 0162:56-58 ("MUST NOT be presented as 1Color" if non-conforming). | note | Before rename, either conform or use the Mandala name for the overlay. |

## 10. Other spec items

| # | Spec | Ours | Status | Note |
|---|---|---|---|---|
| 10.1 | Deploy MUST be output 0 (0162:107,246) | G/ownership.go:64; ledger.go:253; L tokenIdOfDeploy `_0`. | conform | |
| 10.2 | Wire format, canonical amount (min script num, 0..16 as OP_n, <=9 bytes), non-minimal/neg/oversize invalid (0162:129-137) | G/codec.go:134-172 (checks listed) identical to template. | conform | |
| 10.3 | 36-byte id with vout 0 invalid (0162:112) | n/a (all 36 byte ids invalid, see 6). | conform-by-superset | |
| 10.4 | Strict DAG-CBOR decode, canonical: definite lengths, sorted keys, minimal ints, no float/undefined/NaN, only tag 42 (0162:143-145) | Subset: uint/bytes/text/map/null/bool; rejects arrays, negative ints, tags (incl. 42), depth>4, >4096 bytes (G/strictcbor.go:12-16,209-255; DD §3.5; vectors in testdata/brc162.json). Also accepts `true/false` (simple 20/21) which DAG-CBOR allows. | divergent-intended (stricter than spec; DD §3.5) | Consequence: spec-valid payloads (arrays for icon/req, negatives, tag 42, deep nesting) are "not a valid map" for Mandala. For a payload that is only *advisory* this is harmless on non-deploy outputs; on deploy it triggers rDeployPayload. Value outputs: payload not validated by overlay (only authority `adm` is read: token_lookup.go:29; authority.go:144), matching 0162:121. |
| 10.5 | Binary wins over BRC-161 JSON in same script (0162:103) | Overlay/lib only recognize the binary prefix; a script that begins with the token prefix is never also treated as JSON (no BRC-161 support). | conform | We do not support BRC-161 at all (DD:33). A BRC-207 wallet recognizes both; fine. |
| 10.6 | Payload never affects balance/authority admission (0162:100) | Mandala makes it matter: deploy rejected without well-formed sym/dec/label (details.go:22-62), authority output without a valid `adm` is not a committed action (authority.go:144; DD §3.3), non-canonical push on deploy rejected. | divergent-intended (DD §3.1 policy; stablecoin safety) | The deploy-payload requirement is stricter than "missing or malformed display fields do not invalidate a deploy" (0162:154). Note `label` and `feeRatePerKb` are non-spec keys (ignored by spec, so no conflict). |
| 10.7 | `dec` 0-18, default 0; `sym` text, unenforced uniqueness (0162:156-163,179-185) | Required, not defaulted (G/details.go:36-55 "missing key"); sym 1-32 chars, label 1-64. Keyed by token id. | divergent-intended (stricter) | |
| 10.8 | Authority rules: id present, amount 0, valid only if tx spends valid authority of same token; deploy with amount 0 is first authority; authority inputs contribute 0; end/split/combine/transfer (0162:262-275, 303-308) | G/brc162/ledger.go:252-268 SpecVerdicts identical to upstream. Mandala adds: admin action commitment (authority output `adm` = sha256 of off-chain details) and per-kind delta rules; only issuer-trusted deploy keys, `tm_mandala` registry unique deploy. Whole-tx rejects. | conform (layer A) + divergent-intended (layers B-D, DD §3.3/§4) | Also Mandala forbids authority supply "fixed-supply" deploys? Fixed-supply deploy (empty id, amount>0) is not used; DD:33 mentions "fixed-supply deploys" as out of scope. |
| 10.9 | Fixed-supply deploy (empty id, amount>0) valid (0162:123,191-193) | ledger.go:267 `|| every(ValueOutIndices)` admits it in layer A; Mandala layers refuse fixed-supply (DD out-of-scope list line 33; authority.go checks, not re-verified). | divergent-intended (DD) | |
| 10.10 | Satoshi value convention (0162:252-254) | See 5. | divergent-intended | |
| 10.11 | "Mandala's governance or application layer remains separate from this format" (0162:60) | We embed governance in overlay consensus and off-chain envelope; our admission needs envelope+σI+linkage (G/mandala/envelope.go, deploysig.go) not derivable from chain data alone. | note | Means an independent 1Color indexer cannot reproduce Mandala admission; independent 1Color indexer would admit transfers Mandala rejects (not violating spec, but spendability answers from `ls_color_` must come from our overlay). |
| 10.12 | Receive legacy supply and spend in binary form (207 A.40 ~4005; A.97-99 ~7142-7287) | No BRC-161 support (DD:33; no code for BRC-161 JSON). | divergent-intended (no legacy tokens in Mandala) | A.40/A.97-A.99 need only apply if the wallet accepts foreign 1Color assets; Mandala wallet only handles Mandala-topic coins. |
| 10.13 | Wallet MUST not assume unresolved source is bare satoshis; authenticate every input (207:701-712) | L/ftCandidates*.ts, receive paths verify via overlay σI (see DD §6 and offline settlement). Not audited in depth. | not audited | |
| 10.14 | Required profile unsupported -> wallet error (207 A.142 ~9381) | n/a; our wallet never sees `req`. | gap (see 1.2-1.3) | |

## 11. Upstream ts-stack (Bsv21Binary vs OneColor; topics)

| # | Item | Observation | Status | Note |
|---|---|---|---|---|
| 11.1 | ts-templates/src/OneColor.ts (155 lines, origin/main) | Extends Bsv21Binary: `readTokenId` accepts 32 or 36 byte direct push (OneColor.ts:34-50), `tokenIdFromString` `<64hex>_<vout>` -> canonical wire id (vout 0 -> 32 bytes; else 36 bytes; vout>uint32 refused) (61-70), `tokenIdToString` fails on 36-byte vout 0 (72-82), `lock(tokenId string|null, amount, pkh, payload?)` uses it. Decode returns same OneColorDecoded shape (restChunks, restPubKeyHash, payload, payloadCanonical). Package version not readable (no package.json in export). | new in 2.1.0 per task brief | Mandala's pinned `@bsv/templates ^2.0.0` (lib/package.json:35, app/package.json:16; installed 2.0.0) lacks OneColor: no 36-byte ids, `tokenIdToString` only `_0`. |
| 11.2 | Neither Bsv21Binary nor OneColor implements the `OP_0 OP_DROP` encoder rule, `req`/`ext`, or `icon` parsing | Both only lock canonical P2PKH remainders; payload is raw bytes; no DAG-CBOR attribute reader. | gap upstream (low) | Rule only needed once non-P2PKH remainders are encoded. |
| 11.3 | Uint64 in templates | `BSV21_MAX_AMOUNT = 2^64-1`, bigint everywhere. | conform | |
| 11.4 | topics/src/brc162/ledger.ts (layer A) imports `Bsv21Binary` from @bsv/templates (ledger.ts:8); not switched to OneColor in this export, so 36-byte ids are classified invalid. topics/src/mandala/ownership.ts:26,96,99 keep MAX_SAFE and 1-sat; MandalaTopicDocs.md.ts:119 documents ERR_SATOSHIS. topics/src/bsv21/Bsv21TopicManager.ts uses `Bsv21Token` (BRC-161 JSON). No tm_color_<assetId> / OneColor topic in topics/src. | gap upstream vs final 0162/0207 (no conforming `color` service export seen) | Mandala's Go port mirrors upstream mandala topic (parity refs ts-stack 37468f290, G/brc162/doc.go). |
| 11.5 | `strictCbor.ts` (templates) | Same subset as Go; no arrays. | divergent-intended | See 10.4. |

## Top gaps (priority)

1. **Overlay 2^53-1 cap on per-output amount, per-tx sums and supply** (G/mandala/ownership.go:73, authority.go:246-257, amount.go:12) plus lib `number` amounts (L/brc162.ts:60,90, L/amount.ts): conflicts with the final per-output uint64 rule and the user's 2026-10-13 decision; a conforming wallet output > 2^53 is rejected by overlay / invisible in lib. Needs bigint/Decimal128-or-string storage and wide sums. (Spec: 0162:139; 207 A.38/A.110-113.)
2. **No `req` declaration for Mandala semantics** (KYC, trusted issuer, freeze, pause, linkage envelope): conforming BRC-207 wallets treat Mandala assets as plain 1Color, will build transactions the overlay rejects, and our wallet ignores third-party `req` (unsafe vs 0162:149-152). Decide: declare an immutable `req` profile in new deploys (requires arrays/negatives in strict CBOR? only if params use them) and enforce unknown required profiles in lib; or keep Mandala-branded and do not call these 1Color.
3. **1-sat service filter and 32-byte-only ids** (G/ownership.go:70; G/codec.go:88-97): final spec says a conforming BRC-207 `color` service does neither (207:775-782, 1552). Both intended divergences (DD D2, §3), so a Mandala overlay cannot answer as `ls_color_<assetId>` without either change; templates pin 2.0.0 lacks OneColor (upgrade to 2.1.0 gives 36-byte codec).
4. **Naming/service surface**: `tm_mandala`, `tm_<txid>`, `ls_<txid>`, `p mandala token`, single `mandala-tokens` basket vs `tm_color`, `tm_color_<assetId>`, `p color ...` baskets, `color-spendability` query, `brc207-color` capability.
5. **Strict-CBOR subset (no arrays, <=4096 B, depth 4, no tag 42/negatives)** makes spec-valid `icon`/`req` payloads undecodable and rejects deploy; no icon support at all (0162:230-240).
6. **No holder burn** (I == O only): BRC-207 A.35 explicit burn not supported; documented divergence (DD D5).
7. Spec editorial: 0162:107 (`<txid>.0`) vs 0162:116 (`<txid>_<vout>`), report upstream.
8. Encoder `OP_0 OP_DROP` rule: no action needed today (P2PKH only), add if non-P2PKH remainders are ever encoded.

---

## Appendix 2-modules

### Findings 2 — P-modules (bsv-desktop + bsv-wallet) vs BRC-207 / upstream @bsv/color-permission-module 0.1.0

Read-only audit. Paths: DESK=/Users/personal/git/ts/bsv-desktop/src/lib/permissionModules ; WAL=bsv-wallet@origin/master:packages/expo-wallet-toolbox/core/mandala ; UP=ts-stack@origin/main:packages/wallet/color-permission-module/src.
Desktop tests could NOT be run (`@bsv/mandala/unlock` unresolved in this checkout); all statements are from static reading.
Agreed renames (Mandala->1Color, `p mandala`->`p color`, `tm_mandala`->`tm_color`) and no-back-compat are NOT counted as gaps. Blinded A' recipients stay (sender-side only).

## 1. Architecture map (ours vs BRC-207)

| Aspect | BRC-207 | Ours (desktop = wallet, same design) | Verdict |
|---|---|---|---|
| Basket | per-asset `p color <assetTag>` + `p color <assetTag> authority`; no global basket (0207:567-577) | ONE basket `p mandala` for all assets (DESK mandala.ts:8, WAL types.ts:318); no authority basket (authority/issuer outputs are not P-basketed; lib uses `mandala admin` protocol, `constants.ts` ADMIN_PROTOCOL) | divergent (after rename still one global `p color` basket). Needs per-asset baskets for conformance; incompatible with `p color balance <tag>` |
| Protocol / key | `[2,"p color <assetTag|issue> <hex(prefix)> <hex(suffix)>"]`, keyID fixed `color` (0207:519-565) | `[2,'p mandala token']` FIXED; uniqueness in keyID (`xfer-<ts>`, `change-<ts>-<i>`) (lib constants.ts:7, transfer.ts:220-246) | divergent (inverse split). Real conformance change: asset/prefix/suffix move into protocol name, keyID=`color` |
| Counterparty | sender derives recipient child with recipient identity, `forSelf:false`; recipient derives with sender identity; `anyone` = pubkey of key 1 in receipt (0207:549-558) | Same BRC-42 relationship (unlock.ts:54-63 forSelf:true for received); blinded A' = A+rG default (blinding.ts) so recipient counterparty is A', not sender identity | divergent-intended (blinding). Remittance (`senderIdentityKey`) would carry A'. Self-send uses identity key unblinded |
| Capability discovery | `getVersion` returns `brc207-color=4` (BRC-205) (0207:1494); upstream emits `5` | none: no `capabilities` field on either module; no getVersion hook. Installed desktop `@bsv/wallet-toolbox-client` 2.14.5 has `handleRequest` but NO `capabilities`/BRC-205 `withBrc205Capabilities` (only ts-stack master has it) | gap (blocked on toolbox bump) |
| Inventory/balance | `p color assets` + `p color balance <tag> [authority]` BRC-112 decimal-string totals, state tags `color_state_*` (0207:600-693) | none. `listOutputs` on `p mandala` just prompts once/session then passes through raw wallet result; apps must sum themselves (lib ftCandidates) | gap |
| Who builds/signs | Wallet-managed: module reads plan labels (`p color plan i n hex`), selects per-asset inputs, adds token change in `createAction`, signs token inputs in `signAction`, verifies overlay spendability, submits to `tm_color_<asset>` (0207:1161-1253; UP ColorPermissionModule.ts createAction/signAction) | App-built (Mandala lib): lib selects coins (ftSelect/ftChange), builds outputs, calls `createAction` (wallet funds sats only), signs each token input itself via `createSignature{hashToDirectlySign}` (unlock.ts:50-55), `signAction`, then lib submits to overlay. Module = consent gate only, no planning/overlay checks | divergent-intended (simplest-token principle) but means most MUST bullets below are n/a or gap |
| Dispatch | Reserved `p color` identifiers routed to module before generic permissions (0207:587) | Manager routes basket `p mandala`, labels `p mandala *`, protocol `[2,'p mandala token']` by schemeID `mandala`; inputs-only spends need `wrapCreateActionForTokenInputs` injecting label `p mandala token-spend` (DESK permissionModule.ts:399,867; PermissionQueueManager.ts:960; WAL WalletContext.tsx:2108-2115) | conform in effect (extra wrapper = fragile wiring; see G7) |
| Module hook used | `handleRequest(req,next)` + `onRequest` + `capabilities` (UP:870-930) | `onRequest/onResponse` only (arg-gating); response hook captures sighashes | divergent; fine for gate model |

## 2. Spec-clause table

Legend: Status = conform / gap / divergent-intended (DI).

| # | Spec clause | Desktop | Wallet | Upstream | Status | Note |
|---|---|---|---|---|---|---|
| 1 | Asset identity = issuance outpoint, canonical `<txid>_<vout>` (0207:32) | token.ts decode -> `tokenIdToString` (token.ts:25-30) | same (token.ts identical to desktop) | identifiers.ts parseAssetId | conform | amount > 2^53 rejected (token.ts:27) while spec wants uint64 (up to 2^64-1) and exact big sums | 
| 2 | Amounts exact integers, uint64, no float (0207:38-45) | amounts are JS `number`; `formatTokenAmount` uses float division `baseUnits/10**decimals` `.toFixed` (permissionModule.ts:374-377); decode throws >MAX_SAFE_INTEGER | same | bigint everywhere, decimal strings | gap (known 2^53 incident) | Prompt display can round for large amounts; asset with >2^53 output is undecodable -> generic prompt |
| 3 | New outputs MUST be BRC-162; BRC-161 JSON receivable (0207:49-53) | only BRC-162 VALUE decodes (`Bsv21Binary`); JSON inputs not recognized | same | reads BRC-161 JSON as value/authority | gap (low) | foreign BRC-161 coin would be seen as non-token => "generic" prompt |
| 4 | Protocol ID wire format, keyID `color`, 280-char bound, invalid identifiers fail before derivation (0207:519-565; A.04-A.07) | none: no parsing of protocolID/keyID; `getPublicKey/verifySignature` pass through for any token-protocol args (onRequest default branch :510-516) | same (:507-516) | parseKeyArgs rejects non-conforming (UP:~2130-2190) | gap | A.07 (reject `ISSUE AQ==` spelling) not enforced; follows from DI on key layout |
| 5 | ISSUE key preserved after finalization; store exact tuple (0207:566-567) | not modelled (lib stores keyID/counterparty in customInstructions JSON) | same | assertOwned/custody tuple | DI | lib keeps keyID per output; no ISSUE concept |
| 6 | Per-asset value + authority baskets, no global basket (0207:567-577; A.09/A.10) | single `p mandala` | same | assetBasket(), parseAssetBasket | divergent | see §1; authority outputs not in any P basket |
| 7 | Reserved `p color` identifiers dispatched to module; app cannot bypass by renaming baskets/relabeling (0207:585-591; A.11) | basket/label/protocol routing by manager; input-only spends caught by wrapper | same | same + handleRequest | conform (wiring-dependent) | relinquishOutput prompts every time and resolves target from own listing (promptForRelinquish :598-625) -> matches A.11 intent; fail-closed if unresolved |
| 8 | `createSignature` accepts ONLY the transaction request envelope; `hashToDirectlySign` MUST be absent (0207:1033-1050; A.13) | accepts `hashToDirectlySign` (or `data`, sha256-hashed) and signs it if equal to BIP-143 SIGHASH_ALL|FORKID digest of an input of a createAction-approved tx; otherwise PROMPTS per signature and then signs ANY 32-byte digest (authorizeSignature :552-560; signedDigestHex :61-77) | same (:552) | rejects `hashToDirectlySign` with error (UP:1904-1908); requires JSON envelope; module computes the preimage itself | divergent-intended + risk | A.13 expects an error, no prompt. Ours lets user approve blind digest signing (message `{type:'mandala_signature'}` carries NO tx detail; Prompt.tsx:87-88 "only approve if you just asked...") = user-approvable arbitrary-digest oracle on a custody key. DI for the app-built flow (lib needs hashToDirectlySign) but the unapproved-digest PROMPT branch is the unsafe part: recommend hard refuse (no prompt) |
| 9 | Signing needs module-computed consensus preimage from authenticated source; coverage disclosed (0207:1052-1070; A.52-A.57) | digest set = BIP-143 ALL|FORKID hash256(preimage) per input of approved `signableTransaction` (authorizedSighashes :85-96, `tx.preimage(i)` default scope) | same (:88) | `preimage()` honors sighashType from envelope + SINGLE guard (UP:2268-2300) | divergent | Only ALL|FORKID digests auto-pass. NONE/SINGLE/ANYONECANPAY/Chronicle digests are never in the set -> fall to blind prompt (#8). No SINGLE `inputIndex<outputs` guard (0207:1088-1095, A.59). Lib only signs `all` by default (unlock.ts:42) so honest flow works |
| 10 | Consent covers actual final layout: every asset leg, satoshis, fee, released signatures (0207:1236-1240; A.26) | prompt built from createAction ARGS outputs only (extractOutputAmountsByAsset :743-763): sendAmount/changeAmount per asset; no satoshi totals, no fee, no input accounting, no burn detection; `signableTransaction` is hashed AFTER approval (onResponse :529-543) not re-evaluated | same (:736-756) | transactionConsent/actionConsent over final tx (UP) | gap (HIGH) | Wallet-added funding inputs/change and the explicit token inputs are not shown. Token inputs worth more than outputs = silent burn shown as a smaller send (0207: burns must be explicit, 1239-1245) |
| 11 | Wallet derives actual P2PKH hash before counting output as change/own (A.15; 0207:2420 text; "control of each requested custody output" 1470) | `output.basket === 'p mandala' && !isMarkedSent` => counted as CHANGE, never verified against wallet-derived key (extractOutputAmountsByAsset :754) | same (:747) | assertOwned derives key and matches hash (UP:~2180-2190) | gap (HIGH) | A malicious app can basket an attacker-paid token output into `p mandala` (or set no 'sent' marker) so the prompt shows send=0/change=N while funds go to attacker (Prompt shows `line.display` = sendAmount only, Prompt.tsx:122-126). The `isMarkedSent` comment ("can only make the prompt show more") is true only for the non-basket direction |
| 12 | Encrypt/decrypt/HMAC/linkage MUST be rejected (0207:593-595; A.12) | `encrypt/decrypt/createHmac/verifyHmac` refused with error even before generic grants (REFUSED_KEY_METHODS :54, :511-513) | same (:57) | default branch throws `not available` (UP:897) | conform (partial) | Linkage revelation (`revealCounterpartyKeyLinkage`/`revealSpecificKeyLinkage`) is NOT in the refused set; in the manager those methods may or may not be P-routed. Verify manager routing; add to refused list. Also lib's blinding uses specific linkage revelation toward overlay under `FT_PROTOCOL` (blinding.ts:149-157) => spec/lib conflict for the blinding design (needs admin-originator only; external apps still blocked only if routed) |
| 13 | `getPublicKey`/`verifySignature` public semantics retained (0207:591-592; A.05, A.58) | pass-through (:514-516) | same | pass-through after parseKeyArgs | conform | `verifySignature` with `hashToDirectlyVerify` unaffected |
| 14 | Read permission module-aware; no leakage without grant; `seekPermission:false` => error not prompt (A.115, A.27) | listOutputs/listActions prompt once per originator per 30 min (promptOnceForAccess :562-580); args.seekPermission IGNORED; no scoping; returns whatever wallet returns incl `customInstructions` (key tuples) when asked | same, 60s window (:563) | `authorizeRead` every call w/ `seekPermission` forwarded; host decides (UP:2373-2378) | gap (medium) | A.115/A.27 not honored: always prompts, even when app set `seekPermission:false`. Access grant is shared by listOutputs+listActions+spend+credit prompts (grantSessionAuthorization in promptForSpend :676 etc) => spend approval silently unlocks inventory reads for 30 min; spec: "generic grant does not automatically authorize this inventory scope" (A.115) |
| 15 | `p color assets`, `balance` selectors, state tags, ordering, snapshot, pagination (0207:600-693; A.105-A.114, A.132-A.133) | not implemented | not implemented | inventory()/balance() (UP:2030-2100) | gap | App must list `p mandala` and sum itself. Blocked on per-asset baskets (#6). Note upstream returns `totalOutputs` as decimal string; needs toolbox/BRC-112 substrate support |
| 16 | `balance p color ...` prefix prohibited (A.114) | n/a | n/a | basket parse rejects | n/a | |
| 17 | Overlay admission/spendability check for every input; fail closed; no caller topic hints (0207:700-780; A.16-A.23) | NONE in module. Lib does overlay admission itself (admission.ts, transfer pipeline) | same | `spendable()`/`admission()` via ColorOverlayProvider; foreign inputs authenticated | DI | Trust root is the lib/overlay in the app. A third-party app that calls createAction/createSignature directly gets no overlay check from our module => it can sign a spend of a coin the overlay would reject (harmless to funds: unspent coin spends are the user's own) but consent text may overstate receipt |
| 18 | Known topic rejection => refuse every wallet-controlled signature (0207:1127-1137) | none | none | partial (spendable checks) | DI | lib submits to overlay after signing (recipient submits model per offline-settlement) |
| 19 | Plan labels `p color plan i n hex`, strict JSON, randomizeOutputs:false (0207:1161-1250; A.14,A.15,A.61,A.89) | no plan; lib deliberately lets wallet shuffle outputs (transfer.ts ~"No randomizeOutputs:false"); labels `mandala`,`transfer`,`to-<key>` | same | ColorPlan.ts + createAction | DI/gap | Unknown labels pass; upstream rejects unknown `p color` labels. Ours accepts any `p mandala*` label as a route trigger |
| 20 | Wallet selects inputs per asset, fresh change, positions constraints (0207:1205-1232; A.24-25) | lib selects (ftSelect/ftChange, `loadFtCandidates`) | same | selectInputs in module | DI | |
| 21 | Atomic cross-asset reservation, exposure records after signature release; abort doesn't free inputs (0207:1244-1253) | no module reservation; wallet `abortGuard.ts` (wallet only) refuses abort of admitted settlements; desktop none | wallet: `wrapAbortActionForSettlements` (WalletContext.tsx:2108-2115) | README says "not yet recorded as BRC-207 exposure" | gap in both (wallet partial) | Desktop lacks abortGuard — check parity with 2026-09-15 incident |
| 22 | Internalize: `basket insertion` into per-asset basket with JSON `{version:1,assetId,derivationPrefix,derivationSuffix,senderIdentityKey}`; wrong basket fails; reject `tokenProofs`; 1000-byte bound; must already be admitted (0207:1427-1470; A.115+) | promptForCredit only decodes tx outputs & prompts (:680-721); no validation of customInstructions, assetId/basket coherence, admission, or receipt member set; lib's customInstructions = `{protocolID,keyID,counterparty,label}` (receive.ts:331-338) | same | internalizeAction() validates every field (UP:~990-1070) | gap (+DI) | Fraud vector: app can internalize an output it cannot spend into `p mandala` (inflating local inventory) — prompt text is just a credit line. Low harm without overlay-backed balance |
| 23 | Non-final/locktime/auction (0207:1253-1420) | none | none | not implemented upstream either | n/a | |
| 24 | noSend/BRC-177 handoff (upstream) | lib handover flow uses plain noSend + signAction (handover.ts) | same | requires `p nosend expiry` label; only noSend token action | DI | our lib doesn't emit BRC-177 labels |
| 25 | `brc207-color=4` in getVersion (0207:1494; A.01/A.02) | absent | absent | `capabilities: {'brc207-color':'5'}` + manager `getVersion` (UP:848; WalletPermissionsManager.ts:228-290,5781) | gap | Upstream advertises 5, spec text says 4 (A.x also shows 5 at 0207:1824) — spec internally inconsistent; align with spec editor. Needs toolbox bump |
| 26 | Module never exposes protected keys via aux methods; 'generic signing grant cannot bypass' (0207:587-595) | protocol-routed methods are gated; `seekProtocolPermissionsForSigning` generic grants don't apply because module dispatch precedes | same | same | conform | but #8 prompt path breaks the spirit |
| 27 | User decline => error, no signature, reservation released (A.26) | denial throws 'User denied permission to spend tokens' (:671-675) | same | `the user declined the color_send request` | conform | error wording differs (spec: `User declined the Colored Tokens spend`, code 1) — cosmetic |

## 3. Desktop vs Wallet module diff (`diff DESK/mandala/permissionModule.ts WAL/permissionModule.ts`)

- `token.ts`: identical byte-for-byte (both Bsv21Binary-based).
- `permissionModule.ts` (DESK 920 lines vs WAL 930):
  1. SESSION_TIMEOUT_MS: desktop 30 min (DESK :46, commit d99f397), wallet 60 s (WAL :49). Governs listOutputs/listActions session AND approved-transaction lifetime for createSignature.
  2. Desktop dedupes concurrent access prompts per originator (`pendingAccessPrompts`, DESK :416-420, :566-576; commit 9945d83). Wallet: one prompt queued per call.
  3. Import `@bsv/wallet-toolbox-client` (desktop) vs `@bsv/wallet-toolbox-mobile` (wallet).
  4. Comments only: wallet header still describes "own script layout 8-chunk"/`0.4.0` and an outdated finding (1) text; wallet `listOutputs` case has braces. Wiring doc differs (guardVaultAccess ordering vs PermissionQueueManager).
- Wiring: desktop wraps in `PermissionQueueManager.ts:960` + `mandala.ts` (`includeCustomInstructions:false` for internal listings); wallet in `WalletContext.tsx:2017-2115` plus `wrapAbortActionForSettlements`, `SigningPolicyPermissionsManager`, `migrateMandalaBasketName`.
- Wallet extras absent on desktop: `abortGuard.ts` (blocks abortAction of admitted token settlements), `basketMigration.ts`, `settlementStore.ts`, `drain.ts`, `inboxPrehold.ts`, `createRuntime.ts` (offline settlement runtime).
- Desktop extras absent on wallet: React `Prompt.tsx` (FIFO MUI dialog; mobile uses its own UI), `registry.ts` default-enabled module restoration.
- Newer/canonical: DESKTOP module is newer (30-min window + prompt dedupe). Wallet (origin/master) is behind by two commits-worth of behavior. Canonical for desktop = bsv-desktop HEAD 9945d83; wallet should adopt both changes if the 30-min window is desired (security note: 30 min extends both inventory-read and approved-tx signing windows; spec has no objection but G5 interacts).
- TESTS: desktop test file `test/mandalaPermissionModule.test.ts` still asserts a 60 s expiry (lines 137-148 "expires after 60 seconds", 982-998 "forgets an approved transaction after the session window", both advance 61 s). With the 30-minute constant these two tests should FAIL — the test file was last touched in 3e8d997 (2026-10-07), before d99f397. Not run (dependency `@bsv/mandala/unlock` unresolved in checkout) so unverified. Wallet tests match its 60 s code.

## 4. Ours vs upstream @bsv/color-permission-module 0.1.0

Upstream implements, ours lacks: per-asset `p color` baskets + `assets`/`balance` views (BRC-112 decimal strings, `color_state_*` tags); strict key parsing (`parseColorProtocolID`, keyID `color`, 280-char); plan labels (`ColorPlan`) incl. operations/inputPositions/changePositions/sighashTypes; module-run input selection, per-asset change, signing in `signAction` with sighashType overrides and SINGLE guard; overlay provider (`color-spendability`/`color-admission`), foreign-input authentication, `tm_color_<asset>` submission with 3 retries and held-output resubmit; deploy/ISSUE handling; BRC-177 handoff (noSend + auto split); strict receipt validation in `internalizeAction`; `createSignature` envelope-only with full transaction consent (`color_signature`); consent for the final funded tx (`color_send`) incl. sats/fee; `capabilities` (BRC-205); `handleRequest` hook; `dispose()`; `requestTokenAccess` types `color_send|color_signature|color_access|color_relinquish`; BRC-161 JSON read support; unknown-label rejection; `p color` labels in internalize rejected.

Upstream explicitly fails (same non-goals): issuance/mint/burn/authority beyond plan ops, BRC-161 JSON burn/holding, required profiles, `profileData`, satoshi `changePositions`, non-final txs, exposure recording of createSignature releases, BRC-176 lineage.

Ours does that upstream/spec differ on or forbid:
- Accepts `hashToDirectlySign` (spec: MUST be absent) and allows blind per-signature user approval (A.13).
- Single global basket and fixed protocol with per-keyID uniqueness (spec: per-asset baskets; keyID `color`).
- Session-based approval caching (30 min / 60 s) and cross-prompt-class grant sharing; upstream "asks on every operation, keeps no grants" and leaves caching to host.
- Ignores `seekPermission`.
- Trusts `basket`/`customInstructions` markers from the caller for the consent summary; upstream derives ownership from keys.
- Numbers (not bigint) for amounts.
- Blinded recipient keys A' (upstream/spec: remittance carries sender identity; A' sender-side blinding compatible only if recipient is told counterparty A'; spec has no blinding concept — agreed DI).
- Lib does overlay checks app-side; upstream module does them wallet-side.

## 5. Prioritized gap list

P0 (security; module-level, fixable without lib changes)
1. **Unapproved-digest prompt = blind signing** (#8): authorizeSignature (DESK :552-560, WAL :552) lets the user approve signing any 32-byte digest with token keys with a content-free prompt. Replace with hard refusal (spec A.13), or require the app to supply a parseable tx envelope and show consent. Desktop and wallet both.
2. **Prompt can be spoofed by basketing output / marker** (#11): verify every `p mandala`-basketed output is actually locked to a key the wallet derives from the stated customInstructions (or cross-check against signableTransaction response and recompute), else count it as sent. Also show change not as reassurance unless verified.
3. **Consent ignores inputs/burn** (#10): compute token input sum (resolve explicit inputs via listOutputs) vs outputs; show any difference as BURN; show sat total/fee from the final signableTransaction (re-verify at onResponse/ before signature, since the approved digests are taken from that tx).
P1
4. **`seekPermission:false` must error not prompt** (#14); separate approval classes so spend approval does not unlock inventory reads (grantSessionAuthorization in promptForSpend/promptForCredit/promptGeneric).
5. **Linkage revelation not in refused set** (#12): add `revealCounterpartyKeyLinkage`/`revealSpecificKeyLinkage` to the refused methods or confirm the manager never routes them here; the lib needs them only under admin originator (already passes through).
6. **Desktop test drift**: update `test/mandalaPermissionModule.test.ts` 60 s expectations (lines ~137-148, 982-998) to the 30 min window (or expose the constant); parity-sync wallet module to desktop (30 min decision + prompt dedupe) or document that mobile intentionally stays at 60 s.
7. **Wiring fragility**: inputs-only spends rely on `wrapCreateActionForTokenInputs` at each entry point (PermissionQueueManager.ts:960, WalletContext.tsx:2108); fail-closed on list fault already handled. Add a test per entry point. Desktop lacks wallet's `abortGuard` (check).
P2 (conformance after rename; larger work, tied to spec-alignment)
8. Per-asset `p color <assetTag>` (+authority) baskets; protocol `[2,"p color <tag> <hexprefix> <hexsuffix>"]`, keyID `color`; strict identifier parsing (A.04-A.07, A.60).
9. `p color assets` / `p color balance <tag>` views with exact decimal strings and state tags (A.105-A.114); needs toolbox support for P-basket decimal-string `totalOutputs`.
10. `capabilities: {'brc207-color': ...}` + toolbox bump to a version with `withBrc205Capabilities` (installed 2.14.5 lacks); clarify 4 vs 5 with spec editor.
11. Envelope-based `createSignature` (JSON `{version,tx,inputIndex,sighashType,ownedOutputs}`) with module-computed preimage, all sighash families, SINGLE guard (A.52-A.59) — requires lib `walletMandalaUnlock` change.
12. `internalizeAction` receipt validation (strict `{version,assetId,derivationPrefix,derivationSuffix,senderIdentityKey}`, per-asset basket, reject unknown members, overlay admission check, 1000-byte bound).
13. Amount type: bigint/decimal string through decode/prompt (uint64 domain; remove 2^53 limit in token.ts:27).
14. Wallet-side overlay spendability/admission checks and submission (or keep as DI: lib does it).
P3 / not applicable now: BRC-161 JSON recognition, plan labels, BRC-177 handoff, exposure records for released signatures, non-final/auction txs, required profiles.

## Divergent-intended (keep, document)
- App-built flow (lib selects/signs; module is a consent gate) — simplest-token principle.
- Blinded recipient keys A' default.
- Lib-side overlay admission and recipient-submits settlement model.
- `randomizeOutputs` left default (wallet shuffles) — spec requires `false` only with plan labels.

---

## Appendix 3-offline

### Findings 3 — BRC-207 attested admission / offline graphs vs Mandala σI offline settlement

Refs: 0207:N = wallet/0207.md; M: = mandala repo; W: = bsv-wallet origin/master core/; U: = ts-stack color-permission-module/src.

## Profile requirements (0207:162-450)
- Id/version `https://brc.dev/207/attested` v1, declared only in immutable deploy `req` (binary BRC-162), not combinable with BRC-209 (0207:164-171).
- params: `trustMode` any/same/all/identity (default any); `identityKey` iff identity; `evidenceProfile`; unknown members/null fail (0207:173-179).
- Trust: BRC-189 list snapshot + consent, empty list fails, recheck before release; identity = fixed key, no rotation (0207:196-232).
- Statement `1color-admit:v1:tm_color_<id>:<txid>:<outs>`, single SHA-256, BRC-42 child `[2,"color admission attestation"]` keyID 1 counterparty anyone, low/high-S accepted, no timestamp (0207:235-290, C.0).
- Carrier `profileData[uri][assetId] = {declarationTx, transactions, attestations, submissions?, lifecycles?}` (0207:295-326).
- Frontier: every same-asset path incl. authority inputs reaches attested anchor on exact outpoint; full local transition validation of unanchored hops; mined-only ≠ anchor; no duplicate spend in graph; SPV for BTC inputs; known contradictory spend defeats acceptance (0207:328-357).
- Offline: credit before broadcast allowed; `spendable` + `color_offline`; deferred vs settled shown; reserved parent+child not both counted (0207:381-403).
- Settlement: internalize does not broadcast; submit ancestors parents-first; exact-bytes idempotent retry; drop `color_offline` only after real admission (0207:405-421).
- Replacement via `evidenceProfile` naming another exact profile in `req` (0207:429-448).

## Clause table
| # | Spec | Ours | Status | Action |
|---|---|---|---|---|
| 1 | Profile in `req` (0207:164-179) | no deploy has `req`; payload `{sym,dec,label,feeRatePerKb?}` (M:lib/src/brc162.ts:213-220); Go ignores unknown keys (details.go:298-340) | gap→conform | new deploys add `req` (identity mode, overlay key) |
| 2 | `req` immutable (C02-C04) | old deploys baseline | gap→conform (new deploys) | no back-compat |
| 3 | Message bytes (0207:235-258) | `mandala-admit:v3:tm_<txid>` (M:lib/src/admission.ts:46) | gap→conform / F1 | topic rename is overlay-wide |
| 4 | BRC-42 anyone child key (0207:259-290) | bare key (admission.ts:127-137; overlay-go/internal/mandala/admissions.go:86) | gap→conform | breaking wire change, accepted |
| 5 | high-S accepted | TS+Go accept | conform | add C.0 vectors |
| 6 | BRC-189 snapshot + consent | one configured key (lib/src/constants.ts:30,65), no consent | gap→conform | identity mode; add consent record |
| 7 | no rotation (0207:222) | rotation out of scope | spec-ambiguity F2 | |
| 8 | carrier shape | handover body/frame v4 (AtomicBEEF + admissions[] + linkage[]) (handover.ts; receive.ts:262-300) | gap→conform | adapter; add declarationTx |
| 9 | authenticate `req` first (0207:62-94) | no reader | gap→conform | strict reader |
| 10 | frontier includes authority inputs (C26) | `decodeValue` value-role only (brc162.ts:80-85) | gap→conform | walk authority inputs |
| 11 | local transition validation (C25) | none on unanchored hops; tip-only conservation in W:localpay/verify.ts:353 | security gap + offline feedback F3 | validate public BRC-162 rules before credit |
| 12 | Mandala rules beyond BRC-162 (linkage, freeze/pause/KYC, I>O) | overlay-only | spec-ambiguity / F3 | |
| 13 | mined ≠ anchor (C22) | FIX B | conform | |
| 14 | per-vout coverage (C24) | FIX A | conform | |
| 15 | no duplicate spend in graph (C20) | not checked | gap→conform | outpoint-uniqueness pass |
| 16 | diamond/cycle/hash-checked | memo + IN_PROGRESS + hash check | conform | |
| 17 | BTC SPV (C23) | BEEF + internalizeAction; FIX K | conform (by reading) | |
| 18 | known conflict defeats acceptance (C28) | only at /submit (FIX L) | gap (minor) | local spend/ban check |
| 19 | persist evidence w/o sender | durable frame bytes (drain.ts, settlementStore.ts) | conform | |
| 20 | unknown profile fails (A.142-A.148) | unhandled; U:tokenOutputs.ts:47-88 has guard | gap→conform | port |
| 21 | malformed `req`/`ext` fails (A.147) | unhandled | gap→conform | |
| 22 | profileData limits (A.144, A.154, A.157-A.159) | no profileData | vacuous | |
| 23 | balance + deferred display (C40) | settling vs settled (W:mandala/createRuntime.ts:443-500) | conform | |
| 24 | reserved parent/child (C41) | noSend reservation (abortGuard.ts) | conform (by reading) | test |
| 25 | lifecycles (C43-C46) | no BRC-177 | spec-ambiguity F4 | risk limit |
| 26 | no broadcast on internalize | inboxPrehold.ts | conform | |
| 27 | topological settle, exact-bytes retry (C48-C51) | yes | conform | |
| 28 | drop offline flag after admission (C54) | `admitted` = settled | conform | |
| 29 | evidenceProfile | n/a | spec-ambiguity F5 | |
| 30 | no signed age (C56) | no timestamp | conform | |
| 31 | restricted resources (A.149-A.153) | freeze = overlay ban + wallet sync | spec-ambiguity | map frozen→restricted |
| 32 | bounds (C37) | 64 KiB frame cap, explicit refusal | conform | |

---

## Appendix 4-overlay

### BRC-207 conformance audit 4: overlay spendability, discovery, evidence, internalization

Scope: spec `specs/0207.md` (694-1024, 1425-1490, App. A.16-23, 77-86, 100, 102, 117-118, 127, 129-131) and `0162.md` against Mandala Go overlay, `lib/src`, wallet `core/mandala`, upstream `color-permission-module`.
Read-only. Paths: GO=/Users/personal/git/demos/mandala/overlay-go/internal, LIB=/Users/personal/git/demos/mandala/lib/src, W=bsv-wallet@origin/master:packages/expo-wallet-toolbox/core/mandala, UP=ts-stack@origin/main:packages/wallet/color-permission-module/src.
Standing user decisions: rename to tm_color etc. AGREED (no back-compat); Mandala keeps trusted-issuer gating, authority-only supply, holder I==O.
Status legend: conform / gap / divergent-intended / spec-ambiguity. "Planned" = covered by the agreed rename but not yet done.

## Table

| # | Spec clause | Our behavior (file:line) | Upstream ref | Status | Note |
|---|---|---|---|---|---|
| 1 | 0207:694-702 per-asset topic `tm_color_<assetId>`, lookup `ls_color_<assetId>`, canonical underscore asset id | Per-token `tm_<64hex>` / `ls_<64hex>` with the `_0` dropped: GO/mandala/topics.go:29-47, 53-60 (`tokenTopicPattern ^tm_[0-9a-f]{64}$`, :21-22). lib mirror LIB/brc162.ts:13-34. README topic table | UP/identifiers.ts:191-195 (`DISCOVERY_TOPIC='tm_color'`, `colorTopic`=`tm_color_<assetId>`) | gap (planned rename) | Asset id is `<txid>_0` only (topics.go:21). Rename must switch the pattern to `tm_color_<txid>_<vout>`; topic derivation, `IsSigmaTopic` (topics.go:67), `DeployTokenOf` (:73-80) and the lib/wallet regexes all change with it. |
| 2 | 0207:694-700 topic/lookup cover both encodings, value and authority | Per-token topic admits deploy, authority and value outputs of one BRC-162 token (token_topic.go:96-143; README row 2) | UP/ColorPermissionModule.ts:1031-1070 | conform (BRC-162) / divergent-intended (no BRC-161 JSON) | Mandala has no BRC-161 encoding anywhere (brc162/codec.go only). Consistent with the simplest-token principle, but then Mandala must not claim to be a "conforming color service" for BRC-161 assets (0207:775-778). |
| 3 | 0207:703-712 wallet authenticates EVERY input (caller-supplied or selected), resolves token vs bare sat, derives topic itself, fails if unresolvable | lib/wallet pick coins from the local basket (W/createRuntime.ts:673-725 lists `p mandala` and filters by asset). The only server-side input check is `/submit`: `requireUnspent` (GO/mandala/token_topic.go:149-169) plus `ClassifyAdmittedInputs` over engine `previousCoins` (:100). No client-side per-input classification or spendability call | UP/ColorPermissionModule.ts:1202-1217, 1585, 1825, 1990 (`spendable()` before signing) | divergent-intended / gap | Mandala's gate is "submit to overlay first, broadcast after" (LIB/overlay.ts:398-531), so an unadmitted input fails conservation at the overlay (ERR_CONSERVATION) rather than at the wallet. Spec wants the wallet to check before releasing the signature. |
| 4 | 0207:713-737 user-accepted provider/evidence config; BRC-88 SLAP discovery optional; authenticate provider + response provenance; fail closed; caller-supplied endpoint is not a trust anchor | One configured `OVERLAY_URL` + `OVERLAY_IDENTITY_KEY` (LIB/constants.ts:34-39). Admission provenance is σI v3 verified against the configured key (LIB/overlay.ts:313-347). SHIP/SLAP/GASP off (README:8-9, design A1.1) | UP/types.ts:5-14 (`ColorOverlayProvider`, host-chosen) | divergent-intended + one gap | Single-operator trust is a legitimate "configured provider" policy. GAP: with no identity key configured `requireVerifiedAdmission` only warns and returns (LIB/overlay.ts:314-320), so it fails OPEN. Spec says fail closed. |
| 5 | 0207:739-752 `color-spendability` query: `{type,version:1,assetId,topic,outpoints[]}`; BRC-24 `output-list` of exactly the queried, currently admitted and unspent outputs, each with outputIndex + BEEF; empty list = valid negative | `ls_<id>` takes `metadataTokenId`/`authoritiesTokenId`/`tokenId`/`txid+outputIndex` keys only (GO/mandala/token_lookup.go:118-121, 326-431). `RequireLookupQuery` rejects unknown keys, so `type`/`outpoints`/`assetId`/`topic` is an invalid query. Closest is the single-outpoint `{txid,outputIndex}` form (:407-430). Answers are formulas the engine hydrates to output-list (engine.go:730-752; GO/httpapi/lookup.go:56-98) | UP/overlay.ts:14-45 `readOutputList`; UP/types.ts:8-10 | gap (core) | Missing: `color-spendability` type, multi-outpoint batch, `version`, `assetId`/`topic` echo. Current-only semantics hold de facto because value/authority rows are deleted on spend (token_lookup.go:291-313), so `{txid,outputIndex}` gives a negative answer once spent. Hydration uses `FindOutput(...spent=nil)` (engine.go:771), so correctness depends on that row deletion, not on a spent filter. |
| 6 | 0207:753-761 `color-admission` query: historical membership incl. spent outputs | No such query. Spent rows are removed from the lookup tables; engine storage keeps outputs but no service exposes them. Nearest: `GET /admin/admission/:txid` (GO/httpapi/admin.go:~70-110), admin-token gated, per-tx σI, not per-output membership | UP/ColorPermissionModule.ts:2194-2212 (`provider.admission` to authenticate deploy) | gap | Needed for receipts whose consumed inputs were spent (A.78, A.85). Mandala's substitute is σI + COVER (lib bundle.ts), which is an attested-profile-style evidence model rather than the baseline. |
| 7 | 0207:752-757 any missing queried token outpoint fails; unrelated/duplicate/conflicting returned outputs invalid; wallet reconstructs outpoint and matches bytes (A.100) | Server: each formula is one stored outpoint of this token (token_lookup.go:413-430, `row.TokenID != l.tokenID` -> empty :418). Client: no `/lookup` client exists in lib (`grep fetch(` in LIB shows only /admin/* and /submit) | UP/ColorPermissionModule.ts:2219-2238; UP/overlay.ts:36-38 | gap (client) | Nothing in lib/wallet validates a lookup answer against source bytes; add alongside item 5. |
| 8 | A.16 trusted provider answer / A.17 absent membership (empty list = fail) / A.18 trusted providers disagree = cannot establish state / A.19 unreachable + stale cache = fail | Single provider; no multi-provider reconciliation. Unreachable overlay -> `OverlayRefusedError` ERR_UNAVAILABLE, retryable (LIB/overlay.ts:140-173, 223-226); nothing is broadcast after any refusal (:411-412). No cached-permission path | n/a (provider-injected) | divergent-intended | A.18 is moot with one provider. A.17/A.19 behave fail-closed at the submit gate (empty admitted set raises; overlay.ts:270-274). A.19: no stale cache is used. Conform in outcome. |
| 9 | 0207:763-788 services MUST apply BRC-161/162 rules, recognize both encodings incl. canonical 36-byte ids for legacy nonzero-index deploys, and ADMIT regardless of carrier sats; 1-sat is not a validity rule; a provider unable to comply MUST NOT advertise as the conforming service | Hard 1-sat rule: `RequireValidTokenOutputs` refuses any token output with `Satoshis != 1` (GO/mandala/ownership.go:70-72, reject.go:14,76 ERR_SATOSHIS). It rejects the whole tx, not just the output. 32-byte ids only (GO/brc162/codec.go:88-97; `^..._0$` topics.go:21). Deploy must be vout 0 (ownership.go:63-65). 36-byte id script = codec failure = invalid output = tx refused. No BRC-161 | 0162:30,87,110-111 (36-byte id), 0162:315-317 (1-sat "convention", validators MAY apply) | divergent-intended (but non-conforming as `tm_color_*`) | 0162 permits a 1-sat policy; 0207 forbids it for a conforming color service. Under the "simplest token" principle this is an accepted divergence, but it means Mandala topics cannot be advertised as conforming `tm_color_<id>`. If conformance is wanted: drop ERR_SATOSHIS, accept 36-byte ids and nonzero deploys (or scope out). Mandala's own wallets always create 1-sat outputs, so only third-party senders are affected. |
| 10 | 0207:789-822 shared `tm_color` discovery topic: authenticates complete deploy tx + chain evidence, validates deploy position/encoding without 1-sat filter, admits only qualifying deploys, not arbitrary asset ids; legacy nonzero deploys recognized | `tm_mandala` (topics.go:11): admits vout-0 deploy only after running the token topic's full check as a dry run, including trusted-issuer + deploySig gating and the 1-sat rule (GO/mandala/token_registry_topic.go:45-66, token_topic.go:96-130). Permanent registry record | UP/identifiers.ts:191 `tm_color` | divergent-intended (+ planned rename) | Issuer gating = user decision. It is stricter than spec ("admits qualifying deploy outputs"), so a spec-conforming wallet may see Mandala refuse deploys by untrusted issuers. Note this is a legitimate "provider unable to meet rules MUST NOT answer as conforming" case. |
| 11 | 0207:803-814 wallet-created deploy is submitted to `tm_color`; providers observe it and SEED per-asset topic/lookup; no per-asset provider needed before signing | One `/submit` naming `[tm_mandala, tm_<txid>]` (LIB/brc162.ts:38; GO/httpapi/submit.go:546-572 `DeployTokenOf`). The deploy hook calls `TokenTopics.Ensure` to register the per-token topic on submit (GO/wiring/tokentopics.go:76-100). Any other submit naming `tm_mandala` is refused ERR_SHAPE (README). Boot rebuilds from the registry (tokentopics.go:121-143). `MANDALA_TOKEN_ALLOWLIST` can leave a node not hosting a token (400 unknown-topic) | UP/ColorPermissionModule.ts:945 | divergent-intended | Same outcome (per-asset service exists once the deploy is admitted) but via a paired submit, not observation-seeding. The wallet gets the per-asset admission in the same STEAK, so "discovery ack alone is insufficient" (A.131) is satisfied by construction. |
| 12 | A.129 bootstrap; A.130 discovery ok but no per-asset provider -> keep exact signed tx + prospective basket pending, retry idempotently, don't re-issue | `submitToOverlay` requires every σ topic to admit (LIB/overlay.ts:270-274) and verifies σI per topic (:286-294). A retryable refusal journals exact bytes and keeps inputs held (:443-465); `/submit` is idempotent; reconcile retries (LIB/reconcile.ts). Registry per-topic σ binds the topic (README) | n/a | conform (outcome) | Overlay-first ordering (admit, then broadcast; overlay.ts:398-531) is stronger than spec's Bitcoin-then-overlay. The A.102 failure mode (chain done, overlay failed) is therefore reached only by the 'accepted' journal + broadcast-retry path (:498-530). |
| 13 | A.131 / 0207:1440-1468 incoming receipt needs the per-asset admitted-AND-unspent answer for the received outpoint; MUST NOT silently submit; missing admission rejects | v1 receive: `verifyIncoming` only decodes the output and checks asset/amount (LIB/receive.ts:98-123); σI is optional and "treated as absent" when missing or invalid (:125-150, doc :89-96). It then calls `internalizeAction` unconditionally (:323-343) and acks. No `/lookup` membership check, no admission requirement | UP/ColorPermissionModule.ts:1060-1070 (`spendable()` on the received output, throws if absent) | gap (P1) | `admissionVerified` is informational (:208). A sender that never submitted still gets credited, and `settled` stays true for v1 (:356). Wallet partly mitigates through the settlement tables and `ensureAdmissionsForHoldings` (W/createRuntime.ts:~1160-1220) and the storage broadcast guard (W/inboxPrehold.ts:1-40), but credit precedes admission confirmation. |
| 14 | 0207:1466-1480 A.117/A.127: candidate output is NOT spendable local balance until admitted; pending visible, not spendable; non-final tx cannot be internalized | Credit via `internalizeAction` happens before settle (LIB/receive.ts:323-343 then 361). The overlay-first send path keeps own change pending until admitted (overlay.ts:436-505). No non-final (nLockTime/sequence) screening in `receiveTokens` | UP/ColorPermissionModule.ts:1190-1195 | gap | Receive path: credit-then-settle. Send path: conform. Non-final detection (A.127) not implemented in lib. |
| 15 | 0207:1425-1450, A.80/A.81 basket + derivation: strict JSON `{version:1,assetId,derivationPrefix,derivationSuffix,senderIdentityKey}`; wrong basket FAILS; derivation must match the real output key | `customInstructions` = `{protocolID,keyID,counterparty,label}` (LIB/receive.ts:333-338), not the spec shape. One shared basket for all assets: lib `BASKET='mandala-tokens'` (LIB/constants.ts:19), wallet `MANDALA_BASKET='p mandala'` (W/types.ts:318); per-asset identity lives in `tags` (receive.ts:339). No check that the output's P2PKH hash equals the derived key, and no basket check | UP/ColorPermissionModule.ts:1031-1067 (`parseAssetBasket`, `assertOwned`) | gap (planned: `p color` per-asset baskets) | Mandala's own owner proof is overlay-side linkage (GO/mandala/ownership.go:`VerifyOutputOwners`), so a recipient relying on σI inherits it, but the v1 path has no σI requirement (item 13). A hostile sender can create an uncontrollable "credit". Strict-JSON/duplicate-member rejection is absent. |
| 16 | A.83 idempotent receipt retry | `isAlreadyInternalized` = regex `/already\|duplicate\|exists/i` over the error string, treated as success (LIB/receive.ts:153-155, 344-350); dedup `processed` set (:239, 406) | n/a | conform (fragile) | Works, but string-matching a wallet error is brittle. Suggest a structured check (output already in basket for this outpoint). |
| 17 | A.84 receipt instructions reject `tokenProofs`, proof URLs and unknown members | No schema validation of customInstructions; unknown members ignored | UP (strictJson.ts) | gap (low) | Mandala carries no BRC-176 packets (offline COVER + σI instead), so the exposure is only lenient parsing. Becomes moot once item 15 adopts strict JSON. |
| 18 | A.85 / A.118 historical admission of consumed inputs via lookup or BRC-176 lineage; cached packet must match asset+subject; cache presence is not validation | Historical evidence is the σI/COVER bundle (LIB/bundle.ts:245-371, `cover()` against the configured key; LIB/receive.ts:262-300). No BRC-176 anywhere | n/a | divergent-intended | Equivalent to the "attested profile" replacement the spec allows only for a declared profile. Mandala has declared no profile; flag as spec-ambiguity until Mandala's profile is declared (e.g. via `profileData`). A.118 is n/a (no packet cache). Cache-scope bugs cannot occur. |
| 19 | 0207:823-870 evidence: full BEEF/SPV, source outputs, proofs, scripts, balance rules per asset, reject duplicate inputs; `trustSelf`/`knownTxids` never waive admission | Receive: `Transaction.fromAtomicBEEF` parse only (LIB/receive.ts:99-108). SPV/script execution is left to `wallet.internalizeAction` (not verified in this audit). Overlay side: `spv.Verify` in engine.Submit (README script-rules section), conservation (layers C/D) | UP/ColorPermissionModule.ts:1020-1030 `assertCompletedTransaction` (assertUnlocks) | divergent-intended | Amounts are capped at 2^53-1 (`MaxSafeAmount`, GO/mandala/ownership.go:73-75; `Number(msg.amount)` receive.ts:119) while spec requires uint64 per output. The unsafe-amount incident is related. Under the BRC-207 alignment decision (uint64/output) this is a planned gap. |
| 20 | A.86 foreign destination is not a wallet credit; ownership needs remittance tuple matched against actual P2PKH hash | Receive credits exactly `msg.outputIndex` (receive.ts:109-122, 328) with no P2PKH-hash vs derived-key comparison | UP/ColorPermissionModule.ts `assertOwned` | gap (shares root cause with 15) | Application annotation can set ownership. |
| 21 | A.82 internalize a completed deploy authority (`assetId:"ISSUE"`) | Not applicable: Mandala deploys are created by the issuer's own wallet (LIB/issuerOps.ts:108) and never arrive as receipts. Receiving an authority output is not supported by `receiveTokens` (value only: `decodeValue`, receive.ts:113) | UP receipts handle both roles | divergent-intended | Consistent with "authority-only supply, holder I==O". |
| 22 | 0207:1425 "internalization MUST NOT silently submit an absent transaction" (A.79) vs Mandala offline settlement (recipient submits after COVER) | v1: no submit. v2 hand-over: recipient submits via `settle` after COVER passes (LIB/receive.ts:67-79, 358-379). The default settle also runs AFTER internalize | n/a | divergent-intended | Deliberate offline settlement design (memory: offline-token-settlement). Spec says higher-level flow submits before requesting receipt. Mark as an explicit, documented deviation; the submit is not "silent" (COVER evidence verified), but it is a different model. |
| 23 | 0207:1451-1490 wallet-created actions: submit to every involved token topic, record each topic's actual admission, per-topic crediting; failed overlay after on-chain success keeps pending/error state; retries idempotent (A.102) | Submit to every token topic of the tx with per-topic σI verification (LIB/overlay.ts:246-296), 'accepted'/'retryable' journal (:443-505), idempotent `/submit` (receive.ts:54-61 comment), reconcile sweeps | UP/ColorPermissionModule.ts:1879 | conform | Multi-asset admission "all topics must admit" is enforced for σ topics (overlay.ts:270-274). |
| 24 | 0207:1451-1466 pending admission visible but not spendable (A.117) on the send side | Journal 'accepted' entry carries σI and the tx stays unbroadcast-guarded until posted; wallet marks coins via settlement table (W/createRuntime.ts:1160-1230) | UP:779-781 | conform (not fully verified) | The wallet's balance rendering of pending coins was not audited. |
| 25 | 0207:772-775 admission of "valid token outputs regardless of carrier sats" and lookup answers include them | Lookup rows only written when an owner identity is proven (GO/mandala/token_lookup.go:251-261: no owner -> nothing written until the reconciler repairs) | n/a | gap (low) | Window where an admitted output is absent from the lookup answer. Cannot be both admitted and ownerless in practice (layer B requires linkage), but crash between admit and index leaves a hole until the reconcile pass. |
| 26 | 0207:789-822 / A.129 token discovery surface | `GET /admin/tokens?limit&skip` public with `hosted` flag; `ls_mandala` `{tokenId}`/`{list:true}` (GO/mandala/token_registry_lookup.go:18, 154-196); client `listTokens`/`resolveAssetMetadata` (LIB/metadata.ts:36-91) | UP:2194 | divergent-intended | Discovery is a registry service over one operator, not SLAP. Naming trap: `fetchRegistry` (LIB/registry.ts:207; W/createRuntime.ts:614) is the KYC identity registry (`tm_mandala_kyc`, bearer-gated `/admin/registry`), NOT the token registry. Token discovery is `/admin/tokens` + `ls_mandala`. |

## Prioritized gaps

P1 (safety-relevant, fix first)
1. Receipt credit without current per-asset membership (items 13/14): `receiveTokens` internalizes before any admitted-and-unspent check; σI is optional (LIB/receive.ts:98-150, 323-343, 356). Require either a verified σI for the received output or a live `/lookup` membership answer before `internalizeAction`; otherwise reject and leave the message pending. Depends on item 5.
2. Ownership/derivation and basket validation on receipt (items 15/20): verify the output's P2PKH matches the derived key and the basket matches the asset; adopt the strict spec instruction JSON with the `p color` baskets rename.
3. Fail-open when `OVERLAY_IDENTITY_KEY` is empty (LIB/overlay.ts:314-320): make it a hard failure for any admission-dependent path.

P2 (spec interop)
4. Implement `color-spendability` and `color-admission` query types on the per-asset lookup (token_lookup.go:118-431): `{type,version,assetId,topic,outpoints[]}`, output-list of matching outputs, plus a historical (spent-inclusive) variant. Add a lib `/lookup` client with source-byte matching (A.100).
5. Rename topics/lookups to `tm_color`, `tm_color_<txid>_<vout>`, `ls_color_<...>` across GO topics.go, wiring, lib brc162.ts/constants.ts, wallet (agreed; no back-compat).
6. Client-side pre-sign spendability check for every token input (item 3), instead of relying solely on submit-gate conservation.

P3 (decide / document)
7. 1-sat rule, 32-byte-only ids, vout-0-only deploys, no BRC-161 (item 9): Mandala is non-conforming as a color service on these points. Decide: either declare Mandala a restricted profile and not advertise as conforming, or relax. Related: uint64 amounts versus the 2^53-1 cap.
8. Offline hand-over: recipient submits (item 22) and the σI/COVER evidence model (item 18) need an explicit profile declaration.
9. Receipt hardening: structured idempotency check instead of error-regex (item 16), strict JSON member rejection (item 17), non-final tx screening (A.127), lookup-index hole after crash (item 25).

## Spec-ambiguity notes
- 0207:713-737 "user-accepted configuration" does not say whether a single operator-configured overlay URL plus identity key meets the baseline; this audit treats it as acceptable, subject to the fail-closed fix.
- 0207:739-761 specify no BRC-24 `service`-side versioning rule for unknown query keys; our `RequireLookupQuery` rejects unknown keys, which is reasonable but should be stated.
- Whether σI-signed admission counts as the "attested" profile replacement is not defined for Mandala.

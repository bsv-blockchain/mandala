# Mandala on BRC-162 (BSV-21 binary, authority supply) — design

- **Date:** 2026-10-01
- **Status:** draft for maintainer review
- **Branch:** mandala `feat/brc162`; ts-stack PR from a worktree off `origin/main`; bsv-wallet worktree off `master`
- **Invariant spec:** [`docs/design/brc-0162-bsv21-binary.pinned.md`](../../design/brc-0162-bsv21-binary.pinned.md) (verbatim, bsv-blockchain/BRCs @ `8f36bdf`)
- **Supersedes:** the MandalaToken / MandalaAdmin formats, `docs/design/2026-09-15-mandala-wire-contract-v2.md` (replaced by wire contract v3, §9 below; σI digest and the offline-settlement model carry over unchanged)

## 1. Goal

Rebuild the Mandala stablecoin platform on the BRC-162 token output format, in **authority supply** mode only. The token format change is small; the overlay rules stay close to today's. What changes:

1. Token and admin outputs share one on-chain layout: the BRC-162 prefix in front of a P2PKH lock.
2. Admin authority is an on-chain **authority output** (token id present, amount 0) that can split, combine and transfer. It replaces the linear, commitment-keyed P2PKH admin chain.
3. The admin action's commitment lives in the authority output's DAG-CBOR payload instead of being bound into a derived public key.
4. Identity enforcement (P2PKH + specificKeyLinkage) becomes a Mandala policy layer on top of generic, spec-faithful BRC-162 rules, in separate methods.
5. The identity registry becomes its own authority deployment, with no value outputs.
6. Both overlays re-base onto their latest upstream bases (ts-stack `infra/overlay-server` stack; go-overlay-services).

No one has used the app yet: this is a **clean break**. Old codecs, `txid.vout` asset ids, admin-chain machinery and wrappers that only existed for pinned-package bugs are deleted, not deprecated. No data migration.

### 1.1 Success criteria

- Every token output either side produces or admits conforms byte-for-byte to the pinned BRC-162 wire format.
- The generic BRC-162 rules module passes table tests that mirror every example in the spec's *Examples* section.
- TS and Go overlays agree byte-for-byte on scripts, payloads, commitments, verdict codes and reason strings, checked by shared conformance vectors (not by assumption).
- End-to-end on the local stack: deploy → issue → send (online and offline hand-over) → freeze → reissue → redeem → registry admit/revoke, with σI-based offline acceptance unchanged.
- Every adversarial case in §8.2 is rejected with the specified code on both engines.

### 1.2 Non-goals

- BRC-176 validity proofs. Offline acceptance stays "trust the issuer overlay's σI over a txid" (offline-settlement design, unchanged).
- BRC-161 (JSON) compatibility, 36-byte token ids, fixed-supply deploys.
- bigint amounts in lib, app or wallet (§3.4).
- Threshold/multisig authority locks and key rotation (still deferred, per stablecoin-mobile decision 1). The layered design keeps the door open: only layer B/C policy would change.
- Adopting go-overlay-services' opt-in admission storage path (separate future project, §7.2).
- Token-fee P3. It rebases onto this work afterwards; its decisions (`2026-09-22-mandala-token-fee-design.md`) are unchanged.

## 2. Decisions of record

Taken with the maintainer on 2026-10-01. Do not re-litigate.

| # | Decision | Note |
|---|---|---|
| D1 | Authority supply mode only | Spec §Supply models |
| D2 | 1-satoshi policy on every token output (deploy, authority, value) | Spec allows (§Satoshi value) |
| D3 | Every token output is BRC-162 prefix + P2PKH; owner proven by specificKeyLinkage | Mandala policy, not universal |
| D4 | Authority outputs are token outputs, so D3 applies; their identity must be in the **trusted-issuer set** | The trust anchor. Gates deploys, authority transfers and the registry |
| D5 | Non-authority transactions must conserve exactly: value in == value out (no holder implicit burn) | Stricter than spec |
| D6 | Codecs are uint64/bigint-capable; the overlay rejects any amount, per-tx sum or circulating supply above 2^53−1; lib/app/wallet stay on JS `number` | Stricter than spec |
| D7 | Generic BRC-162 codec in `@bsv/templates`; generic rules + Mandala policy topic managers in `@bsv/overlay-topics` (ts-stack PR) | Upstream `infra/overlay-server` stays a working reference |
| D8 | A transaction that spends an authority of token T must create at least one authority of T | Tx-local form of "never end the last authority"; no concurrency race |
| D9 | At most one authority output per token per transaction carries an action commitment | As today's "one verified admin output per asset per tx" |
| D10 | This lands before token-fee P3; P3 rebases onto it | |
| D11 | Admin action details travel off-chain as DAG-CBOR bytes; the payload carries only their SHA-256 | Maintainer: "the hash of administrative tasks … in that CBOR payload" |
| D12 | Offline validation = issuer σI over txid (no BRC-176) | Unchanged |
| D13 | Clean break, no migration | |

## 3. On-chain format

### 3.1 Every token output

Exactly the spec wire format, with a P2PKH remainder (D3), carrying exactly 1 satoshi (D2):

```
<push id32 | OP_0> <push amount | OP_0> OP_2DROP [<push DAG-CBOR> OP_DROP]
OP_DUP OP_HASH160 <push pkh20> OP_EQUALVERIFY OP_CHECKSIG
```

- **Token id on the wire:** 32 bytes, deploy txid in natural/internal byte order (spec §Token identification). A 36-byte id is *invalid for Mandala* (no BRC-161 tokens exist here).
- **Token id string:** `<txid>_0` (64 lowercase hex, display byte order, underscore). Used in every API, store, frame and UI. **Outpoints** stay `<txid>.<vout>`; they get their own helper. The lib's single `outpoint()` helper that served both is split (`tokenIdString` / `outpointString`) so the two can never be confused.
- **Amount:** minimally encoded script number per spec. The codec decodes the full 0…2^64−1 domain as `bigint`. The Mandala policy cap is in §3.4.
- **Payload:** optional per spec. When present it must be a strict DAG-CBOR map (§3.5) to carry Mandala attributes. A non-map or non-strict payload carries no attributes. On a deploy or a committed authority output that makes the transaction fail Mandala policy (§4.3); on any other output it is ignored.

### 3.2 Roles (authority supply only)

| Role | id | amount | Where | Payload (DAG-CBOR map) |
|---|---|---|---|---|
| **Deploy** (first authority) | `OP_0` | `OP_0` | vout 0 only | `{sym: text, dec: uint 0–18, label: text, feeRatePerKb?: uint \| null}` |
| **Authority** | id | `OP_0` | any | none, or `{adm: bytes(32)}` = action commitment |
| **Value** | id | > 0 | any | none (ignored if present) |

- A deploy with amount > 0 (fixed supply) is refused by Mandala policy (D1).
- The issuer is the deploy output's linked identity, never a payload field.
- `sym`, `dec` follow the spec's display fields. `label` and `feeRatePerKb` are Mandala keys (the spec ignores unknown keys). `feeRatePerKb` keeps the meaning shipped in token-fee P0/P1.
- `dec` outside 0–18 or a non-text `sym`/`label` makes the deploy fail Mandala policy (§4.3). The spec says malformed display fields do not invalidate a deploy; Mandala refuses them pre-broadcast so a stablecoin never ships with broken metadata.

### 3.3 Admin action details

Off-chain, as strict DAG-CBOR bytes (hex in the JSON envelope, §6.1). `commitment = SHA-256(details bytes)`; the committed authority output's payload is `{adm: commitment}`.

Keys and types (unknown keys → refuse; missing required key → refuse):

| `kind` (text) | Other keys | Supply delta rule (§3.6) |
|---|---|---|
| `issue` | `bankRef?: bytes(32)` | Δ > 0 |
| `redeem` | — | Δ < 0 |
| `reissue` | `outpoint: bytes(36)`, `recipient: bytes(33)` | Δ == frozen row amount |
| `pause`, `unpause` | — | Δ = 0 |
| `blockIdentity`, `unblockIdentity`, `allowIdentity`, `unallowIdentity` | `identityKey: bytes(33)` | Δ = 0 |
| `setAccessMode` | `mode: "denylist" \| "allowlist"` | Δ = 0 |
| `freezeOutput`, `unfreezeOutput` | `outpoint: bytes(36)` | Δ = 0 |
| `setFeeRate` | `feeRatePerKb: uint ≥ 1 \| null` | Δ = 0 |
| registry: `admitIdentity`, `revokeIdentity` | `identityKey: bytes(33)` | n/a (no value) |

All kinds also accept `reason?: text`. Keys are compressed SEC1 public keys; outpoints use the 36-byte sighash layout (txid natural order ‖ uint32 LE vout). Binary fields remove the hex-case normalization questions of today's JSON details.

Removed from today's details: `priorOutpoint` (authority spends are on-chain), `assetId` (the authority output carries the id), `amount` (derived from the transaction), `counterparty`, `issuer`. The `register` kind is gone: the deploy output *is* registration. `recover` stays gone.

An authority transaction with **no** committed output is a plain authority operation (split, combine, transfer to another trusted issuer) and must have Δ = 0.

### 3.4 Amount policy (D6)

The overlay rejects (`ERR_SHAPE`, §6.3) a transaction in which, for any token:
- any value output amount > 2^53−1, or
- the value-in or value-out sum > 2^53−1, or
- (authority tx with Δ > 0) circulating supply after admission > 2^53−1.

Overlay arithmetic is `bigint` on both engines. The lib asserts `Number.isSafeInteger` on every amount it parses, builds, sums or receives. This closes the 2026-09-21 unsafe-amount class.

### 3.5 DAG-CBOR strictness

Readers must decode strictly per the DAG-CBOR spec. Neither chosen library is strict on its own (probe, 2026-10-01), so both engines use the same rule:

> `strictDecode(bytes)`: decode, re-encode canonically, and require the re-encoding to equal the input byte-for-byte. Anything else is "not a valid DAG-CBOR map".

- TS: `@ipld/dag-cbor` (10.x; ESM-only, no Node builtins; Metro 0.84 resolves the `import` condition from ESM imports).
- Go: `github.com/fxamacker/cbor/v2` v2.9.4 with decode options `DupMapKeyEnforcedAPF`, `IndefLengthForbidden`, `TagsForbidden`, `NaNDecodeForbidden`, `InfDecodeForbidden`, `IntDecConvertSignedOrBigInt`, `DefaultMapType: map[string]any`, and encode options `CoreDetEncOptions()` + `SortLengthFirst`, `ShortestFloatNone`, `NaNConvertNone`, `InfConvertNone`.
- Probe-verified: both reject indefinite lengths, duplicate keys, non-minimal ints, unsorted / wrong length-first keys, integer keys, tags, `undefined`, NaN/Infinity, float16/32 and trailing bytes, and both encode `{"sym":"USD","dec":2}` as `a263646563026373796d63555344`. Shared vectors pin this (§8.3).

### 3.6 Supply delta

For an authority transaction of token T: `Δ = Σ value-out(T) − Σ value-in(T)`, over admitted value inputs and all value outputs of T.

- Spec semantics: with an authority input, value outputs need no input coverage (mint), and any shortfall is burned. Mandala narrows this with the per-kind rules in §3.3.
- A non-authority transaction must have Δ = 0 for every token (D5).

## 4. Validation architecture

Four layers, each a separate module with its own tests. They run in order; the first refusal rejects the whole transaction. The same split exists file-for-file in Go.

### 4.1 Layer A — generic BRC-162 rules (`overlay-topics/src/bsv21/`)

Spec-faithful. No Mandala knowledge, so any future BRC-162 topic can reuse it.

- `classifyOutput(script)` → `{role, id?, amount, payload?, rest}` or `notToken`, applying the spec's decoding rules exactly. That includes the payload rule ("a single push followed by `OP_DROP`") and the role table.
- `tokenShaped(script)`: true when the script begins with two push operations followed by `OP_2DROP`. Layer B uses it to turn "token-shaped but invalid" (bad id length, non-minimal or out-of-range amount, 36-byte id with vout 0) into a rejection instead of a silent skip.
- `ledger(tx, admittedInputs)` → per token id `{deploy?, authorityIn[], authorityOut[], valueIn, valueOut}`, with spec validity:
  - deploy valid only at vout 0 (token id = `<txid>_0`);
  - authority output valid iff the tx spends an admitted authority of the same id;
  - value outputs valid iff an authority input is present, or `I ≥ O` (all-or-nothing).
- Output: the ledger plus spec verdicts. Layer A never throws for spec-invalid outputs. It reports them, and the Mandala layers decide.

### 4.2 Layer B — Mandala ownership policy (`overlay-topics/src/mandala/ownership.ts`)

Identity checks, kept separate from layer A as the maintainer asked:

- `requireAllTokenOutputsValid`: any `tokenShaped` output that layer A does not classify as a valid role → `ERR_SHAPE`.
- `requireP2pkhRemainder`: the remainder is exactly the 5-op P2PKH → else `ERR_SHAPE`.
- `requireOneSat` → `ERR_SATOSHIS`.
- `requireSafeAmounts` (§3.4) → `ERR_SHAPE`.
- `verifyOutputLinkage`: each token output needs a linkage at its index whose derived pkh equals the remainder's pkh → identity. Missing or mismatched → `ERR_LINKAGE`. This is the reject-not-skip rule, generalized to every role.
- `resolveInputOwner`: the owner of a spent token input is the stored row (`mandalaTokens` / `mandalaAuthorities`), which must exist and match id, role and amount. An input linkage, when present, must corroborate it (prover + L·G == source pkh, prover == stored owner) → else `ERR_LINKAGE`. This adopts the Go model on both engines (closes the TS/Go gap found 2026-10-01; prerequisite of blinded A′, stablecoin-mobile decision 2).

### 4.3 Layer C — Mandala authority policy (`overlay-topics/src/mandala/authority.ts`)

Everything below fails with `ERR_AUTHORITY` unless noted:

1. **Trusted identities (D4).** Every deploy and authority output's linked identity, and its linkage `prover`, is in the trusted-issuer set (→ `ERR_UNTRUSTED`, retryable, never persisted, §6.3).
2. **Deploy signature (§5.3).** A deploy needs a valid issuer `deploySig` over its txid.
3. **No fixed supply.** A deploy with amount > 0 is refused.
4. **Continuity (D8).** For each token T with ≥1 authority input, the tx creates ≥1 authority output of T.
5. **One action (D9).** At most one authority output of T carries a payload with `adm`. The committed output needs exactly one `admin[]` entry at its index, whose `strictDecode`d details hash to `adm` and pass the §3.3 schema (schema failures → `ERR_SHAPE`).
6. **Orphan details.** An `admin[]` entry at an index that is not a committed authority output is refused (`ERR_SHAPE`).
7. **Delta rules.** Δ per §3.3 for the committed kind, or Δ = 0 if none (→ `ERR_CONSERVATION`). A non-authority tx needs Δ = 0 for every token (D5, → `ERR_CONSERVATION`). A value output of T in a tx with no admitted authority or value input of T → `ERR_CONSERVATION`.
8. **Reissue.** The target outpoint is in `frozenOutpoints`; Δ equals the frozen row's amount; there are zero value inputs of T; every value output of T is owned by `recipient` (→ `ERR_SHAPE`).
9. **Deploy payload.** It is a strict map with `sym`, `dec`, `label` well-typed (→ `ERR_SHAPE`).

### 4.4 Layer D — controls (unchanged semantics)

Per token touched: frozen/evicted input (`ERR_FROZEN`), paused and not an admin tx of T (`ERR_PAUSED`), access mode for non-admin txs (`ERR_ACCESS`), sanctions over all identities incl. authority owners (`ERR_SANCTIONED`), registry membership (`ERR_MEMBERSHIP`).

"Admin tx of T" = the tx spends an admitted authority of T. That is verifiable on-chain, never self-declared. Issuer exemptions (access mode, membership) come from the trusted-issuer set plus the overlay identity key. They are no longer read from asset state, which removes the "anyone who registers an asset is a globally exempt issuer" hole.

### 4.5 Order and outcome

Repo-local pre-checks (conflicting spend, fuel when P3 lands) → layer A → B → C → D. Then admit every token output of the tx (`outputsToAdmit`, ascending) and sign σI. Rejections are typed throws (§6.3). Whole-tx rejection instead of the spec's "outputs invalid, inputs burned" is deliberate: under overlay-first nothing is broadcast, so there is nothing to burn.

## 5. Trust anchor details

### 5.1 Trusted-issuer set

Overlay configuration `MANDALA_ISSUER_KEYS`: a JSON array of compressed identity public keys (TS env and Go env, same parsing; empty → boot fails when Mandala is enabled).

The overlay no longer holds any issuer private key, and the commitment-keyed admin derivation is deleted. (Today both engines use `SERVER_PRIVATE_KEY` for σI, linkage decryption *and* admin derivation, so the overlay was implicitly the issuer. `MANDALA_ISSUER_KEYS` makes the set explicit.)

**Single overlay key (documented divergence from upstream).** Upstream `securityConfig` requires independent server, verifier and admin keys. Mandala keeps one overlay identity key (`SERVER_PRIVATE_KEY`) for both σI signing and linkage decryption, because lib and wallet reveal linkage to, and verify σI against, the one configured overlay key per chain (stablecoin-mobile decision 6). P0 adopts upstream's parsing style but not the three-key split. Upstream's `MANDALA_ADMIN_PRIVATE_KEY` / `MANDALA_VERIFIER_PRIVATE_KEY` are not used.

### 5.1a Key derivation for all token outputs

Every token output (deploy, authority, value) derives under `FT_PROTOCOL` `[2,'mandala token']` with a per-output unique keyID. Authority and deploy outputs lock to the issuer itself (`counterparty` = issuer identity key hex, never the literal `'self'`). Blinded recipient outputs keep the pkh-only path. One protocol for all roles means `lib/src/unlock.ts` (`walletMandalaUnlock`, which hard-codes `FT_PROTOCOL`) stays unchanged and signs every role. `ADMIN_PROTOCOL` and `REGISTRY_PROTOCOL` are deleted. Registry outputs also use `FT_PROTOCOL`; the topic, not the key, separates them.

### 5.2 Why linkage identity is enough for authority outputs

Linkage decryption uses the ECDH key between the overlay and `linkage.prover` with AES-GCM, so a linkage decrypts only if the prover really produced it. Requiring `prover ∈ trusted` therefore authenticates the issuer for every authority output it creates. Authority *spends* are already authenticated: the input script must verify (SPV) against a key only the authority's owner holds, and continuity requires an admitted authority input.

### 5.3 Deploy replay gap and the deploy signature

A deploy has no authority input. Someone who saw an issuer's earlier linkage could rebuild a deploy locked to the same pkh, reusing that linkage. The prover check would still pass. The rogue token would only be spendable by the issuer, but it could spoof metadata ("USD") under the issuer's name.

Fix: the off-chain envelope carries `deploySig`, an issuer signature over `"mandala-deploy:" + txid` (wallet `createSignature`, protocol `[2, 'mandala deploy']`, keyID `'1'`, counterparty `'anyone'`). The overlay verifies it against the deploy output's linked identity. The txid is known after `signAction(noSend)`, before submit, so no circularity, and a txid is unique so it cannot be replayed. Applies to the registry deploy too.

### 5.4 Registry

`tm_mandala_registry` uses layers A–C with:
- value outputs forbidden (→ `ERR_SHAPE`);
- kinds limited to `admitIdentity` / `revokeIdentity`;
- first trusted deploy wins; a second registry deploy → `ERR_SHAPE` (`registration chain already exists`, as today).

Membership semantics are unchanged.

## 6. Wire contract v3 (overlay ↔ lib ↔ wallet)

Supersedes v2. Unchanged from v2: §1 admission digest, §3 `GET /admin/admission/:txid`, §4 admission record, §5 eviction, §7 conflicting spend, the v2.1 amendments 9.1–9.5, 9.7–9.12, and v2.2 (fees, rebased in P3). The changes:

### 6.1 Off-chain values envelope (UTF-8 JSON)

```json
{
  "inputs":  [{ "index": 0, "linkage": { /* SpecificLinkage, as today */ } }],
  "outputs": [{ "index": 0, "linkage": { } }],
  "admin":   [{ "index": 1, "details": "<hex DAG-CBOR>" }],
  "deploySig": "<DER hex>"
}
```

- Indices are unique, non-negative safe integers.
- Every token output (all roles) needs an `outputs` entry.
- `deploySig` is present iff output 0 is a deploy.

### 6.2 Identifiers

- Token id `<txid>_0` everywhere: routes, query keys, MessageBox body (`assetId` field renamed `tokenId`), bundles, journals, SQLite.
- Outpoints stay `<txid>.<vout>`.

### 6.2a COVER walk (replaces v2 §8 / FIX K wording)

The `cover()` walk follows every input whose source output decodes as a valid BRC-162 token output of the bundle's `tokenId`, in **either role (value or authority)**. Issue/reissue/redeem txs spend authority inputs, and σI covers every admitted output of a tx. Non-token inputs (fees) are not walked.

### 6.3 Verdicts

- Topic managers throw `MandalaReject { code, reason }`. The repo-local side channel captures the object and the verdict uses `.code` directly. The substring `REASON_TABLE` is deleted on both engines.
- Codes: v2 set plus two new codes. Content-deterministic refusals are final; refusals that depend on operator configuration are not, so that a config change can lift them (same principle as `ERR_INPUT_SPENT` / `ERR_MEMBERSHIP`).

| code | HTTP | retryable | persisted | when |
|---|---|---|---|---|
| `ERR_AUTHORITY` | 400 | false | yes | missing or invalid `deploySig`, continuity break, duplicate commitment, fixed-supply deploy, authority output without an admitted authority input |
| `ERR_UNTRUSTED` | 409 | true | **never** | a deploy/authority output identity or linkage prover is not in `MANDALA_ISSUER_KEYS` |
- Reason strings are pinned in the conformance vectors and byte-identical TS ≡ Go. The v2 §6 string becomes `output <idx>: token output with no verified linkage`.

### 6.4 Guard order (replaces v2 §9.6)

Conflicting spend → (fuel, P3) → layer A → B → C → D.

### 6.5 Routes

| v2 | v3 |
|---|---|
| `GET /admin/asset-auth/:assetId` (head + `authDetails`) | `GET /admin/authorities/:tokenId` → `{tokenId, authorities: [{outpoint, identityKey, height?}]}`, unspent only |
| `GET /admin/asset-auth/beef/:txid` | `GET /admin/authorities/beef/:txid?vout=` |
| `/admin/asset-state/:assetId`, `/admin/admin-history[-page]/:assetId`, `/admin/admin-summary/:assetId`, `/admin/activity?assetId=` | same, keyed by `tokenId`. History rows carry `{txid, outputIndex, kind, detailsHex, commitment, delta, height, offset, admitSeq}`. Summary sums Δ (`totalIssued` = Σ positive, `totalRedeemed` = Σ |negative|) |
| lookup `{metadataAssetId}` | lookup `{metadataTokenId}` |

## 7. Overlay re-base onto upstream

### 7.1 TS (`overlay/`) — base is ts-stack `infra/overlay-server`

- **Bump:** `@bsv/overlay` 2.6.2, `@bsv/overlay-express` 2.7.3, `@bsv/sdk` 2.8.11 (later `@bsv/overlay-topics`/`@bsv/templates` to the new PR versions); Node 24.
- **Adopt from upstream:**
  - `securityConfig.ts` style (strict env parsing; `MANDALA_ISSUER_KEYS` replaces the admin private key);
  - `configureEngineParams({throwOnBroadcastFailure: true})`, `configureHealth`, `lifecycle.ts`, `logger.ts`;
  - `allowPrivateHosts: true` for local Arcade/Chaintracks; chaintracks prefix `/chaintracks/v2`; ≥32-char callback/admin tokens with constant-time compare.
- **Keep (still needed on 2.6.2):**
  - verdict side channel (Engine.submit still swallows manager throws);
  - verdict persistence and σI / admission record / `/admin/admission`;
  - pre-broadcast conflicting-spend guard (upstream's CAS fires after broadcast);
  - eviction restore (upstream `/arc-ingest` evicts but never restores inputs or rebuilds state);
  - activity, admin auth/CORS.
- **Delete:**
  - `tokenLinkageGuard.ts`, `adminChainGuard.ts` (rules now in the package);
  - `pinnedReducer.ts` (reducer exported);
  - `feeRates.ts` (fee rate folded by the package reducer);
  - the CAS monkeypatch (upstream KnexStorage CAS);
  - the token-less `/arc-ingest` stub (upstream fails closed);
  - `registry.ts` (topic moves to the package).

### 7.2 Go (`overlay-go/`) — base is go-overlay-services

- **Bump:** go-overlay-services v1.3.7, go-sdk v1.7.1, Go 1.26 (verified: build, vet and tests green with no code changes); Dockerfile and CI.
- **Test:** add a test pinning the go-sdk interpreter's after-Chronicle default on the script-verify path.
- **Keep:**
  - the engine compensation seam (v1.3.7 still marks spends before broadcast; `ErrorOnBroadcastFailure` still dead);
  - `EvictTx` (no upstream eviction API);
  - custom `httpapi` (upstream still drops off-chain values);
  - `enginestore`, `arcade`.
- **Upstream status:** the repo is archived, moving to the experimental go-stack monorepo. Pin the published tag. The opt-in admission-storage path (broadcast-first atomic commit) is a separate future project: it needs a replica set, a lookup-outbox worker and an eviction plan.

## 8. Testing

### 8.1 Per layer

- Layer A table tests restate every example in the spec's *Examples* section, plus the role table, deploy-not-at-vout-0, the payload rule edge cases (`<push> OP_DROP` remainder, `OP_1NEGATE`/`OP_n` payloads), the binary-wins rule, non-minimal amounts, the 2^64 boundary, and 36-byte ids including vout 0.
- Layers B–D: unit tests per method; existing control-gate suites ported.

### 8.2 Adversarial (both engines, exact code)

- Forged authority: an authority output without an authority input; an authority input that was never admitted.
- Untrusted deploy; untrusted authority transfer target; forged linkage prover; replayed linkage on a deploy without `deploySig`; `deploySig` over a different txid.
- Unlabelled mint (authority input, Δ > 0, no commitment); issue with Δ ≤ 0; redeem with Δ ≥ 0.
- Holder implicit burn (I > O, no authority); holder over-spend (O > I).
- Continuity break (spend authority, no authority output); two committed outputs for one token; orphan `admin[]` entry; commitment mismatch; non-strict CBOR details (unsorted keys, float, tag).
- Fixed-supply deploy; deploy at vout ≠ 0; 36-byte id; non-minimal amount; amount > 2^53−1; sum overflow; non-P2PKH remainder; 2-sat output; token-shaped garbage output.
- Reissue: of an unfrozen outpoint, with a wrong amount, with value inputs, to the wrong recipient.
- Registry: value output; second deploy.

### 8.3 Conformance vectors

ts-stack generates one JSON file from the published package code. It covers scripts per role, payload bytes, details bytes and commitments, linkage, `deploySig` digests, strict-CBOR accept/reject cases, and every reject `{code, reason}`. It is copied to `overlay-go/testdata/vectors.json`; the Go tests read it. Regenerating it is a script, not hand edits.

### 8.4 End to end

Local docker stack (TS :8080, Go :8081, shared Mongo): the §1.1 flow against each engine, including an offline hand-over chain of depth ≥ 2 settled via COVER.

### 8.5 Stability review

Every lib flow (deploy, issue, redeem, admin action, authority split/transfer, send, receive, hand-over) gets the stability-mandate pass: crash at every await, double click, second tab, stale cache, overlay/wallet divergence.

## 9. Component changes and phasing

Each phase gets its own implementation plan (writing-plans). Phases land in order; P0 is deliberately format-neutral.

### P0 — Upstream re-base (old format, mandala `feat/brc162`)

The §7 bumps and adoptions, done as separate commits with full suites green, before any format change. That way upstream behaviour changes are never confused with format changes.

### P1 — ts-stack PR (worktree off `origin/main`; maintainer merges, tags, publishes)

- **`@bsv/templates`:**
  - `Bsv21Binary` codec: `encode/decode` prefix + optional payload, role helpers, bigint amounts, `lock(id, amount, pkh, payload?)` pkh-only entry (needed by the blinded recipient path), `lockBRC29(...)`, `tokenIdString/parse`, `dagCborStrict` wrapper.
  - The name avoids the existing JSON `Bsv21Token`.
  - Delete `MandalaToken`, `MandalaAdmin`, `mandala-encoding` (keep `createMinimallyEncodedScriptChunk` / `decodeScriptNumChunk` for `MultiPushDrop` / `P2MSKH`).
  - Update `browser-budget.json`, `pack:check` exports, governance mutation targets.
- **`@bsv/overlay-topics`:**
  - `bsv21/` (layer A); rewritten `mandala/` (layers B–D, lookup, storage incl. `mandalaAuthorities`, reducer with fee rate, typed rejects); `mandala-registry/` topic + lookup (moved from the mandala repo).
  - Export the reducer and the reject type.
  - Delete the old mandala sources and tests.
- **`infra/overlay-server`:** Mandala wiring → `MANDALA_ISSUER_KEYS`, registry topic; docs, README, release notes, `pnpm docs:facts`.
- **Conformance vectors generator** (§8.3).
- **Supersedes open PRs** bsv-blockchain/ts-stack#535 (1.7.3 unlinked-token reject) and bsv-blockchain/ts-stack#584 (reducer export). Both touch files this PR deletes. Whether to close or merge-then-rebase them is the maintainer's call.
- Until publish, mandala consumes the packages as packed tarballs (`file:` to a vendored `.tgz`, like the wallet does with the lib).

### P2 — TS overlay

Consume the new packages; §7.1 deletions; side channel reads `.code`; v3 routes; `MANDALA_ISSUER_KEYS` config.

### P3 — Go overlay

Port layers A–D + registry file-for-file (`internal/bsv21`, `internal/mandala`); strict CBOR wrapper; `mandalaAuthorities`; v3 routes and verdicts; vectors parity. Delete `token.go`/`admin.go`/`adminwallet.go` commitment code.

### P4 — lib (`@bsv/mandala`)

- **Helpers:** tokenId/outpoint helpers.
- **Issuer flows:**
  - `deploy` (replaces register: vout 0, payload, `deploySig`, `randomizeOutputs:false`);
  - `issue` / `redeem`, and `submitAdminAction` / `submitGlobalAdminAction` building `{adm}` payloads and DAG-CBOR details;
  - authority selection from the wallet basket, cross-checked against `/admin/authorities`;
  - `splitAuthority` / `transferAuthority` (byte-unique scripts via unique keyIDs, for `matchOutputIndices`).
- **Deleted machinery:** `adminCustomInstructions.authDetails`, `recoverAdminAuth` head recovery, `reconstructRegistryDetails`, commitment-keyed registry locks. Authority recovery becomes "internalize unspent authorities listed by the overlay".
- **Data:** metadata read from the deploy payload; `Number.isSafeInteger` guards on every amount path; MessageBox body `tokenId`; bundle/COVER decode via the codec.
- **Kept as is:** `unlock.ts` (P2PKH over the full source script).

### P5 — app

`useHolderData`, `AlertBanners` (codec decode); `RegulatoryControls` builds typed details; register UI → deploy; audit log/CSV shows `kind`, `delta`, `commitment`, decoded details.

### P6 — bsv-wallet (worktree off `master`)

- **Code:** every `MandalaToken` import site; `session.ts` and `parsePeerPayURI.ts` id regex → `^[0-9a-f]{64}_0$`; `canonicalOutpoint` stays `txid.vout`; `tokenFormat.ts` docstring; permission module decode (payload-aware); demo ledger ids.
- **Lib:** re-vendor the lib (`scripts/sync-mandala.sh`).
- **Checks:** Hermes BigInt smoke; `proofBar.railIsolation` still rejects the Vault R1C lock.
- Frame stays v5 (`assetId` is a length-prefixed string; only the validation regex changes).

### P7 — docs

Wire contract v3 file (§6 made standalone), PROJECT-STATE refresh, runbook env changes (`MANDALA_ISSUER_KEYS`), memory update. Then token-fee P3 rebases.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Strict-CBOR divergence TS vs Go | Same re-encode rule on both engines; shared accept/reject vectors |
| ESM-only CBOR libs in RN/Jest | Metro resolves the `import` condition; add to wallet Jest `transformIgnorePatterns`; P6 smoke on device |
| ts-stack publish cycle blocks P2+ | Tarball consumption until publish; P1 PR kept self-contained |
| Upstream overlay 2.6.2 behaviour shifts (submit serialization, CAS errors) | P0 isolates the bump; double-spend e2e checks the CAS error maps to the conflicting-spend path |
| Fold ordering with concurrent authority branches | Unchanged (height, offset, admitSeq) last-write-wins; continuity is tx-local so no state race |
| Spec-faithful readers disagree with Mandala on I > O and payload-commitment txs | Documented as policy (§2, §4.5); Mandala never broadcasts such txs |

# Mandala token topics — design

Status: approved in conversation 2026-10-05, pending written-spec review.
Builds on: [`2026-10-01-mandala-brc162-design.md`](2026-10-01-mandala-brc162-design.md) (BRC-162 v3). Everything there stands unless this document says otherwise.

## 1. Intent

Other overlay operators must be able to choose which Mandala tokens they host and sync. Today every token lives in one topic, `tm_mandala`, so an operator hosts all or nothing.

The new layout:

- `tm_mandala` is the **token registry**. It admits deploys only, so anyone can learn which tokens exist.
- `tm_<deployTxid>` is a **per-token topic**. It holds one token's authority and value outputs. Operators advertise (SHIP/SLAP) and sync (GASP) only the token topics they choose.
- `tm_mandala_kyc` is the identity (KYC) registry, renamed from `tm_mandala_registry`.

Success: an operator with an allowlist of one token syncs the registry and that one token from a peer, and nothing else. A deploy, an issue, a transfer and a two-token transfer all work through one overlay that follows every token.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| T1 | Three topic kinds: `tm_mandala` (deploys), `tm_mandala_kyc` (identity registry), `tm_<deployTxid>` (one per token). Lookups mirror them: `ls_mandala`, `ls_mandala_kyc`, `ls_<deployTxid>`. | Per-token hosting and sync for other operators. |
| T2 | Token topic name = `tm_` + the deploy txid, 64 lowercase hex, with no `_0` suffix. | Every BRC-162 token id ends in `_0`, so the suffix carries no information. |
| T3 | Widen BRC-87 upstream: names `^(?=.{1,150}$)(?:tm_\|ls_)[a-z0-9]+(?:_[a-z0-9]+)*$`. | `tm_<64hex>` is 67 characters and contains digits; the current rule allows 50 characters of `a-z` only. 150 gives about twice the headroom needed. Every name valid today stays valid. |
| T4 | An operator follows the registry by default, with an optional allowlist (`MANDALA_TOKEN_ALLOWLIST`, a JSON array of deploy txids). | Our overlay follows everything. A third party narrows to the tokens it cares about. |
| T5 | A deploy is one submit naming both `tm_mandala` and `tm_<own txid>`. The host registers the token topic before calling the engine. | Atomic: one transaction, one broadcast. The first issue spends the deploy output, so that output must already be in the token topic. |
| T6 | `@bsv/overlay-topics` ships the change as 2.1 (2.0.0 is already published). | User decision. It is strictly a breaking change to what `tm_mandala` admits. |
| T7 | Registry deploy records are permanent. The `ls_mandala` spend handler keeps them. | The first issue spends the deploy output. A registry listing only unspent outputs would forget the token. |
| T8 | Go overlay (`overlay-go/`) is the stack. The TS overlay is the parity reference only. | User decision 2026-10-03. |

## 3. Topics

| Topic | Lookup | Admits | On spend |
|---|---|---|---|
| `tm_mandala` | `ls_mandala` | Deploy outputs only: vout 0, empty id, amount 0, valid deploySig, trusted issuer. Every other output is ignored, which is not a refusal. | The record stays. `ls_mandala` lists every token ever deployed. |
| `tm_mandala_kyc` | `ls_mandala_kyc` | Today's identity registry, unchanged apart from the name. | Unchanged. |
| `tm_<deployTxid>` | `ls_<deployTxid>` | Everything for that one token: its deploy output (the first authority), authority outputs and value outputs. All rules of the BRC-162 design apply (layers A–D, conservation, owner journal, §4.2a repair, maintenance). | Unchanged. |

Rules:

- A transaction that moves several tokens names every token topic it touches. Each token manager considers only the inputs and outputs of its own token. It admits only those outputs and checks conservation for its own token only. An output of another token is not admitted there, and that is not a refusal.
- A deploy names `tm_mandala` and `tm_<own txid>`. Both managers run the same deploy checks (layer A shape, deploySig, trusted issuer), so they admit or refuse together.
- Membership (the KYC gate) is read from `tm_mandala_kyc` for every token topic, exactly as it is read from `tm_mandala_registry` today.

## 4. Package: `@bsv/overlay-topics` 2.1 (ts-stack PR)

- `MandalaRegistryTopicManager` for `tm_mandala`. It runs layer A deploy rules plus the deploySig and trusted-issuer checks, admits deploy outputs only, and writes the deploy metadata. It has a matching registry lookup whose records are permanent (T7). The lookup returns `{ tokenId, sym, dec, label, issuer, deployTxid }` per token.
- `MandalaTokenTopicManager` is today's `MandalaTopicManager` bound to one token id. A factory `createMandalaTokenTopic(tokenId, deps)` returns `{ topicName, lookupName, manager, lookupFactory }` for that token. Inputs and outputs of other tokens are invisible to it.
- One shared `MandalaStorageManager`. The existing `topic` field on rows and on the journal now holds `tm_<txid>`. The existing `(topic, tokenId)` indexes already cover this; no new indexes.
- Rename `tm_mandala_registry` → `tm_mandala_kyc` and `ls_mandala_registry` → `ls_mandala_kyc`, with the `REGISTRY_*` constants renamed to match (`KYC_TOPIC`, `KYC_LOOKUP`). Behaviour is unchanged.
- Helpers: `tokenTopic(tokenId)`, `tokenLookup(tokenId)`, `isTokenTopic(name)`, `tokenIdOfTopic(name)`. `tokenIdOfTopic('tm_' + txid)` returns `txid + '_0'`. Names that are not exactly `tm_` + 64 lowercase hex return `null`.
- Vectors regenerated for the new topic names.

## 5. BRC-87 widening (separate ts-stack PR)

Today the same regex is copied in four places:

| File | Effect |
|---|---|
| `packages/sdk/src/overlay-tools/SHIPBroadcaster.ts:171` | The client refuses to broadcast to a non-conforming topic. |
| `packages/sdk/src/overlay-tools/OverlayAdminTokenTemplate.ts:32-33` | SHIP/SLAP advertisement tokens cannot be built. |
| `packages/overlays/overlay/src/DiscoveryAdvertisementValidation.ts:21-22` | The engine rejects discovery ads when validating them. |
| `packages/overlays/overlay-discovery-services/src/utils/isValidTopicOrServiceName.ts:7` | The shared check used by `SHIPLookupService.ts:110`, `SLAPLookupService.ts:113`, `WalletAdvertiser.ts:192,481` and `isAdmissibleDiscoveryOutput.ts:35`. The last one is the check every peer's SHIP/SLAP topic manager runs. |

Change:

1. Export one constant and predicate from `@bsv/sdk` (`BRC87_NAME_RE`, `isValidOverlayName`), using the T3 regex. Replace all four copies with imports of it.
2. Update `isValidTopicOrServiceName.test.ts` and add property tests: `tm_`/`ls_` + 64 hex accepted, length over 150 rejected, every previously valid name accepted.
3. Update `SHIPTopic.docs.ts:34` and `SLAPTopic.docs.ts:29,53`.
4. Open a matching text change to BRC-87 in the bsv-blockchain/BRCs repo.

Go needs no change. Neither go-sdk v1.7.1 nor go-overlay-services v1.3.7 validates names.

Rollout limit: until an operator upgrades, their hosts refuse our token-topic ads. Registry and KYC ads are unaffected.

## 6. Host wiring (Go overlay)

Facts about go-overlay-services v1.3.7 (`pkg/core/engine/engine.go`):

- `RegisterTopicManager` (`:212`) and `RegisterLookupService` (`:242`) are thread-safe, guarded by `mu sync.RWMutex`.
- `Submit` fails the whole transaction with `ErrUnknownTopic` if any named topic is not registered (`:401-414`).
- `SyncAdvertisements` (`:900`) creates SHIP/SLAP ads for the managers registered when it is called, and revokes ads for any that are not.
- `SyncConfiguration` is a plain map with no lock. `StartGASPSync` (`:988`) reads it.

### 6.1 `TokenTopics` registrar (`internal/wiring`)

The only place token topics come into existence.

- `Ensure(tokenId) (registered bool, err error)`:
  1. If `tm_<id>` is already registered, return `true`.
  2. If an allowlist is set and does not contain the id, return `false`.
  3. Build the manager and lookup from the package-equivalent factory on the shared storage.
  4. `RegisterTopicManager(tm_<id>)`, `RegisterLookupService(ls_<id>)`.
  5. Set `SyncConfiguration[tm_<id>]` to SHIP-discovered peers.
  6. Schedule one `SyncAdvertisements` (coalesced).
- All `Ensure` calls and every `SyncConfiguration` write are serialised by one registrar mutex. GASP sync runs from the registrar's snapshot, never by iterating the live map.
- `Ensure` is idempotent. Registration is in memory only; boot rebuilds it (6.2).

### 6.2 When `Ensure` runs

1. **Boot**, before listening and before the owner-index boot run. Ensure every token in the union of:
   - deploy records in `ls_mandala`;
   - distinct `tm_<id>` topics in the `mandalaOwners` journal. This covers a token whose registry record write failed after the token topic admitted its outputs.
2. **Deploy submit.** The `/submit` handler checks the named topics. If they include `tm_mandala` and a `tm_<hex>` whose hex is this transaction's own txid, it calls `Ensure(hex)` before `engine.Submit`.
   - It never lazily registers any other unknown topic. Those reach the engine and answer `ErrUnknownTopic`.
   - If both managers refuse the deploy, the empty topic stays registered until the next restart, which only registers recorded tokens.
3. **Registry admission by GASP.** When `tm_mandala` admits a deploy synced from a peer, the registry lookup's admit hook calls `Ensure`. A follower discovers new tokens through the registry alone.

### 6.3 Allowlist

`MANDALA_TOKEN_ALLOWLIST`: optional JSON array of deploy txids (64 lowercase hex, unique). It is parsed at boot, and an invalid value fails boot.

- Unset: follow every token the registry admits.
- Set: only these tokens are registered, advertised and synced. A submit naming any other token topic answers `ErrUnknownTopic`.
- Narrowing between restarts: removed tokens are not registered, and the next `SyncAdvertisements` revokes their ads. Their stored rows stay unused, and come back into use if the token is re-added.

### 6.4 Advertising and sync

- SHIP/SLAP ads: `tm_mandala`, `tm_mandala_kyc`, and every registered `tm_<id>` / `ls_<id>`.
- GASP: `tm_mandala` and `tm_mandala_kyc` sync as today. Each `tm_<id>` syncs from SHIP-discovered peers hosting the same topic.
- A peer still on the old BRC-87 rule refuses our token ads. The registrar logs that once per topic. Readiness is unaffected.
- Each operator's own `MANDALA_ISSUER_KEYS` decides which synced deploys its registry admits, and so which tokens it can host.

### 6.5 Maintenance and eviction

- The owner-index pass (refold under the submit gate, reconcile under the reconcile lock, per the P2 design) iterates every registered token topic plus `tm_mandala_kyc`.
- Eviction restores inputs and refolds per topic, using the journal's `topic` field.

### 6.6 Admin routes

The v3 URLs are unchanged (`/admin/authorities/:tokenId`, `/admin/asset-state/:tokenId` and the rest). The host maps `tokenId` to `tm_<txid>` internally. A token that is not registered on this host answers 404 `token not hosted`.

New route `GET /admin/tokens`: the registry list from `ls_mandala`, each entry with a `hosted` flag.

## 7. TS overlay (parity reference)

The same registrar over `server.engine.managers` / `lookupServices`, which are plain objects in `@bsv/overlay` 2.6.2, with the same boot union and deploy-submit rule. It is kept only to compare wire behaviour with the Go overlay, and it is lower priority than Go.

## 8. Lib and wallet (folded into P4 / P6)

- **Topics** are computed from the transaction. Callers never pass topic strings.
  - Deploy: `['tm_mandala', tm_<own txid>]`.
  - Other token transactions: one `tm_<id>` per distinct token among the outputs and token inputs.
  - KYC actions: `['tm_mandala_kyc']`.
- **Lookups.** The token list comes from `ls_mandala`. Holdings, authorities and history come from `ls_<id>`. KYC comes from `ls_mandala_kyc`.
- **Host discovery.** Use the SDK SLAP/SHIP resolvers for `ls_<id>` / `tm_<id>`, falling back to the configured overlay URL. This needs a wallet `@bsv/sdk` that includes the BRC-87 widening: today's `SHIPBroadcaster` refuses `tm_<hex>` on the client side.
- **Unchanged:** the overlay-first flow (noSend → submit → sendWith), token-aware coin selection, `walletMandalaUnlock`, the deploySig protocol.

## 9. Wire contract changes (contract v3, P7)

- STEAK: `outputsToAdmit`, `admissionSignature` and `admissionIdentityKey` move from the `tm_mandala` entry to each `tm_<id>` entry. A transaction that touches two tokens carries two σI, each over only that topic's admitted outputs.
- A deploy's `tm_mandala` entry also admits vout 0 and carries its own σI, so the wallet can prove registration.
- Offline settlement (recipient submits, σI per input txid, walk-back) works per token topic and is otherwise unchanged.
- `ErrUnknownTopic` answers 400 `ERR_SHAPE` and is never persisted.

## 10. Failure cases

| Case | Behaviour |
|---|---|
| Registry and token topic disagree on a deploy | They can't: both run the same deploy checks. A refusal answers once, with the shared code. |
| Crash after `Ensure`, before the submit completes | Nothing persisted, so nothing is half-done. Boot rebuilds from the 6.2 union. |
| Double submit, or two deploys at once | `Ensure` is idempotent and serialised. |
| Submit names an unregistered topic | `ErrUnknownTopic` → 400 `ERR_SHAPE`, not persisted, nothing admitted on any topic. |
| Allowlist narrowed | See 6.3. |
| Peer on the old BRC-87 rule | Token ads refused there, logged once. Registry and KYC still sync. |
| Synced deploy from an issuer this operator doesn't trust | Refused by this operator's registry manager, so no topic is registered. |

## 11. Testing

- **Package 2.1:**
  - The registry admits only valid deploys, and keeps its record after the deploy output is spent.
  - The token manager ignores other tokens' inputs and outputs.
  - A two-token transaction conserves each token separately.
  - The KYC rename keeps behaviour identical.
  - Vectors are regenerated.
- **BRC-87 PR:** the shared regex accepts `tm_<64hex>` and `ls_<64hex>`, rejects names over 150 characters, and accepts every old-valid name (property tests).
- **Go overlay:**
  - Registrar unit tests: idempotent, concurrent `Ensure`, allowlist, lazy registration only for the transaction's own txid, no `SyncConfiguration` race (run with `-race`).
  - End-to-end on the real engine: deploy (both topics) → issue → transfer, then a two-token transfer.
  - Boot re-registration from both sources, including a token with a journal entry but no registry record.
  - Owner-index maintenance across token topics. Eviction per topic.
  - Golden-vector parity with the TS package.
- **Two-node integration:** overlays A and B. B has an allowlist of one token. A deploys two tokens. B syncs `tm_mandala`, then registers and syncs only the allowed `tm_<id>`.

## 12. Phases

| Phase | Work | Gate |
|---|---|---|
| Q1 | ts-stack PR: BRC-87 widening (`@bsv/sdk`, discovery-services, overlay). | User merges and publishes. |
| Q2 | ts-stack PR: overlay-topics 2.1. In parallel with Q1. | User merges and publishes. |
| Q3 | Go overlay: registrar, registry and token topics, KYC rename, routes, tests. | Q2 vectors. |
| Q4 | TS overlay parity reference. | Q2 published. |
| Q5 | Lib/wallet topic routing, inside P4/P6. | Q1 published (client SDK). |
| Q6 | Wire contract v3 text, inside P7. | Q3. |

## 13. Out of scope

- Migrating existing state. Clean break, as in the BRC-162 design D13.
- Per-token trusted-issuer sets. One `MANDALA_ISSUER_KEYS` per operator.
- Persisting registrar state; it is rebuilt at boot.
- Unregistering a token topic at runtime. Allowlist changes take effect on restart.

## 14. Amendment A1 (2026-10-05): single-overlay Q3; σI per topic; persistence; token list

Found while mapping the Go overlay for Q3 (fact base: `docs/superpowers/plans/2026-10-05-q3-facts/`, especially `gaps.md` G1–G7, G19). User decisions on 2026-10-05.

**A1.1 Cross-operator sync is deferred (supersedes §1 success criterion, §6.1 steps 5–6, §6.2.3, §6.4, the two-node test in §11).**
- An overlay verifies an output's owner by decrypting its envelope linkage with its own `SERVER_PRIVATE_KEY`. GASP (TS `OverlayGASPStorage.finalizeGraph`, Go `gasp-storage.go submitBeef`) carries no off-chain values, so every synced Mandala output is refused at layer B (`noLinkage`). Even with the envelope, a second operator cannot decrypt linkages encrypted to another overlay's key.
- go-overlay-services v1.3.7 discovers SHIP peers only for `tm_ship`/`tm_slap`, and Go has no Advertiser or SHIP/SLAP host.
- Therefore Q3 delivers token topics on **one overlay**: registry, per-token topics, KYC rename, registrar with allowlist, boot union, deploy hook, maintenance and eviction per topic. The registrar registers managers and lookups only; it does not touch `SyncConfiguration`, does not call `SyncAdvertisements` and runs no GASP. GASP stays off.
- Cross-operator hosting needs a new trust rule (for example: admit a synced transaction when a trusted peer overlay's σI covers it; or multi-recipient linkage). That is a separate design, **Q3b**, after Q3.
- New Q3 success criterion: one Go overlay that follows every token admits a deploy (both topics), an issue, a transfer and a two-token transfer; an allowlisted overlay refuses submits naming an unlisted token topic with 400 `ERR_SHAPE`; a restart re-registers every token from the boot union.

**A1.2 σI per topic (supersedes §9 bullet 1).** One admission record per txid holds a per-topic map `topic → {outputsToAdmit, admissionSignature}` plus `admissionIdentityKey`. The σI digest becomes v3 and binds the topic: `SHA-256("mandala-admit:v3:" + topic + ":" + txid + ":" + join(sorted unique outputsToAdmit, ","))`. Each STEAK entry for `tm_mandala` and every `tm_<id>` carries its own σI. `GET /admin/admission/:txid` returns the map. This is a wire-contract v3 change (P7) and the lib verifies per topic (P4).

**A1.3 Persisted refusals.** A final refusal (the `FINAL_CODES` set) is persisted when the refusing topic is `tm_mandala` or any `tm_<id>`. `tm_mandala_kyc` refusals stay unpersisted, as today. `ErrUnknownTopic` is never persisted, and the host checks every named topic with `HasTopicManager` **before** writing the provisional admission record, so an unhosted topic leaves nothing behind.

**A1.4 Token list.** `GET /admin/tokens` is **public** (deploys are on chain), CORS `*` like the other token routes. It is the only wire for the registry list; `/lookup` stays outputs-only. §8's "token list comes from `ls_mandala`" now reads "from `GET /admin/tokens`".

**A1.5 Smaller rulings.**
- The Go codec and generic rules live in `internal/brc162`.
- `MANDALA_TOKEN_ALLOWLIST` error strings are defined by the Q3 plan (no TS reference exists yet; Q4 copies them).
- `/admin/registry` and `/admin/registry/beef/:txid` keep their URLs and read `tm_mandala_kyc`. `/admin/authorities/beef/:txid` finds the output across topics (it has no tokenId) and serves it only when the output is a token output on a `tm_<id>` topic.
- Go boots Q3 on a fresh `NODE_NAME` (old-format state stays untouched, as in P2).

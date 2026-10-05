# Q3 fact base: gaps, contradictions and fills

Completeness critique of `go-host.md`, `go-mandala.md`, `ts-codec.md`, `ts-layers.md`, `ts-storage.md`, `gos-engine.md` and `p2-parity.md`, measured against the Q3 goal: port `overlay-go` to BRC-162 in the token-topic layout. Every gap below is filled from code where possible.

Collected 2026-10-05. Everything was read-only. Apart from grep, sed and read-only git, the only build or test command run was `go test -race -count=1 -run '^$' ./internal/wiring ./internal/httpapi` (compile only; repo still clean afterwards).

## 0. Citation keys and provenance

| Key | Path |
|---|---|
| OG/ | `overlay-go/` at mandala `feat/brc162` HEAD **`1125767`**. That is a merge of `claude/go-overlay-mongodb-config-b40af0`; the sheets were taken at `628a97c`. |
| E/ | `~/go/pkg/mod/github.com/bsv-blockchain/go-overlay-services@v1.3.7/pkg/core/engine/` |
| G/ | `…/go-overlay-services@v1.3.7/pkg/core/gasp/` |
| SRV/ | `…/go-overlay-services@v1.3.7/pkg/server/` |
| SDK/ | `~/go/pkg/mod/github.com/bsv-blockchain/go-sdk@v1.7.1/` |
| Q2/ | ts-stack branch `feat/mandala-token-topics` at **`573198ddb`** (2026-10-05 14:30), path `packages/overlays/topics/src/`. The worktree `/private/tmp/ts-stack-q2` is temporary. **Q2 is still running**: HEAD moved from `0f2bf7d90` to `573198ddb` while this sheet was being written. Re-read Q2 before you finalise the plan. |
| Q2P | `docs/superpowers/plans/2026-10-05-q2-overlay-topics-2-1-token-topics.md` |
| TT | `docs/superpowers/specs/2026-10-05-mandala-token-topics-design.md` |
| D | `docs/superpowers/specs/2026-10-01-mandala-brc162-design.md` |
| TSO/ | `overlay/node_modules/@bsv/overlay/dist/esm/src/` (`@bsv/overlay` 2.6.2) |
| OV/ | `overlay/src/` (TS P2 host) |

Module path, for imports: `github.com/sirdeggen/mandala/overlay-go`, as reported by `go test`. `go env`: `go1.26.0`, `CGO_ENABLED=1`. `-race` builds for `./internal/wiring` and `./internal/httpapi`.

---

## 1. Blocking contradictions: TT design vs the pinned engine

### G1. GASP carries no off-chain values, so every synced Mandala transaction is refused at layer B
- **Go ingest.** `submitBeef` submits `overlay.TaggedBEEF{Topics: []string{s.Topic}, Beef: beef}` with `SubmitModeHistorical` and no `OffChainValues` (E/gasp-storage.go:453-492, literal at :482-485).
- **Go serve.** `hydrateGASPNode` and `buildGASPNode` set only `GraphID`, `RawTx`, `OutputIndex` and `Proof`. They never set `TxMetadata` or `OutputMetadata` (E/engine.go:1287-1330). The fields themselves exist on the node (G/types.go:95-103).
- **Interface.** The Go `TopicManager` interface has no offChainValues, mode or context parameter (E/topic-manager.go:12-17). Mandala passes the envelope through `ctx` (OG/internal/httpapi/submit.go:119-123), and GASP's ctx carries none.
- **TS behaves the same.**
  - `finalizeGraph` calls `engine.submit({beef, topics:[this.topic]}, () => {}, 'historical-tx-no-spv')` with no offChainValues (TSO/GASP/OverlayGASPStorage.js:396-412).
  - Only the dry-run in `findNeededInputs` passes `txMetadata` (:169). `:326` passes `undefined`.
- **Consequence (derived from layer B, ts-layers §2).** An empty envelope gives `Reasons.noLinkage(i)` for every token output. For a deploy, layer C would also give `deploySig()`, but layer B runs first.
  - A follower's `tm_mandala` registry manager therefore refuses every synced deploy. TT §6.2.3 ("registry admission by GASP") can never fire.
  - TT §6.4 per-token sync can never admit anything.
  - The TT §1 success criterion ("syncs the registry and that one token from a peer") is unreachable on either engine as specified.
- **TT text is also stale.** TT:120 says "`tm_mandala` and `tm_mandala_kyc` sync as today", but GASP is off today on both stacks: OG/internal/wiring/engine.go:1-4 ("GASP off") and OV/index.ts:246 (`configureEnableGASPSync(false)`).
- **OPEN QUESTION (user, U1).**

### G2. SHIP peer discovery in v1.3.7 works only for `tm_ship` and `tm_slap`
- `discoverSHIPPeers(ctx, topic)` passes the topic being synced to `extractPeerEndpoints(topic, …)` (E/engine.go:1023-1059). For any topic other than `tm_ship` and `tm_slap`, `expectedProtocolForTopic` returns `("", false)` (E/engine.go:1062-1071), so the result is an empty set with the log `"unknown topic, cannot determine expected protocol"` (E/engine.go:1074-1080).
- Even for known topics, every output is dropped when `e.Advertiser == nil` (E/engine.go:1108).
- So TT §6.1 step 5 ("Set `SyncConfiguration[tm_<id>]` to SHIP-discovered peers") cannot use `SyncConfigurationSHIP`. The registrar has to discover peers itself and write `SyncConfiguration{Type: SyncConfigurationPeers (=0), Peers: […]}` (E/engine.go:48-78). Pieces available for that:
  - the resolver: `engine.NewLookupResolverWithNetwork(overlay.Network)` (E/lookup_resolver.go:24-36), queried on service `"ls_ship"` with `{"topics":[topic]}` (the same shape as E/engine.go:1029-1038);
  - `admintoken.Decode(*script.Script) *OverlayAdminTokenData{Protocol, IdentityKey, Domain, TopicOrService}` (SDK/overlay/admin-token/admin-token.go:41-72) to parse the ads;
  - the network constants `overlay.NetworkMainnet=0`, `NetworkTestnet=1`, `NetworkLocal=2` (SDK/overlay/overlay.go:73-85);
  - the default trackers: mainnet `DEFAULT_SLAP_TRACKERS` (4 hosts), testnet `["https://testnet-users.bapp.dev"]` (SDK/overlay/lookup/resolver.go:20-28).
- `NewEngine` defaults `LookupResolver` to **mainnet** (E/engine.go:162-164). `NETWORK=test` must pass `NewLookupResolverWithNetwork(overlay.NetworkTestnet)` through `engine.Config.LookupResolver`.
- `StartGASPSync` runs once and returns; it has no interval. It also iterates the live `e.SyncConfiguration` map with no lock (E/engine.go:988-1020). To satisfy TT §6.1 ("GASP sync runs from the registrar's snapshot"), the registrar has to run its own loop from exported pieces:
  - `engine.NewOverlayGASPStorage(topic, *Engine, *int)` (E/gasp-storage.go:87);
  - `engine.NewOverlayGASPRemote(endpointURL, topic, util.HTTPClient, maxConcurrency)` (E/gasp-remote.go:39);
  - `gasp.NewGASP(gasp.Params{…})` (G/gasp.go:53-88), which needs `Close()`;
  - `Storage.GetLastInteraction` and `UpdateLastInteraction` (OG/internal/enginestore/enginestore.go:786-808).

  This mirrors `syncWithPeer` (E/engine.go:1124-1163).

### G3. No Go Advertiser, no SHIP/SLAP topic managers, no SHIP/SLAP lookups
- A grep of go-overlay-services v1.3.7, go-sdk v1.7.1 and go-wallet-toolbox v0.186.3 for `ParseAdvertisement|"tm_ship"|ls_ship` (non-test) finds:
  - the interface only (`advertiser.Advertiser`, E/../advertiser/advertiser.go:26-31);
  - the engine's callers;
  - generated openapi;
  - conformance JSON.
  
  `pkg/topics` contains only `identity/`.
- go-sdk provides the building blocks:
  - `admintoken.NewOverlayAdminToken(wallet.Interface, originator...)`, `.Lock(ctx, protocol, domain, topicOrService)` and `.Unlock(ctx, protocol)` (SDK/overlay/admin-token/admin-token.go:28-139). This is a PushDrop lock that needs a wallet with `GetPublicKey(IdentityKey:true)` plus signing.
  - `topic.NewBroadcaster(topics, cfg)`, which accepts only names starting with `tm_` (SDK/overlay/topic/broadcaster.go:65-73).
- `SyncAdvertisements` behaviour:
  - It creates ads and then calls **`e.Submit(ctx, taggedBEEF, SubmitModeCurrent, nil)` on this engine** (E/engine.go:965-973). Without local `tm_ship`/`tm_slap` managers that returns `unknown-topic`, which is only logged.
  - It revokes every found ad whose topic is not registered, with **no Domain check** (E/engine.go:928-933). The `Advertiser.FindAllAdvertisements` scope therefore decides whose ads get revoked.
- Setting `Engine.Advertiser` also enables `propagateToNetwork` synchronously inside every non-historical Submit (E/engine.go:697-727).
- There is a funded Go wallet in the repo, but it is a separate module: `fuelkeeper/` (`fuelkeeper/go.mod:7` requires `go-wallet-toolbox v0.186.3`). Whether it fits advertising is UNVERIFIED.
- **OPEN QUESTION (user, U2).**

### G4. Q3's gate ("Q2 vectors") does not exist yet
- Q2 commits on top of `87a14c9b5`, in order: `85f301334` (Task 0), `860fdb721` (T1), `c3e9e3e2c` (T2), `c31a8aac5` (fix), `259d6414a` (T3), `0f2bf7d90` (T4), `573198ddb` (fix). **Task 5 (KYC rename, exports, vectors, version) has not landed.** Current state:
  - `REGISTRY_TOPIC = 'tm_mandala_registry'` is unchanged (Q2/mandala-registry/RegistryTopicManager.ts:31).
  - `Reasons.registryExists` is `'tm_mandala_registry: registration chain already exists; register is genesis-only'` and `registryValue` is ``output ${i}: tm_mandala_registry does not admit value outputs`` (Q2/mandala/reject.ts:144-147). These are byte-exact contract strings. Q2P:29 says "Reject reasons stay verbatim", so whether they change with the rename is UNVERIFIED until Task 5.
  - `test/vectors/mandala-rejects.json` was last changed in `0211fd965` (2026-10-02), and its cases still carry `"topic": "tm_mandala"`.
- Neither vendored tarball ships vectors: `tar -tzf overlay/vendor/bsv-overlay-topics-2.0.0.tgz` lists only `package/package.json` for the `json|vector` pattern, and templates lists none. The vectors must be copied from ts-stack source into `OG/testdata/`, which today holds `vectors.json` (old format), `chronicle_sighash_vectors.json` and `gen/`.
- **OPEN QUESTION (user, U3).**

---

## 2. Q2 as built: the reference Go must mirror (no sheet covers it)

go-mandala §0 marks all of 2.1 "UNVERIFIED by construction". Code now exists for everything except Task 5, and it differs from Q2P in several places (marked ≠Q2P below).

### 2.1 Names: `Q2/mandala/topics.ts:4-24`
- `MANDALA_TOPIC='tm_mandala'`, `MANDALA_LOOKUP='ls_mandala'`, `KYC_TOPIC='tm_mandala_kyc'`, `KYC_LOOKUP='ls_mandala_kyc'`.
- The regexes are `TOKEN_ID = /^([0-9a-f]{64})_0$/` and `TOKEN_TOPIC = /^tm_([0-9a-f]{64})$/`.
- `tokenTopic(id)` and `tokenLookup(id)` throw `` `not a canonical Mandala token id: ${tokenId}` ``.
- `isTokenTopic(name)` is a regex test. `tokenIdOfTopic(name)` returns `` `${hex}_0` `` or `null`.
- Near-miss tests: uppercase, 63 hex, `…0`, `…_0`, `ls_…`, `tm_mandala`, `tm_mandala_kyc`, `''` and `'tm_'` are all not token topics (Q2P:125-130, ported as Q2/mandala/__tests/topics.test.ts).

### 2.2 Scope: `Q2/mandala/scope.ts:15-34`
`scopeToToken(tokenId, {outputs, invalid, inputs, env})` keeps:
- outputs and inputs whose `tokenId === tokenId`;
- **every** `invalid` entry;
- `env.outputs` and `env.inputs` filtered by the kept indices;
- `env.admin` entries whose index is one of this token's outputs, **or names no token output of any token**;
- `deploySig` only when a kept output has `role === 'deploy'`, otherwise `undefined`.

### 2.3 Token manager: `Q2/mandala/MandalaTopicManager.ts` (class `MandalaTokenTopicManager`)
- **Constructor (:161-172).**
  - `topic = tokenTopic(deps.tokenId)`, which throws on a bad id.
  - `trusted = trustedSet(deps.trustedIssuers, 'MandalaTokenTopicManager')`.
  - `exempt = trusted ∪ exemptKeys(deps.membershipExempt, …)`.
- **Early return (:191-204) ≠Q2P.** After scoping, it returns `{outputsToAdmit: [], coinsToRetain: []}` only when `outputs`, `inputs`, `invalid` **and `env.admin`** are all empty. Commit `c31a8aac5` ("orphan admin entry refuses every token topic") added the `env.admin` condition. The envelope is decoded before scoping, so a malformed envelope refuses on every token topic.
- **Steps.** Layers B to D run as in 2.0, with `topic: this.topic` passed to `resolveInputOwners` (:210-216). The journal is written with `journalOwners(store, this.topic, txid, owners)` when `outputs.length > 0 && context?.dryRun !== true` (:231-233).
- **Return (:236-239) ≠ 2.0.** `{outputsToAdmit: ascendingIndices(outputs), coinsToRetain: inputs.map(i => i.index).sort()}`. 2.0 and Go both retain `previousCoins` (OG/internal/mandala/topic_manager.go:280, registry_topic.go:110); see G9.
- **Metadata (:246-251).** `{name: this.topic, shortDescription: 'Mandala BRC-162 token ' + tokenId + ': authority and value outputs, identity linkage, issuer controls.'}`.

### 2.4 Registry manager (`tm_mandala`): `Q2/mandala/MandalaRegistryTopicManager.ts` at `573198ddb`
- **Constructor (:19-23).** `trustedSet(…,'MandalaRegistryTopicManager')` and `exemptKeys(…)`.
- **`identifyAdmissibleOutputs` (:25-48) ≠Q2P and ≠`0f2bf7d90`.** It **always** builds `new MandalaTokenTopicManager({...deps, tokenId: `${txid}_0`})` and runs it with `{...context, dryRun: true}`, so any refusal propagates. Then it returns `{outputsToAdmit: deployAt0 ? [0] : [], coinsToRetain: []}`.
  - `deployAt0` is `classifyOutputs(tx).outputs.some(o => o.index === 0 && o.role === 'deploy')`.
  - Commit `573198ddb` gives the reason: the registry must also refuse whatever every token topic refuses (codec-refused output, orphan admin entry, malformed envelope), and must agree with `tm_<txid>` on a codec-refused deploy-shaped vout 0.
- **Metadata (:54-59).** `{name: 'tm_mandala', shortDescription: 'Mandala token registry: one permanent record per BRC-162 deploy.'}`.

### 2.5 Registry lookup (`ls_mandala`): `Q2/mandala/MandalaRegistryLookupService.ts`
- `QUERY_KEYS = ['tokenId','list','limit','skip']` (:38). `spendNotificationMode = 'none'` (:48).
- **`outputAdmittedByTopic` (:53-75).**
  - It returns unless `topic === 'tm_mandala'`, `outputIndex === 0`, and output 0 classifies as a deploy.
  - It then computes `verifyOutputOwners([deploy], decodeEnvelope(offChainValues), verifierWallet)[0].identityKey` as the issuer, and `deployMetadata(payload, payloadCanonical)`.
  - It writes with `storeRegistryRecord({tokenId, deployTxid, sym, dec, label, issuer, feeRatePerKb, createdAt: new Date()})`.
- `outputSpent` is a no-op (:78). `outputEvicted(txid, 0)` calls `deleteRegistryRecord(`${txid}_0`)` (:81-83).
- **`lookup` (:85-100).**
  - `requireLookupQuery(question, 'ls_mandala', QUERY_KEYS)`.
  - Then `requireTokenId`, `readBoolean('list')`, `readInteger('limit', 100, 1, 100)` and `readInteger('skip', 0, 0, 100000)`.
  - `{tokenId}` returns `[record]` or `[]`. `{list:true}` returns a page. Anything else throws `'Unsupported query'`.
  - Records are returned through a cast to `LookupFormula` (:42-43).
- Factory: `createMandalaRegistryLookupService(verifierWallet, storage)`. This is ≠Q2P, which took `(storage)` only (:119-125).

### 2.6 Token registry storage, `mandalaTokenRegistry` (≠Q2P, which said `mandalaRegistry`)
- Collection `'mandalaTokenRegistry'` (Q2/mandala/MandalaStorageManager.ts:132). The comment explains why it is not `mandalaRegistry`: the KYC `RegistryStorage` keeps identity rows there under a unique `identityKey` index.
- Indexes: `{tokenId:1}` **unique** and `{createdAt:1}` (:107-118).
- `MandalaRegistryRecord {tokenId, deployTxid, sym, dec: number, label, issuer, feeRatePerKb: number|null, createdAt: Date}` (Q2/mandala/types.ts:73-84).
- Methods:
  - `storeRegistryRecord`: `updateOne({tokenId}, {$setOnInsert: r}, {upsert:true})`, first write wins (:363-370);
  - `findRegistryRecord`: projection `{_id:0}` (:372-375);
  - `listRegistryRecords(limit, skip)`: sort `{createdAt:1, tokenId:1}` (:378-386);
  - `deleteRegistryRecord(tokenId)` (:388-391);
  - `allRegistryTokenIds()`: `distinct('tokenId')` (:394-397).
- There is **no** method for the journal's distinct topics. TT §6.2.1's second boot source is host-side: `mandalaOwners.distinct('topic')` filtered by `isTokenTopic`. That rules out `tm_mandala_kyc` rows; `tm_mandala` never journals because the registry is a dry run (2.4).

### 2.7 Token lookup (`ls_<txid>`): `Q2/mandala/MandalaLookupService.ts`
- `MandalaLookupDeps` gains `topic: string` (:51) and `lookupName: string` (:53).
- The admit filter is `payload.topic !== this.deps.topic` (:226) and the spend filter likewise (:369).
- Authority queries use `listAuthorities(topic, tokenId)` (:106).
- `outputEvicted` has no topic guard: it does `takeRow`, then `deleteMetadata(`${txid}_0`)` when vout is 0 (:373-376).
- Factory: `createMandalaLookupService(verifierWallet, storage, tokenId)` (:475).
- Bundle factory: `createMandalaTokenTopic(tokenId, deps & {storage}) → {tokenId, topicName, lookupName, manager, lookupFactory}` (Q2/mandala/tokenTopic.ts:24-38).

### 2.8 Unchanged by Q2 so far
- The KYC manager and lookup (Task 5 pending).
- Reject strings.
- `brc162.json` (Q2 does not touch `@bsv/templates`).
- The `reconcile.ts` API (`reconcile.test.ts` changed by 10 lines only; `git diff --stat 87a14c9b5`).

Base equivalence: `git log 729ad70e0..87a14c9b5 -- packages/overlays/topics packages/helpers/ts-templates` is empty. So the vendored 2.0.0 tarballs (`overlay/vendor/README.md`: packed at `729ad70e0`) equal the ts-layers/ts-codec/ts-storage source `87a14c9b5` for these packages, and those sheets' citations hold for TS P2.

---

## 3. Gaps in the Go host: what `"tm_mandala"` now means

### G5. Every `tm_mandala` literal in httpapi and wiring changes meaning (registry, not tokens)
go-host §6 lists them, but no sheet states the consequence. Under TT a transfer's X-Topics are `[tm_<id>…]` (TT §8), so with the literals unchanged:
- `tokenSubmit = slices.Contains(topics, "tm_mandala")` (OG/internal/httpapi/submit.go:134-135) is false for every transfer. That skips `serveKnownVerdict` (:145-149), the provisional record (:186-197) and σI (:245-261).
- `admittedTokenOutputs` reads `steak["tm_mandala"]` (:381-387). The σI attach (:439-442) and the dupe-200 body key (:352-361) are wrong for transfers.
- `Persistable()` requires `Topic == "tm_mandala"` (OG/internal/httpapi/verdict.go:159-161), so no token-topic refusal is persisted. TS P2's equivalent rule is `refusingTopic === TOKEN_TOPIC` (OV/admission.ts:498). The TT and Q4 rule is undefined; see U5.
- The wiring closures are hard-bound to the topic: `spendChecker` (OG/internal/wiring/engine.go:435-453), `appliedAdmissionProof` (:407-427), the compensation dupe check (:377-380) and `restoreLiveTokenRows` (:581-610, `IsUnspent(tokenTopic,…)` at :592).
  - `SpendChecker.SpentBy(ctx, txid, vout)` has no topic parameter (OG/internal/mandala/topic_manager.go:434-436), so each per-token manager needs its own bound instance.
  - `PrepareSubmitCompensation(ctx, beef)` gets no topics (OG/internal/httpapi/submit.go:76), so the dupe check cannot know which topics to test.

### G6. `ErrUnknownTopic` must become 400 `ERR_SHAPE`, unpersisted (TT §9:154); Go answers 503 today
- The engine returns the sentinel **unwrapped**: `return nil, ErrUnknownTopic` (E/engine.go:405-410), with `ErrUnknownTopic = errors.New("unknown-topic")` (E/engine.go:284). So `errors.Is(err, engine.ErrUnknownTopic)` works. The fix point is `VerdictForSubmitError` (OG/internal/httpapi/verdict.go:166-177).
- Side effect today: the provisional `RecordAdmission{Pending:true, Restore}` is written **before** `s.Submit` (OG/internal/httpapi/submit.go:186-199). Generalised to token topics, a submit naming an unhosted `tm_<hex>` would leave a pending record behind for a transaction the engine never saw. `Engine.HasTopicManager(name)` exists for a pre-check (E/engine.go:234-239).
- `/lookup` with an unknown service, such as an unhosted `ls_<hex>`, answers 400 `{status:'error', message:'unknown-topic'}` (OG/internal/httpapi/lookup.go:48-50; E/engine.go:731-735). No TT text changes this. TT §6.6's 404 `token not hosted` applies to admin routes only.

### G7. σI per topic vs the single-signature `AdmissionRecord`
- TT §9:151-152: a two-token transaction carries one σI per `tm_<id>` entry, and a deploy carries σI on both the `tm_mandala` entry (vout 0) and the `tm_<id>` entry.
- Go keeps one record per txid: `AdmissionRecord{Txid, Topics []string, OutputsToAdmit []uint32, AdmissionSignature, AdmissionIdentityKey, …}` (OG/internal/mandala/admissions.go:66-94) with **unique** `{txid:1}` (OG/internal/mandala/storage.go:153-159). `GET /admin/admission/:txid` returns one signature (OG/internal/httpapi/admin.go:109-157).
- **The digest does not bind the topic.** `SHA-256("mandala-admit:" + txid + ":" + join(sorted unique outs, ","))` (OG/internal/httpapi/admission.go:44-53). On a deploy, `tm_mandala` admits `[0]` and `tm_<id>` admits `[0]`, so the two σI are byte-identical. (That `tm_<id>` admits only `[0]` on a deploy is derived from layer C: `authorityWithoutInput` allows no authority output but the genesis, and `holderConservation` allows no value output without an authority input; ts-layers §3 steps 4 and 8.) For a two-token transaction, each σI covers disjoint output sets with nothing naming the topic.
- `enginestore.AdmittedOutputIndexes(ctx, topic, txid)` already works per topic (OG/internal/enginestore/enginestore.go:550-571). The FIX C fallback can therefore be per topic once the record shape is settled.
- **OPEN QUESTION (user, U4).** Options: a per-topic map in one record, or one record per `(txid, topic)` with the unique index changed to `{txid, topic}`. Separately, digest v3 with or without the topic.

### G8. The `previousCoins` → `coinsToRetain` change deletes engine docs in Go
- In the Go engine, inputs that are not retained go through `deleteUTXODeep` (the doc is deleted when `ConsumedBy` is empty) and are appended to `CoinsRemoved` (E/engine.go:600-610). Retained inputs keep their spent doc and gain `ConsumedBy` (E/engine.go:685-694).
- Under 2.1, `coinsToRetain` is the indices of the **classified** inputs of this token (2.3). A previous coin that `classifyAdmittedInputs` ignores is not retained and so gets deleted:
  - a codec-refused source;
  - a deploy source at vout ≠ 0;
  - a missing `sourceTransaction` (ts-layers §1 `readInput` cases).
- Eviction restore needs the spent doc to exist: `UnmarkSpentBySpendTxid` is `$set spent:false` on existing docs (OG/internal/enginestore/enginestore.go:582-593). A deleted input therefore cannot be restored by eviction.
- Q2's own comment (Q2/mandala/MandalaTopicManager.ts:234-235): "a coin not retained is deleted from the topic as stale". The Go port must reproduce `coinsToRetain` exactly for vectors parity: `gen.test.ts` compares `{outputsToAdmit, coinsToRetain}` (ts-layers §13). Whether Task 5's regenerated vectors pin the new rule is UNVERIFIED.

### G9. The registry's dry run needs an internal Go seam, and GASP calls managers speculatively
- Go `IdentifyAdmissibleOutputs(ctx, beef, txid, previousCoins)` has no context or dry-run flag (E/topic-manager.go:12-17). The registry (2.4) needs the token check with the journal write skipped, so the port needs an internal method such as `identify(ctx, …, journal bool)` shared by both managers. That method is a planner choice.
- GASP calls managers speculatively, and the Go engine gives no dry-run signal (D §4.2a rule 1 expects one: "`context.dryRun` (GASP) skips the write"):
  - `FindNeededInputs` calls `IdentifyAdmissibleOutputs` and **discards the error** (`admit, _ :=`, E/gasp-storage.go:235);
  - `ValidateGraphAnchor` calls it again (E/gasp-storage.go:392).

  This resolves gos-engine §1's UNVERIFIED: under v3 the Go manager **does** have side effects (the journal write, and the §4.2a inline repair `repairOwnerRow` and `takeBackRepair`). Today, though, G1 makes every such call refuse at layer B, before the journal step.

---

## 4. Eviction, admin routes, boot and config under TT

### G10. Eviction routing
- `evictTx` notifies only `ls_mandala` (`ls.OutputEvicted`, OG/internal/wiring/engine.go:534-542). `OutputEvicted(ctx, outpoint)` carries no topic (E/lookup-service.go:58), and the engine never calls it (gos-engine §2).
- Under TT, an evicted output's rows must reach:
  - the token's `ls_<id>`, whose `takeRow` and `deleteMetadata` at vout 0 are idempotent across instances per Q2/mandala/MandalaLookupService.ts:373-376 and Q2P:370;
  - `ls_mandala` for a deploy at vout 0 (`deleteRegistryRecord`, 2.5);
  - `ls_mandala_kyc` (`takeAuthority`, ts-storage §5.2).
- The engine deletes are already topic-agnostic: `DeleteOutputsByTxid` and `DeleteAppliedTransactionsByTxid` (OG/internal/enginestore/enginestore.go:631-634, 708-711).
- Input restore per TT §6.5 ("using the journal's `topic` field") needs a journal read by outpoint across topics. TS `getOwnerJournal(txid, vout, topic)` is topic-keyed (ts-storage §3), so Go must either iterate registered topics or add a topic-free read. That is a planner choice.

### G11. `/admin/authorities/beef/:txid?vout=` cannot be a "path rename only"
p2-parity row 10 and its routes table say "path rename only", which is wrong under TT.
- TS P2 reads `findOutput(txid, vout, TOKEN_TOPIC, …)` (OV/index.ts:367). Go reads `OutputBeefBytes(ctx, "tm_mandala", txid, vout)` (OG/internal/httpapi/admin.go:59; enginestore.go:681-703).
- Under TT the authority lives in `tm_<id>`, and the route has no tokenId.
- Topic-agnostic reads exist: `FindOutput(ctx, outpoint, topic=nil, spent=nil, includeBEEF)` (OG/internal/enginestore/enginestore.go:271-290; it applies no topic filter when nil and returns any matching doc) and `FindOutputsForTransaction` (:339-358).
- Likewise `/admin/registry/beef/:txid` is bound to `mandala.RegistryTopic` (admin.go:61) and must move to `tm_mandala_kyc`. Whether the route names `/admin/registry*` are renamed is not stated in TT; §6.6 says only "The v3 URLs are unchanged".

### G12. Boot union and the deploy hook: exact attach points
- **Boot (TT §6.2.1).** The union of `mandalaTokenRegistry.distinct("tokenId")` (2.6) and `mandalaOwners.distinct("topic")` filtered by `^tm_[0-9a-f]{64}$`, then `Ensure` each.
  - It runs after `wiring.Build` (OG/cmd/overlay/main.go:56-59 at `1125767`) and before `httpapi.New` (:76) and `Listen(":8080")` (:80).
  - Today nothing runs in between except the identity boot log (:61-75).
  - go-host §1's main.go line numbers predate the merge: `requireEnv` is now :117 and `loadConfig` :131-170.
- **Deploy hook (TT §6.2.2).** `txidFromBeef(beef)` is already computed at OG/internal/httpapi/submit.go:134. The hook goes before `s.Submit` (:199). Match "names `tm_mandala` and `tm_<own txid>`" against the parsed `topics` (:92-99).
- **Config.**
  - `MANDALA_ISSUER_KEYS` and `MANDALA_TOKEN_ALLOWLIST` belong in `loadConfig` (OG/cmd/overlay/main.go:131-170 at `1125767`) and in `wiring.Config` (OG/internal/wiring/engine.go:43-65).
  - The TS byte-exact `MANDALA_ISSUER_KEYS` error strings are in p2-parity §6.
  - **No reference error strings exist for `MANDALA_TOKEN_ALLOWLIST`**: TT §6.3 gives only the rule, and Q4 (TS) is unwritten. The planner must define them.
- **Live `.env` hazard.** `overlay-go/.env` has `NODE_NAME=mandala`, giving the v2-format db `mandala_lookup_services` (OG/internal/wiring/engine.go:220). Q3 must boot on a fresh node name, as P2 did with `mandala162`. The index-collision mechanics are in go-mandala §8.6 and ts-storage §7.4.

### G13. GASP serving routes are not mounted, and the library handlers are not reusable as-is
- The peer client POSTs to `{peer}/requestSyncResponse` with `gasp.InitialRequest{version, since, limit}` and to `{peer}/requestForeignGASPNode` with `gasp.NodeRequest{graphID, txid, outputIndex, metadata}`, both with header `X-BSV-Topic: <topic>`. It expects 200 with `gasp.InitialResponse{UTXOList, since}` or `gasp.Node` JSON; anything else is an `util.HTTPError` (E/gasp-remote.go:53-199; G/types.go:52-103).
- The engine provides `ProvideForeignSyncResponse(ctx, *gasp.InitialRequest, topic)` (E/engine.go:1237) and `ProvideForeignGASPNode(ctx, graphID, outpoint, topic)` (E/engine.go:1260).
- The library handlers live in `SRV/internal/ports/…`, a Go `internal` package that mandala cannot import.
- The exported `server.RegisterRoutes(app, *RegisterRoutesConfig{…, BaseURL})` registers the **whole** openapi route set, including its own `/submit` and `/lookup` (SRV/server_http_register_routes.go:35-127). Whether it can be mounted beside mandala's handlers without collision is UNVERIFIED.
- Hand-written fiber handlers over the two engine methods have no such dependency.

### G14. The maintenance gate cannot see GASP or advertisement submits
- `OverlayGASPStorage.Engine` is `*engine.Engine` (E/gasp-storage.go:77-84), and `submitBeef` calls `s.Engine.Submit` directly (E/gasp-storage.go:479-486). `SyncAdvertisements` also calls `e.Submit` (E/engine.go:968).
- A gate that wraps only `submitHandler` (as p2-parity row 1 proposes) therefore lets GASP-driven admissions and lookup folds run beside the exclusive refold. That breaks the package contract that `rebuildState` "must never run beside a live fold" (ts-storage §4.5).
- TS P2 does not face this because its GASP is off (OV/index.ts:246). In Go the registrar's GASP loop would have to take the shared slot itself.
- **Lock order to pin.** TS fixes reconcile lock → submit gate (p2-parity row 1). TT adds the registrar mutex, which is taken by `Ensure` both from `/submit` (which holds the gate's shared slot) and from the `ls_mandala` admit hook (which runs inside `engine.Submit`).
  - No deadlock with `engine.mu`: `getLookupServicesSnapshot` releases its RLock before callbacks run (E/engine.go:271-280, 663-682), and `RegisterTopicManager`/`RegisterLookupService` take `mu.Lock` (E/engine.go:212-246).
  - The ordering between the gate and the registrar mutex is a planner decision.

---

## 5. Contradictions and staleness between the sheets (and against code)

| # | Sheet claim | Reality | Evidence |
|---|---|---|---|
| C1 | go-host §0 and §7: branch `claude/go-overlay-mongodb-config-b40af0` unmerged; HEAD `628a97c`; overlay-go identical on `master` and `feat/brc162` | Merged at `1125767`. `git diff --stat master HEAD -- overlay-go` shows `cmd/overlay/main.go` +11/-2 and a new `docker-compose.yml` | `git log` / `git diff --stat 628a97c 1125767` |
| C2 | go-mandala §0: overlay-topics 2.1 "UNVERIFIED by construction" | Tasks 0–4 and two fixes exist at Q2 `573198ddb` | §2 above |
| C3 | Q2P:470: registry records in `mandalaRegistry` | Code uses `mandalaTokenRegistry` (the KYC collision is avoided) | Q2/mandala/MandalaStorageManager.ts:130-132 |
| C4 | Q2P:450-457: the registry returns early unless there is a deploy at vout 0 | It always dry-runs the token check (`573198ddb`) | Q2/mandala/MandalaRegistryTopicManager.ts:32-47 |
| C5 | ts-layers §0 step 9 and ts-storage: `coinsToRetain: previousCoins`; the token lookup filters `MANDALA_TOPIC` | 2.1: this token's classified inputs; filter is `deps.topic` | Q2/mandala/MandalaTopicManager.ts:236-239; MandalaLookupService.ts:226,369 |
| C6 | TT §6.1.5 and §6.4: SHIP-discovered peers via `SyncConfiguration` | v1.3.7 discovery is a no-op for any topic but `tm_ship`/`tm_slap` (gos-engine §0.1 is right; TT is wrong) | E/engine.go:1062-1080, 1108 |
| C7 | TT:120: "`tm_mandala` and `tm_mandala_kyc` sync as today" | GASP is off on both stacks today | OG/internal/wiring/engine.go:1-4; OV/index.ts:246 |
| C8 | p2-parity row 10 and the routes table: authorities BEEF is a "path rename only" | Topic is unknowable from `:txid` under TT | G11 |
| C9 | go-host §4.4: keyset paging needs a new index `{topic, spent, score, txid, outputIndex}` (UNVERIFIED) | The reconciler's `listUnspentAdmittedOutputs` keyset is `(txid, outputIndex)` on `{topic, spent:false}` (p2-parity row 3). The existing unique `{topic:1, txid:1, outputIndex:1}` (OG/internal/enginestore/enginestore.go:61-62) serves that sort with `spent` as a residual filter (Mongo semantics; not exercised). A score-keyset index matters only for GASP serving (G15). | p2-parity row 3; enginestore.go:61-68 |
| C10 | p2-parity row 2: owner-index topics `[TOKEN_TOPIC, REGISTRY_TOPIC]` | TT §6.5: every registered `tm_<id>` plus `tm_mandala_kyc`. `tm_mandala` never journals (2.4). | OV/index.ts:279; TT:126 |
| C11 | ts-storage §0 / ts-layers: `REGISTRY_TOPIC`/`REGISTRY_LOOKUP` | Still current at Q2 HEAD; Task 5 will remove them (Q2P:27) | Q2/mandala-registry/RegistryTopicManager.ts:31 |
| C12 | D P3 (D:496): `internal/bsv21`; D §3.5/§4.1 and ts-codec §0: `internal/brc162` | Unresolved; already go-mandala Q1 | D:169,188,496 |

---

## 6. UNVERIFIED items from the sheets, now resolved

- **go-host §6** asked whether `/admin/registry` is renamed. Unresolved by TT. Facts: TT §6.6 says "v3 URLs are unchanged", and the beef route's topic must change (G11).
- **gos-engine §1**: whether the manager has side effects in `IdentifyAdmissibleOutputs`. Yes under v3 (G9).
- **p2-parity §7.9**:
  - Go `ListRegistry` sorts `{admitSeq:-1}`, has filter `bson.D{}` and returns full rows (OG/internal/mandala/registry.go:106-122).
  - The Go index at `storage.go:142` is `{assetId:1, txid:1, outputIndex:1}` (comment "Admin-chain anchoring looks this up…").
- **go-host §4.5**: `InsertOutputs` re-insert resets `spent`. Confirmed: the replacement `outputDoc` has no `Spent` (false) and no `SpendTxid`/`ConsumedBy` (OG/internal/enginestore/enginestore.go:244-262).
- **ts-layers §6 deploySig**:
  - Go has `wallet.NewProtoWallet(ProtoWalletArgs{Type: ProtoWalletArgsTypeAnyone})` (SDK/wallet/proto_wallet.go:28-42).
  - `VerifySignature(ctx, VerifySignatureArgs{EncryptionArgs, Data, Signature *ec.Signature, ForSelf}, originator)` hashes `sha256(Data)` and derives with `keyDeriver.DerivePublicKey` (SDK/wallet/proto_wallet.go:224-280; args at SDK/wallet/wallet.go:150-157). A mismatch returns `ErrInvalidSignature` (:268-275). The caller parses the DER first.
  - Low-S is enforced on neither side. Go `Signature.Verify` checks no half-order (SDK/primitives/ec/signature.go:112-137); its external-verifier path re-serialises to low-S (:135). TS `ECDSA.js` has no `halfOrder` reference (grep).
  - DER strictness differs:
    - TS `Signature.fromDER` accepts short-form lengths only, rejects excess zero padding (`Invalid R-value`/`Invalid S-value`), and reads r and s as **unsigned** bytes (`overlay/node_modules/@bsv/sdk/dist/esm/src/primitives/Signature.js:41-93`).
    - Go offers three parsers: `FromDER` (`asn1.Unmarshal`, :47-53), `ParseSignature` (BER, :297) and `ParseDERSignature` (strict, :304).
    - Which Go parser accepts exactly the TS set is UNVERIFIED. `brc162.json` has only 2 valid `deploySig` rows and no negative case (ts-codec §8).
- **ts-layers §14 hazard 3** (linkage protocol coercion): go-sdk `computeInvoiceNumber` also does `strings.ToLower(strings.TrimSpace(protocol.Protocol))`, with the same length, double-space, charset and `" protocol"` rules (SDK/wallet/key_deriver.go:214-254). Name normalisation matches TS.
  - Still divergent: Go `VerifyKeyLinkage` returns `l.Counterparty` raw, not canonicalised (OG/internal/mandala/linkage.go:50-90, return at :89). TS returns `canonicalKey(…)` (ts-layers §2).
  - Go types `ProtocolID{SecurityLevel int; Name string}` strictly (OG/internal/mandala/payload.go:117-176), so a string security level fails JSON decode. That is the envelope-vs-`noLinkage` placement problem in ts-layers §14.2(g).
- **TT §5** ("Go needs no change for BRC-87"): confirmed.
  - The only name rule in go-sdk overlay code is the `tm_` prefix in `topic.NewBroadcaster` (SDK/overlay/topic/broadcaster.go:65-73).
  - `admintoken.Lock` has no regex (SDK/overlay/admin-token/admin-token.go:75-114).
  - `grep regexp|MustCompile` over `SDK/overlay` (non-test) finds no name check.

---

## 7. Other facts no sheet states

- **G15. GASP serving page boundary.**
  - `ProvideForeignSyncResponse` uses `FindUTXOsForTopic(topic, since, limit)` with filter `score > since` and sort `score` (E/engine.go:1237-1257; OG/internal/enginestore/enginestore.go:363-391).
  - Go assigns one `score` per `InsertOutputs` call, shared by every vout of a transaction (OG/internal/enginestore/enginestore.go:242).
  - The client bumps `LastInteraction` to the page's maximum score before processing (gos-engine §10, G/gasp.go:159-161), and `DefaultGASPSyncLimit = 1000` (E/engine.go:28).
  - So sibling outputs cut at a page edge are skipped. This is derived, not exercised.
- **G16. The `tm_mandala` copy of a deploy is never marked spent.** Issues name only `tm_<id>` (TT §8:143), and `markSpentAndNotify` runs per named topic (E/engine.go:377, 513-534). `FindUTXOsForTopic("tm_mandala", …)` therefore lists every deploy forever, which is consistent with T7. It also means the registry's engine outputs are not a spent-state signal.
- **G17. Duplicate X-Topics.** On the legacy path the engine does not dedupe topics (gos-engine §5; dedupe exists only at E/admission_submit.go:84-91). `httpapi` checks only that `X-Topics` is a JSON string array (OG/internal/httpapi/submit.go:92-99).
- **G18. Lookup fan-out.** Every lookup gets every topic's admit and spend events (E/engine.go:663-682, 553-572). With N tokens that is N+2 filter calls per output, and any lookup error aborts the submit after spends are marked (gos-engine §0.3).
- **G19. `/lookup` cannot carry registry records.**
  - Go serialises only `{type, outputs:[{beef, outputIndex}]}` and drops `LookupAnswer.Result` (OG/internal/httpapi/lookup.go:55-98).
  - On TS, the engine's `assertLookupFormula` throws for any entry without a 32-byte hex `txid` (TSO/Engine.js:1365-1430). Q2's registry records and asset-state casts have no `txid`, so `ls_mandala {list:true}` is not servable over `/lookup` on TS 2.6.2. Q2's tests call `lookup()` directly (Q2/mandala/__tests/MandalaRegistry.test.ts:504,565).
  - TT §8:145 says the lib reads the token list from `ls_mandala`. The wire for that is undefined; see U6.
- **G20. Fuel and token-fee.** D §6.4 orders the guards as "Conflicting spend → (fuel, P3) → layer A…", and D §9 P7 says "Then token-fee P3 rebases". The fuel guard is therefore outside Q3. That is an inference from D's phasing; no Q3 text says it.
- **G21. Readiness.** TS `mandala-owner-index` is `critical:false`, so it degrades readiness but stays 200 (p2-parity §3). TT §6.4 adds that BRC-87 ad refusals do not affect readiness. Go `/health/ready` is a Mongo ping only (OG/internal/httpapi/admin.go:248-269).

---

## 8. Remaining UNVERIFIED (still open after this pass)

- Q2 Task 5 output: the KYC reason strings, the vector topic field values, and whether the vectors pin the 2.1 `coinsToRetain`. Q2 is in flight.
- Whether `server.RegisterRoutes` can co-exist with mandala's own `/submit` and `/lookup` (G13).
- Which Go DER parser matches TS `Signature.fromDER` (§6).
- Whether `fuelkeeper`'s go-wallet-toolbox wallet can fund SHIP/SLAP ads (G3).
- Whether `lockingScript.toBinary()` reproduces source bytes for the §4.2a byte compare (ts-layers §14.6). Unchanged by this pass.

---

## 9. Open questions for the user

- **U1. Cross-overlay sync (G1).** GASP on both engines delivers transactions without the Mandala envelope, so every synced deploy and token output fails linkage at layer B. Choose one:
  - drop GASP and SHIP from Q3 and do single-overlay TT only;
  - carry the envelope in GASP `txMetadata`, which needs engine changes: go-overlay-services is archived and pinned (D §7.2);
  - define a different trust rule for historical/GASP admissions.
  
  The TT §1 success criterion depends on this choice.
- **U2. SHIP/SLAP advertising in Go (G3).** No Go Advertiser and no SHIP/SLAP host exist. Is advertising in Q3 scope? If so, which wallet funds the advertisement transactions (`fuelkeeper`?), and should ads go to remote SHIP trackers directly via `topic.NewBroadcaster`, given there is no local `tm_ship`?
- **U3. Q3 gate (G4).** Wait for Q2 Task 5 (KYC rename plus regenerated `mandala-rejects.json`) before writing vector-parity tasks, or plan against Q2 HEAD and leave those tasks blocked on Task 5?
- **U4. σI and the admission record under multiple topics (G7).**
  - One record per txid with per-topic fields, or one record per `(txid, topic)`?
  - Should the σI digest gain the topic, given the deploy's two σI are byte-identical today?
  - What should `GET /admin/admission/:txid` return?
- **U5. Persisted refusals under TT (G5).** Which refusing topics persist? Today only `tm_mandala` refusals persist (Go `verdict.go:159-161`, TS `admission.ts:498`). Under TT a transfer is refused by `tm_<id>`.
- **U6. Registry list wire (G19).** Serve the token list through `/lookup` (Go would add `result` to the wire; TS cannot serve it), or only through `GET /admin/tokens`? Is `/admin/tokens` admin-gated? TT §6.6 does not say.
- **U7. Package directory.** `internal/brc162` or `internal/bsv21` (C12)?
- **U8. Allowlist error strings.** `MANDALA_TOKEN_ALLOWLIST` has no TS reference (G12). May the planner define them?

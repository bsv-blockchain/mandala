# go-overlay-services v1.3.7 engine: fact sheet (Q3 input)

Read-only survey, 2026-10-05. Every claim cites file:line. Path prefixes:

- `E/` = `/Users/personal/go/pkg/mod/github.com/bsv-blockchain/go-overlay-services@v1.3.7/pkg/core/engine/`
- `G/` = `/Users/personal/go/pkg/mod/github.com/bsv-blockchain/go-overlay-services@v1.3.7/pkg/core/gasp/`
- `A/` = `/Users/personal/go/pkg/mod/github.com/bsv-blockchain/go-overlay-services@v1.3.7/pkg/core/advertiser/`
- `SRV/` = `/Users/personal/go/pkg/mod/github.com/bsv-blockchain/go-overlay-services@v1.3.7/pkg/server/`
- `SDK/` = `/Users/personal/go/pkg/mod/github.com/bsv-blockchain/go-sdk@v1.7.1/overlay/`
- `OG/` = `/Users/personal/git/demos/mandala/overlay-go/`

Pinned versions: `OG/go.mod:6` `github.com/bsv-blockchain/go-overlay-services v1.3.7`, `OG/go.mod:7` `github.com/bsv-blockchain/go-sdk v1.7.1`. There is no `replace`.

---

## 0. Headline surprises

1. **SHIP peer discovery only works for `tm_ship` and `tm_slap`.** `expectedProtocolForTopic` knows only those two names (`E/engine.go:1062-1071`). For any other topic, `extractPeerEndpoints` logs `"unknown topic, cannot determine expected protocol"` and returns an empty set (`E/engine.go:1076-1080`). So `SyncConfigurationSHIP` on `tm_mandala` (or any per-token topic) finds zero peers and logs "No peers found ... skipping sync" (`E/engine.go:1007-1010`). For a custom topic, only `SyncConfigurationPeers` with an explicit `Peers` list can sync.
2. **Lookup-service fan-out ignores topics.** `OutputAdmittedByTopic`, `OutputSpent` and `OutputNoLongerRetainedInHistory` go to *every* registered lookup service (`E/engine.go:554-556`, `:665-669`, `:1338-1340`). `OutputBlockHeightUpdated` and `OutputEvicted` carry no topic at all (`E/lookup-service.go:58-59`). Mandala's lookup services filter on exact strings: `p.Topic != "tm_mandala"` (`OG/internal/mandala/lookup_service.go:43`, `:263`) and `p.Topic != RegistryTopic` (`OG/internal/mandala/registry_lookup.go:27`).
3. **Lookup-service errors are never swallowed.** A failing lookup service aborts Submit midway, after spends are marked and outputs inserted, and nothing is unwound (`E/engine.go:565-567`, `:675-678`, `:1340-1343`, `:1546-1549`).
4. **Ordering hazards on the legacy path.** All topics' `IdentifyAdmissibleOutputs` run first; then spends are marked and lookup services get `OutputSpent`; then the tx is broadcast; then `OnSteakReady`/`OnAdmission` fire; only then are outputs committed (`E/engine.go:369-396`). `mergeExistingOutputs` mutates the shared `p.Beef` across topics (`E/engine.go:502`), and that merged BEEF is stored for every topic (`E/engine.go:612`).
5. **The mandala node runs no GASP and no advertising, in or out.** Wiring sets no Advertiser, SyncConfiguration or trackers (`OG/internal/wiring/engine.go:272-285`). Nothing calls `StartGASPSync` or `SyncAdvertisements` (grep over `OG/` non-test code: zero hits). httpapi mounts no `/requestSyncResponse` or `/requestForeignGASPNode` route (§12).
6. **The engine has no eviction API and no topic-name validation** (§10, §11). Config fields `ErrorOnBroadcastFailure`, `BroadcastFacilitator`, `LogTime` and `LogPrefix` are stored but never read (§3).

---

## 1. TopicManager interface (`E/topic-manager.go:12-17`)

```go
type TopicManager interface {
	IdentifyAdmissibleOutputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error)
	IdentifyNeededInputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash) ([]*transaction.Outpoint, error)
	GetDocumentation() string
	GetMetaData() *overlay.MetaData
}
```

- The interface has **no mode, offChainValues or topic parameter.** The topic manager never sees `SubmitMode` or `OffChainValues`. `previousCoins` holds the *input indexes* (vin) whose source outpoints are already stored in this topic (`E/engine.go:497-507`).
- The engine passes `p.Beef.Clone()` per topic (`E/engine.go:471-472`), so TM mutations of the BEEF do not leak back.
- **GASP calls `IdentifyAdmissibleOutputs` speculatively**, without a commit afterwards: from `FindNeededInputs` (`E/gasp-storage.go:235`, error discarded `admit, _ :=`) and from `ValidateGraphAnchor` (`E/gasp-storage.go:392`). A TM with side effects in `IdentifyAdmissibleOutputs` would therefore produce them during GASP validation. Whether mandala's TM has such side effects: **UNVERIFIED** (not checked).
- `IdentifyNeededInputs` is called only by GASP (`E/gasp-storage.go:237`, `:268`), never by Submit.

`overlay.AdmittanceInstructions` (`SDK/overlay.go:63-68`):
```go
type AdmittanceInstructions struct {
	OutputsToAdmit []uint32          `json:"outputsToAdmit"`
	CoinsToRetain  []uint32          `json:"coinsToRetain"`
	CoinsRemoved   []uint32          `json:"coinsRemoved,omitempty"`
	AncillaryTxids []*chainhash.Hash `json:"ancillaryTxids,omitempty"`
}
type Steak map[string]*AdmittanceInstructions   // SDK/overlay.go:71
```
`overlay.MetaData` (`SDK/overlay.go:89-94`) has the JSON fields `name`, `shortDescription`, `iconURL`, `version` and `informationURL`.

Mandala implementers: `var _ engine.TopicManager = (*TopicManager)(nil)` (`OG/internal/mandala/topic_manager.go:88`) and `(*RegistryTopicManager)` (`OG/internal/mandala/registry_topic.go:31`).

## 2. LookupService interface and payloads (`E/lookup-service.go`)

```go
type OutputAdmittedByTopic struct {   // :14-19
	Topic          string
	OutputIndex    uint32
	AtomicBEEF     []byte
	OffChainValues []byte
}
type OutputSpent struct {             // :22-30
	Outpoint           *transaction.Outpoint
	Topic              string
	SpendingTxid       *chainhash.Hash
	InputIndex         uint32
	UnlockingScript    *script.Script
	SequenceNumber     uint32
	SpendingAtomicBEEF []byte
}
type LookupService interface {        // :33-63
	OutputAdmittedByTopic(ctx context.Context, payload *OutputAdmittedByTopic) error
	OutputSpent(ctx context.Context, payload *OutputSpent) error
	OutputNoLongerRetainedInHistory(ctx context.Context, outpoint *transaction.Outpoint, topic string) error
	OutputEvicted(ctx context.Context, outpoint *transaction.Outpoint) error
	OutputBlockHeightUpdated(ctx context.Context, txid *chainhash.Hash, blockHeight uint32, blockIndex uint64) error
	Lookup(ctx context.Context, question *lookup.LookupQuestion) (*lookup.LookupAnswer, error)
	GetDocumentation() string
	GetMetaData() *overlay.MetaData
}
```

- `OutputAdmittedByTopic` has **no Txid field**. The lookup service must derive it from `AtomicBEEF`. `AtomicBEEF` is the raw submitted bytes (`taggedBEEF.Beef`, `E/engine.go:323`), not the cross-topic-merged BEEF.
- The comments mention `admissionMode` and `spendNotificationMode` (`E/lookup-service.go:36`, `:42`), but **Go has no such modes**. The payload is always the full struct.
- `OffChainValues` is the request's `TaggedBEEF.OffChainValues`, passed unchanged (`E/engine.go:674`).
- `OutputEvicted` is **never called by the engine** (grep shows no call site in `E/`). Only mandala's own `evictTx` calls it (`OG/internal/wiring/engine.go:539`).

Lookup types (`SDK/lookup/types.go`): `AnswerTypeOutputList = "output-list"`, `AnswerTypeFreeform = "freeform"`, `AnswerTypeFormula = "formula"` (:13-15). `LookupQuestion{Service string; Query json.RawMessage}` (:25-28). `LookupFormula{Outpoint *transaction.Outpoint; History func(beef *transaction.Beef, outputIndex, currentDepth uint32) bool}` (:31-35). `LookupAnswer{Type; Outputs []*OutputListItem; Formulas []LookupFormula; Result any}` (:38-43). `OutputListItem{Beef []byte; OutputIndex uint32}` (:19-22).

## 3. Engine struct, Config, NewEngine (`E/engine.go`)

```go
type Engine struct {                       // :91-113
	managers       map[string]TopicManager   // unexported; guarded by mu
	lookupServices map[string]LookupService  // unexported; guarded by mu
	Storage                 Storage
	ChainTracker            chaintracker.ChainTracker
	HostingURL              string
	SHIPTrackers            []string
	SLAPTrackers            []string
	Broadcaster             transaction.Broadcaster
	Advertiser              advertiser.Advertiser
	SyncConfiguration       map[string]SyncConfiguration
	LogTime                 bool
	LogPrefix               string
	ErrorOnBroadcastFailure bool
	BroadcastFacilitator    topic.Facilitator
	LookupResolver          LookupResolverProvider
	OnAdmission             func(txid *chainhash.Hash, steak *overlay.Steak, beef []byte)
	mu sync.RWMutex
}
```

- `Config` (`:117-133`) has the same exported fields **minus `OnAdmission`**. It is settable only by assignment after construction.
- `NewEngine(cfg *Config) *Engine` (`:136-193`): a nil cfg becomes `&Config{}`. A nil `SyncConfiguration` becomes an empty map (`:159-161`). A nil `LookupResolver` becomes `NewLookupResolver()`, which is **mainnet** (`:162-164`, `E/lookup_resolver.go:18-19`). The constructor copies the managers and lookup services (`:167-174`). For `tm_ship`/`tm_slap` entries whose SyncConfiguration `.Type == SyncConfigurationPeers`, it merges `SHIPTrackers`/`SLAPTrackers` into `.Peers` (`:177-190`, `mergePeers` `:196-209`, map-based dedupe). This merge runs **only in NewEngine**, never in `RegisterTopicManager`.
- **Dead fields:** `ErrorOnBroadcastFailure`, `BroadcastFacilitator`, `LogTime` and `LogPrefix` have no reads in `pkg/` outside the struct, Config and NewEngine (grep). In particular, broadcast failure always fails Submit (`:579-582`), and `propagateToNetwork` builds a fresh `topic.BroadcasterConfig{}` (`:715`) that ignores `BroadcastFacilitator`.
- Constants: `DefaultGASPSyncLimit = 1000` (`:28`). `type SumbitMode string` (**sic**, `:38`). `SubmitModeHistorical SumbitMode = "historical-tx"` (`:42`). `SubmitModeCurrent SumbitMode = "current-tx"` (`:44`). `type OnSteakReady func(steak *overlay.Steak)` (`:81`).
- `LookupResolverProvider` (`:84-88`): `SLAPTrackers() []string; SetSLAPTrackers([]string); Query(ctx, *lookup.LookupQuestion) (*lookup.LookupAnswer, error)`. `SetSLAPTrackers` ignores an empty slice (`E/lookup_resolver.go:42-47`).
- `OverlayEngineProvider` contract interface (`E/contract.go:18-31`): Submit, Lookup, GetUTXOHistory, SyncAdvertisements, StartGASPSync, ProvideForeignSyncResponse, ProvideForeignGASPNode, ListTopicManagers, ListLookupServiceProviders, GetDocumentationForLookupServiceProvider, GetDocumentationForTopicManager, HandleNewMerkleProof.

### Errors (verbatim, `E/engine.go:282-309`)
`ErrUnknownTopic "unknown-topic"`, `ErrInvalidBeef "invalid-beef"`, `ErrInvalidTransaction "invalid-transaction"`, `ErrMissingInput "missing-input"`, `ErrMissingOutput "missing-output"`, `ErrInputSpent "input-spent"`, `ErrMissingDependencyTx "missing dependency transaction"`, `ErrMissingBeef "missing beef"`, `ErrUnableToFindOutput "unable to find output"`, `ErrMissingSourceTransaction "missing source transaction"`, `ErrMissingTransaction "missing transaction"`, `ErrNoDocumentationFound "no documentation found"`, `ErrInvalidMerkleProof "invalid merkle proof"`. Storage: `ErrNotFound "not-found"` (`E/storage.go:13`). `ErrInputSpent` is declared but never returned anywhere in `pkg/` (grep). The engine itself has no double-spend check.

## 4. Register / Unregister / getters (`E/engine.go:211-280`)

| Method | Lock | Line |
|---|---|---|
| `RegisterTopicManager(name string, manager TopicManager)` | `mu.Lock`, overwrites silently | :212-216 |
| `UnregisterTopicManager(name string)` | `mu.Lock`, `delete` | :219-223 |
| `GetTopicManager(name) (TopicManager, bool)` | RLock | :226-231 |
| `HasTopicManager(name) bool` | RLock | :234-239 |
| `RegisterLookupService(name string, service LookupService)` | Lock | :242-246 |
| `UnregisterLookupService(name string)` | Lock | :249-253 |
| `GetLookupService(name) (LookupService, bool)` | RLock | :256-261 |
| `HasLookupService(name) bool` | RLock | :264-269 |
| `getLookupServicesSnapshot() []LookupService` (unexported) | RLock, copies values | :272-280 |
| `ListTopicManagers() map[string]*overlay.MetaData` | RLock, calls `GetMetaData()` under lock | :1584-1592 |
| `ListLookupServiceProviders()` | RLock | :1595-1603 |
| `GetDocumentationForTopicManager(name)` / `...LookupServiceProvider` | via Get*; `ErrNoDocumentationFound` | :1606-1623 |

- Unregister does not touch storage, `SyncConfiguration` or advertisements.
- `getLookupServicesSnapshot` drops the names, so the engine cannot route by service name.
- Submit snapshots managers once at entry (`validateTopicsAndGetManagers`, `:401-414`). A concurrent Unregister after that point does not stop an in-flight submit.

## 5. Submit end to end, legacy path (the path mandala uses)

Entry `Submit(ctx, taggedBEEF overlay.TaggedBEEF, mode SumbitMode, onSteakReady OnSteakReady) (overlay.Steak, error)` (`:312-324`):
1. `transaction.ParseBeef(taggedBEEF.Beef)`. A parse error is returned raw. A nil tx returns `ErrInvalidBeef` (`:314-321`).
2. Delegates to `SubmitParsedBeef(ctx, beef, txid, topics, atomicBeef, offChainValues, mode, onSteakReady)` (exported, `:340-346`), which goes to `submitParsedBeefInternal` (`:349-398`).

`TaggedBEEF{Beef []byte; Topics []string; OffChainValues []byte}` (`SDK/overlay.go:41-45`).

`submitParsedBeefInternal` order:

| # | Step | Line(s) | Failure behaviour |
|---|---|---|---|
| 1 | `validateTopicsAndGetManagers(p.Topics)`, under RLock; **any** unknown topic means the whole submit returns `ErrUnknownTopic` | :350-353, :401-414 | returns before any I/O. **An empty topics slice passes** (loop no-op), so the steak is `{}` (UNVERIFIED end to end; the code path has no empty check) |
| 2 | `p.Beef.FindTransactionForSigningByHash(p.Txid)`; nil gives `ErrInvalidBeef` | :355-359 | |
| 3 | SPV: `spv.Verify(ctx, tx, e.ChainTracker, nil)`, **once per submit** (not per topic). An error is returned raw; `!valid` gives `ErrInvalidTransaction` | :360-362, :417-428 | |
| 4 | `steak := make(overlay.Steak, len(p.Topics))`; `buildInpoints(tx)` (vin-ordered) | :364-367, :431-440 | |
| 5 | `identifyAdmissibleOutputsPerTopic`, sequential over `p.Topics`: | :444-480 | first error aborts everything; no writes yet |
| 5a | dupe gate (legacy only): `Storage.DoesAppliedTransactionExist(&AppliedTransaction{Txid, Topic})`. If it exists: `steak[t] = &AdmittanceInstructions{}`, `dupeTopics[t]`, skip TM | :455-466 | check-then-act, no lock |
| 5b | `mergeExistingOutputs`: `Storage.FindOutputs(ctx, inpoints, topic, nil, true)`. **Relies on the result being index-aligned with inpoints** (`for vin, output := range outputs`). Merges each found output's Beef **into the shared `p.Beef`**; `previousCoins` = vins found; `topicInputs[topic][vin] = output` | :467, :483-510 | mandala's FindOutputs is aligned (`OG/internal/enginestore/enginestore.go:296`, `:331-333`) |
| 5c | `managers[t].IdentifyAdmissibleOutputs(ctx, p.Beef.Clone(), txid, previousCoins)`; `steak[t] = &admit` | :471-477 | |
| 6 | `if GetAdmissionStorage(e.Storage) != nil` → `submitWithAdmission` (§6) | :373-375 | **nil for mandala** |
| 7 | `markSpentAndNotify` per non-dupe topic: `Storage.MarkUTXOsAsSpent(topicInpoints, topic, txid)`, **all** `topicInputs[t]`, including ones the TM will retain; then `OutputSpent` to **every** lookup service per input | :377-379, :513-572 | lookup-service error returned, **no unwind** |
| 8 | `broadcastIfNeeded`: skipped if `mode == SubmitModeHistorical \|\| e.Broadcaster == nil`; `Broadcaster.Broadcast(tx)` failure is returned as the error | :381-383, :575-584 | spends from step 7 stay marked (mandala compensates; §13) |
| 9 | `p.OnSteakReady(&steak)` if non-nil | :385-387 | fires **before commit** |
| 10 | `e.OnAdmission(txid, &steak, AtomicBeef)` if `mode != Historical` and non-nil | :388-390 | fires before commit |
| 11 | `commitAdmittedOutputs` per non-dupe topic → `commitTopicOutputs`: | :392-394, :587-631 | |
| 11a | `separateRetainedCoins(inputs, admit.CoinsToRetain)` removes retained vins from `topicInputs[t]` **in place** and returns `(outputsConsumed, outpointsConsumed)` | :602, :635-660 | |
| 11b | for each **non-retained** input: `deleteUTXODeep(output)`; `admit.CoinsRemoved = append(..., vin)` (mutates the steak entry) | :604-610 | |
| 11c | `Storage.InsertOutputs(ctx, topic, txid, admit.OutputsToAdmit, outpointsConsumed, p.Beef /*merged*/, admit.AncillaryTxids)` | :612-615 | |
| 11d | `notifyAdmittedOutputs`: for each vout × **every** lookup service, `OutputAdmittedByTopic{Topic, OutputIndex: vout, AtomicBEEF, OffChainValues}` | :617-620, :663-682 | error returned; outputs already inserted |
| 11e | `updateConsumedByReferences`: for each retained output, `ConsumedBy = append(ConsumedBy, newOutpoints...)`; `Storage.UpdateConsumedBy` | :622-624, :685-694 | |
| 11f | `Storage.InsertAppliedTransaction(&AppliedTransaction{Txid, Topic})` | :626-629 | **last** write per topic, so a crash before it leaves the dupe gate open |
| 12 | `propagateToNetwork` (§9) | :396 | all errors logged and swallowed |
| 13 | return `steak` | :397 | |

`deleteUTXODeep(output)` (`:1332-1378`): if `len(ConsumedBy)==0`, then `Storage.DeleteOutput(&Outpoint, output.Topic)` and `OutputNoLongerRetainedInHistory(outpoint, topic)` to **every** lookup service (error returned). Then for each `OutputsConsumed` outpoint, it finds the stale output (`FindOutput(outpoint, &output.Topic, nil, false)`), removes this txid from its `ConsumedBy` (compared by `TxBytes()`, so per *txid*, not per outpoint), calls `UpdateConsumedBy`, and recurses. It relies on `Output.Topic` being populated; mandala's `toOutput` sets it (`OG/internal/enginestore/enginestore.go:141`, `:148`).

Multi-topic notes:
- The topic loop is over `p.Topics` as supplied. **Duplicates are not deduped on the legacy path**, so a topic listed twice runs the TM twice and commits twice. A dedupe exists only on the admission path (`E/admission_submit.go:84-91`).
- One TM error rejects all topics (`:472-476`).
- The steak has an entry for every requested topic, including dupes (empty instructions).

## 6. Admission-storage path (present in v1.3.7, NOT exercised by mandala)

Selected when `GetAdmissionStorage(e.Storage) != nil` (`E/engine.go:373`). That requires Storage to implement `AdmissionStorageProvider{ AdmissionStorage() AdmissionStorage }` returning an impl whose `AdmissionProtocol() == "overlay-admission-v1"` (`E/admission_storage.go:17`, `:313-323`, `:334-350`). `submitWithAdmission` also requires Storage to satisfy unexported `admissionHost` (Storage + `Scope()`, `PublishPayload`, `CurrentHistoryFence`, `EnsureHistoryFence`) or it returns `ErrAdmissionUnsupported` (`E/admission_submit.go:19-25`, `:35-38`).

Mandala's enginestore does **not** implement it: a grep for `AdmissionStorage|AdmissionProtocol` in `OG/` non-test code returns nothing. `OG/internal/enginestore/enginestore.go:42` asserts only `engine.Storage`.

Differences from legacy, for reference:
- no dupe gate (`E/engine.go:455`)
- broadcast **before** plan/commit (`E/admission_submit.go:39-41`)
- lookup services and propagation become **outbox intents** (`:127-138`), not synchronous calls
- `propagateToNetwork` is not called
- `OnSteakReady`/`OnAdmission` fire only after state `committed` (`:51-66`)
- errors: `ErrAdmissionPending "admission commit pending"`, `ErrAdmissionRejected "admission rejected"` (`E/admission_storage.go:24-26`)
- the PolicyID is the topic name (`E/admission_submit.go:90`)
- `AdmissionTopicDecision.Evictions` exists but is always `nil` here (`:225`)

## 7. Lookup (`E/engine.go:730-800`)

- `Lookup(ctx, question)`: `GetLookupService(question.Service)`. An unknown service returns **`ErrUnknownTopic`** (reused, `:731-735`). Freeform and output-list answers are returned as-is (`:741-743`). A formula answer is hydrated via `FindOutput(formula.Outpoint, nil /*any topic*/, nil, true)`, then `LoadAncillaryBeef`, then `GetUTXOHistory(output, formula.History, 0)`, then `AtomicBytes` (`:755-800`).
- A missing output or nil BEEF is skipped silently (`:776-778`). Any storage error fails the whole lookup (`:758-761`).

## 8. SyncAdvertisements and the Advertiser

Interface (`A/advertiser.go:26-31`):
```go
type Advertiser interface {
	CreateAdvertisements(adsData []*AdvertisementData) (overlay.TaggedBEEF, error)
	FindAllAdvertisements(protocol overlay.Protocol) ([]*Advertisement, error)
	RevokeAdvertisements(advertisements []*Advertisement) (overlay.TaggedBEEF, error)
	ParseAdvertisement(outputScript *script.Script) (*Advertisement, error)
}
type Advertisement struct { Protocol overlay.Protocol; IdentityKey, Domain, TopicOrService string; Beef []byte; OutputIndex uint32 } // :10-17
type AdvertisementData struct { Protocol overlay.Protocol; TopicOrServiceName string }                                             // :20-23
```
`overlay.ProtocolSHIP = "SHIP"`, `ProtocolSLAP = "SLAP"` (`SDK/overlay.go:18-19`). The interface methods take **no ctx**.

`SyncAdvertisements(ctx) error` (`E/engine.go:900-985`):
- returns nil immediately if `Advertiser == nil` (`:901-903`)
- under RLock, snapshots required SHIP = **all manager names** and required SLAP = **all lookup-service names**. No filter, so every registered topic gets advertised (`:905-914`).
- `FindAllAdvertisements("SHIP")`; an error is returned (`:915-919`)
- to create: topics with no ad where `TopicOrService == topic && Domain == e.HostingURL` (`:920-927`)
- to revoke: ads whose topic is not in the required set. **No Domain check on revoke**, so the advertiser's `FindAllAdvertisements` scope decides whose ads are revoked (`:928-933`).
- SLAP is handled the same way (`:935-953`)
- `CreateAdvertisements`, then `e.Submit(ctx, taggedBEEF, SubmitModeCurrent, nil)`. Errors are **logged only** (`:967-973`). Revoke goes through the same pattern (`:977-983`).
- returns nil (`:984`)

It is not called automatically anywhere in `E/` (it is in the contract interface only).

## 9. propagateToNetwork (`E/engine.go:697-727`)

- **Gated on `e.Advertiser != nil`**, not on Broadcaster. It is also skipped in historical mode (`:698-700`).
- Relevant topics are those whose steak entry has a non-nil `OutputsToAdmit` or `CoinsToRetain`, and which are not dupes (`:702-710`). Note the nil check, not a length check: a TM returning `[]uint32{}` counts as relevant.
- If `SLAPTrackers` is non-empty, it builds a resolver with those trackers (`:716-720`).
- `topic.NewBroadcaster(relevantTopics, cfg)` **requires every topic to start with `"tm_"`** (`SDK/topic/broadcaster.go:69-73`). Otherwise it errors with `topic %s must start with 'tm_'`, which is logged and swallowed (`E/engine.go:722-723`).
- `BroadcastCtx` failure is logged and swallowed (`:724-726`). This runs synchronously in the Submit call.

## 10. GASP

### Config types (`E/engine.go:48-78`)
```go
type SyncConfigurationType int
const ( SyncConfigurationPeers SyncConfigurationType = iota /*0*/; SyncConfigurationSHIP /*1*/; SyncConfigurationNone /*2*/ )
type SyncConfiguration struct { Type SyncConfigurationType; Peers []string; Concurrency int }
```
**Zero value: `Type == SyncConfigurationPeers`.** An entry with no Type set is a Peers config.

### StartGASPSync(ctx) error (`E/engine.go:988-1020`)
- one-shot and synchronous; topics run sequentially in map-iteration (random) order; peers run sequentially
- `SyncConfigurationSHIP` → `discoverSHIPPeers`. **An error there returns and aborts the remaining topics** (`:997-1002`).
- any other Type (including `None`) uses `.Peers` as-is. **`SyncConfigurationNone` is not specially skipped**: it syncs if `Peers` is non-empty (`:1003-1005`, `:1007-1017`).
- a `syncWithPeer` error returns (`:1014-1016`), but syncWithPeer only errors on `GetLastInteraction` (`:1128-1132`)

### discoverSHIPPeers (`E/engine.go:1023-1059`)
- `e.LookupResolver.SetSLAPTrackers(e.SLAPTrackers)` mutates the shared resolver on every call (`:1026`)
- query `{"topics":[topic]}` to service `"ls_ship"`, 60 s timeout (`:1029-1038`)
- a non-output-list answer gives `nil, nil` (`:1044-1047`)
- `extractPeerEndpoints` works **only for tm_ship and tm_slap** (headline 1, `:1074-1089`). Per output it parses the BEEF, then `e.Advertiser.ParseAdvertisement(lockingScript)`. **If `Advertiser == nil`, every output is dropped** (`:1108-1110`). It returns `.Domain` when the protocol matches (`:1117-1120`).
- it excludes `e.HostingURL` (`:1052-1056`)

### syncWithPeer (`E/engine.go:1124-1163`)
- `Storage.GetLastInteraction(peer, topic)` (`:1128`)
- `gasp.NewGASP(gasp.Params{Storage: NewOverlayGASPStorage(topic, e, nil /*no max nodes*/), Remote: NewOverlayGASPRemote(peer, topic, http.DefaultClient, 8), LastInteraction, LogPrefix, Unidirectional: true, Concurrency: concurrency, Topic: topic})` (`:1134-1142`)
- loop: `Sync(ctx, peer, 1000)`. **An error logs and breaks, then the function returns nil (swallowed)** (`:1148-1151`). If `LastInteraction` advanced, it calls `UpdateLastInteraction` (error logged only, `:1153-1156`); otherwise it breaks.
- `CanAdvanceGASPCursor` (`E/recovery_contract.go:108`) is **unused** (grep).

### gasp core (`G/gasp.go`)
- `MaxConcurrency = 16` (`:18`), but it is not enforced in NewGASP. The limiter is `max(Concurrency, 1)` (`:99-103`). Default `Version = 1` (`:104-108`). `NewGASP` starts a worker goroutine, so `Close()` is required (`:121`, `:522-525`).
- `Sync`: `GetInitialResponse({Version, Since: LastInteraction, Limit})`, then `HasOutputs`. It bumps `LastInteraction` to the max score **before** processing (`:159-161`). It processes unknowns via errgroup, and **one failed UTXO fails the page** (`:176-197`). The reply half runs only when `!Unidirectional` (`:199`).
- Server side: `GetInitialResponse` returns `VersionMismatchError{Code: "ERR_GASP_VERSION_MISMATCH"}` if the versions differ (`:252-257`, `G/types.go:133-140`).
- `CompleteGraph` = `ValidateGraphAnchor`, then `FinalizeGraph`, then `DiscardGraph` (`:323-338`). Dependency errors in `processIncomingNode` are logged, not returned (`:370-372`).
- Wire types (`G/types.go`): `InitialRequest{version, since, limit}` (:52-56). `Output{txid, outputIndex, score}` (:59-63). `InitialResponse{UTXOList, since}` (:66-69). `Node{graphID, rawTx(hex), outputIndex, proof, txMetadata, outputMetadata, inputs}` (:95-103). `NodeRequest{graphID, txid, outputIndex, metadata}` (`G/gasp.go:45-50`).
- `gasp.Storage` and `gasp.Remote` interfaces: `G/storage.go:10-19`, `G/remote.go:10-15`.

### Per-topic GASP storage (`E/gasp-storage.go`)
- `OverlayGASPStorage{Topic; Engine; MaxNodesInGraph *int; Logger; graphs sync.Map; submissionTracker sync.Map}` (`:77-84`). It is scoped to one topic.
- `FindKnownUTXOs` → `Storage.FindUTXOsForTopic(topic, since, limit, false)` (`:107-123`)
- `HasOutputs` → `FindOutputs(outpoints, topic, nil, false)` (`:126-139`)
- `HydrateGASPNode` uses `FindOutput(outpoint, nil /*any topic*/, ...)` (`:143`)
- the manager is looked up **per call** via `GetTopicManager(s.Topic)`, so a runtime-registered topic works. A missing one gives `ErrNoManagerForTopic "no manager for topic"` (`:43-44`, `:254-269`).
- `ValidateGraphAnchor`: SPV on the root, then a topologically-ordered TM replay (`:336-412`). `ErrGraphNoTopicalAdmittance` = `"graph did not result in topical admittance of the root node"` (`G/gasp.go:31`).
- `FinalizeGraph` → `submitBeef` per ordered BEEF → `Engine.Submit(ctx, TaggedBEEF{Topics: []string{s.Topic}, Beef}, SubmitModeHistorical, nil)` (`:433-494`). So GASP ingest means **no broadcast, no OnAdmission, no propagate**, and it runs the full legacy commit, including lookup-service notifications, with `OffChainValues == nil`.

### Remote (`E/gasp-remote.go`)
- POST `{peer}/requestSyncResponse` (`:60`) and POST `{peer}/requestForeignGASPNode` (`:142`), both with header `X-BSV-Topic: <topic>` (`:66`, `:147`)
- `GetInitialReply` and `SubmitNode` return `ErrNotImplemented "not-implemented"` (`:21`, `:191-198`), so bidirectional sync cannot work with this remote
- in-flight dedupe per outpoint (`:97-121`)

### Serving side
- `ProvideForeignSyncResponse(ctx, *gasp.InitialRequest, topic)` → `FindUTXOsForTopic(topic, req.Since, req.Limit, false)` and echoes `Since: initialRequest.Since`. There is no version check here (`E/engine.go:1237-1257`).
- `ProvideForeignGASPNode(ctx, graphID, outpoint, topic)` → `FindOutput(graphID, &topic, nil, true)` → `hydrateGASPNode`, depth capped at 1. A miss gives `ErrMissingOutput` (`:1260-1317`).
- `SyncInvalidatedOutputs(ctx, topic)`: up to 1000 invalidated outpoints; asks `SyncConfiguration[topic].Peers` (not SHIP-discovered) for a node with a proof, then `HandleNewMerkleProof` (`:1166-1234`). It is not called anywhere in `E/` or `OG/`.

## 11. Topic-name validation

- **None in `pkg/core/engine`.** Topic names are plain map keys (`:93`, `:406`).
- Only special names: `"tm_ship"`/`"tm_slap"` (`:183`, `:186`, `:1064-1067`) and `"ls_ship"` (`:1038`).
- `"tm_"` prefix is enforced only by go-sdk `topic.NewBroadcaster` (`SDK/topic/broadcaster.go:69-73`), and only reached from `propagateToNetwork` (Advertiser set).
- The library HTTP server's `TransactionTopics.Verify` rejects an empty list or a trimmed length of 0 or 1 (`SRV/internal/app/submit_transaction_service.go:65-78`). Mandala does **not** use `pkg/server`; it uses its own `httpapi.New(app)` (`OG/cmd/overlay/main.go:69`). Mandala's only check is that `X-Topics` is present and is a JSON string array (`OG/internal/httpapi/submit.go:92-99`).
- `IsValidHostingURL` exists (`E/validation.go:13`) but has **no callers** in `pkg/` (grep).

## 12. Eviction APIs

- **The Engine has no eviction method.** There is no `Evict*` in `E/engine.go`, and `OverlayEngineProvider` has none (`E/contract.go:18-31`).
- Related pieces only: `LookupService.OutputEvicted` (`E/lookup-service.go:58`, never invoked by the engine), `Storage.DeleteOutput` (`E/storage.go:32`), and `AdmissionTopicDecision.Evictions` (`E/admission_storage.go:180`, admission path only, always nil from the engine).
- Mandala builds eviction itself from its concrete stores: `evictTx` (`OG/internal/wiring/engine.go:490-566`). That covers unmarking spends, restoring token rows, `MarkEvicted`, `ls.OutputEvicted` (**ls_mandala only**, `:538-542`), `DeleteOutputsByTxid`, `DeleteAppliedTransactionsByTxid`, and the admin-history rebuild.

## 13. Concurrency guarantees

- `mu sync.RWMutex` guards **only** `managers` and `lookupServices` (`E/engine.go:111-112`). Writers: Register/Unregister (Lock). Readers: Get/Has/List/snapshot/validateTopics/SyncAdvertisements snapshot/buildAdmissionPlan (RLock, `E/admission_submit.go:130-135`).
- **Unguarded:**
  - the exported `SyncConfiguration` map, iterated in `StartGASPSync` (`:989`) and read in `SyncInvalidatedOutputs` (`:1176`)
  - `SHIPTrackers`, `SLAPTrackers`, `HostingURL`, `Advertiser`, `OnAdmission`
  - the `LookupResolver` tracker slice, which is written by `discoverSHIPPeers` on every call (`:1026`, `E/lookup_resolver.go:46`)
- **Submit has no serialization.** Two concurrent submits of the same txid can both pass the dupe gate (`:456`), which is check-then-act. Two submits spending the same input both read it via `FindOutputs(spent=nil)` (`:492`). The engine itself does not reject an already-spent input (`ErrInputSpent` is unused).
- GASP-internal concurrency: `sync.Map` per graph and per submission tracker (`E/gasp-storage.go:82-83`, `:463-477`), and `utxoProcessingMap` (`G/gasp.go:80`, `:433-457`).

## 14. Merkle-proof path (for completeness)

`HandleNewMerkleProof(ctx, txid, proof)` (`E/engine.go:1512-1552`) runs `validateMerkleProof` via `ChainTracker.IsValidRootForHeight` (`:1555-1571`), then `FindOutputsForTransaction` (all topics), then `updateMerkleProof` + `UpdateOutputBlockHeight` per output. It then calls `OutputBlockHeightUpdated(txid, height, blockIdx)` on **every** lookup service, and an error is returned. Mandala's `/arc-ingest` calls it (`OG/internal/httpapi/arcingest.go:23-27`, `:153`).

## 15. How mandala's wiring constructs the Engine

`OG/internal/wiring/engine.go:272-285`:
```go
eng := engine.NewEngine(&engine.Config{
	Managers: map[string]engine.TopicManager{
		"tm_mandala":          tm,
		mandala.RegistryTopic: rtm,      // "tm_mandala_registry" (OG/internal/mandala/registry_topic.go:15)
	},
	LookupServices: map[string]engine.LookupService{
		"ls_mandala":           ls,
		mandala.RegistryLookup: rls,     // "ls_mandala_registry" (OG/internal/mandala/registry_lookup.go:14)
	},
	Storage:      es,                  // *enginestore.Store, legacy engine.Storage only
	ChainTracker: tracker,             // arcade.NewChaintracks(...) or scriptsOnlyTracker{} (:199-209, :267-270)
	Broadcaster:  o.broadcaster,       // arcade.NewBroadcaster(...) iff ArcadeURL != "" (:191-198); else nil → broadcast skipped
	HostingURL:   cfg.HostingURL,
})
```

| Setting | Value in mandala | Evidence |
|---|---|---|
| Advertiser | **not set (nil)**, so SyncAdvertisements is a no-op, propagateToNetwork is skipped, and SHIP endpoint parsing would drop everything | `:272-285`; file doc comment "No advertiser, no GASP sync config (GASP off)" `:1-4` |
| SyncConfiguration | not set, so an empty map | `E/engine.go:159-161` |
| SHIPTrackers / SLAPTrackers | not set | `:272-285` |
| LookupResolver | not set, so the default **mainnet** resolver | `E/engine.go:162-164` |
| OnAdmission | not set | grep: no hits in `OG/` |
| Runtime Register/Unregister | never called | grep: no hits in `OG/` |
| StartGASPSync / SyncAdvertisements / SyncInvalidatedOutputs / ProvideForeign* | never called | grep: no hits in `OG/` non-test code |
| GASP HTTP routes | not mounted; routes are `/submit`, `/lookup`, `/arc-ingest`, `/admin/*`, `/health*` | `OG/internal/httpapi/submit.go:79`, `lookup.go:13`, `arcingest.go:48`, `admin.go:53-82,249-251`, `activity.go:42` |
| Engine methods used by httpapi | `Submit` (`submit.go:32-36`), `Lookup` (`server.go:27-31`), `HandleNewMerkleProof` (`arcingest.go:23-27`) | |

Compensation seams that exist **because of** the §5 ordering:
- `PrepareSubmitCompensation` snapshots token rows before Submit. On a broadcast-classified error it runs `UnmarkSpentBySpendTxid` + `restoreLiveTokenRows`, skipping if `DoesAppliedTransactionExist(txid, "tm_mandala")` is true (`OG/internal/wiring/engine.go:82-96`, `:337-398`). This is set only when Arcade is enabled (`:302-305`).
- The FIX L spend guard is `spendChecker` → `es.SpendStateOf(tokenTopic, ...)` (`:435-453`). That gives the double-spend protection the engine lacks, but it is hard-wired to `tokenTopic = "tm_mandala"` (`:34`).
- `AppliedAdmissionProof` is also hard-wired to `tokenTopic` (`:407-427`).

Hard-coded `"tm_mandala"` literals in `OG/internal` non-test code (full grep list). This matters for any per-token topic scheme:
- `OG/internal/mandala/lookup_service.go:43`, `:263` (lookup-service topic filters)
- `OG/internal/mandala/topic_manager.go:424`, `:476` (`RejectError{Topic: "tm_mandala"}`) and `:1020` (MetaData Name)
- `OG/internal/httpapi/submit.go:25` (`const tokenTopic`)
- `OG/internal/httpapi/admin.go:59` (`beefHandler`)
- `OG/internal/wiring/engine.go:34` (`const tokenTopic`), `:274` (manager registration) and `:379` (compensation dupe check)

`ErrInputSpent` is declared at `E/engine.go:294` with no other reference in `pkg/`. `LookupService.OutputEvicted` is called only by `pkg/topics/identity/lookup.go:137` (an identity lookup service calling its own method), never by the engine.

## 16. Implications for a Q3 plan (facts only, no design)

- Adding a topic at runtime: `RegisterTopicManager(name, tm)` and `RegisterLookupService(name, ls)` are lock-safe (`E/engine.go:212-246`). In-flight submits keep their snapshot (`:401-414`). The tm_ship/tm_slap tracker merge does not apply (`:176-190`).
- Every lookup service receives every topic's events, so a per-token-topic lookup service must filter on `payload.Topic` (`E/engine.go:554-571`, `:663-682`). `OutputBlockHeightUpdated` and `OutputEvicted` give no topic (`E/lookup-service.go:58-59`).
- A submit naming any unregistered topic fails entirely with `"unknown-topic"` (`E/engine.go:405-410`).
- Propagation, SHIP/SLAP advertising and SHIP-based GASP discovery are all off in mandala today (§15). If they are enabled: topic names need the `tm_` prefix (§9), SHIP discovery cannot find peers for non-`tm_ship`/`tm_slap` topics (headline 1), and the Go remote cannot do bidirectional sync (`E/gasp-remote.go:191-198`).

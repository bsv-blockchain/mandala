# Q3 facts — Go overlay HOST layer (overlay-go)

Scope: `cmd/overlay`, `internal/wiring`, `internal/httpapi`, `internal/enginestore`, the pinned engine `go-overlay-services@v1.3.7` (module cache, `~/go/pkg/mod/github.com/bsv-blockchain/go-overlay-services@v1.3.7/pkg/core/engine/`, cited as `ENG/…`), the unmerged branch `claude/go-overlay-mongodb-config-b40af0`, and how tests run.
Paths are relative to `overlay-go/` unless noted. Collected 2026-10-05 on `feat/brc162` @ 628a97c. Read-only.

## 0. Pins and repo state

- `go.mod`: `go 1.26.0`; `go-overlay-services v1.3.7`, `go-sdk v1.7.1`, `gofiber/fiber/v2 v2.52.15`, `mongo-driver/v2 v2.9.1` (go.mod:3-10).
- overlay-go is the same on `master` (bbead2e, the PR #15 merge) and `feat/brc162` HEAD: `git diff --stat master feat/brc162 -- overlay-go` is empty.
- Latest overlay-go commits: c0d326d, 8f3127d (Chronicle pre-check), 4056405 (restore snapshot merges), bd29b5d (eviction parity), e80ee93 (CompactSize).
- **overlay-go has no BRC-162 P2 machinery.** A grep for `owner.index|ownerindex|refold|reconcile.lock|submit.gate|journal|SyncConfiguration|Advertiser|StartGASPSync|SHIPTrackers|MANDALA_ISSUER_KEYS|MANDALA_TOKEN_ALLOWLIST|sync.Mutex` over non-test `internal`/`cmd` finds only the comment at internal/wiring/engine.go:4 ("No advertiser, no GASP sync config (GASP off)"). The owner index and maintenance gate exist only in TS: `overlay/src/ownerIndex.ts`, `overlay/src/maintenanceGate.ts`, `overlay/src/engineMigrations.ts`, `overlay/src/index.ts`. So the spec's "before the owner-index boot run" (docs/superpowers/specs/2026-10-05-mandala-token-topics-design.md:101) and §6.5 (spec:126) have no Go hook to attach to.

## 1. `cmd/overlay/main.go` — config and boot order

### 1.1 Boot sequence (`run()`, main.go:32-101)
1. `cfg, err := loadConfig(os.Getenv)` (main.go:33).
2. If `cfg.AdminAPIToken == ""`, log once: `"mandala overlay-go: ADMIN_API_TOKEN is not set — /admin/registry, /admin/activity and /admin/admission/:txid are UNAUTHENTICATED. Set ADMIN_API_TOKEN before any public demo."` (main.go:43-45).
3. If `cfg.ArcadeURL != "" && cfg.ArcadeCallbackToken == ""`, log once: `"mandala overlay-go: ARCADE_CALLBACK_TOKEN is not set — /arc-ingest will NOT be mounted, …"` (main.go:51-53).
4. `app, err := wiring.Build(context.Background(), cfg)`, wrapped as `fmt.Errorf("wiring.Build: %w", err)` (main.go:55-58).
5. Log `"mandala overlay-go: node=%s network=%s arcade=%s mongo_db=%s"` (main.go:64-67).
6. `fiberApp := httpapi.New(app)` (main.go:69).
7. `fiberApp.Listen(":8080")` in a goroutine. **The port is hardcoded**; there is no PORT env var (main.go:72-77).
8. Wait for SIGINT/SIGTERM (main.go:79-90), then `fiberApp.ShutdownWithContext` with `shutdownTimeout = 10 * time.Second` (main.go:24, 92-96), then `app.Mongo.Client().Disconnect` (main.go:97-99).

Nothing runs between `Build` and `Listen` apart from the log line and `httpapi.New`. There is no migration, index pass, GASP start, `SyncAdvertisements` call or registrar.

### 1.2 Env vars (`loadConfig`, main.go:124-163)
| Var | Required | Field | Notes |
|---|---|---|---|
| `NODE_NAME` | yes | `cfg.NodeName` | main.go:131 |
| `SERVER_PRIVATE_KEY` | yes | `cfg.ServerPrivKeyHex` | main.go:132 |
| `HOSTING_URL` | yes | `cfg.HostingURL` | main.go:133 |
| `MONGO_URL` | yes | `cfg.MongoURL` | main.go:134 |
| `NETWORK` | yes | `cfg.Network` | must be `"main"` or `"test"`, else `` fmt.Errorf(`NETWORK must be "main" or "test", got %q`, …) `` (main.go:144-146) |
| `ARCADE_URL` | no | `cfg.ArcadeURL` | main.go:148 |
| `ARCADE_API_KEY` | no | `cfg.ArcadeAPIKey` | main.go:149 |
| `ARCADE_CALLBACK_TOKEN` | no | `cfg.ArcadeCallbackToken` | main.go:150 |
| `CHAINTRACKS_URL` | no | `cfg.ChaintracksURL` | main.go:151 |
| `CHAINTRACKS_API_PREFIX` | no | `cfg.ChaintracksPrefix` | main.go:152 |
| `ADMIN_API_TOKEN` | no | `cfg.AdminAPIToken` | main.go:159 |
| `ADMIN_CORS_ORIGINS` | no | `cfg.AdminCORSOrigins = httpapi.ParseAdminCORSOrigins(raw, cfg.HostingURL)` | main.go:160 |

- A missing required var gives the error string `"missing required environment variable: %s"` (`requireEnv`, main.go:110-116). Vars are checked in the order of the table and the first missing one wins (main.go:127-143).
- `type envLookup func(string) string` (main.go:106) is the test seam. `cmd/overlay/main_test.go:7-21` builds `envMap` and `requiredEnv()`.
- `wiring.Config.ArcadeCallbackURL` has **no env var**. Build derives it as `TrimRight(HostingURL,"/") + "/arc-ingest"` (wiring/engine.go:193-196).
- The Mongo **db name is `cfg.NodeName + "_lookup_services"`** (wiring/engine.go:220). Any path in `MONGO_URL` (for example `/mandala`) is ignored for db selection.

## 2. `internal/wiring` — engine assembly

### 2.1 Types
- `Config` struct (wiring/engine.go:43-65): `NodeName, ServerPrivKeyHex, HostingURL, MongoURL, Network, ArcadeURL, ArcadeAPIKey, ArcadeCallbackURL, ArcadeCallbackToken, ChaintracksURL, ChaintracksPrefix string; AdminAPIToken string; AdminCORSOrigins []string`.
- `App` struct (wiring/engine.go:69-136):
  - `Engine *engine.Engine`
  - `Store *mandala.Store`
  - `EngineStore *enginestore.Store`
  - `Verifier *mandala.Verifier`
  - `Mongo *mongo.Database`
  - `ArcadeEnabled bool`
  - `ArcadeCallbackToken string`
  - `PrepareSubmitCompensation func(ctx context.Context, beef []byte) (func(context.Context) error, *mandala.RestoreSnapshot, error)` (:96)
  - `EvictTx func(ctx context.Context, txid string) (mandala.EvictionOutcome, error)` (:107)
  - `AppliedAdmissionProof func(ctx context.Context, txid string) (bool, []uint32, error)` (:114)
  - `FindRawTxs func(ctx context.Context, txids []string) (map[string]string, error)` (:120)
  - `OutputBeef func(ctx context.Context, topic, txid string, vout uint32) ([]byte, bool, error)` (:125)
  - `ServerPrivKeyHex string`, `AdminAPIToken string`, `AdminCORSOrigins []string`
- Options: `type Option func(*buildOptions)`, with `WithBroadcaster(transaction.Broadcaster)` and `WithChainTracker(chaintracker.ChainTracker)` (wiring/engine.go:139-157).
- `scriptsOnlyTracker{}` accepts every root and its `CurrentHeight` is 0 (wiring/engine.go:162-175). It is used when no tracker is injected and `ArcadeURL==""` (:267-270).
- Constants: `defaultChaintracksPrefix = "/v2"` (:30) and `tokenTopic = "tm_mandala"` (:34).

### 2.2 `Build(ctx, cfg, opts...) (*App, error)` (wiring/engine.go:185-307), in order
1. If `ArcadeURL != ""`, default the broadcaster to `arcade.NewBroadcaster(cfg.ArcadeURL, cfg.ArcadeAPIKey, callbackURL, cfg.ArcadeCallbackToken, nil)`. Default the tracker to `arcade.NewChaintracks(chaintracksURL, prefix, nil)`, where chaintracksURL defaults to `ArcadeURL+"/chaintracks"` (:191-210).
2. `mongo.Connect(options.Client().ApplyURI(cfg.MongoURL))` then `client.Ping` (:212-219). Errors are `"wiring: mongo connect: %w"` and `"wiring: mongo ping: %w"`.
3. `db := client.Database(cfg.NodeName + "_lookup_services")` (:220).
4. `mandala.NewStore(db)` creates the indexes and aborts on failure (:225-229).
5. `mandala.NewVerifier(priv)`, `mandala.NewAdminWallet(priv)` and `ec.PrivateKeyFromHex(priv)` (overlay identity) (:230-248).
6. `enginestore.New(db)` creates the indexes and aborts on failure (:249-253).
7. Construct the token topic manager (:254-257):
   ```go
   tm := mandala.NewTopicManager(verifier, adminWallet, mandala.NoSanctions{}, store).
       WithRegistry(store).
       WithSpendChecker(spendChecker(es, store)).
       WithMembershipExemptions(overlayPriv.PubKey().ToDERHex())
   ```
8. `ls := mandala.NewLookupService(verifier, store)` (:258). Then `regWallet := mandala.NewRegistryWallet(priv)`, `rtm := mandala.NewRegistryTopicManager(regWallet, store)` and `rls := mandala.NewRegistryLookupService(store)` (:259-265).
9. Managers and lookups are registered **statically**, through `engine.NewEngine(&engine.Config{…})` (:272-285):
   ```go
   Managers:       map[string]engine.TopicManager{"tm_mandala": tm, mandala.RegistryTopic: rtm},
   LookupServices: map[string]engine.LookupService{"ls_mandala": ls, mandala.RegistryLookup: rls},
   Storage: es, ChainTracker: tracker, Broadcaster: o.broadcaster, HostingURL: cfg.HostingURL,
   ```
   `SHIPTrackers`, `SLAPTrackers`, `Advertiser`, `SyncConfiguration`, `ErrorOnBroadcastFailure` and `LookupResolver` are all left at their zero values.
10. Build the `App` (:287-301). Only when `ArcadeEnabled` are `PrepareSubmitCompensation = prepareSubmitCompensation(store, es)` and `EvictTx = evictTx(es, ls, store)` set (:302-305).

Constructor signatures, all in `internal/mandala`:
- `NewTopicManager(v *Verifier, aw *AdminWallet, sp ScreeningProvider, st StateStore) *TopicManager` (topic_manager.go:91)
- `(*TopicManager).WithRegistry(r RegistryReader)` (:97)
- `WithSpendChecker(c SpendChecker)` (:439)
- `WithMembershipExemptions(keys ...string)` (:76)
- `NewLookupService(v *Verifier, store *Store) *LookupService` (lookup_service.go:36)
- `NewRegistryTopicManager(w *RegistryWallet, store RegistryChainStore)` (registry_topic.go:33)
- `NewRegistryLookupService(store *Store)` (registry_lookup.go:22)
- Constants: `RegistryTopic = "tm_mandala_registry"` (registry_topic.go:15) and `RegistryLookup = "ls_mandala_registry"` (registry_lookup.go:14).

### 2.3 Engine runtime registration API (exists, unused by wiring)
- `RegisterTopicManager(name, TopicManager)`, `UnregisterTopicManager`, `GetTopicManager`, `HasTopicManager`, `RegisterLookupService`, `UnregisterLookupService`, `GetLookupService`, `HasLookupService` (ENG/engine.go:212-270). They are guarded by `mu sync.RWMutex` (ENG/engine.go:112).
- `SyncConfiguration map[string]SyncConfiguration` is a **plain exported field with no lock** (ENG/engine.go:103). NewEngine initialises it to an empty map (ENG/engine.go:159-160).
- Other methods: `SyncAdvertisements(ctx)` (ENG/engine.go:900), `StartGASPSync(ctx)` (:988), `ListTopicManagers()` (:1584) and `ListLookupServiceProviders()` (:1595). Nothing in overlay-go calls the first two.
- Interfaces: `TopicManager{IdentifyAdmissibleOutputs, IdentifyNeededInputs, GetDocumentation, GetMetaData}` (ENG/topic-manager.go:12-17) and `LookupService` (ENG/lookup-service.go:33ff).
- Tests assert registration through `app.Engine.HasTopicManager("tm_mandala")` and `HasLookupService("ls_mandala")` (internal/wiring/engine_test.go:91-96).

### 2.4 Pinned-engine Submit ordering (why the compensation seam exists)
`Engine.Submit` (ENG/engine.go:312-324) parses the BEEF, then `submitParsedBeefInternal` (:349-398) runs:
1. `validateTopicsAndGetManagers`. **An unknown topic returns `ErrUnknownTopic` = `errors.New("unknown-topic")`** (:401-414, :284).
2. `verifyTransaction`, which is `spv.Verify` (:360, :417-428).
3. `identifyAdmissibleOutputsPerTopic` (:444-480). For each topic it runs the dupe gate `Storage.DoesAppliedTransactionExist`; on a hit it records `steak[t]=&AdmittanceInstructions{}` and adds the topic to `dupeTopics`. Then `mergeExistingOutputs` (FindOutputs on the inputs gives `previousCoins`), then `manager.IdentifyAdmissibleOutputs(ctx, beef.Clone(), txid, previousCoins)`. A manager error is returned **verbatim** (:472-476).
4. `if GetAdmissionStorage(e.Storage) != nil { return e.submitWithAdmission(...) }` (:373-375). **enginestore must never expose `AdmissionStorage()`**, because that would bypass the whole path below. This is pinned by `TestStoreDoesNotAdvertiseAdmissionStorage` (internal/enginestore/enginestore_test.go:1090-1098).
5. `markSpentAndNotify` (:377, :513-534) calls `MarkUTXOsAsSpent`, then `OutputSpent` on **every** lookup service (:553-572).
6. `broadcastIfNeeded` (:381, :575-584) returns the `*transaction.BroadcastFailure` unwrapped. `ErrorOnBroadcastFailure` is never read.
7. `commitAdmittedOutputs` → `commitTopicOutputs` (:587-631) runs `deleteUTXODeep` on the inputs, `InsertOutputs`, `notifyAdmittedOutputs` (**every** lookup service, :663-682), `updateConsumedByReferences`, then `InsertAppliedTransaction`.
8. `propagateToNetwork`, which is a no-op because `Advertiser == nil` (:697-700).

**Lookup-service fan-out is unfiltered.** Every registered lookup service receives every topic's `OutputAdmittedByTopic`/`OutputSpent` (via `getLookupServicesSnapshot`, ENG/engine.go:272-280). Each service filters for itself: `p.Topic != "tm_mandala"` (lookup_service.go:43, :263) and `p.Topic != RegistryTopic` (registry_lookup.go:27). N per-token lookup services therefore mean O(N) callbacks per admitted or spent output.

### 2.5 Compensation seam: `prepareSubmitCompensation(store, es)` (wiring/engine.go:337-398)
- Parses the BEEF. On a parse error or nil tx it returns `(nil, nil, nil)`, meaning nothing to compensate (:339-345).
- Builds `outpoints []mandala.Outpoint` and `spentOutpoints []string` (`"%s.%d"`) from inputs with a non-nil `SourceTXID` (:346-354).
- Calls `store.SnapshotTokens(ctx, outpoints)` (:355). The error is `"wiring: snapshot token rows for %s: %w"`.
- Returns `restore := &mandala.RestoreSnapshot{SpentOutpoints, TokenRows: snapshot}` together with a closure (:362-396). The closure:
  - checks `es.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: txid, Topic: "tm_mandala"})` (**literal**, :377-380). If the record exists, it logs `"wiring: skipping compensation: tx already committed (duplicate resubmit): %s"` and returns nil (:384-387);
  - otherwise runs `es.UnmarkSpentBySpendTxid(ctx, spendTxid)` then `restoreLiveTokenRows(ctx, es, store, restore)` (:388-394).
- The HTTP side calls the closure only when `arcade.IsBroadcastFailureErr(err)`, which is `errors.As(err, &*transaction.BroadcastFailure)` (internal/arcade/broadcaster.go:52-55; httpapi/submit.go:211-215).

### 2.6 `EvictTx`: `evictTx(es, ls, store)` (wiring/engine.go:490-566)
1. `rec := store.GetAdmission(txid)`. `out.AlreadyEvicted = rec != nil && rec.EvictedAt != ""` (:493-497).
2. The restore runs **before** the stamp (:508-529):
   - already evicted: nothing.
   - `rec.Restore != nil`: `UnmarkSpentBySpendTxid` sets `RestoredOutpoints`, and `restoreLiveTokenRows` sets `RestoredTokenRows`.
   - otherwise: unmark only, plus a log line.
3. `store.MarkEvicted(ctx, txid)` (:530).
4. `es.FindOutputsByTxid`, then for each outpoint `ls.OutputEvicted(ctx, op)`. **Only `ls_mandala` is notified**; `RegistryLookupService.OutputEvicted` is a no-op anyway (registry_lookup.go:68). Then `es.DeleteOutputsByTxid` and `es.DeleteAppliedTransactionsByTxid` (:534-548).
5. `rebuildThenPurgeAdminHistory(ctx, txid, evictHistoryDeps{assetsTouched: store.FindAssetsTouchedByTxid, rebuildExcluding: ls.RebuildStateExcluding, purge: store.DeleteAdminHistoryByTxid})` (:554-563, :642-656).

`restoreLiveTokenRows` (:581-610) restores a snapshot row only if `es.IsUnspent(ctx, tokenTopic, txid, vout)`. A read error is fail-closed: it returns an error, and the caller answers 503. `parseOutpoint` requires `dot == 64` (:614-628).

### 2.7 Other closures
- `appliedAdmissionProof(es)` (:407-427) runs `DoesAppliedTransactionExist{Topic: tokenTopic}` and then `es.AdmittedOutputIndexes(ctx, tokenTopic, txid)`. A non-hex txid yields `(false, nil, nil)`.
- `spendChecker(es, store)` (:435-453) calls `es.SpendStateOf(ctx, tokenTopic, txid, vout)`. If the spender's admission record has `EvictedAt != ""`, the coin counts as live (`""`). It is adapted through `spendCheckerFunc.SpentBy` (:456-460).
- `findRawTxs(es)` (:317-331) calls `es.RawTxHexByTxid` once per txid.

### 2.8 `wiring/script_rules.go`
- `CheckChronicleSighashRule(beefBytes []byte) (err error)` (script_rules.go:83-139) returns `*ChronicleSighashError{Txid string; Vin int}` with message `"script verification failed: input %d of version-1 transaction %s carries a SIGHASH_CHRONICLE signature"` (:14-21).
- It recovers from panics and returns them as `"script rules check panicked: %v"` (:84-88).
- It skips locking scripts that contain `epochDivergentOpcodes` (:143-154).

## 3. `internal/httpapi`

### 3.1 Server and routes (`server.go`)
- `New(app *wiring.App) *fiber.App` (server.go:39-60). It always applies `WithActivity`, `WithOutputBeef`, `WithAdminAPIToken`, `WithAdminCORSOrigins` and `WithAdmissionStore(app.Store, app.AppliedAdmissionProof)`. It adds `WithAdmissionSigner(NewECAdmissionSigner(priv))` when that constructor returns no error (:47-51). Only when `ArcadeEnabled` does it add `WithArcade(app.Engine, app.ArcadeCallbackToken, app.EvictTx)` and `WithBroadcastCompensation(app.PrepareSubmitCompensation)` (:52-56). The Pinger is `app.Mongo.Client().Ping` (:57-59).
- `newServer(submitter Submitter, lookuper Lookuper, store AdminStore, ping Pinger, opts ...ServerOption)` (server.go:169-209) is the test seam. `serverOptions` fields are listed at :67-81.
- `bodyLimit = 1 << 30` (:21).
- Middleware order: `corsMiddleware(adminCORSOrigins)` (:179), then the routes, then `notFoundMiddleware` last. Its 404 body is `{"status":"error","code":"ERR_ROUTE_NOT_FOUND","description":"Route not found."}` (:206, :250-256).

Route table, in registration order:

| Method / path | Handler | Gate | file:line |
|---|---|---|---|
| POST `/submit` | `submitHandler` | — | submit.go:78-80 |
| POST `/lookup` | `lookupHandler` | — | lookup.go:12-14 |
| GET `/admin/asset-state/:assetId` | `assetStateHandler` | — | admin.go:53 |
| GET `/admin/admin-history/:assetId` | `adminHistoryHandler` | — | admin.go:54 |
| GET `/admin/admin-history-page/:assetId` | `adminHistoryPageHandler` (`limit`, `offset`) | — | admin.go:55 |
| GET `/admin/admin-summary/:assetId` | `adminSummaryHandler` | — | admin.go:56 |
| GET `/admin/asset-auth/beef/:txid?vout=` | `beefHandler(beef, "tm_mandala", adminTxNotFound)` | — | admin.go:59 |
| GET `/admin/asset-auth/:assetId` | `assetAuthHandler` | — | admin.go:60 |
| GET `/admin/registry/beef/:txid?vout=` | `beefHandler(beef, mandala.RegistryTopic, registryTxNotFound)` | — | admin.go:61 |
| GET `/admin/registry` | `ListRegistry`, mounted only if the store has that method | `AdminAuthMiddleware` | admin.go:62-72 |
| GET `/admin/admission/:txid?payloadHash=` | `admissionHandler` | `AdminAuthMiddleware` | admin.go:81-83 |
| GET `/health`, `/health/live`, `/health/ready` | ok / ok / Mongo ping (2s), 503 `{"status":"error"}` | — | admin.go:248-269 |
| GET `/admin/activity?assetId&limit&before` | `activityHandler` | `AdminAuthMiddleware` | activity.go:41-43 |
| POST `/arc-ingest` | `arcIngestHandler`, mounted only if Arcade is on **and** the token is non-empty; otherwise it logs `"arc-ingest: NOT mounted — …"` | callback token | server.go:189-201; arcingest.go:47-49 |

- 404 strings: `registryTxNotFound = "registry tx not in overlay storage"`, `adminTxNotFound = "admin tx not in overlay storage"`, `assetAuthNotFound = "no admin history for this asset"` (admin.go:35-39).
- Admin GET errors use the shape 500 `{"error": err.Error()}` (`adminErrorResponse`, admin.go:284-286).
- `beefHandler` returns 200 `{beef: number[], outputIndex}`. It reads `vout` with ParseUint, and an absent or bad value means 0 (admin.go:212-240).

### 3.2 Admin auth and CORS (`admin_auth.go`, `server.go`)
- `AdminAuthMiddleware(token)` lets every request through when the token is empty. Otherwise it requires `Authorization: Bearer <token>` with a constant-time compare, and a failure returns 401 `{"error":"unauthorized"}` (admin_auth.go:41-63).
- **The narrowed-CORS set is exactly three paths:** `adminGatedPath(path) = path == "/admin/registry" || path == "/admin/activity" || strings.HasPrefix(path, "/admin/admission/")` (admin_auth.go:70-72). A new gated route such as the spec's `GET /admin/tokens` (spec:133) needs both `AdminAuthMiddleware` on the route **and** an `adminGatedPath` entry.
- `ParseAdminCORSOrigins(raw, hostingURL)` reads a comma list. Its default is `[originOf(hostingURL), "http://127.0.0.1:5173", "http://localhost:5173"]` (admin_auth.go:86-100).
- Public CORS sets `*` for allow-origin, headers, methods and expose-headers, plus `Access-Control-Allow-Private-Network: true`. OPTIONS returns 200 (server.go:220-246). Gated paths echo the allowed origin, add `Vary: Origin`, and set `Allow-Headers: Authorization, Content-Type` and `Allow-Methods: GET, OPTIONS` (:222-233).

### 3.3 POST `/submit` (`submit.go`)
- `Submitter` interface is `Submit(ctx, overlay.TaggedBEEF, engine.SumbitMode, engine.OnSteakReady) (overlay.Steak, error)` (submit.go:32-34).
- `AdmissionRecorder` interface is `GetAdmission`, `RecordAdmission(ctx, mandala.AdmissionRecord)` and `MarkRefused(ctx, mandala.Refusal)` (:42-48).
- `type AppliedAdmissionProof func(ctx, txid string) (applied bool, outputsToAdmit []uint32, err error)` (:58).
- `type PrepareSubmitCompensation func(ctx, beef []byte) (compensate func(context.Context) error, restore *mandala.RestoreSnapshot, err error)` (:76).
- `const tokenTopic = "tm_mandala"` (:25).

Handler steps (`submitHandler`, submit.go:90-263):
1. `X-Topics` must be present and a JSON `[]string`. Otherwise it returns 400 ERR_SHAPE with `"X-Topics header is required"` or `"X-Topics header must be a JSON array of strings"` (:92-99).
2. If `x-includes-off-chain-values: true`, the body is a canonical CompactSize `beefLen`, then the BEEF, then the off-chain bytes. Framing errors return 400 ERR_SHAPE `"invalid off-chain values framing: …"` (:101-117). `readVarInt` rejects non-canonical forms with `errNonCanonicalVarInt` (:474-516).
3. `payload := mandala.DecodeLinkagePayload(offChain)`. An error returns 400 ERR_SHAPE `"invalid off-chain values payload: …"`. Otherwise `ctx := mandala.WithPayload(c.UserContext(), payload)` (:119-123). The topic manager reads the payload with `mandala.PayloadFromContext(ctx)` (mandala/ctxvals.go:7-16), and the lookup service reads it from `TaggedBEEF.OffChainValues`.
4. `payloadHash := mandala.PayloadHashHex(offChain)`, which is sha256 hex of the raw bytes and sha256("") when absent (:128; admissions.go:295-298).
5. `txid, txidErr := txidFromBeef(beef)`; `tokenSubmit := slices.Contains(topics, tokenTopic)` (:134-135).
6. When `txidErr == nil && tokenSubmit`, `serveKnownVerdict` runs before any side effect (:145-149, :277-328). It reads the record in this order:
   - `EvictedAt` set: 410 ERR_EVICTED.
   - `RefusedCode` set and `RefusedPayloadHash == payloadHash`: 400 with the stored code, description and spendTxid.
   - `Admitted()`: 200 re-signed.
   - otherwise the applied proof. If applied, it finalizes the record (`Topics: []string{tokenTopic}`) and answers 200.
7. `wiring.CheckChronicleSighashRule(beef)`. An error returns 503 ERR_UNAVAILABLE and nothing is persisted (:159-161).
8. `prepare(ctx, beef)`. An error returns 503 `"broadcast-failure compensation unavailable: …"` (:168-176).
9. When `rec != nil && txidErr == nil && tokenSubmit`, the provisional record `RecordAdmission{Txid, Topics: topics, Restore: restore, Pending: true}` is written. A failure returns 503 `"provisional admission record write failed: …"` (:186-197).
10. `s.Submit(ctx, overlay.TaggedBEEF{Beef, Topics, OffChainValues: offChain}, engine.SubmitModeCurrent, nil)` (:199-203).
11. On error: compensate only if it is a broadcast failure (:211-215). Then `sv := VerdictForSubmitError(err)`. If `sv.Persistable() && rec != nil && txidErr == nil`, it calls `rec.MarkRefused(Refusal{Txid, Code, Description, SpendTxid, PayloadHash})`, and a persistence failure is only logged. It then responds `verdictResponse(c, sv.Verdict, sv.Description, sv.SpendTxid)` (:216-233).
12. On success: `admits := admittedTokenOutputs(steak)`, i.e. the canonical tm_mandala `OutputsToAdmit` (:381-387). σ_I comes from `signAdmission` (:366-376). If `len(admits) > 0`, the finalize `RecordAdmission{Txid, Topics: admittingTopics(steak), OutputsToAdmit, AdmissionSignature, AdmissionIdentityKey, Restore}` runs; a failure returns 503 `"admission record write failed: …"` (:245-259). The response is 200 `steakToWire(steak, sig, ident)` (:261).

Wire shape: `wireAdmittance{outputsToAdmit, coinsToRetain, coinsRemoved,omitempty, admissionSignature,omitempty, admissionIdentityKey,omitempty}` (submit.go:415-421). σ_I is attached only to the `tm_mandala` entry, and only when it admitted outputs (:439-442).

**"Side-channel capture" has no separate Go module.** The TS `overlay/src/submitSideChannel.ts` corresponds to three Go pieces:
- the `prepare()` snapshot (submit.go:168-176; wiring/engine.go:337-398);
- the provisional `RecordAdmission{Pending:true}` (submit.go:186-197);
- `mandala.MergeRestoreSnapshot` (admissions.go:121-163, whose comment names `mergeRestore (overlay/src/submitSideChannel.ts)`).

The manager's reject reason does not travel through a side channel either. It arrives through `errors.As(err, &*mandala.RejectError)`, because the engine returns manager errors verbatim (topic_manager.go:372-394; ENG/engine.go:472-476).

### 3.4 Verdict taxonomy (`verdict.go`)
- Codes: `ERR_CONSERVATION, ERR_LINKAGE, ERR_SHAPE, ERR_SATOSHIS, ERR_INPUT_SPENT, ERR_PAUSED, ERR_FROZEN, ERR_SANCTIONED, ERR_ACCESS, ERR_MEMBERSHIP, ERR_EVICTED, ERR_UNAVAILABLE` (verdict.go:22-35).
- `type Verdict struct{ Code string; HTTP int; Retryable bool; Final bool }` (:38-46).
- Rows (:48-61):
  - 400, retryable false, final true: conservation, linkage, shape, satoshis, inputSpent.
  - 409, retryable true, final false: paused, frozen, sanctioned, access, membership.
  - 410, retryable false, final true: evicted.
  - 503, retryable true, final false: unavailable.
- `rejectReasonTable` (the Go equivalent of TS REASON_TABLE in `overlay/src/submitVerdict.ts`). Matching is a lowercase `strings.Contains`; the first hit wins (verdict.go:95-114):
  1. `"not anchored to the asset admin chain"` → SHAPE
  2. `"conservation"` → CONSERVATION
  3. `"no verified linkage"` → LINKAGE
  4. `"linkage"` → LINKAGE
  5. `"satoshi"` → SATOSHIS
  6. `"sanctioned party"` → MEMBERSHIP
  7. `"not admitted"` → MEMBERSHIP
  8. `"membership"` → MEMBERSHIP
  9. `"paused"` → PAUSED
  10. `"frozen"` → FROZEN
  11. `"sanction"` → SANCTIONED
  12. `"access mode"` → ACCESS
  13. `"allowlist"` → ACCESS
  14. `"denylist"` → ACCESS
  15. `"spent"` → INPUT_SPENT
  - No match → SHAPE (`VerdictForRejectReason`, :119-127).
- `type SubmitVerdict struct{ Verdict Verdict; Description, SpendTxid, Topic string }` (:132-137).
- `Persistable()` is `s.Verdict.Final && s.Topic == tokenTopic && s.Verdict.Code != CodeInputSpent` (:159-161). Only tm_mandala refusals are persisted.
- `VerdictForSubmitError(err)`: a `*mandala.RejectError` maps through the table and carries `Description: rej.Error()`, `SpendTxid` and `Topic`. **Any other error is 503 ERR_UNAVAILABLE** (:166-177).
- `RejectError{Topic string; Err error; SpendTxid string}` (mandala/topic_manager.go:381-394). The token manager wraps through `reject()` (:413-425). `infraError` dependency faults pass through untyped (:402-408). The registry wraps through `registryReject` (registry_topic.go:118-121).
- **An unknown X-Topics topic answers 503 ERR_UNAVAILABLE (retryable), not 400.** `ErrUnknownTopic` ("unknown-topic", ENG/engine.go:284) is not a RejectError (verdict.go:166-177). The spec's "answer `ErrUnknownTopic`" (spec:105) therefore reaches the wire as a retryable 503.
- Error body (`verdictResponse`, verdict.go:183-195): `{status:"error", code, retryable, description, message: description, spendTxid?}`.
- `errorResponse(c, status, msg)` gives `{status:"error", message}` (submit.go:402-407). It is used by `/lookup` and `/arc-ingest`.

### 3.5 Admission σ_I (`admission.go`) and GET `/admin/admission/:txid` (`admin.go`)
- `admissionDigestPrefix = "mandala-admit:"`. `AdmissionDigestV2(txid, outs)` is `SHA-256("mandala-admit:"+txid+":"+join(canonical asc dedup, ","))`. An empty set returns `ErrNoAdmittedOutputs` (admission.go:16-54).
- `canonicalOutputs` sorts, compacts, and returns nil for an empty set (:61-68).
- `AdmissionSigner` interface: `SignAdmission(txid string, outputsToAdmit []uint32) (sigDERHex, identityKeyHex string, err error)` (:73-75).
- `ECAdmissionSigner` uses RFC6979, returns DER hex and the compressed pubkey hex (:81-114).
- `admissionHandler` (admin.go:109-157):
  - `url.PathUnescape`, lowercase, then the `^[0-9a-f]{64}$` check. A bad txid returns 400 ERR_SHAPE `"invalid txid: expected 64 hex characters, got N"`.
  - `?payloadHash=` is lowercased.
  - Record order: evicted → 410; refused with matching hash → 400; `Admitted()` → 200 `{txid, outputsToAdmit, admissionSignature, admissionIdentityKey, at}`.
  - Then the applied proof; a non-empty canonical set gives 200.
  - Otherwise 404 `{"status":"error","message":"no admission on record for <txid>"}`.

### 3.6 POST `/lookup` (`lookup.go`) and engine Lookup
- `Lookuper` interface is `Lookup(ctx, *lookup.LookupQuestion) (*lookup.LookupAnswer, error)` (server.go:27-29).
- The body `lookupRequestBody{Service string; Query json.RawMessage}` needs a non-empty service and the `query` key present. Otherwise it returns 400 `{status:"error", message:"invalid request: body must contain \"service\" (string) and \"query\" fields"}` (lookup.go:22-42).
- **Any engine error, including an unknown service, returns 400** `{status:"error", message: err.Error()}` (lookup.go:48-50). An unknown service's error text is `"unknown-topic"` (ENG/engine.go:730-735).
- `X-Aggregation` is ignored. Responses are always JSON `{type, outputs:[{beef:number[] (mandala.NumBytes), outputIndex}]}`, and nil outputs become `[]` (lookup.go:62-98).
- Engine path: `GetLookupService` → `l.Lookup`. Freeform and output-list answers are returned as-is. Formulas are hydrated with `Storage.FindOutput(outpoint, topic=nil, spent=nil, includeBEEF=true)` (**topic-agnostic**), then `LoadAncillaryBeef` and `GetUTXOHistory` (ENG/engine.go:730-800).

### 3.7 POST `/arc-ingest` (`arcingest.go`)
- `MerkleProofHandler` interface is `HandleNewMerkleProof(ctx, *chainhash.Hash, *transaction.MerklePath) error`. `type EvictTx func(ctx, txid string) (EvictionOutcome, error)`, with `EvictionOutcome = mandala.EvictionOutcome{RestoredOutpoints, RestoredTokenRows int; AlreadyEvicted bool}` (arcingest.go:23-40; admissions.go:44-55).
- The token check accepts `Authorization: Bearer <tok>` or `x-callback-token`, compared in constant time. A failure returns 401 `{status:"error", message:"Unauthorized callback"}` (arcingest.go:79-84, :207-222).
- Body `{txid, merklePath, blockHeight *int64, txStatus, extraInfo}` (:54-60). Checks:
  - missing txid → 400 `"Provider callback is missing txid"`;
  - the txid is lowercased, and anything other than 64 hex returns 400 `"Provider callback txid must be 64 hex characters"` (:86-100).
- Terminal statuses are those in `arcade.IsTerminalStatus(status, extra)`: `DOUBLE_SPEND_ATTEMPTED`, `REJECTED`, `INVALID`, `MALFORMED`, `MINED_IN_STALE_BLOCK`, or a status or extraInfo containing `ORPHAN` (arcade/broadcaster.go:24-40).
  - An evict error returns **503** `"failed to evict transaction: …"`.
  - Success returns 200 `{status:"success", message:"Terminal transaction status processed", data:{txid, txStatus, reason, restoredOutpoints, restoredTokenRows, alreadyEvicted}}`.
  - `reason = evictionReason(txStatus, extraInfo)`, trimmed and capped at 256 UTF-16 units (arcingest.go:102-136, :180-200).
- No merklePath returns 202 `"Transaction status received without proof"`. A proof goes to `HandleNewMerkleProof`; an error returns 400, and success returns 200 `"Transaction status updated"` (:138-160).

### 3.8 GET `/admin/activity` (`activity.go`)
- `ActivityLinkage{ListLinkage(ctx, limit int64, before *time.Time); FindLinkageByOutpoints(ctx, []mandala.Outpoint)}`, plus `FindRawTxsFunc` (activity.go:22-32).
- `before` must be RFC3339, otherwise 400 `{"error":"invalid before: must be an RFC3339 timestamp"}`. The handler delegates to `activity.Build` (:45-75).

## 4. `internal/enginestore` — Mongo engine.Storage

### 4.1 Collections and indexes (`New(db)`, enginestore.go:53-80)
`Store{outputs, applied, interactions *mongo.Collection}` (:36-40). Index-creation failure aborts with `"engine store: index creation failed on %s: %w"`.

| Collection | Indexes |
|---|---|
| `engineOutputs` | **unique** `{topic:1, txid:1, outputIndex:1}`; `{txid:1}`; `{topic:1, spent:1, score:1}`; `{topic:1, merkleState:1}` (:61-68) |
| `engineAppliedTransactions` | **unique** `{topic:1, txid:1}` (:69-73) |
| `engineInteractions` | **unique** `{host:1, topic:1}` (:74-78) |

Mandala-side collections live in the same db (`mandala.NewStore`, mandala/storage.go:94-161): `mandalaTokens`, `mandalaLinkageRecords`, `mandalaBalances`, `mandalaMetadata`, `mandalaAssetStates`, `mandalaAdminHistory`, `mandalaCounters`, `mandalaRegistry`, and `mandalaAdmissions` (= `AdmissionsCollection`, admissions.go:19, with a **unique** `{txid:1}` index, storage.go:153-159).

### 4.2 Output document schema (`outputDoc`, enginestore.go:90-110)
```go
type outputDoc struct {
    Topic           string        `bson:"topic"`
    Txid            string        `bson:"txid"`          // display hex
    OutputIndex     uint32        `bson:"outputIndex"`
    Spent           bool          `bson:"spent"`
    SpendTxid       string        `bson:"spendTxid,omitempty"`
    OutputsConsumed []outpointDoc `bson:"outputsConsumed,omitempty"` // {txid, index}
    ConsumedBy      []outpointDoc `bson:"consumedBy,omitempty"`
    BlockHeight     uint32        `bson:"blockHeight,omitempty"`
    BlockIdx        uint64        `bson:"blockIdx,omitempty"`
    Score           float64       `bson:"score"`
    Beef            []byte        `bson:"beef,omitempty"`   // whole submitted BEEF, inline, same bytes on every vout of the tx
    AncillaryTxids  []string      `bson:"ancillaryTxids,omitempty"`
    MerkleRoot      string        `bson:"merkleRoot,omitempty"`
    MerkleState     uint8         `bson:"merkleState"`
}
```
- `outpointDoc{Txid string `bson:"txid"`; Index uint32 `bson:"index"`}` (:83-86).
- **No locking script or satoshis field.** To read an output's script, parse `beef` and index `tx.Outputs[outputIndex]`.
- The applied-tx document is `{topic, txid}` only (:764-773). The interactions document is `{host, topic, score}` (:786-792).

### 4.3 Reading an admitted output
- `FindOutput(ctx, outpoint *transaction.Outpoint, topic *string, spent *bool, includeBEEF bool) (*engine.Output, error)` returns `(nil, nil)` when the output is absent (:271-290).
- `FindOutputs(ctx, outpoints, topic string, spent *bool, includeBEEF bool) ([]*engine.Output, error)` is **positional** and leaves nil for missing entries (:295-335).
- `FindOutputsForTransaction(ctx, txid *chainhash.Hash, includeBEEF)` covers all topics (:339-358).
- `OutputBeefBytes(ctx, topic, txid string, vout uint32) ([]byte, bool, error)` returns the raw stored BEEF, spent or not; `(nil,false,nil)` means absent or empty (:681-703).
- `AdmittedOutputIndexes(ctx, topic, txid string) ([]uint32, error)` returns indexes ascending, spent included, and `[]uint32{}` when there are none (:550-571).
- `SpendStateOf(ctx, topic, txid string, vout uint32) (string, error)` returns `""` when the coin is live **or missing** (:494-517).
- `IsUnspent(ctx, topic, txid string, vout uint32) (bool, error)` returns false when the document is missing (:525-542).
- `RawTxHexByTxid(ctx, txid string) (string, bool, error)` (:644-674).
- `toOutput(includeBEEF)` parses the BEEF only when asked (:141-183).

### 4.4 Listing unspent outputs per topic: the only ordered list
- `FindUTXOsForTopic(ctx, topic string, since float64, limit uint32, includeBEEF bool) ([]*engine.Output, error)` (:363-391).
  - Filter: `{topic, spent:false, score:{$gt: since}}`. Sort: `{score:1}`. `limit 0` means unlimited.
  - Served by the index `{topic, spent, score}` (:64).
- **Tie hazard.** `score := float64(time.Now().UnixMicro())` is computed **once per `InsertOutputs` call** and shared by every vout of that tx in that topic (:242, :245-262). Scores therefore tie across siblings, and paging with `limit` and `since = lastScore` skips the rest of a tx cut mid-page.
- There is no `(score, txid, outputIndex)` keyset method and no index for one. True keyset paging needs a new method and a compound index such as `{topic, spent, score, txid, outputIndex}`. UNVERIFIED that the spec requires stricter keyset semantics.
- `FindOutpointsByMerkleState(ctx, topic, state, limit)` has no sort (:812-841).

### 4.5 Writes and mutators
- `InsertOutputs(ctx, topic, txid *chainhash.Hash, outputs []uint32, outpointsConsumed []*transaction.Outpoint, beef *transaction.Beef, ancillaryTxids []*chainhash.Hash) error` (:225-266).
  - It is a `ReplaceOne` upsert per vout. **The replacement document has `Spent:false` and no `spendTxid`**, so re-inserting an existing outpoint resets its spent state (read directly from :245-262; no caller-path analysis done).
  - An empty `outputs` slice is a no-op.
  - `proofInfo` sets `merkleState` to Validated when the BEEF has a bump for the txid, else Unmined (:194-218).
- `MarkUTXOsAsSpent(ctx, outpoints, topic, spendTxid *chainhash.Hash) error` (:417-460) is a compare-and-swap.
  - It matches `{topic, $and:[{$or: outpoints}, {$or:[{spent:false},{spendTxid: spender}]}]}`.
  - On a shortfall it calls `UnmarkSpentBySpendTxid(spender)` and returns `"enginestore: refusing to mark inputs spent for %s: %s"`, where the detail is `"input %s.%d is already spent by %s"` or `"an input is no longer available on this topic"` (:453-488). This error is **not** a RejectError, so it answers 503.
- `UnmarkSpentBySpendTxid(ctx, spendTxid string) (int64, error)` works across **all topics**: `$set spent:false`, `$unset spendTxid`, and it returns `ModifiedCount` (:582-593).
- `FindOutputsByTxid(ctx, txid string) ([]*transaction.Outpoint, error)` is deduped by outputIndex across topics (:599-627).
- `DeleteOutputsByTxid` and `DeleteAppliedTransactionsByTxid` work across all topics (:631-634, :708-711).
- `DeleteOutput`, `UpdateConsumedBy` (wholesale), `UpdateTransactionBEEF`, `UpdateOutputBlockHeight`, `ReconcileMerkleRoot` and `LoadAncillaryBeef` (:395-398, :716-759, :849-907).
- `InsertAppliedTransaction` treats a duplicate key as success (:764-773). `DoesAppliedTransactionExist` uses `CountDocuments` with limit 1 (:776-782).
- `UpdateLastInteraction` and `GetLastInteraction` are GASP high-water marks, unused while GASP is off (:786-808).

## 5. Admission and applied records (mandala, consumed by the host)
- `AdmissionRecord` (admissions.go:66-94), bson keys: `txid, topics, outputsToAdmit, admissionSignature, admissionIdentityKey, at, refusedCode, refusedDescription, refusedSpendTxid, refusedAt, refusedPayloadHash, evictedAt, pending, restore{spentOutpoints, tokenRows}`.
- `Admitted()` is `!Pending && EvictedAt=="" && RefusedCode=="" && len(OutputsToAdmit)>0` (:98-100).
- `RecordAdmission(ctx, rec)` (:183-236) upserts with filter `{txid, evictedAt:{$exists:false}}`.
  - Provisional: adds `admissionSignature:{$exists:false}` to the filter and sets `pending:true`.
  - Finalize: sets the output and signature fields and `pending:false`, and `$unset`s all `refused*` fields.
  - `restore` is merged through `MergeRestoreSnapshot` after a read.
  - A duplicate-key error is treated as a no-op.
- `MarkRefused(ctx, Refusal{Txid, Code, Description, SpendTxid, PayloadHash})` uses filter `{txid, evictedAt:∄, admissionSignature:∄}` and treats a duplicate key as a no-op (:266-289).
- `MarkEvicted(ctx, txid)` writes the stamp once (:304-319). `IsoStamp` uses the format `"2006-01-02T15:04:05.000Z"` (:117-119).
- `TokenRow{txid, outputIndex, assetId, amount int64, identityKey, createdAt}` (mandala/storage.go:23-30).
- The "applied" record is `engineAppliedTransactions{topic, txid}` (§4.1). The FIX C proof reads it only for `tm_mandala` (wiring/engine.go:414).

## 6. Hardcoded topic-name inventory (non-test code) — what Q3 must parameterise or rename

`"tm_mandala"` / `tokenTopic`:
- internal/wiring/engine.go:34 (`const tokenTopic`), :274 (Managers map key), :379 (literal in the compensation dupe check), :414 and :421 (applied proof), :437 (spend checker), :592 (restore liveness).
- internal/httpapi/submit.go:25 (`const tokenTopic`), :135 (`tokenSubmit`), :314 (finalize topics), :354 (dupe 200 body key), :382 (`admittedTokenOutputs`), :439 (σ_I attach).
- internal/httpapi/verdict.go:160 (`Persistable`).
- internal/httpapi/admin.go:59 (asset-auth BEEF route topic).
- internal/mandala/topic_manager.go:424 and :476 (`RejectError.Topic`), :1020 (MetaData Name).
- internal/mandala/lookup_service.go:43 and :263 (topic filters).

`"ls_mandala"`:
- internal/wiring/engine.go:278 (LookupServices map key).
- internal/mandala/lookup_service.go:425 (MetaData Name).

KYC rename scope (`tm_mandala_registry` / `ls_mandala_registry`), non-test:
- Constants: registry_topic.go:15 and registry_lookup.go:14.
- **Reason strings with a `tm_mandala_registry:` prefix** (wire-visible as `description`): registry_topic.go:40, 44, 80, 91, 94, 103, 108.
- Log prefix: registry_topic.go:119.
- `ls_mandala_registry:` error prefixes: registry_lookup.go:32, 35, 39.
- Docs strings: registry_topic.go:135 and registry_lookup.go:88.
- Comments: topic_manager.go:382 and verdict.go:145.
- Uses: httpapi/admin.go:61; wiring/engine.go:264-265, 275, 279.

Test files that reference these names: mandala/registry_test.go (1), enginestore/enginestore_test.go (1), httpapi/verdict_poisoning_test.go (4), httpapi/admin_test.go (1), httpapi/verdict_test.go (3), httpapi/admission_flow_test.go (4).

Related names that may need a decision: the Mongo collection `mandalaRegistry` (mandala/storage.go:103) and the routes `/admin/registry` and `/admin/registry/beef/:txid` (admin.go:61-72). Whether the spec renames these is UNVERIFIED.

## 7. Unmerged branch `claude/go-overlay-mongodb-config-b40af0`
- Worktree: `/Users/personal/git/demos/mandala/.claude/worktrees/go-overlay-mongodb-config-b40af0`.
- Commits (author Deggen, 2026-10-03):
  - `28d94d6 chore: make Go overlay (Mongo-only) the default stack`
  - `ea9a33c docs(runbook): overlay-go compose path`
- Merge-base with master: `bbead2e`, which is master HEAD. Because overlay-go is unchanged between master and feat/brc162, the branch diff applies to the current tree as is.
- diffstat: README.md ±110, app/.env.example 4, overlay-go/Dockerfile 4, overlay-go/cmd/overlay/main.go +11/-2, **new** overlay-go/docker-compose.yml +28, overlay/docker-compose.yml -23/+6, runbook.md 4.

`main.go` change:
- Imports `ec "github.com/bsv-blockchain/go-sdk/primitives/ec"`.
- After the arcadeState block it adds:
  ```go
  // wiring.Build already parsed SERVER_PRIVATE_KEY, so this cannot fail.
  // The identity key is what app/.env VITE_OVERLAY_IDENTITY_KEY must hold.
  priv, err := ec.PrivateKeyFromHex(cfg.ServerPrivKeyHex)
  if err != nil {
      return fmt.Errorf("SERVER_PRIVATE_KEY: %w", err)
  }
  log.Printf(
      "mandala overlay-go: node=%s network=%s arcade=%s mongo_db=%s identity=%s",
      cfg.NodeName, cfg.Network, arcadeState, app.Mongo.Name(), priv.PubKey().ToDERHex(),
  )
  ```
- No other boot-order or env change.

New `overlay-go/docker-compose.yml`:
- Service `mongodb`: `image: mongo:7`, `ports: ["27017:27017"]`, `volumes: ["mongo-data:/data/db"]`.
- Service `overlay-go`: `build: .`, `env_file: .env`, `environment: MONGO_URL: mongodb://mongodb:27017/mandala`, `ports: ["8081:8080"]`, `depends_on: ["mongodb"]`, `stop_grace_period: 15s`.
- Volume `mongo-data`.
- The header comment says Mongo is the only datastore and that the boot log's `identity=` value goes in `VITE_OVERLAY_IDENTITY_KEY`.

Other changes:
- `overlay/docker-compose.yml` removes the commented-out `overlay-go` service and adds a header saying TS is the parity reference only and that both stacks use db `${NODE_NAME}_lookup_services` on port 27017, so only one should be up.
- `overlay-go/Dockerfile` changes only its comment (built by overlay-go compose and GHCR). The build stays `golang:1.26` → `CGO_ENABLED=0 go build -o /overlay ./cmd/overlay` → distroless, `EXPOSE 8080` (Dockerfile at HEAD).
- `app/.env.example` changes `VITE_OVERLAY_URL` to `http://localhost:8081` and `VITE_OVERLAY_IDENTITY_KEY=paste_identity_key_from_overlay-go_boot_log`.
- `runbook.md` adds a stack-decision banner (2026-10-03) and points the overlay-go row at `overlay-go/docker-compose.yml`.
- `overlay-go/.env.example` is **not changed** by the branch (last touched db638af). It lists the 5 required vars plus commented `ARCADE_URL`, `ARCADE_API_KEY`, `ARCADE_CALLBACK_TOKEN`, `CHAINTRACKS_URL`, `CHAINTRACKS_API_PREFIX`, `ADMIN_API_TOKEN` and `ADMIN_CORS_ORIGINS`. Its `MONGO_URL` has the path `/mandala`, which is ignored for db selection (wiring/engine.go:220). Any new Q3 var, such as `MANDALA_TOKEN_ALLOWLIST` (spec:111), would go here and in `loadConfig`.

## 8. Go tests — how they run
- **No env var and no build tag.** Every Mongo helper hardcodes `mongodb://localhost:27017`, applies a 2 s ping timeout, and calls **`t.Skip("mongo unavailable:", err)`** if the connect or the ping fails.
  - `enginestore/enginestore_test.go:33-49` `testDB` uses db `mandala_go_engine_test`, dropped before the test and in cleanup.
  - `mandala/storage_test.go:14-28` `testDB` uses db `mandala_go_test`, dropped in cleanup only.
  - `httpapi/admin_test.go:25-39` `testAdminDB` uses db `mandala_go_httpadmin_test`.
  - `wiring/engine_test.go:37-49` `requireMongo` is ping-only. Each test then calls `Build` with a unique `NodeName` (`mandala_wiring_test`, `…_arcade`, `…_arcade_override`, `…_comp`, `…_comp_dup`, `…_evict`, `…_rawtxs`, `…_evict_restore`, `…_spendguard`, `…_proof`, `…_evict_history`, `…_evict_ordering`), so the db is `<NodeName>_lookup_services`; cleanup calls `app.Mongo.Drop`. `wiring/previous_coins_test.go:71` uses db `mandala_wiring_test_previous_coins`.
- Store helpers fail on index errors: `mustStore` (storage_test.go:33-40), and `mustMandalaStore`/`mustEngineStore` (admin_test.go:45-61).
- Stub-based tests (`newServer` with stub Submitter, Lookuper and AdminStore) need no Mongo. `cmd/overlay` tests use `envMap` (main_test.go:7-21).
- Test key: `testPrivHex = "1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"` (wiring/engine_test.go:30).
- Documented commands:
  - `cd overlay-go && go test ./...`, with Mongo at localhost:27017 for the Mongo-gated packages (`docker compose -f ../overlay/docker-compose.yml up -d mongo` first). Source: docs/superpowers/plans/2026-10-01-brc162-p0-upstream-rebase.md:1187.
  - Full gate: `cd overlay-go && go build ./... && go vet ./... && go test ./...` (same plan, :1305, :1387).
  - Focused runs: `go test ./internal/<pkg> -run '<Regex>' -v`.
  - The spec asks for registrar tests under `-race` (spec:178), e.g. `go test -race ./internal/wiring`.
- Observed 2026-10-05 with Mongo up (`nc -z localhost 27017` succeeded): `go test -count=1 ./...` passed all 7 packages, EXIT 0. Timings: cmd/overlay 0.5s, activity 0.5s, arcade 0.5s, enginestore 15.1s, httpapi 22.1s, mandala 32.7s, wiring 27.9s. `go test -count=1 -v ./... | grep -c -- '--- SKIP'` returned **0**.
- **Without Mongo the suite still reports `ok`.** The gated tests skip silently, so `grep -c -- '--- SKIP'` on `-v` output is the honest check.
- Packages run in parallel under the default `-p`. Each package uses distinct db names, so there is no cross-package collision. Within a package, tests share one db unless they use a distinct `NodeName` or db name.

# overlay-go

Go port of the Mandala BSV overlay service (replaces the TS `overlay/` service).
Module path: `github.com/sirdeggen/mandala/overlay-go`.

Status: BRC-162 with Mandala token topics on one overlay (Q3). `cmd/overlay/main.go` is the entrypoint
(env config, `wiring.Build`, the boot via `App.Start`, graceful shutdown). The pinned `go-overlay-services`
engine runs three kinds of topic behind a hand-written Fiber HTTP layer that keeps the TS overlay's wire shapes:
`tm_mandala` (the token registry), one `tm_<deployTxid>` per token, and `tm_mandala_kyc` (the identity registry).
GASP, SHIP/SLAP advertising and cross-operator sync are off (design A1.1); token topics are registered in memory
by `wiring.TokenTopics` at boot and by the `/submit` deploy hook.

## Topics, routes and environment

| Topic | Lookup | Admits |
|---|---|---|
| `tm_mandala` | `ls_mandala` | Deploys only: vout 0 of a deploy by a trusted issuer with a valid deploySig. The registry record is permanent. |
| `tm_<deployTxid>` | `ls_<deployTxid>` | One token's deploy, authority and value outputs under BRC-162 layers A–D, the owner journal and §4.2a repair. |
| `tm_mandala_kyc` | `ls_mandala_kyc` | The identity registry: one authority chain that admits and revokes identities. |

A deploy is one submit naming `["tm_mandala", "tm_<own txid>"]`; any other submit naming `tm_mandala` is refused
(400 `ERR_SHAPE`). A token transaction names one `tm_<id>` per token it touches; a KYC action names
`["tm_mandala_kyc"]`. Each `tm_mandala` / `tm_<id>` STEAK entry with admitted outputs carries its own σI
(digest v3 binds the topic).

| Route | Access | Notes |
|---|---|---|
| `POST /submit` | public | Holds a maintenance-gate slot; pairing rule and deploy hook; typed verdicts; an unhosted topic answers 400 `unknown-topic: <name>`. |
| `POST /lookup` | public | Outputs only. |
| `GET /admin/tokens?limit&skip` | public | The registry list with a `hosted` flag (`limit` 1–100, `skip` 0–100000). |
| `GET /admin/authorities/:tokenId`, `/admin/asset-state/:tokenId`, `/admin/admin-history/:tokenId`, `/admin/admin-history-page/:tokenId?limit&offset`, `/admin/admin-summary/:tokenId` | public | 400 `invalid tokenId`; 404 `token not hosted`. |
| `GET /admin/authorities/beef/:txid?vout=` | public | Served only from a `tm_<id>` copy. |
| `GET /admin/registry/beef/:txid?vout=` | public | KYC registry outputs. |
| `GET /admin/registry`, `/admin/activity?tokenId&limit&before`, `/admin/admission/:txid?payloadHash=` | `ADMIN_API_TOKEN` | Narrowed CORS. |
| `POST /arc-ingest` | Arcade callback token | Mounted only with Arcade and a non-empty token. |
| `GET /health`, `/health/live`, `/health/ready` | public | Readiness includes the `mandala-owner-index` check. |

| Variable | Required | Meaning |
|---|---|---|
| `NODE_NAME` | yes | Database `<NODE_NAME>_lookup_services`. Use a fresh name (e.g. `mandala_q3`); never `mandala` or `mandala162`. |
| `SERVER_PRIVATE_KEY` | yes | The overlay key: decrypts linkage, signs σI. |
| `HOSTING_URL`, `MONGO_URL`, `NETWORK` | yes | `NETWORK` is `main` or `test`; the `MONGO_URL` path is ignored. |
| `MANDALA_ISSUER_KEYS` | yes | JSON array of trusted issuer identity keys. |
| `MANDALA_TOKEN_ALLOWLIST` | no | JSON array of deploy txids to host; unset follows every token, `[]` hosts none. |
| `PORT` | no | Listen port, default `8080`. |
| `ARCADE_*`, `CHAINTRACKS_*`, `ADMIN_API_TOKEN`, `ADMIN_CORS_ORIGINS` | no | See `.env.example`. |

## Toolchain

- Built/verified with `go1.26.0 darwin/arm64` (local toolchain).
- `go-overlay-services@v1.3.7` and `go-sdk@v1.7.1` both declare `go 1.26.0`,
  so `go.mod` declares `go 1.26.0` and the Docker builder is `golang:1.26`.
  `GOTOOLCHAIN=auto` (default) will download a matching toolchain if the local
  one is older than what a dependency requires.

## Pinned dependencies

```
github.com/bsv-blockchain/go-overlay-services v1.3.7
github.com/bsv-blockchain/go-sdk              v1.7.1
go.mongodb.org/mongo-driver/v2                v2.9.1
github.com/gofiber/fiber/v2                   v2.52.15
```

`github.com/b-open-io/overlay` (pinned at v0.3.0 in Task 1) was **dropped in
Task 12**: no published tag implements go-overlay-services v1.3.2's
`engine.Storage`, which v1.3.7 leaves unchanged (see the compatibility verdict
below), so the spec fallback
governs and `internal/enginestore` is the in-repo Mongo implementation.

`go mod tidy` is safe to run: every pinned dependency, including fiber, is a
direct import of shipped code (`internal/httpapi` imports fiber directly).

## Pinned API notes

Reconciled via `go doc` against the exact pinned versions above. These are
the signatures later tasks should code against verbatim. `TopicManager`,
`LookupService`, `Config`, `Storage` and `Output` are identical in v1.3.2 and
v1.3.7.

`Engine.Submit` builds `previousCoins` with `Storage.FindOutputs(..., spent=nil)`, so a coin another transaction
already spent is still listed. The token topic manager's conflicting-spend guard inspects exactly those coins
(`internal/wiring/previous_coins_test.go` pins it). A token topic retains only the inputs it classifies as its
own token's; the engine deletes any other previous coin of that topic (pinned in
`internal/wiring/engine_contract_test.go`).

Script rules (go-sdk v1.7.1, wire contract §11.7). go-sdk's `spv.Verify`, which
`Engine.Submit` runs, verifies every tx version under after-Chronicle rules. TS's
`Transaction.verify` treats a version ≤ 1 tx as not after-Chronicle, but it
gates opcodes only on explicit flags, which it never passes. So the engines
agree on Chronicle-only opcodes at every version. The one v1 gap is a
SIGHASH_CHRONICLE (0x20) signature: TS refuses it and go-sdk accepts it.
`internal/wiring/script_rules.go`'s `CheckChronicleSighashRule` closes that gap
before `Engine.Submit` with the same `503 ERR_UNAVAILABLE` TS gives. It re-runs
each v1 input, in the tx and in its unproven ancestors, under the pre-Chronicle
flags and refuses only on `ErrInvalidSigHashType`. It skips any input whose
locking script contains an epoch-divergent opcode (OP_SUBSTR, OP_LEFT,
OP_RIGHT, OP_LSHIFTNUM, OP_RSHIFTNUM, OP_VER, OP_VERIF, OP_VERNOTIF,
OP_2MUL, OP_2DIV) or fails to parse. A pre-Chronicle run of such a script can
take a different path and falsely refuse a tx both stacks accept. The cost of
skipping is the documented gap: Go admits a v1 SIGHASH_CHRONICLE signature in
such an input. The cells live in `testdata/chronicle_sighash_vectors.json`,
which the TS overlay's `chronicleSighashParity.test.ts` reads too. Re-check
both when bumping go-sdk.

### `engine.TopicManager` (go-overlay-services v1.3.7)

```
type TopicManager interface {
	IdentifyAdmissibleOutputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error)
	IdentifyNeededInputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash) ([]*transaction.Outpoint, error)
	GetDocumentation() string
	GetMetaData() *overlay.MetaData
}
```

### `engine.LookupService` (go-overlay-services v1.3.7)

```
type LookupService interface {
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

### `engine.Config` (go-overlay-services v1.3.7)

```
type Config struct {
	Managers                map[string]TopicManager
	LookupServices          map[string]LookupService
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
}
```

Use `NewEngine(Config)` to construct an `*Engine`.

### `Engine.Submit` (go-overlay-services v1.3.7)

```
func (e *Engine) Submit(ctx context.Context, taggedBEEF overlay.TaggedBEEF, mode SumbitMode, onSteakReady OnSteakReady) (overlay.Steak, error)
```

Note the upstream typo: `SumbitMode`, not `SubmitMode` (the type name — values
like `SubmitModeHistorical` are spelled normally).

### `overlay.TaggedBEEF` (go-sdk)

```
type TaggedBEEF struct {
	Beef           []byte
	Topics         []string
	OffChainValues []byte
}
```

### `overlay.AdmittanceInstructions` (go-sdk)

```
type AdmittanceInstructions struct {
	OutputsToAdmit []uint32
	CoinsToRetain  []uint32
	CoinsRemoved   []uint32
	AncillaryTxids []*chainhash.Hash
}
```

### `wallet.NewProtoWallet` (go-sdk)

```
func NewProtoWallet(rootKeyOrKeyDeriver ProtoWalletArgs) (*ProtoWallet, error)
```

### `wallet.ProtoWallet.Decrypt` (go-sdk)

```
func (p *ProtoWallet) Decrypt(
	ctx context.Context,
	args DecryptArgs,
	originator string,
) (*DecryptResult, error)
```

### `engine.Storage` (go-overlay-services v1.3.7) — the interface a Mongo/BEEF store must satisfy

```
type Storage interface {
	InsertOutputs(ctx context.Context, topic string, txid *chainhash.Hash, outputs []uint32, outpointsConsumed []*transaction.Outpoint, beef *transaction.Beef, ancillaryTxids []*chainhash.Hash) error
	FindOutput(ctx context.Context, outpoint *transaction.Outpoint, topic *string, spent *bool, includeBEEF bool) (*Output, error)
	FindOutputs(ctx context.Context, outpoints []*transaction.Outpoint, topic string, spent *bool, includeBEEF bool) ([]*Output, error)
	FindOutputsForTransaction(ctx context.Context, txid *chainhash.Hash, includeBEEF bool) ([]*Output, error)
	FindUTXOsForTopic(ctx context.Context, topic string, since float64, limit uint32, includeBEEF bool) ([]*Output, error)
	DeleteOutput(ctx context.Context, outpoint *transaction.Outpoint, topic string) error
	MarkUTXOsAsSpent(ctx context.Context, outpoints []*transaction.Outpoint, topic string, spendTxid *chainhash.Hash) error
	UpdateConsumedBy(ctx context.Context, outpoint *transaction.Outpoint, topic string, consumedBy []*transaction.Outpoint) error
	UpdateTransactionBEEF(ctx context.Context, txid *chainhash.Hash, beef *transaction.Beef) error
	UpdateOutputBlockHeight(ctx context.Context, outpoint *transaction.Outpoint, topic string, blockHeight uint32, blockIndex uint64) error
	InsertAppliedTransaction(ctx context.Context, tx *overlay.AppliedTransaction) error
	DoesAppliedTransactionExist(ctx context.Context, tx *overlay.AppliedTransaction) (bool, error)
	UpdateLastInteraction(ctx context.Context, host, topic string, since float64) error
	GetLastInteraction(ctx context.Context, host, topic string) (float64, error)
	FindOutpointsByMerkleState(ctx context.Context, topic string, state MerkleState, limit uint32) ([]*transaction.Outpoint, error)
	ReconcileMerkleRoot(ctx context.Context, topic string, blockHeight uint32, merkleRoot *chainhash.Hash) error
	LoadAncillaryBeef(ctx context.Context, output *Output) error
}
```

`engine.Output.Beef` (the field a `Storage`/BEEF layer must round-trip) is
typed `*transaction.Beef`, not `[]byte`. This matters for the compatibility
verdict below.

## b-open-io/overlay compatibility verdict (historical record): **NOT COMPATIBLE** (as of v0.3.0, 2026-07-07)

This section documents the Task 1 investigation that justified dropping
`b-open-io/overlay` from `go.mod` in Task 12 (see "Pinned dependencies"
above) in favor of `internal/enginestore`, an in-repo `engine.Storage`
implementation. It is kept verbatim as the record of that decision, not as a
description of the current dependency graph. It ran against the then-pinned
`v1.3.2`; the pin is now `v1.3.7`, whose `engine.Storage` and `engine.Output`
are identical, so the verdict stands.

**Verdict: `github.com/b-open-io/overlay` did NOT implement
the then-pinned `go-overlay-services@v1.3.2`'s `engine.Storage` interface, at any tag
published then (`v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0` — there is no v2.x/v3.x
line; the module has never left 0.x).** This contradicts the brief's
assumption that a `v2.x`/`v3.x` tag might resolve the mismatch — no such tags
exist. Per the brief's instruction, this is flagged rather than
improvised around: **the fallback (an in-repo Mongo `engine.Storage`
implementation) is the spec-level decision a later task needs to make.**

### How this was verified

1. `go get github.com/b-open-io/overlay@latest` resolves to `v0.3.0`.
2. `github.com/b-open-io/overlay@v0.3.0`'s own `go.mod` requires
   `github.com/bsv-blockchain/go-overlay-services v0.1.1` and additionally
   carries:
   ```
   replace github.com/bsv-blockchain/go-overlay-services => github.com/bsv-blockchain/go-overlay-services v0.1.2-0.20250808182921-aeae02752891
   ```
   i.e. b-open-io's own code was written and tested against a pre-`v0.1.2`
   snapshot of `engine.Storage` — many minor versions behind our then-pinned
   `v1.3.2` (now `v1.3.7`). **`replace` directives in a dependency's `go.mod` are ignored
   when that module is not the main module**, so in `overlay-go`'s build,
   Minimal Version Selection picks our higher pin (then `v1.3.2`, now `v1.3.7`) for the shared
   dependency — confirmed at the time via `go list -m github.com/bsv-blockchain/go-overlay-services` → `v1.3.2`. b-open-io/overlay's storage code is therefore
   compiled against an `engine.Storage` interface that has moved on since
   they wrote it.
3. Building `overlay-go` with a probe file that imports
   `github.com/b-open-io/overlay/storage` and assigns
   `*storage.MongoEventDataStorage` to an `engine.Storage`-typed variable
   surfaces two independent, stacked problems:

   **(a) A real bug in the published `v0.3.0` module itself**, unrelated to
   `engine.Storage`: `github.com/b-open-io/overlay/pubsub` fails to compile
   on its own —
   ```
   pubsub/channels.go:6:2: "time" imported and not used
   pubsub/redis.go:9:2: "time" imported and not used
   ```
   (verified: `grep -n "time\."` over both files returns zero uses). This
   bug is present in all four published tags' `pubsub` package in some form,
   and `storage/*.go` imports `pubsub` directly (`factory.go`, `mongo.go`,
   `base.go`, `sqlite.go`, `event_data.go`, `redis.go` all reference it), so
   this alone blocks `go build` for anyone who imports
   `b-open-io/overlay/storage`, before the `engine.Storage` question is even
   reached.

   **(b) A genuine `engine.Storage` interface mismatch**, visible once (a)
   is patched around locally to see past it (diagnostic only — not part of
   the pinned module):
   - `storage/event_data.go:39-40` — `EventDataStorage` embeds `engine.Storage`:
     ```go
     type EventDataStorage interface {
     	engine.Storage
     	GetBeefStorage() beef.BeefStorage
     	...
     }
     ```
   - `storage/factory.go:76,80,89,93,100` — `*RedisEventDataStorage`,
     `*MongoEventDataStorage`, `*SQLiteEventDataStorage` all fail to satisfy
     `EventDataStorage` with: **`missing method FindOutpointsByMerkleState`**
     (and, transitively, `ReconcileMerkleRoot`/`LoadAncillaryBeef` are also
     absent — these three methods were added to `engine.Storage` after
     b-open-io/overlay's last sync; confirmed absent via
     `grep -rn "FindOutpointsByMerkleState\|ReconcileMerkleRoot\|LoadAncillaryBeef" storage/*.go` → no matches).
   - `storage/mongo.go:157` — `s.beefStore.SaveBeef(ctx, &utxo.Outpoint.Txid, utxo.Beef)`
     fails to compile: `beef.BeefStorage.SaveBeef` (see `beef/{filesystem,junglebus,sqlite,redis}.go`)
     takes `beefBytes []byte`, but `utxo` is `*engine.Output` and
     `engine.Output.Beef` is typed `*transaction.Beef` in v1.3.2 and v1.3.7 (confirmed via
     `go doc .../engine Output`). Same shape of error recurs at
     `storage/mongo.go:211,238,271,305` for `LoadBeef`'s return value.
   - This same `FindOutpointsByMerkleState`/Beef-type failure pattern was
     independently confirmed by actually building against `v0.1.0`, `v0.2.0`,
     and `v0.2.1` (no local patching needed — their `pubsub` package doesn't
     block the build early the same way, so the real errors surface
     directly). All four tags fail the same way.

4. Conclusion: no published `b-open-io/overlay` tag built cleanly as an
   `engine.Storage` against the then-pinned `go-overlay-services@v1.3.2`, independent of the
   `pubsub` compile bug. At the time of this investigation, `go.mod` still
   pinned `b-open-io/overlay@v0.3.0` (the most recent tag, and the only one
   that got past the interface-shape issues once the unrelated `pubsub` bug
   was set aside) because the brief's Step 1 explicitly called for
   `@latest`, and no better-fitting tag existed — but nothing in `overlay-go`
   imported it, so it did not block `go build ./...` at the time. Task 12
   made the call this section flagged as open: it dropped
   `b-open-io/overlay` from `go.mod` entirely and wrote
   `internal/enginestore`, an in-repo `engine.Storage` implementation
   against MongoDB directly.

Constructor names kept for reference only, in case a future effort wants to
revisit b-open-io/overlay's Mongo-backed storage (e.g. against a patched
fork) instead of `internal/enginestore`:
`storage.NewMongoEventDataStorage(connString string, beefStore beef.BeefStorage, pubsub pubsub.PubSub) (*MongoEventDataStorage, error)`.
BEEF store: `beef.BeefStorage` interface (see `github.com/b-open-io/overlay/beef`),
concrete constructors include `beef.NewSQLiteBeefStorage`, `beef.NewFilesystemBeefStorage`,
`beef.NewJunglebusBeefStorage`, `beef.NewRedisBeefStorage` (signatures not
reconciled further here — moot since `internal/enginestore` already resolved
the Storage question).

## ctx-propagation verdict: **YES**

`Engine.Submit`'s `ctx` reaches `TopicManager.IdentifyAdmissibleOutputs`
unmodified — no `context.WithValue`, no `context.Background()` reset, no
derived/child context anywhere in the call chain. The exact same `ctx`
variable is threaded through every intermediate call:

```
$(go env GOMODCACHE)/github.com/bsv-blockchain/go-overlay-services@v1.3.7/pkg/core/engine/engine.go
```

(Line numbers re-checked against v1.3.7; the chain is unchanged from v1.3.2.)

- `engine.go:312` — `func (e *Engine) Submit(ctx context.Context, ...)`
- `engine.go:323` — `return e.SubmitParsedBeef(ctx, beef, txid, ...)` (same `ctx`)
- `engine.go:340` — `func (e *Engine) SubmitParsedBeef(ctx context.Context, ...)`
- `engine.go:341` — `return e.submitParsedBeefInternal(ctx, &submitParsedBeefParams{...})` (same `ctx`; note `ctx` is a separate positional arg, not a struct field)
- `engine.go:349` — `func (e *Engine) submitParsedBeefInternal(ctx context.Context, p *submitParsedBeefParams)`
- `engine.go:369` — `if err := e.identifyAdmissibleOutputsPerTopic(ctx, p, managers, inpoints, steak, topicInputs, dupeTopics); err != nil {` (same `ctx`)
- `engine.go:444-445` — `func (e *Engine) identifyAdmissibleOutputsPerTopic(ctx context.Context, p *submitParsedBeefParams, ...)`
- **`engine.go:472`** — `admit, err := managers[t].IdentifyAdmissibleOutputs(ctx, topicBeef, p.Txid, previousCoins)` — the call site, same `ctx` all the way from `Submit`.

**Decision: `ctx propagated: YES` → Task 10 uses the `context.WithValue`
strategy**, not the `sync.Map` fallback.

## Layout

```
overlay-go/
  go.mod
  cmd/overlay/main.go        — entrypoint: env config, wiring.Build, App.Start, graceful shutdown
  internal/brc162/           — generic BRC-162: TS-parity chunker, binary codec, strict CBOR, token ledger
  internal/mandala/          — Mandala policy: topics, envelope, layers B–D, managers, lookups, §6.6 store,
                                σI v3 admission record, fold/refold, reconciler, KYC registry
  internal/mandalatest/      — importable test kit: parties, BEEF/envelope builders, deploy/issue/transfer flows
  internal/maintenance/      — the shared/exclusive maintenance gate
  internal/enginestore/      — in-repo engine.Storage Mongo implementation
  internal/wiring/           — Build: engine, TokenTopics registrar, boot union, eviction, owner-index maintenance
  internal/httpapi/          — Fiber server: /submit (host rules, typed verdicts), /lookup, admin and token routes
  internal/activity/         — the /admin/activity feed
  internal/arcade/           — optional Arcade broadcaster + chaintracks client
  internal/testmongo/        — Mongo test databases (dropped before and after)
```

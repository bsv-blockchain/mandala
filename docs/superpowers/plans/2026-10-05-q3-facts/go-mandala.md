# Q3 fact sheet — Go `internal/mandala` + `internal/activity` vs BRC-162 v3 + token topics

Read-only inventory, 2026-10-05. Every claim cites `file:line`. Paths are relative to `overlay-go/internal/` unless prefixed.

## 0. Provenance

| Item | Value |
|---|---|
| mandala repo | branch `feat/brc162`, HEAD `628a97c` |
| Go deps | `go-overlay-services v1.3.7`, `go-sdk v1.7.1` (`overlay-go/go.mod:6-7`) |
| TS parity reference (code) | `overlay/node_modules/@bsv/overlay-topics` **2.0.0** and `@bsv/templates` **2.0.0** (`package.json:3` each). Cited below as `OT/<path>` = `overlay/node_modules/@bsv/overlay-topics/dist/<path>` |
| TS overlay P2 (code) | `overlay/src/*.ts` on this branch (e.g. `overlay/src/activity.ts`, commit `54fc293`) |
| Specs | `docs/superpowers/specs/2026-10-01-mandala-brc162-design.md` (= **D**), `docs/superpowers/specs/2026-10-05-mandala-token-topics-design.md` (= **TT**) |
| UNVERIFIED by construction | Anything about overlay-topics **2.1** (`MandalaRegistryTopicManager`, `createMandalaTokenTopic`, `tokenTopic()/tokenLookup()/isTokenTopic()/tokenIdOfTopic()`, `KYC_TOPIC`/`KYC_LOOKUP`, registry lookup record `{tokenId, sym, dec, label, issuer, deployTxid}`) exists only in TT §4 (TT:45-52). The installed 2.0.0 has `dist/mandala` + `dist/mandala-registry` only (no 2.1 code read). |
| Tests run | `go test ./internal/mandala -run '<pure tests>'` → 23 PASS; `go test ./internal/activity` → ok. **Mongo-backed tests NOT executed** (they connect to `mongodb://localhost:27017`, db `mandala_go_test`, and drop it — `mandala/storage_test.go:14-28`). |
| Not present yet | No `internal/brc162` or `internal/bsv21` dir (`ls overlay-go/internal` → `activity arcade enginestore httpapi mandala wiring`). |

## 1. Verdict table (the deliverable)

Legend: **keep** = reusable unchanged (comments/renames at most) · **rewrite** = file survives, contents change materially · **delete** = no v3 role. "OLD" = MandalaToken / commitment-chain admin / adminwallet / asset-auth head machinery.

| Go file | Verdict | Reason (details in §2) |
|---|---|---|
| `mandala/doc.go` | keep (edit comment) | Package doc points at Appendix A port spec (`doc.go:1-3`); v3 spec is D. |
| `mandala/ctxvals.go` | keep | Generic context carrier (`ctxvals.go:7-16`); only the carried type changes (`*LinkagePayload` → v3 envelope). |
| `mandala/adminwallet.go` | **delete** | Commitment-keyed admin key derivation `[2,"mandala admin"]` (`adminwallet.go:12-15,38-58`). D §5.1a: "`ADMIN_PROTOCOL` and `REGISTRY_PROTOCOL` are deleted" (D:277); D P3 "Delete `token.go`/`admin.go`/`adminwallet.go` commitment code" (D:496). |
| `mandala/admin.go` | **delete** (lift P2PKH-shape check) | `DecodeAdmin`/`LockAdmin` = MandalaAdmin 5/7-chunk format (`admin.go:21-81`); `Commitment` = SHA-256 of JS-canonical JSON (`admin.go:203-210`) — v3 commitment is SHA-256 of strict-CBOR detail bytes (D:101). Only the 5-op P2PKH shape test (`admin.go:41-46`) is reusable for layer B `requireP2pkhRemainder` (D:205). |
| `mandala/token.go` | **delete** (keep `maxSafeAmount` idea) | MandalaToken 8-chunk, 36-byte assetId codec (`token.go:115-184`). v3: 32-byte id / `OP_0`, optional payload, amount 0 allowed, strict push canonicality (D:69-83). `decodeScriptNumChunk` accepts forms v3 rejects (§4 surprise 2). `maxSafeAmount = 9007199254740991` (`token.go:13`) is the §3.4 cap (D:125-128). |
| `mandala/asset_auth.go` | **delete** `PickAssetAuthHead`; `AnnotateFrozenRows` → planner decision | Asset-auth head = newest admin-history row (`asset_auth.go:10-29`), replaced by `GET /admin/authorities/:tokenId` over `mandalaAuthorities` (D:346). `AnnotateFrozenRows` (`asset_auth.go:41-56`) computes `HasFrozenRow`, which TS 2.0.0 `FrozenRef` does not have (`OT/mandala/AssetStateReducer.d.ts:2-6`); still called by `httpapi/admin.go:303`. |
| `mandala/linkage.go` | **keep** | BRC-72/BRC-42 linkage verification, format-independent. TS 2.0.0 exports the same trio `verifyKeyLinkage` / `verifyInputKeyLinkage` / `linkageControlsPubKeyHash` (`OT/mandala/verifyKeyLinkage.d.ts:13,23,24`). |
| `mandala/payload.go` | **rewrite (split)** | Keep `NumBytes`, `ProtocolID`, `SpecificLinkage`, `bsonNumberToInt`, `IndexedLinkage` (`payload.go:16-187,212-215`). Rewrite `IndexedAdmin`/`LinkagePayload`/`DecodeLinkagePayload` to the v3 envelope `{inputs, outputs, admin:[{index, details:<hex>}], deploySig?}` (D:302-315; `OT/mandala/types.d.ts:12-26`). Delete `ActionDetails` map + `Kind/Str/Num` (`payload.go:189-210`) — v3 details are typed strict-CBOR (D:99-121; `OT/mandala/details.d.ts:5-18`). |
| `mandala/reducer.go` | **rewrite (same file)** | Fold semantics carry, types and several rules do not: `assetId`→`tokenId`, `IssuerIdentityKey` removed (D:369), `register` kind gone (D:119), `FrozenRef.Reason` gone, `FoldContext` = `{frozenAmount, frozenOwner}` only, lowercase normalization, freeze-if-already-frozen is a no-op in TS (`OT/mandala/AssetStateReducer.js:1-85`). See §2.9. |
| `mandala/storage.go` | **rewrite** | Collections keyed by `assetId` (`storage.go:23-60`), `InsertOne` writes (`:166,285,439`), no `mandalaOwners`/`mandalaAuthorities`, OLD admin-chain query `IsAdminOutpoint` (`:447-460`), OLD exemption `IssuerIdentityKeys` (`:415-426`). Keep patterns: index-abort discipline (`:83-161`), `RestoreTokens` `$setOnInsert` credit-once (`:264-280`), `SnapshotTokens` (`:235-256`), empty-not-nil slices, `NextAdmitSeq` (`:602-616`), eviction trio (`:465-497`). §2.11. |
| `mandala/admissions.go` | **keep** | σI admission record / verdict / eviction stamp (`admissions.go:19-333`). Wire contract §4 admission record is "unchanged from v2" (D:300), which is why `mandalaAdmissions` is **absent** from D §6.6. Ripple only: `RestoreSnapshot.TokenRows []TokenRow` (`admissions.go:34`) inherits `TokenRow`'s v3 shape. |
| `mandala/lookup_service.go` | **rewrite** | Projects OLD token/admin outputs (`lookup_service.go:59-62,116-173`), hard-codes `tm_mandala`/`ls_mandala` (`:43,263,425`), OLD `adminAssetID`/`register` (`:179-186`), `foldContext` with `Issuer` (`:192-215`). Keep: `txOrdering` (`:376-391`, same rule as `OT/mandala/ordering.js:1-8`), `splitOutpoint` (`:395-405`), `outpointAnswer` (`:359-369`), replay skeleton (`:222-258`), `OutputSpent`/`OutputEvicted` skeletons. |
| `mandala/topic_manager.go` | **rewrite** (layers A–D per D §4) | OLD: `verifiedTokenOutputs` on `DecodeToken` (`:295-327`), admin anchoring (`:335-363,511-558`), `verifyAdminOutput`+`AdminWallet` (`:494-504`), payload-declared `verifiedAdminByAsset` exemption (`:194-238`), `IssuerLister` exemption (`:69-71,939-947`), A16 freeze refusal (`:221-225,562-574`, absent from TS 2.0.0). Keep: `RejectError`/`infraError`/`reject` discipline (`:381-425`) + add `Code`; `SpendChecker`/`noConflictingSpend` (`:434-479`); `ScreeningProvider`/`NoSanctions` (`:31-39`); `RegistryReader` (`:46-49`); `WithMembershipExemptions` (`:76-86`); input helpers (`:579-624`); `accessModeRejects` (`:873-888`); stored-owner rule of `resolveSpendIdentities` (`:702-755`) **minus** its missing-row fallback (D:496). |
| `mandala/registry.go` | **rewrite** | `RegistryWallet` + `registryProtocol [2,"mandala registry"]` delete (`registry.go:32-72`; D:277). `FoldRegistry` has `register` + `issuer` fallback (`:125-153`) — gone in v3. `RegistryRow.ActionDetails` (`:29`) absent from TS 2.0.0 `list()` projection (`OT/mandala-registry/RegistryStorage.js:58-61`). `RegistryActive` counts every doc (`:89-95`) but TS stores a meta doc in the same collection (§4 surprise 3). Keep `IsAdmitted`/`UpsertRegistry`/`ListRegistry` shapes with fixes. |
| `mandala/registry_topic.go` | **rewrite** | Commitment-keyed P2PKH + `priorOutpoint` chain (`registry_topic.go:74-101`) → v3 authority deployment (layers A–C, value outputs forbidden, kinds `admitIdentity`/`revokeIdentity`, first trusted deploy wins; D:291-296). Rename topic `tm_mandala_registry` → `tm_mandala_kyc` (TT:14,50). Keep `registryReject` typing idea (`:118-121`). |
| `mandala/registry_lookup.go` | **rewrite body, keep skeleton** | Engine `LookupService` skeleton (`registry_lookup.go:16-92`) keeps; fold body changes (typed details, no `register`, separate counter `registryAdmitSeq` per `OT/mandala-registry/RegistryStorage.js:66-69`). Rename `ls_mandala_registry` → `ls_mandala_kyc` (TT:50). |
| *(new)* deploy-registry topic + lookup for `tm_mandala` / `ls_mandala` | **new file(s)** | Under TT, `tm_mandala` admits deploys only and its lookup keeps records after the deploy output is spent (TT:35, T7 TT:28, TT:47). Go `OutputSpent` deletes rows unconditionally (`lookup_service.go:262-278`), so this is new code, not a rewrite of either existing lookup. |
| *(scoping)* `topic_manager.go` / `lookup_service.go` under TT | per-token instances | Built by a factory bound to one tokenId (TT:48, TT:37); a token manager ignores other tokens' inputs/outputs and checks conservation for its own token only (TT:41). Today `conservationHolds` and `controlGatePasses` iterate every asset in the tx (`topic_manager.go:630-656,762-812`). |
| `activity/activity.go` | **rewrite (small)** | Pipeline keeps; must decode BRC-162 and **filter to value role** before classifying, rename `assetId`→`tokenId`. TS P2 already did exactly this (`overlay/src/activity.ts:88-154`). Without it every issue reads as "transfer" (§4 surprise 1). |
| `mandala/*_test.go`, `testdata/vectors.json` | per §6 | OLD-format vectors `tokenScripts/assetIds/adminScripts/commitments`; `linkage` vector carries over. |

## 2. Per-file detail

### 2.1 `mandala/doc.go` (4 lines)
- `package mandala`; comment: "ports the @bsv/overlay-topics mandala domain logic to Go … 2026-07-07-go-overlay-port-appendix-a-port-spec.md" (`doc.go:1-4`).

### 2.2 `mandala/ctxvals.go` (16 lines) — keep
- `type payloadKey struct{}` (`:5`)
- `func WithPayload(ctx context.Context, p *LinkagePayload) context.Context` (`:7`)
- `func PayloadFromContext(ctx context.Context) *LinkagePayload` (`:11`) — returns `&LinkagePayload{}` when absent/nil (`:15`).
- External caller: `httpapi/submit.go:123` (`mandala.WithPayload(c.UserContext(), payload)`); payload decoded at `httpapi/submit.go:119`.
- v3: same mechanism; carried type becomes the v3 envelope. TS decodes the envelope in the manager (`OT/mandala/types.d.ts:122-123` `decodeEnvelope`: "Absent or empty off-chain values are an empty envelope; anything malformed is `ERR_SHAPE`").

### 2.3 `mandala/adminwallet.go` (58 lines) — delete, all OLD
- `var adminProtocol = wallet.Protocol{SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty, Protocol: "mandala admin"}` (`:12-15`)
- `type AdminWallet struct { deriver *wallet.KeyDeriver }` (`:20-22`)
- `func NewAdminWallet(privHex string) (*AdminWallet, error)` (`:26`); error `"admin key: %w"` (`:29`)
- `func (w *AdminWallet) ExpectedPKH(details ActionDetails) ([20]byte, error)` (`:38`): keyID = `Commitment(details)`; counterparty = `details["counterparty"]` if string else self (`:44-51`); error `"admin counterparty: %w"` (`:48`); returns hash160 of derived pubkey (`:52-57`).
- External caller: `wiring/engine.go:235` (`mandala.NewAdminWallet(cfg.ServerPrivKeyHex)`), passed to `NewTopicManager` at `wiring/engine.go:254`.

### 2.4 `mandala/admin.go` (210 lines) — delete, all OLD
- `type AdminDecoded struct { PubKeyHash [20]byte; PublicData map[string]any }` (`:16-19`)
- `func DecodeAdmin(s *script.Script) (*AdminDecoded, error)` (`:21`): 7-chunk `<push json> OP_DROP <p2pkh>` or 5-chunk P2PKH (`:28-40`); P2PKH shape check (`:41-45`). Errors: `"not a mandala admin output"` (`:30`), `"admin publicData: %w"` (`:34`), `"not a mandala admin output: %d chunks"` (`:39`), `"not a mandala admin output: p2pkh shape"` (`:44`).
- `func LockAdmin(pubKeyHash []byte, publicData map[string]any) (*script.Script, error)` (`:54`); errors `"pubKeyHash must be 20 bytes"`, `"lock admin: …"` (`:56-79`).
- unexported `encodeJSONString` (`:89`), `encodeJSONNumber` (`:124`), `canonicalize` (`:152`); error `"commitment: unsupported type %T"` (`:198`).
- `func Commitment(details map[string]any) (string, error)` (`:203`) = hex SHA-256 of canonical JSON.
- Reusable idea only: the 5-op P2PKH check (`:41-46`: `OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG`) is D layer B `requireP2pkhRemainder` (D:205).
- External callers: none outside the package (grep).

### 2.5 `mandala/token.go` (184 lines) — delete, all OLD
- `const maxSafeAmount = int64(9007199254740991)` (`:13`)
- `type TokenDecoded struct { AssetID string; Amount int64; PubKeyHash [20]byte }` (`:15-19`)
- `func EncodeAssetID(assetID string) ([]byte, error)` (`:21`) — 36 bytes, txid reversed + LE uint32 vout (`:38-43`). Errors `"assetId missing vout: %q"`, `"assetId txid must be 64 hex chars"`, `"assetId vout: %w"`.
- `func DecodeAssetID(b []byte) (string, error)` (`:46`) → `"<txid>.<vout>"`; error `"assetId must be 36 bytes, got %d"`.
- `func decodeScriptNumChunk(op byte, data []byte) (int64, error)` (`:60`): accepts `OP_0`→0, `OP_1NEGATE`→−1, `OP_1..OP_16`, empty data→0, data ≤ 8 bytes sign-magnitude; **no minimality check**; error `"script number too large"` (`:73`).
- `func encodeScriptNum(n int64) []byte` (`:90`).
- `func DecodeToken(s *script.Script) (*TokenDecoded, error)` (`:115`): exactly 8 chunks; `<36B assetId> <amount> OP_2DROP OP_DUP OP_HASH160 <20B> OP_EQUALVERIFY OP_CHECKSIG`; amount ∈ [1, 2^53−1]. Errors `"not a mandala token: %d chunks"`, `"not a mandala token: opcode shape"`, `"not a mandala token: assetId push"`, `"invalid token amount %d"`, `"not a mandala token: pkh push"`.
- `func LockToken(assetID string, amount int64, pubKeyHash []byte) (*script.Script, error)` (`:150`); errors `"pubKeyHash must be 20 bytes"`, `"amount out of range"`.
- External callers: `activity/activity.go:223,388` (`mandala.DecodeToken`).
- v3 replacement (D §3.1, D:69-83): `<push id32 | OP_0> <push amount | OP_0> OP_2DROP [<push DAG-CBOR> OP_DROP] <P2PKH>`; id = 32 bytes natural order, direct push opcode `0x20` only; amount 0 = `OP_0`, 1–16 = `OP_1..OP_16`, else direct push `0x01..0x09` minimal LE; reject `OP_1NEGATE`, data-push of small numbers, `PUSHDATA*` for id/amount; payload must use minimal push for its length. Token id string `<txid>_0` (D:74). D P3 places the codec in `internal/brc162` (D:169,188) **or** `internal/bsv21` (D:496) — see §7 Q1.

### 2.6 `mandala/payload.go` (237 lines) — rewrite (split)
Reusable unchanged:
- `type NumBytes []byte` (`:16`) + `UnmarshalJSON` (`:18`), `MarshalJSON` (`:34`), `MarshalBSONValue` → BSON array of int32 (`:44-54`), `UnmarshalBSONValue` accepts array of any numeric, binary, null/undefined (`:60-93`). Errors `"byte out of range: %d"`, `"numBytes[%d]: …"`, `"numBytes: unsupported bson type %v"`.
- `func bsonNumberToInt(v any) (int, error)` (`:97`) — int32/int64/float64/float32. Reusable for D §6.6 "Go writes float64 and reads int32, int64 or double" (D:358).
- `type ProtocolID struct { SecurityLevel int; Name string }` (`:117-120`) + JSON 2-tuple (`:122-138`) + BSON 2-element array (`:143-176`). Errors `"protocolID must be a 2-element array, got %d"`, `"protocolID: expected bson array, got %v"`, `"protocolID[1]: expected string, got %T"`.
- `type SpecificLinkage struct` (`:178-187`): `Prover` `prover`, `Verifier` `verifier`, `Counterparty` `counterparty`, `ProtocolID` `protocolID`, `KeyID` `keyID`, `EncryptedLinkage NumBytes` `encryptedLinkage`, `EncryptedLinkageProof NumBytes` `encryptedLinkageProof`, `ProofType int` `proofType` (bson == json tags). Matches TS `SpecificLinkage` (`OT/mandala/types.d.ts:1-10`).
- `type IndexedLinkage struct { Index uint32 \`json:"index"\`; Linkage *SpecificLinkage \`json:"linkage"\` }` (`:212-215`).
OLD / rewrite:
- `type ActionDetails map[string]any` (`:189`), `Kind()` (`:191`), `Str(key)` (`:196`), `Num(key)` integral float64 within ±2^53−1 (`:201-210`). v3 details are strict-CBOR bytes, typed per kind (D:99-121); TS `AdminDetails{kind, bankRef?: number[], outpoint?: "<txid>.<vout>", recipient?: hex, identityKey?: hex, mode?, feeRatePerKb?: number|null, reason?}` (`OT/mandala/details.d.ts:5-18`), `decodeAdminDetails(detailsHex, allowed, outputIndex) → {details, commitment}` (`:24-27`).
- `type IndexedAdmin struct { Index uint32 \`json:"index"\`; ActionDetails ActionDetails \`json:"actionDetails"\` }` (`:217-220`) → v3 `{index, details: "<hex DAG-CBOR>"}` (D:308; `OT/mandala/types.d.ts:21-24`).
- `type LinkagePayload struct { Inputs []IndexedLinkage \`json:"inputs"\`; Outputs []IndexedLinkage \`json:"outputs"\`; Admin []IndexedAdmin \`json:"admin,omitempty"\` }` (`:222-226`) → add `deploySig` (DER hex, present iff output 0 is a deploy; D:309,315).
- `func DecodeLinkagePayload(b []byte) (*LinkagePayload, error)` (`:228`): empty → `&LinkagePayload{}`; plain `json.Unmarshal` (unknown fields ignored, duplicate indices accepted); error `"linkage payload: %w"`. v3 requires unique non-negative safe-integer indices (D:313) and malformed → `ERR_SHAPE` (`OT/mandala/types.d.ts:122`). TS reason `Reasons.envelope(detail)` (`OT/mandala/reject.d.ts:46`).
- External callers: `httpapi/submit.go:119` (`DecodeLinkagePayload`), `httpapi/lookup.go:63,89` (`NumBytes` for BEEF bytes).

### 2.7 `mandala/linkage.go` (163 lines) — keep
- `type Verifier struct { pw *wallet.ProtoWallet; identity string }` (`:16-19`)
- `func NewVerifier(privHex string) (*Verifier, error)` (`:22`); error `"verifier key: %w"`.
- `func (v *Verifier) IdentityKey() string` (`:38`)
- `func (v *Verifier) VerifyKeyLinkage(ctx context.Context, l *SpecificLinkage) (string, []byte, error)` (`:50`) → `(l.Counterparty, hash160(counterparty + (L mod n)·G))`. Wrapper protocol `[2, "specific linkage revelation <level> <name>"]`, keyID `l.KeyID`, counterparty = prover (`:58-73`).
- `func (v *Verifier) VerifyInputLinkage(ctx context.Context, l *SpecificLinkage) (string, []byte, error)` (`:102`) → `(l.Prover, hash160(prover + L·G))`.
- `func (v *Verifier) linkageOffset(...) (*big.Int, error)` (`:122`) — same decrypt as `:58-75` (duplicated code).
- `func (v *Verifier) LinkageControlsPKH(ctx context.Context, l *SpecificLinkage, pkh []byte) bool` (`:150`) — **no non-test caller** (grep).
- Errors: `"nil linkage"`, `"prover key: %w"`, `"linkage decrypt: %w"`, `"counterparty key: %w"`.
- v3 needs from it: output owner (layer B `verifyOutputLinkage`, D:208), input corroboration prover + L·G == source pkh (D:209), and `l.Prover` for the trusted-issuer check (D:241) — all available. TS returns `{identityKey, derivedKey, pubKeyHash}` (`OT/mandala/verifyKeyLinkage.d.ts:3-7`); Go returns no derived key (not needed by any v3 rule read).
- External callers: `wiring/engine.go:230` (`NewVerifier`), `wiring/engine.go:77` (`App.Verifier`).

### 2.8 `mandala/asset_auth.go` (56 lines)
- `func PickAssetAuthHead(rows []AdminHistoryEntry) (AdminHistoryEntry, bool)` (`:10`) + `later` (`:21-29`) — OLD (A10 head by `(height, offset, admitSeq)`). Caller `httpapi/admin.go:197` (`/admin/asset-auth/:assetId`). v3 route `GET /admin/authorities/:tokenId → {tokenId, authorities:[{outpoint, identityKey, height?}]}` (D:346). **delete**.
- `type TokenRowReader interface { GetTokenRow(ctx, txid string, vout uint32) (*TokenRow, error) }` (`:33-35`)
- `func AnnotateFrozenRows(ctx context.Context, st AssetAdminState, rows TokenRowReader) (AssetAdminState, error)` (`:41`) — sets `FrozenRef.HasFrozenRow` per request. Caller `httpapi/admin.go:303`. v3 TS has no such field (`OT/mandala/AssetStateReducer.d.ts:2-6`) → §7 Q4.

### 2.9 `mandala/reducer.go` (141 lines) — rewrite in place
Go today:
- `type FrozenRef struct { Outpoint string \`json:"outpoint" bson:"outpoint"\`; Amount int64 \`…"amount"\`; Owner string \`…"owner"\`; Reason string \`…"reason"\`; HasFrozenRow bool \`json:"hasFrozenRow" bson:"-"\` }` (`:3-12`)
- `type AssetAdminState struct` (`:14-31`): `AssetID "assetId"`, `IssuerIdentityKey "issuerIdentityKey"`, `IsPaused "isPaused"`, `AccessMode "accessMode"`, `FeeRatePerKb *int64 "feeRatePerKb"` (no omitempty on purpose, `:19-23`), `BlockedIdentities`, `AllowedIdentities`, `FrozenOutpoints []FrozenRef`, `EvictedOutpoints []string`, `LastProcessedHeight int64`, `LastProcessedOffset int64`, `LastAdmitSeq int64` (bson == json names).
- `type FoldContext struct { Issuer string; FrozenAmount int64; FrozenOwner string; HasFrozenRow bool }` (`:33-38`)
- `func DefaultAssetState(assetID string) AssetAdminState` (`:40`) — `accessMode:"denylist"`, empty non-nil slices.
- helpers `uniqueAppend` (`:48`), `remove` (`:58`), `removeFrozen` (`:68`), `feeRateOf` (`:82`).
- `func FoldAction(prev AssetAdminState, details ActionDetails, ctx FoldContext) AssetAdminState` (`:90`). Kinds: `register` (sets issuer + fee rate, `:93-97`), `setFeeRate`, `pause`, `unpause`, `blockIdentity`, `unblockIdentity`, `allowIdentity`, `unallowIdentity`, `setAccessMode`, `freezeOutput` (**replaces** an existing ref, `:124-129`), `unfreezeOutput`, `reissue` (unfreeze + add to evicted, `:134-138`).
TS 2.0.0 v3 reducer (`OT/mandala/AssetStateReducer.js`):
- `defaultAssetState(tokenId, feeRatePerKb = null)` (`:1-13`) — fee rate seeded from the deploy payload (lookup `indexDeploy`, `OT/mandala/MandalaLookupService.js:210-216`).
- Lowercases identity keys and outpoints (`:14-24`); Go compares case-sensitively (`reducer.go:48-76`).
- `freezeOutput`: no-op if already frozen (`:51-52`); stores `{outpoint, amount: ctx.frozenAmount ?? 0, owner: lower(ctx.frozenOwner ?? '')}` — no `reason`.
- `setFeeRate`: `s.feeRatePerKb = d.feeRatePerKb` when defined (`:74-77`) (null clears).
- No `register`; `issue`/`redeem`/registry kinds have no handler (`:29-31`).
- `FoldContext { frozenAmount?, frozenOwner? }` (`OT/mandala/AssetStateReducer.d.ts:23-26`).
- History rows persist `frozenAmount`/`frozenOwner` for refold (D:370; `OT/mandala/MandalaLookupService.js:262-275`).

### 2.10 `mandala/admissions.go` (333 lines) — keep
- `const AdmissionsCollection = "mandalaAdmissions"` (`:19`)
- `type RestoreSnapshot struct { SpentOutpoints []string \`bson:"spentOutpoints" json:"spentOutpoints"\`; TokenRows []TokenRow \`bson:"tokenRows" json:"tokenRows"\` }` (`:26-35`)
- `type EvictionOutcome struct { RestoredOutpoints int \`json:"restoredOutpoints"\`; RestoredTokenRows int \`json:"restoredTokenRows"\`; AlreadyEvicted bool \`json:"alreadyEvicted"\` }` (`:44-55`)
- `type AdmissionRecord struct` (`:66-94`): `Txid "txid"`, `Topics []string "topics"`, `OutputsToAdmit []uint32 "outputsToAdmit"`, `AdmissionSignature "admissionSignature"`, `AdmissionIdentityKey "admissionIdentityKey"`, `At "at"`, `RefusedCode "refusedCode,omitempty"`, `RefusedDescription "refusedDescription,omitempty"`, `RefusedSpendTxid "refusedSpendTxid,omitempty"`, `RefusedAt "refusedAt,omitempty"`, `RefusedPayloadHash "refusedPayloadHash,omitempty"`, `EvictedAt "evictedAt,omitempty"`, `Pending bool "pending,omitempty"`, `Restore *RestoreSnapshot "restore,omitempty"`.
- `func (r *AdmissionRecord) Admitted() bool` (`:98`)
- `type Refusal struct { Txid, Code, Description, SpendTxid, PayloadHash string }` (`:106-112`)
- `func IsoStamp(t time.Time) string` (`:117`) — `"2006-01-02T15:04:05.000Z"`.
- `func MergeRestoreSnapshot(existing, incoming *RestoreSnapshot) *RestoreSnapshot` (`:134`)
- `func (s *Store) RecordAdmission(ctx context.Context, rec AdmissionRecord) error` (`:183`) — filter `{txid, evictedAt:{$exists:false}}` (+ `admissionSignature:{$exists:false}` when pending); finalize `$unset`s refusal fields; dup-key → nil (`:187-235`).
- `func (s *Store) GetAdmission(ctx context.Context, txid string) (*AdmissionRecord, error)` (`:239`)
- `func (s *Store) MarkRefused(ctx context.Context, r Refusal) error` (`:266`) — filter excludes evicted/admitted.
- `func PayloadHashHex(offChainValues []byte) string` (`:295`)
- `func (s *Store) MarkEvicted(ctx context.Context, txid string) error` (`:304`)
- v3/TT touch points: (a) `Topics` is already a list → multi-topic STEAK fits; TT §9 puts σI per `tm_<id>` entry (TT:151) — single `AdmissionSignature` field per txid cannot hold two σI (§7 Q6). (b) `TokenRows` shape follows `TokenRow` rename. (c) `RefusedCode` will come from typed `Code` instead of the substring table (D:328).

### 2.11 `mandala/storage.go` (620 lines) — rewrite
Types:
- `Outpoint { Txid "txid"; OutputIndex uint32 "outputIndex" }` (`:17-20`) — keep.
- `TokenRow { Txid "txid"; OutputIndex uint32 "outputIndex"; AssetID "assetId"; Amount int64 "amount"; IdentityKey "identityKey"; CreatedAt time.Time "createdAt" }` (`:23-30`) — no json tags (embedded in `RestoreSnapshot` JSON as Go field names, UNVERIFIED whether any client reads them).
- `LinkageRow { Txid; OutputIndex; IdentityKey; Linkage SpecificLinkage "linkage"; CreatedAt }` (`:34-40`) — keep.
- `MetadataRow { Txid; OutputIndex; AssetID "assetId" }` (`:43-47`) — OLD shape.
- `AdminHistoryEntry { AssetID "assetId"; Txid; OutputIndex; Height int64; Offset int64; AdmitSeq int64; ActionDetails ActionDetails "actionDetails"; CreatedAt }` (`:51-60`) — OLD shape.
- `balanceRecord { IdentityKey; Balance int64 }` (`:63-66`); `counterDoc { ID "_id"; Seq int64 "seq" }` (`:69-72`).
- `type Store struct { tokens, linkage, balances, metadata, states, history, counters, registry, admissions *mongo.Collection }` (`:76-81`).
Constructor: `func NewStore(db *mongo.Database) (*Store, error)` (`:94`) — any index failure aborts (`:87-93`, error `"mandala store: index creation failed on %s: %w"`).
Methods (signature · write semantics · non-package callers · v3 fate):

| Method | Line | Semantics | External callers | v3 |
|---|---|---|---|---|
| `StoreToken(ctx, r TokenRow) error` | 165 | `InsertOne` | — | → `storeTokenIfAbsent` (`$setOnInsert`, returns inserted; `OT/mandala/MandalaStorageManager.js:124-128`) |
| `GetTokenRow(ctx, txid, vout) (*TokenRow, error)` | 170 | nil,nil on miss | `httpapi/admin.go:21` (iface) | keep |
| `DeleteToken(ctx, txid, vout) error` | 182 | `DeleteOne` | — | → `takeToken` (`findOneAndDelete`, `OT/…:130-133`) so debit happens once |
| `FindByAssetID(ctx, assetID) ([]Outpoint, error)` | 187 | filters `EvictedOutpoints` in Go | — | → `findTokensByTokenId(tokenId, limit, skip)` with server-side `$nor` (`OT/…:135-164`) |
| `FindByOutpoint(ctx, txid, vout) ([]Outpoint, error)` | 214 | projection | — | keep |
| `SnapshotTokens(ctx, []Outpoint) ([]TokenRow, error)` | 235 | `$or`, empty short-circuit | `wiring/engine.go:337-362` (prepareSubmitCompensation) | keep (+ authorities? §7 Q7) |
| `RestoreTokens(ctx, []TokenRow) error` | 264 | `$setOnInsert` upsert, credit on insert | `wiring/engine.go:606` | keep |
| `StoreLinkage(ctx, LinkageRow) error` | 284 | `InsertOne` | — | → upsert `$set` by `(txid, outputIndex)` (`OT/…:232-235`) |
| `GetLinkageRow` | 289 | — | **none** (dead) | keep/drop |
| `ListLinkage(ctx, limit int64, before *time.Time) ([]LinkageRow, error)` | 301 | sort `createdAt:-1`, `$lte` | `activity`, `httpapi/activity.go:23` | keep |
| `FindLinkageByOutpoints(ctx, []Outpoint) ([]LinkageRow, error)` | 321 | `$or` | `activity`, `httpapi/activity.go:24` | keep |
| `AdjustBalance(ctx, identityKey, delta int64) error` | 346 | `$inc` upsert | — | keep |
| `GetBalance` | 354 | — | **none** (dead) | keep |
| `StoreMetadata(ctx, MetadataRow) error` | 368 | upsert by outpoint | — | → by `tokenId`, decoded deploy payload (`OT/…:236-239`) |
| `FindMetadataByAssetID` | 376 | — | — | → `findMetadata(tokenId)` |
| `DeleteMetadata(ctx, txid, vout)` | 392 | — | — | → `deleteMetadata(tokenId)` |
| `GetAssetState(ctx, assetID) (AssetAdminState, error)` | 399 | default on miss | `httpapi/admin.go:20` | keep (tokenId) |
| `IssuerIdentityKeys(ctx) ([]string, error)` | 415 | `Distinct issuerIdentityKey` | — (TM via `IssuerLister`) | **delete** (D:259) |
| `PutAssetState(ctx, AssetAdminState) error` | 428 | `$set` upsert | — | keep + add `putAssetStateIfAbsent` (`OT/…:259-263`) |
| `AppendAdminHistory(ctx, AdminHistoryEntry) error` | 438 | `InsertOne` | — | → `$setOnInsert` by `(tokenId, txid, outputIndex)`, returns inserted (`OT/…:269-273`) |
| `IsAdminOutpoint(ctx, assetID, txid, vout) (bool, error)` | 447 | — | — (TM `StateStore`) | **delete** (OLD anchoring) |
| `FindAssetsTouchedByTxid(ctx, txid) ([]string, error)` | 465 | `Distinct assetId` sorted | `wiring/engine.go:555` | keep → `tokensTouchedBy` (`OT/…:291-294`) |
| `FindAdminHistoryByAssetIDExcluding(ctx, assetID, txid)` | 484 | `txid $ne` | — (LS) | keep (tokenId) |
| `DeleteAdminHistoryByTxid(ctx, txid) error` | 494 | `DeleteMany` | `wiring/engine.go:560` | keep |
| `FindAdminHistoryByAssetID(ctx, assetID)` | 499 | sort `(height, offset, admitSeq)` | `httpapi/admin.go:22` | keep (tokenId) |
| `PageAdminHistory(ctx, assetID, limit, offset int64)` | 522 | sort `admitSeq:-1`, clamp [1,500] default 100 | `httpapi/admin.go:23` | keep; TS 2.0.0 pages in fold order instead (`OT/…:275-284`) — §7 Q5 |
| `AdminSummary(ctx, assetID) (totalIssued, totalRedeemed, actionCount int64, err error)` | 560 | dedup by `(txid,outputIndex)` then sum `actionDetails.amount` per kind | `httpapi/admin.go` | **rewrite**: v3 sums `delta` (`totalIssued` = Σ positive, `totalRedeemed` = Σ |negative|, D:348); dedup only needed while writes are `InsertOne` |
| `NextAdmitSeq(ctx) (int64, error)` | 602 | counter `_id:"admitSeq"` | — | keep |
| `fmtOutpoint(txid, vout) string` | 618 | `"%s.%d"` | — | keep; add a **separate** `tokenIdString` (D:74) |

Missing in Go, present in TS 2.0.0 (`OT/mandala/MandalaStorageManager.js`): `recordOwners` (`:99-110`, bulk `$setOnInsert`, unordered), `getOwnerJournal(txid, outputIndex, topic)` (`:111-114`), `circulatingSupply(tokenId)` bigint (`:149-158`), `liveTokenFilter` (`:160-164`), `getAuthorityRow`/`storeAuthorityIfAbsent`/`takeAuthority`/`listAuthorities(topic, tokenId)` (`:166-185`), `repairOwnerRow`/`repairTokenRow`/`repairAuthorityRow` (`:194-221`), `tokenIdsWithHistory()` (`:286-289`), `putAssetStateIfAbsent` (`:259-263`).

### 2.12 `mandala/lookup_service.go` (428 lines) — rewrite
- `const maxSafeHeight = int64(9007199254740991)` (`:22`)
- `type LookupService struct { verifier *Verifier; store *Store }` (`:28-31`); `func NewLookupService(v *Verifier, store *Store) *LookupService` (`:36`)
- `OutputAdmittedByTopic(ctx, p *engine.OutputAdmittedByTopic) error` (`:42`): ignores topics ≠ `"tm_mandala"` (`:43`); `DecodeToken` → `indexTokenOutput`, else `indexAdminOutput` (`:59-62`). Errors `"ls_mandala: parse beef: %w"`, `"ls_mandala: atomic tx not found in beef"`, `"ls_mandala: output index %d out of range"`.
- `indexTokenOutput` (`:70-108`): token row written even with no identity (`IdentityKey:""`, `:87-95`); credit + linkage only with verified identity. Error `"ls_mandala: output %d linkage verification: %w"`.
- `indexAdminOutput` (`:116-173`): metadata keyed by the admin output's own outpoint when publicData present (`:121-127`); history append + fold with `NextAdmitSeq` (`:147-172`).
- `adminAssetID` (`:179-186`) — `register` is its own genesis. OLD.
- `foldContext` (`:192-215`) — reads `issuer`, frozen token row. OLD inputs.
- `RebuildState(ctx, assetID) (AssetAdminState, error)` (`:222`) — no non-test caller; `RebuildStateExcluding(ctx, assetID, txid)` (`:233`) — caller `wiring/engine.go:557`; `replayState` (`:242-258`).
- `OutputSpent(ctx, p *engine.OutputSpent) error` (`:262`): debit + `DeleteToken` (not atomic take).
- `OutputEvicted(ctx, outpoint *transaction.Outpoint) error` (`:282`): deletes token + metadata row by outpoint, no balance adjust (`:287-290`). Caller `wiring/engine.go:539`.
- `OutputNoLongerRetainedInHistory`, `OutputBlockHeightUpdated` no-ops (`:295-303`).
- `type lookupQuery struct { MetadataAssetID "metadataAssetId"; AssetID "assetId"; Txid "txid"; OutputIndex *uint32 "outputIndex" }` (`:307-312`).
- `Lookup` (`:321-353`) serves only outpoint-shaped queries; errors `"Unsupported query"`, `"ls_mandala: invalid query: %w"`. Deliberately does not serve asset-state/admin-history via `/lookup` (`:314-320`).
- `outpointAnswer` (`:359-369`) — `lookup.AnswerTypeFormula`.
- `txOrdering(tx, txid) (height, offset int64)` (`:376-391`) — identical rule to TS (`OT/mandala/ordering.js:1-8`). keep.
- `splitOutpoint(s) (txid string, vout uint32, ok bool)` (`:395-405`) — keep.
- `GetDocumentation` (`:409`), `GetMetaData` name `"ls_mandala"` (`:423-428`).
TS 2.0.0 v3 lookup (`OT/mandala/MandalaLookupService.js`): query keys in dispatch order `metadataTokenId`, `assetStateTokenId`, `adminHistoryTokenId`, `authoritiesTokenId`, `tokenId`, plus `txid`/`outputIndex`/`limit`/`skip` (`:30-55`); admit handler runs `recordAction`, `indexDeploy`, `indexOwner` via `everyStep` (all run, first fault rethrown; `:141-153`); owner = journal if it agrees with the script, else linkage (`:155-167`); **linkage record stored for every admitted token output, any role** (`:172-188`); authority/deploy → `mandalaAuthorities`, value → `mandalaTokens` + credit on insert (`:189-208`); deploy → metadata + `putAssetStateIfAbsent(defaultAssetState(tokenId, feeRatePerKb))` (`:210-216`).

### 2.13 `mandala/topic_manager.go` (1023 lines) — rewrite as layers A–D
Interfaces / types:
- `type StateStore interface { GetAssetState(ctx, assetID string) (AssetAdminState, error); GetTokenRow(ctx, txid string, vout uint32) (*TokenRow, error); IsAdminOutpoint(ctx, assetID, txid string, vout uint32) (bool, error) }` (`:20-28`) — drop `IsAdminOutpoint`; add owner-journal/authority/repair reads.
- `type ScreeningProvider interface { IsSanctioned(ctx, identityKey string) (bool, error) }` (`:31-33`); `type NoSanctions struct{}` (`:36-39`) — keep.
- `type RegistryReader interface { IsAdmitted(ctx, identityKey string) (bool, error); RegistryActive(ctx) (bool, error) }` (`:46-49`) — keep (TS `MembershipProvider { isActive, isAdmitted }`, `OT/mandala/types.d.ts:98-101`).
- `type TopicManager struct { verifier *Verifier; admin *AdminWallet; screen ScreeningProvider; state StateStore; registry RegistryReader; spend SpendChecker; exempt map[string]bool }` (`:51-63`).
- `type IssuerLister interface { IssuerIdentityKeys(ctx) ([]string, error) }` (`:69-71`) — delete (D:259: exemptions from trusted-issuer set + overlay key).
- `func (m *TopicManager) WithMembershipExemptions(keys ...string) *TopicManager` (`:76`); `func NewTopicManager(v *Verifier, aw *AdminWallet, sp ScreeningProvider, st StateStore) *TopicManager` (`:91`); `WithRegistry(r RegistryReader)` (`:97`); `WithSpendChecker(c SpendChecker)` (`:439`).
- `type ftOut struct { index uint32; assetID string; amount int64; pubKeyHash [20]byte; identityKey string }` (`:104-110`).
- `const AdminNotAnchoredReason = "tm_mandala: admin action is not anchored to the asset admin chain (priorOutpoint must be a previously admitted admin output of this asset, spent by this transaction)"` (`:335-336`) — delete.
- `type RejectError struct { Topic string; Err error; SpendTxid string }` (`:381-391`) + `Error()`/`Unwrap()` (`:393-394`) — keep, add `Code` (D:328: typed `{code, reason}`, substring `REASON_TABLE` deleted). Caller `httpapi/verdict.go:167`.
- `type infraError struct{ err error }`, `func infra(err error) error` (`:402-408`) — keep.
- `func (m *TopicManager) reject(err error) error` (`:413-425`) — keep; topic literal `"tm_mandala"` (`:424`).
- `type SpendChecker interface { SpentBy(ctx, txid string, vout uint32) (spendTxid string, err error) }` (`:434-436`) — keep (D:340 conflicting spend first).
Pipeline `IdentifyAdmissibleOutputs` (`:129-281`), current guard order: (1) unlinked-token reject `verifiedTokenOutputs` (`:152`), (2) `noConflictingSpend` (`:161`), (3) `adminChainAnchored` (`:166`), (4) own rules: 1-sat token (`:185`), admin verify + 1-sat + A16 (`:196-239`), conservation (`:242`), `resolveSpendIdentities` (`:249`), `anySanctioned` (`:255`), `controlGatePasses` (`:261`), `membershipHolds` (`:269`); result ascending (`:274-280`). v3 order: conflicting spend → (fuel) → A → B → C → D (D:340).
Function-level fate:

| Function | Line | Fate | Note |
|---|---|---|---|
| `verifiedTokenOutputs` | 295 | rewrite → layer B `verifyOutputLinkage` over all roles | reason becomes `output <idx>: token output with no verified linkage` (D:336) vs Go `"output %d: MandalaToken-decodable output with no verified linkage"` (`:369`) |
| `adminChainAnchored`, `priorAnchored`, `registerIsGenesis` | 349, 531, 511 | delete | authority spends are on-chain (D:119, D:14) |
| `noConflictingSpend` | 450 | keep | reason `"input %s already spent by %s"` (`:474`) |
| `verifyAdminOutput` | 494 | delete | `AdminWallet` |
| `freezeTargetHasRow` | 562 | delete | A16 refusal absent from TS 2.0.0 (`grep "no token row" OT/mandala` → none); v3 folds `{0, ''}` (`OT/mandala/MandalaLookupService.js:262-269`) |
| `inputOutpointString`, `inputSourceTxid`, `sourceOutput` | 579, 590, 602 | keep | |
| `ftInputAssetID` | 614 | rewrite | uses `DecodeToken` |
| `conservationHolds` | 630 | rewrite → layer A ledger + layer C delta rules (D:194-198, 251) | int64 sums; v3 wants bigint + caps (D:125-130) |
| `anySanctioned` | 662 | keep logic | include authority owners (D:257); reason `"sanctioned party involved in transfer"` (`:683`) |
| `resolveSpendIdentities` | 702 | keep core, change fallback | today a missing row yields `stored=""` and the input linkage's prover is accepted (`:730-750`); v3: repair-or-503 (D:224-231, D:496) |
| `controlGatePasses`, `assetGatePasses` | 762, 817 | rewrite | "admin tx" = spends an admitted authority of T, not a payload entry (D:259); sender set from `payload.Inputs` via `VerifyKeyLinkage` (counterparty!) at `:793` — OLD behaviour |
| `accessModeRejects` | 873 | keep | |
| `reissueGuardFails` | 894 | rewrite | v3 adds "every value output owned by `recipient`" (D:252) |
| `membershipHolds` | 924 | rewrite | exemptions = trusted set + overlay key (D:259) |
| `IdentifyNeededInputs` | 1000 | keep | returns nil |
| `GetDocumentation`/`GetMetaData` | 1005/1018 | rewrite | name `"tm_mandala"` (`:1020`) |

Error strings currently emitted (verbatim, for diffing against `OT/mandala/reject.d.ts:19-59` `Reasons`): `"tm_mandala: missing beef or txid"` (`:132`), `"tm_mandala: transaction %s not found in beef"` (`:138`), `"token output %d must carry exactly 1 satoshi"` (`:186`), `"admin output %d must carry exactly 1 satoshi"` (`:216`), `"conservation violated: outputs exceed authorized inputs/issuance"` (`:243`), `"control gate rejected the transaction (paused asset or access mode)"` (`:266`), `"output %d linkage verification: %w"` (`:316`), `"tm_mandala: spend state for %s: %w"` (`:469`, infra), `"admin output %d key derivation: %w"` (`:501`), `"admin prior lookup %s: %w"` (`:555`, infra), `"tm_mandala: token row for %s: %w"` (`:567,733`, infra), `"tm_mandala: freezeOutput targets an outpoint with no token row: %s"` (`:573`), `"sanctions screening of %s: %w"` (`:680`, infra), `"input %d linkage verification: %w"` (`:741`), `"input %d linkage does not control the coin being spent"` (`:744`), `"input %d linkage names %s but the coin is owned by %s"` (`:747`), `"tm_mandala: asset state for %s: %w"` (`:805`, infra), `"registry: %w"` (`:930`), `"registry: issuer keys: %w"` (`:942`), `"registry: asset state for %s: %w"` (`:968`), `"registry: membership of %s: %w"` (`:980`), `"identity not admitted: %s"` (`:983`).
TS 2.0.0 codes: `ERR_SHAPE | ERR_SATOSHIS | ERR_LINKAGE | ERR_CONSERVATION | ERR_AUTHORITY | ERR_UNTRUSTED | ERR_PAUSED | ERR_FROZEN | ERR_ACCESS | ERR_SANCTIONED | ERR_MEMBERSHIP | ERR_UNAVAILABLE` (`OT/mandala/reject.d.ts:1`); `class MandalaReject { code; reason }` (`:2-8`); reason catalog keys (`:19-59`): `invalidTokenOutput, nonP2pkhRemainder, oneSat, amountCap, sumCap, supplyCap, noLinkage, inputLinkageControl, inputLinkageOwner, ownerIndexUnavailable, storeUnavailable, storeWriteUnavailable, untrustedOwner, untrustedProver, untrustedAuthorityInput, fixedSupply, deploySig, deployNotAtZero, authorityWithoutInput, continuity, twoCommitments, commitmentMismatch, missingDetails, orphanDetails, detailsSchema, deployPayload, envelope, holderConservation, deltaRule, reissue, frozenInput, evictedInput, paused, blocked, notAllowed, sanctioned, notMember, registryExists, registryValue`. Exact strings are pinned in `@bsv/overlay-topics test/vectors/mandala-rejects.json` (D:448) — not read here (UNVERIFIED path in the installed package).

### 2.14 `mandala/registry.go` (153 lines) — rewrite
- `type RegistryRow struct { IdentityKey "identityKey"; Status "status" /* admitted|revoked */; Txid "txid"; OutputIndex uint32 "outputIndex"; AdmitSeq int64 "admitSeq"; CreatedAt time.Time "createdAt"; ActionDetails ActionDetails "actionDetails,omitempty" }` (`:18-30`).
- `var registryProtocol = wallet.Protocol{…, Protocol: "mandala registry"}` (`:32-35`) — delete.
- `type RegistryWallet struct`, `NewRegistryWallet(privHex string)`, `ExpectedPKH(details ActionDetails) ([20]byte, error)` (`:40-72`) — delete. Caller `wiring/engine.go:259`.
- `func (s *Store) IsAdmitted(ctx, identityKey string) (bool, error)` (`:75`) — findOne by identityKey, `status=="admitted"`.
- `func (s *Store) RegistryActive(ctx) (bool, error)` (`:89`) — `CountDocuments({})`.
- `func (s *Store) UpsertRegistry(ctx, row RegistryRow) error` (`:98`) — `$set` whole row upsert by identityKey (createdAt overwritten every fold).
- `func (s *Store) ListRegistry(ctx) ([]RegistryRow, error)` (`:108`) — sort `admitSeq:-1`, no filter. Caller `httpapi/admin.go:63`.
- `func FoldRegistry(details ActionDetails, txid string, vout uint32, seq int64) (RegistryRow, bool)` (`:125`) — kinds `register` (key from `issuer`), `admitIdentity`, `revokeIdentity`.
TS 2.0.0 `RegistryStorage` (`OT/mandala-registry/RegistryStorage.js`): meta doc `{_id:"registryTokenId", tokenId, createdAt}` in the **same** `mandalaRegistry` collection (`:2,16-17,21-29`, first writer wins via `$setOnInsert`); identity rows filtered `identityKey:{$exists:true}` (`:4,48,59`); `apply` skips a replay of the same outpoint, `$set {status, txid, outputIndex, admitSeq}` + `$setOnInsert {createdAt}` (`:34-44`); `isAdmitted` = findOne `{identityKey, status:"admitted"}` (`:50-54`); `list()` projection `{identityKey, status, txid, outputIndex, admitSeq}` (`:56-64`); counter `_id:"registryAdmitSeq"` (`:66-69`).

### 2.15 `mandala/registry_topic.go` (143 lines) — rewrite
- `const RegistryTopic = "tm_mandala_registry"` (`:15`) → `tm_mandala_kyc` (TT:50). External callers `wiring/engine.go:275`, `httpapi/admin.go:61`.
- `type RegistryChainStore interface { RegistryActive(ctx) (bool, error) }` (`:20-22`)
- `type RegistryTopicManager struct { wallet *RegistryWallet; store RegistryChainStore }` (`:26-29`); `NewRegistryTopicManager(w *RegistryWallet, store RegistryChainStore)` (`:33`).
- `IdentifyAdmissibleOutputs` (`:37-111`): kinds `register|admitIdentity|revokeIdentity` (`:71`), `DecodeAdmin` + `ExpectedPKH` (`:74-84`), `register` genesis-only via `RegistryActive` (`:85-95`), else `priorOutpoint` ∈ previousCoins (`:97-100`), 1-sat (`:102-104`), `CoinsToRetain: previousCoins` (`:110`). All OLD.
- `func registryReject(err error) error` (`:118`) → `&RejectError{Topic: RegistryTopic, Err: err}`; `registryActive` (`:123`); `IdentifyNeededInputs` nil (`:130`); docs/metadata (`:134-143`).
- Error strings: `"tm_mandala_registry: missing beef or txid"`, `"…: transaction %s not found in beef"`, `"…: output %d key derivation: %w"`, `"…: registry state: %w"` (untyped infra), `"…: registration chain already exists; register is genesis-only"`, `"…: output %d must carry exactly 1 satoshi"`, `"…: no admissible registry outputs"` (`:40,44,80,91,94,103,108`).
- v3: layers A–C with value outputs forbidden (→ `ERR_SHAPE`, reason key `registryValue`), kinds `admitIdentity`/`revokeIdentity` only, first trusted deploy wins, second deploy → `ERR_SHAPE` "registration chain already exists" (reason key `registryExists`) (D:291-296; `OT/mandala/reject.d.ts:57-58`).

### 2.16 `mandala/registry_lookup.go` (92 lines) — rewrite body
- `const RegistryLookup = "ls_mandala_registry"` (`:14`) → `ls_mandala_kyc`. External caller `wiring/engine.go:279`.
- `type RegistryLookupService struct { store *Store }` (`:16-18`); `NewRegistryLookupService(store *Store)` (`:22`).
- `OutputAdmittedByTopic` (`:26-60`): ignores other topics; folds `payload.Admin[index]` via `FoldRegistry` with shared `NextAdmitSeq` (`:51`); errors `"ls_mandala_registry: parse beef: %w"`, `"ls_mandala_registry: missing output"`, `"ls_mandala_registry: payload: %w"`.
- `OutputSpent`/`OutputNoLongerRetainedInHistory`/`OutputEvicted`/`OutputBlockHeightUpdated` no-ops (`:62-73`).
- `Lookup` returns `AnswerTypeFreeform` with empty `[]any{}`; served via `GET /admin/registry` instead (`:75-85`).

### 2.17 `activity/activity.go` (420 lines) — rewrite (small)
- `const groupOverlap = 9` (`:41`)
- `type Deps struct { ListLinkage func(ctx, limit int64, before *time.Time) ([]mandala.LinkageRow, error); FindLinkageByOutpoints func(ctx, []mandala.Outpoint) ([]mandala.LinkageRow, error); FindRawTxs func(ctx, txids []string) (map[string]string, error) }` (`:45-56`)
- `type Opts struct { AssetID string; Limit int64; Before *time.Time }` (`:63-67`)
- `type Proof struct { OutputIndex uint32 "outputIndex"; IdentityKey "identityKey"; KeyID "keyID"; Counterparty "counterparty"; ProofType int "proofType" }` (`:70-76`)
- `type Entry struct { Txid "txid"; When "when"; AssetID "assetId"; Kind "kind"; From *string "from"; To *string "to"; Amount int64 "amount"; Proofs []Proof "proofs" }` (`:81-90`)
- `type Page struct { Entries []Entry "entries"; NextCursor *string "nextCursor" }` (`:96-99`)
- `type FtInput { IdentityKey; Amount int64; AssetID }` (`:104-108`), `type FtOutput { OutputIndex uint32; IdentityKey; Amount int64; AssetID }` (`:112-117`), `type SummarizeParams` (`:120-126`)
- `func SummarizeTx(p SummarizeParams) *Entry` (`:130`) — nil when no FT inputs/outputs (`:131-133`); issue/transfer/redeem/self.
- `largestOutputIdentity` (`:201`), `decodeFtOutputs` uses `mandala.DecodeToken` (`:220-235`), `isoMillis` (`:239`), `newestISO` (`:248`).
- `func Build(ctx context.Context, deps Deps, opts Opts) (Page, error)` (`:259`); error `"activity: parse raw tx %s: %w"` (`:316`); source-input decode via `mandala.DecodeToken` (`:388`).
- No Mongo access of its own; reads through `Deps` (wired in `httpapi/activity.go:62`).
- v3 reference = `overlay/src/activity.ts`: `FtRole = 'value'|'authority'|'deploy'` (`:88`), `decodeToken` via `Bsv21Binary.decode`, deploy id `${txid}_0`, rejects amount > 2^53−1 (`:93-100`), `summarizeTx` filters both sides to `role === 'value'` before classifying (`:122-125`), `ActivityEntry.tokenId` (`:48`), `opts.tokenId` filter (`:158,247`), `GROUP_OVERLAP = 9` unchanged (`:86`).

## 3. Mongo collections and indexes

All created by `mandala.NewStore` (`storage.go:94-161`) in db `cfg.NodeName + "_lookup_services"` (`wiring/engine.go:220`). Go sets no index names (driver default `k1_1_k2_1`). TS `label` strings (`OT/mandala/MandalaStorageManager.js:13-76`) match those defaults textually; whether `CollectionIndexes` passes them as the Mongo `name` option is UNVERIFIED (`OT/shared/collectionIndexes.js` not read). Only matters if both engines share a db, which they do not today (`wiring/engine.go:220`). No TTL anywhere (`storage.go:85`).

| Collection | Go index today (`storage.go`) | TS 2.0.0 index | D §6.6 | Divergence |
|---|---|---|---|---|
| `mandalaOwners` | — (absent) | unique `{txid,outputIndex,topic}` (`OT/…:12-17`) | same (D:363) | **new in Go** |
| `mandalaTokens` | unique `{txid,outputIndex}`; `{assetId}`; `{identityKey}` (`:109-115`) | unique `{txid,outputIndex}`; `{tokenId}`; `{identityKey}` (`:18-25`) | same as TS (D:364) | `assetId`→`tokenId` |
| `mandalaAuthorities` | — (absent) | unique `{txid,outputIndex}`; `{topic,tokenId}` (`:26-36`) | same (D:365) | **new in Go** |
| `mandalaLinkageRecords` | `{txid,outputIndex}`; `{identityKey}`; `{createdAt:-1}` (`:116-122`) | `{txid,outputIndex}`; `{identityKey}` (`:38-47`) | "unchanged" (D:366) | Go has extra `createdAt:-1` (activity paging, `:119`) |
| `mandalaBalances` | unique `{identityKey}` (`:123-127`) | unique `{identityKey}` (`:48-53`) | unchanged (D:367) | none |
| `mandalaMetadata` | unique `{txid,outputIndex}`; `{assetId}` (`:128-133`) | unique `{tokenId}` (`:54-59`) | unique `tokenId` (D:368) | different key + shape |
| `mandalaAssetStates` | unique `{assetId}` (`:134-138`) | unique `{tokenId}` (`:60-65`) | unique `tokenId` (D:369) | key rename (see §5 hazard) |
| `mandalaAdminHistory` | `{assetId,height,offset,admitSeq}`; `{assetId,admitSeq:-1}`; `{assetId,txid,outputIndex}` (`:139-146`) | `{tokenId,height,offset,admitSeq}`; `{tokenId,txid,outputIndex}`; `{txid}` (`:66-76`) | same as TS (D:370) | Go has `(…,admitSeq:-1)` for `PageAdminHistory`; lacks `{txid}` |
| `mandalaRegistry` | unique `{identityKey}`; `{status}` (`:147-152`) | unique `{identityKey}`; `{status}` (`OT/mandala-registry/RegistryStorage.js:7-15`) | "as today" (D:371) | TS also stores meta doc `_id:"registryTokenId"` |
| `mandalaCounters` | none; docs `_id:"admitSeq"` (`:602-616`), also used by registry (`registry_lookup.go:51`) | none; `_id:"admitSeq"` (`OT/…:299-303`), `_id:"registryAdmitSeq"` (`RegistryStorage.js:66-69`) | `admitSeq`, `registryAdmitSeq` (D:372) | Go lacks `registryAdmitSeq` |
| `mandalaAdmissions` | unique `{txid}` (`:153-159`) | — (repo-local, not in package) | not in §6.6 (wire contract §4 unchanged, D:300) | none for v3 |

## 4. Document shapes (Go struct ↔ v3)

| Collection | Go today (file:line) | v3 (TS `OT/mandala/types.d.ts` / D §6.6) |
|---|---|---|
| `mandalaOwners` | — | `{txid, outputIndex, topic, tokenId, role: 'deploy'\|'authority'\|'value', amount, identityKey, createdAt}` (`types.d.ts:28-37`; D:363) |
| `mandalaTokens` | `TokenRow {txid, outputIndex(uint32), assetId, amount(int64), identityKey, createdAt}` (`storage.go:23-30`) | `{txid, outputIndex, tokenId, amount, identityKey, createdAt}` (`types.d.ts:39-46`); `amount` BSON double, Go writes float64, reads int32/int64/double (D:358) |
| `mandalaAuthorities` | — | `{txid, outputIndex, topic, tokenId, identityKey, createdAt}` (`types.d.ts:48-55`) |
| `mandalaLinkageRecords` | `LinkageRow {txid, outputIndex, identityKey, linkage: SpecificLinkage, createdAt}` (`storage.go:34-40`; linkage bytes as int32 arrays, `payload.go:44-54`) | identical (`types.d.ts:83-89`) |
| `mandalaBalances` | `{identityKey, balance(int64)}` (`storage.go:63-66`) | `{identityKey, balance}` (D:367) |
| `mandalaMetadata` | `MetadataRow {txid, outputIndex, assetId}` (`storage.go:43-47`) | `{tokenId, txid, outputIndex: 0, sym, dec, label, feeRatePerKb: number\|null}` (`types.d.ts:57-65`; D:368) |
| `mandalaAssetStates` | `AssetAdminState {assetId, issuerIdentityKey, isPaused, accessMode, feeRatePerKb(*int64), blockedIdentities, allowedIdentities, frozenOutpoints:[{outpoint, amount, owner, reason}], evictedOutpoints, lastProcessedHeight, lastProcessedOffset, lastAdmitSeq}` (`reducer.go:3-31`) | `{tokenId, isPaused, accessMode, blockedIdentities, allowedIdentities, frozenOutpoints:[{outpoint, amount, owner}], evictedOutpoints, feeRatePerKb, lastProcessedHeight, lastProcessedOffset, lastAdmitSeq}` (`OT/mandala/AssetStateReducer.d.ts:7-21`; D:369) |
| `mandalaAdminHistory` | `AdminHistoryEntry {assetId, txid, outputIndex, height, offset, admitSeq, actionDetails(map), createdAt}` (`storage.go:51-60`) | `{tokenId, txid, outputIndex, kind, detailsHex, commitment, delta, height, offset, admitSeq, createdAt, frozenAmount?, frozenOwner?}` (`types.d.ts:67-82`; D:370) |
| `mandalaRegistry` | `RegistryRow {identityKey, status, txid, outputIndex, admitSeq, createdAt, actionDetails?}` (`registry.go:18-30`) | rows `{identityKey, status, txid, outputIndex, admitSeq, createdAt}` + meta `{_id:"registryTokenId", tokenId, createdAt}` (`RegistryStorage.js:27,40-43`) |
| `mandalaCounters` | `{_id:"admitSeq", seq}` (`storage.go:69-72`) | `{_id:"admitSeq"\|"registryAdmitSeq", seq}` |
| `mandalaAdmissions` | `AdmissionRecord` (`admissions.go:66-94`) + `RestoreSnapshot {spentOutpoints, tokenRows:[TokenRow]}` (`:26-35`) | unchanged contract (D:300); `tokenRows` follow `TokenRow` |

## 5. Blast radius outside the two packages (non-test callers)

- `wiring/engine.go`: `NewStore` (`:225`), `NewVerifier` (`:230`), `NewAdminWallet` (`:235`), `NewTopicManager(...).WithRegistry(store).WithSpendChecker(spendChecker(es, store)).WithMembershipExemptions(overlayPriv.PubKey().ToDERHex())` (`:254-257`), `NewLookupService` (`:258`), `NewRegistryWallet` (`:259`), `NewRegistryTopicManager` (`:264`), `NewRegistryLookupService` (`:265`), engine maps `"tm_mandala"`/`RegistryTopic`/`"ls_mandala"`/`RegistryLookup` (`:272-285`), `SnapshotTokens`/`RestoreSnapshot` (`:337-362`), `spendChecker` (`:435`), `evictTx` uses `GetAdmission`, `MarkEvicted`, `OutputEvicted`, `FindAssetsTouchedByTxid`, `RebuildStateExcluding`, `DeleteAdminHistoryByTxid` (`:490-566`), `restoreLiveTokenRows` uses `es.IsUnspent(ctx, tokenTopic, …)` with `const tokenTopic = "tm_mandala"` (`:34,592`) and `RestoreTokens` (`:606`).
- `httpapi/submit.go`: `AdmissionRecorder` iface (`:43-50`), `DecodeLinkagePayload`/`WithPayload`/`PayloadHashHex` (`:119-128`), `RecordAdmission`/`MarkRefused` (`:187-312`), `const tokenTopic = "tm_mandala"` (`:25`).
- `httpapi/admin.go`: `AdminStore` iface `GetAssetState`, `GetTokenRow`, `FindAdminHistoryByAssetID`, `PageAdminHistory` (`:20-27`); `/admin/asset-auth/beef/:txid` with `"tm_mandala"` (`:59`); `/admin/registry/beef/:txid` with `RegistryTopic` (`:61`); `ListRegistry` (`:63`); `IsoStamp` (`:169`); `PickAssetAuthHead` (`:197`); `AnnotateFrozenRows` (`:303`).
- `httpapi/activity.go`: `ActivityLinkage` iface (`:23-27`), `activity.Build` (`:62-66`).
- `httpapi/verdict.go:167` (`*mandala.RejectError`); `httpapi/arcingest.go:32` (`EvictionOutcome` alias); `httpapi/lookup.go:63,89` (`NumBytes`).
- `enginestore/enginestore.go:49` mentions `mandala.NewStore` in a comment only.

## 6. Hard-coded topic/lookup names (token-topics work list)

| Literal | Location |
|---|---|
| `"tm_mandala"` | `mandala/lookup_service.go:43,263`; `mandala/topic_manager.go:424,476,1020`; `wiring/engine.go:34,274,379`; `httpapi/submit.go:25`; `httpapi/admin.go:59` |
| `"ls_mandala"` | `mandala/lookup_service.go:425`; `wiring/engine.go:278` |
| `"tm_mandala_registry"` | `mandala/registry_topic.go:15` (`RegistryTopic`) |
| `"ls_mandala_registry"` | `mandala/registry_lookup.go:14` (`RegistryLookup`) |

Under TT: `tm_mandala` admits deploys only and its records survive spends (TT:35, T7 TT:28); value/authority live in `tm_<deployTxid>` (64 lowercase hex, no `_0`, TT:23); each token manager sees only its own token's inputs/outputs (TT:41). Go has no `tokenTopic`/`tokenIdOfTopic` helper today (grep). The `topic` field on `mandalaOwners`/`mandalaAuthorities` holds `tm_<txid>` (TT:49).

## 7. Tests and vectors

| Test file | Tests | Mongo (`testDB`/`mustStore` uses) | Covers | v3 fate |
|---|---|---|---|---|
| `admin_chain_test.go` | 9 | — (stub) | priorOutpoint anchoring, register genesis | delete |
| `admin_test.go` | 5 | — | `DecodeAdmin`, `Commitment`, `LockAdmin` vs `vectors.json` | delete |
| `admissions_test.go` | 11 | yes | `RecordAdmission`, `MarkRefused`, `MarkEvicted`, `MergeRestoreSnapshot` | keep |
| `asset_auth_test.go` | 3 | partly (1) | `PickAssetAuthHead`, `AnnotateFrozenRows`, `IssuerIdentityKeys` | delete/adjust |
| `ctxvals_test.go` | 2 | — | ctx round trip | keep |
| `guards_test.go` | 6 | — (stubs) | canonical guard order, infra-not-verdict | rewrite (v3 order) |
| `linkage_test.go` | 2 | — | `VerifyKeyLinkage` golden + tamper (`vectors.json` `linkage`) | keep |
| `lookup_service_test.go` | 9 | yes (8 uses of `testDB`/`mustStore`) | projections, `adminAssetID` | rewrite |
| `membership_test.go` | 8 | — | membership exemptions, A16 freeze | rewrite |
| `payload_test.go` | 4 | — | payload decode, `ProtocolID`, `Num` | split |
| `rebuild_state_test.go` | 2 | yes | replay / excluding | rewrite (tokenId) |
| `reducer_test.go` | 6 | — | fold table, fee rate | rewrite |
| `registry_test.go` | 5 | partly (1) | `FoldRegistry`, chain spend, genesis-only | rewrite |
| `spend_identity_test.go` | 3 | — | stored-owner naming | keep intent, update fallback |
| `storage_test.go` | 15 | yes | lifecycle, TS-shape BSON, index-abort | rewrite |
| `token_test.go` | 4 | — | `DecodeToken`/`LockToken`/assetId vs `vectors.json` | delete |
| `topic_manager_test.go` | 23 | — (stubs) | admission rules | rewrite |
| `activity/activity_test.go` | 15 | — | `SummarizeTx`, `Build` paging | adapt (role filter, tokenId) |

`overlay-go/testdata/vectors.json` top-level keys: `tokenScripts`, `assetIds`, `adminScripts`, `commitments`, `linkage` (python json load). First four are OLD; `linkage` is format-independent. Generator `overlay-go/testdata/gen/gen.mjs` emits from `@bsv/templates` `MandalaAdmin`/`MandalaToken` (`mandala/admin_test.go:157`). v3: copy `@bsv/templates test/vectors/brc162.json` and `@bsv/overlay-topics test/vectors/mandala-rejects.json` into `overlay-go/testdata/` (D:450).

## 8. Surprises (ranked)

1. **Activity misclassifies every v3 issue as a transfer unless it filters by role.** v3 stores a linkage record for every admitted token output, authority included (`OT/mandala/MandalaLookupService.js:172-188`). Go `SummarizeTx` treats the first FT input with a linkage row as sender (`activity.go:155-160`) and any differently-owned output as external (`:171-188`). An issue spends the issuer's authority, so it would read as issuer→recipient "transfer"; pure admin txs (pause etc.) would become 0-unit "self" entries instead of nil (`:131-133`). TS P2 already filters to `role === 'value'` (`overlay/src/activity.ts:122-125`). (Derived from code reading; no test executed for this case.) `groupOverlap = 9` (`activity.go:41`) assumes ≤ 9 linkage rows per tx; authority split txs add rows. TS kept 9 (`activity.ts:86`).
2. **`decodeScriptNumChunk` cannot be reused for BRC-162.** It accepts `OP_1NEGATE` and non-minimal data pushes (`token.go:60-88`), both rejected by D:81, caps at 8 bytes (`:72`) while v3 accepts direct pushes `0x01..0x09` up to 2^64−1 (D:80), and returns int64. The amount codec needs a new uint64/bigint implementation.
3. **The registry collection holds two kinds of document in TS v3.** The meta doc `{_id:"registryTokenId", tokenId, createdAt}` lives in `mandalaRegistry` (`RegistryStorage.js:2,16-17,26-29`). Go `RegistryActive` = `CountDocuments({})` (`registry.go:89-95`) would count it, and `ListRegistry` has no `identityKey:{$exists:true}` filter (`registry.go:108-122`). Go folds registry rows with the shared `admitSeq` counter (`registry_lookup.go:51`); TS uses `registryAdmitSeq` (`RegistryStorage.js:67`; D:372).
4. **Go writes are inserts where v3 upserts.** `StoreToken`, `StoreLinkage` and `AppendAdminHistory` use `InsertOne` (`storage.go:166,285,439`). TS v3 uses `$setOnInsert`/`$set` upserts that return "inserted" so replays neither duplicate nor double-credit (`OT/mandala/MandalaStorageManager.js:124-128,232-235,269-273`). Go's `AdminSummary` dedup (`storage.go:552-559`) exists only to paper over duplicate history rows.
5. **Reducer semantics differ, not only types.** TS v3 lowercases identities and outpoints and makes re-freezing a no-op (`AssetStateReducer.js:14-24,51-52`). Go is case-sensitive and replaces an existing freeze with the new amount and owner (`reducer.go:124-129`). The A16 "freeze of an outpoint with no token row" refusal (`topic_manager.go:221-225,573`) does not exist in TS 2.0.0; v3 folds `{0, ''}`.
6. **Index hazard on a reused database.** `mandalaAssetStates` keeps a unique `{assetId:1}` index from the old store (`storage.go:134-138`). v3 documents have no `assetId`, so the second token's state would be a duplicate-null on that index. D13 is a clean break, and the runbook already moves P2 to a fresh node name (commit `792b65a`). Go P3 must also use a fresh `NodeName` (db name `wiring/engine.go:220`) or drop the old indexes. Inference from Mongo unique-index semantics; not exercised.
7. **Spec inconsistency on the Go package name.** D P3 says "`internal/bsv21`" (D:496) but D §3.5/§4.1 say `internal/brc162` (D:169,188).
8. **Missing-row fallback in `resolveSpendIdentities`.** When the token row is missing, Go sets `stored = ""` and accepts the input linkage's prover as the spender (`topic_manager.go:730-750`). D P3 requires repair-or-503 instead (D:224-231,496).
9. **Control-gate senders use the wrong linkage direction.** `controlGatePasses` resolves senders from `payload.Inputs` via `VerifyKeyLinkage`, which names the counterparty, not the prover (`topic_manager.go:792-797`). Sanctions and membership already use `resolveSpendIdentities`, which names the prover/stored owner (`:249-271`). v3 layer D reads owners from layer B, so this goes away in the rewrite.

## 9. Open questions for the planner

- Q1. Package dir: `internal/brc162` (D:169,188) or `internal/bsv21` (D:496)?
- Q2. Keep Go's extra `mandalaLinkageRecords {createdAt:-1}` index (needed by `ListLinkage`, `storage.go:301-308`) even though TS 2.0.0 lacks it? D §6.6 says "unchanged", so keeping it is consistent with Go today.
- Q3. Serve `assetStateTokenId`/`adminHistoryTokenId`/`authoritiesTokenId` through `/lookup` like TS 2.0.0 (`OT/mandala/MandalaLookupService.js:30-54`), or keep Go's HTTP-only stance (`lookup_service.go:314-320`)?
- Q4. Keep `AnnotateFrozenRows`/`hasFrozenRow` in the `/admin/asset-state` response (`httpapi/admin.go:303`)? It is a per-request field with no TS 2.0.0 counterpart.
- Q5. `PageAdminHistory` order: newest-first by `admitSeq` (Go, `storage.go:537-538`) or fold order (TS `findAdminHistory`, `OT/…:275-284`)? D §6.5 history row fields are listed (D:348); the page order is not specified there (UNVERIFIED in wire contract v3 text, not yet written).
- Q6. TT §9 has one σI per `tm_<id>` entry (TT:151-152), but `AdmissionRecord` stores a single `AdmissionSignature`/`OutputsToAdmit` per txid (`admissions.go:67-71`). Per-topic fields or one record per (txid, topic)?
- Q7. Does `RestoreSnapshot` need authority rows and a topic? Today it holds `TokenRows` only (`admissions.go:34`), and restore checks liveness on the fixed `tokenTopic` (`wiring/engine.go:592`). v3 eviction restores "inputs' rows only for coins live again" for both `mandalaTokens` and `mandalaAuthorities` (D:379), per topic (TT:127).

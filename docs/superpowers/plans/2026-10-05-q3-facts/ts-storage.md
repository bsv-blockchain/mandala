# Q3 fact sheet: TS Mandala storage + lookup (ts-stack) → Go port

Read-only survey, 2026-10-05. Every claim cites `file:line`. Path aliases:

- `TS` = `/private/tmp/claude-502/-Users-personal-git-demos-mandala/3d20e190-a562-4265-999c-8be2669d684d/scratchpad/ts-stack-main/packages/overlays/topics/src` (ts-stack HEAD `87a14c9b5`, `@bsv/overlay-topics` package.json version `2.0.0`)
- `GO` = `/Users/personal/git/demos/mandala/overlay-go/internal`
- `OV` = `/Users/personal/git/demos/mandala/overlay/src` (TS P2 overlay host, branch feat/brc162)
- `SPEC` = `/Users/personal/git/demos/mandala/docs/superpowers/specs/2026-10-01-mandala-brc162-design.md`
- `ENG` = `/Users/personal/git/demos/mandala/overlay/node_modules/@bsv/overlay/dist/esm/src` (`@bsv/overlay` 2.6.2)

---

## 0. Constants (verbatim)

| Name | Value | Cite |
|---|---|---|
| `MANDALA_TOPIC` | `'tm_mandala'` | TS/mandala/MandalaTopicManager.ts:27 |
| `LOOKUP_SERVICE` (Mandala lookup) | `'ls_mandala'` | TS/mandala/MandalaLookupService.ts:52 |
| `REGISTRY_TOPIC` | `'tm_mandala_registry'` | TS/mandala-registry/RegistryTopicManager.ts:31 |
| `REGISTRY_LOOKUP` | `'ls_mandala_registry'` | TS/mandala-registry/RegistryLookupService.ts:31 |
| `COMPRESSED_KEY` | `/^0[23][0-9a-f]{64}$/` (lowercase only) | TS/mandala/MandalaLookupService.ts:53 |
| `OUTPOINT` (storage) | `/^([0-9a-fA-F]{64})\.(0\|[1-9]\d{0,9})$/` | TS/mandala/MandalaStorageManager.ts:20 |
| `META_ID` | `'registryTokenId'` | TS/mandala-registry/RegistryStorage.ts:27 |
| `IDENTITY_ROWS` | `{ identityKey: { $exists: true } }` | TS/mandala-registry/RegistryStorage.ts:41 |
| `REGISTRY_KINDS` | `['admitIdentity', 'revokeIdentity']` | TS/mandala/details.ts:52 |
| `ADMIN_KINDS` | array at | TS/mandala/details.ts:37 |
| `INDEX_REPAIR_ENV` | `'OVERLAY_INDEX_REPAIR'` (`'true'` or `'1'`) | TS/shared/collectionIndexes.ts:24-29 |
| tokenId form | `<64 lowercase hex>_0`; deploy names itself `${txid}_${index}` | TS/brc162/ledger.ts:16, :66, :91; TS/shared/queryValidation.ts:227-232 |

A deploy is valid genesis only at vout 0 (TS/brc162/ledger.ts:225, :231), so deploy tokenIds are always `<txid>_0`.

---

## 1. Database and collections

Both stacks pick the Mongo DB as `${NODE_NAME}_lookup_services`:
- TS: overlay-express `configureMongo` → `mongoClient.db(\`${this.name}_lookup_services\`)` (overlay/node_modules/@bsv/overlay-express/dist/esm/src/OverlayExpress.js:884); host reuses it as `lookupDb = server.mongoDb!` and builds ONE `MandalaStorageManager` and ONE `RegistryStorage` on it (OV/index.ts:93-103).
- Go: `db := client.Database(cfg.NodeName + "_lookup_services")` (GO/wiring/engine.go:220). The Go engine's own output storage is in the same DB: `enginestore.New(db)` (GO/wiring/engine.go:249). TS engine storage is sqlite via knex (OV/index.ts:88-92), not Mongo.

### 1.1 Collections owned by the ts-stack package

| Collection | TS owner / field | Constructed at |
|---|---|---|
| `mandalaOwners` | `MandalaStorageManager.owners` | TS/mandala/MandalaStorageManager.ts:108 |
| `mandalaTokens` | `.tokens` | :109 |
| `mandalaAuthorities` | `.authorities` | :110 |
| `mandalaLinkageRecords` | `.linkage` | :111 |
| `mandalaBalances` | `.balances` | :112 |
| `mandalaMetadata` | `.metadata` | :113 |
| `mandalaAssetStates` | `.assetStates` | :114 |
| `mandalaAdminHistory` | `.adminHistory` | :115 |
| `mandalaCounters` | `.counters` (doc `{_id:'admitSeq', seq}`) | :116, :410-414 |
| `mandalaRegistry` | `RegistryStorage.rows` AND `.meta` (same collection, two typed handles) | TS/mandala-registry/RegistryStorage.ts:59-60 |
| `mandalaCounters` | `RegistryStorage.counters` (doc `{_id:'registryAdmitSeq', seq}`) | TS/mandala-registry/RegistryStorage.ts:61, :130-134 |

Host-only collection (not package): `mandalaAdmissions` (OV/index.ts:122; Go `AdmissionsCollection = "mandalaAdmissions"` GO/mandala/admissions.go:19).

### 1.2 Document shapes (verbatim TS interfaces)

`mandalaOwners` — `MandalaOwnerRecord` (TS/mandala/types.ts:27-36), append-only, never deleted:
```ts
{ txid: string; outputIndex: number; topic: string; tokenId: string;
  role: 'deploy' | 'authority' | 'value'; amount: number; identityKey: string; createdAt: Date }
```
Written by `journalRows` (TS/mandala/MandalaTopicManager.ts:100-116): `amount: Number(o.amount)` with comment "layer B caps every amount at 2^53-1, so this is exact"; one `createdAt = new Date()` per batch (:141).

`mandalaTokens` — `MandalaTokenRecord` (TS/mandala/types.ts:39-46):
```ts
{ txid: string; outputIndex: number; tokenId: string; amount: number; identityKey: string; createdAt: Date }
```

`mandalaAuthorities` — `MandalaAuthorityRecord` (TS/mandala/types.ts:49-56), deleted when spent or evicted:
```ts
{ txid: string; outputIndex: number; topic: string; tokenId: string; identityKey: string; createdAt: Date }
```

`mandalaMetadata` — `MandalaMetadataRecord` (TS/mandala/types.ts:59-67):
```ts
{ tokenId: string; txid: string; outputIndex: 0; sym: string; dec: number; label: string; feeRatePerKb: number | null }
```
(No `createdAt`.) `deployMetadata` returns `{ sym, dec, label, feeRatePerKb: number | null }` (TS/mandala/details.ts:333-350).

`mandalaAdminHistory` — `AdminHistoryEntry` (TS/mandala/types.ts:70-85):
```ts
{ tokenId: string; txid: string; outputIndex: number; kind: string; detailsHex: string; commitment: string;
  delta: number; height: number; offset: number; admitSeq: number; createdAt: Date;
  frozenAmount?: number; frozenOwner?: string }   // optional: freezeOutput rows only
```

`mandalaLinkageRecords` — `MandalaLinkageRecord` (TS/mandala/types.ts:87-93):
```ts
{ txid: string; outputIndex: number; identityKey: string; linkage: SpecificLinkage; createdAt: Date }
```
`SpecificLinkage` (TS/mandala/types.ts:5-14): `{ prover, verifier, counterparty: string; protocolID: [0|1|2, string]; keyID: string; encryptedLinkage: number[]; encryptedLinkageProof: number[]; proofType: number }`.

`mandalaBalances` — `BalanceRecord` (TS/mandala/MandalaStorageManager.ts:15-18): `{ identityKey: string; balance: number }`.

`mandalaAssetStates` — `AssetAdminState` (TS/mandala/AssetStateReducer.ts:12-26):
```ts
{ tokenId: string; isPaused: boolean; accessMode: 'denylist' | 'allowlist';
  blockedIdentities: string[]; allowedIdentities: string[];
  frozenOutpoints: FrozenRef[];        // FrozenRef = { outpoint: string; amount: number; owner: string } (:6-10)
  evictedOutpoints: string[]; feeRatePerKb: number | null;
  lastProcessedHeight: number; lastProcessedOffset: number; lastAdmitSeq: number }
```
`defaultAssetState(tokenId, feeRatePerKb = null)` (TS/mandala/AssetStateReducer.ts:34-49): `isPaused:false, accessMode:'denylist'`, all arrays `[]`, `lastProcessed*:0`, `lastAdmitSeq:0`. No `issuerIdentityKey` (SPEC:364 "`issuerIdentityKey` removed").

`mandalaRegistry` identity row — `StoredRow` (TS/mandala-registry/RegistryStorage.ts:12-25):
```ts
{ identityKey: string; status: 'admitted' | 'revoked'; txid: string; outputIndex: number; admitSeq: number; createdAt: Date }
```
`mandalaRegistry` meta doc — `RegistryMeta` (:29-33): `{ _id: 'registryTokenId'; tokenId: string; createdAt: Date }` (no `identityKey` field).

`mandalaCounters` — `{ _id: string; seq: number }` (TS/mandala/MandalaStorageManager.ts:37; TS/mandala-registry/RegistryStorage.ts:35-38).

### 1.3 BSON numeric typing (both directions)

- SPEC §6.6 says `amount`/`delta` are "BSON double holding an integer with |x| ≤ 2^53−1 ... Go writes `float64` and reads int32, int64 or double" (SPEC:356-358).
- Actual js-bson 7.3.3 (TS driver): a `number` that is a safe integer in int32 range is written as **int32**, anything else as **double** (overlay/node_modules/bson/lib/bson.cjs:3818-3825). So TS rows hold int32 for small amounts and double for large; SPEC "BSON double" is imprecise.
- Go driver v2.9.1 `intDecodeType` decodes int32, int64, and integral doubles into Go int types; a fractional double errors `errCannotTruncate` (`$GOMODCACHE/go.mongodb.org/mongo-driver/v2@v2.9.1/bson/default_value_decoders.go:230-256`).
- Go `uint32` encodes as int64 unless minSize (`.../bson/uint_codec.go:31-35`); decoding into uint32 range-checks (`uint_codec.go:113-118`).
- `$inc` on balances mixes types (TS int32/double delta, Go int64 delta). Mongo numeric equality/index matching across int32/int64/double is by value — Mongo semantics, UNVERIFIED in-repo.
- `frozenAmount`/`frozenOwner` presence is semantic: `recordedFoldContext` branches on `entry.frozenAmount === undefined` (TS/mandala/MandalaLookupService.ts:360). Go must model them as pointer + `omitempty` (absent ≠ 0).
- `feeRatePerKb` must round-trip `null` (TS types `number | null`, TS/mandala/types.ts:66; AssetStateReducer.ts:22).

---

## 2. Indexes

### 2.1 MandalaStorageManager (TS/mandala/MandalaStorageManager.ts:39-105)

Index names are Mongo defaults (no `name` option is passed; `label` is log-only, TS/shared/collectionIndexes.ts:9-10, :81-84).

| Label (verbatim) | Collection | Keys | Options | Cite |
|---|---|---|---|---|
| `mandalaOwners txid_1_outputIndex_1_topic_1` | mandalaOwners | `{txid:1, outputIndex:1, topic:1}` | `unique:true` | :40-45 |
| `mandalaTokens txid_1_outputIndex_1` | mandalaTokens | `{txid:1, outputIndex:1}` | `unique:true` | :46-51 |
| `mandalaTokens tokenId_1` | mandalaTokens | `{tokenId:1}` | — | :52 |
| `mandalaTokens identityKey_1` | mandalaTokens | `{identityKey:1}` | — | :53 |
| `mandalaAuthorities txid_1_outputIndex_1` | mandalaAuthorities | `{txid:1, outputIndex:1}` | `unique:true` | :54-59 |
| `mandalaAuthorities topic_1_tokenId_1` | mandalaAuthorities | `{topic:1, tokenId:1}` | — | :60-64 |
| `mandalaLinkageRecords txid_1_outputIndex_1` | mandalaLinkageRecords | `{txid:1, outputIndex:1}` | — (NOT unique) | :66-70 |
| `mandalaLinkageRecords identityKey_1` | mandalaLinkageRecords | `{identityKey:1}` | — | :71-75 |
| `mandalaBalances identityKey_1` | mandalaBalances | `{identityKey:1}` | `unique:true` | :76-81 |
| `mandalaMetadata tokenId_1` | mandalaMetadata | `{tokenId:1}` | `unique:true` | :82-87 |
| `mandalaAssetStates tokenId_1` | mandalaAssetStates | `{tokenId:1}` | `unique:true` | :88-93 |
| `mandalaAdminHistory tokenId_1_height_1_offset_1_admitSeq_1` | mandalaAdminHistory | `{tokenId:1, height:1, offset:1, admitSeq:1}` | — | :94-98 |
| `mandalaAdminHistory tokenId_1_txid_1_outputIndex_1` | mandalaAdminHistory | `{tokenId:1, txid:1, outputIndex:1}` | — (NOT unique, see appendAdminHistory) | :99-103 |
| `mandalaAdminHistory txid_1` | mandalaAdminHistory | `{txid:1}` | — | :104 |

No partial indexes anywhere. No TTL: "Deliberately NO TTL index on linkage — retention is >= 5 years." (:65). No index on `mandalaCounters` (`_id` only).

### 2.2 RegistryStorage (TS/mandala-registry/RegistryStorage.ts:48-56)

| Label | Collection | Keys | Options |
|---|---|---|---|
| `mandalaRegistry identityKey_1` | mandalaRegistry | `{identityKey:1}` | `unique:true` (:50-54) |
| `mandalaRegistry status_1` | mandalaRegistry | `{status:1}` | — (:55) |

The meta doc has no `identityKey`, so it is the (only) null-key entry of the unique `identityKey_1` index (Mongo semantics: missing field indexes as null — UNVERIFIED in-repo, but the test "persists to mandalaRegistry ... and a unique identityKey index" exists, TS/mandala-registry/__tests/registry.test.ts:427).

### 2.3 Host-added indexes (TS overlay, not the package)

- `mandalaLinkageRecords {createdAt:-1}` — awaited at boot, failure aborts (OV/index.ts:437-438).
- `mandalaAdminHistory {tokenId:1, admitSeq:-1}` — awaited at boot (OV/index.ts:443), for the paged route `find({tokenId}).sort({admitSeq:-1}).skip(offset).limit(limit)` (OV/index.ts:390).
- `mandalaAdmissions` indexes via `ensureAdmissionIndexes` (OV/index.ts:126).

### 2.4 ensureIndexes laziness — `CollectionIndexes` (TS/shared/collectionIndexes.ts)

- `MandalaStorageManager.ensureIndexes()` = `this.indexes.ensure()` (TS/mandala/MandalaStorageManager.ts:119-121); every public method of MandalaStorageManager awaits it first (e.g. :134, :152, :159, :168 … :409).
- `ensure()` memoizes `pending`; runs ALL definitions concurrently via `Promise.all(... build(d))`; if any outcome is `false`, clears `pending` so the next call retries (:71-77).
- `build` = `createIndex(keys, options ?? {})`; on error logs `` `${owner}: failed to create index ${label}; continuing without it` `` and goes to `repairAndRetry`; never throws (:79-93).
- `repairAndRetry` only for `unique:true` + duplicate-key error (`code === 11000` or message includes `E11000`, :31-35) + env opt-in. Without opt-in logs `` `${owner}: ${label} is unbuildable while duplicate rows exist; set OVERLAY_INDEX_REPAIR=true to delete the duplicates automatically` `` (:100-109). With opt-in: `$group` by index fields (`_id: {f0:'$field0',...}`), `$match n>1`, `allowDiskUse:true`, sorts docs oldest-`createdAt`-first (missing createdAt sorts last), `deleteOne({_id})` the extras, then re-`createIndex` (:111-146).
- So in TS, queries run even when an index build failed (doc comment :44-62).
- RegistryStorage: `apply`, `isActive`, `isAdmitted`, `list` call `indexes.ensure()` (TS/mandala-registry/RegistryStorage.ts:85, :104, :109, :119); `registryTokenId`, `claimRegistryTokenId`, `nextSeq` do NOT (:65-78, :129-136).
- Contrast Go today: `NewStore` creates all indexes eagerly and RETURNS AN ERROR (abort startup) on any failure, citing "Wire contract §9.9" (GO/mandala/storage.go:83-161).

---

## 3. MandalaStorageManager — every method, exact Mongo op

All reads use `projection: { _id: 0 }` unless stated. "FWW" = first-write-wins.

| Method (signature) | Collection | Op | Filter | Update / options | Returns | Cite |
|---|---|---|---|---|---|---|
| `recordOwners(rows: readonly MandalaOwnerRecord[]): Promise<void>` | mandalaOwners | `bulkWrite([...updateOne])`, `{ ordered: false }`; no-op if `rows.length === 0` (before ensureIndexes) | per row `{txid, outputIndex, topic}` | `{ $setOnInsert: row }`, `upsert: true` | void; any real failure throws | :132-145 |
| `getOwnerJournal(txid, outputIndex, topic)` | mandalaOwners | `findOne` | `{txid, outputIndex, topic}` | — | `MandalaOwnerRecord \| null` | :147-154 |
| `getTokenRow(txid, outputIndex)` | mandalaTokens | `findOne` | `{txid, outputIndex}` | — | `MandalaTokenRecord \| null` | :158-161 |
| `storeTokenIfAbsent(row)` | mandalaTokens | `updateOne` | `{txid: row.txid, outputIndex: row.outputIndex}` | `{ $setOnInsert: row }`, `upsert: true` | `upsertedCount === 1` (FWW) | :167-175 |
| `takeToken(txid, outputIndex)` | mandalaTokens | `findOneAndDelete` | `{txid, outputIndex}` | projection `{_id:0}` | removed row or `null` (exactly-once) | :178-181 |
| `findTokensByTokenId(tokenId, limit, skip)` | mandalaTokens | `find(liveTokenFilter).sort({txid:1, outputIndex:1}).skip(skip).limit(limit)` | see liveTokenFilter | — | `MandalaTokenRecord[]` | :184-196 |
| `circulatingSupply(tokenId): Promise<bigint>` | mandalaTokens | `find(liveTokenFilter, {projection:{_id:0, amount:1}})`, streamed | — | — | `Σ BigInt(row.amount)` (bigint, exact past 2^53) | :203-211 |
| `liveTokenFilter(tokenId)` (private) | mandalaAssetStates then — | `findOne({tokenId}, {projection:{_id:0, evictedOutpoints:1}})` | — | — | `{tokenId}` if no evicted, else `{ tokenId, $nor: [{txid: lower, outputIndex: n}, ...] }`; malformed entries dropped via `outpointKey` (OUTPOINT regex, txid lowercased) | :214-221, :23-26 |
| `getAuthorityRow(txid, outputIndex)` | mandalaAuthorities | `findOne` | `{txid, outputIndex}` | — | row or null | :225-228 |
| `storeAuthorityIfAbsent(row)` | mandalaAuthorities | `updateOne` | `{txid, outputIndex}` | `{ $setOnInsert: row }`, upsert | `upsertedCount === 1` | :230-238 |
| `takeAuthority(txid, outputIndex)` | mandalaAuthorities | `findOneAndDelete` | `{txid, outputIndex}` (NO topic) | projection `{_id:0}` | row or null | :240-246 |
| `listAuthorities(topic, tokenId)` | mandalaAuthorities | `find({topic, tokenId}).sort({txid:1, outputIndex:1})` (unbounded) | — | — | rows | :248-254 |
| `repairOwnerRow(journal): Promise<{inserted: boolean}>` | dispatch | `role === 'value'` → `repairTokenRow`, else (`'deploy'`/`'authority'`) → `repairAuthorityRow` | — | — | `{inserted}` | :265-272 |
| `repairTokenRow(journal)` (private) | mandalaTokens | `findOneAndUpdate` | `{txid, outputIndex}` | `{ $set: {tokenId, amount, identityKey}, $setOnInsert: {createdAt: journal.createdAt} }`, `{ upsert: true, returnDocument: 'before', projection: {_id: 1} }` | `before !== null` → false (corrected, no credit); else `adjustBalance(identityKey, amount)` then true | :274-290 |
| `repairAuthorityRow(journal)` (private) | mandalaAuthorities | `findOneAndUpdate` | `{txid, outputIndex}` | `{ $set: {topic, tokenId, identityKey}, $setOnInsert: {createdAt: journal.createdAt} }`, same options | `before === null` (never credits) | :292-302 |
| `adjustBalance(identityKey, delta: number)` | mandalaBalances | `updateOne` | `{identityKey}` | `{ $inc: { balance: delta } }`, upsert | void | :306-309 |
| `getBalance(identityKey): Promise<number>` | mandalaBalances | `findOne({identityKey})` (no projection) | — | — | `rec?.balance ?? 0` | :311-315 |
| `storeLinkage(rec)` | mandalaLinkageRecords | `updateOne` | `{txid, outputIndex}` | `{ $set: rec }`, upsert (LAST-write-wins, overwrites createdAt) | void | :317-324 |
| `storeMetadata(m)` | mandalaMetadata | `updateOne` | `{tokenId: m.tokenId}` | `{ $set: m }`, upsert (last-write) | void | :326-329 |
| `findMetadata(tokenId)` | mandalaMetadata | `findOne({tokenId})` | — | — | row or null | :331-334 |
| `deleteMetadata(tokenId)` | mandalaMetadata | `deleteOne({tokenId})` | — | — | void | :336-339 |
| `getAssetState(tokenId)` | mandalaAssetStates | `findOne({tokenId})` | — | — | `doc ?? defaultAssetState(tokenId)` (default NOT persisted) | :343-347 |
| `putAssetState(s)` | mandalaAssetStates | `updateOne` | `{tokenId: s.tokenId}` | `{ $set: s }`, upsert | void | :349-352 |
| `putAssetStateIfAbsent(s)` | mandalaAssetStates | `updateOne` | `{tokenId: s.tokenId}` | `{ $setOnInsert: s }`, upsert | `upsertedCount === 1` | :355-363 |
| `appendAdminHistory(e)` | mandalaAdminHistory | `updateOne` | `{tokenId, txid, outputIndex}` | `{ $setOnInsert: e }`, upsert | `upsertedCount === 1`; key index not unique, so two truly concurrent writes could both insert (doc :365-369) | :370-378 |
| `findAdminHistory(tokenId, limit?, skip = 0)` | mandalaAdminHistory | `find({tokenId}).sort({height:1, offset:1, admitSeq:1}).skip(skip)` + `.limit(limit)` only if defined | — | — | rows (fold order) | :381-389 |
| `tokenIdsWithHistory()` | mandalaAdminHistory | `distinct('tokenId')` (no filter) | — | — | `string[]` | :392-395 |
| `tokensTouchedBy(txid)` | mandalaAdminHistory | `distinct('tokenId', {txid})` | — | — | `string[]` (unsorted) | :398-401 |
| `deleteAdminHistoryByTxid(txid)` | mandalaAdminHistory | `deleteMany({txid})` | — | — | void | :403-406 |
| `nextAdmitSeq()` | mandalaCounters | `findOneAndUpdate` | `{_id: 'admitSeq'}` | `{ $inc: {seq: 1} }`, `{ upsert: true, returnDocument: 'after' }` | `seq ?? 1` | :408-416 |

Three write idioms the Go port must reproduce:
1. FWW insert: `updateOne(filter, {$setOnInsert: doc}, upsert)` → `UpsertedCount == 1` (`storeTokenIfAbsent`, `storeAuthorityIfAbsent`, `putAssetStateIfAbsent`, `appendAdminHistory`, `recordOwners` via bulk).
2. Last-write upsert: `updateOne(filter, {$set: doc}, upsert)` (`storeLinkage`, `storeMetadata`, `putAssetState`).
3. Repair: `findOneAndUpdate({$set, $setOnInsert:{createdAt}}, upsert, returnDocument:'before')` — Go equivalent returns `mongo.ErrNoDocuments` when it inserted (inserted ⇔ before is null).
Plus atomic take: `findOneAndDelete` (`takeToken`, `takeAuthority`).

Note `$setOnInsert: row` with the whole row includes the filter fields; Mongo accepts this (equality fields also seeded). Behaviour pinned by test "does not mutate the rows it is given" (TS/mandala/__tests/MandalaStorageManager.test.ts:226) — TS passes the caller object, driver would add `_id` on insert, hence upsert-not-insert (doc :125-131).

### 3.1 Store sub-interfaces (what Go must expose to each consumer)

- `MandalaStateStore = Pick<MandalaStorageManager, 'getAssetState' | 'getTokenRow' | 'getAuthorityRow' | 'getOwnerJournal' | 'recordOwners' | 'repairOwnerRow' | 'takeToken' | 'takeAuthority' | 'adjustBalance' | 'circulatingSupply'>` (TS/mandala/MandalaStorageManager.ts:424-436) — used by both topic managers (TS/mandala/MandalaTopicManager.ts:33; TS/mandala-registry/RegistryTopicManager.ts:38).
- `ReconcileStore = Pick<MandalaStorageManager, 'getTokenRow' | 'getAuthorityRow' | 'getOwnerJournal' | 'repairOwnerRow' | 'takeToken' | 'takeAuthority' | 'adjustBalance'>` (TS/mandala/reconcile.ts:33-42).
- `RepairUndoStore = Pick<MandalaStateStore, 'takeToken' | 'takeAuthority' | 'adjustBalance'>` (TS/mandala/ownership.ts:208-211); `takeBackRepair(store, txid, outputIndex, role)`: non-value → `takeAuthority`; value → `takeToken` then debit `-row.amount` only if a row was removed (:219-231).
- Read-fault wrappers: `readAssetState` → `Reasons.storeUnavailable('the asset state', cause)`, `readSupply` → `storeUnavailable('the circulating supply', cause)` (TS/mandala/authority.ts:73-91).
- Inline repair (`repairedOwner`, TS/mandala/ownership.ts:289-319): needs journal + engine `findAdmittedOutput` + script bytes equal; `repairOwnerRow`; if `inserted` and engine no longer has the output → `takeBackRepair` and throw `ownerIndexUnavailable(outpoint)`.

Reason strings (TS/mandala/reject.ts): `ownerIndexUnavailable: owner index unavailable for ${op}` (:100); `storeUnavailable: ${what} could not be read; retry` (:101-102); `storeWriteUnavailable: ${what} could not be written; retry` (:103-104); `registryExists: tm_mandala_registry: registration chain already exists; register is genesis-only` (:144-145, code `shape`).

---

## 4. MandalaLookupService (TS/mandala/MandalaLookupService.ts)

Class fields: `admissionMode: AdmissionMode = 'whole-tx'`, `spendNotificationMode: SpendNotificationMode = 'script'` (:209-210). Deps `{ storage: MandalaStorageManager; verifierWallet: WalletInterface }` (:47-50). Factory `createMandalaLookupService(verifierWallet, storage?) => (db) => new MandalaLookupService({storage: storage ?? new MandalaStorageManager(db), verifierWallet})` (:470-479).

### 4.1 `outputAdmittedByTopic(payload)` (:221-231)

1. Return unless `payload.mode === 'whole-tx' && payload.topic === MANDALA_TOPIC` (:222).
2. `admittedOutput(Transaction.fromBEEF(payload.atomicBEEF), payload.outputIndex)` → `classifyOutputs(tx).outputs.find(o => o.index === outputIndex)`; non-token output → return (:125-129, :223-224).
3. `env = decodeEnvelope(payload.offChainValues)` (throws on malformed) (:225).
4. `everyStep([recordAction, indexDeploy, indexOwner])` — runs ALL steps in order even if one throws, then rethrows the FIRST fault (:151-161, :226-230). The engine only logs what this throws; nothing retries (doc :214-220).

`recordAction(admitted, env)` (:312-340):
- `committedAction(output, env, kinds = ADMIN_KINDS)` (:195-206): only `role === 'authority'`; requires `commitmentOf(output.payload, output.payloadCanonical) !== undefined`; envelope `admin` entry with `index === output.index`; `decodeAdminDetails(entry.details, kinds, output.index)` → `{details, detailsHex: entry.details, commitment: toHex(commitment)}`. Else no action → return.
- `{height, offset} = txOrdering(tx)`: no merklePath → `{height: Number.MAX_SAFE_INTEGER, offset: 0}`; else `mp.blockHeight` and offset of the level-0 leaf with `hash === txid && txid` flag, default 0 (TS/mandala/ordering.ts:3-9).
- `read = settled(liveFoldContext(details, tokenId))` (never throws) (:318).
- entry = `{tokenId, txid, outputIndex, kind: details.kind, detailsHex, commitment, delta: deltaOf(admitted), height, offset, admitSeq: await storage.nextAdmitSeq(), createdAt: new Date(), ...(read.ok ? read.value : {})}` (:319-332). `nextAdmitSeq` is consumed even on a replay (gaps are normal).
- `if (!(await storage.appendAdminHistory(entry))) return` — replay: no fold (:333).
- `if (!read.ok) throw read.fault` — row kept without context, fold left to refold (:334).
- `state = getAssetState(tokenId)`; `putAssetState(folded(state, details, entry, read.value))` (:338-339). Crash between append and put leaves an unfolded action; recovered only by boot refold (:335-337).
- `folded(...)` = `{...foldAction(state, details, ctx), lastProcessedHeight: at.height, lastProcessedOffset: at.offset, lastAdmitSeq: at.admitSeq}` (:173-183).
- `deltaOf` = `Number(valueOut - valueIn)` of the output's token over `classifyAdmittedInputs(tx, [...tx.inputs.keys()])` (all inputs) and `buildLedger`; 0 if no ledger (:140-145).

`liveFoldContext(details, tokenId)` (:346-353): only `kind === 'freezeOutput'` with `details.outpoint`; `[txid, vout] = outpoint.split('.')`; `getTokenRow(txid, Number(vout))`; if `row?.tokenId !== tokenId` → `{frozenAmount: 0, frozenOwner: ''}`; else `{frozenAmount: row.amount, frozenOwner: row.identityKey}`. Others → `{}`.

`indexDeploy({txid, output})` (:297-303): only `role === 'deploy'`; `metadata = deployMetadata(output.payload, output.payloadCanonical)`; `storeMetadata({tokenId: output.tokenId, txid, outputIndex: 0, ...metadata})`; `putAssetStateIfAbsent(defaultAssetState(output.tokenId, metadata.feeRatePerKb))`.

`indexOwner(admitted, env)` (:250-258):
- `ownerOf` (:234-244): journal `getOwnerJournal(txid, output.index, MANDALA_TOPIC)`; if non-null and `journalAgrees` → `journal.identityKey`; else try `verifyOutputOwners([output], env, verifierWallet)[0].identityKey`; catch → `undefined`.
- `journalAgrees(journal, output)` (exported, :132-137): `tokenId ===`, `role ===`, `Number.isSafeInteger(journal.amount)`, `BigInt(journal.amount) === output.amount`, `COMPRESSED_KEY.test(identityKey)`.
- No owner → return; NOTHING is written, including the linkage record (the linkage exists only in this notification's off-chain values).
- `createdAt = new Date()` shared; `everyStep([storeLinkage, storeOwnerRow])`.
- `storeLinkage` (:260-270): `linkage = env.outputs.find(e => e.index === outputIndex)?.linkage`; absent → skip; else `storage.storeLinkage({txid, outputIndex, identityKey, linkage, createdAt})`.
- `storeOwnerRow` (:272-294): non-value (deploy/authority) → `storeAuthorityIfAbsent({txid, outputIndex, topic: MANDALA_TOPIC, tokenId, identityKey, createdAt})`; value → `amount = Number(output.amount)`, `if (await storeTokenIfAbsent(row)) await adjustBalance(identityKey, amount)` (credit on insert only).

### 4.2 `outputSpent(payload)` (:364-367)
Return unless `payload.topic === MANDALA_TOPIC` (mode not checked). `takeRow(payload.txid, payload.outputIndex)`.

`takeRow(txid, outputIndex)` (:376-381): `row = takeToken(...)`; row → `adjustBalance(row.identityKey, -row.amount)`; else `takeAuthority(...)`.

### 4.3 `outputEvicted(txid, outputIndex)` (:369-373)
NO topic guard. `takeRow(txid, outputIndex)` (so eviction DEBITS the balance, unlike Go today), then `if (outputIndex === 0) deleteMetadata(\`${txid}_0\`)`.

### 4.4 `lookup(question)` (:383-401)

- `query = requireLookupQuery(question, 'ls_mandala', QUERY_KEYS)` (:384); `QUERY_KEYS = ['metadataTokenId', 'assetStateTokenId', 'adminHistoryTokenId', 'authoritiesTokenId', 'tokenId', 'txid', 'outputIndex', 'limit', 'skip']` (:82-111).
- `requireLookupQuery` (TS/shared/queryValidation.ts:16-44): question must be non-null non-array object else `Invalid lookup query: a question object is required`; `question.service !== expected` → `Lookup service not supported!`; query must be a plain object (`Invalid lookup query: query must be an object` / `... must be a plain object`); every own key must be a string, not `__proto__|constructor|prototype`, in allowed set → else `Invalid lookup query: unexpected field ${key}`; accessor property → `field ${key} must be data`.
- ALL keys are validated before any is answered (:385-394):
  - each token key: `optionalTokenId` → `requireTokenId(value, field)`: `/^[0-9a-f]{64}_0$/` else `Invalid lookup query: ${field} must be a token id (<64 lowercase hex>_0)` (queryValidation.ts:227-232).
  - `outpointOf` (:116-123): `readString(query,'txid',{maxBytes:64})` (non-string → `txid must be a string`; length outside 1..64 bytes → `txid must contain 1-64 UTF-8 bytes`, queryValidation.ts:46-61) then `requireTxid` (`/^[0-9a-fA-F]{64}$/`, lowercased; else `txid must be a transaction ID`, :220-224); `outputIndex` only if defined: `readInteger(query,'outputIndex',0,0,0xffffffff)`. Outpoint defined only when BOTH present.
  - `limit = readInteger(query,'limit',100,1,100)`, `skip = readInteger(query,'skip',0,0,100000)`; error `Invalid lookup query: ${field} must be an integer from ${min} to ${max}` (queryValidation.ts:63-75).
- Dispatch: first token key present in `TOKEN_QUERIES` order wins (:395-398). Else no outpoint → `throw new Error('Unsupported query')` (:399). Else `outpointAnswer` (:400).

| Key (precedence order) | Answer | Paging | Cite |
|---|---|---|---|
| `metadataTokenId` | `findMetadata` → `[]` or `[{txid: metadata.txid, outputIndex: metadata.outputIndex}]` | none | :83-89 |
| `assetStateTokenId` | `[getAssetState(tokenId)]` cast to LookupFormula (`stateAnswer`, default state if none) | none | :79, :90-93 |
| `adminHistoryTokenId` | `findAdminHistory(tokenId, limit, skip)` (full AdminHistoryEntry rows, fold order) | server-side | :94-98 |
| `authoritiesTokenId` | `listAuthorities(MANDALA_TOPIC, tokenId).slice(skip, skip + limit)` | IN MEMORY after full fetch | :99-103 |
| `tokenId` | `findTokensByTokenId(tokenId, limit, skip)` (full token rows, evicted excluded) | server-side | :104-108 |
| `txid`+`outputIndex` | `getTokenRow ?? getAuthorityRow` → `[row]` or `[]` (authority row of ANY topic) | — | :403-409 |

Engine hydration (TS `@bsv/overlay` 2.6.2): `assertLookupFormula` requires every entry to have `txid` passing `assertHash` (`${label} must be 32 bytes of hex`) and a u32 `outputIndex` (ENG/Engine.js:1415-1427; ENG/RemoteSecurity.js:62-70). Only `{txid, outputIndex, history, context}` are read; other fields ignored; entries whose output the engine cannot load are dropped; result `{type:'output-list', outputs}` (ENG/Engine.js:1370-1401).
- Consequence: `assetStateTokenId` answer has no `txid` → an engine-routed `/lookup` with that key throws `TypeError: Lookup result[0] txid must be 32 bytes of hex`. The source comment says "the overlay serves it straight from storage (spec §6.5)" (:77-78). No consumer of these query keys was found outside docs (grep of overlay/, app/, lib/ — only SPEC and the P1 plan mention them). Reachability: UNVERIFIED.
- `adminHistoryTokenId` rows carry the authority outpoint; whether spent authority outputs hydrate depends on engine retention — UNVERIFIED.
- Go today declines to serve `assetState*`/`adminHistory*` via `/lookup` (GO/mandala/lookup_service.go:314-320).

### 4.5 Package eviction / refold API

`rebuildState(tokenId, excludeTxid?)` (:418-428):
1. `metadata = findMetadata(tokenId)`; `state = defaultAssetState(tokenId, metadata?.feeRatePerKb ?? null)` (fees off if deploy metadata gone).
2. `eachInOrder(await findAdminHistory(tokenId) /* no limit */, entry => ...)`: skip `entry.txid === excludeTxid` (in memory); `{details} = decodeAdminDetails(entry.detailsHex, ADMIN_KINDS, entry.outputIndex)`; `state = folded(state, details, entry, await recordedFoldContext(entry, details))`.
3. `putAssetState(state)` (`$set` upsert) — even if history is empty (writes a default state).
- `recordedFoldContext` (:356-362): `entry.frozenAmount === undefined` → `liveFoldContext` (reads the current token row); else `{frozenAmount, frozenOwner: entry.frozenOwner ?? ''}`.
- Contract: "must never run beside a live fold" (:416); a `decodeAdminDetails` throw aborts the whole rebuild without writing.
- `eachInOrder` = strict sequential, first throw ends the run (TS/mandala/inOrder.ts:7-16).

`tokenIdsWithHistory()` → `storage.tokenIdsWithHistory()` (:431-433).

`purgeAndRefold(txid): Promise<string[]>` (:440-446): `tokenIds = tokensTouchedBy(txid)`; `eachInOrder(tokenIds, id => rebuildState(id, txid))`; THEN `deleteAdminHistoryByTxid(txid)`; return `tokenIds`. Order makes an interrupted run repeatable.

`restoreInputRow(journal): Promise<boolean>` (:453-455) = `(await storage.repairOwnerRow(journal)).inserted`. Does not check liveness; caller must confirm the engine has the coin unspent and admitted.

Metadata: `getMetaData()` → `{ name: 'ls_mandala', shortDescription: 'Mandala BRC-162 token index by tokenId and outpoint: metadata, admin state and history, authorities. No identity-balance query.' }` (:461-467). `getDocumentation()` → TS/mandala/MandalaLookupDocs.md.ts.

### 4.6 Host duties (TS overlay, for parity)

- Boot + interval: refold every `tokenIdsWithHistory()` inside the exclusive gate, then reconcile both topics under the reconcile lock (OV/index.ts:280-292; OV/ownerIndex.ts:14, :58-62, :114-116). SPEC §6.6 "Overlay duties" (SPEC:369-372).
- Eviction: `restoreInput` via journal + `restoreInputRow`; `retireOutputs` via `mongoIndexedVouts` (reads `mandalaTokens` and `mandalaAuthorities` by `{txid}` with projection `{_id:0, outputIndex:1}` directly) then package `outputEvicted`; `purgeAndRefold(txid)` (OV/index.ts:304-315; OV/eviction.ts:168-180).
- Routes read storage: `listAuthorities(TOKEN_TOPIC, id)`, `findAdminHistory(id)`, paged history direct query, `registryStorage.list()` (OV/index.ts:372-420).

---

## 5. Registry

### 5.1 RegistryStorage methods (TS/mandala-registry/RegistryStorage.ts)

| Method | Op | Filter | Update / options | Returns | ensure()? | Cite |
|---|---|---|---|---|---|---|
| `registryTokenId(): Promise<string \| null>` | `meta.findOne` | `{_id: 'registryTokenId'}` | — | `meta?.tokenId ?? null` | no | :65-68 |
| `claimRegistryTokenId(tokenId): Promise<boolean>` | `meta.updateOne` | `{_id: 'registryTokenId'}` | `{ $setOnInsert: { tokenId, createdAt: new Date() } }`, upsert | `upsertedCount === 1` (FWW) | no | :71-78 |
| `apply(identityKey, status, ref: {txid, outputIndex})` | 1) `rows.findOne({identityKey}, {projection:{txid:1, outputIndex:1}})`; if same txid+outputIndex → return; 2) `admitSeq = nextSeq()`; 3) `rows.updateOne` | `{identityKey}` | `{ $set: {status, txid, outputIndex, admitSeq}, $setOnInsert: {createdAt: new Date()} }`, upsert | void | yes | :84-100 |
| `isActive()` | `rows.findOne(IDENTITY_ROWS, {projection:{_id:1}})` | `{identityKey:{$exists:true}}` | — | `!== null` | yes | :103-106 |
| `isAdmitted(identityKey)` | `rows.findOne({identityKey, status:'admitted'}, {projection:{_id:1}})` | — | — | `!== null` | yes | :108-115 |
| `list(): Promise<RegistryRow[]>` | `rows.find(IDENTITY_ROWS, {projection:{_id:0, identityKey:1, status:1, txid:1, outputIndex:1, admitSeq:1}}).sort({admitSeq:-1})` | — | — | rows (no createdAt) newest first | yes | :118-126 |
| `nextSeq()` (private) | `counters.findOneAndUpdate` | `{_id: 'registryAdmitSeq'}` | `{ $inc: {seq:1} }`, `{upsert:true, returnDocument:'after'}` | `counter?.seq ?? 1` | no | :129-136 |

`apply` is read-then-write, not atomic, and has no ordering guard: any action with a different outpoint than the stored one overwrites `status` (last applied wins). Replay of the SAME outpoint keeps its `admitSeq` (test TS/mandala-registry/__tests/registry.test.ts:401).

`registryMembership(storage): MembershipProvider` = `{ isActive: () => storage.isActive(), isAdmitted: k => storage.isAdmitted(k) }` (:140-145). `MembershipProvider` = `{ isActive: () => Promise<boolean>; isAdmitted: (identityKey) => Promise<boolean> }` (TS/mandala/types.ts:113-116). Wired as `membership: registryMembership(registryStorage)` into `MandalaTopicManager` (OV/index.ts:214).

### 5.2 RegistryLookupService (TS/mandala-registry/RegistryLookupService.ts)

Deps `{ registry: RegistryStorage; storage: MandalaStorageManager }` (:33-36). `admissionMode = 'whole-tx'`, `spendNotificationMode = 'script'` (:39-40). Factory ignores the db: `createRegistryLookupService(registry, storage) => () => new RegistryLookupService({registry, storage})` (:120-125).

`outputAdmittedByTopic(payload)` (:44-54) — SEQUENTIAL, no `everyStep` (a throw stops later steps):
1. Return unless `mode === 'whole-tx' && topic === REGISTRY_TOPIC`.
2. `output = classifyOutputs(tx).outputs.find(o => o.index === payload.outputIndex)`; return if undefined or `role === 'value'`.
3. If `role === 'deploy'` → `claimRegistryTokenId(output.tokenId)`.
4. `foldAction(txid, output, decodeEnvelope(offChainValues))` (:61-76): `committedAction(output, env, REGISTRY_KINDS)` (undefined → return); `claimRegistryTokenId(output.tokenId)` again (first claim wins; recovers a lost deploy claim); `if (registryTokenId() !== output.tokenId) return` (rival chain moves no membership); `identityKey === undefined` → `throw new Error(\`registry action ${kind} has no identityKey\`)`; `status = kind === 'admitIdentity' ? 'admitted' : 'revoked'`; `registry.apply(identityKey, status, {txid, outputIndex: output.index})`.
5. `indexAuthority(txid, output)` (:79-91): journal `getOwnerJournal(txid, output.index, REGISTRY_TOPIC)`; null or `!journalAgrees` → return (no linkage fallback, unlike Mandala); else `storeAuthorityIfAbsent({txid, outputIndex, topic: REGISTRY_TOPIC, tokenId, identityKey: journal.identityKey, createdAt: new Date()})`.

`outputSpent(payload)`: topic guard `REGISTRY_TOPIC`, `storage.takeAuthority(txid, outputIndex)` (:93-96).
`outputEvicted(txid, outputIndex)`: `storage.takeAuthority(...)` only; registry row kept ("nothing records what it replaced") (:98-101).
`lookup()` → `[]` (:103-105). `getMetaData()` → `{ name: 'ls_mandala_registry', shortDescription: 'Mandala identity registry index: folds admit and revoke actions into the membership cache and tracks the registry authority.' }` (:111-117).

Registry has NO balances, NO linkage records, NO admin history/asset state, NO tokens rows. Its authorities live in the shared `mandalaAuthorities` with `topic: 'tm_mandala_registry'`.

### 5.3 RegistryTopicManager (storage-relevant parts) (TS/mandala-registry/RegistryTopicManager.ts)

- Deps: `verifierWallet`, `trustedIssuers`, `stateStore: MandalaStateStore` ("The same state store, and so the same journal collections, as the Mandala topic manager"), `engineOutputs`, `registry: RegistryStorage`, `onOwnerRepair?` (:33-46).
- `identifyAdmissibleOutputs` (:59-99): layers A–C with `topic: REGISTRY_TOPIC` and `checkAuthority(..., {trustedIssuers, store, registry: true})`; then `requireFirstRegistry(outputs)`; then if `outputs.length > 0 && context?.dryRun !== true` → `journalOwners(store, REGISTRY_TOPIC, txid, owners)`; returns `{outputsToAdmit: ascendingIndices(outputs), coinsToRetain: previousCoins}`.
- `requireFirstRegistry` (:105-110): only when a deploy output exists; `claimed = registryTokenId()` (read fault → `Reasons.storeUnavailable('the registry', cause)` = `the registry could not be read; retry`, :113-119); `claimed !== null && claimed !== deploy.tokenId` → `throw Reasons.registryExists()`.
- `journalOwners` failure → `Reasons.storeWriteUnavailable('the owner journal', cause)` (TS/mandala/MandalaTopicManager.ts:134-145).

---

## 6. Behaviour pinned by TS tests (port these as Go tests)

TS/mandala/__tests/MandalaStorageManager.test.ts: builds every index on first use (:127); unique keys of journal + both owner indexes (:155); no TTL on linkage (:178); journal idempotent / append-only / partial-duplicate batch inserts the rest / one row per topic / empty batch no-op / non-duplicate failure rethrown (:186-240); token FWW + safe-integer cap stored as number (:255-276); takeToken exactly once (:283); paging + evicted excluded + outpoint order (:290-313); circulatingSupply: zero, sums, after spend, excludes evicted, evicted match case-insensitive + malformed ignored, same vout other tx not excluded, per-token evicted, exact past 2^53 (:330-384); authority FWW/take/list (:393-410); repairOwnerRow insert+credit once / authority never credits / deploy treated as authority / correct without re-credit / concurrent repair credits once / never writes journal (:428-483); balances (:490); linkage one per outpoint (:518); metadata keyed on tokenId alone, delete one token (:539-560); asset state default not persisted, put replaces, IfAbsent (:574-608); history order, paging, FWW per (tokenId, txid, outputIndex), distinct touched, delete by txid (:616-676); nextAdmitSeq starts at 1, monotonic, unique under concurrency (:692-698).

TS/mandala-registry/__tests/registry.test.ts: claim null→first wins, concurrent claims one winner, claim not active nor listed, admit→revoke one row, same-outpoint apply no-op, revoked-never-admitted still active, list newest first exact fields, `registryAdmitSeq` counter + unique identityKey (:359-427); membership inactive while empty, admits exactly admitted (:450-456).

---

## 7. Go overlay compatibility (GO/mandala/storage.go and friends)

### 7.1 Same Mongo DB?

- Formula identical: `${NODE_NAME}_lookup_services` on both (§1).
- Collection names identical where both exist: `mandalaTokens`, `mandalaLinkageRecords`, `mandalaBalances`, `mandalaMetadata`, `mandalaAssetStates`, `mandalaAdminHistory`, `mandalaCounters`, `mandalaRegistry`, `mandalaAdmissions` (GO/mandala/storage.go:95-105).
- Live config differs: `overlay-go/.env` `NODE_NAME=mandala` → `mandala_lookup_services`; `overlay/.env` `NODE_NAME=mandala162` → `mandala162_lookup_services` (both `.env` line 1). Runbook: TS P2 runs on fresh node `mandala162`; old-format `mandala_lookup_services` "is untouched and obsolete. Never point the P2 build at it" (runbook.md:3). The `overlay/docker-compose.yml:17-23` comment ("they share the one real database ... NODE_NAME=mandala ... interchangeable") predates P2 and is stale.
- So today they do NOT share a DB. A Go P3 meant to be interchangeable with TS P2 must run with the P2 node name and the P2 schema.

### 7.2 Missing in Go

- No `mandalaOwners` (journal) and no `mandalaAuthorities` collection at all (storage.go:76-81, :95-105).
- No `RegistryStorage` meta doc `{_id:'registryTokenId'}`, no `registryAdmitSeq` counter (Go registry uses the shared `admitSeq`: GO/mandala/registry_lookup.go:51 → `NextAdmitSeq`).
- No `circulatingSupply`, `repairOwnerRow`, `takeToken`/`takeAuthority` (atomic), `putAssetStateIfAbsent`, `tokenIdsWithHistory`, `listAuthorities`, `getOwnerJournal`, `recordOwners`.

### 7.3 Field / shape divergence inside the same collection names

| Collection | TS P2 (§1.2) | Go today | Cite (Go) |
|---|---|---|---|
| mandalaTokens | `tokenId` | `assetId`; `Amount int64`; `OutputIndex uint32` | storage.go:23-30 |
| mandalaMetadata | `{tokenId, txid, outputIndex:0, sym, dec, label, feeRatePerKb}` | `{txid, outputIndex, assetId}` only | storage.go:43-47 |
| mandalaAssetStates | `tokenId`, no `issuerIdentityKey`, `FrozenRef{outpoint,amount,owner}` | `assetId`, has `issuerIdentityKey`, `FeeRatePerKb *int64` (no omitempty, writes null) | GO/mandala/reducer.go:14-31 |
| mandalaAdminHistory | `{tokenId, txid, outputIndex, kind, detailsHex, commitment, delta, height, offset, admitSeq, createdAt, frozenAmount?, frozenOwner?}` | `{assetId, txid, outputIndex, height, offset, admitSeq, actionDetails{...}, createdAt}` | storage.go:51-60 |
| mandalaRegistry | identity rows + meta doc; `createdAt` set on insert only | `RegistryRow` with `actionDetails,omitempty`; `$set: row` overwrites `createdAt` every write | GO/mandala/registry.go:18-30, :98-105 |
| mandalaLinkageRecords | same shape | same shape | storage.go:34-40 |
| mandalaBalances | `{identityKey, balance}` | same (`Balance int64`) | storage.go:63-66 |
| mandalaCounters | `{_id:'admitSeq'}`, `{_id:'registryAdmitSeq'}` | `{_id:'admitSeq'}` only | storage.go:602-616 |

### 7.4 Index divergence (Go `NewStore`, storage.go:107-159)

| Collection | Go index | TS P2 index | Note |
|---|---|---|---|
| mandalaTokens | unique `(txid,outputIndex)`, `assetId_1`, `identityKey_1` (:109-115) | unique `(txid,outputIndex)`, `tokenId_1`, `identityKey_1` | rename |
| mandalaLinkageRecords | `(txid,outputIndex)`, `identityKey_1`, `createdAt_-1` (:116-122) | `(txid,outputIndex)`, `identityKey_1` + host `createdAt:-1` | same set overall |
| mandalaBalances | unique `identityKey` (:123-127) | same | same |
| mandalaMetadata | UNIQUE `(txid,outputIndex)`, `assetId_1` (:128-133) | UNIQUE `tokenId_1` | different key |
| mandalaAssetStates | UNIQUE `assetId_1` (:134-138) | UNIQUE `tokenId_1` | rename |
| mandalaAdminHistory | `(assetId,height,offset,admitSeq)`, `(assetId,admitSeq:-1)`, `(assetId,txid,outputIndex)` (:139-146) | `(tokenId,height,offset,admitSeq)`, `(tokenId,txid,outputIndex)`, `txid_1` + host `(tokenId,admitSeq:-1)` | rename; Go lacks `txid_1` |
| mandalaRegistry | unique `identityKey`, `status_1` (:147-152) | same | same |
| mandalaAdmissions | unique `txid` (:153-158) | host-owned | — |
| mandalaOwners / mandalaAuthorities | none | see §2.1 | missing |

Startup hazard (follows from Mongo's missing-field-as-null rule for unique indexes; UNVERIFIED empirically): pointing a P2-schema Go store at the old `mandala_lookup_services` and creating unique `tokenId_1` on `mandalaAssetStates`/`mandalaMetadata` would hit E11000 on legacy docs that lack `tokenId` (more than one null), and Go `NewStore` returns the error and aborts boot (storage.go:87-93). The reverse: Go's current unique `assetId_1` on a P2-populated `mandalaAssetStates` (docs lack `assetId`) fails as soon as two tokens exist. TS `CollectionIndexes` instead logs and continues (§2.4). So Go P3 should run on a fresh node name (as TS P2 did) or ship a migration; the old v2 indexes must not be created in a P2 DB.

### 7.5 Write-semantics divergence (Go today vs TS)

- `StoreToken` = `InsertOne` (storage.go:165-168) vs TS FWW upsert `storeTokenIfAbsent`.
- `StoreLinkage` = `InsertOne` (:284-287) vs TS `$set` upsert by outpoint.
- `AppendAdminHistory` = `InsertOne` (:438-441) vs TS FWW upsert returning bool; Go `AdminSummary` dedupes re-admits by `(txid,outputIndex)` because of this (:552-559).
- `StoreMetadata` upserts by `(txid,outputIndex)` (:368-374) vs TS by `tokenId`; `DeleteMetadata(txid, vout)` (:392-395) vs TS `deleteMetadata(tokenId)`.
- `DeleteToken` = `DeleteOne` (:182-185); Go `OutputSpent` is read (`GetTokenRow`) → debit → `DeleteToken`, not atomic, so two concurrent spends can double-debit (GO/mandala/lookup_service.go:262-278) vs TS `findOneAndDelete` exactly-once.
- Go `OutputEvicted` deletes the token row and metadata with NO balance debit and no authority handling (lookup_service.go:282-292) vs TS `takeRow` (debit) + `deleteMetadata(\`${txid}_0\`)` only at vout 0.
- `FindByAssetID` filters evicted outpoints in Go memory with exact-string match `"<txid>.<vout>"` (storage.go:187-212) vs TS server-side `$nor` with lowercased txid + regex validation.
- Go `NextAdmitSeq` matches TS (`findOneAndUpdate {_id:'admitSeq'} $inc seq, upsert, After`, fallback 1) (storage.go:602-616).
- Go has `SnapshotTokens`/`RestoreTokens` broadcast-failure compensation (storage.go:230-280) with no TS-package counterpart (TS host has its own snapshotRestore, OV/index.ts:18, :223).

### 7.6 Registry divergence (Go today vs TS)

- `RegistryActive` = `CountDocuments(bson.D{})` (GO/mandala/registry.go:89-95) — would count the TS meta doc; TS uses `{identityKey:{$exists:true}}`.
- `IsAdmitted` reads the row and compares `Status == "admitted"` (registry.go:75-85) — equivalent result to TS filter.
- `ListRegistry` = `Find({})` sorted `admitSeq:-1`, no `$exists` filter, returns full rows incl. `createdAt`/`actionDetails` (registry.go:108-122) vs TS projection of 5 fields.
- `UpsertRegistry` = `$set: row` upsert by `identityKey` (registry.go:98-105): no same-outpoint no-op guard, consumes a seq every replay (registry_lookup.go:51), no claimed-registry-token check.
- `FoldRegistry` accepts kind `register` and falls back to `issuer` field (registry.go:125-153); TS `REGISTRY_KINDS` are only `admitIdentity`/`revokeIdentity`.
- Go `RegistryLookupService.OutputSpent`/`OutputEvicted` are no-ops (registry_lookup.go:62-70) vs TS `takeAuthority`.
- Go registry `Lookup` returns `AnswerTypeFreeform` with `[]any{}` (registry_lookup.go:75-85); TS returns `[]` (empty formula → empty output-list).

### 7.7 Go lookup today vs TS keys

Go `lookupQuery{metadataAssetId, assetId, txid, outputIndex *uint32}` parsed with `json.Unmarshal` (unknown keys ignored), switch precedence metadataAssetId → assetId → txid+outputIndex, else `errors.New("Unsupported query")`; answers `AnswerTypeFormula` outpoints only (GO/mandala/lookup_service.go:306-361). TS keys are `metadataTokenId`, `assetStateTokenId`, `adminHistoryTokenId`, `authoritiesTokenId`, `tokenId`, `txid`, `outputIndex`, `limit`, `skip` with strict validation (§4.4). Go `FindByOutpoint` reads only `mandalaTokens` (storage.go:214-228); TS falls back to `mandalaAuthorities`.

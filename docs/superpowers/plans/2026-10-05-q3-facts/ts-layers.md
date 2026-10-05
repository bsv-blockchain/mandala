# Q3 fact sheet: the TS BRC-162 Mandala rules (layers A–D) to port to Go

Source snapshot: ts-stack `main` at `87a14c9b5`, checked out at
`/private/tmp/claude-502/-Users-personal-git-demos-mandala/3d20e190-a562-4265-999c-8be2669d684d/scratchpad/ts-stack-main`.
Read-only survey. Nothing was run. Every claim cites `file:line`.

## File key (paths relative to `packages/overlays/topics/` unless noted)

| key | path |
|---|---|
| ledger | `src/brc162/ledger.ts` (240 lines) |
| own | `src/mandala/ownership.ts` (377) |
| auth | `src/mandala/authority.ts` (349) |
| ctl | `src/mandala/controls.ts` (163) |
| det | `src/mandala/details.ts` (361) |
| dsig | `src/mandala/deploySig.ts` (40) |
| vkl | `src/mandala/verifyKeyLinkage.ts` (81) |
| types | `src/mandala/types.ts` (201) |
| rej | `src/mandala/reject.ts` (148) |
| red | `src/mandala/AssetStateReducer.ts` (135) |
| ord | `src/mandala/ordering.ts` (9) |
| ino | `src/mandala/inOrder.ts` (16) |
| rec | `src/mandala/reconcile.ts` (200) |
| tm | `src/mandala/MandalaTopicManager.ts` (221): the orchestrator, not in the brief but it fixes the cross-layer order |
| rtm | `src/mandala-registry/RegistryTopicManager.ts` (132): the vectors dispatch to it |
| sm | `src/mandala/MandalaStorageManager.ts` (436): collections, indexes, the `MandalaStateStore` surface |
| gen | `test/vectors/generate.test.ts` (1723) |
| vec | `test/vectors/mandala-rejects.json` (102 cases) |
| b21 | `../../helpers/ts-templates/src/Bsv21Binary.ts` (267): token codec, source of the `invalidTokenOutput` detail strings |
| cbor | `../../helpers/ts-templates/src/strictCbor.ts` (276): strict CBOR, source of the `detailsSchema`/`deployPayload` detail strings |
| scr | `../../sdk/src/script/Script.ts`: chunk parser |
| kd | `../../sdk/src/wallet/KeyDeriver.ts` |
| pw | `../../sdk/src/wallet/ProtoWallet.ts` |
| sk | `../../sdk/src/primitives/SymmetricKey.ts` |

---

## 0. Pipeline order (the first refusal wins across layers)

`MandalaTopicManager.identifyAdmissibleOutputs(beef, previousCoins, offChainValues?, _mode?, context?)` (tm:163-208):

1. `Transaction.fromBEEF(beef)` (tm:170). A bad BEEF throws a **plain Error**, not a MandalaReject, and it propagates (tm:4-6).
2. `txid = tx.id('hex')` (tm:171).
3. `env = decodeEnvelope(offChainValues)` (tm:172). **Envelope `ERR_SHAPE` comes before every codec or shape check.**
4. Layer A, which never throws a reject: `classifyOutputs(tx)` (tm:176), `classifyAdmittedInputs(tx, previousCoins)` (tm:177), `buildLedger(txid, outputs, inputs)` (tm:178).
5. Layer B: `requireValidTokenOutputs(invalid, outputs)` (tm:181), then `verifyOutputOwners(outputs, env, verifierWallet)` (tm:182), then `resolveInputOwners(inputs, tx, env, {store, engine, verifierWallet, topic: 'tm_mandala', onRepair})` (tm:183-189).
6. Layer C: `checkAuthority(txid, ledger, outputs, owners, inputOwners, env, {trustedIssuers: this.trusted, store, registry: false})` (tm:192-196).
7. Layer D: `checkControls(ledger, inputs, inputOwners, owners, auth, {store, screening, membership, exempt: this.exempt})` (tm:197-202).
8. When `outputs.length > 0 && context?.dryRun !== true`: `journalOwners(store, 'tm_mandala', txid, owners)` (tm:204-206).
9. Returns `{ outputsToAdmit: ascendingIndices(outputs), coinsToRetain: previousCoins }` (tm:207). `outputsToAdmit` lists every BRC-162 token output index in ascending order (tm:118-119). Non-token outputs are never admitted. `coinsToRetain` is `previousCoins` exactly as passed.

A transaction with no token outputs and no token inputs is admitted with `outputsToAdmit: []`. No layer refuses it: every check iterates over empty lists.

**Registry variant** `RegistryTopicManager.identifyAdmissibleOutputs` (rtm:59-99) runs the same steps 1–6 with `topic: 'tm_mandala_registry'` (rtm:83) and `registry: true` (rtm:91). It has **no layer D**. After layer C it runs `requireFirstRegistry(outputs)` (rtm:93, 105-110), then the journal (rtm:95-97), then the same return. So a second registry deploy that has a bad deploySig fails on deploySig first, and `registryExists` fires only for a deploy that passes all of layer C.

Constructor configuration (thrown as plain Errors at construction, never per transaction):
- `trustedSet(keys, owner)` (tm:63-80). A non-array or empty list fails with `` `${owner}: trustedIssuers must be a non-empty array` `` (tm:65). A key that fails `isCanonicalKey` fails with `` `${owner}: trusted issuer ${String(key)} is not a compressed lowercase public key` `` (tm:71). A duplicate fails with `` `${owner}: trusted issuer ${key} is listed more than once` `` (tm:75).
- `isCanonicalKey(key)` holds when the key is a string matching `/^0[23][0-9a-f]{64}$/` and `PublicKey.fromString(key).toString() === key` (tm:46-57).
- `exemptKeys(keys, owner)` (tm:87-98): `undefined` gives `[]`. A non-array fails with `` `${owner}: membershipExempt must be an array` ``. A key that is not canonical fails with `` `${owner}: membership-exempt key ${String(key)} is not a compressed lowercase public key` ``.
- `exempt = trusted ∪ membershipExempt` (tm:156-159). The registry manager has no exempt set.
- `onRepair` defaults to `logOwnerRepair(label)`, which logs `` console.warn(`[${label}] owner index repaired for ${outpoint} from the owner journal (${what})`) `` with `what` = `'row inserted' | 'row corrected'` (tm:122-127).

Constants: `MANDALA_TOPIC = 'tm_mandala'` (tm:27), `REGISTRY_TOPIC = 'tm_mandala_registry'` (rtm:31).

### `eachInOrder` (ino:7-16)
`eachInOrder<T>(items: Iterable<T>, step: (item: T) => Promise<void> | void): Promise<void>` runs the items strictly in sequence and stops at the first throw (ino:1-6). In Go this is a plain `for` loop that returns the first error.

---

## 1. Layer A: `brc162/ledger.ts` (generic BRC-162 rules, never throws a reject)

### Types (ledger:12-62)
```ts
Brc162Output { index: number; satoshis: number; role: Bsv21Role; tokenId: string; amount: bigint;
               payload?: number[]; payloadCanonical: boolean; restPubKeyHash?: number[] }
InvalidTokenOutput { index: number; detail: string }
Brc162Input { index: number; role: Bsv21Role /* only 'authority'|'value' */; tokenId: string; amount: bigint;
              outpoint: string /* `<display txid>.<vout>` */ }
TokenLedger { tokenId: string; deployIndex?: number; authorityIn: number[] /* input idx */;
              authorityOut: number[] /* output idx, an authority deploy included */; valueIn: bigint; valueOut: bigint;
              valueInIndices: number[]; valueOutIndices: number[] }
Brc162Classification { outputs: Brc162Output[]; invalid: InvalidTokenOutput[] }
SpecVerdict { deployValid: boolean; authorityOutputsValid: boolean; valueOutputsValid: boolean }
```
`Bsv21Role = 'deploy' | 'authority' | 'value'` (b21:20).

### `readTokenScript(script)` (ledger:70-78)
- Returns `undefined` when `!isTokenShaped(script)`.
- Otherwise returns `{decoded: Bsv21Binary.decode(script)}`. A `Bsv21BinaryError` becomes `{detail: error.message}`. Any other error is rethrown.

### `classifyOutputs(tx): Brc162Classification` (ledger:100-111)
- Walks `tx.outputs` in index order. Outputs that are not token-shaped are skipped.
- A codec refusal goes to `invalid`, in index order.
- Anything else goes to `outputs` through `toOutput(txid, index, output.satoshis ?? 0, decoded)` (ledger:108). **Missing satoshis read as 0.**
- `toOutput` (ledger:80-97) sets `tokenId` to `` `${txid}_${index}` `` for a deploy (decoded.tokenId undefined), and to `tokenIdToString(decoded.tokenId)` otherwise.

### `classifyAdmittedInputs(tx, previousCoins): Brc162Input[]` (ledger:151-161)
- Iterates `[...new Set(previousCoins)].sort((a,b)=>a-b)`: deduplicated, ascending numeric (ledger:156).
- `readInput(tx, index)` (ledger:125-144) returns `undefined`, so the input is silently ignored, in each of these cases:
  - the index is out of range or the input has no `sourceTransaction`;
  - `source.outputs[vout]` is missing;
  - the source script is not token-shaped, **or it is token-shaped but the codec refuses it** (ledger:132);
  - the source is a deploy at `vout ≠ 0` (`inputTokenId`, ledger:116-123).
- The role comes from the amount alone: `amount === 0n ? 'authority' : 'value'` (ledger:139). A spent deploy at vout 0 is therefore an **authority** input with `tokenId = <sourceTxid>_0`.
- `outpoint = `${sourceTxid}.${vout}`` (ledger:142), where `sourceTxid = source.id('hex')` (lowercase display hex).

### `buildLedger(txid, outputs, inputs): Map<string, TokenLedger>` (ledger:201-220)
- **Insertion order is semantic.** Outputs are added first, then inputs, each in the given order. Outputs are in index order and inputs in ascending index order. A token seen first among the inputs is appended after every output token. **Go must use an ordered slice plus an index map, not a bare map.**
- A deploy output is keyed by `deployTokenId(txid, output.index)` (ledger:215).
- `addOutput` (ledger:176-184):
  - a deploy role sets `deployIndex`;
  - amount `0n` pushes to `authorityOut`;
  - otherwise `valueOut += amount` and the index is pushed to `valueOutIndices`.
- `addInput` (ledger:186-193): amount 0 goes to `authorityIn`, otherwise to `valueIn` and `valueInIndices`.

### `specVerdicts(ledger): SpecVerdict` (ledger:230-240)
```
deployValid           = deployIndex === undefined || deployIndex === 0
authorized            = authorityIn.length > 0
isGenesis(i)          = deployValid && i === deployIndex
authorityOutputsValid = authorized || authorityOut.every(isGenesis)
valueOutputsValid     = authorized || valueIn >= valueOut || valueOutIndices.every(isGenesis)
```
Mandala uses only `authorityOutputsValid` (auth:152). A grep of `src/` finds `valueOutputsValid` only at its definition (ledger:61, 237): no layer reads it. Value creation is policed instead by `requireDeltaRule` (auth:244-256).

### Codec `Bsv21Binary.decode(script)` (b21:197-213): check order and detail strings
1. `!isTokenShaped` gives `'not a BRC-162 token output'`. This cannot be reached from `readTokenScript`.
2. **Any** chunk in the whole script with `invalidLength === true` gives `'truncated push'` (b21:200). This check covers every chunk, including the rest of the script.
3. `decodeTokenId(c[0])` (b21:174-180): `OP_0` means a deploy. Otherwise, `op !== 32 || data.length !== 32` gives `'token id must be a direct 32-byte push'`.
4. `decodeAmountChunk(c[1])` (b21:87-101):
   - `OP_0` reads as 0 and `OP_1..OP_16` as 1..16.
   - A chunk that is not a direct push (`1 <= op <= 9 && data.length === op`) gives `'amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes'`.
   - Then the checks run in this order: a top byte with `& 0x80` gives `'amount must not be negative'`; a non-minimal encoding (`isMinimalScriptNum`, b21:76-79) gives `'amount is not minimally encoded'`; `v <= 16` gives `'amounts 0..16 must use OP_0/OP_1..OP_16'`; `v > 2^64-1` gives `'amount exceeds 2^64-1'`.
   - The value is little-endian (b21:81-85).
5. `splitPayload(c.slice(3))` (b21:153-164): when the first chunk after the prefix is a push and the second is `OP_DROP`, the first chunk is the payload. The payload bytes come from `pushedBytes`: `OP_1NEGATE` gives `[0x81]`, `OP_1..16` give `[n]`, and any other push gives its `data ?? []`. `payloadCanonical = first.op === canonicalPushOp(payload)` (b21:124-132). Without a payload, `payloadCanonical` is `true`.
6. `restPubKeyHash` (b21:166-172) is set only when the rest is exactly `[OP_DUP, OP_HASH160, op==20, OP_EQUALVERIFY, OP_CHECKSIG]` and the push carries 20 data bytes. A PUSHDATA1 push of 20 bytes does not count.
7. `roleOf` (b21:182-185): no token id means `deploy`; amount 0 means `authority`; anything else means `value`.

`isTokenShaped` (b21:118-121) requires `chunks.length >= 3 && isPushOp(c[0].op) && isPushOp(c[1].op) && c[2].op === OP_2DROP`. `isPushOp(op)` holds for `op <= OP_PUSHDATA4 (0x4e)`, which includes OP_0, and for `op === OP_1NEGATE` and `OP_1..OP_16` (b21:53-55).

`tokenIdToString(bytes)` returns `` `${hex(reverse(bytes))}_0` `` and fails with `'token id must be 32 bytes'` (b21:112-115). `tokenIdFromString` requires `/^[0-9a-f]{64}_0$/` (b21:103-109).

### SDK chunk parser semantics the Go chunker must reproduce (scr:599-632)
- An `OP_RETURN` (0x6a) **outside a conditional block** becomes one chunk whose `data` is every remaining byte, and parsing stops (scr:608-611). In the `token-shaped-garbage` vector (gen:718-727) the OP_RETURN is the last byte, so its data is empty. The vector only shows that OP_RETURN still yields a chunk, so the script keeps ≥ 3 chunks and stays token-shaped. No vector exercises the swallowing of trailing bytes.
- `OP_IF/OP_NOTIF/OP_VERIF/OP_VERNOTIF` raise the conditional depth and `OP_ENDIF` lowers it (scr:613-617).
- A push opcode `1..0x4e` reads its length. When the data or the length bytes run past the end, the chunk is kept with the bytes that are present and with `invalidLength = !hasLength || end - pos !== len` (scr:619-625). This flag is the source of the `'truncated push'` refusal (vector `truncated-push-after-prefix`, gen:728-732, script hex `20<id32>556d4c05aa`).
- Every other opcode becomes `{op}`, with no data (scr:627).

---

## 2. Layer B: `mandala/ownership.ts`

Constants and helpers:
- `MAX_SAFE = 9007199254740991n` (own:26).
- `COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/` (own:52).
- `canonicalKey(k) = PublicKey.fromString(k).toString()` (own:57). It accepts upper case or uncompressed input and returns compressed lowercase.
- `sameBytes` (own:59-60).
- `isIdentity(v)`: a string that matches COMPRESSED_KEY (own:62-63). This is a regex only, with **no on-curve check**.
- `sameAmount(stored: number, amount: bigint)`: `Number.isSafeInteger(stored) && BigInt(stored) === amount` (own:65-66).

```ts
interface VerifiedOwner { index: number; tokenId: string; role: Bsv21Role; amount: bigint;
  identityKey: string /* compressed lowercase */; prover: string /* compressed lowercase */ }   // own:28-37
interface InputOwnerDeps { store: MandalaStateStore; engine: EngineOutputReader; verifierWallet: WalletInterface;
  topic: string; onRepair: (outpoint: string, inserted: boolean) => void }                    // own:39-50
```

### `requireValidTokenOutputs(invalid, outputs): void` (own:107-116)
The checks are **rule-major**: each rule scans every output in index order before the next rule runs (own:101-106). The first failing rule throws, at its first failing index (`rejectFirst`, own:72-79).
1. `invalid[0]` throws `Reasons.invalidTokenOutput(first.index, first.detail)` (own:82-85).
2. `role === 'deploy' && index !== 0` throws `Reasons.deployNotAtZero(i)` (own:89-90).
3. `restPubKeyHash === undefined` throws `Reasons.nonP2pkhRemainder(i)` (own:92-93).
4. `satoshis !== 1` throws `Reasons.oneSat(i)` (ERR_SATOSHIS) (own:95-96).
5. `amount > MAX_SAFE` throws `Reasons.amountCap(i)` (own:98-99).

Vectors pin the precedence: `precedence-codec-before-satoshis` and `precedence-satoshis-before-amount-cap` (gen:778-793).

### `verifyOutputOwners(outputs, env, verifierWallet): Promise<VerifiedOwner[]>` (own:144-158)
Runs in output index order and covers **every role**:
- `linkage = env.outputs.find(e => e.index === output.index)?.linkage`.
- `linkedIdentity(linkage, wallet, output.restPubKeyHash)` (own:125-138) returns `undefined` when:
  - the linkage is undefined or the pkh is undefined;
  - `verifyKeyLinkage` throws (a malformed linkage, a ciphertext that does not decrypt, a bad key);
  - the derived pkh is not equal to the pkh in the script.
- Otherwise it returns `{identityKey: canonicalKey(verified.identityKey /* = linkage.counterparty */), prover: canonicalKey(linkage.prover)}`. Everything runs inside one try, so a non-key `prover` also gives `undefined`.
- `undefined` throws `Reasons.noLinkage(index)`.
- `env.outputs` entries for indices that are not token outputs, and extra entries in general, are **ignored**. Only `admin` has an orphan check.

### `resolveInputOwners(inputs, tx, env, deps): Promise<Map<number,string>>` (own:362-377)
Runs per input in ascending order, and each input is fully judged (owner, then linkage) before the next starts. So a linkage error on input 0 wins over an index fault on input 1.
1. `sourceOf(tx, input)` (own:171-187) re-decodes the source script and returns `{txid (from outpoint), vout, script: lockingScript.toBinary(), role: decoded.role (so 'deploy' for a deploy), pubKeyHash: decoded.restPubKeyHash}`. A missing script is a plain Error (own:176). It cannot be reached.
2. `storedOwner(input, source, store)` (own:245-256):
   - A value role reads `store.getTokenRow(txid, vout)`; any other role reads `store.getAuthorityRow(txid, vout)`. A read fault throws `Reasons.storeUnavailable('the owner index', cause)` (`fromIndex`, own:191-197).
   - The owner is accepted when `rowAgrees` holds (own:239-243): the row is not null, `row.tokenId === input.tokenId`, `isIdentity(row.identityKey)`, and for a value role also `row.amount !== undefined && sameAmount(row.amount, input.amount)`.
   - **The authority row's `topic` is not compared.**
3. If no stored owner is found, `repairedOwner(input, source, deps)` runs (own:292-321). It is §4.2a rule 3:
   - Reads `journal = store.getOwnerJournal(txid, vout, topic)`, **then** `admitted = engine.findAdmittedOutput(txid, vout, topic)`. Both reads go through fromIndex, so a fault gives `storeUnavailable('the owner index')`.
   - If `journal === null || admitted === null || !journalAgrees || !sameBytes(admitted.lockingScript, source.script)`, it throws `Reasons.ownerIndexUnavailable(input.outpoint)` (ERR_UNAVAILABLE).
   - `journalAgrees` (own:261-269) requires `tokenId` equal, `journal.role === source.role` (the script's role, so a spent deploy journals as `'deploy'`), `sameAmount`, and `isIdentity`.
   - Then `{inserted} = store.repairOwnerRow(journal)`. A write fault gives `storeWriteUnavailable('the owner index')` (`toIndex`, own:199-205).
   - If `inserted && stillAdmitted(...) === null`, it calls `takeBackRepair(store, txid, vout, journal.role)` (write fault: storeWriteUnavailable) and then throws `ownerIndexUnavailable(outpoint)`. `stillAdmitted` is read through fromIndex (own:272-276).
   - Otherwise `deps.onRepair(input.outpoint, inserted)` runs and `journal.identityKey` is returned.
4. `requireInputLinkage(input, source, owner, env, wallet)` (own:341-355):
   - `entry = env.inputs.find(e => e.index === input.index)`. With no entry the step passes: input linkage is optional.
   - `linkedProver` (own:325-337) calls `verifyInputKeyLinkage` (base = `linkage.prover`). It returns `undefined` on a throw, a missing pkh, or a pkh mismatch. Otherwise it returns `canonicalKey(verified.identityKey /* = prover */)`.
   - `undefined` throws `Reasons.inputLinkageControl(i)`.
   - `prover !== owner` (an exact string compare) throws `Reasons.inputLinkageOwner(i, prover, owner)`.
5. `owners.set(input.index, owner)`.

### `takeBackRepair(store: RepairUndoStore, txid, outputIndex, role): Promise<void>` (own:219-231)
- If `role !== 'value'`, it calls `store.takeAuthority(txid, outputIndex)`.
- Otherwise `row = store.takeToken(...)`, and if the row is not null it calls `store.adjustBalance(row.identityKey, -row.amount)`.
- `RepairUndoStore = Pick<MandalaStateStore, 'takeToken'|'takeAuthority'|'adjustBalance'>` (own:208-211).

---

## 3. Layer C: `mandala/authority.ts`

```ts
interface AuthorityDeps { trustedIssuers: ReadonlySet<string>; store: MandalaStateStore; registry: boolean }   // auth:31-36
interface CommittedAction { tokenId: string; outputIndex: number; details: AdminDetails; detailsHex: string; commitment: number[] } // auth:38-44
interface AuthorityResult { actions: CommittedAction[]; deltas: Map<string, bigint>; adminTokens: Set<string> }        // auth:46-53
```
Constants:
- `PLAIN_AUTHORITY = 'plain authority'` (auth:56).
- `ZERO = {rule: '= 0', holds: d => d === 0n}` (auth:63).
- `DELTA_RULES`: `issue` → `{rule: '> 0'}`, `redeem` → `{rule: '< 0'}` (auth:64-67).
- `trusted = lowered(deps.trustedIssuers)` (auth:69-70, 332).

Helpers:
- `readAssetState(store, tokenId)` (auth:73-82) is exported and also used by layer D. A fault gives `storeUnavailable('the asset state', cause)`.
- `readSupply` (auth:84-90): a fault gives `storeUnavailable('the circulating supply', cause)`.
- `ownerAt` (auth:92-96): a missing owner is a plain Error.

### `checkAuthority(txid, ledger, outputs, owners, inputOwners, env, deps): Promise<AuthorityResult>` (auth:322-349)
`ledgers = [...ledger.values()]`, in ledger insertion order. The steps run in this order:

1. **`requireValidDeploys`** (auth:100-113). Runs in output order and only for `role === 'deploy'`. Layer B has already put any deploy at index 0.
   - (a) `amount > 0n` throws `Reasons.fixedSupply()`.
   - (b) `deployMetadata(output.payload, output.payloadCanonical)` throws `Reasons.deployPayload(...)`. See §5.
   - (c) `!verifyDeploySig(txid, env.deploySig, owner.identityKey)` throws `Reasons.deploySig()`.
2. **`requireTrustedOutputs(owners, trusted)`** (auth:117-130). This step is **per output, not rule-major.** Owners are walked in index order and value owners are skipped. For each owner: a lowercased `identityKey` outside `trusted` throws `untrustedOwner(index, owner.identityKey)`; **then**, for the same output, a lowercased `prover` outside `trusted` throws `untrustedProver(index, owner.prover)`. Only after both pass does the next output start.
3. **`requireTrustedAuthorityInputs`** (auth:135-146). Takes `ledgers.flatMap(l => l.authorityIn)`, sorted ascending. For each index: a missing owner in `inputOwners` is a plain Error, and an owner outside `trusted` throws `untrustedAuthorityInput(index, owner)`.
4. **`requireAuthorityInputs`** (auth:150-156). In ledger order, `!specVerdicts(l).authorityOutputsValid` throws `authorityWithoutInput(l.authorityOut[0], l.tokenId)`.
5. **`requireContinuity`** (auth:158-164). In ledger order, `authorityIn.length > 0 && authorityOut.length === 0` throws `continuity(tokenId)`.
6. **`committedActions(ledgers, outputs, env, registry)`** (auth:208-225). The allowed kinds are `REGISTRY_KINDS` when `registry` is true, otherwise `ADMIN_KINDS`. For each ledger in order:
   - `commitmentsOf(outputs, tokenId)` (auth:175-181) collects outputs with `role === 'authority'` (**never a deploy**) and the same tokenId, each with `commitmentOf(payload, payloadCanonical)` defined.
   - `> 1` commitment throws `twoCommitments(tokenId)`.
   - Exactly one runs `verifyCommittedAction` (auth:183-200):
     - no `env.admin` entry with that index throws `missingDetails(index)`;
     - otherwise `decodeAdminDetails(entry.details, allowedKinds, index)` runs, and its schema errors win;
     - then `toHex(sha256(bytes)) !== toHex(commitment)` throws `commitmentMismatch(index)`.
   - After all ledgers, `requireNoOrphanDetails` (auth:202-206) throws `orphanDetails(entry.index)` for the first `env.admin` entry, in **envelope array order**, whose index is not a committed outputIndex.
7. If `registry`, **`requireNoValueOutputs`** (auth:229-232): the first output with `role === 'value'` throws `registryValue(index)`.
8. **`requireDeltaRule`** for each ledger in order (auth:244-256), with `delta = valueOut - valueIn` (auth:239):
   - `authorityIn.length === 0` and `delta !== 0n` throws `holderConservation(tokenId, valueIn, valueOut)`.
   - Otherwise `kind = action?.details.kind ?? 'plain authority'`. When `kind === 'reissue'` the step returns early and step 10 checks the reissue.
   - Otherwise `{rule, holds} = DELTA_RULES.get(kind) ?? ZERO`, and `!holds(delta)` throws `deltaRule(tokenId, kind, rule, delta)`.
   - So every admin kind other than issue, redeem and reissue (pause, setFeeRate, …) needs `delta = 0`.
9. **`requireCaps`** (auth:260-273). Runs per ledger in order:
   - `valueIn > MAX_SAFE || valueOut > MAX_SAFE` throws `sumCap(tokenId)`.
   - `delta > 0n && readSupply(store, tokenId) + delta > MAX_SAFE` throws `supplyCap(tokenId)`. **The supply is read only when delta > 0.**
10. **`requireValidReissues`** (auth:304-314) runs per ledger whose action kind is `'reissue'`. `requireValidReissue` (auth:280-302):
    - `target = (details.outpoint ?? '').toLowerCase()`;
    - `state = readAssetState(store, tokenId)`;
    - `frozen = state.frozenOutpoints.find(f => f.outpoint.toLowerCase() === target)`; none throws `reissue(tokenId, 'target is not frozen')`;
    - `!amountIs(frozen.amount, delta)` (safe integer and equal, auth:277-278) throws `reissue(tokenId, 'amount does not match the frozen row')`;
    - `valueInIndices.length > 0` throws `reissue(tokenId, 'must not spend value inputs')`;
    - if any owner with this tokenId and role value has a lowercased identityKey different from the lowercased `details.recipient`, it throws `reissue(tokenId, 'outputs must go to the recipient')`.
11. Returns `actions` (at most one per token, in ledger order), `deltas` (every ledger's Δ), and `adminTokens` (the tokens with `authorityIn.length > 0`) (auth:344-348).

Fact: `checkAuthority` does not persist anything. Actions are folded by `MandalaLookupService` (`foldAction` at `src/mandala/MandalaLookupService.ts:179`, `txOrdering` at `:317`). Those files are out of scope.

### Registry rule `requireFirstRegistry(outputs)` (rtm:105-119)
- `deploy = outputs.find(o => o.role === 'deploy')`. With no deploy the step passes.
- `claimed = registry.registryTokenId()`. A fault gives `storeUnavailable('the registry', cause)` (rtm:113-119).
- `claimed !== null && claimed !== deploy.tokenId` throws `registryExists()`.

---

## 4. Layer D: `mandala/controls.ts`

```ts
interface ControlDeps { store: MandalaStateStore; screening: ScreeningProvider; membership?: MembershipProvider;
  exempt: ReadonlySet<string> /* trusted ∪ overlay identity */ }   // ctl:17-23
```
### `checkControls(ledger, inputs, inputOwners, owners, auth, deps): Promise<void>` (ctl:145-163)
`parties = {inputs, inputOwners, owners, exempt: lowered(deps.exempt)}`.

1. **Per token**, in `ledger.keys()` order (the ledger's insertion order), sequentially: `requireTokenControls(tokenId, auth.adminTokens.has(tokenId), parties, store)` (ctl:77-89).
   - `tokenInputs = inputs.filter(i => i.tokenId === tokenId)`. Order is preserved, so this is ascending input order.
   - `state = readAssetState(store, tokenId)`. This runs for **every** token, including a fresh deploy, which reads the default state. A fault gives `storeUnavailable('the asset state')`.
   - `requireSpendableInputs(state, tokenInputs)` (ctl:36-44). For each input in order: a lowercased outpoint in the lowercased `frozenOutpoints[].outpoint` throws `frozenInput(index, input.outpoint)`; **then**, for the same input, a lowercased outpoint in the lowercased `evictedOutpoints` throws `evictedInput(index, input.outpoint)`. The reason prints the original `input.outpoint`.
   - `isAdmin` makes the step return here. **Frozen and evicted checks apply even to admin transactions; pause and access do not.**
   - `state.isPaused` throws `paused(tokenId)`.
   - `requireAccess(tokenId, state, tokenParties(tokenId, tokenInputs, parties))` (ctl:65-75):
     - `tokenParties` (ctl:56-62) lists this token's output owners' identityKeys in index order, then this token's input owners in input order. All are lowercased and the exempt keys are removed. The list is **not deduplicated**.
     - When `accessMode === 'denylist'`, the first party in the lowercased `blockedIdentities` throws `blocked(tokenId, party)`.
     - **Any other mode** is read as an allowlist and fails closed: the first party not in the lowercased `allowedIdentities` throws `notAllowed(tokenId, party)`. The reason prints the lowercased party.
2. `identities = allIdentities(parties)` (ctl:94-100) lists every output owner (all tokens and roles, index order), then every input owner (input order). All are lowercased and **deduplicated with a JS Set, first occurrence wins**.
3. `requireNotSanctioned(screening, identities)` (ctl:116-125) checks **every** identity, the exempt ones included. Order matters. `verdictOf` (ctl:104-114): a throw **or** a non-boolean answer gives `storeUnavailable('the screening provider', cause)`. `true` throws `sanctioned(key)`.
4. `requireMembers(membership, identities.filter(k => !exempt.has(k)))` (ctl:127-138):
   - With no membership provider the step passes.
   - `isActive()` goes through verdictOf with `'the membership provider'`. `false` makes the step pass.
   - Then per key in order: `isAdmitted(key)` (verdictOf, same label) returning `false` throws `notMember(key)`.

`ownerOfInput`: a missing owner is a plain Error (ctl:28-32).

---

## 5. `mandala/details.ts`: AdminDetails, schemas, deploy and authority payloads

```ts
type AdminKind = 'issue'|'redeem'|'reissue'|'pause'|'unpause'|'blockIdentity'|'unblockIdentity'|'allowIdentity'
               |'unallowIdentity'|'setAccessMode'|'freezeOutput'|'unfreezeOutput'|'setFeeRate'      // det:21-34
type RegistryKind = 'admitIdentity'|'revokeIdentity'                                                // det:35
ADMIN_KINDS (det:37-51, order as above); REGISTRY_KINDS = ['admitIdentity','revokeIdentity'] (det:52)
interface AdminDetails { kind; bankRef?: number[] /*32B*/; outpoint?: string /*`<display txid>.<vout>`*/;
  recipient?: string; identityKey?: string /*compressed lowercase hex*/; mode?: 'denylist'|'allowlist';
  feeRatePerKb?: number|null; reason?: string }                                                     // det:54-67
```
### SCHEMAS (det:82-98). Every kind also accepts `reason`, read last (det:81, 215).
| kind | required | optional |
|---|---|---|
| issue | – | bankRef |
| redeem, pause, unpause | – | – |
| reissue | outpoint, recipient | – |
| blockIdentity, unblockIdentity, allowIdentity, unallowIdentity, admitIdentity, revokeIdentity | identityKey | – |
| setAccessMode | mode | – |
| freezeOutput, unfreezeOutput | outpoint | – |
| setFeeRate | feeRatePerKb | – |

### Field readers and rule strings (det:113-172). A reader returns `undefined` for an invalid value, which throws `fail(rule)`.
| field | accepted | rule string (verbatim) |
|---|---|---|
| bankRef | CBOR bytes, length 32 | `bankRef must be 32 bytes` |
| outpoint | CBOR bytes, length 36, read as `hex(reverse(b[0..32])) + '.' + LE-u32(b[32..36])` (det:122-128) | `outpoint must be 36 bytes` |
| recipient | 33 bytes and `PublicKey.fromDER(b).toDER('hex') === hex(b)` (canonical compressed and on the curve, det:132-141) | `recipient must be a 33-byte compressed public key` |
| identityKey | same as recipient | `identityKey must be a 33-byte compressed public key` |
| mode | text `'denylist'` or `'allowlist'` | `mode must be denylist or allowlist` |
| feeRatePerKb | CBOR `null` gives null; a uint (bigint) in `1..2^53-1` gives a number (det:146-149) | `feeRatePerKb must be a safe integer >= 1 or null` (`FEE_RATE_RULE`, det:159) |
| reason | text | `reason must be text` |

### `decodeAdminDetails(detailsHex, allowed, outputIndex): {details, commitment}` (det:248-262)
`fail = d => Reasons.detailsSchema(outputIndex, d)`. The checks run in this order:
1. `!/^([0-9a-f]{2})+$/.test(detailsHex)` gives `'details must be lowercase hex'`. The envelope decoder enforces this earlier, so this is unreachable via `tm` and acts as defence in depth.
2. `decodeStrictCbor(bytes)`: a `StrictCborError` message passes through (det:178-184). Other errors are rethrown.
3. `readKind` (det:201-213):
   - an absent kind gives `'missing key kind'`;
   - a kind that is not a string gives `'kind must be text'`;
   - a kind outside `allowed`, or without an own property in SCHEMAS, gives `` `kind ${kind} is not allowed` ``.
4. `rejectUnknownKeys` (det:217-221): `known = {'kind', ...required, ...optional, 'reason'}`. It sorts the unknown keys in CBOR order (`cborKeyRank`, which is the 4-hex-digit UTF-8 byte length followed by the hex bytes, det:188-197) and throws for the first with `` `unknown key ${key}` ``. **Go must sort explicitly: Go map iteration is random, and JS `Object.keys` puts integer-like keys first.**
5. `readFields` (det:229-241) iterates `keysOf(schema)` = required, then optional, then `'reason'`. A present key is read and may throw its rule. An absent required key gives `` `missing key ${field}` ``. Note the interleaving: a missing earlier required field reports before a later field's bad value. For reissue, `outpoint` is read before `recipient`.
6. `commitment = sha256(bytes)` (det:261).

### `deployMetadata(payload, payloadCanonical)` (det:333-351). Each refusal is `Reasons.deployPayload(detail)`.
The checks run in this order:
1. `payload === undefined` gives `'missing payload'`.
2. `!payloadCanonical` gives `'non-canonical payload push'`.
3. A strict CBOR decode error passes its `StrictCborError` message through.
4. The keys are then checked in this order: `sym`, `dec`, `label` (`requireKey`, det:315-326):
   - an absent key gives `` `missing key ${key}` ``;
   - `sym` fails with `'sym must be text of 1-32 characters'` (code points, `[...value].length`; Go: `utf8.RuneCountInString`, det:305-310);
   - `dec` fails with `'dec must be an integer 0-18'` (a bigint `<= 18n`, det:312-313);
   - `label` fails with `'label must be text of 1-64 characters'`.
5. `feeRatePerKb = readFeeRate(map.feeRatePerKb ?? null)`. Absent and null both read as null, and an invalid value gives `FEE_RATE_RULE`.

Unknown keys are **ignored** in a deploy payload (det:329-331). The function returns `{sym, dec, label, feeRatePerKb}`.

### `commitmentOf(payload, payloadCanonical): number[] | undefined` (det:354-361)
It returns `undefined` when the payload is missing or non-canonical. Otherwise it reads `tryDecodeStrictCbor(payload)?.adm` and returns it when it is bytes of length 32. A payload that is not strict CBOR **silently means no commitment** (no reject). Other keys are ignored.

### `encodeAdminDetails(d)` (det:286-301)
This is the writer. It applies no schema check. `outpointBytes` requires `/^([0-9a-f]{64})\.(0|[1-9]\d{0,9})$/` with vout ≤ 0xffffffff, and otherwise throws a plain Error `'outpoint must be <64 lowercase hex txid>.<vout 0..4294967295>'` (det:267-281).

### Strict CBOR decoder `decodeStrictCbor(input)` (cbor:251-265): check order and verbatim strings
1. `input.length > 4096` gives `'input exceeds 4096 bytes'`.
2. `head()` (cbor:139-150):
   - running out of bytes gives `'truncated input'` (cbor:127, 132);
   - `info > 27` gives `'indefinite length'` when `info === 31`, otherwise `'reserved additional info'`. **This is checked before the major type**, so 0x9f gives `'indefinite length'`, not a major-type error;
   - an argument below the minimum for its width (24 / 0x100 / 0x10000 / 0x100000000) gives `'non-minimal header'`.
3. A top-level major type that is not 5 gives `'top level must be a map'`.
4. `count(v)`: `v > input.length` gives `'length exceeds input'` (cbor:153-156).
5. `decodeMapBody` (cbor:229-249):
   - depth > 4 gives `'map nesting deeper than 4'` (top level = depth 1);
   - a key that is not major 3 gives `'map key must be text'`;
   - a key with invalid UTF-8 gives `'invalid UTF-8'` (strict RFC 3629 hand validator, cbor:162-197);
   - an encoded key that is not strictly greater than the previous one bytewise gives `'map keys unsorted or duplicated'`.
6. `decodeValue` (cbor:211-227):
   - major 0 gives a bigint, 2 gives bytes, 3 gives text (UTF-8 validated), 5 gives a nested map;
   - major 7 values 20/21/22 give false/true/null, and any other value gives `'simple value or float not allowed'`;
   - majors 1, 4 and 6 give `` `major type ${major} not allowed` ``.
7. Leftover bytes give `'trailing bytes'`.
8. The map is re-encoded and compared with the input. A difference gives `'non-canonical encoding'`.

`tryDecodeStrictCbor` returns `undefined` only for a StrictCborError (cbor:267-276). Limits: `STRICT_CBOR_MAX_BYTES = 4096` and `STRICT_CBOR_MAX_DEPTH = 4` (cbor:12-13). Integers may be up to 2^64-1.

---

## 6. `deploySig.ts` and `verifyKeyLinkage.ts` (the crypto seams)

### Deploy signature (dsig)
- `DEPLOY_PREFIX = 'mandala-deploy:'` (dsig:9).
- `deployDigest(txid) = utf8('mandala-deploy:' + txid)`, where the txid is 64 lowercase hex in display order (dsig:13-15).
- `verifyDeploySig(txid, signatureHex | undefined, ownerIdentityKey): Promise<boolean>` (dsig:22-40):
  - It returns false when the signature is undefined or fails `/^([0-9a-f]{2})+$/`.
  - Otherwise it runs `new ProtoWallet('anyone').verifySignature({data: deployDigest(txid), signature: hexToBytes(sig), protocolID: [2, 'mandala deploy'], keyID: '1', counterparty: ownerIdentityKey})`. **Any throw is false.** ProtoWallet throws `ERR_INVALID_SIGNATURE` on mismatch (pw:388-392), so a mismatch also reads as false.
  - Verification path (pw:358-394):
    - `hash = sha256(data)` (pw:59-74);
    - `key = derivePublicKey(...)` with `forSelf` undefined: the owner's public BRC-42 child for root `'anyone'`, where 'anyone' is `PrivateKey(1)` (kd:143-144). The invoice number is `'2-mandala deploy-1'` (kd:470-511);
    - `Signature.fromDER(signature)` (pw:377);
    - `verify(BigNumber(hash), sig, key)` (pw:381).
  - UNVERIFIED: whether `Signature.fromDER` or `verify` reject non-canonical DER or high-S. Project memory says Chronicle does not need low-S. The Go side must accept exactly what the TS side accepts.

### Key linkage (vkl)
- `deriveLinkedKey(linkage, verifierWallet, identityKey)` (vkl:21-39):
  - It calls `verifierWallet.decrypt({ciphertext: linkage.encryptedLinkage, protocolID: [2, `specific linkage revelation ${linkage.protocolID[0]} ${linkage.protocolID[1]}`], keyID: linkage.keyID, counterparty: linkage.prover})`.
  - Then `offset = G·BigNumber(plaintext)`, where the plaintext is read as a big-endian scalar, and `derived = PublicKey.fromString(identityKey) + offset`.
  - It returns `{identityKey, derivedKey (compressed hex), pubKeyHash: hash160(derivedKey bytes)}`.
- `verifyKeyLinkage` (for outputs) uses base = **`linkage.counterparty`** (vkl:46-51).
- `verifyInputKeyLinkage` (for inputs) uses base = **`linkage.prover`** (vkl:62-67).
- `linkageControlsPubKeyHash` (vkl:69-81) has no caller in `src/`: grep finds only its definition.
- Ciphertext layout: `iv(32) || ciphertext || authTag(16)` AES-GCM (sk:40, sk:198-227 with `ivLength = 32`). The symmetric key comes from `deriveSymmetricKey(protocolID, keyID, counterparty)` (pw:268-281).
- Invoice normalisation (kd:470-511):
  - The security level must be an integer 0..2.
  - `protocolName = protocolID[1].toLowerCase().trim()`.
  - The keyID length must be between 1 and 800 (kd:476-481). A non-string keyID never reaches this point, because ProtoWallet validates the arguments first (next bullet).
  - The name length must be ≥ 5. Names of 400+ characters are allowed only with the `'specific linkage revelation '` prefix, up to 430.
  - The name may not contain two spaces in a row, must match `/^[a-z0-9 ]+$/`, and may not end in `' protocol'`.
- Counterparty handling: `'self'` means the root public key, `'anyone'` means `PrivateKey(1)`'s public key, and any other string goes through `PublicKey.fromString` (kd `normalizeCounterparty`).
- **ProtoWallet validates the arguments before deriving anything.** `decrypt` calls `validateWalletDecryptArgs` (pw:269), which lives in `../../sdk/src/wallet/validationHelpers.ts:1758-1762`. Any failure throws, and the layers turn the throw into `noLinkage` or `inputLinkageControl`. The checks are:
  - `validateEncryptionArgs` (:224-230) requires `protocolID` to be a 2-tuple with an integer level 0..2 and a string name of 5..400 UTF-8 bytes (`validateProtocol` :198-205). The protocol name is the template string vkl builds, so it is always a string.
  - `keyID` must be a **string** of 1..800 UTF-8 bytes (`validateStringLength` :348-356). A non-string keyID throws.
  - `counterparty` (`linkage.prover`) must be `'self'`, `'anyone'`, or 66 hex characters that form a valid compressed key (`validateCounterparty` :193-196, `validatePublicKey` :185-191). `validateHexString` (:522-534) **trims the value and accepts upper-case hex**, which it lowercases. An uncompressed prover therefore throws.
  - `ciphertext` must be a dense array of integers 0..255 (`validateByteArray` :146-177).

---

## 7. `types.ts`: wire envelope, records, providers

### Envelope (types:5-22)
```ts
SpecificLinkage { prover: string; verifier: string; counterparty: string; protocolID: [0|1|2, string];
  keyID: string; encryptedLinkage: number[]; encryptedLinkageProof: number[]; proofType: number }
MandalaEnvelope { inputs: Array<{index:number; linkage: SpecificLinkage}>; outputs: same;
  admin: Array<{index:number; details:string /*lowercase hex*/}>; deploySig?: string /*lowercase hex*/ }
```
`encodeEnvelope(e)` = `utf8(JSON.stringify(e))` (types:148-150). The key order is the object's insertion order. The vectors use `{"inputs","outputs","admin"[,"deploySig"]}` (see `vec`).

### `decodeEnvelope(bytes | undefined): MandalaEnvelope` (types:187-201). Every refusal is `Reasons.envelope(detail)`, which reads `` `Mandala payload ${detail}` ``.
1. `undefined` or zero-length input gives the empty envelope `{inputs:[],outputs:[],admin:[]}`.
2. `parseJson` (types:155-161) runs `TextDecoder(fatal:true, ignoreBOM:true)` and then `JSON.parse`. Any failure gives `'must be UTF-8 JSON'`. **A leading BOM is kept and makes JSON.parse fail** (types:141-144).
3. A value that is not a plain object (including an array or null) gives `'must be an object'`.
4. `readList(payload, label)` runs for `'inputs'`, then `'outputs'`, then `'admin'` (types:171-184):
   - **only `=== undefined` counts as absent; `null` gives `` `${label} must be an array` ``**;
   - an entry whose `index` is missing or not a safe non-negative integer, or a duplicate index, gives `` `${label} must contain unique non-negative integer indices` ``. A non-object entry also fails this way.
5. If any `admin[].details` is not a lowercase-hex string of even length 2 or more, it gives `'admin details must be lowercase hex'`.
6. When `deploySig` is not `=== undefined` and fails the lowercase-hex test, it gives `'deploySig must be lowercase hex'`. `null` and `""` both fail.
7. Linkage objects are **not shape-checked** here. A bad linkage surfaces later as `noLinkage` or `inputLinkageControl`.

### Persisted records (§6.6) (types:26-93)
```ts
MandalaOwnerRecord   { txid; outputIndex; topic; tokenId; role: 'deploy'|'authority'|'value'; amount: number; identityKey; createdAt: Date }
MandalaTokenRecord   { txid; outputIndex; tokenId; amount: number; identityKey; createdAt }
MandalaAuthorityRecord { txid; outputIndex; topic; tokenId; identityKey; createdAt }
MandalaMetadataRecord { tokenId; txid; outputIndex: 0; sym; dec: number; label; feeRatePerKb: number|null }
AdminHistoryEntry { tokenId; txid; outputIndex; kind; detailsHex; commitment: string; delta: number; height; offset;
                    admitSeq; createdAt; frozenAmount?: number; frozenOwner?: string }
MandalaLinkageRecord { txid; outputIndex; identityKey; linkage: SpecificLinkage; createdAt }
```
### Providers (types:97-135)
```ts
ScreeningProvider { isSanctioned(identityKey): Promise<boolean> }
InMemoryScreeningProvider(keys = []) // lowercases its list and the query (types:101-111)
MembershipProvider { isActive(): Promise<boolean>; isAdmitted(identityKey): Promise<boolean> }
EngineOutputReader {
  findAdmittedOutput(txid, outputIndex, topic): Promise<{lockingScript: number[]; satoshis: number} | null>
     // a spent output MUST read as null (types:120-124)
  listUnspentAdmittedOutputs(topic, after: {txid, outputIndex} | null, limit): Promise<Array<{txid, outputIndex}>>
}
```

### Journal write `journalOwners(store, topic, txid, owners)` (tm:134-145)
- The rows are built by `journalRows` (tm:100-116): one row per verified owner, `amount: Number(o.amount)` (exact, because amounts are capped at 2^53-1), and one shared `new Date()`.
- A store fault throws `storeWriteUnavailable('the owner journal', cause)`.

---

## 8. `reject.ts`: the reason catalog (verbatim; cross-engine contract, rej:1-5)

`MandalaReject extends Error` has `{name: 'MandalaReject', code, reason}`, and `message === reason` (rej:36-46). `isMandalaReject(e)` is a structural check: `name === 'MandalaReject'`, a code in `CODES`, and `reason` a string (rej:52-61). Codes (rej:7-34): `ERR_SHAPE, ERR_SATOSHIS, ERR_LINKAGE, ERR_CONSERVATION, ERR_AUTHORITY, ERR_UNTRUSTED, ERR_PAUSED, ERR_FROZEN, ERR_ACCESS, ERR_SANCTIONED, ERR_MEMBERSHIP, ERR_UNAVAILABLE`. Infra rejects keep `cause` (rej:74-76).

`Amount = bigint | number`, interpolated with JS `${}`: a bigint prints with no `n`, and a negative delta prints as `-40` (rej:63, 130-133).

| key (rej line) | code | template (verbatim) | thrown from | vector id(s) |
|---|---|---|---|---|
| invalidTokenOutput (86) | ERR_SHAPE | `output ${i}: token-shaped output is not a valid BRC-162 token output (${detail})` | own:84 | amount-*, token-id-*, token-shaped-garbage, truncated-push-after-prefix, precedence-codec-before-satoshis |
| nonP2pkhRemainder (88) | ERR_SHAPE | `output ${i}: token output remainder must be a P2PKH lock` | own:93 | remainder-not-p2pkh |
| oneSat (90) | ERR_SATOSHIS | `output ${i}: token output must carry exactly 1 satoshi` | own:96 | two-satoshi-output, precedence-satoshis-before-amount-cap |
| amountCap (92) | ERR_SHAPE | `output ${i}: token amount exceeds 2^53-1` | own:99 | amount-above-2^53-1 |
| sumCap (93) | ERR_SHAPE | `token ${id}: value sum exceeds 2^53-1` | auth:266 | value-sum-above-2^53-1 |
| supplyCap (94) | ERR_SHAPE | `token ${id}: circulating supply would exceed 2^53-1` | auth:270 | circulating-supply-above-2^53-1 |
| noLinkage (95) | ERR_LINKAGE | `output ${i}: token output with no verified linkage` | own:153 | linkage-missing, linkage-for-another-key, linkage-sealed-for-another-verifier, linkage-malformed |
| inputLinkageControl (96) | ERR_LINKAGE | `input ${i}: linkage does not control the coin being spent` | own:351 | input-linkage-does-not-control-the-coin, input-linkage-malformed |
| inputLinkageOwner (98) | ERR_LINKAGE | `input ${i}: linkage names ${named} but the coin is owned by ${owner}` | own:354 | input-linkage-names-another-owner |
| ownerIndexUnavailable (100) | ERR_UNAVAILABLE | `owner index unavailable for ${op}` | own:310, 317 | owner-index-row-and-journal-missing, owner-index-journal-disagrees-with-the-script |
| storeUnavailable (101) | ERR_UNAVAILABLE | `${what} could not be read; retry` | see below | none (excluded from the coverage test, gen:1662-1675) |
| storeWriteUnavailable (103) | ERR_UNAVAILABLE | `${what} could not be written; retry` | see below | none (excluded) |
| untrustedOwner (105) | ERR_UNTRUSTED | `output ${i}: owner ${k} is not a trusted issuer` | auth:124 | deploy-by-untrusted-owner, authority-handed-to-untrusted-owner |
| untrustedProver (107) | ERR_UNTRUSTED | `output ${i}: linkage prover ${k} is not a trusted issuer` | auth:127 | deploy-with-untrusted-linkage-prover |
| untrustedAuthorityInput (109) | ERR_UNTRUSTED | `input ${i}: authority owner ${k} is not a trusted issuer` | auth:144 | authority-input-owned-by-an-untrusted-key |
| fixedSupply (111) | ERR_AUTHORITY | `output 0: fixed-supply deploys are not allowed` | auth:108 | deploy-fixed-supply |
| deploySig (112) | ERR_AUTHORITY | `output 0: deploy requires a valid deploySig over this txid` | auth:111 | deploy-without-deploysig, deploysig-over-another-txid, deploy-replayed-with-the-original-signature |
| deployNotAtZero (113) | ERR_SHAPE | `output ${i}: a deploy must be output 0` | own:90 | deploy-not-at-zero |
| authorityWithoutInput (114) | ERR_AUTHORITY | `output ${i}: authority output without an admitted authority input of token ${id}` | auth:153 | authority-output-without-authority-input, authority-input-not-admitted, registry-authority-input-not-admitted |
| continuity (116) | ERR_AUTHORITY | `token ${id}: spends an authority but creates none` | auth:161 | authority-spent-and-not-recreated |
| twoCommitments (117) | ERR_AUTHORITY | `token ${id}: more than one authority output carries an action commitment` | auth:218 | two-committed-authority-outputs |
| commitmentMismatch (119) | ERR_AUTHORITY | `output ${i}: admin details do not match the payload commitment` | auth:192 | details-do-not-match-the-commitment |
| missingDetails (121) | ERR_SHAPE | `output ${i}: committed authority output has no admin details` | auth:190 | committed-authority-without-details |
| orphanDetails (123) | ERR_SHAPE | `admin entry ${i} does not name a committed authority output` | auth:205 | details-for-an-uncommitted-output |
| detailsSchema (125) | ERR_SHAPE | `output ${i}: admin details violate the schema (${detail})` | det:253 | details-*, registry-mandala-kind |
| deployPayload (127) | ERR_SHAPE | `output 0: deploy payload is not a valid Mandala deploy map (${detail})` | det:322-349 | deploy-payload-* |
| envelope (129) | ERR_SHAPE | `Mandala payload ${detail}` | types:159-199 | envelope-* |
| holderConservation (130) | ERR_CONSERVATION | `token ${id}: value in ${vin} != value out ${vout} without an authority` | auth:248 | holder-implicit-burn, holder-overspend, value-out-of-nothing, value-input-not-admitted |
| deltaRule (132) | ERR_CONSERVATION | `token ${id}: ${kind} requires delta ${rule} but delta is ${delta}` | auth:255 | unlabelled-mint, issue-without-a-positive-delta, redeem-*, pause-with-a-delta |
| reissue (134) | ERR_SHAPE | `token ${id}: reissue ${detail}` | auth:290-301 | reissue-* (4) |
| frozenInput (135) | ERR_FROZEN | `input ${i}: coin ${op} is frozen` | ctl:41 | input-frozen, frozen-input-before-paused |
| evictedInput (136) | ERR_FROZEN | `input ${i}: coin ${op} was evicted by a reissue` | ctl:42 | input-evicted-by-a-reissue |
| paused (138) | ERR_PAUSED | `token ${id} is paused` | ctl:87 | token-paused |
| blocked (139) | ERR_ACCESS | `token ${id}: ${k} is blocked (denylist)` | ctl:69 | identity-blocked |
| notAllowed (140) | ERR_ACCESS | `token ${id}: ${k} is not allowlisted (allowlist)` | ctl:74 | identity-not-allowlisted |
| sanctioned (141) | ERR_SANCTIONED | `identity ${k} is sanctioned` | ctl:122 | identity-sanctioned |
| notMember (142) | ERR_MEMBERSHIP | `identity ${k} is not an admitted registry member` | ctl:136 | identity-not-an-admitted-member |
| registryExists (144) | ERR_SHAPE | `tm_mandala_registry: registration chain already exists; register is genesis-only` | rtm:109 | registry-second-deploy |
| registryValue (146) | ERR_SHAPE | `output ${i}: tm_mandala_registry does not admit value outputs` | auth:231 | registry-value-output |

### Every `what` passed to storeUnavailable / storeWriteUnavailable
| reason produced | from |
|---|---|
| `the owner index could not be read; retry` | own:195 (row read, journal read, engine read, re-read after insert) |
| `the owner index could not be written; retry` | own:203 (repairOwnerRow, takeBackRepair) |
| `the asset state could not be read; retry` | auth:80 (reissue; layer D every token) |
| `the circulating supply could not be read; retry` | auth:88 |
| `the screening provider could not be read; retry` | ctl:112 via ctl:121 (a throw **or** a non-boolean answer) |
| `the membership provider could not be read; retry` | ctl:112 via ctl:133 |
| `the registry could not be read; retry` | rtm:117 |
| `the owner journal could not be written; retry` | tm:143 |

### Reason fragments that come from other modules (byte-exact)
- `Reasons.reissue` details: `target is not frozen`, `amount does not match the frozen row`, `must not spend value inputs`, `outputs must go to the recipient` (auth:290-301).
- `Reasons.envelope` details: `must be UTF-8 JSON`, `must be an object`, `${label} must be an array`, `${label} must contain unique non-negative integer indices`, `admin details must be lowercase hex`, `deploySig must be lowercase hex` (types:159-199).
- `Reasons.deltaRule` kind and rule: the kind is the admin kind or `plain authority`; the rule is `> 0`, `< 0` or `= 0` (auth:56-67).
- `invalidTokenOutput` details: the b21 strings in §1.
- `detailsSchema` and `deployPayload` details: the cbor strings in §5, plus the det strings in §5.

---

## 9. `AssetStateReducer.ts`: the admin-state fold

```ts
FrozenRef { outpoint: string; amount: number; owner: string }                         // red:6-10
AssetAdminState { tokenId; isPaused; accessMode: 'denylist'|'allowlist'; blockedIdentities: string[];
  allowedIdentities: string[]; frozenOutpoints: FrozenRef[]; evictedOutpoints: string[];
  feeRatePerKb: number|null; lastProcessedHeight; lastProcessedOffset; lastAdmitSeq }  // red:12-26
FoldContext { frozenAmount?: number; frozenOwner?: string }                            // red:29-32
defaultAssetState(tokenId, feeRatePerKb = null) // isPaused false, accessMode 'denylist', empty lists, 0/0/0 (red:34-49)
foldAction(state, details, ctx = {}) => shallow copy + HANDLERS[kind] if own property (red:127-135)
```
Handlers (red:82-124) never mutate the input arrays. They always produce new arrays. All comparisons go through `toLowerCase`.
- `pause` and `unpause` set `isPaused` to true and false.
- `blockIdentity` and `allowIdentity` use `addUnique`, which appends the **lowercased** key when absent (red:53-56). `unblockIdentity` and `unallowIdentity` use `remove`. Each runs only if `typeof d.identityKey === 'string'`.
- `setAccessMode` applies only `'denylist'` or `'allowlist'`.
- `freezeOutput`:
  - it does nothing when the outpoint is not a string or is already frozen;
  - otherwise it appends `{outpoint: lower, amount: ctx.frozenAmount ?? 0, owner: lower(ctx.frozenOwner ?? '')}`.
- `unfreezeOutput` removes the outpoint.
- `reissue` removes the outpoint from frozen **and** adds it to `evictedOutpoints` with addUnique.
- `setFeeRate` applies when `feeRatePerKb !== undefined`, so null is applied.
- `issue`, `redeem`, the registry kinds and unknown kinds have no handler and leave the state unchanged.
- The fold never touches `lastProcessed*` or `lastAdmitSeq`. They are set by `MandalaLookupService.ts:179-182` (`...foldAction(...)`, `lastProcessedHeight: at.height`, …, `lastAdmitSeq: at.admitSeq`), which is out of scope.

## 10. `ordering.ts`
`txOrdering(tx): {height, offset}` (ord:3-9):
- With no `merklePath`, it returns `{height: Number.MAX_SAFE_INTEGER, offset: 0}`.
- Otherwise `height = mp.blockHeight`, and `offset` is the offset of the `path[0]` leaf with `hash === txid && l.txid` (the leaf's txid flag), or `0` when no such leaf exists.
- Used at `MandalaLookupService.ts:317`.

## 11. `reconcile.ts`: the owner-index reconciler (§4.2a rule 5)
```ts
ReconcileResult { scanned: number; repaired: number; unrepairable: string[] /* `${txid}.${vout}` */ }   // rec:20-30
ReconcileStore = Pick<MandalaStorageManager,'getTokenRow'|'getAuthorityRow'|'getOwnerJournal'|'repairOwnerRow'|'takeToken'|'takeAuthority'|'adjustBalance'> // rec:33-42
ReconcileDeps { storage; engine: EngineOutputReader; topic; batchSize?: number /*200*/; onRepair?(outpoint, inserted) } // rec:44-55
```
- `DEFAULT_BATCH = 200` (rec:69).
- The default log is `` console.warn(`[reconcileOwnerIndex] owner index repaired for ${outpoint} from the owner journal (${what})`) `` (rec:77-82).
- `batchSizeOf`: a size that is not a safe integer, or is below 1, throws a plain Error `'reconcileOwnerIndex: batchSize must be a positive integer'` (rec:147-153).
- `reconcileOwnerIndex(deps)` (rec:195-200) pages through `listUnspentAdmittedOutputs(topic, cursor, limit)` (rec:177-188).
  - `requireProgress` (rec:169-174): when the last item of the page equals the cursor, it throws a plain Error `` `reconcileOwnerIndex: the engine listing did not advance past ${label}` ``.
  - Each page is processed in sequence. `scanned++` counts before each item.
  - The next page starts after the last item of this page. Paging continues while `page.length >= limit`.
  - **Every engine or store error propagates**, and the caller reruns. Repairs are idempotent.
- `reconcileOne(op, deps)` (rec:125-145) returns one of `'ok' | 'repaired' | 'unrepairable'`:
  1. `admitted = engine.findAdmittedOutput(op.txid, op.outputIndex, topic)`. Null gives `'ok'`.
  2. `token = scriptToken(admitted.lockingScript, op)` (rec:85-93) decodes the script. Any throw, a non-token script, or a deploy at vout ≠ 0 gives undefined, which means `'unrepairable'`. Otherwise it returns `{tokenId (`${txid}_0` for a vout-0 deploy), role, amount}`.
  3. `rowAgrees` (rec:95-111) reads by `token.role`: a non-value role reads the authority row and checks tokenId and COMPRESSED_KEY; a value role reads the token row and checks tokenId, sameAmount and COMPRESSED_KEY. Agreement gives `'ok'`.
  4. `journal = getOwnerJournal(txid, vout, topic)`. A null journal or `!journalAgrees` (rec:113-117: tokenId, role === script role, sameAmount, key regex) gives `'unrepairable'`.
  5. `{inserted} = repairOwnerRow(journal)`. If inserted and the engine now reads null, it calls `takeBackRepair(storage, txid, vout, token.role)` and returns `'ok'` (rec:138-141).
  6. Otherwise `onRepair(label, inserted)` and `'repaired'`.

---

## 12. Store surface, collections and indexes (sm)

`MandalaStateStore = Pick<MandalaStorageManager, 'getAssetState'|'getTokenRow'|'getAuthorityRow'|'getOwnerJournal'|'recordOwners'|'repairOwnerRow'|'takeToken'|'takeAuthority'|'adjustBalance'|'circulatingSupply'>` (sm:424-436).

Collections (sm:107-117): `mandalaOwners`, `mandalaTokens`, `mandalaAuthorities`, `mandalaLinkageRecords`, `mandalaBalances`, `mandalaMetadata`, `mandalaAssetStates`, `mandalaAdminHistory`, `mandalaCounters`.

Indexes (sm:39-105):
- `mandalaOwners {txid:1,outputIndex:1,topic:1}` (unique)
- `mandalaTokens {txid:1,outputIndex:1}` (unique), `{tokenId:1}`, `{identityKey:1}`
- `mandalaAuthorities {txid:1,outputIndex:1}` (unique), `{topic:1,tokenId:1}`
- `mandalaLinkageRecords {txid:1,outputIndex:1}`, `{identityKey:1}`, with **no TTL**
- `mandalaBalances {identityKey:1}` (unique)
- `mandalaMetadata {tokenId:1}` (unique)
- `mandalaAssetStates {tokenId:1}` (unique)
- `mandalaAdminHistory {tokenId:1,height:1,offset:1,admitSeq:1}`, `{tokenId:1,txid:1,outputIndex:1}` (not unique), `{txid:1}`

Method semantics:
- `recordOwners(rows)` (sm:132-145) does an unordered bulk of `updateOne({txid,outputIndex,topic}, {$setOnInsert: row}, upsert)`. The first write wins.
- `getOwnerJournal(txid, outputIndex, topic)` (sm:147-154).
- `getTokenRow` (sm:158-161) and `getAuthorityRow` (sm:225-228) are keyed by `{txid, outputIndex}` only.
- `takeToken` and `takeAuthority` use `findOneAndDelete` (sm:178-181, 240-246).
- `circulatingSupply(tokenId)` sums the bigint `amount` of the token's rows **excluding evicted outpoints** (`liveTokenFilter` with `$nor`, sm:203-221). The evicted outpoint regex is `/^([0-9a-fA-F]{64})\.(0|[1-9]\d{0,9})$/`, and the txid is lowercased (sm:20-26).
- `repairOwnerRow(journal)` (sm:265-302) upserts by `findOneAndUpdate` with `returnDocument: 'before'`:
  - **value** journal: `mandalaTokens` gets `$set {tokenId, amount, identityKey}` and `$setOnInsert {createdAt}`, and an insert also runs `adjustBalance(identityKey, +amount)`;
  - **deploy/authority** journal: `mandalaAuthorities` gets `$set {topic, tokenId, identityKey}` and `$setOnInsert {createdAt}`;
  - `inserted` is `before === null`.
- `adjustBalance` does `$inc` with upsert (sm:306-309).
- `getAssetState` returns the stored document or `defaultAssetState(tokenId)` (sm:343-347).

---

## 13. Vectors: `test/vectors/mandala-rejects.json` and `generate.test.ts`

### File format (gen:13-24, 104-150)
```ts
Vectors { id: 'mandala.rejects'; version: 1; verifierPrivateKey: string /* hex scalar */; trustedIssuers: string[]; cases: VectorCase[] }
VectorCase { id; topic: 'tm_mandala'|'tm_mandala_registry'; beef: hex; offChainValues: hex (may be ''); previousCoins: number[];
             state: VectorState; expected: {code, reason} | {outputsToAdmit: number[]} }
VectorState { tokens: VectorToken[]; authorities: VectorAuthority[]; owners: VectorOwner[]; assetStates: AssetAdminState[];
              sanctioned?: string[]; members?: string[]; registryTokenId?: string }
VectorToken { txid; outputIndex; tokenId; amount: number; identityKey }
VectorAuthority { txid; outputIndex; topic; tokenId; identityKey }
VectorOwner = MandalaOwnerRecord minus createdAt
```
- Committed values (`vec`): `verifierPrivateKey = '0a'×32`, `trustedIssuers = ['035ab4689e400a4a160cf01cd44730845a54768df8547dcdf073d964f109f18c30']`, **102 cases**.
- The test asserts that the first four keys of `state` are, in order, `tokens, authorities, owners, assetStates` (gen:1636-1641). It asserts at least 40 cases, unique ids, every one of the 12 codes, and exactly 3 admissions (gen:1645-1652).
- Cast scalars (gen:97-102): verifier `'0a'×32`, issuer `'66'×32`, holder `'44'×32`, receiver `'22'×32`, rogue `'33'×32`.
- Linkage protocol: `FT = [2, 'mandala token']` (gen:76). Output keyIDs are `out-N` (gen:402).
- Payloads: deploy `{sym:'USD',dec:2,label:'US Dollar'}`; registry `{sym:'KYC',dec:0,label:'Mandala registry'}` (gen:492-493).
- Linkage ciphertexts are frozen snapshots, because the AES-GCM IV is random (gen:9-11).

### Replay harness the Go port must reproduce (gen:159-333)
- `storeOver(state)` (gen:225-246):
  - `getAssetState` returns the state row or `defaultAssetState`.
  - `getTokenRow`, `getAuthorityRow` and `getOwnerJournal` look up `(txid, outputIndex[, topic])` and return the row with `createdAt = new Date(0)`, or null.
  - `recordOwners` is first-write-wins keyed `(txid, outputIndex, topic)` (gen:219-223).
  - `repairOwnerRow` upserts with `Object.assign` into tokens (value) or authorities (other roles) and returns `{inserted}` (gen:186-216).
  - `takeToken` and `takeAuthority` splice the row out.
  - `adjustBalance` is a **no-op**.
  - `circulatingSupply` sums the tokens rows for the token, excluding the lowercased `evictedOutpoints` of that token's asset state (gen:175-184).
- `engineFor(topic, beef, previousCoins)` (gen:248-265): `findAdmittedOutput` answers **only** for the source outpoints of the `previousCoins` inputs, and only when the topic matches. It returns `{lockingScript: source script bytes, satoshis: 1}`. `listUnspentAdmittedOutputs` returns `[]`.
- `managerFor` (gen:277-304):
  - The verifier is a `ProtoWallet(PrivateKey(verifierPrivateKey))`. `onOwnerRepair` appends the outpoint to `repairs`.
  - `tm_mandala_registry` builds `RegistryTopicManager` with `registry.registryTokenId = async () => state.registryTokenId ?? null`.
  - `tm_mandala` builds `MandalaTopicManager` with `InMemoryScreeningProvider(state.sanctioned ?? [])` and with `membership = members === undefined ? undefined : {isActive: () => true, isAdmitted: k => members.includes(k)}` (gen:267-270).
  - No `membershipExempt` is passed, so exempt = trusted.
- `execute` (gen:310-329) calls `identifyAdmissibleOutputs(beef, previousCoins, offChainBytes, 'current-tx')` with **no context**, so `dryRun` is undefined and the journal is written. Only `isMandalaReject` errors become `{code, reason}`; any other error fails the test.
- An admission compares `{outputsToAdmit, coinsToRetain: previousCoins}` (gen:332-333) with `isDeepStrictEqual` (gen:1575).
- Post-conditions (gen:1677-1716):
  - for every admission, the journal rows written for this txid equal `outputsToAdmit`, in order;
  - for `admit-transfer-repairing-the-owner-row`, `repairs` must equal exactly `[<issueTxid>.0]`, and `state.tokens` must end as exactly that one repaired row.
- The catalog coverage test spies on every `Reasons` key except `storeUnavailable` and `storeWriteUnavailable`, and requires each to be called at least once (gen:1662-1675).
- Regenerate with `REGENERATE_VECTORS=1 pnpm --filter @bsv/overlay-topics test test/vectors/generate.test.ts` (gen:5).

### Case groups, in file order (gen:1506-1523)
`shapeCases, envelopeCases, linkageCases, inputCases, deployCases, payloadCases, authorityCases, detailsCases, deltaCases, capCases, reissueCases, controlCases, registryCases, unadmittedInputCases, admitCases, revocationCases`.
- The three admissions: `admit-signed-deploy` gives `[0]`; `admit-issue-from-the-deploy-authority` gives `[0,1]`; `admit-transfer-repairing-the-owner-row` gives `[0,1]` (gen:1468-1477).
- The registry cases are `registry-second-deploy`, `registry-value-output`, `registry-mandala-kind` and `registry-authority-input-not-admitted`, on `tm_mandala_registry`.
- How the noteworthy states are built:
  - `strangerOwns`: the token row's identityKey is set to the rogue key (gen:874-875).
  - `noRowNoJournal`: the tokens are cleared and the coin's journal row is removed (gen:902-905).
  - `journalDisagrees`: the journal amount is set to 99 (gen:906-911).
  - `nearCap`: an extra tokens row of amount `2^53-1-100` is added (gen:1252-1259).
  - `frozen()`: the asset state gets `frozenOutpoints [{'dd'×32 + '.0', 100, holder}]` (gen:1287-1294).
  - `detrusted`: the authority row and its journal row get the rogue key (gen:1488-1491).
  - `unadmitted`: `previousCoins` is set to `[]` (gen:1427).

---

## 14. Go-parity hazards: places where a naive Go port diverges

1. **Ordered maps.** `buildLedger`'s Map (ledger:206), `ledger.values()` (auth:331), `ledger.keys()` (ctl:154) and `allIdentities`' Set dedup (ctl:99) all decide which refusal fires. Go needs a slice plus an index.
2. **`decodeEnvelope` is JS `JSON.parse`.** `encoding/json` differs in several ways:
   - (a) Go struct field matching is **case-insensitive**, so `{"Outputs":…}` would bind in Go but not in TS.
   - (b) `null` lists and `deploySig: null` must be refusals, not "absent".
   - (c) An index of `1.0` or `1e0` is valid in JS. A value above 2^53 is parsed and then rejected by the safe-integer test, and `-0` is accepted as 0.
   - (d) Duplicate keys: the last one wins in JS.
   - (e) A leading BOM is refused.
   - (f) Invalid UTF-8 is refused (`fatal: true`).
   - (g) Linkage fields are **untyped**: a mistyped linkage must become `noLinkage` or `inputLinkageControl`, never an envelope error. Decode the entries leniently (for example as `json.RawMessage`).
   - Vectors cover the `envelope-*` cases and `linkage-malformed` (`{}`) / `input-linkage-malformed`. They do not cover (a), (c), (d) or (e).
3. **JS coercion in the linkage path.** The linkage protocol string is built by template interpolation of `protocolID[0]` and `protocolID[1]` (vkl:28-31), and the KeyDeriver lowercases and trims the name (kd:475). A crafted linkage with `protocolID: ["2","Mandala Token"]` therefore yields the same invoice and still decrypts in TS. A non-string `keyID`, an uncompressed `prover` or a non-byte `encryptedLinkage` do **not** get through: the argument validation rejects them (validationHelpers.ts:224-230, 185-196, 146-177). A `prover` with surrounding whitespace or in upper case does get through: it is trimmed and lowercased (:522-534), and `canonicalKey` then normalises it. Not covered by vectors. A Go port that types `protocolID` strictly would refuse such a linkage, a refusal TS does not make; that divergence is acceptable only if it is documented.
4. **The chunk parser** must copy the TS rules: OP_RETURN swallowing, conditional depth, `invalidLength` (§1). The `'truncated push'` check applies to every chunk, including the rest of the script.
5. **Satoshis.** A missing satoshis field reads as 0 (ledger:108). Engine-side `satoshis` in `findAdmittedOutput` is not checked by layer B (own:301-308 compares only `lockingScript`).
6. **Byte compare of the source script.** The repair compares `engine.lockingScript` with `lockingScript.toBinary()` of the parsed source (own:183, 308). UNVERIFIED whether `toBinary()` reproduces the original bytes exactly for every decodable script (non-minimal pushes in the rest of the script). Go should compare raw source bytes, and test that against TS.
7. **The authority row's topic is not compared** by `rowAgrees` (own:239-243) or by the reconciler (rec:100-103). Only the journal lookup is keyed by topic.
8. **Number formatting.** Bigint deltas and sums print as plain decimal integers, and negative values keep their `-` sign (rej:130-133). The amounts compared with stored rows require safe-integer `number`s (own:65-66, auth:277-278).
9. **Unknown-key ordering** in admin details must use the CBOR length-first byte order (det:188-197), not Go map order.
10. **Two deploySig refusal routes.** A lowercase-hex check failure makes the envelope fail (types:199). An absent signature, or one that does not verify, gives `deploySig()` (dsig:27).
11. **Exempt identities are still screened for sanctions** (ctl:142-158). Membership and access skip them.
12. **The registry topic** skips layer D completely and checks the claim **after** layer C (rtm:87-93).

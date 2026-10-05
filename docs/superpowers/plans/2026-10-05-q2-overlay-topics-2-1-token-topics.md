# Q2 — `@bsv/overlay-topics` 2.1: token registry, per-token topics, KYC rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@bsv/overlay-topics` 2.1.0 in one ts-stack PR, which the maintainer merges and publishes. In it:
- `tm_mandala` admits deploys only, as a permanent token registry;
- each token gets its own topic `tm_<deployTxid>`, served by a per-token manager and lookup built from a factory;
- the identity registry becomes `tm_mandala_kyc`.

**Architecture:** Layer A already groups a transaction by token id (`buildLedger`). A new pure `scopeToToken` narrows a transaction's outputs, inputs and envelope to one token before the existing layers B–D run. The per-token manager is today's `MandalaTopicManager` with that scope applied and its topic name bound. The registry manager runs the identical scoped check for the deploy's own token and admits only vout 0, so the registry and the token topic admit or refuse a deploy together. Lookups are parameterised by topic. The registry lookup keeps its own permanent collection.

**Tech Stack:** ts-stack pnpm monorepo, TypeScript (ESM), jest, MongoDB (test db via the package's existing Mongo test setup), `@bsv/templates` 2.x, `@bsv/sdk`.

**Spec:** [`docs/superpowers/specs/2026-10-05-mandala-token-topics-design.md`](../specs/2026-10-05-mandala-token-topics-design.md) §2–§4, §10, §11 (package). Base design: [`2026-10-01-mandala-brc162-design.md`](../specs/2026-10-01-mandala-brc162-design.md).

## Global Constraints

- Topic names:
  - `MANDALA_TOPIC = 'tm_mandala'`, now the registry;
  - `MANDALA_LOOKUP = 'ls_mandala'`;
  - `KYC_TOPIC = 'tm_mandala_kyc'`;
  - `KYC_LOOKUP = 'ls_mandala_kyc'`;
  - token topic `tm_<64 lowercase hex deploy txid>`;
  - token lookup `ls_<same>`.
  
  No `_0` in names.
- `REGISTRY_TOPIC` / `REGISTRY_LOOKUP` are removed and replaced by `KYC_TOPIC` / `KYC_LOOKUP`. Class names `RegistryTopicManager`, `RegistryStorage`, `registryMembership` and `createRegistryLookupService` are unchanged.
- Version `@bsv/overlay-topics` 2.0.0 → **2.1.0**. This is a user decision (spec T6). The changelog states plainly that `tm_mandala`'s admission changed and that `REGISTRY_*` constants were renamed.
- Reject reasons stay verbatim `Reasons.*`. Add new reasons only if a task below names one.
- An output of another token is **not admitted and not refused** by a token topic.
- A token-shaped output the codec refuses (`invalid`) still refuses the transaction on every Mandala topic. Its token is unknowable, so all-or-nothing stays.
- An `env.admin` entry whose index is not a token output of any token in the transaction is still refused (the existing orphan rule), on every topic.
- The registry admits only vout 0 of a deploy transaction, and only when the scoped token check admits it.
- Work in a new ts-stack worktree off `origin/main`. Never touch `/Users/personal/git/ts-stack`, which is the user's branch with unmerged work. Invoke the `botboard` skill and follow ts-stack `AGENTS.md`. Ship as a PR only; never merge or publish.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two tokens in one transaction.** Each token topic admits exactly its own outputs, conserves only its own token, and is not refused for the other token's admin envelope entries. Pinned in Task 2.
2. **The registry and the token topic disagree on a deploy.** They must not: same verdict and same reason for each of untrusted issuer, missing deploySig, a fixed-supply deploy, and a bad linkage. Pinned in Task 4.
3. **A deploy-shaped output at vout ≠ 0, or a non-deploy transaction sent to `tm_mandala`.** The registry admits nothing and does not refuse. Pinned in Task 4.
4. **The registry record after the deploy output is spent or evicted.** Spent: the record stays (T7). Evicted: the record goes, since the transaction never happened. Pinned in Task 4.
5. **Topic-name helpers given a near-miss name:** uppercase hex, 63 or 65 hex characters, a `_0` suffix, `ls_` passed to `tokenIdOfTopic`. They return `null` and never throw. Pinned in Task 1.

---

### Task 0: Worktree; shared test fixtures

**Files:**
- Create: `packages/overlays/topics/src/mandala/__tests/fixtures.ts`
- Modify: `packages/overlays/topics/src/mandala/__tests/MandalaTopicManager.test.ts` (import from fixtures; no behaviour change)

**Interfaces:**
- Produces, exported from `fixtures.ts`:
  - wallets and keys: `codec`, `FT`, `keyOf`, `walletOf`, `overlay`, `issuer`, `holder`, `receiver`, `rogue`, `OVERLAY`, `ISSUER`, `HOLDER`, `RECEIVER`, `ROGUE`, `verifierWallet`, `DEPLOY_PAYLOAD`;
  - transaction builders: `funding`, `linkedLock`, `txSpending`, `built`, `build`, `signDeploy`, `deploy`, `tokenOf`, `commitTo`, `issue`, `transfer`;
  - engine fake: `engineOutputs`;
  - the types `Built` and `Spend`.
  
  These are moved verbatim from `MandalaTopicManager.test.ts:42-211`.

- [ ] **Step 1: Worktree**
```bash
cd /Users/personal/git/ts-stack && git fetch -q origin
git worktree add -b feat/mandala-token-topics /private/tmp/ts-stack-q2 origin/main
cd /private/tmp/ts-stack-q2 && pnpm install --frozen-lockfile
```
Invoke the `botboard` skill; follow its Lockfile protocol.

- [ ] **Step 2: Move the fixtures.** Cut `MandalaTopicManager.test.ts` lines 42–211 into `fixtures.ts`, prefixing each declaration with `export`. Keep any module-level state those helpers close over (stores, counters) in `fixtures.ts`, exported too. Replace the cut lines with one `import { … } from './fixtures.js'` listing exactly the moved names.

- [ ] **Step 3: Run, expect the same pass count as before the move**
```bash
cd packages/overlays/topics && npx jest src/mandala/__tests/MandalaTopicManager.test.ts
```
Note the count before Step 2, and confirm it is identical after.

- [ ] **Step 4: Commit** `test(overlay-topics): share Mandala test fixtures`.

---

### Task 1: Topic names and `scopeToToken`

**Files:**
- Create:
  - `packages/overlays/topics/src/mandala/topics.ts`
  - `packages/overlays/topics/src/mandala/scope.ts`
- Test:
  - `packages/overlays/topics/src/mandala/__tests/topics.test.ts`
  - `packages/overlays/topics/src/mandala/__tests/scope.test.ts`

**Interfaces:**
- Produces, in `topics.ts`:
```ts
export const MANDALA_TOPIC = 'tm_mandala'
export const MANDALA_LOOKUP = 'ls_mandala'
export const KYC_TOPIC = 'tm_mandala_kyc'
export const KYC_LOOKUP = 'ls_mandala_kyc'
export function tokenTopic(tokenId: string): string      // '<txid>_0' → 'tm_<txid>'; throws on a non-canonical id
export function tokenLookup(tokenId: string): string     // → 'ls_<txid>'
export function isTokenTopic(name: string): boolean
export function tokenIdOfTopic(name: string): string | null  // 'tm_<txid>' → '<txid>_0', else null
```
- Produces, in `scope.ts`:
```ts
export interface TxView { outputs: Brc162Output[]; invalid: InvalidTokenOutput[]; inputs: Brc162Input[]; env: MandalaEnvelope }
export function scopeToToken(tokenId: string, view: TxView): TxView
```

- [ ] **Step 1: Failing tests**

`topics.test.ts`:
```ts
import { tokenTopic, tokenLookup, isTokenTopic, tokenIdOfTopic, MANDALA_TOPIC, KYC_TOPIC } from '../topics.js'

const T = 'ab'.repeat(32)

describe('Mandala topic names', () => {
  it('maps a token id to its topic and lookup', () => {
    expect(tokenTopic(`${T}_0`)).toBe(`tm_${T}`)
    expect(tokenLookup(`${T}_0`)).toBe(`ls_${T}`)
    expect(tokenIdOfTopic(`tm_${T}`)).toBe(`${T}_0`)
    expect(isTokenTopic(`tm_${T}`)).toBe(true)
  })
  it.each([
    `tm_${T.toUpperCase()}`, `tm_${T.slice(1)}`, `tm_${T}0`, `tm_${T}_0`, `ls_${T}`, MANDALA_TOPIC, KYC_TOPIC, '', 'tm_'
  ])('%s is not a token topic', name => {
    expect(isTokenTopic(name)).toBe(false)
    expect(tokenIdOfTopic(name)).toBeNull()
  })
  it.each([`${T}_1`, `${T}.0`, T, `${T.toUpperCase()}_0`])('tokenTopic refuses %s', id => {
    expect(() => tokenTopic(id)).toThrow(/token id/)
  })
})
```
`scope.test.ts`: build views by hand. `Brc162Output`, `Brc162Input` and `InvalidTokenOutput` are plain objects.
```ts
import { scopeToToken } from '../scope.js'

const A = 'aa'.repeat(32) + '_0', B = 'bb'.repeat(32) + '_0', TX = 'cc'.repeat(32)
const out = (index: number, tokenId: string, amount: bigint, role: 'value' | 'authority' | 'deploy' = amount === 0n ? 'authority' : 'value') =>
  ({ index, satoshis: 1, role, tokenId, amount, payloadCanonical: true })
const inp = (index: number, tokenId: string, amount: bigint) =>
  ({ index, role: amount === 0n ? 'authority' : 'value', tokenId, amount, outpoint: `${'dd'.repeat(32)}.${index}` })
const env = (o: object = {}) => ({ inputs: [], outputs: [], admin: [], ...o }) as any

describe('scopeToToken', () => {
  it('keeps only the token\'s outputs, inputs and per-index envelope entries', () => {
    const view = {
      outputs: [out(0, A, 5n), out(1, B, 7n), out(2, A, 0n)],
      invalid: [],
      inputs: [inp(0, A, 5n), inp(1, B, 7n)],
      env: env({
        outputs: [{ index: 0, linkage: 'la' }, { index: 1, linkage: 'lb' }, { index: 2, linkage: 'la2' }],
        inputs: [{ index: 0, x: 1 }, { index: 1, x: 2 }],
        admin: [{ index: 2, details: 'da' }, { index: 1, details: 'db' }]
      })
    }
    const a = scopeToToken(A, view)
    expect(a.outputs.map(o => o.index)).toEqual([0, 2])
    expect(a.inputs.map(i => i.index)).toEqual([0])
    expect(a.env.outputs.map((e: any) => e.index)).toEqual([0, 2])
    expect(a.env.inputs.map((e: any) => e.index)).toEqual([0])
    expect(a.env.admin.map((e: any) => e.index)).toEqual([2])
  })
  it('keeps an admin entry that names no token output at all, so the orphan rule still refuses', () => {
    const v = { outputs: [out(0, A, 5n)], invalid: [], inputs: [], env: env({ admin: [{ index: 9, details: 'x' }] }) }
    expect(scopeToToken(A, v).env.admin).toEqual([{ index: 9, details: 'x' }])
  })
  it('keeps every invalid output, so every topic still refuses', () => {
    const v = { outputs: [], invalid: [{ index: 3, detail: 'bad' }], inputs: [], env: env() }
    expect(scopeToToken(A, v).invalid).toEqual([{ index: 3, detail: 'bad' }])
  })
  it('keeps the deploy and deploySig only for the deploy\'s own token', () => {
    const d = { outputs: [out(0, `${TX}_0`, 0n, 'deploy'), out(1, A, 3n)], invalid: [], inputs: [], env: env({ deploySig: 'sig' }) }
    expect(scopeToToken(`${TX}_0`, d).env.deploySig).toBe('sig')
    expect(scopeToToken(A, d).env.deploySig).toBeUndefined()
    expect(scopeToToken(A, d).outputs.map(o => o.index)).toEqual([1])
  })
})
```

- [ ] **Step 2: Run, expect FAIL.** `cd packages/overlays/topics && npx jest src/mandala/__tests/topics.test.ts src/mandala/__tests/scope.test.ts`

- [ ] **Step 3: Implement**

`topics.ts`:
```ts
// Mandala topic names (token-topics design §3). `tm_mandala` is the token registry (deploys only),
// `tm_mandala_kyc` the identity registry, and each token has `tm_<deploy txid>` / `ls_<deploy txid>`.
// Token topic names need BRC-87 widened to 150 characters with digits (design §5).
export const MANDALA_TOPIC = 'tm_mandala'
export const MANDALA_LOOKUP = 'ls_mandala'
export const KYC_TOPIC = 'tm_mandala_kyc'
export const KYC_LOOKUP = 'ls_mandala_kyc'

const TOKEN_ID = /^([0-9a-f]{64})_0$/
const TOKEN_TOPIC = /^tm_([0-9a-f]{64})$/

function txidOf(tokenId: string): string {
  const m = TOKEN_ID.exec(tokenId)
  if (m === null) throw new Error(`not a canonical Mandala token id: ${tokenId}`)
  return m[1]
}

export const tokenTopic = (tokenId: string): string => `tm_${txidOf(tokenId)}`
export const tokenLookup = (tokenId: string): string => `ls_${txidOf(tokenId)}`
export const isTokenTopic = (name: string): boolean => TOKEN_TOPIC.test(name)
export function tokenIdOfTopic(name: string): string | null {
  const m = TOKEN_TOPIC.exec(name)
  return m === null ? null : `${m[1]}_0`
}
```
`scope.ts`. Check the real `MandalaEnvelope` field names in `types.ts` first: `inputs`, `outputs`, `admin`, `deploySig`. Match them exactly.
```ts
// Narrows one transaction to one token (token-topics design §3), so a per-token topic runs layers
// B to D over its own token only. Envelope entries are kept by index. An admin entry that names no
// token output of any token is kept everywhere, so the orphan rule (authority.ts) still refuses it,
// and so is every codec-refused output: its token is unknowable.
import type { Brc162Input, Brc162Output, InvalidTokenOutput } from '../brc162/ledger.js'
import type { MandalaEnvelope } from './types.js'

export interface TxView {
  outputs: Brc162Output[]
  invalid: InvalidTokenOutput[]
  inputs: Brc162Input[]
  env: MandalaEnvelope
}

export function scopeToToken(tokenId: string, view: TxView): TxView {
  const outputs = view.outputs.filter(o => o.tokenId === tokenId)
  const inputs = view.inputs.filter(i => i.tokenId === tokenId)
  const mine = new Set(outputs.map(o => o.index))
  const anyToken = new Set(view.outputs.map(o => o.index))
  const myInputs = new Set(inputs.map(i => i.index))
  const deployHere = outputs.some(o => o.role === 'deploy')
  return {
    outputs,
    inputs,
    invalid: view.invalid,
    env: {
      ...view.env,
      outputs: view.env.outputs.filter(e => mine.has(e.index)),
      inputs: view.env.inputs.filter(e => myInputs.has(e.index)),
      admin: view.env.admin.filter(e => mine.has(e.index) || !anyToken.has(e.index)),
      deploySig: deployHere ? view.env.deploySig : undefined
    }
  }
}
```
If `MandalaEnvelope.deploySig` is not optional in the type, set it to whatever "absent" value `decodeEnvelope` produces for a missing one, and adjust the test to match.

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(overlay-topics): Mandala topic names and per-token transaction scope`.

---

### Task 2: `MandalaTokenTopicManager` (one token per topic)

**Files:**
- Modify: `packages/overlays/topics/src/mandala/MandalaTopicManager.ts` (rename the class and file contents; keep the file name to limit churn)
- Modify: `packages/overlays/topics/src/mandala/MandalaTopicDocs.md.ts` (describe the per-token topic)
- Test:
  - `packages/overlays/topics/src/mandala/__tests/MandalaTopicManager.test.ts`, existing; port it to the token manager
  - new `MandalaTokenTopicManager.multitoken.test.ts`

**Interfaces:**
- Consumes: `scopeToToken`, `tokenTopic`, `isTokenTopic` (Task 1).
- Produces:
```ts
export interface MandalaTokenTopicManagerDeps extends MandalaTopicManagerDeps { tokenId: string }  // '<txid>_0'
export class MandalaTokenTopicManager implements TopicManager {
  readonly topic: string        // tokenTopic(deps.tokenId)
  readonly tokenId: string
  constructor (deps: MandalaTokenTopicManagerDeps)
}
```
`MandalaTopicManager` and the old `MANDALA_TOPIC` export from this file are removed. `MANDALA_TOPIC` now lives in `topics.ts` and means the registry. `trustedSet`, `exemptKeys`, `journalOwners`, `ascendingIndices` and `logOwnerRepair` stay exported.

- [ ] **Step 1: Port the existing tests.**
  - Every `managerWith(...)` constructs `new MandalaTokenTopicManager({ ...depsWith(over), tokenId })`, using the token id under test:
    - for a deploy's own test, that is `tokenOf(deployBuilt)`;
    - for later steps, the same id.
  - Every `topic: 'tm_mandala'` in a journal or row assertion becomes `tokenTopic(tokenId)`.
  - The construction and metadata tests now expect `getMetaData().name === tokenTopic(tokenId)`.
  - Add a construction test: a non-canonical `tokenId` throws `/token id/`.

- [ ] **Step 2: New failing tests** (`MandalaTokenTopicManager.multitoken.test.ts`, using `fixtures.ts`):
```ts
// Two tokens A and B are deployed and issued (to HOLDER) through their own managers.
// One transaction then spends HOLDER's A value and B value and pays RECEIVER both,
// with an A output at index 0 and a B output at index 1.
it('each token topic admits only its own outputs and conserves only its own token', async () => {
  // build with the existing `transfer`-style helper extended to two tokens: inputs [A coin, B coin], outputs [A→RECEIVER, B→RECEIVER]
  const a = await managerFor(tokenA).identifyAdmissibleOutputs(tx.beef, [0, 1], tx.offChain)
  const b = await managerFor(tokenB).identifyAdmissibleOutputs(tx.beef, [0, 1], tx.offChain)
  expect(a.outputsToAdmit).toEqual([0])
  expect(b.outputsToAdmit).toEqual([1])
})
it('a token topic is not refused for the other token\'s implicit burn', async () => {
  // same tx but the B output pays 1 less than the B input: B refuses (Reasons.implicitBurn), A still admits [0]
})
it('an admin envelope entry for the other token\'s authority does not refuse this topic', async () => {
  // issuer tx: spends A authority and B authority, emits A authority (index 0, admin entry) + B authority (index 1, admin entry) + values
  // A admits its indices, B admits its indices, neither refuses
})
it('a transaction with no output or input of the token admits nothing and does not refuse', async () => {
  expect(await managerFor(tokenA).identifyAdmissibleOutputs(onlyB.beef, onlyB.previousCoins, onlyB.offChain))
    .toEqual({ outputsToAdmit: [], coinsToRetain: [] })
})
```
Write every body in full, with builders that extend the fixture helpers to two tokens. `managerFor(tokenId)` is `new MandalaTokenTopicManager({ ...depsWith(), tokenId })`. Assert the B refusal reason against the real `Reasons` call, not a hand-typed string. `coinsToRetain` follows the same rule as the outputs: it keeps only the input indices of this token. Assert it.

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement.** In `identifyAdmissibleOutputs`:
```ts
    const tx = Transaction.fromBEEF(beef)
    const txid = tx.id('hex')
    const all = { ...classifyOutputs(tx), inputs: classifyAdmittedInputs(tx, previousCoins), env: decodeEnvelope(offChainValues) }
    const { outputs, invalid, inputs, env } = scopeToToken(this.tokenId, all)
    if (outputs.length === 0 && inputs.length === 0 && invalid.length === 0) {
      return { outputsToAdmit: [], coinsToRetain: [] }
    }
    const ledger = buildLedger(txid, outputs, inputs)
```
After that come the existing layer B–D calls, unchanged, with `topic: this.topic` in `resolveInputOwners`. Then `journalOwners(store, this.topic, txid, owners)`. Return:
```ts
    return { outputsToAdmit: ascendingIndices(outputs), coinsToRetain: inputs.map(i => i.index).sort((x, y) => x - y) }
```
**Check before writing:** today's code returns `coinsToRetain: previousCoins`. Read the engine's use of `coinsToRetain` in `packages/overlays/overlay/src/Engine.ts` and confirm that narrowing to this token's inputs is correct per topic. If the engine needs every previous coin retained for spend tracking, keep `previousCoins` filtered to inputs of this token and say so in the report.

`getMetaData()` returns `{ name: this.topic, shortDescription: 'Mandala BRC-162 token ' + this.tokenId + ': authority and value outputs, identity linkage, issuer controls.' }`.

In the constructor: `this.tokenId = deps.tokenId; this.topic = tokenTopic(deps.tokenId)`. `tokenTopic` throws on a bad id.

- [ ] **Step 5: Run the mandala test folder, expect PASS.** `npx jest src/mandala`
- [ ] **Step 6: Commit** `feat(overlay-topics)!: MandalaTokenTopicManager — one topic per token`.

---

### Task 3: Lookup per topic; `createMandalaTokenTopic` factory

**Files:**
- Modify: `packages/overlays/topics/src/mandala/MandalaLookupService.ts`
- Create: `packages/overlays/topics/src/mandala/tokenTopic.ts`
- Test:
  - `packages/overlays/topics/src/mandala/__tests/MandalaLookupService.test.ts` (port it)
  - new `tokenTopic.test.ts`

**Interfaces:**
- Consumes: `MandalaTokenTopicManager` (Task 2) and `tokenTopic` / `tokenLookup` (Task 1).
- Produces:
  - `MandalaLookupDeps` gains `topic: string` and `lookupName: string`. The lookup answers only for `payload.topic === deps.topic`. `listAuthorities(deps.topic, …)` replaces `MANDALA_TOPIC`. `getMetaData().name === deps.lookupName`. `requireLookupQuery(question, deps.lookupName, …)`.
  - The `createMandalaLookupService` signature changes to `(verifierWallet, storage, tokenId) => (db) => MandalaLookupService`.
  - In `tokenTopic.ts`:
```ts
export interface MandalaTokenTopic {
  tokenId: string; topicName: string; lookupName: string
  manager: MandalaTokenTopicManager
  lookupFactory: (db: Db) => MandalaLookupService
}
export function createMandalaTokenTopic(tokenId: string, deps: MandalaTopicManagerDeps & { storage: MandalaStorageManager }): MandalaTokenTopic
```

- [ ] **Step 1: Failing tests**
  - In `MandalaLookupService.test.ts`, construct with `{ storage, verifierWallet, topic: tokenTopic(id), lookupName: tokenLookup(id) }`. Add a test: an `outputAdmittedByTopic` payload for another token's topic writes nothing.
  - `tokenTopic.test.ts`: `createMandalaTokenTopic(id, deps)` returns matching names; `manager.topic === topicName`; `lookupFactory(db).getMetaData()` reports `name === lookupName`; a bad id throws.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Replace each `MANDALA_TOPIC` in `MandalaLookupService.ts` with `this.deps.topic`, and `LOOKUP_SERVICE` with `this.deps.lookupName`. `outputEvicted(txid, vout)` has no topic and stays as is: rows are keyed by outpoint, so every instance taking the same row is idempotent. Add the factory module.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(overlay-topics)!: lookup per token topic; createMandalaTokenTopic`.

---

### Task 4: Token registry: `MandalaRegistryTopicManager` and `MandalaRegistryLookupService` (`tm_mandala`)

**Files:**
- Create:
  - `packages/overlays/topics/src/mandala/MandalaRegistryTopicManager.ts`
  - `packages/overlays/topics/src/mandala/MandalaRegistryLookupService.ts`
  - `packages/overlays/topics/src/mandala/MandalaRegistryDocs.md.ts`
- Modify: `packages/overlays/topics/src/mandala/MandalaStorageManager.ts` (add the `mandalaRegistry` collection and its methods)
- Test:
  - `packages/overlays/topics/src/mandala/__tests/MandalaRegistry.test.ts`
  - extend `MandalaStorageManager.test.ts`

**Interfaces:**
- Consumes: `MandalaTokenTopicManager` (Task 2), `MANDALA_TOPIC` / `MANDALA_LOOKUP` / `tokenTopic` (Task 1).
- Produces:
```ts
export class MandalaRegistryTopicManager implements TopicManager   // name MANDALA_TOPIC; deps = MandalaTopicManagerDeps
export interface MandalaRegistryRecord { tokenId: string; deployTxid: string; sym: string; dec: number; label: string; issuer: string; feeRatePerKb: number | null; createdAt: Date }
// storage:
storeRegistryRecord(r: MandalaRegistryRecord): Promise<void>     // upsert-if-absent on tokenId (first write wins)
findRegistryRecord(tokenId: string): Promise<MandalaRegistryRecord | null>
listRegistryRecords(limit: number, skip: number): Promise<MandalaRegistryRecord[]>  // createdAt asc, then tokenId
deleteRegistryRecord(tokenId: string): Promise<void>
allRegistryTokenIds(): Promise<string[]>
export class MandalaRegistryLookupService implements LookupService  // name MANDALA_LOOKUP
export function createMandalaRegistryLookupService(storage: MandalaStorageManager): (db: Db) => MandalaRegistryLookupService
```
The lookup query is `{ tokenId }`, which returns one record or `[]`, or `{ list: true, limit?, skip? }`, which returns a page. Records come back through the same `LookupFormula` cast pattern `stateAnswer` uses.

- [ ] **Step 1: Failing tests** (`MandalaRegistry.test.ts`, using `fixtures.ts` and the real Mongo test storage):
```ts
it('admits a valid deploy at vout 0 only, and records it', async () => {
  const d = await deploy()   // fixture: deploy + an extra authority output of the same token at index 1
  const r = await registry().identifyAdmissibleOutputs(d.beef, [], d.offChain)
  expect(r).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
})
it.each(['untrusted issuer', 'missing deploySig', 'fixed-supply deploy', 'bad linkage'])(
  'refuses %s with the same code and reason as the token topic', async kind => {
    const d = await badDeploy(kind)       // builders in this file, one per kind
    const reg = await rejection(registry().identifyAdmissibleOutputs(d.beef, [], d.offChain))
    const tok = await rejection(tokenManager(tokenOf(d)).identifyAdmissibleOutputs(d.beef, [], d.offChain))
    expect({ code: reg.code, reason: reg.reason }).toEqual({ code: tok.code, reason: tok.reason })
  })
it('admits nothing for a transaction without a deploy at vout 0, and does not refuse', async () => {
  const { transferTx } = await transferred()
  expect(await registry().identifyAdmissibleOutputs(transferTx.beef, [0], transferTx.offChain))
    .toEqual({ outputsToAdmit: [], coinsToRetain: [] })
})
it('lookup: records on admission, keeps the record when the deploy output is spent, drops it on eviction', async () => {
  // outputAdmittedByTopic(topic: 'tm_mandala', outputIndex 0) → findRegistryRecord(tokenId) has sym/dec/label/issuer
  // outputSpent(topic 'tm_mandala', same outpoint) → record still present
  // outputEvicted(deployTxid, 0) → record gone
  // a payload for any other topic writes nothing
})
it('lookup answers { tokenId } and { list: true } pages', async () => { /* two deploys → list returns both in createdAt order; limit 1 pages */ })
```
Write every body in full. `registry()` is `new MandalaRegistryTopicManager(depsWith())`. The issuer stored is the deploy output's verified owner identity key: the trusted issuer. Before writing the builders, check that `Reasons` has a fixed-supply reason (`authority.ts:108` `Reasons.fixedSupply()`), and use the real calls.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the manager:**
```ts
// The Mandala token registry (token-topics design §3): `tm_mandala` admits the deploy output of a
// deploy transaction and nothing else, so every overlay can learn which tokens exist. It runs the
// very check the token's own topic runs on the same transaction, so the two always agree.
export class MandalaRegistryTopicManager implements TopicManager {
  private readonly deps: MandalaTopicManagerDeps
  constructor (deps: MandalaTopicManagerDeps) {
    trustedSet(deps.trustedIssuers, 'MandalaRegistryTopicManager')   // fail at construction, like the token manager
    this.deps = deps
  }

  async identifyAdmissibleOutputs (beef: number[], previousCoins: number[], offChainValues?: number[], mode?: 'historical-tx' | 'current-tx' | 'historical-tx-no-spv', context?: TopicAdmittanceContext): Promise<AdmittanceInstructions> {
    const tx = Transaction.fromBEEF(beef)
    const deployAt0 = classifyOutputs(tx).outputs.some(o => o.index === 0 && o.role === 'deploy')
    if (!deployAt0) return { outputsToAdmit: [], coinsToRetain: [] }
    const tokenId = `${tx.id('hex')}_0`
    // dry run: the registry never journals (its record is written by its lookup), and the token
    // topic journals its own owners when it admits the same transaction.
    const token = new MandalaTokenTopicManager({ ...this.deps, tokenId })
    await token.identifyAdmissibleOutputs(beef, previousCoins, offChainValues, mode, { ...context, dryRun: true })
    return { outputsToAdmit: [0], coinsToRetain: [] }
  }
  async getDocumentation (): Promise<string> { return docs }
  async getMetaData () { return { name: MANDALA_TOPIC, shortDescription: 'Mandala token registry: one permanent record per BRC-162 deploy.' } }
}
```
Check that `TopicAdmittanceContext` allows `{ dryRun: true }`, following how `MandalaTopicManager` reads `context?.dryRun`. If the type is not spreadable from `undefined`, build `{ dryRun: true }` directly.

Implement the lookup:
- `outputAdmittedByTopic`: ignore any topic other than `MANDALA_TOPIC` and any output index other than 0. Classify the deploy, decode its metadata with the existing `deployMetadata(payload, canonical)` helper, which is exported from `MandalaLookupService.ts` (export it if it isn't). The issuer comes from `verifyOutputOwners([deploy], env, verifierWallet)[0].identityKey`. Then `storeRegistryRecord`.
- `outputSpent`: a no-op (T7).
- `outputEvicted(txid, 0)`: `deleteRegistryRecord(`${txid}_0`)`.

Storage: a `mandalaRegistry` collection with a unique index on `tokenId` and an index on `createdAt`. `storeRegistryRecord` uses `updateOne({tokenId}, {$setOnInsert: r}, {upsert: true})`.

- [ ] **Step 4: Run, expect PASS.** `npx jest src/mandala`
- [ ] **Step 5: Commit** `feat(overlay-topics)!: tm_mandala is the token registry (deploys only, permanent records)`.

---

### Task 5: KYC rename, exports, vectors, version, PR

**Files:**
- Modify:
  - `packages/overlays/topics/src/mandala-registry/RegistryTopicManager.ts:31`
  - `packages/overlays/topics/src/mandala-registry/RegistryLookupService.ts:29,31` and every `REGISTRY_TOPIC` / `REGISTRY_LOOKUP` use
  - `RegistryDocs.md.ts`
  - `src/index.ts:167-224`
  - `test/vectors/generate.test.ts`
  - `test/vectors/mandala-rejects.json` (regenerated)
  - the package `README.md` (Mandala section)
  - `package.json` (version)
  - `CHANGELOG.md`
- Test:
  - `src/mandala-registry/__tests/registry.test.ts` (update names)
  - the vectors check

**Interfaces:**
- Produces the public exports of 2.1.0:
  - `MandalaTokenTopicManager`, `MandalaTokenTopicManagerDeps`
  - `MandalaRegistryTopicManager`, `MandalaRegistryLookupService`, `createMandalaRegistryLookupService`, `MandalaRegistryRecord`
  - `createMandalaTokenTopic`, `MandalaTokenTopic`
  - `MANDALA_TOPIC`, `MANDALA_LOOKUP`, `KYC_TOPIC`, `KYC_LOOKUP`
  - `tokenTopic`, `tokenLookup`, `isTokenTopic`, `tokenIdOfTopic`, `scopeToToken`
  - everything else exported by 2.0.0, except `MandalaTopicManager`, `REGISTRY_TOPIC` and `REGISTRY_LOOKUP`
  - `createMandalaLookupService` with its new signature

- [ ] **Step 1: Rename.** Remove `REGISTRY_TOPIC` and `REGISTRY_LOOKUP`. Import `KYC_TOPIC` / `KYC_LOOKUP` from `../mandala/topics.js` everywhere they were used. Update `registry.test.ts` to expect `'tm_mandala_kyc'` and `'ls_mandala_kyc'`.

- [ ] **Step 2: Exports.** Edit `src/index.ts` to export exactly the list above.

- [ ] **Step 3: Vectors.**
  - In `generate.test.ts`, the case `topic` field now holds the real topic name: `tm_<deploy txid>` for every former `tm_mandala` case, `tm_mandala_kyc` for every former registry case, and new `tm_mandala` registry cases. Add one admitted deploy, one refused deploy (untrusted issuer) and one non-deploy transaction that admits nothing.
  - Dispatch each case by topic: `isTokenTopic` → `MandalaTokenTopicManager` with `tokenIdOfTopic`; `MANDALA_TOPIC` → registry manager; `KYC_TOPIC` → `RegistryTopicManager`.
  - Update the header comment's description of the format.
  - Regenerate: `REGENERATE_VECTORS=1 pnpm --filter @bsv/overlay-topics test test/vectors/generate.test.ts`. Then run a plain check pass.

- [ ] **Step 4: Docs, version, changelog.**
  - Set `package.json` to `2.1.0`.
  - Rewrite the README's Mandala section topic table to match design §3. Add a "Host duties" note: register `tm_<id>` before a deploy submit names it (design §6.2); boot from the registry records plus the journal's distinct topics; token-topic names need BRC-87 widened.
  - Add a `CHANGELOG.md` entry:
```markdown
## 2.1.0
### Changed (breaking for hosts, see note)
- `tm_mandala` is now the Mandala token registry: it admits deploys only, with permanent `mandalaRegistry` records (`MandalaRegistryTopicManager`, `MandalaRegistryLookupService`).
- Each token has its own topic `tm_<deploy txid>` and lookup `ls_<deploy txid>` (`MandalaTokenTopicManager`, `createMandalaTokenTopic`). A transaction moving several tokens names each token topic; each admits and conserves its own token only.
- The identity registry topic is `tm_mandala_kyc` / `ls_mandala_kyc`; `REGISTRY_TOPIC`/`REGISTRY_LOOKUP` are replaced by `KYC_TOPIC`/`KYC_LOOKUP`.
- `MandalaTopicManager` is removed; `createMandalaLookupService` takes a `tokenId`.
Note: released as a minor by maintainer decision; hosts of 2.0.0 must rewire.
```

- [ ] **Step 5: Gates**
```bash
cd /private/tmp/ts-stack-q2 && node scripts/check-versions.mjs && pnpm --filter @bsv/overlay-topics build && pnpm --filter @bsv/overlay-topics test
```
Expected: green, with the Mongo-backed suites running. Run long commands in the background.

- [ ] **Step 6: Commit** `feat(overlay-topics)!: KYC rename; 2.1.0 exports, vectors, docs`.

- [ ] **Step 7: PR, only after the user says to open it.**
```bash
git push -u origin feat/mandala-token-topics
gh pr create --repo bsv-blockchain/ts-stack --base main --head feat/mandala-token-topics --title "feat(overlay-topics)!: Mandala token registry + per-token topics (2.1.0)" --body-file <scratch body>
```
The body links the design spec, the companion BRC-87 PR (Q1) and the vectors change (the Go overlay reads `mandala-rejects.json`). It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Out of scope

- Host wiring: registrar, allowlist, boot union, SHIP/GASP. That is Q3 (Go) and Q4 (TS).
- BRC-87 widening (Q1).
- Lib and wallet (P4/P6).

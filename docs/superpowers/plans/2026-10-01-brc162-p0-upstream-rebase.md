# BRC-162 P0 — Upstream Overlay Re-base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-base both Mandala overlays onto their latest upstream bases (TS: `@bsv/overlay` 2.6.2 / `@bsv/overlay-express` 2.7.3 / `@bsv/sdk` 2.8.11 / Node 24; Go: go-overlay-services v1.3.7 / go-sdk v1.7.1 / Go 1.26) with the **old token format unchanged**, so later BRC-162 phases never confuse upstream behaviour changes with format changes.

**Architecture:** The bump is not a drop-in. The new engine filters spent coins out of `previousCoins`, serializes submits, does its own compare-and-swap (CAS) mark-spent with `spentBy`, and rethrows phase-3 failures. overlay-express 2.7.3 adds edge policy, strict outbound URLs, a mandatory callback token, and an FQDN normalizer that turns on the SHIP/SLAP advertiser. Each task adapts one repo-local seam to the new behaviour and pins it with a test, starting with a real-engine harness, because the existing suite (fakes only) stays green across the bump while double-spends regress.

**Tech Stack:** TypeScript (ESM, Node 24, vitest 4, knex + sqlite3, mongodb 7), Go 1.26 (fiber v2, mongo-driver v2), Docker.

**Spec:** `docs/superpowers/specs/2026-10-01-mandala-brc162-design.md` (§7, §9 P0). Fact base for this plan: the P0 understand workflow (`wf_79dff343-bbe`); the per-agent reports are copied in `$SCRATCH/p0facts/` (`agent5` engine, `agent6` upstream-server, `agent7` express API, `agent8` deploy surface, `agent10` scratch bump probe, `agent12` critic).

`$SCRATCH` = `/private/tmp/claude-502/-Users-personal-git-demos-mandala/e3b64642-9053-4dd2-9c8a-875af42dd484/scratchpad`

## Global Constraints

- Branch: mandala `feat/brc162`. All work happens in `/Users/personal/git/demos/mandala`; nothing in ts-stack or bsv-wallet.
- **Old token format stays.** `@bsv/overlay-topics` stays `^1.6.0` and resolves to exactly **1.6.0**; `@bsv/templates` stays `^1.9.0` and resolves to **1.9.0**. Both are pinned by the lockfile (`npm ci`).
- TS targets: `@bsv/overlay ^2.6.2`, `@bsv/overlay-express ^2.7.3`, `@bsv/sdk ^2.8.11`, `knex ^3.3.0`, `mongodb ^7.5.0`, `@types/node ^24.0.0`, `"engines": {"node": ">=24 <25"}`, Docker base `node:24-bookworm` (not slim: sqlite3's node-gyp fallback needs python3/make/g++).
- Go targets: `go 1.26.0`, `github.com/bsv-blockchain/go-overlay-services v1.3.7`, `github.com/bsv-blockchain/go-sdk v1.7.1`, Docker `golang:1.26`.
- **Single overlay key:** `SERVER_PRIVATE_KEY` signs σI and decrypts linkage. Do NOT adopt upstream's three-key split or any `MANDALA_*_PRIVATE_KEY` env.
- **Skipped upstream items (spec §7.1 deviation, record in docs):** pino `logger.ts`, OTel `telemetry.ts`, `configureHealth` contextProvider (exposes details), upstream lifecycle "legacy branch" (2.7.3 has `close()`).
- Chaintracks: keep `CHAINTRACKS_API_PREFIX` default `/v2` on `${ARCADE_URL}/chaintracks` (same final URL; parity with Go `defaultChaintracksPrefix`).
- Wire contract v2 codes and reason strings are unchanged. TS ≡ Go on every verdict code.
- Every repo-local guard that cannot read its state fails CLOSED with `InfraError` → `503 ERR_UNAVAILABLE`, never persisted (contract §9.5).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Local npm 12 skips install scripts (`allow-scripts`). After any `npm install`/`npm ci` run `node -e "require('sqlite3')"`. If that fails, run `npm rebuild sqlite3 --foreground-scripts` and re-check.

## Review Focus

1. **Double-spend after the bump.** The second spend of a coin must still get `400 ERR_INPUT_SPENT {spendTxid}`, never `ERR_CONSERVATION`. The engine now drops spent coins from `previousCoins`. Pinned in Task 1 (harness), fixed in Task 2.
2. **Crash between mark-spent and apply.** A retry of the same tx must converge (self-heal → 503 → admitted), not be refused with a persisted final code. Pinned and fixed in Task 2.
3. **Eviction re-delivery racing a live spend.** A retried `/arc-ingest` must never unmark a coin that a different, live tx has since spent. Task 3.
4. **Transient edge refusals.** `ERR_SERVER_BUSY` 503 from the new edge policy must reach the client as retryable `503 ERR_UNAVAILABLE`. The lib must never treat any 503/429 as final. Tasks 5 and 8.
5. **Arcade dupe re-broadcast.** A non-terminal 2xx status outside 2.7.3's success set (e.g. `SEEN_MULTIPLE_NODES`) must count as success, as in Go. Otherwise every idempotent re-submit 503s. Task 6.

---

### Task 1: Real-engine regression harness (current pins)

**Files:**
- Create: `overlay/src/testkit/engineHarness.ts`
- Create: `overlay/src/engineIntegration.test.ts`
- Modify: `overlay/src/spentGuard.ts` (add `knexSpentInputStore`)
- Modify: `overlay/src/index.ts:273-285` (use `knexSpentInputStore`)

**Interfaces:**
- Produces:
  - `knexSpentInputStore(knex: KnexLike, topic: string, wasEvicted: (txid: string) => Promise<boolean>): SpentInputStore`
  - `createHarness(opts?: { wasEvicted?: (txid: string) => Promise<boolean> }): Promise<Harness>`, where `Harness = { engine, storage, knex, key, lock, root: Transaction, spend(sats: number): Promise<Transaction>, submit(tx): Promise<{steak?: unknown, error?: unknown, refusal?: unknown}>, refusals: unknown[], close(): Promise<void> }`

This task runs on the **current** pins (`@bsv/overlay` 2.2.0). It pins today's double-spend behaviour, so that Task 2's bump visibly breaks it.

- [ ] **Step 1: Extract the production spent-input store into `spentGuard.ts`**

Append to `overlay/src/spentGuard.ts`:

```ts
/** Minimal knex surface the spent-input store needs (a knex instance satisfies it). */
export type KnexLike = (table: string) => any

const parseConsumedBy = (raw: unknown): ConsumedByEntry[] => {
  if (Array.isArray(raw)) return raw as ConsumedByEntry[]
  if (typeof raw === 'string' && raw !== '') {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v as ConsumedByEntry[] : [] } catch { return [] }
  }
  return []
}

/**
 * The production SpentInputStore: reads the engine's `outputs` table directly
 * (KnexStorage.findOutput does not select `spentBy`).
 */
export const knexSpentInputStore = (
  knex: KnexLike, topic: string, wasEvicted: (txid: string) => Promise<boolean>
): SpentInputStore => ({
  spendStateOf: async (txid, outputIndex) => {
    const row = await knex('outputs').where({ txid, outputIndex, topic }).first()
    if (row == null) return null
    return { spent: row.spent === true || row.spent === 1, consumedBy: parseConsumedBy(row.consumedBy) }
  },
  wasEvicted
})
```

(Task 2 extends `SpendState` with `spentBy` and adds `releaseSpend`. Keep this step minimal.)

- [ ] **Step 2: Use it in `index.ts`**

Replace `overlay/src/index.ts:273-285` (the `spentInputStore` literal) with:

```ts
  // FIX L — the live spend state of an input, and whether the transaction that
  // spent it has since been evicted (in which case the coin counts as live).
  const spentInputStore: SpentInputStore = knexSpentInputStore(server.knex!, TOKEN_TOPIC, async (txid) => {
    const rec = await admissionsCol.findOne({ txid }, { projection: { evictedAt: 1 } })
    return rec?.evictedAt != null
  })
```

Add `knexSpentInputStore` to the `./spentGuard.js` import on line 20.

- [ ] **Step 3: Write the harness**

Create `overlay/src/testkit/engineHarness.ts`. This is `$SCRATCH/p0-ts/probe/probe.mts` turned into a reusable module that wires the real guard:

```ts
import { Engine, KnexStorage, KnexStorageMigrations } from '@bsv/overlay'
import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import knexFactory from 'knex'
import { withSpentInputGuard, knexSpentInputStore } from '../spentGuard.js'

export const HARNESS_TOPIC = 'tm_harness'

export interface SubmitOutcome { steak?: unknown, error?: unknown, refusal?: unknown }

export const createHarness = async (opts: { wasEvicted?: (txid: string) => Promise<boolean> } = {}) => {
  const knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  const migrations: any[] = (KnexStorageMigrations as any).default ?? KnexStorageMigrations
  await knex.migrate.latest({
    migrationSource: {
      getMigrations: async () => migrations,
      getMigrationName: (m: any) => `Migration at index ${migrations.indexOf(m)}`,
      getMigration: async (m: any) => m
    }
  })
  const storage = new KnexStorage(knex)
  const refusals: unknown[] = []
  const admitAll = {
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[]) => {
      const tx = Transaction.fromBEEF(beef)
      // Retains like MandalaTopicManager (coinsToRetain: previousCoins).
      return { outputsToAdmit: tx.outputs.map((_: unknown, i: number) => i), coinsToRetain: previousCoins }
    },
    getDocumentation: async () => '',
    getMetaData: async () => ({ name: HARNESS_TOPIC, shortDescription: '' })
  }
  const guarded = withSpentInputGuard(admitAll as any,
    knexSpentInputStore(knex, HARNESS_TOPIC, opts.wasEvicted ?? (async () => false)))
  // Outermost recorder: the engine swallows manager throws, so capture them here.
  const recorded = {
    ...guarded,
    identifyAdmissibleOutputs: async (...args: any[]) => {
      try { return await (guarded.identifyAdmissibleOutputs as any)(...args) } catch (e) { refusals.push(e); throw e }
    }
  }
  const engine = new (Engine as any)({ [HARNESS_TOPIC]: recorded }, {}, storage, 'scripts only',
    'https://harness.invalid', [], [], undefined, undefined, {})

  const key = PrivateKey.fromRandom()
  const lock = new P2PKH().lock(key.toPublicKey().toAddress())
  const root = new Transaction(1, [], [{ lockingScript: lock, satoshis: 1000 }], 0)
  root.merklePath = new MerklePath(1, [[{ offset: 0, hash: root.id('hex'), txid: true }]])
  const spend = async (sats: number, source: Transaction = root, vout = 0): Promise<Transaction> => {
    const t = new Transaction(1, [{
      sourceTransaction: source, sourceOutputIndex: vout,
      unlockingScriptTemplate: new P2PKH().unlock(key), sequence: 0xffffffff
    }], [{ lockingScript: lock, satoshis: sats }], 0)
    await t.sign()
    return t
  }
  const submit = async (tx: Transaction): Promise<SubmitOutcome> => {
    const before = refusals.length
    try {
      const steak = await engine.submit({ beef: tx.toBEEF(), topics: [HARNESS_TOPIC] }, undefined, 'current-tx')
      return { steak, refusal: refusals[before] }
    } catch (error) {
      return { error, refusal: refusals[before] }
    }
  }
  return { engine, storage, knex, key, lock, root, spend, submit, refusals, close: async () => { await knex.destroy() } }
}
export type Harness = Awaited<ReturnType<typeof createHarness>>
```

If `engine.submit`'s third parameter is not `'current-tx'` on the installed version, read `node_modules/@bsv/overlay/dist/esm/src/Engine.js` `submit(` and use its mode name. The probe used `'current-tx'` against both 2.2.0 and 2.6.2.

- [ ] **Step 4: Write the double-spend test**

Create `overlay/src/engineIntegration.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './testkit/engineHarness.js'
import { InputSpentError } from './submitVerdict.js'

describe('real engine + spent-input guard', () => {
  let h: Harness
  afterEach(async () => { await h?.close() })

  it('refuses a double spend of an admitted coin with InputSpentError naming the winner', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    const b = await h.spend(800)
    const ra = await h.submit(a)
    expect(ra.refusal).toBeUndefined()
    const rb = await h.submit(b)
    expect(rb.refusal).toBeInstanceOf(InputSpentError)
    expect((rb.refusal as InputSpentError).spendTxid).toBe(a.id('hex'))
  })
})
```

- [ ] **Step 5: Run it on the current pins**

Run: `cd overlay && npx vitest run src/engineIntegration.test.ts`
Expected: PASS. 2.2.0 keeps spent coins in `previousCoins`. If `InputSpentError` is not exported from `submitVerdict.ts`, import it from where `spentGuard.ts` imports it.

- [ ] **Step 6: Full suite + typecheck**

Run: `cd overlay && npx tsc --noEmit -p . && npx vitest run`
Expected: all green (381 + 1). If `indexWiring.test.ts` asserts the old `spentInputStore` literal text, update that assertion to `knexSpentInputStore(server.knex!, TOKEN_TOPIC` and keep its ordering checks.

- [ ] **Step 7: Commit**

```bash
git add overlay/src/testkit/engineHarness.ts overlay/src/engineIntegration.test.ts overlay/src/spentGuard.ts overlay/src/index.ts overlay/src/indexWiring.test.ts
git commit -m "test(overlay): real-engine harness pinning double-spend refusal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bump TS dependencies; make the spent-input guard correct on the new engine

**Files:**
- Modify: `overlay/package.json`, `overlay/package-lock.json`, `overlay/Dockerfile`
- Modify: `overlay/src/spentGuard.ts` (rewrite `conflictingSpend`; delete `InFlightOutpoints`, `IN_FLIGHT_DESCRIPTION`, `tokenInputOutpoints`, `casMarkUTXOAsSpent`, `CasMarkSpentDeps`)
- Modify: `overlay/src/admission.ts` (remove `inFlight` dep, the `finally` release, the `hadSpendConflict` branch, `SPEND_CONFLICT_DESCRIPTION`)
- Modify: `overlay/src/submitSideChannel.ts` (remove `noteSpendConflict` / `hadSpendConflict`)
- Modify: `overlay/src/index.ts` (remove `inFlight` (212-215, 222, 326), the CAS monkeypatch (378-405) and imports)
- Modify tests: `spentGuard.test.ts`, `admission.test.ts`, `submitSideChannel.test.ts`, `wrapperStack.test.ts`, `indexWiring.test.ts`, `engineIntegration.test.ts`

**Interfaces:**
- Consumes: Task 1 `knexSpentInputStore`, `createHarness`.
- Produces:
  - `SpendState = { spent: boolean, spentBy: string | null, consumedBy: ConsumedByEntry[] }`
  - `SpentInputStore.releaseSpend(txid: string, outputIndex: number, spender: string): Promise<number>`
  - `conflictingSpend(tx: Transaction, store: SpentInputStore): Promise<{outpoint: string, spendTxid: string} | null>`
  - `withSpentInputGuard(inner: TopicManager, store: SpentInputStore): TopicManager`
  - exported `SELF_HEAL_DESCRIPTION(outpoint)`, `EVICTED_HEAL_DESCRIPTION(outpoint, competitor)`

Why this is one task: the bump alone breaks Review Focus #1 and #2. The CAS monkeypatch must go in the same change, because it drops the engine's 4th `spendingTxid` argument, so `spentBy` would never be written and the self-heal could not work.

- [ ] **Step 1: Bump dependencies**

Edit `overlay/package.json`:
- deps: `"@bsv/overlay": "^2.6.2"`, `"@bsv/overlay-express": "^2.7.3"`, `"@bsv/sdk": "^2.8.11"`, `"knex": "^3.3.0"`, `"mongodb": "^7.5.0"` (topics, templates, sqlite3, dotenv unchanged).
- devDeps: `"@types/node": "^24.0.0"`.
- Add `"engines": { "node": ">=24 <25" }`.

Run (Node 24):

```bash
cd overlay && npm install && node -e "require('sqlite3')" && npm ls @bsv/overlay @bsv/overlay-express @bsv/overlay-topics @bsv/sdk @bsv/templates
```

Expected: overlay 2.6.2, overlay-express 2.7.3, **overlay-topics 1.6.0**, sdk 2.8.11, **templates 1.9.0**; one copy of each (others "deduped"). If sqlite3 fails to load, run `npm rebuild sqlite3 --foreground-scripts` and re-check. If topics or templates resolved higher, run `npm install @bsv/overlay-topics@1.6.0 @bsv/templates@1.9.0 --save-exact=false` to pin the lock, then re-check.

- [ ] **Step 2: Dockerfile**

Replace `overlay/Dockerfile` with:

```dockerfile
FROM node:24-bookworm
WORKDIR /app
# Lockfile + npm ci: a lockfile-less `npm install` floats ^1.6.0 overlay-topics
# to the newest 1.x, not the 1.6.0 the tests pin.
COPY package.json package-lock.json ./
RUN npm ci
# No SQLite migration patch: @bsv/overlay >= 2.6 emits ON CONFLICT DO NOTHING
# off MySQL in 2024-07-17-001-transactions.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Run the harness — expect the regression**

Run: `cd overlay && npx vitest run src/engineIntegration.test.ts`
Expected: FAIL. `rb.refusal` is `undefined`, because 2.6.2 calls `findOutput(…, false)` and the spent coin never reaches the guard.

- [ ] **Step 4: Add the crash-window and evicted-competitor tests**

Append to `overlay/src/engineIntegration.test.ts` (inside the `describe`). Add `InfraError` to the imports from `./submitVerdict.js`.

```ts
  it('self-heals a coin left spent by an interrupted attempt of the SAME tx, then converges', async () => {
    h = await createHarness()
    await h.submit(h.root)
    const a = await h.spend(900)
    // Interrupted attempt: mark-spent ran (spentBy = a), then insertOutput threw.
    const storage = h.storage as any
    const realInsert = storage.insertOutput.bind(storage)
    storage.insertOutput = async () => { throw new Error('simulated crash after mark-spent') }
    const crashed = await h.submit(a)
    expect(crashed.error).toBeDefined()
    storage.insertOutput = realInsert
    const row = await h.knex('outputs').where({ txid: h.root.id('hex'), outputIndex: 0 }).first()
    expect(Boolean(row.spent)).toBe(true)
    expect(row.spentBy).toBe(a.id('hex'))
    // Retry 1: the guard releases its own stale spend and answers retryable.
    const retry1 = await h.submit(a)
    expect(retry1.refusal).toBeInstanceOf(InfraError)
    // Retry 2: the coin is live again and the tx is admitted.
    const retry2 = await h.submit(a)
    expect(retry2.refusal).toBeUndefined()
    expect(JSON.stringify(retry2.steak)).toContain('"outputsToAdmit":[0]')
  })

  it('heals a coin still marked spent by an EVICTED competitor (retryable), then admits the new spend', async () => {
    const evicted = new Set<string>()
    h = await createHarness({ wasEvicted: async (t) => evicted.has(t) })
    await h.submit(h.root)
    const a = await h.spend(900)
    const b = await h.spend(800)
    await h.submit(a)
    evicted.add(a.id('hex')) // eviction recorded, but its input restore never ran
    const r1 = await h.submit(b)
    expect(r1.refusal).toBeInstanceOf(InfraError)
    const r2 = await h.submit(b)
    expect(r2.refusal).toBeUndefined()
  })
```

Run: `npx vitest run src/engineIntegration.test.ts`
Expected: the 3 tests FAIL.

- [ ] **Step 5: Rewrite the guard**

In `overlay/src/spentGuard.ts`:

1. Replace the module docstring's hole 1 / hole 2 text. Since `@bsv/overlay` 2.6 the engine builds `previousCoins` with `findOutput(…, topic, false)`, which silently drops a spent coin; the guard therefore inspects **every input**. The engine's own `markUTXOAsSpent` is a CAS that writes `spentBy`, and phase-3 failures now rethrow.
2. Change the types:

```ts
export interface SpendState {
  spent: boolean
  /** The engine's `outputs.spentBy` — the spending txid recorded by the CAS (null on legacy rows). */
  spentBy: string | null
  /** The outputs that consumed this coin — fallback when spentBy is null. */
  consumedBy: ConsumedByEntry[]
}

export interface SpentInputStore {
  spendStateOf: (txid: string, outputIndex: number) => Promise<SpendState | null>
  wasEvicted: (txid: string) => Promise<boolean>
  /**
   * `UPDATE outputs SET spent=false, spentBy=NULL WHERE txid/outputIndex/topic
   * AND spent=true AND (spentBy=spender OR spentBy IS NULL)` → rows affected.
   */
  releaseSpend: (txid: string, outputIndex: number, spender: string) => Promise<number>
}

export const SELF_HEAL_DESCRIPTION = (outpoint: string): string =>
  `input ${outpoint} was left marked spent by an interrupted attempt of this transaction; released, retry`
export const EVICTED_HEAL_DESCRIPTION = (outpoint: string, competitor: string): string =>
  `input ${outpoint} was still marked spent by evicted transaction ${competitor}; released, retry`
```

3. Delete `tokenInputOutpoints`, `IN_FLIGHT_DESCRIPTION`, `InFlightOutpoints`, `CasMarkSpentDeps`, `casMarkUTXOAsSpent`.
4. Replace `conflictingSpend` and `withSpentInputGuard`:

```ts
/**
 * The first input of `tx` that a different, still-admitted transaction has
 * already spent — or null when every input is live.
 *
 * Every input, not `previousCoins`: since @bsv/overlay 2.6 the engine omits
 * spent coins from previousCoins, so the double spend would otherwise surface
 * as the manager's conservation reject (a persisted final ERR_CONSERVATION).
 *
 * Two stale-spend cases are healed, then refused retryably (InfraError → 503),
 * because the engine already built previousCoins without the coin:
 *  - spent by THIS tx: an earlier attempt crashed between mark-spent and
 *    insertAppliedTransaction (the engine's dupe check already proved this tx
 *    is not applied);
 *  - spent by an EVICTED tx whose input restore never ran.
 */
export const conflictingSpend = async (
  tx: Transaction,
  store: SpentInputStore
): Promise<{ outpoint: string, spendTxid: string } | null> => {
  const self = tx.id('hex')
  for (const inp of tx.inputs) {
    const { txid, vout } = outpointOf(inp)
    if (txid === '') continue
    const state = await infra('the engine output store', async () => await store.spendStateOf(txid, vout))
    if (state == null || !state.spent) continue
    const outpoint = `${txid}.${vout}`
    const competitor = state.spentBy ?? spendTxidOf(state.consumedBy)
    if (competitor === self) {
      await infra('the engine output store', async () => await store.releaseSpend(txid, vout, self))
      throw new InfraError(SELF_HEAL_DESCRIPTION(outpoint))
    }
    if (competitor != null && await infra('the admission record store', async () => await store.wasEvicted(competitor))) {
      await infra('the engine output store', async () => await store.releaseSpend(txid, vout, competitor))
      throw new InfraError(EVICTED_HEAL_DESCRIPTION(outpoint, competitor))
    }
    return { outpoint, spendTxid: competitor ?? '' }
  }
  return null
}

/** Wraps a topic manager so a conflicting spend is refused before delegating. */
export const withSpentInputGuard = (inner: TopicManager, store: SpentInputStore): TopicManager => {
  const guarded: TopicManager = {
    ...inner,
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[], offChainValues?: number[]) => {
      const tx = Transaction.fromBEEF(beef)
      const hit = await conflictingSpend(tx, store)
      if (hit != null) throw new InputSpentError(hit.outpoint, hit.spendTxid)
      return await (inner.identifyAdmissibleOutputs as (
        b: number[], p: number[], o?: number[]
      ) => Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }>)(beef, previousCoins, offChainValues)
    }
  }
  return new Proxy(guarded, {
    get: (target, prop, receiver) =>
      prop === 'identifyAdmissibleOutputs'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}
```

5. Extend `knexSpentInputStore`:

```ts
export const knexSpentInputStore = (
  knex: KnexLike, topic: string, wasEvicted: (txid: string) => Promise<boolean>
): SpentInputStore => ({
  spendStateOf: async (txid, outputIndex) => {
    const row = await knex('outputs').where({ txid, outputIndex, topic }).first()
    if (row == null) return null
    const spentBy = typeof row.spentBy === 'string' && row.spentBy !== '' ? row.spentBy.toLowerCase() : null
    return { spent: row.spent === true || row.spent === 1, spentBy, consumedBy: parseConsumedBy(row.consumedBy) }
  },
  wasEvicted,
  releaseSpend: async (txid, outputIndex, spender) =>
    await knex('outputs')
      .where({ txid, outputIndex, topic, spent: true })
      .andWhere((q: any) => q.where('spentBy', spender).orWhereNull('spentBy'))
      .update({ spent: false, spentBy: null })
})
```

- [ ] **Step 6: Remove the in-flight hold and the CAS monkeypatch**

- `overlay/src/index.ts`:
  - delete lines 212-215 (`inFlight` construction), `inFlight` from the `wrapSubmitJson({...})` deps (line 222), and the `inFlight` argument of `withSpentInputGuard` (line 326);
  - delete the whole `// FIX L, detecting half…` block (lines 378-405);
  - drop `casMarkUTXOAsSpent, InFlightOutpoints` from the import on line 20.
- `overlay/src/admission.ts`:
  - delete `inFlight` from `SubmitWrapDeps`;
  - delete the `finally { … releaseAll … }` in the `res.json` override;
  - in the `admitted.length > 0` branch replace the `conflicted` logic with `await persist(txid, signed, admitted, outcome?.restore); origJson(signed); return`;
  - delete `SPEND_CONFLICT_DESCRIPTION` (line 286) and its import of `InFlightOutpoints`.
- `overlay/src/submitSideChannel.ts`: delete `noteSpendConflict` and `hadSpendConflict` and their state.

A CAS conflict now rejects `Engine.submit` itself. The route answers `{status:'error', …}` and the existing `isErrorBody` branch maps it to `503 ERR_UNAVAILABLE` (retryable). The retry converges on the guard's `400 ERR_INPUT_SPENT`.

- [ ] **Step 7: Update unit tests to the new contract**

- `spentGuard.test.ts`:
  - Every store fake gains `spentBy: null` in returned states and a `releaseSpend` that records calls and returns 1.
  - Invert the test at ~line 75 ("only inspects previousCoins") into "inspects every input, even with `previousCoins = []`", using the probe's case: `store({ row: { spent: true, spentBy: COMPETITOR, consumedBy: [] } })`, `identifyAdmissibleOutputs(spendTx().toBEEF(), [], undefined)` → `InputSpentError` with `spendTxid === COMPETITOR` and inner not called.
  - Replace the ~line 52 "evicted competitor counts as live → delegates" test with "evicted competitor → `releaseSpend(txid, vout, COMPETITOR)` called once and `InfraError` with `EVICTED_HEAL_DESCRIPTION`; inner not called".
  - Add "spentBy === own txid → `releaseSpend(…, self)` and `InfraError` with `SELF_HEAL_DESCRIPTION`".
  - Add "spentBy null + consumedBy names competitor → `InputSpentError` naming it" (legacy fallback).
  - Delete the `InFlightOutpoints` and `casMarkUTXOAsSpent` suites (~187-270).
- `admission.test.ts` / `submitSideChannel.test.ts` / `wrapperStack.test.ts`: delete the spend-conflict and in-flight cases (`wrapperStack.test.ts` ~339 and ~378). Do not weaken any other assertion.
- `indexWiring.test.ts`: drop the `inFlight` assertions (~63, ~75-83). Keep the guard-order assertion: `withUnlinkedTokenReject( withSpentInputGuard( withAdminChainAnchor(`.

- [ ] **Step 8: Run everything**

Run: `cd overlay && npx tsc --noEmit -p . && npx vitest run`
Expected: all green, including the 3 harness tests.

- [ ] **Step 9: Commit**

```bash
git add overlay/
git commit -m "feat(overlay): bump to @bsv/overlay 2.6.2 / overlay-express 2.7.3 / sdk 2.8.11 on Node 24

The new engine drops spent coins from previousCoins and does its own CAS
mark-spent with spentBy. The spent-input guard now checks every input,
self-heals a coin left spent by an interrupted attempt of the same tx, and
heals a coin still held by an evicted competitor (both retryable 503).
The 3-arg CAS monkeypatch (which dropped spentBy) and the in-flight hold
(redundant now that the engine serializes submits) are removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Eviction hardening for the new engine

**Files:**
- Modify: `overlay/src/eviction.ts`
- Modify: `overlay/src/index.ts:407-460` (mountArcIngest deps)
- Test: `overlay/src/eviction.test.ts`

**Interfaces:**
- Consumes: Task 2's `spentBy` column semantics.
- Produces:
  - `EvictionDeps.unmarkSpent(txid: string, outputIndex: number, evictedTxid: string): Promise<number>`, which returns rows affected;
  - `restoreTokenRow` is called only for coins whose unmark affected a row or that were already unspent;
  - `ArcIngestDeps.ingestProof(txid: string, merklePathHex: string): Promise<void>` (no `blockHeight`).

- [ ] **Step 1: Write the failing tests**

Add to `overlay/src/eviction.test.ts`, reusing the file's existing fakes:

1. **Never clobber a live spend.** The `unmarkSpent` fake returns `0`: the coin is now spent by a different tx. Expect `evictWithRestore` NOT to call `restoreTokenRow` for that coin's row. The eviction still completes (`markEvicted` called, `evict` called), and `report.restoredOutpoints === 0`.
2. **Retry after a partial failure still restores.** The first run unmarked the coin, then `restoreTokenRow` threw (→ `InfraError`, nothing stamped). On the retry `unmarkSpent` returns `0` (already unspent) and `isUnspent` returns `true`, so `restoreTokenRow` IS called for that coin's row and the eviction completes.
3. **Reason is truncated** to 256 UTF-16 units before `evict` is called: pass a 2000-char `extraInfo` and expect `evict`'s reason length ≤ 256.
4. **Malformed txid → 400** `{status:'error', message:'Provider callback txid must be 64 hex characters'}` before any store write (`store.get` not called).
5. **Proof ingestion drops `blockHeight`:** `ingestProof` is called with exactly `(txid, merklePathHex)`.

(The constant-time callback-token compare lands in Task 4, which owns `secrets.ts`.)

Run: `npx vitest run src/eviction.test.ts` → FAIL.

- [ ] **Step 2: Implement in `eviction.ts`**

- `EvictionDeps.unmarkSpent` becomes `(txid, outputIndex, evictedTxid) => Promise<number>`.
- Add `EvictionDeps.isUnspent: (txid, outputIndex) => Promise<boolean>`, true when the row exists with `spent=false`.
- In `evictWithRestore`, build `restorable = new Set<string>()` of outpoints whose `unmarkSpent(...) > 0` OR `isUnspent(...) === true`. Restore only token rows whose `${row.txid}.${row.outputIndex}` is in `restorable`. A coin spent by a different live tx stays spent and keeps no token row.
- In `arcIngestHandler`:
  - after the empty-txid check add `if (!/^[0-9a-f]{64}$/.test(txid)) { res.status(400).json({ status: 'error', message: 'Provider callback txid must be 64 hex characters' }); return }`;
  - compute `reason` then `const bounded = reason.slice(0, 256)`;
  - call `deps.ingestProof(txid, merklePath)`.
- Replace the local `TERMINAL_STATUSES` / `isTerminalArcStatus` mirror with `import { isTerminalArcStatus } from '@bsv/overlay-express'` if `node_modules/@bsv/overlay-express/dist/esm/mod.js` (or the package entry) exports it. Otherwise keep the mirror and update its comment.
- Delete the empty-token stub in `mountArcIngest`. It now always mounts the real handler and returns `void`. Update the module docstring: overlay-express 2.7.3 fails closed and `start()` refuses Arcade without a token, so the stub is gone; the route is still shadowed because the pinned route evicts without restoring inputs.

- [ ] **Step 3: Wire in `index.ts`**

```ts
      unmarkSpent: async (txid, outputIndex, evictedTxid) =>
        await server.knex!('outputs')
          .where({ txid, outputIndex, topic: TOKEN_TOPIC, spent: true })
          .andWhere((q: any) => q.where('spentBy', evictedTxid).orWhereNull('spentBy'))
          .update({ spent: false, spentBy: null }),
      isUnspent: async (txid, outputIndex) => {
        const row = await server.knex!('outputs').where({ txid, outputIndex, topic: TOKEN_TOPIC }).first('spent')
        return row != null && !(row.spent === true || row.spent === 1)
      },
      ingestProof: async (txid, merklePathHex) => {
        await (server.engine as unknown as {
          handleNewMerkleProof: (t: string, p: MerklePath) => Promise<unknown>
        }).handleNewMerkleProof(txid, MerklePath.fromHex(merklePathHex))
      }
```

Update the comments at `index.ts:72-78` and `:407-415`: the token is mandatory whenever `ARCADE_URL` is set (Task 4 enforces it at boot).

- [ ] **Step 4: Run and commit**

Run: `cd overlay && npx tsc --noEmit -p . && npx vitest run` → green. Delete or invert the stub tests (~`eviction.test.ts:402`).

```bash
git add overlay/src/eviction.ts overlay/src/eviction.test.ts overlay/src/index.ts
git commit -m "fix(overlay): eviction never clobbers a live spend; bounded reason, txid guard, proof height from proof

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Boot configuration for overlay-express 2.7.3

**Files:**
- Create: `overlay/src/secrets.ts`, `overlay/src/secrets.test.ts`
- Modify: `overlay/src/eviction.ts` (`arcIngestHandler` token check → `constantTimeEqual`), `overlay/src/eviction.test.ts`
- Create: `overlay/src/bootConfig.ts`, `overlay/src/bootConfig.test.ts`
- Modify: `overlay/src/adminAuth.ts:33-43`, `overlay/src/index.ts:33-88, 376`
- Modify: `overlay/.env.example`

**Interfaces:**
- Produces:
  - `assertSharedSecret(value: unknown, label: string): asserts value is string`
  - `readOptionalSecretEnv(env, name): string`
  - `constantTimeEqual(a: string, b: string): boolean`
  - `readBooleanEnv(env, name, defaultValue): boolean`
  - `canonicalPrivateKey(value: string, name: string): string`
  - `readBootConfig(env: Record<string, string | undefined>): BootConfig`

```ts
export interface BootConfig {
  nodeName: string
  serverPrivateKey: string          // canonical 64-hex
  hostingUrl: string                // as given (CORS origin, logs)
  advertisableHost: string          // passed to new OverlayExpress(...)
  mongoUrl: string
  network: 'main' | 'test'
  sqliteFile: string
  adminApiToken: string             // '' = open (dev default, warned)
  arcade?: {
    url: string
    apiKey?: string
    callbackToken: string           // ≥32 bytes, mandatory with arcade
    chaintracksUrl: string
    chaintracksApiPrefix: string    // default '/v2'
    allowPrivateHosts: boolean      // ARCADE_ALLOW_PRIVATE_HOSTS, default false
  }
}
```

- [ ] **Step 1: Write `secrets.test.ts` (failing)**

```ts
import { describe, expect, it } from 'vitest'
import { assertSharedSecret, constantTimeEqual, readOptionalSecretEnv, readBooleanEnv } from './secrets.js'

const S32 = 'a'.repeat(32)
describe('secrets', () => {
  it('accepts a 32-byte secret', () => { expect(() => assertSharedSecret(S32, 'X')).not.toThrow() })
  it('rejects 31 bytes', () => { expect(() => assertSharedSecret('a'.repeat(31), 'X')).toThrow(/X must contain between 32 and 16384 UTF-8 bytes/) })
  it('rejects surrounding whitespace', () => { expect(() => assertSharedSecret(S32 + '\n', 'X')).toThrow(/whitespace/) })
  it('rejects control characters', () => { expect(() => assertSharedSecret('a'.repeat(31) + '\u0007', 'X')).toThrow(/control/) })
  it('unset optional secret is empty', () => { expect(readOptionalSecretEnv({}, 'T')).toBe('') })
  it('set-but-weak optional secret throws naming the env var', () => { expect(() => readOptionalSecretEnv({ T: 'short' }, 'T')).toThrow(/^T must/) })
  it('constant-time equal', () => { expect(constantTimeEqual(S32, S32)).toBe(true); expect(constantTimeEqual(S32, 'b'.repeat(32))).toBe(false) })
  it('booleans', () => {
    expect(readBooleanEnv({}, 'B', false)).toBe(false)
    expect(readBooleanEnv({ B: 'true' }, 'B', false)).toBe(true)
    expect(() => readBooleanEnv({ B: 'maybe' }, 'B', false)).toThrow(/B must be one of/)
  })
})
```

- [ ] **Step 2: Implement `secrets.ts`**

```ts
import { createHash, timingSafeEqual } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'

/** Ported from overlay-express 2.7.3 assertSharedSecret (OverlayExpress.ts:308-326), naming the env var. */
export const MIN_SHARED_SECRET_BYTES = 32
export const MAX_SHARED_SECRET_BYTES = 16 * 1024

export function assertSharedSecret (value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new TypeError(`${label} must not contain leading or trailing whitespace`)
  }
  const byteLength = new TextEncoder().encode(value).byteLength
  if (byteLength < MIN_SHARED_SECRET_BYTES || byteLength > MAX_SHARED_SECRET_BYTES) {
    throw new TypeError(`${label} must contain between ${MIN_SHARED_SECRET_BYTES} and ${MAX_SHARED_SECRET_BYTES} UTF-8 bytes`)
  }
  if (Array.from(value).some(ch => { const cp = ch.codePointAt(0) ?? 0; return cp <= 0x1f || cp === 0x7f })) {
    throw new TypeError(`${label} must not contain control characters`)
  }
}

/** '' when unset/empty (the caller decides what unset means); throws when set but weak. */
export function readOptionalSecretEnv (env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') return ''
  assertSharedSecret(value, name)
  return value
}

export function constantTimeEqual (a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/** Verbatim from ts-stack infra/overlay-server securityConfig.ts. */
export const readBooleanEnv = (env: Record<string, string | undefined>, name: string, defaultValue: boolean): boolean => {
  const value = env[name]
  if (value === undefined || value === '') return defaultValue
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  throw new TypeError(`${name} must be one of true, false, 1, 0, yes, or no`)
}

/** Adapted from upstream securityConfig.ts canonicalPrivateKey (no key-independence check: one overlay key). */
export const canonicalPrivateKey = (value: string, name: string): string => {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${name} must be an exact 32-byte hexadecimal private key`)
  try { return PrivateKey.fromHex(value).toHex() } catch { throw new TypeError(`${name} must be a valid secp256k1 private key`) }
}
```

Run: `npx vitest run src/secrets.test.ts` → PASS.

- [ ] **Step 3: Write `bootConfig.test.ts` (failing)**

```ts
import { describe, expect, it } from 'vitest'
import { readBootConfig } from './bootConfig.js'

const KEY = '1'.repeat(64)
const base = { NODE_NAME: 'mandala', SERVER_PRIVATE_KEY: KEY, HOSTING_URL: 'http://localhost:8080', MONGO_URL: 'mongodb://m', NETWORK: 'test' }
const TOKEN = 't'.repeat(32)

describe('readBootConfig', () => {
  it('local dev: http hosting URL yields a bare host, no arcade', () => {
    const c = readBootConfig(base)
    expect(c.advertisableHost).toBe('localhost:8080')
    expect(c.arcade).toBeUndefined()
    expect(c.sqliteFile).toBe('/data/overlay.sqlite')
  })
  it('https hosting URL is reduced to its host', () => {
    expect(readBootConfig({ ...base, HOSTING_URL: 'https://deggen.ngrok.app' }).advertisableHost).toBe('deggen.ngrok.app')
  })
  it('scheme-less hosting URL passes through', () => {
    expect(readBootConfig({ ...base, HOSTING_URL: 'overlay.example.com' }).advertisableHost).toBe('overlay.example.com')
  })
  it('rejects a bad NETWORK and a malformed key', () => {
    expect(() => readBootConfig({ ...base, NETWORK: 'ttn' })).toThrow(/NETWORK must be "main" or "test"/)
    expect(() => readBootConfig({ ...base, SERVER_PRIVATE_KEY: 'xyz' })).toThrow(/SERVER_PRIVATE_KEY must be an exact 32-byte/)
  })
  it('arcade requires a ≥32-byte callback token', () => {
    const env = { ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'https://arcade.example.com' }
    expect(() => readBootConfig(env)).toThrow(/ARCADE_CALLBACK_TOKEN is required when ARCADE_URL is set/)
    expect(() => readBootConfig({ ...env, ARCADE_CALLBACK_TOKEN: 'short' })).toThrow(/ARCADE_CALLBACK_TOKEN must contain/)
  })
  it('arcade requires an https HOSTING_URL (Arcade calls back https://<host>/arc-ingest)', () => {
    expect(() => readBootConfig({ ...base, ARCADE_URL: 'https://arcade.example.com', ARCADE_CALLBACK_TOKEN: TOKEN }))
      .toThrow(/HOSTING_URL must be an https URL when ARCADE_URL is set/)
  })
  it('arcade defaults', () => {
    const c = readBootConfig({ ...base, HOSTING_URL: 'https://o.example.com', ARCADE_URL: 'https://arcade.example.com', ARCADE_CALLBACK_TOKEN: TOKEN })
    expect(c.arcade).toEqual({
      url: 'https://arcade.example.com', apiKey: undefined, callbackToken: TOKEN,
      chaintracksUrl: 'https://arcade.example.com/chaintracks', chaintracksApiPrefix: '/v2', allowPrivateHosts: false
    })
  })
  it('weak ADMIN_API_TOKEN fails boot; unset stays open', () => {
    expect(readBootConfig(base).adminApiToken).toBe('')
    expect(() => readBootConfig({ ...base, ADMIN_API_TOKEN: 'short' })).toThrow(/ADMIN_API_TOKEN must contain/)
  })
})
```

- [ ] **Step 4: Implement `bootConfig.ts`**

```ts
import { canonicalPrivateKey, readBooleanEnv, readOptionalSecretEnv } from './secrets.js'

export interface BootConfig { /* exactly as in this task's Interfaces block */ }

type Env = Record<string, string | undefined>
const requireEnv = (env: Env, name: string): string => {
  const v = env[name]
  if (v == null || v === '') throw new Error(`Missing required environment variable: ${name}`)
  return v
}

/** overlay-express 2.7.3 wants a bare HTTPS host (it rejects http:// URLs and paths). */
export const advertisableHostOf = (hostingUrl: string): string =>
  hostingUrl.includes('://') ? new URL(hostingUrl).host : hostingUrl

export const readBootConfig = (env: Env): BootConfig => {
  const nodeName = requireEnv(env, 'NODE_NAME')
  const serverPrivateKey = canonicalPrivateKey(requireEnv(env, 'SERVER_PRIVATE_KEY'), 'SERVER_PRIVATE_KEY')
  const hostingUrl = requireEnv(env, 'HOSTING_URL')
  const mongoUrl = requireEnv(env, 'MONGO_URL')
  const network = requireEnv(env, 'NETWORK')
  if (network !== 'main' && network !== 'test') throw new Error('NETWORK must be "main" or "test"')
  const adminApiToken = readOptionalSecretEnv(env, 'ADMIN_API_TOKEN')
  const arcadeUrl = env.ARCADE_URL
  let arcade: BootConfig['arcade']
  if (arcadeUrl != null && arcadeUrl !== '') {
    const callbackToken = readOptionalSecretEnv(env, 'ARCADE_CALLBACK_TOKEN')
    if (callbackToken === '') throw new Error('ARCADE_CALLBACK_TOKEN is required when ARCADE_URL is set (overlay-express 2.7.3 refuses to start without it)')
    if (!hostingUrl.startsWith('https://')) throw new Error('HOSTING_URL must be an https URL when ARCADE_URL is set (Arcade calls back https://<host>/arc-ingest)')
    arcade = {
      url: arcadeUrl,
      apiKey: env.ARCADE_API_KEY === '' ? undefined : env.ARCADE_API_KEY,
      callbackToken,
      chaintracksUrl: env.CHAINTRACKS_URL ?? `${arcadeUrl}/chaintracks`,
      chaintracksApiPrefix: env.CHAINTRACKS_API_PREFIX ?? '/v2',
      allowPrivateHosts: readBooleanEnv(env, 'ARCADE_ALLOW_PRIVATE_HOSTS', false)
    }
  }
  return {
    nodeName, serverPrivateKey, hostingUrl, advertisableHost: advertisableHostOf(hostingUrl),
    mongoUrl, network, sqliteFile: env.SQLITE_FILE ?? '/data/overlay.sqlite', adminApiToken, arcade
  }
}
```

Run: `npx vitest run src/bootConfig.test.ts` → PASS.

- [ ] **Step 5: Use it in `index.ts`**

- Replace `requireEnv` and lines 40-54 / 71-88 with `const cfg = readBootConfig(process.env)`. Use `cfg.*` everywhere: `SERVER_PRIVATE_KEY` → `cfg.serverPrivateKey`, `NODE_NAME` → `cfg.nodeName`, `HOSTING_URL` → `cfg.hostingUrl` (CORS origins and the final log), `ADMIN_API_TOKEN` → `cfg.adminApiToken`.
- Constructor: `new OverlayExpress(cfg.nodeName, cfg.serverPrivateKey, cfg.advertisableHost)`.
- Arcade block:

```ts
  if (cfg.arcade != null) {
    server.configureArcade(cfg.arcade.url, { apiKey: cfg.arcade.apiKey, allowPrivateHosts: cfg.arcade.allowPrivateHosts })
    server.configureArcCallbackToken(cfg.arcade.callbackToken)
    server.configureChaintracks(cfg.arcade.chaintracksUrl, { apiPrefix: cfg.arcade.chaintracksApiPrefix, allowPrivateHosts: cfg.arcade.allowPrivateHosts })
  } else {
    server.configureChainTracker('scripts only')
  }
```

- The `mountArcIngest` gate becomes `if (cfg.arcade != null)` with `callbackToken: cfg.arcade.callbackToken`.
- Immediately before `await server.configureEngine(false)` add `server.configureEngineParams({ throwOnBroadcastFailure: true })`. The comment notes that the "failed broadcast rejects the submit" invariant is now explicit, not a default.
- Immediately after `await server.configureEngine(false)` add:

```ts
  // overlay-express 2.7.3 builds a SHIP/SLAP WalletAdvertiser once the FQDN is
  // a valid https host. Mandala does not advertise (GASP sync is off), and the
  // advertiser would run babbage-storage calls at boot and SLAP lookups inside
  // the engine's submission lock. start() only inits it when it is a
  // WalletAdvertiser, so clearing it is safe.
  ;(server.engine as unknown as { advertiser?: unknown }).advertiser = undefined
```

- `adminAuth.ts`: delete the local `constantTimeEqual` (lines 33-43) and its `crypto` import; import `constantTimeEqual` from `./secrets.js`.
- `eviction.ts` `arcIngestHandler`: replace `!presented(req.headers ?? {}).includes(deps.callbackToken)` with `!presented(req.headers ?? {}).some(c => constantTimeEqual(c, deps.callbackToken))`. Add an `eviction.test.ts` case: a wrong token of equal length → 401, and the right token via `X-Callback-Token` → handled.

- [ ] **Step 6: `.env.example`**

In `overlay/.env.example`:
- document that `ADMIN_API_TOKEN` and `ARCADE_CALLBACK_TOKEN` must each be 32–16384 UTF-8 bytes with no surrounding whitespace;
- document that `ARCADE_CALLBACK_TOKEN` is required whenever `ARCADE_URL` is set, and that `HOSTING_URL` must then be the overlay's public `https://` URL;
- add a commented `#ARCADE_ALLOW_PRIVATE_HOSTS=false` with "only for an isolated local http/private-network Arcade";
- remove the "server still starts without a token" wording.

- [ ] **Step 7: Run and commit**

Run: `cd overlay && npx tsc --noEmit -p . && npx vitest run` → green. Update `indexWiring.test.ts` source-text assertions that referenced the removed env code (keep the ordering assertions).

```bash
git add overlay/
git commit -m "feat(overlay): boot config for overlay-express 2.7.3 — https host, mandatory callback token, ≥32-byte secrets, advertiser off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `/submit` wrapper hardening against the new edge policy

**Files:**
- Modify: `overlay/src/admission.ts` (`wrapSubmitJson`, varint readers)
- Modify: `overlay/src/index.ts:217-223`
- Test: `overlay/src/admission.test.ts`, `overlay/src/indexWiring.test.ts`

**Interfaces:**
- Produces: `wrapSubmitJson(deps)` is mounted with `server.app.post('/submit', …)`; `normalizeDoubleSlash` middleware.

- [ ] **Step 1: Failing tests in `admission.test.ts`**

Use the file's existing req/res fakes.

1. **Synchronous edge response inside `next()`:** `next` calls `res.json({ status: 'error', code: 'ERR_SERVER_BUSY', description: 'busy' })` synchronously. Expected: the response is `503` with body `{ status: 'error', code: 'ERR_UNAVAILABLE', retryable: true, description: 'busy' }` (use `errorBody`'s exact shape), and no `ReferenceError` is logged.
2. **Synchronous `ERR_BODY_TOO_LARGE` / `ERR_INVALID_BODY` inside `next()`** with `req.body` unset → `400` with `requestErrorBody` shape (code `ERR_SHAPE`, `retryable: false`).
3. **Non-canonical varint framing** (`x-includes-off-chain-values: true`, length written as `0xfd 0x05 0x00`) → `txidFromSubmitBody` returns `null`, so the request is refused as 400, the same as upstream's strict reader.

Run → FAIL. Case 1 currently hits the TDZ: `settle` is declared after `runInSubmitScope`.

- [ ] **Step 2: Implement**

In `wrapSubmitJson`:
- Move `runInSubmitScope(scope, () => { next() })` to the very end of the returned middleware function, after the `settle`, `refuse` and `requestProblem` declarations. This fixes the TDZ.
- At the top of the `res.json` override, before the async IIFE:

```ts
      // overlay-express 2.7.3 edge policy answers synchronously from inside
      // next() (concurrency cap, body limits). ERR_SERVER_BUSY is transient and
      // must reach the client as the contract's retryable 503, never a 400.
      const edge = body as { status?: unknown, code?: unknown, description?: unknown } | null
      if (edge?.status === 'error' && edge.code === 'ERR_SERVER_BUSY') {
        send(503, errorBody('ERR_UNAVAILABLE', typeof edge.description === 'string' ? edge.description : 'overlay at capacity'))
        return res
      }
```

- Replace `r.readVarIntNum()` at `admission.ts:82` and `:134` with `r.readVarIntNumStrict(false)` (sdk ≥2.8). If the SDK's `Reader` signature differs, read `node_modules/@bsv/sdk/dist/esm/src/primitives/utils.js` `readVarIntNumStrict` and match upstream's call at `OverlayExpress.ts:2672-2676`. Wrap it in the same try/catch that returns `null`.
- Remove the `req.path !== '/submit' || req.method !== 'POST'` early return (the route matcher now does this).

In `index.ts` replace `server.app.use(wrapSubmitJson({...}) as any)` with:

```ts
  // Collapse leading '//' before any route of ours matches (2.7.3 normalizes
  // only later, inside start(), so '//submit' would otherwise bypass σI).
  server.app.use((req: Request, _res: Response, next: () => void) => {
    if (req.url.startsWith('//')) req.url = req.url.replace(/^\/{2,}/, '/')
    next()
  })
  // Same matcher as the upstream route (case-insensitive, non-strict), so
  // '/Submit' and '/submit/' cannot bypass the admission wrapper either.
  server.app.post('/submit', wrapSubmitJson({ priv: overlayPriv, store: admissionStore, applied: appliedProof, channel: submitChannel }) as any)
```

Express calls `next()` from our handler into the upstream `/submit` route registered in `start()`.

- [ ] **Step 3: Wiring test**

In `indexWiring.test.ts` assert that the source contains `server.app.post('/submit', wrapSubmitJson(` and the double-slash normalizer appears before it.

- [ ] **Step 4: Run and commit**

Run: `cd overlay && npx tsc --noEmit -p . && npx vitest run` → green.

```bash
git add overlay/src/admission.ts overlay/src/admission.test.ts overlay/src/index.ts overlay/src/indexWiring.test.ts
git commit -m "fix(overlay): /submit wrapper — route matcher, '//' normalizer, TDZ, ERR_SERVER_BUSY→retryable 503, strict varints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Arcade status parity with Go

**Files:**
- Create: `overlay/src/arcadeParity.ts`, `overlay/src/arcadeParity.test.ts`
- Modify: `overlay/src/index.ts` (after `configureEngine`)

**Interfaces:**
- Produces: `withArcadeStatusParity<B extends { broadcast: (tx: Transaction) => Promise<any> }>(b: B): B`

overlay-express 2.7.3's `ArcadeProvider.broadcast` returns `{status:'error', code:'500', description:'Arcade returned an unknown success status', more:{terminal:false}}` for a 2xx whose `txStatus` is not terminal and not in its eight-status success set. Arcade echoes `SEEN_MULTIPLE_NODES` / `PENDING_RETRY` / `STUMP_PROCESSING` / `UNKNOWN` on re-submit. overlay-go's broadcaster (`internal/arcade/broadcaster.go:186-203`) treats every non-terminal 2xx as success. Terminal statuses are checked before that throw, so the description identifies a non-terminal 2xx exactly.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { Transaction } from '@bsv/sdk'
import { withArcadeStatusParity, UNKNOWN_SUCCESS_STATUS } from './arcadeParity.js'

const tx = new Transaction(1, [], [], 0)
const fake = (r: unknown) => ({ broadcast: async () => r })

describe('withArcadeStatusParity', () => {
  it('maps a non-terminal unknown 2xx status to success (Go parity)', async () => {
    const b = withArcadeStatusParity(fake({ status: 'error', code: '500', description: UNKNOWN_SUCCESS_STATUS, more: { terminal: false } }))
    expect(await b.broadcast(tx)).toEqual({ status: 'success', txid: tx.id('hex'), message: 'non-terminal Arcade status accepted (Go parity)' })
  })
  it('passes terminal failures through', async () => {
    const f = { status: 'error', code: 'DOUBLE_SPEND_ATTEMPTED', description: 'x', more: { terminal: true } }
    expect(await withArcadeStatusParity(fake(f)).broadcast(tx)).toBe(f)
  })
  it('passes other 500s through (network, oversize body)', async () => {
    const f = { status: 'error', code: '500', description: 'fetch failed', more: { terminal: false } }
    expect(await withArcadeStatusParity(fake(f)).broadcast(tx)).toBe(f)
  })
  it('passes success through', async () => {
    const s = { status: 'success', txid: 'a', message: 'SEEN_ON_NETWORK' }
    expect(await withArcadeStatusParity(fake(s)).broadcast(tx)).toBe(s)
  })
})
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement `arcadeParity.ts`**

```ts
import type { Transaction } from '@bsv/sdk'

/** Exact description overlay-express 2.7.3 ArcadeProvider.broadcast returns for a non-terminal 2xx outside its success set. */
export const UNKNOWN_SUCCESS_STATUS = 'Arcade returned an unknown success status'

export const withArcadeStatusParity = <B extends { broadcast: (tx: Transaction) => Promise<any> }>(inner: B): B => {
  const original = inner.broadcast.bind(inner)
  inner.broadcast = async (tx: Transaction) => {
    const r = await original(tx)
    if (r?.status === 'error' && r.code === '500' && r.description === UNKNOWN_SUCCESS_STATUS && r.more?.terminal === false) {
      return { status: 'success', txid: tx.id('hex'), message: 'non-terminal Arcade status accepted (Go parity)' }
    }
    return r
  }
  return inner
}
```

- [ ] **Step 3: Wire after `configureEngine`**

```ts
  const engineBroadcaster = (server.engine as unknown as { broadcaster?: { broadcast: (tx: any) => Promise<any> } }).broadcaster
  if (engineBroadcaster != null) withArcadeStatusParity(engineBroadcaster)
```

Read `OverlayExpress.ts` (`configureEngine`, ~line 1510) in `node_modules/@bsv/overlay-express/dist/esm/src/OverlayExpress.js` to confirm `engine.broadcaster` is the `ArcadeProvider` itself, or a chain whose `broadcast` returns the provider's result. If it is a `ProviderChainBroadcaster` that converts failures, wrap the Arcade provider it holds instead and note where.

- [ ] **Step 4: Run and commit**

Run: `cd overlay && npx tsc --noEmit -p . && npx vitest run` → green.

```bash
git add overlay/src/arcadeParity.ts overlay/src/arcadeParity.test.ts overlay/src/index.ts
git commit -m "fix(overlay): accept non-terminal Arcade 2xx statuses on re-broadcast (Go parity)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Graceful lifecycle on `OverlayExpress.close()`

**Files:**
- Create: `overlay/src/shutdown.ts`, `overlay/src/shutdown.test.ts`
- Modify: `overlay/src/index.ts:94-103, 650-654`

**Interfaces:**
- Produces: `createShutdown(deps: { close: () => Promise<void>, exit: (code?: number) => void, log: (m: string, e?: unknown) => void, deadlineMs: number, setTimer?: (fn: () => void, ms: number) => { unref?: () => void } }): (signal: string) => Promise<void>` (idempotent).

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it, vi } from 'vitest'
import { createShutdown } from './shutdown.js'

describe('createShutdown', () => {
  it('closes once then exits 0, even when signalled twice', async () => {
    const close = vi.fn(async () => {}); const exit = vi.fn()
    const s = createShutdown({ close, exit, log: () => {}, deadlineMs: 25_000 })
    await Promise.all([s('SIGTERM'), s('SIGINT')])
    expect(close).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
  it('exits 1 when close throws', async () => {
    const exit = vi.fn()
    await createShutdown({ close: async () => { throw new Error('x') }, exit, log: () => {}, deadlineMs: 25_000 })('SIGTERM')
    expect(exit).toHaveBeenCalledWith(1)
  })
  it('arms a deadline that force-exits 1', async () => {
    let fire: () => void = () => {}
    const exit = vi.fn()
    const s = createShutdown({ close: () => new Promise(() => {}), exit, log: () => {}, deadlineMs: 5, setTimer: (fn) => { fire = fn; return {} } })
    void s('SIGTERM'); fire()
    expect(exit).toHaveBeenCalledWith(1)
  })
})
```

- [ ] **Step 2: Implement `shutdown.ts`**

```ts
export interface ShutdownDeps {
  close: () => Promise<void>
  exit: (code?: number) => void
  log: (message: string, err?: unknown) => void
  deadlineMs: number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
}

export const createShutdown = (deps: ShutdownDeps): ((signal: string) => Promise<void>) => {
  let running: Promise<void> | undefined
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  return async (signal: string) => {
    running ??= (async () => {
      deps.log(`[mandala] ${signal} received — draining`)
      setTimer(() => { deps.log('[mandala] shutdown deadline exceeded'); deps.exit(1) }, deps.deadlineMs).unref?.()
      try {
        await deps.close()
        deps.exit(0)
      } catch (e) {
        deps.log('[mandala] shutdown failed', e)
        deps.exit(1)
      }
    })()
    return await running
  }
}
```

- [ ] **Step 3: Wire into `index.ts`**

- Delete the second `MongoClient` (lines 98-100). Use `const lookupDb = server.mongoDb!` immediately after `await server.configureMongo(cfg.mongoUrl)`. Build `sharedStorage = new MandalaStorageManager(lookupDb)` and remove the separate `lookupDb = mongoClient.db(...)` line. First confirm in `node_modules/@bsv/overlay-express/dist/esm/src/OverlayExpress.js` that `configureMongo` sets `this.mongoDb` to the db named `${name}_lookup_services`. If not, keep the second client and register it for close inside the shutdown `close` callback.
- Replace the last line with two shutdown instances: one for signals (exit 0 on a clean close) and one for a failed startup (always exit 1).

```ts
let overlay: OverlayExpress | undefined   // assigned in main() right after construction
const log = (m: string, e?: unknown): void => { if (e == null) console.log(m); else console.error(m, e) }
const close = async (): Promise<void> => { await overlay?.close() }
const onSignal = createShutdown({ close, exit: (code) => process.exit(code), log, deadlineMs: 25_000 })
// A failed startup exits 1 whether or not the cleanup close succeeds.
const onStartupFailure = createShutdown({ close, exit: () => process.exit(1), log, deadlineMs: 10_000 })
process.once('SIGTERM', () => { void onSignal('SIGTERM') })
process.once('SIGINT', () => { void onSignal('SIGINT') })
main().catch((e) => { console.error(e); void onStartupFailure('startup-failure') })
```

  In `main()` set `overlay = server` right after `new OverlayExpress(...)`. Re-run the wiring test.

- [ ] **Step 4: Compose grace period**

In `overlay/docker-compose.yml` add `stop_grace_period: 30s` to the overlay service.

- [ ] **Step 5: Run and commit**

Run: `cd overlay && npx tsc --noEmit -p . && npx vitest run` → green.

```bash
git add overlay/src/shutdown.ts overlay/src/shutdown.test.ts overlay/src/index.ts overlay/docker-compose.yml
git commit -m "feat(overlay): graceful shutdown on OverlayExpress.close(); single Mongo client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Lib — never treat a transient overlay status as final

**Files:**
- Modify: `lib/src/overlay.ts:63-78, 124-131`
- Test: `lib/src/overlay.test.ts`

**Interfaces:**
- Produces: `OverlayRefusedError.retryable === true` for any HTTP 503 or 429, and for code `ERR_SERVER_BUSY`.

- [ ] **Step 1: Failing tests**

In `lib/src/overlay.test.ts`, using the existing fetch-mock pattern:
- `503 {status:'error', code:'ERR_SERVER_BUSY', retryable:false}` → `OverlayRefusedError` with `retryable === true`, `code === 'ERR_SERVER_BUSY'`;
- `429 {status:'error', code:'ERR_RATE', retryable:false}` → `retryable === true`;
- `400 {code:'ERR_CONSERVATION', retryable:false}` → `retryable === false` (unchanged).

Run: `cd lib && npx vitest run src/overlay.test.ts` → FAIL.

- [ ] **Step 2: Implement**

- Add `ERR_SERVER_BUSY: true` to `RETRYABLE_BY_CODE`.
- Change the `retryable` computation (~line 128) to `parsed.retryable === true || RETRYABLE_BY_CODE[code] === true || httpStatus === 503 || httpStatus === 429`. Keep whatever existing terms are there; this only widens to true.

- [ ] **Step 3: Run and commit**

Run: `cd lib && npx tsc --noEmit -p . && npx vitest run` → green.

```bash
git add lib/src/overlay.ts lib/src/overlay.test.ts
git commit -m "fix(lib): any 503/429 or ERR_SERVER_BUSY from the overlay is retryable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Go overlay bump

**Files:**
- Modify: `overlay-go/go.mod`, `overlay-go/go.sum`, `overlay-go/Dockerfile:3`
- Create: `overlay-go/internal/wiring/script_rules_test.go`
- Modify: `overlay-go/internal/enginestore/enginestore_test.go` (add one test)
- Modify: stale `v1.3.2` comments in `internal/arcade/broadcaster.go:45`, `internal/mandala/lookup_service.go:356`, `internal/mandala/topic_manager.go:378`, `internal/enginestore/enginestore.go:2,3,35,551`, `internal/enginestore/enginestore_test.go:3`, `internal/httpapi/submit.go:59`, `internal/httpapi/arcingest.go:37`, `internal/wiring/engine.go:81,363`, `internal/wiring/engine_test.go:239,307,356`

**Interfaces:** none (no API change).

- [ ] **Step 1: Bump**

```bash
cd overlay-go && go get github.com/bsv-blockchain/go-overlay-services@v1.3.7 github.com/bsv-blockchain/go-sdk@v1.7.1 && go mod edit -go=1.26.0 && go mod tidy && go build ./... && go vet ./...
```

Expected: success. Then set `overlay-go/Dockerfile:3` to `FROM golang:1.26 AS builder`.

- [ ] **Step 2: Run the existing tests**

Run: `cd overlay-go && go test ./...` (Mongo at localhost:27017 for the Mongo-gated packages: `docker compose -f ../overlay/docker-compose.yml up -d mongo` first).
Expected: PASS. Any failure here is a real upstream break: stop and diagnose (systematic-debugging) before continuing.

- [ ] **Step 3: Pin the after-Chronicle script rules (failing first)**

Create `overlay-go/internal/wiring/script_rules_test.go`:

```go
package wiring

// go-sdk v1.6.0+ spv.Verify runs scripts under after-Chronicle rules for EVERY
// tx version. The TS SDK gates Chronicle on transactionVersion > 1. These
// tests pin Go's behaviour on the exact verify path the engine uses so a
// future go-sdk change is noticed, and document the v1 divergence.

import (
	"context"
	"testing"

	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/spv"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

// OP_1 OP_2MUL OP_2 OP_EQUAL — valid only once OP_2MUL is re-enabled (Chronicle).
func chronicleOnlyLock(t *testing.T) *script.Script {
	t.Helper()
	s := &script.Script{}
	if err := s.AppendOpcodes(script.Op1, script.Op2MUL, script.Op2, script.OpEQUAL); err != nil {
		t.Fatal(err)
	}
	return s
}

func chronicleSpend(t *testing.T, version uint32) (*transaction.Transaction, *transaction.TransactionOutput) {
	t.Helper()
	src := transaction.NewTransaction()
	src.Version = version
	src.AddOutput(&transaction.TransactionOutput{Satoshis: 1000, LockingScript: chronicleOnlyLock(t)})
	srcID := src.TxID()
	src.MerklePath = transaction.NewMerklePath(1, [][]*transaction.PathElement{{{Offset: 0, Hash: srcID, Txid: boolPtr(true)}}})

	child := transaction.NewTransaction()
	child.Version = version
	child.AddInput(&transaction.TransactionInput{
		SourceTXID: srcID, SourceTxOutIndex: 0, SourceTransaction: src,
		UnlockingScript: &script.Script{}, SequenceNumber: 0xffffffff,
	})
	child.AddOutput(&transaction.TransactionOutput{Satoshis: 900, LockingScript: chronicleOnlyLock(t)})
	return child, src.Outputs[0]
}

func boolPtr(b bool) *bool { return &b }

func TestSPVVerifyAppliesAfterChronicleToV2(t *testing.T) {
	child, _ := chronicleSpend(t, 2)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("v2 OP_2MUL spend must verify under after-Chronicle rules: ok=%v err=%v", ok, err)
	}
}

// Documented divergence: Go also accepts it for a v1 tx; TS (@bsv/sdk Spend) rejects it.
func TestSPVVerifyAppliesAfterChronicleToV1(t *testing.T) {
	child, _ := chronicleSpend(t, 1)
	ok, err := spv.Verify(context.Background(), child, scriptsOnlyTracker{}, nil)
	if err != nil || !ok {
		t.Fatalf("go-sdk v1.7.1 verifies v1 txs under after-Chronicle rules too: ok=%v err=%v", ok, err)
	}
}

func TestPreChronicleInterpreterRejectsSameSpend(t *testing.T) {
	child, prevOut := chronicleSpend(t, 2)
	err := interpreter.NewEngine().Execute(
		interpreter.WithTx(child, 0, prevOut), interpreter.WithForkID(), interpreter.WithAfterGenesis())
	if err == nil {
		t.Fatal("pre-Chronicle (after-Genesis only) flags must reject OP_2MUL")
	}
}
```

Before running, resolve the exact go-sdk v1.7.1 identifiers in `$(go env GOMODCACHE)/github.com/bsv-blockchain/go-sdk@v1.7.1`:
- `transaction.NewMerklePath` / `PathElement` field names (`Offset`, `Hash`, `Txid`);
- `script.Op2MUL` naming;
- `TransactionInput` field names (`SourceTXID`, `SourceTxOutIndex`);
- `interpreter.WithTx` arity.

Adjust the test to the real names; do not change the assertions.

Run: `go test ./internal/wiring -run 'Chronicle' -v` → PASS. These are pin tests of upstream behaviour. Prove they bite by temporarily replacing `chronicleOnlyLock`'s `Op2MUL` with `Op2DIV`-free garbage (`OP_RETURN`): the first two tests must fail. Then revert.

- [ ] **Step 4: Pin that our store does not opt into admission storage**

Append to `overlay-go/internal/enginestore/enginestore_test.go`:

```go
// go-overlay-services v1.3.7 switches Submit to the broadcast-first admission
// path when the storage exposes AdmissionStorage(). Our compensation seam and
// EvictTx assume the default path, so the store must not advertise it.
func TestStoreDoesNotAdvertiseAdmissionStorage(t *testing.T) {
	db := requireMongoDB(t) // use this file's existing Mongo helper name
	es, err := New(db)
	if err != nil { t.Fatal(err) }
	if engine.GetAdmissionStorage(es) != nil {
		t.Fatal("enginestore.Store must not implement admission storage (wiring/engine.go compensation assumes the default Submit path)")
	}
}
```

Use the file's actual Mongo helper and the `engine` import path `github.com/bsv-blockchain/go-overlay-services/pkg/core/engine`. If `GetAdmissionStorage` takes the storage interface by a different name, match its v1.3.7 signature.

Run: `go test ./internal/enginestore -run AdmissionStorage -v` → PASS.

- [ ] **Step 5: Stale comments, full run, commit**

Update every `v1.3.2` comment listed under **Files** to `v1.3.7`. Where the comment explains the ordering bug, also note "(still present in v1.3.7: Submit marks spends before broadcast; ErrorOnBroadcastFailure unread)".

Run: `cd overlay-go && go build ./... && go vet ./... && go test ./...` → green. Then `docker build -t mandala-overlay-go:p0 overlay-go` → success.

```bash
git add overlay-go/
git commit -m "build(overlay-go): go-overlay-services v1.3.7, go-sdk v1.7.1, Go 1.26; pin after-Chronicle verify + default submit path

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and runbook

**Files:**
- Modify: `README.md` (L12-13, L45, L75, L286-290, L310), `runbook.md` (L78, L111-115, L282-290), `docs/PROJECT-STATE.md` (L31-32, L563, L639, L644, L697-698, L742-743), `overlay-go/README.md` (L21-37 and the `v1.3.2` mentions at L49, 60, 75, 99, 145, 182, 201-204, 248, 258, 288)
- Modify: `docs/superpowers/specs/2026-10-01-mandala-brc162-design.md` (§7.1 and §10)
- Modify: `docs/design/2026-09-15-mandala-wire-contract-v2.md` (append amendment v2.3)
- Modify: `docs/superpowers/specs/2026-07-07-go-overlay-port-appendix-b-wire-contract.md:52` (note)

- [ ] **Step 1: Version and command updates**

- Versions everywhere:
  - TS: `@bsv/sdk v2.8.11`, `@bsv/overlay v2.6.2`, `@bsv/overlay-express v2.7.3`, `@bsv/overlay-topics v1.6.0`, `@bsv/templates v1.9.0`; "Requires Node 24".
  - Go: go-overlay-services v1.3.7, go-sdk v1.7.1, Go 1.26.
- `curl …/api/v1/info` (README L75, L310) → `curl …/health`.
- runbook:
  - delete the L113 double-scheme warning and the L115 `INSERT OR IGNORE` note;
  - add "Before first boot on 2.6.2 with an existing sqlite: the topical-uniqueness migration aborts on duplicates. Mandala has no users, so wipe `overlay-data` / `/tmp/mandala-overlay.sqlite`";
  - add the `npm rebuild sqlite3 --foreground-scripts` note for npm ≥12;
  - add "Go bump reaches flux only via a new `v*` tag (user-pushed)".

- [ ] **Step 2: Spec deviations**

In the design spec §7.1:
- Replace the "adopt `logger.ts`, `configureHealth`" bullet with: "Skipped: pino logger, OTel telemetry, `configureHealth` contextProvider (2.7.3 hides details by default; exposing them is public). Adopted instead: explicit `throwOnBroadcastFailure`, graceful `close()` shutdown, ≥32-byte secrets with constant-time compare, https advertisable host, advertiser disabled, edge-policy-aware `/submit` wrapper, Arcade status parity."
- Record that the in-flight hold (§9.7 503) is removed on TS because 2.6.2 serializes submits, and that a CAS conflict now surfaces as `503 ERR_UNAVAILABLE`.

In §10 change "double-spend e2e checks the CAS error maps to the conflicting-spend path" to "maps to `503 ERR_UNAVAILABLE`, and the retry converges on `400 ERR_INPUT_SPENT`".

- [ ] **Step 3: Wire contract amendment v2.3**

Append to `docs/design/2026-09-15-mandala-wire-contract-v2.md`:

```markdown
## 11. Amendment v2.3 (2026-10-01) — upstream re-base (BRC-162 P0)

11.1 TS overlay on @bsv/overlay ≥2.6: submits are serialized per process, so §9.7's in-flight 503 is no longer emitted by TS (a concurrent submit waits, then receives the guard's authoritative answer). Go is unchanged.
11.2 Both engines: the spent-input guard inspects every input. A coin left spent by an interrupted attempt of the same txid, or by an evicted competitor, is released and answered `503 ERR_UNAVAILABLE` (retryable). The retry converges.
11.3 Edge refusals (TS): `ERR_SERVER_BUSY` maps to `503 ERR_UNAVAILABLE`; body-limit refusals map to `400 ERR_SHAPE` (never persisted). Clients treat any 503/429 as retryable.
11.4 A non-terminal Arcade 2xx status counts as a successful broadcast on both engines.
11.5 Upstream error messages are masked by overlay-express 2.7.3 ("Request could not be processed"); only `description` text is affected, never codes.
```

Decide 11.2's Go scope from code, not by assumption. Read go-overlay-services v1.3.7 `pkg/core/engine/engine.go`: how does it build previous coins for a topic, and does it filter spent outputs? Then read our `noConflictingSpend` (`overlay-go/internal/mandala/topic_manager.go:450`) and the compensation seam (`internal/wiring/engine.go`, which unmarks spends on a failed Submit).
- If v1.3.7 **filters** spent coins (the same change as TS 2.6), port Task 2's guard to Go now:
  - the two heal cases, using `infraError` with the descriptions byte-identical to `SELF_HEAL_DESCRIPTION` / `EVICTED_HEAL_DESCRIPTION`;
  - every input inspected;
  - Go tests mirroring Task 2 Step 7.
- If it **does not** filter (Go's guard still sees spent coins and the seam already unmarks on failure), write 11.2 as "TS only (Go's engine still passes spent coins to the guard and its compensation seam unmarks interrupted spends)".

Either way, state the finding in the commit message.

- [ ] **Step 4: Commit**

```bash
git add README.md runbook.md docs/ overlay-go/README.md overlay-go/internal
git commit -m "docs: P0 upstream re-base — versions, runbook, spec deviations, wire contract v2.3

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end verification

**Files:** none (verification only; fix forward in the owning task's files if anything fails).

- [ ] **Step 1: Clean installs + suites**

```bash
cd overlay && rm -rf node_modules dist && npm ci && node -e "require('sqlite3')" && npx tsc --noEmit -p . && npx vitest run
cd ../lib && npx vitest run
cd ../overlay-go && go build ./... && go vet ./... && go test ./...
```

Expected: all green. Record the test counts.

- [ ] **Step 2: Images**

```bash
docker build -t mandala-overlay:p0 overlay && docker build -t mandala-overlay-go:p0 overlay-go
```

Expected: both build. The TS build log must not contain `migration patched`.

- [ ] **Step 3: Boot smoke (local, no Arcade)**

With `overlay/.env` = `.env.example` defaults (`HOSTING_URL=http://localhost:8080`, no `ARCADE_URL`):
- run `docker compose -f overlay/docker-compose.yml up -d mongo`;
- run the TS overlay with `cd overlay && npm run build && node dist/index.js`, in a terminal tab via `run_in_terminal` or a background Bash, not a foreground sleep.

Verify:
- `curl -s localhost:8080/health/live` → 200;
- `curl -s localhost:8080/health/ready` → 200;
- the log shows no advertiser init and no babbage calls;
- `curl -s -X POST localhost:8080/submit -H 'x-topics: ["tm_mandala"]' --data-binary @/dev/null` → a JSON error body with `code` (not an HTML 404);
- `curl -s -X POST localhost:8080//submit …` → the same shape (σI wrapper not bypassed).

Then send SIGTERM and confirm exit code 0 within 25 s.

- [ ] **Step 4: Boot-refusal smoke**

`ARCADE_URL=https://arcade.example.com node dist/index.js` (no token) → exits non-zero with `ARCADE_CALLBACK_TOKEN is required when ARCADE_URL is set`.

- [ ] **Step 5: Whole-branch review**

Dispatch the final reviewer (superpowers:requesting-code-review) over `git diff master...feat/brc162 -- overlay overlay-go lib docs`, with the Review Focus list above as the checklist. Fix confirmed findings in the owning files and re-run Step 1.

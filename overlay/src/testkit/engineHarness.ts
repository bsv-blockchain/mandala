import { Engine, KnexStorage, KnexStorageMigrations, type LookupService, type TopicManager } from '@bsv/overlay'
import { MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import knexFactory from 'knex'
import { withSpentInputGuard, knexSpentInputStore } from '../spentGuard.js'

export const HARNESS_TOPIC = 'tm_harness'

export interface SubmitOutcome { steak?: unknown, error?: unknown, refusal?: unknown }

export interface HarnessOptions {
  wasEvicted?: (txid: string) => Promise<boolean>
  /**
   * Wraps the guarded manager the way index.ts wraps tm_mandala's (e.g. in
   * withVerdictCapture), so a test can drive the production stack's outer
   * layers over the real engine. Receives the harness knex.
   */
  wrap?: (guarded: TopicManager, knex: any) => TopicManager
  /** Lookup services the engine notifies (none by default). */
  lookupServices?: Record<string, LookupService>
  /**
   * Registers these named managers INSTEAD of the admit-all `tm_harness` stack
   * (no spent guard or `wrap` is applied; the caller builds its own stack over
   * the harness knex). Each is still wrapped in the refusal recorder.
   */
  topicManagers?: (knex: any) => Record<string, TopicManager>
  /** The topics `submit` tags (default `[tm_harness]`). */
  topics?: string[]
}

export const createHarness = async (opts: HarnessOptions = {}) => {
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
  const spendGuarded = withSpentInputGuard(admitAll as any,
    knexSpentInputStore(knex, HARNESS_TOPIC, opts.wasEvicted ?? (async () => false)))
  const guarded = opts.wrap != null ? opts.wrap(spendGuarded, knex) : spendGuarded
  // Outermost recorder: the engine swallows manager throws, so capture them here.
  const record = (inner: TopicManager): TopicManager => new Proxy(inner, {
    get: (target, prop, receiver) => prop === 'identifyAdmissibleOutputs'
      ? async (...args: any[]) => {
        try { return await (target.identifyAdmissibleOutputs as any)(...args) } catch (e) { refusals.push(e); throw e }
      }
      : Reflect.get(target, prop, receiver)
  })
  const managers: Record<string, TopicManager> = opts.topicManagers != null
    ? Object.fromEntries(Object.entries(opts.topicManagers(knex)).map(([topic, tm]) => [topic, record(tm)]))
    : { [HARNESS_TOPIC]: record(guarded) }
  const topics = opts.topics ?? [HARNESS_TOPIC]
  const engine = new (Engine as any)(managers, opts.lookupServices ?? {}, storage, 'scripts only',
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
  /** `offChainValues` is the engine's 4th positional argument (not a tagged-BEEF field). */
  const submit = async (tx: Transaction, offChainValues?: number[]): Promise<SubmitOutcome> => {
    const before = refusals.length
    try {
      const steak = await engine.submit({ beef: tx.toBEEF(), topics }, undefined, 'current-tx', offChainValues)
      return { steak, refusal: refusals[before] }
    } catch (error) {
      return { error, refusal: refusals[before] }
    }
  }
  return { engine, storage, knex, key, lock, root, spend, submit, refusals, close: async () => { await knex.destroy() } }
}
export type Harness = Awaited<ReturnType<typeof createHarness>>

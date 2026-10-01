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

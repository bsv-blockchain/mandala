/**
 * FIX E's token-row restore against the REAL lookup store: MandalaStorageManager
 * on a local Mongo, with the unique (txid, outputIndex) index on mandalaTokens
 * that production has. Every other eviction test fakes `restoreTokenRow`, which
 * is how a plain insertOne (E11000 on any re-delivery that finds a row already
 * restored) survived: the retry §9.8 promises converges only if the restore is
 * an idempotent upsert, and the holder's balance is re-credited exactly once.
 *
 * Skipped when no Mongo is reachable on localhost:27017 (overlay-go's pattern).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MandalaStorageManager } from '@bsv/overlay-topics'
import { arcIngestHandler, evictWithRestore, mongoRestoreTokenRow, type EvictionDeps } from './eviction.js'
import type { AdmissionRecord, AdmissionStore } from './admission.js'
import type { AdmissionTokenRow } from './submitSideChannel.js'
import { connectTestMongo, mongoAvailable, type TestMongo } from './testkit/mongo.js'

const T = 'aa'.repeat(32)
const X = 'bb'.repeat(32)
const Y = 'cc'.repeat(32)
const HOLDER = '02' + 'dd'.repeat(32)

const row = (txid: string, amount: number): AdmissionTokenRow => ({
  txid, outputIndex: 0, assetId: `${'ee'.repeat(32)}.0`, amount, identityKey: HOLDER, createdAt: '2026-10-01T00:00:00.000Z'
})

const up = await mongoAvailable()

describe.skipIf(!up)('FIX E token-row restore on the real lookup store (Mongo)', () => {
  let mongo: TestMongo
  const extraDbs: Array<{ dropDatabase: () => Promise<unknown> }> = []

  beforeAll(async () => {
    mongo = (await connectTestMongo('token_restore'))!
  })
  afterAll(async () => {
    for (const db of extraDbs) await db.dropDatabase().catch(() => {})
    await mongo?.close()
  })

  /**
   * A fresh lookup store holding the state an admitted T leaves behind: X and Y
   * were the holder's coins (rows stored, balance credited), then T spent both
   * (rows deleted, balance debited — MandalaLookupService.outputSpent).
   */
  const spentByT = async (name: string): Promise<{ storage: MandalaStorageManager, tokens: any }> => {
    const db = mongo.db.client.db(`${mongo.db.databaseName}_${name}`)
    extraDbs.push(db)
    const storage = new MandalaStorageManager(db)
    // Production's indexes, the unique (txid, outputIndex) one included — the
    // index a plain-insert restore collides with on a re-delivery.
    await (storage as unknown as { ensureIndexes: () => Promise<void> }).ensureIndexes()
    const indexes = await db.collection('mandalaTokens').indexes()
    expect(indexes.some(ix => ix.unique === true && JSON.stringify(ix.key) === '{"txid":1,"outputIndex":1}')).toBe(true)
    for (const r of [row(X, 5), row(Y, 7)]) {
      await storage.storeToken({ ...r, createdAt: new Date(r.createdAt!) })
      await storage.adjustBalance(HOLDER, r.amount)
    }
    for (const r of [row(X, 5), row(Y, 7)]) {
      await storage.adjustBalance(HOLDER, -r.amount)
      await storage.deleteToken(r.txid, r.outputIndex)
    }
    return { storage, tokens: db.collection('mandalaTokens') }
  }

  /** evictWithRestore deps around one admission record and an in-memory engine spend map. */
  const harness = (restore: (r: AdmissionTokenRow) => Promise<void>, spent: Map<string, string>) => {
    const rec: AdmissionRecord = {
      txid: T, outputsToAdmit: [0],
      restore: { spentOutpoints: [`${X}.0`, `${Y}.0`], tokenRows: [row(X, 5), row(Y, 7)] }
    }
    const evicted: string[] = []
    const store: AdmissionStore = {
      get: async () => rec,
      putAdmitted: async () => {},
      putRefusal: async () => {},
      markEvicted: async (_txid, at) => { rec.evictedAt = at }
    }
    const deps: EvictionDeps = {
      store,
      unmarkSpent: async (txid, vout, ev) => {
        const k = `${txid}.${vout}`
        if (spent.get(k) !== ev) return 0
        spent.delete(k)
        return 1
      },
      isUnspent: async (txid, vout) => !spent.has(`${txid}.${vout}`),
      restoreTokenRow: restore,
      evict: async (txid) => { evicted.push(txid); return {} },
      assetsTouchedBy: async () => [],
      rebuildAssetStateExcluding: async () => {},
      purgeAdminHistory: async () => {}
    }
    return { rec, deps, evicted }
  }

  it('a re-delivery after a restore that failed half-way converges: 200, evictedAt stamped, evict called, each row and credit once', async () => {
    const { storage, tokens } = await spentByT('redeliver')
    const prod = mongoRestoreTokenRow(tokens, async (k, d) => { await storage.adjustBalance(k, d) })
    let failY = true
    const { rec, deps, evicted } = harness(async (r) => {
      if (failY && r.txid === Y) throw new Error('simulated Mongo blip on the second row')
      await prod(r)
    }, new Map([[`${X}.0`, T], [`${Y}.0`, T]]))

    // Over the /arc-ingest handler itself, so the status codes are pinned.
    const TOKEN = 'k'.repeat(32)
    const handler = arcIngestHandler({ ...deps, callbackToken: TOKEN, ingestProof: async () => {} })
    const deliver = async (): Promise<{ status: number, body: any }> => await new Promise(resolve => {
      let status = 200
      const res: any = {
        status (n: number) { status = n; return res },
        json (b: unknown) { resolve({ status, body: b }); return res }
      }
      handler({ headers: { 'x-callback-token': TOKEN }, body: { txid: T, txStatus: 'REJECTED' } }, res)
    })

    // Delivery 1: X's row is restored, Y's fails — nothing stamped, nothing evicted.
    const first = await deliver()
    expect(first.status).toBe(503)
    expect(first.body.code).toBe('ERR_UNAVAILABLE')
    expect(rec.evictedAt).toBeUndefined()
    expect(evicted).toEqual([])
    expect(await storage.getTokenRow(X, 0)).not.toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(5)

    // Delivery 2: X's row is already there — that must not be an error.
    failY = false
    const second = await deliver()
    expect(second.status).toBe(200)
    expect(second.body.data).toMatchObject({ restoredOutpoints: 0, restoredTokenRows: 2, alreadyEvicted: false })
    expect(rec.evictedAt).toBeDefined()
    expect(evicted).toEqual([T])
    expect(await tokens.countDocuments({ txid: X, outputIndex: 0 })).toBe(1)
    expect(await tokens.countDocuments({ txid: Y, outputIndex: 0 })).toBe(1)
    // Credited exactly once per restored row: 5 + 7.
    expect(await storage.getBalance(HOLDER)).toBe(12)

    // Delivery 3 (Arcade repeats itself): alreadyEvicted, nothing re-credited.
    const third = await evictWithRestore(T, 'REJECTED', deps)
    expect(third.alreadyEvicted).toBe(true)
    expect(await storage.getBalance(HOLDER)).toBe(12)
  })

  it('a row the crashed attempt never deleted is left alone and not re-credited (the first delivery does not wedge)', async () => {
    const { storage, tokens } = await spentByT('neverdeleted')
    // Phase 3 died after marking X but before reaching Y: Y is still unspent,
    // its row and its credit are still in place.
    await storage.storeToken({ ...row(Y, 7), createdAt: new Date() })
    await storage.adjustBalance(HOLDER, 7)
    const prod = mongoRestoreTokenRow(tokens, async (k, d) => { await storage.adjustBalance(k, d) })
    const { rec, deps, evicted } = harness(prod, new Map([[`${X}.0`, T]]))

    const report = await evictWithRestore(T, 'REJECTED', deps)
    expect(report.restoredOutpoints).toBe(1)
    expect(rec.evictedAt).toBeDefined()
    expect(evicted).toEqual([T])
    expect(await tokens.countDocuments({ txid: Y, outputIndex: 0 })).toBe(1)
    // X re-credited (5), Y not touched (its 7 was never debited).
    expect(await storage.getBalance(HOLDER)).toBe(12)
  })

  it('restores the snapshot row verbatim, createdAt as a Date', async () => {
    const { storage, tokens } = await spentByT('verbatim')
    const prod = mongoRestoreTokenRow(tokens, async (k, d) => { await storage.adjustBalance(k, d) })
    await prod(row(X, 5))
    const got = await storage.getTokenRow(X, 0)
    expect(got).toMatchObject({ txid: X, outputIndex: 0, assetId: row(X, 5).assetId, amount: 5, identityKey: HOLDER })
    expect(got?.createdAt).toBeInstanceOf(Date)
    expect((got?.createdAt as Date).toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('a row with no identity key is restored without touching any balance', async () => {
    const { storage, tokens } = await spentByT('nokey')
    const credits: Array<[string, number]> = []
    const prod = mongoRestoreTokenRow(tokens, async (k, d) => { credits.push([k, d]) })
    await prod({ ...row(X, 5), identityKey: '' })
    expect(await storage.getTokenRow(X, 0)).not.toBeNull()
    expect(credits).toEqual([])
  })
})

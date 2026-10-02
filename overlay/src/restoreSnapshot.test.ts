/**
 * The FIX E restore snapshot (§9.4) must only ever GROW.
 *
 * The provisional record is written before every attempt of a txid, and the
 * admitting attempt writes it again on the way out. Replacing the snapshot on
 * each write could drop an input an earlier attempt named (the crash-window
 * self-heal makes three attempts, and a refused-then-admitted txid starts with
 * an early empty snapshot). So every write merges: the union of
 * `spentOutpoints`, first-seen order kept. Owners are not snapshotted; they
 * come from the package's owner journal at eviction time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mongoAdmissionStore } from './admissionStore.js'
import { connectTestMongo, mongoAvailable, type TestMongo } from './testkit/mongo.js'

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)

const up = await mongoAvailable()

describe.skipIf(!up)('mongoAdmissionStore — the restore snapshot only grows (Mongo)', () => {
  let mongo: TestMongo
  beforeAll(async () => { mongo = (await connectTestMongo('admission_store'))! })
  afterAll(async () => { await mongo?.close() })

  it('putPending and putAdmitted merge into the stored snapshot instead of replacing it', async () => {
    const store = mongoAdmissionStore(mongo.db.collection('merge_case'))
    const at = '2026-10-01T00:00:00.000Z'
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.0`] } })
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [] } })
    await store.putAdmitted({
      txid: A, topics: ['tm_mandala'], outputsToAdmit: [0], admissionSignature: 's', admissionIdentityKey: 'k', at,
      restore: { spentOutpoints: [`${B}.1`] }
    })
    const rec = await store.get(A)
    expect(rec?.restore).toEqual({ spentOutpoints: [`${B}.0`, `${B}.1`] })
    expect(rec?.pending).toBe(false)
  })

  it('refused-then-admitted: the later, non-empty snapshot lands on a record that started empty', async () => {
    const store = mongoAdmissionStore(mongo.db.collection('refused_case'))
    const at = '2026-10-01T00:00:00.000Z'
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [] } })
    await store.putRefusal({ txid: A, refusedCode: 'ERR_LINKAGE', refusedDescription: 'x', refusedAt: at, refusedPayloadHash: 'h' })
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.0`] } })
    expect((await store.get(A))?.restore).toEqual({ spentOutpoints: [`${B}.0`] })
  })

  it('a provisional write with no snapshot (the snapshot read failed) leaves the stored one alone', async () => {
    const store = mongoAdmissionStore(mongo.db.collection('nosnap_case'))
    const at = '2026-10-01T00:00:00.000Z'
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.0`] } })
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at })
    expect((await store.get(A))?.restore).toEqual({ spentOutpoints: [`${B}.0`] })
  })

  it('a legacy stored snapshot with tokenRows is rewritten without them on the next merge', async () => {
    const col = mongo.db.collection('legacy_case')
    const at = '2026-10-01T00:00:00.000Z'
    await col.insertOne({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.0`], tokenRows: [{ txid: B, outputIndex: 0 }] } })
    const store = mongoAdmissionStore(col)
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.1`] } })
    expect((await store.get(A))?.restore).toEqual({ spentOutpoints: [`${B}.0`, `${B}.1`] })
  })
})

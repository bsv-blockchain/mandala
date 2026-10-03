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
import { MandalaStorageManager, MandalaLookupService } from '@bsv/overlay-topics'
import { MerklePath, P2PKH, ProtoWallet, Transaction } from '@bsv/sdk'
import { mongoAdmissionStore } from './admissionStore.js'
import { snapshotRestore } from './submitSideChannel.js'
import { evictWithRestore, journalRestoreInput, knexEvictionCoins, lookupRetireOutputs, mongoIndexedVouts } from './eviction.js'
import { createHarness, HARNESS_TOPIC, type Harness } from './testkit/engineHarness.js'
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

// Review Focus 3, end to end: eviction of a tx whose inputs were a value coin
// and an AUTHORITY coin, through the real package storage, lookup service and
// owner journal, over the real engine.
describe.skipIf(!up)('eviction restores value and authority inputs from the owner journal (real storage)', () => {
  let mongo: TestMongo
  let h: Harness | undefined
  beforeAll(async () => { mongo = (await connectTestMongo('journal_evict'))! })
  afterAll(async () => { await h?.close(); await mongo?.close() })

  it('restores each live input once, never a coin another tx spent, and a repeat does not double-credit', async () => {
    const TM = 'tm_mandala'
    const HOLDER = '02' + 'dd'.repeat(32)
    const TOKEN = 'ee'.repeat(32) + '_0'
    const storage = new MandalaStorageManager(mongo.db)
    const lookup = new MandalaLookupService({ storage, verifierWallet: new ProtoWallet('anyone') as any })
    const admissions = mongoAdmissionStore(mongo.db.collection('mandalaAdmissions'))
    h = await createHarness()

    // r: value 1000 (r.0), authority (r.1), value 500 (r.2).
    const r = new Transaction(1, [], [
      { lockingScript: h.lock, satoshis: 1000 }, { lockingScript: h.lock, satoshis: 1 }, { lockingScript: h.lock, satoshis: 500 }
    ], 0)
    r.merklePath = new MerklePath(1, [[{ offset: 0, hash: r.id('hex'), txid: true }]])
    const R = r.id('hex')
    const createdAt = new Date()
    await storage.recordOwners([
      { txid: R, outputIndex: 0, topic: TM, tokenId: TOKEN, role: 'value', amount: 1000, identityKey: HOLDER, createdAt },
      { txid: R, outputIndex: 1, topic: TM, tokenId: TOKEN, role: 'authority', amount: 0, identityKey: HOLDER, createdAt },
      { txid: R, outputIndex: 2, topic: TM, tokenId: TOKEN, role: 'value', amount: 500, identityKey: HOLDER, createdAt }
    ])
    await storage.storeTokenIfAbsent({ txid: R, outputIndex: 0, tokenId: TOKEN, amount: 1000, identityKey: HOLDER, createdAt })
    await storage.storeAuthorityIfAbsent({ txid: R, outputIndex: 1, topic: TM, tokenId: TOKEN, identityKey: HOLDER, createdAt })
    await storage.storeTokenIfAbsent({ txid: R, outputIndex: 2, tokenId: TOKEN, amount: 500, identityKey: HOLDER, createdAt })
    await storage.adjustBalance(HOLDER, 1500)
    expect((await h.submit(r)).refusal).toBeUndefined()

    // A spends all three coins; the lookup's outputSpent effect: rows gone, balance debited.
    const a = new Transaction(1, [0, 1, 2].map(vout => ({
      sourceTransaction: r, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(h!.key), sequence: 0xffffffff
    })), [{ lockingScript: h.lock, satoshis: 400 }], 0)
    await a.sign()
    expect((await h.submit(a)).refusal).toBeUndefined()
    const A = a.id('hex')
    for (const vout of [0, 2]) {
      const row = await storage.takeToken(R, vout)
      await storage.adjustBalance(row!.identityKey, -row!.amount)
    }
    await storage.takeAuthority(R, 1)
    expect(await storage.getBalance(HOLDER)).toBe(0)

    // Another tx takes r.2 from A (A's own spend released it first), then A is evicted.
    const coins = knexEvictionCoins(h.knex, HARNESS_TOPIC)
    expect(await coins.unmarkSpent(R, 2, A)).toBe(1)
    const b = await h.spend(300, r, 2)
    expect((await h.submit(b)).refusal).toBeUndefined()

    // F4 — A's OWN output row, as the lookup indexed it at admission (under a
    // separate holder with its own credit). The harness engine has no lookup
    // service, so its eviction leaves the row behind exactly as a swallowed
    // outputEvicted failure would.
    const PAYEE = '03' + 'ab'.repeat(32)
    await storage.storeTokenIfAbsent({ txid: A, outputIndex: 0, tokenId: TOKEN, amount: 400, identityKey: PAYEE, createdAt })
    await storage.adjustBalance(PAYEE, 400)

    await admissions.putAdmitted({
      txid: A, topics: [HARNESS_TOPIC], outputsToAdmit: [0], admissionSignature: 's', admissionIdentityKey: 'k',
      at: new Date().toISOString(), restore: snapshotRestore(a)
    })
    const deps = {
      store: admissions,
      ...coins,
      restoreInput: journalRestoreInput(
        async (t, v, topic) => await storage.getOwnerJournal(t, v, topic),
        async (j) => await lookup.restoreInputRow(j),
        TM
      ),
      evict: async (txid: string, reason?: string) => await h!.engine.evictAppliedTransaction(txid, { reason }),
      retireOutputs: lookupRetireOutputs(mongoIndexedVouts(mongo.db), async (t, v) => await lookup.outputEvicted(t, v)),
      purgeAndRefold: async (txid: string) => await lookup.purgeAndRefold(txid)
    }
    const report = await evictWithRestore(A, 'REJECTED', deps)
    expect(report).toMatchObject({ restoredOutpoints: 2, restoredTokenRows: 2, alreadyEvicted: false, retiredRows: 1 })
    // The evicted tx's own row is gone and its credit debited exactly once.
    expect(await storage.getTokenRow(A, 0)).toBeNull()
    expect(await storage.getBalance(PAYEE)).toBe(0)
    expect(await storage.getTokenRow(R, 0)).toMatchObject({ amount: 1000, identityKey: HOLDER })
    expect(await storage.getAuthorityRow(R, 1)).toMatchObject({ tokenId: TOKEN, identityKey: HOLDER })
    expect(await storage.getTokenRow(R, 2)).toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(1000)

    // A repeat callback restores nothing again and credits nothing again.
    const again = await evictWithRestore(A, 'REJECTED', deps)
    expect(again).toMatchObject({ restoredTokenRows: 0, alreadyEvicted: true, retiredRows: 0 })
    expect(await storage.getBalance(HOLDER)).toBe(1000)
    expect(await storage.getBalance(PAYEE)).toBe(0)
    expect(await storage.getTokenRow(A, 0)).toBeNull()
    expect(await storage.getTokenRow(R, 2)).toBeNull()
  })
})

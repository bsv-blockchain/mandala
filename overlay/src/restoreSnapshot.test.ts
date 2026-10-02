/**
 * The FIX E restore snapshot (§9.4) must only ever GROW.
 *
 * The provisional record is written before every attempt of a txid, and the
 * admitting attempt writes it again on the way out. A crash-window self-heal
 * makes three attempts: the first marks the input spent and the lookup deletes
 * its token row before phase 3 dies; the heal round and the admitting round
 * then snapshot an input whose row is already gone. Replacing the snapshot on
 * each write therefore ended with `{spentOutpoints:[X], tokenRows:[]}` — and an
 * eviction of that tx unmarked X but had no row to put back: a live coin with
 * no token row, the holder's balance still debited.
 *
 * So every write merges: the union of `spentOutpoints`, and the union of
 * `tokenRows` keyed by outpoint with the first-seen row kept. A write never
 * replaces, which also keeps refused-then-admitted right (an early empty
 * snapshot is merged into, not frozen in).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MandalaStorageManager } from '@bsv/overlay-topics'
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { TopicManager } from '@bsv/overlay'
import {
  mergeRestore, snapshotRestoreFrom, withVerdictCapture, SubmitSideChannel,
  type AdmissionRestore, type AdmissionTokenRow
} from './submitSideChannel.js'
import { mongoAdmissionStore } from './admissionStore.js'
import { evictWithRestore, knexEvictionCoins, mongoRestoreTokenRow } from './eviction.js'
import { createHarness, HARNESS_TOPIC, type Harness } from './testkit/engineHarness.js'
import { connectTestMongo, mongoAvailable, type TestMongo } from './testkit/mongo.js'

const A = 'aa'.repeat(32)
const B = 'bb'.repeat(32)
const C = 'cc'.repeat(32)
const row = (txid: string, vout: number, amount: number): AdmissionTokenRow => ({
  txid, outputIndex: vout, assetId: `${'ee'.repeat(32)}.0`, amount, identityKey: '02k', createdAt: '2026-10-01T00:00:00.000Z'
})

describe('mergeRestore — union, never replace', () => {
  it('keeps the first snapshot\'s token row when a later one no longer has it (the self-heal case)', () => {
    const crashed: AdmissionRestore = { spentOutpoints: [`${A}.0`], tokenRows: [row(A, 0, 5)] }
    const heal: AdmissionRestore = { spentOutpoints: [`${A}.0`], tokenRows: [] }
    const admit: AdmissionRestore = { spentOutpoints: [`${A}.0`], tokenRows: [] }
    expect(mergeRestore(mergeRestore(crashed, heal), admit)).toEqual(crashed)
  })

  it('an early EMPTY snapshot is merged into, not kept (refused-then-admitted)', () => {
    const refused: AdmissionRestore = { spentOutpoints: [], tokenRows: [] }
    const admitted: AdmissionRestore = { spentOutpoints: [`${A}.0`], tokenRows: [row(A, 0, 5)] }
    expect(mergeRestore(refused, admitted)).toEqual(admitted)
  })

  it('unions outpoints and rows by outpoint, first-seen row wins, order kept, duplicates dropped', () => {
    const first: AdmissionRestore = { spentOutpoints: [`${A}.0`, `${B}.1`], tokenRows: [row(A, 0, 5)] }
    const later: AdmissionRestore = {
      spentOutpoints: [`${B}.1`, `${C}.2`, `${C}.2`],
      tokenRows: [{ ...row(A, 0, 999) }, row(C, 2, 7), row(C, 2, 7)]
    }
    expect(mergeRestore(first, later)).toEqual({
      spentOutpoints: [`${A}.0`, `${B}.1`, `${C}.2`],
      tokenRows: [row(A, 0, 5), row(C, 2, 7)]
    })
  })

  it('matches outpoints case-insensitively (a txid is hex)', () => {
    const got = mergeRestore(
      { spentOutpoints: [`${A}.0`], tokenRows: [row(A, 0, 5)] },
      { spentOutpoints: [`${A.toUpperCase()}.0`], tokenRows: [row(A.toUpperCase(), 0, 5)] }
    )
    expect(got).toEqual({ spentOutpoints: [`${A}.0`], tokenRows: [row(A, 0, 5)] })
  })

  it('nothing incoming leaves the record alone; nothing stored takes the incoming snapshot', () => {
    const s: AdmissionRestore = { spentOutpoints: [`${A}.0`], tokenRows: [row(A, 0, 5)] }
    expect(mergeRestore(s, undefined)).toEqual(s)
    expect(mergeRestore(undefined, undefined)).toBeUndefined()
    expect(mergeRestore(null, s)).toEqual(s)
  })

  it('tolerates a malformed stored snapshot (non-array fields) without dropping the incoming one', () => {
    const s: AdmissionRestore = { spentOutpoints: [`${A}.0`], tokenRows: [row(A, 0, 5)] }
    expect(mergeRestore({ spentOutpoints: 'x', tokenRows: null } as unknown as AdmissionRestore, s)).toEqual(s)
  })
})

describe('snapshotRestoreFrom — every input, not previousCoins (Go parity)', () => {
  it('names every input and snapshots each row that still exists, whatever the engine listed', async () => {
    const key = PrivateKey.fromRandom()
    const lock = new P2PKH().lock(key.toPublicKey().toAddress())
    const tx = new Transaction(1, [
      { sourceTXID: A, sourceOutputIndex: 0, unlockingScript: lock, sequence: 0xffffffff },
      { sourceTXID: B, sourceOutputIndex: 3, unlockingScript: lock, sequence: 0xffffffff }
    ], [{ lockingScript: lock, satoshis: 1 }], 0)
    const rows: Record<string, any> = { [`${B}.3`]: { ...row(B, 3, 9), createdAt: new Date('2026-10-01T00:00:00.000Z'), _id: 'x' } }
    const snap = await snapshotRestoreFrom(async (t, v) => rows[`${t}.${v}`] ?? null)(tx, [])
    expect(snap).toEqual({ spentOutpoints: [`${A}.0`, `${B}.3`], tokenRows: [row(B, 3, 9)] })
  })
})

// ───────────── the production store and the real engine (Mongo) ─────────────

const up = await mongoAvailable()

describe.skipIf(!up)('mongoAdmissionStore — the restore snapshot only grows (Mongo)', () => {
  let mongo: TestMongo
  beforeAll(async () => { mongo = (await connectTestMongo('admission_store'))! })
  afterAll(async () => { await mongo?.close() })

  it('putPending and putAdmitted merge into the stored snapshot instead of replacing it', async () => {
    const store = mongoAdmissionStore(mongo.db.collection('merge_case'))
    const at = '2026-10-01T00:00:00.000Z'
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.0`], tokenRows: [row(B, 0, 5)] } })
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [], tokenRows: [] } })
    await store.putAdmitted({
      txid: A, topics: ['tm_mandala'], outputsToAdmit: [0], admissionSignature: 's', admissionIdentityKey: 'k', at,
      restore: { spentOutpoints: [`${B}.0`], tokenRows: [] }
    })
    const rec = await store.get(A)
    expect(rec?.restore).toEqual({ spentOutpoints: [`${B}.0`], tokenRows: [row(B, 0, 5)] })
    expect(rec?.pending).toBe(false)
  })

  it('refused-then-admitted: the later, non-empty snapshot lands on a record that started empty', async () => {
    const store = mongoAdmissionStore(mongo.db.collection('refused_case'))
    const at = '2026-10-01T00:00:00.000Z'
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [], tokenRows: [] } })
    await store.putRefusal({ txid: A, refusedCode: 'ERR_LINKAGE', refusedDescription: 'x', refusedAt: at, refusedPayloadHash: 'h' })
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.0`], tokenRows: [row(B, 0, 5)] } })
    expect((await store.get(A))?.restore).toEqual({ spentOutpoints: [`${B}.0`], tokenRows: [row(B, 0, 5)] })
  })

  it('a provisional write with no snapshot (the snapshot read failed) leaves the stored one alone', async () => {
    const store = mongoAdmissionStore(mongo.db.collection('nosnap_case'))
    const at = '2026-10-01T00:00:00.000Z'
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at, restore: { spentOutpoints: [`${B}.0`], tokenRows: [row(B, 0, 5)] } })
    await store.putPending!({ txid: A, topics: ['tm_mandala'], at })
    expect((await store.get(A))?.restore).toEqual({ spentOutpoints: [`${B}.0`], tokenRows: [row(B, 0, 5)] })
  })
})

describe.skipIf(!up)('crash → heal → admit → evict over the real engine and the production stack (Mongo)', () => {
  let mongo: TestMongo
  let h: Harness | undefined
  beforeAll(async () => { mongo = (await connectTestMongo('snapshot_heal'))! })
  afterAll(async () => { await h?.close(); await mongo?.close() })

  it('the evicted tx\'s input gets its token row and its balance back', async () => {
    const storage = new MandalaStorageManager(mongo.db)
    const tokens = mongo.db.collection('mandalaTokens')
    const admissions = mongoAdmissionStore(mongo.db.collection('mandalaAdmissions'))
    const channel = new SubmitSideChannel()
    const HOLDER = '02' + 'dd'.repeat(32)

    // A lookup that keeps token rows the way MandalaLookupService does: a row
    // per admitted output (credited), debited and deleted on outputSpent.
    const lookup = {
      outputAdmittedByTopic: async (p: any) => {
        const tx = Transaction.fromBEEF(p.atomicBEEF)
        await storage.storeToken({
          txid: tx.id('hex'), outputIndex: p.outputIndex, assetId: `${'ee'.repeat(32)}.0`,
          amount: tx.outputs[p.outputIndex].satoshis ?? 0, identityKey: HOLDER, createdAt: new Date()
        })
        await storage.adjustBalance(HOLDER, tx.outputs[p.outputIndex].satoshis ?? 0)
      },
      outputSpent: async (p: any) => {
        const r = await storage.getTokenRow(p.txid, p.outputIndex)
        if (r != null) await storage.adjustBalance(r.identityKey, -r.amount)
        await storage.deleteToken(p.txid, p.outputIndex)
      },
      outputEvicted: async (txid: string, vout: number) => { await storage.deleteToken(txid, vout) },
      lookup: async () => [],
      getDocumentation: async () => '',
      getMetaData: async () => ({ name: 'ls_test', shortDescription: '' })
    }

    // index.ts's outer layer, verbatim in shape: capture + snapshot + §9.4
    // provisional record around the spent-input guard.
    h = await createHarness({
      wrap: (guarded: TopicManager) => withVerdictCapture(guarded, {
        channel,
        putPending: async (rec) => { await admissions.putPending!(rec) },
        snapshotRestore: snapshotRestoreFrom(async (t, v) => await storage.getTokenRow(t, v))
      }),
      lookupServices: { ls_test: lookup as any }
    })
    await h.submit(h.root)
    const X = `${h.root.id('hex')}.0`
    expect(await storage.getTokenRow(h.root.id('hex'), 0)).not.toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(1000)

    const a = await h.spend(900)
    const txidA = a.id('hex')

    // Attempt 1: phase 3 marks X spent by A and the lookup deletes X's row
    // (debit), then insertOutput dies.
    const realInsert = h.storage.insertOutput.bind(h.storage)
    h.storage.insertOutput = async () => { throw new Error('simulated crash after mark-spent') }
    expect((await h.submit(a)).error).toBeDefined()
    h.storage.insertOutput = realInsert
    expect(await storage.getTokenRow(h.root.id('hex'), 0)).toBeNull()
    expect(await storage.getBalance(HOLDER)).toBe(0)
    channel.take(txidA)

    // Attempt 2: the guard heals the self-held coin and refuses retryably.
    expect((await h.submit(a)).refusal).toBeDefined()
    channel.take(txidA)

    // Attempt 3: admitted. The /submit wrapper finalizes with this round's
    // snapshot — which no longer carries X's row.
    const admitted = await h.submit(a)
    expect(admitted.refusal).toBeUndefined()
    expect((admitted.steak as any)[HARNESS_TOPIC].outputsToAdmit).toEqual([0])
    const outcome = channel.take(txidA)
    expect(outcome?.restore?.tokenRows).toEqual([])
    await admissions.putAdmitted({
      txid: txidA, topics: [HARNESS_TOPIC], outputsToAdmit: [0], admissionSignature: 's', admissionIdentityKey: 'k',
      at: new Date().toISOString(), restore: outcome?.restore
    })
    const rec = await admissions.get(txidA)
    expect(rec?.restore?.spentOutpoints).toEqual([X])
    expect(rec?.restore?.tokenRows.map(r => `${r.txid}.${r.outputIndex}`)).toEqual([X])

    // Arcade rejects A: evict with the production restore path.
    const balanceBeforeEvict = await storage.getBalance(HOLDER)
    const report = await evictWithRestore(txidA, 'REJECTED', {
      store: admissions,
      ...knexEvictionCoins(h.knex, HARNESS_TOPIC),
      restoreTokenRow: mongoRestoreTokenRow(tokens as any, async (k, d) => { await storage.adjustBalance(k, d) }),
      evict: async (txid, reason) => await h!.engine.evictAppliedTransaction(txid, { reason }),
      assetsTouchedBy: async () => [],
      rebuildAssetStateExcluding: async () => {},
      purgeAdminHistory: async () => {}
    })
    expect(report).toMatchObject({ restoredOutpoints: 1, restoredTokenRows: 1, alreadyEvicted: false })

    // X is live in the engine, its token row is back, and the restore credited
    // the holder X's 1000 (the debit the crashed attempt's outputSpent made).
    // Asserted as a delta: the evicted output's own 900 is removed by
    // outputEvicted, which — like MandalaLookupService's — deletes the row
    // without a debit, and this test should not pin that.
    const xRow = await h.knex('outputs').where({ txid: h.root.id('hex'), outputIndex: 0, topic: HARNESS_TOPIC }).first()
    expect(Boolean(xRow.spent)).toBe(false)
    expect(await storage.getTokenRow(h.root.id('hex'), 0)).toMatchObject({ amount: 1000, identityKey: HOLDER })
    expect(await storage.getBalance(HOLDER) - balanceBeforeEvict).toBe(1000)
    expect((await admissions.get(txidA))?.evictedAt).toBeDefined()
  })
})

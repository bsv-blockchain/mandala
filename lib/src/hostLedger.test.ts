/** The host ledger (design §9 B7): merge rules and corrupt records. */
import { describe, it, expect } from 'vitest'
import { createHostLedger, mergeRecord, type LedgerRecord } from './hostLedger.js'
import { memoryStorage } from './storage.js'
import { ID } from './__fixtures__/signedChain.js'

const T = 'a'.repeat(64)
const rec = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({ v: 1, txid: T, assetId: ID, state: 'pending', outputs: [0], at: 1, ...over })

describe('host ledger', () => {
  it('never downgrades settled, unions outputs, and owes markSettled once a pending record settles', async () => {
    const l = createHostLedger(memoryStorage())
    await l.put(rec())
    const s = await l.put(rec({ state: 'settled', outputs: [1] }))
    expect(s).toMatchObject({ state: 'settled', outputs: [0, 1], marked: false })
    expect(await l.put(rec({ state: 'pending' }))).toMatchObject({ state: 'settled' })
    expect(mergeRecord(undefined, rec({ state: 'settled' })).marked).toBeUndefined()
    expect(mergeRecord(rec({ state: 'refused' }), rec({ state: 'pending' })).state).toBe('refused')
  })

  it('a record for another asset under the same txid is refused', async () => {
    const l = createHostLedger(memoryStorage())
    await l.put(rec())
    await expect(l.put(rec({ assetId: `${'b'.repeat(64)}_0` }))).rejects.toThrow(/another asset/)
  })

  it('a corrupt record reads as absent; a malformed record is never written', async () => {
    const store = memoryStorage()
    await store.setItem(`mandala.host.v1.record.${T}`, '{"v":1,"txid":"x"}')
    const l = createHostLedger(store)
    expect(await l.get(T)).toBeUndefined()
    await expect(l.put({ ...rec(), outputs: [-1] })).rejects.toThrow(TypeError)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import {
  blindingPut,
  blindingGet,
  blindingList,
  blindingClear,
  blindingReserve,
  blindingCommit,
  blindingListReserved,
  blindingPruneReserved
} from './blindingJournal.js'

beforeEach(async () => { await blindingClear() })

describe('blindingJournal', () => {
  it('stores and retrieves r by txid', async () => {
    await blindingPut({
      txid: 'aa',
      r: 'ff'.repeat(32),
      senderBlinded: '02ab',
      recipient: '03cd',
      keyID: 'k',
      at: 1
    })
    expect((await blindingGet('aa'))?.r).toBe('ff'.repeat(32))
    expect(await blindingList()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Deferred-commit blinding: the nearby-payee rail runs lockToPayee (and mints
// r) BEFORE a txid exists, so it must reserve under keyID and only gain a
// txid-keyed record once the tx is actually built (blindingCommit).
// ---------------------------------------------------------------------------

const RECORD = (over: Partial<{ r: string, senderBlinded: string, recipient: string, keyID: string, at: number }> = {}) => ({
  r: 'ff'.repeat(32),
  senderBlinded: '02ab',
  recipient: '03cd',
  keyID: 'k1',
  at: 1,
  ...over
})

describe('blindingReserve / blindingCommit — deferred-commit journal', () => {
  it('reserve → commit → blindingGet(txid) finds the record', async () => {
    await blindingReserve('k1', RECORD())
    await blindingCommit('k1', 'txid-1')
    const got = await blindingGet('txid-1')
    expect(got?.txid).toBe('txid-1')
    expect(got?.r).toBe('ff'.repeat(32))
    expect(got?.keyID).toBe('k1')
  })

  it('removes the reservation once committed', async () => {
    await blindingReserve('k1', RECORD())
    await blindingCommit('k1', 'txid-1')
    expect(await blindingListReserved()).toHaveLength(0)
  })

  it('blindingListReserved lists outstanding reservations keyed by keyID', async () => {
    await blindingReserve('k1', RECORD({ keyID: 'k1' }))
    await blindingReserve('k2', RECORD({ keyID: 'k2' }))
    const reserved = await blindingListReserved()
    expect(reserved).toHaveLength(2)
    expect(reserved.map(r => r.keyID).sort()).toEqual(['k1', 'k2'])
  })

  it('committing an unknown keyID is a safe no-op (nothing to move)', async () => {
    await expect(blindingCommit('nope', 'txid-x')).resolves.not.toThrow()
    expect(await blindingGet('txid-x')).toBeUndefined()
  })

  it('blindingPruneReserved removes only reservations older than the cutoff', async () => {
    const now = Date.now()
    await blindingReserve('old', RECORD({ keyID: 'old', at: now - 10_000 }))
    await blindingReserve('fresh', RECORD({ keyID: 'fresh', at: now }))
    const removed = await blindingPruneReserved(5_000)
    expect(removed).toBe(1)
    const remaining = await blindingListReserved()
    expect(remaining.map(r => r.keyID)).toEqual(['fresh'])
  })

  it('a pruned reservation cannot later be committed', async () => {
    const now = Date.now()
    await blindingReserve('old', RECORD({ keyID: 'old', at: now - 10_000 }))
    await blindingPruneReserved(5_000)
    await blindingCommit('old', 'txid-old')
    expect(await blindingGet('txid-old')).toBeUndefined()
  })
})

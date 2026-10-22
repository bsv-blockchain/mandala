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
import { configureStorage, memoryStorage, MandalaStorage } from './storage.js'

const TXID = 'ab'.repeat(32)
const ASSET = `${'c7'.repeat(32)}_0`

function spyStorage (): { store: MandalaStorage, map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    store: {
      getItem: async k => map.get(k) ?? null,
      setItem: async (k, v) => { map.set(k, v) },
      removeItem: async k => { map.delete(k) },
      keys: async p => [...map.keys()].filter(k => k.startsWith(p))
    }
  }
}

beforeEach(async () => {
  configureStorage(memoryStorage())
  await blindingClear()
})

const RECORD = (over: Partial<{ r: string, senderBlinded: string, recipient: string, assetId: string, at: number }> = {}) => ({
  r: 'ff'.repeat(32),
  senderBlinded: '02ab',
  recipient: '03cd',
  assetId: ASSET,
  at: 1,
  ...over
})

describe('blindingJournal (keyed by outpoint, C§8.1)', () => {
  it('stores r under mandala.blindingJournal.<txid>.<vout> and reads it back by outpoint', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    await blindingPut({ outpoint: `${TXID}.0`, ...RECORD() })
    expect([...map.keys()]).toEqual([`mandala.blindingJournal.${TXID}.0`])
    const got = await blindingGet(`${TXID}.0`)
    expect(got).toEqual({ outpoint: `${TXID}.0`, ...RECORD() })
    expect(got?.assetId).toBe(ASSET)
    expect(await blindingGet(`${TXID}.1`)).toBeUndefined()
    expect(await blindingList()).toHaveLength(1)
  })

  it('refuses a malformed outpoint (underscore form, uppercase, missing vout)', async () => {
    for (const bad of [`${TXID}_0`, `${TXID.toUpperCase()}.0`, TXID, `${TXID}.01`]) {
      await expect(blindingPut({ outpoint: bad, ...RECORD() })).rejects.toBeInstanceOf(TypeError)
    }
    expect(await blindingList()).toEqual([])
  })

  it('a storage write failure propagates (r has no other copy)', async () => {
    const { store } = spyStorage()
    configureStorage({ ...store, setItem: async () => { throw new Error('quota') } })
    await expect(blindingPut({ outpoint: `${TXID}.0`, ...RECORD() })).rejects.toThrow(/quota/)
    await expect(blindingReserve('sfx', RECORD())).rejects.toThrow(/quota/)
  })
})

// ---------------------------------------------------------------------------
// Deferred commit: r is minted by recipientLinkage before a txid exists, so it
// is reserved under the derivationSuffix and moved to the recipient output's
// outpoint once the tx is signed (blindingCommit).
// ---------------------------------------------------------------------------

describe('blindingReserve / blindingCommit (key = derivationSuffix)', () => {
  it('reserve → commit moves the reservation to its outpoint', async () => {
    await blindingReserve('EBESExQVFhcYGRobHB0eHw==', RECORD())
    expect(await blindingListReserved()).toEqual([{ key: 'EBESExQVFhcYGRobHB0eHw==', ...RECORD() }])
    await blindingCommit('EBESExQVFhcYGRobHB0eHw==', `${TXID}.0`)
    const got = await blindingGet(`${TXID}.0`)
    expect(got).toEqual({ outpoint: `${TXID}.0`, ...RECORD() })
    expect(await blindingListReserved()).toHaveLength(0)
  })

  it('reservations never show up in blindingList', async () => {
    await blindingReserve('k1', RECORD())
    expect(await blindingList()).toEqual([])
  })

  it('blindingListReserved lists outstanding reservations by key', async () => {
    await blindingReserve('k1', RECORD())
    await blindingReserve('k2', RECORD())
    const reserved = await blindingListReserved()
    expect(reserved.map(r => r.key).sort()).toEqual(['k1', 'k2'])
  })

  it('committing an unknown key is a safe no-op (nothing to move)', async () => {
    await expect(blindingCommit('nope', `${TXID}.0`)).resolves.toBeUndefined()
    expect(await blindingGet(`${TXID}.0`)).toBeUndefined()
  })

  it('commit refuses a malformed outpoint and keeps the reservation', async () => {
    await blindingReserve('k1', RECORD())
    await expect(blindingCommit('k1', `${TXID}_0`)).rejects.toBeInstanceOf(TypeError)
    expect(await blindingListReserved()).toHaveLength(1)
  })

  it('a failed commit write keeps the reservation (r is not lost)', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    await blindingReserve('k1', RECORD())
    configureStorage({ ...store, setItem: async () => { throw new Error('quota') } })
    await blindingCommit('k1', `${TXID}.0`)
    expect([...map.keys()]).toEqual(['mandala.blindingJournal.reserve.k1'])
  })

  it('a repeated commit (double-click, second tab) is harmless', async () => {
    await blindingReserve('k1', RECORD())
    await blindingCommit('k1', `${TXID}.0`)
    await blindingCommit('k1', `${TXID}.0`)
    expect((await blindingGet(`${TXID}.0`))?.r).toBe('ff'.repeat(32))
    expect(await blindingList()).toHaveLength(1)
  })

  it('blindingPruneReserved removes only reservations older than the cutoff', async () => {
    const now = Date.now()
    await blindingReserve('old', RECORD({ at: now - 10_000 }))
    await blindingReserve('fresh', RECORD({ at: now }))
    const removed = await blindingPruneReserved(5_000)
    expect(removed).toBe(1)
    const remaining = await blindingListReserved()
    expect(remaining.map(r => r.key)).toEqual(['fresh'])
  })

  it('a pruned reservation cannot later be committed', async () => {
    const now = Date.now()
    await blindingReserve('old', RECORD({ at: now - 10_000 }))
    await blindingPruneReserved(5_000)
    await blindingCommit('old', `${TXID}.0`)
    expect(await blindingGet(`${TXID}.0`)).toBeUndefined()
  })
})

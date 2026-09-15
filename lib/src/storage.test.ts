/**
 * D3c — the injected storage adapter and the async journals that ride on it.
 *
 * The contract under test is the one the recovery machinery depends on:
 *   · every journal read/write goes through the CURRENT adapter, so a host
 *     that injects durable storage (React Native / Expo SQLite) really does
 *     survive process death;
 *   · there is no in-memory mirror in front of the adapter, so a second
 *     reader can never see a stale entry;
 *   · `submitAndBroadcast` does not start the network broadcast until the
 *     'accepted' write has RESOLVED — that write is the commit point.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MandalaStorage,
  configureStorage,
  getStorage,
  memoryStorage,
  defaultStorage
} from './storage.js'
import { journalPut, journalList, journalClear, journalRemove, hasFreshIntent, journalIntentBegin } from './txJournal.js'
import { notifyPut, notifyList, notifyClear } from './notifyJournal.js'
import { blindingPut, blindingGet, blindingList, blindingClear } from './blindingJournal.js'
import { configureMandala } from './constants.js'
import { submitAndBroadcast } from './overlay.js'

/** A spying adapter over an isolated Map — stands in for the host's store. */
function spyStorage (): { store: MandalaStorage, map: Map<string, string>, sets: string[] } {
  const map = new Map<string, string>()
  const sets: string[] = []
  return {
    map,
    sets,
    store: {
      getItem: async k => map.get(k) ?? null,
      setItem: async (k, v) => { sets.push(k); map.set(k, v) },
      removeItem: async k => { map.delete(k) },
      keys: async prefix => [...map.keys()].filter(k => k.startsWith(prefix))
    }
  }
}

/** An adapter whose writes park until `flush()` — the crash window, held open. */
function deferredStorage (): {
  store: MandalaStorage
  flush: () => void
  parked: () => number
} {
  const base = memoryStorage()
  const waiting: Array<() => void> = []
  return {
    store: {
      ...base,
      setItem: async (k, v) => {
        await new Promise<void>(resolve => waiting.push(resolve))
        await base.setItem(k, v)
      }
    },
    flush: () => { waiting.splice(0).forEach(resolve => resolve()) },
    parked: () => waiting.length
  }
}

afterEach(() => configureStorage(null))

describe('MandalaStorage default adapter', () => {
  beforeEach(() => configureStorage(null))

  it('is the adapter in force until one is injected', () => {
    expect(getStorage()).toBe(defaultStorage)
  })

  it('round-trips get/set/remove', async () => {
    const s = getStorage()
    expect(await s.getItem('mandala.test.absent')).toBeNull()
    await s.setItem('mandala.test.a', 'one')
    expect(await s.getItem('mandala.test.a')).toBe('one')
    await s.setItem('mandala.test.a', 'two')
    expect(await s.getItem('mandala.test.a')).toBe('two')
    await s.removeItem('mandala.test.a')
    expect(await s.getItem('mandala.test.a')).toBeNull()
  })

  it('keys(prefix) returns only the matching keys', async () => {
    const s = getStorage()
    await s.setItem('mandala.pfx.a', '1')
    await s.setItem('mandala.pfx.b', '2')
    await s.setItem('mandala.other.c', '3')
    expect((await s.keys('mandala.pfx.')).sort()).toEqual(['mandala.pfx.a', 'mandala.pfx.b'])
    expect(await s.keys('mandala.nothing.')).toEqual([])
    await Promise.all(['mandala.pfx.a', 'mandala.pfx.b', 'mandala.other.c'].map(async k => { await s.removeItem(k) }))
  })

  it('memoryStorage() hands out isolated stores (test fixtures never bleed)', async () => {
    const a = memoryStorage()
    const b = memoryStorage()
    await a.setItem('k', 'v')
    expect(await a.getItem('k')).toBe('v')
    expect(await b.getItem('k')).toBeNull()
  })

  it('configureStorage(null) restores the default adapter', () => {
    const injected = memoryStorage()
    configureStorage(injected)
    expect(getStorage()).toBe(injected)
    configureStorage(null)
    expect(getStorage()).toBe(defaultStorage)
  })

  it('configureMandala({ storage }) is an equivalent entry point and leaves it alone when omitted', () => {
    const injected = memoryStorage()
    configureMandala({ storage: injected })
    expect(getStorage()).toBe(injected)
    configureMandala({ overlayUrl: 'http://o' })
    expect(getStorage()).toBe(injected)
  })
})

describe('the three journals read and write through the injected adapter', () => {
  it('txJournal persists entries under mandala.txJournal.<id> in the injected store', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    await journalPut({ txid: 'abc', stage: 'accepted', at: 1 })
    expect([...map.keys()]).toEqual(['mandala.txJournal.abc'])
    expect(JSON.parse(map.get('mandala.txJournal.abc') as string)).toMatchObject({ txid: 'abc', stage: 'accepted' })
    expect(await journalList()).toMatchObject([{ txid: 'abc', stage: 'accepted' }])
    await journalRemove('abc')
    expect(map.size).toBe(0)
    expect(await journalList()).toEqual([])
  })

  it('notifyJournal persists entries under mandala.notifyJournal.<txid> in the injected store', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    await notifyPut({ txid: 'n1', recipient: '02ab', messageBox: 'mb', body: { a: 1 }, at: 1 })
    expect([...map.keys()]).toEqual(['mandala.notifyJournal.n1'])
    expect(await notifyList()).toMatchObject([{ txid: 'n1', recipient: '02ab' }])
    await notifyClear()
    expect(map.size).toBe(0)
  })

  it('blindingJournal persists r under mandala.blindingJournal.<txid> in the injected store', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    await blindingPut({ txid: 'b1', r: 'ff'.repeat(32), senderBlinded: '02ab', recipient: '03cd', keyID: 'k', at: 1 })
    expect([...map.keys()]).toEqual(['mandala.blindingJournal.b1'])
    expect((await blindingGet('b1'))?.r).toBe('ff'.repeat(32))
    expect(await blindingList()).toHaveLength(1)
    await blindingClear()
    expect(map.size).toBe(0)
    expect(await blindingGet('b1')).toBeUndefined()
  })

  it('a swapped adapter is authoritative immediately — nothing is cached from the old one', async () => {
    const first = spyStorage()
    configureStorage(first.store)
    await journalPut({ txid: 'old', stage: 'accepted', at: 1 })
    await notifyPut({ txid: 'old', recipient: '02ab', messageBox: 'mb', body: {}, at: 1 })
    await blindingPut({ txid: 'old', r: 'aa', senderBlinded: '02ab', recipient: '03cd', keyID: 'k', at: 1 })

    configureStorage(memoryStorage())
    expect(await journalList()).toEqual([])
    expect(await notifyList()).toEqual([])
    expect(await blindingList()).toEqual([])
    expect(await blindingGet('old')).toBeUndefined()
  })
})

describe('no stale read after a write (the mirror is gone)', () => {
  it('a write made straight into the store is visible to the journal readers', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    // Reader A populates the journal through the API…
    await journalPut({ txid: 'mine', stage: 'accepted', at: 1 })
    // …while "another reader" (second tab / another process) writes and
    // deletes directly in the shared store. A memory mirror would hide both.
    map.set('mandala.txJournal.theirs', JSON.stringify({ txid: 'theirs', stage: 'abort', reference: 'r', at: 2 }))
    map.delete('mandala.txJournal.mine')

    expect((await journalList()).map(e => e.txid)).toEqual(['theirs'])
  })

  it('an entry removed underneath us is gone from every reader', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    await notifyPut({ txid: 'n1', recipient: '02ab', messageBox: 'mb', body: {}, at: 1 })
    await blindingPut({ txid: 'n1', r: 'aa', senderBlinded: '02', recipient: '03', keyID: 'k', at: 1 })
    map.clear()
    expect(await notifyList()).toEqual([])
    expect(await blindingList()).toEqual([])
    expect(await blindingGet('n1')).toBeUndefined()
  })

  it('a rewritten entry reads back as the new value, never the first one', async () => {
    configureStorage(memoryStorage())
    await journalPut({ txid: 'abc', stage: 'accepted', at: 1 })
    await journalPut({ txid: 'abc', stage: 'accepted', at: 1, attempts: 3 })
    expect(await journalList()).toMatchObject([{ txid: 'abc', attempts: 3 }])
  })

  it('hasFreshIntent reads the store, so an intent written elsewhere blocks this reader too', async () => {
    const { store, map } = spyStorage()
    configureStorage(store)
    expect(await hasFreshIntent()).toBe(false)
    map.set('mandala.txJournal.intent:other-tab', JSON.stringify({ txid: 'intent:other-tab', stage: 'intent', at: Date.now() }))
    expect(await hasFreshIntent()).toBe(true)
  })
})

describe('the commit point is an awaited write (deferred adapter)', () => {
  const signed = { tx: [1, 2, 3], txid: 'abc' }

  beforeEach(async () => {
    configureStorage(null)
    await journalClear()
    configureMandala({ overlayUrl: 'http://test-overlay' })
  })

  it("submitAndBroadcast does not call createAction({sendWith}) until the 'accepted' write resolves", async () => {
    const deferred = deferredStorage()
    configureStorage(deferred.store)
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    const wallet = { createAction: vi.fn().mockResolvedValue({}), abortAction: vi.fn() }

    const done = submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any)

    // Overlay accepted; the journal write is parked mid-flight.
    await vi.waitFor(() => expect(deferred.parked()).toBe(1))
    expect(wallet.createAction).not.toHaveBeenCalled() // broadcast has NOT started
    expect(wallet.abortAction).not.toHaveBeenCalled()

    deferred.flush()
    await expect(done).resolves.toMatchObject({ outputsToAdmit: [0] })
    await vi.waitFor(() => expect(wallet.createAction).toHaveBeenCalledWith({
      description: 'broadcast overlay-accepted tx',
      options: { sendWith: ['abc'], acceptDelayedBroadcast: false }
    }))
  })

  it("the 'accepted' entry is durable in the injected store before the broadcast is attempted", async () => {
    const seenAtBroadcast: string[] = []
    const { store, map } = spyStorage()
    configureStorage(store)
    const facilitator = { send: vi.fn().mockResolvedValue({ tm_mandala: { outputsToAdmit: [0] } }) }
    const wallet = {
      createAction: vi.fn(async () => { seenAtBroadcast.push(...map.keys()); return {} }),
      abortAction: vi.fn()
    }
    await submitAndBroadcast(wallet as any, signed, undefined, 'ref-1', facilitator as any)
    await vi.waitFor(() => expect(wallet.createAction).toHaveBeenCalled())
    expect(seenAtBroadcast).toEqual(['mandala.txJournal.abc'])
  })

  it('an intent write is awaited too, so the marker exists before the caller proceeds', async () => {
    const deferred = deferredStorage()
    configureStorage(deferred.store)
    let settled = false
    const begun = journalIntentBegin().then(id => { settled = true; return id })
    await vi.waitFor(() => expect(deferred.parked()).toBe(1))
    expect(settled).toBe(false)
    deferred.flush()
    expect(await begun).toMatch(/^intent:/)
    expect(await hasFreshIntent()).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { OneColor } from '@bsv/templates'
import type { ListOutputsArgs, ListOutputsResult, WalletOutput } from '@bsv/sdk'
import {
  AVAILABLE_TAG,
  INVENTORY_SELECTOR,
  OFFLINE_TAG,
  PENDING_TAG,
  balanceSelector,
  frozenUnitsFor,
  listAllOutputs,
  parseBalanceTotal,
  summarizeInventory
} from './holderBalances'

const MAX = 2n ** 64n - 1n
const ID = `${'c'.repeat(64)}_0`
const ID2 = `${'d'.repeat(64)}_0`
const PKH = new Array(20).fill(7)
const lock = (id: string | null, amount: bigint): string => new OneColor().lock(id, amount, PKH).toHex()

function fakeWallet (total: number): {
  calls: ListOutputsArgs[]
  listOutputs: (args: ListOutputsArgs) => Promise<ListOutputsResult>
} {
  const calls: ListOutputsArgs[] = []
  return {
    calls,
    listOutputs: async (args) => {
      calls.push(args)
      const offset = args.offset ?? 0
      const limit = args.limit ?? 10
      const outputs: WalletOutput[] = []
      for (let i = offset; i < Math.min(total, offset + limit); i++) {
        outputs.push({ outpoint: `${i.toString(16).padStart(64, '0')}.0`, satoshis: 1, spendable: true })
      }
      return { totalOutputs: total, outputs }
    }
  }
}

describe('holderBalances', () => {
  it('pins the BRC-207 selector and state tag names (0207:396-404, 608-612, 649)', () => {
    expect(INVENTORY_SELECTOR).toBe('p color assets')
    expect(OFFLINE_TAG).toBe('color_offline')
    expect(AVAILABLE_TAG).toBe('color_state_available')
    expect(PENDING_TAG).toBe('color_state_pending')
  })

  it('parseBalanceTotal accepts the BRC-112 decimal string and plain counts (0207:687)', () => {
    expect(parseBalanceTotal('18446744073709551615')).toBe(MAX)
    expect(parseBalanceTotal('36893488147419103230')).toBe(2n * MAX)
    expect(parseBalanceTotal('0')).toBe(0n)
    expect(parseBalanceTotal(5)).toBe(5n)
    for (const bad of ['01', '-1', '1.0', '', ' 1', '1 ', '0x1', -1, 1.5, NaN, Infinity, 2 ** 53, null, undefined, 5n, {}]) {
      expect(() => parseBalanceTotal(bad)).toThrow()
    }
  })

  it('balanceSelector uses the assetTag form', () => {
    expect(balanceSelector(ID)).toBe(`p color balance ${'c'.repeat(64)}v0`)
  })

  it('summarizeInventory splits unsettled (in balance) from incoming (not in balance)', () => {
    const m = summarizeInventory([
      { outpoint: `${'1'.repeat(64)}.0`, lockingScript: lock(ID, 7n), tags: ['color_state_available'] }, // settled, neither
      { outpoint: `${'5'.repeat(64)}.0`, lockingScript: lock(ID, MAX), tags: ['color_state_available', 'color_offline'] }, // unsettled
      { outpoint: `${'6'.repeat(64)}.0`, lockingScript: lock(ID, 2n), tags: ['color_offline', 'color_state_available'] }, // unsettled (tag order irrelevant)
      { outpoint: `${'2'.repeat(64)}.1`, lockingScript: lock(ID, 5n), tags: ['color_state_pending', 'color_offline'] }, // incoming only
      { outpoint: `${'3'.repeat(64)}.0`, lockingScript: lock(ID2, 9n), tags: ['color_state_reserved', 'color_offline'] }, // neither
      { outpoint: `${'7'.repeat(64)}.0`, lockingScript: lock(ID2, 4n), tags: ['color_state_restricted'] }, // neither
      { outpoint: `${'4'.repeat(64)}.0`, lockingScript: 'deadbeef', tags: ['color_offline', 'color_state_available'] } // undecodable: skipped
    ])
    expect(m.get(ID)).toEqual({ unsettled: MAX + 2n, incoming: 5n })
    expect(m.get(ID2)).toEqual({ unsettled: 0n, incoming: 0n })
    expect(m.size).toBe(2)
  })

  it('summarizeInventory never mixes incoming into unsettled at uint64 max', () => {
    const m = summarizeInventory([
      { outpoint: `${'8'.repeat(64)}.0`, lockingScript: lock(ID, MAX), tags: ['color_state_pending'] },
      { outpoint: `${'9'.repeat(64)}.0`, lockingScript: lock(ID, MAX), tags: ['color_state_pending', 'color_offline'] }
    ])
    expect(m.get(ID)).toEqual({ unsettled: 0n, incoming: 2n * MAX })
  })

  it('summarizeInventory registers deploy-only and authority-only assets with no value', () => {
    const deployTxid = 'a'.repeat(64)
    const m = summarizeInventory([
      { outpoint: `${deployTxid}.0`, lockingScript: lock(null, 0n), tags: ['color_state_available'] },
      { outpoint: `${'b'.repeat(64)}.0`, lockingScript: 'ab', tags: [] }
    ], () => ({ role: 'authority', assetId: ID2, amount: 0n }))
    expect(m.get(ID2)).toEqual({ unsettled: 0n, incoming: 0n })
    const d = summarizeInventory([{ outpoint: `${deployTxid}.0`, lockingScript: lock(null, 0n), tags: [] }])
    expect(d.get(`${deployTxid}_0`)).toEqual({ unsettled: 0n, incoming: 0n })
  })

  it('summarizeInventory counts a record repeated across pages once (0207:660 reconcile outpoints)', () => {
    const row = { outpoint: `${'5'.repeat(64)}.0`, lockingScript: lock(ID, MAX), tags: ['color_state_available', 'color_offline'] }
    const m = summarizeInventory([row, { ...row }])
    expect(m.get(ID)).toEqual({ unsettled: MAX, incoming: 0n })
  })

  it('summarizeInventory skips records without a script or whose decoder throws', () => {
    const m = summarizeInventory([
      { outpoint: `${'1'.repeat(64)}.0`, tags: ['color_offline', 'color_state_available'] },
      { outpoint: `${'2'.repeat(64)}.0`, lockingScript: lock(ID, 3n), tags: ['color_offline', 'color_state_available'] }
    ], () => { throw new Error('boom') })
    expect(m.size).toBe(0)
  })

  it('frozenUnitsFor sums only rows owned by the identity', () => {
    expect(frozenUnitsFor({
      frozenOutpoints: [
        { outpoint: 'a.0', amount: MAX, owner: 'me', reason: '' },
        { outpoint: 'b.0', amount: 4n, owner: 'me', reason: '' },
        { outpoint: 'c.0', amount: 9n, owner: 'x', reason: '' }
      ]
    }, 'me')).toBe(MAX + 4n)
    expect(frozenUnitsFor(null, 'me')).toBe(0n)
    expect(frozenUnitsFor(undefined, 'me')).toBe(0n)
    expect(frozenUnitsFor({ frozenOutpoints: [] }, null)).toBe(0n)
    expect(frozenUnitsFor({ frozenOutpoints: [{ outpoint: 'a.0', amount: 1n, owner: 'me', reason: '' }] }, null)).toBe(0n)
  })

  it('listAllOutputs pages until totalOutputs and errors instead of truncating', async () => {
    const w = fakeWallet(2500)
    expect((await listAllOutputs(w, { basket: 'x' }, 1000)).length).toBe(2500)
    expect(w.calls.map(c => c.offset)).toEqual([0, 1000, 2000])
    expect(w.calls.every(c => c.basket === 'x' && c.limit === 1000)).toBe(true)
    await expect(listAllOutputs(fakeWallet(100_001), { basket: 'x' }, 1000)).rejects.toThrow('exceeds 100000 outputs')
  })

  it('listAllOutputs returns an exact fit at the page cap and stops on an empty page', async () => {
    expect((await listAllOutputs(fakeWallet(100_000), { basket: 'x' }, 1000)).length).toBe(100_000)
    expect((await listAllOutputs(fakeWallet(0), { basket: 'x' }, 1000)).length).toBe(0)
    const shrunk = {
      calls: 0,
      listOutputs: async (): Promise<ListOutputsResult> => {
        shrunk.calls++
        return { totalOutputs: 50, outputs: [] }
      }
    }
    expect(await listAllOutputs(shrunk, { basket: 'x' })).toEqual([])
    expect(shrunk.calls).toBe(1)
  })

  it('listAllOutputs refuses a malformed totalOutputs', async () => {
    const w = { listOutputs: async (): Promise<ListOutputsResult> => ({ totalOutputs: -1, outputs: [] }) }
    await expect(listAllOutputs(w, { basket: 'x' })).rejects.toThrow()
  })
})

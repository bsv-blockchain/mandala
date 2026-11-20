import { describe, it, expect } from 'vitest'
import type { ListOutputsArgs, ListOutputsResult, WalletOutput } from '@bsv/sdk'
import { listAllOutputs, parseBalanceTotal } from './walletOutputs'

const MAX = 2n ** 64n - 1n

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

describe('walletOutputs', () => {
  it('parseBalanceTotal accepts the BRC-112 decimal string and plain counts (0207:687)', () => {
    expect(parseBalanceTotal('18446744073709551615')).toBe(MAX)
    expect(parseBalanceTotal('36893488147419103230')).toBe(2n * MAX)
    expect(parseBalanceTotal('0')).toBe(0n)
    expect(parseBalanceTotal(5)).toBe(5n)
    for (const bad of ['01', '-1', '1.0', '', ' 1', '1 ', '0x1', -1, 1.5, NaN, Infinity, 2 ** 53, null, undefined, 5n, {}]) {
      expect(() => parseBalanceTotal(bad)).toThrow()
    }
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

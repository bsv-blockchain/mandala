import { describe, it, expect } from 'vitest'
import { OneColor } from '@bsv/templates'
import type { ListOutputsArgs, ListOutputsResult, WalletOutput } from '@bsv/sdk'
import { TREASURY_BASKET } from '@bsv/mandala'
import { loadTreasuryBalances, sumTreasury } from './treasury'

const MAX = 2n ** 64n - 1n
const ID = `${'c'.repeat(64)}_0`
const ID2 = `${'d'.repeat(64)}_0`
const PKH = new Array(20).fill(7)
const lock = (id: string | null, amount: bigint, payload?: number[]): string =>
  new OneColor().lock(id, amount, PKH, payload).toHex()

let n = 0
const rec = (lockingScript: string): WalletOutput => ({
  outpoint: `${(++n).toString(16).padStart(64, '0')}.0`,
  satoshis: 1,
  spendable: true,
  lockingScript
})

function fakeWallet (outputs: WalletOutput[]): {
  calls: ListOutputsArgs[]
  listOutputs: (args: ListOutputsArgs) => Promise<ListOutputsResult>
} {
  const calls: ListOutputsArgs[] = []
  return {
    calls,
    listOutputs: async (args) => {
      calls.push(args)
      const offset = args.offset ?? 0
      return { totalOutputs: outputs.length, outputs: outputs.slice(offset, offset + (args.limit ?? 10)) }
    }
  }
}

describe('treasury', () => {
  it('sumTreasury counts value outputs per asset only', () => {
    const deployScript = lock(null, 0n, [1, 2, 3])
    expect(sumTreasury([rec(lock(ID, MAX)), rec(lock(ID, 1n)), rec(deployScript), rec('00')])).toEqual({ [ID]: MAX + 1n })
    expect(sumTreasury([rec(lock(ID2, 5n))], () => ({ role: 'authority', assetId: ID2, amount: 0n }))).toEqual({})
  })

  it('sumTreasury counts an outpoint repeated across pages once', () => {
    const r = rec(lock(ID, MAX))
    expect(sumTreasury([r, { ...r }, rec(lock(ID, 2n))])).toEqual({ [ID]: MAX + 2n })
  })

  it('loadTreasuryBalances lists TREASURY_BASKET with locking scripts', async () => {
    const w = fakeWallet([rec(lock(ID, MAX)), rec(lock(ID2, 3n)), rec(lock(ID, MAX))])
    expect(await loadTreasuryBalances(w)).toEqual({ [ID]: 2n * MAX, [ID2]: 3n })
    expect(TREASURY_BASKET).toBe('mandala treasury')
    expect(w.calls[0]).toMatchObject({ basket: 'mandala treasury', include: 'locking scripts' })
  })
})

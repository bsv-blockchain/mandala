import { describe, it, expect } from 'vitest'
import { Hash, PrivateKey } from '@bsv/sdk'
import { MandalaToken } from './__fixtures__/token.js'
import { outpoint, decodeBalances, matchOutputIndices } from './tokens.js'
import { MAX_UINT64 } from './amount.js'

describe('tokens helpers', () => {
  it('formats outpoints', () => {
    expect(outpoint('ab', 2)).toBe('ab.2')
  })

  it('sums balances by assetId and skips non-token scripts', () => {
    const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
    const assetA = `${'a'.repeat(64)}_0`
    const lsA1 = new MandalaToken().lock(assetA, 30n, pkh).toHex()
    const lsA2 = new MandalaToken().lock(assetA, 20n, pkh).toHex()
    const balances = decodeBalances([
      { lockingScript: lsA1 },
      { lockingScript: lsA2 },
      { lockingScript: '006a' } // not a token
    ])
    expect(balances).toEqual([{ assetId: assetA, amount: 50n }])
  })

  it('sums MAX_UINT64 coins exactly and skips authority coins', () => {
    const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
    const assetA = `${'a'.repeat(64)}_0`
    const max = new MandalaToken().lock(assetA, MAX_UINT64, pkh).toHex()
    const auth = new MandalaToken().lock(assetA, 0n, pkh).toHex()
    expect(decodeBalances([{ lockingScript: max }, { lockingScript: max }, { lockingScript: auth }]))
      .toEqual([{ assetId: assetA, amount: 2n * MAX_UINT64 }])
  })
})

describe('matchOutputIndices', () => {
  const txWith = (...hexes: string[]): any => ({
    outputs: hexes.map(h => ({ lockingScript: { toHex: () => h } }))
  })

  it('finds each planned script at its shuffled position', () => {
    // Randomized order: change, wallet fee-change, recipient.
    const tx = txWith('cc01', 'ff99', 'aa01')
    expect(matchOutputIndices(tx, ['aa01', 'cc01'])).toEqual([2, 0])
  })

  it('ignores unplanned outputs (wallet satoshi change)', () => {
    const tx = txWith('ff99', 'aa01')
    expect(matchOutputIndices(tx, ['aa01'])).toEqual([1])
  })

  it('throws when a planned script is missing from the tx', () => {
    const tx = txWith('aa01')
    expect(() => matchOutputIndices(tx, ['aa01', 'bb02'])).toThrow(/not found/i)
  })

  it('throws on duplicate planned scripts (ambiguous match)', () => {
    const tx = txWith('aa01', 'aa01')
    expect(() => matchOutputIndices(tx, ['aa01', 'aa01'])).toThrow(/ambiguous/i)
  })
})

import { describe, it, expect } from 'vitest'
import { Hash, PrivateKey, ProtoWallet } from '@bsv/sdk'
import { MandalaToken } from './__fixtures__/token.js'
import { outpoint, decodeBalances, revealLinkage, matchOutputIndices } from './tokens.js'
import { encodeLinkagePayload, MandalaLinkagePayload } from './encoding.js'
import { configureMandala } from './constants.js'

describe('tokens helpers', () => {
  it('formats outpoints', () => {
    expect(outpoint('ab', 2)).toBe('ab.2')
  })

  it('sums balances by assetId and skips non-token scripts', () => {
    const pkh = Hash.hash160(PrivateKey.fromRandom().toPublicKey().encode(true) as number[])
    const assetA = `${'a'.repeat(64)}_0`
    const lsA1 = new MandalaToken().lock(assetA, 30, pkh).toHex()
    const lsA2 = new MandalaToken().lock(assetA, 20, pkh).toHex()
    const balances = decodeBalances([
      { lockingScript: lsA1 },
      { lockingScript: lsA2 },
      { lockingScript: '006a' } // not a token
    ])
    expect(balances).toEqual([{ assetId: assetA, amount: 50 }])
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

describe('input linkage payload assembly', () => {
  it('inputs length equals the number of spent FT inputs', async () => {
    // Simulate the pattern used in SendTokens.transfer:
    //   for each entry in spendInfo, call revealLinkage and push to inLinks.
    // We use ProtoWallet (same mock wallet as unlock tests) + 'self' counterparty.
    // revealLinkage's verifier comes from configureMandala — the package has
    // no ambient env, so tests must set a valid overlay identity key.
    configureMandala({
      overlayIdentityKey: PrivateKey.fromRandom().toPublicKey().toString()
    })
    const wallet = new ProtoWallet(PrivateKey.fromRandom())

    const spendInfo = [
      { keyID: 'tkn-1', counterparty: 'self' },
      { keyID: 'tkn-2', counterparty: 'self' },
      { keyID: 'tkn-3', counterparty: 'self' }
    ]

    const inLinks: Array<{ index: number, linkage: any }> = []
    for (let i = 0; i < spendInfo.length; i++) {
      inLinks.push({
        index: i,
        linkage: await revealLinkage(wallet as any, spendInfo[i].keyID, spendInfo[i].counterparty)
      })
    }

    // The payload's inputs array must match spendInfo.length (3 inputs → 3 entries)
    const payload: MandalaLinkagePayload = { inputs: inLinks, outputs: [] }
    const bytes = encodeLinkagePayload(payload)
    const decoded = JSON.parse(Buffer.from(bytes).toString('utf8')) as MandalaLinkagePayload

    expect(decoded.inputs.length).toBe(spendInfo.length)
    // Each entry must have a matching index
    for (let i = 0; i < spendInfo.length; i++) {
      expect(decoded.inputs[i].index).toBe(i)
    }
  })

  it('inputs is empty when spendInfo is empty (previous buggy state)', () => {
    // Guard: encodeLinkagePayload with inputs:[] produces an empty inputs array
    const payload: MandalaLinkagePayload = { inputs: [], outputs: [] }
    const bytes = encodeLinkagePayload(payload)
    const decoded = JSON.parse(Buffer.from(bytes).toString('utf8')) as MandalaLinkagePayload
    expect(decoded.inputs.length).toBe(0)
  })
})

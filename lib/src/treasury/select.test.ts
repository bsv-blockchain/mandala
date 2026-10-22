import { existsSync } from 'node:fs'
import { it, expect, describe } from 'vitest'
import { selectTreasuryInputs, TreasuryCandidate } from './select.js'
import { MAX_UINT64 } from '../amount.js'

// Terse builder: amount, confirmed (default true), order (default = amount rank).
let seq = 0
const c = (amount: bigint, confirmed = true, order = seq++): TreasuryCandidate => ({
  outpoint: `tx${amount}_${order}.0`, amount, keyID: 'k', counterparty: 'cp', confirmed, order
})

const amounts = (s: { selected: TreasuryCandidate[] }): bigint[] => s.selected.map(x => x.amount)

describe('selectTreasuryInputs', () => {
  it('prefers an exact match in a single UTXO', () => {
    const r = selectTreasuryInputs([c(30n), c(50n), c(100n)], 50n)
    expect(amounts(r)).toEqual([50n])
    expect(r.total).toBe(50n)
  })

  it('overfunds by the least (smallest covering output), one UTXO', () => {
    // target 40: no exact; smallest >= 40 is 50 (not 100).
    const r = selectTreasuryInputs([c(20n), c(50n), c(100n)], 40n)
    expect(amounts(r)).toEqual([50n])
  })

  it('falls to largest-below and loops when nothing covers the remainder', () => {
    // target 120: no single output >= 120 → take 100 (largest below), remainder 20,
    // then smallest >= 20 is 30.
    const r = selectTreasuryInputs([c(30n), c(100n), c(15n)], 120n)
    expect(r.total >= 120n).toBe(true)
    expect(amounts(r)).toEqual([100n, 30n])
  })

  it('exact match ties break to the oldest (lowest order)', () => {
    const older = { ...c(50n, true, 1) }
    const newer = { ...c(50n, true, 9) }
    const r = selectTreasuryInputs([newer, older], 50n)
    expect(r.selected[0].order).toBe(1)
  })

  it('without an order, array position is the age rank', () => {
    const a: TreasuryCandidate = { outpoint: 'a.0', amount: 50n, keyID: 'a', counterparty: 'cp', confirmed: true }
    const b: TreasuryCandidate = { outpoint: 'b.0', amount: 50n, keyID: 'b', counterparty: 'cp', confirmed: true }
    expect(selectTreasuryInputs([a, b], 50n).selected[0].outpoint).toBe('a.0')
  })

  it('spends confirmed outputs before any unconfirmed one', () => {
    // Confirmed 50 covers the target; the unconfirmed 60 must be ignored.
    const r = selectTreasuryInputs([c(60n, false), c(50n, true)], 40n)
    expect(amounts(r)).toEqual([50n])
    expect(r.selected[0].confirmed).toBe(true)
  })

  it('dips into unconfirmed only when confirmed cannot cover', () => {
    // Confirmed total 30 < target 70 → take confirmed 30, then unconfirmed for the rest.
    const r = selectTreasuryInputs([c(30n, true), c(50n, false), c(100n, false)], 70n)
    expect(r.total >= 70n).toBe(true)
    expect(r.selected.some(x => x.confirmed === true && x.amount === 30n)).toBe(true)
    expect(r.selected.some(x => x.confirmed !== true)).toBe(true)
  })

  it('throws when the combined balance is insufficient', () => {
    expect(() => selectTreasuryInputs([c(10n), c(20n, false)], 100n)).toThrow(/insufficient treasury balance/)
  })

  it('returns nothing for a non-positive target', () => {
    expect(selectTreasuryInputs([c(10n)], 0n)).toEqual({ selected: [], total: 0n })
  })

  it('selection total exceeds 2^64 exactly', () => {
    const T = 'ab'.repeat(32)
    const K = '02' + '11'.repeat(32)
    const cands: TreasuryCandidate[] = [
      { outpoint: `${T}.0`, amount: MAX_UINT64, keyID: 'a', counterparty: K },
      { outpoint: `${T}.1`, amount: MAX_UINT64, keyID: 'b', counterparty: K }
    ]
    expect(selectTreasuryInputs(cands, MAX_UINT64 + 1n).total).toBe(2n * MAX_UINT64)
    expect(() => selectTreasuryInputs(cands, 2n * MAX_UINT64 + 1n)).toThrow(/insufficient/)
  })
})

describe('legacy holder/FT modules are gone', () => {
  it.each(['ftSelect.ts', 'ftCandidates.ts', 'unlock.ts', 'ftChange.ts', 'ftCandidatesBeef.test.ts'])('src/%s does not exist', f => {
    expect(existsSync(new URL(`../${f}`, import.meta.url))).toBe(false)
  })
})

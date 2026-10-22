// app/src/lib/mandala/banking.test.ts
import { it, expect } from 'vitest'
import { reconcile, bankBalance, makeTransfer, randomLetter } from './banking.js'

it('bank balance nets deposits minus withdrawals', () => {
  expect(bankBalance([100n, 50n], [30n])).toBe(120n)
})
it('reconciles with no drift when issued-redeemed equals bank balance', () => {
  const r = reconcile({ deposits: [100n], withdrawals: [40n], issued: 100n, redeemed: 40n })
  expect(r).toEqual({ bankBalance: 60n, netSupply: 60n, drift: 0n })
})
it('a redeem with no bank withdrawal does NOT flag drift only if modeled as a withdrawal', () => {
  const r = reconcile({ deposits: [100n], withdrawals: [], issued: 100n, redeemed: 40n })
  expect(r.drift).toBe(40n) // bank 100 vs supply 60 -> 40 drift until a withdrawal is recorded
})

it('bank balance and reconcile stay exact above 2^64', () => {
  const max = (1n << 64n) - 1n
  expect(bankBalance([max, max], [1n])).toBe(2n * max - 1n)
  const r = reconcile({ deposits: [max, max], withdrawals: [], issued: max * 2n, redeemed: 1n })
  expect(r).toEqual({ bankBalance: 2n * max, netSupply: 2n * max - 1n, drift: 1n })
  expect(bankBalance([], [])).toBe(0n)
})

it('randomLetter picks deterministically from the injected RNG', () => {
  expect(randomLetter(() => 0)).toBe('A')
  expect(randomLetter(() => 0.999999)).toBe('Z')
})

it('makeTransfer always names the counterparty "Company {letter}"', () => {
  const t = makeTransfer(500n, 'in', 'asset.0', { now: () => 1_780_000_000_000, random: () => 0 })
  expect(t.originator).toBe('Company A')
  expect(t.amount).toBe(500n)
  expect(t.direction).toBe('in')
  expect(t.assetId).toBe('asset.0')
  expect(t.timestamp).toBe(1_780_000_000_000)
})

it('makeTransfer records the requested direction', () => {
  const t = makeTransfer(500n, 'out', 'asset.0', { now: () => 1, random: () => 0 })
  expect(t.direction).toBe('out')
})

it('makeTransfer ids are unique across different timestamps', () => {
  const a = makeTransfer(10n, 'in', 'asset.0', { now: () => 1, random: () => 0 })
  const b = makeTransfer(10n, 'in', 'asset.0', { now: () => 2, random: () => 0 })
  expect(a.id).not.toBe(b.id)
})

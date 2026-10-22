// app/src/lib/mandala/banking.ts
export type TransferDirection = 'in' | 'out'

export interface MockTransfer { id: string, assetId: string, amount: bigint, direction: TransferDirection, originator: string, timestamp: number }

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Picks a random uppercase letter A-Z via the given RNG (defaults to Math.random). */
export function randomLetter(random: () => number = Math.random): string {
  return LETTERS[Math.floor(random() * LETTERS.length)]
}

/**
 * Builds a demo bank transfer (incoming deposit or outgoing withdrawal) for a
 * given asset. The counterparty is always a synthetic "Company {letter}" —
 * this is a sandbox feed standing in for a real bank/Plaid integration, not
 * real originator data, so it must not look like one.
 */
export function makeTransfer(
  amount: bigint,
  direction: TransferDirection,
  assetId: string,
  opts: { now?: () => number, random?: () => number } = {}
): MockTransfer {
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  const ts = now()
  return {
    id: `BR-${ts.toString(36).toUpperCase().slice(-6)}`,
    assetId,
    amount,
    direction,
    originator: `Company ${randomLetter(random)}`,
    timestamp: ts
  }
}

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n)

/** Exact bigint bank balance (deposits − withdrawals), unbounded. */
export const bankBalance = (deposits: bigint[], withdrawals: bigint[]): bigint =>
  sum(deposits) - sum(withdrawals)

export function reconcile (p: { deposits: bigint[], withdrawals: bigint[], issued: bigint, redeemed: bigint }): { bankBalance: bigint, netSupply: bigint, drift: bigint } {
  const bal = bankBalance(p.deposits, p.withdrawals)
  const netSupply = p.issued - p.redeemed
  return { bankBalance: bal, netSupply, drift: bal - netSupply }
}


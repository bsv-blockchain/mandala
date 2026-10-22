/**
 * Treasury coin selection: picks the issuer's own value coins of one asset
 * (Mandala keys, `mandala treasury` basket) to cover a token amount.
 *
 * Mirrors the wallet-toolbox change-allocation strategy
 * (StorageKnex.allocateChangeInput / generateChange) but selects on the token
 * amount carried by each 1Color value output rather than on satoshis:
 *
 *   Prefer CONFIRMED outputs entirely; only dip into unconfirmed ones when the
 *   confirmed balance cannot cover the target. Within a pool, allocate one input
 *   at a time against the remaining target:
 *     1. exact match  — an output whose amount equals the remainder (oldest first)
 *     2. overfund least — the smallest output ≥ the remainder (oldest first);
 *                          taking it satisfies the target in a single UTXO
 *     3. largest below — the largest output < the remainder (newest first), then
 *                          loop for the rest
 *   This keeps the input count low (a single covering output wins) and spends
 *   confirmed, older coins first.
 *
 * Amounts are exact `bigint` (each 0..2^64-1); totals are unbounded, so a
 * selection may exceed 2^64 exactly.
 */

export interface TreasuryCandidate {
  outpoint: string
  /** Exact uint64 token amount of the coin. */
  amount: bigint
  keyID: string
  counterparty: string
  /** True only when the creating action is known to be completed; absent or false = unconfirmed. */
  confirmed?: boolean
  /**
   * Relative age rank, lower = older (derived from listActions position by the
   * loader). Extension over the contract shape; absent ⇒ the candidate's
   * position in the input array.
   */
  order?: number
}

export interface TreasurySelection {
  selected: TreasuryCandidate[]
  total: bigint
}

interface Ranked { c: TreasuryCandidate, rank: number }

// Index of the oldest output whose amount exactly equals `remaining`.
function exactIndex (pool: Ranked[], remaining: bigint): number {
  let best = -1
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].c.amount !== remaining) continue
    if (best < 0 || pool[i].rank < pool[best].rank) best = i
  }
  return best
}

// Index of the smallest output ≥ `remaining` (overfund by the least); ties → oldest.
function overfundIndex (pool: Ranked[], remaining: bigint): number {
  let best = -1
  for (let i = 0; i < pool.length; i++) {
    const r = pool[i]
    if (r.c.amount < remaining) continue
    if (best < 0 || r.c.amount < pool[best].c.amount ||
      (r.c.amount === pool[best].c.amount && r.rank < pool[best].rank)) {
      best = i
    }
  }
  return best
}

// Index of the largest output < `remaining`; ties → newest (mirrors outputId desc).
function largestBelowIndex (pool: Ranked[], remaining: bigint): number {
  let best = -1
  for (let i = 0; i < pool.length; i++) {
    const r = pool[i]
    if (r.c.amount >= remaining) continue
    if (best < 0 || r.c.amount > pool[best].c.amount ||
      (r.c.amount === pool[best].c.amount && r.rank > pool[best].rank)) {
      best = i
    }
  }
  return best
}

/**
 * Select treasury inputs to cover `target` units. Confirmed outputs are
 * exhausted (as needed) before any unconfirmed output is touched. Throws
 * `insufficient treasury balance` if the combined balance cannot cover it.
 */
export function selectTreasuryInputs (candidates: TreasuryCandidate[], target: bigint): TreasurySelection {
  if (typeof target !== 'bigint') throw new TypeError('selectTreasuryInputs: target must be a bigint')
  for (const c of candidates) {
    if (typeof c.amount !== 'bigint') throw new TypeError(`selectTreasuryInputs: amount of ${c.outpoint} must be a bigint`)
  }
  const selected: TreasuryCandidate[] = []
  let total = 0n
  if (target <= 0n) return { selected, total }

  const ranked: Ranked[] = candidates.map((c, i) => ({ c, rank: c.order ?? i }))
  const allocateFrom = (pool: Ranked[]): void => {
    const avail = [...pool]
    while (total < target && avail.length > 0) {
      const remaining = target - total
      let idx = exactIndex(avail, remaining)
      if (idx < 0) idx = overfundIndex(avail, remaining)
      if (idx < 0) idx = largestBelowIndex(avail, remaining)
      if (idx < 0) break
      const [chosen] = avail.splice(idx, 1)
      selected.push(chosen.c)
      total += chosen.c.amount
    }
  }

  allocateFrom(ranked.filter(r => r.c.confirmed === true))
  if (total < target) allocateFrom(ranked.filter(r => r.c.confirmed !== true))

  if (total < target) {
    const have = candidates.reduce((sum, c) => sum + c.amount, 0n)
    throw new Error(`insufficient treasury balance: need ${target}, have ${have} across ${candidates.length} spendable output(s)`)
  }
  return { selected, total }
}

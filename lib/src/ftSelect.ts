/**
 * Token-aware UTXO (coin) selection.
 *
 * Mirrors the wallet-toolbox change-allocation strategy
 * (StorageKnex.allocateChangeInput / generateChange) but selects on the token
 * amount carried by each FT output rather than on satoshis:
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
 * `order` is a relative age rank (lower = older), derived from listActions
 * position by the loader. Ties in step 3 take the newest to mirror the toolbox's
 * `orderBy outputId desc`.
 */

export interface FtCandidate {
  outpoint: string
  amount: number
  keyID: string
  counterparty: string
  confirmed: boolean
  /** Relative age rank; lower = older. */
  order: number
}

export interface FtSelection {
  selected: FtCandidate[]
  total: number
}

// Index of the oldest output whose amount exactly equals `remaining`.
function exactIndex(pool: FtCandidate[], remaining: number): number {
  let best = -1
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].amount !== remaining) continue
    if (best < 0 || pool[i].order < pool[best].order) best = i
  }
  return best
}

// Index of the smallest output ≥ `remaining` (overfund by the least); ties → oldest.
function overfundIndex(pool: FtCandidate[], remaining: number): number {
  let best = -1
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i]
    if (c.amount < remaining) continue
    if (best < 0 || c.amount < pool[best].amount ||
      (c.amount === pool[best].amount && c.order < pool[best].order)) {
      best = i
    }
  }
  return best
}

// Index of the largest output < `remaining`; ties → newest (mirrors outputId desc).
function largestBelowIndex(pool: FtCandidate[], remaining: number): number {
  let best = -1
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i]
    if (c.amount >= remaining) continue
    if (best < 0 || c.amount > pool[best].amount ||
      (c.amount === pool[best].amount && c.order > pool[best].order)) {
      best = i
    }
  }
  return best
}

/**
 * Select FT inputs to cover `target` units. Confirmed outputs are exhausted (as
 * needed) before any unconfirmed output is touched. Throws if the combined
 * balance is insufficient.
 */
export function selectFtInputs(candidates: FtCandidate[], target: number): FtSelection {
  const selected: FtCandidate[] = []
  let total = 0
  if (target <= 0) return { selected, total }

  const allocateFrom = (pool: FtCandidate[]): void => {
    const avail = [...pool]
    while (total < target && avail.length > 0) {
      const remaining = target - total
      let idx = exactIndex(avail, remaining)
      if (idx < 0) idx = overfundIndex(avail, remaining)
      if (idx < 0) idx = largestBelowIndex(avail, remaining)
      if (idx < 0) break
      const [chosen] = avail.splice(idx, 1)
      selected.push(chosen)
      total += chosen.amount
    }
  }

  allocateFrom(candidates.filter(c => c.confirmed))
  if (total < target) allocateFrom(candidates.filter(c => !c.confirmed))

  if (total < target) {
    const have = candidates.reduce((sum, c) => sum + c.amount, 0)
    throw new Error(`insufficient token balance: need ${target}, have ${have} across ${candidates.length} spendable output(s)`)
  }
  return { selected, total }
}

import { decodeToken, isTokenId } from './brc162.js'

/** Exact (unbounded) sum of an asset's value coins. */
export interface TokenBalance { assetId: string, amount: bigint }

export const outpoint = (txid: string, index: number): string => `${txid}.${index}`

/**
 * Sum 1Color value coins per Mandala asset id (`<txid>_0`). Authority and
 * deploy coins, other remainders and non-Mandala ids are skipped. Exact bigint.
 */
export function decodeBalances (
  outputs: Array<{ lockingScript: string }>
): TokenBalance[] {
  const totals = new Map<string, bigint>()
  for (const o of outputs) {
    const d = decodeToken(o.lockingScript)
    if (d == null || d.role !== 'value' || d.assetId == null || !isTokenId(d.assetId)) continue
    totals.set(d.assetId, (totals.get(d.assetId) ?? 0n) + d.amount)
  }
  return [...totals.entries()].map(([assetId, amount]) => ({ assetId, amount }))
}

/**
 * Locate each planned locking script's final output index in a built tx.
 * createAction returns no vout mapping, and with randomized output order the
 * only reliable join is the script bytes themselves — unique keyIDs make every
 * planned script byte-unique. Unplanned outputs (wallet satoshi change) are
 * ignored; a missing or duplicated planned script throws.
 */
export function matchOutputIndices (
  tx: { outputs: Array<{ lockingScript?: { toHex: () => string } }> },
  scriptHexes: string[]
): number[] {
  const byHex = new Map<string, number>()
  tx.outputs.forEach((o, i) => {
    const hex = o.lockingScript?.toHex()
    if (hex == null) return
    if (byHex.has(hex)) byHex.set(hex, -1) // duplicate → poison
    else byHex.set(hex, i)
  })
  return scriptHexes.map(hex => {
    const idx = byHex.get(hex)
    if (idx == null) throw new Error(`planned output script not found in tx: ${hex.slice(0, 16)}…`)
    if (idx === -1) throw new Error(`ambiguous output script (duplicate) in tx: ${hex.slice(0, 16)}…`)
    return idx
  })
}

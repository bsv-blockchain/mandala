import { WalletInterface, WalletCounterparty } from '@bsv/sdk'
import { decodeValue } from './brc162.js'
import { FT_PROTOCOL, OVERLAY_IDENTITY_KEY } from './constants.js'
import { SpecificLinkage } from './encoding.js'

export interface TokenBalance { assetId: string, amount: number }

export const outpoint = (txid: string, index: number): string => `${txid}.${index}`

export function decodeBalances (
  outputs: Array<{ lockingScript: string }>
): TokenBalance[] {
  const totals = new Map<string, number>()
  for (const o of outputs) {
    const d = decodeValue(o.lockingScript)
    if (d != null) totals.set(d.tokenId, (totals.get(d.tokenId) ?? 0) + d.amount)
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

export async function revealLinkage (
  wallet: WalletInterface, keyID: string, counterparty: WalletCounterparty
): Promise<SpecificLinkage> {
  const linkage = await wallet.revealSpecificKeyLinkage({
    counterparty: counterparty as string,
    verifier: OVERLAY_IDENTITY_KEY,
    protocolID: FT_PROTOCOL,
    keyID
  })
  return linkage as unknown as SpecificLinkage
}

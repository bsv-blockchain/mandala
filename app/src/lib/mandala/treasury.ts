/**
 * Issuer treasury sums over the lib's `TREASURY_BASKET` (an ordinary BRC-100
 * basket of Mandala-key 1Color outputs). Only `value` outputs count; deploy
 * and authority outputs carry no treasury units. Exact bigint, no ceiling.
 */
import type { WalletInterface } from '@bsv/sdk'
import { TREASURY_BASKET, decodeToken } from '@bsv/mandala'
import { decodeRecord, listAllOutputs, uniqueRecords, type InventoryRecord } from './holderBalances'

/** assetId → treasury units. Never put in a query key or JSON as-is (bigint). */
export type TreasuryData = Record<string, bigint>

export function sumTreasury (records: InventoryRecord[], decode: typeof decodeToken = decodeToken): TreasuryData {
  const out: TreasuryData = {}
  for (const r of uniqueRecords(records)) {
    const d = decodeRecord(r, decode)
    if (d === null || d.role !== 'value' || typeof d.assetId !== 'string') continue
    out[d.assetId] = (out[d.assetId] ?? 0n) + d.amount
  }
  return out
}

export async function loadTreasuryBalances (wallet: Pick<WalletInterface, 'listOutputs'>): Promise<TreasuryData> {
  const outputs = await listAllOutputs(wallet, { basket: TREASURY_BASKET, include: 'locking scripts' })
  return sumTreasury(outputs)
}

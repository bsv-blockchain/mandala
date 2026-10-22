/**
 * Holder hero lines for one asset row (contract §8.1:572; plan A6).
 *
 * - `hero`: the `p color balance` view, which ALREADY includes `color_offline`
 *   available outputs; `—` when that view failed (`balance === null`).
 * - `unsettled`: the part of the hero still awaiting settlement. It is a subset
 *   of the balance, so it is only shown when the balance is known.
 * - `incoming`: `color_state_pending` value, which is NOT in the balance.
 *
 * The three figures are formatted independently and never added together.
 */
import type { AssetRow } from './loadHolderData'
import { displayAmount } from './amountDisplay'

export interface HolderLines {
  hero: string
  unsettled: string | null
  incoming: string | null
}

export const BALANCE_UNAVAILABLE = '—'

export function holderLines (
  row: Pick<AssetRow, 'balance' | 'unsettled' | 'incoming'>,
  dec: number
): HolderLines {
  const known = row.balance !== null
  return {
    hero: row.balance === null ? BALANCE_UNAVAILABLE : displayAmount(row.balance, dec),
    unsettled: known && row.unsettled > 0n
      ? `of which awaiting settlement: ${displayAmount(row.unsettled, dec)}`
      : null,
    incoming: row.incoming > 0n ? `Incoming: ${displayAmount(row.incoming, dec)}` : null
  }
}

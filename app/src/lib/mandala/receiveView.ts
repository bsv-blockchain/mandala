// Pure presentation of hand-overs received through the wallet's BRC-207 module
// (`receiveHandovers`). Amounts stay bigint end to end; the only formatting is
// the exact grouped decimal from `displayAmount`.
//
// An `offline: true` credit is a `color_offline` available output: it is already
// counted in the `p color balance` view, but it is not settled yet. That is the
// same "of which awaiting settlement" state HolderHome shows (Task 5, A6).
import type { ReceiveResult } from '@bsv/mandala'
import type { AssetMeta } from './loadHolderData'
import { displayAmount } from './amountDisplay'

export interface ReceivedView {
  key: string
  label: string
  amountText: string
  title: string
  pending: boolean
}

type Accepted = Pick<ReceiveResult['accepted'][number], 'messageId' | 'assetId' | 'amount' | 'offline'>
type Failed = Pick<ReceiveResult['failed'][number], 'error' | 'code'>

/** `dec` is an integer 0..18 (0162:246-252); anything else displays as 0, as in loadHolderData. */
function decimalsOf (d: number | undefined): number {
  return typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 18 ? d : 0
}

export function describeAccepted (a: Accepted, metas: Record<string, AssetMeta>): ReceivedView {
  const meta = metas[a.assetId]
  const label = meta?.label != null && meta.label !== '' ? meta.label : a.assetId.slice(0, 10) + '…'
  return {
    key: a.messageId,
    label,
    amountText: '+' + displayAmount(a.amount, decimalsOf(meta?.decimals)),
    title: a.offline ? 'Tokens received — awaiting settlement' : 'Tokens received',
    pending: a.offline
  }
}

/** The error message, with the overlay/receive code appended unless the message already carries it. */
export function describeFailed (f: Failed): string {
  const base = f.error instanceof Error && f.error.message !== '' ? f.error.message : 'Unexpected error'
  if (f.code == null || f.code === '' || base.includes(`(${f.code}`)) return base
  return `${base} (${f.code})`
}

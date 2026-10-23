/**
 * The B7 required-profile handler surface the Mandala issuer-v1 handler
 * implements (design §9 B7; `@bsv/color-permission-module` after the B7
 * rework). Declared here structurally because the vendored module tarball
 * (0.2.0 at ts-stack 4fa68e7) still ships the pre-B7 `admitReceipt(ctx,
 * ReceiptGraph)` signature. Re-verify against the module's exported
 * `RequiredProfileHandler` once the B7 tarball is vendored, and replace this
 * file with a type import if they agree.
 */
import type { Transaction } from '@bsv/sdk'
import type { ProfileAssetContext, RequiredProfileHandler } from '@bsv/color-permission-module'

/** What the module hands `admitReceipt` for every receipt of a profiled asset (B7). */
export interface ProfileReceiptView {
  assetId: string
  txid: string
  outputIndex: number
  tx: Transaction
  /** AtomicBEEF of `tx`. */
  beef: number[]
}

/** `'pending'` ⇒ the module tags the output `color_offline` (pending balance) until the host's `markSettled(txid)`. */
export interface ProfileReceiptCredit { credit: 'settled' | 'pending' }

/**
 * The B7 handler: the pre-B7 hooks minus the evidence carriers
 * (`maxReceiptBytes`, `checkReceiptData`), with the B7 `admitReceipt`.
 */
export type B7RequiredProfileHandler = Omit<RequiredProfileHandler, 'admitReceipt' | 'maxReceiptBytes' | 'checkReceiptData'> & {
  admitReceipt: (ctx: ProfileAssetContext, receipt: ProfileReceiptView) => Promise<ProfileReceiptCredit>
}

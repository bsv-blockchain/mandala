/**
 * Per-asset `feeRatePerKb` (token-fee design §2): token base units per 1000
 * bytes the issuer charges for issuer-paid network fees. `null` disables.
 * Set at register (issuerOps.ts) or later through the admin chain here.
 */
import type { WalletInterface } from '@bsv/sdk'
import type { MandalaActionDetails } from '@bsv/templates'
import { submitAdminAction, type AdminAsset, type SubmitAdminActionResult } from './assets.js'

export function assertFeeRate (v: unknown): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
    throw new Error('feeRatePerKb must be a safe integer ≥ 1 (base units per KB)')
  }
}

export interface SetFeeRateParams {
  wallet: WalletInterface
  asset: AdminAsset
  identityKey: string
  /** `null` disables issuer-paid fees for the asset. */
  feeRatePerKb: number | null
  messageBoxClient?: any
}

/**
 * Spend the asset's admin-auth head with `{ kind: 'setFeeRate' }`. Anchoring,
 * next-auth output, journaling and σ_I handling are submitAdminAction's.
 */
export async function setFeeRate (p: SetFeeRateParams): Promise<SubmitAdminActionResult> {
  if (p.feeRatePerKb !== null) assertFeeRate(p.feeRatePerKb)
  // 'setFeeRate' is not yet in the pinned MandalaActionKind union (ts-stack
  // PR pending); both overlays admit any anchored kind and fold this one.
  const details = {
    kind: 'setFeeRate',
    assetId: p.asset.assetId,
    priorOutpoint: p.asset.authOutpoint,
    feeRatePerKb: p.feeRatePerKb
  } as unknown as MandalaActionDetails
  return await submitAdminAction({
    wallet: p.wallet,
    asset: p.asset,
    identityKey: p.identityKey,
    messageBoxClient: p.messageBoxClient,
    details
  })
}

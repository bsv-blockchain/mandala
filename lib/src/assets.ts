import { Utils, WalletInterface } from '@bsv/sdk'
import { TREASURY_BASKET } from './constants.js'
import { MandalaActionDetails } from './brc162.js'
import { outpoint } from './tokens.js'
import { AdmissionReceipt, admissionReceipt } from './overlay.js'
import { withAdminAuthGate, withAdminAuthGates, assertSpendablePrior } from './adminAuthGate.js'
import { withIntent } from './txJournal.js'
import { runAuthorityTx } from './authority.js'

const DESCRIPTION_MIN = 5
const DESCRIPTION_MAX = 50
const ELLIPSIS = '…'
const utf8Length = (s: string): number => Utils.toArray(s, 'utf8').length

/**
 * A BRC-100 action description from free text. The wallet validates
 * `description` as 5..50 UTF-8 *bytes* (sdk validateStringLength), and a
 * label is up to 64 code points that may be multibyte, so every lib-built
 * createAction/internalizeAction description goes through here. Trims; over
 * 50 bytes it cuts whole code points from the end and appends `…` inside the
 * limit; under 5 bytes it pads with '.'. Only the tail is ever cut, so a
 * fixed prefix such as `Redeem <amount>` (≤ 27 bytes at 2^64-1) survives.
 */
export function actionDescription (text: string): string {
  let s = String(text).trim()
  if (utf8Length(s) > DESCRIPTION_MAX) {
    const budget = DESCRIPTION_MAX - utf8Length(ELLIPSIS)
    let head = ''
    let used = 0
    for (const cp of s) {
      const n = utf8Length(cp)
      if (used + n > budget) break
      head += cp
      used += n
    }
    s = head.trimEnd() + ELLIPSIS
  }
  while (utf8Length(s) < DESCRIPTION_MIN) s += '.'
  return s
}

// Admin auth bookkeeping lives in the authority output's customInstructions,
// so the wallet basket is the single source of truth. The live authority UTXO
// for an asset carries everything needed to spend it next: the token id, a
// human label, and the keyID its key derives under (the commitment hex, or
// 'deploy' — recomputable from the output itself, see brc162 authorityKeyIdOf).
const ADMIN_CI_TYPE = 'mandala-admin'

export interface AdminAsset {
  /** BRC-162 token id `<deployTxid>_0`. */
  assetId: string
  label: string
  authOutpoint: string
  /** keyID of the live authority coin (ADMIN_PROTOCOL, counterparty = issuer identity key). */
  authKeyID: string
  metadata?: Record<string, unknown>
}

interface AdminCI {
  type: typeof ADMIN_CI_TYPE
  assetId: string
  label: string
  authKeyID: string
  metadata?: Record<string, unknown>
}

export function adminCustomInstructions (
  assetId: string, label: string, authKeyID: string, metadata?: Record<string, unknown>
): string {
  return JSON.stringify({ type: ADMIN_CI_TYPE, assetId, label, authKeyID, metadata } satisfies AdminCI)
}

export function parseAdminCI (ci: string | null | undefined): AdminCI | null {
  if (ci == null) return null
  try {
    const parsed = JSON.parse(ci)
    return parsed?.type === ADMIN_CI_TYPE && typeof parsed.authKeyID === 'string' ? parsed as AdminCI : null
  } catch {
    return null
  }
}

/** Attach an optional admin-action reason (omitted when empty). */
export function withReason<T extends object> (details: T, reason?: string): T {
  const r = reason?.trim()
  return r ? { ...details, reason: r } : details
}

/**
 * Attach the deposit-record hash (R12) as `bankRef` — 64 lowercase hex
 * (32 bytes on chain). Omitted when empty.
 */
export function withBankRef<T extends object> (details: T, bankRef?: string): T {
  const r = bankRef?.trim().toLowerCase()
  return r ? { ...details, bankRef: r } : details
}

// Map a wallet output (with customInstructions) to an AdminAsset, or null if it
// is not a mandala authority output.
export function adminAssetFromOutput (
  o: { outpoint: string, customInstructions?: string }
): AdminAsset | null {
  const ci = parseAdminCI(o.customInstructions)
  if (ci == null) return null
  // The deploy output can't store its own token id (it is `<its txid>_0`,
  // unknown when the CI is written), so it leaves assetId empty.
  const assetId = ci.assetId !== '' ? ci.assetId : `${o.outpoint.slice(0, o.outpoint.lastIndexOf('.'))}_0`
  return { assetId, label: ci.label, authOutpoint: o.outpoint, authKeyID: ci.authKeyID, metadata: ci.metadata }
}

// List the issuer's live admin assets straight from the wallet basket.
export async function listAdminAssets (wallet: WalletInterface): Promise<AdminAsset[]> {
  const res = await wallet.listOutputs({
    basket: TREASURY_BASKET,
    includeCustomInstructions: true,
    limit: 1000
  })
  return res.outputs
    .map(o => adminAssetFromOutput(o as { outpoint: string, customInstructions?: string }))
    .filter((a): a is AdminAsset => a != null)
}

// ---------------------------------------------------------------------------
// Orchestrators — sign + submit.
// ---------------------------------------------------------------------------

export interface SubmitAdminActionParams {
  wallet: WalletInterface
  asset: AdminAsset
  details: MandalaActionDetails
  /**
   * For reissue: the recipient + exact amount for the value output (the
   * amount must equal the frozen row's; details must carry {outpoint,
   * recipient}). Refused until the payout path builds the recipient's
   * `p color` output and BRC-207 receipt (plan 04 Task 12).
   */
  ftOutput?: { recipient: string, amount: bigint }
  messageBoxClient?: any
  identityKey: string
}

export interface SubmitAdminActionResult extends AdmissionReceipt {
  txid: string
  nextAuthOutpoint: string
  /** keyID of the new authority coin. */
  nextAuthKeyID: string
  /**
   * False when the action committed but a recipient notification is still
   * pending (journaled, retried by reconcileNotifications); the action itself
   * must never be reported as failed or retried. Always true while no admin
   * action carries a recipient output (reissue goes through the payout path).
   */
  notified: boolean
}

async function spendableBeef (wallet: WalletInterface, priors: string[]): Promise<number[]> {
  const list = await wallet.listOutputs({ basket: TREASURY_BASKET, include: 'entire transactions', limit: 1000 })
  if (list.BEEF == null) throw new Error('listOutputs returned no BEEF')
  // Fail fast on a stale auth reference (e.g. spent by a half-failed earlier
  // action) instead of building a doomed tx that dies with a cryptic wallet error.
  const spendable = list.outputs.map(o => o.outpoint)
  for (const p of priors) assertSpendablePrior(p, spendable)
  return list.BEEF as number[]
}

/** Thrown for a reissue until the payout path builds its recipient output (Task 12). */
export const REISSUE_VIA_PAYOUT = 'reissue builds its recipient output through the payout path'

/**
 * Spend the asset's live authority, producing the next authority. Submits to
 * exactly tm_color_<assetId>. A reissue (an `ftOutput`, or `details.kind ===
 * 'reissue'`) is refused before any gate or wallet call: its recipient output
 * must be a holder `p color` output with a BRC-207 receipt, which only the
 * payout path builds.
 */
export async function submitAdminAction (
  p: SubmitAdminActionParams
): Promise<SubmitAdminActionResult> {
  const { wallet, asset, details, ftOutput, identityKey } = p
  if (ftOutput != null || details.kind === 'reissue') throw new Error(REISSUE_VIA_PAYOUT)

  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const inputBEEF = await spendableBeef(wallet, [asset.authOutpoint])
    const res = await runAuthorityTx({
      wallet,
      identityKey,
      legs: [{
        prior: { tokenId: asset.assetId, outpoint: asset.authOutpoint, keyID: asset.authKeyID },
        details,
        customInstructions: keyID => adminCustomInstructions(asset.assetId, asset.label, keyID, asset.metadata)
      }],
      inputBEEF,
      description: actionDescription(`${details.kind} ${asset.label}`),
      labels: ['mandala', details.kind]
    })
    return {
      txid: res.txid,
      nextAuthOutpoint: outpoint(res.txid, res.authIndices[0]),
      nextAuthKeyID: res.authKeyIDs[0],
      notified: true,
      ...admissionReceipt(res.admitted)
    }
  }))
}

/**
 * Fan-out variant: spend N authorities in a single tx, producing N next
 * authorities. Used for global pause/unpause/setAccessMode etc. Names every
 * token's topic.
 */
export interface GlobalAdminActionResult extends AdmissionReceipt {
  txid: string
}

export async function submitGlobalAdminAction (p: {
  wallet: WalletInterface
  assets: AdminAsset[]
  detailsFor: (a: AdminAsset) => MandalaActionDetails
  identityKey: string
}): Promise<GlobalAdminActionResult> {
  const { wallet, assets } = p
  if (assets.length === 0) throw new Error('submitGlobalAdminAction: assets list is empty')

  const claims = assets.map(a => ({ assetId: a.assetId, priorOutpoint: a.authOutpoint }))
  return withAdminAuthGates(claims, async () => await withIntent(async () => {
    const inputBEEF = await spendableBeef(wallet, assets.map(a => a.authOutpoint))
    const details = assets.map(p.detailsFor)
    const res = await runAuthorityTx({
      wallet,
      identityKey: p.identityKey,
      legs: assets.map((a, i) => ({
        prior: { tokenId: a.assetId, outpoint: a.authOutpoint, keyID: a.authKeyID },
        details: details[i],
        customInstructions: keyID => adminCustomInstructions(a.assetId, a.label, keyID, a.metadata)
      })),
      inputBEEF,
      description: actionDescription(`global ${details[0]?.kind ?? 'admin'} (${assets.length} assets)`),
      labels: ['mandala', details[0]?.kind ?? 'admin']
    })
    return { txid: res.txid, ...admissionReceipt(res.admitted) }
  }))
}

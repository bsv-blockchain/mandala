import { WalletInterface } from '@bsv/sdk'
import { BASKET, MESSAGEBOX, FT_PROTOCOL } from './constants.js'
import { MandalaActionDetails } from './brc162.js'
import { outpoint } from './tokens.js'
import { AdmissionReceipt, admissionReceipt } from './overlay.js'
import { withAdminAuthGate, withAdminAuthGates, assertSpendablePrior } from './adminAuthGate.js'
import { withIntent } from './txJournal.js'
import { notifyPut, notifyRemove, PendingNotification } from './notifyJournal.js'
import { runAuthorityTx } from './authority.js'

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
  /** keyID of the live authority coin (FT_PROTOCOL, counterparty = issuer identity key). */
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
    basket: BASKET,
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
   * For reissue: the recipient + amount for the value output (the amount must
   * equal the frozen row's; details must carry {outpoint, recipient}).
   */
  ftOutput?: { recipient: string, amount: number }
  messageBoxClient?: any
  identityKey: string
}

export interface SubmitAdminActionResult extends AdmissionReceipt {
  txid: string
  nextAuthOutpoint: string
  /** keyID of the new authority coin. */
  nextAuthKeyID: string
  /**
   * False when the action committed but the reissue recipient's MessageBox
   * notification did not go out (no client, or the send failed). The
   * notification is journaled and retried by reconcileNotifications; the
   * action itself must never be reported as failed or retried.
   */
  notified: boolean
}

async function spendableBeef (wallet: WalletInterface, priors: string[]): Promise<number[]> {
  const list = await wallet.listOutputs({ basket: BASKET, include: 'entire transactions', limit: 1000 })
  if (list.BEEF == null) throw new Error('listOutputs returned no BEEF')
  // Fail fast on a stale auth reference (e.g. spent by a half-failed earlier
  // action) instead of building a doomed tx that dies with a cryptic wallet error.
  const spendable = list.outputs.map(o => o.outpoint)
  for (const p of priors) assertSpendablePrior(p, spendable)
  return list.BEEF as number[]
}

/**
 * Spend the asset's live authority, producing the next authority (and, for a
 * reissue, a value output to the recipient). Submits to tm_<tokenId>.
 */
export async function submitAdminAction (
  p: SubmitAdminActionParams
): Promise<SubmitAdminActionResult> {
  const { wallet, asset, details, ftOutput, messageBoxClient, identityKey } = p

  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const inputBEEF = await spendableBeef(wallet, [asset.authOutpoint])
    const ftKeyID = ftOutput != null ? 'reissue-' + Date.now() : ''
    const res = await runAuthorityTx({
      wallet,
      identityKey,
      legs: [{
        prior: { tokenId: asset.assetId, outpoint: asset.authOutpoint, keyID: asset.authKeyID },
        details,
        customInstructions: keyID => adminCustomInstructions(asset.assetId, asset.label, keyID, asset.metadata)
      }],
      valueOuts: ftOutput != null
        ? [{ tokenId: asset.assetId, amount: ftOutput.amount, owner: ftOutput.recipient, keyID: ftKeyID, outputDescription: 'reissued FT' }]
        : [],
      inputBEEF,
      description: `${details.kind} ${asset.label}`,
      labels: ['mandala', details.kind]
    })

    // The reissue is committed (overlay accepted); a notify failure must not
    // undo it. Journal the notification FIRST so a crash or send failure is
    // retried by reconcileNotifications.
    let notified = true
    if (ftOutput != null) {
      const notification: PendingNotification = {
        txid: res.txid,
        recipient: ftOutput.recipient,
        messageBox: MESSAGEBOX,
        body: {
          assetId: asset.assetId,
          amount: ftOutput.amount,
          transaction: res.tx,
          keyID: ftKeyID,
          outputIndex: res.valueIndices[0],
          protocolID: FT_PROTOCOL,
          // Issuer remittances are not blinded — the recipient derives
          // against the issuer identity key directly.
          sender: identityKey,
          senderMode: 'unblinded'
        },
        at: Date.now()
      }
      await notifyPut(notification)
      if (messageBoxClient == null) {
        console.warn('[mandala] reissue committed with no MessageBox client; recipient notify journaled for reconcileNotifications')
        notified = false
      } else {
        try {
          await messageBoxClient.sendMessage({
            recipient: notification.recipient,
            messageBox: notification.messageBox,
            body: notification.body
          })
          await notifyRemove(res.txid)
        } catch (e) {
          console.warn('[mandala] reissue committed but recipient notify failed; will retry via reconcileNotifications:', e)
          notified = false
        }
      }
    }

    return {
      txid: res.txid,
      nextAuthOutpoint: outpoint(res.txid, res.authIndices[0]),
      nextAuthKeyID: res.authKeyIDs[0],
      notified,
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
      description: `global ${details[0]?.kind ?? 'admin'} (${assets.length} assets)`,
      labels: ['mandala', details[0]?.kind ?? 'admin']
    })
    return { txid: res.txid, ...admissionReceipt(res.admitted) }
  }))
}

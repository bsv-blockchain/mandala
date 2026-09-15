import { Transaction, WalletInterface } from '@bsv/sdk'
import { MandalaAdmin, MandalaToken, MandalaActionDetails } from '@bsv/templates'
import { BASKET, FT_PROTOCOL, MESSAGEBOX } from './constants.js'
import { encodeLinkagePayload } from './encoding.js'
import { revealLinkage, outpoint } from './tokens.js'
import { AdmissionReceipt, admissionReceipt, submitAndBroadcast } from './overlay.js'
import { withAdminAuthGate, withAdminAuthGates, assertSpendablePrior } from './adminAuthGate.js'
import { withIntent } from './txJournal.js'
import { notifyPut, notifyRemove, PendingNotification } from './notifyJournal.js'

// Admin auth bookkeeping lives in the admin output's customInstructions, so the
// wallet basket is the single source of truth — no localStorage, no on-chain
// marker. The live admin auth UTXO for an asset carries everything needed to
// spend it next: the assetId, a human label, and the action details whose
// commitment derives the locking key.
const ADMIN_CI_TYPE = 'mandala-admin'

export interface AdminAsset {
  assetId: string
  label: string
  authOutpoint: string
  authDetails: MandalaActionDetails
  metadata?: Record<string, unknown>
}

interface AdminCI {
  type: typeof ADMIN_CI_TYPE
  assetId: string
  label: string
  authDetails: MandalaActionDetails
  metadata?: Record<string, unknown>
}

export function adminCustomInstructions (
  assetId: string, label: string, authDetails: MandalaActionDetails, metadata?: Record<string, unknown>
): string {
  return JSON.stringify({ type: ADMIN_CI_TYPE, assetId, label, authDetails, metadata } satisfies AdminCI)
}

export function parseAdminCI (ci: string | null | undefined): AdminCI | null {
  if (ci == null) return null
  try {
    const parsed = JSON.parse(ci)
    return parsed?.type === ADMIN_CI_TYPE ? parsed as AdminCI : null
  } catch {
    return null
  }
}

/**
 * Attach an optional admin-action reason. Omits the key when empty so the
 * commitment for reason-less actions is byte-identical to before this feature —
 * the admin locking key derives from Commitment(details), and an extra key would
 * change it.
 */
export function withReason<T extends Record<string, unknown>> (details: T, reason?: string): T {
  const r = reason?.trim()
  return r ? { ...details, reason: r } : details
}

/**
 * Attach the deposit-record hash (R12 "commits a hash of the deposit record")
 * as `bankRef`. Same omit-when-empty discipline as withReason: a ref-less
 * issue keeps the commitment it always had, so existing auth chains stay
 * spendable.
 */
export function withBankRef<T extends Record<string, unknown>> (details: T, bankRef?: string): T {
  const r = bankRef?.trim()
  return r ? { ...details, bankRef: r } : details
}

/**
 * On-chain marker pushed-and-dropped in front of every admin-auth P2PKH
 * (R23). Without it the output is a bare 5-chunk P2PKH — the exact shape
 * wallets reclassify as vanilla P2PKH and strip customInstructions from,
 * after which listAdminAssets returns nothing and every admin operation for
 * the asset becomes impossible (runbook failure 3). MandalaAdmin.commitment
 * does not cover publicData, so the marker changes no locking key.
 */
export function adminMarker (assetId: string): { t: typeof ADMIN_CI_TYPE, assetId: string } {
  return { t: ADMIN_CI_TYPE, assetId }
}

// Map a wallet output (with customInstructions) to an AdminAsset, or null if it
// is not a mandala admin auth output.
export function adminAssetFromOutput (
  o: { outpoint: string, customInstructions?: string }
): AdminAsset | null {
  const ci = parseAdminCI(o.customInstructions)
  if (ci == null) return null
  // The genesis/register output can't store its own assetId (the assetId IS its
  // outpoint, unknown when the CI is written), so it leaves assetId empty. For that
  // output assetId === its own outpoint. Subsequent auth outputs carry the real assetId.
  const assetId = ci.assetId !== '' ? ci.assetId : o.outpoint
  return { assetId, label: ci.label, authOutpoint: o.outpoint, authDetails: ci.authDetails, metadata: ci.metadata }
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
// Pure arg-builder helpers — unit-testable without wallet/signing machinery.
// These construct the `createAction` args object; the orchestrators below
// handle locking-script derivation, signing, and overlay submission.
// ---------------------------------------------------------------------------

interface FtOutputSpec {
  lockingScript: string
  amount: number
  recipient: string
}

interface CreateActionArgs {
  description: string
  labels: string[]
  inputBEEF?: number[]
  inputs: Array<{ outpoint: string, unlockingScriptLength: number, inputDescription: string }>
  outputs: Array<{ satoshis: number, lockingScript: string, outputDescription: string, basket?: string, customInstructions?: string }>
  options?: { randomizeOutputs: boolean }
}

/**
 * Pure function: given an asset + action details + a pre-computed auth locking
 * script hex (and optional FT output spec for reissue), returns the
 * `createAction` args object. No I/O — fully unit-testable.
 *
 * Output ordering:
 *   - Without FT: [authOutput]          → authIndex = 0
 *   - With FT:    [ftOutput, authOutput] → authIndex = 1
 */
export function buildAdminActionArgs (
  asset: AdminAsset,
  details: MandalaActionDetails,
  authLockHex: string,
  ftOutput?: FtOutputSpec
): CreateActionArgs {
  const outputs: CreateActionArgs['outputs'] = []

  if (ftOutput != null) {
    outputs.push({
      satoshis: 1,
      lockingScript: ftOutput.lockingScript,
      outputDescription: 'reissued FT'
    })
  }

  const authIndex = ftOutput != null ? 1 : 0
  outputs.push({
    satoshis: 1,
    lockingScript: authLockHex,
    outputDescription: `${details.kind} auth`,
    basket: BASKET,
    customInstructions: adminCustomInstructions(asset.assetId, asset.label, details, asset.metadata)
  })
  // authIndex is used below by the orchestrator — suppress unused-var lint
  void authIndex

  return {
    description: `${details.kind} ${asset.label}`,
    labels: ['mandala', details.kind],
    inputs: [{
      outpoint: asset.authOutpoint,
      unlockingScriptLength: 108,
      inputDescription: 'spend prior admin auth'
    }],
    outputs,
    options: { randomizeOutputs: false }
  }
}

/**
 * Pure function: builds `createAction` args for a single tx that spends N
 * prior-auth inputs and produces N next-auth outputs (one per asset). Used by
 * `submitGlobalAdminAction`.
 */
export function buildGlobalAdminActionArgs (
  assets: AdminAsset[],
  detailsFor: (a: AdminAsset) => MandalaActionDetails,
  authLockHexes: string[]
): CreateActionArgs {
  const details = assets.map(detailsFor)
  return {
    description: `global ${details[0]?.kind ?? 'admin'} (${assets.length} assets)`,
    labels: ['mandala', details[0]?.kind ?? 'admin'],
    inputs: assets.map(a => ({
      outpoint: a.authOutpoint,
      unlockingScriptLength: 108,
      inputDescription: 'spend prior auth'
    })),
    outputs: assets.map((a, i) => ({
      satoshis: 1,
      lockingScript: authLockHexes[i],
      outputDescription: `${details[i].kind} auth`,
      basket: BASKET,
      customInstructions: adminCustomInstructions(a.assetId, a.label, details[i], a.metadata)
    })),
    options: { randomizeOutputs: false }
  }
}

// ---------------------------------------------------------------------------
// Orchestrators — sign + submit.
// ---------------------------------------------------------------------------

export interface SubmitAdminActionParams {
  wallet: WalletInterface
  asset: AdminAsset
  details: MandalaActionDetails
  /** For reissue: the recipient + amount for the FT output. */
  ftOutput?: { recipient: string, amount: number }
  messageBoxClient?: any
  identityKey: string
}

export interface SubmitAdminActionResult extends AdmissionReceipt {
  txid: string
  nextAuthOutpoint: string
  /**
   * False when the action committed but the reissue recipient's MessageBox
   * notification did not go out (no client, or the send failed). The
   * notification is journaled and retried by reconcileNotifications; the
   * action itself must never be reported as failed or retried.
   */
  notified: boolean
}

/**
 * Spend the asset's current admin auth UTXO, producing a next-auth output
 * (and optionally a reissued FT output). Submits to overlay.
 *
 * Returns { txid, nextAuthOutpoint, notified }.
 */
export async function submitAdminAction (
  p: SubmitAdminActionParams
): Promise<SubmitAdminActionResult> {
  const { wallet, asset, details, ftOutput, messageBoxClient, identityKey } = p

  // Same gate as issue/redeem — regulatory and treasury cannot share one
  // prior; the intent marker keeps the reconcile sweep away from the live
  // noSend action while the pipeline runs.
  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    // Derive next auth locking script (marker: see adminMarker).
    const nextAuthLock = await MandalaAdmin.lock({ wallet: wallet as any, data: details, publicData: adminMarker(asset.assetId) })

    // Fetch BEEF for the prior auth outpoint.
    const list = await wallet.listOutputs({ basket: BASKET, include: 'entire transactions', limit: 1000 })
    if (list.BEEF == null) throw new Error('listOutputs returned no BEEF')
    // Fail fast on a stale auth reference (e.g. spent by a half-failed earlier
    // action) instead of building a doomed tx that dies with a cryptic wallet error.
    assertSpendablePrior(asset.authOutpoint, list.outputs.map(o => o.outpoint))

    // Optionally build FT locking script for reissue.
    let ftKeyID = ''
    let ftLockHex: string | undefined
    if (ftOutput != null) {
      ftKeyID = 'reissue-' + Date.now()
      const ftLock = await new MandalaToken(wallet as any).lockBRC29(
        details.assetId as string, ftOutput.amount, FT_PROTOCOL, ftKeyID, ftOutput.recipient
      )
      ftLockHex = ftLock.toHex()
    }

    const ftSpec: FtOutputSpec | undefined = ftLockHex != null && ftOutput != null
      ? { lockingScript: ftLockHex, amount: ftOutput.amount, recipient: ftOutput.recipient }
      : undefined

    const actionArgs = buildAdminActionArgs(asset, details, nextAuthLock.toHex(), ftSpec)
    const created = await wallet.createAction({
      ...actionArgs,
      inputBEEF: list.BEEF as number[]
    })
    if (created.signableTransaction == null) throw new Error('no signableTransaction')

    // Sign the prior auth input.
    const txToSign = Transaction.fromBEEF(created.signableTransaction.tx as number[])
    txToSign.inputs[0].unlockingScriptTemplate = MandalaAdmin.unlock({ wallet: wallet as any, data: asset.authDetails })
    await txToSign.sign()

    const signed = await wallet.signAction({
      reference: created.signableTransaction.reference,
      spends: { '0': { unlockingScript: txToSign.inputs[0].unlockingScript!.toHex() } },
      options: { noSend: true } // hold — broadcast only after the overlay accepts
    })
    if (signed.tx == null || signed.txid == null) throw new Error('signAction returned no tx')

    const adminIndex = ftOutput != null ? 1 : 0
    const outLinks = ftOutput != null && ftKeyID !== ''
      ? [{ index: 0, linkage: await revealLinkage(wallet as any, ftKeyID, ftOutput.recipient) }]
      : []
    const admitted = await submitAndBroadcast(
      wallet,
      { tx: signed.tx as number[], txid: signed.txid },
      encodeLinkagePayload({ inputs: [], outputs: outLinks, admin: [{ index: adminIndex, actionDetails: details }] }),
      created.signableTransaction.reference
    )

    // The reissue is committed (overlay accepted); a notify failure must not
    // undo it — an operator retry would die on the spent prior. Journal the
    // notification FIRST so a crash or send failure is retried by
    // reconcileNotifications; duplicate delivery is safe (receive acks by
    // messageId and treats an already-internalized output as success).
    let notified = true
    if (ftOutput != null) {
      const notification: PendingNotification = {
        txid: signed.txid,
        recipient: ftOutput.recipient,
        messageBox: MESSAGEBOX,
        body: {
          assetId: details.assetId,
          amount: ftOutput.amount,
          transaction: signed.tx,
          keyID: ftKeyID,
          // randomizeOutputs is false: the reissued FT is always output 0.
          outputIndex: 0,
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
          await notifyRemove(signed.txid)
        } catch (e) {
          console.warn('[mandala] reissue committed but recipient notify failed; will retry via reconcileNotifications:', e)
          notified = false
        }
      }
    }

    return {
      txid: signed.txid,
      nextAuthOutpoint: outpoint(signed.txid, adminIndex),
      notified,
      ...admissionReceipt(admitted)
    }
  }))
}

/**
 * Fan-out variant: spend N prior-auth inputs in a single tx, producing N
 * next-auth outputs. Used for global pause/unpause/setAccessMode etc.
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

  // One tx spends N priors: hold every asset's admin-auth gate (acquired in
  // sorted assetId order — see withAdminAuthGates) so no per-asset pipeline
  // can commit on one of these priors meanwhile, and run under an intent
  // marker so the reconcile sweep leaves the live noSend action alone.
  const claims = assets.map(a => ({ assetId: a.assetId, priorOutpoint: a.authOutpoint }))
  return withAdminAuthGates(claims, async () => await withIntent(async () => {
    const list = await wallet.listOutputs({ basket: BASKET, include: 'entire transactions', limit: 1000 })
    if (list.BEEF == null) throw new Error('listOutputs returned no BEEF')
    // Every prior must still be spendable — one stale asset (spent by another
    // session) would otherwise sink the whole fan-out with a cryptic wallet error.
    const spendable = list.outputs.map(o => o.outpoint)
    for (const a of assets) assertSpendablePrior(a.authOutpoint, spendable)

    const details = assets.map(p.detailsFor)

    // Derive all next-auth locking scripts (marker: see adminMarker).
    const authLockHexes: string[] = await Promise.all(
      details.map((d, i) =>
        MandalaAdmin.lock({ wallet: wallet as any, data: d, publicData: adminMarker(assets[i].assetId) }).then(ls => ls.toHex())
      )
    )

    const actionArgs = buildGlobalAdminActionArgs(assets, p.detailsFor, authLockHexes)
    const created = await wallet.createAction({
      ...actionArgs,
      inputBEEF: list.BEEF as number[]
    })
    if (created.signableTransaction == null) throw new Error('no signableTransaction')

    // Sign each prior-auth input with its asset's stored authDetails.
    const tx = Transaction.fromBEEF(created.signableTransaction.tx as number[])
    for (let i = 0; i < assets.length; i++) {
      tx.inputs[i].unlockingScriptTemplate = MandalaAdmin.unlock({ wallet: wallet as any, data: assets[i].authDetails })
    }
    await tx.sign()

    const spends: Record<string, { unlockingScript: string }> = {}
    for (let i = 0; i < assets.length; i++) {
      spends[String(i)] = { unlockingScript: tx.inputs[i].unlockingScript!.toHex() }
    }

    const signed = await wallet.signAction({
      reference: created.signableTransaction.reference,
      spends,
      options: { noSend: true } // hold — broadcast only after the overlay accepts
    })
    if (signed.tx == null || signed.txid == null) throw new Error('signAction returned no tx')

    const admitted = await submitAndBroadcast(
      wallet,
      { tx: signed.tx as number[], txid: signed.txid },
      encodeLinkagePayload({ inputs: [], outputs: [], admin: assets.map((_, i) => ({ index: i, actionDetails: details[i] })) }),
      created.signableTransaction.reference
    )

    return { txid: signed.txid, ...admissionReceipt(admitted) }
  }))
}

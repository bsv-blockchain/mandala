import { Utils, WalletInterface } from '@bsv/sdk'
import { OVERLAY_IDENTITY_KEY, OVERLAY_IDENTITY_KEY_UNSET, TREASURY_BASKET } from './constants.js'
import { MandalaActionDetails } from './brc162.js'
import { outpoint } from './tokens.js'
import { normalizeKey } from './keys.js'
import { AdmissionReceipt, admissionReceipt, mayHaveCommitted } from './overlay.js'
import { withAdminAuthGate, withAdminAuthGates, assertSpendablePrior } from './adminAuthGate.js'
import { withIntent } from './txJournal.js'
import { notifyPutIntent, notifyRemove } from './notifyJournal.js'
import { runAuthorityTx } from './authority.js'
import { guardPositiveAmount } from './submitGuards.js'
import {
  checkRecipient, deliverIssuerReceipt, handoverBody, issuerReceipt, issuerRecipientOutput, MessageBoxSender,
  requireAttestedOutput
} from './receipt.js'

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
   * Reissue only: the recipient and exact amount of the replacement output
   * (the amount must equal the frozen row's; `details` must be
   * `{kind:'reissue', outpoint, recipient}` with the same recipient). The
   * output is the recipient's `p color` output, built through the payout
   * path, and its BRC-207 receipt is delivered through `messageBoxClient`.
   */
  ftOutput?: { recipient: string, amount: bigint }
  /** Required when `ftOutput` is set (TypeError before any wallet call otherwise). */
  messageBoxClient?: MessageBoxSender
  identityKey: string
}

export interface SubmitAdminActionResult extends AdmissionReceipt {
  txid: string
  nextAuthOutpoint: string
  /** keyID of the new authority coin. */
  nextAuthKeyID: string
  /**
   * False when a reissue committed but its recipient notification is still
   * pending (journaled, retried by reconcileNotifications); the action itself
   * must never be reported as failed or retried. Always true for an action
   * without a recipient output.
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

/**
 * Refuse a malformed reissue before any gate or wallet call: `ftOutput` and
 * `details.kind === 'reissue'` go together, the recipient must match
 * `details.recipient`, the amount must be a positive uint64, and the receipt
 * needs a MessageBox client.
 */
function checkReissue (p: SubmitAdminActionParams): string | undefined {
  const { details, ftOutput } = p
  if (ftOutput == null) {
    if (details.kind === 'reissue') throw new TypeError('@bsv/mandala: a reissue needs ftOutput { recipient, amount }')
    return
  }
  if (details.kind !== 'reissue') throw new TypeError(`@bsv/mandala: ftOutput is only valid on a reissue, not ${details.kind}`)
  if (normalizeKey(ftOutput.recipient, 'ftOutput.recipient') !== normalizeKey(details.recipient, 'details.recipient')) {
    throw new TypeError('@bsv/mandala: ftOutput.recipient must equal details.recipient (the overlay requires every reissued output to go to it)')
  }
  const gate = guardPositiveAmount(ftOutput.amount)
  if (!gate.ok) throw new Error(gate.reason)
  return checkRecipient({ identityKey: p.identityKey, recipientKey: ftOutput.recipient, messageBoxClient: p.messageBoxClient })
}

/**
 * Spend the asset's live authority, producing the next authority. Submits to
 * exactly tm_color_<assetId>.
 *
 * A reissue (`ftOutput`) also creates the recipient's `p color` output at
 * index 0 (unblinded linkage, counterparty = details.recipient) and spends
 * no value inputs (overlay reissue rule). Its deploy is fetched before any
 * coin is held; after admission the attested BRC-207 receipt is journaled
 * and delivered on MESSAGEBOX exactly like a payout (its receipt intent is
 * journaled before the submit, R6). `notified` is false when
 * the send failed (reconcileNotifications retries); the action itself is
 * committed and must never be retried. A retryable overlay refusal on a
 * reissue that proves nothing was applied (a typed 4xx) is not held
 * (holdRetryable false): the action is aborted, nothing is committed, and
 * re-running the reissue is the retry. An unknown outcome
 * (`OverlayRefusedError.outcome === 'unknown'`) keeps the action held and the
 * receipt intent journaled; do NOT re-run it, reconcile settles it. An admission
 * without an attestation for the recipient output throws a committed
 * ReceiptUnavailableError (do not retry; the authority is spent, so a stale
 * retry fails closed with StaleAdminAuthError).
 */
export async function submitAdminAction (
  p: SubmitAdminActionParams
): Promise<SubmitAdminActionResult> {
  const { wallet, asset, identityKey } = p
  // The recipient key is lowercased once here; everything below (the admin
  // details, the linkage, the receipt intent, the MessageBox address) uses it.
  const recipientKey = checkReissue(p)
  const details = recipientKey != null ? { ...p.details, recipient: recipientKey } as typeof p.details : p.details
  const ftOutput = recipientKey != null && p.ftOutput != null ? { ...p.ftOutput, recipient: recipientKey } : p.ftOutput
  if (OVERLAY_IDENTITY_KEY === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)

  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const inputBEEF = await spendableBeef(wallet, [asset.authOutpoint])
    const foreign = ftOutput != null
      ? await issuerRecipientOutput(wallet, { identityKey, recipientKey: ftOutput.recipient, assetId: asset.assetId, amount: ftOutput.amount })
      : undefined
    // R6: a reissue journals its receipt intent before the submit; any
    // failure from there to admission that released the action removes it.
    // An unknown outcome (the action is held) keeps it.
    let intentTxid: string | undefined
    const journalIntent = ftOutput != null && foreign != null
      ? async (s: { txid: string, tx: number[], offChainValues: number[], topics: string[], foreignIndices: number[] }) => {
        intentTxid = s.txid
        await notifyPutIntent(s.txid, {
          assetId: asset.assetId,
          recipientKey: ftOutput.recipient,
          outputIndex: s.foreignIndices[0],
          amount: ftOutput.amount.toString(),
          derivationPrefix: foreign.derivationPrefix,
          derivationSuffix: foreign.derivationSuffix,
          senderIdentityKey: foreign.senderIdentityKey,
          senderMode: 'identity',
          txHex: Utils.toHex(s.tx),
          offChainHex: Utils.toHex(s.offChainValues),
          topics: s.topics
        })
      }
      : undefined
    let res
    try {
      res = await runAuthorityTx({
        wallet,
        identityKey,
        legs: [{
          prior: { tokenId: asset.assetId, outpoint: asset.authOutpoint, keyID: asset.authKeyID },
          details,
          customInstructions: keyID => adminCustomInstructions(asset.assetId, asset.label, keyID, asset.metadata)
        }],
        ...(foreign != null
          ? { foreignOuts: [{ lockingScript: foreign.lockingScript, linkage: foreign.linkage, outputDescription: 'reissued token' }] }
          : {}),
        inputBEEF,
        description: actionDescription(`${details.kind} ${asset.label}`),
        labels: ['mandala', details.kind],
        ...(journalIntent != null ? { beforeSubmit: journalIntent } : {})
      })
    } catch (e) {
      // An unknown submit outcome keeps the action held (submitAndBroadcast)
      // and so keeps the intent: the reissue may have landed (see payout.ts).
      if (intentTxid != null && !mayHaveCommitted(e)) await notifyRemove(intentTxid)
      throw e
    }

    let notified = true
    if (ftOutput != null && foreign != null) {
      const outputIndex = res.foreignIndices[0]
      const attestation = requireAttestedOutput(res.admitted, outputIndex, res.txid)
      notified = await deliverIssuerReceipt({
        messageBoxClient: p.messageBoxClient as MessageBoxSender,
        recipientKey: ftOutput.recipient,
        txid: res.txid,
        body: handoverBody({
          assetId: asset.assetId,
          amount: ftOutput.amount,
          outputIndex,
          tx: res.tx,
          derivationPrefix: foreign.derivationPrefix,
          derivationSuffix: foreign.derivationSuffix,
          senderIdentityKey: foreign.senderIdentityKey,
          senderMode: 'identity',
          admission: attestation,
          linkage: [{ txid: res.txid, offChainValues: res.offChainValues }]
        })
      })
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
      description: actionDescription(`global ${details[0]?.kind ?? 'admin'} (${assets.length} assets)`),
      labels: ['mandala', details[0]?.kind ?? 'admin']
    })
    return { txid: res.txid, ...admissionReceipt(res.admitted) }
  }))
}

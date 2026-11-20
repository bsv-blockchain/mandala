/**
 * BRC-207 receipt instructions and the MessageBox hand-over body (C§7.1,
 * C§7.2), shared by issuer payouts, reissues and holder hand-overs.
 *
 * B7: a receipt is plain BRC-207 custody JSON; the issuer's evidence (σ and
 * envelopes) rides in the v4 MessageBox body beside it, never inside it.
 */
import { Random, Utils, WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { MESSAGEBOX, OVERLAY_IDENTITY_KEY } from './constants.js'
import type { Attestation } from './attestation.js'
import { notifyPut, notifyRemove } from './notifyJournal.js'
import { recipientLinkage } from './linkage.js'
import { normalizeKey } from './keys.js'

/** The MessageBox slice payouts and hand-overs send through (structural; `MessageBoxClient` fits). */
export interface MessageBoxSender {
  sendMessage: (a: { recipient: string, messageBox: string, body: object }) => Promise<unknown>
}

/**
 * BRC-207 `internalizeAction` customInstructions for a `p color` output
 * (0207:1431-1440): plain custody JSON, exactly these five members, well under
 * 1000 bytes (design §9 B7). Evidence never travels here.
 */
export type ReceiptInstruction = {
  version: 1
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
  /** A, or A′ when the sender blinded (B3). */
  senderIdentityKey: string
}

/** A fresh remittance string: base64 of 16 random bytes (C§0). */
export function newRemittance (): string {
  return Utils.toBase64(Random(16))
}

/**
 * The issuer receipt builders. Defined in issuerIntent.ts, which rebuilds a
 * receipt after a crash (plan 04 R6) and must not import this module back.
 */
export { issuerReceipt } from './issuerIntent.js'
export type { IssuerReceiptIntent } from './issuerIntent.js'

/**
 * The MessageBox hand-over body (C§7.2). Defined in notifyJournal.ts, which
 * rebuilds it for redelivery (Task 15) and must not import this module back.
 */
export { handoverBody, receiptOfBody } from './notifyJournal.js'
export type { HandoverBodyV4, WireAdmission, WireLinkage } from './notifyJournal.js'

/**
 * Deliver `body` for committed tx `txid` on MESSAGEBOX. The notification is
 * journaled BEFORE the send (a crash or a failed send is retried by
 * reconcileNotifications) and cleared after it; that write replaces the
 * pending receipt intent the payout journaled before its submit (R6). Never
 * throws: the tx is already committed, so a failed send only reports `false`.
 */
export async function deliverIssuerReceipt (p: {
  messageBoxClient: MessageBoxSender
  recipientKey: string
  txid: string
  body: object
}): Promise<boolean> {
  await notifyPut({ txid: p.txid, recipient: p.recipientKey, messageBox: MESSAGEBOX, body: p.body, at: Date.now() })
  try {
    await p.messageBoxClient.sendMessage({ recipient: p.recipientKey, messageBox: MESSAGEBOX, body: p.body })
  } catch (e) {
    console.warn(`[mandala] ${p.txid} committed but the recipient notification failed; reconcileNotifications retries it:`, e)
    return false
  }
  await notifyRemove(p.txid)
  return true
}

/**
 * The overlay admitted (committed) an issuer-built tx but its attestation does
 * not cover the recipient output, so no receipt can be built. Unreachable with
 * a conforming overlay (it admits every token output or refuses the tx).
 * `committed` is always true: value moved, and the caller must NOT re-run the
 * payout or reissue (that would pay twice).
 */
export class ReceiptUnavailableError extends Error {
  readonly committed = true as const
  readonly txid: string
  readonly outputIndex: number
  constructor (txid: string, outputIndex: number) {
    super(`overlay admitted ${txid} without an attestation covering output ${outputIndex}: the tx is committed (do not retry) but no receipt can be built for the recipient`)
    this.name = 'ReceiptUnavailableError'
    this.txid = txid
    this.outputIndex = outputIndex
  }
}

/** The verified attestation of `admitted`, which must cover the recipient output `index`; else ReceiptUnavailableError. */
export function requireAttestedOutput (admitted: { attestation?: Attestation }, index: number, txid: string): Attestation {
  const a = admitted.attestation
  if (a == null || a.txid !== txid || !a.outputs.includes(index)) throw new ReceiptUnavailableError(txid, index)
  return a
}

/**
 * Arguments every issuer-built recipient output shares (payout and reissue);
 * TypeError before any wallet call. Returns the recipient key normalised to
 * lowercase: callers must use it, not the raw argument.
 */
export function checkRecipient (p: { identityKey: string, recipientKey: string, messageBoxClient?: MessageBoxSender }): string {
  const recipientKey = normalizeKey(p.recipientKey, 'recipientKey')
  if (recipientKey === p.identityKey) {
    throw new TypeError('@bsv/mandala: a payout needs a recipient other than the issuer (self uses owned outputs)')
  }
  if (p.messageBoxClient == null || typeof p.messageBoxClient.sendMessage !== 'function') {
    throw new TypeError('@bsv/mandala: a payout needs a messageBoxClient to deliver the receipt')
  }
  return recipientKey
}

/**
 * The recipient `p color` output of an issuer-built tx (a reissue): remittances,
 * linkage and the 1-sat lock, unblinded (the receipt shows the issuer key).
 * Used by submitAdminAction; payoutTokens builds its own (it may blind).
 */
export async function issuerRecipientOutput (wallet: WalletInterface, a: {
  identityKey: string
  recipientKey: string
  assetId: string
  amount: bigint
}): Promise<{
  lockingScript: string
  linkage: Awaited<ReturnType<typeof recipientLinkage>>['linkage']
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}> {
  const derivationPrefix = newRemittance()
  const derivationSuffix = newRemittance()
  const r = await recipientLinkage(wallet, {
    identityKey: a.identityKey,
    recipientKey: a.recipientKey,
    assetId: a.assetId,
    derivationPrefix,
    derivationSuffix,
    overlayIdentityKey: OVERLAY_IDENTITY_KEY,
    blind: false
  })
  return {
    lockingScript: new OneColor().lock(a.assetId, a.amount, r.pubKeyHash).toHex(),
    linkage: r.linkage,
    derivationPrefix,
    derivationSuffix,
    senderIdentityKey: r.senderIdentityKey
  }
}

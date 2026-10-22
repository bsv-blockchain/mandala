/**
 * BRC-207 receipt instructions and the MessageBox hand-over body (C§7.1,
 * C§7.2), shared by issuer payouts, reissues and holder hand-overs.
 *
 * Every Mandala receipt carries the attested leaf (0207:313-322): the deploy
 * raw tx, the unattested token ancestors (none for an issuer payout: its
 * inputs are treasury coins, and the tip itself is attested), the tip's
 * attestation, and one submission per unattested tx including the tip.
 */
import { Random, Utils } from '@bsv/sdk'
import { ATTESTED_PROFILE_ID, MESSAGEBOX } from './constants.js'
import type { Attestation } from './attestation.js'
import { notifyPut, notifyRemove } from './notifyJournal.js'

/** The MessageBox slice payouts and hand-overs send through (structural; `MessageBoxClient` fits). */
export interface MessageBoxSender {
  sendMessage: (a: { recipient: string, messageBox: string, body: object }) => Promise<unknown>
}

/** BRC-207 `internalizeAction` customInstructions for a `p color` output (C§7.1). */
export type ReceiptInstruction = {
  version: 1
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
  /** A, or A′ when the sender blinded (B3). */
  senderIdentityKey: string
  profileData: Record<string, unknown>
}

/** A fresh remittance string: base64 of 16 random bytes (C§0). */
export function newRemittance (): string {
  return Utils.toBase64(Random(16))
}

/**
 * The attested-profile leaf of an issuer receipt (payout or reissue): the tip
 * is attested and has no unattested ancestors, so `transactions` is empty and
 * `submissions` holds exactly the tip (C§8.1 PayoutResult note).
 */
export function issuerAttestedLeaf (p: {
  /** Raw deploy tx: `(await fetchDeployTx(assetId)).toBinary()`. */
  declarationTx: number[]
  attestation: Attestation
  /** The tip's submission data (the Mandala envelope bytes). */
  offChainValues: number[]
}): Record<string, unknown> {
  return {
    declarationTx: Utils.toHex(p.declarationTx),
    transactions: [],
    attestations: [p.attestation],
    submissions: [{ txid: p.attestation.txid, offChainValues: Utils.toHex(p.offChainValues) }]
  }
}

/** The receipt for an issuer-built `p color` output, members in C§7.1 order. */
export function issuerReceipt (p: {
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
  declarationTx: number[]
  attestation: Attestation
  offChainValues: number[]
}): ReceiptInstruction {
  return {
    version: 1,
    assetId: p.assetId,
    derivationPrefix: p.derivationPrefix,
    derivationSuffix: p.derivationSuffix,
    senderIdentityKey: p.senderIdentityKey,
    profileData: {
      [ATTESTED_PROFILE_ID]: {
        [p.assetId]: issuerAttestedLeaf({ declarationTx: p.declarationTx, attestation: p.attestation, offChainValues: p.offChainValues })
      }
    }
  }
}

/** The MessageBox hand-over body (C§7.2). No amount: the recipient reads it from the script. */
export function handoverBody (p: {
  assetId: string
  outputIndex: number
  /** AtomicBEEF of the tip. */
  tx: number[]
  receipt: ReceiptInstruction
  note?: string
}): object {
  return {
    v: 3,
    kind: 'handover',
    assetId: p.assetId,
    outputIndex: p.outputIndex,
    tx: Utils.toHex(p.tx),
    receipt: p.receipt,
    ...(p.note != null ? { note: p.note } : {})
  }
}

/**
 * Deliver `body` for committed tx `txid` on MESSAGEBOX. The notification is
 * journaled BEFORE the send (a crash or a failed send is retried by
 * reconcileNotifications) and cleared after it. Never throws: the tx is
 * already committed, so a failed send only reports `false`.
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

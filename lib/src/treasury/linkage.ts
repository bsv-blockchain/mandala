/**
 * Specific key linkage revelation for Mandala-key outputs (treasury, authority,
 * deploy, registry, payout change): BRC-72 under ADMIN_PROTOCOL, revealed to
 * the overlay so it can tie each output's key to its owner (C§5.1).
 */
import { WalletInterface } from '@bsv/sdk'
import { ADMIN_PROTOCOL, OVERLAY_IDENTITY_KEY, OVERLAY_IDENTITY_KEY_UNSET } from '../constants.js'
import { readSpecificLinkage, SpecificLinkage } from '../encoding.js'

/**
 * Reveal the ADMIN_PROTOCOL linkage of `keyID`/`counterparty` to `verifier`
 * (default: the configured overlay identity key). Throws
 * `OVERLAY_IDENTITY_KEY_UNSET` before touching the wallet when the verifier is
 * '' (S5), and TypeError when the wallet returns anything other than a
 * `[2, 'mandala admin']`, proofType-0 linkage for the requested keyID. The
 * result carries exactly the contract members in contract order.
 */
export async function revealIssuerLinkage (
  wallet: WalletInterface, keyID: string, counterparty: string, verifier?: string
): Promise<SpecificLinkage> {
  const v = verifier ?? OVERLAY_IDENTITY_KEY
  if (typeof v !== 'string' || v === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  const revealed = await wallet.revealSpecificKeyLinkage({
    counterparty,
    verifier: v,
    protocolID: ADMIN_PROTOCOL,
    keyID
  })
  const r = revealed as unknown as Record<string, unknown>
  const linkage = readSpecificLinkage({
    prover: r.prover,
    verifier: r.verifier,
    counterparty: r.counterparty,
    protocolID: r.protocolID,
    keyID: r.keyID,
    encryptedLinkage: Array.from((r.encryptedLinkage ?? []) as ArrayLike<number>),
    encryptedLinkageProof: Array.from((r.encryptedLinkageProof ?? []) as ArrayLike<number>),
    proofType: r.proofType
  }, 'revealed linkage')
  if (linkage.protocolID[1] !== ADMIN_PROTOCOL[1] || linkage.keyID !== keyID || linkage.verifier !== v) {
    throw new TypeError('revealed linkage does not match the requested protocol, keyID or verifier')
  }
  return linkage
}

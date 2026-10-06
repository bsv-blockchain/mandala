import { Utils, WalletProtocol } from '@bsv/sdk'
export type { MandalaActionKind, MandalaActionDetails } from './brc162.js'

export interface SpecificLinkage {
  prover: string
  verifier: string
  counterparty: string
  protocolID: WalletProtocol
  keyID: string
  encryptedLinkage: number[]
  encryptedLinkageProof: number[]
  proofType: number
}

/**
 * The v3 off-chain envelope (overlay-go internal/mandala/envelope.go), sent
 * CompactSize-framed after the BEEF in the /submit body. `admin[].details` is
 * the lowercase hex of the strict-CBOR admin details whose sha256 the
 * authority output at `index` commits to; `deploySig` (lowercase hex DER)
 * rides on a deploy only.
 */
export interface MandalaLinkagePayload {
  inputs: Array<{ index: number, linkage: SpecificLinkage }>
  outputs: Array<{ index: number, linkage: SpecificLinkage }>
  admin?: Array<{ index: number, details: string }>
  deploySig?: string
}

export const encodeLinkagePayload = (payload: MandalaLinkagePayload): number[] =>
  Utils.toArray(JSON.stringify(payload), 'utf8')

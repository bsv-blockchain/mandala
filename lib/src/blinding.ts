/**
 * Sender-identity blinding for Mandala transfers (whitepaper §4).
 *
 * A′ = A + rG. The recipient derives against A′ and cannot join later
 * payments. The overlay never needs A′ — it already bound the inputs.
 * r is a sender-local secret: store it on *change* customInstructions
 * and in blindingJournal, never on the recipient output and never in
 * the MessageBox body (that would let the recipient open A′ − rG = A).
 */
import {
  Hash, PrivateKey, PublicKey, Point, WalletInterface, WalletProtocol, Utils
} from '@bsv/sdk'
import { FT_PROTOCOL, OVERLAY_IDENTITY_KEY } from './constants.js'
import type { SpecificLinkage } from './encoding.js'

export function sampleBlindingFactor (): PrivateKey {
  return PrivateKey.fromRandom()
}

export function invoiceNumber (protocolID: WalletProtocol, keyID: string): string {
  const protocolName = protocolID[1].toLowerCase().trim()
  return `${protocolID[0]}-${protocolName}-${keyID}`
}

/** A′ = A + rG, compressed hex. */
export function addBlind (A: PublicKey, r: PrivateKey): string {
  const sum = A.add(r.toPublicKey())
  return new PublicKey(sum.x, sum.y).toString()
}

/** S′ = S + r·B  (ECDH(a+r, B) = ECDH(b, A′)). */
export function blindedSharedSecret (S: Point, r: PrivateKey, B: PublicKey): PublicKey {
  const sum = S.add(B.mul(r))
  return new PublicKey(sum.x, sum.y)
}

export function childOffset (S: Point, protocolID: WalletProtocol, keyID: string): number[] {
  return Hash.sha256hmac(S.encode(true) as number[], Utils.toArray(invoiceNumber(protocolID, keyID), 'utf8'))
}

export function outputPublicKey (B: PublicKey, k: number[]): PublicKey {
  const H = new PrivateKey(k).toPublicKey()
  const P = B.add(H)
  return new PublicKey(P.x, P.y)
}

export function outputPubKeyHash (P: PublicKey): number[] {
  return Hash.hash160(P.encode(true) as number[])
}

/** Recipient-output CI: never carries r. */
export function recipientCustomInstructions (args: {
  keyID: string
  recipientKey: string
  senderBlinded: string
}): string {
  return JSON.stringify({
    protocolID: FT_PROTOCOL,
    keyID: args.keyID,
    counterparty: args.recipientKey,
    direction: 'sent',
    recipient: args.recipientKey,
    senderBlinded: args.senderBlinded
  })
}

/** Change-output CI: the sender keeps this UTXO, so r can live here. */
export function changeCustomInstructions (args: {
  keyID: string
  identityKey: string
  recipientKey: string
  sentAmount: number
  r: string
  senderBlinded: string
}): string {
  return JSON.stringify({
    protocolID: FT_PROTOCOL,
    keyID: args.keyID,
    counterparty: args.identityKey,
    direction: 'change',
    recipient: args.recipientKey,
    sentAmount: args.sentAmount,
    blindingR: args.r,
    senderBlinded: args.senderBlinded
  })
}

export interface BlindedPayment {
  /** Scalar r, hex. Sender-local only. */
  r: string
  /** A′ compressed hex — what the recipient is shown. */
  senderBlinded: string
  pubKeyHash: number[]
  /** Specific-linkage payload the overlay decrypts (k for S′, not S). */
  linkage: SpecificLinkage
}

/**
 * Root ECDH point with `counterparty`. Prefers an in-process KeyDeriver
 * (ProtoWallet). Otherwise reveal-to-self + decrypt, which any BRC-100
 * wallet that implements linkage revelation can do without exporting a.
 */
export async function rootSharedSecret (
  wallet: WalletInterface,
  counterparty: string
): Promise<PublicKey> {
  const deriver = (wallet as { keyDeriver?: { revealCounterpartySecret: (c: string) => number[] } }).keyDeriver
  if (deriver?.revealCounterpartySecret != null) {
    const bytes = deriver.revealCounterpartySecret(counterparty)
    return PublicKey.fromDER(bytes)
  }
  const { publicKey: me } = await wallet.getPublicKey({ identityKey: true })
  const revelation = await wallet.revealCounterpartyKeyLinkage({
    counterparty,
    verifier: me
  })
  const { plaintext } = await wallet.decrypt({
    ciphertext: revelation.encryptedLinkage,
    protocolID: [2, 'counterparty linkage revelation'],
    keyID: revelation.revelationTime,
    counterparty: me
  })
  return PublicKey.fromDER(plaintext)
}

/**
 * Build the blinded recipient lock material and the overlay-bound specific
 * linkage of the *blinded* offset k. The recipient output is locked to
 * HASH160(B + kG) with k = HMAC(S′, ι), S′ = ECDH(A′, B).
 */
export async function prepareBlindedPayment (
  wallet: WalletInterface,
  args: { identityKey: string, recipientKey: string, keyID: string, protocolID?: WalletProtocol }
): Promise<BlindedPayment> {
  const protocolID = args.protocolID ?? FT_PROTOCOL
  const r = sampleBlindingFactor()
  const A = PublicKey.fromString(args.identityKey)
  const B = PublicKey.fromString(args.recipientKey)
  const senderBlinded = addBlind(A, r)
  const S = await rootSharedSecret(wallet, args.recipientKey)
  const Sprime = blindedSharedSecret(S, r, B)
  const k = childOffset(Sprime, protocolID, args.keyID)
  const P = outputPublicKey(B, k)
  const pubKeyHash = outputPubKeyHash(P)

  const overlay = OVERLAY_IDENTITY_KEY
  const { ciphertext: encryptedLinkage } = await wallet.encrypt({
    plaintext: k,
    protocolID: [2, `specific linkage revelation ${protocolID[0]} ${protocolID[1]}`],
    keyID: args.keyID,
    counterparty: overlay
  })
  const { ciphertext: encryptedLinkageProof } = await wallet.encrypt({
    plaintext: [0x00],
    protocolID: [2, `specific linkage revelation ${protocolID[0]} ${protocolID[1]}`],
    keyID: args.keyID,
    counterparty: overlay
  })

  return {
    r: r.toHex(),
    senderBlinded,
    pubKeyHash,
    linkage: {
      prover: args.identityKey,
      verifier: overlay,
      counterparty: args.recipientKey,
      protocolID,
      keyID: args.keyID,
      encryptedLinkage,
      encryptedLinkageProof,
      proofType: 0
    }
  }
}

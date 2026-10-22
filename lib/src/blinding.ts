/**
 * Sender-identity blinding math (whitepaper §4, B3).
 *
 * A′ = A + rG. The recipient derives against A′ and cannot join later
 * payments. The overlay never needs A′: the envelope linkage names the real
 * prover A (C§5.1). r is a sender-local secret kept only in blindingJournal,
 * never on the recipient output, in the receipt or in the MessageBox body
 * (that would let the recipient open A′ − rG = A). `recipientLinkage`
 * (linkage.ts) composes these helpers for `p color` outputs.
 */
import {
  Hash, PrivateKey, PublicKey, Point, WalletInterface, WalletProtocol, Utils
} from '@bsv/sdk'

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

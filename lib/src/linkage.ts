/**
 * Recipient-output linkage for `p color` outputs (C§5.1, C§8.1, B3, D20).
 *
 * The sending app derives the recipient's output key itself from the root
 * ECDH secret, because the color module refuses `revealSpecificKeyLinkage` on
 * any `p color` protocol through the permission manager (0207:597-600):
 *
 *   invoice = `2-<p color name>-color`, S = ECDH(a, B)
 *   blind:  r random, S′ = S + r·B (= ECDH(b, A′)), A′ = A + r·G
 *   L = HMAC-SHA256(compressed(S′ or S), utf8(invoice)), P = B + L·G
 *   pubKeyHash = hash160(P)
 *
 * The overlay K decrypts L from `encryptedLinkage` and checks
 * hash160(counterparty + L·G) (overlay-go linkage.go VerifyKeyLinkage), so the
 * linkage names B as counterparty and the real A as prover even when blinded.
 * The recipient derives P by plain BRC-42 against the `senderIdentityKey` it
 * is shown (A′ when blinded). The receipt shows A′ while the envelope prover
 * is A: this mismatch is intended (C§5.1). r is returned to the caller for
 * the sender-local blindingJournal only; it never enters the linkage.
 */
import { PrivateKey, PublicKey, WalletInterface } from '@bsv/sdk'
import { OVERLAY_IDENTITY_KEY_UNSET } from './constants.js'
import { normalizeKey } from './keys.js'
import { colorProtocolID } from './naming.js'
import { readSpecificLinkage, SpecificLinkage } from './encoding.js'
import {
  addBlind, blindedSharedSecret, childOffset, outputPublicKey, outputPubKeyHash,
  rootSharedSecret, sampleBlindingFactor
} from './blinding.js'

/** keyID of every `p color` derivation (0207:540-546). */
const COLOR_KEY_ID = 'color'
const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

export interface RecipientLinkageArgs {
  identityKey: string
  recipientKey: string
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
  overlayIdentityKey: string
  blind: boolean
}

export interface RecipientLinkageResult {
  /** Caller locks: `new OneColor().lock(assetId, amount, pubKeyHash)`, 1 sat, no payload. */
  pubKeyHash: number[]
  /** A′ when blinded, else A: the receipt's `senderIdentityKey`. */
  senderIdentityKey: string
  /** Blinding scalar (64 lowercase hex), present iff blinded. Sender-local only. */
  r?: string
  linkage: SpecificLinkage
}

/** Parse a 66-hex compressed, lowercase, on-curve identity key (C§0) or throw TypeError. */
function checkKey (key: unknown, name: string): PublicKey {
  if (typeof key !== 'string' || !COMPRESSED_KEY.test(key)) {
    throw new TypeError(`@bsv/mandala: ${name} must be a 66-hex compressed lowercase public key`)
  }
  let pk: PublicKey
  try {
    pk = PublicKey.fromString(key)
  } catch {
    throw new TypeError(`@bsv/mandala: ${name} is not a point on secp256k1`)
  }
  if (!pk.validate()) throw new TypeError(`@bsv/mandala: ${name} is not a point on secp256k1`)
  return pk
}

/**
 * Build the recipient `p color` output key hash and the overlay-bound
 * specific linkage for it. Every argument is validated before any wallet
 * call: the S5 check (`overlayIdentityKey === ''` ⇒
 * `Error(OVERLAY_IDENTITY_KEY_UNSET)`), then `TypeError` on an invalid key, a
 * send to self (self uses owned outputs), an invalid asset id or remittance,
 * or an `identityKey` that is not the wallet's identity key.
 */
export async function recipientLinkage (
  wallet: WalletInterface,
  a: RecipientLinkageArgs
): Promise<RecipientLinkageResult> {
  if (a == null || typeof a !== 'object') throw new TypeError('@bsv/mandala: recipientLinkage arguments are required')
  if (a.overlayIdentityKey === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  const A = checkKey(a.identityKey, 'identityKey')
  const recipientKey = normalizeKey(a.recipientKey, 'recipientKey')
  const B = checkKey(recipientKey, 'recipientKey')
  checkKey(a.overlayIdentityKey, 'overlayIdentityKey')
  if (recipientKey === a.identityKey) {
    throw new TypeError('@bsv/mandala: recipientLinkage refuses a send to self (self uses owned outputs)')
  }
  if (typeof a.blind !== 'boolean') throw new TypeError('@bsv/mandala: blind must be a boolean')
  const protocolID = colorProtocolID(a.assetId, a.derivationPrefix, a.derivationSuffix)

  // The prover named in the linkage must be the key the wallet actually
  // derives with, or the overlay refuses the output for good (ERR_LINKAGE).
  const { publicKey: walletIdentity } = await wallet.getPublicKey({ identityKey: true })
  if (walletIdentity !== a.identityKey) {
    throw new TypeError('@bsv/mandala: identityKey is not this wallet\'s identity key')
  }

  const S = await rootSharedSecret(wallet, recipientKey)
  let r: PrivateKey | undefined
  let senderIdentityKey = a.identityKey
  let secret: PublicKey = S
  if (a.blind) {
    r = sampleBlindingFactor()
    senderIdentityKey = addBlind(A, r)
    secret = blindedSharedSecret(S, r, B)
  }
  const L = childOffset(secret, protocolID, COLOR_KEY_ID)
  const pubKeyHash = outputPubKeyHash(outputPublicKey(B, L))

  const revelationProtocol: [2, string] = [2, `specific linkage revelation 2 ${protocolID[1]}`]
  const { ciphertext: encryptedLinkage } = await wallet.encrypt({
    plaintext: L,
    protocolID: revelationProtocol,
    keyID: COLOR_KEY_ID,
    counterparty: a.overlayIdentityKey
  })
  const { ciphertext: encryptedLinkageProof } = await wallet.encrypt({
    plaintext: [0x00],
    protocolID: revelationProtocol,
    keyID: COLOR_KEY_ID,
    counterparty: a.overlayIdentityKey
  })

  const linkage = readSpecificLinkage({
    prover: a.identityKey,
    verifier: a.overlayIdentityKey,
    counterparty: recipientKey,
    protocolID,
    keyID: COLOR_KEY_ID,
    encryptedLinkage: Array.from(encryptedLinkage),
    encryptedLinkageProof: Array.from(encryptedLinkageProof),
    proofType: 0
  }, 'recipient linkage')

  return r == null
    ? { pubKeyHash, senderIdentityKey, linkage }
    : { pubKeyHash, senderIdentityKey, r: r.toHex(), linkage }
}

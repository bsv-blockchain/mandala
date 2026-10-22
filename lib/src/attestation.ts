/**
 * BRC-207 attested admission statement, version 1 (C§3, 0207:250-275,
 * Appendix C.0 at 0207:10214-10264).
 *
 * This is how a `tm_color_<assetId>` admission is proven. The overlay signs
 * the complete admitted output set of one topic for one transaction:
 *
 *   message = "1color-admit:v1:" + "tm_color_" + assetId + ":" + txid + ":" + outputs.join(",")
 *   digest  = SHA-256(utf8(message)), once
 *   key     = BRC-42 child of the signer's identity key,
 *             protocol [2, "color admission attestation"], keyID "1", counterparty anyone
 *             (invoice "2-color admission attestation-1")
 *
 * It replaces σI v3 on token topics. σI v3 (`admission.ts`) now covers only
 * the `tm_mandala` registry topic, signed by the bare overlay key.
 *
 * Verification rules (all enforced, none relaxed):
 * - the signer must equal the expected signer exactly (lowercase compressed key);
 * - outputs must already be canonical: non-empty, unique, strictly ascending uint32
 *   (an unsorted array is refused, never sorted for the caller);
 * - the signature must be lowercase, strict-DER hex with no sighash byte;
 * - low-S and high-S are both accepted (BSV Chronicle: S is never normalized);
 * - the key is always the publicly derived child, never the bare identity key
 *   or a caller-supplied child.
 *
 * Pure and React-Native safe: `@bsv/sdk` primitives only, no storage, no network.
 */
import { BigNumber, ECDSA, Hash, PrivateKey, PublicKey, Signature, Utils, type WalletInterface } from '@bsv/sdk'
import { colorTopic, isAssetId } from './naming.js'

/** A BRC-207 JSON attestation: exactly these four members (0207:257-261). */
export interface Attestation {
  /** 64 lowercase hex txid of the admitted transaction. */
  txid: string
  /** The topic's complete admitted output set, strictly ascending. */
  outputs: number[]
  /** The authority's lowercase compressed identity key. */
  signer: string
  /** Lowercase strict-DER ECDSA hex, no sighash byte. */
  signature: string
}

/** BRC-43 protocol of the attestation key (C§3). */
export const ATTESTATION_PROTOCOL_ID: [2, 'color admission attestation'] = [2, 'color admission attestation']
/** BRC-43 key id of the attestation key (C§3). */
export const ATTESTATION_KEY_ID = '1'

const MESSAGE_PREFIX = '1color-admit:v1:'
const INVOICE = `${ATTESTATION_PROTOCOL_ID[0]}-${ATTESTATION_PROTOCOL_ID[1]}-${ATTESTATION_KEY_ID}`
const MAX_UINT32 = 4294967295
const TXID_RE = /^[0-9a-f]{64}$/
const KEY_RE = /^0[23][0-9a-f]{64}$/
const HEX_RE = /^(?:[0-9a-f]{2})+$/
/** BRC-42 "anyone" private scalar: the public derivation counterparty. */
const ANYONE = new PrivateKey(1)

/** True iff `outputs` is non-empty, unique, strictly ascending uint32 (C§3). */
function isCanonicalOutputs (outputs: unknown): outputs is number[] {
  if (!Array.isArray(outputs) || outputs.length === 0) return false
  let prev = -1
  for (const v of outputs) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_UINT32 || v <= prev) return false
    prev = v
  }
  return true
}

/**
 * The exact UTF-8 message an authority signs (C§3). It throws `TypeError` on a
 * non-canonical asset id or txid, or on outputs that are empty, unsorted,
 * duplicated or outside uint32. It never canonicalizes for the caller: a
 * noncanonical spelling has no message.
 */
export function attestationMessage (assetId: string, txid: string, outputs: number[]): string {
  if (!isAssetId(assetId)) {
    throw new TypeError(`@bsv/mandala: invalid asset id ${JSON.stringify(assetId)} (expected <64 lowercase hex>_<vout>)`)
  }
  if (typeof txid !== 'string' || !TXID_RE.test(txid)) {
    throw new TypeError('@bsv/mandala: attestation txid must be 64 lowercase hex characters')
  }
  if (!isCanonicalOutputs(outputs)) {
    throw new TypeError('@bsv/mandala: attestation outputs must be a non-empty, strictly ascending list of uint32 indexes')
  }
  return `${MESSAGE_PREFIX}${colorTopic(assetId)}:${txid}:${outputs.join(',')}`
}

/** The publicly derived attestation child of `signer` (BRC-42, counterparty anyone). */
function attestationChild (signer: string): PublicKey {
  return PublicKey.fromString(signer).deriveChild(ANYONE, INVOICE)
}

/**
 * True iff `a` is a valid attested v1 statement by exactly `expectedSigner`
 * for `assetId` (C§3). Never throws: any malformed member, a non-strict or
 * uppercase signature, an off-curve key or a failed ECDSA check is `false`.
 */
export function verifyAttestation (a: Attestation, assetId: string, expectedSigner: string): boolean {
  try {
    if (a == null || typeof a !== 'object') return false
    const { txid, outputs, signer, signature } = a
    if (typeof expectedSigner !== 'string' || typeof signer !== 'string') return false
    if (!KEY_RE.test(signer) || signer !== expectedSigner) return false
    if (typeof signature !== 'string' || !HEX_RE.test(signature)) return false
    // Strict DER: the sdk parser tolerates a few non-minimal spellings (e.g. a
    // sign-bit-set INTEGER without its 0x00 pad). The canonical re-encoding
    // keeps r and s exactly as parsed (it never flips S), so a byte-exact
    // round trip admits low- and high-S alike and nothing else.
    const sig = Signature.fromDER(signature, 'hex')
    if (sig.toDER('hex') !== signature) return false
    const message = attestationMessage(assetId, txid, outputs)
    const digest = Hash.sha256(Utils.toArray(message, 'utf8'))
    return ECDSA.verify(new BigNumber(digest, 16), sig, attestationChild(signer))
  } catch {
    return false
  }
}

/**
 * Map the BRC-22 STEAK entry `steak[tm_color_<assetId>]` to an attestation
 * (C§3): `{txid, outputs: outputsToAdmit, signer: admissionIdentityKey,
 * signature: admissionSignature}`. Returns `undefined` (never throws) when the
 * entry is absent, unsigned, or its admitted set is not already canonical.
 * The result is not verified; pass it to `verifyAttestation`.
 */
export function attestationFromSteak (txid: string, assetId: string, steak: Record<string, any>): Attestation | undefined {
  try {
    if (typeof txid !== 'string' || !TXID_RE.test(txid)) return undefined
    if (!isAssetId(assetId) || steak == null || typeof steak !== 'object') return undefined
    const topic = colorTopic(assetId)
    if (!Object.prototype.hasOwnProperty.call(steak, topic)) return undefined
    const entry = steak[topic]
    if (entry == null || typeof entry !== 'object') return undefined
    const { outputsToAdmit, admissionSignature, admissionIdentityKey } = entry
    if (typeof admissionSignature !== 'string' || typeof admissionIdentityKey !== 'string') return undefined
    if (!isCanonicalOutputs(outputsToAdmit)) return undefined
    return { txid, outputs: [...outputsToAdmit], signer: admissionIdentityKey, signature: admissionSignature }
  } catch {
    return undefined
  }
}

/**
 * Sign the attested v1 statement with `wallet`'s identity (contract G5; used
 * by fixtures and E2E, the overlay signs in production). BRC-3
 * `createSignature` hashes `data` with SHA-256 once and signs with RFC 6979,
 * which reproduces the C.0 low-S bytes. The message is validated before the
 * wallet is called. Returns lowercase DER hex.
 */
export async function signAttestation (
  wallet: Pick<WalletInterface, 'createSignature'>,
  assetId: string,
  txid: string,
  outputs: number[]
): Promise<string> {
  const message = attestationMessage(assetId, txid, outputs)
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(message, 'utf8'),
    protocolID: ATTESTATION_PROTOCOL_ID,
    keyID: ATTESTATION_KEY_ID,
    counterparty: 'anyone'
  })
  return Utils.toHex(Array.from(signature))
}

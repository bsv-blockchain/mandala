/**
 * Test-only overlay signer for STEAK fixtures (C§3, C§6).
 *
 * `OVERLAY_PRIV` is the BRC-207 Appendix C.0 public test key 5555 (never fund
 * it); `OVERLAY_KEY` is the C.0 signer. `signedSteak` answers a `/submit` the
 * way overlay-go does:
 *
 * - `tm_color_<assetId>`: the attested v1 statement, signed by the BRC-42
 *   attestation child (`signAttestation`);
 * - `tm_mandala`: σI v3, signed by the bare overlay key;
 * - `tm_mandala_kyc`: unsigned.
 *
 * An entry that admits nothing carries no signature (no admitted outputs ⇒ no
 * signature exists). Any other topic throws: the fixture never mints a legacy
 * `tm_<txid>` answer.
 */
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { signAttestation } from '../attestation.js'
import { admissionMessageV3 } from '../admission.js'
import { isColorTopic } from '../naming.js'
import { REGISTRY_TOPIC, TOPIC } from '../constants.js'

export const OVERLAY_PRIV = new PrivateKey(5555)
/** `02798b81951a6a8c7ef8beda09b06a23031d7efaf37b663265e0188ab378124046` (C.0 signer). */
export const OVERLAY_KEY = OVERLAY_PRIV.toPublicKey().toString()

/** σI v3 over `(tm_mandala, txid, outputs)` by `priv`'s bare key (lowercase DER hex). */
export function signSigmaV3 (txid: string, outputs: number[], priv: PrivateKey = OVERLAY_PRIV): string {
  return Utils.toHex(priv.sign(Utils.toArray(admissionMessageV3(TOPIC, txid, outputs), 'utf8')).toDER() as number[])
}

export async function signedSteak (
  txid: string,
  entries: Record<string, number[]>,
  priv: PrivateKey = OVERLAY_PRIV
): Promise<Record<string, any>> {
  const signer = priv.toPublicKey().toString()
  const steak: Record<string, any> = {}
  for (const [topic, outputs] of Object.entries(entries)) {
    const entry: Record<string, any> = { outputsToAdmit: [...outputs], coinsToRetain: [] }
    if (isColorTopic(topic)) {
      if (outputs.length > 0) {
        entry.admissionSignature = await signAttestation(new ProtoWallet(priv), topic.slice('tm_color_'.length), txid, outputs)
        entry.admissionIdentityKey = signer
      }
    } else if (topic === TOPIC) {
      if (outputs.length > 0) {
        entry.admissionSignature = signSigmaV3(txid, outputs, priv)
        entry.admissionIdentityKey = signer
      }
    } else if (topic !== REGISTRY_TOPIC) {
      throw new TypeError(`signedSteak: no signing scheme for topic ${topic}`)
    }
    steak[topic] = entry
  }
  return steak
}

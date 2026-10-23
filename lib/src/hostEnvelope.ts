/**
 * The envelope (submission data) of a plain-noSend hand-over, built by the
 * sending host (design §9 B7). The B7 color module does not call the
 * profile's `submissionData` for a plain hand-over and returns nothing beyond
 * the signed bytes, so the host builds `{"outputs": [...]}` itself:
 *
 * - the recipient output: the linkage the lib already made with
 *   `recipientLinkage` (blinded or not);
 * - every other token output of the asset (the module's change, or the owned
 *   output of a self-send): its custody is read from the HOST's underlying
 *   wallet (the module stores it, encrypted with the toolbox's
 *   `admin metadata encryption` key, in `p color <assetTag>`), and the
 *   linkage is revealed through that wallet, exactly as the issuer-v1
 *   `submissionData` would (C§5.1: counterparty = owner = this identity).
 *
 * Every owned entry is checked to derive the output's key before it is used,
 * so a wrong custody can never produce an envelope the overlay refuses.
 * Only a wallet host has an underlying wallet; a BRC-100 app cannot do this.
 */
import { Hash, PublicKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { decodeToken } from './brc162.js'
import { encodeEnvelope, type SpecificLinkage } from './encoding.js'
import { colorBasket, colorProtocolID } from './naming.js'

const COLOR_KEY_ID = 'color'
const METADATA_PROTOCOL: [2, 'admin metadata encryption'] = [2, 'admin metadata encryption']
const PAGE = 1000

interface Custody { assetId: string, derivationPrefix: string, derivationSuffix: string, senderIdentityKey: string }

/** The toolbox's `maybeDecryptMetadata`: decrypt, else the value unchanged. */
async function maybeDecrypt (wallet: WalletInterface, value: string): Promise<string> {
  try {
    const { plaintext } = await wallet.decrypt({ ciphertext: Utils.toArray(value, 'base64'), protocolID: METADATA_PROTOCOL, keyID: '1' })
    return Utils.toUTF8(plaintext)
  } catch {
    return value
  }
}

function readCustody (text: string, assetId: string): Custody | undefined {
  try {
    const c = JSON.parse(text) as Partial<Custody>
    if (c?.assetId !== assetId || typeof c.derivationPrefix !== 'string' || typeof c.derivationSuffix !== 'string' ||
      typeof c.senderIdentityKey !== 'string') return undefined
    return { assetId, derivationPrefix: c.derivationPrefix, derivationSuffix: c.derivationSuffix, senderIdentityKey: c.senderIdentityKey }
  } catch {
    return undefined
  }
}

/** Custody of each wanted outpoint, from the host wallet's `p color <assetTag>` basket. */
async function custodies (wallet: WalletInterface, assetId: string, want: Set<string>): Promise<Map<string, Custody>> {
  const found = new Map<string, Custody>()
  for (let offset = 0; found.size < want.size; offset += PAGE) {
    const r = await wallet.listOutputs({ basket: colorBasket(assetId), includeCustomInstructions: true, limit: PAGE, ...(offset > 0 ? { offset } : {}) })
    const outputs = Array.isArray(r?.outputs) ? r.outputs : []
    for (const o of outputs) {
      if (!want.has(o.outpoint) || typeof o.customInstructions !== 'string') continue
      const c = readCustody(await maybeDecrypt(wallet, o.customInstructions), assetId)
      if (c != null) found.set(o.outpoint, c)
    }
    if (outputs.length < PAGE) break
  }
  return found
}

/**
 * Build the hand-over envelope for `tx` (the signed tip). `recipient` is the
 * lib-built entry for a non-owned output (absent for a self-send). Throws when
 * a token output of the asset has no recoverable custody or its revealed
 * linkage does not derive the output's key.
 */
export async function buildHandoverEnvelope (p: {
  /** The host's underlying wallet (not the permissions manager). */
  hostWallet: WalletInterface
  /** This wallet's identity key (the owner of every non-recipient output). */
  identityKey: string
  /** The overlay identity key K (linkage verifier). */
  overlayIdentityKey: string
  assetId: string
  tx: Transaction
  recipient?: { index: number, linkage: SpecificLinkage }
}): Promise<number[]> {
  const txid = p.tx.id('hex')
  const owned: number[] = []
  p.tx.outputs.forEach((o, i) => {
    const d = decodeToken(o.lockingScript, txid, i)
    if (d != null && d.assetId === p.assetId && i !== p.recipient?.index) owned.push(i)
  })
  const want = new Set(owned.map(i => `${txid}.${i}`))
  const found = want.size > 0 ? await custodies(p.hostWallet, p.assetId, want) : new Map<string, Custody>()
  const entries: Array<{ index: number, linkage: SpecificLinkage }> = p.recipient != null ? [p.recipient] : []
  for (const index of owned) {
    const custody = found.get(`${txid}.${index}`)
    if (custody == null) throw new Error(`@bsv/mandala: the host wallet holds no custody for ${txid}.${index}; cannot build the hand-over envelope`)
    const protocolID = colorProtocolID(p.assetId, custody.derivationPrefix, custody.derivationSuffix)
    // The output must be ours under this custody before we vouch for it.
    const { publicKey } = await p.hostWallet.getPublicKey({ protocolID, keyID: COLOR_KEY_ID, counterparty: custody.senderIdentityKey, forSelf: true })
    const pkh = OneColor.decode(p.tx.outputs[index].lockingScript).restPubKeyHash
    if (pkh == null || Utils.toHex(Hash.hash160(PublicKey.fromString(publicKey).encode(true) as number[])) !== Utils.toHex(pkh)) {
      throw new Error(`@bsv/mandala: custody of ${txid}.${index} does not derive its key`)
    }
    const revealed = await p.hostWallet.revealSpecificKeyLinkage({
      counterparty: custody.senderIdentityKey,
      verifier: p.overlayIdentityKey,
      protocolID,
      keyID: COLOR_KEY_ID
    })
    entries.push({
      index,
      linkage: {
        prover: revealed.prover,
        verifier: p.overlayIdentityKey,
        counterparty: p.identityKey,
        protocolID,
        keyID: COLOR_KEY_ID,
        encryptedLinkage: Array.from(revealed.encryptedLinkage),
        encryptedLinkageProof: Array.from(revealed.encryptedLinkageProof),
        proofType: 0
      }
    })
  }
  if (entries.length === 0) throw new Error('@bsv/mandala: the hand-over has no token output to cover')
  return encodeEnvelope({ outputs: entries.sort((a, b) => a.index - b.index) })
}

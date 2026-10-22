/**
 * issuer-v1 B1 hooks: `checkPlanData` and `submissionData` (C§5.1, C§5.2).
 *
 * The sending app puts the overlay-bound linkage of every non-owned token
 * output (the recipient outputs, built by `recipientLinkage`) into its plan
 * leaf `{"outputs":[{index, linkage}]}`. The module calls `checkPlanData` at
 * createAction (no tx yet) and again at signAction (final, unsigned tx), then
 * `submissionData` before signing: the leaf entries plus an owner linkage for
 * each wallet-owned output (token change, plan.ownedOutputs), revealed by the
 * underlying wallet, as the Mandala envelope bytes the overlay checks
 * (`tm_color_<assetId>` offChainValues).
 *
 * Why the signAction checks matter: a hand-over is credited offline by its
 * recipient before any overlay sees it. A leaf whose linkage does not derive
 * the output's key, a non-1-sat token output or a second asset in the tx is
 * refused by the overlay for good (ERR_LINKAGE, ERR_SATOSHIS, D1), so the
 * wallet refuses it here, before anything is signed (Review Focus 1, G10).
 *
 * Both hooks are pure apart from read-only wallet calls (decrypt, reveal), so
 * a retried createAction/signAction re-runs them with the same result.
 * Every refusal is the module's ProfileDataError (plan data) or
 * ProfileParamsError (transaction shape, descriptor), matched by `.name`.
 */
import { PublicKey, Utils, type LockingScript, type Transaction } from '@bsv/sdk'
import { OneColor, isTokenShaped } from '@bsv/templates'
import {
  ProfileDataError,
  ProfileParamsError,
  type JsonValue,
  type ProfileAssetContext,
  type ProfileTxView
} from '@bsv/color-permission-module'
import { encodeEnvelope, readSpecificLinkage, type SpecificLinkage } from './encoding.js'
import { assetTag, colorProtocolID } from './naming.js'
import { outputPubKeyHash, outputPublicKey } from './blinding.js'
import { isIdentityKey, issuerKey } from './profileDescriptor.js'

/** keyID of every `p color` derivation (0207:540-546). */
const COLOR_KEY_ID = 'color'
/** Bound on each linkage byte array (C§5.2). */
const MAX_LINKAGE_BYTES = 1024
/** 0207:548. */
const MAX_PROTOCOL_NAME = 280
const LOWER_HEX_PAIRS = /^(?:[0-9a-f]{2})+$/

interface LinkageEntry { index: number, linkage: SpecificLinkage }

const dataError = (reason: string): ProfileDataError =>
  new ProfileDataError(`BRC-207: Mandala issuer-v1 plan data: ${reason}`)
const shapeError = (reason: string): ProfileParamsError =>
  new ProfileParamsError(`BRC-207: Mandala issuer-v1 transaction: ${reason}`)

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function exactMembers (o: Record<string, unknown>, members: readonly string[], what: string): void {
  const keys = Object.keys(o)
  for (const k of keys) if (!members.includes(k)) throw dataError(`${what} has unknown member '${k}'`)
  for (const m of members) if (!Object.prototype.hasOwnProperty.call(o, m)) throw dataError(`${what} lacks member '${m}'`)
}

/**
 * Lossy decode (no TextDecoder: the profile entry runs on React Native).
 * Malformed UTF-8 becomes U+FFFD, which the `colorProtocolID` round trip in
 * checkColorName then refuses, since it re-encodes to different hex.
 */
const hexToUtf8 = (hex: string): string => Utils.toUTF8(Utils.toArray(hex, 'hex'))

/**
 * `name` must be exactly `p color <assetTag(assetId)> <hex> <hex>` as
 * `colorProtocolID` writes it (lowercase hex of strict UTF-8 remittances of
 * at most 48 bytes, no whitespace; 0207:540-548). The round trip through
 * `colorProtocolID` rejects every alternate spelling.
 */
function checkColorName (assetId: string, name: string, what: string): void {
  if (name.length > MAX_PROTOCOL_NAME) throw dataError(`${what}.protocolID is longer than ${MAX_PROTOCOL_NAME} characters`)
  const parts = name.split(' ')
  if (parts.length !== 5 || parts[0] !== 'p' || parts[1] !== 'color') {
    throw dataError(`${what}.protocolID is not a p color protocol`)
  }
  if (parts[2] !== assetTag(assetId)) throw dataError(`${what}.protocolID names another asset`)
  if (!LOWER_HEX_PAIRS.test(parts[3]) || !LOWER_HEX_PAIRS.test(parts[4])) {
    throw dataError(`${what}.protocolID remittances must be lowercase hex`)
  }
  let canonical: string
  try {
    canonical = colorProtocolID(assetId, hexToUtf8(parts[3]), hexToUtf8(parts[4]))[1]
  } catch (e) {
    throw dataError(`${what}.protocolID has an invalid remittance (${(e as Error).message})`)
  }
  if (canonical !== name) throw dataError(`${what}.protocolID is not canonical`)
}

function checkBytes (b: number[], what: string): void {
  if (b.length < 1 || b.length > MAX_LINKAGE_BYTES) throw dataError(`${what} must hold 1..${MAX_LINKAGE_BYTES} bytes`)
}

/**
 * Parse the issuer-v1 plan leaf: exactly `{outputs: [{index, linkage}]}`,
 * unique indices, each linkage exactly the 8 BRC-72 members with
 * `verifier === K`, `prover === ctx.identityKey`, keyID `'color'`, a
 * canonical `p color` name of this asset, `proofType 0`, a canonical
 * counterparty key and byte arrays of 1..1024 entries. `undefined` stays
 * `undefined`.
 */
function parseLeaf (ctx: ProfileAssetContext, leaf: JsonValue | undefined, K: string): LinkageEntry[] | undefined {
  if (leaf === undefined) return undefined
  if (!isObject(leaf)) throw dataError('the leaf must be {"outputs": [...]}')
  exactMembers(leaf, ['outputs'], 'the leaf')
  const list = leaf.outputs
  if (!Array.isArray(list)) throw dataError('outputs must be an array')
  const seen = new Set<number>()
  return list.map((e, i) => {
    const what = `outputs[${i}]`
    if (!isObject(e)) throw dataError(`${what} must be an object`)
    exactMembers(e, ['index', 'linkage'], what)
    const index = e.index
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
      throw dataError(`${what}.index must be a non-negative integer`)
    }
    if (seen.has(index)) throw dataError(`duplicate output index ${index}`)
    seen.add(index)
    let linkage: SpecificLinkage
    try {
      linkage = readSpecificLinkage(e.linkage, `${what}.linkage`)
    } catch (err) {
      throw dataError((err as Error).message)
    }
    checkBytes(linkage.encryptedLinkage, `${what}.linkage.encryptedLinkage`)
    checkBytes(linkage.encryptedLinkageProof, `${what}.linkage.encryptedLinkageProof`)
    if (linkage.verifier !== K) throw dataError(`${what}.linkage.verifier is not the overlay identity key`)
    if (linkage.prover !== ctx.identityKey) throw dataError(`${what}.linkage.prover is not this wallet's identity key`)
    if (linkage.keyID !== COLOR_KEY_ID) throw dataError(`${what}.linkage.keyID must be '${COLOR_KEY_ID}'`)
    if (!isIdentityKey(linkage.counterparty)) throw dataError(`${what}.linkage.counterparty is not a canonical identity key`)
    checkColorName(ctx.assetId, linkage.protocolID[1], `${what}.linkage`)
    return { index, linkage }
  })
}

/** The leaf's indices must be exactly the asset's non-owned token outputs (no extra, no missing). */
function checkCoverage (entries: LinkageEntry[] | undefined, view: ProfileTxView): LinkageEntry[] {
  const nonOwned = view.outputs.filter(o => o.custody === undefined).map(o => o.outputIndex).sort((x, y) => x - y)
  if (entries === undefined) {
    if (nonOwned.length > 0) throw dataError(`the leaf is required: output(s) ${nonOwned.join(', ')} are not wallet-owned`)
    return []
  }
  const got = entries.map(e => e.index).sort((x, y) => x - y)
  if (got.length !== nonOwned.length || got.some((v, i) => v !== nonOwned[i])) {
    throw dataError(`leaf outputs [${got.join(', ')}] must be exactly the non-owned token outputs [${nonOwned.join(', ')}]`)
  }
  return entries
}

interface ReadToken { deploy: boolean, assetId?: string, pubKeyHash?: number[] }

/**
 * Any BRC-162 token-shaped script, whatever its remainder (so a foreign token
 * with an unusual lock cannot slip the one-asset rule). A token-shaped script
 * that does not decode fails closed.
 */
function readToken (script: LockingScript, what: string): ReadToken | undefined {
  if (!isTokenShaped(script)) return undefined
  let d: ReturnType<typeof OneColor.decode>
  try {
    d = OneColor.decode(script)
  } catch (e) {
    throw shapeError(`${what} is a malformed BRC-162 output (${(e as Error).message})`)
  }
  if (d.role === 'deploy') return { deploy: true }
  return {
    deploy: false,
    assetId: OneColor.tokenIdToString(d.tokenId as number[]),
    ...(d.restPubKeyHash != null ? { pubKeyHash: [...d.restPubKeyHash] } : {})
  }
}

/**
 * signAction shape (G10): every token output of the asset carries exactly 1
 * sat, and no input or output carries a token of any other asset, a deploy
 * included (D1). Inputs are read from their source transactions; a missing
 * one fails closed.
 */
function checkTxShape (assetId: string, tx: Transaction): void {
  tx.inputs.forEach((input, i) => {
    const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (source === undefined) throw shapeError(`input ${i} has no source output; one asset per transaction cannot be checked`)
    const token = readToken(source.lockingScript, `input ${i}`)
    if (token === undefined) return
    if (token.deploy || token.assetId !== assetId) {
      throw shapeError(`input ${i} spends a token of another asset; one Mandala asset per transaction (D1)`)
    }
  })
  tx.outputs.forEach((output, i) => {
    const token = readToken(output.lockingScript, `output ${i}`)
    if (token === undefined) return
    if (token.deploy || token.assetId !== assetId) {
      throw shapeError(`output ${i} is a token of another asset; one Mandala asset per transaction (D1)`)
    }
    if (output.satoshis !== 1) {
      throw shapeError(`output ${i} carries ${String(output.satoshis)} satoshis; Mandala token outputs carry exactly 1`)
    }
  })
}

/**
 * Linkage-script binding, as the overlay will check it (linkage.go): decrypt
 * L (the prover is this wallet, so the BRC-2 key with K is symmetric) and
 * require hash160(counterparty + L·G) to be the output's P2PKH hash.
 */
async function checkBinding (ctx: ProfileAssetContext, e: LinkageEntry, tx: Transaction): Promise<void> {
  const mismatch = (): ProfileDataError => dataError(`linkage does not match output ${e.index}`)
  const output = tx.outputs[e.index]
  if (output === undefined) throw mismatch()
  const token = readToken(output.lockingScript, `output ${e.index}`)
  if (token?.pubKeyHash === undefined) throw mismatch()
  let derived: number[]
  try {
    const { plaintext } = await ctx.wallet.decrypt({
      ciphertext: e.linkage.encryptedLinkage,
      protocolID: [2, `specific linkage revelation 2 ${e.linkage.protocolID[1]}`],
      keyID: COLOR_KEY_ID,
      counterparty: e.linkage.verifier
    })
    derived = outputPubKeyHash(outputPublicKey(PublicKey.fromString(e.linkage.counterparty), plaintext))
  } catch {
    throw mismatch()
  }
  const pkh = token.pubKeyHash
  if (derived.length !== pkh.length || derived.some((b, i) => b !== pkh[i])) throw mismatch()
}

/**
 * B1-i (C§5.2): check the issuer-v1 plan leaf against the asset's view. At
 * signAction (`view.tx` set) also checks the tx shape (1 sat, D1) and that
 * every leaf linkage derives its output's key.
 */
export async function checkPlanData (
  ctx: ProfileAssetContext,
  leaf: JsonValue | undefined,
  view: ProfileTxView
): Promise<void> {
  const K = issuerKey(ctx.descriptor)
  const entries = checkCoverage(parseLeaf(ctx, leaf, K), view)
  if (view.tx === undefined) return
  checkTxShape(ctx.assetId, view.tx)
  for (const e of entries) await checkBinding(ctx, e, view.tx)
}

/**
 * B1-ii (C§5.1, G9): the envelope `{"outputs":[…]}` for this asset: the plan
 * leaf entries plus, for each wallet-owned output, the underlying wallet's
 * `revealSpecificKeyLinkage` with the owner (`ctx.identityKey`, the overlay's
 * base key) as `counterparty`. Every token output must be covered exactly
 * once, and the result must not be empty.
 */
export async function submissionData (ctx: ProfileAssetContext, view: ProfileTxView): Promise<number[]> {
  const K = issuerKey(ctx.descriptor)
  const entries: LinkageEntry[] = [...checkCoverage(parseLeaf(ctx, view.planLeaf, K), view)]
  for (const o of view.outputs) {
    const custody = o.custody
    if (custody === undefined) continue
    if (custody.assetId !== ctx.assetId) throw dataError(`output ${o.outputIndex} custody names another asset`)
    let protocolID: [2, string]
    try {
      protocolID = colorProtocolID(custody.assetId, custody.derivationPrefix, custody.derivationSuffix)
    } catch (e) {
      throw dataError(`output ${o.outputIndex} custody: ${(e as Error).message}`)
    }
    const revealed = await ctx.wallet.revealSpecificKeyLinkage({
      counterparty: custody.senderIdentityKey,
      verifier: K,
      protocolID,
      keyID: COLOR_KEY_ID
    })
    const entry: LinkageEntry = {
      index: o.outputIndex,
      linkage: {
        prover: revealed.prover,
        verifier: K,
        counterparty: ctx.identityKey,
        protocolID,
        keyID: COLOR_KEY_ID,
        encryptedLinkage: Array.from(revealed.encryptedLinkage),
        encryptedLinkageProof: Array.from(revealed.encryptedLinkageProof),
        proofType: 0
      }
    }
    // The overlay derives the owner's key from this entry; prove it locks the output we sign.
    if (view.tx !== undefined) await checkBinding(ctx, entry, view.tx)
    entries.push(entry)
  }
  if (entries.length === 0) throw dataError('there is no token output to cover')
  try {
    return encodeEnvelope({ outputs: entries })
  } catch (e) {
    throw dataError((e as Error).message)
  }
}

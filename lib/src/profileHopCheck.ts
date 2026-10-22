/**
 * issuer-v1 offline local hop checks (C§4 "Local hop checks", G18, design
 * goal 4, Review Focus 6).
 *
 * When the recipient's own submit fails for transport reasons only,
 * `admitReceipt` answers `unavailable` and the color module may credit the
 * receipt offline (`color_offline`) on attested evidence. The module's
 * frontier validator proves every unanchored hop descends from attested
 * outputs (S1), but it knows nothing of Mandala policy. (In module 0.2.0 the
 * frontier validator runs before `admitReceipt` and already refuses a hop
 * whose value outputs exceed its inputs, so rule 1 is defense in depth there;
 * rules 2-5 are reachable only here. Pinned by Task 22's integration test.)
 * Without these checks
 * the wallet would credit value the overlay later refuses for good
 * (ERR_CONSERVATION, ERR_SATOSHIS, ERR_SHAPE, ERR_LINKAGE). So every
 * unanchored hop is checked here, against the same rules the overlay applies:
 *
 *   1. per-asset I == O (bigint), unless an authority input of the asset is spent;
 *   2. every token output of the asset (value and authority) carries exactly 1 sat;
 *   3. no input or output token of another asset, a deploy included (D1);
 *   4. no non-deploy token payload map with `req` or `ext`;
 *   5. the envelope covers exactly the asset's token outputs, each linkage
 *      with verifier K and keyID 'color'.
 *
 * Fail closed throughout: a hop whose AtomicBEEF does not parse, whose
 * subject is not the stated txid (stale cache), or one of whose inputs has no
 * source transaction is refused. A token-shaped script that does not decode
 * as a P2PKH 1Color output is refused too, so an unusual remainder can never
 * slip a foreign token past rule 3. Linkage bytes are not decrypted (only K
 * can); a wrong linkage is a typed overlay refusal at settle, which the
 * module reports as refused, never as credit gained.
 *
 * Pure and synchronous; no wallet or network call. Every refusal is the
 * module's ProfileDataError, `hop <txid>: <reason>`, matched by `.name`.
 */
import { Transaction, type LockingScript } from '@bsv/sdk'
import { isTokenShaped, readOneColorAttributes } from '@bsv/templates'
import { ProfileDataError, type ProfileAssetContext } from '@bsv/color-permission-module'
import { decodeToken, type DecodedToken } from './brc162.js'
import { decodeEnvelope, type MandalaEnvelope } from './encoding.js'

/** keyID of every `p color` derivation (0207:540-546). */
const COLOR_KEY_ID = 'color'
const TXID_RE = /^[0-9a-f]{64}$/

export interface OfflineHop { txid: string, atomicBEEF: number[], offChainValues: number[] }

class HopFailure extends Error {}
const fail = (reason: string): never => { throw new HopFailure(reason) }

/**
 * A token-shaped script as a decoded 1Color output, `undefined` for a
 * non-token. `txid`/`vout` name the script's own outpoint (a deploy's id).
 */
function readToken (script: LockingScript, txid: string, vout: number, what: string): DecodedToken | undefined {
  if (!isTokenShaped(script)) return undefined
  const token = decodeToken(script, txid, vout)
  if (token === null) return fail(`${what} is a token that does not decode as a P2PKH 1Color output`)
  return token
}

/** Rule 3 (D1): only this asset's value and authority tokens; never a deploy. */
function ownToken (token: DecodedToken, assetId: string, what: string): void {
  if (token.role === 'deploy' || token.assetId !== assetId) {
    fail(`${what} is a token of another asset; one Mandala asset per transaction (D1)`)
  }
}

function checkHop (assetId: string, hop: OfflineHop, K: string): void {
  if (hop == null || typeof hop !== 'object') return fail('not a hop')
  if (!Array.isArray(hop.atomicBEEF)) return fail('AtomicBEEF must be a byte array')
  let tx: Transaction
  try {
    tx = Transaction.fromAtomicBEEF(hop.atomicBEEF)
  } catch (e) {
    return fail(`AtomicBEEF does not parse (${(e as Error).message})`)
  }
  if (tx.id('hex') !== hop.txid) fail(`AtomicBEEF subject ${tx.id('hex')} is not the hop txid`)

  // Rules 1 and 3 over the inputs.
  let sumIn = 0n
  let authority = false
  tx.inputs.forEach((input, i) => {
    const source = input.sourceTransaction
    const output = source?.outputs[input.sourceOutputIndex]
    if (source === undefined || output === undefined) {
      fail(`input ${i} has no source transaction; the hop cannot be checked`)
      return
    }
    const token = readToken(output.lockingScript, source.id('hex'), input.sourceOutputIndex, `input ${i}`)
    if (token === undefined) return
    ownToken(token, assetId, `input ${i}`)
    if (token.role === 'authority') authority = true
    else sumIn += token.amount
  })

  // Rules 1-4 over the outputs.
  let sumOut = 0n
  const tokenOutputs: number[] = []
  tx.outputs.forEach((output, i) => {
    const token = readToken(output.lockingScript, hop.txid, i, `output ${i}`)
    if (token === undefined) return
    ownToken(token, assetId, `output ${i}`)
    tokenOutputs.push(i)
    if (output.satoshis !== 1) {
      fail(`output ${i} carries ${String(output.satoshis)} satoshis; Mandala token outputs carry exactly 1 satoshi`)
    }
    const attrs = readOneColorAttributes(token.payload)
    if (attrs.payload === 'map' && (attrs.req.status !== 'absent' || attrs.ext.status !== 'absent')) {
      fail(`output ${i}: req and ext are deploy-only under Mandala policy`)
    }
    if (token.role === 'value') sumOut += token.amount
  })
  if (!authority && sumIn !== sumOut) {
    fail(`the transaction does not conserve the asset (inputs ${sumIn}, outputs ${sumOut}) and spends no authority`)
  }

  // Rule 5: the envelope the overlay will check.
  let envelope: MandalaEnvelope
  try {
    envelope = decodeEnvelope(hop.offChainValues)
  } catch (e) {
    return fail(`the envelope is invalid (${(e as Error).message})`)
  }
  const entries = envelope.outputs ?? []
  const covered = entries.map(e => e.index).sort((x, y) => x - y)
  if (covered.length !== tokenOutputs.length || covered.some((v, i) => v !== tokenOutputs[i])) {
    fail(`the envelope covers outputs [${covered.join(', ')}], not exactly the token outputs [${tokenOutputs.join(', ')}]`)
  }
  for (const { index, linkage } of entries) {
    if (linkage.verifier !== K) fail(`envelope output ${index}: linkage verifier is not the overlay identity key`)
    if (linkage.keyID !== COLOR_KEY_ID) fail(`envelope output ${index}: linkage keyID must be '${COLOR_KEY_ID}'`)
  }
}

/**
 * Check every hop (C§4 local hop checks). Throws `ProfileDataError('hop
 * <txid>: <reason>')` on the first failure; returns only when every hop is
 * policy-clean.
 */
export function checkOfflineHops (ctx: ProfileAssetContext, hops: OfflineHop[], K: string): void {
  if (!Array.isArray(hops)) throw new ProfileDataError('BRC-207: Mandala issuer-v1 receipt: hops must be an array')
  for (const hop of hops) {
    const label = typeof hop?.txid === 'string' && TXID_RE.test(hop.txid) ? hop.txid : JSON.stringify(hop?.txid)
    try {
      checkHop(ctx.assetId, hop, K)
    } catch (e) {
      // A HopFailure carries the reason; anything unexpected fails closed the same way.
      throw new ProfileDataError(`hop ${label}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

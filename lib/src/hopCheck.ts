/**
 * The local Mandala checks of one unanchored hop (design §9 B7, audit S1,
 * C§4 "Local hop checks"). COVER (bundle.ts) runs this on every transaction
 * it would credit offline: the tip and each unadmitted ancestor. Each rule
 * mirrors a refusal the overlay would issue later, so an offline credit is
 * never made on value the overlay is certain to refuse for good:
 *
 *   0. every input's unlocking script verifies against the output it spends
 *      (BSV Chronicle rules as the sdk applies them; S is never normalized).
 *      Without this a payer could hand over a forged spend of anybody's
 *      admitted coin, or of the issuer's authority;
 *   1. per-asset I == O (bigint) unless an authority (or the deploy) is spent;
 *   2. a hop that spends an authority is a valid authority transition:
 *      exactly one authority input, exactly one authority output of amount 0
 *      whose `{adm}` commitment is sha256 of the strict details carried in
 *      the envelope's `admin` entry for that output, and the details decode;
 *   3. every token output of the asset carries exactly 1 sat;
 *   4. no token input or output of another asset (one asset per tx, D1); no
 *      deploy output; a token-shaped script that does not decode is refused;
 *   5. no non-deploy payload map with `req` or `ext`;
 *   6. the envelope covers exactly the asset's token outputs, each linkage
 *      with verifier K (and keyID 'color' on a holder hop).
 *
 * Linkage bytes are not decrypted (only K can); a wrong linkage is a typed
 * overlay refusal at settle. Pure and synchronous; throws HopCheckError.
 */
import { Spend, type LockingScript, type Transaction } from '@bsv/sdk'
import { isTokenShaped, readOneColorAttributes } from '@bsv/templates'
import { commitmentHex, commitmentOf, decodeAdminDetails, decodeToken, type DecodedToken } from './brc162.js'
import { decodeEnvelope, type MandalaEnvelope } from './encoding.js'

export class HopCheckError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'HopCheckError'
  }
}

const COLOR_KEY_ID = 'color'
const fail = (reason: string): never => { throw new HopCheckError(reason) }

function readToken (script: LockingScript, txid: string, vout: number, what: string): DecodedToken | undefined {
  if (!isTokenShaped(script)) return undefined
  const token = decodeToken(script, txid, vout)
  if (token === null) return fail(`${what} is a token that does not decode as a P2PKH 1Color output`)
  return token
}

/** Rule 0: the input's unlocking script against the spent output. */
function verifyInputScript (tx: Transaction, i: number): void {
  const input = tx.inputs[i]
  const source = input.sourceTransaction as Transaction
  const output = source.outputs[input.sourceOutputIndex]
  if (input.unlockingScript == null) fail(`input ${i} is unsigned`)
  let ok = false
  try {
    ok = new Spend({
      sourceTXID: input.sourceTXID ?? source.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      lockingScript: output.lockingScript,
      sourceSatoshis: output.satoshis ?? 0,
      transactionVersion: tx.version,
      otherInputs: [],
      allInputs: tx.inputs,
      unlockingScript: input.unlockingScript as any,
      inputSequence: input.sequence ?? 0xffffffff,
      inputIndex: i,
      outputs: tx.outputs,
      lockTime: tx.lockTime
    }).validateJavaScript()
  } catch (e) {
    fail(`input ${i}: the unlocking script does not verify (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!ok) fail(`input ${i}: the unlocking script does not verify`)
}

/**
 * Check one unanchored hop of `assetId` with its envelope bytes. Every input
 * must carry its source transaction (the hop cannot be checked otherwise).
 */
export function checkHop (assetId: string, tx: Transaction, envelopeBytes: number[], K: string): void {
  const txid = tx.id('hex')
  const own = (token: DecodedToken, what: string): void => {
    if (token.assetId !== assetId) fail(`${what} is a token of another asset; one Mandala asset per transaction (D1)`)
  }

  let sumIn = 0n
  let authorityInputs = 0
  tx.inputs.forEach((input, i) => {
    const source = input.sourceTransaction
    const output = source?.outputs[input.sourceOutputIndex]
    if (source == null || output == null) fail(`input ${i} has no source transaction; the hop cannot be checked`)
    verifyInputScript(tx, i)
    const s = source as Transaction
    const token = readToken(output!.lockingScript, s.id('hex'), input.sourceOutputIndex, `input ${i}`)
    if (token === undefined) return
    own(token, `input ${i}`)
    if (token.role === 'value') sumIn += token.amount
    else authorityInputs++ // authority, or the asset's own deploy (COVER checked which)
  })

  let sumOut = 0n
  const tokenOutputs: number[] = []
  const authorityOutputs: Array<{ index: number, token: DecodedToken }> = []
  tx.outputs.forEach((output, i) => {
    const token = readToken(output.lockingScript, txid, i, `output ${i}`)
    if (token === undefined) return
    if (token.role === 'deploy') fail(`output ${i} is a deploy; a hand-over hop never deploys`)
    own(token, `output ${i}`)
    tokenOutputs.push(i)
    if (output.satoshis !== 1) fail(`output ${i} carries ${String(output.satoshis)} satoshis; Mandala token outputs carry exactly 1 satoshi`)
    if (token.role === 'authority') {
      authorityOutputs.push({ index: i, token })
      return
    }
    const attrs = readOneColorAttributes(token.payload)
    if (attrs.payload === 'map' && (attrs.req.status !== 'absent' || attrs.ext.status !== 'absent')) {
      fail(`output ${i}: req and ext are deploy-only under Mandala policy`)
    }
    sumOut += token.amount
  })

  let envelope: MandalaEnvelope
  try {
    envelope = decodeEnvelope(envelopeBytes)
  } catch (e) {
    return fail(`the envelope is invalid (${(e as Error).message})`)
  }

  if (authorityInputs === 0) {
    if (authorityOutputs.length > 0) fail('an authority output is created without spending an authority')
    if (sumIn !== sumOut) fail(`the transaction does not conserve the asset (inputs ${sumIn}, outputs ${sumOut}) and spends no authority`)
  } else {
    // Rule 2: one authority in, the next one out, committing to admin details the envelope carries.
    if (authorityInputs !== 1) fail(`the transaction spends ${authorityInputs} authorities; an authority transition spends exactly one`)
    if (authorityOutputs.length !== 1) fail(`the transaction creates ${authorityOutputs.length} authority outputs; an authority transition creates exactly one`)
    const [next] = authorityOutputs
    if (next.token.amount !== 0n) fail(`authority output ${next.index} carries amount ${next.token.amount}`)
    const commitment = commitmentOf(next.token.payload)
    if (commitment == null) fail(`authority output ${next.index} carries no {adm} commitment`)
    const admin = (envelope.admin ?? []).find(a => a.index === next.index)
    if (admin == null) fail(`the envelope carries no admin details for authority output ${next.index}`)
    const details = decodeAdminDetails(admin!.details)
    if (details == null) fail(`the admin details for authority output ${next.index} do not decode`)
    if (commitmentHex(Array.from(hexBytes(admin!.details))) !== commitment) {
      fail(`authority output ${next.index} does not commit to the envelope's admin details`)
    }
  }

  // Rule 6: the envelope the overlay will check.
  const entries = envelope.outputs ?? []
  const coveredIdx = entries.map(x => x.index).sort((x, y) => x - y)
  if (coveredIdx.length !== tokenOutputs.length || coveredIdx.some((v, i) => v !== tokenOutputs[i])) {
    fail(`the envelope covers outputs [${coveredIdx.join(', ')}], not exactly the token outputs [${tokenOutputs.join(', ')}]`)
  }
  for (const { index, linkage } of entries) {
    if (linkage.verifier !== K) fail(`envelope output ${index}: linkage verifier is not the overlay identity key`)
    if (authorityInputs === 0 && linkage.keyID !== COLOR_KEY_ID) fail(`envelope output ${index}: linkage keyID must be '${COLOR_KEY_ID}'`)
  }
}

function hexBytes (hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

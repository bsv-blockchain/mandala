/**
 * Test-only Mandala overlay over `fetch` (plan 04 Task 22), shared by the
 * issuer's lib globals (`globalThis.fetch`) and the holders' Mandala
 * providers (`createMandalaProfile({ fetch })`).
 *
 * `POST /submit` (C§6 framing): the X-Topics header, the varint framing iff
 * `x-includes-off-chain-values: true`, an AtomicBEEF subject. Per
 * `tm_color_<assetId>` topic it applies the overlay rules the seam depends on:
 * - every token input of the asset must be admitted and unspent
 *   (ERR_INPUT_SPENT), and a transfer must conserve (Σin = Σout, bigint)
 *   unless an authority input of the asset is spent (ERR_CONSERVATION);
 * - the Mandala envelope must cover every token output of the asset, and each
 *   linkage must name K as verifier and decrypt under K to an L with
 *   `hash160(counterparty + L·G)` equal to the output's P2PKH hash, exactly
 *   as overlay-go's linkage.go does (ERR_LINKAGE).
 * Admitted topics are answered with `signedSteak` (attested v1 on
 * `tm_color_*`, σI v3 on `tm_mandala`). A replay of an applied txid returns
 * the same entries, re-signed (idempotent /submit, D7).
 *
 * `POST /lookup` answers `color-spendability` (admitted and unspent) and
 * `color-admission` (ever admitted), each entry with AtomicBEEF and `txid`.
 * `offline` makes every request throw `TypeError('fetch failed')`; `refuse`
 * answers every later `/submit` with a typed verdict until `refuse(null)`.
 *
 * This file must not name the color module (core isolation scans fixtures).
 */
import { PrivateKey, ProtoWallet, PublicKey, Transaction, Utils } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { decodeToken } from '../brc162.js'
import { decodeEnvelope, type MandalaEnvelope } from '../encoding.js'
import { isColorTopic } from '../naming.js'
import { outputPubKeyHash, outputPublicKey } from '../blinding.js'
import { REGISTRY_TOPIC, TOPIC } from '../constants.js'
import { signedSteak } from './overlaySigner.js'

export interface FakeSubmission {
  topics: string[]
  beef: number[]
  offChainValues: number[]
  steak: Record<string, any>
  txid: string
}

export interface FakeMandalaOverlay {
  fetch: typeof fetch
  offline: boolean
  /** Answer every later /submit with `{status:'error', code, retryable}` at `status`; `refuse(null)` clears it. */
  refuse: (code: string | null, status?: number, retryable?: boolean) => void
  /** Every outpoint ever admitted on a color topic. */
  admitted: Set<string>
  spent: Set<string>
  /** Every accepted /submit, in order (replays of an applied txid are not repeated here). */
  submissions: FakeSubmission[]
  /** Every /submit body that reached the overlay (accepted or refused), in order. */
  requests: Array<{ topics: string[], txid: string }>
  /** The request paths refused with a transport failure while `offline`, in order. */
  offlineAttempts: string[]
}

class Verdict extends Error {
  constructor (readonly code: string, readonly status: number, readonly retryable: boolean, description: string) {
    super(description)
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function header (headers: unknown, name: string): string | undefined {
  if (headers == null) return undefined
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  for (const [k, v] of Object.entries(headers as Record<string, string>)) if (k.toLowerCase() === name.toLowerCase()) return v
  return undefined
}

async function bodyBytes (body: unknown): Promise<number[]> {
  if (body instanceof Uint8Array) return Array.from(body)
  if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body))
  if (typeof body === 'string') return Utils.toArray(body, 'utf8')
  throw new TypeError('fake overlay: unsupported request body')
}

export function fakeMandalaOverlay ({ priv }: { priv: PrivateKey }): FakeMandalaOverlay {
  const K = priv.toPublicKey().toString()
  const kWallet = new ProtoWallet(priv)
  /** outpoint → the admitted output (asset, tx). */
  const outputs = new Map<string, { assetId: string, tx: Transaction, vout: number }>()
  const applied = new Map<string, Record<string, number[]>>()
  let refusal: { code: string, status: number, retryable: boolean } | undefined

  const state: FakeMandalaOverlay = {
    offline: false,
    admitted: new Set(),
    spent: new Set(),
    submissions: [],
    requests: [],
    offlineAttempts: [],
    refuse (code, status = 409, retryable = true) {
      refusal = code == null ? undefined : { code, status, retryable }
    },
    fetch: (async (input: unknown, init?: any): Promise<Response> => {
      const path = new URL(String(input)).pathname
      if (state.offline) {
        state.offlineAttempts.push(path)
        throw new TypeError('fetch failed')
      }
      if (path.endsWith('/submit')) return await submit(init)
      if (path.endsWith('/lookup')) return await lookup(init)
      return json(404, { status: 'error', message: `no route ${path}` })
    }) as typeof fetch
  }

  async function submit (init: any): Promise<Response> {
    const topics = JSON.parse(header(init?.headers, 'X-Topics') ?? '[]') as string[]
    let beef = await bodyBytes(init?.body)
    let offChainValues: number[] = []
    if (header(init?.headers, 'x-includes-off-chain-values') === 'true') {
      const r = new Utils.Reader(beef)
      const n = r.readVarIntNum()
      const rest = beef.slice(r.pos)
      beef = rest.slice(0, n)
      offChainValues = rest.slice(n)
    }
    const tx = Transaction.fromAtomicBEEF(beef)
    const txid = tx.id('hex')
    state.requests.push({ topics, txid })
    if (refusal != null) {
      return json(refusal.status, {
        status: 'error', code: refusal.code, retryable: refusal.retryable, description: `refused by the test overlay (${refusal.code})`, message: refusal.code
      })
    }
    const replay = applied.get(txid)
    if (replay != null) return json(200, await signedSteak(txid, replay, priv))
    let entries: Record<string, number[]>
    try {
      entries = await evaluate(tx, txid, topics, offChainValues)
    } catch (e) {
      if (e instanceof Verdict) {
        return json(e.status, { status: 'error', code: e.code, retryable: e.retryable, description: e.message, message: e.message })
      }
      throw e
    }
    // Apply: inputs of every admitted asset are spent, outputs admitted.
    for (const [topic, outs] of Object.entries(entries)) {
      if (!isColorTopic(topic)) continue
      const assetId = topic.slice('tm_color_'.length)
      for (const input of tx.inputs) {
        const src = input.sourceTransaction!
        const op = `${src.id('hex')}.${input.sourceOutputIndex}`
        if (outputs.get(op)?.assetId === assetId) state.spent.add(op)
      }
      for (const vout of outs) {
        outputs.set(`${txid}.${vout}`, { assetId, tx, vout })
        state.admitted.add(`${txid}.${vout}`)
      }
    }
    applied.set(txid, entries)
    const steak = await signedSteak(txid, entries, priv)
    state.submissions.push({ topics, beef, offChainValues, steak, txid })
    return json(200, steak)
  }

  async function evaluate (tx: Transaction, txid: string, topics: string[], offChainValues: number[]): Promise<Record<string, number[]>> {
    if (topics.length === 0) throw new Verdict('ERR_SHAPE', 400, false, 'no topics')
    let env: MandalaEnvelope | undefined
    const envelope = (): MandalaEnvelope => {
      if (env != null) return env
      try {
        env = decodeEnvelope(offChainValues)
      } catch (e) {
        throw new Verdict('ERR_LINKAGE', 400, false, `bad envelope: ${(e as Error).message}`)
      }
      return env
    }
    const entries: Record<string, number[]> = {}
    for (const topic of topics) {
      if (topic === TOPIC) {
        const d = decodeToken(tx.outputs[0]?.lockingScript, txid, 0)
        if (d?.role !== 'deploy') throw new Verdict('ERR_SHAPE', 400, false, 'tm_mandala admits only a deploy at output 0')
        entries[topic] = [0]
        continue
      }
      if (topic === REGISTRY_TOPIC) { entries[topic] = []; continue }
      if (!isColorTopic(topic)) throw new Verdict('ERR_SHAPE', 400, false, `unknown-topic: ${topic}`)
      const assetId = topic.slice('tm_color_'.length)
      // Token outputs of the asset (a deploy names its own new asset).
      const outs: number[] = []
      let outValue = 0n
      tx.outputs.forEach((o, vout) => {
        const d = decodeToken(o.lockingScript, txid, vout)
        if (d?.assetId !== assetId) return
        if (o.satoshis !== 1) throw new Verdict('ERR_SATOSHIS', 400, false, `output ${vout}: token outputs carry exactly 1 satoshi`)
        outs.push(vout)
        if (d.role === 'value') outValue += d.amount
      })
      if (outs.length === 0) throw new Verdict('ERR_SHAPE', 400, false, `no outputs of ${assetId}`)
      let inValue = 0n
      let authority = false
      for (const input of tx.inputs) {
        const src = input.sourceTransaction
        if (src == null) throw new Verdict('ERR_SHAPE', 400, false, 'input without source')
        const op = `${src.id('hex')}.${input.sourceOutputIndex}`
        const admitted = outputs.get(op)
        if (admitted?.assetId !== assetId) continue
        if (state.spent.has(op)) throw new Verdict('ERR_INPUT_SPENT', 400, false, `input ${op} is spent`)
        const d = decodeToken(src.outputs[input.sourceOutputIndex].lockingScript, src.id('hex'), input.sourceOutputIndex)
        if (d == null) continue
        if (d.role === 'value') inValue += d.amount
        else authority = true // authority or deploy (the first authority)
      }
      const deploy = outs.some(v => decodeToken(tx.outputs[v].lockingScript, txid, v)?.role === 'deploy')
      if (!deploy && !authority && inValue !== outValue) {
        throw new Verdict('ERR_CONSERVATION', 400, false, `inputs ${inValue} != outputs ${outValue}`)
      }
      // Linkage: every token output of the asset is covered and derives its key.
      const covered = new Map((envelope().outputs ?? []).map(o => [o.index, o.linkage]))
      for (const vout of outs) {
        const l = covered.get(vout)
        if (l == null) throw new Verdict('ERR_LINKAGE', 400, false, `output ${vout}: no linkage`)
        if (l.verifier !== K) throw new Verdict('ERR_LINKAGE', 400, false, `output ${vout}: verifier is not this overlay`)
        let L: number[]
        try {
          L = (await kWallet.decrypt({
            ciphertext: l.encryptedLinkage,
            protocolID: [2, `specific linkage revelation ${l.protocolID[0]} ${l.protocolID[1]}`],
            keyID: l.keyID,
            counterparty: l.prover
          })).plaintext
        } catch {
          throw new Verdict('ERR_LINKAGE', 400, false, `output ${vout}: linkage does not decrypt`)
        }
        const pkh = OneColor.decode(tx.outputs[vout].lockingScript).restPubKeyHash
        const derived = outputPubKeyHash(outputPublicKey(PublicKey.fromString(l.counterparty), L))
        if (pkh == null || Utils.toHex(pkh) !== Utils.toHex(derived)) {
          throw new Verdict('ERR_LINKAGE', 400, false, `output ${vout}: linkage does not derive the output key`)
        }
      }
      entries[topic] = outs
    }
    return entries
  }

  async function lookup (init: any): Promise<Response> {
    const { service, query } = JSON.parse(String(init?.body ?? '{}'))
    if (query?.type !== 'color-spendability' && query?.type !== 'color-admission') {
      return json(400, { status: 'error', message: 'Invalid lookup query: unsupported type' })
    }
    if (service !== `ls_color_${String(query.assetId)}` || query.topic !== `tm_color_${String(query.assetId)}`) {
      return json(400, { status: 'error', message: 'Invalid lookup query: service/topic mismatch' })
    }
    const answer = (query.outpoints as string[]).flatMap(op => {
      const o = outputs.get(op)
      if (o == null || o.assetId !== query.assetId) return []
      if (query.type === 'color-spendability' && state.spent.has(op)) return []
      return [{ beef: o.tx.toAtomicBEEF(), outputIndex: o.vout, txid: o.tx.id('hex') }]
    })
    return json(200, { type: 'output-list', outputs: answer })
  }

  return state
}

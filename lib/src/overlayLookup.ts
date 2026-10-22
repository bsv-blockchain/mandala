/**
 * BRC-24 `POST /lookup` against the Mandala overlay (C§6) and the
 * hash-verified deploy fetch (C§8.1).
 *
 * Errors are `LookupError`s classified exactly as the Mandala provider
 * classifies submits (C§6, D22). No verdict ⇒ `ERR_UNAVAILABLE` (retryable,
 * `transport: true`): a fetch failure, a timeout, a 5xx, a 408/429, a
 * non-OK status below 400, a non-OK answer whose body is empty or not JSON,
 * or an untyped JSON 4xx other than 400 (an intermediary, never overlay-go).
 * A verdict ⇒ `transport: false`: a typed JSON 4xx keeps its code and
 * `retryable`; overlay-go's untyped JSON 400 (`{status, message}`) is a
 * final `ERR_LOOKUP`. Only `transport` may ever be
 * read as "the overlay is unreachable": an answer that fails verification is
 * `ERR_INVALID_ANSWER` with `transport: false`, so a bad or poisoned answer
 * can never be mistaken for an outage. Callers match on `.name` and the
 * `(ERR_*` code in the message, never `instanceof`.
 *
 * Uses `fetch` only (RN-safe).
 */
import { Transaction } from '@bsv/sdk'
import { OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'
import { decodeToken } from './brc162.js'
import { colorLookup, colorTopic } from './naming.js'

/** A BRC-24 output-list answer. Assignable to the sdk `LookupAnswer`. */
export interface LookupOutputList {
  type: 'output-list'
  outputs: Array<{ beef: number[], outputIndex: number, txid: string }>
}

export class LookupError extends Error {
  readonly code: string
  readonly retryable: boolean
  /** True only when the overlay could not be reached or did not answer (never for a verdict or a bad answer). */
  readonly transport: boolean

  constructor (p: { code: string, retryable: boolean, transport: boolean, description?: string }) {
    const tag = p.retryable ? `${p.code}, retryable` : p.code
    super(`[LookupError] mandala overlay lookup failed (${tag})${p.description != null && p.description !== '' ? `: ${p.description}` : ''}`)
    this.name = 'LookupError'
    this.code = p.code
    this.retryable = p.retryable
    this.transport = p.transport
  }
}

/** The slice of `Response` postLookup reads (keeps it mockable and RN-safe). */
export interface LookupFetchResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}

export interface LookupOptions {
  /** Overlay base URL; default the configured OVERLAY_URL. */
  url?: string
  fetch?: (url: string, init: any) => Promise<LookupFetchResponse>
  /** Default 15000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15000
const TXID_RE = /^[0-9a-f]{64}$/
const MANDALA_ASSET_ID = /^([0-9a-f]{64})_0$/

const unavailable = (description: string): LookupError =>
  new LookupError({ code: 'ERR_UNAVAILABLE', retryable: true, transport: true, description })
const invalidAnswer = (description: string): LookupError =>
  new LookupError({ code: 'ERR_INVALID_ANSWER', retryable: true, transport: false, description })

function isByteArray (v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every(b => Number.isInteger(b) && b >= 0 && b <= 255)
}

function readOutputList (v: unknown): LookupOutputList {
  const a = v as { type?: unknown, outputs?: unknown }
  if (a == null || typeof a !== 'object' || a.type !== 'output-list' || !Array.isArray(a.outputs)) {
    throw invalidAnswer('the answer is not an output-list')
  }
  const outputs = a.outputs.map((o: any, i: number) => {
    if (o == null || typeof o !== 'object' || !isByteArray(o.beef) ||
      !Number.isInteger(o.outputIndex) || o.outputIndex < 0 || o.outputIndex > 0xffffffff) {
      throw invalidAnswer(`output ${i} is malformed`)
    }
    // C§6: overlay-go sends the AtomicBEEF subject's txid on every entry. It is
    // required, never derived from the same bytes (that would make the
    // consumer's fromBEEF(beef, txid) check circular), and never trusted on
    // its own: consumers re-hash what they parse.
    const txid: unknown = o.txid
    if (typeof txid !== 'string' || !TXID_RE.test(txid)) throw invalidAnswer(`output ${i} has no valid txid`)
    return { beef: o.beef as number[], outputIndex: o.outputIndex as number, txid }
  })
  return { type: 'output-list', outputs }
}

/**
 * POST `{service, query}` to `<url>/lookup` and return the output-list.
 * Throws `Error(OVERLAY_URL_UNSET)` before any request when no URL is
 * configured, else only `LookupError`.
 */
export async function postLookup (service: string, query: unknown, o: LookupOptions = {}): Promise<LookupOutputList> {
  const base = o.url ?? OVERLAY_URL
  if (base === '') throw new Error(OVERLAY_URL_UNSET)
  const doFetch = o.fetch ?? ((url: string, init: any) => (globalThis as any).fetch(url, init))
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the race as a timeout first, then cancel the request.
      reject(unavailable(`lookup timed out after ${timeoutMs} ms`))
      controller?.abort()
    }, timeoutMs)
  })

  let status = 0
  let text = ''
  let okStatus = false
  try {
    const res = await Promise.race([
      doFetch(`${base}/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, query }),
        ...(controller != null ? { signal: controller.signal } : {})
      }),
      timedOut
    ])
    status = res.status
    okStatus = res.ok
    try {
      text = await Promise.race([res.text(), timedOut])
    } catch (e) {
      if ((e as { name?: unknown })?.name === 'LookupError') throw e
      text = ''
    }
  } catch (e) {
    if ((e as { name?: unknown })?.name === 'LookupError') throw e
    throw unavailable(String((e as { message?: unknown })?.message ?? e))
  } finally {
    if (timer != null) clearTimeout(timer)
  }

  let body: any
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = undefined
  }

  if (!okStatus) {
    const description = typeof body?.description === 'string'
      ? body.description
      : typeof body?.message === 'string' ? body.message : `overlay returned ${status}`
    // No verdict: the same rule as the provider's submit (C§6).
    if (body === undefined || status >= 500 || status === 408 || status === 429 || status < 400) {
      throw unavailable(description)
    }
    if (body?.status === 'error' && typeof body.code === 'string' && /^ERR_[A-Z0-9_]+$/.test(body.code)) {
      throw new LookupError({ code: body.code, retryable: body.retryable === true, transport: false, description })
    }
    // overlay-go's untyped lookup error is a 400 ({status, message}): a final
    // refusal of the question. Any other untyped JSON 4xx is an intermediary's.
    if (status !== 400) throw unavailable(description)
    throw new LookupError({ code: 'ERR_LOOKUP', retryable: false, transport: false, description })
  }
  if (body === undefined) throw unavailable(`overlay returned ${status} with a non-JSON body`)
  return readOutputList(body)
}

// ---------------------------------------------------------------------------
// Deploy fetch
// ---------------------------------------------------------------------------

/** Verified deploy raw tx bytes, keyed by `<url>|<assetId>`. Only verified answers enter. */
const deployMemo = new Map<string, number[]>()

/** Test helper: forget every memoized deploy. */
export function clearDeployTxCache (): void {
  deployMemo.clear()
}

/**
 * The deploy transaction of a Mandala asset `<txid>_0`, fetched through
 * `ls_color_<assetId>` (`color-admission` of `<txid>.0`, C§6).
 *
 * Verified before use: the BEEF is parsed for the txid the asset id names
 * (the answer's own `txid` is never trusted), the parsed tx must hash to it,
 * and its output 0 must decode as a 1Color deploy. A verified answer is
 * memoized as raw bytes and every call returns a fresh `Transaction`, so a
 * caller that mutates its copy cannot poison the cache. A failed or invalid
 * answer is never memoized.
 */
export async function fetchDeployTx (assetId: string, o: LookupOptions = {}): Promise<Transaction> {
  const m = typeof assetId === 'string' ? MANDALA_ASSET_ID.exec(assetId) : null
  if (m == null) throw new TypeError(`@bsv/mandala: ${JSON.stringify(assetId)} is not a Mandala asset id (<64 lowercase hex>_0)`)
  const txid = m[1]
  const memoKey = `${o.url ?? OVERLAY_URL}|${assetId}`
  const hit = deployMemo.get(memoKey)
  if (hit != null) return Transaction.fromBinary(hit)

  const answer = await postLookup(colorLookup(assetId), {
    type: 'color-admission',
    version: 1,
    assetId,
    topic: colorTopic(assetId),
    outpoints: [`${txid}.0`]
  }, o)
  const row = answer.outputs.find(r => r.outputIndex === 0 && r.txid === txid) ?? answer.outputs[0]
  if (row == null) {
    throw new LookupError({ code: 'ERR_NOT_FOUND', retryable: true, transport: false, description: `no admitted deploy for ${assetId}` })
  }
  let tx: Transaction
  try {
    tx = Transaction.fromBEEF(row.beef, txid)
  } catch (e) {
    throw invalidAnswer(`the answer does not carry deploy ${txid}: ${String((e as { message?: unknown })?.message ?? e)}`)
  }
  if (tx.id('hex') !== txid) throw invalidAnswer(`the answer's transaction hashes to ${tx.id('hex')}, not ${txid}`)
  const out0 = tx.outputs[0]
  const decoded = out0 != null ? decodeToken(out0.lockingScript, txid, 0) : null
  if (decoded == null || decoded.role !== 'deploy') throw invalidAnswer(`output 0 of ${txid} is not a 1Color deploy`)
  const raw = tx.toBinary()
  deployMemo.set(memoKey, raw)
  return Transaction.fromBinary(raw)
}

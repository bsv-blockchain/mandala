/**
 * The Mandala overlay as a BRC-207 `ColorOverlayProvider` (C§6, C§8.2), for
 * `@bsv/mandala/profile`. The issuer-v1 handler routes every query and submit
 * of a Mandala asset here (by the overlay identity key K its deploy `req`
 * names), so the module talks to the issuer's own overlay and to nothing else.
 *
 * Errors are the module's `ColorProviderError(code, retryable, transport,
 * message)`. The classification decides whether a recipient may ever take the
 * offline path (D6), so it is deliberately narrow:
 *
 * - `transport: true` (`ERR_UNAVAILABLE`, retryable): the overlay could not be
 *   reached or gave no verdict: a fetch failure, a timeout, a 5xx, a 408/429,
 *   a non-JSON body, or a typed `ERR_UNAVAILABLE`.
 * - `transport: false`: a typed verdict (`(body.code, body.retryable)`), an
 *   untyped JSON 4xx (`ERR_REQUEST`/`ERR_LOOKUP`, final), or an answer that
 *   fails validation (`ERR_INVALID_ANSWER`). A bad or poisoned answer is never
 *   reported as an outage, so it can never open the offline path.
 *
 * Message: `[ColorProviderError] mandala overlay refused (<CODE>[, retryable]): <description>`.
 * The module's constructor adds the `[ColorProviderError] ` prefix (once);
 * receivers parse the `(ERR_` code (G13, D22).
 *
 * Stability: every call is stateless and idempotent at this layer (a resubmit
 * of the same bytes is the overlay's idempotent replay); arguments are
 * validated before any network call; a timeout aborts the request.
 */
import { PublicKey, Utils } from '@bsv/sdk'
import { ColorProviderError, type AttestedSTEAK, type ColorOverlayProvider } from '@bsv/color-permission-module'
import { postLookup, type LookupFetchResponse, type LookupOutputList } from './overlayLookup.js'
import { colorLookup, colorTopic } from './naming.js'

export interface MandalaOverlayProviderOptions {
  /** Overlay base URL (http or https), e.g. `https://overlay.example`. */
  url: string
  /** The overlay's identity key K (66 lowercase hex, compressed, on curve). */
  identityKey: string
  fetch?: typeof fetch
  /** Per request; default 15000. */
  timeoutMs?: number
}

export type MandalaOverlayProvider = ColorOverlayProvider & { readonly url: string, readonly identityKey: string }

const DEFAULT_TIMEOUT_MS = 15000
const MAX_OUTPOINTS = 1000
const MAX_VOUT = 4294967295
const OUTPOINT_RE = /^([0-9a-f]{64})\.(0|[1-9][0-9]{0,9})$/
const KEY_RE = /^0[23][0-9a-f]{64}$/
const CODE_RE = /^ERR_[A-Z0-9_]+$/
const LOOKUP_MESSAGE_RE = /^\[LookupError\] mandala overlay lookup failed \([^)]*\)(?:: ([\s\S]*))?$/

type FetchLike = (url: string, init: any) => Promise<LookupFetchResponse>

function providerError (code: string, retryable: boolean, transport: boolean, description: string): ColorProviderError {
  const tag = retryable ? `${code}, retryable` : code
  return new ColorProviderError(code, retryable, transport, `mandala overlay refused (${tag}): ${description}`)
}

const unavailable = (description: string): ColorProviderError => providerError('ERR_UNAVAILABLE', true, true, description)

function checkIdentityKey (k: unknown): string {
  if (typeof k !== 'string' || !KEY_RE.test(k)) {
    throw new TypeError('@bsv/mandala: the Mandala overlay identity key must be 66 lowercase hex characters (compressed)')
  }
  try {
    if (PublicKey.fromString(k).toString() !== k) throw new Error('not canonical')
  } catch {
    throw new TypeError('@bsv/mandala: the Mandala overlay identity key is not a point on the curve')
  }
  return k
}

function checkUrl (url: unknown): string {
  if (typeof url !== 'string' || url === '') throw new TypeError('@bsv/mandala: the Mandala overlay url is required')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new TypeError(`@bsv/mandala: the Mandala overlay url ${JSON.stringify(url)} is not a URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`@bsv/mandala: the Mandala overlay url ${JSON.stringify(url)} must be http or https`)
  }
  return url
}

/** 1..1000 unique canonical `<txid>.<vout>` outpoints (C§6), else TypeError. */
function checkOutpoints (outpoints: unknown): string[] {
  if (!Array.isArray(outpoints) || outpoints.length === 0 || outpoints.length > MAX_OUTPOINTS) {
    throw new TypeError(`@bsv/mandala: outpoints must be an array of 1..${MAX_OUTPOINTS} outpoints`)
  }
  const seen = new Set<string>()
  for (const o of outpoints) {
    const m = typeof o === 'string' ? OUTPOINT_RE.exec(o) : null
    // vout is an output index, not a token amount: Number() is exact here.
    if (m == null || Number(m[2]) > MAX_VOUT) {
      throw new TypeError(`@bsv/mandala: ${JSON.stringify(o)} is not a canonical outpoint (<64 lowercase hex>.<vout>)`)
    }
    if (seen.has(o)) throw new TypeError(`@bsv/mandala: duplicate outpoint ${o}`)
    seen.add(o)
  }
  return [...outpoints] as string[]
}

function isByteArray (v: unknown, allowEmpty: boolean): v is number[] {
  return Array.isArray(v) && (allowEmpty || v.length > 0) && v.every(b => Number.isInteger(b) && b >= 0 && b <= 255)
}

/** A `LookupError` (or anything postLookup throws) as a `ColorProviderError`, keeping its classification. */
function fromLookupError (e: unknown): ColorProviderError {
  const x = e as { name?: unknown, code?: unknown, retryable?: unknown, transport?: unknown, message?: unknown } | undefined
  if (x?.name === 'LookupError' && typeof x.code === 'string') {
    const message = typeof x.message === 'string' ? x.message : ''
    const description = LOOKUP_MESSAGE_RE.exec(message)?.[1] ?? message
    // A typed ERR_UNAVAILABLE is "no verdict" whatever its status (C§2.1 transport rule).
    if (x.code === 'ERR_UNAVAILABLE') return unavailable(description)
    return providerError(x.code, x.retryable === true, x.transport === true, description)
  }
  // Not a classified answer (should not happen: the url is validated): no verdict, so transport.
  return unavailable(String(x?.message ?? e))
}

/** Race a promise against the request timer. */
async function within<T> (p: Promise<T>, timedOut: Promise<never>): Promise<T> {
  return await Promise.race([p, timedOut])
}

/** POST /submit with C§6 framing; resolves the parsed STEAK object, else throws ColorProviderError. */
async function postSubmit (
  url: string, doFetch: FetchLike, timeoutMs: number,
  topics: string[], beef: number[], offChainValues: number[] | undefined
): Promise<AttestedSTEAK> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Topics': JSON.stringify(topics)
  }
  let body: Uint8Array
  // C§6: the header and the varint framing iff there ARE off-chain values.
  if (offChainValues != null && offChainValues.length > 0) {
    headers['x-includes-off-chain-values'] = 'true'
    const w = new Utils.Writer()
    w.writeVarIntNum(beef.length)
    w.write(beef)
    w.write(offChainValues)
    body = new Uint8Array(w.toArray())
  } else {
    body = new Uint8Array(beef)
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(unavailable(`submit timed out after ${timeoutMs} ms`))
      controller?.abort()
    }, timeoutMs)
  })
  // A rejection nobody awaits (the race already settled) must not surface as unhandled.
  timedOut.catch(() => {})

  let status = 0
  let ok = false
  let text = ''
  try {
    const res = await within(doFetch(`${url}/submit`, {
      method: 'POST',
      headers,
      body,
      ...(controller != null ? { signal: controller.signal } : {})
    }), timedOut)
    status = res.status
    ok = res.ok
    try {
      text = await within(res.text(), timedOut)
    } catch (e) {
      if ((e as { name?: unknown })?.name === 'ColorProviderError') throw e
      text = ''
    }
  } catch (e) {
    if ((e as { name?: unknown })?.name === 'ColorProviderError') throw e
    throw unavailable(String((e as { message?: unknown })?.message ?? e))
  } finally {
    if (timer != null) clearTimeout(timer)
  }

  let parsed: any
  let isJson = false
  try {
    if (text !== '') {
      parsed = JSON.parse(text)
      isJson = true
    }
  } catch {
    isJson = false
  }

  if (!ok) {
    const description = typeof parsed?.description === 'string'
      ? parsed.description
      : typeof parsed?.message === 'string' ? parsed.message : `overlay returned ${status}`
    if (!isJson || status >= 500 || status === 408 || status === 429 || status < 400) {
      throw unavailable(description)
    }
    if (parsed?.status === 'error' && typeof parsed.code === 'string' && CODE_RE.test(parsed.code)) {
      if (parsed.code === 'ERR_UNAVAILABLE') throw unavailable(description)
      throw providerError(parsed.code, parsed.retryable === true, false, description)
    }
    // A JSON 4xx without a typed verdict: the overlay refused the request itself (headers, framing). Final.
    throw providerError('ERR_REQUEST', false, false, description)
  }
  if (!isJson) throw unavailable(`overlay returned ${status} with a non-JSON body`)
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed) ||
    Object.values(parsed).some(v => v == null || typeof v !== 'object' || Array.isArray(v))) {
    throw providerError('ERR_INVALID_ANSWER', true, false, 'the submit answer is not a STEAK object')
  }
  return parsed as AttestedSTEAK
}

/**
 * The Mandala overlay at `url`, whose identity key is K (C§8.2).
 * Throws `TypeError` on an empty or non-http(s) url or a malformed K, so a
 * provider never exists for an unconfigured overlay (S5).
 */
export function createMandalaOverlayProvider (o: MandalaOverlayProviderOptions): MandalaOverlayProvider {
  if (o == null || typeof o !== 'object') throw new TypeError('@bsv/mandala: createMandalaOverlayProvider options are required')
  const url = checkUrl(o.url)
  const identityKey = checkIdentityKey(o.identityKey)
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('@bsv/mandala: timeoutMs must be a positive number')
  const doFetch: FetchLike = o.fetch != null
    ? (o.fetch as unknown as FetchLike)
    : (u, init) => (globalThis as any).fetch(u, init)

  async function lookup (type: 'color-spendability' | 'color-admission', assetId: string, outpoints: string[]): Promise<LookupOutputList> {
    // Validated before any fetch: colorLookup/colorTopic throw TypeError on a bad id.
    const service = colorLookup(assetId)
    const topic = colorTopic(assetId)
    const query = { type, version: 1, assetId, topic, outpoints: checkOutpoints(outpoints) }
    try {
      return await postLookup(service, query, { url, fetch: doFetch, timeoutMs })
    } catch (e) {
      throw fromLookupError(e)
    }
  }

  const provider: MandalaOverlayProvider = {
    url,
    identityKey,
    spendability: async (assetId, outpoints) => await lookup('color-spendability', assetId, outpoints),
    admission: async (assetId, outpoints) => await lookup('color-admission', assetId, outpoints),
    submit: async (topics, beef, offChainValues) => {
      if (!Array.isArray(topics) || topics.length === 0 || topics.some(t => typeof t !== 'string' || t === '')) {
        throw new TypeError('@bsv/mandala: submit topics must be a non-empty array of topic names')
      }
      if (!isByteArray(beef, false)) throw new TypeError('@bsv/mandala: submit beef must be a non-empty byte array')
      if (offChainValues !== undefined && !isByteArray(offChainValues, true)) {
        throw new TypeError('@bsv/mandala: submit offChainValues must be a byte array')
      }
      return await postSubmit(url, doFetch, timeoutMs, [...topics], beef, offChainValues)
    }
  }
  return Object.freeze(provider)
}

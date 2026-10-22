/**
 * BRC-162 1Color / BRC-207 naming (C§0, 0207:540-551, 0207:700-705).
 *
 * Every per-asset name is a pure function of the canonical underscore asset
 * id. Invalid input throws before any key derivation or network call: there
 * is no truncation, case folding or alternate spelling (0207:548-551).
 */
import { Utils } from '@bsv/sdk'

const ASSET_ID = /^[0-9a-f]{64}_(0|[1-9][0-9]{0,9})$/
const MAX_VOUT = 4294967295
/** Mandala bound per remittance string, so the protocol name stays ≤ 280 chars (C§0). */
export const MAX_REMITTANCE_BYTES = 48
const TOPIC_PREFIX = 'tm_color_'
const LOOKUP_PREFIX = 'ls_color_'

/** True iff `id` is a canonical asset id `<64 lowercase hex>_<vout>` with vout ≤ 2^32-1 (C§0). */
export function isAssetId (id: string): boolean {
  if (typeof id !== 'string') return false
  const m = ASSET_ID.exec(id)
  // vout is an output index, not a token amount: Number() is exact here.
  return m != null && Number(m[1]) <= MAX_VOUT
}

function checkAssetId (assetId: string): string {
  if (!isAssetId(assetId)) {
    throw new TypeError(`@bsv/mandala: invalid asset id ${JSON.stringify(assetId)} (expected <64 lowercase hex>_<vout>)`)
  }
  return assetId
}

/** `tm_color_<assetId>`: the per-asset overlay topic. */
export function colorTopic (assetId: string): string {
  return TOPIC_PREFIX + checkAssetId(assetId)
}

/** `ls_color_<assetId>`: the per-asset lookup service. */
export function colorLookup (assetId: string): string {
  return LOOKUP_PREFIX + checkAssetId(assetId)
}

/** True iff `topic` is exactly `tm_color_<canonical asset id>`. */
export function isColorTopic (topic: string): boolean {
  return typeof topic === 'string' && topic.startsWith(TOPIC_PREFIX) && isAssetId(topic.slice(TOPIC_PREFIX.length))
}

/** `<64hex>v<vout>`: the derivation and basket form of an asset id. */
export function assetTag (assetId: string): string {
  const id = checkAssetId(assetId)
  const sep = id.indexOf('_')
  return `${id.slice(0, sep)}v${id.slice(sep + 1)}`
}

/** Strictly well-formed UTF-16 (no lone surrogates), i.e. it encodes to strict UTF-8. */
function isWellFormed (s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

/**
 * Validate a remittance string (derivationPrefix / derivationSuffix) and
 * return it unchanged: non-empty, no whitespace, strict UTF-8, at most 48
 * UTF-8 bytes (C§0, 0207:530-533). `name` labels the error.
 */
export function assertRemittance (s: string, name: string): string {
  if (typeof s !== 'string' || s.length === 0) {
    throw new TypeError(`@bsv/mandala: ${name} must be a non-empty string`)
  }
  if (/\s/u.test(s)) throw new TypeError(`@bsv/mandala: ${name} must not contain whitespace`)
  if (!isWellFormed(s)) throw new TypeError(`@bsv/mandala: ${name} is not valid UTF-8`)
  const bytes = Utils.toArray(s, 'utf8').length
  if (bytes > MAX_REMITTANCE_BYTES) {
    throw new TypeError(`@bsv/mandala: ${name} is ${bytes} UTF-8 bytes; at most ${MAX_REMITTANCE_BYTES} are accepted`)
  }
  return s
}

/**
 * `[2, 'p color <assetTag> <hex(prefix utf8)> <hex(suffix utf8)>']`
 * (0207:540-546). The hex is of the exact remittance strings' UTF-8 bytes,
 * never of decoded base64. keyID is always `'color'`.
 */
export function colorProtocolID (assetId: string, prefix: string, suffix: string): [2, string] {
  const tag = assetTag(assetId)
  const p = Utils.toHex(Utils.toArray(assertRemittance(prefix, 'derivationPrefix'), 'utf8'))
  const s = Utils.toHex(Utils.toArray(assertRemittance(suffix, 'derivationSuffix'), 'utf8'))
  return [2, `p color ${tag} ${p} ${s}`]
}

/** The per-asset value basket `p color <assetTag>`, or its `… authority` basket. */
export function colorBasket (assetId: string, role: 'value' | 'authority' = 'value'): string {
  const tag = assetTag(assetId)
  if (role === 'value') return `p color ${tag}`
  if (role === 'authority') return `p color ${tag} authority`
  throw new TypeError(`@bsv/mandala: invalid basket role ${JSON.stringify(role)}`)
}

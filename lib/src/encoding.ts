import { Utils } from '@bsv/sdk'
export type { MandalaActionKind, MandalaActionDetails } from './brc162.js'

/**
 * A BRC-72 specific key linkage revelation (C§5.1). The byte arrays are JSON
 * number arrays (integers 0..255). Mandala only ever reveals security-level-2
 * protocols with proof type 0.
 */
export interface SpecificLinkage {
  prover: string
  verifier: string
  counterparty: string
  protocolID: [2, string]
  keyID: string
  encryptedLinkage: number[]
  encryptedLinkageProof: number[]
  proofType: 0
}

/**
 * The v3 off-chain envelope (overlay-go internal/mandala/envelope.go), sent
 * CompactSize-framed after the BEEF in the /submit body (C§5.1, C§6).
 * `outputs` must cover every token output of the asset; `inputs` is optional
 * for the overlay and holder txs omit it (D3). `admin[].details` is the
 * lowercase hex of the strict-CBOR admin details whose sha256 the authority
 * output at `index` commits to; `deploySig` (lowercase hex DER) rides on a
 * deploy only.
 */
export interface MandalaEnvelope {
  inputs?: Array<{ index: number, linkage: SpecificLinkage }>
  outputs?: Array<{ index: number, linkage: SpecificLinkage }>
  admin?: Array<{ index: number, details: string }>
  deploySig?: string
}

const ENVELOPE_KEYS = ['inputs', 'outputs', 'admin', 'deploySig'] as const
const LINKAGE_KEYS = [
  'prover', 'verifier', 'counterparty', 'protocolID', 'keyID', 'encryptedLinkage', 'encryptedLinkageProof', 'proofType'
] as const
const LOWER_HEX_PAIRS = /^(?:[0-9a-f]{2})+$/

const fail = (msg: string): never => { throw new TypeError(`MandalaEnvelope: ${msg}`) }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function exactKeys (o: Record<string, unknown>, keys: readonly string[], what: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${what} has unknown member '${k}'`)
  for (const k of keys) if (!(k in o)) fail(`${what} lacks member '${k}'`)
}

function bytes (v: unknown, what: string): number[] {
  if (!Array.isArray(v)) return fail(`${what} must be a byte array`)
  for (const b of v) {
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) fail(`${what} must hold integers 0..255`)
  }
  return [...v] as number[]
}

function str (v: unknown, what: string): string {
  if (typeof v !== 'string') return fail(`${what} must be a string`)
  return v
}

/**
 * Validate a BRC-72 linkage (exactly the contract members, `protocolID`
 * `[2, string]`, bytes 0..255, `proofType` 0) and rebuild it with only those
 * members, in contract order. Throws TypeError.
 */
export function readSpecificLinkage (v: unknown, what = 'linkage'): SpecificLinkage {
  if (!isObject(v)) return fail(`${what} must be an object`)
  exactKeys(v, LINKAGE_KEYS, what)
  const p = v.protocolID
  if (!Array.isArray(p) || p.length !== 2 || p[0] !== 2 || typeof p[1] !== 'string') {
    fail(`${what}.protocolID must be [2, string]`)
  }
  if (v.proofType !== 0) fail(`${what}.proofType must be 0`)
  return {
    prover: str(v.prover, `${what}.prover`),
    verifier: str(v.verifier, `${what}.verifier`),
    counterparty: str(v.counterparty, `${what}.counterparty`),
    protocolID: [2, (p as [2, string])[1]],
    keyID: str(v.keyID, `${what}.keyID`),
    encryptedLinkage: bytes(v.encryptedLinkage, `${what}.encryptedLinkage`),
    encryptedLinkageProof: bytes(v.encryptedLinkageProof, `${what}.encryptedLinkageProof`),
    proofType: 0
  }
}

function readIndex (v: unknown, what: string, seen: Set<number>): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return fail(`${what}.index must be a non-negative safe integer`)
  if (seen.has(v)) fail(`${what} has duplicate index ${v}`)
  seen.add(v)
  return v
}

function readList<T> (
  v: unknown, label: string, read: (e: Record<string, unknown>, what: string) => T
): Array<{ index: number } & T> {
  if (!Array.isArray(v)) return fail(`${label} must be an array`)
  const seen = new Set<number>()
  return v.map((e, i) => {
    const what = `${label}[${i}]`
    if (!isObject(e)) return fail(`${what} must be an object`)
    // `index` first, then the entry body: the member order encodeEnvelope writes.
    const index = readIndex(e.index, what, seen)
    return { index, ...read(e, what) }
  })
}

const readLinkageEntry = (e: Record<string, unknown>, what: string): { linkage: SpecificLinkage } => {
  exactKeys(e, ['index', 'linkage'], what)
  return { linkage: readSpecificLinkage(e.linkage, `${what}.linkage`) }
}

const readAdminEntry = (e: Record<string, unknown>, what: string): { details: string } => {
  exactKeys(e, ['index', 'details'], what)
  const details = str(e.details, `${what}.details`)
  if (!LOWER_HEX_PAIRS.test(details)) fail(`${what}.details must be lowercase hex`)
  return { details }
}

/** Validate a parsed envelope object and rebuild it canonically (members in contract order). */
function readEnvelope (v: unknown): MandalaEnvelope {
  if (!isObject(v)) return fail('must be a JSON object')
  for (const k of Object.keys(v)) if (!(ENVELOPE_KEYS as readonly string[]).includes(k)) fail(`unknown member '${k}'`)
  const out: MandalaEnvelope = {}
  if ('inputs' in v) out.inputs = readList(v.inputs, 'inputs', readLinkageEntry)
  if ('outputs' in v) out.outputs = readList(v.outputs, 'outputs', readLinkageEntry)
  if ('admin' in v) out.admin = readList(v.admin, 'admin', readAdminEntry)
  if ('deploySig' in v) {
    const sig = str(v.deploySig, 'deploySig')
    if (!LOWER_HEX_PAIRS.test(sig)) fail('deploySig must be non-empty lowercase hex')
    out.deploySig = sig
  }
  return out
}

const byIndex = <T extends { index: number }>(list: T[]): T[] => [...list].sort((a, b) => a.index - b.index)

/**
 * UTF-8 JSON bytes of `e`, byte-deterministic: absent (undefined) members are
 * omitted, `inputs`/`outputs`/`admin` are sorted by `index`, and every object
 * is rebuilt with only its contract members in contract order (top level
 * `inputs, outputs, admin, deploySig`; entries `index` first; linkage
 * `prover, verifier, counterparty, protocolID, keyID, encryptedLinkage,
 * encryptedLinkageProof, proofType`). Throws TypeError on anything
 * decodeEnvelope would refuse, so a malformed envelope never reaches the wire.
 */
export function encodeEnvelope (e: MandalaEnvelope): number[] {
  if (!isObject(e)) return fail('must be an object')
  // Project onto the contract members first (a wallet's reveal result or a
  // caller object may carry extras), then validate exactly as decode does.
  const pick = (o: unknown, keys: readonly string[]): unknown => {
    if (!isObject(o)) return o
    const r: Record<string, unknown> = {}
    for (const k of keys) if (o[k] !== undefined) r[k] = o[k]
    return r
  }
  const linkageEntry = (x: unknown): unknown => {
    const p = pick(x, ['index', 'linkage'])
    return isObject(p) ? { ...p, linkage: pick(p.linkage, LINKAGE_KEYS) } : p
  }
  const present: Record<string, unknown> = {}
  for (const k of ENVELOPE_KEYS) {
    const v = (e as Record<string, unknown>)[k]
    if (v === undefined) continue
    if (!Array.isArray(v)) present[k] = v
    else if (k === 'admin') present[k] = v.map(x => pick(x, ['index', 'details']))
    else present[k] = v.map(linkageEntry)
  }
  const canonical = readEnvelope(present)
  if (canonical.inputs != null) canonical.inputs = byIndex(canonical.inputs)
  if (canonical.outputs != null) canonical.outputs = byIndex(canonical.outputs)
  if (canonical.admin != null) canonical.admin = byIndex(canonical.admin)
  return Utils.toArray(JSON.stringify(canonical), 'utf8')
}

/**
 * Strict decode of envelope bytes. Throws TypeError on invalid UTF-8 (or a
 * non-byte element), non-JSON, a non-object, unknown or missing members,
 * duplicate indices within a list, byte arrays outside 0..255, a protocolID
 * that is not `[2, string]`, `proofType ≠ 0`, or non-lowercase-hex
 * `details`/`deploySig`. Lists keep their wire order; absent members stay
 * absent. Stricter than overlay-go DecodeEnvelope by design: it is only
 * used on envelopes Mandala code must vouch for.
 */
export function decodeEnvelope (b: number[]): MandalaEnvelope {
  if (!Array.isArray(b)) return fail('bytes must be a number array')
  for (const x of b) {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 255) fail('bytes must be integers 0..255')
  }
  // Utils.toUTF8 replaces malformed sequences instead of throwing (and the
  // core stays free of TextDecoder for React Native), so a lossless
  // re-encode is the strict UTF-8 check: overlongs, surrogates, stray
  // continuation bytes and truncated sequences all fail it.
  const text = Utils.toUTF8(b)
  const again = Utils.toArray(text, 'utf8')
  if (again.length !== b.length || again.some((x, i) => x !== b[i])) fail('must be valid UTF-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('must be UTF-8 JSON')
  }
  return readEnvelope(parsed)
}

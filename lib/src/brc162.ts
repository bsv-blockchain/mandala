/**
 * BRC-162 wire helpers: the 1Color (OneColor) token codec boundary, the strict
 * DAG-CBOR admin details / authority commitment / deploy payload and Mandala
 * `req` (C§4) and the deploy signature digest. Mirrors overlay-go
 * internal/mandala/{details,deploysig}.go. Topic names are in naming.ts.
 *
 * Pure and React-Native safe (@bsv/templates 2.x imports only @bsv/sdk).
 */
import { Hash, LockingScript, Utils, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { OneColor, decodeStrictCbor, encodeStrictCbor, readOneColorAttributes } from '@bsv/templates'
import { MAX_UINT64 } from './amount.js'
import { ADMIN_PROTOCOL, MANDALA_PROFILE_ID } from './constants.js'

export const MANDALA_TOPIC = 'tm_mandala'

const TOKEN_ID_RE = /^([0-9a-f]{64})_0$/

/** `<64 lowercase hex deploy txid>_0` — the only token id the overlay accepts. */
export const isTokenId = (id: string): boolean => TOKEN_ID_RE.test(id)

/** The token id a deploy txid creates. */
export const tokenIdOfDeploy = (deployTxid: string): string => `${deployTxid}_0`

// Topic and lookup names live in naming.ts (`colorTopic`, `colorLookup`): the
// legacy `tm_<txid>` / `ls_<txid>` helpers and `deployTopics` are removed
// (C§8.1). A deploy submits `[TOPIC, colorTopic(`${txid}_0`)]` inline.

// ---------------------------------------------------------------------------
// Codec boundary (BRC-162 1Color, @bsv/templates OneColor)
// ---------------------------------------------------------------------------

export interface DecodedToken {
  role: 'deploy' | 'authority' | 'value'
  /** The output's asset id; for a deploy only when its txid was given (`<txid>_<vout>`). */
  assetId?: string
  /** Exact uint64 amount; no 2^53 logic. */
  amount: bigint
  payload?: number[]
}

/**
 * Decode a BRC-162 1Color output locked to a plain P2PKH remainder. Null for a
 * non-token, a malformed token or any other remainder. No amount cap and no
 * Mandala id policy: a 36-byte id decodes to `<txid>_<vout>` and the overlay
 * refuses it.
 */
export function decodeToken (script: LockingScript | string, txid?: string, vout?: number): DecodedToken | null {
  try {
    const ls = typeof script === 'string' ? LockingScript.fromHex(script) : script
    const d = OneColor.decode(ls)
    if (d.restPubKeyHash == null) return null
    let assetId: string | undefined
    if (d.tokenId != null) assetId = OneColor.tokenIdToString(d.tokenId)
    else if (txid != null) assetId = `${txid}_${vout ?? 0}`
    return {
      role: d.role,
      ...(assetId != null ? { assetId } : {}),
      amount: d.amount,
      ...(d.payload != null ? { payload: d.payload } : {})
    }
  } catch {
    return null
  }
}

/**
 * Lock a Mandala-key (issuer, treasury, authority, deploy, registry) 1Color
 * output: OneColor lockBRC29 to hash160 of the key derived under
 * ADMIN_PROTOCOL. `assetId` null is a deploy. Throws RangeError for an amount
 * outside 0..2^64-1 before any key derivation.
 */
export async function lockIssuerToken (
  wallet: WalletInterface,
  assetId: string | null,
  amount: bigint,
  keyID: string,
  counterparty: string,
  payload?: number[]
): Promise<LockingScript> {
  if (typeof amount !== 'bigint' || amount < 0n || amount > MAX_UINT64) {
    throw new RangeError(`@bsv/mandala: token amount must be a bigint in 0..2^64-1, got ${String(amount)}`)
  }
  return await new OneColor(wallet).lockBRC29(assetId, amount, ADMIN_PROTOCOL, keyID, counterparty, payload)
}

// ---------------------------------------------------------------------------
// Admin details (strict CBOR) — overlay-go details.go
// ---------------------------------------------------------------------------

export type MandalaActionKind =
  | 'issue' | 'redeem' | 'reissue' | 'pause' | 'unpause'
  | 'blockIdentity' | 'unblockIdentity' | 'allowIdentity' | 'unallowIdentity'
  | 'setAccessMode' | 'freezeOutput' | 'unfreezeOutput' | 'setFeeRate'
  | 'admitIdentity' | 'revokeIdentity'

/**
 * Admin action details. Only the keys the kind's schema allows may be set
 * (the overlay refuses unknown keys): issue {bankRef?}, reissue {outpoint,
 * recipient}, *Identity {identityKey}, setAccessMode {mode},
 * freeze/unfreezeOutput {outpoint}, setFeeRate {feeRatePerKb}; any kind may
 * carry `reason`.
 */
export interface MandalaActionDetails {
  kind: MandalaActionKind
  /** 64 hex (32 bytes): sha256 of the off-chain deposit record. */
  bankRef?: string
  /** `<txid>.<vout>` */
  outpoint?: string
  /** 66-hex compressed key. */
  recipient?: string
  /** 66-hex compressed key. */
  identityKey?: string
  mode?: 'denylist' | 'allowlist'
  feeRatePerKb?: number | null
  reason?: string
}

const OUTPOINT_RE = /^([0-9a-f]{64})\.(0|[1-9]\d{0,9})$/
const KEY_RE = /^0[23][0-9a-f]{64}$/

function outpointBytes (op: string): Uint8Array {
  const m = OUTPOINT_RE.exec(op)
  if (m == null) throw new Error('outpoint must be <64 lowercase hex txid>.<vout>')
  const vout = Number(m[2])
  if (vout > 0xffffffff) throw new Error('outpoint vout out of range')
  const txid = Utils.toArray(m[1], 'hex').reverse()
  return Uint8Array.from([...txid, vout & 0xff, (vout >>> 8) & 0xff, (vout >>> 16) & 0xff, (vout >>> 24) & 0xff])
}

function outpointText (b: Uint8Array): string {
  const txid = Utils.toHex(Array.from(b.slice(0, 32)).reverse())
  const vout = (b[32] | (b[33] << 8) | (b[34] << 16) | (b[35] << 24)) >>> 0
  return `${txid}.${vout}`
}

/** Strict-CBOR bytes of `details`, byte-identical to overlay-go EncodeAdminDetails. */
export function encodeAdminDetails (d: MandalaActionDetails): number[] {
  const m: Record<string, any> = { kind: d.kind }
  if (d.bankRef != null && d.bankRef !== '') {
    if (!/^[0-9a-f]{64}$/.test(d.bankRef)) throw new Error('bankRef must be 64 lowercase hex')
    m.bankRef = Uint8Array.from(Utils.toArray(d.bankRef, 'hex'))
  }
  if (d.outpoint != null && d.outpoint !== '') m.outpoint = outpointBytes(d.outpoint)
  for (const k of ['recipient', 'identityKey'] as const) {
    const v = d[k]
    if (v == null || v === '') continue
    if (!KEY_RE.test(v.toLowerCase())) throw new Error(`${k} must be a 66-hex compressed public key`)
    m[k] = Uint8Array.from(Utils.toArray(v.toLowerCase(), 'hex'))
  }
  if (d.mode != null) m.mode = d.mode
  if (d.feeRatePerKb !== undefined) m.feeRatePerKb = d.feeRatePerKb === null ? null : BigInt(d.feeRatePerKb)
  if (d.reason != null) m.reason = d.reason
  return encodeStrictCbor(m)
}

/** Decode strict-CBOR admin details (hex or bytes) back to the JS shape; null when malformed. */
export function decodeAdminDetails (detailsHex: string | number[]): MandalaActionDetails | null {
  try {
    const bytes = typeof detailsHex === 'string' ? Utils.toArray(detailsHex, 'hex') : detailsHex
    const m = decodeStrictCbor(bytes) as Record<string, unknown>
    if (typeof m.kind !== 'string') return null
    const d: MandalaActionDetails = { kind: m.kind as MandalaActionKind }
    if (m.bankRef instanceof Uint8Array) d.bankRef = Utils.toHex(Array.from(m.bankRef))
    if (m.outpoint instanceof Uint8Array && m.outpoint.length === 36) d.outpoint = outpointText(m.outpoint)
    if (m.recipient instanceof Uint8Array) d.recipient = Utils.toHex(Array.from(m.recipient))
    if (m.identityKey instanceof Uint8Array) d.identityKey = Utils.toHex(Array.from(m.identityKey))
    if (typeof m.mode === 'string') d.mode = m.mode as 'denylist' | 'allowlist'
    if ('feeRatePerKb' in m) d.feeRatePerKb = m.feeRatePerKb == null ? null : Number(m.feeRatePerKb)
    if (typeof m.reason === 'string') d.reason = m.reason
    return d
  } catch {
    return null
  }
}

/** sha256 of the details bytes, lowercase hex — the authority commitment and the authority keyID. */
export const commitmentHex = (detailsBytes: number[]): string => Utils.toHex(Hash.sha256(detailsBytes))

/** Authority output payload `{adm: sha256(details)}`. */
export const commitmentPayload = (detailsBytes: number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256(detailsBytes)) })

/** The `adm` commitment of an authority payload, hex, or null. */
export function commitmentOf (payload?: number[]): string | null {
  if (payload == null) return null
  try {
    const m = decodeStrictCbor(payload) as Record<string, unknown>
    return m.adm instanceof Uint8Array && m.adm.length === 32 ? Utils.toHex(Array.from(m.adm)) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Deploy payload and the Mandala `req` (C§4)
// ---------------------------------------------------------------------------

const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn

function modPow (b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n
  b %= m
  while (e > 0n) {
    if ((e & 1n) === 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}

/** 66-hex lowercase compressed secp256k1 key whose x is a field element on the curve (C§0). */
function isIdentityKey (k: unknown): k is string {
  if (typeof k !== 'string' || !/^0[23][0-9a-f]{64}$/.test(k)) return false
  const x = BigInt('0x' + k.slice(2))
  if (x >= SECP256K1_P) return false
  const y2 = (modPow(x, 3n, SECP256K1_P) + 7n) % SECP256K1_P
  const y = modPow(y2, (SECP256K1_P + 1n) / 4n, SECP256K1_P)
  return (y * y) % SECP256K1_P === y2
}

const codePoints = (s: unknown): number => typeof s === 'string' ? [...s].length : -1

/**
 * The exact `req` every Mandala deploy writes (design §9 B7): only the
 * Mandala issuer-v1 profile, for K = the overlay's identity key.
 */
export function mandalaReq (identityKey: string): Record<string, { version: 1, params: Record<string, string> }> {
  return {
    [MANDALA_PROFILE_ID]: { version: 1, params: { identityKey } }
  }
}

export interface DeployPayloadParams {
  /** 1..32 Unicode code points. */
  sym: string
  /** Integer 0..18. */
  dec: number
  /** 1..64 Unicode code points. */
  label: string
  /** K, the Mandala overlay identity key the deploy's `req` names (66-hex lowercase, on curve). */
  identityKey: string
  icon?: { mediaType: string, bytes: number[] }
  /** Optional; the console no longer writes it by default (B6). */
  feeRatePerKb?: number
}

/**
 * Strict DAG-CBOR Mandala deploy payload `{dec, req: mandalaReq(K), sym, label, icon?, feeRatePerKb?}`
 * (C§4). `ext` is never written. TypeError on any out-of-range field.
 */
export function deployPayload (m: DeployPayloadParams): number[] {
  const n = codePoints(m.sym)
  if (n < 1 || n > 32) throw new TypeError('@bsv/mandala: sym must be 1..32 characters')
  const l = codePoints(m.label)
  if (l < 1 || l > 64) throw new TypeError('@bsv/mandala: label must be 1..64 characters')
  if (!Number.isInteger(m.dec) || m.dec < 0 || m.dec > 18) throw new TypeError('@bsv/mandala: dec must be an integer 0..18')
  if (!isIdentityKey(m.identityKey)) throw new TypeError('@bsv/mandala: identityKey must be a 66-hex lowercase compressed public key on secp256k1')
  const map: Record<string, any> = { dec: BigInt(m.dec), req: mandalaReq(m.identityKey), sym: m.sym, label: m.label }
  if (m.icon != null) {
    if (typeof m.icon.mediaType !== 'string' || m.icon.mediaType === '') throw new TypeError('@bsv/mandala: icon mediaType must be non-empty')
    if (!Array.isArray(m.icon.bytes) || m.icon.bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) {
      throw new TypeError('@bsv/mandala: icon bytes must be an array of bytes')
    }
    map.icon = [m.icon.mediaType, Uint8Array.from(m.icon.bytes)]
  }
  if (m.feeRatePerKb != null) {
    if (!Number.isSafeInteger(m.feeRatePerKb) || m.feeRatePerKb < 0) throw new TypeError('@bsv/mandala: feeRatePerKb must be a non-negative safe integer')
    map.feeRatePerKb = BigInt(m.feeRatePerKb)
  }
  return encodeStrictCbor(map)
}

export interface ParsedDeployPayload {
  sym: string
  dec: number
  label: string
  feeRatePerKb?: number | null
  icon?: { mediaType: string, bytes: number[] }
}

/** The display fields of a strict deploy payload, or null when it lacks a valid sym/dec/label. */
export function parseDeployPayload (payload?: number[]): ParsedDeployPayload | null {
  if (payload == null) return null
  const a = readOneColorAttributes(payload)
  if (a.payload !== 'map' || a.map == null) return null
  const label = a.map.label
  if (a.sym.status !== 'valid' || a.dec.status !== 'valid' || typeof label !== 'string') return null
  const out: ParsedDeployPayload = { sym: a.sym.value, dec: a.dec.value, label }
  if ('feeRatePerKb' in a.map) {
    const f = a.map.feeRatePerKb
    out.feeRatePerKb = f == null ? null : Number(f)
  }
  if (a.icon.status === 'valid') out.icon = { mediaType: a.icon.value.mediaType, bytes: Array.from(a.icon.value.bytes) }
  return out
}

/**
 * Read a deploy output (output `vout` 0 of `txid`): its asset id, display
 * fields and, iff its `req` wire bytes are exactly `mandalaReq(K)`, the
 * Mandala key K. Null unless the script is a 1Color deploy to P2PKH. Never
 * throws. An opaque or absent payload gives `dec: 0` and no display fields; a
 * malformed `dec` gives `dec: 0` (display fields are independent, 0162:221).
 * The `req` check compares the exact wire span, never a re-encoding (a float
 * 1.0 version must not pass as 1; plan 01 RF2).
 */
export function readDeploy (
  lockingScript: LockingScript | string,
  txid: string
): { assetId: string, sym?: string, dec: number, label?: string, mandalaKey?: string } | null {
  const d = decodeToken(lockingScript, txid, 0)
  if (d == null || d.role !== 'deploy' || d.assetId == null) return null
  const a = readOneColorAttributes(d.payload)
  const out: { assetId: string, sym?: string, dec: number, label?: string, mandalaKey?: string } = {
    assetId: d.assetId,
    dec: a.dec.status === 'valid' ? a.dec.value : 0
  }
  if (a.payload !== 'map' || a.map == null) return out
  if (a.sym.status === 'valid') out.sym = a.sym.value
  if (typeof a.map.label === 'string') out.label = a.map.label
  if (a.req.status === 'valid' && a.reqBytes != null) {
    const params = a.req.value.get(MANDALA_PROFILE_ID)?.params
    const k = params != null && typeof params === 'object' && !Array.isArray(params) && !(params instanceof Uint8Array)
      ? (params as Record<string, unknown>).identityKey
      : undefined
    if (typeof k === 'string' && isIdentityKey(k) &&
      Utils.toHex(Array.from(a.reqBytes)) === Utils.toHex(encodeStrictCbor(mandalaReq(k)))) {
      out.mandalaKey = k
    }
  }
  return out
}

export const DEPLOY_PROTOCOL: WalletProtocol = [2, 'mandala deploy']
export const deployDigest = (txid: string): number[] => Utils.toArray(`mandala-deploy:${txid}`, 'utf8')

/** Hex DER deploy signature: createSignature over deployDigest(txid), keyID '1', counterparty 'anyone'. */
export async function signDeploy (wallet: WalletInterface, txid: string): Promise<string> {
  const { signature } = await wallet.createSignature({
    data: deployDigest(txid),
    protocolID: DEPLOY_PROTOCOL,
    keyID: '1',
    counterparty: 'anyone'
  })
  return Utils.toHex(signature)
}

/** The keyID a deploy output is derived under (the authority chain's first link). */
export const DEPLOY_KEY_ID = 'deploy'

/** keyID of an authority output: its commitment hex, or DEPLOY_KEY_ID for a deploy. Recomputable from chain data alone. */
export function authorityKeyIdOf (script: LockingScript | string): string | null {
  const d = decodeToken(script)
  if (d == null || d.amount !== 0n) return null
  if (d.role === 'deploy') return DEPLOY_KEY_ID
  return commitmentOf(d.payload)
}

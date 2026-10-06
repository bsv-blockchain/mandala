/**
 * BRC-162 wire helpers: the Bsv21Binary token codec boundary, the strict
 * DAG-CBOR admin details / authority commitment / deploy payload, the deploy
 * signature digest and the per-token topic names. Mirrors overlay-go
 * internal/mandala/{details,deploysig,topics}.go.
 *
 * Pure and React-Native safe (@bsv/templates 2.x imports only @bsv/sdk).
 */
import { Hash, LockingScript, Utils, WalletInterface, WalletProtocol } from '@bsv/sdk'
import { Bsv21Binary, decodeStrictCbor, encodeStrictCbor, tokenIdToString } from '@bsv/templates'

export const MANDALA_TOPIC = 'tm_mandala'
export const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER

const TOKEN_ID_RE = /^([0-9a-f]{64})_0$/
const TOKEN_TOPIC_RE = /^tm_[0-9a-f]{64}$/

/** `<64 lowercase hex deploy txid>_0` — the only token id the overlay accepts. */
export const isTokenId = (id: string): boolean => TOKEN_ID_RE.test(id)

function txidOfToken (tokenId: string): string {
  const m = TOKEN_ID_RE.exec(tokenId)
  if (m == null) throw new Error(`not a canonical Mandala token id: ${tokenId}`)
  return m[1]
}

/** `<txid>_0` → `tm_<txid>`: the topic every non-deploy tx of the token names. */
export const tokenTopic = (tokenId: string): string => `tm_${txidOfToken(tokenId)}`
/** tokenTopic, or '' for a non-canonical id (a σI checked against '' never verifies). */
export const tokenTopicOrEmpty = (tokenId: string): string => { try { return tokenTopic(tokenId) } catch { return '' } }
/** `<txid>_0` → `ls_<txid>`. */
export const tokenLookup = (tokenId: string): string => `ls_${txidOfToken(tokenId)}`
/** The token id a deploy txid creates. */
export const tokenIdOfDeploy = (deployTxid: string): string => `${deployTxid}_0`
/** Topics whose STEAK entry carries σI: tm_mandala and every tm_<64 hex>, never tm_mandala_kyc. */
export const isSigmaTopic = (t: string): boolean => t === MANDALA_TOPIC || TOKEN_TOPIC_RE.test(t)
/** X-Topics of a token deploy: the registry plus the new token's own topic. */
export const deployTopics = (deployTxid: string): string[] => [MANDALA_TOPIC, `tm_${deployTxid}`]

// ---------------------------------------------------------------------------
// Codec boundary
// ---------------------------------------------------------------------------

export const codec = new Bsv21Binary()

export interface DecodedToken {
  role: 'deploy' | 'authority' | 'value'
  /** Absent for a deploy (its id is `<this txid>_0`). */
  tokenId?: string
  amount: number
  payload?: number[]
}

/** Decode a BRC-162 token output, or null when the script is not one (or its amount is unsafe). */
export function decodeToken (script: LockingScript | string): DecodedToken | null {
  try {
    const ls = typeof script === 'string' ? LockingScript.fromHex(script) : script
    const d = Bsv21Binary.decode(ls)
    if (d.restPubKeyHash == null) return null
    if (d.amount > BigInt(MAX_SAFE_AMOUNT)) return null
    return {
      role: d.role,
      ...(d.tokenId != null ? { tokenId: tokenIdToString(d.tokenId) } : {}),
      amount: Number(d.amount),
      ...(d.payload != null ? { payload: d.payload } : {})
    }
  } catch {
    return null
  }
}

/** A value coin of `tokenId` (amount > 0), else null. */
export function decodeValue (script: LockingScript | string, tokenId?: string): { tokenId: string, amount: number } | null {
  const d = decodeToken(script)
  if (d == null || d.role !== 'value' || d.tokenId == null) return null
  if (tokenId != null && d.tokenId !== tokenId) return null
  return { tokenId: d.tokenId, amount: d.amount }
}

/** Lock to hash160 of the wallet-derived key (BRC-29 style), like the old MandalaToken.lockBRC29. */
export async function lockToken (
  wallet: WalletInterface,
  tokenId: string | null,
  amount: number,
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  payload?: number[]
): Promise<LockingScript> {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`amount must be a safe non-negative integer, got ${amount}`)
  return await new Bsv21Binary(wallet).lockBRC29(tokenId, BigInt(amount), protocolID, keyID, counterparty, payload)
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
// Deploy
// ---------------------------------------------------------------------------

export interface DeployMetadata {
  /** 1-32 characters. */
  sym: string
  /** 0-18. */
  dec: number
  /** 1-64 characters. */
  label: string
  feeRatePerKb?: number | null
}

export function deployPayload (m: DeployMetadata): number[] {
  const map: Record<string, any> = { sym: m.sym, dec: BigInt(m.dec), label: m.label }
  if (m.feeRatePerKb != null) map.feeRatePerKb = BigInt(m.feeRatePerKb)
  return encodeStrictCbor(map)
}

export function parseDeployPayload (payload?: number[]): DeployMetadata | null {
  if (payload == null) return null
  try {
    const m = decodeStrictCbor(payload) as Record<string, unknown>
    if (typeof m.sym !== 'string' || typeof m.label !== 'string' || m.dec == null) return null
    return {
      sym: m.sym,
      dec: Number(m.dec),
      label: m.label,
      ...('feeRatePerKb' in m ? { feeRatePerKb: m.feeRatePerKb == null ? null : Number(m.feeRatePerKb) } : {})
    }
  } catch {
    return null
  }
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
  if (d == null || d.amount !== 0) return null
  if (d.role === 'deploy') return DEPLOY_KEY_ID
  return commitmentOf(d.payload)
}

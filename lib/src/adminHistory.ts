import { OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'
import { decodeAdminDetails, MandalaActionDetails } from './brc162.js'

/** One admin-history row (`GET /admin/admin-history/:tokenId`). */
export interface AdminHistoryRow {
  assetId: string
  txid: string
  outputIndex: number
  height: number
  offset: number
  /** Decoded from the strict-CBOR `detailsHex`; `{kind}` alone when undecodable. */
  actionDetails: MandalaActionDetails
  detailsHex: string
  /** sha256(details) hex — also the authority keyID of this link. */
  commitment: string
  /** Supply change of the action (issue > 0, redeem < 0, reissue = frozen amount). */
  delta: number
  admitSeq?: number
  createdAt?: string
}

function toRow (e: any): AdminHistoryRow | null {
  if (e == null || typeof e.txid !== 'string') return null
  const detailsHex = typeof e.detailsHex === 'string' ? e.detailsHex : ''
  const actionDetails = decodeAdminDetails(detailsHex) ?? { kind: e.kind }
  return {
    assetId: e.tokenId,
    txid: e.txid,
    outputIndex: Number(e.outputIndex) || 0,
    height: Number(e.height) || 0,
    offset: Number(e.offset) || 0,
    actionDetails,
    detailsHex,
    commitment: typeof e.commitment === 'string' ? e.commitment : '',
    delta: Number(e.delta) || 0,
    ...(typeof e.admitSeq === 'number' ? { admitSeq: e.admitSeq } : {}),
    ...(typeof e.createdAt === 'string' ? { createdAt: e.createdAt } : {})
  }
}

const toRows = (body: unknown): AdminHistoryRow[] =>
  Array.isArray(body) ? body.map(toRow).filter((r): r is AdminHistoryRow => r != null) : []

export async function resolveAdminHistory (assetId: string): Promise<AdminHistoryRow[]> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const res = await fetch(`${OVERLAY_URL}/admin/admin-history/${encodeURIComponent(assetId)}`)
    if (!res.ok) return []
    return toRows(await res.json())
  } catch {
    return []
  }
}

/** One page of admin history, newest-first (?limit=&offset= on the overlay). */
export async function resolveAdminHistoryPage (
  assetId: string,
  opts: { limit?: number, offset?: number } = {}
): Promise<AdminHistoryRow[]> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const params = new URLSearchParams()
    params.set('limit', String(opts.limit ?? 100))
    params.set('offset', String(opts.offset ?? 0))
    const res = await fetch(`${OVERLAY_URL}/admin/admin-history-page/${encodeURIComponent(assetId)}?${params.toString()}`)
    if (!res.ok) return []
    return toRows(await res.json())
  } catch {
    return []
  }
}

export interface AdminSummary {
  totalIssued: number
  totalRedeemed: number
  actionCount: number
}

/**
 * Whole-history issue/redeem totals, aggregated on the overlay — the Overview
 * KPIs and Banking reconciliation need full sums without shipping the full
 * history to the client.
 */
export async function resolveAdminSummary (assetId: string): Promise<AdminSummary | null> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const res = await fetch(`${OVERLAY_URL}/admin/admin-summary/${encodeURIComponent(assetId)}`)
    if (!res.ok) return null
    const s = await res.json()
    return {
      totalIssued: Number(s.totalIssued) || 0,
      totalRedeemed: Number(s.totalRedeemed) || 0,
      actionCount: Number(s.actionCount) || 0
    }
  } catch {
    return null
  }
}

const short = (k?: string): string => k == null ? '' : `${k.slice(0, 8)}…`

/** A safe-integer ≥ 1 fee rate carried in details, else undefined (byte-identical gate to feeRateFromDetails/feeRateOf). */
const feeRateOf = (d: Record<string, unknown>): number | undefined => {
  const v = d.feeRatePerKb
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : undefined
}

/** `delta` is the supply change the overlay recorded for the row (issue/redeem/reissue amounts). */
export function describeAction (d: MandalaActionDetails, delta?: number): string {
  const amt = delta != null ? `${Math.abs(delta)} units` : 'units'
  switch (d.kind) {
    // bankRef is the sha256 of the off-chain deposit record (R12) — shown in
    // full so an auditor can match it against the bank's own record hash.
    case 'issue': return `Issued ${amt}${d.bankRef != null ? ` (bankRef ${d.bankRef})` : ''}`
    case 'redeem': return `Redeemed (burned) ${amt}`
    case 'pause': return 'Paused transfers'
    case 'unpause': return 'Resumed transfers'
    case 'blockIdentity': return `Blocked identity ${short(d.identityKey)}`
    case 'unblockIdentity': return `Unblocked identity ${short(d.identityKey)}`
    case 'allowIdentity': return `Allowlisted identity ${short(d.identityKey)}`
    case 'unallowIdentity': return `Removed ${short(d.identityKey)} from allowlist`
    case 'setAccessMode': return `Set access mode to ${String(d.mode)}`
    case 'freezeOutput': return `Froze output ${String(d.outpoint)}`
    case 'unfreezeOutput': return `Unfroze output ${String(d.outpoint)}`
    case 'reissue': return `Reissued ${amt} from ${String(d.outpoint)} to ${short(d.recipient)}`
    case 'setFeeRate': return d.feeRatePerKb == null ? 'Issuer-paid fees disabled' : `Fee rate set to ${d.feeRatePerKb} units/KB`
    case 'admitIdentity': return `Admitted identity ${short(d.identityKey)}`
    case 'revokeIdentity': return `Revoked identity ${short(d.identityKey)}`
    default: return String((d as { kind?: unknown }).kind)
  }
}

const esc = (s: string): string => `"${s.replace(/"/g, '""')}"`

export function exportAdminHistoryCsv (rows: AdminHistoryRow[]): string {
  const header = ['txid', 'outputIndex', 'kind', 'bankRef', 'detailsHex', 'commitment', 'delta', 'height', 'offset', 'description']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      esc(r.txid),
      String(r.outputIndex),
      esc(r.actionDetails.kind),
      esc(String(r.actionDetails.bankRef ?? '')),
      esc(r.detailsHex),
      esc(r.commitment),
      String(r.delta),
      String(r.height),
      String(r.offset),
      esc(describeAction(r.actionDetails, r.delta))
    ].join(','))
  }
  return lines.join('\n')
}

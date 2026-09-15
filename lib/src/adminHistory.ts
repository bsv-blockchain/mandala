import { MandalaAdmin } from '@bsv/templates'
import type { MandalaActionDetails } from '@bsv/templates'
import { OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'

export interface AdminHistoryRow {
  assetId: string
  txid: string
  outputIndex: number
  height: number
  offset: number
  actionDetails: MandalaActionDetails
}

export async function resolveAdminHistory (assetId: string): Promise<AdminHistoryRow[]> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const res = await fetch(`${OVERLAY_URL}/admin/admin-history/${encodeURIComponent(assetId)}`)
    if (!res.ok) return []
    const entries: Array<{
      assetId: string
      txid: string
      outputIndex: number
      height: number
      offset: number
      actionDetails: MandalaActionDetails
    }> = await res.json()
    return entries.map(e => ({
      assetId: e.assetId,
      txid: e.txid,
      outputIndex: e.outputIndex,
      height: e.height,
      offset: e.offset,
      actionDetails: e.actionDetails
    }))
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
    const entries = await res.json()
    return Array.isArray(entries) ? entries as AdminHistoryRow[] : []
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

export function describeAction (d: MandalaActionDetails): string {
  // 'recover' was removed as an action kind (recovery is now the guarded
  // 'reissue'), but legacy on-chain admin records may still carry it — describe
  // it without referencing the removed union member.
  if ((d.kind as string) === 'recover') return `Recovered ${d.amount} units to ${short(d.recipient as string)} (legacy)`
  switch (d.kind) {
    // The register action carries the genesis metadata (label/ticker), not an
    // assetId — the assetId is the outpoint of this very tx, so it can't be a
    // field within its own payload.
    case 'register': return `Registered asset "${d.label as string}"${d.ticker != null && d.ticker !== '' ? ` (${d.ticker as string})` : ''}`
    // bankRef is the sha256 of the off-chain deposit record (R12) — shown in
    // full so an auditor can match it against the bank's own record hash.
    case 'issue': return `Issued ${d.amount} units${d.bankRef != null ? ` (bankRef ${d.bankRef})` : ''}`
    case 'redeem': return `Redeemed (burned) ${d.amount} units`
    case 'pause': return 'Paused transfers'
    case 'unpause': return 'Resumed transfers'
    case 'blockIdentity': return `Blocked identity ${short(d.identityKey as string)}`
    case 'unblockIdentity': return `Unblocked identity ${short(d.identityKey as string)}`
    case 'allowIdentity': return `Allowlisted identity ${short(d.identityKey as string)}`
    case 'unallowIdentity': return `Removed ${short(d.identityKey as string)} from allowlist`
    case 'setAccessMode': return `Set access mode to ${d.mode}`
    case 'freezeOutput': return `Froze output ${d.outpoint}`
    case 'unfreezeOutput': return `Unfroze output ${d.outpoint}`
    case 'reissue': return `Reissued ${d.amount} units to ${short(d.recipient as string)}${d.bankRef != null ? ` (bankRef ${d.bankRef})` : ''}`
    default: return (d as MandalaActionDetails).kind
  }
}

const esc = (s: string): string => `"${s.replace(/"/g, '""')}"`

export function exportAdminHistoryCsv (rows: AdminHistoryRow[]): string {
  const header = ['txid', 'outputIndex', 'priorOutpoint', 'kind', 'bankRef', 'canonicalDetailsJson', 'commitment', 'height', 'offset', 'description']
  const lines = [header.join(',')]
  for (const r of rows) {
    const canonical = MandalaAdmin.canonicalize(r.actionDetails)
    const commitment = MandalaAdmin.commitment(r.actionDetails)
    lines.push([
      esc(r.txid),
      String(r.outputIndex),
      esc(String(r.actionDetails.priorOutpoint ?? '')),
      esc(r.actionDetails.kind),
      esc(String(r.actionDetails.bankRef ?? '')),
      esc(canonical),
      esc(commitment),
      String(r.height),
      String(r.offset),
      esc(describeAction(r.actionDetails))
    ].join(','))
  }
  return lines.join('\n')
}

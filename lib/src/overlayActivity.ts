/**
 * Client for the overlay's /admin/activity endpoint — the operator-oversight
 * transaction feed. Each entry is a semantic summary (sender → recipient, net
 * units moved) derived by the overlay from its append-only key-linkage
 * records (identities proven via revealSpecificKeyLinkage at submission) and
 * the engine's raw-tx store. See overlay/src/activity.ts.
 */
import { adminAuthHeaders, OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'

export type ActivityKind = 'issue' | 'transfer' | 'self' | 'redeem'

export interface ActivityProof {
  outputIndex: number
  identityKey: string
  keyID: string
  counterparty: string
  proofType: number
}

export interface ActivityEntry {
  txid: string
  when: string
  assetId: string
  kind: ActivityKind
  from: string | null
  to: string | null
  amount: number
  proofs: ActivityProof[]
}

export interface ActivityPage {
  entries: ActivityEntry[]
  /** Inclusive cursor for the next (older) page; null when exhausted. */
  nextCursor: string | null
}

export const ACTIVITY_PAGE_SIZE = 100

export async function fetchOverlayActivity (
  assetId?: string,
  opts: { limit?: number, before?: string } = {}
): Promise<ActivityPage> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  const params = new URLSearchParams()
  if (assetId != null && assetId !== '') params.set('assetId', assetId)
  params.set('limit', String(opts.limit ?? ACTIVITY_PAGE_SIZE))
  if (opts.before != null) params.set('before', opts.before)
  // Identity-bearing route (A13): carries the admin bearer token when configured.
  const res = await fetch(`${OVERLAY_URL}/admin/activity?${params.toString()}`, { headers: adminAuthHeaders() })
  if (!res.ok) throw new Error(`activity fetch failed: ${res.status}`)
  const data = await res.json()
  if (data == null || !Array.isArray(data.entries)) return { entries: [], nextCursor: null }
  return { entries: data.entries as ActivityEntry[], nextCursor: data.nextCursor ?? null }
}

/**
 * Flatten pages into one list, deduplicating by txid: the cursor is inclusive
 * so a boundary-straddling tx group can appear again on the next page — the
 * first (newest-page) occurrence wins.
 */
export function flattenActivityPages (pages: ActivityPage[]): ActivityEntry[] {
  const seen = new Set<string>()
  const out: ActivityEntry[] = []
  for (const page of pages) {
    for (const e of page.entries) {
      if (seen.has(e.txid)) continue
      seen.add(e.txid)
      out.push(e)
    }
  }
  return out
}

/** One-line human description of an entry, e.g. for tooltips/tests. */
export function describeActivity (e: ActivityEntry): string {
  switch (e.kind) {
    case 'issue': return `Issued ${e.amount} units`
    case 'transfer': return `Transferred ${e.amount} units`
    case 'self': return 'Transferred 0 units to self'
    case 'redeem': return `Redeemed (burned) ${e.amount} units`
  }
}

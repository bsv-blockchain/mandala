/**
 * v3 token admin routes (§6.5): authorities, BEEF for an authority tx, asset
 * state (with the A16 frozen-row flag), paged admin history and the delta
 * summary. Pure handlers over injected deps; index.ts mounts them.
 *
 * Wire shapes are shared with overlay-go/internal/httpapi/admin.go: camelCase,
 * arrays never null, `500 {error}` on failure, the 404 string below.
 *
 * Every handler that takes a tokenId validates it first. A malformed id
 * (`txid.0`, uppercase hex, `_1`) is `400 {error:'invalid tokenId'}` and no
 * dep is called: answering `200 []` would tell an old-format client "no
 * authorities" and start a new genesis.
 */
import type { AssetAdminState, AdminHistoryEntry } from '@bsv/overlay-topics'

export const TOKEN_ID_RE = /^[0-9a-f]{64}_0$/
export const ADMIN_TX_NOT_FOUND = 'admin tx not in overlay storage'

export interface RouteResult { status: number, body: unknown }

const INVALID_TOKEN_ID: RouteResult = { status: 400, body: { error: 'invalid tokenId' } }
const fail = (e: unknown): RouteResult => ({ status: 500, body: { error: String(e) } })

export const tokenIdParam = (raw: unknown): string | null =>
  typeof raw === 'string' && TOKEN_ID_RE.test(raw) ? raw : null

/** `?vout=` as the registry BEEF route reads it: `Number(vout ?? 0)`, junk → 0. */
export const voutParam = (raw: unknown): number => {
  const n = Number(raw ?? 0)
  return Number.isFinite(n) ? n : 0
}

export const splitOutpoint = (op: string): { txid: string, vout: number } | null => {
  const dot = op.lastIndexOf('.')
  if (dot <= 0) return null
  const vout = Number(op.slice(dot + 1))
  if (!Number.isInteger(vout) || vout < 0) return null
  return { txid: op.slice(0, dot), vout }
}

/**
 * A16: annotate each frozen ref with `hasFrozenRow` — whether the frozen coin
 * still has a live token row, i.e. whether a reissue of it can succeed. Read
 * live per request so a freeze that raced the coin's spend is reported as it
 * stands now, not as it was folded.
 */
export async function withFrozenRowFlags<F extends { outpoint: string }, S extends { frozenOutpoints: F[] }> (
  state: S,
  hasTokenRow: (txid: string, vout: number) => Promise<boolean>
): Promise<Omit<S, 'frozenOutpoints'> & { frozenOutpoints: Array<F & { hasFrozenRow: boolean }> }> {
  const frozenOutpoints = await Promise.all(state.frozenOutpoints.map(async f => {
    const op = splitOutpoint(f.outpoint)
    return { ...f, hasFrozenRow: op != null && await hasTokenRow(op.txid, op.vout) }
  }))
  return { ...state, frozenOutpoints }
}

export async function authoritiesResponse (tokenId: unknown, deps: {
  listAuthorities: (tokenId: string) => Promise<Array<{ txid: string, outputIndex: number, identityKey: string }>>
}): Promise<RouteResult> {
  const id = tokenIdParam(tokenId)
  if (id == null) return INVALID_TOKEN_ID
  try {
    const rows = await deps.listAuthorities(id)
    const authorities = rows
      .map(r => ({ outpoint: `${r.txid}.${r.outputIndex}`, identityKey: r.identityKey }))
      .sort((a, b) => (a.outpoint < b.outpoint ? -1 : a.outpoint > b.outpoint ? 1 : 0))
    return { status: 200, body: { tokenId: id, authorities } }
  } catch (e) {
    return fail(e)
  }
}

export async function authoritiesBeefResponse (txid: unknown, vout: unknown, deps: {
  findBeef: (txid: string, vout: number) => Promise<{ beef: number[], outputIndex: number } | null>
}): Promise<RouteResult> {
  try {
    const out = await deps.findBeef(String(txid ?? ''), voutParam(vout))
    if (out == null) return { status: 404, body: { error: ADMIN_TX_NOT_FOUND } }
    return { status: 200, body: { beef: out.beef, outputIndex: out.outputIndex } }
  } catch (e) {
    return fail(e)
  }
}

export async function assetStateResponse (tokenId: unknown, deps: {
  getAssetState: (id: string) => Promise<AssetAdminState>
  hasTokenRow: (txid: string, vout: number) => Promise<boolean>
}): Promise<RouteResult> {
  const id = tokenIdParam(tokenId)
  if (id == null) return INVALID_TOKEN_ID
  try {
    return { status: 200, body: await withFrozenRowFlags(await deps.getAssetState(id), deps.hasTokenRow) }
  } catch (e) {
    return fail(e)
  }
}

/** limit: clamp 1..500, default 100 (junk → 100). offset: ≥ 0, default 0 (junk → 0). */
export async function adminHistoryPageResponse (tokenId: unknown, limit: unknown, offset: unknown, deps: {
  page: (id: string, limit: number, offset: number) => Promise<AdminHistoryEntry[]>
}): Promise<RouteResult> {
  const id = tokenIdParam(tokenId)
  if (id == null) return INVALID_TOKEN_ID
  // An empty `?limit=` is missing, not 0.
  const l = Number(limit === '' ? 100 : limit ?? 100)
  const o = Number(offset === '' ? 0 : offset ?? 0)
  const lim = Number.isFinite(l) ? Math.min(Math.max(Math.trunc(l), 1), 500) : 100
  const off = Number.isFinite(o) ? Math.max(Math.trunc(o), 0) : 0
  try {
    return { status: 200, body: await deps.page(id, lim, off) }
  } catch (e) {
    return fail(e)
  }
}

/**
 * Re-admits (GASP re-sync / reorg replay) append duplicate rows for the same
 * on-chain action with a fresh admitSeq: collapse to one per (txid, outputIndex)
 * before summing, or totals double-count.
 */
export const summarizeHistory = (
  rows: ReadonlyArray<Pick<AdminHistoryEntry, 'txid' | 'outputIndex' | 'kind' | 'delta'>>
): { totalIssued: number, totalRedeemed: number, actionCount: number } => {
  const seen = new Set<string>()
  let totalIssued = 0
  let totalRedeemed = 0
  for (const r of rows) {
    const key = `${r.txid}:${r.outputIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    if (r.delta > 0) totalIssued += r.delta
    else if (r.delta < 0) totalRedeemed += -r.delta
  }
  return { totalIssued, totalRedeemed, actionCount: seen.size }
}

export async function adminSummaryResponse (tokenId: unknown, deps: {
  history: (id: string) => Promise<AdminHistoryEntry[]>
}): Promise<RouteResult> {
  const id = tokenIdParam(tokenId)
  if (id == null) return INVALID_TOKEN_ID
  try {
    return { status: 200, body: summarizeHistory(await deps.history(id)) }
  } catch (e) {
    return fail(e)
  }
}

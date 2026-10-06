import { Transaction } from '@bsv/sdk'
import { OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'
import { decodeToken, parseDeployPayload } from './brc162.js'

/** Public token metadata (deploy payload + registry row). */
export interface AssetMetadata {
  label: string
  ticker: string
  decimals: number
  /** Deployer identity key, when known (the registry row carries it). */
  issuer?: string
  feeRatePerKb?: number | null
  [k: string]: unknown
}

/** One `GET /admin/tokens` row. */
export interface TokenListing {
  tokenId: string
  deployTxid: string
  sym: string
  dec: number
  label: string
  issuer: string
  feeRatePerKb: number | null
  createdAt: string
  /** Whether this overlay host follows the token's topic. */
  hosted: boolean
}

/**
 * GET /admin/tokens (public): every token ever deployed, ordered createdAt
 * then tokenId. `limit` 1-100 (default 100), `skip` 0-100000.
 */
export async function listTokens (opts: { limit?: number, skip?: number } = {}): Promise<TokenListing[]> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  const params = new URLSearchParams()
  if (opts.limit != null) params.set('limit', String(opts.limit))
  if (opts.skip != null) params.set('skip', String(opts.skip))
  const q = params.toString()
  const res = await fetch(`${OVERLAY_URL}/admin/tokens${q !== '' ? `?${q}` : ''}`)
  if (!res.ok) throw new Error(`token list fetch failed: ${res.status}`)
  const body = await res.json()
  const rows: unknown[] = Array.isArray(body) ? body : Array.isArray(body?.tokens) ? body.tokens : []
  return rows.filter((r): r is TokenListing => r != null && typeof (r as TokenListing).tokenId === 'string')
}

const toMetadata = (t: TokenListing): AssetMetadata => ({
  label: t.label,
  ticker: t.sym,
  decimals: t.dec,
  issuer: t.issuer,
  feeRatePerKb: t.feeRatePerKb
})

const cache = new Map<string, AssetMetadata>()

/** Pure decode helper: the deploy payload of output `index` in a BEEF, or null. */
export function parseMetadataFromBeef (beef: number[], index: number): AssetMetadata | null {
  try {
    const tx = Transaction.fromBEEF(beef)
    const ls = tx.outputs[index]?.lockingScript
    if (ls == null) return null
    const d = decodeToken(ls)
    if (d == null || d.role !== 'deploy') return null
    const m = parseDeployPayload(d.payload)
    return m == null ? null : { label: m.label, ticker: m.sym, decimals: m.dec, ...(m.feeRatePerKb !== undefined ? { feeRatePerKb: m.feeRatePerKb } : {}) }
  } catch {
    return null
  }
}

/**
 * An asset's metadata by token id, from the overlay's token registry
 * (GET /admin/tokens, paged). Only positive answers are memoized.
 */
export async function resolveAssetMetadata (assetId: string): Promise<AssetMetadata | null> {
  const hit = cache.get(assetId)
  if (hit != null) return hit
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const PAGE = 100
    for (let skip = 0; skip <= 100000; skip += PAGE) {
      const rows = await listTokens({ limit: PAGE, skip })
      for (const r of rows) cache.set(r.tokenId, toMetadata(r))
      if (cache.has(assetId) || rows.length < PAGE) break
    }
  } catch (e) {
    console.warn(`[mandala] asset metadata lookup failed for ${assetId}:`, e instanceof Error ? e.message : e)
  }
  return cache.get(assetId) ?? null
}

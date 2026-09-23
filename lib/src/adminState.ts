import { OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'

export interface AssetAdminStateView {
  assetId: string
  issuerIdentityKey: string
  isPaused: boolean
  accessMode: 'denylist' | 'allowlist'
  /** Token-fee design §2: base units per 1000 bytes; null/absent = issuer-paid fees disabled. */
  feeRatePerKb?: number | null
  blockedIdentities: string[]
  allowedIdentities: string[]
  frozenOutpoints: Array<{ outpoint: string, amount: number, owner: string, reason: string }>
  evictedOutpoints: string[]
}

const cache = new Map<string, { at: number, val: AssetAdminStateView | null }>()
const TTL = 10_000

/**
 * Overlay admin state for one asset, memoised for TTL. Pass `force` on the
 * post-mutation path (an admin action just committed) so the caller does not
 * read pre-action state out of the memo and see its freeze "not applied";
 * the forced fetch re-primes the memo, so steady-state load is unchanged.
 * Any remaining lag after a forced fetch is the overlay folding the admission
 * asynchronously — a server-side item, not addressed here.
 */
export async function resolveAssetState (
  assetId: string,
  opts: { force?: boolean } = {}
): Promise<AssetAdminStateView | null> {
  const hit = cache.get(assetId)
  if (!opts.force && hit != null && Date.now() - hit.at < TTL) return hit.val
  let val: AssetAdminStateView | null = null
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const res = await fetch(`${OVERLAY_URL}/admin/asset-state/${encodeURIComponent(assetId)}`)
    if (res.ok) val = await res.json() as AssetAdminStateView
  } catch { val = null }
  cache.set(assetId, { at: Date.now(), val })
  return val
}

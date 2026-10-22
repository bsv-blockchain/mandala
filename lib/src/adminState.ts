import { OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'
import { parseDecimalAmount } from './amount.js'

export interface AssetAdminStateView {
  assetId: string
  /** Not served by the BRC-162 overlay (the issuer is the token registry row's `issuer`). */
  issuerIdentityKey?: string
  isPaused: boolean
  accessMode: 'denylist' | 'allowlist'
  /** Token-fee design §2: base units per 1000 bytes; null/absent = issuer-paid fees disabled. */
  feeRatePerKb?: number | null
  blockedIdentities: string[]
  allowedIdentities: string[]
  /** `amount` is exact; an entry whose wire amount is not a decimal string is dropped (C§0). */
  frozenOutpoints: Array<{ outpoint: string, amount: bigint, owner: string, reason: string }>
  evictedOutpoints: string[]
}

type FrozenRef = AssetAdminStateView['frozenOutpoints'][number]

// Never coerced: an entry with a non-canonical amount is dropped, one warning per read.
function readFrozen (raw: unknown, assetId: string): FrozenRef[] {
  if (!Array.isArray(raw)) return []
  const out: FrozenRef[] = []
  let dropped = 0
  for (const f of raw) {
    const amount = parseDecimalAmount(f?.amount)
    if (amount == null) { dropped++; continue }
    out.push({ ...f, amount })
  }
  if (dropped > 0) console.warn(`[mandala] asset state ${assetId}: dropped ${dropped} frozen outpoint(s) whose amount is not a decimal string`)
  return out
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
    if (res.ok) {
      const body = await res.json()
      // The v3 route keys the row by tokenId; keep the assetId view.
      val = { ...body, assetId: body.assetId ?? body.tokenId, frozenOutpoints: readFrozen(body.frozenOutpoints, assetId) } as AssetAdminStateView
    }
  } catch { val = null }
  cache.set(assetId, { at: Date.now(), val })
  return val
}

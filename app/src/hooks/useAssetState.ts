import { useQuery, useQueryClient } from '@tanstack/react-query'
import { resolveAssetState, AssetAdminStateView } from '@bsv/mandala/adminState'

export const assetStateKey = (assetId: string) => ['asset-state', assetId] as const

/** Overlay-resolved admin state (pause, access mode …) for one asset. */
export function useAssetState(assetId: string) {
  return useQuery({
    queryKey: assetStateKey(assetId),
    enabled: assetId !== '',
    queryFn: async (): Promise<AssetAdminStateView | null> => resolveAssetState(assetId)
  })
}

/** Invalidate one asset's admin state from anywhere (post-admin-action). */
export function useInvalidateAssetState() {
  const qc = useQueryClient()
  return async (assetId: string) => {
    // Post-mutation path: the lib memoises resolveAssetState for 10 s, so a
    // plain refetch could hand back pre-action state and the operator would
    // see their freeze "not applied". Force one fresh fetch (which re-primes
    // the memo), then let react-query refetch from it — one network call.
    // Any remaining one-submit lag is the overlay folding the admission
    // asynchronously: a server-side item, not addressed here.
    await resolveAssetState(assetId, { force: true })
    await qc.invalidateQueries({ queryKey: assetStateKey(assetId) })
  }
}

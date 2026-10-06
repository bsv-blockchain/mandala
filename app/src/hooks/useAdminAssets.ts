import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useWallet } from '../context/WalletContext'
import { listAdminAssets, AdminAsset } from '@bsv/mandala/assets'

export const adminAssetsKey = (identityKey: string | null) =>
  ['admin-assets', identityKey] as const

/** Issuer console's admin-asset list — shared cache across every section. */
export function useAdminAssets() {
  const { wallet, identityKey } = useWallet()
  return useQuery({
    queryKey: adminAssetsKey(identityKey),
    enabled: wallet != null,
    queryFn: async (): Promise<AdminAsset[]> => listAdminAssets(wallet as any)
  })
}

export function useInvalidateAdminAssets() {
  const qc = useQueryClient()
  const { identityKey } = useWallet()
  return () => qc.invalidateQueries({ queryKey: adminAssetsKey(identityKey) })
}

/**
 * Advance an asset's admin-auth chain in the cache the moment an action
 * commits. The background refetch eventually agrees, but until it lands a
 * second action would read the SPENT prior from the cache and die with
 * StaleAdminAuthError — this closes that gap. authKeyID must advance with
 * the outpoint (the next unlock derives from them).
 */
export function useAdvanceAdminAuth() {
  const qc = useQueryClient()
  const { identityKey } = useWallet()
  return (assetId: string, nextAuthOutpoint: string, nextAuthKeyID?: string) => {
    qc.setQueryData<AdminAsset[]>(adminAssetsKey(identityKey), prev =>
      prev?.map(a =>
        a.assetId === assetId
          ? { ...a, authOutpoint: nextAuthOutpoint, authKeyID: nextAuthKeyID ?? a.authKeyID }
          : a
      )
    )
  }
}

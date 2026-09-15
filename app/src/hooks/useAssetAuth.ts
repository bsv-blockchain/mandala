import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useWallet } from '../context/WalletContext'
import { fetchAssetAuthHead, recoverAdminAuth, OverlayAssetAuth } from '@bsv/mandala/assetRecover'
import { useInvalidateAdminAssets } from './useAdminAssets'

export const assetAuthKey = (assetId: string) => ['asset-auth', assetId] as const

/**
 * The overlay's view of an asset's live admin-auth head. This is the recovery
 * path — it is consulted when the basket does NOT list the asset — so it is
 * never answered from the cache: a re-attach must see the head as it stands.
 */
export function useAssetAuth(assetId: string) {
  return useQuery({
    queryKey: assetAuthKey(assetId),
    enabled: assetId !== '',
    staleTime: 0,
    queryFn: async (): Promise<OverlayAssetAuth | null> => fetchAssetAuthHead(assetId)
  })
}

/** Put the overlay's live admin-auth UTXO for an asset back in this wallet's basket. */
export function useReattachAssetAuth() {
  const { wallet } = useWallet()
  const qc = useQueryClient()
  const invalidateAdminAssets = useInvalidateAdminAssets()
  return useMutation({
    mutationFn: async (assetId: string) => {
      if (wallet == null) throw new Error('Wallet not ready')
      return recoverAdminAuth({ wallet: wallet as any, assetId })
    },
    onSuccess: asset => {
      toast.success(
        asset != null
          ? `Re-attached the asset authority for ${asset.label} to this wallet`
          : 'The overlay has no admin history for this asset'
      )
    },
    onError: e => toast.error(`Re-attach failed: ${String(e)}`),
    onSettled: (_result, _error, assetId) => {
      void invalidateAdminAssets()
      void qc.invalidateQueries({ queryKey: assetAuthKey(assetId) })
    }
  })
}

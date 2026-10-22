import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAdminAssets, loadHistory, resolveAssetMetadata } from '@bsv/mandala'
import { useWallet } from '../context/WalletContext'
import { loadHolderData, type HolderData } from '../lib/mandala/loadHolderData'

export type { AssetMeta, AssetRow, HolderData } from '../lib/mandala/loadHolderData'

/** JSON-safe (strings/null only): React Query hashes keys with JSON.stringify. */
export const holderDataKey = (identityKey: string | null) =>
  ['holder-data', identityKey] as const

const deps = { loadHistory, listAdminAssets, resolveAssetMetadata }

/**
 * Balances + history + resolved metadata in one query. Every holder view reads
 * this shape, so navigation between home / send / history renders instantly
 * from cache while a background refetch keeps it current. Balances are the
 * exact BRC-207 `p color balance` views (bigint); see `loadHolderData`.
 */
export function useHolderData() {
  const { wallet, identityKey } = useWallet()

  return useQuery({
    queryKey: holderDataKey(identityKey),
    enabled: wallet != null,
    queryFn: async (): Promise<HolderData> => {
      if (wallet == null) throw new Error('Wallet not ready')
      return await loadHolderData(wallet, deps)
    }
  })
}

/** Invalidate holder data from anywhere (post-mutation, incoming payment…). */
export function useInvalidateHolderData() {
  const qc = useQueryClient()
  const { identityKey } = useWallet()
  return () => qc.invalidateQueries({ queryKey: holderDataKey(identityKey) })
}

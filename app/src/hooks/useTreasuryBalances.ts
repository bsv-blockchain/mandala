import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { useWallet } from '../context/WalletContext'
import { loadTreasuryBalances, type TreasuryData } from '../lib/mandala/treasury'

export type { TreasuryData } from '../lib/mandala/treasury'

/** JSON-safe (strings/null only): React Query hashes keys with JSON.stringify. */
export const treasuryKey = (identityKey: string | null) =>
  ['treasury', identityKey] as const

/**
 * Issuer treasury units per asset (exact bigint) from the lib's
 * TREASURY_BASKET. Enabled only for the issuer: a holder has no treasury.
 */
export function useTreasuryBalances(): UseQueryResult<TreasuryData> {
  const { wallet, identityKey, isIssuer } = useWallet()
  return useQuery({
    queryKey: treasuryKey(identityKey),
    enabled: wallet != null && isIssuer,
    queryFn: async (): Promise<TreasuryData> => {
      if (wallet == null) throw new Error('Wallet not ready')
      return await loadTreasuryBalances(wallet)
    }
  })
}

export function useInvalidateTreasury(): () => Promise<void> {
  const qc = useQueryClient()
  const { identityKey } = useWallet()
  return async () => { await qc.invalidateQueries({ queryKey: treasuryKey(identityKey) }) }
}

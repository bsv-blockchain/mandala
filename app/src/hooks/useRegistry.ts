import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useWallet } from '../context/WalletContext'
import {
  fetchRegistry,
  listRegistryAuth,
  OverlayRegistryRow,
  RegistryAuth
} from '@bsv/mandala/registry'

export const overlayRegistryKey = ['overlay-registry'] as const
export const registryAuthKey = (identityKey: string | null) =>
  ['registry-auth', identityKey] as const

/** Overlay cache of the issuer-level identity chain. */
export function useOverlayRegistry () {
  return useQuery({
    queryKey: overlayRegistryKey,
    queryFn: fetchRegistry
  })
}

/** Live registry-auth UTXO in this wallet's basket, if any. */
export function useRegistryAuth () {
  const { wallet, identityKey } = useWallet()
  return useQuery({
    queryKey: registryAuthKey(identityKey),
    enabled: wallet != null,
    queryFn: async (): Promise<RegistryAuth | null> => listRegistryAuth(wallet as any)
  })
}

export function useInvalidateRegistry () {
  const qc = useQueryClient()
  const { identityKey } = useWallet()
  return () => {
    void qc.invalidateQueries({ queryKey: overlayRegistryKey })
    void qc.invalidateQueries({ queryKey: registryAuthKey(identityKey) })
  }
}

export type { OverlayRegistryRow, RegistryAuth }

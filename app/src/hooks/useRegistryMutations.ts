import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useWallet } from '../context/WalletContext'
import { mockKycAdmit, mockKycOpen, mockKycRevoke } from '@bsv/mandala/registry'
import { BusyError } from '@bsv/mandala/singleFlight'
import { useInvalidateRegistry } from './useRegistry'

export function useRegistryMutations () {
  const { wallet, identityKey } = useWallet()
  const invalidate = useInvalidateRegistry()

  const open = useMutation({
    mutationFn: async () => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      return mockKycOpen({ wallet: wallet as any, issuerIdentityKey: identityKey })
    },
    onSuccess: res => {
      if (res.recovered) toast.success('Re-attached the on-chain identity authorization to this wallet')
      else if (res.opened) toast.success('Identity chain opened — this wallet now holds the live authorization')
      else toast.success('This wallet already holds the live identity authorization')
    },
    onError: e => {
      if (e instanceof BusyError) return
      toast.error(`Open identity chain failed: ${String(e)}`)
    },
    onSettled: () => { invalidate() }
  })

  const admit = useMutation({
    mutationFn: async (targetKey: string) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      return mockKycAdmit({ wallet: wallet as any, issuerIdentityKey: identityKey, targetKey })
    },
    onSuccess: (res, key) => {
      toast.success(
        res.recovered
          ? `Re-attached identity chain and admitted ${key.slice(0, 12)}…`
          : res.opened
            ? `Opened identity registry and admitted ${key.slice(0, 12)}…`
            : `Admitted ${key.slice(0, 12)}…`
      )
    },
    onError: e => {
      if (e instanceof BusyError) return
      toast.error(`Admit failed: ${String(e)}`)
    },
    onSettled: () => { invalidate() }
  })

  const revoke = useMutation({
    mutationFn: async (targetKey: string) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      return mockKycRevoke({ wallet: wallet as any, issuerIdentityKey: identityKey, targetKey })
    },
    onSuccess: (_r, key) => toast.success(`Revoked ${key.slice(0, 12)}…`),
    onError: e => {
      if (e instanceof BusyError) return
      toast.error(`Revoke failed: ${String(e)}`)
    },
    onSettled: () => { invalidate() }
  })

  return { open, admit, revoke }
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useWallet } from '../context/WalletContext'
import { AdminAsset } from '@bsv/mandala/assets'
import { registerAsset, issueTokens, redeemTokens } from '@bsv/mandala/issuerOps'
import { reconcileWallet } from '@bsv/mandala/reconcile'
import { formatAmount } from '@bsv/mandala/amount'
import { registerFlight, BusyError } from '@bsv/mandala/singleFlight'
import { guardIssueSubmit, guardRedeemSubmit, guardRegisterSubmit } from '@bsv/mandala/submitGuards'
import { adminAssetsKey, useAdvanceAdminAuth } from './useAdminAssets'
import { holderDataKey, HolderData } from './useHolderData'

/**
 * Issuer operations as optimistic mutations. Issue/redeem update the issuer's
 * own FT balance in the holder-data cache instantly and roll back if the
 * overlay rejects; every mutation invalidates the shared admin-assets query
 * and runs a background reconcile so half-finished state self-heals.
 *
 * Register is single-flight (registerFlight). Issue/redeem serialize per-asset
 * admin-auth inside issuerOps (withAdminAuthGate) so a double-click cannot
 * spend the same priorOutpoint twice.
 */
export function useIssuerMutations() {
  const { wallet, identityKey } = useWallet()
  const qc = useQueryClient()
  const holderKey = holderDataKey(identityKey)
  const advanceAdminAuth = useAdvanceAdminAuth()

  const settle = () => {
    void qc.invalidateQueries({ queryKey: adminAssetsKey(identityKey) })
    void qc.invalidateQueries({ queryKey: holderKey })
    if (wallet != null) void reconcileWallet(wallet as any).catch(() => {})
  }

  const adjustBalance = async (assetId: string, delta: number) => {
    await qc.cancelQueries({ queryKey: holderKey })
    const prev = qc.getQueryData<HolderData>(holderKey)
    if (prev != null) {
      qc.setQueryData<HolderData>(holderKey, {
        ...prev,
        assets: prev.assets.map(a =>
          a.assetId === assetId ? { ...a, balance: a.balance + delta } : a
        )
      })
    }
    return { prev }
  }

  const register = useMutation({
    mutationFn: async (vars: { label: string; ticker: string; decimals: number; feeRatePerKb?: number }) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      const gate = guardRegisterSubmit({
        label: vars.label,
        ticker: vars.ticker,
        decimals: vars.decimals,
        walletReady: true
      })
      if (!gate.ok) throw new Error(gate.reason)
      return registerFlight.run(() =>
        registerAsset({ wallet: wallet as any, identityKey, ...vars })
      )
    },
    onSuccess: (res, vars) => toast.success(`Registered ${vars.label.trim()} (${res.assetId})`),
    onError: e => {
      if (e instanceof BusyError) return // silent no-op for double-click
      toast.error(`Register failed: ${String(e)}`)
    },
    onSettled: settle
  })

  const issue = useMutation<Awaited<ReturnType<typeof issueTokens>>, Error, { asset: AdminAsset; amount: number; depositHash?: string }, { prev?: HolderData }>({
    mutationFn: async ({ asset, amount, depositHash }) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      // depositHash is the sha256 of the bank record (hashed in the panel);
      // the guard refuses anything that is not a 64-hex digest so a raw
      // reference can never be committed on-chain.
      const gate = guardIssueSubmit({ assetId: asset.assetId, amount, bankRef: depositHash, walletReady: true })
      if (!gate.ok) throw new Error(gate.reason)
      return issueTokens({ wallet: wallet as any, identityKey, asset, amount, depositHash })
    },
    onMutate: ({ asset, amount }) => adjustBalance(asset.assetId, amount),
    onSuccess: (r, { asset, amount }) => {
      // Advance the cached auth chain immediately — a second action before the
      // background refetch lands must not read the spent prior.
      advanceAdminAuth(asset.assetId, r.nextAuthOutpoint, r.nextAuthDetails)
      toast.success(`Issued ${formatAmount(amount, Number(asset.metadata?.decimals) || 0)} ${asset.label}`)
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev != null) qc.setQueryData(holderKey, ctx.prev)
      if (e instanceof BusyError) return
      toast.error(`Issue failed: ${String(e)}`)
    },
    onSettled: settle
  })

  const redeem = useMutation<Awaited<ReturnType<typeof redeemTokens>>, Error, { asset: AdminAsset; amount: number }>({
    mutationFn: async ({ asset, amount }) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      // Enforce balance at the mutation boundary even when the UI guard is
      // bypassed (direct mutate). Read the cache BEFORE the optimistic
      // decrement — onMutate would run first and make the gate compare
      // against balance-minus-amount, refusing any redeem above half.
      // A missing asset row means "balance unknown" (e.g. just-issued,
      // refetch pending): skip the cap and let coin selection be the
      // authority, matching the UI guard's semantics.
      const holder = qc.getQueryData<HolderData>(holderKey)
      const balance = holder?.assets.find(a => a.assetId === asset.assetId)?.balance
      const gate = guardRedeemSubmit({
        assetId: asset.assetId,
        amount,
        balance,
        walletReady: true
      })
      if (!gate.ok) throw new Error(gate.reason)
      // Optimistic decrement lives here (not onMutate) so the gate above sees
      // the pre-decrement balance; roll back inline on any failure.
      const { prev } = await adjustBalance(asset.assetId, -amount)
      try {
        return await redeemTokens({
          wallet: wallet as any,
          identityKey,
          asset,
          amount,
          balance
        })
      } catch (e) {
        if (prev != null) qc.setQueryData(holderKey, prev)
        throw e
      }
    },
    onSuccess: (r, { asset, amount }) => {
      advanceAdminAuth(asset.assetId, r.nextAuthOutpoint, r.nextAuthDetails)
      toast.success(`Redeemed (burned) ${formatAmount(amount, Number(asset.metadata?.decimals) || 0)} ${asset.label}`)
    },
    onError: e => {
      if (e instanceof BusyError) return
      toast.error(`Redeem failed: ${String(e)}`)
    },
    onSettled: settle
  })

  return { register, issue, redeem }
}

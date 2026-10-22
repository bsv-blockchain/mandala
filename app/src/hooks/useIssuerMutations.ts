import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { registerAsset, issueTokens, redeemTokens } from '@bsv/mandala'
import type { AdminAsset } from '@bsv/mandala/assets'
import { registerFlight, BusyError } from '@bsv/mandala/singleFlight'
import { guardIssueSubmit, guardRedeemSubmit, guardRegisterSubmit } from '@bsv/mandala/submitGuards'
import { useWallet } from '../context/WalletContext'
import { displayAmount } from '../lib/mandala/amountDisplay'
import { decimalsOf } from '../lib/mandala/loadHolderData'
import { validateRegisterForm } from '../lib/mandala/registerForm'
import { adminAssetsKey, useAdvanceAdminAuth } from './useAdminAssets'
import { holderDataKey } from './useHolderData'
import { treasuryKey, type TreasuryData } from './useTreasuryBalances'

export interface RegisterVars { label: string, ticker: string, decimals: number }
export interface IssueVars { asset: AdminAsset, amount: bigint, depositHash?: string }
export interface RedeemVars { asset: AdminAsset, amount: bigint }

/**
 * Issuer operations as mutations over exact bigint amounts.
 *
 * - Register: the deploy carries the Mandala `req` (the lib builds
 *   mandalaReq(OVERLAY_IDENTITY_KEY) inside registerAsset) and no fee rate
 *   (B6). Field limits are re-checked here so a direct `mutate` cannot skip
 *   the strip's validation.
 * - Issue mints into the issuer treasury (TREASURY_BASKET): the treasury cache
 *   is raised optimistically and restored from the snapshot on failure.
 * - Redeem burns treasury coins: the balance gate reads the treasury cache
 *   BEFORE this mutation's own decrement (so redeem-all is possible), then
 *   decrements and calls redeemTokens.
 *
 * Stability:
 * - Double-click / multi-tab: register runs under registerFlight (same tab)
 *   and the lib's `mandala.register` web lock (other tabs). Issue and redeem
 *   spend admin authority: the lib serializes them per asset (adminAuthGate),
 *   the panel refuses while isAdminAuthInFlight, and onSuccess advances the
 *   cached authority immediately so the next action never reads the spent
 *   prior.
 * - Stale cache: an absent treasury row means "balance unknown" (just issued,
 *   refetch pending), so the gate skips the cap and the lib's coin selection
 *   is the authority. The balance is not passed on to redeemTokens: the cache
 *   may be an optimistic value, and the gate above already applied it.
 * - Crash / retry: every mutation settles by refetching treasury, admin
 *   assets and holder data, then running drainNow({ force: true }) — the
 *   app's single recovery entry (notification redelivery + wallet reconcile).
 *   This hook never calls the lib's reconcile itself.
 */
export function useIssuerMutations() {
  const { wallet, identityKey, drainNow } = useWallet()
  const qc = useQueryClient()
  const tKey = treasuryKey(identityKey)
  const advanceAdminAuth = useAdvanceAdminAuth()

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: tKey })
    void qc.invalidateQueries({ queryKey: adminAssetsKey(identityKey) })
    void qc.invalidateQueries({ queryKey: holderDataKey(identityKey) })
  }

  const settle = (): void => {
    refresh()
    void drainNow({ force: true }).finally(refresh)
  }

  /** Optimistically move one asset's treasury sum by `delta`; returns the snapshot. */
  const adjustTreasury = async (assetId: string, delta: bigint): Promise<{ prev?: TreasuryData }> => {
    await qc.cancelQueries({ queryKey: tKey })
    const prev = qc.getQueryData<TreasuryData>(tKey)
    if (prev != null) {
      qc.setQueryData<TreasuryData>(tKey, { ...prev, [assetId]: (prev[assetId] ?? 0n) + delta })
    }
    return { prev }
  }

  const register = useMutation({
    mutationFn: async (vars: RegisterVars) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      const form = validateRegisterForm({ label: vars.label, ticker: vars.ticker, decimals: String(vars.decimals) })
      if (!form.ok) throw new Error(form.reason)
      const gate = guardRegisterSubmit({ ...form.value, walletReady: true })
      if (!gate.ok) throw new Error(gate.reason)
      const { label, ticker, decimals } = form.value
      return await registerFlight.run(async () =>
        await registerAsset({ wallet: wallet as any, identityKey, label, ticker, decimals })
      )
    },
    onSuccess: (res, vars) => toast.success(`Registered ${vars.label.trim()} (${res.assetId})`),
    onError: e => {
      if (e instanceof BusyError) return // silent no-op for double-click
      toast.error(`Register failed: ${String(e)}`)
    },
    onSettled: settle
  })

  const issue = useMutation<Awaited<ReturnType<typeof issueTokens>>, Error, IssueVars, { prev?: TreasuryData }>({
    mutationFn: async ({ asset, amount, depositHash }) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      // depositHash is the sha256 of the bank record (hashed in the panel);
      // the guard refuses anything that is not a 64-hex digest so a raw
      // reference can never be committed on-chain.
      const gate = guardIssueSubmit({ assetId: asset.assetId, amount, bankRef: depositHash, walletReady: true })
      if (!gate.ok) throw new Error(gate.reason)
      return await issueTokens({ wallet: wallet as any, identityKey, asset, amount, depositHash })
    },
    onMutate: async ({ asset, amount }) => await adjustTreasury(asset.assetId, amount),
    onSuccess: (r, { asset, amount }) => {
      // Advance the cached auth chain immediately — a second action before the
      // background refetch lands must not read the spent prior.
      advanceAdminAuth(asset.assetId, r.nextAuthOutpoint, r.nextAuthKeyID)
      toast.success(`Issued ${displayAmount(amount, decimalsOf(asset.metadata?.decimals))} ${asset.label}`)
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev != null) qc.setQueryData(tKey, ctx.prev)
      if (e instanceof BusyError) return
      toast.error(`Issue failed: ${String(e)}`)
    },
    onSettled: settle
  })

  const redeem = useMutation<Awaited<ReturnType<typeof redeemTokens>>, Error, RedeemVars>({
    mutationFn: async ({ asset, amount }) => {
      if (wallet == null || identityKey == null) throw new Error('Wallet not ready')
      // Read the treasury BEFORE the optimistic decrement: an onMutate would
      // run first and make the gate compare against balance-minus-amount,
      // refusing any redeem above half.
      const balance = qc.getQueryData<TreasuryData>(treasuryKey(identityKey))?.[asset.assetId]
      const gate = guardRedeemSubmit({
        assetId: asset.assetId,
        amount,
        balance,
        walletReady: true
      })
      if (!gate.ok) throw new Error(gate.reason)
      // Optimistic decrement lives here (not onMutate) so the gate above sees
      // the pre-decrement balance; roll back inline on any failure.
      const { prev } = await adjustTreasury(asset.assetId, -amount)
      try {
        return await redeemTokens({ wallet: wallet as any, identityKey, asset, amount })
      } catch (e) {
        if (prev != null) qc.setQueryData(tKey, prev)
        throw e
      }
    },
    onSuccess: (r, { asset, amount }) => {
      advanceAdminAuth(asset.assetId, r.nextAuthOutpoint, r.nextAuthKeyID)
      toast.success(`Redeemed (burned) ${displayAmount(amount, decimalsOf(asset.metadata?.decimals))} ${asset.label}`)
    },
    onError: e => {
      if (e instanceof BusyError) return
      toast.error(`Redeem failed: ${String(e)}`)
    },
    onSettled: settle
  })

  return { register, issue, redeem }
}

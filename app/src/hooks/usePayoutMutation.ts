import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { payoutTokens, type PayoutResult } from '@bsv/mandala'
import type { AdminAsset } from '@bsv/mandala/assets'
import { createSingleFlight, BusyError } from '@bsv/mandala/singleFlight'
import { guardPositiveAmount } from '@bsv/mandala/submitGuards'
import { useWallet } from '../context/WalletContext'
import { treasuryKey, type TreasuryData } from './useTreasuryBalances'

export interface PayoutVars { asset: AdminAsset; amount: bigint; recipientKey: string; note?: string }

/** Process-wide payout latch: one issuer payout pipeline per tab at a time. */
export const payoutFlight = createSingleFlight('payout')

interface PayoutContext { prev?: TreasuryData, acquired?: boolean }

/**
 * Issuer payout (B4): treasury value coins to one holder `p color` output with
 * a BRC-207 receipt delivered on MessageBox. Unblinded, so the receipt names
 * the issuer key.
 *
 * Stability:
 * - Double-click: `payoutFlight` is taken synchronously in onMutate, before
 *   any await; the lib's `mandala.payout` web lock covers other tabs (its
 *   BusyError arrives from mutationFn after the optimistic write, so rollback
 *   keys on `ctx.acquired`, not on the error class).
 * - A payout spends treasury inputs only and no admin authority, so it never
 *   reads or writes the admin-auth cache and cannot race an admin action over
 *   the authority output.
 * - Stale cache: the treasury is decremented optimistically, restored from
 *   the snapshot on error, and refetched once settled.
 * - Crash / undelivered receipt: the lib journals the receipt before the
 *   submit. `drainNow` (notification redelivery plus wallet reconcile) is the
 *   only recovery path; this hook never reconciles directly.
 */
export function usePayoutMutation() {
  const { wallet, messageBoxClient, identityKey, overlayIdentityKey, drainNow } = useWallet()
  const qc = useQueryClient()
  const tKey = treasuryKey(identityKey)

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: tKey })
  }

  return useMutation<PayoutResult, Error, PayoutVars, PayoutContext>({
    mutationFn: async ({ asset, amount, recipientKey, note }) => {
      // S5: refuse before any wallet work without a verified overlay key.
      if (wallet == null || messageBoxClient == null || identityKey == null || overlayIdentityKey == null) {
        throw new Error('Wallet not ready')
      }
      const gate = guardPositiveAmount(amount)
      if (!gate.ok) throw new Error(gate.reason)
      if (recipientKey.trim() === '') throw new Error('Enter a recipient')
      return await payoutTokens({
        wallet: wallet as any,
        identityKey,
        asset,
        amount,
        recipientKey: recipientKey.trim(),
        blind: false,
        messageBoxClient,
        note
      })
    },

    onMutate: async vars => {
      // Sync latch before any await: a second click in the same tick no-ops.
      if (!payoutFlight.tryAcquire()) {
        throw new BusyError('Payout already in progress')
      }
      try {
        await qc.cancelQueries({ queryKey: tKey })
        const prev = qc.getQueryData<TreasuryData>(tKey)
        if (prev != null) {
          qc.setQueryData<TreasuryData>(tKey, {
            ...prev,
            [vars.asset.assetId]: (prev[vars.asset.assetId] ?? 0n) - vars.amount
          })
        }
        return { prev, acquired: true }
      } catch (e) {
        payoutFlight.release()
        throw e
      }
    },

    onError: (e, _vars, ctx) => {
      if (ctx?.acquired !== true) {
        // This tab's losing double-click: nothing written, nothing started.
        toast.error(e.message)
        return
      }
      if (ctx.prev != null) qc.setQueryData(tKey, ctx.prev)
      // An unknown overlay outcome says so in its message (do not re-run).
      toast.error(e.message)
    },

    onSuccess: r => {
      if (r.notified === false) {
        toast.warning('Paid out; recipient notification pending — it will be retried automatically')
      } else {
        toast.success(`Paid out · ${r.txid.slice(0, 8)}…${r.txid.slice(-4)}`)
      }
    },

    onSettled: (_d, _e, _vars, ctx) => {
      // A losing same-tab mutate did no wallet work; a refetch now would
      // clobber the winner's optimistic treasury.
      if (ctx?.acquired !== true) return
      payoutFlight.release()
      refresh()
      // Redeliver a pending receipt and settle a half-finished payout from the
      // issuer journal; refetch once that pass resolves.
      void drainNow({ force: true }).finally(refresh)
    }
  })
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { payoutTokens } from '@bsv/mandala'
import type { AdminAsset } from '@bsv/mandala/assets'
import { createSingleFlight } from '@bsv/mandala/singleFlight'
import { guardPositiveAmount } from '@bsv/mandala/submitGuards'
import { useWallet } from '../context/WalletContext'
import { treasuryKey } from './useTreasuryBalances'
import { describePayoutOutcome, runPayout, type PayoutOutcome } from '../lib/mandala/payoutFlow'

export interface PayoutVars { asset: AdminAsset; amount: bigint; recipientKey: string; note?: string }

/** Process-wide payout latch: one issuer payout pipeline per tab at a time. */
export const payoutFlight = createSingleFlight('payout')

/**
 * Issuer payout (B4/B8): treasury value coins (Mandala issuer keys) to one
 * holder `p color` output, lib-built and overlay-first (noSend → submit →
 * sendWith), with the BRC-207 receipt delivered in the v4 hand-over body on
 * MessageBox. Unblinded, so the receipt names the issuer key.
 *
 * The mutation resolves to a PayoutOutcome and never rejects (runPayout).
 *
 * Stability:
 * - Double-click / two mounted forms: `payoutFlight` is taken synchronously at
 *   the start of runPayout; the lib's `mandala.payout` web lock covers other
 *   tabs. Both surface as outcome `busy`, with no wallet work started.
 * - A payout spends treasury inputs only and no admin authority, so it never
 *   reads or writes the admin-auth cache and cannot race an admin action.
 * - Stale cache: no optimistic write; the treasury is refetched once the
 *   payout settles, and again after the drain pass it triggers.
 * - Crash / undelivered receipt / unknown outcome: the lib journals the
 *   receipt before the submit and holds an unknown-outcome action. `drainNow`
 *   (notification redelivery plus wallet reconcile) is the only recovery path;
 *   this hook never reconciles directly.
 */
export function usePayoutMutation() {
  const { wallet, messageBoxClient, identityKey, overlayIdentityKey, drainNow } = useWallet()
  const qc = useQueryClient()
  const tKey = treasuryKey(identityKey)

  const refresh = (): void => { void qc.invalidateQueries({ queryKey: tKey }) }

  return useMutation<PayoutOutcome, Error, PayoutVars>({
    mutationFn: async vars => await runPayout({
      flight: payoutFlight,
      payout: async ({ asset, amount, recipientKey, note }: PayoutVars) => {
        // S5: refuse before any wallet work without a verified overlay key.
        if (wallet == null || messageBoxClient == null || identityKey == null || overlayIdentityKey == null) {
          throw new Error('Wallet not ready')
        }
        const gate = guardPositiveAmount(amount)
        if (!gate.ok) throw new Error(gate.reason)
        // The lib takes a lowercase compressed key only.
        const recipient = recipientKey.trim().toLowerCase()
        if (recipient === '') throw new Error('Enter a recipient')
        return await payoutTokens({
          wallet: wallet as any,
          identityKey,
          asset,
          amount,
          recipientKey: recipient,
          blind: false,
          messageBoxClient,
          ...(note != null && note.trim() !== '' ? { note: note.trim() } : {})
        })
      }
    }, vars),

    // Hook-level (not per-call) so the outcome is announced even if the form
    // unmounted mid-payout (asset switch, navigation).
    onSuccess: o => {
      const v = describePayoutOutcome(o)
      if (v.tone === 'success') toast.success(v.title)
      else if (v.tone === 'warning') toast.warning(v.title, { description: v.detail })
      else toast.error(v.title, { description: v.detail })
    },

    onSettled: o => {
      // A `busy` outcome did no wallet work: nothing to refresh or recover.
      if (o?.kind === 'busy') return
      refresh()
      // Redeliver a pending receipt and settle a half-finished payout from the
      // issuer journal; refetch once that pass resolves.
      void drainNow({ force: true }).finally(refresh)
    }
  })
}

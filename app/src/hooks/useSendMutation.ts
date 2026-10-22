import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useWallet } from '../context/WalletContext'
import { deliverHandover, markHandoverDelivered, sendHandover, settleHandover } from '@bsv/mandala'
import { sendFlight, BusyError } from '@bsv/mandala/singleFlight'
import { guardPositiveAmount } from '@bsv/mandala/submitGuards'
import { holderDataKey, HolderData } from './useHolderData'
import { contactsKey } from './useContactsData'
import {
  describeSettle,
  explainSendError,
  sendAndDeliver,
  type SendOutcome,
  type SendVars
} from '../lib/mandala/sendPipeline'

export type { SendOutcome, SendVars } from '../lib/mandala/sendPipeline'

interface SendContext { prev?: HolderData, acquired?: boolean }

/**
 * Optimistic holder send over BRC-207 (B5): sign → deliver → post-ACK settle
 * (`sendAndDeliver`). On mutate the balance drops and a pending history row
 * appears; the lib journal holds the signed hand-over before `sendHandover`
 * resolves, so after that point the mutation always succeeds and reports the
 * outcome (delivery or settle failures are finished by `drainNow`).
 *
 * Stability:
 * - Double-click: `sendFlight` is acquired synchronously in onMutate, before
 *   any await; the lib's `mandala.send` web lock covers other tabs.
 * - BusyError has two sources: this tab's latch (thrown by onMutate, nothing
 *   written, `ctx` undefined) and the lib's cross-tab lock (thrown by
 *   mutationFn after the optimistic write). Rollback and invalidation key on
 *   `ctx.acquired`, not on the error class.
 * - Stale cache: holder data and contacts are invalidated when the send
 *   settles and again when the post-send drain resolves (a refusal restores
 *   coins the optimistic cache removed).
 * - Recovery: the drain owns redelivery and settle recovery; the wallet
 *   module owns spendability. Nothing here reconciles directly.
 */
export function useSendMutation() {
  const { wallet, messageBoxClient, identityKey, overlayIdentityKey, drainNow } = useWallet()
  const qc = useQueryClient()
  const key = holderDataKey(identityKey)

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: contactsKey(identityKey) })
  }

  return useMutation<SendOutcome, Error, SendVars, SendContext>({
    mutationFn: async vars => {
      if (wallet == null || messageBoxClient == null || identityKey == null || overlayIdentityKey == null) {
        throw new Error('Wallet not ready')
      }
      const amountGate = guardPositiveAmount(vars.amount)
      if (!amountGate.ok) throw new Error(amountGate.reason)
      if (vars.assetId.trim() === '' || vars.recipientKey.trim() === '') {
        throw new Error('Asset and recipient are required')
      }
      // Latch is acquired in onMutate (before the optimistic write). Held
      // through sign, deliver and settle; released in onSettled.
      return await sendAndDeliver({
        wallet: wallet as any,
        identityKey,
        overlayIdentityKey,
        messageBoxClient,
        send: sendHandover,
        deliver: deliverHandover,
        markDelivered: markHandoverDelivered,
        settle: settleHandover
      }, vars)
    },

    onMutate: async vars => {
      // Sync latch before any await — a second click in the same tick no-ops.
      if (!sendFlight.tryAcquire()) {
        throw new BusyError('Send already in progress')
      }
      try {
        await qc.cancelQueries({ queryKey: key })
        const prev = qc.getQueryData<HolderData>(key)
        if (prev != null) {
          qc.setQueryData<HolderData>(key, {
            ...prev,
            assets: prev.assets.map(a =>
              a.assetId === vars.assetId && a.balance != null ? { ...a, balance: a.balance - vars.amount } : a
            ),
            history: [
              ...prev.history,
              {
                txid: `pending-${Date.now()}`,
                assetId: vars.assetId,
                direction: 'sent',
                amount: vars.amount,
                counterparty: vars.recipientKey,
                when: Date.now(),
                kind: 'transfer'
              }
            ]
          })
        }
        return { prev, acquired: true }
      } catch (e) {
        sendFlight.release()
        throw e
      }
    },

    onError: (e, _vars, ctx) => {
      // This tab's losing double-click never wrote optimistically (ctx is
      // undefined); the Send screen shows its BusyError inline.
      if (ctx?.acquired !== true) return
      // Signing failed or was refused (including another tab's send holding
      // the lib lock): nothing is journaled; restore the pre-send snapshot.
      if (ctx.prev != null) qc.setQueryData(key, ctx.prev)
      toast.error(explainSendError(e))
    },

    onSuccess: outcome => {
      const d = describeSettle(outcome)
      toast[d.kind](d.text)
      // Finish whatever the immediate leg left (redelivery, settle retry) and
      // refetch once that pass resolves.
      void drainNow({ force: true }).finally(refresh)
    },

    onSettled: (_d, _e, _vars, ctx) => {
      // A losing same-tab mutate did no wallet work. Invalidating here would
      // race the winner's in-flight pipeline (a refetch clobbers its
      // optimistic row).
      if (ctx?.acquired !== true) return
      sendFlight.release()
      refresh()
    }
  })
}

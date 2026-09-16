import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useWallet } from '../context/WalletContext'
import { transferTokens, TransferResult } from '@bsv/mandala/transfer'
import { reconcileWallet } from '@bsv/mandala/reconcile'
import { reconcileBans } from '@bsv/mandala/reconcileBans'
import { reconcileNotifications } from '@bsv/mandala/notifyJournal'
import { sendFlight, BusyError } from '@bsv/mandala/singleFlight'
import { guardPositiveAmount } from '@bsv/mandala/submitGuards'
import { holderDataKey, HolderData } from './useHolderData'
import { contactsKey } from './useContactsData'

export interface SendVars {
  assetId: string
  amount: number
  recipientKey: string
  /** The sender's own note — becomes the recipient's action description in
   * place of the fixed "Receive N of assetId" wording (see transfer.ts). */
  note?: string
}

/**
 * Optimistic send. On mutate the balance drops and a pending history row
 * appears instantly; the pipeline (build → sign → overlay submit) runs behind
 * it. The overlay is the commit point — a rejection aborts the wallet action
 * (inputs released, see submitAndBroadcast) and rolls the cache back. The
 * network broadcast continues in the background under journal protection.
 *
 * Single-flight: sendFlight rejects a second mutate before React re-renders
 * isPending, so double-click cannot start two createAction pipelines.
 */
export function useSendMutation() {
  const { wallet, messageBoxClient, identityKey } = useWallet()
  const qc = useQueryClient()
  const key = holderDataKey(identityKey)

  return useMutation<TransferResult, Error, SendVars, { prev?: HolderData; acquired?: boolean }>({
    mutationFn: async vars => {
      if (wallet == null || messageBoxClient == null || identityKey == null) {
        throw new Error('Wallet not ready')
      }
      const amountGate = guardPositiveAmount(vars.amount)
      if (!amountGate.ok) throw new Error(amountGate.reason)
      if (vars.assetId.trim() === '' || vars.recipientKey.trim() === '') {
        throw new Error('Asset and recipient are required')
      }
      // Latch is acquired in onMutate (before optimistic write). Hold through
      // the full pipeline; release in onSettled.
      return transferTokens({
        wallet: wallet as any,
        messageBoxClient,
        identityKey,
        assetId: vars.assetId,
        amount: vars.amount,
        recipientKey: vars.recipientKey,
        note: vars.note
      })
    },

    onMutate: async vars => {
      // Sync latch before any await — second click in the same tick no-ops.
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
              a.assetId === vars.assetId ? { ...a, balance: a.balance - vars.amount } : a
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
      // Busy re-entry never wrote optimistically (onMutate threw before setQueryData
      // only when acquire failed — in that case ctx is undefined).
      if (e instanceof BusyError) return
      // Overlay rejected (or build failed) — the wallet action was aborted and
      // inputs released; restore the pre-send snapshot.
      if (ctx?.prev != null) qc.setQueryData(key, ctx.prev)
    },

    onSuccess: res => {
      if (!res.notified) {
        toast.warning('Sent, but the recipient could not be notified — they may need to refresh.')
      }
    },

    onSettled: (_d, e, vars, ctx) => {
      if (ctx?.acquired) sendFlight.release()
      // A losing BusyError mutate did no wallet work. Invalidating or
      // reconciling here would race the winner's in-flight pipeline: a refetch
      // clobbers its optimistic row, and the reconcile sweep can abort its
      // live noSend action before the journal 'accepted' entry lands.
      if (e instanceof BusyError) return
      void qc.invalidateQueries({ queryKey: key })
      void qc.invalidateQueries({ queryKey: contactsKey(identityKey) })
      // Self-heal any half-finished state (stuck aborts, pending broadcasts,
      // undelivered recipient notifications) without waiting for the next
      // page load.
      if (wallet != null) void reconcileWallet(wallet as any).catch(() => {})
      if (wallet != null) void reconcileBans(wallet as any, [vars.assetId]).catch(() => {})
      if (messageBoxClient != null) void reconcileNotifications(messageBoxClient).catch(() => {})
    }
  })
}

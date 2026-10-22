import { useState, useEffect, useRef } from 'react'
import { Card, CardContent } from './ui/card'
import { toast } from 'sonner'
import { useWallet } from '../context/WalletContext'
import { Check, Clock } from 'lucide-react'
import { receiveHandovers, type ReceiveResult } from '@bsv/mandala'
import { useHolderData, useInvalidateHolderData } from '../hooks/useHolderData'
import { describeAccepted, describeFailed } from '../lib/mandala/receiveView'
import ReceivePanel from './holder/ReceivePanel'
import { Spinner } from './ui/spinner'

type ReceivedToken = ReceiveResult['accepted'][number] & { at: number }

/**
 * Incoming hand-overs are ACCEPTED AUTOMATICALLY — there is no manual
 * accept/reject step. On load the @bsv/mandala receive pipeline
 * (`receiveHandovers`) internalizes every pending MessageBox hand-over into
 * the wallet's BRC-207 module with its receipt, then acknowledges it; we show a
 * read-only confirmation. The QR/identity panel lets others send to you.
 *
 * Re-entry: a second pass (StrictMode double effect, wallet re-init) shares
 * `processedRef`; the lib checks and marks each id synchronously, so an
 * in-flight message is never internalized twice by this tab, and a retryable
 * failure is dropped from the set so a later pass retries it. Unacknowledged
 * messages survive a crash in the MessageBox and are received on next load.
 */
export default function ReceiveTokens() {
  const { wallet, messageBoxClient } = useWallet()
  const invalidateHolderData = useInvalidateHolderData()
  // Rows are described at render time from the live metas, so the first
  // hand-over of a not-yet-known asset backfills its label and decimals once
  // the invalidated holder data refetches.
  const { data: holderData } = useHolderData()
  const metas = holderData?.metas ?? {}
  const metasRef = useRef(metas)
  metasRef.current = metas
  const [received, setReceived] = useState<ReceivedToken[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const processedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    void autoReceive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageBoxClient, wallet])

  const autoReceive = async () => {
    setIsLoading(true)
    try {
      if (messageBoxClient == null || wallet == null) return
      const { accepted, failed } = await receiveHandovers({
        wallet,
        messageBoxClient,
        processed: processedRef.current
      })
      if (accepted.length > 0) {
        // Balance + history changed — refresh the shared holder cache in the background.
        void invalidateHolderData()
        const at = Date.now()
        // Keyed by messageId: a message re-accepted after a failed ack replaces its row.
        const ids = new Set(accepted.map(t => t.messageId))
        setReceived(prev => [...accepted.map(t => ({ ...t, at })), ...prev.filter(r => !ids.has(r.messageId))])
        for (const t of accepted) {
          const v = describeAccepted(t, metasRef.current)
          toast.success(v.title, {
            description: `${v.amountText} ${v.label}`,
            duration: 4000
          })
        }
      }
      for (const f of failed) {
        // One bad hand-over doesn't block the rest; a retryable one stays un-acknowledged.
        console.error('Auto-receive failed for', f.messageId, f.code, f.error)
        toast.error('Could not receive a transfer', { description: describeFailed(f) })
      }
    } catch (error) {
      console.error('Error checking for incoming transfers:', error)
      toast.error('Failed to check for incoming transfers', {
        description: error instanceof Error ? error.message : 'Unknown error'
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    // No header — the page's top bar already says "Receive"; the QR panel is
    // the action. One quiet footnote covers the "just wait" behaviour.
    <Card>
      <CardContent className="space-y-6 pt-6">
        {/* QR / identity — how others send to you; sits directly on the card
            (no nested well) to match the Send screen's single surface. */}
        <ReceivePanel />

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-2 text-muted-foreground">
            <Spinner size="sm" tone="brand" />
            <span className="text-[13px]">Checking for incoming transfers…</span>
          </div>
        ) : received.length === 0 ? (
          <p className="text-center text-[13px] text-muted-foreground">
            Incoming transfers are accepted automatically.
          </p>
        ) : (
          <div className="space-y-3">
            {received.map((r) => {
              const v = describeAccepted(r, metas)
              return (
                <div key={v.key} className="rounded-md border border-separator p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-0.5 text-[11px] font-semibold text-success">
                          <Check className="h-3 w-3" /> Received
                        </span>
                        {v.pending && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2.5 py-0.5 text-[11px] font-semibold text-warning">
                            <Clock className="h-3 w-3" /> Awaiting settlement
                          </span>
                        )}
                        <span className="text-[12px] text-subtle-foreground">{new Date(r.at).toLocaleTimeString()}</span>
                      </div>
                      <p className="tabular text-[28px] font-semibold leading-none tracking-[-0.02em] text-success">
                        {v.amountText}
                      </p>
                      <p className="mt-2 text-[15px] font-semibold">{v.label}</p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

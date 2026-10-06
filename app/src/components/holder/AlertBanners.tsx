import { decodeValue } from '@bsv/mandala'
import { useEffect, useState } from 'react'
import { AlertTriangle, ShieldOff } from 'lucide-react'
import { useWallet } from '../../context/WalletContext'
import { BASKET } from '@bsv/mandala/constants'
import { useAssetState } from '../../hooks/useAssetState'
import { useHolderData } from '../../hooks/useHolderData'
import { formatCurrency } from '@bsv/mandala/amount'

interface Props {
  assetId: string
}

export default function AlertBanners({ assetId }: Props) {
  const { wallet } = useWallet()
  // Cached queries — admin state (pause/freezes) + shared metadata.
  const { data: state } = useAssetState(assetId)
  const { data: holderData } = useHolderData()
  const [frozenAmount, setFrozenAmount] = useState(0)

  const isPaused = state?.isPaused ?? false
  const meta = holderData?.metas[assetId]
  const decimals = meta?.decimals ?? 0
  const ticker = meta?.ticker

  useEffect(() => {
    if (!assetId) return
    let cancelled = false
    void (async () => {
      if (state == null || wallet == null) return

      // Compute frozen amount: sum amounts of the holder's outputs whose outpoint
      // is in state.frozenOutpoints.
      const frozenSet = new Set(state.frozenOutpoints.map(fp => fp.outpoint))
      if (frozenSet.size === 0) { if (!cancelled) setFrozenAmount(0); return }

      try {
        const res = await wallet.listOutputs({
          basket: BASKET,
          include: 'locking scripts',
          limit: 1000
        })

        let total = 0
        for (const o of res.outputs) {
          const opStr = o.outpoint as string
          if (!frozenSet.has(opStr)) continue
          try {
            const decoded = decodeValue(o.lockingScript as string, assetId)
            if (decoded != null) total += decoded.amount
          } catch { /* not a mandala output */ }
        }
        if (!cancelled) setFrozenAmount(total)
      } catch (e) {
        console.error('AlertBanners: error computing frozen amount', e)
      }
    })()
    return () => { cancelled = true }
  }, [assetId, wallet, state])

  if (!isPaused && frozenAmount === 0) return null

  return (
    <div className="space-y-2">
      {isPaused && (
        <div className="flex items-start gap-3 rounded-md bg-warning/10 px-4 py-3 text-[13px] text-warning">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Transfers temporarily disabled by the issuer.</span>
        </div>
      )}
      {frozenAmount > 0 && (
        <div className="flex items-start gap-3 rounded-md bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {formatCurrency(frozenAmount, decimals, ticker)} of your balance has been frozen.
            Please contact support to dispute.
          </span>
        </div>
      )}
    </div>
  )
}

import { AlertTriangle, ShieldOff } from 'lucide-react'
import { useWallet } from '../../context/WalletContext'
import { useAssetState } from '../../hooks/useAssetState'
import { useHolderData } from '../../hooks/useHolderData'
import { formatCurrency } from '../../lib/mandala/amountDisplay'
import { frozenUnitsFor } from '../../lib/mandala/holderBalances'

interface Props {
  assetId: string
}

export default function AlertBanners({ assetId }: Props) {
  const { identityKey } = useWallet()
  // Cached queries — admin state (pause/freezes) + shared metadata.
  const { data: state } = useAssetState(assetId)
  const { data: holderData } = useHolderData()

  const isPaused = state?.isPaused ?? false
  const meta = holderData?.metas[assetId]
  const decimals = meta?.decimals ?? 0
  const ticker = meta?.ticker
  // Derived synchronously from the cached overlay admin state: no wallet scan,
  // no effect, no local state, so switching assets can never show the previous
  // asset's figure. The overlay folds frozen owners to lowercase hex.
  const frozenUnits = frozenUnitsFor(state, identityKey?.toLowerCase() ?? null)

  if (!isPaused && frozenUnits === 0n) return null

  return (
    <div className="space-y-2">
      {isPaused && (
        <div className="flex items-start gap-3 rounded-md bg-warning/10 px-4 py-3 text-[13px] text-warning">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Transfers temporarily disabled by the issuer.</span>
        </div>
      )}
      {frozenUnits > 0n && (
        <div className="flex items-start gap-3 rounded-md bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {formatCurrency(frozenUnits, decimals, ticker)} of your balance has been frozen.
            Please contact support to dispute.
          </span>
        </div>
      )}
    </div>
  )
}

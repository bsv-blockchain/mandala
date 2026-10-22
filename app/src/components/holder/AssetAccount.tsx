import { useState } from 'react'
import { ArrowLeft, Send, Download, Clock } from 'lucide-react'
import { Button } from '../ui/button'
import { formatCurrency } from '../../lib/mandala/amountDisplay'
import { useHolderData } from '../../hooks/useHolderData'
import AlertBanners from './AlertBanners'
import ReceivePanel from './ReceivePanel'
import TransactionHistory from './TransactionHistory'
import SendTokens from '../SendTokens'
import { cn } from '@/lib/utils'

type Tab = 'send' | 'receive' | 'history'

interface Props {
  assetId: string
  /** Exact units, as selected from the holder view. */
  balance: bigint
  decimals?: number
  ticker?: string
  label?: string
  onBack: () => void
}

export default function AssetAccount({ assetId, balance, decimals: decimalsProp = 0, ticker: tickerProp, label, onBack }: Props) {
  const [tab, setTab] = useState<Tab>('send')
  // Cached metadata (shared query) wins over props once resolved.
  const { data } = useHolderData()
  const meta = data?.metas[assetId]
  const decimals = meta?.decimals ?? decimalsProp
  const ticker = meta?.ticker ?? tickerProp
  // The live holder row wins over the balance captured at selection time, so a
  // refetch after a send or receive never leaves a stale header. A row whose
  // balance view failed shows "—" rather than the old figure.
  const row = data?.assets.find(a => a.assetId === assetId)
  const current = row != null ? row.balance : balance

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 px-1">
        <Button variant="ghost" size="sm" onClick={onBack} className="h-9 w-9 shrink-0 p-0">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
            {label ?? `${assetId.slice(0, 10)}…`}
          </h2>
          <p className="tabular text-[13px] text-muted-foreground">
            {current === null ? '— · Balance unavailable' : formatCurrency(current, decimals, ticker)}
          </p>
        </div>
      </div>

      {/* Alert banners */}
      <AlertBanners assetId={assetId} />

      {/* Tab bar */}
      <div className="flex rounded-lg bg-muted p-1">
        {([
          { key: 'send', icon: Send, label: 'Send' },
          { key: 'receive', icon: Download, label: 'Receive' },
          { key: 'history', icon: Clock, label: 'History' }
        ] as const).map(({ key, icon: Icon, label: tabLabel }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-2 text-[13px] font-medium transition-colors',
              tab === key
                ? 'bg-card text-foreground shadow-[var(--shadow-card)]'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {tabLabel}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'send' && <SendTokens lockedAssetId={assetId} />}
      {tab === 'receive' && <ReceivePanel />}
      {tab === 'history' && (
        <TransactionHistory assetId={assetId} decimals={decimals} ticker={ticker} />
      )}
    </div>
  )
}

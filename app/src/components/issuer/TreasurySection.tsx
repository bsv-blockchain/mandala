import { useState } from 'react'
import { ArrowUpRight, ArrowDownLeft } from 'lucide-react'
import { useWallet } from '../../context/WalletContext'
import type { AdminAsset } from '@bsv/mandala/assets'
import { formatCurrency } from '../../lib/mandala/amountDisplay'
import { decimalsOf } from '../../lib/mandala/loadHolderData'
import { useTreasuryBalances } from '../../hooks/useTreasuryBalances'
import SendTokens from '../SendTokens'
import ReceivePanel from '../holder/ReceivePanel'
import { cn } from '@/lib/utils'

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  assetId: string
  asset: AdminAsset | null
}

// ── TreasurySection ───────────────────────────────────────────────────────────

type Tab = 'send' | 'receive'

export default function TreasurySection({ assetId, asset }: Props) {
  const { identityKey } = useWallet()
  const [tab, setTab] = useState<Tab>('send')

  const ticker = typeof asset?.metadata?.ticker === 'string' ? asset.metadata.ticker : undefined
  const decimals = decimalsOf(asset?.metadata?.decimals)

  // ── Treasury units for this asset (TREASURY_BASKET, exact bigint) — the
  //    shared treasury cache, so navigating here renders instantly with a
  //    background refetch. The issuer's own `p color` holdings are not the
  //    treasury and are not shown here. An asset with no treasury outputs is
  //    absent from the sums: that is zero, not "unavailable". ────────────────

  const { data: treasury } = useTreasuryBalances()
  const balance: bigint | undefined = treasury == null || !assetId
    ? undefined
    : treasury[assetId] ?? 0n
  // Skeleton only while the query has no cached data yet.
  const loading = balance === undefined

  // ── Balance card ────────────────────────────────────────────────────────────

  const keyAbbr = identityKey != null
    ? `${identityKey.slice(0, 8)}…${identityKey.slice(-4)}`
    : '—'

  const formattedBalance = balance !== undefined
    ? formatCurrency(balance, decimals, ticker)
    : '—'

  const isEmpty = balance === 0n

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-[26px]">
      {/* Section header */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground mb-[3px]">
          Treasury
        </div>
        <div className="text-[22px] font-semibold leading-snug">
          {asset?.label ?? 'Asset'} Holdings
        </div>
      </div>

      {/* Balance card */}
      <div className="rounded-lg border border-separator bg-card px-[24px] py-[20px] shadow-[var(--shadow-card)]">
        <div className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground mb-[10px]">
          Treasury balance
        </div>
        {loading ? (
          <div className="animate-pulse h-[44px] w-[180px] rounded-sm bg-muted" />
        ) : (
          <div
            className={cn(
              'tabular text-[44px] font-semibold leading-none tracking-[-1.5px]',
              isEmpty ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {formattedBalance}
          </div>
        )}
        <div className="mt-[10px] text-[12px] text-subtle-foreground">
          Treasury of this issuer
          {identityKey != null && (
            <> &middot; <span className="tabular font-mono">{keyAbbr}</span></>
          )}
        </div>
      </div>

      {/* Empty state hint */}
      {!loading && isEmpty && (
        <div className="rounded-md border border-dashed border-separator bg-muted/50 px-[20px] py-[18px] text-center">
          <div className="text-[14px] font-medium text-muted-foreground">
            No units held — issue some in Operations.
          </div>
        </div>
      )}

      {/* Payout / Receive toggle — always accessible even with zero treasury (issuer might receive) */}
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground mb-[14px]">
          Actions
        </div>
        {/* Tab bar */}
        <div className="inline-flex rounded border border-separator bg-muted p-[3px] gap-[3px] mb-[22px]">
          {(['send', 'receive'] as const).map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'flex items-center gap-[7px] rounded px-[14px] py-[7px] text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === t
                  ? 'bg-card text-foreground font-semibold shadow-[0_1px_2px_var(--separator)]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t === 'send'
                ? <ArrowUpRight className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />
                : <ArrowDownLeft className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />}
              {t === 'send' ? 'Pay out' : 'Receive'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'send' && (
          <SendTokens lockedAssetId={assetId} mode="payout" />
        )}
        {tab === 'receive' && (
          <div className="rounded-lg border border-separator bg-card px-[24px] py-[20px] shadow-[var(--shadow-card)]">
            <p className="mb-[14px] text-[12px] text-subtle-foreground">
              Tokens sent to this identity arrive in the wallet's 1Color balance, not the treasury.
            </p>
            <ReceivePanel />
          </div>
        )}
      </div>
    </div>
  )
}

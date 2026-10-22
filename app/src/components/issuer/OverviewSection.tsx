import { useMemo } from 'react'
import { RefreshCw } from 'lucide-react'
import { AdminAsset } from '@bsv/mandala/assets'
import { AssetAdminStateView } from '@bsv/mandala/adminState'
import { reconcile } from '@bsv/mandala/banking'
import { useAssetState, useInvalidateAssetState } from '../../hooks/useAssetState'
import { useAdminSummary, useInvalidateAdminHistory } from '../../hooks/useAdminHistory'
import { useMockTransfers } from '../../lib/mandala/mockBankStore'
import { displayAmount, reserveRatioPct } from '../../lib/mandala/amountDisplay'
import { decimalsOf } from '../../lib/mandala/loadHolderData'
import { cn } from '@/lib/utils'
import AuditLog from './AuditLog'

interface Props {
  assetId: string
  asset: AdminAsset | null
  onReload?: () => void
}

// ── Stat tile ──────────────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string
  value: string
  sub: string
  valueColor?: string
}) {
  return (
    <div className="flex-1 rounded-md border border-border bg-card px-4 py-[15px]">
      <div className="text-[11px] leading-none text-subtle-foreground">{label}</div>
      <div
        className={cn(
          'mt-[10px] text-[24px] font-semibold leading-none tracking-[-0.3px]',
          valueColor ?? 'text-foreground'
        )}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </div>
      <div className="mt-[6px] text-[10.5px] leading-none text-faint-foreground">{sub}</div>
    </div>
  )
}

// ── Status / reserve pill ──────────────────────────────────────────────────────

function StatusPill({ state }: { state: AssetAdminStateView | null }) {
  if (state === null) {
    return (
      <span className="inline-flex items-center gap-[5px] rounded-full bg-muted px-[10px] py-[5px] text-[11.5px] font-medium text-muted-foreground">
        <span className="h-[6px] w-[6px] rounded-full bg-muted-foreground" />
        Unavailable
      </span>
    )
  }
  return state.isPaused ? (
    <span className="inline-flex items-center gap-[5px] rounded-full bg-warning/14 px-[10px] py-[5px] text-[11.5px] font-medium text-warning">
      <span className="h-[6px] w-[6px] rounded-full bg-warning" />
      Paused
    </span>
  ) : (
    <span className="inline-flex items-center gap-[5px] rounded-full bg-success/12 px-[10px] py-[5px] text-[11.5px] font-medium text-success">
      <span className="h-[6px] w-[6px] rounded-full bg-success" />
      Active
    </span>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OverviewSection({ assetId, asset, onReload }: Props) {
  // Shared with the Banking page's demo transfer feed (mockBankStore) — the
  // ratio must reflect real added transfers, scoped to this asset, never a
  // separate fabricated number.
  const transfers = useMockTransfers(assetId)

  const decimals = decimalsOf(asset?.metadata?.decimals)

  const stateQuery = useAssetState(assetId)
  // Whole-history issue/redeem totals come pre-aggregated from the overlay —
  // the client never sums (or downloads) thousands of history rows for KPIs.
  const summaryQuery = useAdminSummary(assetId)
  const invalidateAssetState = useInvalidateAssetState()
  const invalidateAdminHistory = useInvalidateAdminHistory()

  const state: AssetAdminStateView | null = stateQuery.data ?? null
  const summary = summaryQuery.data
  // Skeleton only while the queries have no data yet — background refetches
  // keep showing cached values.
  const loading = assetId !== '' && (stateQuery.data === undefined || summary === undefined)
  const refetching = stateQuery.isFetching || summaryQuery.isFetching

  // Exact bigint supply math; the only Number is the final percentage
  // (reserveRatioPct, integer basis points on bigints, clamped 0..100).
  const { inCirculation, netIssued, ratioPct } = useMemo((): { inCirculation: bigint, netIssued: bigint, ratioPct: number | null } => {
    if (summary == null) return { inCirculation: 0n, netIssued: 0n, ratioPct: null }
    const circulation = summary.totalIssued - summary.totalRedeemed

    const recon = reconcile({
      deposits: transfers.filter(t => t.direction === 'in').map(t => t.amount),
      withdrawals: transfers.filter(t => t.direction === 'out').map(t => t.amount),
      issued: summary.totalIssued,
      redeemed: summary.totalRedeemed,
    })
    return { inCirculation: circulation, netIssued: circulation, ratioPct: reserveRatioPct(recon.bankBalance, circulation) }
  }, [summary, transfers])

  // Restrictions tile: read from assetAdminState
  const isAllowlist = state?.accessMode === 'allowlist'
  const identityCount = isAllowlist
    ? state?.allowedIdentities.length ?? 0
    : state?.blockedIdentities.length ?? 0
  const frozenCount = state?.frozenOutpoints.length ?? 0
  // Warn when identities are blocked, outputs frozen, or allowlist is empty (all transfers blocked)
  const restrictionsWarn = frozenCount > 0 || (isAllowlist ? identityCount === 0 : identityCount > 0)

  // Reserve ratio display
  const reserveValue =
    ratioPct == null
      ? '—'
      : `${ratioPct.toFixed(1)}%`
  const reserveColor = ratioPct != null && ratioPct < 100 ? 'text-warning' : undefined

  const ticker = String(asset?.metadata?.ticker ?? asset?.label?.slice(0, 3) ?? '').toUpperCase()

  return (
    <div>
      {/* ── Page title row ── */}
      <div className="flex items-start justify-between mb-[22px]">
        <div>
          <h1 className="text-[27px] font-semibold leading-none tracking-[-0.5px]">Overview</h1>
          <div className="mt-2 text-[13px] text-subtle-foreground">
            {asset != null
              ? `${asset.label}${ticker ? ` (${ticker})` : ''} stablecoin · live state & admin history`
              : 'Live state & admin history'}
          </div>
        </div>
        <div className="flex items-center gap-[10px]">
          <StatusPill state={state} />
          <button
            type="button"
            onClick={() => {
              onReload?.()
              void invalidateAssetState(assetId)
              void invalidateAdminHistory(assetId)
            }}
            className="flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className={cn('h-4 w-4', refetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* ── 4 KPI tiles ── */}
      <div className="flex gap-[14px]">
        <StatTile
          label="In circulation"
          value={loading ? '…' : assetId === '' ? '—' : displayAmount(inCirculation, decimals)}
          sub={ticker ? ticker : 'issued − redeemed'}
        />
        <StatTile
          label="Net issued"
          value={
            loading
              ? '…'
              : assetId === ''
              ? '—'
              : (netIssued >= 0n ? '+' : '') + displayAmount(netIssued, decimals)
          }
          sub="all history"
          valueColor={netIssued > 0n ? 'text-success' : undefined}
        />
        <StatTile
          label="Reserve ratio (demo)"
          value={loading ? '…' : reserveValue}
          sub="bank ↔ supply"
          valueColor={reserveColor}
        />
        <StatTile
          label="Restrictions"
          value={loading ? '…' : assetId === '' ? '—' : `${identityCount} · ${frozenCount}`}
          sub={isAllowlist ? 'allowed · frozen' : 'blocked · frozen'}
          valueColor={restrictionsWarn ? 'text-warning' : undefined}
        />
      </div>

      {/* ── Audit log as the default dashboard ── */}
      <div className="mt-[28px]">
        <div className="mb-[14px]">
          <div className="text-[11px] font-medium tracking-[1.2px] text-subtle-foreground uppercase">
            Admin history
          </div>
        </div>
        <AuditLog assetId={assetId} decimals={decimals} />
      </div>
    </div>
  )
}

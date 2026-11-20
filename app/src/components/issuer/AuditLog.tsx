import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Select } from '../ui/select'
import { Spinner } from '../ui/spinner'
import { AdminAsset } from '@bsv/mandala/assets'
import { describeAction, exportAdminHistoryCsv, resolveAdminHistory, AdminHistoryRow } from '@bsv/mandala/adminHistory'
import { useAdminHistoryPages } from '../../hooks/useAdminHistory'
import { displayAmount } from '../../lib/mandala/amountDisplay'
import { decimalsOf } from '../../lib/mandala/decimals'

interface Props {
  assets?: AdminAsset[]
  /** Controlled mode: when set, use this assetId and suppress the internal asset selector. */
  assetId?: string
  /** Asset `dec` for the supply-change column; standalone mode reads it from `assets`. */
  decimals?: number
}

/** Signed display of a row's exact supply change; `null` for actions that move no supply. */
function deltaText (delta: bigint, decimals: number): string | null {
  if (delta === 0n) return null
  return `${delta < 0n ? '−' : '+'}${displayAmount(delta < 0n ? -delta : delta, decimals)}`
}

/** Fixed row height for virtualization — rows clamp their text to one line. */
const ROW_HEIGHT = 48

export default function AuditLog({ assets = [], assetId: controlledAssetId, decimals: decimalsProp }: Props) {
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [exporting, setExporting] = useState(false)

  // In controlled mode the active asset is the prop; otherwise use internal state
  const activeAssetId = controlledAssetId ?? selectedAssetId
  const decimals = decimalsOf(decimalsProp ?? assets.find(a => a.assetId === activeAssetId)?.metadata?.decimals)

  // Paged newest-first history — thousands of actions stream in pages instead
  // of one unbounded response; rows render through a virtualized list.
  const {
    rows, data, isFetching, refetch,
    hasNextPage, isFetchingNextPage, fetchNextPage
  } = useAdminHistoryPages(activeAssetId)
  // Skeleton only while the query has no cached data yet.
  const loading = activeAssetId !== '' && data == null

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })
  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return
    if (rows.length - lastIndex <= 20) void fetchNextPage()
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  // Export always covers the FULL history (separate un-paged fetch), not just
  // the pages scrolled into view so far.
  const handleExport = async () => {
    setExporting(true)
    try {
      const all: AdminHistoryRow[] = await resolveAdminHistory(activeAssetId)
      const csv = exportAdminHistoryCsv(all)
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const label = assets.find(a => a.assetId === activeAssetId)?.label ?? activeAssetId
      a.download = `audit-log-${label.replace(/\s+/g, '-')}-${Date.now()}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      {/* Page heading — only shown in standalone (uncontrolled) mode */}
      {controlledAssetId == null && (
        <div className="mb-[18px]">
          <h1 className="text-[27px] font-semibold tracking-[-0.5px] leading-tight">Audit log</h1>
          <p className="text-[13px] text-muted-foreground mt-[3px]">Full admin action history per asset</p>
        </div>
      )}

      {/* Controls row */}
      <div className="flex items-center gap-[10px] flex-wrap mb-[18px]">
        {/* Asset selector — suppressed in controlled mode */}
        {controlledAssetId == null && (
          <Select
            id="al-asset"
            value={selectedAssetId}
            onChange={e => setSelectedAssetId(e.target.value)}
            className="w-auto text-[13px] rounded-full px-3 py-1.5 h-auto"
          >
            <option value="">Select asset…</option>
            {assets.map(a => (
              <option key={a.assetId} value={a.assetId}>{a.label}</option>
            ))}
          </Select>
        )}

        <button
          className="grid place-items-center w-9 h-9 rounded bg-card border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void refetch()}
          title="Refresh"
        >
          <RefreshCw size={15} className={isFetching && !isFetchingNextPage ? 'animate-spin' : ''} />
        </button>

        {rows.length > 0 && (
          <button
            className="flex items-center gap-[7px] bg-card border border-border rounded px-[14px] py-[9px] text-[12.5px] font-semibold text-primary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? <Spinner size="sm" tone="current" /> : <Download size={14} />}
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        )}
      </div>

      {/* States */}
      {activeAssetId !== '' && loading && (
        <p className="text-[13px] text-muted-foreground animate-pulse">Loading history…</p>
      )}
      {activeAssetId !== '' && !loading && rows.length === 0 && (
        <p className="text-[13px] text-muted-foreground">No admin actions recorded yet.</p>
      )}

      {/* Virtualized rows card */}
      {rows.length > 0 && (
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <div ref={scrollRef} className="max-h-[520px] overflow-y-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map(vi => {
                const row = rows[vi.index]
                const delta = deltaText(row.delta, decimals)
                return (
                  <div
                    key={`${row.txid}-${row.outputIndex}-${vi.index}`}
                    className="absolute left-0 top-0 flex w-full items-center gap-3 px-[18px] border-b border-separator"
                    style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
                  >
                    {/* Kind badge */}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold shrink-0">
                      {row.actionDetails.kind}
                    </span>
                    {/* Description */}
                    <span className="flex-1 min-w-0 truncate text-[13px] text-foreground">
                      {describeAction(row.actionDetails, row.delta)}
                    </span>
                    {/* Supply change (exact, in display units) */}
                    {delta != null && (
                      <span className={`text-[12.5px] font-semibold tabular-nums shrink-0 ${row.delta < 0n ? 'text-warning' : 'text-success'}`}>
                        {delta}
                      </span>
                    )}
                    {/* Block height */}
                    <span className="text-[12px] text-subtle-foreground tabular-nums shrink-0">
                      {row.height > 0 ? row.height : '—'}
                    </span>
                    {/* Txid link */}
                    <a
                      href={`https://whatsonchain.com/tx/${row.txid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-subtle-foreground underline-offset-2 hover:underline font-mono shrink-0"
                      title={row.txid}
                    >
                      {row.txid.slice(0, 10)}…
                    </a>
                  </div>
                )
              })}
            </div>
            {isFetchingNextPage && (
              <div className="flex items-center justify-center gap-2 py-3 text-[12px] text-muted-foreground">
                <Spinner size="sm" tone="brand" />
                Loading more…
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

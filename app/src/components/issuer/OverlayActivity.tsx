import { useEffect, useRef } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useWallet } from '../../context/WalletContext'
import { useOverlayActivity } from '../../hooks/useOverlayActivity'
import { ActivityEntry, ActivityKind } from '@bsv/mandala/overlayActivity'
import { displayAmount } from '../../lib/mandala/amountDisplay'
import { decimalsOf } from '../../lib/mandala/loadHolderData'
import { CounterpartyDisplay } from '../CounterpartyDisplay'
import { Spinner } from '../ui/spinner'
import { cn } from '@/lib/utils'

interface Props {
  assetId: string
  decimals: number
  /** Standalone page mode: renders the page heading row (sidebar navigation). */
  standalone?: boolean
}

const KIND_LABEL: Record<ActivityKind, string> = {
  issue: 'Issued',
  transfer: 'Transfer',
  self: 'Self',
  redeem: 'Redeemed'
}

/** Fixed row height — required for smooth virtualization of thousands of rows. */
const ROW_HEIGHT = 60
/** Grid template shared by the header and every row. */
const COLS = 'grid grid-cols-[1.1fr_1fr_1fr_110px_110px] items-center'

function KindChip ({ kind }: { kind: ActivityKind }) {
  return (
    <span className={cn(
      'rounded-full px-2 py-0.5 text-[11px] font-semibold',
      kind === 'issue' && 'bg-success/10 text-success',
      kind === 'redeem' && 'bg-warning/10 text-warning',
      kind === 'transfer' && 'bg-primary/10 text-primary',
      kind === 'self' && 'bg-muted text-muted-foreground'
    )}>
      {KIND_LABEL[kind]}
    </span>
  )
}

function AmountCell ({ e, decimals }: { e: ActivityEntry, decimals: number }) {
  // Net units moved, exact bigint. The kind carries the sign (issue +,
  // redeem −); a negative wire amount keeps its own sign instead of a doubled one.
  const neg = e.amount < 0n
  const abs = neg ? -e.amount : e.amount
  const sign = neg || e.kind === 'redeem' ? '−' : e.kind === 'issue' ? '+' : ''
  if (e.kind === 'self') {
    return <span className="tabular text-[14px] font-semibold text-muted-foreground">0</span>
  }
  return (
    <span className={cn(
      'tabular text-[14px] font-semibold',
      e.kind === 'issue' && 'text-success',
      e.kind === 'redeem' && 'text-warning',
      e.kind === 'transfer' && 'text-foreground'
    )}>
      {sign}{displayAmount(abs, decimals)}
    </span>
  )
}

/**
 * Overlay-wide transaction feed — every admitted transaction, with sender and
 * recipient identities proven by revealSpecificKeyLinkage. This page exists
 * to show what the overlay operator has oversight of: not just its own
 * wallet's history, but every party to every movement of the asset.
 *
 * Built for thousands of transactions: the overlay serves cursor-paginated
 * pages and the list virtualizes rows (only the visible slice is in the DOM),
 * fetching the next page as the scroll approaches the end.
 */
export default function OverlayActivity ({ assetId, decimals: decimalsProp, standalone = false }: Props) {
  // Clamp to the BRC-162 range (0..18): an out-of-range dec would make the
  // exact formatter throw and blank the page.
  const decimals = decimalsOf(decimalsProp)
  const { wallet } = useWallet()
  const {
    entries, data, isFetching, isError, refetch,
    hasNextPage, isFetchingNextPage, fetchNextPage
  } = useOverlayActivity(assetId)
  const loading = assetId !== '' && data == null && !isError

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10
  })

  // Infinite scroll: when the last rendered row is near the end of the loaded
  // list, pull the next page.
  const items = virtualizer.getVirtualItems()
  const lastIndex = items.at(-1)?.index ?? 0
  useEffect(() => {
    if (!hasNextPage || isFetchingNextPage) return
    if (entries.length - lastIndex <= 20) void fetchNextPage()
  }, [lastIndex, entries.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <div>
      {standalone && (
        <div className="mb-[18px]">
          <h1 className="text-[27px] font-semibold tracking-[-0.5px] leading-tight">Activity</h1>
          <p className="text-[13px] text-muted-foreground mt-[3px]">
            Overlay-wide transaction feed — operator oversight
          </p>
        </div>
      )}
      <div className="flex items-start justify-between gap-3 mb-[14px]">
        <p className="text-[13px] text-muted-foreground max-w-[560px]">
          Every transaction admitted by the overlay for this asset. Counterparty
          identities are proven by key linkage revealed to the operator at
          submission — sender and recipient, not just your own transfers.
        </p>
        <button
          className="grid place-items-center w-9 h-9 shrink-0 rounded bg-card border border-border text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void refetch()}
          title="Refresh"
        >
          <RefreshCw size={15} className={isFetching && !isFetchingNextPage ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <Spinner size="md" tone="brand" />
          Loading overlay activity…
        </div>
      )}

      {isError && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          Could not reach the overlay activity endpoint.
        </div>
      )}

      {!loading && !isError && entries.length === 0 && (
        <div className="rounded-md border border-separator bg-card px-[18px] py-[26px] text-center text-[13px] text-muted-foreground">
          No transactions admitted yet — issue or transfer some units to see them here.
        </div>
      )}

      {entries.length > 0 && (
        <div className="overflow-hidden rounded-md border border-separator bg-card">
          {/* Header (outside the scroll container so it stays put) */}
          <div className={cn(COLS, 'border-b border-separator bg-muted/40')}>
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">Type</div>
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">From</div>
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">To</div>
            <div className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">Units</div>
            <div className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">Proof</div>
          </div>

          {/* Virtualized rows */}
          <div ref={scrollRef} className="max-h-[560px] overflow-y-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {items.map(vi => {
                const e = entries[vi.index]
                return (
                  <div
                    key={e.txid}
                    className={cn(COLS, 'absolute left-0 top-0 w-full border-b border-separator transition-colors hover:bg-muted/40')}
                    style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
                  >
                    <div className="px-3 min-w-0">
                      <div className="flex flex-col gap-1">
                        <span><KindChip kind={e.kind} /></span>
                        <a
                          href={`https://whatsonchain.com/tx/${e.txid}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[11px] text-subtle-foreground truncate hover:text-primary hover:underline"
                          title={e.txid}
                        >
                          {e.txid.slice(0, 10)}…
                        </a>
                      </div>
                    </div>
                    <div className="px-3 text-[12px] min-w-0 truncate">
                      {e.from != null
                        ? <CounterpartyDisplay identityKey={e.from} wallet={wallet} />
                        : <span className="text-subtle-foreground">Minted</span>}
                    </div>
                    <div className="px-3 text-[12px] min-w-0 truncate">
                      {e.kind === 'self'
                        ? <span className="text-subtle-foreground">Self</span>
                        : e.to != null
                          ? <CounterpartyDisplay identityKey={e.to} wallet={wallet} />
                          : <span className="text-subtle-foreground">Burned</span>}
                    </div>
                    <div className="px-3 text-right">
                      <AmountCell e={e} decimals={decimals} />
                    </div>
                    <div className="px-3 text-right">
                      <span
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-success"
                        title={e.proofs.map(p => `output ${p.outputIndex}: keyID ${p.keyID}`).join('\n')}
                      >
                        <ShieldCheck size={13} />
                        {e.proofs.length} linkage
                      </span>
                    </div>
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

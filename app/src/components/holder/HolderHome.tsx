/**
 * HolderHome — Meridian single-account neobank layout.
 *
 * Sections (top → bottom):
 *   1. Brand row  — BrandMark + currency switcher chip (corner) + notification bell + avatar chip
 *   2. Hero       — labelled balance for CURRENT account
 *   3. Quick actions — Send | Contacts | Receive (wired to real tabs via onAction)
 *   4. RECENT activity — last 4 history rows for CURRENT account
 *
 * Currency switcher: a compact "$ USD ▾" chip in the top-right area; when >1 currency
 * it is a dropdown to change which account is shown; when 1, a static chip.
 * The accounts list is replaced by the switcher.
 *
 * Trend pill: omitted (no reliable wall-clock timestamps — honest).
 *
 * All data is real wallet data (no mocks).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ArrowDownLeft, ArrowUpRight, Bell, Send, Download, Users, RefreshCw, ChevronDown } from 'lucide-react'
import { HistoryRow } from '@bsv/mandala/history'
import { currencySymbol, displayAmount } from '../../lib/mandala/amountDisplay'
import { holderLines } from '../../lib/mandala/holderLines'
import { useHolderData } from '../../hooks/useHolderData'
import { useWallet } from '../../context/WalletContext'
import { CounterpartyDisplay } from '../CounterpartyDisplay'
import { BrandMark } from '../ui/BrandMark'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Currency badge colour map (matches comp: USD=brass, EUR=navy-tint, GBP=lavender,
// CHF=sage; all others use a neutral brass chip)
// ---------------------------------------------------------------------------

const CURRENCY_BADGE: Record<string, { bg: string; text: string; symbol: string }> = {
  USD:  { bg: 'bg-accent',      text: 'text-accent-foreground', symbol: '$'   },
  EUR:  { bg: 'bg-navy-tint',   text: 'text-primary',           symbol: '€'   },
  GBP:  { bg: 'bg-[#E3DCEA]',   text: 'text-[#5B4B7A]',         symbol: '£'   },
  CHF:  { bg: 'bg-[#E1E7DE]',   text: 'text-[#4B6B4E]',         symbol: 'Fr'  },
}

function badgeFor(ticker?: string): { bg: string; text: string; symbol: string } {
  if (ticker) {
    const upper = ticker.toUpperCase()
    if (CURRENCY_BADGE[upper]) return CURRENCY_BADGE[upper]
  }
  // Fallback: neutral brass chip with first letter of ticker or '?'
  return {
    bg: 'bg-accent',
    text: 'text-accent-foreground',
    symbol: ticker ? ticker.slice(0, 2).toUpperCase() : '?',
  }
}

// ---------------------------------------------------------------------------
// Relative time helper (no external dep)
// ---------------------------------------------------------------------------

function relativeTime(when: number): string {
  if (when === 0) return ''
  const diff = Date.now() - when
  const days = Math.floor(diff / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Counterparty display
// ---------------------------------------------------------------------------

function shortCounterparty(cp: string): string {
  if (cp.length <= 14) return cp
  return `${cp.slice(0, 12)}…`
}

/** Row title when there is no counterparty key to show (e.g. issuance). */
function directionLabel(direction: HistoryRow['direction']): string {
  switch (direction) {
    case 'issued': return 'Issued'
    case 'redeemed': return 'Redeemed'
    default: return '—'
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function QuickActionButton({
  icon,
  label,
  primary,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  primary?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 flex-col items-center gap-[7px] rounded-md py-[13px]',
        'text-[11.5px] font-medium leading-none transition-transform duration-150 ease-out active:scale-[0.97]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        primary
          ? 'bg-primary text-primary-foreground'
          : 'border border-border bg-card text-foreground'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function RecentRow({ row, decimals, ticker }: { row: HistoryRow; decimals: number; ticker?: string }) {
  const { wallet } = useWallet()
  const isCredit = row.direction === 'received' || row.direction === 'issued'
  // Optimistic rows carry a placeholder txid until the overlay-accepted tx
  // replaces them on the next refetch.
  const isPending = row.txid.startsWith('pending-')
  const symbol = currencySymbol(ticker)
  const formatted = `${isCredit ? '+' : '−'}${symbol}${displayAmount(row.amount, decimals)}`
  const cp = row.counterparty !== '' ? shortCounterparty(row.counterparty) : directionLabel(row.direction)
  const when = isPending ? 'Sending…' : relativeTime(row.when)

  return (
    <div className={cn('flex items-center gap-[12px] border-t border-separator py-[9px]', isPending && 'opacity-60')}>
      {/* Direction icon — inbound (positive) points down-left, outbound
          (negative) points up-right (app-wide convention). */}
      <div
        className={cn(
          'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full',
          isCredit ? 'bg-success/12 text-success' : 'bg-foreground/6 text-subtle-foreground'
        )}
        aria-hidden="true"
      >
        {isCredit
          ? <ArrowDownLeft size={15} strokeWidth={2} />
          : <ArrowUpRight size={15} strokeWidth={2} />}
      </div>

      {/* Name + timestamp — resolved identity where known, truncated key otherwise */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-[1.2]">
          {row.counterparty !== ''
            ? <CounterpartyDisplay identityKey={row.counterparty} wallet={wallet} />
            : cp}
        </div>
        {when && (
          <div className="mt-[2px] text-[11px] leading-[1.2] text-subtle-foreground">{when}</div>
        )}
      </div>

      {/* Amount */}
      <div
        className={cn(
          'tabular text-[13.5px] font-medium leading-[1.2]',
          isCredit ? 'text-success' : 'text-foreground'
        )}
      >
        {formatted}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export type HolderAction = 'send' | 'contacts' | 'receive'

interface Props {
  onSelect: (assetId: string, balance: bigint) => void
  onAction?: (action: HolderAction, assetId?: string) => void
  identityKey?: string | null
}

export default function HolderHome({ onSelect: _onSelect, onAction, identityKey }: Props) {
  // Shared cached query — renders instantly on navigation, refetches behind.
  const { data, isFetching, refetch } = useHolderData()
  const assets = data?.assets ?? []
  const history = data?.history ?? []
  const firstLoad = data == null
  // currentAssetId lives in the URL (?asset=…) so a reload restores the selection.
  const [searchParams, setSearchParams] = useSearchParams()
  const currentAssetId = searchParams.get('asset') ?? ''
  const selectAsset = useCallback((assetId: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('asset', assetId)
      return next
    }) // push a history entry so Back returns to the previous account
  }, [setSearchParams])
  // switcher dropdown open state
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const switcherRef = useRef<HTMLDivElement>(null)


  // Avatar initials from identity key
  const initials = identityKey ? identityKey.slice(2, 4).toUpperCase() : '?'

  // Auto-select a default account (first non-zero) into ?asset when the URL has
  // no valid selection — writes with replace so it doesn't add a history entry.
  useEffect(() => {
    if (assets.length === 0) return
    const valid = currentAssetId !== '' && assets.some(a => a.assetId === currentAssetId)
    if (valid) return
    const def = assets.find(a => a.balance !== null && a.balance > 0n)?.assetId ?? assets[0]?.assetId
    if (def == null) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('asset', def)
      return next
    }, { replace: true })
  }, [assets, currentAssetId, setSearchParams])

  // Close switcher on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Current account row
  const currentAsset = assets.find(a => a.assetId === currentAssetId) ?? null

  // Recent: last 4 history rows for the current asset only
  const recentRows = history
    .filter(r => currentAsset && r.assetId === currentAsset.assetId)
    .slice(-4)
    .reverse()

  // ── Currency switcher chip label ──────────────────────────────────────────
  const switcherLabel = (() => {
    if (!currentAsset) return '—'
    const t = currentAsset.meta.ticker?.toUpperCase()
    if (!t) return currentAsset.meta.label.slice(0, 6)
    const sym = currencySymbol(t).trim()
    // Only prefix a real symbol ($, €…) — the fallback echoes the ticker,
    // which would render "FUN FUN".
    return sym !== '' && sym !== t ? `${sym} ${t}` : t
  })()

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col">
      {/* ── Brand row ── */}
      <div className="flex items-center justify-between px-[22px] pt-[8px]">
        <BrandMark wordmark size="sm" />

        <div className="flex items-center gap-[9px]">
          {/* Currency switcher chip — only rendered when there is actually
              something to switch between; the balance header already names
              the single asset. */}
          {assets.length > 1 && (
          <div className="relative" ref={switcherRef}>
            <button
              type="button"
              onClick={() => setSwitcherOpen(o => !o)}
              aria-label="Switch currency"
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
              className={cn(
                'flex items-center gap-[5px] rounded-full px-[10px] py-[5px]',
                'text-[12px] font-semibold leading-none',
                'border border-border bg-card text-foreground',
                'transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              {firstLoad ? (
                <RefreshCw className="h-[11px] w-[11px] animate-spin text-subtle-foreground" />
              ) : (
                switcherLabel
              )}
              <ChevronDown
                className={cn(
                  'h-[11px] w-[11px] text-subtle-foreground transition-transform duration-150',
                  switcherOpen && 'rotate-180'
                )}
                strokeWidth={2.2}
              />
            </button>

            {/* Dropdown */}
            {switcherOpen && (
              <div
                role="listbox"
                className={cn(
                  'absolute right-0 top-[calc(100%+6px)] z-50 min-w-[160px]',
                  'rounded-md border border-border bg-popover shadow-[var(--shadow-pop)]',
                  'overflow-hidden py-[6px]'
                )}
              >
                {assets.map(a => {
                  const badge = badgeFor(a.meta.ticker)
                  const isSelected = a.assetId === currentAssetId
                  return (
                    <button
                      key={a.assetId}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        selectAsset(a.assetId)
                        setSwitcherOpen(false)
                      }}
                      className={cn(
                        'flex w-full items-center gap-[10px] px-[13px] py-[9px]',
                        'text-left text-[13px] font-medium leading-none',
                        'transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isSelected && 'bg-muted/40'
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-sm',
                          'text-[11px] font-bold leading-none',
                          badge.bg,
                          badge.text
                        )}
                      >
                        {badge.symbol}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{a.meta.label}</div>
                        {a.meta.ticker && (
                          <div className="mt-[2px] text-[10.5px] text-subtle-foreground">
                            {a.meta.ticker.toUpperCase()}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <svg
                          width="13" height="13" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor"
                          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                          className="text-primary shrink-0"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          )}

          {/* Bell */}
          <button
            type="button"
            aria-label="Notifications"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bell className="h-[19px] w-[19px]" strokeWidth={1.7} />
          </button>

          {/* Avatar chip */}
          <div
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground"
            aria-label="Account"
          >
            {initials}
          </div>
        </div>
      </div>

      {/* ── Hero ── */}
      <div className="px-[26px] pt-[20px]">
        {/* Account label */}
        <p className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground leading-none">
          {currentAsset ? currentAsset.meta.label : 'Balance'}
        </p>

        {/* Big balance number */}
        {firstLoad ? (
          <div className="mt-[7px] h-12 w-44 animate-pulse rounded-full bg-muted" />
        ) : currentAsset ? (
          (() => {
            // hero is the `p color balance` view, which already contains the
            // unsettled part; incoming (pending) is outside it. Each line is
            // formatted on its own and never added to the hero (plan A6).
            const lines = holderLines(currentAsset, currentAsset.meta.decimals)
            if (currentAsset.balance === null) {
              return (
                <div className="mt-[7px]">
                  <div className="flex items-baseline">
                    <span className="text-[44px] font-semibold leading-none tracking-[-1.5px] text-subtle-foreground">
                      {lines.hero}
                    </span>
                  </div>
                  <p className="mt-[6px] text-[12px] leading-none text-subtle-foreground">Balance unavailable</p>
                  {lines.incoming && (
                    <p className="mt-[6px] tabular text-[12px] leading-none text-subtle-foreground">{lines.incoming}</p>
                  )}
                </div>
              )
            }
            const sym = currencySymbol(currentAsset.meta.ticker)
            const dotIdx = lines.hero.indexOf('.')
            const whole = dotIdx >= 0 ? lines.hero.slice(0, dotIdx) : lines.hero
            const frac = dotIdx >= 0 ? lines.hero.slice(dotIdx) : ''
            return (
              <div className="mt-[7px]">
                <div className="flex items-baseline gap-[2px]">
                  <span className="tabular text-[44px] font-semibold leading-none tracking-[-1.5px]">
                    {sym}{whole}
                  </span>
                  {frac && (
                    <span className="tabular text-[24px] font-semibold leading-none tracking-[-0.3px] text-subtle-foreground">
                      {frac}
                    </span>
                  )}
                </div>
                {lines.unsettled && (
                  <p className="mt-[6px] tabular text-[12px] leading-none text-subtle-foreground">{lines.unsettled}</p>
                )}
                {lines.incoming && (
                  <p className="mt-[6px] tabular text-[12px] leading-none text-subtle-foreground">{lines.incoming}</p>
                )}
              </div>
            )
          })()
        ) : (
          <div className="mt-[7px] flex items-baseline">
            <span className="text-[44px] font-semibold leading-none tracking-[-1.5px] text-subtle-foreground">—</span>
          </div>
        )}

        {/* Refresh affordance — replaces the old "across N accounts" text */}
        <div className="mt-[12px] flex items-center gap-[9px]">
          {/* Background refetch — never disabled, never blocks the view */}
          <button
            type="button"
            onClick={() => void refetch()}
            aria-label="Refresh"
            className="flex items-center gap-[5px] text-[12px] font-medium text-subtle-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <RefreshCw className={cn('h-[12px] w-[12px]', isFetching && 'animate-spin')} />
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Quick actions ── */}
      <div className="flex gap-[9px] px-[24px] pt-[22px]">
        <QuickActionButton
          primary
          onClick={() => onAction?.('send', currentAsset?.assetId)}
          label="Send"
          icon={
            <Send className="h-[18px] w-[18px]" strokeWidth={1.9} />
          }
        />
        <QuickActionButton
          onClick={() => onAction?.('contacts', currentAsset?.assetId)}
          label="Contacts"
          icon={
            <Users className="h-[18px] w-[18px]" strokeWidth={1.9} />
          }
        />
        <QuickActionButton
          onClick={() => onAction?.('receive', currentAsset?.assetId)}
          label="Receive"
          icon={
            <Download className="h-[18px] w-[18px]" strokeWidth={1.9} />
          }
        />
      </div>

      {/* ── Empty state ── */}
      {!firstLoad && assets.length === 0 && (
        <div className="px-[26px] pt-[24px]">
          <div className="border-t border-separator py-8 text-center text-[14px] text-muted-foreground">
            No tokens yet — tokens you receive will appear here.
          </div>
        </div>
      )}

      {/* ── Recent activity (scoped to current asset) ── */}
      {recentRows.length > 0 && (
        <div className="px-[26px] pt-[22px] pb-[24px]">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground leading-none">
              Recent
            </p>
          </div>

          {recentRows.map((row, i) => {
            const meta = currentAsset?.meta ?? { label: '…', decimals: 0 }
            return (
              <RecentRow
                key={`${row.txid}-${i}`}
                row={row}
                decimals={meta.decimals}
                ticker={meta.ticker}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

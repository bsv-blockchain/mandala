import { useCallback, useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, PlusCircle, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Select } from '../ui/select'
import { Input } from '../ui/input'
import { AdminAsset } from '@bsv/mandala/assets'
import { useAdminAssets } from '../../hooks/useAdminAssets'
import { useAdminSummary } from '../../hooks/useAdminHistory'
import { useWallet } from '../../context/WalletContext'
import { reconcile, makeTransfer, TransferDirection } from '@bsv/mandala/banking'
import { useMockTransfers, addMockTransfer, removeMockTransfer, clearMockTransfers } from '../../lib/mandala/mockBankStore'
import { displayAmount, safeParseAmount } from '../../lib/mandala/amountDisplay'
import { decimalsOf } from '../../lib/mandala/loadHolderData'

interface BankingMockProps {
  /** Controlled mode: when set, use this assetId and hide the header asset selector. */
  assetId?: string
}

/**
 * Demo bank feed + reserve reconciliation. Transfers here are fake (persisted
 * in localStorage, deletable/clearable); issuance happens on the Operations
 * page — this page only shows how the bank balance reconciles against
 * on-chain supply.
 */
export default function BankingMock({ assetId: controlledAssetId }: BankingMockProps = {}) {
  const { wallet } = useWallet()
  const { data: assetsData } = useAdminAssets()
  const assets: AdminAsset[] = assetsData ?? []
  const [selectedAssetId, setSelectedAssetId] = useState('')
  const [transferAmount, setTransferAmount] = useState('')
  const [direction, setDirection] = useState<TransferDirection>('in')

  // In controlled mode the active asset id comes from the prop
  const activeAssetId = controlledAssetId ?? selectedAssetId

  // Shared with the Overview reserve-ratio KPI (mockBankStore) so both reflect
  // the same per-asset feed; starts blank — nothing to reconcile until a
  // transfer is added, and switching assets switches the whole feed.
  const transfers = useMockTransfers(activeAssetId)

  const asset = assets.find(a => a.assetId === activeAssetId) ?? null
  const decimals = decimalsOf(asset?.metadata?.decimals)

  // Issue/redeem totals pre-aggregated on the overlay — reconciliation never
  // downloads the full admin history.
  const summaryQuery = useAdminSummary(wallet != null ? activeAssetId : '')
  const summary = summaryQuery.data

  const recon = useMemo((): ReturnType<typeof reconcile> | null => {
    if (summary == null) return null
    return reconcile({
      deposits: transfers.filter(t => t.direction === 'in').map(t => t.amount),
      withdrawals: transfers.filter(t => t.direction === 'out').map(t => t.amount),
      issued: summary.totalIssued,
      redeemed: summary.totalRedeemed
    })
  }, [summary, transfers])

  // Add a demo transfer — the counterparty is always a synthetic
  // "Company {letter}" (see makeTransfer); only amount + direction are admin-supplied.
  const handleAddTransfer = useCallback(() => {
    // Exact bigint parse: malformed, too many fractional digits, or above
    // MAX_UINT64 is refused (null), never rounded or wrapped.
    const amount = safeParseAmount(transferAmount, decimals)
    if (amount === null || amount <= 0n) {
      toast.error('Enter a valid amount')
      return
    }
    const t = makeTransfer(amount, direction, activeAssetId)
    addMockTransfer(t)
    setTransferAmount('')
    toast.success(`Added ${direction === 'in' ? 'incoming' : 'outgoing'} transfer: ${t.originator} · ${displayAmount(amount, decimals)}`)
  }, [transferAmount, decimals, direction, activeAssetId])

  const handleRemoveTransfer = useCallback((id: string) => {
    removeMockTransfer(id)
  }, [])

  const handleClearAll = useCallback(() => {
    clearMockTransfers(activeAssetId)
    toast.success('Cleared all demo transfers')
  }, [activeAssetId])

  return (
    <div>
      {/* Page heading row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[27px] font-semibold tracking-[-0.5px] leading-tight">Banking</h1>
          <p className="text-[13px] text-muted-foreground mt-[3px]">Demo deposit feed &amp; reserve reconciliation — issuance lives on Operations</p>
        </div>
        {controlledAssetId == null && (
          <Select
            id="bm-asset"
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
      </div>

      {/* SIMULATE A TRANSFER — the counterparty is always a synthetic "Company
          {letter}"; only amount + direction are admin-supplied. This is a
          sandbox feed standing in for a real bank connection, so it starts
          empty rather than pre-seeded with fake history. */}
      <p className="text-[11px] font-medium tracking-[1.2px] text-subtle-foreground uppercase mb-[10px] mt-[22px]">
        Simulate a Bank Transfer
      </p>
      <div className="bg-card border border-border rounded-md px-[18px] py-[15px] flex items-center gap-3">
        {/* Direction tab bar */}
        <div className="inline-flex rounded border border-separator bg-muted p-[3px] gap-[3px] flex-none">
          {(['in', 'out'] as const).map(d => (
            <button
              key={d}
              type="button"
              onClick={() => setDirection(d)}
              className={cn(
                'flex items-center gap-[6px] rounded px-3 py-[9px] text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                direction === d
                  ? 'bg-card text-foreground font-semibold shadow-[0_1px_2px_var(--separator)]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {d === 'in'
                ? <ArrowDownLeft className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />
                : <ArrowUpRight className="h-[15px] w-[15px] shrink-0" strokeWidth={2} />}
              {d === 'in' ? 'Incoming' : 'Outgoing'}
            </button>
          ))}
        </div>
        <Input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={transferAmount}
          onChange={e => setTransferAmount(e.target.value)}
          placeholder="Amount"
          className="flex-1"
          aria-label="Transfer amount"
        />
        <button
          onClick={handleAddTransfer}
          disabled={transferAmount.trim() === '' || activeAssetId === ''}
          className="flex items-center gap-2 whitespace-nowrap rounded bg-primary text-primary-foreground px-4 py-[11px] text-[13px] font-semibold disabled:opacity-50"
        >
          <PlusCircle size={16} />
          Add transfer
        </button>
      </div>

      {/* TRANSFERS */}
      <div className="flex items-center justify-between mb-[10px] mt-[22px]">
        <p className="text-[11px] font-medium tracking-[1.2px] text-subtle-foreground uppercase">
          Transfers
        </p>
        {transfers.length > 0 && (
          <button
            onClick={handleClearAll}
            className="flex items-center gap-[5px] text-[12px] font-medium text-subtle-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            <Trash2 size={13} />
            Clear all
          </button>
        )}
      </div>
      {transfers.length === 0 ? (
        <div className="bg-card border border-border rounded-md px-[18px] py-[26px] text-center text-[13px] text-muted-foreground">
          No transfers yet — add one above to see it flow through reconciliation.
        </div>
      ) : (
      <div className="bg-card border border-border rounded-md overflow-hidden">
        {transfers.map((t, idx) => {
          const dateStr = new Date(t.timestamp).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
          const isOut = t.direction === 'out'
          return (
            <div
              key={t.id}
              className={`flex items-center gap-[14px] px-[18px] py-[15px]${idx > 0 ? ' border-t border-separator' : ''}`}
            >
              {/* Icon */}
              <div className={cn(
                'w-10 h-10 rounded grid place-items-center flex-none',
                isOut ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'
              )}>
                {isOut ? <ArrowUpRight size={18} /> : <ArrowDownLeft size={18} />}
              </div>
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-semibold">{t.originator}</div>
                <div className="text-[11.5px] text-subtle-foreground mt-[3px]">
                  {t.id} · {dateStr}
                </div>
              </div>
              {/* Amount */}
              <span className={cn('text-[15px] font-semibold tabular-nums', isOut ? 'text-destructive' : 'text-success')}>
                {isOut ? '−' : '+'}{displayAmount(t.amount, decimals)}
              </span>
              {/* Delete */}
              <button
                onClick={() => handleRemoveTransfer(t.id)}
                aria-label={`Delete transfer ${t.id}`}
                className="flex-none text-subtle-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        })}
      </div>
      )}

      {/* RECONCILIATION */}
      {recon != null && (() => {
        const hasDrift = recon.drift !== 0n
        return (
          <>
            <p className="text-[11px] font-medium tracking-[1.2px] text-subtle-foreground uppercase mb-[10px] mt-[22px]">
              Reconciliation
            </p>
            <div className="bg-card border border-border rounded-md px-[18px] pt-[6px] pb-[14px]">
              {/* Bank balance */}
              <div className="flex justify-between items-center border-b border-separator py-3">
                <span className="text-[13px] text-muted-foreground">Bank balance</span>
                <span className="text-[14px] font-semibold tabular-nums">{displayAmount(recon.bankBalance, decimals)}</span>
              </div>
              {/* Net supply */}
              <div className="flex justify-between items-center border-b border-separator py-3">
                <span className="text-[13px] text-muted-foreground">Net supply · issued − redeemed</span>
                <span className="text-[14px] font-semibold tabular-nums">{displayAmount(recon.netSupply, decimals)}</span>
              </div>
              {/* Drift */}
              <div className={`flex justify-between items-center ${hasDrift ? 'py-3' : 'pt-3'} ${hasDrift ? 'text-warning' : 'text-success'}`}>
                <span className="text-[13px] font-semibold">Drift</span>
                <span className="text-[14px] font-semibold tabular-nums">
                  {recon.drift > 0n ? '+' : ''}{displayAmount(recon.drift, decimals)}
                </span>
              </div>
              {/* Amber callout — how to close the gap */}
              {hasDrift && (
                <div className="bg-warning/[0.08] rounded px-[13px] py-[10px] text-[11.5px] text-warning leading-[1.4]">
                  <span className="font-semibold">
                    {recon.drift > 0n
                      ? 'Bank reserves exceed on-chain supply — issue tokens from the Operations page to match.'
                      : 'On-chain supply exceeds bank reserves — redeem tokens from the Operations page (or add deposits) to match.'}
                  </span>
                </div>
              )}
              {/* Reconciled callout */}
              {!hasDrift && (
                <div className="text-success text-[11.5px] font-medium pt-1 pb-1">
                  Reconciled — 100%
                </div>
              )}
            </div>
          </>
        )
      })()}
    </div>
  )
}

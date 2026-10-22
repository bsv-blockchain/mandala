import { ArrowUpRight, ArrowDownLeft, Download } from 'lucide-react'
import { useWallet } from '../../context/WalletContext'
import { exportTransactionsCsv, HistoryRow } from '@bsv/mandala/history'
import { useHolderData } from '../../hooks/useHolderData'
import { formatCurrency } from '../../lib/mandala/amountDisplay'
import { CounterpartyDisplay } from '../CounterpartyDisplay'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'

interface Props {
  assetId: string
  decimals: number
  ticker?: string
}

function DirectionIcon({ direction }: { direction: HistoryRow['direction'] }) {
  const isSent = direction === 'sent' || direction === 'redeemed'
  return isSent
    ? <ArrowUpRight className="h-4 w-4 shrink-0 text-destructive" />
    : <ArrowDownLeft className="h-4 w-4 shrink-0 text-success" />
}

export default function TransactionHistory({ assetId, decimals, ticker }: Props) {
  const { wallet } = useWallet()
  // Shared cached query — renders instantly on navigation, refetches behind.
  const { data } = useHolderData()
  const rows = (data?.history ?? []).filter(r => r.assetId === assetId)
  const loading = data == null

  const handleExportCsv = () => {
    const csv = exportTransactionsCsv(rows)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transactions-${assetId.slice(0, 12)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
        <Spinner size="md" tone="brand" />
        Loading history…
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-[13px] text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'}
        </p>
        {rows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleExportCsv}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        )}
      </div>

      {rows.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <h3 className="text-[15px] font-semibold">No transactions yet</h3>
          <p className="max-w-xs text-[14px] leading-relaxed text-muted-foreground">
            Transfers and receipts for this asset will appear here.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-md border border-separator">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-separator bg-muted/40">
                <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">Type</th>
                <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">Counterparty</th>
                <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">Amount</th>
                <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.8px] text-subtle-foreground">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const isSent = row.direction === 'sent' || row.direction === 'redeemed'
                return (
                  <tr
                    key={`${row.txid}-${i}`}
                    className="border-b border-separator last:border-b-0 transition-colors hover:bg-muted/40"
                  >
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-2">
                        <DirectionIcon direction={row.direction} />
                        <span className="text-[13px] font-medium capitalize">{row.direction}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[12px]">
                      <CounterpartyDisplay identityKey={row.counterparty} wallet={wallet} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span className={`tabular text-[14px] font-semibold ${isSent ? 'text-destructive' : 'text-success'}`}>
                        {isSent ? '−' : '+'}{formatCurrency(row.amount, decimals, ticker)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[11px] text-subtle-foreground" title={row.txid}>
                      {row.txid.slice(0, 10)}…
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

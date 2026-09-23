import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useWallet } from '../../context/WalletContext'
import { useIssuerMutations } from '../../hooks/useIssuerMutations'
import { guardRegisterSubmit } from '@bsv/mandala/submitGuards'
import { registerFlight } from '@bsv/mandala/singleFlight'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'

export type FeeRateParse = { ok: true, value: number | undefined } | { ok: false, reason: string }

/**
 * Blank = leave issuer-paid fees disabled; otherwise a whole number ≥ 1
 * (token units per KB). The input is type="text" (see below), so this is the
 * only gate against a mistyped rate — `/^\d+$/` refuses anything `Number()`
 * would otherwise silently coerce (`'1e3'`, `'0x10'`, `'25-'`) into a rate
 * that looks like "off" was never intended.
 */
export function parseFeeRateInput (raw: string): FeeRateParse {
  const s = raw.trim()
  if (s === '') return { ok: true, value: undefined }
  const n = Number(s)
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < 1) {
    return { ok: false, reason: 'Fee rate must be a whole number ≥ 1 (units per KB)' }
  }
  return { ok: true, value: n }
}

/**
 * "Register a new asset" — the rare genesis action, kept as a slim dashed
 * strip on the Overview page (most issuers run a single stablecoin).
 */
export default function RegisterAssetStrip() {
  const { wallet } = useWallet()
  const [label, setLabel] = useState('')
  const [ticker, setTicker] = useState('')
  const [decimals, setDecimals] = useState('0')
  const [feeRate, setFeeRate] = useState('')
  const { register } = useIssuerMutations()
  const startedRef = useRef(false)

  const handleRegister = () => {
    if (startedRef.current || register.isPending || registerFlight.isHeld()) return
    const dec = Number(decimals)
    const gate = guardRegisterSubmit({
      label,
      ticker,
      decimals: dec,
      walletReady: wallet != null
    })
    if (!gate.ok) {
      toast.error(gate.reason)
      return
    }
    const fee = parseFeeRateInput(feeRate)
    if (!fee.ok) {
      toast.error(fee.reason)
      return
    }
    startedRef.current = true
    register.mutate({ label, ticker, decimals: dec, feeRatePerKb: fee.value }, {
      onSuccess: () => { setLabel(''); setTicker(''); setDecimals('0'); setFeeRate('') },
      onSettled: () => { startedRef.current = false }
    })
  }

  const labelCls = 'block text-[10px] font-medium text-subtle-foreground mb-[4px]'

  return (
    <div className="rounded border border-dashed border-input-border bg-muted px-[14px] py-[9px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="shrink-0">
          <p className="text-[12.5px] font-semibold leading-tight">Register a new asset</p>
          <p className="text-[10.5px] text-subtle-foreground mt-0.5 leading-tight">
            Rare — most issuers run a single stablecoin
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2 flex-1 justify-end">
          <div className="flex flex-col min-w-[100px]">
            <label className={labelCls} htmlFor="reg-label">Label</label>
            <Input
              id="reg-label"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Gold Coin"
              className="h-[30px] bg-input border-input-border rounded-sm px-[10px] py-0 text-[12px] placeholder:text-subtle-foreground"
            />
          </div>
          <div className="flex flex-col min-w-[64px]">
            <label className={labelCls} htmlFor="reg-ticker">Ticker</label>
            <Input
              id="reg-ticker"
              value={ticker}
              onChange={e => setTicker(e.target.value)}
              placeholder="USD"
              className="h-[30px] bg-input border-input-border rounded-sm px-[10px] py-0 text-[12px] placeholder:text-subtle-foreground"
            />
          </div>
          <div className="flex flex-col min-w-[56px]">
            <label className={labelCls} htmlFor="reg-decimals">Decimals</label>
            <Input
              id="reg-decimals"
              type="number"
              min="0"
              step="1"
              value={decimals}
              onChange={e => setDecimals(e.target.value)}
              placeholder="0"
              className="h-[30px] bg-input border-input-border rounded-sm px-[10px] py-0 text-[12px] placeholder:text-subtle-foreground tabular-nums"
            />
          </div>
          <div className="flex flex-col min-w-[96px]">
            <label className={labelCls} htmlFor="reg-fee-rate">Fee rate (units/KB)</label>
            <Input
              id="reg-fee-rate"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={feeRate}
              onChange={e => setFeeRate(e.target.value)}
              placeholder="off"
              className="h-[30px] bg-input border-input-border rounded-sm px-[10px] py-0 text-[12px] placeholder:text-subtle-foreground tabular-nums"
            />
          </div>
          <button
            type="button"
            onClick={handleRegister}
            disabled={register.isPending || label.trim() === ''}
            className="h-[30px] shrink-0 rounded-sm border border-input-border bg-card px-3 text-[12px] font-medium text-primary transition-[opacity,background-color] duration-150 hover:bg-accent disabled:opacity-40 flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {register.isPending && <Spinner size="sm" tone="current" />}
            {register.isPending ? 'Registering…' : 'Register asset'}
          </button>
        </div>
      </div>
    </div>
  )
}

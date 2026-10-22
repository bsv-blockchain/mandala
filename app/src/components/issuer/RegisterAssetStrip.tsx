import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useWallet } from '../../context/WalletContext'
import { useIssuerMutations } from '../../hooks/useIssuerMutations'
import { guardRegisterSubmit } from '@bsv/mandala/submitGuards'
import { registerFlight } from '@bsv/mandala/singleFlight'
import { validateRegisterForm } from '../../lib/mandala/registerForm'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'

/**
 * "Register a new asset" — the rare genesis action, kept as a slim dashed
 * strip on the Overview page (most issuers run a single stablecoin).
 *
 * The deploy carries the Mandala `req` (built inside the lib's registerAsset
 * from the configured overlay identity key), and no fee rate (B6): the admin
 * setFeeRate control in RegulatoryControls stays for later.
 */
export default function RegisterAssetStrip() {
  const { wallet } = useWallet()
  const [label, setLabel] = useState('')
  const [ticker, setTicker] = useState('')
  const [decimals, setDecimals] = useState('0')
  const { register } = useIssuerMutations()
  const startedRef = useRef(false)

  const handleRegister = () => {
    if (startedRef.current || register.isPending || registerFlight.isHeld()) return
    // Field limits first (dec 0..18, sym 1..32, label 1..64 code points;
    // contract gap A11), then the lib's own register gate on the trimmed values.
    const form = validateRegisterForm({ label, ticker, decimals })
    if (!form.ok) {
      toast.error(form.reason)
      return
    }
    const gate = guardRegisterSubmit({ ...form.value, walletReady: wallet != null })
    if (!gate.ok) {
      toast.error(gate.reason)
      return
    }
    startedRef.current = true
    register.mutate(form.value, {
      onSuccess: () => { setLabel(''); setTicker(''); setDecimals('0') },
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
              max="18"
              step="1"
              value={decimals}
              onChange={e => setDecimals(e.target.value)}
              placeholder="0"
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

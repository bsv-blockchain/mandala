import { useEffect, useRef, useState } from 'react'
import { Search, X, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import { useIdentitySearch } from '@bsv/identity-react'
import { MAX_UINT64 } from '@bsv/mandala'
import type { AdminAsset } from '@bsv/mandala/assets'
import { useWallet } from '../../context/WalletContext'
import { useAssetState } from '../../hooks/useAssetState'
import { usePayoutMutation, payoutFlight } from '../../hooks/usePayoutMutation'
import { displayAmount, plainAmount, safeParseAmount } from '../../lib/mandala/amountDisplay'
import { guardPayout } from '../../lib/mandala/payoutGuard'
import { describePayoutOutcome, outcomeLocksForm, type PayoutOutcome } from '../../lib/mandala/payoutFlow'
import { useDevMode } from '../../lib/devMode'
import { noAutofill } from '../../lib/noAutofill'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn } from '@/lib/utils'

const NOTE_MAX = 280

interface Props {
  assetId: string
  /** The admin record the payout spends against; null while loading. */
  asset: AdminAsset | null
  /** Treasury units for this asset; undefined while not yet loaded. */
  treasury: bigint | undefined
  decimals: number
  ticker?: string
}

/**
 * Treasury → user payout (B8). Issuer keys, lib-built, overlay-first; the
 * recipient output is derived under the holder's BRC-207 `p color` keys and the
 * receipt travels in the v4 hand-over body on MessageBox.
 *
 * Double submit: `startedRef` (sync, this form) + `payoutFlight` (process-wide,
 * taken again inside runPayout) + `isPending` on the button. A committed or
 * possibly-committed outcome locks the form until "New payout" clears it, so
 * the same review can never be paid twice.
 */
export default function PayoutForm({ assetId, asset, treasury, decimals, ticker }: Props) {
  const { wallet, identityKey } = useWallet()
  const devMode = useDevMode()
  const isPaused = useAssetState(assetId).data?.isPaused ?? false
  const payout = usePayoutMutation()

  const [recipientKey, setRecipientKey] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [note, setNote] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState<PayoutOutcome | null>(null)
  const startedRef = useRef(false)

  const search = useIdentitySearch({
    originator: 'mandala',
    wallet: wallet as any,
    onIdentitySelected: identity => {
      if (identity) {
        setRecipientKey(identity.identityKey)
        setRecipientName(identity.name ?? '')
      }
    }
  })

  const locked = outcome != null && outcomeLocksForm(outcome)
  const busy = payout.isPending || startedRef.current
  const amount = safeParseAmount(amountStr, decimals)
  const gate = guardPayout({ amount, treasury, recipientKey, issuerKey: identityKey, isPaused, pauseBypass: devMode })

  // A different asset may have a different `dec`: never carry a typed amount over.
  useEffect(() => {
    if (startedRef.current) return
    setAmountStr('')
    setReviewing(false)
    setError('')
  }, [assetId])

  const onAmount = (text: string): void => {
    const next = text.replace(/[^0-9.]/g, '')
    if ((next.match(/\./g) ?? []).length > 1) return
    const [, frac = ''] = next.split('.')
    if (frac.length > decimals) return
    if (decimals === 0 && next.includes('.')) return
    setAmountStr(next)
    setReviewing(false)
  }

  const onMax = (): void => {
    if (treasury == null || treasury <= 0n) return
    setAmountStr(plainAmount(treasury > MAX_UINT64 ? MAX_UINT64 : treasury, decimals))
    setReviewing(false)
  }

  const clearRecipient = (): void => {
    setRecipientKey('')
    setRecipientName('')
    search.handleSelect(null as any, null)
    setReviewing(false)
  }

  const reset = (): void => {
    if (payout.isPending) return
    startedRef.current = false
    setOutcome(null)
    setError('')
    setReviewing(false)
    setAmountStr('')
    setNote('')
    clearRecipient()
  }

  const onReview = (): void => {
    if (!gate.ok) { setError(gate.reason); return }
    if (asset == null) { setError('Asset admin record unavailable — refresh'); return }
    setError('')
    setReviewing(true)
  }

  const onConfirm = (): void => {
    // Sync latches first: a second click in the same tick sees startedRef.
    if (startedRef.current || payout.isPending || payoutFlight.isHeld() || locked) return
    // Re-gate on the treasury as read now.
    if (!gate.ok || amount == null) { setError(gate.ok ? 'Enter an amount' : gate.reason); setReviewing(false); return }
    if (asset == null || asset.assetId !== assetId) { setError('Asset admin record unavailable — refresh'); return }
    startedRef.current = true
    setError('')
    payout.mutate(
      { asset, amount, recipientKey, note: note.trim() === '' ? undefined : note.trim() },
      {
        onSuccess: o => {
          setOutcome(o)
          setReviewing(false)
          // Refused / busy / failed: the reviewed form may be submitted again.
          if (!outcomeLocksForm(o)) startedRef.current = false
        }
      }
    )
  }

  const view = outcome != null ? describePayoutOutcome(outcome) : null
  const fieldsDisabled = busy || locked || asset == null
  const label = asset?.label ?? 'tokens'
  const amountText = amount != null ? `${displayAmount(amount, decimals)} ${ticker ?? label}` : '—'

  return (
    <div className="rounded-lg border border-separator bg-card px-[24px] py-[20px] shadow-[var(--shadow-card)]">
      <div className="mb-[4px] text-[15px] font-semibold">Send to a user</div>
      <p className="mb-[18px] text-[12px] leading-[1.55] text-subtle-foreground">
        Pays out from the treasury to a holder's wallet. The overlay admits the transfer first; the
        receipt is then delivered to the recipient over MessageBox.
      </p>

      {view != null && outcome != null && (
        <div
          role="status"
          className={cn(
            'mb-[18px] flex gap-[10px] rounded-md border px-[14px] py-[12px]',
            view.tone === 'success' && 'border-success/40 bg-success/10',
            view.tone === 'warning' && 'border-warning/40 bg-warning/10',
            view.tone === 'error' && 'border-destructive/40 bg-destructive/10'
          )}
        >
          {view.tone === 'success' && <CheckCircle2 className="mt-[1px] h-[18px] w-[18px] shrink-0 text-success" />}
          {view.tone === 'warning' && <AlertTriangle className="mt-[1px] h-[18px] w-[18px] shrink-0 text-warning" />}
          {view.tone === 'error' && <XCircle className="mt-[1px] h-[18px] w-[18px] shrink-0 text-destructive" />}
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold">{view.title}</div>
            <div className="mt-[2px] break-words text-[12px] leading-[1.55] text-muted-foreground">{view.detail}</div>
            {locked && (
              <Button size="sm" variant="outline" className="mt-[10px]" onClick={reset}>New payout</Button>
            )}
          </div>
        </div>
      )}

      <fieldset disabled={fieldsDisabled} className="flex flex-col gap-[14px]">
        {/* Recipient */}
        <div>
          <label className="text-[11px] font-medium uppercase tracking-[1px] text-subtle-foreground">Recipient</label>
          {recipientKey !== '' && recipientName !== '' ? (
            <div className="mt-[6px] flex items-center justify-between gap-2 rounded border border-border bg-muted px-[12px] py-[9px]">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{recipientName}</div>
                <div className="tabular truncate font-mono text-[11px] text-subtle-foreground">{recipientKey}</div>
              </div>
              <button type="button" aria-label="Clear recipient" onClick={clearRecipient} className="text-muted-foreground hover:text-foreground">
                <X className="h-[16px] w-[16px]" />
              </button>
            </div>
          ) : (
            <>
              <div className="mt-[6px]">
                <Input
                  {...noAutofill}
                  name="payout-recipient-search"
                  icon={<Search className="h-[18px] w-[18px]" />}
                  value={search.inputValue}
                  onChange={e => search.handleInputChange(e, e.target.value, 'input')}
                  placeholder="Search by name, @handle or email…"
                />
                {search.inputValue && search.identities.length > 0 && !search.selectedIdentity && (
                  <div className="mt-2 max-h-48 overflow-auto rounded-md bg-popover shadow-[var(--shadow-pop)]">
                    {search.identities.map(identity => {
                      if (typeof identity === 'string') return null
                      return (
                        <button
                          type="button"
                          key={identity.identityKey}
                          onClick={() => {
                            search.handleSelect(null as any, identity)
                            setRecipientKey(identity.identityKey)
                            setRecipientName(identity.name ?? '')
                            setReviewing(false)
                          }}
                          className="flex w-full items-center gap-2 border-b border-separator p-3 text-left text-[14px] transition-colors last:border-b-0 hover:bg-muted"
                        >
                          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
                            {(identity.name ?? identity.identityKey).slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{identity.name || 'Unknown'}</div>
                            <div className="tabular truncate text-[11px] text-subtle-foreground">{identity.identityKey.slice(0, 20)}…</div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              <Input
                {...noAutofill}
                name="payout-recipient-key"
                value={recipientKey}
                onChange={e => { setRecipientKey(e.target.value.trim()); setRecipientName(''); setReviewing(false) }}
                placeholder="Or paste identity key (02… / 03…)"
                className="tabular mt-2 font-mono text-[12.5px]"
              />
            </>
          )}
        </div>

        {/* Amount */}
        <div>
          <div className="flex items-baseline justify-between">
            <label className="text-[11px] font-medium uppercase tracking-[1px] text-subtle-foreground">
              Amount{ticker != null ? ` (${ticker})` : ''}
            </label>
            <button
              type="button"
              onClick={onMax}
              disabled={treasury == null || treasury <= 0n}
              className="text-[11.5px] font-medium text-primary hover:underline disabled:opacity-40"
            >
              Max
            </button>
          </div>
          <Input
            {...noAutofill}
            name="payout-amount"
            inputMode="decimal"
            value={amountStr}
            onChange={e => onAmount(e.target.value)}
            placeholder={decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0'}
            className="tabular mt-[6px]"
          />
          <p className="mt-1 text-[11px] text-subtle-foreground">
            Up to {decimals} decimal place{decimals === 1 ? '' : 's'}.
            {treasury != null && <> Treasury: {displayAmount(treasury, decimals)}.</>}
          </p>
        </div>

        {/* Note */}
        <div>
          <label className="text-[11px] font-medium uppercase tracking-[1px] text-subtle-foreground">Note (optional)</label>
          <Input
            {...noAutofill}
            name="payout-note"
            value={note}
            maxLength={NOTE_MAX}
            onChange={e => { setNote(e.target.value.slice(0, NOTE_MAX)); setReviewing(false) }}
            placeholder="Shown to the recipient"
            className="mt-[6px]"
          />
        </div>
      </fieldset>

      {isPaused && devMode && (
        <p className="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[11.5px]">
          <span className="font-semibold">Developer mode:</span> the pause guard is bypassed so the overlay's
          own enforcement can be observed.
        </p>
      )}

      {error !== '' && (
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">{error}</p>
      )}

      {!locked && (
        reviewing ? (
          <div className="mt-[18px] rounded-md border border-border bg-muted px-[14px] py-[12px]">
            <div className="text-[12px] text-subtle-foreground">You are paying out</div>
            <div className="tabular text-[20px] font-semibold">{amountText}</div>
            <div className="tabular mt-1 break-all font-mono text-[11.5px] text-muted-foreground">
              to {recipientName !== '' ? `${recipientName} · ` : ''}{recipientKey}
            </div>
            {note.trim() !== '' && <div className="mt-1 text-[12px] text-muted-foreground">“{note.trim()}”</div>}
            <div className="mt-[12px] flex gap-2">
              <Button
                onClick={onConfirm}
                disabled={busy || locked || payoutFlight.isHeld() || !gate.ok}
                loading={payout.isPending}
                loadingText="Paying out…"
              >
                Confirm payout
              </Button>
              <Button variant="ghost" onClick={() => setReviewing(false)} disabled={busy}>Edit</Button>
            </div>
          </div>
        ) : (
          <Button className="mt-[18px]" onClick={onReview} disabled={busy || asset == null}>
            Review payout
          </Button>
        )
      )}
    </div>
  )
}

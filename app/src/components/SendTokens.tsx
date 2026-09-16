import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { PublicKey, IdentityClient } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'
import { Button } from './ui/button'
import { Select } from './ui/select'
import { Spinner } from './ui/spinner'
import { useWallet } from '../context/WalletContext'
import { ChevronLeft, Search, CheckCircle2, Copy, QrCode, Send } from 'lucide-react'
import { noAutofill } from '../lib/noAutofill'
import { cn } from '@/lib/utils'
import { parseAmount, formatAmount, formatAmountPlain } from '@bsv/mandala/amount'
import { useHolderData } from '../hooks/useHolderData'
import { useContactsData } from '../hooks/useContactsData'
import { useAssetState } from '../hooks/useAssetState'
import { useSendMutation } from '../hooks/useSendMutation'
import { useDevMode } from '../lib/devMode'
import { reconcileBans } from '@bsv/mandala/reconcileBans'
import { resolveAssetState } from '@bsv/mandala/adminState'
import { guardSendSubmit } from '@bsv/mandala/submitGuards'
import { sendFlight, BusyError } from '@bsv/mandala/singleFlight'
import QrScanModal from './QrScanModal'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = 'recipient' | 'amount' | 'review' | 'sending' | 'sent'

/** A tappable recipient row in the recipient-step shortlist. */
interface PickRow { identityKey: string; name?: string; avatarURL?: string; subtitle: string }

/** Max recipients shown in the shortlist before it's truncated (recency-first). */
const CONTACT_LIMIT = 12

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SendTokens({ lockedAssetId }: { lockedAssetId?: string } = {}) {
  const locked = lockedAssetId != null && lockedAssetId !== ''
  const { wallet, identityKey } = useWallet()
  // Dev mode bypasses the frontend pause guard so a paused transfer actually
  // reaches the overlay, proving the overlay (not the client) enforces the pause.
  const devMode = useDevMode()

  // Wizard step
  const [step, setStep] = useState<Step>('recipient')

  // Transfer fields
  const [assetId, setAssetId] = useState(lockedAssetId ?? '')
  const [amountStr, setAmountStr] = useState('')
  const [note, setNote] = useState('')
  const [recipient, setRecipient] = useState('')
  const [recipientName, setRecipientName] = useState('')
  const [recipientAvatarURL, setRecipientAvatarURL] = useState('')

  // Async state
  const [sendError, setSendError] = useState('')
  const [sentTxid, setSentTxid] = useState('')
  const [receiptCopied, setReceiptCopied] = useState(false)
  const [frozenNote, setFrozenNote] = useState<Array<{ amount: number, reason: string }>>([])

  // Shared cached data — instant render, background refetch.
  const holder = useHolderData()
  const balances = (holder.data?.assets ?? []).filter(a => a.balance > 0)
    .map(a => ({ assetId: a.assetId, amount: a.balance }))
  const metas = holder.data?.metas ?? {}
  const isLoadingBalances = holder.data == null
  const contactsQuery = useContactsData()
  const contacts = contactsQuery.data?.derived ?? []
  const saved = contactsQuery.data?.saved ?? []
  const assetState = useAssetState(assetId)
  const isPaused = assetState.data?.isPaused ?? false

  const sendMutation = useSendMutation()

  // Helpers
  const labelFor = (id: string): string => metas[id]?.label ?? `${id.slice(0, 20)}…`
  const decimalsFor = (id: string): number => metas[id]?.decimals ?? 0

  // Keep the asset locked to the account this Send tab belongs to.
  useEffect(() => {
    if (locked) setAssetId(lockedAssetId as string)
  }, [lockedAssetId, locked])

  // Relinquish any evicted-and-held outputs for the selected asset on mount /
  // asset change, so stale basket entries clear before the user tries to send.
  // Fail-open — a reconcile failure shouldn't block the flow.
  useEffect(() => {
    if (wallet == null || assetId === '') return
    void reconcileBans(wallet as any, [assetId]).catch(() => {})
  }, [wallet, assetId])

  // Surface any frozen outputs the current identity owns for the selected
  // asset, with the freeze reason, so the holder understands why part of
  // their balance may be unspendable.
  useEffect(() => {
    let live = true
    if (assetId === '' || identityKey == null) { setFrozenNote([]); return }
    void resolveAssetState(assetId).then(s => {
      if (!live || s == null) return
      setFrozenNote(
        s.frozenOutpoints
          .filter(f => f.owner === identityKey)
          .map(f => ({ amount: f.amount, reason: f.reason }))
      )
    })
    return () => { live = false }
  }, [assetId, identityKey])

  // ---------------------------------------------------------------------------
  // Identity search — local state replacing useIdentitySearch hook
  // ---------------------------------------------------------------------------

  const [searchInput, setSearchInput] = useState('')
  const [identities, setIdentities] = useState<DisplayableIdentity[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const searchRequestIdRef = useRef(0)
  const identityInputRef = useRef<HTMLInputElement>(null)

  // Detect if input is a compressed public key (identity key)
  const isIdentityKey = useCallback((key: string): boolean => {
    return /^(02|03|04)[0-9a-fA-F]{64}$/.test(key)
  }, [])

  useEffect(() => {
    const query = searchInput.trim()
    if (!query) {
      setIdentities([])
      setIsSearching(false)
      return
    }
    if (wallet == null) return

    setIsSearching(true)
    const requestId = ++searchRequestIdRef.current
    const timer = setTimeout(async () => {
      try {
        const client = new IdentityClient(wallet as any, undefined, 'mandala')
        const results = isIdentityKey(query)
          ? await client.resolveByIdentityKey({ identityKey: query }, true)
          : await client.resolveByAttributes({ attributes: { any: query } }, true)
        if (requestId !== searchRequestIdRef.current) return // stale — discard
        setIdentities(results as DisplayableIdentity[])
      } catch (err) {
        if (requestId !== searchRequestIdRef.current) return
        console.error('Identity search failed:', err)
        setIdentities([])
      } finally {
        if (requestId === searchRequestIdRef.current) setIsSearching(false)
      }
    }, 250)

    return () => { clearTimeout(timer) }
  }, [searchInput, wallet, isIdentityKey])

  const getInitials = (name: string, key: string): string => {
    if (!name || name.trim() === '') return key.slice(0, 2).toUpperCase()
    const words = name.trim().split(/\s+/)
    if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
  }

  // Core transfer pipeline lives in lib/mandala/transfer.ts (via useSendMutation).

  // ---------------------------------------------------------------------------
  // Wizard actions
  // ---------------------------------------------------------------------------

  const selectedBalance = balances.find(b => b.assetId === assetId)
  const decimals = decimalsFor(assetId)
  const sendAmount = parseAmount(amountStr, decimals)

  // Recipient shortlist shown under the search field — tap to pick, no search
  // needed. History counterparties come first (most recently sent-to/received-from,
  // per deriveContacts), enriched with saved-contact names/avatars; saved contacts
  // never transacted with follow, alphabetically. Truncated to CONTACT_LIMIT, so
  // truncation drops the least-recent.
  const pickList = useMemo<PickRow[]>(() => {
    const savedByKey = new Map(saved.map(c => [c.identityKey, c]))
    const seen = new Set<string>()
    const out: PickRow[] = []
    for (const c of contacts) {
      seen.add(c.identityKey)
      const s = savedByKey.get(c.identityKey)
      out.push({
        identityKey: c.identityKey,
        name: s?.name,
        avatarURL: s?.avatarURL,
        subtitle: s?.handle ? `@${s.handle}` : s?.email ?? `${c.count} transaction${c.count !== 1 ? 's' : ''}`,
      })
    }
    for (const s of saved.filter(s => !seen.has(s.identityKey)).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ identityKey: s.identityKey, name: s.name, avatarURL: s.avatarURL, subtitle: s.handle ? `@${s.handle}` : s.email ?? 'Saved contact' })
    }
    return out.slice(0, CONTACT_LIMIT)
  }, [contacts, saved])

  // Select a recipient from the shortlist / issuer shortcut and advance the wizard.
  const pickRecipient = (identityKey: string, name = '', avatarURL = '') => {
    setRecipient(identityKey)
    setRecipientName(name)
    setRecipientAvatarURL(avatarURL)
    setSearchInput('')
    setIdentities([])
    setStep('amount')
  }

  // Tapping a search result is an explicit choice — advance immediately, same
  // as the contacts shortlist. The Amount step's "To: <name>" header is the
  // selection feedback; lingering on the search view reads as a dead click.
  const handleIdentitySelect = (identity: DisplayableIdentity) => {
    pickRecipient(identity.identityKey, identity.name ?? '', identity.avatarURL ?? '')
  }

  // One handler for typed, pasted, and clipboard-button input — a full valid
  // identity key selects the recipient; anything else feeds the fuzzy search.
  const applyRecipientText = (raw: string) => {
    setSearchInput(raw)
    const trimmed = raw.trim()
    if (isIdentityKey(trimmed)) {
      try {
        PublicKey.fromString(trimmed)
        setRecipient(trimmed)
        setRecipientName('')
        setRecipientAvatarURL('')
      } catch {
        setRecipient('')
      }
    } else {
      setRecipient('')
    }
  }

  const [scanOpen, setScanOpen] = useState(false)
  const handleScanResult = (text: string) => {
    setScanOpen(false)
    applyRecipientText(text.trim())
    identityInputRef.current?.focus()
  }

  const confirmRecipient = () => {
    if (!recipient.trim()) return
    setStep('amount')
  }

  const handleKeypad = (key: string) => {
    if (key === 'backspace') {
      setAmountStr(s => s.slice(0, -1))
      return
    }
    if (key === '.') {
      if (decimals === 0) return // no decimals allowed
      if (amountStr.includes('.')) return
      setAmountStr(s => (s === '' ? '0.' : s + '.'))
      return
    }
    // digit
    const next = amountStr + key
    // Validate it won't exceed balance or have too many decimal places
    const [, frac = ''] = next.split('.')
    if (frac.length > decimals) return
    setAmountStr(next)
  }

  const handleMax = () => {
    if (!selectedBalance) return
    setAmountStr(formatAmountPlain(selectedBalance.amount, decimals))
  }

  // Sync re-entry latch: setStep('sending') is async, so a second click in the
  // same tick still sees step === 'review'. This ref + sendFlight close that gap.
  const sendStartedRef = useRef(false)

  const handleConfirmAndSend = () => {
    if (sendStartedRef.current || sendMutation.isPending || sendFlight.isHeld()) return
    if (step === 'sending' || step === 'sent') return

    const gate = guardSendSubmit({
      assetId,
      recipientKey: recipient,
      amount: sendAmount,
      balance: selectedBalance?.amount ?? 0,
      isPaused,
      pauseBypass: devMode,
      walletReady: wallet != null
    })
    if (!gate.ok) {
      setSendError(gate.reason)
      return
    }

    setSendError('')
    sendStartedRef.current = true
    // Flip the UI immediately — the pipeline (build → sign → overlay submit)
    // runs behind the Sending screen. Overlay accept → Sent; reject → back to
    // Review with the error (the wallet action was aborted, inputs released).
    setStep('sending')
    sendMutation.mutate(
      { assetId, amount: sendAmount, recipientKey: recipient, note },
      {
        onSuccess: res => {
          setSentTxid(res.txid)
          setStep('sent')
          // Keep sendStartedRef true until reset — prevents re-send of same review.
        },
        onError: e => {
          sendStartedRef.current = false
          // Lost the race to another in-flight send (e.g. a second mounted
          // send flow). This instance never started a pipeline — return it to
          // review; advancing to 'sending' would strand a screen with no
          // pipeline and no exit.
          if (e instanceof BusyError) {
            setSendError(e.message)
            setStep('review')
            return
          }
          console.error('Send error:', e)
          setSendError(e instanceof Error ? e.message : 'Send failed. Please try again.')
          setStep('review')
        }
      }
    )
  }

  const resetFlow = () => {
    sendStartedRef.current = false
    setStep('recipient')
    setAssetId(lockedAssetId ?? '')
    setAmountStr('')
    setNote('')
    setRecipient('')
    setRecipientName('')
    setRecipientAvatarURL('')
    setSentTxid('')
    setSendError('')
    setSearchInput('')
    setIdentities([])
  }

  const shareReceipt = async () => {
    if (!sentTxid) return
    try {
      await navigator.clipboard.writeText(sentTxid)
      setReceiptCopied(true)
      setTimeout(() => setReceiptCopied(false), 1400)
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const recipientInitials = getInitials(recipientName, recipient || 'XX')

  // Meridian neutral pill — small label
  const SectionLabel = ({ children }: { children: React.ReactNode }) => (
    <div className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground mb-[14px]">
      {children}
    </div>
  )

  // Spendable-balance context bar — pinned to the top of the card on the
  // recipient and review steps so the available amount stays on screen through
  // the whole flow. The amount step already shows it inline beside Max, where
  // it sits closest to the number being typed.
  const AvailableStrip = () =>
    selectedBalance != null && assetId !== '' ? (
      <div className="flex items-center justify-between border-b border-separator bg-muted/60 px-5 py-2.5">
        <span className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground">
          Available
        </span>
        <span className="tabular text-[13px] font-semibold">
          {formatAmount(selectedBalance.amount, decimals)} {labelFor(assetId)}
        </span>
      </div>
    ) : null

  // Back button — white circle with left chevron (faithful to 3a/3b/3c)
  const BackButton = ({ onClick }: { onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-card border border-border transition-colors hover:bg-accent active:scale-[0.97]"
      aria-label="Go back"
    >
      <ChevronLeft className="h-[17px] w-[17px]" />
    </button>
  )

  // Recipient avatar bubble
  const RecipientAvatar = ({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) => {
    const sz = size === 'lg' ? 'h-[90px] w-[90px] text-[30px]' : size === 'md' ? 'h-11 w-11 text-[15px]' : 'h-7 w-7 text-[11px]'
    return recipientAvatarURL ? (
      <img src={recipientAvatarURL} alt={recipientName} className={cn('rounded-full object-cover', sz)} />
    ) : (
      <div className={cn('flex flex-none items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold', sz)}>
        {recipientInitials}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // Step: Recipient
  // ---------------------------------------------------------------------------

  const renderRecipient = () => (
    // No in-card heading — the page/tab context already says "Send"; the
    // search field is the action (mirrors the header-less Receive card).
    <div className="flex flex-col min-h-0 flex-1">
      {/* Search bar — one field for both name/@handle/email search and a
          pasted identity key, so there's no second input further down. */}
      <div className="px-5 pt-5">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border bg-card px-3.5 py-3">
            <Search className="h-[17px] w-[17px] flex-none text-subtle-foreground" />
            <input
              {...noAutofill}
              ref={identityInputRef}
              name="mandala-recipient-search"
              type="text"
              value={searchInput}
              onChange={e => applyRecipientText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && recipient) confirmRecipient() }}
              placeholder="Name, @handle, email or identity key"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground placeholder:text-subtle-foreground outline-none"
            />
            {isSearching && <Spinner size="sm" tone="brand" />}
          </div>
          <button
            type="button"
            onClick={() => setScanOpen(true)}
            aria-label="Scan an identity key QR code"
            title="Scan an identity key QR code"
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <QrCode className="h-[17px] w-[17px]" strokeWidth={1.9} />
          </button>
          <QrScanModal open={scanOpen} onClose={() => setScanOpen(false)} onResult={handleScanResult} />
        </div>

        {(() => {
          const trimmed = searchInput.trim()
          const pastedKey = isIdentityKey(trimmed)

          // Pasted-key path: skip the fuzzy dropdown — show an explicit
          // "recipient selected" card (or flag the bad key) so the paste
          // visibly landed before the user commits.
          if (pastedKey) {
            return recipient ? (
              <div className="mt-3 rounded-md border border-border bg-card px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 flex-none place-items-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
                    {recipient.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-success">
                      <CheckCircle2 className="h-[14px] w-[14px] flex-none" />
                      Valid identity key
                    </div>
                    <div className="tabular truncate text-[12px] text-subtle-foreground mt-0.5">
                      {recipient.slice(0, 20)}…{recipient.slice(-6)}
                    </div>
                  </div>
                </div>
                <Button onClick={confirmRecipient} className="mt-3 w-full" size="lg">
                  Continue
                </Button>
              </div>
            ) : (
              <p className="mt-1.5 text-[12px] text-destructive">
                Not a valid identity key — check it was copied completely.
              </p>
            )
          }

          // Free-text search path: unchanged dropdown behaviour.
          if (searchInput && identities.length > 0) {
            return (
              <div className="mt-2 rounded-md bg-popover shadow-[var(--shadow-pop)] overflow-hidden">
                {identities.map(identity => (
                  <button
                    key={identity.identityKey}
                    type="button"
                    onClick={() => handleIdentitySelect(identity)}
                    className="flex w-full items-center gap-3 border-b border-separator p-3 text-left transition-colors last:border-b-0 hover:bg-muted active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {identity.avatarURL ? (
                      <img src={identity.avatarURL} alt={identity.name} className="h-10 w-10 rounded-full flex-none" />
                    ) : (
                      <div className="grid h-10 w-10 flex-none place-items-center rounded-full bg-primary text-[13px] font-semibold text-primary-foreground">
                        {getInitials(identity.name || '', identity.identityKey)}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-semibold">{identity.name || 'Unknown'}</div>
                      <div className="tabular truncate text-[11.5px] text-subtle-foreground mt-0.5">@{identity.identityKey.slice(0, 16)}…</div>
                    </div>
                    {identity.badgeLabel && (
                      <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium text-accent-foreground">
                        {identity.badgeLabel}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )
          }

          if (searchInput && identities.length === 0 && !isSearching) {
            return <p className="mt-2 text-[13px] text-subtle-foreground">No identities found</p>
          }

          return null
        })()}
      </div>

      {/* Contacts shortlist — recency-first, tap to select (no search needed).
          Truncated to CONTACT_LIMIT so the most recent stay on screen. */}
      {pickList.length > 0 && (
        <div className="px-5 pt-6">
          <SectionLabel>Contacts</SectionLabel>
          <div className="divide-y divide-separator">
            {pickList.map(c => (
              <button
                key={c.identityKey}
                type="button"
                onClick={() => pickRecipient(c.identityKey, c.name ?? '', c.avatarURL ?? '')}
                className="flex w-full items-center gap-3 py-[11px] hover:bg-muted/60 active:bg-accent transition-colors -mx-1 px-1 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {c.avatarURL ? (
                  <img src={c.avatarURL} alt={c.name ?? ''} className="h-10 w-10 flex-none rounded-full object-cover" />
                ) : (
                  <div className="h-10 w-10 flex-none flex items-center justify-center rounded-full bg-primary text-primary-foreground font-semibold text-[13px]">
                    {getInitials(c.name ?? '', c.identityKey)}
                  </div>
                )}
                <div className="flex-1 min-w-0 text-left">
                  <div className="text-[14px] font-semibold truncate">
                    {c.name || `${c.identityKey.slice(0, 16)}…`}
                  </div>
                  <div className="text-[11.5px] text-subtle-foreground mt-0.5 truncate">
                    {c.subtitle}
                  </div>
                </div>
                <ChevronLeft className="h-[17px] w-[17px] text-border rotate-180 flex-none" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Return to issuer shortcut — shown when token is locked and the
          current user isn't the issuer themselves (they'd be sending to
          their own identity key). */}
      {assetId && metas[assetId]?.issuer && metas[assetId].issuer !== identityKey && (
        <div className="px-5 pt-4">
          <button
            type="button"
            onClick={() => {
              const iss = metas[assetId].issuer as string
              setRecipient(iss)
              setRecipientName('Issuer')
              setRecipientAvatarURL('')
              setSearchInput('')
              setIdentities([])
                        setStep('amount')
            }}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-3.5 py-2.5 text-[14px] font-medium text-foreground transition-colors hover:bg-accent active:scale-[0.97]"
          >
            <Send className="h-[15px] w-[15px]" /> Return to issuer
          </button>
        </div>
      )}

    </div>
  )

  // ---------------------------------------------------------------------------
  // Step: Amount
  // ---------------------------------------------------------------------------

  // Format the display value with a blinking cursor
  const amountDisplay = amountStr === '' ? '0' : amountStr

  const renderAmount = () => (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header with back + recipient chip */}
      <div className="flex items-center gap-3 px-5 pt-4">
        <BackButton onClick={() => setStep('recipient')} />
        <div className="flex items-center gap-2.5">
          <RecipientAvatar size="sm" />
          <div>
            <div className="text-[10.5px] text-subtle-foreground leading-none">To</div>
            <div className="text-[14px] font-semibold leading-tight mt-0.5">
              {recipientName || (recipient.slice(0, 12) + '…')}
            </div>
          </div>
        </div>
      </div>

      {/* Token selector (only when not locked) */}
      {!locked && (
        <div className="px-5 pt-4">
          {isLoadingBalances ? (
            <div className="text-[13px] text-subtle-foreground">Loading tokens…</div>
          ) : balances.length > 0 ? (
            <Select value={assetId} onChange={e => { setAssetId(e.target.value); setAmountStr('') }}>
              <option value="">Select a token</option>
              {balances.map(b => (
                <option key={b.assetId} value={b.assetId}>
                  {labelFor(b.assetId)} ({formatAmount(b.amount, decimalsFor(b.assetId))} available)
                </option>
              ))}
            </Select>
          ) : (
            <div className="text-[13px] text-subtle-foreground">No tokens — receive some first.</div>
          )}
        </div>
      )}

      {/* Big amount display */}
      <div className="px-6 pt-9 text-center">
        <div className="text-[11px] font-medium uppercase tracking-[1.2px] text-subtle-foreground">
          Sending · {assetId ? labelFor(assetId) : 'Select token'}
        </div>
        <div className="mt-3.5 font-semibold text-[56px] leading-none tracking-[-2px] tabular">
          {amountDisplay}
          <span className="inline-block w-[3px] h-[46px] bg-primary rounded-[2px] align-[-7px] ml-[3px] animate-pulse" />
        </div>
        {selectedBalance && assetId && (
          <div className="mt-[18px] inline-flex items-center gap-2.5">
            <span className="text-[12px] text-subtle-foreground">
              {formatAmount(selectedBalance.amount, decimals)} available
            </span>
            <button
              type="button"
              onClick={handleMax}
              className="text-[11px] font-semibold text-primary border border-primary/30 rounded-full px-2.5 py-[5px] hover:bg-primary/10 active:scale-[0.97] transition-[background-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Max
            </button>
          </div>
        )}
      </div>

      {/* Frozen holdings note — only the current identity's frozen outputs for
          this asset, so a send that needs one can be understood up front. */}
      {frozenNote.length > 0 && (
        <div className="mx-5 mt-[18px] rounded-md border border-warning/40 bg-warning/10 p-3 text-[12px] text-warning">
          {frozenNote.map((f, i) => (
            <div key={i}>
              {formatAmount(f.amount, decimals)} {labelFor(assetId)} frozen{f.reason ? ` — ${f.reason}` : ''} (unspendable)
            </div>
          ))}
        </div>
      )}

      {/* Note field */}
      <div className="px-5 pt-[22px]">
        <div className="flex items-center gap-2.5 rounded-md border border-border bg-card px-3.5 py-3">
          <svg className="text-muted-foreground" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <input
            type="text"
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add a note (optional)"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-subtle-foreground outline-none"
          />
        </div>
      </div>

      {/* Numeric keypad */}
      <div className="mt-auto px-[30px] pb-6 pt-3">
        <div className="grid grid-cols-3 text-center text-foreground">
          {['1','2','3','4','5','6','7','8','9','.','0','backspace'].map(key => (
            <button
              key={key}
              type="button"
              onClick={() => handleKeypad(key)}
              disabled={key === '.' && decimals === 0}
              className={cn(
                'py-[11px] font-medium text-[23px] flex items-center justify-center rounded transition-transform duration-150 active:scale-[0.97] select-none min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                key === '.' && decimals === 0 && 'opacity-20 cursor-not-allowed'
              )}
            >
              {key === 'backspace' ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 5H8l-6 7 6 7h13a1 1 0 001-1V6a1 1 0 00-1-1z" strokeLinejoin="round"/>
                  <path d="M15 9l-4 6M11 9l4 6" strokeLinecap="round"/>
                </svg>
              ) : key}
            </button>
          ))}
        </div>

        <Button
          onClick={() => {
            if (!assetId || !sendAmount || sendAmount <= 0) return
            if (!selectedBalance || selectedBalance.amount < sendAmount) return
            setStep('review')
          }}
          disabled={!assetId || !sendAmount || sendAmount <= 0 || !selectedBalance || selectedBalance.amount < sendAmount}
          size="lg"
          className="mt-3 w-full"
        >
          Review
        </Button>
      </div>
    </div>
  )

  // ---------------------------------------------------------------------------
  // Step: Review
  // ---------------------------------------------------------------------------

  const renderReview = () => (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 pt-4">
        <BackButton onClick={() => setStep('amount')} />
        <div className="text-[19px] font-semibold">Review</div>
      </div>

      {/* Review card */}
      <div className="px-5 pt-[22px]">
        <div className="rounded-lg border border-border bg-card overflow-hidden shadow-[var(--shadow-card)]">
          {/* Recipient row */}
          <div className="flex items-center gap-3 px-[18px] py-4">
            <RecipientAvatar size="md" />
            <div className="flex-1 min-w-0">
              <div className="text-[15px] font-semibold truncate">
                {recipientName || 'Unknown'}
              </div>
              <div className="tabular text-[12px] text-subtle-foreground mt-[3px] truncate">
                {recipient.slice(0, 24)}…
              </div>
            </div>
            <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-success bg-success/10 px-2 py-1 rounded-sm">
              <CheckCircle2 className="h-[11px] w-[11px]" />
              Verified
            </span>
          </div>

          {/* Detail rows */}
          <div className="px-[18px] pb-2.5">
            <div className="flex items-center justify-between py-3 border-t border-separator">
              <span className="text-[12.5px] text-subtle-foreground">Amount</span>
              <span className="tabular text-[17px] font-semibold">
                {formatAmount(sendAmount, decimals)} {labelFor(assetId)}
              </span>
            </div>
            <div className="flex items-center justify-between py-3 border-t border-separator">
              <span className="text-[12.5px] text-subtle-foreground">From</span>
              <span className="text-[13.5px] font-semibold">{labelFor(assetId)} account</span>
            </div>
            {note && (
              <div className="flex items-center justify-between py-3 border-t border-separator">
                <span className="text-[12.5px] text-subtle-foreground">Note</span>
                <span className="text-[13.5px] font-semibold truncate max-w-[60%] text-right">{note}</span>
              </div>
            )}
            <div className="flex items-center justify-between py-3 border-t border-separator">
              <span className="text-[12.5px] text-subtle-foreground">Fee</span>
              <span className="text-[13.5px] font-semibold text-success">Free · Instant</span>
            </div>
          </div>
        </div>
      </div>

      {/* Pause guard */}
      {isPaused && !devMode && (
        <div className="mx-5 mt-4 rounded-md bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          Transfers are temporarily disabled by the issuer.
        </div>
      )}
      {isPaused && devMode && (
        <div className="mx-5 mt-4 rounded-md bg-warning/10 px-4 py-3 text-[13px] text-warning">
          <span className="font-semibold">Developer mode:</span> frontend pause guard bypassed. This
          asset is paused, so the overlay should reject the transfer server-side — send to verify.
        </div>
      )}

      {/* Send failure surface */}
      {sendError && (
        <div className="mx-5 mt-4 rounded-md bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {sendError}
        </div>
      )}

      {/* Confirm CTA — disabled while in-flight (isPending) and for
          known-invalid gates; sync ref + sendFlight (handler-side, refs don't
          re-render) still block double-click before the re-render lands. */}
      <div className="mt-auto px-5 pb-6 pt-4">
        <Button
          onClick={handleConfirmAndSend}
          disabled={
            (isPaused && !devMode) ||
            wallet == null ||
            sendMutation.isPending ||
            !sendAmount ||
            sendAmount <= 0 ||
            !selectedBalance ||
            selectedBalance.amount < sendAmount
          }
          loading={sendMutation.isPending}
          loadingText="Sending…"
          size="lg"
          className="w-full"
        >
          <Send className="h-[17px] w-[17px]" />
          Send {formatAmount(sendAmount, decimals)} {labelFor(assetId)}
        </Button>
      </div>
    </div>
  )

  // ---------------------------------------------------------------------------
  // Step: Sending — shown the instant the button is pressed; the overlay accept
  // (commit point) flips it to Sent, a reject returns to Review with the error.
  // ---------------------------------------------------------------------------

  const renderSending = () => (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-1 flex-col items-center justify-center px-[34px] pb-[210px] text-center animate-in">
        <div className="relative mb-7 flex justify-center">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[190px] w-[190px] rounded-full bg-[radial-gradient(circle,rgba(35,64,94,.10),rgba(35,64,94,0)_68%)]" />
          <div className="relative flex h-[90px] w-[90px] items-center justify-center rounded-full bg-primary/8">
            <Spinner size="lg" tone="brand" />
          </div>
        </div>
        <div className="text-[11px] font-medium tracking-[2px] uppercase text-subtle-foreground">Sending</div>
        <div className="tabular mt-3 text-[44px] font-semibold leading-none tracking-[-1.5px]">
          {formatAmount(sendAmount, decimals)}
        </div>
        <div className="text-[14px] text-muted-foreground mt-2.5 leading-snug">
          {labelFor(assetId)} to {recipientName || (recipient.slice(0, 12) + '…')}
        </div>
      </div>
    </div>
  )

  // ---------------------------------------------------------------------------
  // Step: Sent
  // ---------------------------------------------------------------------------

  const renderSent = () => (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Calm success centre */}
      <div className="flex flex-1 flex-col items-center justify-center px-[34px] pb-[210px] text-center">
        {/* Glow + check mark */}
        <div className="relative mb-7 flex justify-center">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[190px] w-[190px] rounded-full bg-[radial-gradient(circle,rgba(35,64,94,.16),rgba(35,64,94,0)_68%)]" />
          <div className="relative flex h-[90px] w-[90px] items-center justify-center rounded-full bg-primary shadow-[0_16px_34px_-10px_rgba(35,64,94,.55)]">
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="var(--brass)" strokeWidth="2.4">
              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
        </div>

        <div className="text-[11px] font-medium tracking-[2px] uppercase text-subtle-foreground">Sent</div>
        <div className="tabular mt-3 text-[44px] font-semibold leading-none tracking-[-1.5px]">
          {formatAmount(sendAmount, decimals)}
        </div>
        <div className="text-[14px] text-muted-foreground mt-2.5 leading-snug">
          {labelFor(assetId)} to {recipientName || (recipient.slice(0, 12) + '…')}
        </div>
        {sentTxid && (
          <div className="mt-4 text-[12px] text-subtle-foreground">
            Ref {sentTxid.slice(0, 8)}…{sentTxid.slice(-4)}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="px-5 pb-6 flex flex-col gap-2.5">
        <Button size="lg" className="w-full" onClick={resetFlow}>
          Make another payment
        </Button>
        <button
          type="button"
          onClick={() => void shareReceipt()}
          disabled={!sentTxid}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-[15px] text-[14px] font-semibold text-primary transition-colors hover:bg-accent active:scale-[0.97] disabled:opacity-40"
        >
          {receiptCopied
            ? <><CheckCircle2 className="h-[15px] w-[15px] text-success" />Txid copied</>
            : <><Copy className="h-[15px] w-[15px]" />Share receipt</>}
        </button>
      </div>
    </div>
  )

  // ---------------------------------------------------------------------------
  // Root render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col rounded-lg bg-card shadow-[var(--shadow-card)] border border-border overflow-hidden min-h-[520px]">
      {(step === 'recipient' || step === 'review') && <AvailableStrip />}
      {step === 'recipient' && renderRecipient()}
      {step === 'amount' && renderAmount()}
      {step === 'review' && renderReview()}
      {step === 'sending' && renderSending()}
      {step === 'sent' && renderSent()}
    </div>
  )
}

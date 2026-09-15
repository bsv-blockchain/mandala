import { useCallback, useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useIdentitySearch } from '@bsv/identity-react'
import { Input } from '../ui/input'
import { Select } from '../ui/select'
import { Spinner } from '../ui/spinner'
import { useWallet } from '../../context/WalletContext'
import { AdminAsset, submitAdminAction, SubmitAdminActionParams, withReason } from '@bsv/mandala/assets'
import { AssetAdminStateView } from '@bsv/mandala/adminState'
import { formatAmount } from '@bsv/mandala/amount'
import { guardAdminFields, guardPositiveAmount } from '@bsv/mandala/submitGuards'
import { BusyError } from '@bsv/mandala/singleFlight'
import { isAdminAuthInFlight } from '@bsv/mandala/adminAuthGate'
import { useAssetState, useInvalidateAssetState } from '../../hooks/useAssetState'
import { useInvalidateAdminHistory } from '../../hooks/useAdminHistory'
import { useAdvanceAdminAuth } from '../../hooks/useAdminAssets'

interface Props {
  assets: AdminAsset[]
  onActionComplete?: () => void
  /** Controlled mode: when set, use this assetId and hide the header asset-selector chip. */
  assetId?: string
  /** Embedded inside another page (Operations): slim section label instead of a page heading. */
  embedded?: boolean
}

type ActionKey = 'pause' | 'accessMode' | 'freeze' | 'unfreeze' | 'blockIdentity' | 'unblockIdentity' | 'allowIdentity' | 'unallowIdentity' | 'reissue'

export default function RegulatoryControls({ assets, onActionComplete, assetId: controlledAssetId, embedded = false }: Props) {
  const { wallet, messageBoxClient, identityKey } = useWallet()

  // Selected asset
  const [selectedAssetId, setSelectedAssetId] = useState('')
  // Tracks WHICH action is in flight, not just whether one is — so only the
  // pressed button shows its spinner; every other control is merely disabled.
  // busyRef is the sync half: setState is async, so a double-click before
  // re-render would both see busyAction === null without it.
  const [busyAction, setBusyAction] = useState<ActionKey | null>(null)
  const busyRef = useRef(false)
  const busy = busyAction !== null

  // Admin Operations form: which action is selected in the dropdown, and the
  // shared optional reason carried in every action's committed details.
  const [op, setOp] = useState<ActionKey>('freeze')
  const [reason, setReason] = useState('')

  // Freeze/unfreeze
  const [freezeOutpoint, setFreezeOutpoint] = useState('')
  const [selectedFreezeRef, setSelectedFreezeRef] = useState('')

  // Identity search (block/allow)
  const [resolvedIdentityKey, setResolvedIdentityKey] = useState('')
  const [publicKeyInput, setPublicKeyInput] = useState('')

  // Access mode
  const [newAccessMode, setNewAccessMode] = useState<'denylist' | 'allowlist'>('denylist')

  // Reissue
  const [reissueOutpoint, setReissueOutpoint] = useState('')
  const [reissueAmount, setReissueAmount] = useState('')
  const [reissueRecipient, setReissueRecipient] = useState('')
  const [reissueRecipientPublicKey, setReissueRecipientPublicKey] = useState('')
  const [reissuePublicKeyInput, setReissuePublicKeyInput] = useState('')

  // In controlled mode the active asset id comes from the prop; otherwise use internal state
  const activeAssetId = controlledAssetId ?? selectedAssetId

  const asset = assets.find(a => a.assetId === activeAssetId) ?? null
  const decimals = Number(asset?.metadata?.decimals) || 0

  // Shared overlay admin-state query — cached across sections, refetched in
  // the background so controls stay usable while it refreshes.
  const stateQuery = useAssetState(activeAssetId)
  const state: AssetAdminStateView | null = stateQuery.data ?? null
  const invalidateAssetState = useInvalidateAssetState()
  const invalidateAdminHistory = useInvalidateAdminHistory()
  const advanceAdminAuth = useAdvanceAdminAuth()

  // Keep the access-mode segmented control in sync with freshly loaded state.
  useEffect(() => {
    if (stateQuery.data !== undefined) setNewAccessMode(stateQuery.data?.accessMode ?? 'denylist')
  }, [stateQuery.data])

  // Pre-fill reissue amount when a frozen outpoint is selected
  useEffect(() => {
    if (reissueOutpoint === '' || state == null) { return }
    const ref = state.frozenOutpoints.find(r => r.outpoint === reissueOutpoint)
    if (ref != null) {
      setReissueAmount(String(ref.amount))
    }
  }, [reissueOutpoint, state])

  const identitySearch = useIdentitySearch({
    originator: 'mandala',
    wallet: wallet as any,
    onIdentitySelected: (identity) => {
      if (identity) {
        setResolvedIdentityKey(identity.identityKey)
        setPublicKeyInput(identity.identityKey)
      }
    }
  })

  const reissueIdentitySearch = useIdentitySearch({
    originator: 'mandala',
    wallet: wallet as any,
    onIdentitySelected: (identity) => {
      if (identity) {
        setReissueRecipient(identity.identityKey)
        setReissueRecipientPublicKey(identity.identityKey)
        setReissuePublicKeyInput(identity.identityKey)
      }
    }
  })

  // Single boundary for every regulatory action: submit, then advance the
  // cached auth chain immediately so a rapid second action never reads the
  // spent prior while the background refetch is still in flight.
  const submitAction = useCallback(async (
    args: Omit<SubmitAdminActionParams, 'wallet' | 'identityKey' | 'messageBoxClient'>
  ) => {
    const res = await submitAdminAction({
      ...args,
      wallet: wallet as any,
      identityKey: identityKey!,
      messageBoxClient: messageBoxClient ?? undefined
    })
    advanceAdminAuth(args.asset.assetId, res.nextAuthOutpoint, args.details)
    return res
  }, [wallet, identityKey, messageBoxClient, advanceAdminAuth])

  const run = useCallback(async (action: ActionKey, fn: () => Promise<void>) => {
    if (wallet == null || identityKey == null || asset == null) return
    if (busyRef.current) return
    if (isAdminAuthInFlight(asset.assetId)) {
      toast.error('Admin action already in progress for this asset')
      return
    }
    busyRef.current = true
    setBusyAction(action)
    try {
      await fn()
      setReason('')
      // Refresh every cache this action can touch instead of a manual reload.
      await invalidateAssetState(activeAssetId)
      void invalidateAdminHistory(activeAssetId)
      onActionComplete?.()
    } catch (e) {
      if (e instanceof BusyError) {
        toast.error(e.message)
      } else {
        toast.error(`Action failed: ${String(e)}`)
      }
    } finally {
      busyRef.current = false
      setBusyAction(null)
    }
  }, [wallet, identityKey, asset, activeAssetId, invalidateAssetState, invalidateAdminHistory, onActionComplete])

  // ---------------------------------------------------------------------------
  // Pause / unpause
  // ---------------------------------------------------------------------------
  const handlePauseToggle = () => void run('pause', async () => {
    const isPaused = state?.isPaused ?? false
    await submitAction({
      asset: asset!,
      details: withReason({
        kind: isPaused ? 'unpause' : 'pause',
        assetId: asset!.assetId,
        priorOutpoint: asset!.authOutpoint
      }, reason)
    })
    toast.success(isPaused ? 'Asset unpaused' : 'Asset paused')
  })

  // ---------------------------------------------------------------------------
  // Freeze output
  // ---------------------------------------------------------------------------
  const handleFreeze = () => void run('freeze', async () => {
    const op = freezeOutpoint.trim()
    const fields = guardAdminFields({ outpoint: op, requireOutpoint: true })
    if (!fields.ok) { toast.error(fields.reason); return }
    await submitAction({
      asset: asset!,
      details: withReason({ kind: 'freezeOutput', assetId: asset!.assetId, outpoint: op, priorOutpoint: asset!.authOutpoint }, reason)
    })
    toast.success(`Output ${op.slice(0, 16)}… frozen`)
    setFreezeOutpoint('')
  })

  // ---------------------------------------------------------------------------
  // Unfreeze output (from list)
  // ---------------------------------------------------------------------------
  const handleUnfreeze = () => void run('unfreeze', async () => {
    const op = selectedFreezeRef || freezeOutpoint.trim()
    const fields = guardAdminFields({ outpoint: op, requireOutpoint: true })
    if (!fields.ok) { toast.error(fields.reason); return }
    await submitAction({
      asset: asset!,
      details: withReason({ kind: 'unfreezeOutput', assetId: asset!.assetId, outpoint: op, priorOutpoint: asset!.authOutpoint }, reason)
    })
    toast.success(`Output ${op.slice(0, 16)}… unfrozen`)
    setSelectedFreezeRef('')
    setFreezeOutpoint('')
  })

  // ---------------------------------------------------------------------------
  // Block / unblock / allow / unallow identity
  // ---------------------------------------------------------------------------
  const handleIdentityAction = (kind: 'blockIdentity' | 'unblockIdentity' | 'allowIdentity' | 'unallowIdentity') => void run(kind, async () => {
    const key = resolvedIdentityKey || publicKeyInput.trim()
    const fields = guardAdminFields({ identityKey: key, requireIdentity: true })
    if (!fields.ok) { toast.error(fields.reason); return }
    await submitAction({
      asset: asset!,
      details: withReason({ kind, assetId: asset!.assetId, identityKey: key, priorOutpoint: asset!.authOutpoint }, reason)
    })
    const labels: Record<string, string> = { blockIdentity: 'Blocked', unblockIdentity: 'Unblocked', allowIdentity: 'Allowlisted', unallowIdentity: 'Removed from allowlist' }
    toast.success(`${labels[kind]} ${key.slice(0, 12)}…`)
    setResolvedIdentityKey('')
    setPublicKeyInput('')
    identitySearch.handleSelect(null as any, null)
  })

  // ---------------------------------------------------------------------------
  // Set access mode
  // ---------------------------------------------------------------------------
  const handleSetAccessMode = () => void run('accessMode', async () => {
    await submitAction({
      asset: asset!,
      details: withReason({ kind: 'setAccessMode', assetId: asset!.assetId, mode: newAccessMode, priorOutpoint: asset!.authOutpoint }, reason)
    })
    toast.success(`Access mode set to ${newAccessMode}`)
  })

  // ---------------------------------------------------------------------------
  // Reissue (from frozen outpoint)
  // ---------------------------------------------------------------------------
  const handleReissue = () => void run('reissue', async () => {
    const op = reissueOutpoint
    const recipient = reissueRecipient || reissueRecipientPublicKey.trim()
    const fields = guardAdminFields({
      outpoint: op,
      recipient,
      requireOutpoint: true,
      requireRecipient: true
    })
    if (!fields.ok) { toast.error(fields.reason); return }
    const amount = Number(reissueAmount)
    const amountGate = guardPositiveAmount(amount)
    if (!amountGate.ok) { toast.error(amountGate.reason); return }
    const res = await submitAction({
      asset: asset!,
      details: withReason({
        kind: 'reissue',
        assetId: asset!.assetId,
        outpoint: op,
        amount,
        recipient,
        priorOutpoint: asset!.authOutpoint
      }, reason),
      ftOutput: { recipient, amount }
    })
    const summary = `Reissued ${formatAmount(amount, decimals)} ${asset!.label} to ${recipient.slice(0, 12)}…`
    if (res.notified === false) {
      // The reissue is committed (overlay accepted + broadcast); only the
      // recipient's MessageBox remittance is outstanding. It is journaled and
      // retried by reconcileNotifications — do NOT retry the action, a second
      // attempt would die on the spent prior.
      toast.warning(`${summary}; recipient notification pending — it will be retried automatically`)
    } else {
      toast.success(summary)
    }
    setReissueOutpoint('')
    setReissueAmount('')
    setReissueRecipient('')
    setReissueRecipientPublicKey('')
    setReissuePublicKeyInput('')
    reissueIdentitySearch.handleSelect(null as any, null)
  })

  // ---------------------------------------------------------------------------
  // Empty state
  // ---------------------------------------------------------------------------
  if (assets.length === 0) {
    return (
      <div className="bg-card border border-border rounded-md p-[24px_20px] text-center">
        <p className="text-[13px] text-subtle-foreground">Register an asset first.</p>
      </div>
    )
  }

  const isPaused = state?.isPaused ?? false
  const hasFrozen = (state?.frozenOutpoints.length ?? 0) > 0
  const identityKeyEmpty = resolvedIdentityKey === '' && publicKeyInput.trim() === ''

  // Per-action "is this ready to submit" gate for the shared submit button.
  const opDisabled = (() => {
    switch (op) {
      case 'freeze': return freezeOutpoint.trim() === ''
      case 'unfreeze': return freezeOutpoint.trim() === '' && selectedFreezeRef === ''
      case 'blockIdentity':
      case 'unblockIdentity':
      case 'allowIdentity':
      case 'unallowIdentity':
        return identityKeyEmpty
      case 'reissue':
        return reissueOutpoint === '' || reissueAmount === '' || (reissueRecipient === '' && reissuePublicKeyInput.trim() === '')
      default:
        return false
    }
  })()

  const submitLabel: Record<ActionKey, string> = {
    pause: isPaused ? 'Unpause transfers' : 'Pause transfers',
    accessMode: 'Apply access mode',
    freeze: 'Freeze',
    unfreeze: 'Unfreeze',
    blockIdentity: 'Block',
    unblockIdentity: 'Unblock',
    allowIdentity: 'Allow',
    unallowIdentity: 'Unallow',
    reissue: 'Reissue tokens'
  }

  const runSelectedOp = () => {
    switch (op) {
      case 'pause': handlePauseToggle(); break
      case 'accessMode': handleSetAccessMode(); break
      case 'freeze': handleFreeze(); break
      case 'unfreeze': handleUnfreeze(); break
      case 'blockIdentity': handleIdentityAction('blockIdentity'); break
      case 'unblockIdentity': handleIdentityAction('unblockIdentity'); break
      case 'allowIdentity': handleIdentityAction('allowIdentity'); break
      case 'unallowIdentity': handleIdentityAction('unallowIdentity'); break
      case 'reissue': handleReissue(); break
    }
  }

  const submitButtonClassName = op === 'pause' && !isPaused
    ? 'w-full rounded py-[11px] text-[13px] font-semibold mt-3 flex items-center justify-center gap-2 disabled:opacity-50 bg-destructive text-destructive-foreground'
    : op === 'blockIdentity'
      ? 'w-full rounded py-[11px] text-[13px] font-semibold mt-3 flex items-center justify-center gap-2 disabled:opacity-50 bg-card border border-destructive/40 text-destructive'
      : 'w-full rounded py-[11px] text-[13px] font-semibold mt-3 flex items-center justify-center gap-2 disabled:opacity-50'
  const submitButtonStyle = (op === 'pause' && !isPaused) || op === 'blockIdentity'
    ? undefined
    : { background: 'var(--color-primary)', color: 'var(--color-primary-foreground)' }

  return (
    <div className="space-y-[14px]">
      {/* Page heading row — slim section label when embedded in Operations */}
      <div className="flex items-start justify-between gap-4">
        {embedded ? (
          <div className="pt-[6px]">
            <div className="text-[11px] font-medium tracking-[1.2px] text-subtle-foreground uppercase">
              Regulatory controls
            </div>
          </div>
        ) : (
          <div>
            <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.5px', lineHeight: '1.2' }}>
              Regulatory controls
            </h1>
            <p className="text-subtle-foreground text-[13px] mt-[3px]">
              Pause, freeze, block &amp; manage access
              {asset != null ? ` for ${asset.label}` : ''}
            </p>
          </div>
        )}
        {/* Asset selector chip — suppressed in controlled mode */}
        {controlledAssetId == null && (
          <div className="shrink-0 flex flex-col gap-[4px]">
            <label className="text-[10.5px] text-subtle-foreground font-medium">Asset</label>
            <Select
              value={selectedAssetId}
              onChange={e => { setSelectedAssetId(e.target.value) }}
              className="bg-card border border-border rounded px-3 py-[7px] text-[12px] font-medium"
            >
              <option value="">Select asset…</option>
              {assets.map(a => (
                <option key={a.assetId} value={a.assetId}>{a.label}</option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/* Live state strip */}
      <div className="bg-card border border-border rounded-md px-5 py-[14px] flex items-center gap-0">
        {/* Status */}
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">Status</div>
          {state == null ? (
            <div className="text-[13px] font-semibold text-foreground">—</div>
          ) : (
            <div className="flex items-center gap-[6px]">
              <div
                className={`w-[7px] h-[7px] rounded-full shrink-0 ${isPaused ? 'bg-warning' : 'bg-success'}`}
              />
              <span className="text-[13px] font-semibold">{isPaused ? 'Paused' : 'Active'}</span>
            </div>
          )}
        </div>

        <div className="w-px bg-separator self-stretch mx-4" />

        {/* Access mode */}
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">Access mode</div>
          <div className="text-[13px] font-semibold capitalize">
            {state == null ? '—' : (state.accessMode ?? '—')}
          </div>
        </div>

        <div className="w-px bg-separator self-stretch mx-4" />

        {/* Frozen outputs */}
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">Frozen outputs</div>
          <div className="text-[13px] font-semibold">
            {state == null ? '—' : state.frozenOutpoints.length}
          </div>
        </div>

        <div className="w-px bg-separator self-stretch mx-4" />

        {/* Blocked */}
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">Blocked</div>
          <div className="text-[13px] font-semibold">
            {state == null ? '—' : state.blockedIdentities.length}
          </div>
        </div>

        <div className="w-px bg-separator self-stretch mx-4" />

        {/* Allowed */}
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">Allowed</div>
          <div className="text-[13px] font-semibold">
            {state == null ? '—' : state.allowedIdentities.length}
          </div>
        </div>
      </div>

      {/* Admin Operations form — single action selector + dynamic fields + shared reason */}
      <div className="bg-card border border-border rounded-md p-[16px_18px]">
        <div className="text-[13.5px] font-semibold mb-[10px]">Admin operations</div>

        <label className="text-[10.5px] text-subtle-foreground font-medium">Action</label>
        <Select
          value={op}
          onChange={e => setOp(e.target.value as ActionKey)}
          className="w-full mt-1 text-[13px] font-medium"
        >
          <option value="pause">{isPaused ? 'Unpause transfers' : 'Pause transfers'}</option>
          <option value="accessMode">Set access mode</option>
          <option value="freeze">Freeze output</option>
          <option value="unfreeze">Unfreeze output</option>
          <option value="blockIdentity">Block identity</option>
          <option value="unblockIdentity">Unblock identity</option>
          <option value="allowIdentity">Allow identity</option>
          <option value="unallowIdentity">Unallow identity</option>
          <option value="reissue">Reissue from frozen output</option>
        </Select>

        {/* Dynamic fields for the selected action */}
        <div className="mt-3">
          {op === 'pause' && (
            <p className="text-[12px] text-subtle-foreground leading-[1.5]">
              {isPaused
                ? 'Transfers are paused. Resuming will allow all holder transfers.'
                : 'Peer transfers are currently enabled. Pausing stops all holder transfers; admin actions still work.'}
            </p>
          )}

          {op === 'accessMode' && (
            <>
              <p className="text-[12px] text-subtle-foreground leading-[1.5] mb-[13px]">
                Denylist = anyone except blocked. Allowlist = only allowed identities.
              </p>
              {/* Segmented control */}
              <div className="flex bg-muted rounded p-[3px]">
                <button
                  onClick={() => setNewAccessMode('denylist')}
                  className={
                    newAccessMode === 'denylist'
                      ? 'flex-1 text-center py-2 bg-card rounded-sm font-semibold text-[12px] shadow-[0_1px_2px_var(--separator)] text-foreground'
                      : 'flex-1 text-center py-2 font-medium text-[12px] text-subtle-foreground cursor-pointer'
                  }
                >
                  Denylist
                </button>
                <button
                  onClick={() => setNewAccessMode('allowlist')}
                  className={
                    newAccessMode === 'allowlist'
                      ? 'flex-1 text-center py-2 bg-card rounded-sm font-semibold text-[12px] shadow-[0_1px_2px_var(--separator)] text-foreground'
                      : 'flex-1 text-center py-2 font-medium text-[12px] text-subtle-foreground cursor-pointer'
                  }
                >
                  Allowlist
                </button>
              </div>
              {newAccessMode === 'allowlist' && (state?.allowedIdentities.length ?? 0) === 0 && (
                <p className="text-[12px] text-subtle-foreground leading-[1.5] mt-[9px]">
                  Allowlist is empty — transfers stay blocked until you add allowed identities.
                </p>
              )}
            </>
          )}

          {(op === 'freeze' || op === 'unfreeze') && (
            <>
              <input
                value={freezeOutpoint}
                onChange={e => setFreezeOutpoint(e.target.value)}
                placeholder="txid.vout"
                className="bg-muted border border-border rounded px-[13px] py-[11px] font-mono text-[12px] text-subtle-foreground placeholder:text-subtle-foreground w-full outline-none focus:border-ring"
              />
              {hasFrozen && (
                <Select
                  value={selectedFreezeRef}
                  onChange={e => {
                    setSelectedFreezeRef(e.target.value)
                    setFreezeOutpoint(e.target.value)
                  }}
                  className="w-full mt-2 text-[12px]"
                >
                  <option value="">Select frozen output…</option>
                  {state!.frozenOutpoints.map(r => (
                    <option key={r.outpoint} value={r.outpoint}>
                      {r.outpoint.slice(0, 20)}… — {formatAmount(r.amount, decimals)} — {r.owner.slice(0, 10)}…
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}

          {(op === 'blockIdentity' || op === 'unblockIdentity' || op === 'allowIdentity' || op === 'unallowIdentity') && (
            <>
              <p className="text-[12px] text-subtle-foreground leading-[1.5] mb-[13px]">
                This is the per-asset allow/block list. Overlay KYC is a separate chain — admit the key under{' '}
                <Link to="/issuer/identities" className="text-primary font-medium hover:underline">
                  Identities
                </Link>{' '}
                first, or the overlay will still refuse the transfer.
              </p>
              {/* Identity search */}
              <Input
                icon={<Search className="h-[18px] w-[18px]" />}
                value={identitySearch.inputValue}
                onChange={e => identitySearch.handleInputChange(e, e.target.value, 'input')}
                placeholder="Search by name, email…"
                disabled={!!(resolvedIdentityKey && publicKeyInput)}
              />
              {identitySearch.isLoading && (
                <p className="mt-1.5 text-[12px] text-muted-foreground flex items-center gap-1">
                  <Spinner size="sm" tone="brand" className="h-3 w-3" /> Searching…
                </p>
              )}
              {identitySearch.inputValue && identitySearch.identities.length > 0 && !identitySearch.selectedIdentity && (
                <div className="mt-2 max-h-48 overflow-auto rounded-md bg-popover shadow-[var(--shadow-pop)]">
                  {identitySearch.identities.map(identity => {
                    if (typeof identity === 'string') return null
                    return (
                      <div
                        key={identity.identityKey}
                        onClick={() => {
                          identitySearch.handleSelect(null as any, identity)
                          setResolvedIdentityKey(identity.identityKey)
                          setPublicKeyInput(identity.identityKey)
                        }}
                        className="flex cursor-pointer items-center gap-2 border-b border-separator p-3 text-[14px] transition-colors last:border-b-0 hover:bg-muted"
                      >
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
                          {(identity.name ?? identity.identityKey).slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="truncate font-medium">{identity.name || 'Unknown'}</div>
                          <div className="tabular truncate text-[11px] text-subtle-foreground">{identity.identityKey.slice(0, 20)}…</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Paste key */}
              <Input
                value={publicKeyInput}
                onChange={e => {
                  setPublicKeyInput(e.target.value.trim())
                  setResolvedIdentityKey(e.target.value.trim())
                  identitySearch.handleSelect(null as any, null)
                }}
                disabled={!!identitySearch.selectedIdentity}
                placeholder="Or paste identity key"
                className="tabular mt-2"
              />
            </>
          )}

          {op === 'reissue' && (
            !hasFrozen ? (
              <p className="text-[12px] text-subtle-foreground">No frozen outputs available — freeze an output first to reissue from it.</p>
            ) : (
              <>
                {/* Frozen output select */}
                <Select
                  value={reissueOutpoint}
                  onChange={e => setReissueOutpoint(e.target.value)}
                  className="w-full text-[12px]"
                >
                  <option value="">Select frozen output…</option>
                  {state!.frozenOutpoints.map(r => (
                    <option key={r.outpoint} value={r.outpoint}>
                      {r.outpoint.slice(0, 20)}… — {formatAmount(r.amount, decimals)} — {r.owner.slice(0, 10)}…
                    </option>
                  ))}
                </Select>

                {/* Amount — locked to the selected frozen output's value. The
                    overlay's reissue guard rejects any mismatch, so circulation is
                    conserved; keep the field read-only so it can't be understated. */}
                <input
                  type="number"
                  value={reissueAmount}
                  readOnly
                  aria-readonly="true"
                  tabIndex={-1}
                  placeholder="Select a frozen output"
                  className="bg-muted border border-border rounded px-[13px] py-[11px] font-mono text-[12px] text-foreground w-full mt-2 outline-none cursor-not-allowed"
                />
                <p className="text-[11px] text-subtle-foreground mt-1">
                  Locked to the frozen output's amount — reissuing a different value is rejected by the overlay, so circulation stays constant.
                </p>

                {/* Recipient search */}
                <div className="mt-2">
                  <Input
                    icon={<Search className="h-[18px] w-[18px]" />}
                    value={reissueIdentitySearch.inputValue}
                    onChange={e => reissueIdentitySearch.handleInputChange(e, e.target.value, 'input')}
                    placeholder="Search recipient by name…"
                    disabled={!!(reissueRecipient && reissuePublicKeyInput)}
                  />
                  {reissueIdentitySearch.inputValue && reissueIdentitySearch.identities.length > 0 && !reissueIdentitySearch.selectedIdentity && (
                    <div className="mt-2 max-h-48 overflow-auto rounded-md bg-popover shadow-[var(--shadow-pop)]">
                      {reissueIdentitySearch.identities.map(identity => {
                        if (typeof identity === 'string') return null
                        return (
                          <div
                            key={identity.identityKey}
                            onClick={() => {
                              reissueIdentitySearch.handleSelect(null as any, identity)
                              setReissueRecipient(identity.identityKey)
                              setReissueRecipientPublicKey(identity.identityKey)
                              setReissuePublicKeyInput(identity.identityKey)
                            }}
                            className="flex cursor-pointer items-center gap-2 border-b border-separator p-3 text-[14px] transition-colors last:border-b-0 hover:bg-muted"
                          >
                            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
                              {(identity.name ?? identity.identityKey).slice(0, 2).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-medium">{identity.name || 'Unknown'}</div>
                              <div className="tabular truncate text-[11px] text-subtle-foreground">{identity.identityKey.slice(0, 20)}…</div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Paste recipient key */}
                <Input
                  value={reissuePublicKeyInput}
                  onChange={e => {
                    setReissuePublicKeyInput(e.target.value.trim())
                    setReissueRecipient(e.target.value.trim())
                    setReissueRecipientPublicKey(e.target.value.trim())
                    reissueIdentitySearch.handleSelect(null as any, null)
                  }}
                  disabled={!!reissueIdentitySearch.selectedIdentity}
                  placeholder="Or paste recipient identity key"
                  className="tabular mt-2"
                />
              </>
            )
          )}
        </div>

        {/* Shared reason input — carried into the committed action details for every op */}
        <div className="mt-3">
          <label className="text-[10.5px] text-subtle-foreground font-medium">Reason (optional)</label>
          <input
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. court order 12/A"
            className="bg-muted border border-border rounded px-[13px] py-[11px] text-[12px] w-full mt-1 outline-none focus:border-ring"
          />
        </div>

        {/* Shared submit — busyRef + adminAuthGate block re-entry in the
            handler before re-render (refs don't re-render, so they stay out
            of `disabled`) */}
        <button
          type="button"
          onClick={runSelectedOp}
          disabled={busy || asset == null || (op === 'reissue' && !hasFrozen) || opDisabled}
          className={submitButtonClassName}
          style={submitButtonStyle}
        >
          {busyAction === op && <Spinner size="sm" tone="current" />}
          {submitLabel[op]}
        </button>
      </div>
    </div>
  )
}

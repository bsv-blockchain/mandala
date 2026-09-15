import { useRef, useState } from 'react'
import { Search, IdCard } from 'lucide-react'
import { toast } from 'sonner'
import { useIdentitySearch } from '@bsv/identity-react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Spinner } from '../ui/spinner'
import { useWallet } from '../../context/WalletContext'
import { guardIdentityKey } from '@bsv/mandala/submitGuards'
import { registryFlight, BusyError } from '@bsv/mandala/singleFlight'
import { registryIsLive } from '@bsv/mandala/registry'
import { useOverlayRegistry, useRegistryAuth } from '../../hooks/useRegistry'
import { useRegistryMutations } from '../../hooks/useRegistryMutations'
import { cn } from '@/lib/utils'

/**
 * Overlay-wide identity chain (mock KYC). Separate from per-asset allow/block
 * lists in Operations: once this chain has any row, tm_mandala refuses
 * counterparties that are not admitted here.
 */
export default function IdentityRegistry () {
  const { wallet, identityKey } = useWallet()
  const overlayQuery = useOverlayRegistry()
  const authQuery = useRegistryAuth()
  const { open, admit, revoke } = useRegistryMutations()
  const [publicKeyInput, setPublicKeyInput] = useState('')
  const [resolvedIdentityKey, setResolvedIdentityKey] = useState('')
  const startedRef = useRef(false)
  const openStartedRef = useRef(false)

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

  const rows = overlayQuery.data ?? []
  const live = registryIsLive(rows)
  const admitted = rows.filter(r => r.status === 'admitted')
  const revoked = rows.filter(r => r.status === 'revoked')
  const authReady = authQuery.isFetched
  const holdsAuth = authQuery.data != null
  const needsOpen = authReady && !holdsAuth
  const busy = open.isPending || admit.isPending || revoke.isPending

  const targetKey = (resolvedIdentityKey || publicKeyInput).trim()

  const handleOpen = () => {
    if (openStartedRef.current || busy || registryFlight.isHeld()) return
    openStartedRef.current = true
    open.mutate(undefined as void, {
      onSettled: () => { openStartedRef.current = false },
      onError: e => {
        if (e instanceof BusyError) toast.error(e.message)
      }
    })
  }

  const handleAdmit = () => {
    if (startedRef.current || busy || registryFlight.isHeld()) return
    const gate = guardIdentityKey(targetKey)
    if (!gate.ok) {
      toast.error(gate.reason)
      return
    }
    startedRef.current = true
    admit.mutate(targetKey, {
      onSuccess: () => {
        setPublicKeyInput('')
        setResolvedIdentityKey('')
        identitySearch.handleSelect(null as any, null)
      },
      onSettled: () => { startedRef.current = false },
      onError: e => {
        if (e instanceof BusyError) toast.error(e.message)
      }
    })
  }

  const handleRevoke = (key: string) => {
    if (busy || registryFlight.isHeld() || !holdsAuth) return
    revoke.mutate(key)
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[27px] font-semibold tracking-[-0.5px] leading-tight">
          Identities
        </h1>
        <p className="text-subtle-foreground text-[13.5px] mt-1">
          Overlay-wide KYC chain — not the per-asset allowlist in Operations
        </p>
      </div>

      <div className="bg-card border border-border rounded-md px-5 py-[14px] flex items-center gap-0">
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">KYC gate</div>
          <div className="flex items-center gap-[6px]">
            <div className={cn('w-[7px] h-[7px] rounded-full shrink-0', live ? 'bg-warning' : 'bg-success')} />
            <span className="text-[13px] font-semibold">{live ? 'On' : 'Off'}</span>
          </div>
        </div>
        <div className="w-px bg-separator self-stretch mx-4" />
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">Admitted</div>
          <div className="text-[13px] font-semibold tabular-nums">{admitted.length}</div>
        </div>
        <div className="w-px bg-separator self-stretch mx-4" />
        <div className="flex-1 min-w-0">
          <div className="text-[10.5px] text-subtle-foreground mb-[7px] font-medium">Revoked</div>
          <div className="text-[13px] font-semibold tabular-nums">{revoked.length}</div>
        </div>
      </div>

      <p className="text-[12px] text-subtle-foreground leading-[1.55]">
        {live
          ? 'The overlay refuses transfers that name a key not on this list (issuer excepted). Per-asset allow/block lists in Operations are a second, independent gate.'
          : 'Registering a token does not start this chain. Open it below — that admits you as issuer and writes the live authorization into this wallet. After that, every counterparty must be admitted here.'}
      </p>

      {needsOpen && (
        <div className="bg-card border border-border rounded-md p-[18px] flex flex-col gap-4">
          <div>
            <p className="text-[15px] font-semibold leading-tight">
              {live ? 'Re-attach the identity chain' : 'Start the identity chain'}
            </p>
            <p className="text-[12.5px] text-subtle-foreground mt-1 leading-[1.55]">
              {live
                ? 'The overlay already admitted your opening transaction (it is on chain), but this wallet is not listing the 1-sat authorization with its bookkeeping. Re-attach puts that existing UTXO back in the basket — it does not open a second genesis.'
                : 'Asset genesis is a different spine. Opening the chain is a 1-sat issuer transaction on tm_mandala_registry and admits you as issuer.'}
            </p>
          </div>
          <Button
            onClick={handleOpen}
            disabled={busy}
            loading={open.isPending}
            loadingText={live ? 'Re-attaching…' : 'Opening…'}
            className="w-full sm:w-auto"
          >
            {live ? 'Re-attach identity chain' : 'Open identity chain'}
          </Button>
        </div>
      )}

      <div className="bg-card border border-border rounded-md p-[18px] flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded bg-primary/10 text-primary">
            <IdCard className="h-[18px] w-[18px]" />
          </div>
          <div>
            <p className="text-[15px] font-semibold leading-tight">Mock KYC registration</p>
            <p className="text-[11.5px] text-subtle-foreground mt-0.5">
              Admit an arbitrary compressed identity key for testing
            </p>
          </div>
        </div>

        <Input
          icon={<Search className="h-[18px] w-[18px]" />}
          value={identitySearch.inputValue}
          onChange={e => identitySearch.handleInputChange(e, e.target.value, 'input')}
          placeholder="Search by name, email…"
          disabled={!!(resolvedIdentityKey && publicKeyInput)}
        />
        {identitySearch.isLoading && (
          <p className="text-[12px] text-muted-foreground flex items-center gap-1">
            <Spinner size="sm" tone="brand" className="h-3 w-3" /> Searching…
          </p>
        )}
        {identitySearch.inputValue && identitySearch.identities.length > 0 && !identitySearch.selectedIdentity && (
          <div className="max-h-48 overflow-auto rounded-md bg-popover shadow-[var(--shadow-pop)]">
            {identitySearch.identities.map(identity => {
              if (typeof identity === 'string') return null
              return (
                <button
                  type="button"
                  key={identity.identityKey}
                  onClick={() => {
                    identitySearch.handleSelect(null as any, identity)
                    setResolvedIdentityKey(identity.identityKey)
                    setPublicKeyInput(identity.identityKey)
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 border-b border-separator p-3 text-left text-[14px] transition-colors last:border-b-0 hover:bg-muted"
                >
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
                    {(identity.name ?? identity.identityKey).slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{identity.name || 'Unknown'}</div>
                    <div className="tabular truncate text-[11px] text-subtle-foreground">
                      {identity.identityKey.slice(0, 20)}…
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}

        <Input
          value={publicKeyInput}
          onChange={e => {
            setPublicKeyInput(e.target.value.trim())
            setResolvedIdentityKey(e.target.value.trim())
            identitySearch.handleSelect(null as any, null)
          }}
          disabled={!!identitySearch.selectedIdentity}
          placeholder="Or paste compressed identity key (02… / 03…)"
          className="tabular font-mono text-[12px]"
        />

        <Button
          onClick={handleAdmit}
          disabled={busy || targetKey === ''}
          loading={admit.isPending}
          loadingText={needsOpen ? 'Opening chain & admitting…' : 'Admitting…'}
          className="w-full"
        >
          Admit key (mock KYC)
        </Button>
      </div>

      <div>
        <p className="text-[11px] font-medium tracking-[1.2px] text-subtle-foreground uppercase mb-[10px]">
          Registry
        </p>
        {overlayQuery.isLoading ? (
          <div className="bg-card border border-border rounded-md px-[18px] py-8 flex justify-center">
            <Spinner size="sm" tone="brand" />
          </div>
        ) : overlayQuery.isError ? (
          <div className="bg-card border border-border rounded-md px-[18px] py-5 text-[13px] text-destructive">
            Could not load GET /admin/registry — {String(overlayQuery.error)}
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-card border border-border rounded-md px-[18px] py-5 text-[13px] text-subtle-foreground">
            Empty. The overlay is not gating identities until the first admit.
          </div>
        ) : (
          <div className="bg-card border border-border rounded-md overflow-hidden">
            <ul>
              {rows.map(row => {
                const isSelf = identityKey != null && row.identityKey.toLowerCase() === identityKey.toLowerCase()
                return (
                  <li
                    key={row.identityKey}
                    className="flex items-center gap-3 border-b border-separator last:border-b-0 px-[18px] py-[12px]"
                  >
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-[8px] py-[3px] text-[10.5px] font-semibold',
                        row.status === 'admitted'
                          ? 'bg-success/12 text-success'
                          : 'bg-muted text-subtle-foreground'
                      )}
                    >
                      {row.status}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-[12px] tabular truncate">
                        {row.identityKey}
                      </div>
                      {isSelf && (
                        <div className="text-[10.5px] text-subtle-foreground mt-0.5">Issuer (this wallet)</div>
                      )}
                    </div>
                    {row.status === 'admitted' && !isSelf && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || !holdsAuth}
                        loading={revoke.isPending && revoke.variables === row.identityKey}
                        loadingText="Revoking…"
                        onClick={() => handleRevoke(row.identityKey)}
                      >
                        Revoke
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

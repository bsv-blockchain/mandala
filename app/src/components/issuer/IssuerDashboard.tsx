import { useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  LayoutDashboard, ShieldCheck, Banknote, Wallet, Activity, ChevronDown, IdCard
} from 'lucide-react'
import { useWallet } from '../../context/WalletContext'
import { AdminAsset } from '@bsv/mandala/assets'
import { useAdminAssets, useInvalidateAdminAssets } from '../../hooks/useAdminAssets'
import { useAssetAuth, useReattachAssetAuth } from '../../hooks/useAssetAuth'
import { BrandMark } from '../ui/BrandMark'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import IssuerPanel from '../IssuerPanel'
import OverviewSection from './OverviewSection'
import RegisterAssetStrip from './RegisterAssetStrip'
import RegulatoryControls from './RegulatoryControls'
import BankingMock from './BankingMock'
import OverlayActivity from './OverlayActivity'
import TreasurySection from './TreasurySection'
import IdentityRegistry from './IdentityRegistry'

type Section = 'overview' | 'treasury' | 'operations' | 'identities' | 'activity' | 'banking'

const NAV_ITEMS: Array<{
  id: Section
  label: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}> = [
  { id: 'overview',    label: 'Overview',    icon: LayoutDashboard },
  { id: 'treasury',    label: 'Treasury',    icon: Wallet },
  { id: 'operations',  label: 'Operations',  icon: ShieldCheck },
  { id: 'identities',  label: 'Identities',  icon: IdCard },
  { id: 'activity',    label: 'Activity',    icon: Activity },
  { id: 'banking',     label: 'Banking',     icon: Banknote },
]

// ── AssetSwitcher ─────────────────────────────────────────────────────────────

interface AssetSwitcherProps {
  assets: AdminAsset[]
  currentAssetId: string
  onChange: (assetId: string) => void
}

function AssetBadge({ asset }: { asset: AdminAsset }) {
  const ticker = String(asset.metadata?.ticker ?? asset.label.slice(0, 3)).toUpperCase()
  const symbol = { USD: '$', EUR: '€', GBP: '£', CHF: 'Fr' }[ticker] ?? ticker.slice(0, 2)
  return (
    <div className="flex items-center gap-[9px]">
      <div className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-sm bg-accent font-bold text-[12px] text-accent-foreground">
        {symbol}
      </div>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold">{asset.label}</div>
        {ticker && (
          <div className="text-[10.5px] text-subtle-foreground">{ticker}</div>
        )}
      </div>
    </div>
  )
}

function AssetSwitcher({ assets, currentAssetId, onChange }: AssetSwitcherProps) {
  const current = assets.find(a => a.assetId === currentAssetId)

  // Single asset: static chip
  if (assets.length <= 1) {
    return current != null ? (
      <div className="inline-flex items-center rounded border border-border bg-card px-[12px] py-[7px]">
        <AssetBadge asset={current} />
      </div>
    ) : (
      <div className="inline-flex items-center rounded border border-border bg-card px-[12px] py-[7px] text-[13px] text-muted-foreground">
        No assets
      </div>
    )
  }

  // Multiple assets: dropdown
  return (
    <div className="relative inline-block">
      <select
        value={currentAssetId}
        onChange={e => onChange(e.target.value)}
        className="appearance-none cursor-pointer inline-flex items-center rounded border border-border bg-card px-[12px] py-[7px] pr-[32px] text-[13px] font-semibold focus:outline-none focus:ring-2 focus:ring-ring"
        aria-label="Switch asset"
      >
        {assets.map(a => (
          <option key={a.assetId} value={a.assetId}>{a.label}</option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2 h-[14px] w-[14px] text-subtle-foreground"
        strokeWidth={2}
      />
    </div>
  )
}

// ── ReattachAssetAuthorityCard ────────────────────────────────────────────────

/**
 * Shown when the URL names an asset the overlay knows but this wallet's
 * basket does not list. The live admin-auth UTXO is on chain and admitted;
 * only the wallet's bookkeeping for it is gone (a 1-sat P2PKH reclassified
 * as plain change). Re-attach puts that existing UTXO back in the basket —
 * it does not register a second asset. Mirrors the identity-chain card in
 * IdentityRegistry.
 */
function ReattachAssetAuthorityCard({ assetId, authOutpoint }: { assetId: string; authOutpoint: string }) {
  const reattach = useReattachAssetAuth()
  return (
    <div className="bg-card border border-border rounded-md p-[18px] flex flex-col gap-4 mb-[26px]">
      <div>
        <p className="text-[15px] font-semibold leading-tight">Re-attach asset authority</p>
        <p className="text-[12.5px] text-subtle-foreground mt-1 leading-[1.55]">
          The overlay holds admin history for asset {assetId.slice(0, 12)}… with live authority at{' '}
          <span className="font-mono">{authOutpoint.slice(0, 12)}…</span>, but this wallet is not listing that
          1-sat authorization with its bookkeeping. Re-attach puts the existing UTXO back in the basket — it
          does not create a new asset.
        </p>
      </div>
      <Button
        onClick={() => reattach.mutate(assetId)}
        disabled={reattach.isPending}
        loading={reattach.isPending}
        loadingText="Re-attaching…"
        className="w-full sm:w-auto"
      >
        Re-attach asset authority
      </Button>
    </div>
  )
}

// ── IssuerDashboard ───────────────────────────────────────────────────────────

const SECTION_IDS = NAV_ITEMS.map(n => n.id) as string[]

export default function IssuerDashboard() {
  const { identityKey } = useWallet()
  const navigate = useNavigate()
  const params = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: assetsData } = useAdminAssets()
  const invalidateAdminAssets = useInvalidateAdminAssets()
  const assets: AdminAsset[] = assetsData ?? []

  // Section lives in the path (/issuer/:section); asset lives in ?asset — both
  // in the URL so a reload restores exactly where the operator was.
  const section: Section = SECTION_IDS.includes(params.section ?? '')
    ? (params.section as Section)
    : 'overview'
  const currentAssetId = searchParams.get('asset') ?? ''

  const goSection = (id: Section) => {
    const qs = searchParams.toString()
    navigate(`/issuer/${id}${qs ? `?${qs}` : ''}`)
  }
  const selectAsset = (assetId: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('asset', assetId)
      return next
    })
  }

  // Normalise an unknown /issuer/:section, keeping ?asset. The old standalone
  // /issuer/regulatory page now lives inside Operations.
  useEffect(() => {
    if (params.section != null && !SECTION_IDS.includes(params.section)) {
      const qs = searchParams.toString()
      const target = params.section === 'regulatory' ? 'operations' : 'overview'
      navigate(`/issuer/${target}${qs ? `?${qs}` : ''}`, { replace: true })
    }
  }, [params.section, searchParams, navigate])

  const currentAsset = assets.find(a => a.assetId === currentAssetId) ?? null

  // The URL names an asset this basket does not list. Ask the overlay whether
  // it holds admin history for it — if so, the wallet lost the auth output's
  // bookkeeping and the re-attach card is the way back (A10). Only consulted
  // in that case; a basket-listed asset never hits the overlay for this.
  const missingFromBasket = currentAssetId !== '' && currentAsset == null
  const authQuery = useAssetAuth(missingFromBasket ? currentAssetId : '')
  const overlayKnowsAsset = missingFromBasket && authQuery.data != null

  // Auto-select the first asset into ?asset when the URL has no valid selection.
  useEffect(() => {
    if (assets.length === 0) return
    const valid = currentAssetId !== '' && assets.some(a => a.assetId === currentAssetId)
    if (valid) return
    // Keep a URL asset the overlay still knows (or has not yet answered for):
    // replacing it would hide the re-attach card behind the first basket asset.
    if (missingFromBasket && (authQuery.isPending || authQuery.data != null)) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('asset', assets[0].assetId)
      return next
    }, { replace: true })
  }, [assets, currentAssetId, missingFromBasket, authQuery.isPending, authQuery.data, setSearchParams])

  // Derive issuer initials for the footer chip from identityKey (first 2 hex chars → uppercase)
  const initials = identityKey != null && identityKey.length >= 4
    ? identityKey.slice(2, 4).toUpperCase()
    : 'IS'

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      {/* ── LEFT SIDEBAR NAV ── */}
      <aside className="flex w-[230px] shrink-0 flex-col border-r border-separator bg-muted px-3.5 py-5">
        {/* Brand */}
        <div className="px-2 pb-5">
          <BrandMark size="md" wordmark sublabel="ISSUER CONSOLE" />
        </div>

        {/* Nav items */}
        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = section === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => goSection(id)}
                className={cn(
                  'relative flex items-center gap-[11px] rounded px-3 py-[10px] text-left text-[13px] font-medium',
                  'transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-card text-foreground font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                style={active ? { boxShadow: '0 1px 2px var(--separator)' } : undefined}
              >
                {/* Brass left accent bar for active item */}
                {active && (
                  <span
                    className="absolute left-0 top-[9px] bottom-[9px] w-[3px] rounded-r-[3px]"
                    style={{ background: 'var(--brass)' }}
                  />
                )}
                <Icon
                  className={cn('h-[17px] w-[17px] shrink-0', active ? 'text-primary' : 'text-current')}
                  strokeWidth={1.9}
                />
                {label}
              </button>
            )
          })}
        </nav>

        {/* Footer issuer chip */}
        <div
          className="mt-auto flex items-center gap-[10px] rounded border border-separator bg-background px-[10px] py-3"
        >
          <div
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-sm bg-primary font-semibold text-[11px] text-primary-foreground"
          >
            {initials}
          </div>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold leading-[1.1]">
              {identityKey != null ? `${identityKey.slice(0, 12)}…` : 'Issuer'}
            </div>
            <div className="mt-[2px] text-[10px] leading-[1.1] text-subtle-foreground">
              Verified issuer
            </div>
          </div>
        </div>
      </aside>

      {/* ── MAIN AREA ── */}
      <main className="flex-1 overflow-y-auto bg-background">
        {/* Top bar with asset switcher — Register a new asset lives here too,
            in line with the switcher, only on the Overview page. */}
        <div className="flex items-center justify-between gap-4 border-b border-separator bg-background px-[30px] py-[14px]">
          <AssetSwitcher
            assets={assets}
            currentAssetId={currentAssetId}
            onChange={selectAsset}
          />
          {section === 'overview' && (
            <div className="flex-1">
              <RegisterAssetStrip />
            </div>
          )}
        </div>

        <div className="p-[26px_30px]">
          {overlayKnowsAsset && (
            <ReattachAssetAuthorityCard assetId={currentAssetId} authOutpoint={authQuery.data!.authOutpoint} />
          )}
          {section === 'overview' && (
            <OverviewSection
              assetId={currentAssetId}
              asset={currentAsset}
              onReload={() => void invalidateAdminAssets()}
            />
          )}
          {section === 'treasury' && (
            <TreasurySection assetId={currentAssetId} asset={currentAsset} />
          )}
          {section === 'operations' && (
            assets.length === 0 ? (
              // Nothing on this page is actionable without an asset — show only
              // the pointer to Overview (where registration lives), no dead controls.
              assetsData != null && (
                <div className="bg-card border border-border rounded-md p-[24px_20px] text-center">
                  <p className="text-[13px] text-subtle-foreground">
                    Register an asset first — you can do that from the Overview page.
                  </p>
                </div>
              )
            ) : (
              <div className="space-y-[26px]">
                <IssuerPanel assetId={currentAssetId} />
                <RegulatoryControls
                  embedded
                  assets={assets}
                  assetId={currentAssetId}
                  onActionComplete={() => void invalidateAdminAssets()}
                />
              </div>
            )
          )}
          {section === 'identities' && (
            <IdentityRegistry />
          )}
          {section === 'activity' && (
            <OverlayActivity
              assetId={currentAssetId}
              decimals={Number(currentAsset?.metadata?.decimals) || 0}
              standalone
            />
          )}
          {section === 'banking' && (
            <BankingMock assetId={currentAssetId} />
          )}
        </div>
      </main>
    </div>
  )
}

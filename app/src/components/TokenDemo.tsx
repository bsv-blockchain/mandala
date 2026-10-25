import { AlertTriangle } from 'lucide-react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'
import { Spinner } from './ui/spinner'
import IssuerDashboard from './issuer/IssuerDashboard'
import { BrandMark } from './ui/BrandMark'

// ─── Routing model ──────────────────────────────────────────────────────────
// The console is the issuer/admin tool only (B8). The section lives in the
// path and the asset in ?asset=<id>, so a reload restores the view:
//   /issuer/:section   (?asset=<id> selects the asset)
// Holders send and receive in their BRC-207 wallet (bsv-desktop, bsv-wallet),
// which hosts the color module and ledger the console does not have.

// ─── Main component ───────────────────────────────────────────────────────────

export default function TokenDemo() {
  const { isInitialized, error, isIssuer } = useWallet()

  // ── Loading state ──
  if (!isInitialized) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-4 animate-in">
          <Spinner size="lg" tone="brand" />
          <p className="text-[14px] font-medium text-muted-foreground">Connecting your wallet…</p>
        </div>
      </div>
    )
  }

  // ── Error state ──
  if (error != null) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center animate-in">
          <div className="grid h-12 w-12 place-items-center rounded-md bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Couldn't connect</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{error}</p>
        </div>
      </div>
    )
  }

  // ── Issuer: full-viewport console, section in the path ──
  if (isIssuer) {
    return (
      <Routes>
        <Route path="/issuer/:section" element={<IssuerDashboard />} />
        <Route path="*" element={<Navigate to="/issuer/overview" replace />} />
      </Routes>
    )
  }

  // ── Not the issuer: the console has nothing for this identity ──
  return <NotIssuer />
}

/** Shown to any identity other than the configured issuer (no holder views, B8). */
function NotIssuer() {
  const { identityKey, overlayIdentityKey } = useWallet()
  const abbr = (k: string | null): string => k == null ? '—' : `${k.slice(0, 10)}…${k.slice(-6)}`
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center animate-in">
        <BrandMark />
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Issuer console</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          This console is for the asset issuer only. Connect the wallet that holds the issuer identity to
          manage assets and pay out from the treasury. To send or receive tokens, use a BRC-207 wallet
          (BSV Desktop or the BSV wallet app).
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-left text-[12px]">
          <dt className="text-subtle-foreground">Connected</dt>
          <dd className="tabular font-mono">{abbr(identityKey)}</dd>
          <dt className="text-subtle-foreground">Issuer</dt>
          <dd className="tabular font-mono">{abbr(overlayIdentityKey)}</dd>
        </dl>
      </div>
    </div>
  )
}

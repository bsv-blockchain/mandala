import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { WalletClient } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'
import { toast } from 'sonner'
import { OVERLAY_IDENTITY_KEY, MESSAGEBOX_URL } from '@bsv/mandala'
import { reconcileWallet } from '@bsv/mandala/reconcile'
import { reconcileNotifications } from '@bsv/mandala/notifyJournal'

interface WalletState {
  wallet: WalletClient | null
  messageBoxClient: MessageBoxClient | null
  identityKey: string | null
  /** The configured overlay identity key (S5); null until the wallet initialises or when config failed. */
  overlayIdentityKey: string | null
  isIssuer: boolean
  isInitialized: boolean
  error: string | null
}

const WalletContext = createContext<WalletState>({
  wallet: null, messageBoxClient: null, identityKey: null, overlayIdentityKey: null,
  isIssuer: false, isInitialized: false, error: null
})

export const useWallet = (): WalletState => useContext(WalletContext)

export function WalletProvider({ children, configError = null }: { children: ReactNode; configError?: string | null }) {
  const [state, setState] = useState<WalletState>({
    wallet: null, messageBoxClient: null, identityKey: null, overlayIdentityKey: null,
    isIssuer: false, isInitialized: false, error: null
  })

  useEffect(() => {
    // S5 fail closed: with a bad config (or, defensively, no overlay key bound
    // in the lib) no WalletClient is ever constructed, so no wallet flow,
    // reconcile or MessageBox call can run against an unknown overlay.
    const failClosed = configError ?? (OVERLAY_IDENTITY_KEY === ''
      ? 'VITE_OVERLAY_IDENTITY_KEY is not configured; refusing to start (fail closed).'
      : null)
    if (failClosed != null) {
      setState({
        wallet: null, messageBoxClient: null, identityKey: null, overlayIdentityKey: null,
        isIssuer: false, isInitialized: true, error: failClosed
      })
      return
    }
    const overlayIdentityKey = OVERLAY_IDENTITY_KEY
    // StrictMode double-invokes this effect: the cancelled flag stops the
    // stale run from clobbering state, and the reconcile passes below are
    // web-lock guarded so an overlapping second run skips instead of
    // double-broadcasting/aborting.
    let cancelled = false
    const init = async () => {
      try {
        const wallet = new WalletClient()
        const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
        const messageBoxClient = new MessageBoxClient({
          host: MESSAGEBOX_URL, walletClient: wallet as any,
          enableLogging: false, networkPreset: 'mainnet'
        })
        if (cancelled) return
        setState({
          wallet, messageBoxClient, identityKey, overlayIdentityKey,
          isIssuer: identityKey === overlayIdentityKey,
          isInitialized: true, error: null
        })
        // Recover half-failed flows from previous sessions: re-broadcast
        // overlay-accepted txs and retry pending aborts (see reconcile.ts).
        // sweep: false — BRC-207 hand-overs are long-lived noSend actions held
        // until the recipient ACKs and the sender settles (B5); the bulk sweep
        // cannot tell them from abandoned ones and must never abort one
        // (0207:418-423, contract D27/§8.1). The lib also skips the sweep while
        // any signed/delivered journal entry exists; this is defence in depth.
        // Temporary: the single drainNow() recovery path replaces this call.
        void reconcileWallet(wallet as any, { sweep: false }).then(r => {
          const recovered = r.rebroadcast.length + r.aborted.length + r.swept
          if (recovered > 0) {
            console.info('[mandala] reconciled pending transactions:', r)
            toast.info(`Recovered ${recovered} pending transaction${recovered === 1 ? '' : 's'}`)
          }
        }).catch(e => console.warn('[mandala] reconcile failed:', e))
        // Deliver recipient notifications a crashed/failed send left pending —
        // without this the recipient never learns about their on-chain funds.
        void reconcileNotifications(messageBoxClient).then(d => {
          if (d.length > 0) console.info('[mandala] delivered pending transfer notifications:', d)
        }).catch(e => console.warn('[mandala] notification retry failed:', e))
      } catch (e) {
        if (!cancelled) {
          setState(s => ({ ...s, isInitialized: true, error: 'Failed to initialize wallet. Ensure a BRC-100 wallet (Metanet) is running.' }))
        }
      }
    }
    void init()
    return () => { cancelled = true }
  }, [configError])

  return <WalletContext.Provider value={state}>{children}</WalletContext.Provider>
}

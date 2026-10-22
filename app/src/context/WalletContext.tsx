import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react'
import { WalletClient } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'
import { toast } from 'sonner'
import {
  OVERLAY_IDENTITY_KEY,
  MESSAGEBOX_URL,
  journalListHandovers,
  markHandoverDelivered,
  reconcileWallet
} from '@bsv/mandala'
import { reconcileNotifications } from '@bsv/mandala/notifyJournal'
import { drainHandovers, type DrainReport, type DrainState } from '../lib/mandala/handoverDrain'

/** Unforced drain tick; `DrainState.nextAt` decides whether a tick does anything. */
const DRAIN_TICK_MS = 15_000

interface WalletState {
  wallet: WalletClient | null
  messageBoxClient: MessageBoxClient | null
  identityKey: string | null
  /** The configured overlay identity key (S5); null until the wallet initialises or when config failed. */
  overlayIdentityKey: string | null
  isIssuer: boolean
  isInitialized: boolean
  error: string | null
  /**
   * The app's single recovery entry (B5): one `drainHandovers` pass over the
   * lib journal — the only caller of `reconcileNotifications` and
   * `reconcileWallet`. `force` ignores the backoff (startup, `online`, after a
   * send or an issuer operation). Resolves `undefined` when the wallet is not
   * ready or config failed; never rejects.
   */
  drainNow: (o?: { force?: boolean }) => Promise<DrainReport | undefined>
}

type WalletFields = Omit<WalletState, 'drainNow'>

const notReady = async (): Promise<undefined> => undefined

const WalletContext = createContext<WalletState>({
  wallet: null, messageBoxClient: null, identityKey: null, overlayIdentityKey: null,
  isIssuer: false, isInitialized: false, error: null, drainNow: notReady
})

export const useWallet = (): WalletState => useContext(WalletContext)

export function WalletProvider({ children, configError = null }: { children: ReactNode; configError?: string | null }) {
  const [state, setState] = useState<WalletFields>({
    wallet: null, messageBoxClient: null, identityKey: null, overlayIdentityKey: null,
    isIssuer: false, isInitialized: false, error: null
  })

  // In memory, per tab: the drain's backoff. A reload resets it (one early pass).
  const drainState = useRef<DrainState>({ failures: 0, nextAt: 0 })
  // Live values for the stable drainNow below (no re-registration per render).
  // Updated after commit; declared before the trigger effect, so it runs first.
  const live = useRef({ state, configError })
  useEffect(() => { live.current = { state, configError } }, [state, configError])

  const drainNow = useCallback(async (o?: { force?: boolean }): Promise<DrainReport | undefined> => {
    const { state: s, configError: ce } = live.current
    if (s.wallet == null || s.messageBoxClient == null || s.identityKey == null || ce != null || s.error != null) return undefined
    try {
      const report = await drainHandovers({
        wallet: s.wallet as any,
        identityKey: s.identityKey,
        messageBoxClient: s.messageBoxClient,
        now: Date.now,
        state: drainState.current,
        list: journalListHandovers,
        markDelivered: markHandoverDelivered,
        redeliver: reconcileNotifications,
        reconcile: reconcileWallet
      }, o)
      const r = report.reconcile
      if (r != null) {
        const recovered = r.rebroadcast.length + r.aborted.length + r.resubmitted.length
        if (recovered > 0) {
          console.info('[mandala] reconciled pending transactions:', r)
          toast.info(`Recovered ${recovered} pending transaction${recovered === 1 ? '' : 's'}`)
        }
      }
      if (report.redeliverError != null) console.warn('[mandala] notification retry failed:', report.redeliverError)
      if (report.reconcileError != null) console.warn('[mandala] reconcile failed:', report.reconcileError)
      return report
    } catch (e) {
      console.warn('[mandala] recovery pass failed:', e)
      return undefined
    }
  }, [])

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
    // stale run from clobbering state. Recovery runs from the drain triggers
    // below, never from here.
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
      } catch (e) {
        if (!cancelled) {
          setState(s => ({ ...s, isInitialized: true, error: 'Failed to initialize wallet. Ensure a BRC-100 wallet (Metanet) is running.' }))
        }
      }
    }
    void init()
    return () => { cancelled = true }
  }, [configError])

  // Recovery triggers, once the wallet is ready. Recover half-finished work
  // from earlier sessions (redeliver 'signed' hand-overs, settle 'delivered'
  // ones, rebroadcast accepted txs, retry pending aborts and notifications)
  // through the one drain: forced at startup and on `online`, otherwise a
  // 15 s tick and tab-visible calls that the drain's own backoff gates (5 min
  // idle), so this is never a fixed 15 s recovery loop. The drain is
  // single-flight per tab and web-locked across tabs, and runs reconcile with
  // `{ sweep: false }`: BRC-207 hand-overs are long-lived noSend actions the
  // bulk sweep must never abort (0207:418-423, contract D27/§8.1). The
  // cleanup clears everything, so a StrictMode double effect leaves one
  // interval and one set of listeners.
  const ready = state.wallet != null && state.messageBoxClient != null && state.identityKey != null
  useEffect(() => {
    if (!ready) return
    void drainNow({ force: true })
    const onOnline = (): void => { void drainNow({ force: true }) }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void drainNow()
    }
    const tick = setInterval(() => { void drainNow() }, DRAIN_TICK_MS)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(tick)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ready, drainNow])

  const value = useMemo<WalletState>(() => ({ ...state, drainNow }), [state, drainNow])
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

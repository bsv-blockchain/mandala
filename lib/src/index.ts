/**
 * @bsv/mandala 0.5.0: issuer console and holder client for Mandala assets on
 * BRC-162 1Color, with holder value moving only through BRC-207 receipts.
 *
 * - Issuer / admin / registry flows (Mandala keys, `mandala treasury`
 *   basket) are overlay-first: noSend, overlay /submit, then sendWith, with
 *   journaled recovery (overlay.ts, reconcile.ts).
 * - Holder hand-overs (B7): the wallet host runtime signs a plain-noSend
 *   hand-over through `@bsv/color-permission-module` with the Mandala
 *   issuer-v1 profile, sends the v4 body (receipt fields + σ / envelope
 *   evidence) on MessageBox `mandala-color`, and submits after the ACK. The
 *   recipient host submits (online) or runs COVER (offline) before it
 *   internalizes the plain BRC-207 receipt.
 *
 * The core entry is React Native safe and never imports the color module;
 * the wallet-side profile handler lives in `@bsv/mandala/profile`. Retained
 * building blocks also resolve as subpaths, e.g. `@bsv/mandala/history`.
 */
import { WalletClient, WalletInterface } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'
import { configureMandala, MandalaEndpoints, MESSAGEBOX_URL, OVERLAY_IDENTITY_KEY } from './constants.js'
import {
  AdminAsset,
  listAdminAssets,
  submitAdminAction,
  SubmitAdminActionParams,
  SubmitAdminActionResult
} from './assets.js'
import { registerAsset, issueTokens, redeemTokens, IssuerOpResult, RegisterResult } from './issuerOps.js'
import { reconcileWallet, ReconcileOptions, ReconcileResult } from './reconcile.js'
import { deliverHandover, HandoverResult, sendHandover, settleHandover, SettleResult } from './handover.js'
import { receiveHandovers, ReceiveResult } from './receive.js'
import type { HostLedger } from './hostLedger.js'
import { normalizeKey } from './keys.js'
import { payoutTokens, PayoutParams, PayoutResult } from './payout.js'

export interface MandalaClientOptions extends MandalaEndpoints {
  /** BRC-100 wallet; defaults to a new WalletClient (browser substrate). */
  wallet?: WalletInterface
  /**
   * The host ledger shared with the wallet's Mandala issuer-v1 handler (B7).
   * Only a wallet host runtime has one. Without it `send` throws (the tip's
   * envelope is unreachable) and `receive` cannot credit offline.
   */
  ledger?: HostLedger
  /** Host-only `color.markSettled(txid)` of the color module (B7). */
  markSettled?: (txid: string) => Promise<void>
  /** The host's underlying wallet (B7: the hand-over envelope is built from its custody). Required for `send`. */
  hostWallet?: WalletInterface
}

export type AdminArgs = Omit<SubmitAdminActionParams, 'wallet' | 'messageBoxClient' | 'identityKey'>

export interface SendArgs {
  assetId: string
  /** The recipient's identity key; this wallet's own key is a self-send. */
  counterparty: string
  /** Exact base units, 1..2^64-1. */
  amount: bigint
  note?: string
  /** Default true (A′ on the receipt); forced false for a self-send. */
  blind?: boolean
}

export interface SendOutcome {
  /** The signed hand-over, journaled before `send` resolved. */
  handover: HandoverResult
  /**
   * True when the recipient holds the hand-over: delivered on MessageBox, or
   * a self-send (which owes no delivery). False when delivery failed; the
   * notification is journaled and `reconcileNotifications` redelivers it.
   * Never re-run `send` for the same payment.
   */
  notified: boolean
  /**
   * The settle verdict when settle ran and returned one. Undefined when it
   * did not run (delivery failed) or threw (e.g. no overlay identity key);
   * reconcile settles a delivered hand-over later either way.
   */
  settle?: SettleResult
}

export type PayoutArgs = Omit<PayoutParams, 'wallet' | 'identityKey' | 'messageBoxClient'>

export interface MandalaClient {
  wallet: WalletInterface
  identityKey: () => Promise<string>
  /**
   * Holder hand-over: `sendHandover`, then `deliverHandover` (another
   * recipient), then `settleHandover` against the configured overlay key
   * (delivered or self). Throws only what `sendHandover` throws (bad
   * arguments, S5, BusyError on a concurrent send, a wallet without the
   * color module); a delivery or settle failure is reported, not thrown,
   * because the hand-over is already signed and journaled.
   */
  send: (args: SendArgs) => Promise<SendOutcome>
  /**
   * Receive pending hand-overs into BRC-207 receipts. One `processed` set
   * lives as long as the client, so a declined consent is not re-prompted in
   * this session and overlapping passes skip each other's messages.
   */
  receive: (args?: { assetId?: string }) => Promise<ReceiveResult>
  /** Issuer payout (B4): treasury value to a holder `p color` output with a BRC-207 receipt. */
  payout: (args: PayoutArgs) => Promise<PayoutResult>
  /**
   * Submit a regulatory/treasury admin action (freeze, pause, reissue, …).
   * `notified` is false when a reissue committed but the recipient notify is
   * still pending (journaled; retried by reconcile) — never retry the action.
   */
  admin: (args: AdminArgs) => Promise<SubmitAdminActionResult>
  /** Issuer treasury ops. */
  register: (args: { label: string, ticker: string, decimals: number }) => Promise<RegisterResult>
  /** `depositHash`: sha256 hex of the deposit record, committed on-chain as bankRef. */
  issue: (args: { asset: AdminAsset, amount: bigint, depositHash?: string }) => Promise<IssuerOpResult>
  redeem: (args: { asset: AdminAsset, amount: bigint, balance?: bigint }) => Promise<IssuerOpResult>
  assets: () => Promise<AdminAsset[]>
  /**
   * Self-heal half-finished state (stuck aborts, pending broadcasts,
   * delivered hand-overs). Pass `{ sweep: false }` from a host that manages
   * its own noSend actions — the bulk sweep cannot tell those from abandoned
   * ones.
   */
  reconcile: (opts?: ReconcileOptions) => Promise<ReconcileResult>
}

export function createMandalaClient (opts: MandalaClientOptions = {}): MandalaClient {
  configureMandala(opts)
  const wallet = opts.wallet ?? new WalletClient()
  // Lazy so client construction never does I/O; both resolve once.
  let identityKeyPromise: Promise<string> | undefined
  const identityKey = (): Promise<string> => {
    if (identityKeyPromise != null) return identityKeyPromise
    const p = wallet.getPublicKey({ identityKey: true }).then(r => r.publicKey)
    // A failed lookup (wallet locked, not yet connected) must not stick.
    p.catch(() => { if (identityKeyPromise === p) identityKeyPromise = undefined })
    identityKeyPromise = p
    return p
  }
  let messageBoxPromise: Promise<MessageBoxClient> | undefined
  const messageBox = (): Promise<MessageBoxClient> => {
    messageBoxPromise ??= Promise.resolve(new MessageBoxClient({
      host: opts.messageBoxUrl ?? MESSAGEBOX_URL,
      walletClient: wallet as any,
      enableLogging: false
    }))
    return messageBoxPromise
  }
  const processed = new Set<string>()

  const send = async (a: SendArgs): Promise<SendOutcome> => {
    const me = await identityKey()
    const counterparty = normalizeKey(a.counterparty, 'counterparty')
    const handover = await sendHandover({
      wallet,
      identityKey: me,
      assetId: a.assetId,
      amount: a.amount,
      recipientKey: counterparty,
      ...(a.blind != null ? { blind: a.blind } : {}),
      ...(a.note != null ? { note: a.note } : {}),
      ledger: opts.ledger as HostLedger,
      hostWallet: opts.hostWallet as WalletInterface
    })
    const self = counterparty === me
    let notified = self
    if (!self) {
      try {
        await deliverHandover({
          messageBoxClient: await messageBox(),
          recipientKey: counterparty,
          handover
        })
        notified = true
      } catch (e) {
        // Journaled 'signed' with its notification: redelivery covers it, and
        // an undelivered hand-over is never submitted by its sender (B5).
        console.warn(`[mandala] hand-over ${handover.txid} is signed but its delivery failed; reconcileNotifications retries it:`, e)
      }
    }
    if (!notified) return { handover, notified }
    try {
      // The live binding, read now: configureMandala may have run since construction.
      const settle = await settleHandover({
        wallet,
        handover,
        assetId: a.assetId,
        overlayIdentityKey: OVERLAY_IDENTITY_KEY,
        ...(opts.ledger != null ? { ledger: opts.ledger } : {}),
        ...(opts.markSettled != null ? { markSettled: opts.markSettled } : {})
      })
      return { handover, notified, settle }
    } catch (e) {
      // The entry is 'delivered': reconcile re-submits the journaled bytes.
      console.warn(`[mandala] hand-over ${handover.txid} was delivered but could not be settled now; reconcile retries it:`, e)
      return { handover, notified }
    }
  }

  return {
    wallet,
    identityKey,
    send,
    receive: async (a = {}) =>
      await receiveHandovers({
        wallet,
        messageBoxClient: await messageBox(),
        ...(a.assetId != null ? { assetId: a.assetId } : {}),
        ...(opts.ledger != null ? { ledger: opts.ledger } : {}),
        ...(opts.markSettled != null ? { markSettled: opts.markSettled } : {}),
        processed
      }),
    payout: async a =>
      await payoutTokens({ ...a, wallet, identityKey: await identityKey(), messageBoxClient: await messageBox() }),
    admin: async args =>
      submitAdminAction({
        ...args,
        wallet: wallet as any,
        messageBoxClient: args.ftOutput != null ? await messageBox() : undefined,
        identityKey: await identityKey()
      } as SubmitAdminActionParams),
    register: async args =>
      registerAsset({ wallet: wallet as any, identityKey: await identityKey(), ...args }),
    issue: async ({ asset, amount, depositHash }) =>
      issueTokens({ wallet: wallet as any, identityKey: await identityKey(), asset, amount, depositHash }),
    redeem: async ({ asset, amount, balance }) =>
      redeemTokens({ wallet: wallet as any, identityKey: await identityKey(), asset, amount, balance }),
    assets: async () => listAdminAssets(wallet),
    reconcile: async (opts = {}) => reconcileWallet(wallet as any, opts)
  }
}

// The core surface (C§8.1). Never `./profile*`: that entry imports the color module.
export * from './constants.js'
export * from './storage.js'
export * from './metadata.js'
export * from './brc162.js'
export * from './authority.js'
export * from './txJournal.js'
export * from './overlay.js'
export * from './admission.js'
export * from './attestation.js'
export * from './assets.js'
export * from './issuerOps.js'
export * from './registry.js'
export * from './registryRecover.js'
export * from './assetRecover.js'
export * from './blinding.js'
export * from './blindingJournal.js'
export * from './linkage.js'
export * from './reconcile.js'
export * from './submitGuards.js'
export * from './singleFlight.js'
export * from './adminAuthGate.js'
export * from './amount.js'
export * from './notifyJournal.js'
export * from './webLocks.js'
export * from './feeRate.js'
export * from './naming.js'
export * from './plan.js'
export * from './overlayLookup.js'
export * from './receipt.js'
export * from './payout.js'
export * from './encoding.js'
export * from './handover.js'
export * from './receive.js'
export * from './history.js'
export * from './hostLedger.js'
export * from './bundle.js'
export * from './hostEnvelope.js'
export * from './hopCheck.js'
export * from './evidence.js'
export * from './receiptSettle.js'

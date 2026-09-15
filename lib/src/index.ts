/**
 * @bsv/mandala — token client for Mandala overlay assets.
 *
 * High-level facade: create a client once, then send / receive / admin any
 * asset. Every pipeline is overlay-first (noSend → overlay submit → sendWith
 * broadcast) with journaled recovery; see transfer.ts / overlay.ts /
 * reconcile.ts for the mechanics.
 *
 * Lower-level building blocks (coin selection, guards, journal, reconcile)
 * are exported via subpaths, e.g. `@bsv/mandala/ftSelect`.
 */
import { WalletClient, WalletInterface } from '@bsv/sdk'
import { MessageBoxClient } from '@bsv/message-box-client'
import { configureMandala, MandalaEndpoints, MESSAGEBOX_URL } from './constants.js'
import { transferTokens, TransferResult } from './transfer.js'
import { EvidenceSource } from './handover.js'
import { receiveTokens, ReceiveResult, SettleFn } from './receive.js'
import {
  AdminAsset,
  listAdminAssets,
  submitAdminAction,
  SubmitAdminActionParams,
  SubmitAdminActionResult
} from './assets.js'
import { registerAsset, issueTokens, redeemTokens, IssuerOpResult, RegisterResult } from './issuerOps.js'
import { reconcileWallet, ReconcileResult } from './reconcile.js'

export interface MandalaClientOptions extends MandalaEndpoints {
  /** BRC-100 wallet; defaults to a new WalletClient (browser substrate). */
  wallet?: WalletInterface
}

export interface SendArgs {
  assetId: string
  /** Recipient identity key (hex compressed pubkey). */
  counterparty: string
  /** Base units (integer). */
  amount: number
  /**
   * `'handover'` builds and signs the payment but contacts NOTHING — the
   * recipient submits (offline settlement §0.1). Defaults to `'submit'`, the
   * online rail.
   */
  mode?: 'submit' | 'handover'
  /** Evidence source for `'handover'` mode; defaults to the lib's journals. */
  evidence?: EvidenceSource
}

export interface ReceiveArgs {
  /** Only accept transfers of this asset; others stay pending. */
  assetId?: string
  /** Override how a credited offline hand-over is settled with the overlay. */
  settle?: SettleFn
}

export type AdminArgs = Omit<SubmitAdminActionParams, 'wallet' | 'messageBoxClient' | 'identityKey'>

export interface MandalaClient {
  wallet: WalletInterface
  identityKey: () => Promise<string>
  /** Transfer tokens to a counterparty (overlay-gated, journaled). */
  send: (args: SendArgs) => Promise<TransferResult>
  /** Internalize + acknowledge all pending incoming transfers. */
  receive: (args?: ReceiveArgs) => Promise<ReceiveResult>
  /**
   * Submit a regulatory/treasury admin action (freeze, pause, reissue, …).
   * `notified` is false when a reissue committed but the recipient notify is
   * still pending (journaled; retried by reconcile) — never retry the action.
   */
  admin: (args: AdminArgs) => Promise<SubmitAdminActionResult>
  /** Issuer treasury ops. */
  register: (args: { label: string, ticker: string, decimals: number }) => Promise<RegisterResult>
  /** `depositHash`: sha256 hex of the deposit record, committed on-chain as bankRef. */
  issue: (args: { asset: AdminAsset, amount: number, depositHash?: string }) => Promise<IssuerOpResult>
  redeem: (args: { asset: AdminAsset, amount: number, balance?: number }) => Promise<IssuerOpResult>
  assets: () => Promise<AdminAsset[]>
  /** Self-heal half-finished state (stuck aborts, pending broadcasts). */
  reconcile: () => Promise<ReconcileResult>
}

export function createMandalaClient (opts: MandalaClientOptions = {}): MandalaClient {
  configureMandala(opts)
  const wallet = opts.wallet ?? new WalletClient()
  // Lazy so client construction never does I/O; both resolve once.
  let identityKeyPromise: Promise<string> | undefined
  const identityKey = (): Promise<string> => {
    identityKeyPromise ??= wallet
      .getPublicKey({ identityKey: true })
      .then(r => r.publicKey)
    return identityKeyPromise
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

  return {
    wallet,
    identityKey,
    send: async ({ assetId, counterparty, amount, mode, evidence }) =>
      transferTokens({
        wallet: wallet as any,
        messageBoxClient: await messageBox(),
        identityKey: await identityKey(),
        assetId,
        amount,
        recipientKey: counterparty,
        ...(mode != null ? { mode } : {}),
        ...(evidence != null ? { evidence } : {})
      }),
    receive: async (args = {}) =>
      receiveTokens({
        wallet,
        messageBoxClient: await messageBox(),
        assetId: args.assetId,
        ...(args.settle != null ? { settle: args.settle } : {}),
        processed
      }),
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
    reconcile: async () => reconcileWallet(wallet as any)
  }
}

// Re-export the core surface for direct use.
export { configureMandala } from './constants.js'
export * from './storage.js'
export * from './metadata.js'
export * from './txJournal.js'
export * from './overlay.js'
export * from './admission.js'
export * from './bundle.js'
export * from './transfer.js'
export * from './handover.js'
export * from './receive.js'
export * from './assets.js'
export * from './issuerOps.js'
export * from './registry.js'
export * from './registryRecover.js'
export * from './assetRecover.js'
export * from './blinding.js'
export * from './blindingJournal.js'
export * from './reconcile.js'
export * from './submitGuards.js'
export * from './singleFlight.js'
export * from './adminAuthGate.js'
export * from './amount.js'
export * from './notifyJournal.js'
export * from './webLocks.js'

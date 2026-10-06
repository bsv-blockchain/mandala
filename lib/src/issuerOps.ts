/**
 * Issuer pipelines (register / issue / redeem), extracted from the Operations
 * screen so the UI layer only orchestrates state. All three are overlay-first:
 * built `noSend`, gated on overlay acceptance, broadcast in the background
 * (see submitAndBroadcast). Each resolves at the overlay-accept commit point.
 */
import { Beef, WalletInterface } from '@bsv/sdk'
import { BASKET, FT_PROTOCOL } from './constants.js'
import { deployPayload, deployTopics, MandalaActionDetails } from './brc162.js'
import { assertFeeRate } from './feeRate.js'
import { AdmissionReceipt, admissionReceipt } from './overlay.js'
import { outpoint } from './tokens.js'
import { loadFtCandidates } from './ftCandidates.js'
import { selectFtInputs } from './ftSelect.js'
import { AdminAsset, adminCustomInstructions, withBankRef } from './assets.js'
import { withAdminAuthGate, assertSpendablePrior } from './adminAuthGate.js'
import { guardRedeemSubmit } from './submitGuards.js'
import { withIntent } from './txJournal.js'
import { tryWithLock } from './webLocks.js'
import { BusyError } from './singleFlight.js'
import { runAuthorityTx, runDeployTx } from './authority.js'

// ---------------------------------------------------------------------------
// Register: ONE tx, ONE output that both carries the public metadata blob and
// is the first admin auth. Its outpoint is the assetId; issue spends it. The
// overlay retains the metadata record across that spend (only eviction clears
// it), so the label/precision stay resolvable forever.
// ---------------------------------------------------------------------------

export interface RegisterParams {
  wallet: WalletInterface
  identityKey: string
  label: string
  ticker: string
  decimals: number
  /**
   * Token-fee design §2: token base units per 1000 bytes charged for
   * issuer-paid network fees. Omit to leave issuer-paid fees disabled; can be
   * set or changed later with setFeeRate().
   */
  feeRatePerKb?: number
}

/**
 * A12: every admin/treasury pipeline hands its overlay acceptance proof back to
 * the caller. σ_I is the receipt that the overlay folded THIS spend into its
 * state; discarding it at the call site (as every pipeline but transfer did)
 * threw away the only client-side evidence of admission.
 */
export interface RegisterResult extends AdmissionReceipt {
  assetId: string
}

export interface IssuerOpResult extends AdmissionReceipt {
  txid: string
  nextAuthOutpoint: string
  /** keyID of the new authority coin. */
  nextAuthKeyID: string
  nextAuthDetails: MandalaActionDetails
}

export async function registerAsset (p: RegisterParams): Promise<RegisterResult> {
  // No prior to serialise on (genesis), so the per-asset admin gate does not
  // apply — but a second register in another tab of the same wallet is still
  // a double-submit. registerFlight covers same-tab re-entry; this web lock
  // covers other tabs. Never queue: busy means reject.
  const { acquired, result } = await tryWithLock('mandala.register', async () =>
    // Intent marker: a crash between createAction and the journaled overlay
    // outcome leaves a fresh intent the reconcile sweep respects until TTL,
    // instead of aborting the live noSend action from under us.
    await withIntent(async () => await registerPipeline(p))
  )
  if (!acquired || result == null) {
    throw new BusyError('Register already in progress in another tab')
  }
  return result
}

/**
 * The deploy metadata. Pure so the shape is testable without a wallet. The
 * on-chain deploy payload is {sym, dec, label, feeRatePerKb?} (strict CBOR);
 * `metadata` is the wallet-side bookkeeping copy (adds issuer).
 */
export function registerDetails (
  p: Pick<RegisterParams, 'label' | 'ticker' | 'decimals' | 'identityKey' | 'feeRatePerKb'>
): { metadata: Record<string, unknown>, payload: number[] } {
  if (p.feeRatePerKb !== undefined) assertFeeRate(p.feeRatePerKb)
  const label = p.label.trim()
  const ticker = p.ticker.trim().toUpperCase()
  const metadata: Record<string, unknown> = {
    label,
    ticker,
    decimals: p.decimals,
    issuer: p.identityKey,
    ...(p.feeRatePerKb !== undefined ? { feeRatePerKb: p.feeRatePerKb } : {})
  }
  const payload = deployPayload({ sym: ticker, dec: p.decimals, label, feeRatePerKb: p.feeRatePerKb })
  return { metadata, payload }
}

async function registerPipeline (p: RegisterParams): Promise<RegisterResult> {
  const { wallet, identityKey } = p
  const { metadata, payload } = registerDetails({ ...p, identityKey })
  const res = await runDeployTx({
    wallet: wallet as any,
    identityKey,
    payload,
    topics: deployTopics,
    // The deploy CI can't name its own token id; adminAssetFromOutput resolves it.
    customInstructions: adminCustomInstructions('', String(metadata.label), 'deploy', metadata),
    description: `Register ${String(metadata.label)}`,
    labels: ['mandala', 'register']
  })
  return { assetId: res.tokenId, ...admissionReceipt(res.admitted) }
}

// ---------------------------------------------------------------------------
// Issue: spend the live authority; mint value + next authority.
// ---------------------------------------------------------------------------

export interface IssueParams {
  wallet: WalletInterface
  identityKey: string
  asset: AdminAsset
  amount: number
  /**
   * sha256 hex of the off-chain deposit record backing this issuance,
   * committed on-chain as `bankRef` (32 bytes). Omitted when empty.
   */
  depositHash?: string
}

export async function issueTokens (p: IssueParams): Promise<IssuerOpResult> {
  const { wallet, identityKey, asset, amount, depositHash } = p
  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const keyID = 'mint-' + Date.now()
    // Self-mint: our own identity key (hex) as counterparty, not 'self' — the
    // revealed linkage echoes counterparty verbatim and the overlay parses it.
    const counterparty = identityKey
    const issueDetails: MandalaActionDetails = withBankRef({ kind: 'issue' as const }, depositHash)

    const listResult = await wallet.listOutputs({ basket: BASKET, include: 'entire transactions', limit: 1000 })
    if (listResult.BEEF == null) throw new Error('listOutputs returned no BEEF')
    assertSpendablePrior(asset.authOutpoint, listResult.outputs.map(o => o.outpoint))

    const res = await runAuthorityTx({
      wallet: wallet as any,
      identityKey,
      legs: [{
        prior: { tokenId: asset.assetId, outpoint: asset.authOutpoint, keyID: asset.authKeyID },
        details: issueDetails,
        customInstructions: k => adminCustomInstructions(asset.assetId, asset.label, k, asset.metadata)
      }],
      valueOuts: [{
        tokenId: asset.assetId,
        amount,
        owner: counterparty,
        keyID,
        basket: BASKET,
        customInstructions: JSON.stringify({ protocolID: FT_PROTOCOL, keyID, counterparty }),
        outputDescription: 'minted FT'
      }],
      inputBEEF: listResult.BEEF as number[],
      description: `Issue ${amount} ${asset.label}`,
      labels: ['mandala', 'issue']
    })
    return {
      txid: res.txid,
      nextAuthOutpoint: outpoint(res.txid, res.authIndices[0]),
      nextAuthKeyID: res.authKeyIDs[0],
      nextAuthDetails: issueDetails,
      ...admissionReceipt(res.admitted)
    }
  }))
}

// ---------------------------------------------------------------------------
// Redeem: burn value coins by spending them + the live authority.
//   Output [0] = value change (if any); last = next authority.
// ---------------------------------------------------------------------------

export interface RedeemParams {
  wallet: WalletInterface
  identityKey: string
  asset: AdminAsset
  amount: number
  /**
   * Optional known spendable balance (e.g. from holder-data cache). When set,
   * amount-above-balance is refused before any wallet coin-selection work.
   */
  balance?: number
}

export async function redeemTokens (p: RedeemParams): Promise<IssuerOpResult> {
  const { wallet, identityKey, asset, amount, balance } = p
  const amountGate = guardRedeemSubmit({ assetId: asset.assetId, amount, balance, walletReady: true })
  if (!amountGate.ok) throw new Error(amountGate.reason)

  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const { candidates, beef: beefBytes } = await loadFtCandidates(wallet as any, asset.assetId, {
      requireSpendable: asset.authOutpoint
    })
    const { selected, total: gathered } = selectFtInputs(candidates, amount) // throws if insufficient
    const beef = new Beef()
    beef.mergeBeef(beefBytes)
    const change = gathered - amount
    const redeemDetails: MandalaActionDetails = { kind: 'redeem' }
    const keyIDChange = 'rchg-' + Date.now()

    const res = await runAuthorityTx({
      wallet: wallet as any,
      identityKey,
      legs: [{
        prior: { tokenId: asset.assetId, outpoint: asset.authOutpoint, keyID: asset.authKeyID },
        details: redeemDetails,
        customInstructions: k => adminCustomInstructions(asset.assetId, asset.label, k, asset.metadata)
      }],
      valueIns: selected.map(s => ({ outpoint: s.outpoint, keyID: s.keyID, counterparty: s.counterparty })),
      valueOuts: change > 0
        ? [{
            tokenId: asset.assetId,
            amount: change,
            owner: identityKey,
            keyID: keyIDChange,
            basket: BASKET,
            customInstructions: JSON.stringify({ protocolID: FT_PROTOCOL, keyID: keyIDChange, counterparty: identityKey }),
            outputDescription: 'FT change'
          }]
        : [],
      inputBEEF: beef.toBinary(),
      description: `Redeem ${amount} ${asset.label}`,
      labels: ['mandala', 'redeem']
    })
    return {
      txid: res.txid,
      nextAuthOutpoint: outpoint(res.txid, res.authIndices[0]),
      nextAuthKeyID: res.authKeyIDs[0],
      nextAuthDetails: redeemDetails,
      ...admissionReceipt(res.admitted)
    }
  }))
}

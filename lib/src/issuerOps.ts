/**
 * Issuer pipelines (register / issue / redeem), extracted from the Operations
 * screen so the UI layer only orchestrates state. All three are overlay-first:
 * built `noSend`, gated on overlay acceptance, broadcast in the background
 * (see submitAndBroadcast). Each resolves at the overlay-accept commit point.
 */
import { Beef, WalletInterface } from '@bsv/sdk'
import { TREASURY_BASKET, ADMIN_PROTOCOL, OVERLAY_IDENTITY_KEY, OVERLAY_IDENTITY_KEY_UNSET, TOPIC } from './constants.js'
import { deployPayload, MandalaActionDetails } from './brc162.js'
import { colorTopic } from './naming.js'
import { assertFeeRate } from './feeRate.js'
import { AdmissionReceipt, admissionReceipt } from './overlay.js'
import { outpoint } from './tokens.js'
import { loadTreasuryCandidates } from './treasury/candidates.js'
import { selectTreasuryInputs } from './treasury/select.js'
import { AdminAsset, actionDescription, adminCustomInstructions, withBankRef } from './assets.js'
import { withAdminAuthGate, assertSpendablePrior } from './adminAuthGate.js'
import { guardIssueSubmit, guardRedeemSubmit } from './submitGuards.js'
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
  /** Optional deploy icon `[mediaType, bytes]` (on chain only, never in the wallet metadata copy). */
  icon?: { mediaType: string, bytes: number[] }
  /**
   * B6: the console no longer writes this by default (fuel/token fees are out
   * of scope until fuelkeeper is ported). Token-fee design §2: token base units per 1000 bytes charged for
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
  // S5: the deploy's req names K = the overlay identity key, and the submit
  // verifies against it. Refuse before the lock, the intent marker or any
  // wallet call.
  if (OVERLAY_IDENTITY_KEY === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
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
 * on-chain deploy payload is {dec, req: mandalaReq(K), sym, icon?, label,
 * feeRatePerKb?} (strict CBOR, C§4) with K = the configured overlay identity
 * key (throws OVERLAY_IDENTITY_KEY_UNSET while it is unset); `metadata` is the
 * wallet-side bookkeeping copy (adds issuer; never the icon bytes).
 */
export function registerDetails (
  p: Pick<RegisterParams, 'label' | 'ticker' | 'decimals' | 'identityKey' | 'icon' | 'feeRatePerKb'>
): { metadata: Record<string, unknown>, payload: number[] } {
  if (OVERLAY_IDENTITY_KEY === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
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
  const payload = deployPayload({
    sym: ticker,
    dec: p.decimals,
    label,
    identityKey: OVERLAY_IDENTITY_KEY,
    ...(p.icon != null ? { icon: p.icon } : {}),
    ...(p.feeRatePerKb != null ? { feeRatePerKb: p.feeRatePerKb } : {})
  })
  return { metadata, payload }
}

async function registerPipeline (p: RegisterParams): Promise<RegisterResult> {
  const { wallet, identityKey } = p
  const { metadata, payload } = registerDetails({ ...p, identityKey })
  const res = await runDeployTx({
    wallet: wallet as any,
    identityKey,
    payload,
    // Deploy submit topics are exactly [tm_mandala, tm_color_<txid>_0] (C§0).
    topics: (txid: string) => [TOPIC, colorTopic(`${txid}_0`)],
    // The deploy CI can't name its own token id; adminAssetFromOutput resolves it.
    customInstructions: adminCustomInstructions('', String(metadata.label), 'deploy', metadata),
    description: actionDescription(`Register ${String(metadata.label)}`),
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
  /** Exact base units, 1..2^64-1. */
  amount: bigint
  /**
   * sha256 hex of the off-chain deposit record backing this issuance,
   * committed on-chain as `bankRef` (32 bytes). Omitted when empty.
   */
  depositHash?: string
}

export async function issueTokens (p: IssueParams): Promise<IssuerOpResult> {
  const { wallet, identityKey, asset, amount, depositHash } = p
  // Refuse a bad amount (non-bigint, ≤ 0, > 2^64-1) or a raw deposit
  // reference before any gate or wallet call.
  const gate = guardIssueSubmit({ assetId: asset.assetId, amount, bankRef: depositHash, walletReady: true })
  if (!gate.ok) throw new Error(gate.reason)
  // S5: fail closed before listOutputs (runAuthorityTx re-checks before createAction).
  if (OVERLAY_IDENTITY_KEY === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const keyID = 'mint-' + Date.now()
    // Self-mint: our own identity key (hex) as counterparty, not 'self' — the
    // revealed linkage echoes counterparty verbatim and the overlay parses it.
    const counterparty = identityKey
    const issueDetails: MandalaActionDetails = withBankRef({ kind: 'issue' as const }, depositHash)

    const listResult = await wallet.listOutputs({ basket: TREASURY_BASKET, include: 'entire transactions', limit: 1000 })
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
        basket: TREASURY_BASKET,
        customInstructions: JSON.stringify({ protocolID: ADMIN_PROTOCOL, keyID, counterparty }),
        outputDescription: 'minted FT'
      }],
      inputBEEF: listResult.BEEF as number[],
      description: actionDescription(`Issue ${amount} ${asset.label}`),
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
  /** Exact base units, 1..2^64-1. */
  amount: bigint
  /**
   * Optional known spendable treasury balance (an exact sum; may exceed
   * 2^64). When set, amount-above-balance is refused before any wallet
   * coin-selection work.
   */
  balance?: bigint
}

export async function redeemTokens (p: RedeemParams): Promise<IssuerOpResult> {
  const { wallet, identityKey, asset, amount, balance } = p
  const amountGate = guardRedeemSubmit({ assetId: asset.assetId, amount, balance, walletReady: true })
  if (!amountGate.ok) throw new Error(amountGate.reason)
  // S5: fail closed before listOutputs (runAuthorityTx re-checks before createAction).
  if (OVERLAY_IDENTITY_KEY === '') throw new Error(OVERLAY_IDENTITY_KEY_UNSET)

  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const { candidates, beef: beefBytes } = await loadTreasuryCandidates(wallet as any, asset.assetId, {
      requireSpendable: asset.authOutpoint
    })
    const { selected, total: gathered } = selectTreasuryInputs(candidates, amount) // throws if insufficient
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
      valueOuts: change > 0n
        ? [{
            tokenId: asset.assetId,
            amount: change,
            owner: identityKey,
            keyID: keyIDChange,
            basket: TREASURY_BASKET,
            customInstructions: JSON.stringify({ protocolID: ADMIN_PROTOCOL, keyID: keyIDChange, counterparty: identityKey }),
            outputDescription: 'FT change'
          }]
        : [],
      inputBEEF: beef.toBinary(),
      description: actionDescription(`Redeem ${amount} ${asset.label}`),
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

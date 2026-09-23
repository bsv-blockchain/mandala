/**
 * Issuer pipelines (register / issue / redeem), extracted from the Operations
 * screen so the UI layer only orchestrates state. All three are overlay-first:
 * built `noSend`, gated on overlay acceptance, broadcast in the background
 * (see submitAndBroadcast). Each resolves at the overlay-accept commit point.
 */
import { Transaction, Beef, WalletInterface } from '@bsv/sdk'
import { MandalaToken, MandalaAdmin } from '@bsv/templates'
import { BASKET, FT_PROTOCOL } from './constants.js'
import { encodeLinkagePayload, MandalaActionDetails } from './encoding.js'
import { assertFeeRate } from './feeRate.js'
import { AdmissionReceipt, admissionReceipt, submitAndBroadcast } from './overlay.js'
import { outpoint, revealLinkage } from './tokens.js'
import { walletMandalaUnlock } from './unlock.js'
import { loadFtCandidates } from './ftCandidates.js'
import { selectFtInputs } from './ftSelect.js'
import { AdminAsset, adminCustomInstructions, adminMarker, withBankRef } from './assets.js'
import { withAdminAuthGate, assertSpendablePrior } from './adminAuthGate.js'
import { guardRedeemSubmit } from './submitGuards.js'
import { withIntent } from './txJournal.js'
import { tryWithLock } from './webLocks.js'
import { BusyError } from './singleFlight.js'

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
 * The genesis action details. Pure so the shape is testable without a wallet.
 * issuer = our identity key, baked into the on-chain publicData so any holder
 * can SPV-verify it and return funds to the issuer. feeRatePerKb rides in
 * BOTH the commitment (actionDetails) and publicData when present.
 */
export function registerDetails (
  p: Pick<RegisterParams, 'label' | 'ticker' | 'decimals' | 'identityKey' | 'feeRatePerKb'>
): { metadata: Record<string, unknown>, regDetails: MandalaActionDetails } {
  if (p.feeRatePerKb !== undefined) assertFeeRate(p.feeRatePerKb)
  const metadata: Record<string, unknown> = {
    label: p.label.trim(),
    ticker: p.ticker.trim().toUpperCase(),
    decimals: p.decimals,
    issuer: p.identityKey,
    ...(p.feeRatePerKb !== undefined ? { feeRatePerKb: p.feeRatePerKb } : {})
  }
  const regDetails = { kind: 'register', ...metadata } as MandalaActionDetails
  return { metadata, regDetails }
}

async function registerPipeline (p: RegisterParams): Promise<RegisterResult> {
  const { wallet, identityKey } = p
  const { metadata, regDetails } = registerDetails({ ...p, identityKey })
  const genesisLock = await MandalaAdmin.lock({ wallet: wallet as any, data: regDetails, publicData: metadata })

  const reg = await wallet.createAction({
    description: `Register ${metadata.label}`,
    labels: ['mandala', 'register'],
    outputs: [{
      satoshis: 1,
      lockingScript: genesisLock.toHex(),
      outputDescription: 'asset genesis + admin auth',
      basket: BASKET,
      // Bookkeeping rides on the admin UTXO itself — the wallet basket is the
      // source of truth for the auth chain (no localStorage, no on-chain marker).
      customInstructions: adminCustomInstructions('', String(metadata.label), regDetails, metadata)
    }],
    options: { randomizeOutputs: false, noSend: true } // hold — broadcast after overlay accepts
  })

  if (reg.tx == null || reg.txid == null) throw new Error('register: no tx returned')
  const assetId = outpoint(reg.txid, 0)

  // The output's CI was written with an empty assetId (it IS this outpoint, which
  // didn't exist yet); adminAssetFromOutput resolves it to the outpoint on read.
  const offChainValues = encodeLinkagePayload({
    inputs: [],
    outputs: [],
    admin: [{ index: 0, actionDetails: regDetails }]
  })
  // Genesis has no signable FT inputs, so the wallet normally returns no
  // reference — but forward one whenever it does, so an overlay rejection
  // aborts the held action instead of leaving it stuck for the sweep.
  const admitted = await submitAndBroadcast(
    wallet as any,
    { tx: reg.tx as number[], txid: reg.txid },
    offChainValues,
    reg.signableTransaction?.reference
  )
  return { assetId, ...admissionReceipt(admitted) }
}

// ---------------------------------------------------------------------------
// Issue: spend the current auth outpoint; mint FT + next admin-auth output.
// ---------------------------------------------------------------------------

export interface IssueParams {
  wallet: WalletInterface
  identityKey: string
  asset: AdminAsset
  amount: number
  /**
   * sha256 hex of the off-chain deposit record backing this issuance. Committed
   * on-chain as `bankRef` inside the auth details (R12 / R22) — the bank
   * record itself stays off-chain. Omitted when empty (see withBankRef).
   */
  depositHash?: string
}

export async function issueTokens (p: IssueParams): Promise<IssuerOpResult> {
  const { wallet, identityKey, asset, amount, depositHash } = p
  // Serialize same-asset admin-auth so two issue/redeem/regulatory pipelines
  // cannot both commit on one priorOutpoint; the intent marker keeps the
  // reconcile sweep away from the live noSend action while it runs.
  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    const keyID = 'mint-' + Date.now()
    // Self-mint: use our own identity key (hex) as counterparty, not the literal
    // 'self' — the revealed linkage echoes counterparty verbatim and the overlay
    // parses it as a public key. Derivation is identical ('self' normalizes to this).
    const counterparty = identityKey

    const ftLock = await new MandalaToken(wallet as any).lockBRC29(
      asset.assetId, amount, FT_PROTOCOL, keyID, counterparty
    )

    const priorOutpoint = asset.authOutpoint
    const issueDetails: MandalaActionDetails = withBankRef({
      kind: 'issue',
      assetId: asset.assetId,
      amount,
      priorOutpoint
    }, depositHash)
    const nextAuthLock = await MandalaAdmin.lock({ wallet: wallet as any, data: issueDetails, publicData: adminMarker(asset.assetId) })

    // Fetch BEEF for the prior auth outpoint.
    const listResult = await wallet.listOutputs({
      basket: BASKET,
      include: 'entire transactions',
      limit: 1000
    })
    if (listResult.BEEF == null) throw new Error('listOutputs returned no BEEF')
    assertSpendablePrior(priorOutpoint, listResult.outputs.map(o => o.outpoint))

    const created = await wallet.createAction({
      description: `Issue ${amount} ${asset.label}`,
      labels: ['mandala', 'issue'],
      inputBEEF: listResult.BEEF as number[],
      inputs: [{
        outpoint: priorOutpoint,
        unlockingScriptLength: 108,
        inputDescription: 'spend prior admin auth'
      }],
      outputs: [
        {
          satoshis: 1,
          lockingScript: ftLock.toHex(),
          outputDescription: 'minted FT',
          basket: BASKET,
          customInstructions: JSON.stringify({ protocolID: FT_PROTOCOL, keyID, counterparty })
        },
        {
          satoshis: 1,
          lockingScript: nextAuthLock.toHex(),
          outputDescription: 'next admin auth',
          basket: BASKET,
          customInstructions: adminCustomInstructions(asset.assetId, asset.label, issueDetails, asset.metadata)
        }
      ],
      options: { randomizeOutputs: false }
    })

    if (created.signableTransaction == null) throw new Error('issue: no signableTransaction returned')

    // Sign the prior auth input with the stored authDetails (symmetric with how it was locked).
    const txToSign = Transaction.fromBEEF(created.signableTransaction.tx as number[])
    txToSign.inputs[0].unlockingScriptTemplate = MandalaAdmin.unlock({ wallet: wallet as any, data: asset.authDetails })
    await txToSign.sign()

    const spends: Record<string, { unlockingScript: string }> = {
      '0': { unlockingScript: txToSign.inputs[0].unlockingScript!.toHex() }
    }

    const signed = await wallet.signAction({
      reference: created.signableTransaction.reference,
      spends,
      options: { noSend: true } // hold — broadcast only after the overlay accepts
    })

    if (signed.tx == null || signed.txid == null) throw new Error('signAction: no tx returned')

    // Reveal linkage for the FT output; submit to the overlay, then broadcast.
    const linkage = await revealLinkage(wallet as any, keyID, counterparty)
    const offChainValues = encodeLinkagePayload({
      inputs: [],
      outputs: [{ index: 0, linkage }],
      admin: [{ index: 1, actionDetails: issueDetails }]
    })
    const admitted = await submitAndBroadcast(wallet as any, { tx: signed.tx as number[], txid: signed.txid }, offChainValues, created.signableTransaction.reference)
    // Output order is fixed (randomizeOutputs: false): FT at 0, next auth at 1.
    // nextAuthDetails must travel with the outpoint — the next action's unlock
    // derives from the details the new auth output was locked with.
    return {
      txid: signed.txid,
      nextAuthOutpoint: outpoint(signed.txid, 1),
      nextAuthDetails: issueDetails,
      ...admissionReceipt(admitted)
    }
  }))
}

// ---------------------------------------------------------------------------
// Redeem: burn FT tokens by spending FT inputs + prior auth outpoint.
//   Output [0] = next admin auth; Output [1] = FT change (if any).
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
  // Client-side amount gate first — no gate acquire / wallet I/O on bad amount.
  const amountGate = guardRedeemSubmit({
    assetId: asset.assetId,
    amount,
    balance,
    walletReady: true
  })
  if (!amountGate.ok) throw new Error(amountGate.reason)

  return withAdminAuthGate(asset.assetId, asset.authOutpoint, async () => await withIntent(async () => {
    // Token-aware coin selection (confirmed-first, fewest UTXOs) — same as
    // transfer. requireSpendable fails fast on a stale admin prior against the
    // selection's own first basket listing (before the heavier BEEF/listActions
    // work), matching issueTokens / submitAdminAction without an extra
    // listOutputs round-trip.
    const { candidates, beef: beefBytes } = await loadFtCandidates(wallet as any, asset.assetId, {
      requireSpendable: asset.authOutpoint
    })
    const { selected, total: gathered } = selectFtInputs(candidates, amount) // throws if insufficient
    const beef = new Beef()
    beef.mergeBeef(beefBytes)
    const ftInputs = selected.map(s => ({ outpoint: s.outpoint, unlockingScriptLength: 108, inputDescription: 'burn FT' }))
    const ftSpend = selected.map(s => ({ keyID: s.keyID, counterparty: s.counterparty }))
    const change = gathered - amount

    const redeemDetails: MandalaActionDetails = {
      kind: 'redeem',
      assetId: asset.assetId,
      amount,
      priorOutpoint: asset.authOutpoint
    }
    const nextAuthLock = await MandalaAdmin.lock({ wallet: wallet as any, data: redeemDetails, publicData: adminMarker(asset.assetId) })

    const inputs = [
      ...ftInputs,
      { outpoint: asset.authOutpoint, unlockingScriptLength: 108, inputDescription: 'spend prior auth' }
    ]

    const outputs: any[] = [
      {
        satoshis: 1,
        lockingScript: nextAuthLock.toHex(),
        outputDescription: 'redeem auth',
        basket: BASKET,
        customInstructions: adminCustomInstructions(asset.assetId, asset.label, redeemDetails, asset.metadata)
      }
    ]

    let keyIDChange = ''
    if (change > 0) {
      keyIDChange = 'rchg-' + Date.now()
      const ftChange = await new MandalaToken(wallet as any).lockBRC29(asset.assetId, change, FT_PROTOCOL, keyIDChange, identityKey)
      outputs.push({
        satoshis: 1,
        lockingScript: ftChange.toHex(),
        outputDescription: 'FT change',
        basket: BASKET,
        customInstructions: JSON.stringify({ protocolID: FT_PROTOCOL, keyID: keyIDChange, counterparty: identityKey })
      })
    }

    const created = await wallet.createAction({
      description: `Redeem ${amount} ${asset.label}`,
      labels: ['mandala', 'redeem'],
      inputBEEF: beef.toBinary(),
      inputs,
      outputs,
      options: { randomizeOutputs: false }
    })

    if (created.signableTransaction == null) throw new Error('redeem: no signableTransaction returned')

    // Sign FT inputs then the prior-auth input.
    const txToSign = Transaction.fromBEEF(created.signableTransaction.tx as number[])
    for (let i = 0; i < ftSpend.length; i++) {
      txToSign.inputs[i].unlockingScriptTemplate = walletMandalaUnlock(wallet as any, ftSpend[i].keyID, ftSpend[i].counterparty)
    }
    txToSign.inputs[ftSpend.length].unlockingScriptTemplate = MandalaAdmin.unlock({ wallet: wallet as any, data: asset.authDetails })
    await txToSign.sign()

    const spends: Record<string, { unlockingScript: string }> = {}
    for (let i = 0; i < inputs.length; i++) {
      spends[String(i)] = { unlockingScript: txToSign.inputs[i].unlockingScript!.toHex() }
    }

    const signed = await wallet.signAction({
      reference: created.signableTransaction.reference,
      spends,
      options: { noSend: true } // hold — broadcast only after the overlay accepts
    })

    if (signed.tx == null || signed.txid == null) throw new Error('signAction: no tx returned')

    // Admin auth is index 0; FT change (if any) is index 1.
    const outLinks: Array<{ index: number, linkage: any }> = []
    if (change > 0) {
      outLinks.push({ index: 1, linkage: await revealLinkage(wallet as any, keyIDChange, identityKey) })
    }
    const offChainValues = encodeLinkagePayload({
      inputs: [],
      outputs: outLinks,
      admin: [{ index: 0, actionDetails: redeemDetails }]
    })
    const admitted = await submitAndBroadcast(wallet as any, { tx: signed.tx as number[], txid: signed.txid }, offChainValues, created.signableTransaction.reference)
    // Output order is fixed (randomizeOutputs: false): next auth at 0.
    return {
      txid: signed.txid,
      nextAuthOutpoint: outpoint(signed.txid, 0),
      nextAuthDetails: redeemDetails,
      ...admissionReceipt(admitted)
    }
  }))
}

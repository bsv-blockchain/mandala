/**
 * BRC-162 authority-chain transactions (overlay-go internal/mandala/authority.go).
 *
 * An authority coin is a 1-sat Bsv21Binary output of amount 0, locked to the
 * issuer's own wallet-derived key under FT_PROTOCOL and proven by
 * specificKeyLinkage like any token output. A deploy (output 0, no token id)
 * is the chain's first link; every admin action spends the token's live
 * authority and re-emits one committing `{adm: sha256(details)}`, with the
 * strict-CBOR details carried in the envelope's `admin` list.
 *
 * The authority keyID is recomputable from chain data alone: the commitment
 * hex for an action link, DEPLOY_KEY_ID for a deploy (brc162.ts
 * authorityKeyIdOf). That is what lets recovery re-attach a head the wallet
 * lost track of.
 */
import { Transaction, WalletInterface } from '@bsv/sdk'
import { BASKET, FT_PROTOCOL } from './constants.js'
import {
  commitmentHex, commitmentPayload, DEPLOY_KEY_ID, encodeAdminDetails, lockToken,
  MandalaActionDetails, signDeploy, tokenIdOfDeploy, tokenTopic
} from './brc162.js'
import { encodeLinkagePayload, MandalaLinkagePayload } from './encoding.js'
import { OverlayAdmitResult, submitAndBroadcast } from './overlay.js'
import { revealLinkage } from './tokens.js'
import { walletMandalaUnlock } from './unlock.js'

/** A live authority coin this wallet can spend. */
export interface AuthorityRef {
  tokenId: string
  outpoint: string
  keyID: string
}

/** One authority link: spend `prior`, re-emit committing `details`. */
export interface AuthorityLeg {
  prior: AuthorityRef
  details: MandalaActionDetails
  /** customInstructions for the new authority output (bookkeeping for the next spend). */
  customInstructions: (keyID: string) => string
  /** Wallet basket output tags. */
  tags?: string[]
}

export interface ValueIn { outpoint: string, keyID: string, counterparty: string }

export interface ValueOut {
  tokenId: string
  amount: number
  /** Owner identity key (66 hex). */
  owner: string
  keyID: string
  /** Only for outputs this wallet keeps (owner = self). */
  basket?: string
  customInstructions?: string
  outputDescription?: string
}

export interface AuthorityTxResult {
  txid: string
  tx: number[]
  /** Output index of each leg's new authority (same order as legs). */
  authIndices: number[]
  /** Output index of each value output (same order as valueOuts). */
  valueIndices: number[]
  admitted: OverlayAdmitResult
  /** keyID of each leg's new authority. */
  authKeyIDs: string[]
  /** Hex strict-CBOR details per leg. */
  detailsHex: string[]
}

/**
 * Build, sign, submit (overlay-first) and broadcast one authority tx.
 * Inputs: every leg's prior authority, then value inputs. Outputs: value
 * outputs first, then one authority per leg. Topics: tm_<id> of every token
 * touched. Callers hold the admin-auth gate and the intent marker.
 */
export async function runAuthorityTx (p: {
  wallet: WalletInterface
  identityKey: string
  legs: AuthorityLeg[]
  valueIns?: ValueIn[]
  valueOuts?: ValueOut[]
  inputBEEF: number[]
  description: string
  labels: string[]
  /** X-Topics override (the KYC registry names tm_mandala_kyc); default tm_<id> of every token touched. */
  topics?: string[]
}): Promise<AuthorityTxResult> {
  const { wallet, identityKey, legs } = p
  const valueIns = p.valueIns ?? []
  const valueOuts = p.valueOuts ?? []
  if (legs.length === 0) throw new Error('authority tx needs at least one leg')

  const detailsBytes = legs.map(l => encodeAdminDetails(l.details))
  const authKeyIDs = detailsBytes.map(commitmentHex)

  const outputs: any[] = []
  for (const v of valueOuts) {
    const script = await lockToken(wallet, v.tokenId, v.amount, FT_PROTOCOL, v.keyID, v.owner)
    outputs.push({
      satoshis: 1,
      lockingScript: script.toHex(),
      outputDescription: v.outputDescription ?? 'token value',
      ...(v.basket != null ? { basket: v.basket } : {}),
      ...(v.customInstructions != null ? { customInstructions: v.customInstructions } : {})
    })
  }
  for (let i = 0; i < legs.length; i++) {
    const script = await lockToken(wallet, legs[i].prior.tokenId, 0, FT_PROTOCOL, authKeyIDs[i], identityKey, commitmentPayload(detailsBytes[i]))
    outputs.push({
      satoshis: 1,
      lockingScript: script.toHex(),
      outputDescription: `${legs[i].details.kind} authority`,
      basket: BASKET,
      customInstructions: legs[i].customInstructions(authKeyIDs[i]),
      ...(legs[i].tags != null ? { tags: legs[i].tags } : {})
    })
  }
  const spendPlan: ValueIn[] = [
    ...legs.map(l => ({ outpoint: l.prior.outpoint, keyID: l.prior.keyID, counterparty: identityKey })),
    ...valueIns
  ]

  const created = await wallet.createAction({
    description: p.description,
    labels: p.labels,
    inputBEEF: p.inputBEEF,
    inputs: spendPlan.map(s => ({ outpoint: s.outpoint, unlockingScriptLength: 108, inputDescription: 'spend token coin' })),
    outputs,
    options: { randomizeOutputs: false }
  })
  if (created.signableTransaction == null) throw new Error(`${p.description}: no signableTransaction`)

  const tx = Transaction.fromBEEF(created.signableTransaction.tx as number[])
  const spends: Record<string, { unlockingScript: string }> = {}
  const indexOf = (op: string): number => {
    const dot = op.lastIndexOf('.')
    const txid = op.slice(0, dot)
    const vout = Number(op.slice(dot + 1))
    return tx.inputs.findIndex(i => (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === txid && i.sourceOutputIndex === vout)
  }
  // Match each planned spend by outpoint; a wallet that hands back inputs
  // without resolvable sources keeps the planned (positional) order.
  const located = spendPlan.map(s => indexOf(s.outpoint))
  const positional = located.some(i => i < 0) && tx.inputs.length >= spendPlan.length
  const indices = spendPlan.map((s, k) => {
    const i = positional ? k : located[k]
    if (i < 0) throw new Error(`createAction did not spend ${s.outpoint}`)
    tx.inputs[i].unlockingScriptTemplate = walletMandalaUnlock(wallet, s.keyID, s.counterparty)
    return i
  })
  await tx.sign()
  for (const i of indices) spends[String(i)] = { unlockingScript: tx.inputs[i].unlockingScript!.toHex() }

  const signed = await wallet.signAction({
    reference: created.signableTransaction.reference,
    spends,
    options: { noSend: true } // hold — broadcast only after the overlay accepts
  })
  if (signed.tx == null || signed.txid == null) throw new Error(`${p.description}: signAction returned no tx`)

  const valueIndices = valueOuts.map((_, i) => i)
  const authIndices = legs.map((_, i) => valueOuts.length + i)
  const outLinks: MandalaLinkagePayload['outputs'] = []
  for (let i = 0; i < valueOuts.length; i++) {
    outLinks.push({ index: valueIndices[i], linkage: await revealLinkage(wallet, valueOuts[i].keyID, valueOuts[i].owner) })
  }
  for (let i = 0; i < legs.length; i++) {
    outLinks.push({ index: authIndices[i], linkage: await revealLinkage(wallet, authKeyIDs[i], identityKey) })
  }
  const detailsHex = detailsBytes.map(b => b.map(x => x.toString(16).padStart(2, '0')).join(''))
  const env = encodeLinkagePayload({
    inputs: [],
    outputs: outLinks,
    admin: legs.map((_, i) => ({ index: authIndices[i], details: detailsHex[i] }))
  })
  const topics = p.topics ?? [...new Set([...legs.map(l => l.prior.tokenId), ...valueOuts.map(v => v.tokenId)].map(tokenTopic))]
  const admitted = await submitAndBroadcast(
    wallet,
    { tx: signed.tx as number[], txid: signed.txid },
    env,
    created.signableTransaction.reference,
    undefined,
    topics
  )
  return { txid: signed.txid, tx: signed.tx as number[], authIndices, valueIndices, admitted, authKeyIDs, detailsHex }
}

/**
 * Deploy a new token (or the KYC registry): output 0 is the deploy, locked to
 * our own key under DEPLOY_KEY_ID with `payload`; the envelope carries its
 * linkage and the deploy signature over the txid. `topics(txid)` names the
 * X-Topics (deployTopics for a token, [REGISTRY_TOPIC] for the registry).
 */
export async function runDeployTx (p: {
  wallet: WalletInterface
  identityKey: string
  payload: number[]
  topics: (txid: string) => string[]
  customInstructions: string
  tags?: string[]
  description: string
  labels: string[]
}): Promise<{ txid: string, tokenId: string, admitted: OverlayAdmitResult }> {
  const { wallet, identityKey } = p
  const script = await lockToken(wallet, null, 0, FT_PROTOCOL, DEPLOY_KEY_ID, identityKey, p.payload)
  const created = await wallet.createAction({
    description: p.description,
    labels: p.labels,
    outputs: [{
      satoshis: 1,
      lockingScript: script.toHex(),
      outputDescription: 'token deploy + first authority',
      basket: BASKET,
      customInstructions: p.customInstructions,
      ...(p.tags != null ? { tags: p.tags } : {})
    }],
    options: { randomizeOutputs: false, noSend: true } // hold — broadcast after overlay accepts
  })
  if (created.tx == null || created.txid == null) throw new Error('deploy: no tx returned')
  const txid = created.txid
  const env = encodeLinkagePayload({
    inputs: [],
    outputs: [{ index: 0, linkage: await revealLinkage(wallet, DEPLOY_KEY_ID, identityKey) }],
    admin: [],
    deploySig: await signDeploy(wallet, txid)
  })
  const admitted = await submitAndBroadcast(
    wallet,
    { tx: created.tx as number[], txid },
    env,
    created.signableTransaction?.reference,
    undefined,
    p.topics(txid)
  )
  return { txid, tokenId: tokenIdOfDeploy(txid), admitted }
}

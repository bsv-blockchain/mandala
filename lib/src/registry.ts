/**
 * Issuer-level identity registration chain. Separate spine from per-asset
 * issuance: one admit covers every stablecoin this issuer operates.
 * The overlay database is a cache of this chain.
 */
import {
  Hash, LockingScript, OP, Transaction, TransactionSignature, Signature,
  UnlockingScript, Utils, WalletInterface
} from '@bsv/sdk'
import { MandalaAdmin } from '@bsv/templates'

export interface RegistryActionDetails {
  kind: 'register' | 'admitIdentity' | 'revokeIdentity'
  identityKey?: string
  issuer?: string
  priorOutpoint?: string
  counterparty?: string
  [k: string]: unknown
}
import { adminAuthHeaders, BASKET, OVERLAY_URL, OVERLAY_URL_UNSET, REGISTRY_PROTOCOL, REGISTRY_TOPIC } from './constants.js'
import { encodeLinkagePayload } from './encoding.js'
import { AdmissionReceipt, admissionReceipt, submitAndBroadcast } from './overlay.js'
import { registryFlight } from './singleFlight.js'
import { guardIdentityKey } from './submitGuards.js'
import { outpoint } from './tokens.js'
import { withIntent } from './txJournal.js'
import { walletMandalaUnlock } from './unlock.js'

const CI_TYPE = 'mandala-registry'

export interface RegistryAuth {
  authOutpoint: string
  authDetails: RegistryActionDetails
}

interface RegistryCI {
  type: typeof CI_TYPE
  authDetails: RegistryActionDetails
}

export function registryCustomInstructions (authDetails: RegistryActionDetails): string {
  return JSON.stringify({ type: CI_TYPE, authDetails } satisfies RegistryCI)
}

export function parseRegistryCI (ci: string | object | null | undefined): RegistryCI | null {
  if (ci == null) return null
  try {
    const parsed = typeof ci === 'string' ? JSON.parse(ci) : ci
    return parsed != null && typeof parsed === 'object' && (parsed as RegistryCI).type === CI_TYPE
      ? parsed as RegistryCI
      : null
  } catch {
    return null
  }
}

export async function listRegistryAuth (wallet: WalletInterface): Promise<RegistryAuth | null> {
  const res = await wallet.listOutputs({ basket: BASKET, includeCustomInstructions: true, limit: 1000 })
  const found: RegistryAuth[] = []
  for (const o of res.outputs) {
    const ci = parseRegistryCI(o.customInstructions)
    if (ci != null) found.push({ authOutpoint: o.outpoint, authDetails: ci.authDetails })
  }
  if (found.length === 0) return null
  try {
    const rows = await fetchRegistry()
    const live = rows.find(r => r.txid !== '')
    if (live != null) {
      const op = `${live.txid}.${live.outputIndex}`
      return found.find(f => f.authOutpoint === op) ?? null
    }
  } catch { /* overlay unreachable — fall through */ }
  return found[0]
}

async function lockRegistry (wallet: WalletInterface, data: RegistryActionDetails): Promise<LockingScript> {
  const keyID = MandalaAdmin.commitment(data as any)
  const { publicKey } = await wallet.getPublicKey({ protocolID: REGISTRY_PROTOCOL, keyID, counterparty: 'self' })
  const pubKeyHash = Hash.hash160(Utils.toArray(publicKey, 'hex'))
  // OP_DROP prefix so this is not a vanilla 1-sat P2PKH the wallet reclassifies
  // (and drops basket customInstructions) after a chain sync.
  const marker = Utils.toArray(JSON.stringify({ t: 'mandala-registry' }), 'utf8')
  return new LockingScript([
    { op: marker.length, data: marker },
    { op: OP.OP_DROP },
    { op: OP.OP_DUP },
    { op: OP.OP_HASH160 },
    { op: pubKeyHash.length, data: pubKeyHash },
    { op: OP.OP_EQUALVERIFY },
    { op: OP.OP_CHECKSIG }
  ])
}

function registryUnlock (wallet: WalletInterface, data: RegistryActionDetails) {
  const keyID = MandalaAdmin.commitment(data as any)
  // Same P2PKH unlock shape as walletMandalaUnlock, different protocol.
  const tmpl = walletMandalaUnlock(wallet, keyID, 'self')
  return {
    sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
      const input = tx.inputs[inputIndex]
      const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (sourceTXID == null || sourceOutput?.satoshis == null || sourceOutput.lockingScript == null) {
        throw new Error('registry unlock: missing source')
      }
      const scope = TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL
      const preimage = TransactionSignature.format({
        sourceTXID,
        sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: sourceOutput.satoshis,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
        inputIndex,
        outputs: tx.outputs,
        inputSequence: input.sequence ?? 0xffffffff,
        subscript: sourceOutput.lockingScript,
        lockTime: tx.lockTime,
        scope
      })
      const { signature: der } = await wallet.createSignature({
        hashToDirectlySign: Hash.hash256(preimage),
        protocolID: REGISTRY_PROTOCOL,
        keyID,
        counterparty: 'self'
      })
      const sig = Signature.fromDER([...der])
      const txSig = new TransactionSignature(sig.r, sig.s, scope)
      const sigForScript = txSig.toChecksigFormat()
      const { publicKey } = await wallet.getPublicKey({
        protocolID: REGISTRY_PROTOCOL, keyID, counterparty: 'self', forSelf: true
      })
      const pubkey = Utils.toArray(publicKey, 'hex')
      return new UnlockingScript([
        { op: sigForScript.length, data: sigForScript },
        { op: pubkey.length, data: pubkey }
      ])
    },
    estimateLength: tmpl.estimateLength
  }
}

/** A registry spend's outcome plus the overlay's acceptance proof (A12). */
export interface RegistryActionResult extends AdmissionReceipt {
  authOutpoint: string
}

export async function registerIdentities (p: { wallet: WalletInterface, identityKey: string }): Promise<RegistryActionResult> {
  const details: RegistryActionDetails = { kind: 'register', issuer: p.identityKey, identityKey: p.identityKey }
  const script = await lockRegistry(p.wallet, details)
  return await withIntent(async () => {
    const created = await p.wallet.createAction({
      description: 'Register identity chain',
      labels: ['mandala', 'registry', 'register'],
      outputs: [{
        satoshis: 1,
        lockingScript: script.toHex(),
        outputDescription: 'registry genesis',
        basket: BASKET,
        tags: ['mandala-registry'],
        customInstructions: registryCustomInstructions(details)
      }],
      options: { randomizeOutputs: false, noSend: true }
    })
    if (created.tx == null || created.txid == null) throw new Error('registry register: no tx')
    const admitted = await submitAndBroadcast(
      p.wallet,
      { tx: created.tx as number[], txid: created.txid },
      encodeLinkagePayload({ inputs: [], outputs: [], admin: [{ index: 0, actionDetails: details as any }] }),
      undefined,
      undefined,
      [REGISTRY_TOPIC]
    )
    return { authOutpoint: outpoint(created.txid, 0), ...admissionReceipt(admitted) }
  })
}

/**
 * Spend-and-replace the live identity-admin UTXO.
 * Genesis (registerIdentities) has no inputs. Every later action MUST list
 * the current admin outpoint as a createAction input and emit the next 1-sat
 * auth output — same shape as buildAdminActionArgs.
 */
export function buildRegistrySpendArgs (p: {
  kind: 'admitIdentity' | 'revokeIdentity'
  targetKey: string
  priorOutpoint: string
  nextLockHex: string
  authDetails: RegistryActionDetails
  inputBEEF: number[]
}): {
  description: string
  labels: string[]
  inputBEEF: number[]
  inputs: Array<{ outpoint: string, unlockingScriptLength: number, inputDescription: string }>
  outputs: Array<{
    satoshis: number
    lockingScript: string
    outputDescription: string
    basket: string
    tags: string[]
    customInstructions: string
  }>
  options: { randomizeOutputs: false, noSend: true, trustSelf: 'known' }
} {
  if (p.priorOutpoint.trim() === '' || !p.priorOutpoint.includes('.')) {
    throw new Error('registry spend requires the live admin outpoint as an input')
  }
  if (p.inputBEEF.length === 0) {
    throw new Error('registry spend requires inputBEEF for the live admin outpoint')
  }
  return {
    description: `${p.kind} ${p.targetKey.slice(0, 16)}`,
    labels: ['mandala', 'registry', p.kind],
    inputBEEF: p.inputBEEF,
    inputs: [{
      outpoint: p.priorOutpoint,
      unlockingScriptLength: 108,
      inputDescription: 'spend registry auth'
    }],
    outputs: [{
      satoshis: 1,
      lockingScript: p.nextLockHex,
      outputDescription: 'next registry auth',
      basket: BASKET,
      tags: ['mandala-registry'],
      customInstructions: registryCustomInstructions(p.authDetails)
    }],
    options: {
      randomizeOutputs: false,
      noSend: true,
      trustSelf: 'known'
    }
  }
}

function txFromSignable (bytes: number[]): Transaction {
  try {
    return Transaction.fromAtomicBEEF(bytes)
  } catch {
    return Transaction.fromBEEF(bytes)
  }
}

export async function admitOrRevokeIdentity (p: {
  wallet: WalletInterface
  kind: 'admitIdentity' | 'revokeIdentity'
  targetKey: string
  issuerIdentityKey?: string
  /** When set, skip basket listing — required after re-attach because CI often does not survive. */
  live?: RegistryAuth
}): Promise<RegistryActionResult> {
  let live = p.live
  if (live == null && p.issuerIdentityKey != null) {
    const { recoverRegistryAuth } = await import('./registryRecover.js')
    live = await recoverRegistryAuth({ wallet: p.wallet, issuerIdentityKey: p.issuerIdentityKey }) ?? undefined
  }
  if (live == null) live = await listRegistryAuth(p.wallet) ?? undefined
  if (live == null) throw new Error('no live identity-admin outpoint to spend')
  const details: RegistryActionDetails = {
    kind: p.kind,
    identityKey: p.targetKey,
    priorOutpoint: live.authOutpoint
  }
  const next = await lockRegistry(p.wallet, details)
  return await withIntent(async () => {
    const { loadRegistryInputBeef, abortStuckRegistryActions } = await import('./registryRecover.js')
    await abortStuckRegistryActions(p.wallet)
    const inputBEEF = await loadRegistryInputBeef(p.wallet, live.authOutpoint)
    const args = buildRegistrySpendArgs({
      kind: p.kind,
      targetKey: p.targetKey,
      priorOutpoint: live.authOutpoint,
      nextLockHex: next.toHex(),
      authDetails: details,
      inputBEEF
    })
    let created
    try {
      created = await p.wallet.createAction(args)
    } catch (e) {
      await abortStuckRegistryActions(p.wallet)
      throw e
    }
    if (created.signableTransaction == null) throw new Error('registry: no signableTransaction')
    const tx = txFromSignable(created.signableTransaction.tx as number[])
    const [priorTxid, priorVoutStr] = live.authOutpoint.split('.')
    const priorVout = Number(priorVoutStr ?? 0)
    const spendIndex = tx.inputs.findIndex(i =>
      (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === priorTxid &&
      i.sourceOutputIndex === priorVout
    )
    if (spendIndex < 0) {
      throw new Error(`createAction did not spend registry auth ${live.authOutpoint}`)
    }
    if (tx.inputs[spendIndex].sourceTransaction == null) {
      tx.inputs[spendIndex].sourceTransaction = txFromSignable(inputBEEF)
    }
    tx.inputs[spendIndex].unlockingScriptTemplate = registryUnlock(p.wallet, live.authDetails)
    await tx.sign()
    const hex = tx.inputs[spendIndex].unlockingScript?.toHex()
    if (hex == null) throw new Error('registry: missing unlocking script')
    const signed = await p.wallet.signAction({
      reference: created.signableTransaction.reference,
      spends: { [spendIndex]: { unlockingScript: hex } },
      options: { noSend: true }
    })
    const txid = signed.txid ?? Transaction.fromBEEF(signed.tx as number[]).id('hex')
    const admitted = await submitAndBroadcast(
      p.wallet,
      { tx: signed.tx as number[], txid },
      encodeLinkagePayload({ inputs: [], outputs: [], admin: [{ index: 0, actionDetails: details as any }] }),
      created.signableTransaction.reference,
      undefined,
      [REGISTRY_TOPIC]
    )
    return { authOutpoint: `${txid}.0`, ...admissionReceipt(admitted) }
  })
}

export const admitIdentity = (
  wallet: WalletInterface,
  targetKey: string,
  issuerIdentityKey?: string,
  live?: RegistryAuth
) => admitOrRevokeIdentity({ wallet, kind: 'admitIdentity', targetKey, issuerIdentityKey, live })

export const revokeIdentity = (
  wallet: WalletInterface,
  targetKey: string,
  issuerIdentityKey?: string,
  live?: RegistryAuth
) => admitOrRevokeIdentity({ wallet, kind: 'revokeIdentity', targetKey, issuerIdentityKey, live })

/** Overlay cache of the issuer-level identity chain (`GET /admin/registry`). */
export interface OverlayRegistryRow {
  identityKey: string
  status: 'admitted' | 'revoked'
  txid: string
  outputIndex: number
  admitSeq: number
  createdAt: string
  actionDetails?: RegistryActionDetails
}

export function parseRegistryRows (body: unknown): OverlayRegistryRow[] {
  if (!Array.isArray(body)) return []
  const out: OverlayRegistryRow[] = []
  for (const row of body) {
    if (row == null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.identityKey !== 'string' || r.identityKey === '') continue
    if (r.status !== 'admitted' && r.status !== 'revoked') continue
    out.push({
      identityKey: r.identityKey,
      status: r.status,
      txid: typeof r.txid === 'string' ? r.txid : '',
      outputIndex: typeof r.outputIndex === 'number' ? r.outputIndex : 0,
      admitSeq: typeof r.admitSeq === 'number' ? r.admitSeq : 0,
      createdAt: typeof r.createdAt === 'string'
        ? r.createdAt
        : r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : '',
      actionDetails: r.actionDetails != null && typeof r.actionDetails === 'object'
        ? r.actionDetails as RegistryActionDetails
        : undefined
    })
  }
  return out
}

export async function fetchRegistry (): Promise<OverlayRegistryRow[]> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  // Identity-bearing route (A13): carries the admin bearer token when configured.
  const res = await fetch(`${OVERLAY_URL}/admin/registry`, { headers: adminAuthHeaders() })
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`)
  return parseRegistryRows(await res.json())
}

export function registryIsLive (rows: OverlayRegistryRow[]): boolean {
  return rows.length > 0
}

export type RegistryPlan = 'register' | 'admit' | 'register-then-admit' | 'recover' | 'recover-then-admit'

/** Reconstruct the lock-binding details for an overlay cache row. */
export function reconstructRegistryDetails (
  row: OverlayRegistryRow,
  issuerIdentityKey: string
): RegistryActionDetails {
  if (row.actionDetails != null && typeof row.actionDetails.kind === 'string') {
    return row.actionDetails
  }
  // Genesis is the one action whose details are fully determined by the row:
  // it has no priorOutpoint and names the issuer as both signer and subject.
  if (row.identityKey.trim().toLowerCase() === issuerIdentityKey.trim().toLowerCase() && row.admitSeq <= 1) {
    return { kind: 'register', issuer: issuerIdentityKey, identityKey: issuerIdentityKey }
  }
  // Every later link committed to its own priorOutpoint, which the cache row
  // does not carry. Guessing yields a different commitment, hence a different
  // locking key, and the spend fails later with an opaque signature error.
  // Fail here instead, where the cause is legible.
  throw new Error(
    `registry row ${row.txid}.${row.outputIndex} has no actionDetails; ` +
    'the overlay must serve the details that locked the head before it can be spent'
  )
}

/** What the mock-KYC button must do given live wallet auth and the target key. */
export function nextRegistryPlan (
  live: RegistryAuth | null,
  issuerIdentityKey: string,
  targetKey: string,
  overlayLive = false
): RegistryPlan {
  if (live != null) return 'admit'
  if (overlayLive) {
    return issuerIdentityKey.trim().toLowerCase() === targetKey.trim().toLowerCase()
      ? 'recover'
      : 'recover-then-admit'
  }
  return issuerIdentityKey.trim().toLowerCase() === targetKey.trim().toLowerCase()
    ? 'register'
    : 'register-then-admit'
}

export interface MockKycOpenResult {
  authOutpoint: string
  opened: boolean
  recovered: boolean
}

/** Re-attach an overlay-admitted auth UTXO, or genesis if the chain does not exist. */
export async function mockKycOpen (p: {
  wallet: WalletInterface
  issuerIdentityKey: string
}): Promise<MockKycOpenResult> {
  return await registryFlight.run(async () => {
    const existing = await listRegistryAuth(p.wallet)
    if (existing != null) return { authOutpoint: existing.authOutpoint, opened: false, recovered: false }
    const { recoverRegistryAuth } = await import('./registryRecover.js')
    const recovered = await recoverRegistryAuth(p)
    if (recovered != null) return { authOutpoint: recovered.authOutpoint, opened: false, recovered: true }
    const genesis = await registerIdentities({ wallet: p.wallet, identityKey: p.issuerIdentityKey })
    return { authOutpoint: genesis.authOutpoint, opened: true, recovered: false }
  })
}

export async function mockKycAdmit (p: {
  wallet: WalletInterface
  issuerIdentityKey: string
  targetKey: string
}): Promise<{ authOutpoint: string, opened: boolean, recovered?: boolean }> {
  const gate = guardIdentityKey(p.targetKey)
  if (!gate.ok) throw new Error(gate.reason)
  const target = p.targetKey.trim()
  return await registryFlight.run(async () => {
    const { recoverRegistryAuth } = await import('./registryRecover.js')
    let live = await recoverRegistryAuth(p)
    let opened = false
    const recovered = live != null
    if (live == null) {
      const genesis = await registerIdentities({ wallet: p.wallet, identityKey: p.issuerIdentityKey })
      opened = true
      live = {
        authOutpoint: genesis.authOutpoint,
        authDetails: { kind: 'register', issuer: p.issuerIdentityKey, identityKey: p.issuerIdentityKey }
      }
      if (target.toLowerCase() === p.issuerIdentityKey.trim().toLowerCase()) {
        return { authOutpoint: live.authOutpoint, opened, recovered: false }
      }
    }
    const admitted = await admitOrRevokeIdentity({
      wallet: p.wallet,
      kind: 'admitIdentity',
      targetKey: target,
      issuerIdentityKey: p.issuerIdentityKey,
      live
    })
    return { authOutpoint: admitted.authOutpoint, opened, recovered: recovered && !opened }
  })
}

export async function mockKycRevoke (p: {
  wallet: WalletInterface
  issuerIdentityKey: string
  targetKey: string
}): Promise<{ authOutpoint: string }> {
  const gate = guardIdentityKey(p.targetKey)
  if (!gate.ok) throw new Error(gate.reason)
  return await registryFlight.run(async () => {
    const { recoverRegistryAuth } = await import('./registryRecover.js')
    const live = await recoverRegistryAuth({ wallet: p.wallet, issuerIdentityKey: p.issuerIdentityKey })
    return await admitOrRevokeIdentity({
      wallet: p.wallet,
      kind: 'revokeIdentity',
      targetKey: p.targetKey.trim(),
      issuerIdentityKey: p.issuerIdentityKey,
      live: live ?? undefined
    })
  })
}

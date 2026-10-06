/**
 * Issuer-level identity registration chain. Separate spine from per-asset
 * issuance: one admit covers every stablecoin this issuer operates.
 * The overlay database is a cache of this chain.
 */
import { WalletInterface } from '@bsv/sdk'
import { adminAuthHeaders, BASKET, OVERLAY_URL, OVERLAY_URL_UNSET, REGISTRY_TOPIC } from './constants.js'
import { deployPayload } from './brc162.js'
import { AdmissionReceipt, admissionReceipt } from './overlay.js'
import { registryFlight } from './singleFlight.js'
import { guardIdentityKey } from './submitGuards.js'
import { outpoint } from './tokens.js'
import { withIntent } from './txJournal.js'
import { runAuthorityTx, runDeployTx } from './authority.js'

export interface RegistryActionDetails {
  kind: 'admitIdentity' | 'revokeIdentity'
  identityKey: string
}

const CI_TYPE = 'mandala-registry'

/** The live link of the KYC registry chain (a BRC-162 authority on tm_mandala_kyc). */
export interface RegistryAuth {
  authOutpoint: string
  /** keyID of the authority coin (commitment hex, or 'deploy'). */
  authKeyID: string
  /** The registry's token id `<deployTxid>_0`. */
  tokenId: string
}

interface RegistryCI {
  type: typeof CI_TYPE
  /** '' on the deploy output (its id is its own `<txid>_0`). */
  tokenId: string
  authKeyID: string
}

export function registryCustomInstructions (tokenId: string, authKeyID: string): string {
  return JSON.stringify({ type: CI_TYPE, tokenId, authKeyID } satisfies RegistryCI)
}

export function parseRegistryCI (ci: string | object | null | undefined): RegistryCI | null {
  if (ci == null) return null
  try {
    const parsed = typeof ci === 'string' ? JSON.parse(ci) : ci
    return parsed != null && typeof parsed === 'object' && (parsed as RegistryCI).type === CI_TYPE &&
      typeof (parsed as RegistryCI).authKeyID === 'string'
      ? parsed as RegistryCI
      : null
  } catch {
    return null
  }
}

const tokenIdOf = (ci: RegistryCI, op: string): string =>
  ci.tokenId !== '' ? ci.tokenId : `${op.slice(0, op.lastIndexOf('.'))}_0`

export async function listRegistryAuth (wallet: WalletInterface): Promise<RegistryAuth | null> {
  const res = await wallet.listOutputs({ basket: BASKET, includeCustomInstructions: true, limit: 1000 })
  const found: RegistryAuth[] = []
  for (const o of res.outputs) {
    const ci = parseRegistryCI(o.customInstructions)
    if (ci != null) found.push({ authOutpoint: o.outpoint, authKeyID: ci.authKeyID, tokenId: tokenIdOf(ci, o.outpoint) })
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

/** A registry spend's outcome plus the overlay's acceptance proof (A12). */
export interface RegistryActionResult extends AdmissionReceipt {
  authOutpoint: string
  authKeyID: string
  tokenId: string
}

/** The KYC registry deploy payload (the overlay ignores it on tm_mandala_kyc, but a deploy must be well-formed). */
export const REGISTRY_DEPLOY_PAYLOAD = (): number[] => deployPayload({ sym: 'KYC', dec: 0, label: 'Mandala identity registry' })

/**
 * Deploy the KYC registry chain on tm_mandala_kyc (the first trusted deploy
 * wins; a second is refused). Admits no identity by itself.
 */
export async function registerIdentities (p: { wallet: WalletInterface, identityKey: string }): Promise<RegistryActionResult> {
  return await withIntent(async () => {
    const res = await runDeployTx({
      wallet: p.wallet,
      identityKey: p.identityKey,
      payload: REGISTRY_DEPLOY_PAYLOAD(),
      topics: () => [REGISTRY_TOPIC],
      customInstructions: registryCustomInstructions('', 'deploy'),
      tags: ['mandala-registry'],
      description: 'Register identity chain',
      labels: ['mandala', 'registry', 'register']
    })
    return { authOutpoint: outpoint(res.txid, 0), authKeyID: 'deploy', tokenId: res.tokenId, ...admissionReceipt(res.admitted) }
  })
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
  const details: RegistryActionDetails = { kind: p.kind, identityKey: p.targetKey.trim().toLowerCase() }
  const issuerKey = p.issuerIdentityKey ?? (await p.wallet.getPublicKey({ identityKey: true })).publicKey
  const head = live
  return await withIntent(async () => {
    const { loadRegistryInputBeef, abortStuckRegistryActions } = await import('./registryRecover.js')
    await abortStuckRegistryActions(p.wallet)
    const inputBEEF = await loadRegistryInputBeef(p.wallet, head.authOutpoint)
    let res
    try {
      res = await runAuthorityTx({
        wallet: p.wallet,
        identityKey: issuerKey,
        legs: [{
          prior: { tokenId: head.tokenId, outpoint: head.authOutpoint, keyID: head.authKeyID },
          details,
          customInstructions: keyID => registryCustomInstructions(head.tokenId, keyID),
          tags: ['mandala-registry']
        }],
        inputBEEF,
        description: `${p.kind} ${p.targetKey.slice(0, 16)}`,
        labels: ['mandala', 'registry', p.kind],
        topics: [REGISTRY_TOPIC]
      })
    } catch (e) {
      await abortStuckRegistryActions(p.wallet)
      throw e
    }
    return {
      authOutpoint: outpoint(res.txid, res.authIndices[0]),
      authKeyID: res.authKeyIDs[0],
      tokenId: head.tokenId,
      ...admissionReceipt(res.admitted)
    }
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
          : ''
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
    // Deploy, then admit the issuer itself: the deploy admits no identity, and
    // an identity row is what lets a wallet that loses the head recover it.
    const genesis = await registerIdentities({ wallet: p.wallet, identityKey: p.issuerIdentityKey })
    const self = await admitOrRevokeIdentity({
      wallet: p.wallet,
      kind: 'admitIdentity',
      targetKey: p.issuerIdentityKey,
      issuerIdentityKey: p.issuerIdentityKey,
      live: { authOutpoint: genesis.authOutpoint, authKeyID: genesis.authKeyID, tokenId: genesis.tokenId }
    })
    return { authOutpoint: self.authOutpoint, opened: true, recovered: false }
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
      live = { authOutpoint: genesis.authOutpoint, authKeyID: genesis.authKeyID, tokenId: genesis.tokenId }
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

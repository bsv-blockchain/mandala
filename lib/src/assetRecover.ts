/**
 * Re-attach a live per-asset admin-auth UTXO the overlay already admitted but
 * this wallet no longer lists (A10).
 *
 * The wallet basket is the only place the live admin outpoint is normally
 * known, and a wallet that reclassifies the 1-sat auth output as plain P2PKH
 * strips that bookkeeping with it — after which `listAdminAssets` is empty
 * and every admin action on the asset is impossible. The overlay's admin
 * history holds the same chain, so it can hand the head back:
 * `GET /admin/authorities/:tokenId` and the BEEF to spend it. Near-copy of
 * registryRecover.ts for the registry spine.
 */
import { Transaction, Utils, WalletInterface } from '@bsv/sdk'
import { BASKET, OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'
import { AdminAsset, adminCustomInstructions, listAdminAssets } from './assets.js'
import { resolveAssetMetadata } from './metadata.js'
import { authorityKeyIdOf } from './brc162.js'
import { beefFromWhatsOnChain, toAtomicBeef } from './registryRecover.js'

/** The overlay's view of a token's live authority (`GET /admin/authorities/:tokenId`). */
export interface OverlayAssetAuth {
  authOutpoint: string
  /** The authority owner (issuer identity key). */
  identityKey: string
}

function asBytes (v: unknown): number[] | null {
  if (Array.isArray(v) && v.every(n => typeof n === 'number')) return v as number[]
  if (typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
    return Utils.toArray(v, 'hex')
  }
  return null
}

function parseOutpoint (outpoint: string): { txid: string, vout: number } {
  const dot = outpoint.lastIndexOf('.')
  const txid = dot > 0 ? outpoint.slice(0, dot) : ''
  const vout = Number(outpoint.slice(dot + 1))
  if (txid === '' || !Number.isInteger(vout) || vout < 0) throw new Error(`bad admin auth outpoint ${outpoint}`)
  return { txid, vout }
}

/**
 * The token's live authority as the overlay sees it, or null when it holds
 * none (404, or an empty list). Several live authorities: the first owned by
 * `issuerIdentityKey` when given, else the first. Any other failure throws:
 * silence must not read as "nothing to recover".
 */
export async function fetchAssetAuthHead (assetId: string, issuerIdentityKey?: string): Promise<OverlayAssetAuth | null> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  const res = await fetch(`${OVERLAY_URL}/admin/authorities/${encodeURIComponent(assetId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`authorities fetch failed: ${res.status}`)
  const body = await res.json() as { authorities?: Array<{ outpoint?: unknown, identityKey?: unknown }> }
  const rows = (body.authorities ?? []).filter(r => typeof r?.outpoint === 'string' && typeof r?.identityKey === 'string') as Array<{ outpoint: string, identityKey: string }>
  const mine = issuerIdentityKey != null ? rows.find(r => r.identityKey.toLowerCase() === issuerIdentityKey.toLowerCase()) : undefined
  const head = mine ?? rows[0]
  return head == null ? null : { authOutpoint: head.outpoint, identityKey: head.identityKey }
}

/** BEEF for the authority tx: the overlay's engine store first, the chain as a fallback. */
export async function fetchAssetAuthBeef (txid: string, outputIndex: number): Promise<number[] | null> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const res = await fetch(`${OVERLAY_URL}/admin/authorities/beef/${txid}?vout=${outputIndex}`)
    if (res.ok) {
      const body = await res.json() as { beef?: unknown }
      const fromOverlay = asBytes(body.beef)
      if (fromOverlay != null && fromOverlay.length > 0) return fromOverlay
    }
  } catch { /* fall through to chain */ }
  return await beefFromWhatsOnChain(txid)
}

/** Label + metadata for the recovered asset, best source first. */
async function describeAsset (
  assetId: string,
  listed: AdminAsset | null
): Promise<{ label: string, metadata?: Record<string, unknown> }> {
  if (listed != null) return { label: listed.label, metadata: listed.metadata }
  const meta = await resolveAssetMetadata(assetId).catch(() => null)
  if (meta != null) return { label: meta.label, metadata: meta as unknown as Record<string, unknown> }
  return { label: `${assetId.slice(0, 8)}…` }
}

/**
 * Put the token's live authority UTXO back in this wallet's basket with the
 * customInstructions `listAdminAssets` needs. The keyID is recomputed from
 * the output itself (commitment hex, or 'deploy'). Idempotent. Returns null
 * when the overlay holds no live authority for the token.
 */
export async function recoverAdminAuth (p: {
  wallet: WalletInterface
  assetId: string
  issuerIdentityKey?: string
}): Promise<AdminAsset | null> {
  const listedFor = async (): Promise<AdminAsset | null> =>
    (await listAdminAssets(p.wallet)).find(a => a.assetId === p.assetId) ?? null
  const head = await fetchAssetAuthHead(p.assetId, p.issuerIdentityKey)
  if (head == null) return await listedFor()
  const listed = await listedFor()
  if (listed?.authOutpoint === head.authOutpoint) return listed
  const { txid, vout } = parseOutpoint(head.authOutpoint)
  const beef = await fetchAssetAuthBeef(txid, vout)
  if (beef == null) throw new Error(`could not load authority tx ${txid}`)
  const atomic = toAtomicBeef(beef, txid)
  const script = Transaction.fromAtomicBEEF(atomic).outputs[vout]?.lockingScript
  const authKeyID = script != null ? authorityKeyIdOf(script) : null
  if (authKeyID == null) throw new Error(`${head.authOutpoint} is not an authority output`)
  const { label, metadata } = await describeAsset(p.assetId, listed)
  try {
    await p.wallet.internalizeAction({
      tx: atomic,
      labels: ['mandala', 'admin', 'recover'],
      outputs: [{
        outputIndex: vout,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: BASKET,
          customInstructions: adminCustomInstructions(p.assetId, label, authKeyID, metadata),
          tags: ['mandala-admin']
        }
      }],
      description: `Re-attach ${label} asset authority`
    })
  } catch (e) {
    if (!/already|duplicate|exists/i.test(String(e))) throw e
  }
  const again = await listedFor()
  if (again?.authOutpoint === head.authOutpoint) return again
  return { assetId: p.assetId, label, authOutpoint: head.authOutpoint, authKeyID, metadata }
}

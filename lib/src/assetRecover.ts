/**
 * Re-attach a live per-asset admin-auth UTXO the overlay already admitted but
 * this wallet no longer lists (A10).
 *
 * The wallet basket is the only place the live admin outpoint is normally
 * known, and a wallet that reclassifies the 1-sat auth output as plain P2PKH
 * strips that bookkeeping with it — after which `listAdminAssets` is empty
 * and every admin action on the asset is impossible. The overlay's admin
 * history holds the same chain, so it can hand the head back:
 * `GET /admin/asset-auth/:assetId` and the BEEF to spend it. Near-copy of
 * registryRecover.ts for the registry spine.
 */
import { Utils, WalletInterface } from '@bsv/sdk'
import type { MandalaActionDetails } from '@bsv/templates'
import { adminAuthHeaders, BASKET, OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'
import { AdminAsset, adminCustomInstructions, listAdminAssets } from './assets.js'
import { resolveAssetMetadata } from './metadata.js'
import { beefFromWhatsOnChain, toAtomicBeef } from './registryRecover.js'

/** The overlay's view of an asset's live admin authority (`GET /admin/asset-auth/:assetId`). */
export interface OverlayAssetAuth {
  authOutpoint: string
  authDetails: MandalaActionDetails
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
 * The chain head of the asset's admin outputs as the overlay sees it, or null
 * when the overlay holds no admin history for the asset (404). Any other
 * failure throws: silence must not read as "nothing to recover".
 */
export async function fetchAssetAuthHead (assetId: string): Promise<OverlayAssetAuth | null> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  const res = await fetch(`${OVERLAY_URL}/admin/asset-auth/${encodeURIComponent(assetId)}`, { headers: adminAuthHeaders() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`asset-auth fetch failed: ${res.status}`)
  const body = await res.json() as { authOutpoint?: unknown, authDetails?: unknown }
  if (typeof body.authOutpoint !== 'string' || body.authOutpoint === '') return null
  const details = body.authDetails
  if (details == null || typeof details !== 'object' || typeof (details as { kind?: unknown }).kind !== 'string') return null
  return { authOutpoint: body.authOutpoint, authDetails: details as MandalaActionDetails }
}

/** BEEF for the admin tx: the overlay's engine store first, the chain as a fallback. */
export async function fetchAssetAuthBeef (txid: string, outputIndex: number): Promise<number[] | null> {
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const res = await fetch(`${OVERLAY_URL}/admin/asset-auth/beef/${txid}?vout=${outputIndex}`, { headers: adminAuthHeaders() })
    if (res.ok) {
      const body = await res.json() as { beef?: unknown }
      const fromOverlay = asBytes(body.beef)
      if (fromOverlay != null && fromOverlay.length > 0) return fromOverlay
    }
  } catch { /* fall through to chain */ }
  return await beefFromWhatsOnChain(txid)
}

/**
 * Label + metadata for the recovered asset, best source first: whatever the
 * basket still says (a stale entry keeps the operator's label), the genesis
 * details when the head IS the genesis, else the on-chain metadata; a short
 * asset id when nothing can be found — recovery must not fail on a label.
 */
async function describeAsset (
  assetId: string,
  head: MandalaActionDetails,
  listed: AdminAsset | null
): Promise<{ label: string, metadata?: Record<string, unknown> }> {
  if (listed != null) return { label: listed.label, metadata: listed.metadata }
  if (head.kind === 'register' && typeof head.label === 'string') {
    const label = head.label
    return { label, metadata: { label, ticker: head.ticker, decimals: head.decimals, issuer: head.issuer } }
  }
  const meta = await resolveAssetMetadata(assetId).catch(() => null)
  if (meta != null) return { label: meta.label, metadata: meta as Record<string, unknown> }
  return { label: `${assetId.slice(0, 8)}…` }
}

/**
 * Put the asset's live admin-auth UTXO back in this wallet's basket with the
 * customInstructions `listAdminAssets` needs, from the overlay's view of the
 * chain. Idempotent: an output the wallet already holds is a no-op, so a
 * double click or a second tab converges on the same head. Returns the live
 * head even when the basket listing still lacks it — the overlay, not the
 * basket, is the source of truth for the chain — or null when the overlay
 * has never admitted an admin output for the asset.
 */
export async function recoverAdminAuth (p: {
  wallet: WalletInterface
  assetId: string
}): Promise<AdminAsset | null> {
  const listedFor = async (): Promise<AdminAsset | null> =>
    (await listAdminAssets(p.wallet)).find(a => a.assetId === p.assetId) ?? null
  const head = await fetchAssetAuthHead(p.assetId)
  if (head == null) return await listedFor()
  const listed = await listedFor()
  if (listed?.authOutpoint === head.authOutpoint) return listed
  const { txid, vout } = parseOutpoint(head.authOutpoint)
  const beef = await fetchAssetAuthBeef(txid, vout)
  if (beef == null) throw new Error(`could not load admin tx ${txid}`)
  const { label, metadata } = await describeAsset(p.assetId, head.authDetails, listed)
  try {
    await p.wallet.internalizeAction({
      tx: toAtomicBeef(beef, txid),
      labels: ['mandala', 'admin', 'recover'],
      outputs: [{
        outputIndex: vout,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: BASKET,
          customInstructions: adminCustomInstructions(p.assetId, label, head.authDetails, metadata),
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
  return { assetId: p.assetId, label, authOutpoint: head.authOutpoint, authDetails: head.authDetails, metadata }
}

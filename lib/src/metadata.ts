import { LookupResolver, Transaction, WhatsOnChain } from '@bsv/sdk'
import { MandalaAdmin } from '@bsv/templates'
import type { AssetMetadata } from '@bsv/templates'
export type { AssetMetadata }
import { OVERLAY_URL, OVERLAY_URL_UNSET, LOOKUP } from './constants.js'

const cache = new Map<string, AssetMetadata | null>()

// Pure decode helper (unit-testable without network): read output `index`'s
// locking script from a BEEF and return its MandalaAdmin publicData, or null.
export function parseMetadataFromBeef (beef: number[], index: number): AssetMetadata | null {
  try {
    const tx = Transaction.fromBEEF(beef)
    const ls = tx.outputs[index]?.lockingScript
    if (ls == null) return null
    const decoded = MandalaAdmin.decode(ls)
    if (decoded.publicData == null || typeof (decoded.publicData as any).label !== 'string') return null
    return decoded.publicData as AssetMetadata
  } catch {
    return null
  }
}

// Resolve an asset's on-chain metadata by assetId: query the overlay lookup for
// the genesis output, SPV-verify the genesis tx, then decode publicData. Memoized.
export async function resolveAssetMetadata (assetId: string): Promise<AssetMetadata | null> {
  if (cache.has(assetId)) return cache.get(assetId) ?? null
  // Outside the try: an unconfigured overlay must not read as "no metadata".
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  let result: AssetMetadata | null = null
  try {
    const resolver = new LookupResolver({ networkPreset: 'mainnet', hostOverrides: { [LOOKUP]: [OVERLAY_URL] } })
    const answer = await resolver.query({ service: LOOKUP, query: { metadataAssetId: assetId } })
    const dotIndex = assetId.lastIndexOf('.')
    const vout = Number(assetId.slice(dotIndex + 1))
    for (const out of answer.outputs) {
      const tx = Transaction.fromBEEF(out.beef)
      // A freshly registered genesis has no Merkle path yet, so a full SPV
      // check fails until it is mined. The overlay that served this output is
      // the same authority whose admission signatures the holder already
      // trusts, so fall back to a scripts-only verification of the BEEF
      // instead of treating an unmined genesis as "unknown asset".
      let verified = false
      try { verified = await tx.verify(new WhatsOnChain('main')) } catch { verified = false }
      if (!verified) {
        try { verified = await tx.verify('scripts only') } catch { verified = false }
      }
      if (!verified) continue
      const idx = typeof (out as any).outputIndex === 'number' ? (out as any).outputIndex : vout
      const meta = parseMetadataFromBeef(out.beef, idx)
      if (meta != null) { result = meta; break }
    }
  } catch (e) {
    console.warn(`[mandala] asset metadata lookup failed for ${assetId}:`, e instanceof Error ? e.message : e)
    result = null
  }
  // Only a positive answer is memoized: a transient lookup/network failure
  // must not brand the asset "unidentified" for the rest of the process.
  if (result != null) cache.set(assetId, result)
  return result
}

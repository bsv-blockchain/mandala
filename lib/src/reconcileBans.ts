/**
 * Relinquish outputs the overlay has evicted (reissued to another holder) but
 * that still linger in our basket. Evicted outputs are permanently dead — unlike
 * frozen ones, which may later unfreeze — so they are safe to drop.
 *
 * Trust model: the endpoint is authoritative. The overlay only lists an outpoint
 * in evictedOutpoints after validating the issuer's authenticated reissue tx, so
 * no client-side sender check is needed. Fail open: an unreachable endpoint
 * (state === null) relinquishes nothing.
 */
import { WalletInterface } from '@bsv/sdk'
import { TREASURY_BASKET } from './constants.js'
import { resolveAssetState } from './adminState.js'

export async function reconcileBans (
  wallet: WalletInterface,
  assetIds: string[]
): Promise<string[]> {
  const relinquished: string[] = []

  // What we currently hold, once — evicted matching is by outpoint string.
  const held = new Set<string>()
  try {
    const res = await wallet.listOutputs({ basket: TREASURY_BASKET, limit: 1000 })
    for (const o of res.outputs) held.add(o.outpoint as string)
  } catch { return relinquished }

  for (const assetId of assetIds) {
    // Fail open PER ASSET — a throw for one asset (transient network error)
    // must not abort the loop and silently skip every later asset.
    let state
    try {
      state = await resolveAssetState(assetId)
    } catch {
      continue
    }
    if (state == null) continue // fail open
    for (const op of state.evictedOutpoints) {
      if (!held.has(op)) continue
      try {
        await wallet.relinquishOutput({ basket: TREASURY_BASKET, output: op })
        relinquished.push(op)
      } catch { /* already gone / not ours — idempotent, ignore */ }
    }
  }
  return relinquished
}

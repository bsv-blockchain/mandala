/**
 * Shim over the pinned @bsv/overlay-topics mandala reducer.
 *
 * The eviction rebuild must replay an asset's admin history EXCLUDING the
 * evicted txid's rows (rebuild-first, then delete), which the pinned
 * `MandalaLookupService.rebuildState(assetId)` cannot do: it reads every row.
 * `foldAction`/`defaultAssetState` are exported by the reducer module but not
 * from the package index, and the package `exports` map blocks deep imports,
 * so the file is resolved by absolute path.
 *
 * TODO ts-stack: export foldAction/defaultAssetState from @bsv/overlay-topics index; drop this shim after publish.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

/** Mirrors `AssetAdminState` in the pinned dist/mandala/AssetStateReducer.d.ts. */
export interface AssetAdminState {
  assetId: string
  issuerIdentityKey: string
  isPaused: boolean
  accessMode: 'denylist' | 'allowlist'
  blockedIdentities: string[]
  allowedIdentities: string[]
  frozenOutpoints: Array<{ outpoint: string, amount: number, owner: string }>
  evictedOutpoints: string[]
  lastProcessedHeight: number
  lastProcessedOffset: number
  lastAdmitSeq: number
}
/** Mirrors `FoldContext` in the pinned reducer. */
export interface FoldContext { frozenAmount?: number, frozenOwner?: string, issuer?: string }
type Details = Record<string, unknown> & { kind?: unknown }

// The entry point is the one path the exports map allows; the package root is
// two levels above dist/index.js.
const pkgDir = dirname(dirname(fileURLToPath(import.meta.resolve('@bsv/overlay-topics'))))
const pkgVersion = String((JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: string }).version)
const mod = await import(pathToFileURL(join(pkgDir, 'dist', 'mandala', 'AssetStateReducer.js')).href) as Record<string, unknown>
if (typeof mod.foldAction !== 'function' || typeof mod.defaultAssetState !== 'function') {
  throw new Error(
    `@bsv/overlay-topics ${pkgVersion}: dist/mandala/AssetStateReducer.js no longer exports foldAction/defaultAssetState; update src/pinnedReducer.ts`
  )
}

export const foldAction = mod.foldAction as (state: AssetAdminState, details: Details, ctx?: FoldContext) => AssetAdminState
export const defaultAssetState = mod.defaultAssetState as (assetId: string) => AssetAdminState

export interface ReplayStorage {
  getTokenRow: (txid: string, outputIndex: number) => Promise<{ amount: number, identityKey: string } | null>
  putAssetState: (state: AssetAdminState) => Promise<void>
}

/**
 * Exactly the pinned `rebuildState` loop (same ctx sourcing; lastProcessed* and
 * lastAdmitSeq left at their defaults, as the pinned rebuild leaves them), over
 * a caller-supplied row set — oldest first.
 */
export const replayAssetState = async (
  assetId: string, history: Array<{ actionDetails: Details }>, storage: ReplayStorage
): Promise<AssetAdminState> => {
  let state = defaultAssetState(assetId)
  for (const e of history) {
    const d = e.actionDetails
    const ctx: FoldContext = {}
    if (d.kind === 'freezeOutput' && typeof d.outpoint === 'string') {
      const [ft, fv] = d.outpoint.split('.')
      const row = await storage.getTokenRow(ft, Number(fv))
      if (row != null) {
        ctx.frozenAmount = row.amount
        ctx.frozenOwner = row.identityKey
      }
    }
    if (d.kind === 'register' && typeof d.issuer === 'string') ctx.issuer = d.issuer
    state = foldAction(state, d, ctx)
  }
  await storage.putAssetState(state)
  return state
}

/**
 * Holder view assembly (BRC-207 `p color` views, 0207:606-697):
 * - exact balance per asset from `p color balance <assetTag>` (BRC-112 decimal);
 * - `unsettled` (inside the balance) and `incoming` (outside it) from the
 *   tagged `p color assets` inventory (Task 5 `summarizeInventory`);
 * - holder-scope history and asset metadata.
 *
 * Pure over its injected dependencies so it is unit-tested without React.
 * Never reads the old `'p mandala'` / `mandala-tokens` baskets.
 */
import type { WalletInterface } from '@bsv/sdk'
import type { HistoryRow, loadHistory, listAdminAssets, resolveAssetMetadata } from '@bsv/mandala'
import {
  INVENTORY_SELECTOR,
  balanceSelector,
  listAllOutputs,
  parseBalanceTotal,
  summarizeInventory
} from './holderBalances'

export interface AssetMeta {
  label: string
  decimals: number
  ticker?: string
  issuer?: string
}

export interface AssetRow {
  assetId: string
  /** Exact available units from the balance view; `null` when that view failed. */
  balance: bigint | null
  /** `color_offline` ∧ available: already part of `balance` (awaiting settlement). */
  unsettled: bigint
  /** `color_state_pending`: NOT part of `balance`. */
  incoming: bigint
  meta: AssetMeta
}

export interface HolderData {
  assets: AssetRow[]
  history: HistoryRow[]
  metas: Record<string, AssetMeta>
}

export interface HolderDataDeps {
  loadHistory: typeof loadHistory
  listAdminAssets: typeof listAdminAssets
  resolveAssetMetadata: typeof resolveAssetMetadata
}

/** `dec` is an integer 0..18 (0162:246-252); anything else displays as 0. */
function decimalsOf (v: unknown): number {
  const d = Number(v)
  return Number.isInteger(d) && d >= 0 && d <= 18 ? d : 0
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

async function balanceOf (wallet: WalletInterface, assetId: string): Promise<bigint | null> {
  try {
    const res = await wallet.listOutputs({ basket: balanceSelector(assetId) })
    return parseBalanceTotal(res.totalOutputs)
  } catch (e) {
    console.warn(`[mandala] balance view failed for ${assetId}:`, e instanceof Error ? e.message : e)
    return null
  }
}

async function loadMetas (wallet: WalletInterface, assetIds: string[], deps: HolderDataDeps): Promise<Record<string, AssetMeta>> {
  // Own admin assets are authoritative (issuer running the holder view);
  // everything else resolves via the overlay registry, cached per asset.
  const metas: Record<string, AssetMeta> = {}
  try {
    for (const a of await deps.listAdminAssets(wallet)) {
      metas[a.assetId] = {
        label: a.label,
        decimals: decimalsOf(a.metadata?.decimals),
        ticker: str(a.metadata?.ticker),
        issuer: str(a.metadata?.issuer)
      }
    }
  } catch { /* holder wallets typically have none */ }

  await Promise.all(assetIds.filter(id => metas[id] == null).map(async id => {
    let meta: Awaited<ReturnType<typeof resolveAssetMetadata>> = null
    try {
      meta = await deps.resolveAssetMetadata(id)
    } catch (e) {
      // Missing metadata must not hide balances: fall back to a short label.
      console.warn(`[mandala] metadata unavailable for ${id}:`, e instanceof Error ? e.message : e)
    }
    metas[id] = {
      label: meta?.label ?? `${id.slice(0, 10)}…`,
      decimals: decimalsOf(meta?.decimals),
      ticker: str(meta?.ticker),
      issuer: str(meta?.issuer)
    }
  }))
  return metas
}

/**
 * Inventory first, alone: the first module read establishes the wallet's
 * `color_access` grant, so parallel reads must not race two consent prompts.
 * An inventory failure fails the whole load (no partial holder view). Then
 * history, admin/overlay metadata and one balance view per asset run in
 * parallel; a failed balance view yields `null` for that asset only.
 */
export async function loadHolderData (wallet: WalletInterface, deps: HolderDataDeps): Promise<HolderData> {
  const inventory = await listAllOutputs(wallet, { basket: INVENTORY_SELECTOR, include: 'locking scripts', includeTags: true })
  const summary = summarizeInventory(inventory)

  // balanceOf never rejects, so these may start before history settles.
  const balances = new Map<string, Promise<bigint | null>>()
  const balance = async (id: string): Promise<bigint | null> => {
    let p = balances.get(id)
    if (p === undefined) {
      p = balanceOf(wallet, id)
      balances.set(id, p)
    }
    return await p
  }
  for (const id of summary.keys()) void balance(id)

  const history = await deps.loadHistory(wallet, { scope: 'holder' })
  const assetIds = [...new Set<string>([...summary.keys(), ...history.map(r => r.assetId)])]

  const [values, metas] = await Promise.all([
    Promise.all(assetIds.map(balance)),
    loadMetas(wallet, assetIds, deps)
  ])

  const assets: AssetRow[] = assetIds.map((assetId, i) => ({
    assetId,
    balance: values[i],
    unsettled: summary.get(assetId)?.unsettled ?? 0n,
    incoming: summary.get(assetId)?.incoming ?? 0n,
    meta: metas[assetId]
  }))
  // Non-zero balances first, then alphabetical (a failed view sorts as zero).
  const positive = (a: AssetRow): boolean => a.balance !== null && a.balance > 0n
  assets.sort((a, b) => {
    const pa = positive(a)
    const pb = positive(b)
    if (pa !== pb) return pa ? -1 : 1
    return a.meta.label.localeCompare(b.meta.label)
  })

  return { assets, history, metas }
}

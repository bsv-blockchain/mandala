/**
 * BRC-207 holder views (0207:606-697): the `p color assets` inventory and the
 * `p color balance <assetTag>` exact-balance selectors, built from the lib's
 * `assetTag` (contract §8.1:572 — no lib helper). Pure, bigint throughout.
 *
 * Balance semantics (0207:396-404, C40):
 * - `p color balance` already counts `color_offline` available outputs, so
 *   `unsettled` is a SUBSET of the balance ("of which awaiting settlement").
 * - `color_state_pending` records are excluded from the balance, so
 *   `incoming` is OUTSIDE it. Neither is ever summed into the balance or into
 *   the other.
 */
import type { ListOutputsArgs, WalletInterface, WalletOutput } from '@bsv/sdk'
import { assetTag, decodeToken } from '@bsv/mandala'
import type { AssetAdminStateView } from '@bsv/mandala/adminState'

/** Cross-basket inventory view (0207:608-612). */
export const INVENTORY_SELECTOR = 'p color assets'
/** Wallet-authored: accepted but overlay admission not yet verified (0207:396-404). */
export const OFFLINE_TAG = 'color_offline'
/** Wallet-authored state tags (0207:649). */
export const AVAILABLE_TAG = 'color_state_available'
export const PENDING_TAG = 'color_state_pending'

/** `p color balance <assetTag>` (0207:611): available token units of one asset. */
export function balanceSelector (assetId: string): string {
  return `p color balance ${assetTag(assetId)}`
}

const DECIMAL = /^(0|[1-9][0-9]*)$/

/**
 * A `listOutputs` `totalOutputs`: the BRC-112 canonical decimal string of a
 * P-basket balance (no uint64 ceiling, 0207:687), or an ordinary basket's
 * numeric count (a safe non-negative integer). Anything else throws: no
 * rounding, no partial value.
 */
export function parseBalanceTotal (total: unknown): bigint {
  if (typeof total === 'string') {
    if (!DECIMAL.test(total)) throw new Error(`malformed balance total: ${JSON.stringify(total)}`)
    return BigInt(total)
  }
  if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0) return BigInt(total)
  throw new Error(`malformed balance total: ${typeof total === 'number' ? String(total) : typeof total}`)
}

/** A BRC-100 output record as `listOutputs` returns it (`WalletOutput` fits). */
export interface InventoryRecord {
  outpoint: string
  lockingScript?: string
  tags?: string[]
}

export interface InventorySummary {
  /** `color_offline` ∧ `color_state_available`: already inside `p color balance`. */
  unsettled: bigint
  /** `color_state_pending`: not in `p color balance`. */
  incoming: bigint
}

type Decode = typeof decodeToken
type Decoded = NonNullable<ReturnType<Decode>>

const OUTPOINT = /^([0-9a-f]{64})\.(0|[1-9][0-9]{0,9})$/

/**
 * Decode one record, splitting its BRC-36 outpoint `<txid>.<vout>` (contract
 * §0) so a deploy resolves its asset id. A missing script, a throwing decoder
 * or a `null` decode skips the record.
 */
export function decodeRecord (r: InventoryRecord, decode: Decode): Decoded | null {
  if (typeof r.lockingScript !== 'string' || r.lockingScript.length === 0) return null
  const m = OUTPOINT.exec(r.outpoint)
  const vout = m !== null ? Number(m[2]) : undefined
  try {
    return m !== null && vout !== undefined && vout <= 0xffffffff
      ? decode(r.lockingScript, m[1], vout)
      : decode(r.lockingScript)
  } catch {
    return null
  }
}

/**
 * Yield each record once per outpoint: separate paged `listOutputs` calls need
 * not share a snapshot, so a repeated record must not count twice (0207:660).
 */
export function * uniqueRecords (records: InventoryRecord[]): Generator<InventoryRecord> {
  const seen = new Set<string>()
  for (const r of records) {
    if (seen.has(r.outpoint)) continue
    seen.add(r.outpoint)
    yield r
  }
}

/**
 * Per-asset `unsettled` / `incoming` from a `p color assets` page set fetched
 * with `includeTags` and `include: 'locking scripts'`. Every decodable asset
 * appears (deploy- and authority-only assets with zero figures). A value record
 * tagged pending counts only toward `incoming` (whether or not it is also
 * offline); otherwise one tagged both offline and available counts toward
 * `unsettled`; reserved, restricted and settled-available records add nothing.
 */
export function summarizeInventory (records: InventoryRecord[], decode: Decode = decodeToken): Map<string, InventorySummary> {
  const out = new Map<string, InventorySummary>()
  for (const r of uniqueRecords(records)) {
    const d = decodeRecord(r, decode)
    if (d === null || typeof d.assetId !== 'string') continue
    let s = out.get(d.assetId)
    if (s === undefined) {
      s = { unsettled: 0n, incoming: 0n }
      out.set(d.assetId, s)
    }
    if (d.role !== 'value') continue
    const tags = new Set(r.tags ?? [])
    if (tags.has(PENDING_TAG)) s.incoming += d.amount
    else if (tags.has(OFFLINE_TAG) && tags.has(AVAILABLE_TAG)) s.unsettled += d.amount
  }
  return out
}

/** Units of this identity's outputs the issuer has frozen (sum, no ceiling). */
export function frozenUnitsFor (
  state: Pick<AssetAdminStateView, 'frozenOutpoints'> | null | undefined,
  identityKey: string | null
): bigint {
  if (state == null || identityKey === null || identityKey === '') return 0n
  let sum = 0n
  for (const f of state.frozenOutpoints) if (f.owner === identityKey) sum += f.amount
  return sum
}

const MAX_PAGES = 100

/**
 * Every record of a `listOutputs` query, paged by `offset`. Stops when the
 * collected count reaches `totalOutputs` or a page comes back empty. Throws
 * rather than silently truncating once `MAX_PAGES` pages would not suffice
 * (0207:664-666).
 */
export async function listAllOutputs (
  wallet: Pick<WalletInterface, 'listOutputs'>,
  args: ListOutputsArgs,
  pageSize = 1000
): Promise<WalletOutput[]> {
  const cap = MAX_PAGES * pageSize
  const collected: WalletOutput[] = []
  for (let page = 0; ; page++) {
    const res = await wallet.listOutputs({ ...args, limit: pageSize, offset: collected.length })
    const total = parseBalanceTotal(res.totalOutputs)
    if (total > BigInt(cap)) throw new Error(`inventory exceeds ${cap} outputs`)
    collected.push(...res.outputs)
    if (BigInt(collected.length) >= total || res.outputs.length === 0) return collected
    if (page + 1 >= MAX_PAGES) throw new Error(`inventory exceeds ${cap} outputs`)
  }
}

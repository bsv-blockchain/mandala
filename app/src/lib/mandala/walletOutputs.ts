/**
 * BRC-100 output paging and 1Color record decoding for the issuer treasury
 * (TREASURY_BASKET, an ordinary basket of Mandala-key outputs). Pure, bigint
 * throughout. Holder `p color` views are not the console's concern (B8).
 */
import type { ListOutputsArgs, WalletInterface, WalletOutput } from '@bsv/sdk'
import { decodeToken } from '@bsv/mandala'

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

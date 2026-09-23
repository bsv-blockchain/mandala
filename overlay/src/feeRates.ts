/**
 * Repo-local fold of the per-asset `feeRatePerKb` parameter (token-fee design
 * §2). The pinned @bsv/overlay-topics reducer ignores unknown kinds and copies
 * only `issuer` from register, so the rate lives in its own collection
 * (`mandalaFeeRates`) until the upstream reducer learns the field. The rule is
 * byte-identical to overlay-go's feeRateOf: a safe integer ≥ 1 sets, anything
 * else disables. Register is keyed by its OWN outpoint (P0, §2.1); setFeeRate
 * by details.assetId.
 */
import { Transaction, Utils } from '@bsv/sdk'
import type { LookupService } from '@bsv/overlay'

export interface FeeRateRow { assetId: string, feeRatePerKb: number | null, setByOutpoint: string }

export interface FeeRateHistoryEntry { txid: string, outputIndex: number, actionDetails: Record<string, unknown> }

export interface FeeRateStore {
  get: (assetId: string) => Promise<FeeRateRow | null>
  findBySetBy: (outpoint: string) => Promise<FeeRateRow | null>
  upsert: (row: FeeRateRow) => Promise<void>
  /** The asset's admitted admin history, oldest first (by admitSeq). */
  historyFor: (assetId: string) => Promise<FeeRateHistoryEntry[]>
}

const FEE_KINDS = new Set(['register', 'setFeeRate'])

/** undefined = not a fee-bearing action; null = disabled; number = base units per 1000 bytes. */
export const feeRateFromDetails = (details: Record<string, unknown>): number | null | undefined => {
  if (typeof details.kind !== 'string' || !FEE_KINDS.has(details.kind)) return undefined
  const v = details.feeRatePerKb
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null
}

export const feeRateAssetId = (details: Record<string, unknown>, txid: string, outputIndex: number): string | null => {
  if (details.kind === 'register') return `${txid}.${outputIndex}`
  return typeof details.assetId === 'string' && details.assetId !== '' ? details.assetId : null
}

const adminEntryAt = (offChainValues: number[] | undefined, outputIndex: number): Record<string, unknown> | null => {
  if (offChainValues == null || offChainValues.length === 0) return null
  try {
    const parsed = JSON.parse(Utils.toUTF8(offChainValues)) as { admin?: Array<{ index: number, actionDetails?: Record<string, unknown> }> }
    return parsed.admin?.find(a => a.index === outputIndex)?.actionDetails ?? null
  } catch {
    return null
  }
}

/** Replays the asset's history, skipping `excludeOutpoint`; last fee-bearing entry wins. */
export const recomputeFeeRate = (
  history: FeeRateHistoryEntry[],
  excludeOutpoint: string
): { feeRatePerKb: number | null, setByOutpoint: string } => {
  let out: { feeRatePerKb: number | null, setByOutpoint: string } = { feeRatePerKb: null, setByOutpoint: '' }
  for (const e of history) {
    const op = `${e.txid}.${e.outputIndex}`
    if (op === excludeOutpoint) continue
    const rate = feeRateFromDetails(e.actionDetails)
    if (rate === undefined) continue
    out = { feeRatePerKb: rate, setByOutpoint: op }
  }
  return out
}

export const withFeeRate = <S extends object>(state: S, row: FeeRateRow | null): S & { feeRatePerKb: number | null } =>
  ({ ...state, feeRatePerKb: row?.feeRatePerKb ?? null })

export const withFeeRateFold = (inner: LookupService, store: FeeRateStore): LookupService => {
  const wrapped: LookupService = {
    ...inner,
    outputAdmittedByTopic: async (p) => {
      await inner.outputAdmittedByTopic(p)
      if (p.topic !== 'tm_mandala' || p.mode !== 'whole-tx') return
      const details = adminEntryAt(p.offChainValues, p.outputIndex)
      if (details == null) return
      const rate = feeRateFromDetails(details)
      if (rate === undefined) return
      const txid = Transaction.fromBEEF(p.atomicBEEF).id('hex')
      const assetId = feeRateAssetId(details, txid, p.outputIndex)
      if (assetId == null) return
      await store.upsert({ assetId, feeRatePerKb: rate, setByOutpoint: `${txid}.${p.outputIndex}` })
    },
    outputEvicted: async (txid, outputIndex) => {
      await inner.outputEvicted(txid, outputIndex)
      const op = `${txid}.${outputIndex}`
      const row = await store.findBySetBy(op)
      if (row == null) return
      const next = recomputeFeeRate(await store.historyFor(row.assetId), op)
      await store.upsert({ assetId: row.assetId, ...next })
    }
  }
  // Preserve prototype-bound methods (lookup/getDocumentation/getMetaData/
  // outputSpent/rebuildState) that the spread copies as plain references.
  return new Proxy(wrapped, {
    get: (target, prop, receiver) =>
      prop === 'outputAdmittedByTopic' || prop === 'outputEvicted'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}

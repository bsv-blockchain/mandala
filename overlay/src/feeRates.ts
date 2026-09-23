/**
 * Repo-local fold of the per-asset `feeRatePerKb` parameter (token-fee design
 * §2). The pinned @bsv/overlay-topics reducer ignores unknown kinds and copies
 * only `issuer` from register, so the rate lives in its own collection
 * (`mandalaFeeRates`) until the upstream reducer learns the field. The rule is
 * byte-identical to overlay-go's feeRateOf: a safe integer ≥ 1 sets, anything
 * else disables. Register is keyed by its OWN outpoint (P0, §2.1); setFeeRate
 * by details.assetId.
 *
 * The fold only applies to admin outputs: an admin entry in the off-chain
 * payload is folded only when the output at its index decodes as a
 * MandalaAdmin script, matching overlay-go which folds only after
 * DecodeAdmin succeeds. The topic manager admits an FT output as FT
 * regardless of which admin entry shares its index, so without this gate
 * anyone could attach `{index: <FT vout>, kind: 'register', feeRatePerKb: N}`
 * to their own FT transfer and create a row keyed by an FT outpoint.
 *
 * Eviction rolls the rate back. Since 2026-09-22 (PR #11) eviction on both
 * engines purges the evicted txid's `mandalaAdminHistory` rows and refolds
 * every touched asset from the surviving rows (Go `RebuildState`, which folds
 * FeeRatePerKb through FoldAction; TS the pinned `rebuildState`, which ignores
 * it). The TS eviction step therefore also rebuilds this row from the same
 * surviving history (`rebuildFeeRate`) in the same call, matching Go's fold.
 * The engine's own `outputEvicted` callback is left unoverridden here; it
 * resolves straight through to `inner` (via the Proxy below when `inner` is a
 * class instance whose method lives on the prototype).
 */
import { Transaction, Utils } from '@bsv/sdk'
import type { LookupService } from '@bsv/overlay'
import { MandalaAdmin } from '@bsv/templates'

export interface FeeRateRow { assetId: string, feeRatePerKb: number | null, setByOutpoint: string }

/** One `mandalaAdminHistory` row, as much of it as the fee-rate replay reads. */
export interface FeeRateHistoryEntry { txid: string, outputIndex: number, actionDetails: Record<string, unknown> }

export interface FeeRateStore {
  get: (assetId: string) => Promise<FeeRateRow | null>
  upsert: (row: FeeRateRow) => Promise<void>
  /**
   * The asset's admin-history rows, oldest first — sorted
   * `{ height: 1, offset: 1, admitSeq: 1 }`, the order the pinned
   * `findAdminHistoryByAssetId` and Go `FindAdminHistoryByAssetID` use.
   */
  historyFor: (assetId: string) => Promise<FeeRateHistoryEntry[]>
}

const FEE_KINDS = new Set(['register', 'setFeeRate'])

/** undefined = not a fee-bearing action; null = disabled; number = base units per 1000 bytes. */
export const feeRateFromDetails = (details: Record<string, unknown>): number | null | undefined => {
  if (typeof details.kind !== 'string' || !FEE_KINDS.has(details.kind)) return undefined
  const v = details.feeRatePerKb
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null
}

/**
 * Replay an asset's admin history (oldest first) into its fee-rate row, the
 * way Go's RebuildState folds FeeRatePerKb: every register/setFeeRate entry
 * overwrites the rate (null included), every other kind is skipped. The
 * history is already keyed by asset (a register's row sits under its own
 * genesis outpoint) and eviction has already purged the evicted rows, so the
 * replay takes the rows as they are. No fee-bearing entry → null, no setter.
 */
export const recomputeFeeRate = (history: FeeRateHistoryEntry[]): Omit<FeeRateRow, 'assetId'> => {
  let out: Omit<FeeRateRow, 'assetId'> = { feeRatePerKb: null, setByOutpoint: '' }
  for (const e of history) {
    const rate = feeRateFromDetails(e.actionDetails)
    if (rate === undefined) continue
    out = { feeRatePerKb: rate, setByOutpoint: `${e.txid}.${e.outputIndex}` }
  }
  return out
}

/** Rebuild the asset's fee-rate row from its surviving admin history (eviction). */
export const rebuildFeeRate = async (store: FeeRateStore, assetId: string): Promise<void> => {
  await store.upsert({ assetId, ...recomputeFeeRate(await store.historyFor(assetId)) })
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

export const withFeeRate = <S extends object>(state: S, row: FeeRateRow | null): S & { feeRatePerKb: number | null } =>
  ({
    ...state,
    feeRatePerKb: row != null ? row.feeRatePerKb : ((state as { feeRatePerKb?: number | null }).feeRatePerKb ?? null)
  })

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
      const tx = Transaction.fromBEEF(p.atomicBEEF)
      const output = tx.outputs[p.outputIndex]
      if (output == null) return
      try {
        // Byte-identical gate to overlay-go, which folds only after
        // DecodeAdmin succeeds: an admin entry sharing its index with an FT
        // (or any other non-admin) output must not be folded.
        MandalaAdmin.decode(output.lockingScript)
      } catch {
        return
      }
      const txid = tx.id('hex')
      const assetId = feeRateAssetId(details, txid, p.outputIndex)
      if (assetId == null) return
      await store.upsert({ assetId, feeRatePerKb: rate, setByOutpoint: `${txid}.${p.outputIndex}` })
    }
  }
  // Preserve prototype-bound methods (outputEvicted/lookup/getDocumentation/
  // getMetaData/outputSpent/rebuildState) that the spread above does not
  // copy as own properties when `inner` is a class instance.
  return new Proxy(wrapped, {
    get: (target, prop, receiver) =>
      prop === 'outputAdmittedByTopic'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}

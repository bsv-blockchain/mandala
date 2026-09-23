/**
 * Admin-chain anchoring for `tm_mandala`.
 *
 * Authority on the admin chain is the CHAIN OF SPENDS, not key re-derivation.
 * `MandalaTopicManager.verifyAdminOutput` takes `counterparty` from the
 * unauthenticated off-chain payload and re-derives the expected lock key with
 * `forSelf: false`; by BRC-42 that yields a key the named counterparty can
 * itself compute — and spend — from its own root key plus the overlay's
 * PUBLIC identity key. Re-derivation therefore proves nothing about who
 * authored the action. Worse, the upstream prior check accepts any input of
 * the same transaction, so an attacker points `priorOutpoint` at a coin it
 * already owns.
 *
 * Together those let a third party forge `unpause`, `unfreeze`, `allowIdentity`
 * and — because a verified admin output credits authorized issuance —
 * `issue`/`reissue`, i.e. an unbounded mint.
 *
 * This wrapper closes it without changing the upstream package: before the
 * inner manager runs, every admin entry in the payload must either be a
 * genesis `register` (which creates its own asset and carries no assetId, and
 * confers authority over nothing that exists) or name a `priorOutpoint` that is
 * BOTH an input the engine lists in `previousCoins` — outputs this topic
 * previously admitted — AND a recorded admin output of that same asset.
 * Delegation still works: whoever the new admin output is locked to holds
 * authority next, because producing it required spending the recorded prior.
 *
 * Remove this wrapper once the equivalent gate ships in
 * `@bsv/overlay-topics`; the rule must be identical on both.
 */
import { Transaction, Utils } from '@bsv/sdk'
import type { TopicManager } from '@bsv/overlay'
import { splitOutpoint } from './assetAuth.js'
import { infra } from './submitVerdict.js'

export interface AdminChainStore {
  /** Has this topic already admitted `txid.vout` as an admin output of `assetId`? */
  isAdminOutpoint: (assetId: string, txid: string, vout: number) => Promise<boolean>
  /** Is `txid.vout` a live token row (an unspent coin this overlay indexed)? */
  hasTokenRow: (txid: string, vout: number) => Promise<boolean>
}

/** A16: same string as overlay-go TopicManager — the client's UX keys on it. */
export const FREEZE_NO_ROW = (outpoint: string): string =>
  `tm_mandala: freezeOutput targets an outpoint with no token row: ${outpoint}`

/**
 * A16: a `freezeOutput` whose target has no token row folds to
 * `{amount: 0, owner: ''}` — a coin that can only ever be unfrozen, never
 * reissued. Refuse it at admission. Fails closed on a malformed outpoint.
 * Kinds other than freezeOutput are not subject to this check.
 */
export const freezeTargetHasRow = async (
  details: Record<string, unknown>,
  store: Pick<AdminChainStore, 'hasTokenRow'>
): Promise<boolean> => {
  if (details.kind !== 'freezeOutput') return true
  const op = typeof details.outpoint === 'string' ? splitOutpoint(details.outpoint) : null
  if (op == null) return false
  // §9.5: a malformed outpoint is content (false → a final refusal); a store
  // that cannot answer is infrastructure (InfraError → 503, never persisted).
  return await infra('the token row store', async () => await store.hasTokenRow(op.txid, op.vout))
}

interface AdminEntry { index: number, actionDetails?: Record<string, unknown> }

const outpointOf = (inp: { sourceTXID?: string, sourceTransaction?: Transaction, sourceOutputIndex: number }): string =>
  `${inp.sourceTXID ?? inp.sourceTransaction?.id('hex') ?? ''}.${inp.sourceOutputIndex}`

export const parseAdminEntries = (offChainValues?: number[]): AdminEntry[] => {
  if (offChainValues == null || offChainValues.length === 0) return []
  try {
    const parsed = JSON.parse(Utils.toUTF8(offChainValues)) as { admin?: AdminEntry[] }
    return Array.isArray(parsed.admin) ? parsed.admin : []
  } catch {
    return []
  }
}

/**
 * True when this admin entry is anchored to the asset's admin chain.
 * Exported for testing; `register` is genesis and needs no prior.
 */
export const adminEntryAnchored = async (
  details: Record<string, unknown>,
  admittedInputs: Set<string>,
  store: AdminChainStore
): Promise<boolean> => {
  // P0 (token-fee design §2.1): register is genesis — its assetId IS its own
  // outpoint — so it must not name one. Anything but absent/'' is an attempt
  // to graft onto an existing asset's chain. Byte-identical rule in
  // overlay-go registerIsGenesis.
  if (details.kind === 'register') return details.assetId === undefined || details.assetId === ''
  const prior = typeof details.priorOutpoint === 'string' ? details.priorOutpoint : ''
  const assetId = typeof details.assetId === 'string' ? details.assetId : ''
  if (prior === '' || assetId === '') return false
  if (!admittedInputs.has(prior)) return false
  const dot = prior.lastIndexOf('.')
  if (dot <= 0) return false
  const txid = prior.slice(0, dot)
  const vout = Number(prior.slice(dot + 1))
  if (!Number.isInteger(vout) || vout < 0) return false
  // §9.5: the admin-history read is the state this guard gates on. Swallowing a
  // fault here would fail OPEN on the exact check that stops admin forgery.
  return await infra('the admin history store', async () => await store.isAdminOutpoint(assetId, txid, vout))
}

export const withAdminChainAnchor = (inner: TopicManager, store: AdminChainStore): TopicManager => {
  const guarded: TopicManager = {
    ...inner,
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[], offChainValues?: number[]) => {
      const entries = parseAdminEntries(offChainValues)
      if (entries.length > 0) {
        const tx = Transaction.fromBEEF(beef)
        const admittedInputs = new Set(
          previousCoins.filter(ci => ci < tx.inputs.length).map(ci => outpointOf(tx.inputs[ci]))
        )
        for (const entry of entries) {
          const details = entry.actionDetails
          if (details == null) continue
          if (!await adminEntryAnchored(details, admittedInputs, store)) {
            throw new Error(
              'tm_mandala: admin action is not anchored to the asset admin chain ' +
              '(priorOutpoint must be a previously admitted admin output of this asset, spent by this transaction)'
            )
          }
          if (!await freezeTargetHasRow(details, store)) {
            throw new Error(FREEZE_NO_ROW(String(details.outpoint ?? '')))
          }
        }
      }
      return await (inner.identifyAdmissibleOutputs as (
        b: number[], p: number[], o?: number[]
      ) => Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }>)(beef, previousCoins, offChainValues)
    }
  }
  // Preserve prototype-bound methods (getDocumentation/getMetaData) that the
  // spread above copies as plain references.
  return new Proxy(guarded, {
    get: (target, prop, receiver) =>
      prop === 'identifyAdmissibleOutputs'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}

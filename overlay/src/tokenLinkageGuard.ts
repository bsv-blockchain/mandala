/**
 * FIX A, overlay half — reject-not-skip for `tm_mandala`.
 *
 * `@bsv/overlay-topics`' `MandalaTopicManager.verifyFtOutputs` walks the
 * token-shaped outputs and, for each one, `continue`s when the off-chain
 * payload carries no linkage at that index, and `continue`s again when the
 * linkage verifies to a different pubkey hash than the output is locked to.
 * `conservationHolds` then sums ONLY the admitted subset. The consequence is
 * the EB-1/SM-1 phantom coin: a transaction can carry an arbitrary extra
 * MandalaToken output of arbitrary value, the overlay still admits its
 * siblings, still signs σ_I, and still broadcasts — so the phantom is mined
 * inside a transaction the overlay genuinely attested to. An offline verifier
 * that terminates its coverage walk on "this txid was admitted" then credits
 * the phantom.
 *
 * Neither half of FIX A closes this alone: binding σ_I to the admitted OUTPUT
 * SET (admission.ts, digest v2) tells a verifier WHICH outputs were attested,
 * and this wrapper guarantees no token-shaped output escapes attestation.
 *
 * The package is pinned (ts-stack changes ship as PRs the maintainer
 * publishes), so this is the repo-local wrapper on the `withAdminChainAnchor`
 * pattern: decode every output of the submitted transaction, and if any
 * MandalaToken-decodable output lacks a VERIFIED linkage at its index, reject
 * the whole submission before the pinned manager ever runs. The wrapper has
 * everything it needs — the full BEEF and the off-chain payload — and
 * `verifyKeyLinkage` is exported from the same pinned package, so it computes
 * the pkh exactly as the manager does.
 *
 * STILL WORTH A ts-stack PR: a consumer of `@bsv/overlay-topics` without this
 * wrapper remains silently vulnerable. Turning the two `continue`s in
 * `verifyFtOutputs` into a throw with this exact reason string is the native
 * fix; the wrapper is a strictly-sufficient local mitigation, not a substitute.
 */
import { Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { verifyKeyLinkage, type SpecificLinkage } from '@bsv/overlay-topics'
import type { TopicManager } from '@bsv/overlay'
import { isInfraError } from './submitVerdict.js'

/** Contract §6 — byte-identical on both engines. Do not reword. */
export const unlinkedTokenReason = (index: number): string =>
  `output ${index}: MandalaToken-decodable output with no verified linkage`

export interface TokenLinkageDeps {
  /** The same verifier wallet the pinned manager is constructed with. */
  verifierWallet: WalletInterface
}

interface LinkagePayload {
  outputs?: Array<{ index?: number, linkage?: SpecificLinkage }>
}

const parseOutputLinkage = (offChainValues?: number[]): Map<number, SpecificLinkage> => {
  const map = new Map<number, SpecificLinkage>()
  if (offChainValues == null || offChainValues.length === 0) return map
  try {
    const parsed = JSON.parse(Utils.toUTF8(offChainValues)) as LinkagePayload
    for (const o of parsed.outputs ?? []) {
      if (typeof o?.index === 'number' && o.linkage != null) map.set(o.index, o.linkage)
    }
  } catch {
    // A payload we cannot parse carries no linkage for any index; every
    // token-shaped output then fails the check below, which is the safe
    // direction (reject), not the skip the pinned manager would do.
  }
  return map
}

const sameBytes = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The index of the first (lowest) MandalaToken-decodable output with no
 * verified linkage, or null when every token output is attested. Exported so
 * the rule can be unit-tested without an engine.
 */
export const findUnlinkedTokenOutput = async (
  beef: number[],
  offChainValues: number[] | undefined,
  deps: TokenLinkageDeps
): Promise<number | null> => {
  const tx = Transaction.fromBEEF(beef)
  const linkage = parseOutputLinkage(offChainValues)
  for (let i = 0; i < tx.outputs.length; i++) {
    let decoded: { pubKeyHash: number[] }
    try {
      decoded = MandalaToken.decode(tx.outputs[i].lockingScript) as { pubKeyHash: number[] }
    } catch {
      continue // not token-shaped — an ordinary output, not this rule's business
    }
    const link = linkage.get(i)
    if (link == null) return i
    try {
      const verified = await verifyKeyLinkage(link, deps.verifierWallet)
      if (!sameBytes(verified.pubKeyHash, decoded.pubKeyHash)) return i
    } catch (e) {
      // §9.5: the verifier wallet is local, in-process crypto, so a throw here
      // is a malformed linkage — content, and an absent linkage never passes.
      // An InfraError is the one exception: a wallet that could not ANSWER has
      // not told us the linkage is bad, so it must not mint a final 400.
      if (isInfraError(e)) throw e
      return i
    }
  }
  return null
}

/**
 * Wraps a `tm_mandala` topic manager so an un-linked or pkh-mismatched
 * MandalaToken output rejects the whole submission BEFORE delegating.
 * Composes with `withAdminChainAnchor` in either order.
 */
export const withUnlinkedTokenReject = (inner: TopicManager, deps: TokenLinkageDeps): TopicManager => {
  const guarded: TopicManager = {
    ...inner,
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[], offChainValues?: number[]) => {
      const offending = await findUnlinkedTokenOutput(beef, offChainValues, deps)
      if (offending != null) throw new Error(unlinkedTokenReason(offending))
      return await (inner.identifyAdmissibleOutputs as (
        b: number[], p: number[], o?: number[]
      ) => Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }>)(beef, previousCoins, offChainValues)
    }
  }
  // Same reason as adminChainGuard: the spread copies prototype-bound methods
  // as plain references, so getDocumentation/getMetaData must fall through.
  return new Proxy(guarded, {
    get: (target, prop, receiver) =>
      prop === 'identifyAdmissibleOutputs'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}

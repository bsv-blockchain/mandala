/**
 * `@bsv/mandala/profile`: the Mandala issuer-v1 required-profile handler that
 * BRC-207 wallets register with `@bsv/color-permission-module` (C§8.2), and
 * the Mandala overlay provider it routes to.
 *
 * Profile definition: `docs/profiles/issuer-v1.md` (the profile id resolves
 * to it). A Mandala deploy's `req` is exactly `{issuer-v1: {version: 1,
 * params: {identityKey: K}}}` (design §9 B7: no attested companion).
 *
 * B7: the handler credits a receipt only from the host ledger (the
 * in-process object the host passes here and to the lib's receive/settle
 * paths; never reachable over BRC-100) or after its own submit returns a
 * verified σ by K (profileReceipt.ts). Its provider answers `spendability`
 * from the same ledger when the overlay is unreachable or has not admitted
 * yet (profileSpendability.ts), so offline and chained hand-overs work.
 *
 * S5 (fail closed): the overlay URL is wallet configuration, keyed by K. An
 * asset whose K has no configured overlay gets no provider: `provider()`
 * throws `ProfileParamsError`, and the module's routing refuses every query,
 * submit and settle of that asset before any wallet mutation.
 *
 * Stability: every provider is built once, at construction, in configuration
 * order. `provider()` returns the same object for K on every call, so the
 * module's identity-based routing (one distinct provider per asset) never
 * forks across createAction, signAction, receipt and settle; a constructor
 * that throws on any overlay leaves no handler behind. The handler is frozen
 * and holds no other state.
 *
 * Errors cross the package boundary by `.name` and the `[ClassName] ` prefix
 * (D22, G12); `ProfileParamsError` is the module's own class and adds that
 * prefix itself.
 */
import {
  ProfileParamsError,
  type ColorOverlayProvider,
  type ProfileDescriptor
} from '@bsv/color-permission-module'
import { MANDALA_PROFILE_ID } from './constants.js'
import { createMandalaOverlayProvider, type MandalaOverlayProvider } from './profileProvider.js'
import { invalidProfile as invalid, issuerKey } from './profileDescriptor.js'
import { checkPlanData, submissionData } from './profilePlanData.js'
import { admitReceipt } from './profileReceipt.js'
import type { HostLedger } from './hostLedger.js'
import { withLedgerSpendability } from './profileSpendability.js'
import type { B7RequiredProfileHandler } from './profileTypes.js'

export { MANDALA_PROFILE_ID }
export { createMandalaOverlayProvider }
export { ColorProviderError } from './providerError.js'
export { withLedgerSpendability } from './profileSpendability.js'
export type { MandalaOverlayProvider, MandalaOverlayProviderOptions } from './profileProvider.js'
export type { B7RequiredProfileHandler, ProfileReceiptCredit, ProfileReceiptView } from './profileTypes.js'

export interface MandalaProfileOptions {
  /** Wallet configuration: the Mandala overlays this wallet trusts, by identity key K. K absent ⇒ its assets fail closed (S5). */
  overlays: Array<{ identityKey: string, url: string }>
  /** The host ledger (B7): in-process, host-owned, shared with the lib's receive/settle/send paths. */
  ledger: HostLedger
  fetch?: typeof fetch
  /** Per request; default 15000. */
  timeoutMs?: number
}

/** B7: issuer params exactly {identityKey: K}; req exactly {issuer-v1}. */
function checkDescriptor (descriptor: ProfileDescriptor, req: ReadonlyMap<string, ProfileDescriptor>): void {
  const k = issuerKey(descriptor)
  if (req == null || typeof req.get !== 'function' || req.size !== 1) {
    throw invalid('req must contain exactly the issuer-v1 profile')
  }
  const own = req.get(MANDALA_PROFILE_ID)
  if (own === undefined) throw invalid('req does not contain issuer-v1')
  if (own !== descriptor && issuerKey(own) !== k) throw invalid('issuer-v1 descriptor differs from the req entry')
}

/**
 * The Mandala issuer-v1 `RequiredProfileHandler` (C§8.2). Throws `TypeError`
 * on malformed options, an invalid overlay identity key, an empty or
 * non-http(s) url, or a duplicate identity key.
 */
export function createMandalaProfile (o: MandalaProfileOptions): B7RequiredProfileHandler {
  if (o == null || typeof o !== 'object') throw new TypeError('@bsv/mandala: createMandalaProfile options are required')
  if (!Array.isArray(o.overlays)) throw new TypeError('@bsv/mandala: overlays must be an array of {identityKey, url}')
  const ledger = o.ledger
  if (ledger == null || typeof ledger.get !== 'function' || typeof ledger.put !== 'function') {
    throw new TypeError('@bsv/mandala: createMandalaProfile needs the host ledger (createHostLedger)')
  }
  const providers = new Map<string, MandalaOverlayProvider>()
  for (const entry of o.overlays) {
    if (entry == null || typeof entry !== 'object') throw new TypeError('@bsv/mandala: each overlay must be {identityKey, url}')
    if (typeof entry.identityKey === 'string' && providers.has(entry.identityKey)) {
      throw new TypeError(`@bsv/mandala: duplicate Mandala overlay identity key ${entry.identityKey}`)
    }
    // Validates url and K (TypeError) before anything is kept.
    const provider = createMandalaOverlayProvider({
      url: entry.url,
      identityKey: entry.identityKey,
      ...(o.fetch !== undefined ? { fetch: o.fetch } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {})
    })
    providers.set(provider.identityKey, withLedgerSpendability(provider, ledger))
  }

  /** The memoized provider for K. S5: no configured endpoint for K ⇒ fail closed, never a fallback. */
  const providerFor = (k: string): ColorOverlayProvider => {
    const provider = providers.get(k)
    if (provider === undefined) throw new ProfileParamsError(`no Mandala overlay configured for ${k}`)
    return provider
  }

  const handler: B7RequiredProfileHandler = {
    id: MANDALA_PROFILE_ID,
    versions: Object.freeze([1]),
    sendPolicy: 'plain-nosend',
    operations: Object.freeze(['transfer'] as const),
    checkDescriptor,
    provider: (_assetId: string, descriptor: ProfileDescriptor): ColorOverlayProvider => providerFor(issuerKey(descriptor)),
    deployProviders: (): ColorOverlayProvider[] => [...providers.values()],
    // B1 (C§5.2): the plan leaf and the tx layout are checked at createAction
    // and again at signAction; submissionData gives the envelope bytes.
    checkPlanData,
    submissionData,
    // B7: credit only what the host ledger recorded, else own submit + verified σ.
    admitReceipt: async (ctx, receipt) => await admitReceipt(ctx, receipt, providerFor, ledger)
  }
  return Object.freeze(handler)
}

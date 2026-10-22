/**
 * `@bsv/mandala/profile`: the Mandala issuer-v1 required-profile handler that
 * BRC-207 wallets register with `@bsv/color-permission-module` (C§8.2), and
 * the Mandala overlay provider it routes to.
 *
 * Profile definition: `docs/profiles/issuer-v1.md` (the profile id resolves
 * to it). A Mandala deploy's `req` is exactly attested v1 in identity mode
 * plus issuer-v1, both naming the same overlay identity key K (C§4).
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
import { PublicKey } from '@bsv/sdk'
import { StrictCborLink, type StrictCborValue } from '@bsv/templates'
import {
  ProfileParamsError,
  type ColorOverlayProvider,
  type ProfileDescriptor,
  type RequiredProfileHandler
} from '@bsv/color-permission-module'
import { ATTESTED_PROFILE_ID, MANDALA_PROFILE_ID } from './constants.js'
import { createMandalaOverlayProvider, type MandalaOverlayProvider } from './profileProvider.js'

export { MANDALA_PROFILE_ID }
export { createMandalaOverlayProvider }
export type { MandalaOverlayProvider, MandalaOverlayProviderOptions } from './profileProvider.js'

export interface MandalaProfileOptions {
  /** Wallet configuration: the Mandala overlays this wallet trusts, by identity key K. K absent ⇒ its assets fail closed (S5). */
  overlays: Array<{ identityKey: string, url: string }>
  fetch?: typeof fetch
  /** Per request; default 15000. */
  timeoutMs?: number
}

/** Receipt customInstructions limit for Mandala assets (attested receipts, 16 MiB). */
const MAX_RECEIPT_BYTES = 16_777_216
const KEY_RE = /^0[23][0-9a-f]{64}$/

type CborMap = { readonly [key: string]: StrictCborValue }

/** A CBOR map as the strict decoder returns it: an object that is no array, bytes or link. */
function isCborMap (v: unknown): v is CborMap {
  return typeof v === 'object' && v !== null && !Array.isArray(v) &&
    !(v instanceof Uint8Array) && !(v instanceof StrictCborLink)
}

/** True iff `map` has exactly the own members `members` (order-free). */
function hasExactly (map: CborMap, members: readonly string[]): boolean {
  const keys = Object.keys(map)
  return keys.length === members.length && members.every(m => Object.prototype.hasOwnProperty.call(map, m))
}

/** 66 lowercase hex, compressed, on the curve, canonical. */
function isIdentityKey (k: unknown): k is string {
  if (typeof k !== 'string' || !KEY_RE.test(k)) return false
  try {
    return PublicKey.fromString(k).toString() === k
  } catch {
    return false
  }
}

const invalid = (reason: string): ProfileParamsError =>
  new ProfileParamsError(`BRC-207: invalid Mandala issuer-v1 profile: ${reason}`)

/** issuer-v1 params: exactly `{identityKey: K}` (C§4). Returns K, else throws ProfileParamsError. */
function issuerKey (descriptor: ProfileDescriptor): string {
  if (descriptor == null || typeof descriptor !== 'object') throw invalid('descriptor must be {version, params}')
  if (descriptor.version !== 1) throw invalid('version must be 1')
  const params = descriptor.params
  if (!isCborMap(params) || !hasExactly(params, ['identityKey'])) throw invalid('params must be exactly {identityKey}')
  const k = params.identityKey
  if (!isIdentityKey(k)) throw invalid('identityKey must be a lowercase compressed public key (66 hex) on the curve')
  return k
}

/** C§4: issuer params exactly {identityKey: K}; req exactly {attested v1 identity K, issuer-v1}. */
function checkDescriptor (descriptor: ProfileDescriptor, req: ReadonlyMap<string, ProfileDescriptor>): void {
  const k = issuerKey(descriptor)
  if (req == null || typeof req.get !== 'function' || req.size !== 2) {
    throw invalid('req must contain exactly the attested and issuer-v1 profiles')
  }
  const own = req.get(MANDALA_PROFILE_ID)
  if (own === undefined) throw invalid('req does not contain issuer-v1')
  if (own !== descriptor && issuerKey(own) !== k) throw invalid('issuer-v1 descriptor differs from the req entry')
  const attested = req.get(ATTESTED_PROFILE_ID)
  if (attested === undefined) throw invalid('the attested profile (identity mode) is required in the same req')
  if (attested.version !== 1) throw invalid('the attested profile version must be 1')
  const ap = attested.params
  if (!isCborMap(ap) || !hasExactly(ap, ['trustMode', 'identityKey']) || ap.trustMode !== 'identity') {
    throw invalid('attested params must be exactly {trustMode: "identity", identityKey}')
  }
  if (ap.identityKey !== k) throw invalid('attested identityKey must equal the issuer-v1 identityKey')
}

/**
 * The Mandala issuer-v1 `RequiredProfileHandler` (C§8.2). Throws `TypeError`
 * on malformed options, an invalid overlay identity key, an empty or
 * non-http(s) url, or a duplicate identity key.
 */
export function createMandalaProfile (o: MandalaProfileOptions): RequiredProfileHandler {
  if (o == null || typeof o !== 'object') throw new TypeError('@bsv/mandala: createMandalaProfile options are required')
  if (!Array.isArray(o.overlays)) throw new TypeError('@bsv/mandala: overlays must be an array of {identityKey, url}')
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
    providers.set(provider.identityKey, provider)
  }

  const handler: RequiredProfileHandler = {
    id: MANDALA_PROFILE_ID,
    versions: Object.freeze([1]),
    sendPolicy: 'plain-nosend',
    operations: Object.freeze(['transfer'] as const),
    maxReceiptBytes: MAX_RECEIPT_BYTES,
    checkDescriptor,
    provider: (_assetId: string, descriptor: ProfileDescriptor): ColorOverlayProvider => {
      const k = issuerKey(descriptor)
      const provider = providers.get(k)
      // S5: no configured endpoint for K ⇒ fail closed, never a fallback.
      if (provider === undefined) throw new ProfileParamsError(`no Mandala overlay configured for ${k}`)
      return provider
    },
    deployProviders: (): ColorOverlayProvider[] => [...providers.values()]
  }
  return Object.freeze(handler)
}

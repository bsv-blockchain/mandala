import { WalletProtocol } from '@bsv/sdk'
import { configureStorage, MandalaStorage } from './storage.js'

export const TOPIC = 'tm_mandala'
export const LOOKUP = 'ls_mandala'
export const REGISTRY_TOPIC = 'tm_mandala_kyc'
export const REGISTRY_LOOKUP = 'ls_mandala_kyc'
/**
 * Derivation for every Mandala-key output: treasury value, authority, deploy,
 * registry and payout change (C§8.1, contract gap G1). Holder value uses the
 * per-asset BRC-207 `p color` protocol (naming.ts), never this one.
 */
export const ADMIN_PROTOCOL: WalletProtocol = [2, 'mandala admin']
export const REGISTRY_PROTOCOL: WalletProtocol = [2, 'mandala registry']
/** MessageBox box for BRC-207 hand-over and payout receipts (D11). */
export const MESSAGEBOX = 'mandala-color'

/** Mandala issuer-v1 required-profile id (C§4); exactly 80 UTF-8 bytes. */
export const MANDALA_PROFILE_ID = 'https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md'

/**
 * Wallet basket for the console's issuer/admin outputs (treasury value,
 * authority, deploy, registry). A fixed non-P basket (D18): holder value
 * lives only in the BRC-207 per-asset `p color` baskets.
 */
export const TREASURY_BASKET = 'mandala treasury'

// Endpoints start empty and MUST be set via configureMandala. The library
// deliberately reads no environment: a module-scope env read (the Vite
// pattern) is a parse-time construct Metro/Hermes reject outright, so the
// host app reads its own env (Vite: app/src/main.tsx) and hands it over
// before any overlay request. constants.test.ts scans lib/src for it.
export let OVERLAY_URL = ''
export let OVERLAY_IDENTITY_KEY = ''
export let MESSAGEBOX_URL = ''
/** Bearer token for the overlay's identity-bearing /admin routes (registry, activity, admission). */
export let ADMIN_API_TOKEN = ''

export interface MandalaEndpoints {
  overlayUrl?: string
  overlayIdentityKey?: string
  messageBoxUrl?: string
  /** Sent as `Authorization: Bearer …` on /admin/registry and /admin/activity, never on the public audit routes. */
  adminApiToken?: string
  /**
   * Durable key/value store for the journals (D3c). Omit on the web — the
   * default adapter uses localStorage. React Native has no localStorage, so a
   * host that does not inject one here (or via configureStorage) gets journals
   * that die with the process, i.e. no crash recovery. See storage.ts.
   */
  storage?: MandalaStorage
}

/**
 * Override endpoint configuration at runtime (ESM live bindings propagate).
 * The single entry point: endpoints AND the storage adapter. Omitted fields
 * are left untouched, so existing `configureMandala({ overlayUrl })` calls
 * behave exactly as before.
 */
export function configureMandala (endpoints: MandalaEndpoints): void {
  if (endpoints.overlayUrl != null) OVERLAY_URL = endpoints.overlayUrl
  if (endpoints.overlayIdentityKey != null) OVERLAY_IDENTITY_KEY = endpoints.overlayIdentityKey
  if (endpoints.messageBoxUrl != null) MESSAGEBOX_URL = endpoints.messageBoxUrl
  if (endpoints.adminApiToken != null) ADMIN_API_TOKEN = endpoints.adminApiToken
  if (endpoints.storage != null) configureStorage(endpoints.storage)
}

/**
 * Thrown by every overlay request while OVERLAY_URL is ''. Each caller checks
 * its own imported binding and throws this, so a missing configureMandala
 * fails loudly instead of requesting a relative URL.
 */
export const OVERLAY_URL_UNSET =
  '@bsv/mandala: overlay URL is not configured — call configureMandala({ overlayUrl }) before any overlay request'

/**
 * Thrown before any wallet mutation or network call by every path that
 * submits to, or verifies against, the overlay while OVERLAY_IDENTITY_KEY is
 * '' (S5: fail closed).
 */
export const OVERLAY_IDENTITY_KEY_UNSET =
  '@bsv/mandala: overlay identity key is not configured — call configureMandala({ overlayIdentityKey })'

/** Headers for the identity-bearing /admin routes; empty until a token is configured. */
export function adminAuthHeaders (): Record<string, string> {
  return ADMIN_API_TOKEN === '' ? {} : { Authorization: `Bearer ${ADMIN_API_TOKEN}` }
}

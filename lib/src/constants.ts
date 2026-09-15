import { WalletProtocol } from '@bsv/sdk'
import { configureStorage, MandalaStorage } from './storage.js'

export const TOPIC = 'tm_mandala'
export const LOOKUP = 'ls_mandala'
export const REGISTRY_TOPIC = 'tm_mandala_registry'
export const REGISTRY_LOOKUP = 'ls_mandala_registry'
export const FT_PROTOCOL: WalletProtocol = [2, 'mandala token']
export const ADMIN_PROTOCOL: WalletProtocol = [2, 'mandala admin']
export const REGISTRY_PROTOCOL: WalletProtocol = [2, 'mandala registry']
export const MESSAGEBOX = 'mandala-payments'

/**
 * Wallet basket every Mandala token output lives in. A live binding, not a
 * constant: a host that runs more than one Mandala deployment against one
 * wallet (a staging console beside production, an RN app beside the web
 * console) must be able to keep their outputs apart, and every lib reference
 * reads it at call time so `configureMandala({ basket })` takes effect
 * immediately. The default is unchanged, so an existing wallet keeps its
 * outputs without any migration.
 */
export let BASKET = 'mandala-tokens'

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
   * Wallet basket for token outputs (default 'mandala-tokens'). Changing it
   * points every listing, coin selection and output-tagging call at a
   * different basket — the existing outputs are NOT moved, so only set this
   * before a deployment's first use, or deliberately to isolate one.
   */
  basket?: string
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
  if (endpoints.basket != null && endpoints.basket !== '') BASKET = endpoints.basket
  if (endpoints.storage != null) configureStorage(endpoints.storage)
}

/**
 * Thrown by every overlay request while OVERLAY_URL is ''. Each caller checks
 * its own imported binding and throws this, so a missing configureMandala
 * fails loudly instead of requesting a relative URL.
 */
export const OVERLAY_URL_UNSET =
  '@bsv/mandala: overlay URL is not configured — call configureMandala({ overlayUrl }) before any overlay request'

/** Headers for the identity-bearing /admin routes; empty until a token is configured. */
export function adminAuthHeaders (): Record<string, string> {
  return ADMIN_API_TOKEN === '' ? {} : { Authorization: `Bearer ${ADMIN_API_TOKEN}` }
}

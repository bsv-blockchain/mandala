/**
 * The console's Mandala configuration, read from Vite's env and checked
 * before anything touches a wallet (S5: fail closed). A missing or malformed
 * overlay identity key, overlay URL or MessageBox URL refuses start-up with a
 * reason naming the first bad variable; nothing is defaulted or repaired.
 *
 * The identity key must be the canonical form (contract §0): 33-byte
 * compressed, lowercase hex. An uppercase or padded copy is refused rather
 * than normalized, so `identityKey === overlayIdentityKey` comparisons can
 * never silently disagree with the overlay's own key.
 */

export interface AppMandalaConfig {
  overlayUrl: string
  overlayIdentityKey: string
  messageBoxUrl: string
  adminApiToken: string
}

export type MandalaConfigResult =
  | { ok: true; config: AppMandalaConfig }
  | { ok: false; reason: string }

const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/

function httpUrl(v: string | undefined): string | null {
  if (typeof v !== 'string' || v === '') return null
  let u: URL
  try {
    u = new URL(v)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return v
}

export function readMandalaConfig(env: Record<string, string | undefined>): MandalaConfigResult {
  const overlayIdentityKey = env.VITE_OVERLAY_IDENTITY_KEY
  if (typeof overlayIdentityKey !== 'string' || !IDENTITY_KEY.test(overlayIdentityKey)) {
    return {
      ok: false,
      reason: "VITE_OVERLAY_IDENTITY_KEY must be the overlay's 66-hex compressed identity key (lowercase, 02/03 prefix)"
    }
  }
  const overlayUrl = httpUrl(env.VITE_OVERLAY_URL)
  if (overlayUrl === null) {
    return { ok: false, reason: 'VITE_OVERLAY_URL must be an http(s) URL of the Mandala overlay' }
  }
  const messageBoxUrl = httpUrl(env.VITE_MESSAGEBOX_URL)
  if (messageBoxUrl === null) {
    return { ok: false, reason: 'VITE_MESSAGEBOX_URL must be an http(s) URL of the MessageBox server' }
  }
  return {
    ok: true,
    config: { overlayUrl, overlayIdentityKey, messageBoxUrl, adminApiToken: env.VITE_ADMIN_API_TOKEN ?? '' }
  }
}

/**
 * A13 — bearer auth + narrowed CORS for the overlay's identity-bearing admin
 * routes: `GET /admin/registry`, `GET /admin/activity`, and A12's
 * `GET /admin/admission/:txid`. `GET /admin/registry` returns the complete
 * list of KYC'd identity keys and `/admin/activity` returns linkage-derived
 * counterparties per transaction — exactly what R74 treats as the sensitive
 * asset, and part of what D2's payee-blinding is meant to protect.
 *
 * Every other `/admin/*` route (`asset-state*`, `admin-history*`,
 * `admin-summary*`, `asset-auth*`, `registry/beef/*`) is the public audit
 * surface R29 wants and stays on the existing wildcard CORS with no auth —
 * recovery (registryRecover.ts / assetRecover.ts) must keep working without
 * a console token.
 *
 * Kept pure and framework-light (only Request/Response types) so every
 * branch is unit-testable with a fake req/res, same pattern as
 * assetAuth.ts. Wire shapes (401 body, header names) mirror
 * overlay-go/internal/httpapi/admin_auth.go exactly, so both backends behave
 * identically to the console.
 */
import type { Request, Response, NextFunction } from 'express'
import { createHash, timingSafeEqual } from 'crypto'

const BEARER_PREFIX = 'Bearer '

/** `Authorization: Bearer <token>` → `<token>`; any other shape → null. */
export function parseBearerToken (header: string | undefined | null): string | null {
  if (header == null || !header.startsWith(BEARER_PREFIX)) return null
  const token = header.slice(BEARER_PREFIX.length)
  return token === '' ? null : token
}

/**
 * Constant-time string compare. Both sides are hashed to a fixed-length
 * digest first so neither a length mismatch nor a byte mismatch in
 * `timingSafeEqual` (which requires equal-length buffers) can leak anything
 * about the configured token's length.
 */
function constantTimeEqual (a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

/**
 * True when the request may proceed. An unset/empty `token` is the dev
 * default — every gated route stays open, and `warnIfAdminAuthDisabled`
 * below is what logs that (once, at boot, never per-request). A configured
 * token requires an exact, constant-time bearer match.
 */
export function isAdminAuthorized (authorizationHeader: string | undefined | null, token: string): boolean {
  if (token === '') return true
  const provided = parseBearerToken(authorizationHeader)
  if (provided == null) return false
  return constantTimeEqual(provided, token)
}

/** Express middleware: 401 `{error:'unauthorized'}` on a missing/wrong bearer token, else `next()`. */
export function adminAuth (token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAdminAuthorized(req.header('authorization'), token)) {
      next()
      return
    }
    res.status(401).json({ error: 'unauthorized' })
  }
}

/**
 * Logged once at boot (index.ts calls this exactly once, after reading
 * ADMIN_API_TOKEN) when the token is unset — never per-request, since an
 * unset token is a supported dev default, not a per-call error.
 */
export function warnIfAdminAuthDisabled (token: string, log: (msg: string) => void = console.warn): void {
  if (token === '') {
    log('[mandala] ADMIN_API_TOKEN is not set — /admin/registry, /admin/activity and /admin/admission/:txid are UNAUTHENTICATED. Set ADMIN_API_TOKEN before any public demo.')
  }
}

/**
 * Allowed console origins for the gated routes: `ADMIN_CORS_ORIGINS`
 * (comma-separated) when set and non-blank, else `hostingUrl`'s origin plus
 * the two local dev origins the console runs on (Vite's default and the
 * 127.0.0.1 variant some setups bind instead).
 */
export function parseAdminCorsOrigins (raw: string | undefined, hostingUrl: string): string[] {
  if (raw != null && raw.trim() !== '') {
    return raw.split(',').map(s => s.trim()).filter(s => s !== '')
  }
  let hostingOrigin = hostingUrl
  try { hostingOrigin = new URL(hostingUrl).origin } catch { /* keep the raw value as a best-effort fallback */ }
  return [hostingOrigin, 'http://127.0.0.1:5173', 'http://localhost:5173']
}

/**
 * Narrowed CORS for the gated routes, replacing the OverlayExpress-wide
 * wildcard for exactly these three routes. Echoes the request's Origin back
 * only when it is in `origins` (otherwise the browser gets no
 * Access-Control-Allow-Origin and blocks the read, `Vary: Origin` so caches
 * don't mix responses for different origins), and answers OPTIONS preflight
 * directly with Authorization listed in Access-Control-Allow-Headers — the
 * browser will not send the real request's Authorization header otherwise.
 * Deliberately omits Access-Control-Allow-Private-Network: that header
 * stays a public-routes-only signal (OverlayExpress's own CORS middleware).
 */
export function adminCors (origins: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('origin')
    if (origin != null && origins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
    }
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.status(200).end()
      return
    }
    next()
  }
}

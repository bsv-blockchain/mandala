/**
 * A13 — bearer auth + narrowed CORS for the identity-bearing admin routes
 * (`/admin/registry`, `/admin/activity`, `/admin/admission/:txid`).
 *
 * Pure-function tests plus fake-req/res middleware tests, same pattern as
 * assetAuth.test.ts, so overlay-go/internal/httpapi/admin_auth_test.go can
 * pin the identical 401 shape and CORS behavior without either suite
 * standing up a real server.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  parseBearerToken,
  isAdminAuthorized,
  adminAuth,
  warnIfAdminAuthDisabled,
  parseAdminCorsOrigins,
  adminCors
} from './adminAuth.js'

interface Sent { status: number, body: unknown, ended: boolean }
const fakeRes = (): { res: any, headers: Record<string, string>, done: Promise<Sent> } => {
  let resolve!: (s: Sent) => void
  const done = new Promise<Sent>(r => { resolve = r })
  const headers: Record<string, string> = {}
  let status = 200
  const res: any = {
    header: (name: string, value: string) => { headers[name] = value; return res },
    status: (s: number) => { status = s; return res },
    json: (body: unknown) => { resolve({ status, body, ended: true }); return res },
    end: () => { resolve({ status, body: undefined, ended: true }); return res }
  }
  return { res, headers, done }
}

const fakeReq = (headers: Record<string, string>, method = 'GET'): any => ({
  method,
  header: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? undefined
})

describe('parseBearerToken', () => {
  it('extracts the token from "Bearer <token>"', () => {
    expect(parseBearerToken('Bearer abc123')).toBe('abc123')
  })

  it('returns null for a missing header', () => {
    expect(parseBearerToken(undefined)).toBeNull()
    expect(parseBearerToken(null)).toBeNull()
  })

  it('returns null for a non-Bearer scheme', () => {
    expect(parseBearerToken('Basic abc123')).toBeNull()
  })

  it('returns null for "Bearer" with no token', () => {
    expect(parseBearerToken('Bearer')).toBeNull()
  })
})

describe('isAdminAuthorized', () => {
  it('is always authorized when the configured token is empty (dev default)', () => {
    expect(isAdminAuthorized(undefined, '')).toBe(true)
    expect(isAdminAuthorized('Bearer wrong', '')).toBe(true)
  })

  it('rejects a missing Authorization header when a token is configured', () => {
    expect(isAdminAuthorized(undefined, 'secret')).toBe(false)
  })

  it('rejects a wrong token', () => {
    expect(isAdminAuthorized('Bearer wrong', 'secret')).toBe(false)
  })

  it('rejects a token of different length (constant-time path)', () => {
    expect(isAdminAuthorized('Bearer short', 'a-much-longer-secret-token')).toBe(false)
  })

  it('accepts the exact configured token', () => {
    expect(isAdminAuthorized('Bearer secret', 'secret')).toBe(true)
  })
})

describe('adminAuth middleware', () => {
  it('calls next() and sets no status when the token is unset', async () => {
    const mw = adminAuth('')
    const next = vi.fn()
    const { res } = fakeRes()
    mw(fakeReq({}), res, next)
    expect(next).toHaveBeenCalledOnce()
  })

  it('401s {"error":"unauthorized"} on a missing token when one is configured', async () => {
    const mw = adminAuth('secret')
    const next = vi.fn()
    const { res, done } = fakeRes()
    mw(fakeReq({}), res, next)
    const sent = await done
    expect(next).not.toHaveBeenCalled()
    expect(sent.status).toBe(401)
    expect(sent.body).toEqual({ error: 'unauthorized' })
  })

  it('401s on a wrong token', async () => {
    const mw = adminAuth('secret')
    const next = vi.fn()
    const { res, done } = fakeRes()
    mw(fakeReq({ authorization: 'Bearer nope' }), res, next)
    const sent = await done
    expect(sent.status).toBe(401)
    expect(sent.body).toEqual({ error: 'unauthorized' })
  })

  it('calls next() on the correct token', () => {
    const mw = adminAuth('secret')
    const next = vi.fn()
    const { res } = fakeRes()
    mw(fakeReq({ authorization: 'Bearer secret' }), res, next)
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('warnIfAdminAuthDisabled', () => {
  it('logs a warning when the token is empty', () => {
    const log = vi.fn()
    warnIfAdminAuthDisabled('', log)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toMatch(/ADMIN_API_TOKEN/)
  })

  it('does not log when a token is configured', () => {
    const log = vi.fn()
    warnIfAdminAuthDisabled('secret', log)
    expect(log).not.toHaveBeenCalled()
  })
})

describe('parseAdminCorsOrigins', () => {
  it('splits ADMIN_CORS_ORIGINS on commas and trims whitespace', () => {
    expect(parseAdminCorsOrigins('https://a.example, https://b.example', 'http://localhost:8080'))
      .toEqual(['https://a.example', 'https://b.example'])
  })

  it('defaults to the HOSTING_URL origin plus the two local dev origins when unset', () => {
    expect(parseAdminCorsOrigins(undefined, 'http://localhost:8080/some/path'))
      .toEqual(['http://localhost:8080', 'http://127.0.0.1:5173', 'http://localhost:5173'])
  })

  it('defaults the same way for an empty string', () => {
    expect(parseAdminCorsOrigins('', 'https://overlay.example'))
      .toEqual(['https://overlay.example', 'http://127.0.0.1:5173', 'http://localhost:5173'])
  })
})

describe('adminCors middleware', () => {
  it('echoes the Origin header when it is in the allow-list, and sets Vary', () => {
    const mw = adminCors(['https://console.example'])
    const next = vi.fn()
    const { res, headers } = fakeRes()
    mw(fakeReq({ origin: 'https://console.example' }), res, next)
    expect(headers['Access-Control-Allow-Origin']).toBe('https://console.example')
    expect(headers.Vary).toBe('Origin')
    expect(next).toHaveBeenCalledOnce()
  })

  it('does not set Access-Control-Allow-Origin for an origin outside the allow-list', () => {
    const mw = adminCors(['https://console.example'])
    const next = vi.fn()
    const { res, headers } = fakeRes()
    mw(fakeReq({ origin: 'https://evil.example' }), res, next)
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it('lists Authorization in Access-Control-Allow-Headers', () => {
    const mw = adminCors(['https://console.example'])
    const next = vi.fn()
    const { res, headers } = fakeRes()
    mw(fakeReq({ origin: 'https://console.example' }), res, next)
    expect(headers['Access-Control-Allow-Headers']).toMatch(/Authorization/)
  })

  it('never sets Access-Control-Allow-Private-Network (public-routes-only header)', () => {
    const mw = adminCors(['https://console.example'])
    const next = vi.fn()
    const { res, headers } = fakeRes()
    mw(fakeReq({ origin: 'https://console.example' }), res, next)
    expect(headers['Access-Control-Allow-Private-Network']).toBeUndefined()
  })

  it('short-circuits OPTIONS preflight with 200 and does not call next()', async () => {
    const mw = adminCors(['https://console.example'])
    const next = vi.fn()
    const { res, headers, done } = fakeRes()
    mw(fakeReq({ origin: 'https://console.example' }, 'OPTIONS'), res, next)
    const sent = await done
    expect(sent.status).toBe(200)
    expect(next).not.toHaveBeenCalled()
    expect(headers['Access-Control-Allow-Headers']).toMatch(/Authorization/)
  })
})

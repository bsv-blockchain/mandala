import { describe, it, expect } from 'vitest'
import { readMandalaConfig } from './config'

const K = '02' + 'ab'.repeat(32)
const good = { VITE_OVERLAY_URL: 'http://localhost:8082', VITE_OVERLAY_IDENTITY_KEY: K, VITE_MESSAGEBOX_URL: 'https://mb.example' }

describe('readMandalaConfig (S5: fail closed)', () => {
  it('accepts a complete config', () => {
    const r = readMandalaConfig(good)
    expect(r).toEqual({ ok: true, config: { overlayUrl: 'http://localhost:8082', overlayIdentityKey: K, messageBoxUrl: 'https://mb.example', adminApiToken: '' } })
  })

  it('passes the optional admin API token through', () => {
    const r = readMandalaConfig({ ...good, VITE_ADMIN_API_TOKEN: 'tok' })
    expect(r).toEqual({ ok: true, config: { overlayUrl: 'http://localhost:8082', overlayIdentityKey: K, messageBoxUrl: 'https://mb.example', adminApiToken: 'tok' } })
  })

  it.each([
    [{ ...good, VITE_OVERLAY_IDENTITY_KEY: undefined }, 'VITE_OVERLAY_IDENTITY_KEY'],
    [{ ...good, VITE_OVERLAY_IDENTITY_KEY: 'paste_identity_key_from_overlay-go_boot_log' }, 'VITE_OVERLAY_IDENTITY_KEY'],
    [{ ...good, VITE_OVERLAY_IDENTITY_KEY: K.toUpperCase() }, 'VITE_OVERLAY_IDENTITY_KEY'],
    [{ ...good, VITE_OVERLAY_IDENTITY_KEY: '04' + 'ab'.repeat(32) }, 'VITE_OVERLAY_IDENTITY_KEY'],
    [{ ...good, VITE_OVERLAY_IDENTITY_KEY: ` ${K}` }, 'VITE_OVERLAY_IDENTITY_KEY'],
    [{ ...good, VITE_OVERLAY_URL: '' }, 'VITE_OVERLAY_URL'],
    [{ ...good, VITE_OVERLAY_URL: undefined }, 'VITE_OVERLAY_URL'],
    [{ ...good, VITE_OVERLAY_URL: 'ftp://x' }, 'VITE_OVERLAY_URL'],
    [{ ...good, VITE_OVERLAY_URL: 'localhost:8082' }, 'VITE_OVERLAY_URL'],
    [{ ...good, VITE_MESSAGEBOX_URL: undefined }, 'VITE_MESSAGEBOX_URL'],
    [{ ...good, VITE_MESSAGEBOX_URL: 'not a url' }, 'VITE_MESSAGEBOX_URL']
  ])('fails closed (S5): %#', (env, name) => {
    const r = readMandalaConfig(env)
    expect(r.ok).toBe(false)
    expect((r as any).reason).toContain(name)
  })
})

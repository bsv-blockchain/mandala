/// <reference types="vite/client" />
import { describe, it, expect, beforeEach } from 'vitest'
import * as constants from './constants.js'
import {
  ADMIN_API_TOKEN, MESSAGEBOX_URL, OVERLAY_IDENTITY_KEY, OVERLAY_URL,
  adminAuthHeaders, configureMandala
} from './constants.js'

// Captured at import time, before any test configures anything.
const seeded = [OVERLAY_URL, OVERLAY_IDENTITY_KEY, MESSAGEBOX_URL, ADMIN_API_TOKEN]

const reset = (): void =>
  configureMandala({ overlayUrl: '', overlayIdentityKey: '', messageBoxUrl: '', adminApiToken: '' })

describe('D3a — the library reads no environment', () => {
  beforeEach(reset)

  it('has no import.meta anywhere in lib/src (Metro/Hermes reject it at parse time)', () => {
    // Vite inlines every sibling source at transform time; tests are exempt.
    const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith('.test.ts'))
      .filter(([, src]) => src.includes('import.meta'))
      .map(([path]) => path)
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    expect(offenders).toEqual([])
  })

  it('seeds every endpoint empty', () => {
    expect(seeded).toEqual(['', '', '', ''])
  })

  it('configureMandala fills the live bindings', () => {
    configureMandala({ overlayUrl: 'http://o', overlayIdentityKey: '02aa', messageBoxUrl: 'http://m', adminApiToken: 'tok' })
    expect([OVERLAY_URL, OVERLAY_IDENTITY_KEY, MESSAGEBOX_URL, ADMIN_API_TOKEN])
      .toEqual(['http://o', '02aa', 'http://m', 'tok'])
  })

  it('leaves omitted fields untouched', () => {
    configureMandala({ overlayUrl: 'http://o', adminApiToken: 'tok' })
    configureMandala({ messageBoxUrl: 'http://m' })
    expect(OVERLAY_URL).toBe('http://o')
    expect(ADMIN_API_TOKEN).toBe('tok')
    expect(MESSAGEBOX_URL).toBe('http://m')
  })
})

describe('A13 — adminAuthHeaders', () => {
  beforeEach(reset)

  it('is empty without a token, so requests stay anonymous', () => {
    expect(adminAuthHeaders()).toEqual({})
  })

  it('carries the configured token as a bearer credential', () => {
    configureMandala({ adminApiToken: 'tok' })
    expect(adminAuthHeaders()).toEqual({ Authorization: 'Bearer tok' })
  })
})

describe('1Color constants (C§8.1)', () => {
  it('pins the topics, box, basket, protocols and profile ids', () => {
    expect(constants.TOPIC).toBe('tm_mandala')
    expect(constants.LOOKUP).toBe('ls_mandala')
    expect(constants.REGISTRY_TOPIC).toBe('tm_mandala_kyc')
    expect(constants.REGISTRY_LOOKUP).toBe('ls_mandala_kyc')
    expect(constants.MESSAGEBOX).toBe('mandala-color')
    expect(constants.TREASURY_BASKET).toBe('mandala treasury')
    expect(constants.ADMIN_PROTOCOL).toEqual([2, 'mandala admin'])
    expect(constants.REGISTRY_PROTOCOL).toEqual([2, 'mandala registry'])
    expect(constants.ATTESTED_PROFILE_ID).toBe('https://brc.dev/207/attested')
    expect(constants.MANDALA_PROFILE_ID)
      .toBe('https://github.com/bsv-blockchain/mandala/blob/master/docs/profiles/issuer-v1.md')
    expect(new TextEncoder().encode(constants.MANDALA_PROFILE_ID).length).toBe(80)
    expect(constants.OVERLAY_IDENTITY_KEY_UNSET)
      .toBe('@bsv/mandala: overlay identity key is not configured — call configureMandala({ overlayIdentityKey })')
  })

  it('removes FT_PROTOCOL and the configurable BASKET', () => {
    expect('FT_PROTOCOL' in constants).toBe(false)
    expect('BASKET' in constants).toBe(false)
  })

  it('no lib source names the old p mandala derivation, basket or box', () => {
    const sources = import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const nonTest = Object.entries(sources).filter(([path]) => !path.endsWith('.test.ts'))
    expect(nonTest.length).toBeGreaterThan(10)
    const offenders = nonTest
      .flatMap(([path, src]) => ['p mandala', 'mandala-tokens', 'mandala-payments']
        .filter(needle => src.includes(needle))
        .map(needle => `${path}: ${needle}`))
    expect(offenders).toEqual([])
  })
})

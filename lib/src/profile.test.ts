import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PrivateKey, Utils } from '@bsv/sdk'
import { decodeStrictCbor, type StrictCborValue } from '@bsv/templates'
import { createAttestedProfile, createColorModule, type ProfileDescriptor } from '@bsv/color-permission-module'
import { createMandalaProfile, createMandalaOverlayProvider, MANDALA_PROFILE_ID } from './profile.js'
import { ATTESTED_PROFILE_ID } from './constants.js'

const F = JSON.parse(readFileSync(fileURLToPath(new URL('./__fixtures__/1color-deploy.json', import.meta.url)), 'utf8')) as { identityKey: string, reqHex: string }
const K = new PrivateKey(5555).toPublicKey().toString()
const K2 = new PrivateKey(7777).toPublicKey().toString()
const TXID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f'
const ID = `${TXID}_0`

type Req = Map<string, ProfileDescriptor>

function reqFromFixture (): Req {
  const decoded = decodeStrictCbor(Utils.toArray(F.reqHex, 'hex')) as Record<string, any>
  return new Map(Object.entries(decoded).map(([id, d]) => [id, { version: Number(d.version), params: d.params as StrictCborValue }]))
}
const REQ = reqFromFixture()

/** A deep copy of REQ with `edit` applied. */
function mutateReq (edit: (r: Map<string, { version: number, params: any }>) => void): Req {
  const r = new Map([...REQ].map(([id, d]) => [id, { version: d.version, params: { ...(d.params as object) } }]))
  edit(r)
  return r as Req
}

function caught (f: () => unknown): any {
  try {
    f()
  } catch (e) {
    return e
  }
  throw new Error('expected a throw')
}

describe('createMandalaProfile: identity and shape (C§8.2)', () => {
  const h = createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }] })

  it('the fixture K is the C.0 signer', () => {
    expect(F.identityKey).toBe(K)
  })

  it('declares id, versions, send policy, operations and the receipt limit', () => {
    expect(h.id).toBe(MANDALA_PROFILE_ID)
    expect(new TextEncoder().encode(h.id).length).toBe(80)
    expect(h.versions).toEqual([1])
    expect(h.sendPolicy).toBe('plain-nosend')
    expect(h.operations).toEqual(['transfer'])
    expect(h.maxReceiptBytes).toBe(16777216)
  })

  it('defines no ext state and no receipt leaf hook (G7)', () => {
    expect((h as any).checkExt).toBeUndefined()
    expect((h as any).checkReceiptData).toBeUndefined()
  })
})

describe('createMandalaProfile: registration with the color module', () => {
  it('passes the module\'s handler validation next to the attested profile', () => {
    const h = createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }] })
    const store = { get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [] }
    expect(() => createColorModule({
      wallet: {} as any,
      provider: h.deployProviders!()[0],
      requestTokenAccess: async () => false,
      store,
      profiles: { [ATTESTED_PROFILE_ID]: createAttestedProfile(), [MANDALA_PROFILE_ID]: h }
    })).not.toThrow()
  })
})

describe('createMandalaProfile: constructor', () => {
  it('accepts an empty overlay list (S5 fails later, per asset)', () => {
    expect(() => createMandalaProfile({ overlays: [] })).not.toThrow()
  })

  it('throws TypeError on an invalid or duplicate overlay key or an empty url', () => {
    expect(() => createMandalaProfile({ overlays: [{ identityKey: K.toUpperCase(), url: 'https://o' }] })).toThrow(TypeError)
    expect(() => createMandalaProfile({ overlays: [{ identityKey: '02' + 'f'.repeat(64), url: 'https://o' }] })).toThrow(TypeError)
    expect(() => createMandalaProfile({ overlays: [{ identityKey: K, url: '' }] })).toThrow(TypeError)
    expect(() => createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }, { identityKey: K, url: 'https://p' }] })).toThrow(TypeError)
    expect(() => createMandalaProfile({ overlays: 'x' as any })).toThrow(TypeError)
    expect(() => createMandalaProfile({ overlays: [null as any] })).toThrow(TypeError)
    expect(() => createMandalaProfile(undefined as any)).toThrow(TypeError)
  })
})

describe('createMandalaProfile: checkDescriptor (C§4)', () => {
  const h = createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }] })

  it('accepts the F-REQ req', () => {
    expect(REQ.size).toBe(2)
    expect(() => h.checkDescriptor(REQ.get(MANDALA_PROFILE_ID)!, REQ)).not.toThrow()
  })

  it('does not depend on the overlay configuration (pure)', () => {
    const none = createMandalaProfile({ overlays: [] })
    expect(() => none.checkDescriptor(REQ.get(MANDALA_PROFILE_ID)!, REQ)).not.toThrow()
  })

  const cases: Array<[string, Req]> = [
    ["attested trustMode 'any'", mutateReq(r => { r.get(ATTESTED_PROFILE_ID)!.params.trustMode = 'any' })],
    ['attested identityKey ≠ K', mutateReq(r => { r.get(ATTESTED_PROFILE_ID)!.params.identityKey = K2 })],
    ['attested params with an extra member', mutateReq(r => { r.get(ATTESTED_PROFILE_ID)!.params.evidenceProfile = MANDALA_PROFILE_ID })],
    ['attested version 2', mutateReq(r => { r.get(ATTESTED_PROFILE_ID)!.version = 2 })],
    ['issuer params with an extra member', mutateReq(r => { r.get(MANDALA_PROFILE_ID)!.params.url = 'https://o' })],
    ['issuer params without identityKey', mutateReq(r => { delete r.get(MANDALA_PROFILE_ID)!.params.identityKey })],
    ['req with a third profile', mutateReq(r => { r.set('https://example.com/other', { version: 1, params: {} }) })],
    ['attested entry missing', mutateReq(r => { r.delete(ATTESTED_PROFILE_ID) })],
    ['issuer identityKey uppercase', mutateReq(r => {
      r.get(MANDALA_PROFILE_ID)!.params.identityKey = K.toUpperCase()
      r.get(ATTESTED_PROFILE_ID)!.params.identityKey = K.toUpperCase()
    })],
    ['issuer identityKey off the curve', mutateReq(r => {
      r.get(MANDALA_PROFILE_ID)!.params.identityKey = '02' + 'f'.repeat(64)
      r.get(ATTESTED_PROFILE_ID)!.params.identityKey = '02' + 'f'.repeat(64)
    })],
    ['issuer identityKey as bytes', mutateReq(r => { r.get(MANDALA_PROFILE_ID)!.params.identityKey = Uint8Array.from(Utils.toArray(K, 'hex')) })]
  ]
  it.each(cases)('%s ⇒ ProfileParamsError', (_name, req) => {
    const issuer = req.get(MANDALA_PROFILE_ID) ?? REQ.get(MANDALA_PROFILE_ID)!
    const e = caught(() => h.checkDescriptor(issuer, req))
    expect(e.name).toBe('ProfileParamsError')
    expect(e.message.startsWith('[ProfileParamsError] ')).toBe(true)
  })

  it('a version other than 1 or non-map params ⇒ ProfileParamsError', () => {
    for (const d of [
      { version: 2, params: { identityKey: K } },
      { version: 1, params: null },
      { version: 1, params: [K] },
      { version: 1, params: K },
      { version: 1, params: Uint8Array.from([1]) }
    ] as ProfileDescriptor[]) {
      expect(caught(() => h.checkDescriptor(d, REQ)).name).toBe('ProfileParamsError')
    }
  })

  it('a req that names attested but not issuer-v1 ⇒ ProfileParamsError', () => {
    const req = mutateReq(r => {
      const own = r.get(MANDALA_PROFILE_ID)!
      r.delete(MANDALA_PROFILE_ID)
      r.set('https://example.com/other', own)
    })
    expect(caught(() => h.checkDescriptor(REQ.get(MANDALA_PROFILE_ID)!, req)).name).toBe('ProfileParamsError')
  })
})

describe('createMandalaProfile: provider routing (S5)', () => {
  it('returns the same memoized provider for K on every call', () => {
    const h = createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }] })
    const p = h.provider!(ID, REQ.get(MANDALA_PROFILE_ID)!)
    expect(p).toBe(h.provider!(ID, REQ.get(MANDALA_PROFILE_ID)!))
    expect((p as any).url).toBe('https://o')
    expect((p as any).identityKey).toBe(K)
  })

  it('routes by K among several overlays', () => {
    const h = createMandalaProfile({ overlays: [{ identityKey: K2, url: 'https://two' }, { identityKey: K, url: 'https://o' }] })
    expect((h.provider!(ID, REQ.get(MANDALA_PROFILE_ID)!) as any).url).toBe('https://o')
    expect((h.provider!(ID, { version: 1, params: { identityKey: K2 } }) as any).url).toBe('https://two')
  })

  it('provider for an unconfigured key throws ProfileParamsError (S5)', () => {
    const e = caught(() => createMandalaProfile({ overlays: [] }).provider!(ID, REQ.get(MANDALA_PROFILE_ID)!))
    expect(e.name).toBe('ProfileParamsError')
    expect(e.message).toMatch(/no Mandala overlay configured/)
    expect(e.message).toContain(K)
    const other = caught(() => createMandalaProfile({ overlays: [{ identityKey: K2, url: 'https://two' }] }).provider!(ID, REQ.get(MANDALA_PROFILE_ID)!))
    expect(other.name).toBe('ProfileParamsError')
  })

  it('provider with malformed params throws ProfileParamsError', () => {
    const h = createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }] })
    expect(caught(() => h.provider!(ID, { version: 1, params: { identityKey: K, x: 1 } })).name).toBe('ProfileParamsError')
    expect(caught(() => h.provider!(ID, { version: 1, params: null })).name).toBe('ProfileParamsError')
  })

  it('deployProviders returns every configured provider in configuration order', () => {
    const h = createMandalaProfile({ overlays: [{ identityKey: K, url: 'https://o' }] })
    expect(h.deployProviders!().map(p => (p as any).url)).toEqual(['https://o'])
    const two = createMandalaProfile({ overlays: [{ identityKey: K2, url: 'https://two' }, { identityKey: K, url: 'https://o' }] })
    const list = two.deployProviders!()
    expect(list.map(p => (p as any).url)).toEqual(['https://two', 'https://o'])
    expect(list[1]).toBe(two.provider!(ID, REQ.get(MANDALA_PROFILE_ID)!))
    list.pop()
    expect(two.deployProviders!()).toHaveLength(2)
    expect(createMandalaProfile({ overlays: [] }).deployProviders!()).toEqual([])
  })

  it('re-exports createMandalaOverlayProvider for the profile entry', () => {
    expect(typeof createMandalaOverlayProvider).toBe('function')
  })
})

describe('docs/profiles/issuer-v1.md', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../docs/profiles/issuer-v1.md', import.meta.url)), 'utf8')

  it('cites the id, the replaced procedure and the required sections', () => {
    for (const s of [MANDALA_PROFILE_ID, '0207:126-141', '0207:1476-1481', '## Parameters', '## Credit rule', '## Submission data', '## Failure behaviour']) {
      expect(doc).toContain(s)
    }
  })

  it('has the sections in order', () => {
    const order = ['## Identifier and version', '## Parameters', '## Companion requirement', '## Replaced procedure',
      '## Credit rule', '## Operations and transaction shape', '## Send policy', '## Submission data', '## ext state',
      '## Service configuration', '## Failure behaviour', '## Security notes']
    const at = order.map(s => doc.indexOf(s))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
})

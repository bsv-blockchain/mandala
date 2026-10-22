import { describe, it, expect } from 'vitest'
import { Utils } from '@bsv/sdk'
import { decodeEnvelope, encodeEnvelope } from './encoding.js'
import type { MandalaActionDetails, MandalaEnvelope, SpecificLinkage } from './encoding.js'

const utf8 = (s: string): number[] => Utils.toArray(s, 'utf8')
const K = '02' + 'ab'.repeat(32)
const link = (n: number): SpecificLinkage => ({
  prover: '03' + 'cd'.repeat(32),
  verifier: K,
  counterparty: '02' + n.toString(16).padStart(2, '0').repeat(32),
  protocolID: [2, `p color ${'ee'.repeat(32)}v0 6161 6262`],
  keyID: 'color',
  encryptedLinkage: [1, 2, 3, n],
  encryptedLinkageProof: [4, 5, n],
  proofType: 0
})
const L0 = link(0)
const L2 = link(2)

describe('encodeEnvelope / decodeEnvelope', () => {
  it('sorts by index, omits absent members and round-trips', () => {
    const bytes = encodeEnvelope({ outputs: [{ index: 2, linkage: L2 }, { index: 0, linkage: L0 }] })
    expect(JSON.parse(Utils.toUTF8(bytes))).toEqual({ outputs: [{ index: 0, linkage: L0 }, { index: 2, linkage: L2 }] })
    expect('inputs' in JSON.parse(Utils.toUTF8(bytes))).toBe(false)
    expect(decodeEnvelope(bytes)).toEqual({ outputs: [{ index: 0, linkage: L0 }, { index: 2, linkage: L2 }] })
  })

  it('writes members in the contract order regardless of input key order', () => {
    const shuffled = {
      proofType: 0 as const, encryptedLinkageProof: [9], encryptedLinkage: [8], keyID: 'k',
      protocolID: [2, 'mandala admin'] as [2, string], counterparty: K, verifier: K, prover: K
    }
    const env: MandalaEnvelope = {
      deploySig: 'abcd',
      admin: [{ details: 'a1', index: 1 } as any],
      outputs: [{ linkage: shuffled, index: 1 } as any],
      inputs: [{ linkage: shuffled, index: 0 } as any]
    }
    const text = Utils.toUTF8(encodeEnvelope(env))
    const L = `{"prover":"${K}","verifier":"${K}","counterparty":"${K}","protocolID":[2,"mandala admin"],"keyID":"k","encryptedLinkage":[8],"encryptedLinkageProof":[9],"proofType":0}`
    expect(text).toBe(`{"inputs":[{"index":0,"linkage":${L}}],"outputs":[{"index":1,"linkage":${L}}],"admin":[{"index":1,"details":"a1"}],"deploySig":"abcd"}`)
  })

  it('drops extra members a caller object carries (byte-deterministic)', () => {
    const extra = { ...L0, note: 'x' } as any
    const a = encodeEnvelope({ outputs: [{ index: 0, linkage: extra, more: 1 } as any] })
    expect(a).toEqual(encodeEnvelope({ outputs: [{ index: 0, linkage: L0 }] }))
  })

  it('encodes the empty envelope as {}', () => {
    expect(Utils.toUTF8(encodeEnvelope({}))).toBe('{}')
    expect(decodeEnvelope(utf8('{}'))).toEqual({})
  })

  it('carries admin details as strict-CBOR hex', () => {
    const d: MandalaActionDetails = { kind: 'reissue', outpoint: 'y.1', recipient: '02ab' }
    expect(d.kind).toBe('reissue')
    const bytes = encodeEnvelope({ outputs: [], admin: [{ index: 0, details: 'a16469737375' }] })
    expect(decodeEnvelope(bytes)).toEqual({ outputs: [], admin: [{ index: 0, details: 'a16469737375' }] })
  })

  it('refuses to encode what it would refuse to decode', () => {
    expect(() => encodeEnvelope({ outputs: [{ index: 0, linkage: L0 }, { index: 0, linkage: L2 }] })).toThrow(TypeError)
    expect(() => encodeEnvelope({ outputs: [{ index: 0, linkage: { ...L0, encryptedLinkage: [256] } }] })).toThrow(TypeError)
    expect(() => encodeEnvelope({ admin: [{ index: 0, details: 'ABCD' }] })).toThrow(TypeError)
  })

  const L0json = JSON.stringify(L0)
  it.each([
    ['unknown top-level member', '{"outputs":[],"extra":1}'],
    ['proofType 1', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, proofType: 1 })}}]}`],
    ['duplicate output index', `{"outputs":[{"index":0,"linkage":${L0json}},{"index":0,"linkage":${L0json}}]}`],
    ['duplicate admin index', '{"admin":[{"index":1,"details":"a1"},{"index":1,"details":"a2"}]}'],
    ['unknown entry member', `{"outputs":[{"index":0,"linkage":${L0json},"x":1}]}`],
    ['unknown linkage member', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, x: 1 })}}]}`],
    ['missing linkage member', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, keyID: undefined })}}]}`],
    ['missing linkage', '{"outputs":[{"index":0}]}'],
    ['non-integer byte', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, encryptedLinkage: [1.5] })}}]}`],
    ['byte above 255', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, encryptedLinkageProof: [256] })}}]}`],
    ['negative byte', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, encryptedLinkage: [-1] })}}]}`],
    ['string byte', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, encryptedLinkage: ['1'] })}}]}`],
    ['security level 1', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, protocolID: [1, 'x'] })}}]}`],
    ['protocolID not a pair', `{"outputs":[{"index":0,"linkage":${JSON.stringify({ ...L0, protocolID: [2, 'x', 3] })}}]}`],
    ['negative index', `{"outputs":[{"index":-1,"linkage":${L0json}}]}`],
    ['fractional index', `{"outputs":[{"index":0.5,"linkage":${L0json}}]}`],
    ['unsafe index', `{"outputs":[{"index":9007199254740992,"linkage":${L0json}}]}`],
    ['string index', `{"outputs":[{"index":"0","linkage":${L0json}}]}`],
    ['outputs not an array', '{"outputs":{}}'],
    ['outputs null', '{"outputs":null}'],
    ['admin details not hex', '{"admin":[{"index":0,"details":"xyz"}]}'],
    ['admin details uppercase', '{"admin":[{"index":0,"details":"AB"}]}'],
    ['deploySig empty', '{"deploySig":""}'],
    ['deploySig not a string', '{"deploySig":12}'],
    ['top level array', '[]'],
    ['top level null', 'null'],
    ['not JSON', '{"outputs":'],
    ['empty input', '']
  ])('decode refuses %s with TypeError', (_name, bad) => {
    expect(() => decodeEnvelope(utf8(bad))).toThrow(TypeError)
    expect(() => decodeEnvelope(utf8(bad))).toThrow(/^MandalaEnvelope: /)
  })

  it('decode refuses invalid UTF-8 and non-byte input', () => {
    const good = encodeEnvelope({ deploySig: 'ab' })
    expect(() => decodeEnvelope([...good.slice(0, 2), 0xff, ...good.slice(2)])).toThrow(TypeError)
    expect(() => decodeEnvelope([0x7b, 0xc0, 0x80, 0x7d])).toThrow(TypeError) // overlong NUL
    expect(() => decodeEnvelope([0x7b, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x3a, 0x31, 0x7d])).toThrow(TypeError) // UTF-16 surrogate
    expect(() => decodeEnvelope([0x7b, 300, 0x7d])).toThrow(TypeError)
    expect(() => decodeEnvelope('{}' as any)).toThrow(TypeError)
    expect(() => decodeEnvelope([0x7b, 0xc0, 0x80, 0x7d])).toThrow(/valid UTF-8/)
    // Multi-byte UTF-8 that is valid passes.
    expect(decodeEnvelope(utf8('{"admin":[{"index":0,"details":"ab"}],"deploySig":"cd"}'))).toEqual({ admin: [{ index: 0, details: 'ab' }], deploySig: 'cd' })
  })

  it('decode keeps a valid non-ASCII linkage string intact', () => {
    const l = { ...L0, keyID: 'k€😀' }
    expect(decodeEnvelope(encodeEnvelope({ inputs: [{ index: 3, linkage: l }] }))).toEqual({ inputs: [{ index: 3, linkage: l }] })
  })
})

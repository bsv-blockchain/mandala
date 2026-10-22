import { describe, it, expect } from 'vitest'
import {
  assertRemittance, assetTag, colorBasket, colorLookup, colorProtocolID, colorTopic,
  isAssetId, isColorTopic
} from './naming.js'

// 0207:540-551 example asset; prefix `AQ==`, suffix `Ag==`.
const ID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f_0'
const TAG = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4fv0'

describe('1Color naming (C§0, 0207:540-551, 0207:700-705)', () => {
  it('derives topic, lookup and assetTag from the canonical asset id', () => {
    expect(colorTopic(ID)).toBe(`tm_color_${ID}`)
    expect(colorLookup(ID)).toBe(`ls_color_${ID}`)
    expect(assetTag(ID)).toBe(TAG)
  })

  it('encodes the protocol id with hex of the exact remittance UTF-8 bytes', () => {
    expect(colorProtocolID(ID, 'AQ==', 'Ag==')).toEqual([2, `p color ${assetTag(ID)} 41513d3d 41673d3d`])
  })

  it('names the per-asset value and authority baskets', () => {
    expect(colorBasket(ID)).toBe(`p color ${assetTag(ID)}`)
    expect(colorBasket(ID, 'value')).toBe(`p color ${assetTag(ID)}`)
    expect(colorBasket(ID, 'authority')).toBe(`p color ${assetTag(ID)} authority`)
  })

  it('rejects non-canonical asset ids with a TypeError', () => {
    for (const bad of ['ABC', ID.toUpperCase(), ID.replace('_0', '_01'), ID.replace('_0', '_4294967296'), ID.replace('_0', '.0'), '']) {
      expect(() => colorTopic(bad)).toThrow(TypeError)
      expect(() => colorTopic(bad)).toThrow(/^@bsv\/mandala:/)
      expect(() => colorLookup(bad)).toThrow(TypeError)
      expect(() => assetTag(bad)).toThrow(TypeError)
      expect(() => colorBasket(bad)).toThrow(TypeError)
      expect(() => colorProtocolID(bad, 'AQ==', 'Ag==')).toThrow(TypeError)
      expect(isAssetId(bad)).toBe(false)
    }
  })

  it('accepts the full uint32 vout range', () => {
    const max = ID.replace('_0', '_4294967295')
    expect(isAssetId(max)).toBe(true)
    expect(assetTag(max)).toBe(`${ID.slice(0, 64)}v4294967295`)
    expect(isAssetId(ID.replace('_0', '_7'))).toBe(true)
  })

  it('rejects an unknown basket role', () => {
    expect(() => colorBasket(ID, 'other' as any)).toThrow(TypeError)
  })

  it('bounds remittance strings at 48 UTF-8 bytes and refuses whitespace', () => {
    expect(() => colorProtocolID(ID, 'a'.repeat(49), 'Ag==')).toThrow(/48/)
    expect(() => colorProtocolID(ID, 'AQ==', 'a'.repeat(49))).toThrow(/48/)
    expect(() => colorProtocolID(ID, 'a b', 'Ag==')).toThrow(TypeError)
    expect(() => colorProtocolID(ID, 'AQ==', 'a\tb')).toThrow(TypeError)
    expect(() => colorProtocolID(ID, '', 'Ag==')).toThrow(TypeError)
    // 48 bytes is the inclusive maximum, and the bound counts bytes, not chars.
    const p = colorProtocolID(ID, 'a'.repeat(48), 'b'.repeat(48))
    expect(p[1]).toBe(`p color ${TAG} ${'61'.repeat(48)} ${'62'.repeat(48)}`)
    expect(p[1].length).toBeLessThanOrEqual(280)
    expect(() => colorProtocolID(ID, 'é'.repeat(25), 'Ag==')).toThrow(/48/)
    expect(colorProtocolID(ID, 'é'.repeat(24), 'Ag==')[1]).toBe(`p color ${TAG} ${'c3a9'.repeat(24)} 41673d3d`)
  })

  it('assertRemittance returns the exact string and refuses ill-formed UTF-16', () => {
    const nonce = 'x'.repeat(44)
    expect(assertRemittance(nonce, 'derivationPrefix')).toBe(nonce)
    expect(() => assertRemittance('\ud800', 'derivationPrefix')).toThrow(TypeError)
    expect(() => assertRemittance('a b', 'derivationSuffix')).toThrow(/derivationSuffix/)
    expect(() => assertRemittance(42 as any, 'derivationPrefix')).toThrow(TypeError)
  })

  it('recognises only per-asset color topics', () => {
    expect(isColorTopic(`tm_color_${ID}`)).toBe(true)
    expect(isColorTopic('tm_mandala')).toBe(false)
    expect(isColorTopic('tm_mandala_kyc')).toBe(false)
    expect(isColorTopic(`ls_color_${ID}`)).toBe(false)
    expect(isColorTopic(`tm_color_${ID.toUpperCase()}`)).toBe(false)
    expect(isColorTopic(`tm_${ID.slice(0, 64)}`)).toBe(false)
  })
})

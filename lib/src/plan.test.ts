/**
 * BRC-207 action plan labels (C§8.1, 0207:1165-1186).
 *
 * A.159 vector: the seven labels are copied verbatim from 0207:10056-10062.
 */
import { describe, it, expect } from 'vitest'
import { Utils } from '@bsv/sdk'
import { ColorPlanV1, planLabels, PLAN_MAX_BYTES } from './plan.js'

const A159 = [
  'p color plan 0 7 7b2276657273696f6e223a312c22617373657473223a5b22643734386563366539623565303236363463383066393936326533383538373435366436373461663339316665366533366631313236616232346439626537615f30225d2c226f776e65644f',
  'p color plan 1 7 757470757473223a5b7b226f7574707574496e646578223a302c2261737365744964223a22643734386563366539623565303236363463383066393936326533383538373435366436373461663339316665366533366631313236616232346439626537',
  'p color plan 2 7 615f30222c2264657269766174696f6e507265666978223a2246513d3d222c2264657269766174696f6e537566666978223a2241673d3d222c2273656e6465724964656e746974794b6579223a2230323739626536363765663964636262616335356130',
  'p color plan 3 7 3632393563653837306230373032396266636462326463653238643935396632383135623136663831373938227d5d2c226f7065726174696f6e73223a5b7b2261737365744964223a226437343865633665396235653032363634633830663939363265',
  'p color plan 4 7 33383538373435366436373461663339316665366533366631313236616232346439626537615f30222c226f7065726174696f6e223a227472616e73666572227d5d2c22696e707574506f736974696f6e73223a5b5d2c226368616e6765506f73697469',
  'p color plan 5 7 6f6e73223a5b5d2c22736967686173685479706573223a5b5d2c2270726f66696c6544617461223a7b2275726e3a6578616d706c653a636f6c6f723a7265766973696f6e223a7b2264373438656336653962356530323636346338306639393632653338',
  'p color plan 6 7 3538373435366436373461663339316665366533366631313236616232346439626537615f30223a7b2265787065637465645265766973696f6e223a317d7d7d7d'
]

const chunkOf = (l: string): string => l.split(' ')[5]
const decode = (labels: string[]): string => Utils.toUTF8(Utils.toArray(labels.map(chunkOf).join(''), 'hex'))
const plan = JSON.parse(decode(A159)) as ColorPlanV1

describe('planLabels (A.159, 0207:1165-1186)', () => {
  it('reproduces the A.159 labels exactly', () => {
    expect(planLabels(plan)).toEqual(A159)
  })

  it('caller member order does not matter (canonical order is rebuilt)', () => {
    const scrambled = Object.fromEntries(Object.entries(plan).reverse())
    expect(planLabels(scrambled as unknown as ColorPlanV1)).toEqual(A159)
    const deep = {
      ...plan,
      ownedOutputs: plan.ownedOutputs.map(o => Object.fromEntries(Object.entries(o).reverse())),
      operations: plan.operations.map(o => Object.fromEntries(Object.entries(o).reverse()))
    }
    expect(planLabels(deep as unknown as ColorPlanV1)).toEqual(A159)
  })

  it('drops members outside the plan (no other members, 0207:1189)', () => {
    const extra = { ...plan, junk: 1, ownedOutputs: plan.ownedOutputs.map(o => ({ ...o, junk: 2 })) }
    expect(planLabels(extra as unknown as ColorPlanV1)).toEqual(A159)
  })

  it('omits profileData when absent', () => {
    const { profileData: _pd, ...rest } = plan
    const labels = planLabels(rest as ColorPlanV1)
    expect(JSON.parse(decode(labels))).not.toHaveProperty('profileData')
  })

  it('splits multi-byte UTF-8 into 200-hex chunks with well-formed index/count', () => {
    const big = planLabels({ ...plan, profileData: { 'urn:x:y': { [plan.assets[0]]: { s: 'é'.repeat(300) } } } })
    expect(big.length).toBeGreaterThan(1)
    expect(big.slice(0, -1).every(l => chunkOf(l).length === 200)).toBe(true)
    const last = chunkOf(big[big.length - 1])
    expect(last.length).toBeGreaterThan(0)
    expect(last.length).toBeLessThanOrEqual(200)
    big.forEach((l, i) => {
      const parts = l.split(' ')
      expect(parts.slice(0, 5)).toEqual(['p', 'color', 'plan', String(i), String(big.length)])
      expect(parts[5]).toMatch(/^(?:[0-9a-f]{2})+$/)
    })
    expect(JSON.parse(decode(big)).profileData['urn:x:y'][plan.assets[0]].s).toBe('é'.repeat(300))
  })

  it('rejects empty or duplicate assets', () => {
    expect(() => planLabels({ ...plan, assets: [] })).toThrow(TypeError)
    expect(() => planLabels({ ...plan, assets: [plan.assets[0], plan.assets[0]] })).toThrow(TypeError)
  })

  it('rejects a version other than 1 and non-array position members', () => {
    expect(() => planLabels({ ...plan, version: 2 as 1 })).toThrow(TypeError)
    expect(() => planLabels({ ...plan, inputPositions: undefined as unknown as [] })).toThrow(TypeError)
  })

  it('rejects a plan over 16 MiB of decoded JSON', () => {
    expect(PLAN_MAX_BYTES).toBe(16 * 1024 * 1024)
    const huge = { ...plan, profileData: { 'urn:x:y': { s: 'a'.repeat(PLAN_MAX_BYTES) } } }
    expect(() => planLabels(huge)).toThrow(TypeError)
    // Under the bound in UTF-16 code units, over it in UTF-8 bytes.
    const wide = { ...plan, profileData: { 'urn:x:y': { s: 'é'.repeat(PLAN_MAX_BYTES / 2 + 1) } } }
    expect(() => planLabels(wide)).toThrow(/plan bound/)
  })
})

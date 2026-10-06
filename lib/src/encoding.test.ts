import { describe, it, expect } from 'vitest'
import { Utils } from '@bsv/sdk'
import { encodeLinkagePayload, MandalaLinkagePayload } from './encoding.js'
import type { MandalaActionDetails } from './encoding.js'

it('accepts the new stablecoin action kinds (type + runtime)', () => {
  const d: MandalaActionDetails = { kind: 'reissue', outpoint: 'y.1', recipient: '02ab' }
  const bytes = encodeLinkagePayload({ inputs: [], outputs: [], admin: [{ index: 0, details: JSON.stringify(d) }] })
  expect(bytes.length).toBeGreaterThan(0)
})

describe('encodeLinkagePayload', () => {
  it('encodes to JSON-UTF8 bytes that round-trip', () => {
    const payload: MandalaLinkagePayload = {
      inputs: [],
      outputs: [{ index: 0, linkage: {
        prover: 'aa', verifier: 'bb', counterparty: 'cc',
        protocolID: [2, 'mandala token'], keyID: 'k',
        encryptedLinkage: [1, 2, 3], encryptedLinkageProof: [4, 5], proofType: 0
      } }],
      admin: [{ index: 1, details: 'a16469737375' }]
    }
    const bytes = encodeLinkagePayload(payload)
    const decoded = JSON.parse(Utils.toUTF8(bytes))
    expect(decoded).toEqual(payload)
  })
})

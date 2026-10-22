import { describe, it, expect } from 'vitest'
import {
  resolveAssetMetadata, parseMetadataFromBeef, type AssetMetadata,
  payloadHash, journalListStranded, RETRY_CAP, BROADCAST_RETRY_CAP,
  type FetchAdmissionOptions, type JournalSubmit
} from './index.js'

describe('index — metadata is reachable from the package root', () => {
  it('exports resolveAssetMetadata and parseMetadataFromBeef', () => {
    expect(typeof resolveAssetMetadata).toBe('function')
    expect(typeof parseMetadataFromBeef).toBe('function')
  })

  it('exports the AssetMetadata type', () => {
    const meta: AssetMetadata = { label: 'Gold', ticker: 'GLD', decimals: 2 }
    expect(meta.label).toBe('Gold')
  })

  // A duplicated name would make `export *` drop it silently, so the amendment
  // v2.1 surface is asserted at the package root, not just at its own module.
  it('exports the amendment v2.1 surface from the package root', () => {
    expect(typeof payloadHash).toBe('function')
    expect(typeof journalListStranded).toBe('function')
    expect(RETRY_CAP).toBeGreaterThan(0)
    expect(BROADCAST_RETRY_CAP).toBeGreaterThan(0)
    const fetchOpts: FetchAdmissionOptions = { payloadHash: payloadHash([]) }
    const submit: JournalSubmit = { txHex: 'de', topics: ['tm_mandala'] }
    expect(fetchOpts.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    expect(submit.topics).toEqual(['tm_mandala'])
  })
})

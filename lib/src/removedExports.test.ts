/**
 * Contract removal list (C§8.1): the holder-side 'p mandala' pipeline and
 * cover() are gone from the package root. Holder value moves only through
 * BRC-207 receipts; the lib credits nothing itself.
 */
import { describe, it, expect } from 'vitest'

const mod = await import('./index.js')

describe('removed exports', () => {
  it.each([
    'transferTokens', 'receiveTokens', 'defaultSettle', 'cover', 'canonicalBundleId',
    'collectHandoverEvidence', 'journalEvidenceSource', 'derHex'
  ])('%s is gone', n => {
    expect(n in mod).toBe(false)
  })
})

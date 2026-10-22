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
    'collectHandoverEvidence', 'journalEvidenceSource', 'derHex',
    // Task 7: legacy tm_<txid> topic helpers (C§8.1)
    'tokenTopic', 'tokenLookup', 'tokenTopicOrEmpty', 'isSigmaTopic', 'deployTopics',
    // Task 16: the last 2^53 decoder (C§8.1)
    'decodeValue'
  ])('%s is gone', n => {
    expect(n in mod).toBe(false)
  })
})

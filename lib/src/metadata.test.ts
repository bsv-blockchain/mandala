import { describe, it, expect } from 'vitest'
import { ProtoWallet, PrivateKey, Transaction } from '@bsv/sdk'
import { MandalaAdmin } from '@bsv/templates'
import { parseMetadataFromBeef } from './metadata.js'

describe('parseMetadataFromBeef', () => {
  it('decodes publicData from output 0 of a genesis tx', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const lock = await MandalaAdmin.lock({ wallet: wallet as any, data: { kind: 'register' }, publicData: { label: 'Gold', ticker: 'GLD' } })
    const tx = new Transaction()
    tx.addOutput({ lockingScript: lock, satoshis: 1 })
    const meta = parseMetadataFromBeef(tx.toBEEF(), 0)
    expect(meta).toEqual({ label: 'Gold', ticker: 'GLD' })
  })

  it('round-trips an issuer identity key in publicData', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const issuer = '02' + 'a'.repeat(64)
    const lock = await MandalaAdmin.lock({ wallet: wallet as any, data: { kind: 'register' }, publicData: { label: 'Gold', decimals: 2, issuer } })
    const tx = new Transaction()
    tx.addOutput({ lockingScript: lock, satoshis: 1 })
    expect(parseMetadataFromBeef(tx.toBEEF(), 0)).toEqual({ label: 'Gold', decimals: 2, issuer })
  })

  it('returns null when output has no publicData', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const lock = await MandalaAdmin.lock({ wallet: wallet as any, data: { kind: 'register' } })
    const tx = new Transaction()
    tx.addOutput({ lockingScript: lock, satoshis: 1 })
    expect(parseMetadataFromBeef(tx.toBEEF(), 0)).toBeNull()
  })
})

describe('resolveAssetMetadata caching', () => {
  it('does not memoize a failed lookup', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    let queries = 0
    vi.doMock('@bsv/sdk', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@bsv/sdk')>()
      class LookupResolver { async query (): Promise<never> { queries++; throw new Error('offline') } }
      return { ...actual, LookupResolver }
    })
    const { configureMandala } = await import('./constants.js')
    configureMandala({ overlayUrl: 'http://test-overlay' })
    const { resolveAssetMetadata } = await import('./metadata.js')
    const id = 'dd'.repeat(32) + '.0'
    expect(await resolveAssetMetadata(id)).toBeNull()
    expect(await resolveAssetMetadata(id)).toBeNull()
    // Two calls, two resolver queries: the failure was not cached.
    expect(queries).toBe(2)
    vi.doUnmock('@bsv/sdk')
  })
})

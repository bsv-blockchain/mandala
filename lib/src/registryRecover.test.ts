/**
 * abortStuckRegistryActions — §9.11.
 *
 * The review finding: this ran immediately before every registry createAction
 * and aborted EVERY non-terminal 'mandala'+'registry' action it could see,
 * including one the overlay had already accepted and whose broadcast was still
 * pending. Aborting that destroys a transaction the overlay has committed to
 * and desyncs the wallet from it permanently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LockingScript, Transaction, Utils } from '@bsv/sdk'
import {
  abortStuckRegistryActions,
  beefContainsTxid,
  fetchRegistryBeef,
  loadRegistryInputBeef,
  pickRecoverableRegistryRow,
  toSpendingBeef
} from './registryRecover.js'
import { OverlayRegistryRow } from './registry.js'
import { journalPut, journalClear, INTENT_TTL_MS } from './txJournal.js'
import { configureStorage, memoryStorage } from './storage.js'
import { configureMandala } from './constants.js'

const SPEC_OP = 'ac6b20a3bb320adafecd637b25c84b792ad828d3aa510d05dc841481f664277d'

const action = (over: Record<string, unknown> = {}): any => ({
  txid: 'tx-stuck',
  status: 'nosend',
  reference: 'ref-stuck',
  satoshis: 1,
  isOutgoing: true,
  description: 'admitIdentity',
  version: 1,
  lockTime: 0,
  ...over
})

const mkWallet = (actions: any[] = [action()]) => ({
  abortAction: vi.fn().mockResolvedValue({ aborted: true }),
  listActions: vi.fn().mockImplementation(async (args: any) =>
    args.labels?.includes('abort') === true ? { actions: [] } : { actions }
  )
})

/** Every listActions call that carries the bulk spec-op 'abort' label. */
const bulkCalls = (wallet: ReturnType<typeof mkWallet>): unknown[] =>
  wallet.listActions.mock.calls.filter((call: any[]) => call[0]?.labels?.includes(SPEC_OP) === true)

beforeEach(async () => {
  configureStorage(null)
  await journalClear()
})

describe('abortStuckRegistryActions — journal-protected actions', () => {
  it('aborts an abandoned stuck action when the journal says nothing is live', async () => {
    const wallet = mkWallet()
    await abortStuckRegistryActions(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-stuck' })
    expect(bulkCalls(wallet)).toHaveLength(1)
  })

  it.each(['accepted', 'stranded', 'retryable'])(
    "never aborts an action whose txid has a '%s' journal entry",
    async stage => {
      await journalPut({ txid: 'tx-stuck', stage: stage as any, at: Date.now() })
      const wallet = mkWallet()
      await abortStuckRegistryActions(wallet as any)
      expect(wallet.abortAction).not.toHaveBeenCalled()
      // The server-side bulk abort takes no exceptions, so it must not run either.
      expect(bulkCalls(wallet)).toHaveLength(0)
    }
  )

  it('matches on the reference too, for an entry journaled before the txid was known', async () => {
    await journalPut({ txid: 'some-other-txid', stage: 'accepted', reference: 'ref-stuck', at: Date.now() })
    const wallet = mkWallet()
    await abortStuckRegistryActions(wallet as any)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it("still aborts an action journaled as 'abort' — that entry exists to be retried", async () => {
    await journalPut({ txid: 'tx-stuck', stage: 'abort', reference: 'ref-stuck', at: Date.now() })
    const wallet = mkWallet()
    await abortStuckRegistryActions(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-stuck' })
  })

  it('protects only the journaled action; an unrelated stuck one is still released', async () => {
    await journalPut({ txid: 'tx-live', stage: 'accepted', at: Date.now() })
    const wallet = mkWallet([
      action({ txid: 'tx-live', reference: 'ref-live' }),
      action({ txid: 'tx-dead', reference: 'ref-dead' })
    ])
    await abortStuckRegistryActions(wallet as any)
    expect(wallet.abortAction).toHaveBeenCalledTimes(1)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-dead' })
  })

  it('aborts nothing when the journal cannot be read (not knowing is not a licence)', async () => {
    const mem = memoryStorage()
    configureStorage({ ...mem, keys: async () => { throw new Error('store down') } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const wallet = mkWallet()
      await abortStuckRegistryActions(wallet as any)
      expect(wallet.abortAction).not.toHaveBeenCalled()
      expect(wallet.listActions).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      configureStorage(null)
    }
  })
})

describe('abortStuckRegistryActions — intent TTL', () => {
  const NOW = 1_700_000_000_000

  it('leaves an action younger than the intent TTL alone (another tab may be mid-flight)', async () => {
    const wallet = mkWallet([action({ createdAt: new Date(NOW - 1_000).toISOString() })])
    await abortStuckRegistryActions(wallet as any, NOW)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('aborts once the action is older than the intent TTL', async () => {
    const wallet = mkWallet([action({ createdAt: new Date(NOW - INTENT_TTL_MS - 1).toISOString() })])
    await abortStuckRegistryActions(wallet as any, NOW)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-stuck' })
  })

  it('accepts an epoch-ms or Date createdAt as readily as an ISO string', async () => {
    const fresh = mkWallet([action({ createdAt: NOW - 1_000 })])
    await abortStuckRegistryActions(fresh as any, NOW)
    expect(fresh.abortAction).not.toHaveBeenCalled()

    const old = mkWallet([action({ createdAt: new Date(NOW - INTENT_TTL_MS - 1) })])
    await abortStuckRegistryActions(old as any, NOW)
    expect(old.abortAction).toHaveBeenCalled()
  })

  it('a wallet that reports no timestamp keeps the previous behaviour', async () => {
    const wallet = mkWallet([action()]) // no createdAt at all
    await abortStuckRegistryActions(wallet as any, NOW)
    expect(wallet.abortAction).toHaveBeenCalledWith({ reference: 'ref-stuck' })
  })

  it('skips terminal actions and ones with no reference, as before', async () => {
    const wallet = mkWallet([
      action({ status: 'completed', reference: 'ref-done' }),
      action({ status: 'unproven', reference: 'ref-unproven' }),
      action({ status: 'failed', reference: 'ref-failed' }),
      action({ reference: '' })
    ])
    await abortStuckRegistryActions(wallet as any, NOW)
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })

  it('survives a wallet with no listActions support without throwing', async () => {
    const wallet = {
      abortAction: vi.fn(),
      listActions: vi.fn().mockRejectedValue(new Error('unknown label'))
    }
    await expect(abortStuckRegistryActions(wallet as any)).resolves.toBeUndefined()
    expect(wallet.abortAction).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers: picking the live head and handing its bytes to createAction
// ---------------------------------------------------------------------------

const row = (over: Partial<OverlayRegistryRow> = {}): OverlayRegistryRow => ({
  identityKey: '02' + 'ab'.repeat(32),
  status: 'admitted',
  txid: 'aa'.repeat(32),
  outputIndex: 0,
  admitSeq: 1,
  createdAt: '',
  ...over
})

/** A standalone transaction whose BEEF we can hand around. */
const mkTx = (nonce: number): Transaction => {
  const tx = new Transaction()
  tx.lockTime = nonce
  tx.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 1 })
  return tx
}

describe('pickRecoverableRegistryRow', () => {
  const ISSUER = '02' + '11'.repeat(32)

  it('picks the newest row that names a transaction', () => {
    const head = row({ txid: 'cc'.repeat(32), admitSeq: 9 })
    expect(pickRecoverableRegistryRow([row({ admitSeq: 3 }), head, row({ admitSeq: 7 })])).toBe(head)
  })

  it('skips rows with no txid, and returns null when none names one', () => {
    const named = row({ txid: 'dd'.repeat(32), admitSeq: 2 })
    expect(pickRecoverableRegistryRow([row({ txid: '', admitSeq: 99 }), named])).toBe(named)
    expect(pickRecoverableRegistryRow([row({ txid: '', admitSeq: 99 })])).toBeNull()
    expect(pickRecoverableRegistryRow([])).toBeNull()
  })

  it('does NOT prefer the issuer’s own row — it keeps pointing at a spent genesis', () => {
    // Rows are keyed by the identity each action TARGETS, so the issuer's row
    // stays on the genesis outpoint for the life of the chain. The head is the
    // newest row, whoever it names.
    const genesis = row({ identityKey: ISSUER, admitSeq: 1, txid: 'aa'.repeat(32) })
    const peerAdmit = row({ identityKey: '02' + '22'.repeat(32), admitSeq: 2, txid: 'bb'.repeat(32) })
    expect(pickRecoverableRegistryRow([genesis, peerAdmit])).toBe(peerAdmit)
  })

  it('treats a revoke link as the head just as much as an admit', () => {
    const revoke = row({ status: 'revoked', admitSeq: 5, txid: 'ee'.repeat(32) })
    expect(pickRecoverableRegistryRow([row({ admitSeq: 4 }), revoke])).toBe(revoke)
  })
})

describe('beefContainsTxid / toSpendingBeef', () => {
  const tx = mkTx(1)
  const beef = tx.toBEEF()

  it('recognises the transaction its BEEF carries', () => {
    expect(beefContainsTxid(beef, tx.id('hex'))).toBe(true)
  })

  it('is false for an unrelated txid and for bytes that are not BEEF at all', () => {
    expect(beefContainsTxid(beef, 'ff'.repeat(32))).toBe(false)
    expect(beefContainsTxid([1, 2, 3], tx.id('hex'))).toBe(false)
    expect(beefContainsTxid([], tx.id('hex'))).toBe(false)
  })

  it('toSpendingBeef hands back a BEEF graph that still contains the tx', () => {
    const spending = toSpendingBeef(beef, tx.id('hex'))
    expect(beefContainsTxid(spending, tx.id('hex'))).toBe(true)
  })

  it('toSpendingBeef throws, naming the txid, when the graph does not contain it', () => {
    expect(() => toSpendingBeef(beef, 'ff'.repeat(32))).toThrow(/ff{8}/)
  })
})

describe('fetchRegistryBeef / loadRegistryInputBeef', () => {
  const mockFetch = vi.fn()
  const tx = mkTx(2)
  const TXID = tx.id('hex')

  beforeEach(() => {
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
    configureMandala({ overlayUrl: 'http://test-overlay' })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('prefers the overlay’s own BEEF, asking for the right outpoint', async () => {
    const beef = tx.toBEEF()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ beef }) })
    expect(await fetchRegistryBeef(TXID, 3)).toEqual(beef)
    expect(mockFetch).toHaveBeenCalledWith(`http://test-overlay/admin/registry/beef/${TXID}?vout=3`)
  })

  it('accepts a hex-encoded beefHex body as readily as a byte array', async () => {
    const beef = tx.toBEEF()
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ beefHex: Utils.toHex(beef) }) })
    expect(await fetchRegistryBeef(TXID, 0)).toEqual(beef)
  })

  it('falls back to the chain when the overlay has nothing, and returns null if that fails too', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) }) // overlay
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => '' }) // whatsonchain
    expect(await fetchRegistryBeef(TXID, 0)).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('loadRegistryInputBeef fails legibly when no BEEF can be found for the outpoint', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}), text: async () => '' })
    await expect(loadRegistryInputBeef({} as any, `${TXID}.0`))
      .rejects.toThrow(/re-attach the identity chain/)
  })

  it('loadRegistryInputBeef rejects a malformed outpoint before any fetch', async () => {
    await expect(loadRegistryInputBeef({} as any, '.0')).rejects.toThrow(/bad registry auth outpoint/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

import { describe, it, expect } from 'vitest'
import { Transaction, UnlockingScript, P2PKH, PrivateKey } from '@bsv/sdk'
import {
  SubmitSideChannel, withVerdictCapture, newSubmitScope, runInSubmitScope, PENDING_WRITE_FAILED,
  type AdmissionPending
} from './submitSideChannel.js'
import { InputSpentError, InfraError, isInfraError } from './submitVerdict.js'

const tx = (): Transaction => {
  const t = new Transaction()
  t.addInput({ sourceTXID: 'aa'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  t.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(new PrivateKey(7).toAddress()) })
  return t
}

describe('SubmitSideChannel', () => {
  it('take() returns the noted outcome once, then forgets it', () => {
    const ch = new SubmitSideChannel()
    ch.noteReject('ab'.repeat(32), new Error('conservation violated'))
    expect(ch.take('ab'.repeat(32))?.reason).toBe('conservation violated')
    expect(ch.take('ab'.repeat(32))).toBeUndefined()
  })

  it('keeps the spendTxid off an InputSpentError', () => {
    const ch = new SubmitSideChannel()
    ch.noteReject('ab'.repeat(32), new InputSpentError('cd'.repeat(32) + '.0', 'ef'.repeat(32)))
    const got = ch.take('ab'.repeat(32))
    expect(got?.spendTxid).toBe('ef'.repeat(32))
    expect(got?.reason).toContain('already spent by')
  })

  it('carries the restore snapshot alongside a successful admission', () => {
    const ch = new SubmitSideChannel()
    const restore = { spentOutpoints: ['aa'.repeat(32) + '.0'], tokenRows: [] }
    ch.noteRestore('ab'.repeat(32), restore)
    expect(ch.take('ab'.repeat(32))?.restore).toEqual(restore)
  })

  it('merges a restore note and a later reject for the same txid', () => {
    const ch = new SubmitSideChannel()
    ch.noteRestore('ab'.repeat(32), { spentOutpoints: ['x.0'], tokenRows: [] })
    ch.noteReject('ab'.repeat(32), new Error('boom'))
    const got = ch.take('ab'.repeat(32))
    expect(got?.reason).toBe('boom')
    expect(got?.restore?.spentOutpoints).toEqual(['x.0'])
  })

  it('prunes entries older than the ttl so a dropped connection cannot leak', () => {
    let now = 1000
    const ch = new SubmitSideChannel({ ttlMs: 100, now: () => now })
    ch.noteReject('ab'.repeat(32), new Error('x'))
    now = 1101
    ch.noteReject('cd'.repeat(32), new Error('y')) // any write prunes
    expect(ch.take('ab'.repeat(32))).toBeUndefined()
    expect(ch.take('cd'.repeat(32))?.reason).toBe('y')
  })

  it('lets tm_mandala outrank another topic regardless of arrival order', () => {
    const a = new SubmitSideChannel()
    a.noteReject('ab'.repeat(32), new Error('registry bad'), 'tm_mandala_registry')
    a.noteReject('ab'.repeat(32), new Error('conservation violated'), 'tm_mandala')
    expect(a.take('ab'.repeat(32))?.reason).toBe('conservation violated')

    const b = new SubmitSideChannel()
    b.noteReject('ab'.repeat(32), new Error('conservation violated'), 'tm_mandala')
    b.noteReject('ab'.repeat(32), new Error('registry bad'), 'tm_mandala_registry')
    expect(b.take('ab'.repeat(32))?.reason).toBe('conservation violated')
  })

  it('records a non-token reason when nothing else has been captured', () => {
    const ch = new SubmitSideChannel()
    ch.noteReject('ab'.repeat(32), new Error('registry bad'), 'tm_mandala_registry')
    const got = ch.take('ab'.repeat(32))
    expect(got?.reason).toBe('registry bad')
    expect(got?.topic).toBe('tm_mandala_registry')
  })

  it('tracks compare-and-swap spend conflicts by coin outpoint', () => {
    const ch = new SubmitSideChannel()
    const coin = 'aa'.repeat(32) + '.0'
    expect(ch.hadSpendConflict([coin])).toBe(false)
    ch.noteSpendConflict(coin)
    expect(ch.hadSpendConflict([coin])).toBe(true)
    expect(ch.hadSpendConflict(['ff'.repeat(32) + '.1'])).toBe(false)
    expect(ch.hadSpendConflict([])).toBe(false)
  })

  it('expires spend conflicts on the same ttl', () => {
    let now = 1000
    const ch = new SubmitSideChannel({ ttlMs: 100, now: () => now })
    const coin = 'aa'.repeat(32) + '.0'
    ch.noteSpendConflict(coin)
    expect(ch.hadSpendConflict([coin])).toBe(true)
    now = 1101
    expect(ch.hadSpendConflict([coin])).toBe(false)
  })

  it('keys strictly by txid so concurrent submissions do not cross-talk', () => {
    const ch = new SubmitSideChannel()
    ch.noteReject('ab'.repeat(32), new Error('first'))
    ch.noteReject('cd'.repeat(32), new Error('second'))
    expect(ch.take('cd'.repeat(32))?.reason).toBe('second')
    expect(ch.take('ab'.repeat(32))?.reason).toBe('first')
  })
})

describe('withVerdictCapture', () => {
  it('records the inner reject reason keyed by txid and rethrows unchanged', async () => {
    const ch = new SubmitSideChannel()
    const inner: any = {
      identifyAdmissibleOutputs: async () => { throw new Error('conservation violated: outputs exceed authorized inputs/issuance') },
      getDocumentation: async () => 'doc',
      getMetaData: async () => ({ name: 'tm_mandala', shortDescription: 's' })
    }
    const t = tx()
    const tm = withVerdictCapture(inner, { channel: ch })
    await expect(tm.identifyAdmissibleOutputs(t.toBEEF(), [0], undefined)).rejects.toThrow('conservation violated')
    expect(ch.take(t.id('hex'))?.reason).toBe('conservation violated: outputs exceed authorized inputs/issuance')
  })

  it('captures the spendTxid of an InputSpentError', async () => {
    const ch = new SubmitSideChannel()
    const inner: any = {
      identifyAdmissibleOutputs: async () => { throw new InputSpentError('aa'.repeat(32) + '.0', 'bb'.repeat(32)) }
    }
    const t = tx()
    await expect(withVerdictCapture(inner, { channel: ch }).identifyAdmissibleOutputs(t.toBEEF(), [0], undefined)).rejects.toThrow()
    expect(ch.take(t.id('hex'))?.spendTxid).toBe('bb'.repeat(32))
  })

  it('snapshots the pre-spend restore state before delegating (FIX E)', async () => {
    const ch = new SubmitSideChannel()
    const order: string[] = []
    const inner: any = { identifyAdmissibleOutputs: async () => { order.push('inner'); return { outputsToAdmit: [0], coinsToRetain: [0] } } }
    const t = tx()
    const tm = withVerdictCapture(inner, {
      channel: ch,
      snapshotRestore: async (parsed, previousCoins) => {
        order.push('snapshot')
        return { spentOutpoints: previousCoins.map(ci => `${parsed.inputs[ci].sourceTXID ?? ''}.${parsed.inputs[ci].sourceOutputIndex}`), tokenRows: [] }
      }
    })
    const res = await tm.identifyAdmissibleOutputs(t.toBEEF(), [0], undefined)
    expect(res.outputsToAdmit).toEqual([0])
    expect(order).toEqual(['snapshot', 'inner'])
    expect(ch.take(t.id('hex'))?.restore?.spentOutpoints).toEqual(['aa'.repeat(32) + '.0'])
  })

  it('a snapshot failure never fails the submission', async () => {
    const ch = new SubmitSideChannel()
    const inner: any = { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [0], coinsToRetain: [] }) }
    const tm = withVerdictCapture(inner, { channel: ch, snapshotRestore: async () => { throw new Error('mongo down') } })
    await expect(tm.identifyAdmissibleOutputs(tx().toBEEF(), [0], undefined)).resolves.toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
  })

  it('preserves documentation/metadata through the proxy', async () => {
    const inner: any = {
      identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [], coinsToRetain: [] }),
      getDocumentation: async () => 'doc',
      getMetaData: async () => ({ name: 'tm_mandala', shortDescription: 's' })
    }
    const tm = withVerdictCapture(inner, { channel: new SubmitSideChannel() })
    expect(await tm.getDocumentation()).toBe('doc')
    expect(await tm.getMetaData?.()).toEqual({ name: 'tm_mandala', shortDescription: 's' })
  })

  // §9.5 — an InfraError from any guard beneath is carried STRUCTURALLY, so its
  // code never depends on the wording the substring table would otherwise read.
  it('carries an InfraError as a structural ERR_UNAVAILABLE verdict', async () => {
    const ch = new SubmitSideChannel()
    const inner: any = {
      identifyAdmissibleOutputs: async () => { throw new InfraError('the token row store is unavailable: already spent') }
    }
    const t = tx()
    await expect(withVerdictCapture(inner, { channel: ch }).identifyAdmissibleOutputs(t.toBEEF(), [0], undefined))
      .rejects.toThrow('unavailable')
    const got = ch.take(t.id('hex'))
    expect(got?.verdict).toEqual({
      code: 'ERR_UNAVAILABLE',
      description: 'the token row store is unavailable: already spent',
      spendTxid: undefined
    })
  })
})

// ─────────────── §9.4 — the provisional admission record ────────────────────

describe('withVerdictCapture — provisional record (§9.4)', () => {
  it('writes {txid, topics, restore, at} BEFORE delegating, with the snapshot attached', async () => {
    const ch = new SubmitSideChannel()
    const order: string[] = []
    const written: AdmissionPending[] = []
    const inner: any = { identifyAdmissibleOutputs: async () => { order.push('inner'); return { outputsToAdmit: [0], coinsToRetain: [0] } } }
    const t = tx()
    const tm = withVerdictCapture(inner, {
      channel: ch,
      snapshotRestore: async () => { order.push('snapshot'); return { spentOutpoints: ['aa'.repeat(32) + '.0'], tokenRows: [] } },
      putPending: async (rec) => { order.push('pending'); written.push(rec) }
    })
    await tm.identifyAdmissibleOutputs(t.toBEEF(), [0], undefined)
    // The snapshot is durable strictly before the engine can broadcast or mark
    // anything spent — which is the whole point: a crash in that window would
    // otherwise leave coins spent with no record of what to put back.
    expect(order).toEqual(['snapshot', 'pending', 'inner'])
    expect(written).toHaveLength(1)
    expect(written[0].txid).toBe(t.id('hex'))
    expect(written[0].topics).toEqual(['tm_mandala'])
    expect(written[0].restore?.spentOutpoints).toEqual(['aa'.repeat(32) + '.0'])
    expect(written[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('names the wrapper\'s own topic on a non-token manager', async () => {
    const written: AdmissionPending[] = []
    const inner: any = { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [], coinsToRetain: [] }) }
    const tm = withVerdictCapture(inner, {
      channel: new SubmitSideChannel(), topic: 'tm_mandala_registry', putPending: async (r) => { written.push(r) }
    })
    await tm.identifyAdmissibleOutputs(tx().toBEEF(), [0], undefined)
    expect(written[0].topics).toEqual(['tm_mandala_registry'])
  })

  it('a failed provisional write refuses the submission as a retryable InfraError', async () => {
    const ch = new SubmitSideChannel()
    let delegated = false
    const inner: any = { identifyAdmissibleOutputs: async () => { delegated = true; return { outputsToAdmit: [0], coinsToRetain: [] } } }
    const t = tx()
    const tm = withVerdictCapture(inner, { channel: ch, putPending: async () => { throw new Error('mongo down') } })
    const err = await tm.identifyAdmissibleOutputs(t.toBEEF(), [0], undefined).catch((e: unknown) => e)
    expect(isInfraError(err)).toBe(true)
    expect((err as InfraError).message).toBe(PENDING_WRITE_FAILED)
    // The engine never runs, so nothing is broadcast without a durable snapshot…
    expect(delegated).toBe(false)
    // …and the verdict travels as a 503, never a persistable 400.
    expect(ch.take(t.id('hex'))?.verdict?.code).toBe('ERR_UNAVAILABLE')
  })

  it('is optional — a store without it still delegates', async () => {
    const inner: any = { identifyAdmissibleOutputs: async () => ({ outputsToAdmit: [1], coinsToRetain: [] }) }
    const tm = withVerdictCapture(inner, { channel: new SubmitSideChannel() })
    expect((await tm.identifyAdmissibleOutputs(tx().toBEEF(), [0], undefined)).outputsToAdmit).toEqual([1])
  })
})

// ───────────── §9.7 — request-scoped captures, not one global map ────────────

describe('SubmitSideChannel — request scopes (§9.7)', () => {
  const A = 'ab'.repeat(32)

  it('two scopes capture the SAME txid independently', () => {
    const ch = new SubmitSideChannel()
    const one = newSubmitScope()
    const two = newSubmitScope()
    runInSubmitScope(one, () => { ch.noteReject(A, new Error('conservation violated')) })
    runInSubmitScope(two, () => { ch.noteReject(A, new Error('asset is paused')) })
    expect(ch.take(A, one)?.reason).toBe('conservation violated')
    expect(ch.take(A, two)?.reason).toBe('asset is paused')
  })

  it('a scope with no capture of its own does NOT see another scope\'s verdict', () => {
    const ch = new SubmitSideChannel()
    const refused = newSubmitScope()
    const clean = newSubmitScope()
    runInSubmitScope(refused, () => { ch.noteReject(A, new Error('conservation violated')) })
    expect(ch.take(A, clean)).toBeUndefined()
    expect(ch.take(A, refused)?.reason).toBe('conservation violated')
  })

  it('the scope survives awaits inside it', async () => {
    const ch = new SubmitSideChannel()
    const scope = newSubmitScope()
    await runInSubmitScope(scope, async () => {
      await Promise.resolve()
      ch.noteReject(A, new Error('conservation violated'))
    })
    expect(ch.take(A, scope)?.reason).toBe('conservation violated')
  })

  it('a capture made outside any scope stays visible process-wide (GASP, tests)', () => {
    const ch = new SubmitSideChannel()
    ch.noteReject(A, new Error('conservation violated'))
    expect(ch.take(A, newSubmitScope())?.reason).toBe('conservation violated')
  })

  it('spend conflicts are scoped too — the LOSER records, so the winner must not see it', () => {
    const ch = new SubmitSideChannel()
    const coin = 'aa'.repeat(32) + '.0'
    const winner = newSubmitScope()
    const loser = newSubmitScope()
    runInSubmitScope(loser, () => { ch.noteSpendConflict(coin) })
    expect(ch.hadSpendConflict([coin], winner)).toBe(false)
    expect(ch.hadSpendConflict([coin], loser)).toBe(true)
  })
})

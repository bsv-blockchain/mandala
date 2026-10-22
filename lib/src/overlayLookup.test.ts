/// <reference types="vite/client" />
/**
 * BRC-24 `/lookup` transport and the hash-verified deploy fetch (plan 04
 * Task 12, C§6, C§8.1). The fetch is faked; transactions are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { OneColor } from '@bsv/templates'
import { configureMandala, OVERLAY_URL_UNSET } from './constants.js'
import { clearDeployTxCache, fetchDeployTx, LookupError, postLookup } from './overlayLookup.js'
import fRaw from './__fixtures__/1color-deploy.json?raw'

const fixture = JSON.parse(fRaw) as { lockingScriptHex: string }

const pkh = new PrivateKey(11).toPublicKey().toHash() as number[]

/** A deploy tx (output 0 = the F-REQ deploy script) funded by an unproven parent. */
function deployTx (seed = 1): Transaction {
  const src = new Transaction()
  src.addOutput({ satoshis: 10 + seed, lockingScript: new P2PKH().lock(pkh) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
  tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(fixture.lockingScriptHex) })
  return tx
}

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
const status = (s: number, body: unknown) => ({ ok: false, status: s, text: async () => typeof body === 'string' ? body : JSON.stringify(body) })
const answer = (tx: Transaction, txid: string | undefined = tx.id('hex')) => ({
  type: 'output-list',
  outputs: [{ beef: tx.toAtomicBEEF(true), outputIndex: 0, ...(txid != null ? { txid } : {}) }]
})

async function lookupError (p: Promise<unknown>): Promise<LookupError> {
  try {
    await p
  } catch (e) {
    return e as LookupError
  }
  throw new Error('expected a LookupError')
}

beforeEach(() => {
  clearDeployTxCache()
  configureMandala({ overlayUrl: 'http://o' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('postLookup', () => {
  it('POSTs {service, query} as JSON to <overlay>/lookup and returns the output-list', async () => {
    const tx = deployTx()
    const f = vi.fn(async () => ok(answer(tx)))
    const res = await postLookup('ls_color_x', { a: 1 }, { fetch: f as any })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as unknown as [string, any]
    expect(url).toBe('http://o/lookup')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ service: 'ls_color_x', query: { a: 1 } })
    expect(res).toEqual({ type: 'output-list', outputs: [{ beef: tx.toAtomicBEEF(true), outputIndex: 0, txid: tx.id('hex') }] })
  })

  it('uses an explicit url over the configured one', async () => {
    const f = vi.fn(async () => ok({ type: 'output-list', outputs: [] }))
    await postLookup('s', {}, { url: 'http://other', fetch: f as any })
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://other/lookup')
  })

  it('derives a missing answer txid from the AtomicBEEF subject', async () => {
    const tx = deployTx()
    const f = vi.fn(async () => ok(answer(tx, undefined)))
    const res = await postLookup('s', {}, { fetch: f as any })
    expect(res.outputs[0].txid).toBe(tx.id('hex'))
  })

  it('503 ⇒ LookupError ERR_UNAVAILABLE, retryable, transport', async () => {
    const f = vi.fn(async () => status(503, { status: 'error', code: 'ERR_UNAVAILABLE', retryable: true, description: 'store down' }))
    const e = await lookupError(postLookup('s', {}, { fetch: f as any }))
    expect(e.name).toBe('LookupError')
    expect(e).toMatchObject({ code: 'ERR_UNAVAILABLE', retryable: true, transport: true })
    expect(e.message).toMatch(/\(ERR_UNAVAILABLE, retryable\)/)
  })

  it('a 500 with no body is a transport failure too', async () => {
    const f = vi.fn(async () => status(500, ''))
    expect(await lookupError(postLookup('s', {}, { fetch: f as any }))).toMatchObject({ code: 'ERR_UNAVAILABLE', transport: true })
  })

  it('a typed 400 keeps its code and retryable flag and is not a transport failure', async () => {
    const f = vi.fn(async () => status(400, { status: 'error', code: 'ERR_SHAPE', retryable: false, description: 'bad' }))
    const e = await lookupError(postLookup('s', {}, { fetch: f as any }))
    expect(e).toMatchObject({ name: 'LookupError', code: 'ERR_SHAPE', retryable: false, transport: false })
    expect(e.message).toMatch(/\(ERR_SHAPE\)/)
  })

  it('an untyped 400 {status, message} (overlay-go errorResponse) is a final ERR_LOOKUP', async () => {
    const f = vi.fn(async () => status(400, { status: 'error', message: 'Invalid lookup query: x' }))
    const e = await lookupError(postLookup('s', {}, { fetch: f as any }))
    expect(e).toMatchObject({ code: 'ERR_LOOKUP', retryable: false, transport: false })
    expect(e.message).toMatch(/Invalid lookup query: x/)
  })

  it('a network fault, a non-JSON 200 and a timeout are transport failures', async () => {
    const thrown = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    expect(await lookupError(postLookup('s', {}, { fetch: thrown as any }))).toMatchObject({ code: 'ERR_UNAVAILABLE', transport: true, retryable: true })
    const html = vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html>' }))
    expect(await lookupError(postLookup('s', {}, { fetch: html as any }))).toMatchObject({ code: 'ERR_UNAVAILABLE', transport: true })
    const hang = vi.fn((_u: string, init: any) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const e = await lookupError(postLookup('s', {}, { fetch: hang as any, timeoutMs: 20 }))
    expect(e).toMatchObject({ code: 'ERR_UNAVAILABLE', transport: true })
    expect(e.message).toMatch(/timed out/)
  })

  it('a 200 that is not an output-list is an invalid answer, never a transport failure', async () => {
    for (const body of [{ type: 'freeform', result: {} }, { type: 'output-list', outputs: [{ beef: 'zz', outputIndex: 0 }] }, { type: 'output-list', outputs: [{ beef: [1], outputIndex: -1, txid: 'a'.repeat(64) }] }]) {
      const f = vi.fn(async () => ok(body))
      expect(await lookupError(postLookup('s', {}, { fetch: f as any }))).toMatchObject({ code: 'ERR_INVALID_ANSWER', transport: false })
    }
  })

  it('refuses before any request while the overlay URL is unset', async () => {
    configureMandala({ overlayUrl: '' })
    const f = vi.fn()
    await expect(postLookup('s', {}, { fetch: f as any })).rejects.toThrow(OVERLAY_URL_UNSET)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('fetchDeployTx', () => {
  it('asks ls_color_<id> for color-admission of <txid>.0 and returns the hash-verified deploy', async () => {
    const tx = deployTx()
    const txid = tx.id('hex')
    const id = `${txid}_0`
    const f = vi.fn(async () => ok(answer(tx)))
    vi.stubGlobal('fetch', f)
    const got = await fetchDeployTx(id)
    expect(got.id('hex')).toBe(txid)
    expect(got.toHex()).toBe(tx.toHex())
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, any])[1].body)
    expect(body).toEqual({
      service: `ls_color_${id}`,
      query: { type: 'color-admission', version: 1, assetId: id, topic: `tm_color_${id}`, outpoints: [`${txid}.0`] }
    })
    expect(Object.keys(body.query)).toEqual(['type', 'version', 'assetId', 'topic', 'outpoints'])
  })

  it('memoizes a verified answer and hands every caller a fresh Transaction', async () => {
    const tx = deployTx()
    const id = `${tx.id('hex')}_0`
    const f = vi.fn(async () => ok(answer(tx)))
    vi.stubGlobal('fetch', f)
    const a = await fetchDeployTx(id)
    a.outputs[0].satoshis = 999 // a caller mutating its copy must not poison the cache
    const b = await fetchDeployTx(id)
    expect(f).toHaveBeenCalledTimes(1)
    expect(b).not.toBe(a)
    expect(b.outputs[0].satoshis).toBe(1)
    expect(b.toHex()).toBe(tx.toHex())
  })

  it('stale or poisoned cache: an answer whose BEEF tx hashes to another txid is refused and never memoized', async () => {
    const real = deployTx(1)
    const other = deployTx(2)
    const id = `${real.id('hex')}_0`
    // The answer claims the real txid but carries another transaction.
    const f = vi.fn(async () => ok(answer(other, real.id('hex'))))
    vi.stubGlobal('fetch', f)
    const e = await lookupError(fetchDeployTx(id))
    expect(e).toMatchObject({ name: 'LookupError', code: 'ERR_INVALID_ANSWER', transport: false })
    await expect(fetchDeployTx(id)).rejects.toThrow()
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('refuses an answer whose output 0 is not a deploy', async () => {
    const src = new Transaction()
    src.addOutput({ satoshis: 5, lockingScript: new P2PKH().lock(pkh) })
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]), sequence: 0xffffffff })
    tx.addOutput({ satoshis: 1, lockingScript: new OneColor().lock('cc'.repeat(32) + '_0', 5n, pkh) })
    vi.stubGlobal('fetch', vi.fn(async () => ok(answer(tx))))
    expect(await lookupError(fetchDeployTx(`${tx.id('hex')}_0`))).toMatchObject({ code: 'ERR_INVALID_ANSWER' })
  })

  it('an empty answer is ERR_NOT_FOUND', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ type: 'output-list', outputs: [] })))
    expect(await lookupError(fetchDeployTx('ab'.repeat(32) + '_0'))).toMatchObject({ code: 'ERR_NOT_FOUND', transport: false })
  })

  it('refuses a non-Mandala asset id before any request', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(fetchDeployTx('ab'.repeat(32) + '_1')).rejects.toThrow(TypeError)
    await expect(fetchDeployTx('AB'.repeat(32) + '_0')).rejects.toThrow(TypeError)
    expect(f).not.toHaveBeenCalled()
  })
})

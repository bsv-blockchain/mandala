import { describe, it, expect } from 'vitest'
import { PrivateKey } from '@bsv/sdk'
import { createMandalaOverlayProvider } from './profileProvider.js'

const TXID = 'c7d0f61946bc8bde6c01219c67bb99cbf2f89a39bcaea9c2ecf67c54224edb4f'
const ID = `${TXID}_0`
const K = new PrivateKey(5555).toPublicKey().toString()
const URL_ = 'https://overlay.example'

interface Call { url: string, init: any }
type Reply = { status: number, body?: unknown, raw?: string } | 'throw' | 'hang'

function fakeFetch (...replies: Reply[]): ((url: string, init: any) => Promise<any>) & { calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const f = async (url: string, init: any): Promise<any> => {
    calls.push({ url, init })
    const r = replies[Math.min(i++, replies.length - 1)]
    if (r === 'throw') throw new TypeError('fetch failed')
    if (r === 'hang') return await new Promise(() => {})
    const text = r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body))
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => text }
  }
  return Object.assign(f, { calls })
}

const LIST = { type: 'output-list', outputs: [{ beef: [1], outputIndex: 0, txid: TXID }] }
const provider = (f: any, timeoutMs?: number) =>
  createMandalaOverlayProvider({ url: URL_, identityKey: K, fetch: f, ...(timeoutMs != null ? { timeoutMs } : {}) })

async function caught (p: Promise<unknown>): Promise<any> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected a rejection')
}

describe('createMandalaOverlayProvider: construction', () => {
  it('exposes url and identityKey', () => {
    const p = provider(fakeFetch({ status: 200, body: LIST }))
    expect(p.url).toBe(URL_)
    expect(p.identityKey).toBe(K)
  })

  it('refuses a missing url or a malformed identity key (fail closed, S5)', () => {
    const f = fakeFetch({ status: 200, body: LIST })
    expect(() => createMandalaOverlayProvider({ url: '', identityKey: K, fetch: f as any })).toThrow(TypeError)
    expect(() => createMandalaOverlayProvider({ url: 'ftp://x', identityKey: K, fetch: f as any })).toThrow(TypeError)
    expect(() => createMandalaOverlayProvider({ url: URL_, identityKey: '', fetch: f as any })).toThrow(TypeError)
    expect(() => createMandalaOverlayProvider({ url: URL_, identityKey: K.toUpperCase(), fetch: f as any })).toThrow(TypeError)
    // 66 hex but not on the curve
    expect(() => createMandalaOverlayProvider({ url: URL_, identityKey: '02' + 'f'.repeat(64), fetch: f as any })).toThrow(TypeError)
    expect(f.calls).toHaveLength(0)
  })
})

describe('createMandalaOverlayProvider: lookups (C§6)', () => {
  it('spendability POSTs the exact color-spendability query to <url>/lookup', async () => {
    const f = fakeFetch({ status: 200, body: LIST })
    const answer = await provider(f).spendability(ID, [`${TXID}.0`])
    expect(f.calls[0].url).toBe(`${URL_}/lookup`)
    expect(f.calls[0].init.method).toBe('POST')
    expect(JSON.parse(f.calls[0].init.body)).toEqual({
      service: `ls_color_${ID}`,
      query: { type: 'color-spendability', version: 1, assetId: ID, topic: `tm_color_${ID}`, outpoints: [`${TXID}.0`] }
    })
    expect(answer).toEqual(LIST)
  })

  it('admission POSTs the exact color-admission query', async () => {
    const f = fakeFetch({ status: 200, body: LIST })
    await provider(f).admission(ID, [`${TXID}.0`, `${TXID}.4294967295`])
    expect(JSON.parse(f.calls[0].init.body)).toEqual({
      service: `ls_color_${ID}`,
      query: { type: 'color-admission', version: 1, assetId: ID, topic: `tm_color_${ID}`, outpoints: [`${TXID}.0`, `${TXID}.4294967295`] }
    })
  })

  it('refuses non-canonical outpoints with TypeError and never fetches', async () => {
    const f = fakeFetch({ status: 200, body: LIST })
    const p = provider(f)
    await expect(p.admission(ID, [`${TXID}_0`])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, [])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, [`${TXID}.0`, `${TXID}.0`])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, [`${TXID.toUpperCase()}.0`])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, [`${TXID}.01`])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, [`${TXID}.4294967296`])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, [`${TXID}.-1`])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, [7 as any])).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, 'x' as any)).rejects.toThrow(TypeError)
    await expect(p.spendability(ID, Array.from({ length: 1001 }, (_, i) => `${TXID}.${i}`))).rejects.toThrow(TypeError)
    await expect(p.spendability(`${TXID}.0`, [`${TXID}.0`])).rejects.toThrow(TypeError)
    expect(f.calls).toHaveLength(0)
    // exactly 1000 is accepted
    await p.spendability(ID, Array.from({ length: 1000 }, (_, i) => `${TXID}.${i}`))
    expect(f.calls).toHaveLength(1)
  })

  it('503 ⇒ ColorProviderError ERR_UNAVAILABLE, retryable, transport', async () => {
    const e = await caught(provider(fakeFetch({ status: 503, body: { status: 'error', code: 'ERR_UNAVAILABLE', retryable: true, description: 'store down' } })).spendability(ID, [`${TXID}.0`]))
    expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', retryable: true, transport: true })
    expect(e.message).toBe('[ColorProviderError] mandala overlay refused (ERR_UNAVAILABLE, retryable): store down')
  })

  it('a fetch failure or a timeout is transport', async () => {
    expect(await caught(provider(fakeFetch('throw')).admission(ID, [`${TXID}.0`])))
      .toMatchObject({ name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', retryable: true, transport: true })
    expect(await caught(provider(fakeFetch('hang'), 10).spendability(ID, [`${TXID}.0`])))
      .toMatchObject({ name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', retryable: true, transport: true })
  })

  it('a typed 400 lookup refusal keeps its code and is not transport', async () => {
    const e = await caught(provider(fakeFetch({ status: 400, body: { status: 'error', code: 'ERR_SHAPE', retryable: false, description: 'Invalid lookup query: outpoints' } })).spendability(ID, [`${TXID}.0`]))
    expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_SHAPE', retryable: false, transport: false })
    expect(e.message).toBe('[ColorProviderError] mandala overlay refused (ERR_SHAPE): Invalid lookup query: outpoints')
  })

  it('a typed ERR_UNAVAILABLE lookup answer is transport whatever its status', async () => {
    expect(await caught(provider(fakeFetch({ status: 400, body: { status: 'error', code: 'ERR_UNAVAILABLE', retryable: true, description: 'x' } })).spendability(ID, [`${TXID}.0`])))
      .toMatchObject({ code: 'ERR_UNAVAILABLE', retryable: true, transport: true })
  })

  it('an untyped 400 lookup refusal is final (ERR_LOOKUP), not transport', async () => {
    const e = await caught(provider(fakeFetch({ status: 400, body: { status: 'error', message: 'Invalid lookup query: outpoints' } })).admission(ID, [`${TXID}.0`]))
    expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_LOOKUP', retryable: false, transport: false })
    expect(e.message).toBe('[ColorProviderError] mandala overlay refused (ERR_LOOKUP): Invalid lookup query: outpoints')
  })

  it('an answer that is not a well-formed output-list is a bad answer, never an outage', async () => {
    // An entry without txid whose bytes name no transaction, and a non-list answer.
    for (const body of [
      { type: 'output-list', outputs: [{ beef: [1], outputIndex: 0 }] },
      { type: 'output-list', outputs: [{ outputIndex: 0, txid: TXID }] },
      { type: 'freeform', result: 1 }
    ]) {
      const e = await caught(provider(fakeFetch({ status: 200, body })).spendability(ID, [`${TXID}.0`]))
      expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_INVALID_ANSWER', transport: false })
      expect(e.message.startsWith('[ColorProviderError] mandala overlay refused (ERR_INVALID_ANSWER')).toBe(true)
    }
  })

  it('a 200 with a non-JSON body is transport', async () => {
    expect(await caught(provider(fakeFetch({ status: 200, raw: '<html>' })).spendability(ID, [`${TXID}.0`])))
      .toMatchObject({ name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', transport: true })
  })
})

describe('createMandalaOverlayProvider: submit (C§6 framing and verdicts)', () => {
  const TOPIC = `tm_color_${ID}`
  const BEEF = [1, 2, 3, 4]
  const STEAK = { [TOPIC]: { outputsToAdmit: [0], coinsToRetain: [], admissionSignature: '30', admissionIdentityKey: K } }

  it('without off-chain values: bare BEEF, no x-includes-off-chain-values header; returns the parsed STEAK', async () => {
    for (const offChain of [undefined, []]) {
      const f = fakeFetch({ status: 200, body: STEAK })
      const steak = await provider(f).submit([TOPIC], BEEF, offChain)
      expect(steak).toEqual(STEAK)
      const { url, init } = f.calls[0]
      expect(url).toBe(`${URL_}/submit`)
      expect(init.method).toBe('POST')
      expect(init.headers['Content-Type']).toBe('application/octet-stream')
      expect(init.headers['X-Topics']).toBe(JSON.stringify([TOPIC]))
      expect(init.headers['x-includes-off-chain-values']).toBeUndefined()
      expect(Array.from(init.body as Uint8Array)).toEqual(BEEF)
    }
  })

  it('with off-chain values: header true and CompactSize(len(beef)) ‖ beef ‖ offChainValues', async () => {
    const f = fakeFetch({ status: 200, body: STEAK })
    await provider(f).submit([TOPIC], BEEF, [9])
    const { init } = f.calls[0]
    expect(init.headers['x-includes-off-chain-values']).toBe('true')
    expect(Array.from(init.body as Uint8Array)).toEqual([4, 1, 2, 3, 4, 9])
    // a BEEF of 253+ bytes takes the 0xfd varint form
    const big = Array.from({ length: 300 }, (_, i) => i & 0xff)
    const g = fakeFetch({ status: 200, body: STEAK })
    await provider(g).submit([TOPIC], big, [7, 8])
    expect(Array.from(g.calls[0].init.body as Uint8Array)).toEqual([0xfd, 0x2c, 0x01, ...big, 7, 8])
  })

  it('a typed 400 ⇒ (code, retryable false, transport false) with the exact message', async () => {
    const e = await caught(provider(fakeFetch({ status: 400, body: { status: 'error', code: 'ERR_CONSERVATION', retryable: false, description: 'd', message: 'm' } })).submit([TOPIC], BEEF))
    expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_CONSERVATION', retryable: false, transport: false })
    expect(e.message).toBe('[ColorProviderError] mandala overlay refused (ERR_CONSERVATION): d')
  })

  it('a typed 409 retryable verdict keeps retryable, is not transport, and is prefixed exactly once', async () => {
    const e = await caught(provider(fakeFetch({ status: 409, body: { status: 'error', code: 'ERR_FROZEN', retryable: true, description: 'asset frozen' } })).submit([TOPIC], BEEF))
    expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_FROZEN', retryable: true, transport: false })
    expect(e.message).toContain('(ERR_FROZEN, retryable)')
    expect(e.message.startsWith('[ColorProviderError] ')).toBe(true)
    expect(e.message.split('[ColorProviderError]').length).toBe(2)
  })

  it('a typed 410 eviction is a final verdict', async () => {
    expect(await caught(provider(fakeFetch({ status: 410, body: { status: 'error', code: 'ERR_EVICTED', retryable: false, description: 'gone' } })).submit([TOPIC], BEEF)))
      .toMatchObject({ code: 'ERR_EVICTED', retryable: false, transport: false })
  })

  it('5xx (typed or not), an untyped 4xx, a typed ERR_UNAVAILABLE, a fetch failure, a timeout and a non-JSON 200 are transport', async () => {
    const cases: Array<[Reply, number?]> = [
      [{ status: 503, body: { status: 'error', code: 'ERR_UNAVAILABLE', retryable: true, description: 'busy' } }],
      [{ status: 500, body: { status: 'error', code: 'ERR_CONSERVATION', retryable: false, description: 'x' } }],
      [{ status: 502, raw: 'Bad Gateway' }],
      [{ status: 404, raw: 'Not Found' }],
      [{ status: 400, body: { status: 'error', code: 'ERR_UNAVAILABLE', retryable: true, description: 'later' } }],
      ['throw'],
      ['hang', 10],
      [{ status: 200, raw: 'not json' }]
    ]
    for (const [reply, timeoutMs] of cases) {
      const e = await caught(provider(fakeFetch(reply), timeoutMs).submit([TOPIC], BEEF, [9]))
      expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_UNAVAILABLE', retryable: true, transport: true })
      expect(e.message.startsWith('[ColorProviderError] mandala overlay refused (ERR_UNAVAILABLE, retryable)')).toBe(true)
    }
  })

  it('an untyped JSON 4xx (request-level refusal) is a final refusal, not transport', async () => {
    const e = await caught(provider(fakeFetch({ status: 400, body: { status: 'error', message: 'invalid X-Topics header' } })).submit([TOPIC], BEEF))
    expect(e).toMatchObject({ name: 'ColorProviderError', code: 'ERR_REQUEST', retryable: false, transport: false })
    expect(e.message).toBe('[ColorProviderError] mandala overlay refused (ERR_REQUEST): invalid X-Topics header')
    // 408 and 429 are not verdicts
    for (const status of [408, 429]) {
      expect(await caught(provider(fakeFetch({ status, body: { status: 'error', message: 'slow down' } })).submit([TOPIC], BEEF)))
        .toMatchObject({ code: 'ERR_UNAVAILABLE', transport: true })
    }
  })

  it('a 200 whose JSON is not a STEAK object is a bad answer, not transport', async () => {
    for (const body of [[1, 2], null, 'x', { [TOPIC]: 5 }]) {
      expect(await caught(provider(fakeFetch({ status: 200, body })).submit([TOPIC], BEEF)))
        .toMatchObject({ name: 'ColorProviderError', code: 'ERR_INVALID_ANSWER', transport: false })
    }
  })

  it('refuses malformed arguments with TypeError before any fetch', async () => {
    const f = fakeFetch({ status: 200, body: STEAK })
    const p = provider(f)
    await expect(p.submit([], BEEF)).rejects.toThrow(TypeError)
    await expect(p.submit([7 as any], BEEF)).rejects.toThrow(TypeError)
    await expect(p.submit([TOPIC], [])).rejects.toThrow(TypeError)
    await expect(p.submit([TOPIC], [256])).rejects.toThrow(TypeError)
    await expect(p.submit([TOPIC], BEEF, [1.5])).rejects.toThrow(TypeError)
    expect(f.calls).toHaveLength(0)
  })
})

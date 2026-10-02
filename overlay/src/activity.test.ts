import { describe, it, expect } from 'vitest'
import { Transaction } from '@bsv/sdk'
import { Bsv21Binary } from '@bsv/templates'
import { summarizeTx, decodeFtOutputs, ActivityProof } from './activity.js'

const codec = new Bsv21Binary()
const PKH = new Array(20).fill(7)
const TID = 'ab'.repeat(32) + '_0'
const valueScript = (amt: bigint) => codec.lock(TID, amt, PKH)
const authorityScript = () => codec.lock(TID, 0n, PKH)
const deployScript = () => codec.lock(null, 0n, PKH)
const txHex = (scripts: Array<ReturnType<typeof valueScript>>) => {
  const tx = new Transaction()
  for (const lockingScript of scripts) tx.addOutput({ lockingScript, satoshis: 1 })
  return tx
}

const NO_PROOFS: ActivityProof[] = []
const base = { txid: 't1', when: '2026-07-07T00:00:00.000Z', proofs: NO_PROOFS }

const inp = (identityKey: string, amount: number) => ({ identityKey, amount, tokenId: TID, role: 'value' as const })
const out = (outputIndex: number, identityKey: string, amount: number) => ({ outputIndex, identityKey, amount, tokenId: TID, role: 'value' as const })

describe('summarizeTx', () => {
  it('classifies a mint (no FT inputs) as issue to the largest output', () => {
    const e = summarizeTx({ ...base, ftInputs: [], ftOutputs: [out(0, 'alice', 100)] })
    expect(e).toMatchObject({ kind: 'issue', from: null, to: 'alice', amount: 100, tokenId: TID })
  })

  it('classifies alice→bob with change back to alice as a transfer of the external amount', () => {
    const e = summarizeTx({
      ...base,
      ftInputs: [inp('alice', 100)],
      ftOutputs: [out(0, 'bob', 30), out(1, 'alice', 70)]
    })
    expect(e).toMatchObject({ kind: 'transfer', from: 'alice', to: 'bob', amount: 30 })
  })

  it('classifies alice→alice (all outputs self, conserved) as a 0-unit self transfer', () => {
    const e = summarizeTx({
      ...base,
      ftInputs: [inp('alice', 100)],
      ftOutputs: [out(0, 'alice', 40), out(1, 'alice', 60)]
    })
    expect(e).toMatchObject({ kind: 'self', from: 'alice', to: 'alice', amount: 0 })
  })

  it('classifies a burn (in > out, all change to self) as redeem of the difference', () => {
    const e = summarizeTx({
      ...base,
      ftInputs: [inp('alice', 100)],
      ftOutputs: [out(0, 'alice', 25)]
    })
    expect(e).toMatchObject({ kind: 'redeem', from: 'alice', to: null, amount: 75 })
  })

  it('classifies a full burn (no outputs) as redeem of the whole input', () => {
    const e = summarizeTx({ ...base, ftInputs: [inp('alice', 100)], ftOutputs: [] })
    expect(e).toMatchObject({ kind: 'redeem', from: 'alice', to: null, amount: 100 })
  })

  it('returns null for a tx with no FT movement at all', () => {
    expect(summarizeTx({ ...base, ftInputs: [], ftOutputs: [] })).toBeNull()
  })

  it('sums multiple external outputs and picks the largest as the recipient', () => {
    const e = summarizeTx({
      ...base,
      ftInputs: [inp('alice', 100)],
      ftOutputs: [out(0, 'bob', 10), out(1, 'carol', 50), out(2, 'alice', 40)]
    })
    expect(e).toMatchObject({ kind: 'transfer', to: 'carol', amount: 60 })
  })

  it('ignores unknown-owner outputs when deciding transfer vs self', () => {
    // Output with no verified linkage ('' identity) is not treated as an
    // external recipient — in=out and every known output is the sender's.
    const e = summarizeTx({
      ...base,
      ftInputs: [inp('alice', 100)],
      ftOutputs: [out(0, '', 30), out(1, 'alice', 70)]
    })
    expect(e).toMatchObject({ kind: 'self', amount: 0 })
  })
})

// ---------------------------------------------------------------------------
// buildActivity pagination — complete-group guarantee at page boundaries
// ---------------------------------------------------------------------------
import { buildActivity, LinkageRowLite, ActivityDeps } from './activity.js'

const link = (txid: string, outputIndex: number, identityKey: string, createdAt: string): LinkageRowLite => ({
  txid,
  outputIndex,
  identityKey,
  linkage: { prover: identityKey, verifier: 'v', counterparty: identityKey, keyID: `k-${txid}-${outputIndex}`, proofType: 1 },
  createdAt
})

/** Deps with no raw txs — groups become entries only if raw exists; here we
 *  only exercise the paging/grouping layer, so raw txs are irrelevant and
 *  every group is skipped, but the cursor math still runs. */
function pagingDeps (rows: LinkageRowLite[]): ActivityDeps {
  return {
    listLinkage: async (limit, before) => {
      let r = rows
      if (before != null) r = r.filter(x => new Date(x.createdAt).getTime() <= new Date(before).getTime())
      return r.slice(0, limit)
    },
    findLinkageByOutpoints: async () => [],
    findRawTxs: async () => new Map()
  }
}

describe('BRC-162 decoding', () => {
  it('ignores authority outputs when classifying value movement', () => {
    const auth = { outputIndex: 1, identityKey: 'bob', tokenId: TID, amount: 0, role: 'authority' as const }
    expect(summarizeTx({ ...base, ftInputs: [], ftOutputs: [auth] })).toBeNull()
    const e = summarizeTx({ ...base, ftInputs: [inp('alice', 100)], ftOutputs: [out(0, 'alice', 100), auth] })
    expect(e).toMatchObject({ kind: 'self', amount: 0 })
  })

  it('labels a deploy output with the tx own _0 id', () => {
    const tx = txHex([deployScript()])
    const [o] = decodeFtOutputs(tx.toHex(), new Map())
    expect(o).toMatchObject({ role: 'deploy', tokenId: `${tx.id('hex')}_0`, amount: 0 })
  })

  it('decodes value and authority roles with the token id string', () => {
    const outs = decodeFtOutputs(txHex([valueScript(5n), authorityScript()]).toHex(), new Map([[0, 'alice']]))
    expect(outs).toMatchObject([
      { outputIndex: 0, identityKey: 'alice', tokenId: TID, amount: 5, role: 'value' },
      { outputIndex: 1, tokenId: TID, amount: 0, role: 'authority' }
    ])
  })

  it('skips non-token, malformed token-shaped, and over-2^53 outputs without throwing', () => {
    const malformed = codec.lock(TID, 1n, PKH)
    malformed.chunks[0] = { op: 5, data: [1, 2, 3, 4, 5] } // not a 32-byte id
    const big = valueScript(2n ** 60n)
    const plain = new (Object.getPrototypeOf(malformed).constructor)([{ op: 0x76 }])
    const outs = decodeFtOutputs(txHex([plain, malformed, big, valueScript(1n)]).toHex(), new Map())
    expect(outs.map(o => o.outputIndex)).toEqual([3])
  })
})

describe('buildActivity pagination', () => {
  it('returns a null cursor when everything fits in one page', async () => {
    const rows = [link('t1', 0, 'a', '2026-07-07T10:00:00.000Z'), link('t2', 0, 'a', '2026-07-07T09:00:00.000Z')]
    const page = await buildActivity(pagingDeps(rows), { limit: 100 })
    expect(page.nextCursor).toBeNull()
  })

  it('drops the boundary-straddling group and points the cursor at it (inclusive)', async () => {
    // 10 single-output txs, newest first; page limit 2 → fetches 2+overlap rows,
    // sees more exist, drops the oldest fetched group and cursors to it.
    const rows = Array.from({ length: 20 }, (_, i) =>
      link(`t${i}`, 0, 'a', new Date(Date.UTC(2026, 6, 7, 10, 0, 59 - i)).toISOString()))
    const page = await buildActivity(pagingDeps(rows), { limit: 2 })
    expect(page.nextCursor).not.toBeNull()
    // Cursor is the createdAt of a fetched row — inclusive re-fetch re-serves
    // that row's whole tx group on the next page.
    expect(rows.some(r => new Date(r.createdAt).toISOString() === page.nextCursor)).toBe(true)
  })

  it('still cursors past a max-split transfer at limit 1 (9 linkage rows in one tx)', async () => {
    // A transfer writes up to 9 output-linkage rows (recipient + 8 split
    // change). The overlap must cover a whole such group, or a limit-1 page
    // whose newest tx is a max-split transfer fills the entire fetch window
    // with one txid and pagination dies (hasMore true, but byTx.size === 1).
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => link('big', i, 'a', '2026-07-07T10:00:00.000Z')),
      link('older', 0, 'a', '2026-07-07T09:00:00.000Z'),
      link('oldest', 0, 'a', '2026-07-07T08:00:00.000Z')
    ]
    const page = await buildActivity(pagingDeps(rows), { limit: 1 })
    expect(page.nextCursor).not.toBeNull()
  })

  it('clamps limit into [1, 500]', async () => {
    let requested = 0
    const deps: ActivityDeps = {
      listLinkage: async (limit) => { requested = limit; return [] },
      findLinkageByOutpoints: async () => [],
      findRawTxs: async () => new Map()
    }
    await buildActivity(deps, { limit: 99999 })
    expect(requested).toBeLessThanOrEqual(509) // 500 + overlap
    await buildActivity(deps, { limit: 0 })
    expect(requested).toBeGreaterThanOrEqual(10) // 1 + overlap
  })
})

describe('buildActivity tokenId filter', () => {
  it('returns only entries for the requested token', async () => {
    const OTHER = 'cd'.repeat(32) + '_0'
    const mk = (id: string) => txHex([codec.lock(id, 9n, PKH)])
    const a = mk(TID); const b = mk(OTHER)
    const raws = new Map([[a.id('hex'), a.toHex()], [b.id('hex'), b.toHex()]])
    const deps: ActivityDeps = {
      listLinkage: async () => [link(a.id('hex'), 0, 'alice', '2026-07-07T10:00:00.000Z'), link(b.id('hex'), 0, 'alice', '2026-07-07T09:00:00.000Z')],
      findLinkageByOutpoints: async () => [],
      findRawTxs: async () => raws
    }
    expect((await buildActivity(deps, {})).entries).toHaveLength(2)
    const page = await buildActivity(deps, { tokenId: OTHER })
    expect(page.entries.map(e => e.tokenId)).toEqual([OTHER])
  })
})

import type { EngineOutputReader } from '@bsv/overlay-topics'
import type { KnexLike } from './spentGuard.js'

// The host side of the package's §4.2a repair and reconciler: the engine's own
// admitted outputs, read from KnexStorage's `outputs` table. A spent output reads
// as null (package contract), and an unreadable `spent` throws rather than
// guessing (§9.5): a guess either way repairs a row for a coin that is gone or
// hides a live one.

const spentOf = (raw: unknown): boolean => {
  if (typeof raw === 'boolean') return raw
  const n = typeof raw === 'bigint' ? Number(raw) : raw
  if (n === 0 || n === 1) return n === 1
  throw new Error(`outputs.spent has an unexpected value of type ${raw === null ? 'null' : typeof raw}`)
}

const bytesOf = (raw: unknown): number[] => {
  if (raw instanceof Uint8Array) return Array.from(raw)
  if (Array.isArray(raw)) return raw as number[]
  throw new Error('outputs.outputScript is not binary')
}

export const knexEngineOutputs = (knex: KnexLike): EngineOutputReader => ({
  findAdmittedOutput: async (txid, outputIndex, topic) => {
    const row = await knex('outputs').where({ txid, outputIndex, topic }).first('outputScript', 'satoshis', 'spent')
    if (row == null || spentOf(row.spent)) return null
    return { lockingScript: bytesOf(row.outputScript), satoshis: Number(row.satoshis) }
  },
  listUnspentAdmittedOutputs: async (topic, after, limit) => {
    const q = knex('outputs').where({ topic, spent: false })
    if (after != null) {
      q.andWhere((w: any) => w.where('txid', '>', after.txid)
        .orWhere((x: any) => x.where('txid', after.txid).andWhere('outputIndex', '>', after.outputIndex)))
    }
    const rows = await q.orderBy([{ column: 'txid' }, { column: 'outputIndex' }]).limit(limit).select('txid', 'outputIndex')
    return rows.map((r: any) => ({ txid: String(r.txid), outputIndex: Number(r.outputIndex) }))
  }
})

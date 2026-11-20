/**
 * The Mandala provider's host-ledger spendability (design §9 B7, offline
 * parity with @bsv/mandala 0.4.1).
 *
 * The B7 color module checks every token input of a hand-over with the
 * asset's provider `spendability()` at createAction and signAction, and never
 * resubmits outputs of a plain-noSend asset. Without help, an offline wallet
 * could not hand over a coin, and a coin received or kept offline (pending)
 * could never fund the next hand-over until the overlay admitted it. So the
 * Mandala provider answers from the host ledger as well:
 *
 * - overlay reachable: everything it lists, plus outpoints of `pending`
 *   ledger records (verified-offline receipts after COVER, own hand-over
 *   change), which the overlay cannot list before it admits them. A `settled`
 *   record defers to the overlay (spent, frozen or reissued coins drop out);
 * - overlay unreachable (a transport failure only): outpoints of `pending`
 *   and `settled` ledger records; anything else is absent, so the module
 *   refuses it (fail closed). A typed overlay refusal is never masked.
 *
 * A `refused` record never counts. Only the host writes the ledger, so an
 * application cannot make anything spendable through it.
 *
 * Deploy admission (`admission(assetId, ['<txid>.<vout>'])` of the asset's own
 * deploy outpoint): the real B7 module resolves an asset it has not cached by
 * asking its providers for the deploy, which fails while the overlay is
 * unreachable, so a first offline receipt of an asset could never be
 * credited. On a transport failure only, the provider answers that one
 * outpoint from the deploy bytes carried in a ledger record's BEEF of the
 * same asset (every hand-over's AtomicBEEF carries its ancestry down to the
 * deploy). The module checks the bytes against the asset id's txid, so only
 * the asset's genuine deploy can be served; any other outpoint stays absent.
 */
import { Beef } from '@bsv/sdk'
import type { ColorOverlayProvider } from '@bsv/color-permission-module'
import type { HostLedger } from './hostLedger.js'
import type { MandalaOverlayProvider } from './profileProvider.js'

const OUTPOINT_RE = /^([0-9a-f]{64})\.(0|[1-9][0-9]{0,9})$/

function isTransport (e: unknown): boolean {
  const err = e as { name?: unknown, transport?: unknown, message?: unknown } | null
  if (err == null || typeof err !== 'object') return false
  const named = err.name === 'ColorProviderError' || (typeof err.message === 'string' && err.message.startsWith('[ColorProviderError] '))
  return named && err.transport === true
}

/** `base` with ledger-backed spendability; the same url/identityKey and other methods. */
export function withLedgerSpendability (base: MandalaOverlayProvider, ledger: HostLedger): MandalaOverlayProvider {
  const spendability: ColorOverlayProvider['spendability'] = async (assetId, outpoints) => {
    let listed: any
    let reachable = true
    try {
      listed = await base.spendability(assetId, outpoints)
    } catch (e) {
      if (!isTransport(e)) throw e
      reachable = false
    }
    const outputs: any[] = reachable && Array.isArray(listed?.outputs) ? [...listed.outputs] : []
    const have = new Set(outputs.map(o => `${String(o?.txid)}.${String(o?.outputIndex)}`))
    for (const op of Array.isArray(outpoints) ? outpoints : []) {
      if (have.has(op)) continue
      const m = OUTPOINT_RE.exec(op)
      if (m == null) continue
      const rec = await ledger.get(m[1])
      const vout = Number(m[2])
      if (rec == null || rec.assetId !== assetId || !rec.outputs.includes(vout) || rec.beefHex == null) continue
      const counts = rec.state === 'pending' || (!reachable && rec.state === 'settled')
      if (!counts) continue
      outputs.push({ beef: hexToBytes(rec.beefHex), outputIndex: vout, txid: rec.txid })
      have.add(op)
    }
    return { type: 'output-list', outputs } as any
  }
  const admission: ColorOverlayProvider['admission'] = async (assetId, outpoints) => {
    try {
      return await base.admission(assetId, outpoints)
    } catch (e) {
      if (!isTransport(e)) throw e
      const deploy = await ledgerDeploy(assetId, outpoints)
      if (deploy == null) throw e
      return deploy
    }
  }

  /** The asset's deploy from a ledger record's BEEF, when exactly its deploy outpoint is asked. */
  const ledgerDeploy = async (assetId: string, outpoints: string[]): Promise<any> => {
    const m = /^([0-9a-f]{64})_(0|[1-9][0-9]{0,9})$/.exec(typeof assetId === 'string' ? assetId : '')
    if (m == null || !Array.isArray(outpoints) || outpoints.length !== 1 || outpoints[0] !== `${m[1]}.${m[2]}`) return undefined
    for (const rec of await ledger.list()) {
      if (rec.assetId !== assetId || rec.state === 'refused') continue
      for (const hex of [rec.beefHex, ...(rec.submits ?? []).map(s => s.beefHex)]) {
        if (hex == null) continue
        try {
          const found = Beef.fromBinary(hexToBytes(hex)).findTxid(m[1])
          if (found?.tx == null) continue
          const beef = new Beef()
          beef.mergeTransaction(found.tx)
          return { type: 'output-list', outputs: [{ beef: beef.toBinary(), outputIndex: Number(m[2]), txid: m[1] }] }
        } catch { /* unreadable bytes: try the next record */ }
      }
    }
    return undefined
  }
  return Object.freeze({ ...base, url: base.url, identityKey: base.identityKey, spendability, admission })
}

function hexToBytes (hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

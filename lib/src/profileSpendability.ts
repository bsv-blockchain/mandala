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
 */
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
  return Object.freeze({ ...base, url: base.url, identityKey: base.identityKey, spendability })
}

function hexToBytes (hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16))
  return out
}

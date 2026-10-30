/**
 * Settlement of offline-credited receipts (design §9 B7): the recipient host
 * submits every `pending` ledger chain (parents first, tip last, the exact
 * stored AtomicBEEF and envelope bytes) once it is online, verifies the tip's
 * σ under K covering the credited outputs, records `settled`, and then calls
 * the host's `markSettled(txid)` so the color module clears `color_offline`.
 *
 * Outcomes per record: admitted (settled, marked), retry (transport or a
 * retryable verdict: attempts + 1, nothing else changes), refused (a final
 * verdict: the record becomes `refused` with the code; the host surfaces it —
 * the coin stays `color_offline` in the module, which has no un-credit API).
 *
 * Stability: one pass at a time across tabs (`mandala.receipts` lock); every
 * submit is idempotent on the overlay; the ledger merge never downgrades; a
 * crash between the `settled` write and `markSettled` leaves `marked: false`,
 * which the next pass completes (markSettled is idempotent).
 */
import { Transaction, Utils } from '@bsv/sdk'
import { OVERLAY_IDENTITY_KEY, OVERLAY_IDENTITY_KEY_UNSET } from './constants.js'
import { verifyAttestation, type Attestation } from './attestation.js'
import type { HostLedger, LedgerRecord } from './hostLedger.js'
import { colorTopic } from './naming.js'
import { OverlayRefusedError, submitToOverlay } from './overlay.js'
import { tryWithLock } from './webLocks.js'

export interface ReceiptSettleResult {
  txid: string
  assetId: string
  status: 'admitted' | 'retry' | 'refused'
  code?: string
}

const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/
const FINAL = new Set(['ERR_CONSERVATION', 'ERR_LINKAGE', 'ERR_SHAPE', 'ERR_SATOSHIS', 'ERR_INPUT_SPENT', 'ERR_EVICTED', 'ERR_AUTHORITY'])

/** A verdict that never lifts (the overlay persists it for these bytes). */
function finalCode (e: unknown): string | undefined {
  const err = e as { name?: unknown, code?: unknown, retryable?: unknown } | null
  if (err == null || typeof err !== 'object') return undefined
  if (!(e instanceof OverlayRefusedError) && err.name !== 'OverlayRefusedError') return undefined
  return typeof err.code === 'string' && err.retryable !== true && FINAL.has(err.code) ? err.code : undefined
}

async function settleOne (ledger: HostLedger, r: LedgerRecord, K: string, markSettled?: (txid: string) => Promise<void>): Promise<ReceiptSettleResult> {
  const base = { txid: r.txid, assetId: r.assetId }
  if (r.state === 'settled') {
    // Only an unmarked record reaches here: finish the markSettled.
    if (markSettled == null) return { ...base, status: 'admitted' }
    await markSettled(r.txid)
    await ledger.put({ ...r, marked: true, at: Date.now() })
    return { ...base, status: 'admitted' }
  }
  const submits = r.submits ?? []
  if (submits.length === 0 || submits[submits.length - 1].txid !== r.txid) {
    return { ...base, status: 'retry', code: 'ERR_NO_CHAIN' }
  }
  let tipAttestation: Attestation | undefined
  try {
    for (const s of submits) {
      const beef = Utils.toArray(s.beefHex, 'hex')
      // Stale bytes never go out under a txid they do not hash to.
      if (Transaction.fromAtomicBEEF(beef).id('hex') !== s.txid) throw new Error(`stored bytes for ${s.txid} do not hash to it`)
      const admitted = await submitToOverlay(beef, Utils.toArray(s.offChainHex, 'hex'), undefined, [colorTopic(r.assetId)], K)
      if (s.txid === r.txid) tipAttestation = admitted.attestation
    }
  } catch (e) {
    const code = finalCode(e)
    if (code != null) {
      await ledger.put({ ...r, state: 'refused', code, at: Date.now() })
      return { ...base, status: 'refused', code }
    }
    const c = (e as { code?: unknown })?.code
    await ledger.put({ ...r, attempts: (r.attempts ?? 0) + 1, ...(typeof c === 'string' ? { code: c } : {}), at: Date.now() })
    return { ...base, status: 'retry', ...(typeof c === 'string' ? { code: c } : {}) }
  }
  const a = tipAttestation
  if (a == null || a.txid !== r.txid || !verifyAttestation(a, r.assetId, K) || !r.outputs.every(o => a.outputs.includes(o))) {
    await ledger.put({ ...r, attempts: (r.attempts ?? 0) + 1, code: 'ERR_NOT_ADMITTED', at: Date.now() })
    return { ...base, status: 'retry', code: 'ERR_NOT_ADMITTED' }
  }
  const settled = await ledger.put({ v: 1, txid: r.txid, assetId: r.assetId, state: 'settled', outputs: r.outputs, attestation: a, marked: false, at: Date.now() })
  if (markSettled != null) {
    await markSettled(r.txid)
    await ledger.put({ ...settled, marked: true, at: Date.now() })
  }
  return { ...base, status: 'admitted' }
}

/**
 * Settle every pending (and every settled-but-unmarked) ledger record. Never
 * throws for an overlay outcome; throws `OVERLAY_IDENTITY_KEY_UNSET` (S5)
 * before any submit. A concurrent pass in another tab returns `[]`.
 */
export async function settleReceipts (p: {
  ledger: HostLedger
  /** Host-only `color.markSettled(txid)`. */
  markSettled?: (txid: string) => Promise<void>
  overlayIdentityKey?: string
  /** Settle only these txids. */
  txids?: string[]
}): Promise<ReceiptSettleResult[]> {
  const K = p.overlayIdentityKey ?? OVERLAY_IDENTITY_KEY
  if (typeof K !== 'string' || !COMPRESSED_KEY.test(K)) throw new Error(OVERLAY_IDENTITY_KEY_UNSET)
  const { acquired, result } = await tryWithLock('mandala.receipts', async () => {
    const out: ReceiptSettleResult[] = []
    const only = p.txids != null ? new Set(p.txids) : undefined
    for (const r of await p.ledger.list()) {
      if (only != null && !only.has(r.txid)) continue
      // An own hand-over is never SUBMITTED here (only after the recipient's
      // ACK, by settleHandover); an own record that is settled but unmarked
      // (markSettled failed, or reconcile settled it without one) is marked.
      const unmarked = r.state === 'settled' && r.marked === false
      if (r.own === true && !unmarked) continue
      const due = r.state === 'pending' || unmarked
      if (!due) continue
      try {
        out.push(await settleOne(p.ledger, r, K, p.markSettled))
      } catch (e) {
        console.warn(`[mandala] settling receipt ${r.txid} failed; the next pass retries it:`, e)
        out.push({ txid: r.txid, assetId: r.assetId, status: 'retry' })
      }
    }
    return out
  })
  return acquired && result != null ? result : []
}

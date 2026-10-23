/**
 * The Mandala host ledger (design §9 B7): the in-process, host-side record of
 * what this wallet host has verified about Mandala token transactions.
 *
 * Who may write it: only the wallet host runtime (the process that owns the
 * underlying wallet and the color module) and the Mandala issuer-v1 handler
 * it constructed with the same object. It is never exposed over BRC-100: an
 * app cannot reach it, so an app cannot make the handler credit anything. The
 * host builds it once (`createHostLedger(storage)`) and passes the same object
 * to `createMandalaProfile({ ledger })`, `receiveHandovers({ ledger })`,
 * `settleReceipts({ ledger })` and `sendHandover({ ledger })`.
 *
 * Records, one per txid:
 * - `settled`: a σ by K over the txid was verified by this host. For a
 *   received tip, `outputs` are the receipt outputs it covers.
 * - `pending`: COVER (with the S1 hop checks) accepted the tip offline. The
 *   exact submit chain (parents first, tip last, AtomicBEEF + envelope) is
 *   kept so the host can settle it later.
 * - `refused`: a pending chain met a final overlay verdict. Kept, never
 *   credited again; the host surfaces it.
 *
 * Own hand-overs are recorded too: `pending` at signing (its change and any
 * self output in `outputs`, the exact submit bytes in `submits`), `settled`
 * after the post-ACK submit returns σ, `refused` on a final verdict. The
 * Mandala provider answers `spendability` from these records when the
 * overlay is unreachable or has not admitted yet, so chained offline
 * hand-overs keep working (profile.ts).
 *
 * Stability:
 * - Every write is a single atomic `setItem` of the whole record. `put` merges
 *   with what is stored (outputs union; `settled` never downgrades; `refused`
 *   never upgrades to pending) so a retried or concurrent writer converges.
 * - `marked` records whether the host's `markSettled(txid)` has run for a
 *   settled record that was once pending (crash between the two writes ⇒ the
 *   next settle pass calls it again; `markSettled` is idempotent).
 * - A corrupt record reads as absent (the handler then submits itself and
 *   requires admission: fail closed).
 */
import type { Attestation } from './attestation.js'
import type { MandalaStorage } from './storage.js'

export type LedgerState = 'settled' | 'pending' | 'refused'

/** One unadmitted transaction of an offline chain, exactly as it will be submitted. */
export interface LedgerSubmit {
  txid: string
  /** AtomicBEEF of this transaction, hex. */
  beefHex: string
  /** The Mandala envelope (offChainValues), hex. */
  offChainHex: string
}

export interface LedgerRecord {
  v: 1
  txid: string
  assetId: string
  state: LedgerState
  /** 'own': this host's own hand-over (submitted only after the recipient's ACK, never by settleReceipts). */
  own?: true
  /** Receipt outputs of this tx credited by this host (empty for an own hand-over). */
  outputs: number[]
  /** The verified σ by K (settled). */
  attestation?: Attestation
  /** Pending: the chain to submit, parents first, tip last. */
  submits?: LedgerSubmit[]
  /** AtomicBEEF of this txid, hex (served by the provider's offline spendability answer). */
  beefHex?: string
  /** Pending receipts: the verified ancestor σ that ended COVER, forwarded by an onward hand-over. */
  evidence?: Attestation[]
  /** Settled after pending: whether `markSettled(txid)` has completed. */
  marked?: boolean
  attempts?: number
  /** Last overlay code (retry diagnostics or the final refusal). */
  code?: string
  at: number
}

export interface HostLedger {
  get: (txid: string) => Promise<LedgerRecord | undefined>
  /** Merge-write (see module doc). Throws when the store write fails: callers must not credit on a failed write. */
  put: (record: LedgerRecord) => Promise<LedgerRecord>
  list: () => Promise<LedgerRecord[]>
}

const TXID = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})+$/
const RECORD = 'mandala.host.v1.record.'

function isRecord (v: unknown): v is LedgerRecord {
  const r = v as Partial<LedgerRecord> | null
  return r != null && typeof r === 'object' && r.v === 1 &&
    typeof r.txid === 'string' && TXID.test(r.txid) && typeof r.assetId === 'string' &&
    (r.state === 'settled' || r.state === 'pending' || r.state === 'refused') &&
    Array.isArray(r.outputs) && r.outputs.every(o => Number.isInteger(o) && o >= 0) &&
    (r.beefHex == null || (typeof r.beefHex === 'string' && HEX.test(r.beefHex))) &&
    (r.submits == null || (Array.isArray(r.submits) && r.submits.every(s =>
      s != null && typeof s.txid === 'string' && TXID.test(s.txid) &&
      typeof s.beefHex === 'string' && HEX.test(s.beefHex) && typeof s.offChainHex === 'string' && HEX.test(s.offChainHex))))
}

const RANK: Record<LedgerState, number> = { pending: 0, refused: 1, settled: 2 }

/** The merge rule: never downgrade, union outputs, keep the newest evidence. */
export function mergeRecord (prev: LedgerRecord | undefined, next: LedgerRecord): LedgerRecord {
  if (prev == null) return next
  if (prev.assetId !== next.assetId) throw new Error(`@bsv/mandala: ledger record ${next.txid} names another asset`)
  const state = RANK[next.state] >= RANK[prev.state] ? next.state : prev.state
  const outputs = [...new Set([...prev.outputs, ...next.outputs])].sort((a, b) => a - b)
  const merged: LedgerRecord = {
    ...prev,
    ...next,
    state,
    outputs,
    attestation: next.attestation ?? prev.attestation,
    submits: next.submits ?? prev.submits,
    beefHex: next.beefHex ?? prev.beefHex,
    evidence: next.evidence ?? prev.evidence,
    at: next.at
  }
  // A record that was ever pending owes a markSettled once settled.
  if (state === 'settled') {
    merged.marked = prev.state === 'pending' ? next.marked === true : (next.marked ?? prev.marked ?? true)
  }
  if (merged.attestation === undefined) delete merged.attestation
  if (merged.submits === undefined) delete merged.submits
  if (merged.beefHex === undefined) delete merged.beefHex
  if (merged.evidence === undefined) delete merged.evidence
  return merged
}

/** Build the host ledger over a host-owned store (never the app's storage). */
export function createHostLedger (storage: MandalaStorage): HostLedger {
  if (storage == null || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' ||
    typeof storage.removeItem !== 'function' || typeof storage.keys !== 'function') {
    throw new TypeError('@bsv/mandala: createHostLedger needs a MandalaStorage')
  }
  const read = async (txid: string): Promise<LedgerRecord | undefined> => {
    try {
      const raw = await storage.getItem(RECORD + txid)
      if (raw == null) return undefined
      const r = JSON.parse(raw) as unknown
      return isRecord(r) && r.txid === txid ? r : undefined
    } catch {
      return undefined
    }
  }
  return {
    get: async txid => (typeof txid === 'string' && TXID.test(txid) ? await read(txid) : undefined),
    put: async record => {
      if (!isRecord(record)) throw new TypeError('@bsv/mandala: malformed ledger record')
      const merged = mergeRecord(await read(record.txid), record)
      await storage.setItem(RECORD + record.txid, JSON.stringify(merged))
      return merged
    },
    list: async () => {
      const out: LedgerRecord[] = []
      for (const key of await storage.keys(RECORD)) {
        const r = await read(key.slice(RECORD.length))
        if (r != null) out.push(r)
      }
      return out.sort((a, b) => a.at - b.at)
    }
  }
}

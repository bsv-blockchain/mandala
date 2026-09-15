/**
 * Re-attach a live registry-auth UTXO the overlay already admitted but this
 * wallet no longer lists (plain 1-sat P2PKH loses basket CI after refresh).
 */
import { Beef, Transaction, Utils, WalletInterface } from '@bsv/sdk'
import { BASKET, OVERLAY_URL, OVERLAY_URL_UNSET } from './constants.js'
import {
  fetchRegistry,
  listRegistryAuth,
  reconstructRegistryDetails,
  registryCustomInstructions,
  OverlayRegistryRow,
  RegistryAuth
} from './registry.js'
import { INTENT_TTL_MS, journalList } from './txJournal.js'

function asBytes (v: unknown): number[] | null {
  if (Array.isArray(v) && v.every(n => typeof n === 'number')) return v as number[]
  if (typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
    return Utils.toArray(v, 'hex')
  }
  if (v != null && typeof v === 'object' && Array.isArray((v as { data?: unknown }).data)) {
    const data = (v as { data: unknown[] }).data
    if (data.every(n => typeof n === 'number')) return data as number[]
  }
  return null
}

async function fetchHex (txid: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
    if (!res.ok) return null
    const hex = (await res.text()).trim()
    return /^[0-9a-fA-F]+$/.test(hex) ? hex : null
  } catch {
    return null
  }
}

export async function beefFromWhatsOnChain (txid: string): Promise<number[] | null> {
  const hex = await fetchHex(txid)
  if (hex == null) return null
  const tx = Transaction.fromHex(hex)
  for (const input of tx.inputs) {
    const src = input.sourceTXID
    if (src == null || src === '') continue
    const parent = await fetchHex(src)
    if (parent == null) continue
    input.sourceTransaction = Transaction.fromHex(parent)
  }
  return tx.toBEEF()
}

export async function fetchRegistryBeef (txid: string, outputIndex: number): Promise<number[] | null> {
  // Outside the try: an unconfigured overlay must not read as "no BEEF".
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  try {
    const res = await fetch(`${OVERLAY_URL}/admin/registry/beef/${txid}?vout=${outputIndex}`)
    if (res.ok) {
      const body = await res.json() as { beef?: unknown, beefHex?: unknown }
      const fromOverlay = asBytes(body.beef) ?? (typeof body.beefHex === 'string' ? asBytes(body.beefHex) : null)
      if (fromOverlay != null && fromOverlay.length > 0) return fromOverlay
    }
  } catch { /* fall through to chain */ }
  return await beefFromWhatsOnChain(txid)
}

/**
 * Pick the live head of the registration chain.
 *
 * Rows arrive newest-first by `admitSeq` and are keyed by the identity each
 * action TARGETS, not by who signed it. The issuer's own row therefore keeps
 * pointing at the genesis outpoint for the life of the chain, so preferring it
 * hands back an outpoint that was spent by the first peer admit. The head is
 * simply the newest row that names a transaction — a revoke link is the head
 * just as much as an admit.
 */
export function pickRecoverableRegistryRow (
  rows: OverlayRegistryRow[]
): OverlayRegistryRow | null {
  let head: OverlayRegistryRow | null = null
  for (const r of rows) {
    if (r.txid === '') continue
    if (head == null || r.admitSeq > head.admitSeq) head = r
  }
  return head
}

/** True when `beef` (BEEF or AtomicBEEF) contains the tx we need to spend. */
export function beefContainsTxid (beef: number[], txid: string): boolean {
  try {
    return Beef.fromBinary(beef).findTxid(txid) != null
  } catch {
    try {
      return Transaction.fromBEEF(beef).id('hex') === txid
    } catch {
      return false
    }
  }
}

/** Wallet createAction inputBEEF wants a BEEF graph, not AtomicBEEF-of-subject. */
export function toSpendingBeef (beef: number[], txid: string): number[] {
  const b = Beef.fromBinary(beef)
  if (b.findTxid(txid) == null) throw new Error(`BEEF does not contain ${txid}`)
  return b.toBinary()
}

function parseOutpoint (authOutpoint: string): { txid: string, vout: number } {
  const [txid, voutStr] = authOutpoint.split('.')
  if (txid == null || txid === '') throw new Error(`bad registry auth outpoint ${authOutpoint}`)
  return { txid, vout: Number(voutStr ?? 0) }
}

/**
 * BEEF for the live identity-admin tx ONLY (plus its parents).
 * Do not merge the mandala-tokens basket: that graph can include a previous
 * noSend that already spends this outpoint, and createAction then errors
 * "already consumed by this action batch".
 */
export async function loadRegistryInputBeef (
  _wallet: WalletInterface,
  authOutpoint: string
): Promise<number[]> {
  const { txid, vout } = parseOutpoint(authOutpoint)
  const fetched = await fetchRegistryBeef(txid, vout)
  if (fetched == null || fetched.length === 0 || !beefContainsTxid(fetched, txid)) {
    throw new Error(`no BEEF for registry auth ${authOutpoint} — re-attach the identity chain`)
  }
  return toSpendingBeef(fetched, txid)
}

const SPEC_OP_NOSEND_ACTIONS = 'ac6b20a3bb320adafecd637b25c84b792ad828d3aa510d05dc841481f664277d'

/**
 * Journal stages whose action MUST NOT be aborted (§9.11):
 * - 'accepted'/'stranded' — the overlay has already folded the tx into its
 *   state; aborting desyncs wallet from overlay and burns a committed payment.
 * - 'retryable' — the overlay refused with a liftable condition and the inputs
 *   are held ON PURPOSE so the identical bytes can be re-submitted.
 */
const PROTECTED_STAGES = new Set(['accepted', 'retryable', 'stranded'])

/** An action's creation time, when the wallet reports one (ms since epoch). */
function actionCreatedAt (a: unknown): number | undefined {
  const raw = (a as { createdAt?: unknown, created_at?: unknown })?.createdAt ??
    (a as { created_at?: unknown })?.created_at
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'string') {
    const t = Date.parse(raw)
    return Number.isNaN(t) ? undefined : t
  }
  return undefined
}

/**
 * Release a prior noSend that already reserved the live identity-admin outpoint.
 *
 * This runs immediately before `createAction` in `admitOrRevokeIdentity`, so it
 * is aiming at *abandoned* reservations. Two guards keep it off live ones
 * (§9.11 — the review found it aborting an overlay-accepted, broadcast-pending
 * registry action, which destroys a transaction the overlay has committed to):
 *
 * 1. Any action whose reference or txid appears in the tx journal under a
 *    protected stage is skipped — and while ANY such entry exists the
 *    indiscriminate server-side bulk abort is skipped too, because it cannot
 *    take exceptions. (A journal read that fails skips everything: not knowing
 *    what is live is not a licence to abort.)
 * 2. An action the wallet timestamps is only aborted once it is older than
 *    INTENT_TTL_MS — the same clock the reconcile sweep uses to tell a live
 *    pipeline from a crashed one. A wallet that reports no timestamp keeps the
 *    previous behaviour; guard 1 still covers the committed cases.
 */
export async function abortStuckRegistryActions (
  wallet: WalletInterface,
  now: number = Date.now()
): Promise<void> {
  const protectedRefs = new Set<string>()
  const protectedTxids = new Set<string>()
  try {
    for (const e of await journalList()) {
      if (!PROTECTED_STAGES.has(e.stage)) continue
      protectedTxids.add(e.txid)
      if (e.reference != null && e.reference !== '') protectedRefs.add(e.reference)
    }
  } catch (e) {
    console.warn('[mandala] registry recovery could not read the tx journal; not aborting anything:', e)
    return
  }

  if (protectedTxids.size === 0) {
    // The spec-op bulk abort is all-or-nothing, so it may only run when the
    // journal says nothing is live.
    try {
      await wallet.listActions({
        labels: [SPEC_OP_NOSEND_ACTIONS, 'registry', 'abort'],
        limit: 100
      } as any)
    } catch { /* wallet without spec-op support */ }
  }

  try {
    const res = await wallet.listActions({
      labels: ['mandala', 'registry'],
      labelQueryMode: 'all',
      includeInputs: true,
      limit: 100
    })
    for (const a of res.actions) {
      if (a.status === 'completed' || a.status === 'failed' || a.status === 'unproven') continue
      const ref = (a as { reference?: string }).reference
      if (ref == null || ref === '') continue
      if (protectedRefs.has(ref)) continue
      if (typeof a.txid === 'string' && protectedTxids.has(a.txid)) continue
      const createdAt = actionCreatedAt(a)
      if (createdAt != null && now - createdAt < INTENT_TTL_MS) continue
      try {
        await wallet.abortAction({ reference: ref })
      } catch { /* on-chain already */ }
    }
  } catch { /* listing unsupported */ }
}

export async function recoverRegistryAuth (p: {
  wallet: WalletInterface
  issuerIdentityKey: string
}): Promise<RegistryAuth | null> {
  const row = pickRecoverableRegistryRow(await fetchRegistry())
  if (row == null) return await listRegistryAuth(p.wallet)
  const op = `${row.txid}.${row.outputIndex}`
  const details = reconstructRegistryDetails(row, p.issuerIdentityKey)
  const listed = await listRegistryAuth(p.wallet)
  if (listed?.authOutpoint === op) return listed
  const beef = await fetchRegistryBeef(row.txid, row.outputIndex)
  if (beef == null) throw new Error(`could not load registry tx ${row.txid}`)
  try {
    await p.wallet.internalizeAction({
      tx: beef,
      labels: ['mandala', 'registry', 'recover'],
      outputs: [{
        outputIndex: row.outputIndex,
        protocol: 'basket insertion',
        insertionRemittance: {
          basket: BASKET,
          customInstructions: registryCustomInstructions(details),
          tags: ['mandala-registry']
        }
      }],
      description: 'Re-attach identity registry authorization'
    })
  } catch (e) {
    if (!/already|duplicate|exists/i.test(String(e))) throw e
  }
  const again = await listRegistryAuth(p.wallet)
  if (again?.authOutpoint === op) return again
  // Overlay is the source of truth for the live head. Basket CI is bookkeeping.
  return { authOutpoint: op, authDetails: details }
}

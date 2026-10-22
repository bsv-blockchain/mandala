import { WalletInterface } from '@bsv/sdk'
import { decodeToken, isTokenId } from './brc162.js'
import { parseAmount } from './amount.js'
import { TREASURY_BASKET } from './constants.js'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HistoryRow {
  txid: string
  assetId: string
  direction: 'sent' | 'received' | 'issued' | 'redeemed' | 'admin'
  /** Exact base units (sums may exceed 2^64). */
  amount: bigint
  counterparty: string
  when: number
  kind: string
}

/** Which actions `loadHistory` reports: issuer treasury kinds, holder hand-overs, or both. */
export type HistoryScope = 'treasury' | 'holder' | 'all'

// ---------------------------------------------------------------------------
// Internal raw shape — mirrors WalletAction from @bsv/sdk Wallet.interfaces
// We keep this minimal so the pure parser is portable.
// ---------------------------------------------------------------------------

interface RawOutput {
  outputIndex?: number
  outputDescription?: string
  basket?: string
  customInstructions?: string
  tags?: string[]
  satoshis?: number
  lockingScript?: string
}

interface RawAction {
  txid: string
  description?: string
  labels?: string[]
  isOutgoing?: boolean
  outputs?: RawOutput[]
  /** WalletAction.lockTime is a tx lock-time field, NOT a wall-clock timestamp. */
  lockTime?: number
}

/** Parsed customInstructions relevant to history classification. */
interface ParsedCI {
  assetId?: string
  /** The receipt / custody sender (BRC-207 custody JSON, C§2.2 item 5). */
  senderIdentityKey?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOLDER_KINDS = new Set(['transfer', 'receive'])

/**
 * The action kind: the first label that is not `mandala` and not a BRC-207
 * module label (`p color plan …` carries the action plan, 0207:1165-1186).
 */
const kindFromLabels = (labels: string[] = []): string => {
  if (labels.includes('transfer')) return 'transfer'
  if (labels.includes('receive')) return 'receive'
  return labels.find(l => l !== 'mandala' && !l.startsWith('p color ')) ?? 'admin'
}

const isHolderKind = (kind: string): boolean => HOLDER_KINDS.has(kind)

const inScope = (kind: string, scope: HistoryScope): boolean =>
  scope === 'all' || (scope === 'holder') === isHolderKind(kind)

interface Decoded { o: RawOutput, role: 'deploy' | 'authority' | 'value', assetId: string, amount: bigint }

/**
 * Decode a 1Color output of a Mandala asset (`<txid>_0`) from its locking
 * script. Null for an absent script, a non-token or a non-Mandala id.
 */
function decodeOut (o: RawOutput): Decoded | null {
  if (o.lockingScript == null || o.lockingScript === '') return null
  const d = decodeToken(o.lockingScript)
  if (d == null || d.assetId == null || !isTokenId(d.assetId)) return null
  return { o, role: d.role, assetId: d.assetId, amount: d.amount }
}

function parseCI (raw: string | undefined): ParsedCI {
  if (raw == null || raw === '') return {}
  try {
    const p = JSON.parse(raw)
    return typeof p === 'object' && p != null ? p as ParsedCI : {}
  } catch {
    return {}
  }
}

const sum = (xs: Decoded[]): bigint => xs.reduce((t, x) => t + x.amount, 0n)

/** `Redeem <amount> …`: the fixed description prefix the redeem flow writes. 0n when absent or out of range. */
function redeemAmount (description?: string): bigint {
  const m = /^Redeem (\d+)/.exec(description ?? '')
  if (m == null) return 0n
  try {
    return parseAmount(m[1], 0)
  } catch {
    return 0n
  }
}

/**
 * One holder row (`transfer` ⇒ sent, `receive` ⇒ received), or null when the
 * action's outputs decode no value of exactly one Mandala asset (D1).
 *
 *   sent      amount = the asset's value outputs with no basket (the recipient;
 *             the module's token change sits in `p color <assetTag>`), else
 *             output 0 (a listing without baskets, or a self-send)
 *   received  amount = the asset's value outputs in a `p color ` basket
 *
 * counterparty = the custody `senderIdentityKey` of the counted outputs when
 * the listing carries their customInstructions, else ''.
 */
function holderRow (a: RawAction, kind: string): HistoryRow | null {
  const values = (a.outputs ?? []).map(decodeOut).filter((x): x is Decoded => x != null && x.role === 'value')
  const assets = new Set(values.map(v => v.assetId))
  if (assets.size !== 1) return null
  const assetId = values[0].assetId
  let counted: Decoded[]
  let direction: HistoryRow['direction']
  if (kind === 'transfer') {
    direction = 'sent'
    counted = values.filter(v => v.o.basket == null || v.o.basket === '')
    if (counted.length === 0) counted = values.filter(v => (v.o.outputIndex ?? -1) === 0)
  } else {
    direction = 'received'
    counted = values.filter(v => typeof v.o.basket === 'string' && v.o.basket.startsWith('p color '))
  }
  if (counted.length === 0) return null
  const sender = counted.map(v => parseCI(v.o.customInstructions).senderIdentityKey)
    .find((k): k is string => typeof k === 'string' && k !== '')
  return { txid: a.txid, assetId, direction, amount: sum(counted), counterparty: sender ?? '', when: 0, kind }
}

/** One treasury row (issue/redeem/payout/reissue/register/admin), or null when no asset is attributable. */
function treasuryRow (a: RawAction, kind: string, ciByOutpoint: Record<string, string>): HistoryRow | null {
  const outputs = a.outputs ?? []
  const ciFor = (o: RawOutput): ParsedCI => {
    const own = parseCI(o.customInstructions)
    if (Object.keys(own).length > 0) return own
    return parseCI(ciByOutpoint[`${a.txid}.${o.outputIndex ?? 0}`])
  }
  const decoded = outputs.map(decodeOut).filter((x): x is Decoded => x != null)
  const values = decoded.filter(x => x.role === 'value')

  // assetId: a decoded value output, then any decoded 1Color output (a redeem
  // keeps only its authority), then any dotted tag, then customInstructions.
  const assetId =
    values[0]?.assetId ??
    decoded[0]?.assetId ??
    outputs.flatMap(o => o.tags ?? []).find(t => t.includes('.')) ??
    outputs.map(o => ciFor(o).assetId).find((id): id is string => typeof id === 'string' && id !== '') ??
    ''
  if (assetId === '') return null

  const own = values.filter(v => v.assetId === assetId)
  switch (kind) {
    case 'issue':
      return { txid: a.txid, assetId, direction: 'issued', amount: sum(own), counterparty: '', when: 0, kind }
    case 'redeem':
      // A redeem burns inputs; its outputs are authority + change, so the
      // burned amount lives only in the description's fixed prefix.
      return { txid: a.txid, assetId, direction: 'redeemed', amount: redeemAmount(a.description), counterparty: '', when: 0, kind }
    default:
      return { txid: a.txid, assetId, direction: kind === 'recover' ? 'received' : 'admin', amount: sum(own), counterparty: '', when: 0, kind }
  }
}

// ---------------------------------------------------------------------------
// Pure parser — unit-tested with fixtures
// ---------------------------------------------------------------------------

/**
 * Convert raw wallet actions (from `listActions`) into ONE HistoryRow per
 * action. Classification is by action label: `transfer`/`receive` are holder
 * hand-overs (BRC-207 `p color` outputs), every other kind is an issuer
 * treasury action. `ciByOutpoint` supplies treasury customInstructions
 * recovered from `listOutputs` keyed by `"txid.outputIndex"`.
 *
 * A holder action whose outputs decode no value of exactly one asset is
 * skipped, with one `console.warn` per call.
 *
 * when: The @bsv/sdk WalletAction interface exposes no wall-clock timestamp
 *       field (lockTime is the tx-level nLockTime, not a UNIX timestamp).
 *       `when` is left as 0; callers may populate it from another source.
 */
export function parseActionsToHistory (
  actions: RawAction[],
  ciByOutpoint: Record<string, string> = {},
  scope: HistoryScope = 'all'
): HistoryRow[] {
  const rows: HistoryRow[] = []
  let skipped = 0
  for (const a of actions) {
    const kind = kindFromLabels(a.labels)
    if (!inScope(kind, scope)) continue
    if (isHolderKind(kind)) {
      const row = holderRow(a, kind)
      if (row == null) skipped++
      else rows.push(row)
    } else {
      const row = treasuryRow(a, kind, ciByOutpoint)
      if (row != null) rows.push(row)
    }
  }
  if (skipped > 0) console.warn(`[mandala] history: skipped ${skipped} hand-over action(s) with no decodable value of one asset`)
  return rows
}

// ---------------------------------------------------------------------------
// loadHistory — calls the real wallet SDK
// ---------------------------------------------------------------------------

/**
 * Fetch mandala actions from the wallet and parse them to HistoryRows.
 *
 * One `listActions` (label `mandala`) serves every scope. The treasury basket
 * listing (the reliable source of customInstructions for treasury outputs)
 * runs only when the scope includes treasury. A `p color` basket is never
 * listed: that would prompt the holder for `color_access`.
 */
export async function loadHistory (
  wallet: WalletInterface,
  o: { scope?: HistoryScope, assetId?: string } = {}
): Promise<HistoryRow[]> {
  const scope = o.scope ?? 'all'
  const [actionsRes, outputsRes] = await Promise.all([
    wallet.listActions({
      labels: ['mandala'],
      labelQueryMode: 'any',
      includeLabels: true,
      includeOutputs: true,
      includeOutputLockingScripts: true,
      limit: 1000
    } as any),
    scope === 'holder'
      ? Promise.resolve({ outputs: [] })
      : wallet.listOutputs({
        basket: TREASURY_BASKET,
        includeCustomInstructions: true,
        limit: 1000
      } as any).catch(() => ({ outputs: [] }))
  ])

  const ciByOutpoint: Record<string, string> = {}
  for (const out of (outputsRes as any).outputs ?? []) {
    if (typeof out.outpoint === 'string' && typeof out.customInstructions === 'string') {
      ciByOutpoint[out.outpoint] = out.customInstructions
    }
  }

  const result = actionsRes as { totalActions: number, actions: RawAction[] }
  const rows = parseActionsToHistory(result.actions ?? [], ciByOutpoint, scope)
  return o.assetId == null ? rows : rows.filter(r => r.assetId === o.assetId)
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const esc = (s: string): string => `"${String(s).replace(/"/g, '""')}"`

/**
 * Serialise HistoryRows to CSV (header + one row per entry).
 * Fields: txid, assetId, direction, kind, amount, counterparty, when
 */
export function exportTransactionsCsv (rows: HistoryRow[]): string {
  const header = ['txid', 'assetId', 'direction', 'kind', 'amount', 'counterparty', 'when']
  const lines = [
    header.join(','),
    ...rows.map(r =>
      [
        esc(r.txid),
        esc(r.assetId),
        r.direction,
        r.kind,
        r.amount.toString(),
        esc(r.counterparty),
        r.when
      ].join(',')
    )
  ]
  return lines.join('\n')
}

import { WalletInterface } from '@bsv/sdk'
import { decodeValue } from './brc162.js'
import { BASKET } from './constants.js'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HistoryRow {
  txid: string
  assetId: string
  direction: 'sent' | 'received' | 'issued' | 'redeemed' | 'admin'
  amount: number
  counterparty: string
  when: number
  kind: string
}

// ---------------------------------------------------------------------------
// Internal raw shape — mirrors WalletAction from @bsv/sdk Wallet.interfaces
// We keep this minimal so the pure parser is portable.
// ---------------------------------------------------------------------------

interface RawOutput {
  outputIndex?: number
  outputDescription?: string
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
  direction?: string
  recipient?: string
  counterparty?: string
  sentAmount?: number
  assetId?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const kindFromLabels = (labels: string[] = []): string =>
  labels.find(l => l !== 'mandala' && !l.startsWith('to-') && !l.startsWith('from-')) ?? 'admin'

/**
 * Counterparty key persisted as an action label (`to-<key>` / `from-<key>`).
 * Labels outlive the action's outputs — customInstructions are erased when an
 * output is spent or relinquished, so older transactions lose them.
 */
const counterpartyFromLabels = (labels: string[] = []): string => {
  for (const l of labels) {
    const m = /^(?:to|from)-((?:02|03|04)[0-9a-f]{64})$/.exec(l)
    if (m != null) return m[1]
  }
  return ''
}

/**
 * Attempt to decode the token amount/assetId from the output's locking script.
 * Returns null if the script is absent or not a MandalaToken output.
 */
function decodeFt (o: RawOutput): { assetId: string, amount: number } | null {
  if (!o.lockingScript) return null
  const d = decodeValue(o.lockingScript)
  return d == null ? null : { assetId: d.tokenId, amount: d.amount }
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

// ---------------------------------------------------------------------------
// Pure parser — unit-tested with fixtures
// ---------------------------------------------------------------------------

/**
 * Convert raw wallet actions (from `listActions`) into ONE HistoryRow per
 * action — the user-facing story of a transaction, not its outputs. Outputs
 * are a technical detail: a send usually has a recipient output AND change
 * back to the sender, which must not surface as a bogus "received" row.
 *
 * Classification is by action label first (`transfer`/`receive`/`issue`/
 * `redeem` — set by this app's own flows), so direction never depends on
 * per-output metadata that the wallet may not return from `listActions`:
 *
 *   transfer → sent      amount = recipient output (never the change);
 *                        counterparty = recipient key from output
 *                        customInstructions (falling back to the change
 *                        output's, which the wallet always tracks)
 *   receive  → received  amount = internalized output; counterparty = sender
 *   issue    → issued    amount = minted FT output(s)
 *   redeem   → redeemed  amount from the action description (outputs carry
 *                        only auth/change — the burn amount isn't on-chain)
 *   others   → admin
 *
 * `ciByOutpoint` supplies customInstructions recovered from `listOutputs`
 * (which returns them reliably for basket-tracked outputs) keyed by
 * `"txid.outputIndex"`, as a fallback when the action's own outputs omit them.
 *
 * when: The @bsv/sdk WalletAction interface exposes no wall-clock timestamp
 *       field (lockTime is the tx-level nLockTime, not a UNIX timestamp).
 *       `when` is left as 0; callers may populate it from another source.
 */
export function parseActionsToHistory (
  actions: RawAction[],
  ciByOutpoint: Record<string, string> = {}
): HistoryRow[] {
  const rows: HistoryRow[] = []

  for (const a of actions) {
    const kind = kindFromLabels(a.labels)
    const outputs = a.outputs ?? []

    const ciFor = (o: RawOutput): ParsedCI => {
      const own = parseCI(o.customInstructions)
      if (Object.keys(own).length > 0) return own
      return parseCI(ciByOutpoint[`${a.txid}.${o.outputIndex ?? 0}`])
    }

    // FT outputs of this action, with owner-agnostic decode.
    const fts = outputs
      .map(o => ({ o, ft: decodeFt(o) }))
      .filter((x): x is { o: RawOutput, ft: { assetId: string, amount: number } } => x.ft != null)

    // assetId: decoded FT first, then any dotted tag, then customInstructions.
    const assetId =
      fts[0]?.ft.assetId ??
      outputs.flatMap(o => o.tags ?? []).find(t => t.includes('.')) ??
      outputs.map(o => ciFor(o).assetId).find(id => typeof id === 'string' && id !== '') ??
      ''
    if (assetId === '') continue // not attributable to an asset — skip

    let direction: HistoryRow['direction']
    let amount = 0
    let counterparty = ''

    switch (kind) {
      case 'transfer': {
        const cis = outputs.map(o => ciFor(o))
        // A transfer-labeled action the wallet marks as NOT outgoing is the
        // receive side (seen when a tx is internalized under the same label).
        if (a.isOutgoing === false && cis.every(c => c.direction !== 'sent' && c.direction !== 'change')) {
          direction = 'received'
          amount = fts[0]?.ft.amount ?? 0
          counterparty =
            counterpartyFromLabels(a.labels) !== ''
              ? counterpartyFromLabels(a.labels)
              : cis.find(c => typeof c.counterparty === 'string' && c.counterparty !== '')?.counterparty ?? ''
          break
        }
        direction = 'sent'
        // Recipient output: marked by its own customInstructions, else by the
        // build convention (outputDescription). Never fall back to a change
        // output — a send now carries N change outputs in randomized order, so
        // when the recipient output drops out of listActions the amount must
        // come from the change CI's sentAmount instead. Change is excluded by
        // outputDescription as well as CI: spending an output erases its
        // customInstructions, but the description persists.
        const recipientOut =
          fts.find(x => ciFor(x.o).direction === 'sent') ??
          fts.find(x => x.o.outputDescription === 'FT to recipient') ??
          fts.find(x => x.o.outputDescription !== 'FT change' && ciFor(x.o).direction !== 'change')
        const changeCi = cis.find(c => c.direction === 'change')
        amount = recipientOut?.ft.amount ?? (typeof changeCi?.sentAmount === 'number' ? changeCi.sentAmount : 0)
        counterparty =
          counterpartyFromLabels(a.labels) !== ''
            ? counterpartyFromLabels(a.labels)
            : (recipientOut != null ? ciFor(recipientOut.o).recipient : undefined) ??
              cis.find(c => c.direction === 'sent')?.recipient ??
              changeCi?.recipient ??
              ''
        break
      }
      case 'receive': {
        direction = 'received'
        amount = fts[0]?.ft.amount ?? 0
        counterparty =
          counterpartyFromLabels(a.labels) !== ''
            ? counterpartyFromLabels(a.labels)
            : outputs.map(o => ciFor(o))
              .find(c => typeof c.counterparty === 'string' && c.counterparty !== '')?.counterparty ?? ''
        break
      }
      case 'issue': {
        direction = 'issued'
        amount = fts.reduce((sum, x) => sum + x.ft.amount, 0)
        break
      }
      case 'redeem': {
        direction = 'redeemed'
        // A redeem burns inputs; outputs are auth + optional change, so the
        // burned amount only lives in the action description ("Redeem N …").
        const m = /^Redeem (\d+)\b/.exec(a.description ?? '')
        amount = m != null ? Number(m[1]) : 0
        break
      }
      default: {
        direction = kind === 'recover' ? 'received' : 'admin'
        amount = fts.reduce((sum, x) => sum + x.ft.amount, 0)
      }
    }

    rows.push({ txid: a.txid, assetId, direction, amount, counterparty, when: 0, kind })
  }

  return rows
}

// ---------------------------------------------------------------------------
// loadHistory — calls the real wallet SDK
// ---------------------------------------------------------------------------

/**
 * Fetch mandala actions from the wallet, parse to HistoryRows, and optionally
 * filter by assetId.
 *
 * Runs `listActions` (the actions + output scripts) and `listOutputs` over the
 * mandala basket (the reliable source of customInstructions for outputs the
 * wallet tracks) together, then joins them by outpoint so classification has
 * the send/receive context this app writes at build time.
 */
export async function loadHistory (
  wallet: WalletInterface,
  assetId?: string
): Promise<HistoryRow[]> {
  const [actionsRes, outputsRes] = await Promise.all([
    wallet.listActions({
      labels: ['mandala'],
      includeLabels: true,
      includeOutputs: true,
      includeOutputLockingScripts: true,
      limit: 1000
    } as any),
    wallet.listOutputs({
      basket: BASKET,
      includeCustomInstructions: true,
      limit: 1000
    } as any).catch(() => ({ outputs: [] }))
  ])

  const ciByOutpoint: Record<string, string> = {}
  for (const o of (outputsRes as any).outputs ?? []) {
    if (typeof o.outpoint === 'string' && typeof o.customInstructions === 'string') {
      ciByOutpoint[o.outpoint] = o.customInstructions
    }
  }

  const result = actionsRes as { totalActions: number, actions: RawAction[] }
  const rows = parseActionsToHistory(result.actions ?? [], ciByOutpoint)
  return assetId == null ? rows : rows.filter(r => r.assetId === assetId)
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
        r.amount,
        esc(r.counterparty),
        r.when
      ].join(',')
    )
  ]
  return lines.join('\n')
}

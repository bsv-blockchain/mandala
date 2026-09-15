/**
 * Loads spendable FT outputs of an asset as coin-selection candidates, enriched
 * with confirmation status and relative age via a listActions cross-reference
 * (listOutputs exposes neither). Feeds selectFtInputs (see ftSelect.ts).
 */
import { Beef, LockingScript, WalletInterface } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { BASKET } from './constants.js'
import { FtCandidate } from './ftSelect.js'
import { resolveAssetState } from './adminState.js'
import { assertSpendablePrior } from './adminAuthGate.js'

// Wallet action statuses we treat as confirmed for coin-selection purposes.
// Everything else (nosend/unproven/sending/unprocessed/…) is "unconfirmed" and
// only spent when confirmed outputs can't cover the target.
const CONFIRMED_STATUSES = new Set<string>(['completed'])

interface TxMeta { status: string, order: number }

/**
 * Build a txid → { status, order } map from listActions. listActions returns
 * actions oldest-first, so the array index is a usable age rank (lower = older),
 * matching how the app already derives recency elsewhere.
 */
async function loadTxMeta(wallet: WalletInterface): Promise<Map<string, TxMeta>> {
  const map = new Map<string, TxMeta>()
  try {
    const res = await wallet.listActions({ labels: ['mandala'], limit: 1000 } as any)
    const actions = (res as { actions?: Array<{ txid?: string, status?: string }> }).actions ?? []
    actions.forEach((a, i) => {
      if (typeof a.txid === 'string') map.set(a.txid, { status: a.status ?? '', order: i })
    })
  } catch { /* status unavailable — callers treat every output as unconfirmed */ }
  return map
}

/**
 * Drop candidates the overlay has frozen or evicted. Pure so it is unit-testable; the
 * excluded set is sourced from the admin-state endpoint by loadFtCandidates.
 */
export function excludeFrozen (candidates: FtCandidate[], excluded: Set<string>): FtCandidate[] {
  if (excluded.size === 0) return candidates
  return candidates.filter(c => !excluded.has(c.outpoint))
}

/**
 * Fetch FT candidates for `assetId` plus the merged input BEEF needed to spend
 * them. Outputs whose txid is unknown to listActions are treated as unconfirmed
 * and sorted last (newest).
 */
export async function loadFtCandidates(
  wallet: WalletInterface,
  assetId: string,
  opts?: {
    /**
     * Outpoint that must still be spendable in the basket (e.g. the admin-auth
     * prior for a redeem). Checked against the first listing so a stale prior
     * fails fast before the heavier BEEF/listActions work — and without the
     * extra listOutputs a caller-side pre-check would cost.
     */
    requireSpendable?: string
  }
): Promise<{ candidates: FtCandidate[], beef: number[] }> {
  const scriptRes = await wallet.listOutputs({
    basket: BASKET,
    include: 'locking scripts',
    includeCustomInstructions: true,
    limit: 1000
  })
  if (opts?.requireSpendable != null) {
    assertSpendablePrior(opts.requireSpendable, scriptRes.outputs.map(o => o.outpoint as string))
  }
  const beefRes = await wallet.listOutputs({
    basket: BASKET,
    include: 'entire transactions',
    limit: 1000
  })
  const txMeta = await loadTxMeta(wallet)

  // Some wallets (the mobile toolbox among them) do not populate
  // `lockingScript` for include:'locking scripts'; the BEEF listing carries
  // every script regardless, so read from there whenever the field is absent.
  let scriptsFromBeef: Map<string, LockingScript> | undefined
  const scriptOf = (o: { outpoint?: unknown, lockingScript?: unknown }): LockingScript | undefined => {
    if (typeof o.lockingScript === 'string' && o.lockingScript.length > 0) {
      return LockingScript.fromHex(o.lockingScript)
    }
    if (scriptsFromBeef == null) {
      scriptsFromBeef = new Map()
      try {
        const beef = Beef.fromBinary(beefRes.BEEF as number[])
        for (const btx of beef.txs) {
          const tx = btx.tx
          if (tx == null) continue
          const txid = tx.id('hex')
          tx.outputs.forEach((out, i) => { scriptsFromBeef!.set(`${txid}.${i}`, out.lockingScript) })
        }
      } catch { /* unreadable BEEF — nothing decodes, caller reports zero candidates */ }
    }
    return scriptsFromBeef.get(String(o.outpoint))
  }

  const candidates: FtCandidate[] = []
  for (const o of scriptRes.outputs) {
    let decoded
    try {
      const script = scriptOf(o)
      if (script == null) continue
      decoded = MandalaToken.decode(script)
    } catch { continue } // not a Mandala FT output
    if (decoded.assetId !== assetId) continue

    let ci: { keyID?: string, counterparty?: string } = {}
    try { ci = JSON.parse((o.customInstructions as string) ?? '{}') } catch { /* malformed */ }

    const txid = (o.outpoint as string).split('.')[0]
    const meta = txMeta.get(txid)
    candidates.push({
      outpoint: o.outpoint as string,
      amount: decoded.amount,
      keyID: ci.keyID ?? '',
      counterparty: ci.counterparty ?? '',
      confirmed: meta != null && CONFIRMED_STATUSES.has(meta.status),
      order: meta?.order ?? Number.MAX_SAFE_INTEGER
    })
  }

  // Overlay-authoritative freeze + eviction list; fail open (null → empty set) so a brief
  // endpoint outage never blocks sends — the overlay still rejects a frozen/evicted spend.
  const state = await resolveAssetState(assetId)
  const excluded = new Set<string>([
    ...(state?.frozenOutpoints ?? []).map(f => f.outpoint),
    ...(state?.evictedOutpoints ?? [])
  ])

  const usable = excludeFrozen(candidates, excluded)
  if (usable.length === 0) {
    console.warn(`[mandala] no spendable ${assetId} outputs: listed ${scriptRes.outputs.length} in basket '${BASKET}', ${candidates.length} decoded for this asset, ${excluded.size} frozen/evicted`)
  }
  return { candidates: usable, beef: beefRes.BEEF as number[] }
}

/**
 * Per-asset admin-auth recovery surface (A10) and the frozen-row flag on the
 * asset-state payload (A16).
 *
 * The live admin outpoint of an asset is otherwise known only to the issuer's
 * wallet basket, and a wallet that reclassifies the 1-sat auth output as
 * plain P2PKH strips that bookkeeping (runbook.md, failure 3). The overlay's
 * `mandalaAdminHistory` already holds every admitted admin output in chain
 * order, so it can hand the head back: whoever produced the newest admin
 * output holds authority next, and the newest is the maximum of
 * (height, offset, admitSeq) — unmined actions carry height =
 * Number.MAX_SAFE_INTEGER and therefore sort after every mined one.
 *
 * Wire shapes are shared with overlay-go/internal/httpapi/admin.go: camelCase,
 * arrays never null, `500 {error}` on failure, the 404 strings below.
 */
import type { Request, Response } from 'express'

export interface AdminHistoryRowLite {
  assetId: string
  txid: string
  outputIndex: number
  height: number
  offset: number
  admitSeq: number
  actionDetails: Record<string, unknown>
}

export const ASSET_AUTH_NOT_FOUND = 'no admin history for this asset'
export const ADMIN_TX_NOT_FOUND = 'admin tx not in overlay storage'

const later = (a: AdminHistoryRowLite, b: AdminHistoryRowLite): boolean =>
  a.height !== b.height
    ? a.height > b.height
    : a.offset !== b.offset
      ? a.offset > b.offset
      : a.admitSeq > b.admitSeq

/** The chain head: the row that sorts last by (height, offset, admitSeq). Input order is irrelevant. */
export function pickAssetAuthHead (rows: AdminHistoryRowLite[]): AdminHistoryRowLite | null {
  let head: AdminHistoryRowLite | null = null
  for (const r of rows) {
    if (head == null || later(r, head)) head = r
  }
  return head
}

type Handler = (req: Request<any>, res: Response) => void

const cors = (res: Response): void => { res.header('Access-Control-Allow-Origin', '*') }
const fail = (res: Response, e: unknown): void => { res.status(500).json({ error: String(e) }) }

export function assetAuthHeadHandler (deps: {
  findAdminHistory: (assetId: string) => Promise<AdminHistoryRowLite[]>
}): Handler {
  return (req, res) => {
    cors(res)
    void (async () => {
      try {
        const head = pickAssetAuthHead(await deps.findAdminHistory(String(req.params.assetId ?? '')))
        if (head == null) {
          res.status(404).json({ error: ASSET_AUTH_NOT_FOUND })
          return
        }
        res.json({ authOutpoint: `${head.txid}.${head.outputIndex}`, authDetails: head.actionDetails })
      } catch (e) {
        fail(res, e)
      }
    })()
  }
}

/** `?vout=` as the registry BEEF route reads it: `Number(vout ?? 0)`, junk → 0. */
export const voutParam = (raw: unknown): number => {
  const n = Number(raw ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function assetAuthBeefHandler (deps: {
  findBeef: (txid: string, vout: number) => Promise<{ beef: number[], outputIndex: number } | null>
}): Handler {
  return (req, res) => {
    cors(res)
    void (async () => {
      try {
        const out = await deps.findBeef(String(req.params.txid ?? ''), voutParam(req.query?.vout))
        if (out == null) {
          res.status(404).json({ error: ADMIN_TX_NOT_FOUND })
          return
        }
        res.json({ beef: out.beef, outputIndex: out.outputIndex })
      } catch (e) {
        fail(res, e)
      }
    })()
  }
}

export const splitOutpoint = (op: string): { txid: string, vout: number } | null => {
  const dot = op.lastIndexOf('.')
  if (dot <= 0) return null
  const vout = Number(op.slice(dot + 1))
  if (!Number.isInteger(vout) || vout < 0) return null
  return { txid: op.slice(0, dot), vout }
}

/**
 * A16: annotate each frozen ref with `hasFrozenRow` — whether the frozen coin
 * still has a live token row, i.e. whether a reissue of it can succeed. Read
 * live per request so a freeze that raced the coin's spend is reported as it
 * stands now, not as it was folded.
 */
export async function withFrozenRowFlags<F extends { outpoint: string }, S extends { frozenOutpoints: F[] }> (
  state: S,
  hasTokenRow: (txid: string, vout: number) => Promise<boolean>
): Promise<Omit<S, 'frozenOutpoints'> & { frozenOutpoints: Array<F & { hasFrozenRow: boolean }> }> {
  const frozenOutpoints = await Promise.all(state.frozenOutpoints.map(async f => {
    const op = splitOutpoint(f.outpoint)
    return { ...f, hasFrozenRow: op != null && await hasTokenRow(op.txid, op.vout) }
  }))
  return { ...state, frozenOutpoints }
}

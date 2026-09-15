/**
 * FIX D — the /submit verdict taxonomy (offline-settlement wire contract v2 §2).
 *
 * The pinned `@bsv/overlay` Engine swallows a topic manager's rejection: the
 * per-topic validation is wrapped in a try/catch that records the topic in
 * `failedTopics` and hands the route a STEAK entry of
 * `{outputsToAdmit: [], coinsToRetain: []}` — which is byte-identical to a
 * legitimate "nothing admitted" and to the dupe path. Every submitter therefore
 * sees `200 {}` for a conservation violation, for a storage fault and for a
 * successful re-submit alike, which is exactly the unsoundness SC-3.1/SM-3.3
 * name: a transient fault is indistinguishable from a permanent refusal, so a
 * wallet either strands a good payment forever or retries a dead one forever.
 *
 * This module is the repo-local classifier both halves of the fix share:
 * `submitSideChannel.ts` captures the manager's OWN reason before the engine
 * swallows it, and `admission.ts`'s /submit wrapper turns that reason into the
 * contract's error body via the table here.
 *
 * MAPPING RULE (binding): a 400/409 code may ONLY be minted from a genuine
 * topic-manager reject reason. Anything else — SPV/chaintracker, storage,
 * broadcast/Arcade, sanctions-provider fault, unknown internal error — is
 * `ERR_UNAVAILABLE` (503, retryable). Never infer a policy code from an
 * engine-level error string.
 *
 * The table below is duplicated verbatim in overlay-go; the two stacks must
 * match substring for substring, in this order.
 */

export type VerdictCode =
  // 400, final (a deterministic content refusal — the same bytes always lose)
  | 'ERR_CONSERVATION'
  | 'ERR_LINKAGE'
  | 'ERR_SHAPE'
  | 'ERR_SATOSHIS'
  | 'ERR_INPUT_SPENT'
  // 409, liftable (the overlay's own condition may change; retry with backoff)
  | 'ERR_PAUSED'
  | 'ERR_FROZEN'
  | 'ERR_SANCTIONED'
  | 'ERR_ACCESS'
  | 'ERR_MEMBERSHIP'
  // 410, final — admitted then evicted; the INPUTS are live again (FIX E)
  | 'ERR_EVICTED'
  // 503, retryable — not a manager verdict at all
  | 'ERR_UNAVAILABLE'

export interface VerdictShape {
  httpStatus: number
  retryable: boolean
}

const SHAPES: Record<VerdictCode, VerdictShape> = {
  ERR_CONSERVATION: { httpStatus: 400, retryable: false },
  ERR_LINKAGE: { httpStatus: 400, retryable: false },
  ERR_SHAPE: { httpStatus: 400, retryable: false },
  ERR_SATOSHIS: { httpStatus: 400, retryable: false },
  ERR_INPUT_SPENT: { httpStatus: 400, retryable: false },
  ERR_PAUSED: { httpStatus: 409, retryable: true },
  ERR_FROZEN: { httpStatus: 409, retryable: true },
  ERR_SANCTIONED: { httpStatus: 409, retryable: true },
  ERR_ACCESS: { httpStatus: 409, retryable: true },
  ERR_MEMBERSHIP: { httpStatus: 409, retryable: true },
  ERR_EVICTED: { httpStatus: 410, retryable: false },
  ERR_UNAVAILABLE: { httpStatus: 503, retryable: true }
}

/**
 * "Verdict wins" (contract §2, amended by §9.1/§9.2): only these are persisted
 * on the admission record — keyed by (txid, payloadHash) — and replayed to a
 * later submitter of the SAME payload. Two exclusions, both deliberate:
 *
 *  - a 409 is a snapshot of a liftable condition and must never be persisted as
 *    final, or an unpause could never take effect for a txid refused once;
 *  - `ERR_INPUT_SPENT` is NEVER persisted (§9.2). It is a statement about LIVE
 *    state — which competitor currently holds the coin — and that state changes
 *    under it: the competitor can be evicted (contract §7's rescue clause), at
 *    which point the loser's re-submit must be evaluated fresh and admitted. A
 *    persisted ERR_INPUT_SPENT outranks that rescue and stands the coin off
 *    forever. It stays `400 retryable:false` with `spendTxid` ON THE WIRE (see
 *    SHAPES above): the wallet confirms the competitor via
 *    GET /admin/admission/<spendTxid> before treating it as terminal.
 */
export const FINAL_CODES: ReadonlySet<VerdictCode> = new Set<VerdictCode>([
  'ERR_CONSERVATION', 'ERR_LINKAGE', 'ERR_SHAPE', 'ERR_SATOSHIS', 'ERR_EVICTED'
])

/**
 * The shared substring table, in evaluation order — FIRST HIT WINS. Two rows
 * deviate from the order printed in contract §2, both deliberately and both
 * required for the contract's own stated outcomes:
 *
 *  1. `not anchored to the asset admin chain` is pre-empted to ERR_SHAPE.
 *     That refusal (adminChainGuard.ts) ends "...spent by this transaction",
 *     so the generic `spent` row would otherwise mint ERR_INPUT_SPENT for a
 *     bad admin chain — which §2 explicitly files under ERR_SHAPE. Pre-empting
 *     is what makes the table produce the code the contract asks for.
 *  2. The membership row precedes the `sanction` row. §2's own note says the
 *     upstream membership string is "sanctioned party involved in transfer"
 *     and must map to ERR_MEMBERSHIP, not ERR_SANCTIONED — impossible if
 *     `sanction` is tested first, since it is a substring of it.
 */
export const REASON_TABLE: ReadonlyArray<{ readonly match: readonly string[], readonly code: VerdictCode }> = [
  { match: ['not anchored to the asset admin chain'], code: 'ERR_SHAPE' },
  { match: ['conservation'], code: 'ERR_CONSERVATION' },
  { match: ['no verified linkage', 'linkage'], code: 'ERR_LINKAGE' },
  { match: ['satoshi'], code: 'ERR_SATOSHIS' },
  { match: ['sanctioned party', 'not admitted', 'membership'], code: 'ERR_MEMBERSHIP' },
  { match: ['paused'], code: 'ERR_PAUSED' },
  { match: ['frozen'], code: 'ERR_FROZEN' },
  { match: ['sanction'], code: 'ERR_SANCTIONED' },
  { match: ['access mode', 'allowlist', 'denylist'], code: 'ERR_ACCESS' },
  { match: ['spent'], code: 'ERR_INPUT_SPENT' }
]

/** Map a topic-manager reject reason to its contract code. Default ERR_SHAPE. */
export const classifyManagerReason = (reason: string): VerdictCode => {
  const hay = String(reason ?? '').toLowerCase()
  for (const row of REASON_TABLE) {
    if (row.match.some(m => hay.includes(m))) return row.code
  }
  return 'ERR_SHAPE'
}

export const verdictFor = (code: VerdictCode): VerdictShape => SHAPES[code]

export interface SubmitErrorBody {
  status: 'error'
  code: VerdictCode
  retryable: boolean
  description: string
  /**
   * The SAME text as `description`. Kept alongside it for parity with
   * overlay-go and because every pre-existing TS error body on this server
   * (and the pinned OverlayExpress routes) carries `message` — a client that
   * reads either key gets the same answer.
   */
  message: string
  spendTxid?: string
}

/** The one error body every /submit refusal and every refused GET emits. */
export const errorBody = (code: VerdictCode, description: string, spendTxid?: string): SubmitErrorBody => {
  const body: SubmitErrorBody = {
    status: 'error',
    code,
    retryable: SHAPES[code].retryable,
    description,
    message: description
  }
  if (code === 'ERR_INPUT_SPENT' && spendTxid != null && spendTxid !== '') body.spendTxid = spendTxid
  return body
}

/**
 * A request the overlay could not even interpret — a missing/invalid X-Topics
 * header, or BEEF/off-chain framing it cannot decode. Deterministic and the
 * client's to fix, so it is a 400 ERR_SHAPE rather than a retryable 503, but it
 * is NOT a manager verdict and is therefore never persisted.
 */
export const requestErrorBody = (description: string): SubmitErrorBody =>
  errorBody('ERR_SHAPE', description)

/**
 * FIX L: raised by the spent-input guard. Carries the competing txid so
 * /submit can name it in `spendTxid`; the message is worded so the shared
 * table classifies it even if the typed channel is lost.
 */
export class InputSpentError extends Error {
  constructor (readonly outpoint: string, readonly spendTxid: string) {
    super(`input ${outpoint}: already spent by ${spendTxid}`)
    this.name = 'InputSpentError'
  }
}

/**
 * "Verdict wins" (contract §2): thrown by the topic-manager wrapper when a
 * persisted FINAL verdict already exists for this txid, so the engine never
 * re-admits bytes it has already ruled on (in particular, an evicted txid is
 * never re-admitted). It carries the code structurally rather than relying on
 * the substring table, because ERR_EVICTED has no reason string to classify.
 */
export class FinalVerdictError extends Error {
  constructor (readonly code: VerdictCode, readonly description: string, readonly spendTxid?: string) {
    super(description)
    this.name = 'FinalVerdictError'
  }
}

/**
 * §9.5 — "infra faults are never final".
 *
 * Every repo-local guard gates on state it has to READ: the live spend state of
 * an input, whether an outpoint is a recorded admin output, whether this txid
 * already carries a final verdict. Before this marker existed those reads were
 * either swallowed (the guard failed OPEN — it admitted what it could not
 * check) or allowed to surface as a bare `Error`, which the substring table
 * then classified as a 400 ERR_SHAPE and the /submit wrapper PERSISTED. Both
 * are wrong in opposite directions: the first admits an unchecked transaction,
 * the second turns a Mongo hiccup into a permanent, replayed refusal of a
 * perfectly valid one.
 *
 * An `InfraError` is the third answer: fail CLOSED, but retryably —
 * 503 ERR_UNAVAILABLE, never persisted, never classified through the table.
 * It is carried structurally by `SubmitSideChannel.noteReject`, exactly like
 * `FinalVerdictError`, so its code never depends on its wording.
 */
export class InfraError extends Error {
  constructor (readonly detail: string, readonly cause?: unknown) {
    super(detail)
    this.name = 'InfraError'
  }
}

/** Tolerates a cross-realm copy (two @bsv/* builds of this module). */
export const isInfraError = (e: unknown): e is InfraError =>
  e instanceof InfraError || (e as { name?: unknown } | null)?.name === 'InfraError'

/**
 * Runs a guard's state read, re-badging any fault as an `InfraError`. Use it
 * around EVERY store/provider call a guard makes — that is what makes §9.5
 * mechanical rather than a rule each guard has to remember.
 */
export const infra = async <T>(what: string, read: () => Promise<T>): Promise<T> => {
  try {
    return await read()
  } catch (e) {
    if (isInfraError(e)) throw e
    throw new InfraError(`${what} is unavailable: ${e instanceof Error ? e.message : String(e)}`, e)
  }
}

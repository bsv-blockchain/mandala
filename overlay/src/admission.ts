/**
 * σ_I — the overlay's signature over an ADMITTED OUTPUT SET, and the /submit
 * verdict wrapper that produces, persists and replays it.
 *
 * DIGEST v2 (wire contract v2 §1, FIX A signing half):
 *
 *     SHA-256("mandala-admit:" + txid + ":" + outputsToAdmit.sort(asc).join(","))
 *
 * The v1 message signed only the txid. That is the signing half of the
 * phantom-coin hole: a verifier who terminates its coverage walk on "this txid
 * was admitted" learns nothing about WHICH outputs the overlay actually
 * attested to, so an un-attested sibling token output inside a genuinely
 * admitted transaction reads as covered. Binding the signature to the admitted
 * set closes that, and `tokenLinkageGuard.ts` guarantees no token-shaped output
 * can be left out of the set in the first place. Neither half suffices alone.
 *
 * The signature is gated on the `tm_mandala` topic's OWN admitted set, not on
 * "some topic admitted something": a registry-only admission must never yield a
 * token σ_I. The v1 message is gone — this repo has no live token traffic, so
 * there is nothing to migrate.
 *
 * The /submit wrapper below additionally implements:
 *   FIX C — sign on the dupe path from the engine's own applied-transaction
 *           proof, even when the `mandalaAdmissions` row is missing;
 *   FIX D — the structured verdict taxonomy (see submitVerdict.ts), fed by the
 *           manager reasons `submitSideChannel.ts` captures;
 *   §3.3(b) — the admission record is AWAITED before the response is sent, so a
 *           client that got a 200 is guaranteed the very next GET succeeds.
 */
import { Hash, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import type { TopicManager } from '@bsv/overlay'
import {
  classifyManagerReason, errorBody, requestErrorBody, verdictFor, FINAL_CODES, FinalVerdictError,
  InfraError, isInfraError, infra,
  type VerdictCode, type SubmitErrorBody
} from './submitVerdict.js'
import { TOKEN_TOPIC, newSubmitScope, runInSubmitScope } from './submitSideChannel.js'
import type { AdmissionPending, AdmissionRestore, SubmitSideChannel } from './submitSideChannel.js'
import type { InFlightOutpoints } from './spentGuard.js'

export const ADMISSION_PREFIX = 'mandala-admit:'
export { TOKEN_TOPIC }

/**
 * Ascending, DE-DUPLICATED, comma-joined decimal indexes — e.g. "0,2,3".
 * Never empty (no admitted outputs ⇒ no signature).
 *
 * Canonicalizing here rather than trusting the engine's ordering is what makes
 * the digest a function of the admitted SET, and it matches `@bsv/mandala`'s
 * `canonicalOutputs` byte for byte — the verifier and the signer must agree on
 * the rendering or no σ_I verifies. overlay-go must canonicalize identically.
 */
export const outputSetString = (outputsToAdmit: number[]): string =>
  [...new Set(outputsToAdmit)].sort((a, b) => a - b).join(',')

export const admissionMessageV2 = (txid: string, outputsToAdmit: number[]): string =>
  `${ADMISSION_PREFIX}${txid}:${outputSetString(outputsToAdmit)}`

export const admissionDigestV2 = (txid: string, outputsToAdmit: number[]): number[] =>
  Hash.sha256(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8'))

export interface AdmissionSignature {
  admissionSignature: string
  admissionIdentityKey: string
}

/** Sync ECDSA over the v2 message (PrivateKey.sign hashes with SHA-256). */
export function signAdmissionV2Sync (priv: PrivateKey, txid: string, outputsToAdmit: number[]): AdmissionSignature {
  const sig = priv.sign(Utils.toArray(admissionMessageV2(txid, outputsToAdmit), 'utf8'))
  const der = sig.toDER()
  return {
    admissionSignature: typeof der === 'string' ? der : Utils.toHex(der),
    admissionIdentityKey: priv.toPublicKey().toString()
  }
}

export function txidFromSubmitBody (body: number[], includesOffChain: boolean): string | null {
  try {
    let beef = body
    if (includesOffChain) {
      const r = new Utils.Reader(beef)
      const l = r.readVarIntNum()
      beef = r.read(l)
    }
    return Transaction.fromBEEF(beef).id('hex')
  } catch {
    return null
  }
}

// ─────────────────────── payload hash (contract §9.1) ───────────────────────

/**
 * §9.1 — a persisted final refusal is keyed by `(txid, payloadHash)`, where
 *
 *     payloadHash = sha256(offChainValues bytes exactly as submitted)
 *
 * lowercase hex, and an absent or empty payload hashes the EMPTY byte string.
 *
 * The reason the txid alone is not a key: a Mandala transaction's linkage,
 * admin entries and conservation evidence all live in the off-chain payload,
 * and the txid commits to none of it. So ANY holder of a BEEF — the payee, an
 * observer who saw it on the wire, an attacker who intercepted it — could
 * submit it with the payload stripped, collect the deterministic
 * `400 ERR_LINKAGE`, and have the overlay persist that as the final verdict for
 * the txid. The rightful submitter's later, complete submission would then be
 * refused from the record without the manager ever seeing its payload, and
 * `GET /admin/admission/:txid` would serve the poisoned 400 to everyone. One
 * unauthenticated request per txid, permanently denying a valid transaction.
 *
 * Keying on the payload bytes makes a refusal a statement about the SUBMISSION
 * rather than about the transaction: the stripped submission stays refused, and
 * the complete one is evaluated on its own merits.
 */
export const payloadHashOfValues = (offChainValues?: number[]): string =>
  Utils.toHex(Hash.sha256(offChainValues ?? []))

/** The hash of the empty payload — what an off-chain-free submission carries. */
export const EMPTY_PAYLOAD_HASH = payloadHashOfValues()

/**
 * The same hash, computed from the RAW /submit body. Mirrors the pinned
 * overlay-express route byte for byte: with `x-includes-off-chain-values: true`
 * the body is `varint(beefLength) ++ beef ++ offChainValues`, and the route
 * hands the manager exactly that trailing remainder. Without the header there
 * are no off-chain values at all, so the empty hash is the honest answer —
 * and a body we cannot frame is treated the same way, because a refusal keyed
 * to garbage could never be matched again anyway.
 */
export const payloadHashOfBody = (body: number[], includesOffChain: boolean): string => {
  if (!includesOffChain) return EMPTY_PAYLOAD_HASH
  try {
    const r = new Utils.Reader(body)
    const beefLength = r.readVarIntNum()
    r.read(beefLength)
    return payloadHashOfValues(r.read())
  } catch {
    return EMPTY_PAYLOAD_HASH
  }
}

export type Steak = Record<string, { outputsToAdmit?: number[], coinsToRetain?: number[] } & Record<string, unknown>>

/**
 * Attaches σ_I to the `tm_mandala` STEAK entry when — and only when — that
 * topic admitted at least one output. Mutates and returns the STEAK.
 */
export function attachAdmissionSignaturesSync (steak: Steak, txid: string, priv: PrivateKey): Steak {
  const entry = steak[TOKEN_TOPIC]
  const admitted = entry?.outputsToAdmit ?? []
  if (admitted.length === 0) return steak
  try {
    Object.assign(entry, signAdmissionV2Sync(priv, txid, admitted))
  } catch (e) {
    console.warn('[mandala] admission signature failed:', e)
  }
  return steak
}

// ───────────────────────────── admission record ─────────────────────────────

/**
 * Record of an admission — or of a final refusal, or of an eviction — the
 * overlay attested to (wire contract v2 §4, spec §2.4).
 *
 * σ_I is deterministic (RFC 6979), so the signature need not be stored to be
 * reproduced — but WHETHER a txid was admitted, and OVER WHICH OUTPUT SET,
 * must be, or the overlay would sign an attestation it never made. A holder
 * settling offline hands on the signatures for the inputs it spends, so this
 * record is what lets those be served back long afterwards.
 *
 * `refusedCode`/`refusedAt` are mutually exclusive with the admission fields;
 * `evictedAt` means the coin's spent-input marks were restored and this txid's
 * σ_I is permanently void.
 */
export interface AdmissionRecord {
  txid: string
  topics?: string[]
  outputsToAdmit?: number[]
  admissionSignature?: string
  admissionIdentityKey?: string
  at?: string
  /** §9.4 — written before the engine broadcasts; cleared by the finalize. */
  pending?: boolean
  refusedCode?: VerdictCode
  /** The manager's verbatim reason, so a re-served refusal keeps its text. */
  refusedDescription?: string
  refusedAt?: string
  /**
   * §9.1 — the refusal applies ONLY to a submission whose off-chain payload
   * hashes to this. A record without it (written before the amendment) matches
   * nothing, so it is re-evaluated rather than replayed: the safe direction.
   */
  refusedPayloadHash?: string
  /**
   * Legacy only. §9.2 removed ERR_INPUT_SPENT from the persisted set, so
   * nothing writes this any more; it is read back for old rows, which
   * `finalVerdictOf` now declines to replay in any case.
   */
  refusedSpendTxid?: string
  evictedAt?: string
  restore?: AdmissionRestore
}

export interface AdmissionAdmitted {
  txid: string
  topics: string[]
  outputsToAdmit: number[]
  admissionSignature: string
  admissionIdentityKey: string
  at: string
  restore?: AdmissionRestore
}

export interface AdmissionRefusal {
  txid: string
  refusedCode: VerdictCode
  refusedDescription: string
  refusedAt: string
  /** §9.1 — the payload this refusal is about. Always written. */
  refusedPayloadHash: string
  refusedSpendTxid?: string
}

export interface AdmissionStore {
  get: (txid: string) => Promise<AdmissionRecord | null>
  /**
   * MUST resolve only once the record is durable — the response waits on it.
   * §9.1: an admission CLEARS the refusal fields (`refusedCode`,
   * `refusedDescription`, `refusedAt`, `refusedPayloadHash`,
   * `refusedSpendTxid`), so a transaction that is admitted after an earlier
   * payload was refused stops carrying that refusal. §9.4: it also clears
   * `pending`.
   */
  putAdmitted: (rec: AdmissionAdmitted) => Promise<void>
  putRefusal: (rec: AdmissionRefusal) => Promise<void>
  markEvicted: (txid: string, at: string) => Promise<void>
  /**
   * §9.4 — the provisional record, written before the engine can broadcast.
   * Optional so a store that predates the amendment still type-checks; when it
   * is absent the restore snapshot only becomes durable on the way out.
   */
  putPending?: (rec: AdmissionPending) => Promise<void>
}

/**
 * §9.9 — index creation failures ABORT startup on both engines.
 *
 * The unique index on `txid` is what makes the admission record a record rather
 * than a pile of rows: without it two concurrent submits of one txid insert two
 * documents, `get` returns whichever Mongo feels like, and "verdict wins"
 * silently stops winning. A boot that merely logged the failure would serve
 * exactly that, so the failure is re-thrown with a fatal message and `main()`'s
 * own catch exits the process.
 */
export const ensureAdmissionIndexes = async (
  col: { createIndex: (spec: Record<string, number>, opts?: Record<string, unknown>) => Promise<unknown> }
): Promise<void> => {
  try {
    await col.createIndex({ txid: 1 }, { unique: true })
  } catch (e) {
    throw new Error(
      '[mandala] FATAL: could not create the unique mandalaAdmissions index on txid. ' +
      'Without it "verdict wins" and the σ_I record are not single-valued, so the overlay ' +
      `must not start. Cause: ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

/**
 * FIX C — the engine's own durable proof that a txid went through a topic,
 * independent of whether a `mandalaAdmissions` row exists.
 */
export interface AppliedProof {
  /** `storage.doesAppliedTransactionExist({txid, topic: 'tm_mandala'})`. */
  wasApplied: (txid: string) => Promise<boolean>
  /** tm_mandala output indexes the engine stores for this txid, ascending. */
  storedOutputs: (txid: string) => Promise<number[]>
}

/** Identical on both engines — the wallet keys its "build a new spend" branch on it. */
export const EVICTED_DESCRIPTION = (txid: string): string =>
  `transaction ${txid} was admitted and later evicted; its inputs are spendable again`

/** FIX L race backstop (503, retryable) — never the final ERR_INPUT_SPENT. */
export const SPEND_CONFLICT_DESCRIPTION =
  'an input of this transaction was marked spent by another transaction while it was being admitted; retry'

export interface FinalVerdict {
  code: VerdictCode
  description: string
  spendTxid?: string
}

/**
 * "Verdict wins", payload-scoped (§9.1).
 *
 * `payloadHash` is the hash of the off-chain payload the CALLER presented.
 * A persisted refusal is replayed only when it matches `refusedPayloadHash`;
 * otherwise this returns null and the submission is evaluated fresh. Callers
 * that have no payload to present (a bare `GET /admin/admission/:txid`) pass
 * nothing, and per §9.3 fall through to the applied-proof check and then 404 —
 * a refusal is never served to someone who did not name the payload it is about.
 *
 * Eviction stays keyed by txid alone: it is a statement about the transaction
 * itself — it was admitted, then its inputs were restored — and no payload can
 * make those coins spendable by it again.
 */
export const finalVerdictOf = (
  txid: string, rec: AdmissionRecord | null | undefined, payloadHash?: string
): FinalVerdict | null => {
  if (rec == null) return null
  if (rec.evictedAt != null && rec.evictedAt !== '') {
    return { code: 'ERR_EVICTED', description: EVICTED_DESCRIPTION(txid) }
  }
  if (rec.refusedCode != null && FINAL_CODES.has(rec.refusedCode)) {
    if (payloadHash == null || rec.refusedPayloadHash !== payloadHash) return null
    return {
      code: rec.refusedCode,
      description: rec.refusedDescription ?? rec.refusedCode,
      spendTxid: rec.refusedSpendTxid
    }
  }
  return null
}

/**
 * "Verdict wins", enforced where it has to be — INSIDE the topic manager.
 *
 * The natural place would be a /submit pre-check, but OverlayExpress installs
 * its body parsers at the top of `start()`, after everything this repo
 * registers, so a middleware cannot read the BEEF before the engine runs. The
 * topic manager, by contrast, is handed the parsed BEEF as an argument and runs
 * before ANY mutation or broadcast — so refusing from here is what actually
 * stops an evicted txid being re-admitted for the same bytes, and what makes
 * two independent submitters converge on one answer.
 *
 * The refusal is thrown as a `FinalVerdictError`, which `SubmitSideChannel`
 * carries structurally to the /submit wrapper: ERR_EVICTED has no reason string
 * for the substring table to classify, so the code travels as data.
 */
export const withPersistedVerdict = (inner: TopicManager, store: AdmissionStore): TopicManager => {
  const guarded: TopicManager = {
    ...inner,
    identifyAdmissibleOutputs: async (beef: number[], previousCoins: number[], offChainValues?: number[]) => {
      let txid: string | null = null
      try {
        txid = Transaction.fromBEEF(beef).id('hex')
      } catch {
        // Un-parseable BEEF: nothing to key a verdict on, and the engine
        // rejects it on its own account.
      }
      if (txid != null) {
        // §9.5: the record read is the state this guard gates on. It used to be
        // swallowed, which fails OPEN — an evicted txid was re-admitted, and a
        // new σ_I minted over restored inputs, whenever Mongo blinked. It is now
        // an InfraError: 503, retryable, never persisted, never a 4xx.
        const rec = await infra('the admission record store', async () => await store.get(txid as string))
        const verdict = finalVerdictOf(txid, rec, payloadHashOfValues(offChainValues))
        if (verdict != null) throw new FinalVerdictError(verdict.code, verdict.description, verdict.spendTxid)
      }
      return await (inner.identifyAdmissibleOutputs as (
        b: number[], p: number[], o?: number[]
      ) => Promise<{ outputsToAdmit: number[], coinsToRetain: number[] }>)(beef, previousCoins, offChainValues)
    }
  }
  return new Proxy(guarded, {
    get: (target, prop, receiver) =>
      prop === 'identifyAdmissibleOutputs'
        ? Reflect.get(target, prop, receiver)
        : Reflect.get(target, prop, receiver) ?? Reflect.get(inner as object, prop)
  })
}

// ───────────────────────────── /submit wrapper ──────────────────────────────

export interface SubmitWrapDeps {
  priv: PrivateKey
  store?: AdmissionStore
  applied?: AppliedProof
  channel?: SubmitSideChannel
  /** §9.7 — released here when the request settles (the leak-guard half). */
  inFlight?: InFlightOutpoints
}

/** §9.4 — the finalize write failed, so the client must retry (503). */
export const FINALIZE_FAILED =
  'the admission was not recorded; the transaction may already be applied — retry to collect its signature'

interface ReqLike { path: string, method: string, body: unknown, headers: Record<string, unknown> }
interface ResLike { json: (b: unknown) => unknown, status?: (code: number) => unknown }

const bytesOf = (raw: unknown): number[] =>
  raw instanceof Uint8Array
    ? Array.from(raw)
    : Buffer.isBuffer(raw) ? Array.from(raw) : Array.isArray(raw) ? raw as number[] : []

const nowIso = (): string => new Date().toISOString()

/**
 * Wraps POST /submit. Installed with `app.use` BEFORE `configureEngine`, so it
 * is on the stack ahead of the route OverlayExpress registers in `start()`.
 *
 * `req.body` is read LAZILY, inside the response interceptor: OverlayExpress
 * installs its `bodyParser.raw` at the top of `start()`, i.e. AFTER everything
 * this file registers, so at middleware time the body is still an unparsed
 * stream. By the time the engine has produced a STEAK it is a Buffer. This is
 * also why "verdict wins" cannot be enforced here — see `withPersistedVerdict`,
 * which enforces it inside the topic manager, where the parsed BEEF is a
 * parameter rather than a request field.
 *
 * Response shapes (contract §2):
 *   200 — STEAK as today; the tm_mandala entry gains
 *         {outputsToAdmit, admissionSignature, admissionIdentityKey}
 *   400/409/410/503 — {status:'error', code, retryable, description, spendTxid?}
 */
export function wrapSubmitJson (deps: SubmitWrapDeps) {
  return (req: ReqLike, res: ResLike, next: () => void): void => {
    if (req.path !== '/submit' || req.method !== 'POST') {
      next()
      return
    }
    const origJson = res.json.bind(res)

    const send = (status: number, body: unknown): void => {
      if (status !== 200) res.status?.(status)
      origJson(body)
    }
    const sendVerdict = (v: FinalVerdict): void =>
      send(verdictFor(v.code).httpStatus, errorBody(v.code, v.description, v.spendTxid))

    const includesOffChain = (): boolean => req.headers['x-includes-off-chain-values'] === 'true'

    // §9.7 — this request's private capture scope. It is entered around next()
    // so every manager the engine calls records into it, AND kept here so the
    // response path reads from it directly: `res.json` is called by the pinned
    // route, and the ambient async context is not guaranteed to be ours by then.
    const scope = newSubmitScope()

    res.json = (body: unknown) => {
      void (async () => {
        const txid = txidFromSubmitBody(bytesOf(req.body), includesOffChain())
        try {
          await settle(body, txid)
        } catch (e) {
          // §9.5: an infra fault reaching this far is still never final.
          if (isInfraError(e)) {
            send(503, errorBody('ERR_UNAVAILABLE', e.message))
          } else {
            console.warn('[mandala] admission post-processing failed:', e)
            origJson(body)
          }
        } finally {
          // §9.7 leak-guard: whatever this request still holds is freed when it
          // ends. The compare-and-swap frees each outpoint earlier, as it marks
          // it spent; this covers every path that never reaches one.
          if (txid != null) deps.inFlight?.releaseAll(txid)
        }
      })()
      return res
    }
    runInSubmitScope(scope, () => { next() })

    /**
     * `refusingTopic` is the topic whose OWN manager produced `reason` — not
     * whatever the x-topics header claims the request carried.
     *
     * The rule ("persist only when the refusing verdict's topic is
     * tm_mandala") follows from §4's record model and §9.1: the header is the
     * submitter's own assertion and costs nothing to write, so a request
     * listing `["tm_mandala"]` whose refusal actually came from the registry
     * manager would otherwise persist a registry verdict on a token record, and
     * a later, genuine tm_mandala submission would be refused from it. Only tm_mandala's own verdict is a token
     * verdict, so only tm_mandala's own verdict is persisted.
     */
    const refuse = async (
      txid: string, reason: string, spendTxid: string | undefined, refusingTopic: string | undefined,
      payloadHash: string
    ): Promise<void> => {
      const code = classifyManagerReason(reason)
      if (deps.store != null && refusingTopic === TOKEN_TOPIC && FINAL_CODES.has(code)) {
        try {
          await deps.store.putRefusal({
            txid,
            refusedCode: code,
            refusedDescription: reason,
            refusedAt: nowIso(),
            // §9.1 — what this refusal is ABOUT. Without it the refusal would
            // apply to every future submission of the txid, payload or no.
            refusedPayloadHash: payloadHash
          })
        } catch (e) {
          // A refusal that fails to persist is simply re-derived next time; the
          // response is the same either way, so this stays best-effort.
          console.warn('[mandala] refusal persist failed:', e)
        }
      }
      send(verdictFor(code).httpStatus, errorBody(code, reason, spendTxid))
    }

    /**
     * A request the overlay could not interpret at all. Both signals are the
     * client's to fix and are deterministic, so they are 400 ERR_SHAPE rather
     * than a retryable 503 — but they are not manager verdicts, so they are
     * never persisted.
     */
    const requestProblem = (): string | null => {
      const header = req.headers['x-topics']
      if (typeof header !== 'string' || header === '') return 'Missing x-topics header'
      try {
        if (!Array.isArray(JSON.parse(header))) return 'x-topics must be a JSON array of topic names'
      } catch {
        return 'x-topics must be a JSON array of topic names'
      }
      if (txidFromSubmitBody(bytesOf(req.body), includesOffChain()) == null) {
        return 'could not decode the submitted BEEF or its off-chain framing'
      }
      return null
    }

    const settle = async (body: unknown, txid: string | null): Promise<void> => {
      // §9.1 — the payload THIS request presented, read from the raw body
      // exactly as the pinned route frames it.
      const payloadHash = payloadHashOfBody(bytesOf(req.body), includesOffChain())
      const isErrorBody = body != null && typeof body === 'object' && 'status' in (body as Record<string, unknown>)
      if (txid == null) {
        // Nothing to key on. If the engine also failed, this is framing or
        // payload — a request-level 400 that still carries the full body shape.
        if (isErrorBody) {
          const message = (body as { message?: unknown }).message
          send(400, requestErrorBody(
            typeof message === 'string' && message !== '' ? message : requestProblem() ?? 'malformed submission'
          ))
          return
        }
        origJson(body)
        return
      }
      const outcome = deps.channel?.take(txid, scope)

      // A verdict the wrapper carried structurally — an already-persisted final
      // verdict (withPersistedVerdict) or an InfraError (§9.5) — is replayed
      // verbatim rather than re-classified through the substring table, and is
      // never (re-)persisted from here.
      if (outcome?.verdict != null) {
        sendVerdict(outcome.verdict)
        return
      }
      const isObject = body != null && typeof body === 'object'

      // The pinned route's own catch-all: {status:'error', message}. A manager
      // reject never arrives this way (the engine swallows it into a STEAK), so
      // unless we captured one it is either a request-level fault (400) or
      // infrastructure (503).
      if (isErrorBody) {
        if (outcome?.reason != null) {
          await refuse(txid, outcome.reason, outcome.spendTxid, outcome.topic, payloadHash)
          return
        }
        const message = (body as { message?: unknown }).message
        const description = typeof message === 'string' && message !== '' ? message : 'overlay unavailable'
        const problem = requestProblem()
        send(problem != null ? 400 : 503, problem != null
          ? requestErrorBody(description)
          : errorBody('ERR_UNAVAILABLE', description))
        return
      }
      if (!isObject) {
        origJson(body)
        return
      }

      const steak = body as Steak
      const entry = steak[TOKEN_TOPIC]
      const admitted = entry?.outputsToAdmit ?? []

      if (admitted.length > 0) {
        const signed = attachAdmissionSignaturesSync(steak, txid, deps.priv)
        // FIX L, storage half. A compare-and-swap mark-spent that affected zero
        // rows means another still-admitted transaction got this coin first.
        // The engine runs that UPDATE after it has already answered, inside its
        // own swallowing try/catch, so it can only ever be a RACE BACKSTOP:
        // 503 (retryable), never a final 400. The authoritative answer is the
        // manager's own live-token-row guard, which mints 400 ERR_INPUT_SPENT
        // {spendTxid} on the retry — that is what the client converges on.
        const spent = outcome?.restore?.spentOutpoints ?? []
        const conflicted = (): boolean => deps.channel?.hadSpendConflict(spent, scope) === true
        if (!conflicted()) await persist(txid, signed, admitted, outcome?.restore)
        if (conflicted()) {
          send(503, errorBody('ERR_UNAVAILABLE', SPEND_CONFLICT_DESCRIPTION))
          return
        }
        origJson(signed)
        return
      }

      // Empty tm_mandala set: a swallowed manager reject, a dupe, or a genuine
      // nothing-to-admit — indistinguishable in the pinned engine's STEAK.
      if (outcome?.reason != null) {
        // …unless another topic DID admit something. The engine broadcasts and
        // mutates on any topic's acceptance, so turning that into a 4xx would
        // tell the submitter its already-broadcast transaction was refused.
        // Pass the STEAK through (tm_mandala stays unsigned, which is the
        // honest answer for the token half) and log the swallowed reason.
        const otherAdmitted = Object.keys(steak).some(t => t !== TOKEN_TOPIC && (steak[t]?.outputsToAdmit?.length ?? 0) > 0)
        if (!otherAdmitted) {
          await refuse(txid, outcome.reason, outcome.spendTxid, outcome.topic, payloadHash)
          return
        }
        console.warn(`[mandala] tm_mandala rejected ${txid} but another topic admitted; returning STEAK. Reason: ${outcome.reason}`)
        origJson(steak)
        return
      }

      const prior = deps.store != null ? await deps.store.get(txid).catch(() => null) : null
      const replay = finalVerdictOf(txid, prior, payloadHash)
      if (replay != null) {
        sendVerdict(replay)
        return
      }

      // FIX C — idempotent dupe. The engine short-circuits a re-submit on
      // doesAppliedTransactionExist before the manager ever runs, so a dupe and
      // a rejection look identical on the wire. Re-derive the admitted set from
      // the record, or (record missing/lost) from the engine's own stored
      // outputs, re-sign, and answer 200 with no side effects re-run.
      const dupe = await dupeOutputs(txid, prior)
      if (dupe != null) {
        // The dupe body carries the tm_mandala entry ALONE — the other topics'
        // entries in the engine's STEAK are all empty on a dupe and say nothing.
        // No side effects: no record write, no re-admission (contract §2).
        const dupeSteak: Steak = {
          [TOKEN_TOPIC]: { outputsToAdmit: dupe, coinsToRetain: [] }
        }
        attachAdmissionSignaturesSync(dupeSteak, txid, deps.priv)
        await finalizePending(txid, prior, dupeSteak, dupe)
        origJson(dupeSteak)
        return
      }

      origJson(steak)
    }

    const dupeOutputs = async (id: string, prior: AdmissionRecord | null): Promise<number[] | null> => {
      if (deps.applied == null) return null
      try {
        if (!(await deps.applied.wasApplied(id))) return null
        const fromRecord = prior?.outputsToAdmit ?? []
        if (fromRecord.length > 0) return [...fromRecord].sort((a, b) => a - b)
        const stored = await deps.applied.storedOutputs(id)
        return stored.length > 0 ? [...stored].sort((a, b) => a - b) : null
      } catch (e) {
        console.warn('[mandala] dupe-path derivation failed:', e)
        return null
      }
    }

    /**
     * §9.4, finalize half. A failure is an `InfraError` — 503 ERR_UNAVAILABLE —
     * rather than the swallowed warning it used to be.
     *
     * Swallowing it returned a 200 carrying a σ_I the overlay had no record of
     * ever issuing: the client banks the signature, the next
     * GET /admin/admission/:txid 404s, and an offline recipient walking the
     * coverage chain refuses a payment that was in fact admitted. The 503 is
     * honest and costs nothing, because the provisional record already made the
     * restore snapshot durable and the client's retry lands on the dupe path,
     * which re-derives the same deterministic signature from the engine's own
     * applied-transaction proof and finalizes the record then.
     */
    const persist = async (
      id: string, steak: Steak, outputsToAdmit: number[], restore?: AdmissionRestore
    ): Promise<void> => {
      if (deps.store == null) return
      const entry = steak[TOKEN_TOPIC] as unknown as Partial<AdmissionSignature>
      if (entry?.admissionSignature == null || entry.admissionIdentityKey == null) return
      const topics = Object.keys(steak).filter(t => (steak[t]?.outputsToAdmit?.length ?? 0) > 0)
      // AWAITED (§3.3b): a client holding a 200 is guaranteed the record is
      // durable, so GET /admin/admission/:txid cannot 404 behind its own
      // successful submit.
      await infra('the admission record store', async () => {
        await (deps.store as AdmissionStore).putAdmitted({
          txid: id,
          topics,
          outputsToAdmit: [...outputsToAdmit].sort((a, b) => a - b),
          admissionSignature: entry.admissionSignature as string,
          admissionIdentityKey: entry.admissionIdentityKey as string,
          at: nowIso(),
          restore
        })
      }).catch((e: unknown) => {
        throw new InfraError(FINALIZE_FAILED, e)
      })
    }

    /**
     * §9.4, crash-recovery half: a record left `pending: true` by a process that
     * died between the provisional write and the finalize is completed here,
     * from the engine's own applied-transaction proof. Best-effort — the client
     * already holds a valid, deterministic σ_I and the applied proof re-derives
     * it on every later GET, so a second failure changes nothing for it.
     */
    const finalizePending = async (
      id: string, prior: AdmissionRecord | null, steak: Steak, outputsToAdmit: number[]
    ): Promise<void> => {
      if (deps.store == null || prior?.pending !== true) return
      try {
        await persist(id, steak, outputsToAdmit, prior.restore)
      } catch (e) {
        console.warn(`[mandala] could not finalize the pending admission record for ${id}:`, e)
      }
    }
  }
}

export type { SubmitErrorBody }

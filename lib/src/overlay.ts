import { Beef, Utils, WalletInterface } from '@bsv/sdk'
import { TOPIC, OVERLAY_URL, OVERLAY_URL_UNSET, OVERLAY_IDENTITY_KEY } from './constants.js'
import { verifyAdmission } from './admission.js'
import { journalPut, journalRemove } from './txJournal.js'

export interface OverlayAdmitResult {
  /**
   * The submitted topic's own admitted output indexes — for a token submission
   * this is the `tm_mandala` entry's set, which is exactly what σ_I commits to
   * (admission.ts; FIX A). Never trust an admission for an output that is not
   * in here.
   */
  outputsToAdmit: number[]
  /** Overlay ECDSA signature over admissionDigestV2(txid, outputsToAdmit). */
  admissionSignature?: string
  admissionIdentityKey?: string
}

/**
 * The overlay's acceptance proof, threaded out of every pipeline that commits
 * a transaction (A12). Three fields travel together because σ_I is meaningless
 * without the set it signed over and the key that signed it.
 */
export interface AdmissionReceipt {
  admissionSignature?: string
  admissionIdentityKey?: string
  outputsToAdmit?: number[]
}

/** Narrow an OverlayAdmitResult to the receipt fields a pipeline returns. */
export function admissionReceipt (r: OverlayAdmitResult): AdmissionReceipt {
  return {
    admissionSignature: r.admissionSignature,
    admissionIdentityKey: r.admissionIdentityKey,
    outputsToAdmit: r.outputsToAdmit
  }
}

// ---------------------------------------------------------------------------
// Structured refusals — wire contract v2 §2 (FIX D)
// ---------------------------------------------------------------------------

/**
 * The overlay's verdict codes. Only the topic manager's own `reject(...)` may
 * produce a 4xx/409 code; everything else (SPV, storage, broadcast, sanctions
 * provider, unknown internal error) is ERR_UNAVAILABLE.
 */
export type OverlayErrorCode =
  | 'ERR_CONSERVATION' | 'ERR_LINKAGE' | 'ERR_SHAPE' | 'ERR_SATOSHIS' | 'ERR_INPUT_SPENT'
  | 'ERR_PAUSED' | 'ERR_FROZEN' | 'ERR_SANCTIONED' | 'ERR_ACCESS' | 'ERR_MEMBERSHIP'
  | 'ERR_EVICTED' | 'ERR_UNAVAILABLE'
  // Client-side, never sent by a server: an "admitted" answer whose σ_I is
  // missing (ERR_NO_ADMISSION) or does not verify under the configured overlay
  // identity key (ERR_BAD_ADMISSION). Retryable — the operator may simply have
  // rotated or misconfigured a key — but NEVER an admission.
  | 'ERR_NO_ADMISSION' | 'ERR_BAD_ADMISSION'

/**
 * Whether the same bytes may be re-submitted later and succeed. The table is
 * the wire contract's, not the server's: a server that mislabels a liftable
 * policy refusal as permanent must not be able to strand a payment, and one
 * that mislabels a permanent refusal as retryable must not make a wallet spin.
 * An unrecognised code falls back to whatever the body claimed.
 */
const RETRYABLE_BY_CODE: Record<string, boolean> = {
  ERR_CONSERVATION: false,
  ERR_LINKAGE: false,
  ERR_SHAPE: false,
  ERR_SATOSHIS: false,
  ERR_INPUT_SPENT: false,
  ERR_EVICTED: false,
  ERR_PAUSED: true,
  ERR_FROZEN: true,
  ERR_SANCTIONED: true,
  ERR_ACCESS: true,
  ERR_MEMBERSHIP: true,
  ERR_UNAVAILABLE: true,
  ERR_NO_ADMISSION: true,
  ERR_BAD_ADMISSION: true
}

/**
 * A structured refusal from `POST /submit` (wire contract §2).
 *
 * `retryable` is the only field callers should branch on for liveness: a
 * retryable refusal means the overlay's condition (pause, freeze, screening,
 * membership, or plain unavailability) can lift and the SAME transaction may
 * be submitted again — so its inputs must stay held. A non-retryable one is a
 * final verdict for these bytes, persisted server-side and served identically
 * to every later submitter of the same txid ("verdict wins").
 */
export class OverlayRefusedError extends Error {
  readonly code: string
  readonly retryable: boolean
  /** For ERR_INPUT_SPENT: the competing, still-admitted transaction. */
  readonly spendTxid?: string
  /** 0 when the request never produced a response (network fault). */
  readonly httpStatus: number

  constructor (p: { code: string, description?: string, retryable?: boolean, spendTxid?: string, httpStatus?: number }) {
    super(p.description != null && p.description !== '' ? `overlay refused (${p.code}): ${p.description}` : `overlay refused (${p.code})`)
    this.name = 'OverlayRefusedError'
    this.code = p.code
    this.retryable = RETRYABLE_BY_CODE[p.code] ?? p.retryable === true
    this.spendTxid = p.spendTxid
    this.httpStatus = p.httpStatus ?? 0
  }
}

/**
 * Map an HTTP status + raw body to a refusal. Only a body that actually
 * carries the contract's `{status:'error', code}` shape is trusted for its
 * code; a non-JSON body, an empty body, or an unexpected shape is
 * ERR_UNAVAILABLE/retryable — "not a manager verdict" is the contract's own
 * catch-all, and it is the direction that keeps a payment alive.
 */
export function overlayErrorFromResponse (httpStatus: number, body: string | null | undefined): OverlayRefusedError {
  let parsed: any
  try {
    parsed = body == null || body === '' ? undefined : JSON.parse(body)
  } catch {
    parsed = undefined
  }
  if (parsed?.status === 'error' && typeof parsed.code === 'string' && parsed.code !== '') {
    return new OverlayRefusedError({
      code: parsed.code,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      retryable: parsed.retryable === true,
      spendTxid: typeof parsed.spendTxid === 'string' ? parsed.spendTxid : undefined,
      httpStatus
    })
  }
  return new OverlayRefusedError({
    code: 'ERR_UNAVAILABLE',
    description: `overlay returned ${httpStatus} with no structured error body`,
    retryable: true,
    httpStatus
  })
}

/** Anything thrown below the facilitator that is not already a structured refusal. */
function asRefusal (e: unknown): OverlayRefusedError {
  if (e instanceof OverlayRefusedError) return e
  return new OverlayRefusedError({
    code: 'ERR_UNAVAILABLE',
    description: String((e as any)?.message ?? e),
    retryable: true,
    httpStatus: 0
  })
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

interface OverlayBroadcastFacilitator {
  send: (url: string, taggedBEEF: { beef: number[], topics: string[], offChainValues?: number[] }) => Promise<Record<string, OverlayAdmitResult>>
}

/** The slice of `Response` the facilitator needs (keeps it mockable + RN-safe). */
export interface OverlayFetchResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}
export type OverlayFetch = (url: string, init: any) => Promise<OverlayFetchResponse>

/**
 * The default `POST /submit` facilitator.
 *
 * Wire-identical to @bsv/sdk's `HTTPSOverlayBroadcastFacilitator` (same path,
 * headers and varint-framed off-chain-values body) but it READS the error
 * body: the SDK's facilitator throws a bare `Error('Failed to facilitate
 * broadcast')` for every non-2xx, which discards exactly the structured
 * verdict FIX D depends on. Uses `fetch` only — no Node built-ins.
 */
export function createOverlayFacilitator (fetchImpl?: OverlayFetch): OverlayBroadcastFacilitator {
  const doFetch: OverlayFetch = fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init))
  return {
    async send (url, taggedBEEF) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'X-Topics': JSON.stringify(taggedBEEF.topics)
      }
      let body: Uint8Array
      if (Array.isArray(taggedBEEF.offChainValues)) {
        headers['x-includes-off-chain-values'] = 'true'
        const w = new Utils.Writer()
        w.writeVarIntNum(taggedBEEF.beef.length)
        w.write(taggedBEEF.beef)
        w.write(taggedBEEF.offChainValues)
        body = new Uint8Array(w.toArray())
      } else {
        body = new Uint8Array(taggedBEEF.beef)
      }

      let response: OverlayFetchResponse
      try {
        response = await doFetch(`${url}/submit`, { method: 'POST', headers, body })
      } catch (e) {
        // Network fault — never a verdict, always retryable.
        throw asRefusal(e)
      }
      let text = ''
      try {
        text = await response.text()
      } catch { /* treat an unreadable body as no body */ }
      if (!response.ok) throw overlayErrorFromResponse(response.status, text)
      try {
        return JSON.parse(text)
      } catch (e) {
        throw new OverlayRefusedError({
          code: 'ERR_UNAVAILABLE',
          description: `overlay returned ${response.status} with an unparseable STEAK body`,
          retryable: true,
          httpStatus: response.status
        })
      }
    }
  }
}

export async function submitToOverlay (
  beef: number[],
  offChainValues?: number[],
  facilitator: OverlayBroadcastFacilitator = createOverlayFacilitator(),
  topics: string[] = [TOPIC]
): Promise<OverlayAdmitResult> {
  // Fail loudly: without configureMandala this would POST to a relative /submit.
  if (OVERLAY_URL === '') throw new Error(OVERLAY_URL_UNSET)
  const taggedBEEF = { beef, topics, offChainValues }
  let steak: Record<string, OverlayAdmitResult>
  try {
    steak = await facilitator.send(OVERLAY_URL, taggedBEEF)
  } catch (e) {
    // Every transport/HTTP failure reaches the caller as a structured verdict,
    // so a retryable fault is never mistaken for a permanent refusal (FIX D).
    throw asRefusal(e)
  }
  // The admitted set comes from the submitted topic's own STEAK entry
  // (`tm_mandala` for token traffic) — a registry-only admission must never be
  // read as a token admission.
  const topic = topics.map(t => steak[t]).find(t => (t?.outputsToAdmit?.length ?? 0) > 0) ?? steak[topics[0]]
  const admit = topic?.outputsToAdmit ?? []
  if (admit.length === 0) throw new Error('overlay rejected the transaction')
  const result: OverlayAdmitResult = {
    outputsToAdmit: admit,
    admissionSignature: topic?.admissionSignature,
    admissionIdentityKey: topic?.admissionIdentityKey
  }
  // σ_I speaks for the tm_mandala admitted set only (wire contract §1/§2):
  // neither overlay signs a registry-only admission, so demanding one there
  // refused every identity-chain action AFTER the overlay had already folded
  // and broadcast it (testnet, 2026-09-17). The registry chain is
  // authenticated by spending its live head, not by σ_I.
  if (topics.includes(TOPIC)) requireVerifiedAdmission(beef, result)
  return result
}

let warnedUnverifiable = false

/**
 * An admitted set is not an admission. Only the overlay operator's σ_I over
 * (txid, outputsToAdmit), verifying under the CONFIGURED overlay identity key,
 * proves the operator folded this transaction into its state — an answer
 * without one could come from a misconfigured node, a stale deployment or a
 * man in the middle, and a wallet that broadcast on it would put an
 * unadmitted transaction on chain (2026-09-15 review). So an unsigned or
 * unverifiable "admitted" answer is a retryable refusal, never a success.
 *
 * With no identity key configured the answer cannot be checked at all; the
 * host is warned once, and the call behaves as before. Every production host
 * configures the key (`configureMandala({ overlayIdentityKey })`).
 */
function requireVerifiedAdmission (beef: number[], r: OverlayAdmitResult): void {
  if (OVERLAY_IDENTITY_KEY === '') {
    if (!warnedUnverifiable) {
      warnedUnverifiable = true
      console.warn('[mandala] overlayIdentityKey is not configured: admission signatures cannot be verified')
    }
    return
  }
  const sig = r.admissionSignature
  const signer = r.admissionIdentityKey
  if (sig == null || sig === '' || signer == null || signer === '') {
    throw new OverlayRefusedError({
      code: 'ERR_NO_ADMISSION',
      description: 'the overlay admitted outputs but returned no admission signature',
      httpStatus: 200
    })
  }
  let txid: string
  try {
    const parsed = Beef.fromBinary(beef)
    txid = parsed.atomicTxid ?? parsed.txs[parsed.txs.length - 1].txid
  } catch {
    throw new OverlayRefusedError({ code: 'ERR_BAD_ADMISSION', description: 'could not read the submitted txid', httpStatus: 200 })
  }
  const ok =
    signer.toLowerCase() === OVERLAY_IDENTITY_KEY.toLowerCase() &&
    verifyAdmission({ txid, outputsToAdmit: r.outputsToAdmit, signature: sig, signerKey: signer })
  if (!ok) {
    throw new OverlayRefusedError({
      code: 'ERR_BAD_ADMISSION',
      description: 'the admission signature does not verify under the configured overlay identity key',
      httpStatus: 200
    })
  }
}

/**
 * Does a `createAction({ sendWith })` result PROVE the wallet posted the tx?
 *
 * A resolved promise does not (2026-09-15): a wallet whose storage deliberately
 * holds token requests for its own settlement drain returns a hold-shaped
 * result rather than throwing, and reading that as "broadcast" cleared the
 * 'accepted' journal entry while nothing had been sent. The BRC-100 contract
 * says the only evidence is a `sendWithResults` row for THIS txid whose status
 * is 'unproven' (posted, not yet proven) or 'sending' (posted, in flight);
 * 'failed', an unknown status, a missing row, a missing array, and any
 * differently-shaped result all mean "not posted, keep the entry".
 */
export function sendWithPosted (result: unknown, txid: string): boolean {
  const results = (result as { sendWithResults?: unknown })?.sendWithResults
  if (!Array.isArray(results)) return false
  const rows = results as Array<{ txid?: unknown, status?: unknown } | null>
  const match = rows.find(r => r?.txid === txid) ??
    // The batch was `sendWith: [txid]`, so a lone row the wallet did not label
    // with a txid can only be that one. Two unlabelled rows prove nothing.
    (rows.length === 1 && typeof rows[0]?.txid !== 'string' ? rows[0] : undefined)
  return match?.status === 'unproven' || match?.status === 'sending'
}

/**
 * Broadcast a previously-created `noSend` action now that the overlay has
 * accepted it. Synchronous (`acceptDelayedBroadcast: false`) so a broadcast
 * failure surfaces here rather than in a background process.
 *
 * Returns whether the wallet actually POSTED it (`sendWithPosted`). `false` is
 * not an error — the wallet may be holding the request on purpose — but it is
 * not a broadcast either, so the caller must keep its 'accepted' journal entry
 * and try again later.
 */
export async function broadcastAcceptedTx (wallet: WalletInterface, txid: string): Promise<boolean> {
  const res = await wallet.createAction({
    description: 'broadcast overlay-accepted tx',
    options: { sendWith: [txid], acceptDelayedBroadcast: false }
  })
  return sendWithPosted(res, txid)
}

/**
 * Broadcast errors that mean the network/wallet already has the tx — for
 * recovery purposes these ARE success (the journal entry can clear).
 */
export function isAlreadyBroadcast (e: unknown): boolean {
  return /already|known|duplicate|mempool|txn-already/i.test(String(e))
}

/**
 * Overlay-gated finalize. The transaction must already be created + signed with
 * `noSend` (built, not broadcast). Submit it to the overlay FIRST; only when the
 * overlay accepts (admits outputs) is it broadcast to the network. On rejection,
 * abort the action so its inputs are released for a retry, then rethrow — the
 * transaction never reaches the network.
 *
 * Resolves at the overlay-accept commit point: acceptance is the moment the
 * outcome is decided, so callers (and the UI) don't wait on the network
 * broadcast. The broadcast continues in the background under journal
 * protection — a failure keeps the 'accepted' entry and reconcileWallet
 * retries it; it must never be aborted (that would desync wallet from overlay).
 *
 * **Nothing is ever broadcast after an `OverlayRefusedError`** — retryable or
 * not, a refusal means the overlay has not folded these bytes into its state.
 *
 * **A RETRYABLE refusal does not abort the action.** Pause, freeze, screening,
 * membership and plain unavailability all lift; the same transaction may be
 * submitted again, and releasing its inputs would force a rebuild (and, for an
 * offline hand-over, invalidate evidence the counterparty already holds). The
 * error is rethrown with `retryable: true` so the caller can back off and
 * retry, and the action stays alive for it. Only a FINAL verdict (or any
 * non-refusal failure, e.g. an unconfigured overlay URL) aborts.
 *
 * `reference` is the `createAction` signableTransaction.reference; pass it for
 * signable actions so a rejected tx's inputs are released. Genesis/register
 * actions have no signable reference — omit it (only wallet-managed funding is
 * held, which the wallet reclaims).
 */
export async function submitAndBroadcast (
  wallet: WalletInterface,
  signed: { tx: number[], txid: string },
  offChainValues: number[] | undefined,
  reference?: string,
  facilitator?: OverlayBroadcastFacilitator,
  topics: string[] = [TOPIC]
): Promise<OverlayAdmitResult> {
  let admitted: OverlayAdmitResult
  try {
    admitted = await submitToOverlay(signed.tx, offChainValues, facilitator, topics)
  } catch (e) {
    // Retryable: keep the inputs held so the identical tx can be re-submitted
    // once the overlay's condition lifts.
    const retryable = e instanceof OverlayRefusedError && e.retryable
    if (retryable) {
      // §9.11. A live noSend action with NO durable record was the hole: the
      // caller is told "retry later", and if it never does (crash, tab closed,
      // user walks away) the inputs stay held by an action nothing remembers,
      // and the bulk sweep cannot tell it from an abandoned one. Journal the
      // refusal — with the exact bytes — BEFORE rethrowing, so reconcile can
      // re-submit it and, at RETRY_CAP, release the inputs.
      //
      // Awaited: a crash between this write and the rethrow must leave the
      // entry behind, not the error.
      await journalPut({
        txid: signed.txid,
        stage: 'retryable',
        at: Date.now(),
        code: (e as OverlayRefusedError).code,
        attempts: 0,
        ...(reference != null ? { reference } : {}),
        submit: {
          txHex: Utils.toHex(signed.tx),
          ...(offChainValues != null ? { offChainHex: Utils.toHex(offChainValues) } : {}),
          topics
        }
      })
    } else if (reference != null) {
      // Final refusal — release the held inputs.
      try {
        await wallet.abortAction({ reference })
      } catch {
        // Inputs still held by the dead action — journal so reconcileWallet
        // retries the abort on the next load instead of the asset vanishing.
        // Awaited: the entry must be durable before we hand the error back.
        await journalPut({ txid: signed.txid, stage: 'abort', reference, at: Date.now() })
      }
    }
    throw e
  }

  // Overlay has folded this tx into its state — from here the tx MUST reach the
  // network. Journal first, then broadcast in the background: the entry only
  // clears on success, so an interrupted/failed broadcast is retried by
  // reconcileWallet.
  //
  // THE COMMIT POINT. This write is awaited, so the broadcast provably does not
  // start until the 'accepted' entry has landed in the store — a crash in the
  // window between them is recoverable by construction (storage.test.ts holds
  // the write open and asserts createAction({sendWith}) has not been called).
  //
  // It also carries σ_I (A12): the acceptance proof lands durably here, at no
  // extra I/O, so a client that loses the overlay's admission record still
  // holds its own copy — and `offChainHex`, so a later OFFLINE hand-over can
  // forward this tx's linkage bytes verbatim (handover.ts).
  // `reference` rides along too: it is never used to abort an accepted tx (that
  // is forbidden), but it lets a host — and the reconcile sweep — recognise the
  // noSend action behind this txid as one the lib still owns.
  const linkageReceipt = offChainValues != null ? { offChainHex: Utils.toHex(offChainValues) } : {}
  await journalPut({
    txid: signed.txid,
    stage: 'accepted',
    at: Date.now(),
    ...(reference != null ? { reference } : {}),
    ...linkageReceipt,
    ...admissionReceipt(admitted)
  })
  void broadcastAcceptedTx(wallet, signed.txid)
    .then(async posted => {
      // ONLY a proven post clears the entry. A wallet that resolved without
      // posting (a storage hold) leaves the tx unbroadcast, and dropping the
      // entry there is what let the reconcile sweep abort an on-chain tx.
      if (posted) {
        await journalRemove(signed.txid)
        return
      }
      console.warn(
        `[mandala] overlay accepted ${signed.txid} but the wallet did not report it as posted ` +
        "(no sendWithResults status of 'unproven'/'sending'); keeping the 'accepted' entry for reconcile"
      )
    })
    .catch(async e => {
      if (isAlreadyBroadcast(e)) {
        // The network already has it — recovery complete, clear the entry.
        await journalRemove(signed.txid)
        return
      }
      console.warn(
        `[mandala] overlay accepted ${signed.txid} but broadcast failed; will retry via reconcile:`,
        e
      )
    })
  return admitted
}

/**
 * Holder → recipient FT transfer pipeline, extracted from the Send screen so
 * the UI layer only orchestrates state. Overlay-first: the tx is built and
 * signed `noSend`, submitted to the overlay (which evaluates the topic-manager
 * rules), and only broadcast to the network after acceptance — a rejection
 * aborts the action and releases its inputs (see submitAndBroadcast).
 *
 * Privacy shape: change is split across several outputs (see ftChange.ts —
 * the wallet-toolbox change-spread ported to token units) and output order is
 * randomized by the wallet, so an observer cannot tell recipient from change
 * by position or by amount. Final output indices are recovered by matching
 * locking scripts (matchOutputIndices) and the recipient learns theirs from
 * the messagebox body.
 *
 * Two rails share this pipeline (`mode`). The default `'submit'` rail is the
 * online one described above. The `'handover'` rail is OFFLINE: identical
 * bytes are built and signed, but NOTHING is contacted — no /submit, no
 * broadcast, no abort — and the recipient is handed the transaction plus the
 * admission evidence for its token ancestry (handover.ts) so it can verify
 * the payment itself and submit on its own schedule (offline settlement
 * §0.1). The payer may submit later, from its 'handed_over' journal entry,
 * via reconcile.
 *
 * Resolves at the overlay-accept commit point (submit mode only). The messagebox notification to
 * the recipient is awaited separately by the caller-visible `notified` flag —
 * a notify failure never fails the transfer (the tx is already final).
 */
import { Transaction, Beef, Utils, WalletInterface } from '@bsv/sdk'
import { MandalaToken } from '@bsv/templates'
import { BASKET, FT_PROTOCOL, MESSAGEBOX, TOPIC } from './constants.js'
import { walletMandalaUnlock } from './unlock.js'
import { revealLinkage, matchOutputIndices } from './tokens.js'
import {
  AdmissionReceipt, admissionReceipt, broadcastAcceptedTx, isAlreadyBroadcast, OverlayAdmitResult,
  OverlayRefusedError, submitAndBroadcast, submitToOverlay
} from './overlay.js'
import { encodeLinkagePayload } from './encoding.js'
import { changeCustomInstructions, prepareBlindedPayment, recipientCustomInstructions } from './blinding.js'
import { blindingPut } from './blindingJournal.js'
import { loadFtCandidates } from './ftCandidates.js'
import { selectFtInputs } from './ftSelect.js'
import { generateFtChange } from './ftChange.js'
import { journalIntentBegin, journalIntentEnd, journalPut, journalRemove } from './txJournal.js'
import {
  collectHandoverEvidence, derHex, EvidenceSource, HandoverBody, journalEvidenceSource
} from './handover.js'
import { notifyPut, notifyRemove, PendingNotification } from './notifyJournal.js'
import { tryWithLock } from './webLocks.js'
import { BusyError } from './singleFlight.js'

/**
 * Structural MessageBox surface (rather than the MessageBoxClient class) so
 * a consumer's own @bsv/message-box-client instance — or a mock — satisfies
 * it without nominal-type clashes across duplicated node_modules.
 */
export interface MessageBoxSender {
  sendMessage: (args: {
    recipient: string
    messageBox: string
    body: object
  }) => Promise<unknown>
}

export interface TransferParams {
  wallet: WalletInterface
  messageBoxClient: MessageBoxSender
  identityKey: string
  assetId: string
  amount: number
  recipientKey: string
  /**
   * `'submit'` (default) is the online rail this package has always shipped:
   * build noSend → submit to the overlay → broadcast on acceptance.
   *
   * `'handover'` is the OFFLINE rail (offline settlement §0.1): build and sign
   * exactly the same bytes, contact NOTHING, and hand the recipient the
   * transaction plus the admission evidence for its token ancestry. The
   * RECIPIENT submits (rule 3); this payer may also submit later when it is
   * next online (rule 6), which reconcile.ts does from the 'handed_over'
   * journal entry. The default is unchanged so existing hosts are untouched.
   */
  mode?: 'submit' | 'handover'
  /**
   * Where `'handover'` mode gets its admission/linkage evidence. Defaults to
   * the lib's own journals (`journalEvidenceSource`); a host with a durable
   * settlement store should inject its own. Ignored in `'submit'` mode.
   */
  evidence?: EvidenceSource
  /**
   * Maintainer refinement to the `'handover'` rail (spec §4.3 step 7 / wire
   * contract §9.13): hand-over stays first and inviolable — nothing here ever
   * gates or fails the MessageBox post — but once it is ACKNOWLEDGED, an
   * online payer may submit the identical journaled bytes immediately rather
   * than waiting for reconcile's next pass. Default `false` (unchanged
   * behaviour: the payer submits later, via reconcile, exactly as before).
   * Ignored in `'submit'` mode, which already submits inline.
   *
   * The recipient's own submit stays valid regardless — `/submit` is
   * idempotent — so this is purely a latency improvement, never a
   * correctness dependency.
   */
  submitAfterHandover?: boolean
  /**
   * The sender's own note for this payment. Overrides the fixed
   * `Send ${amount} of ${assetId}` action description, and rides on the
   * MessageBox body (as `note`) so the recipient's own credited action can
   * show it too, in place of its own fixed `Receive ${amount} of ${assetId}`
   * wording — mirroring how a nearby/local rail's payment frame already
   * carries a sender's note. Trimmed; blank and absent are treated alike.
   */
  note?: string
}

/**
 * Extends AdmissionReceipt: the overlay's σ_I over
 * `admissionDigestV2(txid, outputsToAdmit)`, the key that signed it and the
 * admitted set it commits to. All three are needed to verify it — see
 * admission.ts — so they always travel together.
 */
export interface TransferResult extends AdmissionReceipt {
  txid: string
  /**
   * The `createAction` signableTransaction reference behind this send, on BOTH
   * rails. A host that keeps its own noSend bookkeeping needs it to map
   * reference → txid: without it, the only way to tell a live action from an
   * abandoned one is to guess (2026-09-15). Absent only if the wallet returned
   * no signable transaction at all.
   */
  reference?: string
  /** False when the tx committed but the recipient messagebox notify failed. */
  notified: boolean
  /** The signed AtomicBEEF bytes — identical to what was submitted to the overlay. */
  atomicBeef: number[]
  /** The exact off-chain linkage payload bytes submitted alongside `atomicBeef` for this tx. */
  offChainValues: number[]
  /**
   * True when this was a `'handover'` send: the overlay has NOT seen these
   * bytes and nothing has been broadcast. Absent (never false) on the
   * ordinary submit path, so existing consumers are unaffected.
   */
  handedOver?: true
  /**
   * Present only when `submitAfterHandover` was requested on a `'handover'`
   * send AND the message was posted successfully (the immediate submit never
   * runs otherwise). `true` once the payer's own immediate resubmit landed —
   * the overlay admitted these bytes and the journal entry was promoted
   * `'handed_over'` → `'accepted'` — at which point `admissionSignature`,
   * `admissionIdentityKey` and `outputsToAdmit` above are this submit's
   * receipt. `false` when it did not land (a retryable refusal, a network
   * fault, or a FINAL refusal — see `refusedCode`): the `'handed_over'` entry
   * is left exactly as it would be without `submitAfterHandover`, for
   * reconcile (or the recipient's own submit) to settle later.
   */
  settled?: boolean
  /**
   * Set only when the immediate post-hand-over submit hit a FINAL (verdict,
   * non-retryable) refusal. The `'handed_over'` entry is still kept — never
   * aborted here, since the recipient may already hold evidence over these
   * exact bytes — and the payer's own reconcile pass is what eventually gives
   * up, at RETRY_CAP, exactly as it would without this option.
   */
  refusedCode?: string
}

export async function transferTokens (p: TransferParams): Promise<TransferResult> {
  // Cross-tab serialization: the in-process sendFlight latch can't see a send
  // running in another tab of the same wallet; the web lock can. Never queue —
  // a concurrent send is a double-submit and must fail fast.
  const { acquired, result } = await tryWithLock('mandala.send', async () =>
    await transferPipeline(p)
  )
  if (!acquired || result == null) {
    throw new BusyError('Send already in progress in another tab')
  }
  return result
}

async function transferPipeline (p: TransferParams): Promise<TransferResult> {
  const { wallet, messageBoxClient, identityKey, assetId, amount, recipientKey } = p
  const handover = p.mode === 'handover'
  const note = p.note?.trim() || undefined

  // Token-aware coin selection: confirmed-first, fewest UTXOs (see ftSelect).
  const { candidates, beef: beefBytes } = await loadFtCandidates(wallet as any, assetId)
  const { selected, total: gathered } = selectFtInputs(candidates, amount) // throws if insufficient
  const beef = new Beef()
  beef.mergeBeef(beefBytes)
  const inputs = selected.map(s => ({ outpoint: s.outpoint, unlockingScriptLength: 108, inputDescription: 'spend FT' }))
  const spendInfo = selected.map(s => ({ keyID: s.keyID, counterparty: s.counterparty }))
  const change = gathered - amount

  // Split change across several outputs, spreading the per-asset UTXO pool
  // toward its target size exactly as the toolbox does for satoshis.
  const changeAmounts = generateFtChange({
    change,
    poolCount: candidates.length,
    inputCount: selected.length
  })

  const stamp = Date.now()
  const keyIDOut = 'xfer-' + stamp
  // Blind the sender identity toward the recipient (A′ = A + rG). r stays
  // sender-local — never on the recipient output, never in the remittance.
  const blinded = await prepareBlindedPayment(wallet as any, {
    identityKey,
    recipientKey,
    keyID: keyIDOut
  })
  const ftOut = new MandalaToken(wallet as any).lock(assetId, amount, blinded.pubKeyHash)
  const recipientScript = ftOut.toHex()

  // One keyID per change output (the loop index keeps same-millisecond keyIDs
  // unique — colliding keyIDs would reuse keys and produce byte-identical
  // scripts, breaking index matching below).
  const changePlans: Array<{ keyID: string, amount: number, script: string }> = []
  for (let i = 0; i < changeAmounts.length; i++) {
    const keyID = `change-${stamp}-${i}`
    // Change back to self: use our identity key (hex), not the literal 'self' —
    // the overlay parses linkage.counterparty as a public key (it echoes verbatim).
    const script = await new MandalaToken(wallet as any).lockBRC29(assetId, changeAmounts[i], FT_PROTOCOL, keyID, identityKey)
    changePlans.push({ keyID, amount: changeAmounts[i], script: script.toHex() })
  }

  const outputs: any[] = [{
    satoshis: 1,
    lockingScript: recipientScript,
    outputDescription: 'FT to recipient',
    customInstructions: recipientCustomInstructions({
      keyID: keyIDOut,
      recipientKey,
      senderBlinded: blinded.senderBlinded
    }),
    tags: ['mandala', 'sent', assetId]
  }]
  for (const plan of changePlans) {
    outputs.push({
      satoshis: 1,
      lockingScript: plan.script,
      outputDescription: 'FT change',
      basket: BASKET,
      // direction/recipient/sentAmount give history classification the send
      // context even when the recipient output (not basket-tracked) drops out
      // of listActions — change outputs are the ones the wallet always keeps.
      // Every change output carries the FULL sentAmount (history reads the
      // first one it finds; per-output values would under-report).
      customInstructions: changeCustomInstructions({
        keyID: plan.keyID,
        identityKey,
        recipientKey,
        sentAmount: amount,
        r: blinded.r,
        senderBlinded: blinded.senderBlinded
      })
    })
  }

  // From createAction until the overlay outcome is journaled, this pipeline
  // holds a live noSend action the reconcile sweep must not abort — the
  // intent entry is the shared-journal marker that keeps the sweep away
  // (including sweeps from other tabs).
  let txid: string
  let recipientIndex: number
  let signedTx: number[]
  let offChainValuesOut: number[]
  let receipt: AdmissionReceipt = {}
  let handoverExtras: Pick<HandoverBody, 'v' | 'kind' | 'linkage' | 'admissions'> | undefined
  let reference: string | undefined
  const intent = await journalIntentBegin()
  try {
    const created = await wallet.createAction({
      description: note ?? `Send ${amount} of ${assetId}`,
      // The recipient key rides as an action label: output customInstructions
      // are erased when the output is later spent/relinquished, but labels stay
      // with the action for good — history reads the counterparty from here.
      labels: ['mandala', 'transfer', `to-${recipientKey.toLowerCase()}`],
      inputBEEF: beef.toBinary(),
      inputs,
      outputs
      // No randomizeOutputs:false — let the wallet shuffle output order so
      // position reveals nothing about which output pays the counterparty.
    })

    if (!created.signableTransaction) throw new Error('createAction returned no signableTransaction')
    reference = created.signableTransaction.reference

    const tx = Transaction.fromBEEF(created.signableTransaction.tx as number[])

    // Recover where the shuffle put each planned output.
    const [rIndex, ...changeIndices] =
      matchOutputIndices(tx, [recipientScript, ...changePlans.map(c => c.script)])
    recipientIndex = rIndex

    // Input order is caller order (randomizeOutputs only shuffles outputs).
    for (let i = 0; i < spendInfo.length; i++) {
      tx.inputs[i].unlockingScriptTemplate = walletMandalaUnlock(wallet as any, spendInfo[i].keyID, spendInfo[i].counterparty)
    }
    await tx.sign()

    const spends: Record<string, { unlockingScript: string }> = {}
    for (let i = 0; i < spendInfo.length; i++) {
      const hex = tx.inputs[i].unlockingScript?.toHex()
      if (!hex) throw new Error(`Missing unlocking script for input ${i}`)
      spends[String(i)] = { unlockingScript: hex }
    }

    const signed = await wallet.signAction({
      reference: created.signableTransaction.reference,
      spends,
      options: { noSend: true } // hold — broadcast only after the overlay accepts
    })

    // Build offChain linkage payload. Every FT output needs its own entry (an
    // unlinked FT output is skipped by the overlay and breaks conservation);
    // inputs are revealed so the overlay can screen senders under access mode
    // (A6 gate 3). The reveals are independent wallet calls — run them together.
    const [linkOut, ...restLinks] = await Promise.all([
      Promise.resolve(blinded.linkage),
      ...changePlans.map(async c => await revealLinkage(wallet as any, c.keyID, identityKey)),
      ...spendInfo.map(async s => await revealLinkage(wallet as any, s.keyID, s.counterparty))
    ])
    const changeLinks = restLinks.slice(0, changePlans.length)
    const inputLinks = restLinks.slice(changePlans.length)
    const outLinks = [
      { index: recipientIndex, linkage: linkOut },
      ...changeLinks.map((linkage, i) => ({ index: changeIndices[i], linkage }))
    ]
    const inLinks = inputLinks.map((linkage, i) => ({ index: i, linkage }))
    offChainValuesOut = encodeLinkagePayload({ inputs: inLinks, outputs: outLinks })
    // Overlay gates: submit first; broadcast only on acceptance, else abort + throw.
    signedTx = signed.tx as number[]
    txid = signed.txid ?? Transaction.fromBEEF(signedTx).id('hex')
    await blindingPut({
      txid,
      r: blinded.r,
      senderBlinded: blinded.senderBlinded,
      recipient: recipientKey,
      keyID: keyIDOut,
      at: Date.now()
    })
    if (handover) {
      // OFFLINE. No submitToOverlay, no broadcast, and — critically — no abort
      // of the held inputs: the recipient is about to hold evidence over these
      // exact bytes, so releasing the inputs would invalidate a payment that
      // has already been made.
      //
      // The tip's ancestry is read back out of the signed AtomicBEEF rather
      // than from the pipeline's own selection, so the evidence walk sees
      // exactly the graph the recipient will see.
      const tipTx = Transaction.fromAtomicBEEF(signedTx)
      const { linkage, admissions } =
        await collectHandoverEvidence(tipTx, assetId, p.evidence ?? journalEvidenceSource())
      // The tip is itself unadmitted, so it belongs in `linkage` (§1.1: one
      // entry per unbroadcast token tx in the chain) — without its own
      // off-chain payload the recipient could not build its /submit body.
      linkage.set(txid, offChainValuesOut)
      handoverExtras = {
        v: 2,
        kind: 'handover',
        linkage: [...linkage].map(([t, payload]) => ({ txid: t, payload })),
        admissions: [...admissions].map(([t, a]) => ({
          txid: t,
          outputsToAdmit: [...a.outputsToAdmit],
          signature: derHex(a.signature),
          signerKey: a.signerKey
        }))
      }
      // Durable BEFORE the message goes out: a crash after the payee has the
      // bytes but before this lands would leave a live noSend action nothing
      // remembers — the bulk sweep would abort it and un-pay the payee.
      await journalPut({
        txid,
        stage: 'handed_over',
        at: Date.now(),
        reference: created.signableTransaction.reference,
        offChainHex: Utils.toHex(offChainValuesOut),
        submit: {
          txHex: Utils.toHex(signedTx),
          offChainHex: Utils.toHex(offChainValuesOut),
          topics: [TOPIC]
        }
      })
    } else {
      const admitted = await submitAndBroadcast(wallet as any, { tx: signedTx, txid }, offChainValuesOut, created.signableTransaction.reference)
      receipt = admissionReceipt(admitted)
    }
  } finally {
    // Outcome is now journaled ('accepted'/'abort') or the action settled —
    // the intent marker has done its job either way.
    await journalIntentEnd(intent)
  }

  // The tx is committed (overlay accepted); a notify failure must not undo it.
  // Journal the notification FIRST so a crash or send failure here is retried
  // by reconcileNotifications — otherwise the recipient never learns about
  // their on-chain output. Duplicate delivery is safe (receive acks by
  // messageId and treats an already-internalized output as success).
  const notification: PendingNotification = {
    txid,
    recipient: recipientKey,
    messageBox: MESSAGEBOX,
    body: {
      ...(handoverExtras ?? {}),
      ...(note != null ? { note } : {}),
      assetId,
      amount,
      transaction: signedTx,
      keyID: keyIDOut,
      // With randomized output order the recipient can no longer assume
      // their output sits at index 0 — tell them where it landed.
      outputIndex: recipientIndex,
      protocolID: FT_PROTOCOL,
      // Remittance shows A′, not A — Bob derives against this and cannot
      // join later payments. r is not included.
      sender: blinded.senderBlinded,
      senderMode: 'blinded',
      // FIX H / §4.5: the handle rail's sender submits online, so it already
      // holds the tip's own acceptance proof — forward it so the recipient can
      // credit without waiting for its own overlay round-trip. Optional by
      // design: a recipient that cannot verify it treats it as ABSENT (never
      // as a decline), and legacy bodies simply do not carry it.
      ...(receipt.admissionSignature != null && receipt.admissionIdentityKey != null
        ? {
            admission: {
              txid,
              outputsToAdmit: receipt.outputsToAdmit ?? [],
              signature: receipt.admissionSignature,
              signerKey: receipt.admissionIdentityKey
            }
          }
        : {})
    },
    at: Date.now()
  }
  await notifyPut(notification)
  let notified = true
  try {
    await messageBoxClient.sendMessage({
      recipient: notification.recipient,
      messageBox: notification.messageBox,
      body: notification.body
    })
    await notifyRemove(txid)
  } catch (e) {
    console.warn('[mandala] transfer committed but recipient notify failed; will retry via reconcileNotifications:', e)
    notified = false
  }

  // Maintainer refinement (spec §4.3 step 7 / wire contract §9.13): hand-over
  // is already done and acknowledged (`notified`) — order is inviolable, so
  // this only ever runs AFTER that, and never turns the hand-over's own
  // success into a caller-visible failure. `notified === false` (the box was
  // down) leaves this untouched; the payer's next reconcile pass covers it,
  // exactly as it would without this option.
  const settleResult = (handover && p.submitAfterHandover === true && notified)
    ? await attemptImmediateSubmit(wallet, txid, signedTx, offChainValuesOut, reference)
    : {}

  return {
    txid,
    ...(reference != null ? { reference } : {}),
    notified,
    atomicBeef: signedTx,
    offChainValues: offChainValuesOut,
    ...(handover ? { handedOver: true as const } : {}),
    ...receipt,
    ...settleResult
  }
}

/**
 * The immediate half of the maintainer's hand-over-first-submit-second
 * refinement (spec §4.3 step 7, wire contract §9.13). Called only after the
 * hand-over message has already been posted and acknowledged — never before,
 * and its own outcome never throws, because by this point the payment has
 * already been made to the recipient.
 *
 * Shares its commit point with `submitAndBroadcast` (write the `'accepted'`
 * entry, carrying σ_I, before broadcasting) but its failure handling is
 * deliberately different: the recipient may already hold evidence over these
 * exact bytes (handover.ts), so NOTHING here may ever release the held
 * inputs. A retryable refusal, a network fault, or even a FINAL refusal all
 * leave the `'handed_over'` entry exactly as it was — reconcile's existing
 * `'handed_over'` handling (identical to `'retryable'`) is what keeps
 * re-submitting it, and its RETRY_CAP is what eventually gives up.
 */
async function attemptImmediateSubmit (
  wallet: WalletInterface,
  txid: string,
  signedTx: number[],
  offChainValues: number[],
  reference: string | undefined
): Promise<Pick<TransferResult, 'settled' | 'refusedCode'> & AdmissionReceipt> {
  let admitted: OverlayAdmitResult
  try {
    admitted = await submitToOverlay(signedTx, offChainValues, undefined, [TOPIC])
  } catch (e) {
    if (e instanceof OverlayRefusedError && !e.retryable) {
      // FINAL verdict — still never abort here (see class doc); surface the
      // code and leave the 'handed_over' entry for reconcile's RETRY_CAP.
      return { settled: false, refusedCode: e.code }
    }
    // Retryable refusal, or any other failure (network fault, unconfigured
    // overlay, …) — leave 'handed_over' untouched; reconcile retries it.
    return { settled: false }
  }

  const receipt = admissionReceipt(admitted)
  await journalPut({
    txid,
    stage: 'accepted',
    at: Date.now(),
    ...(reference != null ? { reference } : {}),
    offChainHex: Utils.toHex(offChainValues),
    ...receipt
  })
  // Immediate, not left for a later reconcile tick — but still best-effort in
  // the background: the 'accepted' entry is already the durable commit point,
  // and a broadcast failure here is retried by reconcile exactly like any
  // other 'accepted' entry.
  void broadcastAcceptedTx(wallet, txid)
    .then(async posted => {
      // Only a proven post clears the entry: a wallet that resolved without
      // posting has not broadcast anything (2026-09-15).
      if (posted) { await journalRemove(txid); return }
      console.warn(
        `[mandala] immediate post-hand-over submit accepted ${txid} but the wallet did not report it as ` +
        "posted; keeping the 'accepted' entry for reconcile"
      )
    })
    .catch(async e => {
      if (isAlreadyBroadcast(e)) { await journalRemove(txid); return }
      console.warn(
        `[mandala] immediate post-hand-over submit accepted ${txid} but broadcast failed; will retry via reconcile:`,
        e
      )
    })
  return { settled: true, ...receipt }
}

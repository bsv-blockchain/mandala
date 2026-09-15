> Source: `/private/tmp/claude-502/-Users-personal-git-demos-mandala/1d8c5cb1-3448-49bc-b255-3df7840f24b8/scratchpad/offline-settlement-final.md` · Copied 2026-09-15. Spec of record; companions: `2026-09-15-mandala-stablecoin-ux-design.md`, `2026-09-15-mandala-wire-contract-v2.md`.

# Offline settlement — definitive mechanics spec

Date: 2026-09-14. Status: DEFINITIVE — folds the maintainer's settlement model into
the committed PaymentFrame v3 design and the agreed UX design, replacing every
part of both that assumed the payer submits before hand-over.

Path legend: `L/` = `/Users/personal/git/demos/mandala/lib/src/`,
`OG/` = `/Users/personal/git/demos/mandala/overlay-go/internal/`,
`O/` = `/Users/personal/git/demos/mandala/overlay/src/`,
`W/` = `/Users/personal/git/bsv-wallet/packages/expo-wallet-toolbox/`,
`design-v3` = `bsv-wallet/docs/superpowers/specs/2026-07-31-token-payment-frame-v3-design.md`,
`ux` = the agreed UX design (`2026-09-15-mandala-stablecoin-ux-design.md`).

All file:line citations below were re-read from the trees on 2026-09-14, not
copied from the three input design documents, except where explicitly marked
"(per review)" for a claim I did not re-verify byte-for-byte but that three
independent adversarial reviews reproduced identically.

**Live regression noticed while drafting this spec, not caused by it:**
`L/overlay.ts:109` currently reads `void journalPut({ txid, stage: 'accepted', at })`
followed immediately by `void broadcastAcceptedTx(...)`. The adjacent comment
block (`:100-108`) still says *"THE COMMIT POINT. This write is awaited, so the
broadcast provably does not start until the 'accepted' entry has landed in the
store"* and cites a test that "holds the write open and asserts
`createAction({sendWith})` has not been called." As written today the write is
**not** awaited, so that invariant is false and the crash-safety argument this
spec's §5 (rule 6, payer's optional submit) leans on for the *lib's own* commit
point no longer holds. This looks like an accidental regression against the
file's own documented contract, not a deliberate change — flagging it rather
than reverting it (see also Open Question 12).

---

## 0. Scope and how every finding is closed

Three designs were attacked by three lenses each (9 write-ups, ~30 named
findings). Almost all of them collapse into **13 root-cause fixes** — the same
handful of code paths were found broken independently, under different
framings, by different lenses. §0.2 is the master index: every named finding
maps to one or more of these fixes, and every fix is specified in full in
§§1–4 and §8.

### 0.1 The settled model (verbatim, not re-argued)

1. Payer hands the transaction to the recipient together with the overlay's
   admission signature (σ_I) **for each input txid**.
2. **Recursive fallback.** If no σ_I is available for an input txid, the payer
   supplies σ_I for **all of that transaction's own input txids** instead —
   the same walk-back BEEF already does for Merkle paths. This is what makes
   chained offline transactions work.
3. **The recipient submits** the transaction to the overlay — not the payer.
4. Only once the overlay returns *accepted*, with a **new** σ_I over the
   **new** txid, does the recipient broadcast via Arcade, as a normal tx.
5. The recipient acks the payment back to the sender if reachable (nearby
   while online, else via message box).
6. The payer **may also** submit when online, because they want their change
   spendable promptly. This requires `/submit` to be **idempotent** and to
   return an admission signature on re-submission.

### 0.2 Finding-closure index

Every finding below is closed by the numbered ROOT FIX (§0.3); "n/a" rows are
findings that were checked and are **not** regressions this spec introduces —
each says why.

| # | Design (lens) | Severity | One-line finding | Closed by |
|---|---|---|---|---|
| EB-1 | evidence-bundle (theft) | fatal | Un-linked sibling token output silently skipped; conservation summed only over the admitted subset → mint arbitrary value in a genuinely-admitted tx | **FIX A** |
| EB-1a | evidence-bundle (theft) | secondary | Payer trusts ack `s` by shape only; forged σ stops the payer's own submit forever while the tx still broadcasts | **FIX H** |
| EB-1b | evidence-bundle (theft) | secondary | `/arc-ingest` has no auth when no callback token is configured → anyone can evict an admitted tx | **FIX E** |
| EB-2.1 | evidence-bundle (liveness) | fatal | Eviction of an admitted spend never restores the spent input once the spent-input guard exists | **FIX E** |
| EB-2.2 | evidence-bundle (liveness) | serious | Wallet treats a liftable refusal (pause/freeze/allowlist) as permanent while the overlay's condition later lifts → split-brain | **FIX D** |
| EB-2.3 | evidence-bundle (liveness) | serious | Coins admitted before the admission-record feature existed can never get σ_I | **FIX C** |
| EB-3.1 | evidence-bundle (crash) | fatal-in-mechanics | Payer's own optional submit (rule 6) never runs for a nearby token payment: `parked→handed_over` is `INSERT OR IGNORE`, a silent no-op | **FIX F** |
| EB-3.2 | evidence-bundle (crash) | serious | Admission gate fails open; evidence-before-queue ordering unspecified across two connections | **FIX G** |
| EB-3.3 | evidence-bundle (crash) | serious | Counterparty-supplied σ written as `settled` with no signature verification | **FIX H** |
| EB-3.4 | evidence-bundle (crash) | serious | Cancel-by-respend requires exactly what's forbidden and has an unrecoverable branch | **FIX J** |
| EB-3.5 | evidence-bundle (crash) | serious | `ERR_INPUT_SPENT` classified permanent; a mid-commit storage fault can produce a false permanent failure | **FIX D** |
| SC-1 | store-centric (theft) | fatal | "mined ⇒ admitted" bottom lets an unlimited unadmitted forgery be credited offline with zero σ_I on the wire | **FIX B** (needs FIX A too) |
| SC-2.1 | store-centric (liveness) | serious | Both engines broadcast *inside* Submit; a broadcast failure is indistinguishable on the wire from a policy refusal → permanent strand on a transient fault | **FIX D** |
| SC-2.2 | store-centric (liveness) | serious | σ_I can never be obtained for an already-applied txid whose admission record is missing | **FIX C** |
| SC-2.3 | store-centric (liveness) | serious | An unconfirmed BSV fee parent is treated as needing σ_I coverage → common-case offline refusal | **FIX K** |
| SC-2.4 | store-centric (liveness) | smaller | `evicted:true` misread as accepted → infinite rebroadcast of a dead tx | **FIX E** |
| SC-3.1 | store-centric (crash) | fatal | `admitStep` verdict mapping unsound on both overlays (Go: every error is 400; TS: a real rejection is swallowed into 200-empty) | **FIX D** |
| SC-3.2 | store-centric (crash) | serious | "One SQLite transaction" cannot be built as cited (two connections) | **FIX G** |
| SC-3.3 | store-centric (crash) | fatal | An online recipient never enters the drain at all — `attemptToPostReqsToNetwork`'s online branch bypasses the admission gate structurally | **FIX F** |
| SC-3.4 | store-centric (crash) | serious | No "applied ⇒ admitted" reconciliation for a lost admission record | **FIX C** |
| SM-1 | state-machine (theft) | fatal | Un-linked *sibling* output riding one real admission → unbounded cross-asset counterfeit, independently confirms EB-1 | **FIX A** |
| SM-1a | state-machine (theft) | secondary | Overlay doesn't itself refuse a conflicting spend; relies on Arcade's race | **FIX L** |
| SM-1b | state-machine (theft) | secondary | Drain pseudo-code submits `parked` rows, contradicting its own doctrine | **FIX F** |
| SM-2.1 | state-machine (liveness) | fatal | Non-monotonic refusal: a transient 400 observed by one party is final locally while the other party gets the same tx admitted later | **FIX D** |
| SM-2.2 | state-machine (liveness) | serious | `held` has no owner until internalize succeeds; internalize can exhaust its retry ceiling on a retriable header failure | **FIX I** |
| SM-2.3 | state-machine (liveness) | serious | Evidence-write placed inside a "decline on throw" block turns a persisted hand-over into a wrongful decline | **FIX G** |
| SM-2.4 | state-machine (liveness) | serious | No named terminal/timeout for a permanently-absent overlay | **FIX M** |
| SM-3.1 | state-machine (crash) | fatal | An **online** payer broadcasts *before* the overlay ever sees the tx (`finalizeDelivery`→`broadcastPayment`, bypasses every hold) | **FIX F** |
| SM-3.2 | state-machine (crash) | fatal | `parked→handed_over` is a silent no-op (same as EB-3.1, independently found) | **FIX F** |
| SM-3.3 | state-machine (crash) | serious | Same verdict-unsoundness as SC-3.1, found independently a third time | **FIX D** |
| SM-3.4 | state-machine (crash) | serious | Same evidence-write-ordering hazard as EB-3.2/SC-3.2, found independently a third time | **FIX G** |
| SM-3.5 | state-machine (crash) | minor | Online `cancelParkedPayment` never checks the admission record before aborting | **FIX J** |

Three of the nine write-ups found the **identical root cause** independently
(the phantom-coin/sibling-mint hole: EB-1, SM-1, and SC-1's exploit also
depends on it), and three found the **identical root cause** independently a
second time (verdict-classification unsoundness: EB-2.2/EB-3.5, SC-2.1/SC-3.1,
SM-2.1/SM-3.3), and a third time (evidence-write ordering: EB-3.2, SC-3.2,
SM-2.3/SM-3.4), and a fourth time (payer/online-path never actually submits:
EB-3.1, SC-3.3, SM-1b/SM-3.1/SM-3.2). That convergence is why §0.3's fix list
is short even though the finding list is long.

### 0.3 The 13 root fixes, in priority order

**FIX A — bind σ_I to the admitted OUTPUT SET, and make the overlay reject
(never skip) an un-linked or mismatched token-shaped output.** Two-sided;
neither half alone closes the hole (see §7.1 for why). This is the single
highest-priority change in this spec — it blocks safely shipping *any*
offline credit on σ_I coverage. Spec: §1, §3.

**FIX B — remove "mined ⇒ admitted" as a coverage bottom.** Only a σ_I-covered
admission (per FIX A) terminates the recursive walk. A mined-but-unadmitted
ancestor is a hole, not a bottom. Spec: §1.

**FIX C — make σ_I derivable from the engine's own durable "applied" proof,
not only from a side record.** Both overlays must sign on re-submit (or on
`GET /admin/admission/:txid`) whenever their own applied-transaction store
proves the tx went through `tm_mandala`, independent of whether a
`mandalaAdmissions`/Go admission row exists. Spec: §3.

**FIX D — a structural, persisted verdict taxonomy at `/submit`,** replacing
string/shape inference: `ERR_REFUSED` (final, from an allowlist of
policy-level reasons only, persisted per txid so every submitter converges) vs
`ERR_UNAVAILABLE` (retryable — broadcast failure, SPV/chaintracker error,
storage fault, sanctions-provider error) vs `ERR_EVICTED` (permanent, but
*restores* inputs — FIX E) vs liftable policy codes that the wallet must treat
as retryable, never as invalidTx. Spec: §3, §4.

**FIX E — eviction is the exact inverse of admission for inputs,** on both
engines and on every trigger (`/arc-ingest` terminal status, broadcast-failure
compensation): unmark spent, restore the token row, on both the already-wired
pre-Submit compensation path *and* the still-unwired post-hoc eviction path.
`/arc-ingest` requires a non-empty callback token whenever eviction is wired.
Spec: §3.

**FIX F — the recipient's (and payer's) drain is the *only* path that may
ever call `/submit` and then broadcast a token transaction,** online or
offline: (i) a positive ack after a parked build must advance the row with an
explicit state-changing write, never a blind re-insert; (ii) `finalizeDelivery`
must never call `broadcastPayment` for a `kind:'token'` frame, online or off;
(iii) the storage-layer `attemptToPostReqsToNetwork` override must hold a
token request regardless of connectivity, closing the "online recipient never
enters the drain" hole structurally, not by convention. Spec: §4.

**FIX G — evidence is a derivable cache over the persisted frame, not a
precondition guarded by write ordering.** The AdmissionBundle lives inline in
the durable `PaymentFrame`/`localpay_pending` row; the local admission/edge/
linkage tables are rebuilt from it with idempotent upserts on every drain
pass, so no single write ordering is load-bearing and a "decline on throw"
block never has evidence-writing inside it. Spec: §4.

**FIX H — verify every counterparty-supplied σ_I before trusting it for
anything** (skip-submit, mark-settled, credit-without-caveat); an
unverifiable one is treated as **absent**, never as a decline and never as
proof. Spec: §4.

**FIX I — `token_settlements` rows are owned independently of the BSV pending
queue's retry ceiling;** a retriable failure (missing block header) never
burns `MAX_PENDING_ATTEMPTS`, and a reconciliation pass re-derives abandoned
rows. Spec: §4.

**FIX J — cancel is overlay-authoritative:** an online cancel of a
parked/handed-over token payment consults `GET /admin/admission/:txid` first
and refuses if already admitted; there is no local "fail T then respend"
path. Spec: §4, §6.

**FIX K — only token-shaped ancestors are subject to the σ_I walk;** an
unconfirmed BSV fee parent is an ordinary broadcast-only ancestor (the
existing release engine already handles it) and is never treated as a
coverage hole. Spec: §1.

**FIX L — the overlay itself refuses a conflicting second spend of an
already-admitted-as-spent coin,** rather than relying on Arcade's broadcast
race: mark-spent is conditioned on `spent=false` with a rows-affected check.
Spec: §3.

**FIX M — permanently-stuck states get an honest name, not infinite silent
retry:** a payment that cannot settle because the overlay is gone or an asset
is paused indefinitely surfaces a dated "stuck" state with a user-visible
affordance, per the acknowledged double-spend-window doctrine in §7.

---

## 1. Evidence model

### 1.1 The AdmissionBundle (logical object)

Per token payment frame, the payer carries — inline inside `TokenPayment`,
not as a separately-shipped object — the tuple:

```
AdmissionBundle {
  tip:              the payer's new transaction (already the frame's `transaction` field)
  overlayUrl:        string                         // unchanged from v3
  overlayIdentityKey: 33B compressed pubkey          // unchanged from v3
  linkage:  { txid → MandalaLinkagePayload bytes }   // UNCHANGED shape from v3 §2:
                                                      //   one entry per UNBROADCAST token tx
                                                      //   in the chain — the exact off-chain
                                                      //   bytes the overlay's /submit consumes.
  admissions: { txid → AdmissionEntry }              // NEW, replaces `recipientLinkage`
}
AdmissionEntry {
  outputsToAdmit: sorted [uint32]    // exactly what the overlay admitted for this txid
  signature:      DER bytes          // ECDSA over admissionDigestV2(txid, outputsToAdmit) — see §3.1
  signerKey:      33B compressed pubkey  // MUST equal overlayIdentityKey (v1: single trusted key)
}
```

`linkage` and `admissions` are keyed by disjoint sets of txids in a
well-formed bundle: a txid the payer has σ_I for goes in `admissions` and
needs no linkage payload forwarded (the recipient will never submit it); a
txid the payer does *not* have σ_I for goes in `linkage` (so a downstream
submitter can build the /submit body for it) and its own inputs are walked
further. A bundle MAY legitimately have neither for a purely-issued asset's
tip (no token ancestor at all — the trivial base case).

**Canonical form, for verifier test vectors only — never a wire field.** Per
the simplest-token principle (drop frilly bits), the bundle carries no
self-referential hash on the wire. For test-vector pinning define:

```
id = SHA256(
       0x01 ‖ overlayIdentityKey ‖ tipTxid
       ‖ varint(len(linkage))    ‖ (txid ‖ varint(len(payload)) ‖ payload for each, sorted by txid asc)
       ‖ varint(len(admissions)) ‖ (txid ‖ varint(len(outputsToAdmit)) ‖ each varint sorted asc
                                     ‖ varint(len(sig)) ‖ sig ‖ signerKey for each, sorted by txid asc)
     )
```
This is the same canonical, deterministic serialization both a wallet and a
test harness compute over an in-memory `AdmissionBundle` value — it lets the
pure verifier below be pinned by test vectors that are independent of the
outer `PaymentFrame` byte layout (§2).

### 1.2 COVER: the recursive coverage walk

```
Covered(t, v)  :=  Admitted(t)  AND  v ∈ admissions[t].outputsToAdmit

Admitted(t)    :=  t ∈ admissions
                   AND verify(admissions[t].signature,
                              admissionDigestV2(t, admissions[t].outputsToAdmit),
                              admissions[t].signerKey)
                   AND admissions[t].signerKey == bundle.overlayIdentityKey
                       (== session.asset.overlayIdentityKey / frame.token.overlayIdentityKey)

function COVER(tip, bundle) -> { ok: true, mustSubmit: [txid...] }        // topo-ordered, parents first
                              | { ok: false, reason: 'uncovered_ancestor' | 'unsafe_asset' | 'shape' }
  visited := {}                       // txid -> bool, memoizes walk()
  mustSubmit := {}                    // set

  function walk(tx) -> bool:          // true iff every token ancestor of tx bottoms out at Covered()
    if tx.txid in visited: return visited[tx.txid]
    visited[tx.txid] := true          // provisional; a real spend graph is acyclic (txid = hash of
                                       // the tx, so it cannot reference itself or a descendant) —
                                       // this guards only against malformed/hostile input
    tokenInputs := [ (i, src) for i, input in enumerate(tx.inputs)
                     if isMandalaToken(input.sourceTransaction.outputs[input.sourceOutputIndex],
                                       bundle.assetId) ]                 // FIX K: non-token
                                                                         // (fee) inputs are NOT
                                                                         // walked at all — see §1.5
    if tokenInputs.length == 0:
      visited[tx.txid] := true
      return true                     // base case: pure issuance / no token ancestor
    ok := true
    for (i, (ptxid, pvout)) in tokenInputs:
      if Covered(ptxid, pvout):
        continue                      // bottom — proven, nothing to submit for ptxid
      parentTx := bundle.beef.lookup(ptxid)
      if parentTx == None:
        ok := false; break            // HOLE: no evidence and no bytes to recurse into
      if not walk(parentTx):
        ok := false; break
      mustSubmit.add(ptxid)           // ptxid itself is unadmitted; must be submitted (parents of
                                       // ptxid, if any, are already in mustSubmit from the recursion)
    visited[tx.txid] := ok
    return ok

  if not walk(tip): return { ok: false, reason: 'uncovered_ancestor' }
  mustSubmit.add(tip.txid)
  return { ok: true, mustSubmit: topologicalOrder(mustSubmit, bundle.beef) }
```

### 1.3 Termination proof

1. `bundle.beef` is finite — bounded by the sealed-frame ceiling
   (`MAX_MESSAGE_BYTES` = 64 KiB, design-v3 §"Size budget"). There are
   finitely many distinct txids reachable from it.
2. `walk` only recurses into a `sourceTXID` whose *full transaction bytes*
   must already be present in `bundle.beef` — an `AtomicBEEF`/`Beef` parse
   structurally requires every referenced ancestor to be present or
   txid-only; a txid-only or absent ancestor is treated as a HOLE, never as
   an invitation to fetch more bytes from the network (this walk runs
   offline, by construction).
3. `visited` memoizes each txid, so each distinct node is expanded at most
   once: the walk performs at most `|beef.txs|` expansions, each doing
   `O(inputs)` work. It halts within a number of steps bounded by the
   wire-size-capped BEEF.
4. No cycle is possible in a valid transaction graph — a txid is the hash of
   its own serialized bytes, so a transaction cannot spend an output of a
   transaction that (transitively) spends one of its own outputs. Termination
   is therefore structural, not merely capped-and-safe; the BEEF-size cap
   only bounds the constant of proportionality for a hostile or malformed
   bundle.

### 1.4 What COVER proves, and what it does not

**Proves:** every token input the recipient is being asked to accept-and-hand-
over-goods-against, or every ancestor it will be asked to submit, is reachable
either (a) from a σ_I the recipient can itself verify against the *session's
own* overlay key, over a message that names the *exact set of outputs the
overlay actually admitted*, or (b) from transaction bytes the recipient holds
and can walk into further under the same rule. The recipient never has to
trust an unverifiable assertion.

**Does not prove:**
- That a covered coin has not since been double-spent elsewhere. This is
  Bitcoin's ordinary unconfirmed double-spend window, and §7 keeps it to
  exactly that size — no larger, no smaller — via FIX L at the overlay and
  the existing spent-input guard/idempotent-`/submit` machinery.
- On its own, that "every `MandalaToken`-decodable output of an admitted
  transaction was itself one of the admitted outputs." This is *exactly* the
  phantom-coin/sibling-mint hole three independent reviews found. `Covered`
  is defined above to require `v ∈ admissions[t].outputsToAdmit` — but that
  check is only as good as (a) σ_I actually committing to `outputsToAdmit`
  (not just to `t`) and (b) the overlay's own admission decision for `t`
  never admitting `t` as a whole while silently *not* admitting one of its
  token-shaped outputs. Both halves are FIX A; **omitting either half still
  leaves the hole**, because:
  - Without the wallet-side vout check, a genuine σ_I(t) is (mis)read as
    licensing *every* token output of `t`, including one the overlay never
    examined.
  - Without the overlay-side reject-not-skip fix, `outputsToAdmit` for a
    submitted tx can be **wrong on the overlay's own books** — it silently
    admits `{0}` while a hostile output `1` sits in the same tx, unlinked,
    worth nothing to the overlay's own conservation check but perfectly
    decodable and spendable by anyone who has the sibling in their BEEF. A
    correct wallet-side `Covered` check would then correctly refuse output
    `1` — *if* it ever heard about it as a separate coverage query. But the
    attack's whole shape is that the ATTACKER is the one submitting `t`
    online and obtaining σ_I(t) legitimately; the wallet-side fix protects
    the *next* recipient only if the signed `outputsToAdmit` is trustworthy,
    which requires the overlay to have computed it correctly in the first
    place.

  Stated plainly: FIX A is not "belt and braces" — it is two necessary parts
  of one fix. This spec requires both, and §3.2's decision table and §8's
  test list pin both halves.

### 1.5 FIX K: only token ancestors are walked

`walk()` in §1.2 iterates only inputs whose source output decodes as a
`MandalaToken` of the bundle's `assetId`. A fresh, unconfirmed BSV output
funding the payer's transaction fee (`allocateChangeInput` accepts `unproven`
and `payerHold.ts:86` promotes `nosend→unproven` precisely so change funds the
next offline payment) is **not** a token ancestor and is never added to
`mustSubmit` or treated as a hole. It is an ordinary broadcast-only ancestor:
the existing release engine (`W/core/offline/order.ts` `releaseOrder`,
`processOfflineActions.ts`'s `postForeign`) already includes such parents in
the topological release order and posts them via `postBeef`/EF exactly as it
does for a plain BSV nearby payment today. This closes SC-2.3: the design
that walked *every* unmined ancestor (token or not) for σ_I coverage refused
the ordinary case of "the payer just spent their own unconfirmed BSV change."

### 1.6 Worked examples

**0-hop — direct, both inputs already admitted.** Alice holds coin `X` from a
previous *online* transfer; `admissionSignature`/`admissionIdentityKey` for
`X`'s txid were already returned by that transfer's `/submit` call
(`L/overlay.ts:29-33`) and cached. Alice pays Bob offline with tip `T`
spending `X`. Bundle: `beef={X,T}`, `linkage={}` (nothing unadmitted),
`admissions={X: {outputsToAdmit:[…], sig, key}}`. Bob's `COVER(T)`:
`tokenInputs(T)=[(X,v)]`; `Covered(X,v)` — true (σ_I verifies, `v` is in the
signed set). `walk(T)` returns true with zero recursion. `mustSubmit=[T]`.
Bob credits, hands over goods, and — per rule 3 — is the one who submits `T`
whenever *he* reconnects (or Alice does, per rule 6, whichever is first;
idempotent `/submit` makes the order irrelevant).

**1-hop — Alice was herself paid offline and re-spends before reconnecting.**
Alice received `X` offline (never submitted, no σ_I for it) and now pays Bob
with `T` spending `X`. Bundle: `beef={G,X,T}` (`G` = the genuine
admitted ancestor `X` itself spends, online, so `G∈admissions`), `linkage=
{X: payload}` (Alice forwards the linkage bytes for the *not-yet-admitted* `X`
verbatim — she cannot decrypt them, only carry them), `admissions={G:{…}}`.
Bob's `COVER(T)`: `tokenInputs(T)=[(X,v)]`; `Covered(X,v)` — false, `X∉
admissions`. Recurse: `parentTx=X` is present in `beef`; `walk(X)`:
`tokenInputs(X)=[(G,w)]`; `Covered(G,w)` — true. `walk(X)` returns true;
`mustSubmit.add(X)`. Back at `T`: `walk(T)` returns true; `mustSubmit=
{X,T}`. Topological order: `[X, T]`. Bob credits, and per rule 3 Bob's own
drain — whenever it next runs online — submits `X` first (gets a *new* σ_I(X)
over the new admitted set), then submits `T` (gets σ_I(T)) and only then
broadcasts `T`. (`X` is also broadcast, in order, by the same drain pass —
see §4.3.)

**3-hop chained offline — the case the maintainer named explicitly.** `A`
holds admitted coin `X0` (σ_I(X0) already on hand from an earlier online
transfer). All four hops below happen **before anyone reconnects**:

1. `A→B`, tip `T1` spends `X0`. Bundle to B: `beef={X0,T1}`,
   `admissions={X0:{…}}`, `linkage={}`. B's `COVER(T1)`: `Covered(X0,·)` true
   → `mustSubmit=[T1]`. B credits offline.
2. `B→C`, tip `T2` spends `T1`'s output. B forwards `beef={X0,T1,T2}`,
   `admissions={X0:{…}}` (B never submitted `T1` — no σ_I(T1) exists yet),
   `linkage={T1: payload}`. C's `COVER(T2)`: `tokenInputs(T2)=[(T1,v)]`;
   `Covered(T1,v)` false; recurse into `T1`: `Covered(X0,·)` true →
   `walk(T1)`=true → `mustSubmit.add(T1)`. Back at `T2`: true.
   `mustSubmit={T1,T2}`, order `[T1,T2]`. C credits offline.
3. `C→D`, tip `T3` spends `T2`'s output. C forwards `beef={X0,T1,T2,T3}`,
   `admissions={X0:{…}}`, `linkage={T1:payload, T2:payload}`. D's `COVER(T3)`
   walks `T3→T2→T1→X0` (covered), `mustSubmit={T1,T2,T3}`, order
   `[T1,T2,T3]`. D credits offline, hands over the final goods.

**Reconnect — whoever is first settles the whole chain.** Because the linkage
for *every* unadmitted ancestor is forwarded verbatim hop by hop, D's bundle
already contains everything needed to submit `T1`, `T2`, and `T3` — not just
D's own tip. Per rule 3 the *recipient* of each hop is nominally responsible
for submitting that hop, but nothing in the protocol restricts *who* may
POST a given txid's bytes to `/submit` — admission is a function of content
(conservation, linkage, screening), not of caller identity (see §7.4). So
whichever of `{A,B,C,D}` reconnects first can settle the entire chain in one
drain pass: submit `T1` (idempotent — gets σ_I(T1) whether or not anyone
already tried), then `T2`, then `T3`, each in order, broadcasting each as
admitted (rule 4). If instead `B` reconnects first, `B`'s own copy of the
bundle only extends to `T1` (its own tip) — it submits and broadcasts `T1`
and acks; `C` and `D` still need `T2`/`T3` submitted, which happens when *any*
of `C`, `D`, or a reconnecting `A`/`B` next drains (each holds enough of the
chain to submit at least its own frontier). The chain converges monotonically
as devices reconnect, never regresses, and the idempotent `/submit` (FIX C)
guarantees a re-submission by a second party is a no-op rather than a
conflict.

---

## 2. Wire formats

### 2.1 `PaymentFrame` v3 → v4

`FRAME_VERSION` 3 → 4 (`W/core/localpay/codec.ts:3`). Old builds (there are
none live) refuse cleanly by construction — `decodeFrame` already throws
`unsupported frame version ${version}` on any value other than the
compile-time constant (`codec.ts:165`).

`TokenPayment` (`codec.ts:14-21`) changes:

```ts
export interface TokenPayment {
  assetId: string
  overlayUrl: string
  overlayIdentityKey: string          // unchanged
  certificates: Uint8Array[]          // unchanged, still opaque
  linkage: Array<{ txid: string; payload: Uint8Array }>   // UNCHANGED shape —
                                       // still one entry per unbroadcast token
                                       // tx in the chain the recipient may need
                                       // to submit; see §1.1
  admissions: Array<{                 // NEW — replaces `recipientLinkage`
    txid: string
    outputsToAdmit: number[]          // sorted ascending
    signature: Uint8Array             // DER ECDSA
    signerKey: string                 // 66-hex compressed pubkey
  }>
  // `recipientLinkage: Uint8Array` — REMOVED. A payee-decryptable linkage is
  // impossible under D2 blinding without leaking the payer's real key `A`
  // (BRC-72 decryption by the named verifier requires `counterparty: prover`
  // = A). σ_I bound to the admitted output set (FIX A) is strictly stronger
  // evidence, at roughly a tenth the size (see §2.3), and it is evidence the
  // overlay itself vouches for rather than evidence the payer could fabricate
  // about their own honesty. This resolves design-v3's own open question 2
  // and ux's open question 2 the same way, definitively: removed, not renamed.
}
```

Byte layout (`encodeFrame`/`decodeFrame`, `codec.ts:127-203`):

```
[1]    version (4)
[1]    kind                        0x01 = bsv, 0x02 = token          — unchanged
[33]   senderIdentityKey           blinded A′ in token mode (D2)      — unchanged
[v]    outputIndex                                                    — unchanged
[v]+n  derivationPrefix / derivationSuffix                             — unchanged
--- kind 0x02 only ---
[v]+n  assetId                                                        — unchanged
[v]+n  overlayUrl                                                     — unchanged
[33]   overlayIdentityKey                                             — unchanged
[v]    certCount, then per cert: [v]+n bytes                          — unchanged
[v]    linkageCount, then per entry: [32]txid [v]+n payload           — unchanged
[v]    admissionCount, then per entry:                                 — NEW, replaces
  [32]   txid                                                          — recipientLinkage
  [v]    outputsToAdmitCount, then varint per admitted output index    — (was one
  [v]+n  signature (DER)                                               —  [v]+n field)
  [33]   signerKey
--- both kinds ---
[v]+n  transaction (AtomicBEEF)                                       — unchanged
```

`encodeFrame` gains the same shape checks it already has for `overlayIdentityKey`
(`codec.ts:142-144`) applied to each admission entry's `signerKey`; `decodeFrame`
mirrors them. No other field changes.

### 2.2 `Session` — unchanged

`SessionAsset` (`W/core/localpay/session.ts:55-62`) already carries
`overlayUrl`/`overlayIdentityKey` per asset and needs no new field: the
reversal in §9 (offline nearby token payments are back in scope) is a
behavior change in `build.ts`/`NearbyFlow`/the drain, not a wire change.
`SESSION_VERSION` stays 1, per the already-settled policy in design-v3 §3
("a future field that changes the meaning of money on a *deployed* format
must bump `v`" — nothing here changes what `amount` means).

### 2.3 Size budget, updated

| component | v3 | v4 | delta |
|---|---|---|---|
| `recipientLinkage` (JSON `SpecificLinkage`) | ~900 B | 0 (removed) | −900 B |
| one `admissions` entry (32B txid + ~8B outputsToAdmit + ~72B DER sig + 33B key) | — | ~145 B | +145 B per *covered* ancestor |
| linkage payload per unadmitted chain tx (unchanged) | ~2,700 B | ~2,700 B | 0 |

Net effect for the common case (0- or 1-hop, one covered ancestor): frame
shrinks by ~750 B relative to v3. A deep offline chain (§1.6's 3-hop example)
adds one `admissions` entry (one covered bottom, ~145 B) plus the same
`linkage` cost v3 already budgeted for every unadmitted hop — the 5-link
chain in design-v3's own table (≈33 KB, comfortably under the 64 KiB cap)
is unaffected in order of magnitude.

### 2.4 `AdmissionRecord` (overlay-internal, both engines)

Not a wire format the wallet sees directly, but pinned here because §3
depends on its exact shape:

```ts
interface AdmissionRecord {
  txid: string
  topics: string[]
  outputsToAdmit: number[]        // NEW — was missing from O/admission.ts's
                                   // AdmissionRecord (:85-91); required by FIX A
  admissionSignature: string      // DER hex, over admissionDigestV2 (§3.1)
  admissionIdentityKey: string
  refusedCode?: string            // NEW — set only for a FIX-D-final refusal;
  refusedAt?: string              // mutually exclusive with the admission fields
  evictedAt?: string              // NEW — FIX E; presence means the coin's
                                   // spent-input marks were restored and this
                                   // txid's own σ_I is permanently void
  at: string
}
```

---

## 3. Overlay spec

### 3.1 σ_I message format — FIX A, applied to signing

Both signers today sign `SHA-256("mandala-admit:"+txid)`
(`O/admission.ts:10-11`, `OG/httpapi/admission.go:38`). This changes to:

```
admissionDigestV2(txid, outputsToAdmit) =
  SHA-256("mandala-admit:" + txid + ":" + hex(sortedOutputsToAdmit as a
          comma-joined ascending list of decimal uint32, e.g. "0,2,3"))
```

No version byte is needed on the digest itself: because this repo has no
live token traffic yet (design-v3's own Compatibility section: "No live
builds exist; there is no migration story to preserve"), the fencing is
carried entirely by the **frame version bump** (§2.1) — a v4 verifier always
computes `admissionDigestV2`; there is no v3 token traffic in the field to
misinterpret. This is the cheapest point at which to make this change and it
must happen before any offline token traffic ships, since FIX A is the
highest-priority fix in this spec.

**Overlay-side change (both engines), same fix, same two lines each:**

- Go `topic_manager.go:215-224` (currently `if l == nil { continue }` and a
  silent pkh-mismatch `continue`) → `return none, m.reject(fmt.Errorf(
  "output %d: MandalaToken-decodable output with no verified linkage", idx))`.
  Verified live today (re-read 2026-09-14): the skip is exactly as every
  review described it (`topic_manager.go:211-224`), and `conservationHolds`
  (`:434-460`) sums `outTotals` only over `admitted` — this is the exact
  phantom-coin path EB-1/SM-1 exploit.
- TS: `@bsv/overlay-topics`'s `MandalaTopicManager` has the identical
  skip (`verifyFtOutputs`, per review — ts-stack pinned, cannot be patched
  in place). Since the design doctrine is "ts-stack changes ship as PR only,"
  the required repo-local mitigation until a PR lands is a **wrapper** on the
  `withAdminChainAnchor` pattern already used in this repo
  (`O/index.ts`): decode every output of the submitted tx before delegating
  to the pinned topic manager, and if any `MandalaToken`-decodable output has
  no linkage entry at its index, reject the whole submission at the wrapper
  layer *before* it ever reaches the pinned manager. This is strictly
  sufficient (a rejection at the wrapper is a rejection) but not as clean as
  fixing the manager itself — **flag for a ts-stack PR** against
  `@bsv/overlay-topics`'s `MandalaTopicManager` to turn the skip into a
  reject natively, so a future consumer of the package alone (without this
  repo's wrapper) is not silently vulnerable. Try the repo-local wrapper
  first; escalate to a PR only if the wrapper cannot see what it needs
  (it can — the wrapper has the full parsed tx and the off-chain payload
  before calling `submit`).
- Existing tests that pin the skip as correct behavior
  (`TestWrongPKHLinkageSilentlySkipsOutput`,
  `TestMissingOutputLinkageBreaksConservation` — Go;
  the TS equivalent per review) must be updated to expect a rejection.

**Signing change, both engines:** `steakToWire` (Go, `submit.go:152-180`) and
`attachAdmissionSignaturesSync` (TS, `admission.ts:55-73`) currently sign
once per submitted tx if *any* topic admitted `>0` outputs, over the bare
txid. Change to: sign over `admissionDigestV2(txid, sortedOutputsToAdmit)`,
where `outputsToAdmit` is specifically the `tm_mandala` topic's own admitted
set (gate on the `tm_mandala` entry, not "any topic admitted anything" — a
registry-only admission must never yield a token σ_I).

### 3.2 `/submit` decision table

| Server-side state of this txid | Response (this call) | Wire shape | Wallet verdict |
|---|---|---|---|
| Never seen; topic-manager rules run fresh, admits ≥1 output | Admission signature over `admissionDigestV2(txid, outputsToAdmit)` | `200 {outputsToAdmit, admissionSignature, admissionIdentityKey}` | `admitted` |
| Never seen; topic-manager rules run fresh, refuses for a **final** policy reason (allowlist below) | Structured, persisted refusal | `4xx {status:'error', code:'ERR_CONSERVATION'\|'ERR_LINKAGE'\|'ERR_SHAPE'\|'ERR_SATOSHIS'\|'ERR_INPUT_SPENT', retryable:false}` | `refused` (terminal) — FIX D |
| Never seen; refuses for a **liftable** policy reason | Structured, not persisted as final | `4xx {status:'error', code:'ERR_PAUSED'\|'ERR_FROZEN'\|'ERR_SANCTIONED'\|'ERR_ACCESS'\|'ERR_MEMBERSHIP', retryable:true}` | `serviceError`, retry with backoff — FIX D |
| Never seen; a **dependency/infra** fault (Arcade broadcast failure, SPV/chaintracker error, storage fault, sanctions-provider unreachable) | Never the policy shape | `503 {status:'error', code:'ERR_UNAVAILABLE', retryable:true}` | `serviceError` — FIX D |
| **Already admitted** (engine's own applied-transaction store proves it, admission record present *or* not — FIX C) | Same `outputsToAdmit`, freshly signed, no side effects re-run | `200 {outputsToAdmit, admissionSignature, admissionIdentityKey}` | `admitted` (idempotent no-op if already broadcast) — closes EB-2.3, SC-2.2, SC-3.4 |
| **Admitted, then evicted** (`/arc-ingest` terminal status or reorg) | Distinct terminal code; inputs restored (FIX E) as part of the *same* eviction | `410 {status:'error', code:'ERR_EVICTED'}` | permanent for *this* txid, but its **inputs are spendable again** — wallet must build a *new* spend, never retry this one forever (closes SC-2.4) |
| **Conflicting spend** of an input already marked spent by a *different*, still-admitted txid | Refused by the overlay itself (FIX L), not left to Arcade | `4xx {code:'ERR_INPUT_SPENT', retryable:false, spendTxid:<competing txid>}` naming the competitor | `refused` **only if** `GET /admin/admission/<spendTxid>` independently confirms that record; otherwise `serviceError` (guards against the mid-commit-fault false-permanent case, EB-3.5) |

**Allowlist discipline (the actual FIX D mechanism).** `ERR_REFUSED`-class
codes may be minted **only** from a genuine topic-manager `reject(...)` for
one of the five listed final reasons. Every other Go `Submit` error —
`spv.Verify` failure, `DoesAppliedTransactionExist`/`FindOutputs` store
errors, `GetAssetState`/`IsSanctioned` provider errors, and
`arcade.IsBroadcastFailureErr` — is reclassified to `503 ERR_UNAVAILABLE`
before `submitHandler`'s `errorResponse` call (`submit.go:108-121` currently
returns `400` for *every* `Submit` error uniformly; this is the exact
unsoundness SC-3.1/SM-3.3 found). On the TS side, since a genuine
topic-manager rejection is today swallowed into a `200` with empty
`outputsToAdmit` inside the pinned `@bsv/overlay` `Engine.js` (SC-3.1,
per review), the repo-local wrapper (§3.1) must independently capture the
manager's *own* rejection reason before it is swallowed — the manager already
computes it (it is the argument to `m.reject(...)`), the wrapper's job is to
stash it in a side channel the wrapper's own `/submit` handler reads instead
of trusting the pinned engine's collapsed 200. **Flag for a ts-stack PR** if
that side channel cannot be built without patching `@bsv/overlay`'s
`Engine.js` — try the repo-local capture first (the manager function runs
inside this repo's process either way; only the *engine's* handling of its
return value is pinned).

**"Verdict wins."** The **first final** verdict per txid (an `ERR_REFUSED.*`
or `ERR_EVICTED`) is persisted (`AdmissionRecord.refusedCode`/`refusedAt` or
`evictedAt`, §2.4) and served identically to every subsequent submitter via
both `/submit`'s dupe path and `GET /admin/admission/:txid`. This is what
lets two independent submitters (payer and recipient, or two hops of a
chain) converge on the same answer instead of one seeing a transient fault
as final while the other later gets the tx admitted (SM-2.1/EB-2.2).

### 3.3 σ_I persistence and the fetch endpoint

- **TS** already has a `mandalaAdmissions` Mongo collection with a unique
  index on `txid` and a `void admissionsCol.updateOne(...)` fire-and-forget
  write plus `GET /admin/admission/:txid` returning 404 on a miss
  (`O/index.ts:90-102, 152-166` — re-read live, this exists today). Required
  changes: (a) add `outputsToAdmit` to the persisted document (§2.4); (b)
  make the write **awaited before the response is sent**, not fire-and-forget
  — a client that received a 200 must be guaranteed the record exists on the
  very next `GET`, closing the race SC-3.4/EB-2.3 describe where a concurrent
  admission can still 404; (c) sign on the dupe path from
  `DoesAppliedTransactionExist`/an applied-transaction check even when the
  `mandalaAdmissions` row is itself missing (FIX C, covers every Go
  admission that predates this feature and every crash-lost TS record).
- **Go has neither the collection nor the endpoint today** (re-verified
  live: `storage.go`'s `NewStore` wires exactly 8 collections — none named
  admission; `admission.go` defines only the signer, no persistence;
  `server.go:129`'s doc comment names `/admin/admission/:txid` but no route
  registers it). This is new work, not a gap-fix: add a `mandalaAdmissions`
  collection (schema per §2.4) to `overlay-go/internal/mandala/storage.go`,
  a `GetAdmission(ctx, txid)`/`RecordAdmission(ctx, rec)` pair, wire
  `RecordAdmission` synchronously before `submitHandler` returns 200 (Go can
  afford synchronous — no fire-and-forget hazard to inherit), and add
  `GET /admin/admission/:txid` to `overlay-go/internal/httpapi/admin.go`
  returning the identical JSON shape TS returns (parity obligation below).
- **`/arc-ingest` auth (FIX E, second half).** `overlay-go/internal/wiring/
  engine.go`'s `ArcadeCallbackToken` and the Go `WithArcade`
  (`server.go:91-100`) already gate the route behind the token *when
  non-empty*, but boot with an empty token is still accepted (per review,
  confirmed by the doc comment at `server.go:91-93` gating "when it's
  non-empty" — i.e. gating is optional today). Change: refuse to mount
  `/arc-ingest` (or refuse to start with Arcade enabled) if
  `ArcadeCallbackToken == ""`. Same requirement on the TS side wherever its
  equivalent ingest route is wired.

### 3.4 Eviction restores inputs (FIX E)

**Confirmed live today:** the pre-Submit broadcast-failure compensation seam
(`PrepareSubmitCompensation`, `submit.go:31-42`, wired via
`overlay-go/internal/wiring/engine.go` around the snapshot/`UnmarkSpentBySpendTxid`/
`store.RestoreTokens` closure) **already does the right thing** for a
broadcast failure that happens *during* `Submit` — this closes the narrowest
slice of EB-2.1 for that one trigger. But `evictTx`
(`overlay-go/internal/wiring/engine.go`, the closure built by the function of
the same name — re-read live) does **not** call `UnmarkSpentBySpendTxid` or
restore token rows; it only calls `OutputEvicted` (notify), then deletes the
evicted outputs and the applied-transaction records. This is the exact
remaining fatal gap EB-2.1 names: an `/arc-ingest` terminal status
(Arcade rejects a previously-admitted tx after the fact — fee/policy
rejection, reorg) permanently strands the spent input with no token row and
no path back, even though the coin is provably unspent on chain.

**Fix:** extend `evictTx` to run the *same* restore the pre-Submit
compensation already performs: `UnmarkSpentBySpendTxid(txid)` then
`RestoreTokens(snapshot)`. To make the rows restorable at this later point
(the pre-Submit snapshot closure has long since gone out of scope), persist
the pre-spend token-row snapshot **on the admission record itself** at
admission time (the same data the pre-Submit compensation already captures,
now given a durable home instead of a closure-local one), and have
`evictTx` read it from there. Stamp `evictedAt` on the admission record (§2.4)
so `GET /admin/admission/:txid` answers `ERR_EVICTED` for this txid forever
after (never re-admitted for the same bytes) while its inputs show as live
again on the next `FindOutputs`. Mirror on the TS engine's eviction wrapper.

The spent-input guard (§3.5) must additionally treat "no live row, but the
spending tx's admission record carries `evictedAt`" as *live* rather than
`ERR_INPUT_SPENT`, so a client that races the restore is still safe.

### 3.5 Overlay itself refuses a conflicting spend (FIX L)

Both engines' input-marking is unconditional today: Go's
`MarkUTXOsAsSpent` is a plain `UpdateMany` (`enginestore.go:398-416`, per
review) and `FindOutputs` for `previousCoins` applies no `spent` filter
(`enginestore.go:291-333`); TS is the same shape. The only thing refusing a
genuine double spend today is Arcade's own broadcast-time race
(`DOUBLE_SPEND_ATTEMPTED`), which two concurrent `/submit` calls can both
slip past (SM-1a). Fix: condition the spend-mark on `spent=false` with a
rows-affected check (a compare-and-swap), and have the topic manager consult
the live token row — not an unconditional merge of `previousCoins` — before
admitting a spend, refusing with `ERR_INPUT_SPENT` (the FIX-D-final code,
naming the competing txid) when the row is already marked spent by a
different, still-admitted transaction.

### 3.6 TS/Go parity obligations (summary)

| Item | TS today | Go today | Required |
|---|---|---|---|
| σ_I message = `admissionDigestV2` | needs change | needs change | both |
| Reject (not skip) unlinked token output | pinned in `@bsv/overlay-topics` — needs wrapper, **possible ts-stack PR** | live code, direct fix | both |
| `mandalaAdmissions`/admission collection | exists, needs `outputsToAdmit` + awaited write | **missing entirely** | both (Go: new) |
| `GET /admin/admission/:txid` | exists | **missing entirely** | both (Go: new) |
| Sign from applied-store proof on dupe/missing-record | needs change | needs change | both |
| Structural `ERR_REFUSED`/`ERR_UNAVAILABLE` split | needs change (harder — swallow lives in pinned Engine.js, **possible ts-stack PR**) | needs change, direct fix | both |
| `evictTx` restores inputs | needs the eviction-wrapper equivalent | needs change, direct fix | both |
| `/arc-ingest` requires non-empty callback token | needs change | needs change | both |
| Conditional spend-mark (FIX L) | needs change | needs change | both |

Everything in this table is a **repo-local** change (`overlay/src`,
`overlay-go/internal/*`) except the two rows marked "possible ts-stack PR,"
both of which are attempts to route around a pinned package's swallowed
signal from the outside first, per the ts-stack PR-only workflow — only file
against `@bsv/overlay`/`@bsv/overlay-topics` if the repo-local wrapper
provably cannot see what it needs.

---

## 4. Wallet spec

### 4.1 New stores

Four new SQLite tables, additive only — nothing in `offline_actions`,
`proven_tx_reqs`, or the toolbox's own schema changes shape. Migration:
`CREATE TABLE IF NOT EXISTS` on next boot, guarded the same way the app's
other schema additions are (`createTables.ts` precedent).

```sql
-- One row per token tx this wallet has ever built, received, or forwarded
-- evidence for. THE state-machine's single owner of "what state is this
-- token payment in" (§5). role/txid pair is stable; a tx is never both.
CREATE TABLE token_settlements (
  txid            TEXT PRIMARY KEY,
  role            TEXT NOT NULL CHECK (role IN ('sent','received')),
  assetId         TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN (
                    'built','parked','handed_over','held',
                    'submitting','admitted','broadcast','refused','orphaned')),
  counterpartyKey TEXT,             -- A' (received) or the payee key (sent)
  amountBaseUnits INTEGER,
  overlayUrl      TEXT NOT NULL,
  overlayIdentityKey TEXT NOT NULL,
  admissionOutputsJson TEXT,        -- outputsToAdmit once known, JSON array
  admissionSignatureHex TEXT,       -- σ_I over THIS txid once known
  refusedCode     TEXT,
  poisonedByTxid  TEXT,             -- mirrors offline_actions.poisonedByTxid; kept
                                     -- here too so a UI query needs one table
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL
);

-- Cached mirror of AdmissionEntry values this device has SEEN (minted its
-- own, received in a bundle, or fetched via GET /admin/admission/:txid).
-- Purely a derivable cache — see FIX G — never a precondition for anything.
CREATE TABLE token_admissions (
  txid              TEXT PRIMARY KEY,
  outputsToAdmitJson TEXT NOT NULL,
  signatureHex      TEXT NOT NULL,
  signerKey         TEXT NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('minted','bundle','submitted','fetched')),
  obtainedAt        TEXT NOT NULL
);

-- Edge index for the recursive COVER walk as a local SQL query rather than a
-- live re-parse of a BEEF every time. Populated from BEEF parses and from
-- every received bundle's own tokenInputs computation.
CREATE TABLE token_admission_edges (
  childTxid  TEXT NOT NULL,
  parentTxid TEXT NOT NULL,
  parentVout INTEGER NOT NULL,
  PRIMARY KEY (childTxid, parentTxid, parentVout)
);

-- Off-chain linkage payloads for UNADMITTED chain transactions — the
-- committed spec's §6 `offline_linkage` store, un-deferred (§9): offline
-- nearby token payments are back in scope, so this store is needed in v1.
CREATE TABLE token_linkage_payloads (
  txid               TEXT PRIMARY KEY,
  payloadBytes       BLOB NOT NULL,
  overlayUrl         TEXT NOT NULL,
  overlayIdentityKey TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('minted','forwarded')),
  createdAt          TEXT NOT NULL
);
```

**These four tables are exactly store-centric's "four small SQLite tables"
claim, realized with state-machine's state-name discipline for
`token_settlements`.** The recursive `COVER` walk (§1.2) becomes:

```sql
WITH RECURSIVE frontier(txid) AS (
  SELECT ?tipTxid
  UNION
  SELECT e.parentTxid
  FROM token_admission_edges e
  JOIN frontier f ON e.childTxid = f.txid
  WHERE NOT EXISTS (
    SELECT 1 FROM token_admissions a
    WHERE a.txid = e.parentTxid
      AND a.signerKey = ?overlayIdentityKey
      AND instr(a.outputsToAdmitJson, ?  /* e.parentVout, bound per-row in app code */) > 0
  )
)
SELECT txid FROM frontier;
```
run once per `(childTxid,parentVout)` pair the app-level walk needs to check
membership for (SQLite has no native JSON-array-contains without the JSON1
extension enabled; the toolbox's SQLite build already enables JSON1 for other
features — use `json_each`/`EXISTS (SELECT 1 FROM json_each(a.outputsToAdmitJson) WHERE value = ?)`
rather than `instr` in the real implementation; `instr` above is illustrative
only). Termination of the recursive CTE is the same as §1.3's proof: the edge
table is a DAG by construction (edges are inserted from real transaction
input references) and SQLite's `WITH RECURSIVE` already refuses to expand a
row it has re-derived (standard fixpoint semantics), so a malformed/hostile
edge insertion cannot spin the query.

### 4.2 Evidence is a cache, not a precondition (FIX G)

Every row across all four tables above is **re-derivable, idempotently, from
the persisted `PaymentFrame` bytes already durable in `localpay_pending`
(receiver) or `offline_actions.framePayload` (payer)** — this is the whole
point of FIX G. Concretely:

- On `savePending` (receiver) and on `holdSentPaymentOffline`/
  `parkSentPaymentOffline` (payer), the frame's `token.linkage[]` and
  `token.admissions[]` are `INSERT OR IGNORE`d into `token_linkage_payloads`
  and `token_admissions` respectively, and `token_admission_edges` rows are
  derived from a **local, offline** parse of `token.transaction`'s own inputs
  (and each `linkage[]` entry's own transaction bytes, already present in
  the same AtomicBEEF) — no network call, no ordering dependency on any
  other table. `token_settlements` gets one row, `state` set per §5.
- **This write does not have to happen before the frame is considered
  durable.** The frame itself, sitting in `localpay_pending`/
  `offline_actions.framePayload`, already *is* the durable fact. The four
  new tables are populated best-effort immediately, and — this is the
  crash-safety guarantee — **re-populated (idempotently, `INSERT OR IGNORE`)
  by the drain on every pass, before it does anything else**, by re-reading
  every `localpay_pending`/`offline_actions` row's frame bytes. A crash
  between "frame persisted" and "evidence tables populated" self-heals on
  the very next drain tick with no special-cased recovery code.
- Consequently, the R2-inside-a-decline-on-throw hazard (SM-2.3/SM-3.4) is
  structurally impossible to reintroduce: there is no code path where
  writing these four tables can throw and cause a `confirm(false, ...)` to
  be sent for an already-persisted frame, because these writes are never on
  the critical path between "frame received" and "ack sent" at all — they
  happen strictly afterward, in the drain, and are allowed to fail and retry
  silently like any other cache-population step.

### 4.3 The submit-then-broadcast drain

`processOfflineActions` (`W/core/storage/methods/processOfflineActions.ts`)
gains one branch inside its existing per-step loop (`:166-224`), keyed on
whether `step.txid` has a `token_settlements` row:

```
for step in plan:                      # UNCHANGED: parents-first, from releaseOrder
  settlement = token_settlements[step.txid]     # may be absent (BSV tx)
  if settlement is None:
    outcome = postOwned(...) or postForeign(...)   # UNCHANGED BSV path
  else:
    outcome = postTokenStep(storage, settlement, step)   # NEW
  ...                                    # UNCHANGED: applyOutcome, cascade, requeue
```

`postTokenStep`:

```
function postTokenStep(storage, settlement, step):
  cover = COVER(settlement.txid, bundleFromLocalTables(settlement.txid))    # §4.1's SQL
  if not cover.ok:
    return 'serviceError'               # ancestor still missing — retry, never reject locally;
                                         # the overlay is the only authority on final refusal (FIX D)
  for ancestorTxid in cover.mustSubmit:  # parents-first, INCLUDING txids this device does not
                                         # itself own a queue row for (§1.6's "whoever reconnects
                                         # first settles the whole chain")
    if token_admissions[ancestorTxid] already has a valid entry: continue   # idempotent skip
    settlements[ancestorTxid].state := 'submitting'
    resp = POST {overlayUrl of settlement} /submit  with beef+linkage for ancestorTxid
    case resp:
      200 admitted   -> record token_admissions row (source='submitted'); state := 'admitted'
      410 evicted    -> state := 'orphaned'; treat this txid AND its beef-descendants in this
                        chain as poisoned (existing applyOutcome cascade, unchanged)
      4xx final      -> state := 'refused'; cascade (existing applyOutcome, unchanged)
      4xx liftable / 503 -> state := unchanged ('held'/'handed_over'); return 'serviceError'
                            for the WHOLE step (do not partially advance a chain past a
                            liftable stall — retry the whole prefix next pass; idempotent)
  # every ancestor in mustSubmit is now admitted
  broadcastResult = broadcast(settlement.tip via Arcade, EXACTLY as a BSV tx today)
  settlements[settlement.txid].state := 'broadcast' on success
  return outcomeOfOwnedPost(...)          # UNCHANGED shape, feeds the existing applyOutcome
```

**Why this closes SC-3.3/SM-3.1 structurally, not by convention.**
`postTokenStep` is reached **only** from inside `processOfflineActions`'s own
loop, which itself runs **only** from the drain (`TaskSendOffline`, the
receiver's `processPending`-equivalent tick, and the payer's optional-submit
tick — never from `finalizeDelivery`, never from `internalizeAction`'s
forced-broadcast path). Two structural guards make it impossible to reach a
real broadcast any other way for a token tx:

1. **`finalizeDelivery` (`W/core/localpay/build.ts:295-391`) must never call
   `broadcastPayment` for `kind:'token'`, online or offline.** Add a check at
   the top of the online branch (`:381-390` today): `if (built.frame.kind ===
   'token') return { kind: 'sent', broadcast: 'pending', detail: 'awaiting
   overlay admission' }` — the hold (`deps.hold`, always run first regardless
   of connectivity per the existing code's own comment at `:354-355`) is
   unchanged; only the subsequent `broadcastPayment` call is skipped for
   tokens. This directly closes SM-3.1: an online payer's `finalizeDelivery`
   currently falls through to `broadcastPayment`/`sendWith` exactly as the
   BSV path does, with no `kind` check at all.
2. **`StorageExpoSQLite.attemptToPostReqsToNetwork`'s online short-circuit
   (`:1948`, `if (online) return await super.attemptToPostReqsToNetwork(...)`)
   must hold a token request regardless of `online`.** Before that check,
   resolve whether any of `reqs` notifies a transaction with a
   `token_settlements` row (a cheap `txid IN (...)` query against the new
   table); if so, route those reqs through the existing
   `holdReqsOffline`/`groupOfflineHolds` path unconditionally — the
   `online` branch is taken only for the remaining, non-token reqs. This
   directly closes SC-3.3: today `attemptToPostReqsToNetwork` holds
   **only when offline**, so an online recipient's `internalizeAction`-
   triggered forced broadcast reaches `super.attemptToPostReqsToNetwork`
   (a real, unmediated broadcast) with no admission gate at all — the exact
   "common shop case: payee has Wi-Fi, payer none" scenario SC-3.3 names.
3. **`TaskSendWaiting`'s own selection (`monitor/tasks/TaskSendWaiting.js`,
   selects `['unsent','sending']` directly via the module function, bypassing
   the storage override entirely per its own cited comment) must never see a
   token req reach `unsent`/`sending` in the first place.** Guard #1 and #2
   together already guarantee this — a token tx never takes the
   `signAndProcess`/non-delayed path that promotes a req to `unsent`, because
   it is never handed to `sendWith` outside `postTokenStep`. Pin this with a
   wiring test (§8.3) rather than a third code change: assert that a gated
   received row never reaches `unsent`/`sending`.

**Payer's optional submit (rule 6).** The SAME drain machinery runs on the
payer's device for its own `handed_over` rows (`token_settlements.role=
'sent'`) — `postTokenStep` is symmetric in payer/recipient; the payer's copy
of the bundle covers at minimum its own tip (it minted the bundle) and
whatever ancestors it itself forwarded evidence for. Because `/submit` is
idempotent (FIX C), the payer racing the recipient to submit the same bytes
is always safe — whichever request lands first gets the real admission; the
second gets the identical idempotent 200.

### 4.4 `parked → handed_over` is an advancing UPDATE, not a re-insert (FIX F, part 1)

`holdSentPaymentOffline` (`W/core/offline/payerHold.ts:59-87`) currently calls
`insertOfflineAction(db, {...})` unconditionally. `insertOfflineAction`
(`W/core/storage/methods/offlineActions.ts:71-93`) is `INSERT OR IGNORE`
keyed on `txid` — with a `parked` row already present (the payer showed the
code, walked away, then came back and confirmed), the insert is silently
ignored and the row **stays `parked` forever**, even though line `:86`
still promotes the transaction `nosend→unproven`. The row is then neither
drainable (`processOfflineActions` reads only `queued`/`posting`,
`:89`) nor cancellable (`cancelParkedPayment`'s `CANCELLABLE` set excludes
anything past `nosend`, and the promotion just moved it past `nosend`). This
is EB-3.1/SM-3.2's finding, independently confirmed live: `insertOfflineAction`
is `INSERT OR IGNORE` on a `UNIQUE txid` and proves re-insert idempotency
only, never a state advance.

**Fix:** `holdSentPaymentOffline` must check for an existing row first and,
if one exists, call the equivalent of `releaseParkedPayment` (`payerHold.ts:
131-144` — flip to `'queued'`, `noteEnqueued`, promote only if still
`nosend`) instead of `insertOfflineAction`; only when no row exists (the
non-nearby-QR, non-parked hand-over path) does the original insert run. Add
a test: park → hold (a second confirm) → row is `queued` and drainable.

### 4.5 Every counterparty-supplied σ is verified before it gates anything (FIX H)

Two call sites carry an unverified signature-shaped value today:

- **Ack `s`** (design-v3's original §3.4/§4.6 sketch, and the equivalent path
  in this repo's `finalizeDelivery`/`Ack` handling): a payee's positive ack
  must never be trusted to mean "already settled" merely because it *looks*
  like it carries a signature. Any admission evidence riding on the ack is
  verified with the same `Admitted()` predicate (§1.2) against
  `session.asset.overlayIdentityKey` before it is allowed to skip a submit
  step or write anything resembling a `settled`/`admitted` state. A value
  that fails verification is treated as **absent** — never as a negative
  ack, never as proof — so the drain still runs its own `postTokenStep`.
- **Handle-rail body** (`L/transfer.ts:248-267`): per the 2026-09-15
  maintainer decision (§12.9), the handle rail is hand-over-first, identical
  in structure to the nearby rail — no online check at send time on any
  rail. The payer builds and signs (`noSend`), assembles the AdmissionBundle
  from local evidence, journals a `handed_over` entry, and posts a v2 body
  (§9.13 of the wire contract) to the recipient's `'mandala-payments'`
  MessageBox: no `/submit`, no broadcast, and no σ_I for the tip at send
  time. The recipient runs `COVER` (§1.2) against its own configured overlay
  key, credits the payment, then submits via `mustSubmit` (ancestors first,
  tip last — the overlay broadcasts what it admits); the payer's own
  drain/reconcile may submit the same bytes later, harmlessly, since
  `/submit` is idempotent (§3.2). Legacy v1 bodies (sender submitted online
  before handing over) remain accepted. As with the ack path above, any
  admission evidence riding on the v2 body is verified with the same
  `Admitted()` predicate before the receiver treats the transfer as
  pre-settled; absent or unverifiable evidence simply means the receiver's
  own drain runs `postTokenStep`/checks `GET /admin/admission/:txid` on its
  next online tick, exactly as it would for a nearby-rail credit.

### 4.6 `token_settlements` rows outlive the BSV pending queue's retry ceiling (FIX I)

`MAX_PENDING_ATTEMPTS = 3` (`W/core/localpay/pending.ts:42`) governs
`localpay_pending`'s BSV-shaped retry loop and burns an attempt on **any**
`internalizeAction` failure, including a transient `Block header not found
for height` (per review) from a fresh-block BUMP the device hasn't caught up
on yet. A `held` token row's credit depends on the *same* `internalizeAction`
call succeeding, but its state of record is `token_settlements`, not
`localpay_pending` — so: (a) a header-verification failure on a token
frame's internalize is classified retriable and does **not** increment any
ceiling that could abandon the row; (b) even if the underlying
`localpay_pending` entry for a token frame does exhaust its own attempts
(kept for the BSV-shaped machinery's own bookkeeping), the drain in §4.3
still owns the `token_settlements` row independently and keeps attempting
`postTokenStep`/re-internalize for it on every online tick — a row is
abandoned only by an explicit `refused`/`orphaned` terminal state, never by a
retry-count ceiling designed for a different, unrelated queue.

### 4.7 Cancel is overlay-authoritative (FIX J)

`cancelParkedPayment` (`W/core/offline/cancelParked.ts`) gains one check when
online and the target has a `token_settlements` row: `GET
/admin/admission/:txid` first; a `200` (already admitted — the counterparty's
own submit beat the cancel) refuses the cancel with `'already-sent'` instead
of aborting inputs the overlay considers spent. Offline, the existing
`nosend`-only `CANCELLABLE` check is unchanged (there is nothing to poll).
There is **no** "cancel by respend" path for a token payment — `token_settlements`
has no `cancelling` state; the only exits from `handed_over`/`held` are the
overlay's own eventual terminal verdict (§5) or this overlay-checked cancel
of a payment that was never admitted.

### 4.8 Ack channels

Unchanged from the existing nearby-rail machinery (`Ack`/`ConfirmDelivery`,
`W/core/localpay/types.ts`) for the hand-over itself on the nearby rail. On
the handle rail, the hand-over **is** the `'mandala-payments'` MessageBox v2
body (§4.5; §9.13 of the wire contract) — no separate pre-settlement channel
exists or is needed. The **settlement** ack
(rule 5 — "acks the payment back to the sender if reachable") reuses the
existing two channels the app already has for exactly this job: nearby while
still connected (`NearbyFlow`'s existing confirm-channel), or the
same `'mandala-payments'` MessageBox once the recipient's
drain gets σ_I(tip). No new channel is introduced; the settlement-ack
payload is `{txid,
outputsToAdmit, admissionSignature}` so the payer's own reconciliation pass
(§4.6, and the general "un-fail a locally-refused row that the overlay now
reports admitted" pass in §6) can verify it with the same `Admitted()`
predicate rather than trusting it blind (FIX H applies here too).

---

## 5. Total state machine

One row per token transaction, per party, in `token_settlements.state`.
Non-terminal states are each owned by exactly one process; terminal states
never revert (mirroring the existing, sound `applyOutcome` cascade
discipline).

| state | owner | offline_actions mirror | entered from | exits to |
|---|---|---|---|---|
| `built` | the build call itself (payer only) | *(no row yet)* | `createAction`+`signAction`, noSend | `parked` (walk away) / `handed_over` (ack) / discarded (`abortAction`) |
| `parked` | user gesture (payer only) | `status='parked'` | payer left the code screen | `handed_over` (re-show, confirm — §4.4's advancing UPDATE) / discarded (`cancelParkedPayment`, §4.7) |
| `handed_over` | the drain (payer only) | `status='queued'` | positive ack | `submitting` (own optional submit) |
| `held` | the drain (receiver, and any intermediate hop forwarding ancestor evidence) | `status='queued'`, `role='received'` | frame received, `COVER` passed, basket-credited | `submitting` |
| `submitting` | the drain (transient) | `status='posting'` | drain claims the row | `admitted` / `refused` / `orphaned` / back to `handed_over`/`held` on `serviceError` |
| `admitted` | the drain, about to broadcast | *(between posting and sent)* | `/submit` returns 200 | `broadcast` |
| `broadcast` | — (terminal) | `status='sent'` | Arcade accepts | — |
| `refused` | — (terminal) | `status='rejected'` | a FIX-D-final verdict for *this* txid | — |
| `orphaned` | — (terminal) | `status='rejected'`, `poisonedByTxid` set | an ancestor was `refused`/`evicted`; existing children-first cascade | — |

### 5.1 Crash-resume at every transition

| Interrupted at | On relaunch/reconnect | Why safe |
|---|---|---|
| Between sign and the very first `park`/`hold` call | Nothing auto-resumes; inputs sit `nosend`. Same acknowledged gap the BSV nearby rail already has for this exact window (`BuiltPayment.reference`'s own doc comment) — **not** a new risk. | Every call site is required to park-or-hold before returning control to the user; a crash *inside* that tiny window is the same class of gap the existing code already accepts for BSV. |
| `parked`, any point | Row + `framePayload` persist untouched; `nosend` tx untouched. Nothing auto-drains a `parked` row (SM-1b/FIX F: never in the submit set). | User can re-show or cancel; unchanged from today. |
| `parked → handed_over` UPDATE (§4.4), mid-write | Retry: the UPDATE is a single SQLite statement; either it landed or it didn't. If it didn't, the row is still `parked` and the next confirm re-attempts the same UPDATE. | Single-statement atomicity; no multi-table ordering to get wrong. |
| `handed_over`/`held`, evidence-table population (§4.2) | Re-derived idempotently from the persisted frame on the next drain tick, in any order, any subset already done. | FIX G: evidence tables are a cache, never a precondition. |
| `submitting`, mid-HTTP-call | Drain's next pass re-issues an identical `/submit` for the same bytes. | FIX C: idempotent `/submit`; at-least-once delivery of byte-identical content is always safe. |
| `admitted`, before broadcast | `token_settlements.admissionSignatureHex` already stored; next drain pass goes straight to broadcast (or safely re-submits first — also idempotent). | Durable admission record, mirroring the lib's own `txJournal` `'accepted'`-stage pattern (`L/txJournal.ts:13-15`) on the wallet side. |
| `broadcast`/`refused`/`orphaned` | Terminal — nothing to resume. | — |

### 5.2 Both-party view (sender S, recipient R), one hop

```
S: built ──(ack)──▶ handed_over ──(drain: postTokenStep)──▶ submitting ──▶ admitted ──▶ broadcast
                                                                 │
R: (frame recv) ──▶ held ─────────(drain: postTokenStep)────────┘──▶ submitting ──▶ admitted ──▶ broadcast
```
Both rows reference the **same txid**; whichever party's drain runs
`postTokenStep` first wins the race to actually call `/submit` — the loser's
own attempt is the idempotent no-op (FIX C), and both rows converge to
`admitted`→`broadcast` from the identical overlay response. If instead the
overlay returns a FIX-D-final refusal, **both** rows converge to `refused`
identically (persisted verdict, §3.2) — this is what closes the
non-monotonic-refusal class of finding (EB-2.2/SC-3.1/SM-2.1): there is no
longer a world where S sees `refused` and R later sees `broadcast` for the
same txid, because the overlay serves the same first-final-verdict to both.

---

## 6. Failure matrix

| # | Mode | System response | User-facing copy |
|---|---|---|---|
| 1 | Overlay refuses for a final reason (conservation/shape/linkage/1-sat/confirmed conflicting spend) | `refused`, terminal, children-first cascade, credit reversed if it was `held` | **"Acme Bank refused this transfer. Nothing was sent and your USDX is unchanged."** (sender) / **"This payment could not be confirmed by Acme Bank and has been reversed."** (recipient, if it had shown as credited) |
| 2 | Overlay refuses for a liftable reason (pause/freeze/allowlist/sanctions/registry) | `serviceError`, retried with backoff, **never** cascaded | **"Acme Bank has paused USDX right now — we'll keep trying."** / no user action needed; row stays "Settling" |
| 3 | Arcade broadcast failure, SPV/chaintracker error, or other infra fault during `/submit` | `503`, `serviceError`, retried; row stays non-terminal | **"We couldn't reach Acme Bank to confirm this transfer. We'll keep trying."** |
| 4 | Overlay admits, then Arcade later reports a terminal txStatus and `/arc-ingest` evicts | `orphaned` for the evicted tx; inputs **restored** (FIX E) rather than stranded; a *new* spend of the same coin is possible | **"That payment didn't reach the network in time and has been reversed — your USDX is back in your balance."** |
| 5 | Two devices (payer + recipient, or two chain hops) both submit the same bytes | Second call is the idempotent no-op; both converge to the same terminal state | no distinct copy — identical to the ordinary success/refusal copy for whichever party sees it |
| 6 | Payer's optional submit (rule 6) races the recipient's | Whichever lands first wins; the other is a no-op; the payer's change becomes spendable the moment either succeeds | no distinct copy |
| 7 | Recipient credited offline, never reconnects before `MAX_PENDING_ATTEMPTS` retriable-classification would have mattered | Cannot exhaust on a retriable header failure (FIX I); genuinely stuck only if the underlying BEEF is bad | **"We couldn't read the payment you received — ask the sender to send it again."** (only for a structurally bad frame, not a header lag) |
| 8 | Payer cancels a `parked` payment the recipient never actually took | `cancelParkedPayment`, offline: local abort as today. Online: overlay-checked first (FIX J) | **"Cancelled — nothing was sent."** or, if the overlay already admitted it, **"This payment already went through and can't be cancelled."** |
| 9 | Chained offline payment (§1.6): an ancestor two or more hops back is refused | Cascades forward through every descendant hop via the existing children-first `applyOutcome`, regardless of which device currently holds which hop | **"A payment earlier in this chain was refused by Acme Bank, so this one has been reversed too."**, attributing the *sender A′* only (never the intermediate honest hop) |
| 10 | Overlay permanently unreachable / asset paused indefinitely | No auto-resolution; named terminal after a bound (FIX M) rather than silent retry forever | **"This payment has been waiting to settle for over 3 days. You can keep waiting or contact Acme Bank."** |
| 11 | A counterparty-supplied σ fails verification (forged or malformed) | Treated as **absent** (FIX H) — never as a decline, never as proof; the drain runs its own `postTokenStep` regardless | no user-facing copy at all — invisible, by design (the wallet never trusted the unverified value in the first place) |
| 12 | Phantom-coin attempt (an un-linked sibling output) reaches a v4-aware recipient | Rejected at admission time (FIX A, overlay-side) — never reaches the wallet's `COVER` walk as a live possibility; if the overlay is unpatched, `Covered()`'s vout-membership check (FIX A, wallet-side) still refuses it | **"This payment doesn't check out with Acme Bank's records and was not accepted."** |

---

## 7. Security analysis

### 7.1 Malicious payer

Bounded by the overlay's own admission rules (conservation, 1-satoshi rule,
linkage-verified ownership, sanctions/access/registry gates) exactly as an
online transfer is today — offline credit changes *when* those rules are
checked (by the recipient's own verified σ_I coverage instead of by a
same-session network round trip), not *what* they are. **Provably
prevented, once FIX A ships on both overlays:** minting value inside a
genuinely-admitted transaction via an un-linked sibling output. **Detected
after the fact, not prevented:** an ordinary double spend of an admitted
coin — the coin can be shown to two offline recipients before either
reconnects; whichever submits second gets `ERR_INPUT_SPENT` (FIX L makes
this the overlay's own refusal, not Arcade's race) and that recipient's
credit reverses. This is Bitcoin's ordinary unconfirmed-double-spend window,
kept to exactly that size (§7.4) — no larger, because FIX A closes the
*minting* class entirely, and no smaller, because nothing offline can prove a
coin has not *also* been shown elsewhere before the network sees a
transaction.

### 7.2 Malicious recipient

A recipient cannot fabricate σ_I for itself (it has no overlay private key)
and cannot make the payer credit anything (the payer never trusts the
recipient's own claims — `finalizeDelivery`'s abort-on-negative-ack path is
unchanged). The residual risk is the ack channel (FIX H): a recipient who
sends a forged positive ack, or a forged "already settled" signal, is fully
neutralized — an unverified value is treated as absent, so the payer's own
drain still runs `postTokenStep` on its own schedule regardless of what the
recipient claims.

### 7.3 Malicious overlay

Out of scope for a holder-facing spec (D1) beyond noting the trust boundary
explicitly: the wallet trusts exactly one public key per asset
(`overlayIdentityKey`) to mean "this issuer's overlay attests to this
admission." A compromised or dishonest overlay operator can sign anything —
this is the same trust boundary the *online* path already has (a dishonest
overlay could always admit whatever it wants for an online transfer too).
Offline settlement adds no new trust the online path did not already require;
it only lets the recipient *verify* the overlay's own claim without a live
round trip, which is strictly less trust than "the overlay said so and I
have no way to check."

### 7.4 The double-spend window, precisely

**What COVER provably prevents, unconditionally (once FIX A ships):**
crediting a coin that traces, via verified σ_I bound to the exact admitted
output set, to something other than a real, conservation-respecting,
overlay-admitted issuance or transfer chain.

**What it cannot prevent, by the nature of offline operation:** a coin shown
to N offline recipients before any of them reconnects settles for exactly
one of them (first-to-`/submit` after FIX L); the other N−1 lose the credit
via the ordinary `orphaned`/`refused` cascade. This is bounded per victim by
the coin's own value (never unbounded, unlike the phantom-coin exploit FIX A
closes) and is detected, not prevented — exactly the same shape as an
ordinary unconfirmed Bitcoin double spend, and no worse. Submission itself is
**not an authenticated act** (§1.6) — anyone holding valid bundle bytes may
`/submit` them — which is a deliberate liveness choice (any reconnecting
party in a chain can settle the whole chain) with one honest trade-off: an
intermediary who intercepted a bundle in transit could race to submit
someone else's transaction first, but this changes only *who* triggered the
broadcast, never *who owns the money* — the transaction's own locking
scripts already fix that.

---

## 8. The Mandala permission module

### 8.1 The gap (ux open question 7, closed)

`'mandala-tokens'` is a plain, non-`'p '`-prefixed basket with every
`seekBasket*Permission` flag set `false`
(`W/core/context/WalletContext.tsx:1272-1274`, confirmed live), so a paired
external app calling through `WalletPermissionsManager` with its own
originator can `listOutputs`/`createAction`(basket output)/
`internalizeAction`(basket insertion)/`relinquishOutput` against it **with no
prompt at all** — the manager's basket-access checks are the *only* gate for
a non-`'p '` basket, and every one of them is configured off for this basket.

### 8.2 The mechanism that already exists (BTMS's, reused verbatim)

`WalletPermissionsManager` routes **any** `createAction`/`internalizeAction`
output whose `basket` starts with `'p '`, any `listOutputs`/`relinquishOutput`
call whose `basket` starts with `'p '`, and any `listActions` label that
starts with `'p '`, through `config.permissionModules[schemeID]` —
`schemeID = basketOrProtocolName.split(' ')[1]` — **regardless of
originator** (confirmed live: `collectNonPBaskets`/`delegateToPModuleIfNeeded`,
`node_modules/@bsv/wallet-toolbox-client/out/src/WalletPermissionsManager.js:
164-183, 2798-2810, 2965-2980, 3045-3080`; no `isAdminOriginator` bypass
exists in this routing). This is exactly how `@bsv/btms-permission-module`'s
`BasicTokenModule` is wired today
(`W/core/context/WalletContext.tsx:1265-1290`: `permissionModules: { btms:
btmsModule }`).

`createSignature` is **also** P-routed, but keyed on `protocolID[1]`, not on
a basket — Mandala's `FT_PROTOCOL = [2, 'mandala token']`
(`L/constants.ts:8`) does not start with `'p '`, and renaming it would touch
every derivation in the whitepaper's blinding scheme
(`invoiceNumber`/`childOffset` in `L/blinding.ts:20-23,37-39`, and
`walletMandalaUnlock` in `L/unlock.ts`) — far too invasive for this fix.
**Basket-gating alone is sufficient in practice**: `listOutputs` is also
gated, so a paired app can no longer discover the `customInstructions`
(`keyID`/`counterparty`) a Mandala unlocking script needs without first
passing the module's prompt — it cannot build a correct `createSignature`
call for a coin it was never told the derivation for. Protocol-name gating
is noted as a defense-in-depth option for a later revision (§11).

### 8.3 The fix: rename the basket, add `MandalaTokenModule`

- `L/constants.ts:11` — `BASKET = 'mandala-tokens'` → `BASKET = 'p mandala'`
  (a flat, single-scheme basket for every asset — unchanged cardinality from
  today; `'p mandala'.split(' ')[1] = 'mandala'`, a valid schemeID with no
  payload requirement for the basket case).
- **One-time storage migration** (new work, since the basket name is
  persisted per-output in the toolbox's own `output_baskets`/`outputs`
  tables, which this repo does not own the schema of): on first boot after
  this change, run `UPDATE outputs SET basketId = (SELECT basketId FROM
  output_baskets WHERE name = 'p mandala' AND userId = outputs.userId) WHERE
  basketId IN (SELECT basketId FROM output_baskets WHERE name =
  'mandala-tokens' AND userId = outputs.userId)`-shaped logic, guarded to run
  once (a schema-version marker in `key_value_store`, matching the app's
  existing migration doctrine). Since "no live builds exist" today
  (design-v3's Compatibility section), this migration has zero live rows to
  move at ship time — but it must exist in the codebase before any device
  holds a token under the old name, and is specified here so it is never
  skipped later.
- **New module**, `W/core/mandala/permissionModule.ts` (mirrors
  `@bsv/btms-permission-module`'s `BasicTokenModule` shape and file
  organization exactly, but decodes Mandala's own script layout — `<36B
  assetId><scriptnum amount> OP_2DROP <P2PKH tail>` via `MandalaToken.decode`
  from `@bsv/templates`, **not** BTMS's `PushDrop.decode`, since the two
  token formats are unrelated):

```ts
export interface MandalaTokenModuleDeps {
  adminOriginator: string
  /** Same shape as BTMS's requestTokenAccess: app id + JSON message -> approved? */
  requestTokenAccess: (app: string, message: string) => Promise<boolean>
  resolveAssetMetadata: (assetId: string) => Promise<{ label?: string; ticker?: string } | null>
}

export class MandalaTokenModule implements PermissionsModule {
  // Same session-authorization cache shape as BasicTokenModule: Map<originator, timestamp>,
  // SESSION_TIMEOUT_MS = 60_000, periodic cleanup — reused verbatim, it is not Mandala-specific.

  async onRequest(req: { method: string; args: object; originator: string }): Promise<{ args: object }> {
    // THE ONLY MANDALA-SPECIFIC LINE: our own app's lib calls always carry
    // ADMIN_ORIGINATOR (per the wallet's `withAdminOriginator` wrapper, ux
    // §3.2 #16) — auto-approve them with no prompt, preserving "no review
    // screen, the CTA is the confirmation" (ux §4.1 step 6). Everyone else
    // is a paired external caller and is prompted, exactly like BTMS.
    if (req.originator === this.deps.adminOriginator) return { args: req.args }

    switch (req.method) {
      case 'listOutputs':
      case 'relinquishOutput':
        await this.promptOnceForAccess(req.originator, /* action */ req.method)
        break
      case 'createAction':
        await this.promptForSpendOrCredit(req.args as CreateActionArgs, req.originator)
        break
      case 'internalizeAction':
        await this.promptForCredit(req.args, req.originator)   // an app crediting ITSELF
        break                                                   // via basket insertion
    }
    return { args: req.args }
  }

  async onResponse(res: unknown, ctx: { method: string; originator: string }): Promise<unknown> {
    return res   // Mandala tokens carry no post-hoc metadata to redact; unlike BTMS
                 // there is no captureAuthorizedTransaction/preimage-binding layer
                 // here (createSignature is not P-routed for this protocol — see §8.2)
  }
  // ...promptOnceForAccess / promptForSpendOrCredit / promptForCredit mirror
  // BasicTokenModule's promptForBTMSAccess/promptForTokenSpend shape exactly,
  // decoding amounts via MandalaToken.decode(output.lockingScript) per output
  // whose basket === 'p mandala', summing send vs. change by whether the
  // output carries a `basket` (change, stays in 'p mandala') or not
  // (recipient output — Mandala payer outputs are never basketed, L/transfer.ts:123-133).
}
```

### 8.4 Wiring

Identical pattern to BTMS, in `WalletContext.tsx` beside the existing block
(`:1265-1290`):

```ts
const mandalaModule = new MandalaTokenModule({
  adminOriginator,
  requestTokenAccess: mandalaPromptHandler,   // same usePermissionQueue pattern as btmsPromptHandler
  resolveAssetMetadata,
})
const permissionsManager = new WalletPermissionsManager(wallet, adminOriginator, {
  ...existingConfig,
  permissionModules: { btms: btmsModule, mandala: mandalaModule },
})
```

Both `mandala-tokens`-basket-renamed-to-`p mandala` reads/writes throughout
`lib/src/*` and every `ux` §3.2/§3.3 reference to `'mandala-tokens'` update
to `'p mandala'` mechanically — no behavior change for the app's own code,
since it always calls through `withAdminOriginator` and the module passes
those calls through untouched.

### 8.5 What it prompts for

| Trigger | Originator | Prompt |
|---|---|---|
| `listOutputs({basket:'p mandala',...})` | this app (admin) | none |
| `listOutputs({basket:'p mandala',...})` | paired app | **"App wants to see your Acme Dollar balance"** — once per 60s session |
| `createAction` with an output in `'p mandala'` (spend or insert) | this app (admin) | none — the Pay screen's own CTA is the confirmation (ux §4.1 step 6) |
| `createAction` with an output in `'p mandala'` | paired app | **"App wants to spend 25.00 USDX"** with recipient/amount/asset, same shape as BTMS's `promptForTokenSpend` |
| `internalizeAction` inserting into `'p mandala'` | this app (admin) | none |
| `internalizeAction` inserting into `'p mandala'` | paired app | **"App wants to credit 40.00 USDX to your wallet"** |
| `relinquishOutput({basket:'p mandala'})` | this app (admin) | none — `reconcileBans`'s eviction path (ux §6.3) already shows its own alert |
| `relinquishOutput({basket:'p mandala'})` | paired app | **"App wants to remove a USDX holding from your wallet"** |

### 8.6 Tests

- Unit: `onRequest` with `originator === adminOriginator` returns args
  unchanged for every method, with zero calls to `requestTokenAccess` — pins
  the "no review screen" invariant for the app's own flows.
- Unit: `onRequest` with a foreign originator calls `requestTokenAccess`
  exactly once per method per 60s session window (the BTMS session-cache
  shape, reused), and denial throws (mirrors `BasicTokenModule`'s
  `'User denied permission to spend tokens'` shape).
- Unit: amount extraction from mixed basketed/non-basketed outputs via
  `MandalaToken.decode`, including a script that fails to decode (must not
  throw — falls back to a generic prompt, mirroring `BasicTokenModule`'s
  `promptForGenericAuthorization` fallback).
- Wiring: `listOutputs({basket:'p mandala'})` from a non-admin originator
  reaches `MandalaTokenModule.onRequest` (integration test against a real
  `WalletPermissionsManager`, asserting the P-routing actually fires for
  this basket name — a regression here would silently reopen the exact gap
  this section closes).
- Wiring: the one-time basket-rename migration is idempotent (running it
  twice does not double-move rows) and a no-op when zero rows carry the old
  basket name.

---

## 9. Precise edits to `design-final-ux.md`

Sections not listed are unchanged and stand as written.

**§2.3 (Pay screen mockup and prose), step reference to "Nearby rail" —**
no visual change; the copy at step 3.5 area that implies the payer must be
online is removed (see §4.3 replacement below); the mockup itself
(`Pay 25.00 USDX to ◈alice`) is unchanged.

**§4.3 "Nearby rail — the numbered sequence" — REPLACED IN FULL.** The
opening line *"v1 requires the payer to be online... This removes the
`offline_linkage` store and the payee-driven overlay-gated drain from v1
entirely (§10)"* is **false under the settled model** and is deleted. New
text:

> **v1 supports fully offline nearby token payments, per the maintainer's
> settlement model (§0.1 of the offline-settlement-final spec).** The payer
> builds and hands over the frame **without** submitting first — submission
> is the recipient's job (rule 3), with the payer's own drain submitting
> too, optionally, whenever it next comes online (rule 6). Steps:
>
> **Payee:** unchanged from the existing draft — selects the asset, types
> base units, picks "Someone nearby", `mintSession({asset})`.
>
> **Payer:**
> 1. Scan → `classifyScan` (unchanged).
> 2. Overlay-mismatch refusal (unchanged — v1 is single-overlay).
> 3. `send_confirm` shows "Pay 25.00 USDX to ◈alice" (unchanged).
> 4. `buildPaymentFrame` token path: select from `mandala-tokens`
>    [renamed `p mandala`, §8] with `include:'entire transactions'`; lock via
>    `prepareBlindedPayment`; two-step `createAction`/`signAction({noSend:
>    true})`; **assemble the AdmissionBundle** (§1.1 of the offline-settlement-
>    final spec) from the wallet's own `token_admissions`/`token_admission_edges`/
>    `token_linkage_payloads` tables for every ancestor in the transfer's own
>    BEEF.
> 5. **Hand over the frame immediately — no pre-submit.** This restores the
>    committed spec's original §4 step 6 (submit after the positive ack, on
>    the DRAIN, not before hand-over) and is the point of this revision: the
>    payer never blocks a face-to-face payment on connectivity.
> 6. Positive ack → `holdSentPaymentOffline` (§4.4's advancing-UPDATE fix, if
>    the row is `parked`) → the drain owns everything from here (§4.3 of the
>    offline-settlement-final spec).
> 7. Success screen: **"Sent. Settling with Acme Bank — you'll see it
>    confirm once you or Alice reconnect."** when offline; **"Sent · settled
>    with Acme Bank"** when the drain's own online submit already returned
>    σ_I before the screen dismisses.
>
> **Payee settle:** `verifyFramePayment`'s token branch runs unchanged
> (already correct under D2, per ux #29). The frame is credited — spendable
> immediately — the moment `COVER` (§1.2 of the offline-settlement-final
> spec) returns `ok:true`; a frame that fails `COVER` is refused at hand-over
> exactly like a `not_mine`/`unparseable` decode failure today, with copy
> **"This payment doesn't check out with Acme Bank's records and was not
> accepted."** The three-tone receipt doctrine applies: **"Received offline ·
> not yet confirmed by Acme Bank"** until the drain's own `postTokenStep`
> returns `broadcast`.
>
> **Credit:** unchanged — `processPending` branches on `frame.kind`,
> `internalizeAction` with `protocol:'basket insertion'` into `'p mandala'`.

**§5 (the receive flow) — one addition, no deletions.** §5.1's "Receive-side
failures surface" gains: a `held` row that has passed `COVER` and been
credited but has not yet reached `broadcast` after 3 days surfaces via the
same `'token_attention'` `homeBadges` kind already specified, with copy
**"Waiting on Acme Bank to confirm — tap for details"** (FIX M). §5.2's arrival
overlay gains a `not yet confirmed by {{issuer}}` qualifier line, sourced
from `token_settlements.state !== 'broadcast'`, using the existing
`firstHoldNote`/`amountText` slots — no new component.

**§6.1 "Balances" query — one line changed.** `listOutputs({basket:
'mandala-tokens', ...})` → `listOutputs({basket:'p mandala', ...})`
throughout (mechanical, per §8.4). No other change: a `held`-but-not-yet-
`broadcast` output is still `spendable:true` in the toolbox's own bookkeeping
(unchanged — this is what makes chained offline re-spend work at all, per
§1.6), so the balance figure is unaffected.

**§10 "Explicitly out of scope", item 3 — REPLACED.** Old text: *"No
offline nearby token payments in v1. The `offline_linkage` store and the
payee-driven overlay-gated drain (committed spec §6) are deferred... Deferring
the offline path is the single biggest scope decision here and it is named as
one."* New text:

> **3. ~~No offline nearby token payments in v1~~ — reversed.** The
> maintainer's settlement model (recipient submits, recursive σ_I walk-back,
> idempotent `/submit`, payer's own optional submit) makes offline nearby
> token payments the *design center*, not a deferred feature — see the
> offline-settlement-final spec in full. What remains genuinely out of scope
> for v1 is unchanged from the rest of this document: multi-issuer nearby
> sessions (item 4, unchanged) and any dApp-facing story beyond the
> permission module in §8 of the offline-settlement-final spec.

**§11 "Open questions", item 3 — RESOLVED, not open.** Old text asked
whether "submitting to the overlay before hand-over" (the now-reversed
decision) was acceptable. This is superseded: the maintainer's own settlement
model is the answer, and it is the opposite of what was asked — hand-over
happens **before** any submit, unconditionally. Item 3 is struck.

**§11, item 7 — RESOLVED.** *"'mandala-tokens' is a non-admin basket with
every seekBasket*Permission set false... Is that a v1 disclosure gap to
close, or an accepted exposure?"* Answer: closed, not accepted — §8 of the
offline-settlement-final spec (rename to `'p mandala'`, add
`MandalaTokenModule`).

All other sections of `design-final-ux.md` (design principles, information
architecture, component inventory except the mechanical basket-name edits
above, the send-flow numbered sequence for the **handle** rail §4.1–4.2, the
asset-trust/disclosure copy, accessibility checklist, i18n key list, and every
other "explicitly out of scope" item) are **unaffected** and stand exactly as
written.

---

## 10. Implementation order

Dependencies flow strictly downward; an item may start once everything above
it in its column is done. Items marked **[ts-stack PR, try repo-local
first]** are the two escalation candidates from §3.6 — do not open either PR
before confirming the repo-local wrapper genuinely cannot work.

**Phase 0 — overlay, both engines (blocks everything else; this is FIX A/B/L,
the theft-lens fatals).**
1. Go: reject-not-skip unlinked/mismatched token outputs (`topic_manager.go`).
   Update `TestWrongPKHLinkageSilentlySkipsOutput`/
   `TestMissingOutputLinkageBreaksConservation`.
2. TS: repo-local wrapper rejecting the same shape before delegating to the
   pinned manager. **[ts-stack PR, try repo-local first]** if the wrapper
   cannot see enough to reject correctly.
3. Both: σ_I message → `admissionDigestV2(txid, outputsToAdmit)` (§3.1),
   gated on the `tm_mandala` topic's own admitted set specifically.
4. Both: conditional spend-mark (FIX L) + overlay-side conflicting-spend
   refusal.
5. Remove "mined ⇒ admitted" from any offline-verifier reference material
   (this is a wallet-side/spec-level fix, not overlay code, but Phase 0 is
   where the overlay-side precondition it depends on — real σ_I meaning
   something — lands).

**Phase 1 — overlay persistence and verdict taxonomy (FIX C, D, E).**
6. Go: add the `mandalaAdmissions` collection + `GET /admin/admission/:txid`
   (new work — currently absent entirely).
7. TS: add `outputsToAdmit` to the existing `AdmissionRecord`; make the
   persistence write awaited, not fire-and-forget.
8. Both: sign from applied-transaction-store proof on the dupe path / a
   missing record (FIX C).
9. Go: reclassify every non-policy `Submit` error to `503 ERR_UNAVAILABLE`
   before `errorResponse` (`submit.go`).
10. TS: capture the topic manager's own rejection reason before the pinned
    engine's dupe-path swallow (repo-local capture). **[ts-stack PR, try
    repo-local first]** if impossible without patching `Engine.js`.
11. Both: `evictTx`/its TS equivalent restores inputs (FIX E), persisting the
    pre-spend snapshot on the admission record; require a non-empty Arcade
    callback token whenever eviction is wired.

**Phase 2 — wallet stores and drain (FIX F, G, I; depends on Phase 0–1 for
anything it submits to actually be trustworthy).**
12. Migration: four new tables (§4.1).
13. `PaymentFrame` v4 codec change (§2.1) — additive to the existing v3
    codec module, version-fenced.
14. `postTokenStep` + `processOfflineActions` branch (§4.3).
15. `finalizeDelivery` never broadcasts a token frame (§4.3, guard #1).
16. `attemptToPostReqsToNetwork` holds token reqs regardless of online (§4.3,
    guard #2). Wiring test for guard #3 (`TaskSendWaiting` never sees a
    token req at `unsent`/`sending`).
17. `holdSentPaymentOffline`'s `parked→handed_over` advancing UPDATE (§4.4).
18. `token_settlements` independent retry ownership (FIX I, §4.6).

**Phase 3 — verification and UX (depends on Phase 2).**
19. `COVER`/`Admitted` verifier (§1.2), with the SQL recursive-CTE
    implementation (§4.1) and a pure, storage-independent unit-testable core
    (per evidence-bundle's own "one pure verifier... test vectors" goal —
    keep the `walk()` logic in a module with no SQLite dependency; the CTE is
    an optimization over the same logic, not a second implementation to keep
    in sync).
20. FIX H verification of counterparty-supplied σ everywhere it's consumed.
21. FIX J overlay-checked cancel.
22. §9's edits to `design-final-ux.md` land as an actual diff to that file.
23. §8's `MandalaTokenModule` + basket rename + one-time migration.
24. Failure-matrix copy (§6) wired into `classifyTokenSendError`/
    `ConsequenceNote`/`ResultBanner` per the existing i18n-key discipline.

Nothing in Phases 2–3 requires a ts-stack PR — every wallet-side and
repo-local-overlay change is additive to code this repo owns outright.

---

## 11. Open questions for the maintainer

1. **σ_I message-format break (§3.1) has no live traffic to migrate, but
   confirm the timing:** should the digest change land in the *same* PR as
   the reject-not-skip fix (Phase 0), or is there a reason to sequence them
   separately? This spec assumes they ship together since FIX A is two
   halves of one fix.
2. **The two ts-stack escalation candidates (§3.6, §10 items 2 and 10):**
   confirm the repo-local-wrapper-first policy applies here as it does
   elsewhere, and who evaluates whether the wrapper is sufficient before a
   PR is opened.
3. **Submission is not an authenticated act (§7.4).** Confirm this is
   accepted as designed — anyone holding valid bundle bytes may `/submit`
   them, which is what gives chained offline settlement its "whoever
   reconnects first" liveness property (§1.6) — rather than a gap to close
   with per-submitter authentication.
4. **FIX M's exact bound** ("stuck for N days") — this spec used 3 days as a
   placeholder matching typical BSV mempool-eviction/dispute-window
   intuitions; confirm the real number, and whether it should be
   configurable per-issuer via `resolveAssetState` rather than hard-coded.
5. **Protocol-name P-module gating (§8.2's deferred defense-in-depth)** — is
   renaming `FT_PROTOCOL` ever on the table, or is basket-gating alone
   accepted as sufficient permanently? This spec argues it is sufficient
   today; confirm that argument holds for the intended dApp-pairing story,
   which is otherwise out of scope (D1).
6. **The `lib/src/overlay.ts:109` regression** noted at the top of this
   document (`void journalPut` where the adjacent comment and a cited test
   both say it must be awaited) — is this an in-flight edit from unrelated
   work in this session, or a real defect to fix before Phase 0 ships? It
   directly undermines the payer's-optional-submit crash-safety argument
   this spec's §5 leans on for the *online lib* path (as opposed to the
   nearby-rail path, which uses the wallet's own `token_settlements` durable
   state and is unaffected either way).
7. **`token_admission_edges`/`token_admissions` retention** — store-centric's
   sibling design flagged that pruning these tables on "minedness" would
   break offline provability for an old, still-held coin. This spec doesn't
   yet specify a retention/pruning policy at all (tables grow forever).
   Confirm a policy: e.g., retain an admission row for as long as this
   wallet holds any unspent output of that txid or an unadmitted descendant
   of it, prune otherwise.
8. **Certificate slot** (`TokenPayment.certificates`, unchanged from v3) is
   still opaque and unconsumed by anything in this spec — confirm it remains
   entirely out of scope here (per design-v3's own resolved-question 1) and
   is not expected to interact with the AdmissionBundle in v4.

---

## 12. Maintainer decisions (2026-09-15)

Answers to §11, in order. All eight questions are resolved; none remain open.

1. **Digest timing (§11.1).** The σ_I digest change ships in the *same*
   change as the reject-not-skip fix. FIX A is two halves of one fix and is
   not sequenced apart.
2. **ts-stack escalation policy (§11.2).** Repo-local wrapper first, in both
   cases. A ts-stack PR is opened only if the wrapper is provably impossible
   — not merely inconvenient. Per the standing ts-stack workflow, any such PR
   ships as a PR only; the maintainer merges, tags and publishes to npm
   manually.
3. **Unauthenticated submission (§11.3).** Accepted as designed. Anyone
   holding valid bundle bytes may `/submit` them; this is what gives chained
   offline settlement its "whoever reconnects first" liveness property
   (§1.6). This is not a gap to close with per-submitter authentication.
4. **FIX M's bound (§11.4).** 3 days, fixed. It lives as a single constant,
   `STUCK_AFTER_MS`, in the wallet — not in the overlay and not resolved
   through `resolveAssetState`. Per-issuer configuration of this bound is
   deferred, not designed here.
5. **Protocol-name P-module gating (§11.5).** Basket-gating alone is
   accepted as sufficient. Renaming `FT_PROTOCOL` for defense-in-depth is
   deferred; it is not on the table for v1 and is not required by the
   intended dApp-pairing story.
6. **The `lib/src/overlay.ts:109` regression (§11.6).** Confirmed fixed, same
   day, by the D3c async-storage change: the `'accepted'` journal write is
   now awaited before `broadcastAcceptedTx` runs, and a test holds the write
   open and asserts `createAction({sendWith})`/`sendWith` is not called until
   it resolves. This was an in-flight regression against the file's own
   documented contract, not a deliberate change, and it is closed.
7. **`token_admission_edges`/`token_admissions` retention (§11.7).** No
   pruning in v1. The tables grow without bound; a retention/pruning policy
   (e.g. retain while this wallet holds any unspent output of that txid or an
   unadmitted descendant of it, prune otherwise) is deferred to a later spec,
   not designed here.
8. **Certificate slot (§11.8).** Confirmed entirely out of scope. It remains
   opaque and unconsumed by this spec and is not expected to interact with
   the AdmissionBundle in v4.
9. **Every rail is offline-first at send time (2026-09-15 addendum).** "We
   shouldn't have to check anything with the issuer when making a payment
   (we need to be able to do this offline)" applies to every rail, not only
   nearby. The handle (MessageBox) rail is revised to be hand-over-first,
   identical in structure to the nearby rail (§4.5, §4.8; wire contract
   §9.13; UX design §4.1-§4.2): no `/submit`, no broadcast, and no σ_I for
   the tip at send time on any rail. Legacy v1 handle-rail bodies (sender
   submitted online before handing over) remain accepted, so this ships
   without a hard migration cutover.
10. **Submit right after an acknowledged hand-over, when online (2026-09-15
    refinement).** Hand-over-first (decision 9) stays inviolable — nothing
    about this refinement gates or can fail the hand-over itself. But once
    the MessageBox post is acknowledged (nearby: the positive ack), an
    online payer no longer waits for the drain's next tick: it submits the
    identical journaled bytes immediately, exactly as the drain would
    (idempotent `/submit`; the overlay broadcasts on admission). Offline,
    the drain submits on reconnect exactly as before (rule 6, unchanged);
    the recipient's own submit (rule 3) stays valid either way — the two
    submitters race harmlessly. This is a latency improvement only, never a
    correctness dependency: a retryable refusal or a network fault leaves
    the payer's `'handed_over'` entry untouched for the drain/reconcile to
    keep retrying, and even a FINAL refusal does not abort it here (the
    recipient may already hold evidence over these exact bytes) — reconcile's
    existing RETRY_CAP is what eventually gives up. See UX design §4.1 step
    7/8 and §4.3 steps 6-8, and wire contract §9.13.

**One deviation from §9's edits to `design-final-ux.md`, noted here for the
record.** The basket rename is not a hard-coded literal swap. It ships as a
`configureMandala({ basket })` option in the lib, **defaulting to
`'mandala-tokens'`** — so the live web console keeps its existing outputs
under the basket it already uses, untouched. The mobile wallet is the one
caller that passes `basket: 'p mandala'` explicitly. The one-time migration
(moving any already-held outputs from the old basket name to the new one)
lives in the wallet only; the lib itself performs no migration and the web
console needs none.

**(11) 2026-09-15 — an admitted transaction is never aborted locally.** Incident: the lib's reconcile bulk sweep aborted a noSend action 0.7 s after the overlay had admitted (and broadcast) it, because the wallet's intentional token hold made the lib's post-acceptance `sendWith` look successful and its `accepted` journal entry was cleared. Rules now: the sweep is opt-out (the wallet runs reconcile with `sweep:false`), TTL-gated, and never touches a txid with any journal entry; the lib clears `accepted` only when the wallet reports the transaction as posted; the wallet refuses `abortAction` for any reference whose settlement row is held / handed_over / submitting / admitted / broadcast; and a repair pass re-attaches a transaction the wallet marked failed but the overlay admitted.

## Amendment 2026-09-15 (b) — the fee-parent hole and the handle rail's missing retry

Incident: an 8 TOKEN handle-rail send (`8045794f`) sat at "settling". The immediate
`settleNow` ran but no `/submit` left the device; nothing retried it; the recipient
raw-broadcast it; the payer's lib reconcile then re-submitted and stranded.

Root causes and the rules that now hold:

1. **COVER and `/submit` see the wallet's full ancestry.** A noSend action's stored
   `inputBEEF` carries only the parents the lib supplied (token parents). The fee input
   the wallet allocates itself — routinely unmined change of an earlier BSV send — was
   invisible, and FIX B correctly reads an invisible parent as a hole. `cover()` and
   `submit()` now merge every missing parent from `storage.getValidBeefForTxid` before
   walking or posting. FIX B is unchanged.
2. **Every drain-owned `sent` row is stepped on every tick.** `sendToHandle` writes no
   queue row, so the release drain never stepped its rows. `settlePendingSends()`
   (runtime) takes the `settleNow` step for each `handed_over`/`submitting`/`admitted`
   row of role `sent` on the drain tick. `built`/`parked` stay the user's (FIX F).
3. **Guard #2 covers `TaskSendWaiting`.** An internalized inbox credit leaves its
   request `unsent`, which the monitor posts through the module function, past the
   storage hold. `holdTokenReqsForDrain()` + the `processUnsent` patch hold every
   request with a `token_settlements` row.
4. **The lib never broadcasts in this host.** `reconcileWallet(wallet, { sweep: false,
   broadcast: false })`: the lib may re-submit its journaled bytes (idempotent) but the
   drain's `postTokenStep` is the only broadcaster and clears the journal entry.
5. Silent stalls (`cover` incomplete, `/submit` unavailable, a step that did not move
   the row) are logged with their reason.

Observed on device after the fix: `8045794f` → `broadcast` on the first tick (journal
cleared); `a4a6b346` (a real double-spend) → `refused ERR_INPUT_SPENT` once its BEEF was
complete — before that the overlay answered 503 "missing an associated source
transaction", which is retryable by contract and never burned the row.

// Package draft is the fuelKeeper draft signer (spec §4.3). It verifies a
// fuel request on its own authority (§3.1), reserves k proven fuel outputs,
// and returns the fuel-pair skeleton (§1.1): input i spends fuel i and is
// signed SIGHASH_SINGLE|ANYONECANPAY|FORKID, so it commits only to itself and
// to output i, the 1-sat fee output paying F tokens to the issuer.
//
// Reservation safety. Every row this request claims ends in exactly one of:
//   - a verified survivor: claimed, detached from the pool basket, and still
//     spendable in storage;
//   - dropped: a definitive negative answer (the storage funder spent it, its
//     stored data is unusable, or our own signature over it does not verify);
//   - left `reserving` for sweeper rule 0 (§4.7), which re-runs detach+verify
//     per row: any row whose state the keeper could not observe (a storage
//     error, a cancelled request). Such rows are never dropped — the keeper
//     must not drop fuel it cannot see.
//
// The blanket ReleaseReserving(requestID, needs_recheck=1) is issued only
// while every reserving row of the request is a verified survivor. Releasing
// an unverified row could let a later chain recheck see a funder spend and
// deny an innocent requester (§4.7 rule 2), so with any such row present the
// whole request is left to the sweeper instead.
//
// Crash windows: before Claim nothing is held; between Claim and Commit the
// rows sit `reserving` and sweeper rule 0 resolves them after RESERVING_TTL;
// after Commit the draft is `reserved` until consume, release or TTL (rule 1).
// No DB transaction stays open across a storage or signing call.
package draft

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/auth"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/econ"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

// Refusal codes (§3.1), in the order the checks run.
const (
	CodeShape       = "ERR_SHAPE"
	CodeAuth        = "ERR_FUEL_AUTH"
	CodeIneligible  = "ERR_FUEL_INELIGIBLE"
	CodeDenied      = "ERR_FUEL_DENIED"
	CodeQuota       = "ERR_FUEL_QUOTA"
	CodeTooLarge    = "ERR_FUEL_TOO_LARGE"
	CodeUnavailable = "ERR_FUEL_UNAVAILABLE"
)

// fuelSequence is the fuel inputs' nSequence (§1.1).
const fuelSequence = 0xffffffff

// cleanupTimeout bounds a best-effort cleanup write issued after the request
// context may already be cancelled.
const cleanupTimeout = 10 * time.Second

// Request is the verbatim §3.1 body plus the overlay-supplied asset fields.
type Request struct {
	AssetID           string `json:"assetId"`
	N                 int    `json:"n"`
	M                 int    `json:"m"`
	Requester         string `json:"requester"`
	Nonce             string `json:"nonce"`
	Ts                int64  `json:"ts"`
	Sig               string `json:"sig"`
	FeeRatePerKb      int64  `json:"feeRatePerKb"`
	IssuerIdentityKey string `json:"issuerIdentityKey"`
}

// Pair is one fuel pair of the draft (§3.1 response). Amounts are decimal strings.
type Pair struct {
	Vin          int    `json:"vin"`
	Vout         int    `json:"vout"`
	FuelOutpoint string `json:"fuelOutpoint"`
	FuelSatoshis uint64 `json:"fuelSatoshis"`
	KeyID        string `json:"keyID"`
	Counterparty string `json:"counterparty"`
	FeeScript    string `json:"feeScript"`
	FeeAmount    string `json:"feeAmount"`
}

// Response is the §3.1 200 body.
type Response struct {
	RequestID  string `json:"requestId"`
	AssetID    string `json:"assetId"`
	K          int    `json:"k"`
	FeePerPair string `json:"feePerPair"`
	ExpiresAt  int64  `json:"expiresAt"`
	DraftTx    string `json:"draftTx"`
	FuelBeef   string `json:"fuelBeef"`
	Pairs      []Pair `json:"pairs"`
}

// Refusal is a §3.1 rejection: HTTP is the status the API answers with.
type Refusal struct {
	Code        string `json:"code"`
	HTTP        int    `json:"-"`
	Retryable   bool   `json:"retryable"`
	Description string `json:"description"`
}

func refuse(code string, status int, retryable bool, desc string) *Refusal {
	return &Refusal{Code: code, HTTP: status, Retryable: retryable, Description: desc}
}

func shape(desc string) *Refusal        { return refuse(CodeShape, 400, false, desc) }
func unauthorized(desc string) *Refusal { return refuse(CodeAuth, 401, false, desc) }
func ineligible(desc string) *Refusal   { return refuse(CodeIneligible, 409, true, desc) }
func unavailable(desc string) *Refusal  { return refuse(CodeUnavailable, 503, true, desc) }

// Drafter signs fuel drafts. Safe for concurrent use: it holds no mutable
// state; every race is settled by the store's compare-and-set transitions.
type Drafter struct {
	cfg      config.Config
	st       *store.Store
	src      fuel.Source
	verifier *auth.Verifier
	params   econ.Params
	now      func() time.Time
	log      *slog.Logger
}

// New returns a Drafter with a no-op logger (see WithLogger). A nil now
// means time.Now.
func New(cfg config.Config, st *store.Store, src fuel.Source, v *auth.Verifier, now func() time.Time) *Drafter {
	if now == nil {
		now = time.Now
	}
	return &Drafter{
		cfg: cfg, st: st, src: src, verifier: v, now: now,
		params: econ.Params{D: cfg.Denomination, BSVRatePerKb: cfg.BSVRatePerKb, KMax: cfg.KMax},
		log:    slog.New(slog.DiscardHandler),
	}
}

// WithLogger sets the logger (nil keeps the current one) and returns d.
func (d *Drafter) WithLogger(l *slog.Logger) *Drafter {
	if l != nil {
		d.log = l
	}
	return d
}

// Draft runs §4.3. A non-nil Refusal is a §3.1 rejection; a non-nil error is
// an infrastructure failure the API answers with 503 ERR_FUEL_UNAVAILABLE.
func (d *Drafter) Draft(ctx context.Context, req Request) (*Response, *Refusal, error) {
	// 1. Shape → auth → eligibility → deny list (§3.1 order, first wins).
	if req.N < 1 || req.N > d.cfg.NMax || req.M < 1 || req.M > d.cfg.MMax {
		return nil, shape(fmt.Sprintf("n must be in [1, %d] and m in [1, %d]", d.cfg.NMax, d.cfg.MMax)), nil
	}
	if !token.ValidAssetID(req.AssetID) {
		return nil, shape("assetId must be <64 lowercase hex txid>.<vout>"), nil
	}
	// The signature covers the requester string exactly as sent.
	msg := auth.DraftMessage(req.AssetID, req.N, req.M, req.Requester, req.Nonce, req.Ts)
	if err := d.verifier.Verify(ctx, req.Requester, req.Nonce, req.Sig, req.Ts, msg); err != nil {
		if errors.Is(err, auth.ErrShape) {
			return nil, shape(err.Error()), nil
		}
		return nil, unauthorized("signature invalid"), nil
	}
	requesterPub, err := auth.ParseRequester(req.Requester)
	if err != nil { // unreachable: Verify parsed it
		return nil, shape(err.Error()), nil
	}
	// Everything keyed by requester (deny list, quotas, rows) uses the
	// canonical lowercase compressed form, so a case variant of the same key
	// cannot escape the deny list or the quotas.
	requester := requesterPub.ToDERHex()

	if !d.cfg.AllowsAsset(req.AssetID) {
		return nil, ineligible("asset is not fuel-eligible"), nil
	}
	if req.FeeRatePerKb < 1 {
		return nil, ineligible("asset has no feeRatePerKb"), nil
	}
	if !strings.EqualFold(req.IssuerIdentityKey, d.src.IdentityKeyHex()) {
		return nil, ineligible("issuerIdentityKey is not this keeper's identity"), nil
	}
	fee, err := econ.FeePerPair(d.params, req.FeeRatePerKb)
	if err != nil {
		return nil, ineligible(err.Error()), nil
	}
	denied, err := d.st.IsDenied(ctx, requester)
	if err != nil {
		return nil, nil, fmt.Errorf("draft: deny lookup: %w", err)
	}
	if denied {
		return nil, refuse(CodeDenied, 403, false, "requester denied"), nil
	}

	// 2. Nonce + quotas, one serialized DB transaction.
	verdict, err := d.st.BeginRequest(ctx, req.Nonce, requester, req.Ts, store.Quotas{
		MaxOutstanding: d.cfg.MaxOutstanding, DailyPairs: d.cfg.DailyPairs, PairsPerMinute: d.cfg.PairsPerMinute,
	})
	switch {
	case err != nil:
		return nil, nil, fmt.Errorf("draft: begin request: %w", err)
	case verdict == store.VerdictNonceUsed:
		return nil, unauthorized("nonce already used"), nil
	case verdict == store.VerdictQuota:
		return nil, refuse(CodeQuota, 429, true, "quota exceeded"), nil
	case verdict == store.VerdictUnavailable:
		return nil, unavailable("rate limited"), nil
	case verdict != store.VerdictOK:
		return nil, nil, fmt.Errorf("draft: unexpected quota verdict %q", verdict)
	}

	// 3. Size.
	k, err := econ.SizeDraft(d.params, req.N, req.M)
	if errors.Is(err, econ.ErrTooLarge) {
		return nil, refuse(CodeTooLarge, 400, false, fmt.Sprintf("draft needs more than K_MAX=%d fuel pairs", d.cfg.KMax)), nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("draft: size: %w", err)
	}

	// 4–7. Candidates → claim → detach → verify.
	survivors, unresolved, err := d.reserve(ctx, req.Nonce, requester, req.AssetID, k)
	release := func() {
		if unresolved {
			d.log.Warn("fuel draft: rows left reserving for sweeper rule 0", "requestId", req.Nonce)
			return
		}
		d.releaseReserving(ctx, req.Nonce)
	}
	if err != nil {
		release()
		return nil, nil, err
	}
	if len(survivors) < k {
		release()
		return nil, unavailable("no proven fuel"), nil
	}

	// 8–9. Fee scripts, skeleton, signatures, self-check, BEEF.
	tx, prevs, commit, err := d.sign(ctx, req.AssetID, requesterPub, fee, survivors)
	if err != nil {
		release()
		return nil, nil, err
	}
	var bad []string
	for i := range survivors {
		if verr := verifyFuelInput(tx, i, prevs[i]); verr != nil {
			d.log.Error("fuel draft: signed fuel input does not verify; dropping the row", "outpoint", survivors[i].Outpoint, "requestId", req.Nonce, "err", verr)
			bad = append(bad, survivors[i].Outpoint)
		}
	}
	if len(bad) > 0 {
		for _, op := range bad {
			d.drop(ctx, op, req.Nonce)
		}
		release()
		return nil, nil, fmt.Errorf("draft: %d signed fuel input(s) failed self-verification", len(bad))
	}
	fuelBeef, err := mergeBeef(survivors)
	if err != nil {
		release()
		return nil, nil, err
	}

	// 10. Commit. The response's expiresAt is taken before the store stamps
	// its own, so the row never expires before the time the client was told.
	expiresAt := d.now().Unix() + d.cfg.TTLSeconds
	if _, err := d.st.Commit(ctx, req.Nonce, commit, d.cfg.TTLSeconds); err != nil {
		release()
		return nil, nil, fmt.Errorf("draft: commit: %w", err)
	}

	identity := d.src.IdentityKeyHex()
	feeAmount := strconv.FormatInt(fee, 10)
	pairs := make([]Pair, len(survivors))
	for i, c := range survivors {
		pairs[i] = Pair{Vin: i, Vout: i, FuelOutpoint: c.Outpoint, FuelSatoshis: c.Satoshis, KeyID: commit[i].KeyID,
			Counterparty: identity, FeeScript: commit[i].FeeScript, FeeAmount: feeAmount}
	}
	return &Response{
		RequestID: req.Nonce, AssetID: req.AssetID, K: k, FeePerPair: feeAmount, ExpiresAt: expiresAt,
		DraftTx: tx.Hex(), FuelBeef: fuelBeef, Pairs: pairs,
	}, nil, nil
}

// reserve picks, claims, detaches and verifies up to k fuel outputs (§4.3
// steps 4–7): released rows with needs_recheck=0 first (oldest first), then
// the pool basket's proven rows (high-id end). It stops at k survivors or
// after K_MAX·2 claims. unresolved reports that some claimed row is neither a
// survivor nor dropped (its state could not be observed) and so must be left
// to sweeper rule 0; with unresolved=false every reserving row of the
// request is a survivor.
func (d *Drafter) reserve(ctx context.Context, requestID, requester, assetID string, k int) (survivors []store.Candidate, unresolved bool, err error) {
	tried := map[string]bool{}
	claims, budget := 0, d.cfg.KMax*2
	done := func() bool { return len(survivors) >= k || claims >= budget }

	// take runs one candidate through claim → check → detach → verify. A
	// returned error aborts the reservation.
	take := func(c store.Candidate, fromStore bool) error {
		if tried[c.Outpoint] {
			return nil
		}
		tried[c.Outpoint] = true
		if err := ctx.Err(); err != nil {
			return err
		}
		checkErr := d.checkCandidate(c)
		if checkErr != nil && !fromStore {
			// Unusable basket row: leave it in the basket (the toolbox may
			// still spend it as change) and never mark it in our table.
			d.log.Warn("fuel draft: skipping unusable basket row", "outpoint", c.Outpoint, "reason", checkErr)
			return nil
		}
		ok, err := d.st.Claim(ctx, c, requestID, requester, assetID, len(survivors), d.cfg.ReservingTTLSeconds)
		if err != nil {
			unresolved = true // the claim may have committed
			return fmt.Errorf("draft: claim %s: %w", c.Outpoint, err)
		}
		if !ok {
			return nil // another holder has it
		}
		claims++
		if checkErr != nil {
			// A stored row with unusable data: drop it so it stops heading
			// every released-candidates listing. It is already detached.
			return d.dropClaimed(ctx, c.Outpoint, requestID, checkErr, &unresolved)
		}
		if err := d.src.Detach(ctx, c.Outpoint); err != nil {
			unresolved = true
			if ctx.Err() != nil {
				return ctx.Err()
			}
			d.log.Warn("fuel draft: detach failed; row left reserving for sweeper rule 0", "outpoint", c.Outpoint, "requestId", requestID, "err", err)
			return nil
		}
		spendable, err := d.src.StillSpendable(ctx, c.Outpoint)
		if err != nil {
			unresolved = true
			if ctx.Err() != nil {
				return ctx.Err()
			}
			d.log.Warn("fuel draft: verify failed; row left reserving for sweeper rule 0", "outpoint", c.Outpoint, "requestId", requestID, "err", err)
			return nil
		}
		if !spendable {
			return d.dropClaimed(ctx, c.Outpoint, requestID, errors.New("no longer spendable (allocated by the storage funder)"), &unresolved)
		}
		survivors = append(survivors, c)
		return nil
	}

	released, err := d.st.ReleasedCandidates(ctx, k*2)
	if err != nil {
		return survivors, unresolved, fmt.Errorf("draft: released candidates: %w", err)
	}
	for _, c := range released {
		if done() {
			return survivors, unresolved, nil
		}
		if err := take(c, true); err != nil {
			return survivors, unresolved, err
		}
	}
	if done() {
		return survivors, unresolved, nil
	}
	want := k * 4
	rows, err := d.src.ListProven(ctx, d.cfg.PoolBasket, want)
	if err != nil {
		return survivors, unresolved, fmt.Errorf("draft: list fuel: %w", err)
	}
	if len(rows) < want {
		// The source silently skips basket rows without proof, so a short
		// listing is the only signal of an unproven or draining pool.
		d.log.Info("fuel draft: pool listing shorter than requested", "basket", d.cfg.PoolBasket,
			"requested", want, "returned", len(rows), "stillNeeded", k-len(survivors))
	}
	for _, r := range rows {
		if done() {
			break
		}
		c := store.Candidate{Outpoint: r.Outpoint, Satoshis: r.Satoshis, FuelScript: hex.EncodeToString(r.LockingScript),
			FuelBeef: hex.EncodeToString(r.Beef), DerivationPrefix: r.DerivationPrefix, DerivationSuffix: r.DerivationSuffix}
		if err := take(c, false); err != nil {
			return survivors, unresolved, err
		}
	}
	return survivors, unresolved, nil
}

// dropClaimed moves a row this request holds to dropped (terminal). If the
// write fails the row stays reserving, so the request becomes unresolved.
func (d *Drafter) dropClaimed(ctx context.Context, outpoint, requestID string, reason error, unresolved *bool) error {
	d.log.Warn("fuel draft: dropping candidate", "outpoint", outpoint, "requestId", requestID, "reason", reason)
	if err := d.st.Drop(ctx, outpoint, requestID); err != nil {
		*unresolved = true
		return fmt.Errorf("draft: drop %s: %w", outpoint, err)
	}
	return nil
}

// checkCandidate validates a candidate's own data before it is used: a
// canonical outpoint, at least D satoshis (§1.3 sizes every pair on D), a
// derivation, and a BEEF that carries the proven source transaction whose
// output matches the stored script and amount (the payer's inputBEEF needs
// exactly that, §4.3 step 4).
func (d *Drafter) checkCandidate(c store.Candidate) error {
	op, err := transaction.OutpointFromString(c.Outpoint)
	if err != nil || op.String() != c.Outpoint {
		return fmt.Errorf("outpoint %q is not canonical <txid>.<vout>", c.Outpoint)
	}
	if c.Satoshis < d.cfg.Denomination {
		return fmt.Errorf("%d sats is below the denomination %d", c.Satoshis, d.cfg.Denomination)
	}
	if c.DerivationPrefix == "" || c.DerivationSuffix == "" {
		return errors.New("missing derivation prefix or suffix")
	}
	lock, err := hex.DecodeString(c.FuelScript)
	if err != nil || len(lock) == 0 {
		return errors.New("fuel script is empty or not hex")
	}
	raw, err := hex.DecodeString(c.FuelBeef)
	if err != nil || len(raw) == 0 {
		return errors.New("fuel BEEF is empty or not hex")
	}
	beef, err := transaction.NewBeefFromBytes(raw)
	if err != nil {
		return fmt.Errorf("fuel BEEF: %w", err)
	}
	srcTx := beef.FindTransactionByHash(&op.Txid)
	if srcTx == nil {
		return errors.New("fuel BEEF lacks the source transaction")
	}
	if beef.FindBumpByHash(&op.Txid) == nil {
		return errors.New("fuel BEEF has no merkle proof for the source transaction")
	}
	if int(op.Index) >= len(srcTx.Outputs) {
		return errors.New("fuel BEEF source transaction has no such output")
	}
	out := srcTx.Outputs[op.Index]
	if out.Satoshis != c.Satoshis || out.LockingScript == nil || !bytes.Equal(*out.LockingScript, lock) {
		return errors.New("fuel BEEF output does not match the stored script and amount")
	}
	return nil
}

// sign builds the §1.1 skeleton and signs every fuel input. It returns the
// signed tx, each input's previous output, and the commit rows in pair order.
func (d *Drafter) sign(ctx context.Context, assetID string, requester *ec.PublicKey, fee int64, survivors []store.Candidate) (*transaction.Transaction, []*transaction.TransactionOutput, []store.CommitPair, error) {
	tx := transaction.NewTransaction() // version 1, lockTime 0
	prevs := make([]*transaction.TransactionOutput, len(survivors))
	commit := make([]store.CommitPair, len(survivors))
	feeAmount := strconv.FormatInt(fee, 10)
	for i, c := range survivors {
		op, err := transaction.OutpointFromString(c.Outpoint)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("draft: outpoint %s: %w", c.Outpoint, err)
		}
		lock, err := hex.DecodeString(c.FuelScript)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("draft: fuel script %s: %w", c.Outpoint, err)
		}
		prevs[i] = &transaction.TransactionOutput{Satoshis: c.Satoshis, LockingScript: script.NewFromBytes(lock)}
		in := &transaction.TransactionInput{SourceTXID: &op.Txid, SourceTxOutIndex: op.Index, SequenceNumber: fuelSequence}
		in.SetSourceTxOutput(prevs[i])
		tx.AddInput(in)

		keyID := "fee-" + c.Outpoint
		pkh, err := d.src.FeePubKeyHash(ctx, keyID, requester)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("draft: fee key %s: %w", c.Outpoint, err)
		}
		feeScript, err := token.LockToken(assetID, fee, pkh)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("draft: fee script %s: %w", c.Outpoint, err)
		}
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: feeScript})
		commit[i] = store.CommitPair{Outpoint: c.Outpoint, FeeScript: hex.EncodeToString(*feeScript), KeyID: keyID, FeeAmount: feeAmount}
	}
	// Sign once every input and output exists.
	for i, c := range survivors {
		tpl, err := d.src.Unlocker(c.DerivationPrefix, c.DerivationSuffix)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("draft: unlocker %s: %w", c.Outpoint, err)
		}
		us, err := tpl.Sign(tx, uint32(i))
		if err != nil {
			return nil, nil, nil, fmt.Errorf("draft: sign %s: %w", c.Outpoint, err)
		}
		tx.Inputs[i].UnlockingScript = us
	}
	return tx, prevs, commit, nil
}

// verifyFuelInput runs the script engine on fuel input i and checks it is
// signed with the fuel sighash (0xC3): a signature over any other flag would
// verify here but break as soon as the payer extends the skeleton.
func verifyFuelInput(tx *transaction.Transaction, i int, prev *transaction.TransactionOutput) error {
	us := tx.Inputs[i].UnlockingScript
	if us == nil {
		return errors.New("unsigned")
	}
	chunks, err := us.Chunks()
	if err != nil || len(chunks) != 2 || len(chunks[0].Data) == 0 {
		return errors.New("unlocking script is not <sig> <pubkey>")
	}
	if sig := chunks[0].Data; sig[len(sig)-1] != byte(fuel.FuelSigHash) {
		return fmt.Errorf("signed with sighash 0x%02x, want 0x%02x", sig[len(sig)-1], byte(fuel.FuelSigHash))
	}
	return interpreter.NewEngine().Execute(interpreter.WithTx(tx, i, prev), interpreter.WithForkID(), interpreter.WithAfterGenesis())
}

// mergeBeef returns hex BEEF holding every survivor's proven source tx.
func mergeBeef(survivors []store.Candidate) (string, error) {
	b := transaction.NewBeef()
	for _, c := range survivors {
		raw, err := hex.DecodeString(c.FuelBeef)
		if err != nil {
			return "", fmt.Errorf("draft: fuel BEEF %s: %w", c.Outpoint, err)
		}
		if err := b.MergeBeefBytes(raw); err != nil {
			return "", fmt.Errorf("draft: merge fuel BEEF %s: %w", c.Outpoint, err)
		}
	}
	out, err := b.Bytes()
	if err != nil {
		return "", fmt.Errorf("draft: serialize fuel BEEF: %w", err)
	}
	return hex.EncodeToString(out), nil
}

// cleanupCtx outlives a cancelled request so a best-effort write still lands.
func cleanupCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
}

// releaseReserving is the best-effort §4.3 release: this request's reserving
// rows → released, needs_recheck=1. On failure the rows stay reserving and
// sweeper rule 0 resolves them.
func (d *Drafter) releaseReserving(ctx context.Context, requestID string) {
	cctx, cancel := cleanupCtx(ctx)
	defer cancel()
	if _, err := d.st.ReleaseReserving(cctx, requestID, true); err != nil {
		d.log.Warn("fuel draft: release failed; sweeper rule 0 will resolve the rows", "requestId", requestID, "err", err)
	}
}

// drop is the best-effort reserving → dropped for a row found unusable after
// reservation.
func (d *Drafter) drop(ctx context.Context, outpoint, requestID string) {
	cctx, cancel := cleanupCtx(ctx)
	defer cancel()
	if err := d.st.Drop(cctx, outpoint, requestID); err != nil {
		d.log.Warn("fuel draft: drop failed", "outpoint", outpoint, "requestId", requestID, "err", err)
	}
}

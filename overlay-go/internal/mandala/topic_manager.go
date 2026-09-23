package mandala

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

// StateStore is the tm_mandala view of the mandala state store: per-asset
// admin state plus token-row lookup. Satisfied by *Store.
type StateStore interface {
	GetAssetState(ctx context.Context, assetID string) (AssetAdminState, error)
	GetTokenRow(ctx context.Context, txid string, vout uint32) (*TokenRow, error)
	// IsAdminOutpoint reports whether this topic previously admitted the given
	// outpoint as an admin-auth output of assetID. It is what anchors the admin
	// chain: authority comes from spending the recorded prior, not from
	// re-deriving a key an attacker can also derive.
	IsAdminOutpoint(ctx context.Context, assetID, txid string, vout uint32) (bool, error)
}

// ScreeningProvider answers sanctions checks against identity keys.
type ScreeningProvider interface {
	IsSanctioned(ctx context.Context, identityKey string) (bool, error)
}

// NoSanctions is the always-clear ScreeningProvider.
type NoSanctions struct{}

// IsSanctioned always reports false.
func (NoSanctions) IsSanctioned(context.Context, string) (bool, error) { return false, nil }

// TopicManager is the tm_mandala consensus core: it classifies outputs,
// verifies FT outputs by BRC-72 key linkage, enforces per-asset conservation,
// screens sanctions, and applies the per-asset control gates (Appendix A §3).
// RegistryReader is the issuer-level identity database (cache of the
// registration chain). Optional: when unset or inactive, membership is open.
type RegistryReader interface {
	IsAdmitted(ctx context.Context, identityKey string) (bool, error)
	RegistryActive(ctx context.Context) (bool, error)
}

type TopicManager struct {
	verifier *Verifier
	admin    *AdminWallet
	screen   ScreeningProvider
	state    StateStore
	registry RegistryReader
	// spend is the optional FIX L conflicting-spend guard. See
	// WithSpendChecker; nil disables the gate.
	spend SpendChecker
	// exempt are identities never subject to the membership gate (the
	// overlay's own identity key). See WithMembershipExemptions.
	exempt map[string]bool
}

// IssuerLister is optionally satisfied by a StateStore (*Store does): every
// issuerIdentityKey it holds is exempt from the membership gate (A04), so
// both backends exempt the same set as the TS screening seam, which only
// ever sees identity keys and cannot scope issuers to the transaction.
type IssuerLister interface {
	IssuerIdentityKeys(ctx context.Context) ([]string, error)
}

// WithMembershipExemptions names identities the membership gate never
// refuses — the overlay's own identity key (TS parity: registryScreening's
// `identityKeys`).
func (m *TopicManager) WithMembershipExemptions(keys ...string) *TopicManager {
	if m.exempt == nil {
		m.exempt = map[string]bool{}
	}
	for _, k := range keys {
		if k != "" {
			m.exempt[k] = true
		}
	}
	return m
}

var _ engine.TopicManager = (*TopicManager)(nil)

// NewTopicManager wires the tm_mandala dependencies together.
func NewTopicManager(v *Verifier, aw *AdminWallet, sp ScreeningProvider, st StateStore) *TopicManager {
	return &TopicManager{verifier: v, admin: aw, screen: sp, state: st}
}

// WithRegistry attaches the issuer-level identity database. Peer transfers
// of a live registry must name only admitted identities.
func (m *TopicManager) WithRegistry(r RegistryReader) *TopicManager {
	m.registry = r
	return m
}

// ftOut is a classified MandalaToken output; identityKey is set on admission
// (from the verified output linkage's counterparty).
type ftOut struct {
	index       uint32
	assetID     string
	amount      int64
	pubKeyHash  [20]byte
	identityKey string
}

// IdentifyAdmissibleOutputs runs the full §3 admission pipeline. Rejections
// are errors (never silently-empty instructions): the engine treats a thrown
// topic as failed, which keeps rejected transfers off the network.
//
// The guards run in the CANONICAL ORDER of wire contract §9.6 — first refusal
// wins, identically on both engines:
//
//  1. unlinked-token reject   (FIX A)
//  2. conflicting spend       (FIX L)
//  3. admin-chain anchoring
//  4. the topic manager's own rules
//
// That is the same order the TS stack composes its wrappers in
// (overlay/src/index.ts: withUnlinkedTokenReject ∘ withSpentInputGuard ∘
// withAdminChainAnchor ∘ MandalaTopicManager), so the same transaction earns
// the same code on both stacks rather than whichever refusal the
// implementation happened to reach first.
func (m *TopicManager) IdentifyAdmissibleOutputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	var none overlay.AdmittanceInstructions
	if beef == nil || txid == nil {
		return none, m.reject(errors.New("tm_mandala: missing beef or txid"))
	}
	// §3.1 parse: the tx (with source transactions) from the beef, the
	// off-chain linkage payload from ctx (empty payload when absent).
	tx := beef.FindTransaction(txid.String())
	if tx == nil {
		return none, m.reject(fmt.Errorf("tm_mandala: transaction %s not found in beef", txid))
	}
	payload := PayloadFromContext(ctx)

	// Outpoints of inputs the engine previously admitted on this topic. The
	// admin chain is anchored to these: see priorAnchored.
	admittedInputs := make(map[string]bool, len(previousCoins))
	for _, ci := range previousCoins {
		if int(ci) < len(tx.Inputs) {
			admittedInputs[inputOutpointString(tx.Inputs[ci])] = true
		}
	}

	// ---- Guard 1 (§9.6): unlinked-token reject, §3.3 key linkage ----
	admitted, err := m.verifiedTokenOutputs(ctx, tx, payload)
	if err != nil {
		return none, m.reject(err)
	}

	// ---- Guard 2 (§9.6, FIX L): conflicting spend ----
	// Refuse a second spend of a coin this topic already marked spent for a
	// different, still-admitted transaction, rather than leaving the race to
	// the broadcaster.
	if err := m.noConflictingSpend(ctx, tx, txid, previousCoins); err != nil {
		return none, err
	}

	// ---- Guard 3 (§9.6): admin-chain anchoring ----
	if err := m.adminChainAnchored(ctx, payload, admittedInputs); err != nil {
		return none, m.reject(err)
	}

	// ---- Guard 4 (§9.6): the topic manager's own rules ----
	// §3.2 classify outputs: FT outputs were classified by guard 1; admin
	// outputs are verified here by pkh re-derivation (their anchoring is
	// already guaranteed by guard 3).
	adminByIndex := map[uint32]ActionDetails{}
	for _, a := range payload.Admin {
		adminByIndex[a.Index] = a.ActionDetails
	}
	tokenIndex := make(map[uint32]bool, len(admitted))
	for _, f := range admitted {
		tokenIndex[f.index] = true
		// Token value lives in the script payload, never in the output's
		// satoshis: every token output must carry exactly 1 satoshi, so
		// sats cannot be stranded inside token outputs (TS parity:
		// MandalaTopicManager.classifyOutputs throws, rejecting the tx).
		if tx.Outputs[f.index].Satoshis != 1 {
			return none, m.reject(fmt.Errorf("token output %d must carry exactly 1 satoshi", f.index))
		}
	}

	var adminIdx []uint32
	// assetId -> actionDetails, populated ONLY from verified admin outputs.
	// This — never the raw payload — is the source of the control-gate admin
	// exemption, so a forged admin entry cannot bypass the pause/access gates.
	verifiedAdminByAsset := map[string]ActionDetails{}
	authorizedIssuance := map[string]int64{}
	for i, out := range tx.Outputs {
		idx := uint32(i)
		if out.LockingScript == nil || tokenIndex[idx] {
			continue
		}
		details, ok := adminByIndex[idx]
		if !ok || details == nil {
			continue
		}
		admin, err := m.verifyAdminOutput(idx, tx.Outputs[idx], details)
		if err != nil {
			return none, m.reject(err)
		}
		if !admin {
			continue
		}
		// Same 1-satoshi rule for admin-auth outputs — enforced only AFTER
		// verifyAdminOutput admits: an admin output is a bare P2PKH, so
		// checking earlier would reject ordinary wallet change.
		if out.Satoshis != 1 {
			return none, m.reject(fmt.Errorf("admin output %d must carry exactly 1 satoshi", idx))
		}
		// A16: a freeze whose target has no token row folds to {amount: 0,
		// owner: ""} and can never be reissued — refuse it here rather than
		// leave a silent dead end. Same string as overlay/src/adminChainGuard.ts.
		if details.Kind() == "freezeOutput" {
			if err := m.freezeTargetHasRow(ctx, details); err != nil {
				return none, m.reject(err)
			}
		}
		adminIdx = append(adminIdx, idx)
		if assetID, ok := details.Str("assetId"); ok {
			verifiedAdminByAsset[assetID] = details
			// §3.2f issuance credit: issue/reissue mint +amount; redeem
			// credits -amount so partial burns satisfy out == in + issued.
			amt, _ := details.Num("amount") // missing amount -> 0
			switch details.Kind() {
			case "issue", "reissue":
				authorizedIssuance[assetID] += amt
			case "redeem":
				authorizedIssuance[assetID] -= amt
			}
		}
	}

	// §3.4 conservation over previousCoins source outputs.
	if !m.conservationHolds(tx, previousCoins, admitted, authorizedIssuance) {
		return none, m.reject(errors.New("conservation violated: outputs exceed authorized inputs/issuance"))
	}

	// Name the party spending each token input from the owner bound when the
	// overlay admitted that coin. Input linkages, when present, are proofs
	// checked against the spent key — never the source of identity.
	spenders, err := m.resolveSpendIdentities(ctx, tx, previousCoins, payload)
	if err != nil {
		return none, m.reject(err)
	}

	// §3.5 sanctions screening — input linkage errors PROPAGATE here.
	if err := m.anySanctioned(ctx, spenders, admitted); err != nil {
		return none, m.reject(err)
	}

	// §3.6 control gates — input linkage errors are TOLERATED in sender
	// resolution (deliberate asymmetry with §3.5).
	pass, err := m.controlGatePasses(ctx, tx, payload, admitted, verifiedAdminByAsset)
	if err != nil {
		return none, m.reject(err)
	}
	if !pass {
		return none, m.reject(errors.New("control gate rejected the transaction (paused asset or access mode)"))
	}

	if err := m.membershipHolds(ctx, tx, spenders, admitted, verifiedAdminByAsset); err != nil {
		return none, m.reject(err)
	}

	// §3.7 result: admitted FT indices ∪ admitted admin indices, ascending.
	admit := make([]uint32, 0, len(admitted)+len(adminIdx))
	for _, f := range admitted {
		admit = append(admit, f.index)
	}
	admit = append(admit, adminIdx...)
	slices.Sort(admit)
	return overlay.AdmittanceInstructions{OutputsToAdmit: admit, CoinsToRetain: previousCoins}, nil
}

// verifiedTokenOutputs is guard 1 of the canonical order (wire contract §9.6
// and §6, FIX A): EVERY output that decodes as a MandalaToken must carry a
// linkage entry at its own index whose verified key hashes to the output's
// pubKeyHash. A missing entry and a clean pkh MISMATCH both REJECT the whole
// transaction — they used to be silent skips, which let a
// MandalaToken-decodable output of arbitrary size ride along inside a txid the
// overlay then signed (the phantom coin). A verification ERROR (tampered
// ciphertext, bad point, malformed linkage) propagates as before (§2.5
// "errors propagate as failure").
//
// The returned ftOut values already carry the recipient identity the verified
// linkage names, so nothing downstream re-verifies them.
func (m *TopicManager) verifiedTokenOutputs(ctx context.Context, tx *transaction.Transaction, payload *LinkagePayload) ([]ftOut, error) {
	outLinkByIndex := map[uint32]*SpecificLinkage{}
	for _, o := range payload.Outputs {
		outLinkByIndex[o.Index] = o.Linkage
	}
	var admitted []ftOut
	for i, out := range tx.Outputs {
		idx := uint32(i)
		if out.LockingScript == nil {
			continue
		}
		d, err := DecodeToken(out.LockingScript)
		if err != nil {
			continue // not a token output
		}
		l := outLinkByIndex[idx]
		if l == nil {
			return nil, unverifiedLinkageErr(idx)
		}
		identity, pkh, err := m.verifier.VerifyKeyLinkage(ctx, l)
		if err != nil {
			return nil, fmt.Errorf("output %d linkage verification: %w", idx, err)
		}
		if !bytes.Equal(pkh, d.PubKeyHash[:]) {
			return nil, unverifiedLinkageErr(idx)
		}
		admitted = append(admitted, ftOut{
			index: idx, assetID: d.AssetID, amount: d.Amount,
			pubKeyHash: d.PubKeyHash, identityKey: identity,
		})
	}
	return admitted, nil
}

// AdminNotAnchoredReason is the one reason string both engines emit when an
// admin action is not anchored to its asset's admin chain (wire contract §9.6;
// byte-identical to overlay/src/adminChainGuard.ts's throw). The HTTP layer's
// substring table maps it to ERR_SHAPE — and must keep pre-empting the generic
// "spent" row, since this sentence ends in "spent by this transaction". Do not
// reword without changing the contract and both tables.
const AdminNotAnchoredReason = "tm_mandala: admin action is not anchored to the asset admin chain " +
	"(priorOutpoint must be a previously admitted admin output of this asset, spent by this transaction)"

// adminChainAnchored is guard 3 of the canonical order (wire contract §9.6):
// EVERY admin entry in the off-chain payload must be anchored to its asset's
// admin chain, and an unanchored one REJECTS the whole submission rather than
// being skipped. Skipping was the hole: the submission still went through with
// the admin output silently dropped, so a caller could not tell an accepted
// admin action from an ignored one, and the same bytes admitted on one engine
// (TS rejects) and not the other.
//
// Like the TS wrapper this runs over the PAYLOAD's entries, before any output
// is classified: an entry that does not even name a real admin output is still
// an assertion of authority and is still refused.
func (m *TopicManager) adminChainAnchored(ctx context.Context, payload *LinkagePayload, admittedInputs map[string]bool) error {
	for _, a := range payload.Admin {
		if a.ActionDetails == nil {
			continue
		}
		anchored, err := m.priorAnchored(ctx, a.ActionDetails, admittedInputs)
		if err != nil {
			return err // infra: never a verdict (§9.5)
		}
		if !anchored {
			return errors.New(AdminNotAnchoredReason)
		}
	}
	return nil
}

// unverifiedLinkageErr is the one reason string both engines emit for FIX A
// (wire contract §6, verbatim — the HTTP layer maps it to ERR_LINKAGE and the
// wallet matches on it). Do not reword without changing the contract.
func unverifiedLinkageErr(idx uint32) error {
	return fmt.Errorf("output %d: MandalaToken-decodable output with no verified linkage", idx)
}

// RejectError marks an error as a topic manager's OWN deterministic verdict
// on the submitted transaction, as opposed to an infrastructure fault (SPV,
// storage, broadcast, screening provider) that merely surfaced through the
// same return value. FIX D's whole allowlist discipline rests on that
// distinction: only a *RejectError may be minted into one of the 400/409
// wire codes; everything else is ERR_UNAVAILABLE (503, retryable). The
// pinned go-overlay-services v1.3.2 engine returns a manager's error
// verbatim (identifyAdmissibleOutputsPerTopic's bare `return err`), so
// errors.As reaches this from httpapi without any string archaeology.
type RejectError struct {
	// Topic names the manager that refused (tm_mandala, tm_mandala_registry).
	Topic string
	// Err is the reason; its text is what the shared substring table in
	// httpapi/verdict.go matches on, and what the description carries.
	Err error
	// SpendTxid names the competing, still-admitted transaction for the FIX L
	// conflicting-spend refusal, and is empty for every other reason. It is
	// carried structurally rather than parsed back out of the reason text.
	SpendTxid string
}

func (e *RejectError) Error() string { return e.Err.Error() }
func (e *RejectError) Unwrap() error { return e.Err }

// infraError marks a DEPENDENCY fault — state store, screening provider,
// registry, engine store — that surfaced through the same return value as a
// verdict. FIX D's allowlist forbids minting a permanent 4xx from one of
// these: a Mongo blip must answer 503 ERR_UNAVAILABLE (retryable), never
// "this transaction is invalid forever". reject passes them through untyped
// so httpapi's classifier cannot mistake them for the manager's own opinion.
type infraError struct{ err error }

func (e *infraError) Error() string { return e.err.Error() }
func (e *infraError) Unwrap() error { return e.err }

// infra marks err as a dependency fault rather than a verdict.
func infra(err error) error { return &infraError{err: err} }

// reject logs a warning with the rejection reason and returns it as a typed
// verdict (TS parity: the TS manager console.warns and rethrows). Dependency
// faults (infra) and errors already typed are returned unchanged.
func (m *TopicManager) reject(err error) error {
	var fault *infraError
	if errors.As(err, &fault) {
		log.Printf("[tm_mandala] identifyAdmissibleOutputs failed (dependency fault, not a verdict): %v", err)
		return err
	}
	log.Printf("[tm_mandala] identifyAdmissibleOutputs rejected: %v", err)
	var already *RejectError
	if errors.As(err, &already) {
		return err
	}
	return &RejectError{Topic: "tm_mandala", Err: err}
}

// SpendChecker answers FIX L: which transaction, if any, has already spent a
// coin this topic admitted. An empty spendTxid means the coin is live —
// including the case the wire contract §7 calls out, where the spending
// transaction's admission record carries evictedAt (its spend was undone, so
// the coin is spendable again). wiring backs this with the engine store's
// spent/spendTxid flags plus the mandalaAdmissions record; it is optional, and
// an unset checker disables the gate entirely.
type SpendChecker interface {
	SpentBy(ctx context.Context, txid string, vout uint32) (spendTxid string, err error)
}

// WithSpendChecker attaches the FIX L conflicting-spend guard.
func (m *TopicManager) WithSpendChecker(c SpendChecker) *TopicManager {
	m.spend = c
	return m
}

// noConflictingSpend refuses the transaction when any coin the engine listed
// in previousCoins is already marked spent by a DIFFERENT, still-admitted
// transaction. A resubmit of the very transaction that marked the coin is not
// a conflict (that is the idempotent dupe path, not a double spend). A store
// error is NOT a verdict: it propagates untyped so the HTTP layer classifies
// it as ERR_UNAVAILABLE rather than as a permanent refusal.
func (m *TopicManager) noConflictingSpend(ctx context.Context, tx *transaction.Transaction, txid *chainhash.Hash, previousCoins []uint32) error {
	if m.spend == nil {
		return nil
	}
	self := ""
	if txid != nil {
		self = txid.String()
	}
	for _, ci := range previousCoins {
		if int(ci) >= len(tx.Inputs) {
			continue
		}
		in := tx.Inputs[ci]
		srcTxid := inputSourceTxid(in)
		if srcTxid == "" {
			continue
		}
		spendTxid, err := m.spend.SpentBy(ctx, srcTxid, in.SourceTxOutIndex)
		if err != nil {
			return infra(fmt.Errorf("tm_mandala: spend state for %s: %w", fmtOutpoint(srcTxid, in.SourceTxOutIndex), err))
		}
		if spendTxid == "" || strings.EqualFold(spendTxid, self) {
			continue
		}
		reason := fmt.Errorf("input %s already spent by %s", fmtOutpoint(srcTxid, in.SourceTxOutIndex), spendTxid)
		log.Printf("[tm_mandala] identifyAdmissibleOutputs rejected: %v", reason)
		return &RejectError{Topic: "tm_mandala", Err: reason, SpendTxid: spendTxid}
	}
	return nil
}

// verifyAdminOutput implements §3.2a-e: MandalaAdmin.decode plus pkh
// re-derivation via the admin wallet (Commitment(details) keyID). The
// priorOutpoint anchoring check is NOT here — it is guard 3
// (adminChainAnchored), which has already rejected every unanchored entry by
// the time this runs, so an output reaching this function is known to belong
// to an anchored action.
//
// A non-nil error means key DERIVATION failed (e.g. malformed
// details.counterparty hex) and must reject the whole tx (TS parity:
// adminWallet.getPublicKey is awaited uncaught in verifyAdminOutput). Script
// decode failure (not admin-shaped) is shape classification, not
// verification, and stays a silent (false, nil) skip — as does a clean pkh
// mismatch, which just means the output is somebody's ordinary P2PKH change.
func (m *TopicManager) verifyAdminOutput(idx uint32, out *transaction.TransactionOutput, details ActionDetails) (bool, error) {
	decoded, err := DecodeAdmin(out.LockingScript)
	if err != nil {
		return false, nil
	}
	expected, err := m.admin.ExpectedPKH(details)
	if err != nil {
		return false, fmt.Errorf("admin output %d key derivation: %w", idx, err)
	}
	return expected == decoded.PubKeyHash, nil
}

// registerIsGenesis is the P0 rule (token-fee design §2.1): a register is a
// genesis whose assetId IS its own outpoint, so it may carry no assetId at all
// (absent or ""). Anything else is an attempt to graft onto an existing
// asset's chain and is refused with the anchoring reason. Byte-identical
// rule in overlay/src/adminChainGuard.ts.
func registerIsGenesis(details ActionDetails) bool {
	v, present := details["assetId"]
	if !present {
		return true
	}
	s, ok := v.(string)
	return ok && s == ""
}

// priorAnchored enforces the chain of spends that IS the admin authority.
//
// Re-deriving the lock key cannot prove authorship: details.counterparty comes
// from the unauthenticated off-chain payload, and BRC-42 derivation against a
// counterparty yields a key that counterparty can also compute (and spend)
// from its own root key plus the overlay's PUBLIC identity key. Authority
// therefore rests entirely on the prior: an action is authorised only when it
// spends the admin output this topic already recorded for that asset. Whoever
// the new output is locked to holds authority next, so delegation works.
//
// "register" carries no prior: it is a genesis whose assetId is its own outpoint, so it must not name one (registerIsGenesis).
func (m *TopicManager) priorAnchored(ctx context.Context, details ActionDetails, admittedInputs map[string]bool) (bool, error) {
	if details.Kind() == "register" {
		return registerIsGenesis(details), nil
	}
	prior, ok := details.Str("priorOutpoint")
	if !ok || prior == "" {
		return false, nil
	}
	// The prior must be spent by this tx AND be an input the engine says this
	// topic previously admitted. previousCoins is engine-authoritative, so a
	// prior that was already spent cannot be replayed.
	if !admittedInputs[prior] {
		return false, nil
	}
	assetID, ok := details.Str("assetId")
	if !ok || assetID == "" {
		return false, nil
	}
	txid, vout, ok := splitOutpoint(prior)
	if !ok {
		return false, nil
	}
	recorded, err := m.state.IsAdminOutpoint(ctx, assetID, txid, vout)
	if err != nil {
		return false, infra(fmt.Errorf("admin prior lookup %s: %w", prior, err))
	}
	return recorded, nil
}

// freezeTargetHasRow refuses a freezeOutput whose target is not a live token
// row (A16). Fails closed on a malformed outpoint; a store error propagates.
func (m *TopicManager) freezeTargetHasRow(ctx context.Context, details ActionDetails) error {
	op, _ := details.Str("outpoint")
	if txid, vout, ok := splitOutpoint(op); ok {
		row, err := m.state.GetTokenRow(ctx, txid, vout)
		if err != nil {
			return infra(fmt.Errorf("tm_mandala: token row for %s: %w", op, err))
		}
		if row != nil {
			return nil
		}
	}
	return fmt.Errorf("tm_mandala: freezeOutput targets an outpoint with no token row: %s", op)
}

// inputOutpointString renders an input's outpoint as
// "<txid>.<sourceOutputIndex>" where txid is SourceTXID, else the source
// tx's computed id, else the empty string (TS parity — §0.2, §3.6).
func inputOutpointString(in *transaction.TransactionInput) string {
	txid := ""
	if in.SourceTXID != nil {
		txid = in.SourceTXID.String()
	} else if in.SourceTransaction != nil {
		txid = in.SourceTransaction.TxID().String()
	}
	return fmtOutpoint(txid, in.SourceTxOutIndex)
}

// inputSourceTxid is the txid half of an input's outpoint.
func inputSourceTxid(in *transaction.TransactionInput) string {
	if in.SourceTXID != nil {
		return in.SourceTXID.String()
	}
	if in.SourceTransaction != nil {
		return in.SourceTransaction.TxID().String()
	}
	return ""
}

// sourceOutput resolves an input's source output, or nil when the source
// transaction or output is absent (TS: input?.sourceTransaction?.outputs[i]).
func sourceOutput(in *transaction.TransactionInput) *transaction.TransactionOutput {
	if in == nil || in.SourceTransaction == nil {
		return nil
	}
	if int(in.SourceTxOutIndex) >= len(in.SourceTransaction.Outputs) {
		return nil
	}
	return in.SourceTransaction.Outputs[in.SourceTxOutIndex]
}

// ftInputAssetID decodes an input's source output as a MandalaToken,
// reporting its assetId, or ok=false for non-token/unresolvable inputs.
func ftInputAssetID(in *transaction.TransactionInput) (string, bool) {
	src := sourceOutput(in)
	if src == nil || src.LockingScript == nil {
		return "", false
	}
	d, err := DecodeToken(src.LockingScript)
	if err != nil {
		return "", false
	}
	return d.AssetID, true
}

// conservationHolds implements §3.4: inTotals only over previousCoins source
// outputs that decode as tokens; for every assetId present in outTotals
// require out == in + authorizedIssuance. Assets appearing only on the input
// side are unconstrained (consume-only, e.g. full redeem).
func (m *TopicManager) conservationHolds(tx *transaction.Transaction, previousCoins []uint32, admitted []ftOut, issued map[string]int64) bool {
	outTotals := map[string]int64{}
	for _, f := range admitted {
		outTotals[f.assetID] += f.amount
	}
	inTotals := map[string]int64{}
	for _, ci := range previousCoins {
		if int(ci) >= len(tx.Inputs) {
			continue
		}
		src := sourceOutput(tx.Inputs[ci])
		if src == nil || src.LockingScript == nil {
			continue
		}
		d, err := DecodeToken(src.LockingScript)
		if err != nil {
			continue // non-token previous coin
		}
		inTotals[d.AssetID] += d.Amount
	}
	for assetID, outAmt := range outTotals {
		if outAmt != inTotals[assetID]+issued[assetID] {
			return false
		}
	}
	return true
}

// anySanctioned implements §3.5: the identity set is all admitted-FT identity
// keys plus verifyKeyLinkage(inp.linkage).identityKey for EVERY payload.Inputs
// entry. A linkage verification error is NOT caught here — it propagates and
// rejects the whole tx (asymmetric with §3.6 sender resolution).
func (m *TopicManager) anySanctioned(ctx context.Context, spenders []string, admitted []ftOut) error {
	seen := map[string]bool{}
	keys := make([]string, 0, len(admitted)+len(spenders))
	add := func(k string) {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	for _, f := range admitted {
		add(f.identityKey)
	}
	for _, k := range spenders {
		add(k)
	}
	for _, k := range keys {
		hit, err := m.screen.IsSanctioned(ctx, k)
		if err != nil {
			return infra(fmt.Errorf("sanctions screening of %s: %w", k, err))
		}
		if hit {
			return errors.New("sanctioned party involved in transfer")
		}
	}
	return nil
}

// resolveSpendIdentities names the party spending each token input.
//
// The owner of an output is bound once, when the overlay admits it, from the
// recipient its output linkage declares (lookup_service stores it on the token
// row). A spend is therefore named from that stored owner. This is
// payload-independent, so it cannot be steered by a submitter, and it is
// unaffected by sender blinding: the blinded key that PAID the coin is never
// an identity and is never consulted.
//
// When the payload does carry an input linkage it is treated as a proof, not
// as the source of identity: it must reconstruct the very key that locks the
// coin being spent (prover + L·G), and must name the stored owner. A linkage
// that fails either check rejects the whole transaction.
func (m *TopicManager) resolveSpendIdentities(ctx context.Context, tx *transaction.Transaction, previousCoins []uint32, payload *LinkagePayload) ([]string, error) {
	linkByIndex := map[uint32]*SpecificLinkage{}
	if payload != nil {
		for _, in := range payload.Inputs {
			linkByIndex[in.Index] = in.Linkage
		}
	}
	seen := map[string]bool{}
	var out []string
	addIdentity := func(k string) {
		if k != "" && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	for _, ci := range previousCoins {
		if int(ci) >= len(tx.Inputs) {
			continue
		}
		in := tx.Inputs[ci]
		src := sourceOutput(in)
		if src == nil || src.LockingScript == nil {
			continue
		}
		decoded, err := DecodeToken(src.LockingScript)
		if err != nil {
			continue // not a token input; nothing to name
		}
		var stored string
		row, rowErr := m.state.GetTokenRow(ctx, inputSourceTxid(in), in.SourceTxOutIndex)
		if rowErr != nil {
			return nil, infra(fmt.Errorf("tm_mandala: token row for %s: %w", inputOutpointString(in), rowErr))
		}
		if row != nil {
			stored = row.IdentityKey
		}
		if l := linkByIndex[ci]; l != nil {
			prover, pkh, err := m.verifier.VerifyInputLinkage(ctx, l)
			if err != nil {
				return nil, fmt.Errorf("input %d linkage verification: %w", ci, err)
			}
			if !bytes.Equal(pkh, decoded.PubKeyHash[:]) {
				return nil, fmt.Errorf("input %d linkage does not control the coin being spent", ci)
			}
			if stored != "" && !strings.EqualFold(stored, prover) {
				return nil, fmt.Errorf("input %d linkage names %s but the coin is owned by %s", ci, prover, stored)
			}
			addIdentity(prover)
			continue
		}
		addIdentity(stored)
	}
	return out, nil
}

// controlGatePasses implements §3.6. The asset universe is the admitted-FT
// assetIds plus the assetId of EVERY tx input whose source output decodes as
// a MandalaToken (all inputs, not just previousCoins). Senders are resolved
// lazily, once, from payload.Inputs — errors skipped (unverifiable input
// linkage is simply not counted as a party). A StateStore error propagates.
func (m *TopicManager) controlGatePasses(ctx context.Context, tx *transaction.Transaction, payload *LinkagePayload, admitted []ftOut, verifiedAdminByAsset map[string]ActionDetails) (bool, error) {
	seen := map[string]bool{}
	var assets []string
	addAsset := func(id string) {
		if !seen[id] {
			seen[id] = true
			assets = append(assets, id)
		}
	}
	for _, f := range admitted {
		addAsset(f.assetID)
	}
	for _, in := range tx.Inputs {
		if id, ok := ftInputAssetID(in); ok {
			addAsset(id)
		}
	}

	inputOutpoints := make([]string, len(tx.Inputs))
	for i, in := range tx.Inputs {
		inputOutpoints[i] = inputOutpointString(in)
	}

	var senders []string
	sendersResolved := false
	resolveSenders := func() []string {
		if sendersResolved {
			return senders
		}
		sendersResolved = true
		for _, inp := range payload.Inputs {
			identity, _, err := m.verifier.VerifyKeyLinkage(ctx, inp.Linkage)
			if err != nil {
				continue // tolerated: unverifiable input ⇒ not counted as a party
			}
			senders = append(senders, identity)
		}
		return senders
	}

	for _, assetID := range assets {
		state, err := m.state.GetAssetState(ctx, assetID)
		if err != nil {
			return false, infra(fmt.Errorf("tm_mandala: asset state for %s: %w", assetID, err))
		}
		if !assetGatePasses(state, tx, assetID, admitted, verifiedAdminByAsset, inputOutpoints, resolveSenders) {
			return false, nil
		}
	}
	return true, nil
}

// assetGatePasses runs the per-asset gates. A tx is an "issuer admin action
// for X" iff it carries a VERIFIED admin output with actionDetails.assetId ==
// X; otherwise its movement of X is a peer transfer.
func assetGatePasses(state AssetAdminState, tx *transaction.Transaction, assetID string, admitted []ftOut, verifiedAdminByAsset map[string]ActionDetails, inputOutpoints []string, resolveSenders func() []string) bool {
	frozen := map[string]bool{}
	for _, f := range state.FrozenOutpoints {
		frozen[f.Outpoint] = true
	}
	for _, op := range state.EvictedOutpoints {
		frozen[op] = true
	}
	// Gate 1: frozen/evicted input spend — ALL txs, admin included (blocks
	// even redeems of frozen coins; only unfreeze or reissue resolves).
	for _, op := range inputOutpoints {
		if frozen[op] {
			return false
		}
	}

	adminAction, isAdmin := verifiedAdminByAsset[assetID]

	// Gate 2: pause — peer transfers only; verified admin actions on X exempt.
	if state.IsPaused && !isAdmin {
		return false
	}

	// Gate 3: access mode — peer transfers only. Parties are the admitted-FT
	// identity keys for X plus the lazily-resolved senders, minus the issuer.
	if !isAdmin {
		var parties []string
		for _, f := range admitted {
			if f.assetID == assetID {
				parties = append(parties, f.identityKey)
			}
		}
		for _, s := range resolveSenders() {
			parties = append(parties, s)
		}
		filtered := make([]string, 0, len(parties))
		for _, k := range parties {
			if k != state.IssuerIdentityKey {
				filtered = append(filtered, k)
			}
		}
		if accessModeRejects(state, filtered) {
			return false
		}
	}

	// Reissue guards (a/b/c).
	if isAdmin && adminAction.Kind() == "reissue" && reissueGuardFails(state, tx, assetID, adminAction) {
		return false
	}
	return true
}

// accessModeRejects: denylist rejects when any party is blocked; any other
// accessMode value is treated as allowlist, rejecting when any party is not
// explicitly allowed.
func accessModeRejects(state AssetAdminState, parties []string) bool {
	if state.AccessMode == "denylist" {
		for _, k := range parties {
			if slices.Contains(state.BlockedIdentities, k) {
				return true
			}
		}
		return false
	}
	for _, k := range parties {
		if !slices.Contains(state.AllowedIdentities, k) {
			return true
		}
	}
	return false
}

// reissueGuardFails: (a) the target outpoint must currently be frozen;
// (b) the minted amount must exactly match the frozen ref's amount;
// (c) the tx must carry ZERO FT inputs of the asset (the frozen coin is
// evicted, never spent).
func reissueGuardFails(state AssetAdminState, tx *transaction.Transaction, assetID string, adminAction ActionDetails) bool {
	op, _ := adminAction.Str("outpoint") // non-string -> "" (matches nothing)
	var ref *FrozenRef
	for i := range state.FrozenOutpoints {
		if state.FrozenOutpoints[i].Outpoint == op {
			ref = &state.FrozenOutpoints[i]
			break
		}
	}
	if ref == nil {
		return true // (a)
	}
	amt, ok := adminAction.Num("amount")
	if !ok || ref.Amount != amt {
		return true // (b)
	}
	for _, in := range tx.Inputs {
		if id, ok := ftInputAssetID(in); ok && id == assetID {
			return true // (c)
		}
	}
	return false
}

// IdentifyNeededInputs never requests extra inputs (TS parity: the TS manager
// does not implement identifyNeededInputs).
// membershipHolds enforces the issuer-level registration allow-list once
// that chain has any folded row (A04). Exempt, on both backends: every asset
// issuer the state store knows (IssuerLister), the issuers of the assets this
// transaction touches, and the overlay's own identity (WithMembershipExemptions).
func (m *TopicManager) membershipHolds(ctx context.Context, tx *transaction.Transaction, spenders []string, admitted []ftOut, verifiedAdminByAsset map[string]ActionDetails) error {
	if m.registry == nil {
		return nil
	}
	active, err := m.registry.RegistryActive(ctx)
	if err != nil {
		return infra(fmt.Errorf("registry: %w", err))
	}
	if !active {
		return nil
	}
	issuers := map[string]bool{}
	for k := range m.exempt {
		issuers[k] = true
	}
	if l, ok := m.state.(IssuerLister); ok {
		keys, err := l.IssuerIdentityKeys(ctx)
		if err != nil {
			return infra(fmt.Errorf("registry: issuer keys: %w", err))
		}
		for _, k := range keys {
			issuers[k] = true
		}
	}
	// The asset universe whose issuers are exempt: every asset with a verified
	// admin action, plus every asset moving in this tx. A store fault reading
	// any of them is an INFRA fault, never a verdict (§9.5) — dropping it
	// silently shrinks the exemption set, which turns a Mongo blip into a
	// permanent-looking "identity not admitted" refusal of a legitimate issuer.
	seen := map[string]bool{}
	for assetID := range verifiedAdminByAsset {
		seen[assetID] = true
	}
	for _, f := range admitted {
		seen[f.assetID] = true
	}
	for _, in := range tx.Inputs {
		if id, ok := ftInputAssetID(in); ok {
			seen[id] = true
		}
	}
	for assetID := range seen {
		st, err := m.state.GetAssetState(ctx, assetID)
		if err != nil {
			return infra(fmt.Errorf("registry: asset state for %s: %w", assetID, err))
		}
		if st.IssuerIdentityKey != "" {
			issuers[st.IssuerIdentityKey] = true
		}
	}
	check := func(key string) error {
		if key == "" || issuers[key] {
			return nil
		}
		ok, err := m.registry.IsAdmitted(ctx, key)
		if err != nil {
			return infra(fmt.Errorf("registry: membership of %s: %w", key, err))
		}
		if !ok {
			return fmt.Errorf("identity not admitted: %s", key)
		}
		return nil
	}
	for _, f := range admitted {
		if err := check(f.identityKey); err != nil {
			return err
		}
	}
	for _, k := range spenders {
		if err := check(k); err != nil {
			return err
		}
	}
	return nil
}

func (m *TopicManager) IdentifyNeededInputs(context.Context, *transaction.Beef, *chainhash.Hash) ([]*transaction.Outpoint, error) {
	return nil, nil
}

// GetDocumentation describes the topic's admission rules.
func (m *TopicManager) GetDocumentation() string {
	return "tm_mandala admits BRC-92 Mandala fungible-token outputs whose BRC-72 " +
		"specific key linkages verify against the on-chain pubKeyHashes, plus " +
		"admin-auth outputs whose action details re-derive the admin lock key and " +
		"chain to a spent prior authorization. Transfers must conserve per-asset " +
		"supply (out == in + authorized issuance), pass sanctions screening of " +
		"every involved identity, and clear the per-asset control gates: no " +
		"frozen/evicted inputs, no peer transfers while paused, and access-mode " +
		"(denylist/allowlist) party checks; reissues must target a frozen outpoint " +
		"with the exact frozen amount and carry no FT inputs of the asset."
}

// GetMetaData names the topic.
func (m *TopicManager) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{
		Name:        "tm_mandala",
		Description: "BRC-92 Mandala regulated fungible-token transfers with key-linkage verification and sanctions screening.",
	}
}

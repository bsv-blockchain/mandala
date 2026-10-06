package mandala

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// TokenTopicDeps is what a Mandala token topic (and the token registry's dry run) reads.
type TokenTopicDeps struct {
	Verifier         LinkageVerifier
	TrustedIssuers   []string
	MembershipExempt []string // the overlay identity key in production
	Store            StateStore
	Engine           EngineOutputReader
	Screening        ScreeningProvider
	Membership       MembershipProvider                   // nil = no membership gate
	Spends           SpendChecker                         // nil = no conflicting-spend guard
	OnOwnerRepair    func(outpoint string, inserted bool) // nil = LogOwnerRepair(<topic>)
}

// TokenTopicManager is tm_<deploy txid>: one Mandala token (Q2/mandala/MandalaTopicManager.ts).
type TokenTopicManager struct {
	tokenID string
	topic   string
	deps    TokenTopicDeps
	trusted map[string]bool
	exempt  map[string]bool
}

var _ engine.TopicManager = (*TokenTopicManager)(nil)

// NewTokenTopicManager fails on a non-canonical token id or a bad trusted/exempt list
// (configuration faults, never per-transaction refusals).
func NewTokenTopicManager(tokenID string, d TokenTopicDeps) (*TokenTopicManager, error) {
	topic, err := TokenTopic(tokenID)
	if err != nil {
		return nil, err
	}
	trusted, err := TrustedSet(d.TrustedIssuers, "TokenTopicManager")
	if err != nil {
		return nil, err
	}
	exempt, err := ExemptKeys(d.MembershipExempt, "TokenTopicManager")
	if err != nil {
		return nil, err
	}
	if d.Screening == nil {
		d.Screening = NoSanctions{}
	}
	if d.OnOwnerRepair == nil {
		d.OnOwnerRepair = LogOwnerRepair(topic)
	}
	return &TokenTopicManager{tokenID: tokenID, topic: topic, deps: d, trusted: trusted, exempt: managerExemptSet(trusted, exempt)}, nil
}

func (m *TokenTopicManager) Topic() string   { return m.topic }
func (m *TokenTopicManager) TokenID() string { return m.tokenID }

// IdentifyAdmissibleOutputs is the engine entry point: the full check, spend guard and journal on.
func (m *TokenTopicManager) IdentifyAdmissibleOutputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	return m.identify(ctx, beef, txid, previousCoins, true)
}

// identify runs the binding guard order; journal=false is the registry's dry run (no spend guard,
// no journal). Every error leaves through WithTopic(err, m.topic).
func (m *TokenTopicManager) identify(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32, journal bool) (overlay.AdmittanceInstructions, error) {
	fail := func(err error) (overlay.AdmittanceInstructions, error) {
		return overlay.AdmittanceInstructions{}, WithTopic(err, m.topic)
	}
	if beef == nil || txid == nil {
		return fail(fmt.Errorf("%s: missing beef or txid", m.topic))
	}
	tx := beef.FindTransactionForSigningByHash(txid)
	if tx == nil {
		return fail(fmt.Errorf("%s: transaction %s not found in beef", m.topic, txid))
	}
	txidHex := txid.String()
	if journal && m.deps.Spends != nil {
		if err := requireUnspent(ctx, m.deps.Spends, m.topic, tx, txidHex, previousCoins); err != nil {
			return fail(err)
		}
	}
	env, err := DecodeEnvelope(OffChainValuesFrom(ctx))
	if err != nil {
		return fail(err)
	}

	// layer A, narrowed to this token (Q2/mandala/MandalaTopicManager.ts:185-205)
	cls := brc162.ClassifyOutputs(tx)
	v := ScopeToToken(m.tokenID, TxView{Outputs: cls.Outputs, Invalid: cls.Invalid,
		Inputs: brc162.ClassifyAdmittedInputs(tx, previousCoins), Env: env})
	if len(v.Outputs) == 0 && len(v.Inputs) == 0 && len(v.Invalid) == 0 && len(v.Env.Admin) == 0 {
		return overlay.AdmittanceInstructions{OutputsToAdmit: []uint32{}, CoinsToRetain: []uint32{}}, nil
	}
	ledger := brc162.BuildLedger(txidHex, v.Outputs, v.Inputs)

	// layer B
	if err := RequireValidTokenOutputs(v.Invalid, v.Outputs); err != nil {
		return fail(err)
	}
	owners, err := VerifyOutputOwners(ctx, v.Outputs, v.Env, m.deps.Verifier)
	if err != nil {
		return fail(err)
	}
	inputOwners, err := ResolveInputOwners(ctx, v.Inputs, v.Env, InputOwnerDeps{
		Store: m.deps.Store, Engine: m.deps.Engine, Verifier: m.deps.Verifier, Topic: m.topic, Txid: txidHex, OnRepair: m.deps.OnOwnerRepair,
	})
	if err != nil {
		return fail(err)
	}

	// layers C and D
	auth, err := CheckAuthority(ctx, txidHex, ledger, v.Outputs, owners, inputOwners, v.Env,
		AuthorityDeps{Trusted: m.trusted, Store: m.deps.Store, Registry: false})
	if err != nil {
		return fail(err)
	}
	if err := CheckControls(ctx, ledger, v.Inputs, inputOwners, owners, auth, ControlDeps{
		Store: m.deps.Store, Screening: m.deps.Screening, Membership: m.deps.Membership, Exempt: m.exempt,
	}); err != nil {
		return fail(err)
	}

	// D §4.2a rule 1: the journal is the last write before admittance
	if journal && len(v.Outputs) > 0 {
		if err := JournalOwners(ctx, m.deps.Store, m.topic, txidHex, owners); err != nil {
			return fail(err)
		}
	}
	// previousCoins are this topic's coins; a coin not retained is deleted from the topic as stale
	return overlay.AdmittanceInstructions{
		OutputsToAdmit: admittedOutputIndices(v.Outputs),
		CoinsToRetain:  retainedInputIndices(v.Inputs),
	}, nil
}

// requireUnspent is the conflicting-spend guard (D-6), shared by every token topic and tm_mandala_kyc
// (V-17): a previous coin of topic already marked spent by another transaction refuses; the
// transaction's own mark (an idempotent resubmit) does not.
func requireUnspent(ctx context.Context, spends SpendChecker, topic string, tx *transaction.Transaction, self string, previousCoins []uint32) error {
	for _, vin := range previousCoins {
		if int(vin) >= len(tx.Inputs) {
			continue
		}
		in := tx.Inputs[vin]
		src := spendSourceTxid(in)
		if src == "" {
			continue
		}
		spender, err := spends.SpentBy(ctx, topic, src, in.SourceTxOutIndex)
		if err != nil {
			return rStoreUnavailable("the engine output store", err)
		}
		if spender == "" || strings.EqualFold(spender, self) {
			continue
		}
		return rInputSpent(fmt.Sprintf("%s.%d", src, in.SourceTxOutIndex), spender)
	}
	return nil
}

func spendSourceTxid(in *transaction.TransactionInput) string {
	if in.SourceTXID != nil {
		return in.SourceTXID.String()
	}
	if in.SourceTransaction != nil {
		return in.SourceTransaction.TxID().String()
	}
	return ""
}

func admittedOutputIndices(outputs []brc162.Output) []uint32 {
	out := make([]uint32, 0, len(outputs))
	for _, o := range outputs {
		out = append(out, o.Index)
	}
	slices.Sort(out)
	return out
}

func retainedInputIndices(inputs []brc162.Input) []uint32 {
	out := make([]uint32, 0, len(inputs))
	for _, in := range inputs {
		out = append(out, in.Index)
	}
	slices.Sort(out)
	return out
}

// IdentifyNeededInputs is GASP-only; GASP is off (A1.1).
func (m *TokenTopicManager) IdentifyNeededInputs(context.Context, *transaction.Beef, *chainhash.Hash) ([]*transaction.Outpoint, error) {
	return nil, nil
}

func (m *TokenTopicManager) GetDocumentation() string { return docTokenTopic }

func (m *TokenTopicManager) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{
		Name:        m.topic,
		Description: "Mandala BRC-162 token " + m.tokenID + ": authority and value outputs, identity linkage, issuer controls.",
	}
}

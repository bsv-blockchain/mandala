package mandala

import (
	"context"
	"fmt"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// KYCTopicDeps is what tm_mandala_kyc reads. Store is the shared state store (the same journal
// collections as the token topics); Claims names the claimed registry token.
type KYCTopicDeps struct {
	Verifier       LinkageVerifier
	TrustedIssuers []string
	Store          StateStore
	Engine         EngineOutputReader
	Claims         KYCClaims
	OnOwnerRepair  func(outpoint string, inserted bool) // nil = LogOwnerRepair(KYCTopic)
}

// KYCTopicManager is tm_mandala_kyc (Q2/mandala-registry/RegistryTopicManager.ts): the identity
// registry chain as its own authority deployment. Layers A-C (unscoped, registry kinds, no value
// outputs), the first trusted deploy wins, then the journal. No layer D, no spend guard.
type KYCTopicManager struct {
	deps    KYCTopicDeps
	trusted map[string]bool
}

var _ engine.TopicManager = (*KYCTopicManager)(nil)

func NewKYCTopicManager(d KYCTopicDeps) (*KYCTopicManager, error) {
	trusted, err := TrustedSet(d.TrustedIssuers, "KYCTopicManager")
	if err != nil {
		return nil, err
	}
	if d.OnOwnerRepair == nil {
		d.OnOwnerRepair = LogOwnerRepair(KYCTopic)
	}
	return &KYCTopicManager{deps: d, trusted: trusted}, nil
}

func (m *KYCTopicManager) IdentifyAdmissibleOutputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	ins, err := m.identify(ctx, beef, txid, previousCoins)
	if err != nil {
		return overlay.AdmittanceInstructions{}, WithTopic(err, KYCTopic)
	}
	return ins, nil
}

func (m *KYCTopicManager) identify(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	none := overlay.AdmittanceInstructions{}
	if beef == nil || txid == nil {
		return none, fmt.Errorf("%s: missing beef or txid", KYCTopic)
	}
	tx := beef.FindTransactionForSigningByHash(txid)
	if tx == nil {
		return none, fmt.Errorf("%s: transaction %s not found in beef", KYCTopic, txid)
	}
	txidHex := txid.String()
	env, err := DecodeEnvelope(OffChainValuesFrom(ctx))
	if err != nil {
		return none, err
	}

	// layer A (unscoped: the registry is one chain)
	cls := brc162.ClassifyOutputs(tx)
	inputs := brc162.ClassifyAdmittedInputs(tx, previousCoins)
	ledger := brc162.BuildLedger(txidHex, cls.Outputs, inputs)

	// layer B
	if err := RequireValidTokenOutputs(cls.Invalid, cls.Outputs); err != nil {
		return none, err
	}
	owners, err := VerifyOutputOwners(ctx, cls.Outputs, env, m.deps.Verifier)
	if err != nil {
		return none, err
	}
	inputOwners, err := ResolveInputOwners(ctx, inputs, env, InputOwnerDeps{
		Store: m.deps.Store, Engine: m.deps.Engine, Verifier: m.deps.Verifier, Topic: KYCTopic, OnRepair: m.deps.OnOwnerRepair,
	})
	if err != nil {
		return none, err
	}

	// layer C, then the registry's own rule: the first trusted deploy wins
	if _, err := CheckAuthority(ctx, txidHex, ledger, cls.Outputs, owners, inputOwners, env,
		AuthorityDeps{Trusted: m.trusted, Store: m.deps.Store, Registry: true}); err != nil {
		return none, err
	}
	if err := m.requireFirstRegistry(ctx, cls.Outputs); err != nil {
		return none, err
	}

	if len(cls.Outputs) > 0 {
		if err := JournalOwners(ctx, m.deps.Store, KYCTopic, txidHex, owners); err != nil {
			return none, err
		}
	}
	return overlay.AdmittanceInstructions{
		OutputsToAdmit: admittedOutputIndices(cls.Outputs),
		CoinsToRetain:  append([]uint32{}, previousCoins...),
	}, nil
}

// requireFirstRegistry: a deploy is refused once another token is the claimed registry; the
// claimed registry's own deploy (a replay) is not another token.
func (m *KYCTopicManager) requireFirstRegistry(ctx context.Context, outputs []brc162.Output) error {
	for _, o := range outputs {
		if o.Role != brc162.RoleDeploy {
			continue
		}
		claimed, ok, err := m.deps.Claims.KYCRegistryTokenID(ctx)
		if err != nil {
			return rStoreUnavailable("the registry", err)
		}
		if ok && claimed != o.TokenID {
			return rRegistryExists()
		}
		return nil
	}
	return nil
}

func (m *KYCTopicManager) IdentifyNeededInputs(context.Context, *transaction.Beef, *chainhash.Hash) ([]*transaction.Outpoint, error) {
	return nil, nil
}

func (m *KYCTopicManager) GetDocumentation() string { return docKYCTopic }

func (m *KYCTopicManager) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{Name: KYCTopic, Description: "Mandala identity registry on BRC-162: a single authority chain that admits and revokes identities. No value outputs."}
}

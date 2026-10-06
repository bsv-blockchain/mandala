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

// TokenRegistryTopicManager is tm_mandala, the token registry (Q2/mandala/MandalaRegistryTopicManager.ts):
// it admits output 0 of a deploy and nothing else, after running the deploy token's own check as a
// dry run, so it refuses whatever tm_<txid> refuses.
type TokenRegistryTopicManager struct {
	deps    TokenTopicDeps
	trusted map[string]bool
	exempt  map[string]bool
}

var _ engine.TopicManager = (*TokenRegistryTopicManager)(nil)

func NewTokenRegistryTopicManager(d TokenTopicDeps) (*TokenRegistryTopicManager, error) {
	trusted, err := TrustedSet(d.TrustedIssuers, "TokenRegistryTopicManager")
	if err != nil {
		return nil, err
	}
	exempt, err := ExemptKeys(d.MembershipExempt, "TokenRegistryTopicManager")
	if err != nil {
		return nil, err
	}
	d.Spends = nil // the dry run never runs the spend guard
	if d.Screening == nil {
		d.Screening = NoSanctions{}
	}
	if d.OnOwnerRepair == nil {
		d.OnOwnerRepair = LogOwnerRepair(MandalaTopic)
	}
	return &TokenRegistryTopicManager{deps: d, trusted: trusted, exempt: managerExemptSet(trusted, exempt)}, nil
}

func (m *TokenRegistryTopicManager) IdentifyAdmissibleOutputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	if beef == nil || txid == nil {
		return overlay.AdmittanceInstructions{}, WithTopic(fmt.Errorf("%s: missing beef or txid", MandalaTopic), MandalaTopic)
	}
	hexID := txid.String()
	// <txid>_0 is the token a deploy at vout 0 creates; without one, its topic sees only what
	// cannot be scoped to one token, refuses that as every token topic does, and admits nothing.
	inner := &TokenTopicManager{tokenID: hexID + "_0", topic: "tm_" + hexID, deps: m.deps, trusted: m.trusted, exempt: m.exempt}
	if _, err := inner.identify(ctx, beef, txid, previousCoins, false); err != nil {
		return overlay.AdmittanceInstructions{}, WithTopic(err, MandalaTopic)
	}
	admit := []uint32{}
	if tx := beef.FindTransactionForSigningByHash(txid); tx != nil {
		for _, o := range brc162.ClassifyOutputs(tx).Outputs {
			if o.Index == 0 && o.Role == brc162.RoleDeploy {
				admit = []uint32{0}
				break
			}
		}
	}
	return overlay.AdmittanceInstructions{OutputsToAdmit: admit, CoinsToRetain: []uint32{}}, nil
}

func (m *TokenRegistryTopicManager) IdentifyNeededInputs(context.Context, *transaction.Beef, *chainhash.Hash) ([]*transaction.Outpoint, error) {
	return nil, nil
}

func (m *TokenRegistryTopicManager) GetDocumentation() string { return docTokenRegistryTopic }

func (m *TokenRegistryTopicManager) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{Name: MandalaTopic, Description: "Mandala token registry: one permanent record per BRC-162 deploy."}
}

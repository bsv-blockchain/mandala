package mandala

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
)

const RegistryTopic = "tm_mandala_registry"

// RegistryChainStore reports whether the registration chain already exists.
// Only the genesis "register" needs it: every later action is anchored by
// spending the chain's live output instead.
type RegistryChainStore interface {
	RegistryActive(ctx context.Context) (bool, error)
}

// RegistryTopicManager admits issuer-level admit/revoke/register outputs
// on the registration chain. It does not handle FT outputs.
type RegistryTopicManager struct {
	wallet *RegistryWallet
	store  RegistryChainStore
}

var _ engine.TopicManager = (*RegistryTopicManager)(nil)

func NewRegistryTopicManager(w *RegistryWallet, store RegistryChainStore) *RegistryTopicManager {
	return &RegistryTopicManager{wallet: w, store: store}
}

func (m *RegistryTopicManager) IdentifyAdmissibleOutputs(ctx context.Context, beef *transaction.Beef, txid *chainhash.Hash, previousCoins []uint32) (overlay.AdmittanceInstructions, error) {
	var none overlay.AdmittanceInstructions
	if beef == nil || txid == nil {
		return none, registryReject(errors.New("tm_mandala_registry: missing beef or txid"))
	}
	tx := beef.FindTransaction(txid.String())
	if tx == nil {
		return none, registryReject(fmt.Errorf("tm_mandala_registry: transaction %s not found in beef", txid))
	}
	payload := PayloadFromContext(ctx)
	adminByIndex := map[uint32]ActionDetails{}
	for _, a := range payload.Admin {
		adminByIndex[a.Index] = a.ActionDetails
	}
	// Every output this topic admits is a registration-chain output, so an
	// input the engine lists in previousCoins IS the chain's prior link. That
	// is what authorises an admit/revoke: spending the live chain output.
	// Re-deriving the lock key proves nothing, because details.counterparty is
	// attacker-supplied and BRC-42 hands that counterparty a key it can spend.
	admittedInputs := make(map[string]bool, len(previousCoins))
	for _, ci := range previousCoins {
		if int(ci) < len(tx.Inputs) {
			admittedInputs[inputOutpointString(tx.Inputs[ci])] = true
		}
	}

	var admit []uint32
	for i, out := range tx.Outputs {
		idx := uint32(i)
		details, ok := adminByIndex[idx]
		if !ok || details == nil {
			continue
		}
		kind := details.Kind()
		if kind != "register" && kind != "admitIdentity" && kind != "revokeIdentity" {
			continue
		}
		decoded, err := DecodeAdmin(out.LockingScript)
		if err != nil {
			continue
		}
		expected, err := m.wallet.ExpectedPKH(details)
		if err != nil {
			return none, registryReject(fmt.Errorf("tm_mandala_registry: output %d key derivation: %w", idx, err))
		}
		if expected != decoded.PubKeyHash {
			continue
		}
		if kind == "register" {
			// Genesis only: a second register would fold another "admitted"
			// row into the same issuer-level collection, which is a KYC
			// bypass, not a new chain.
			active, err := m.registryActive(ctx)
			if err != nil {
				return none, fmt.Errorf("tm_mandala_registry: registry state: %w", err)
			}
			if active {
				return none, registryReject(errors.New("tm_mandala_registry: registration chain already exists; register is genesis-only"))
			}
		} else {
			prior, ok := details.Str("priorOutpoint")
			if !ok || prior == "" || !admittedInputs[prior] {
				continue
			}
		}
		if out.Satoshis != 1 {
			return none, registryReject(fmt.Errorf("tm_mandala_registry: output %d must carry exactly 1 satoshi", idx))
		}
		admit = append(admit, idx)
	}
	if len(admit) == 0 {
		return none, registryReject(errors.New("tm_mandala_registry: no admissible registry outputs"))
	}
	return overlay.AdmittanceInstructions{OutputsToAdmit: admit, CoinsToRetain: previousCoins}, nil
}

// registryReject types this manager's own deterministic refusals the same way
// TopicManager.reject does, so FIX D's allowlist (httpapi/verdict.go) can mint
// a final 400 for them instead of collapsing every registry refusal into a
// retryable 503. A registryActive STORE error is deliberately left untyped —
// it is an infrastructure fault, not a verdict.
func registryReject(err error) error {
	log.Printf("[tm_mandala_registry] identifyAdmissibleOutputs rejected: %v", err)
	return &RejectError{Topic: RegistryTopic, Err: err}
}

func (m *RegistryTopicManager) registryActive(ctx context.Context) (bool, error) {
	if m.store == nil {
		return false, nil
	}
	return m.store.RegistryActive(ctx)
}

func (m *RegistryTopicManager) IdentifyNeededInputs(context.Context, *transaction.Beef, *chainhash.Hash) ([]*transaction.Outpoint, error) {
	return nil, nil
}

func (m *RegistryTopicManager) GetDocumentation() string {
	return "tm_mandala_registry admits issuer-level identity admit/revoke spends on a hash-linked authorization chain. The database is a cache of that chain."
}

func (m *RegistryTopicManager) GetMetaData() *overlay.MetaData {
	return &overlay.MetaData{
		Name:        RegistryTopic,
		Description: "Issuer-level identity registration chain (admit / revoke).",
	}
}

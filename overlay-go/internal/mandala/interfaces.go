package mandala

import (
	"context"
	"math/big"

	"github.com/bsv-blockchain/go-sdk/transaction"
)

// StateStore is TS MandalaStateStore (F/ts-storage §3.1): what the token and KYC managers read and
// write. *Store implements it, and so does the in-memory memStore of fakes_test.go.
type StateStore interface {
	GetAssetState(ctx context.Context, tokenID string) (AssetAdminState, error)
	GetTokenRow(ctx context.Context, txid string, vout uint32) (*TokenRecord, error)
	GetAuthorityRow(ctx context.Context, txid string, vout uint32) (*AuthorityRecord, error)
	GetOwnerJournal(ctx context.Context, txid string, vout uint32, topic string) (*OwnerRecord, error)
	RecordOwners(ctx context.Context, rows []OwnerRecord) error
	RepairOwnerRow(ctx context.Context, journal OwnerRecord) (inserted bool, err error)
	TakeToken(ctx context.Context, txid string, vout uint32) (*TokenRecord, error)
	TakeAuthority(ctx context.Context, txid string, vout uint32) (*AuthorityRecord, error)
	AdjustBalance(ctx context.Context, identityKey string, delta int64) error
	CirculatingSupply(ctx context.Context, tokenID string) (*big.Int, error)
}

// RepairUndoStore is what takes back a repaired row (TS ownership.ts RepairUndoStore).
type RepairUndoStore interface {
	TakeToken(ctx context.Context, txid string, vout uint32) (*TokenRecord, error)
	TakeAuthority(ctx context.Context, txid string, vout uint32) (*AuthorityRecord, error)
	AdjustBalance(ctx context.Context, identityKey string, delta int64) error
}

// EngineOutputReader is the engine's admitted-output view (TS types.ts EngineOutputReader). It
// uses only builtin and go-sdk types, so *enginestore.Store implements it directly (plan D-2).
type EngineOutputReader interface {
	// FindAdmittedOutput: a spent or absent output reads found=false; a BEEF decode fault is an
	// error (fail closed).
	FindAdmittedOutput(ctx context.Context, txid string, vout uint32, topic string) (lockingScript []byte, satoshis uint64, found bool, err error)
	// ListUnspentAdmittedOutputs pages {topic, spent:false} by the keyset (txid, outputIndex)
	// ascending, strictly after `after` (nil = from the start).
	ListUnspentAdmittedOutputs(ctx context.Context, topic string, after *transaction.Outpoint, limit int) ([]transaction.Outpoint, error)
}

// ScreeningProvider answers the sanctions screen (layer D).
type ScreeningProvider interface {
	IsSanctioned(ctx context.Context, identityKey string) (bool, error)
}

// NoSanctions screens nobody.
type NoSanctions struct{}

// IsSanctioned always answers false.
func (NoSanctions) IsSanctioned(context.Context, string) (bool, error) { return false, nil }

// MembershipProvider is the KYC membership gate (layer D).
type MembershipProvider interface {
	IsActive(ctx context.Context) (bool, error)
	IsAdmitted(ctx context.Context, identityKey string) (bool, error)
}

// KYCClaims reads the claimed KYC registry chain (requireFirstRegistry).
type KYCClaims interface {
	KYCRegistryTokenID(ctx context.Context) (tokenID string, claimed bool, err error)
}

// SpendChecker is the conflicting-spend guard's view (plan D-6): "" = the coin is live on topic or
// absent; a spender whose admission record is evicted reads live.
type SpendChecker interface {
	SpentBy(ctx context.Context, topic, txid string, vout uint32) (spendTxid string, err error)
}

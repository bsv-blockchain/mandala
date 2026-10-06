package mandala

import (
	"time"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// The §6.6 records (D §6.6, F/ts-storage §1.2). On every record the bson tag, the json tag and the
// TS field name are the same string, so a document the TS P2 overlay wrote decodes here and the
// reverse.

// Outpoint is the {txid, outputIndex} projection shape.
type Outpoint struct {
	Txid        string `bson:"txid" json:"txid"`
	OutputIndex uint32 `bson:"outputIndex" json:"outputIndex"`
}

// OwnerRecord is one mandalaOwners journal row (append-only, never deleted; D §4.2a rule 1).
type OwnerRecord struct {
	Txid        string      `bson:"txid" json:"txid"`
	OutputIndex uint32      `bson:"outputIndex" json:"outputIndex"`
	Topic       string      `bson:"topic" json:"topic"`
	TokenID     string      `bson:"tokenId" json:"tokenId"`
	Role        brc162.Role `bson:"role" json:"role"`
	Amount      Amount      `bson:"amount" json:"amount"`
	IdentityKey string      `bson:"identityKey" json:"identityKey"`
	CreatedAt   time.Time   `bson:"createdAt" json:"createdAt"`
}

// TokenRecord is one mandalaTokens row: an unspent value output and its owner.
type TokenRecord struct {
	Txid        string    `bson:"txid" json:"txid"`
	OutputIndex uint32    `bson:"outputIndex" json:"outputIndex"`
	TokenID     string    `bson:"tokenId" json:"tokenId"`
	Amount      Amount    `bson:"amount" json:"amount"`
	IdentityKey string    `bson:"identityKey" json:"identityKey"`
	CreatedAt   time.Time `bson:"createdAt" json:"createdAt"`
}

// AuthorityRecord is one mandalaAuthorities row: an unspent deploy or authority output.
type AuthorityRecord struct {
	Txid        string    `bson:"txid" json:"txid"`
	OutputIndex uint32    `bson:"outputIndex" json:"outputIndex"`
	Topic       string    `bson:"topic" json:"topic"`
	TokenID     string    `bson:"tokenId" json:"tokenId"`
	IdentityKey string    `bson:"identityKey" json:"identityKey"`
	CreatedAt   time.Time `bson:"createdAt" json:"createdAt"`
}

// LinkageRecord is one mandalaLinkageRecords row (last write wins per outpoint).
type LinkageRecord struct {
	Txid        string          `bson:"txid" json:"txid"`
	OutputIndex uint32          `bson:"outputIndex" json:"outputIndex"`
	IdentityKey string          `bson:"identityKey" json:"identityKey"`
	Linkage     SpecificLinkage `bson:"linkage" json:"linkage"`
	CreatedAt   time.Time       `bson:"createdAt" json:"createdAt"`
}

// MetadataRecord is one mandalaMetadata row: the decoded deploy payload of a token.
type MetadataRecord struct {
	TokenID      string `bson:"tokenId" json:"tokenId"`
	Txid         string `bson:"txid" json:"txid"`
	OutputIndex  uint32 `bson:"outputIndex" json:"outputIndex"`
	Sym          string `bson:"sym" json:"sym"`
	Dec          int64  `bson:"dec" json:"dec"`
	Label        string `bson:"label" json:"label"`
	FeeRatePerKb *int64 `bson:"feeRatePerKb" json:"feeRatePerKb"` // no omitempty: null round-trips
}

// FrozenRef is one frozen outpoint of an asset state.
type FrozenRef struct {
	Outpoint string `bson:"outpoint" json:"outpoint"`
	Amount   Amount `bson:"amount" json:"amount"`
	Owner    string `bson:"owner" json:"owner"`
}

// AssetAdminState is one mandalaAssetStates row (TS AssetStateReducer.ts:12-26).
type AssetAdminState struct {
	TokenID             string      `bson:"tokenId" json:"tokenId"`
	IsPaused            bool        `bson:"isPaused" json:"isPaused"`
	AccessMode          string      `bson:"accessMode" json:"accessMode"`
	BlockedIdentities   []string    `bson:"blockedIdentities" json:"blockedIdentities"`
	AllowedIdentities   []string    `bson:"allowedIdentities" json:"allowedIdentities"`
	FrozenOutpoints     []FrozenRef `bson:"frozenOutpoints" json:"frozenOutpoints"`
	EvictedOutpoints    []string    `bson:"evictedOutpoints" json:"evictedOutpoints"`
	FeeRatePerKb        *int64      `bson:"feeRatePerKb" json:"feeRatePerKb"`
	LastProcessedHeight int64       `bson:"lastProcessedHeight" json:"lastProcessedHeight"`
	LastProcessedOffset int64       `bson:"lastProcessedOffset" json:"lastProcessedOffset"`
	LastAdmitSeq        int64       `bson:"lastAdmitSeq" json:"lastAdmitSeq"`
}

// DefaultAssetState is TS defaultAssetState(tokenId, feeRatePerKb): not paused, denylist, every
// list empty and non-nil (JSON [] and BSON array, never null), counters 0. The fee rate is copied,
// so the caller's pointer is never shared with the state.
func DefaultAssetState(tokenID string, feeRatePerKb *int64) AssetAdminState {
	var fee *int64
	if feeRatePerKb != nil {
		v := *feeRatePerKb
		fee = &v
	}
	return AssetAdminState{
		TokenID:           tokenID,
		AccessMode:        "denylist",
		BlockedIdentities: []string{},
		AllowedIdentities: []string{},
		FrozenOutpoints:   []FrozenRef{},
		EvictedOutpoints:  []string{},
		FeeRatePerKb:      fee,
	}
}

// AdminHistoryEntry is one mandalaAdminHistory row. FrozenAmount/FrozenOwner exist only on
// freezeOutput rows: absent is not 0 (TS recordedFoldContext branches on presence).
type AdminHistoryEntry struct {
	TokenID      string    `bson:"tokenId" json:"tokenId"`
	Txid         string    `bson:"txid" json:"txid"`
	OutputIndex  uint32    `bson:"outputIndex" json:"outputIndex"`
	Kind         string    `bson:"kind" json:"kind"`
	DetailsHex   string    `bson:"detailsHex" json:"detailsHex"`
	Commitment   string    `bson:"commitment" json:"commitment"` // lowercase hex
	Delta        Amount    `bson:"delta" json:"delta"`
	Height       int64     `bson:"height" json:"height"`
	Offset       int64     `bson:"offset" json:"offset"`
	AdmitSeq     int64     `bson:"admitSeq" json:"admitSeq"`
	CreatedAt    time.Time `bson:"createdAt" json:"createdAt"`
	FrozenAmount *Amount   `bson:"frozenAmount,omitempty" json:"frozenAmount,omitempty"`
	FrozenOwner  *string   `bson:"frozenOwner,omitempty" json:"frozenOwner,omitempty"`
}

// TokenRegistryRecord is one mandalaTokenRegistry row: the permanent tm_mandala record of a deploy.
type TokenRegistryRecord struct {
	TokenID      string    `bson:"tokenId" json:"tokenId"`
	DeployTxid   string    `bson:"deployTxid" json:"deployTxid"`
	Sym          string    `bson:"sym" json:"sym"`
	Dec          int64     `bson:"dec" json:"dec"`
	Label        string    `bson:"label" json:"label"`
	Issuer       string    `bson:"issuer" json:"issuer"`
	FeeRatePerKb *int64    `bson:"feeRatePerKb" json:"feeRatePerKb"`
	CreatedAt    time.Time `bson:"createdAt" json:"createdAt"`
}

// KYCRow is the 5-field projection of a mandalaRegistry identity row (TS RegistryStorage.list).
type KYCRow struct {
	IdentityKey string `bson:"identityKey" json:"identityKey"`
	Status      string `bson:"status" json:"status"` // "admitted" | "revoked"
	Txid        string `bson:"txid" json:"txid"`
	OutputIndex uint32 `bson:"outputIndex" json:"outputIndex"`
	AdmitSeq    int64  `bson:"admitSeq" json:"admitSeq"`
}

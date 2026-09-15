package mandala

import (
	"context"
	"fmt"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	hash "github.com/bsv-blockchain/go-sdk/primitives/hash"
	"github.com/bsv-blockchain/go-sdk/wallet"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// RegistryRow is one identity on the issuer-level registration chain.
// The collection is a cache of the chain replay, not the source of truth.
type RegistryRow struct {
	IdentityKey string    `bson:"identityKey" json:"identityKey"`
	Status      string    `bson:"status" json:"status"` // admitted | revoked
	Txid        string    `bson:"txid" json:"txid"`
	OutputIndex uint32    `bson:"outputIndex" json:"outputIndex"`
	AdmitSeq    int64     `bson:"admitSeq" json:"admitSeq"`
	CreatedAt   time.Time `bson:"createdAt" json:"createdAt"`
	// ActionDetails are the details that LOCKED this output. A client
	// re-spending the chain head must reproduce them byte for byte to
	// recompute the commitment, so guessing them is not an option (TS parity:
	// RegistryRow.actionDetails).
	ActionDetails ActionDetails `bson:"actionDetails,omitempty" json:"actionDetails,omitempty"`
}

var registryProtocol = wallet.Protocol{
	SecurityLevel: wallet.SecurityLevelEveryAppAndCounterparty,
	Protocol:      "mandala registry",
}

// RegistryWallet re-derives the P2PKH lock for a registration-chain action
// (same commitment scheme as AdminWallet, different protocol ID so the
// two spines do not share keys).
type RegistryWallet struct {
	deriver *wallet.KeyDeriver
}

func NewRegistryWallet(privHex string) (*RegistryWallet, error) {
	priv, err := ec.PrivateKeyFromHex(privHex)
	if err != nil {
		return nil, fmt.Errorf("registry key: %w", err)
	}
	return &RegistryWallet{deriver: wallet.NewKeyDeriver(priv)}, nil
}

func (w *RegistryWallet) ExpectedPKH(details ActionDetails) ([20]byte, error) {
	var out [20]byte
	keyID, err := Commitment(map[string]any(details))
	if err != nil {
		return out, err
	}
	cp := wallet.Counterparty{Type: wallet.CounterpartyTypeSelf}
	if s, ok := details.Str("counterparty"); ok {
		pub, err := ec.PublicKeyFromString(s)
		if err != nil {
			return out, fmt.Errorf("registry counterparty: %w", err)
		}
		cp = wallet.Counterparty{Type: wallet.CounterpartyTypeOther, Counterparty: pub}
	}
	pub, err := w.deriver.DerivePublicKey(registryProtocol, keyID, cp, false)
	if err != nil {
		return out, err
	}
	copy(out[:], hash.Hash160(pub.Compressed()))
	return out, nil
}

// IsAdmitted reports whether identityKey currently has status "admitted".
func (s *Store) IsAdmitted(ctx context.Context, identityKey string) (bool, error) {
	var row RegistryRow
	err := s.registry.FindOne(ctx, bson.D{{Key: "identityKey", Value: identityKey}}).Decode(&row)
	if err == mongo.ErrNoDocuments {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return row.Status == "admitted", nil
}

// RegistryActive is true once any registration-chain action has been folded
// (the membership gate stays off until then so existing demos keep working).
func (s *Store) RegistryActive(ctx context.Context) (bool, error) {
	n, err := s.registry.CountDocuments(ctx, bson.D{})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// UpsertRegistry writes the latest status for an identity.
func (s *Store) UpsertRegistry(ctx context.Context, row RegistryRow) error {
	_, err := s.registry.UpdateOne(ctx,
		bson.D{{Key: "identityKey", Value: row.IdentityKey}},
		bson.D{{Key: "$set", Value: row}},
		options.UpdateOne().SetUpsert(true),
	)
	return err
}

// ListRegistry returns every identity row, newest-first.
func (s *Store) ListRegistry(ctx context.Context) ([]RegistryRow, error) {
	cur, err := s.registry.Find(ctx, bson.D{}, options.Find().SetSort(bson.D{{Key: "admitSeq", Value: -1}}))
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var out []RegistryRow
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []RegistryRow{}
	}
	return out, nil
}

// FoldRegistry maps an admitted registration action onto a row.
func FoldRegistry(details ActionDetails, txid string, vout uint32, seq int64) (RegistryRow, bool) {
	key, ok := details.Str("identityKey")
	if !ok || key == "" {
		if details.Kind() == "register" {
			key, ok = details.Str("issuer")
		}
	}
	if !ok || key == "" {
		return RegistryRow{}, false
	}
	status := "admitted"
	switch details.Kind() {
	case "revokeIdentity":
		status = "revoked"
	case "admitIdentity", "register":
		status = "admitted"
	default:
		return RegistryRow{}, false
	}
	return RegistryRow{
		IdentityKey:   key,
		Status:        status,
		Txid:          txid,
		OutputIndex:   vout,
		AdmitSeq:      seq,
		CreatedAt:     time.Now().UTC(),
		ActionDetails: details,
	}, true
}

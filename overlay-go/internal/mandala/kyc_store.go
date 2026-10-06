package mandala

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The identity registry's state (Q2/mandala-registry/RegistryStorage.ts): one mandalaRegistry row
// per identity plus the meta doc {_id: "registryTokenId", tokenId, createdAt} naming the claimed
// registry token, and its own counter "registryAdmitSeq".
const (
	kycMetaID     = "registryTokenId"
	kycAdmitSeqID = "registryAdmitSeq"
)

// kycIdentityRows: only identity rows carry an identityKey; the meta doc never counts as a member.
var kycIdentityRows = bson.D{{Key: "identityKey", Value: bson.D{{Key: "$exists", Value: true}}}}

// kycRows is the Store handle NewStore opened on KYCRegistryCollection (Task 9's field kyc).
func (s *Store) kycRows() *mongo.Collection { return s.kyc }

var _ KYCClaims = (*Store)(nil)

// KYCRegistryTokenID is the claimed registry token, or claimed=false before the first deploy.
func (s *Store) KYCRegistryTokenID(ctx context.Context) (string, bool, error) {
	var meta struct {
		TokenID string `bson:"tokenId"`
	}
	err := s.kycRows().FindOne(ctx, bson.D{{Key: "_id", Value: kycMetaID}}).Decode(&meta)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if meta.TokenID == "" {
		return "", false, nil
	}
	return meta.TokenID, true, nil
}

// ClaimKYCRegistryTokenID: first writer wins; true only to the call that created the claim.
func (s *Store) ClaimKYCRegistryTokenID(ctx context.Context, tokenID string) (bool, error) {
	res, err := s.kycRows().UpdateOne(ctx,
		bson.D{{Key: "_id", Value: kycMetaID}},
		bson.D{{Key: "$setOnInsert", Value: bson.D{{Key: "tokenId", Value: tokenID}, {Key: "createdAt", Value: time.Now().UTC()}}}},
		options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return false, nil // a concurrent claim created it first
	}
	if err != nil {
		return false, err
	}
	return res.UpsertedCount == 1, nil
}

// ApplyKYC folds one registry action into the identity's row. A row that already carries this very
// outpoint is left as it is, so a replayed notification keeps its admitSeq.
func (s *Store) ApplyKYC(ctx context.Context, identityKey, status, txid string, vout uint32) error {
	var current struct {
		Txid        string `bson:"txid"`
		OutputIndex uint32 `bson:"outputIndex"`
	}
	err := s.kycRows().FindOne(ctx, bson.D{{Key: "identityKey", Value: identityKey}},
		options.FindOne().SetProjection(bson.D{{Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}})).Decode(&current)
	switch {
	case err == nil:
		if current.Txid == txid && current.OutputIndex == vout {
			return nil
		}
	case !errors.Is(err, mongo.ErrNoDocuments):
		return err
	}
	// Task 9's counter: monotonic and persisted, so rows folded after a restart sort above older ones.
	seq, err := s.nextSeq(ctx, kycAdmitSeqID)
	if err != nil {
		return err
	}
	filter := bson.D{{Key: "identityKey", Value: identityKey}}
	update := bson.D{
		{Key: "$set", Value: bson.D{{Key: "status", Value: status}, {Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}, {Key: "admitSeq", Value: seq}}},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: time.Now().UTC()}}},
	}
	_, err = s.kycRows().UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		// a concurrent first action for this identity inserted the row: update it instead
		_, err = s.kycRows().UpdateOne(ctx, filter, update, options.UpdateOne().SetUpsert(true))
	}
	return err
}

// KYCActive: whether the registry has any identity row (the membership gate is off until it does).
func (s *Store) KYCActive(ctx context.Context) (bool, error) {
	err := s.kycRows().FindOne(ctx, kycIdentityRows, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) KYCAdmitted(ctx context.Context, identityKey string) (bool, error) {
	err := s.kycRows().FindOne(ctx, bson.D{{Key: "identityKey", Value: identityKey}, {Key: "status", Value: "admitted"}},
		options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 1}})).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	return err == nil, err
}

// ListKYC: every identity row, newest action first, the five TS list() fields.
func (s *Store) ListKYC(ctx context.Context) ([]KYCRow, error) {
	cur, err := s.kycRows().Find(ctx, kycIdentityRows, options.Find().
		SetProjection(bson.D{{Key: "_id", Value: 0}, {Key: "identityKey", Value: 1}, {Key: "status", Value: 1},
			{Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}, {Key: "admitSeq", Value: 1}}).
		SetSort(bson.D{{Key: "admitSeq", Value: -1}}))
	if err != nil {
		return nil, err
	}
	rows := []KYCRow{}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// KYCMembership is the slice of the registry the token topics' layer D reads.
type KYCMembership struct{ Store *Store }

var _ MembershipProvider = KYCMembership{}

func (m KYCMembership) IsActive(ctx context.Context) (bool, error) { return m.Store.KYCActive(ctx) }

func (m KYCMembership) IsAdmitted(ctx context.Context, identityKey string) (bool, error) {
	return m.Store.KYCAdmitted(ctx, identityKey)
}

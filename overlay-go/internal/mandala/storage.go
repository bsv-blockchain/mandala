package mandala

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// Collection names (D §6.6, F/ts-storage §1, F/gaps §2.6), one lookup database per node.
const (
	OwnersCollection        = "mandalaOwners"
	TokensCollection        = "mandalaTokens"
	AuthoritiesCollection   = "mandalaAuthorities"
	LinkageCollection       = "mandalaLinkageRecords"
	BalancesCollection      = "mandalaBalances"
	MetadataCollection      = "mandalaMetadata"
	AssetStatesCollection   = "mandalaAssetStates"
	AdminHistoryCollection  = "mandalaAdminHistory"
	CountersCollection      = "mandalaCounters"
	TokenRegistryCollection = "mandalaTokenRegistry"
	KYCRegistryCollection   = "mandalaRegistry"
	AdmissionsCollection    = "mandalaAdmissions"
)

// Store is the Go port of TS MandalaStorageManager plus the token registry records and the host's
// admission records (F/ts-storage §3). admissions.go and kyc_store.go add methods over these fields
// (kyc + counters hold the KYC identity rows and the registryAdmitSeq counter).
type Store struct {
	owners        *mongo.Collection // mandalaOwners
	tokens        *mongo.Collection // mandalaTokens
	authorities   *mongo.Collection // mandalaAuthorities
	linkage       *mongo.Collection // mandalaLinkageRecords
	balances      *mongo.Collection // mandalaBalances
	metadata      *mongo.Collection // mandalaMetadata
	states        *mongo.Collection // mandalaAssetStates
	history       *mongo.Collection // mandalaAdminHistory
	counters      *mongo.Collection // mandalaCounters
	tokenRegistry *mongo.Collection // mandalaTokenRegistry
	kyc           *mongo.Collection // mandalaRegistry
	admissions    *mongo.Collection // mandalaAdmissions
}

var (
	_ StateStore      = (*Store)(nil)
	_ RepairUndoStore = (*Store)(nil)
)

type storeIndexSpec struct {
	coll  *mongo.Collection
	name  string
	model mongo.IndexModel
}

func storeAsc(fields ...string) bson.D {
	d := bson.D{}
	for _, f := range fields {
		d = append(d, bson.E{Key: f, Value: 1})
	}
	return d
}

// NewStore builds the store and creates every index eagerly. Unlike TS CollectionIndexes (which
// logs and continues, F/ts-storage §2.4) any failure aborts boot: the unique indexes are what make
// the journal, the value index and the admission record single-valued under concurrency.
func NewStore(db *mongo.Database) (*Store, error) {
	s := &Store{
		owners:        db.Collection(OwnersCollection),
		tokens:        db.Collection(TokensCollection),
		authorities:   db.Collection(AuthoritiesCollection),
		linkage:       db.Collection(LinkageCollection),
		balances:      db.Collection(BalancesCollection),
		metadata:      db.Collection(MetadataCollection),
		states:        db.Collection(AssetStatesCollection),
		history:       db.Collection(AdminHistoryCollection),
		counters:      db.Collection(CountersCollection),
		tokenRegistry: db.Collection(TokenRegistryCollection),
		kyc:           db.Collection(KYCRegistryCollection),
		admissions:    db.Collection(AdmissionsCollection),
	}
	// A fresh options builder per unique index: IndexView.CreateMany calls SetName on the builder it
	// is given, so one shared builder would hand its first index name to every later index.
	uniq := func() *options.IndexOptionsBuilder { return options.Index().SetUnique(true) }
	indexes := []storeIndexSpec{
		{s.owners, OwnersCollection, mongo.IndexModel{Keys: storeAsc("txid", "outputIndex", "topic"), Options: uniq()}},
		{s.tokens, TokensCollection, mongo.IndexModel{Keys: storeAsc("txid", "outputIndex"), Options: uniq()}},
		{s.tokens, TokensCollection, mongo.IndexModel{Keys: storeAsc("tokenId")}},
		{s.tokens, TokensCollection, mongo.IndexModel{Keys: storeAsc("identityKey")}},
		{s.authorities, AuthoritiesCollection, mongo.IndexModel{Keys: storeAsc("txid", "outputIndex"), Options: uniq()}},
		{s.authorities, AuthoritiesCollection, mongo.IndexModel{Keys: storeAsc("topic", "tokenId")}},
		{s.linkage, LinkageCollection, mongo.IndexModel{Keys: storeAsc("txid", "outputIndex")}},
		{s.linkage, LinkageCollection, mongo.IndexModel{Keys: storeAsc("identityKey")}},
		{s.linkage, LinkageCollection, mongo.IndexModel{Keys: bson.D{{Key: "createdAt", Value: -1}}}}, // activity paging; NO TTL
		{s.balances, BalancesCollection, mongo.IndexModel{Keys: storeAsc("identityKey"), Options: uniq()}},
		{s.metadata, MetadataCollection, mongo.IndexModel{Keys: storeAsc("tokenId"), Options: uniq()}},
		{s.states, AssetStatesCollection, mongo.IndexModel{Keys: storeAsc("tokenId"), Options: uniq()}},
		{s.history, AdminHistoryCollection, mongo.IndexModel{Keys: storeAsc("tokenId", "height", "offset", "admitSeq")}},
		{s.history, AdminHistoryCollection, mongo.IndexModel{Keys: storeAsc("tokenId", "txid", "outputIndex")}},
		{s.history, AdminHistoryCollection, mongo.IndexModel{Keys: storeAsc("txid")}},
		{s.history, AdminHistoryCollection, mongo.IndexModel{Keys: bson.D{{Key: "tokenId", Value: 1}, {Key: "admitSeq", Value: -1}}}},
		{s.tokenRegistry, TokenRegistryCollection, mongo.IndexModel{Keys: storeAsc("tokenId"), Options: uniq()}},
		{s.tokenRegistry, TokenRegistryCollection, mongo.IndexModel{Keys: storeAsc("createdAt")}},
		{s.kyc, KYCRegistryCollection, mongo.IndexModel{Keys: storeAsc("identityKey"), Options: uniq()}},
		{s.kyc, KYCRegistryCollection, mongo.IndexModel{Keys: storeAsc("status")}},
		{s.admissions, AdmissionsCollection, mongo.IndexModel{Keys: storeAsc("txid"), Options: uniq()}},
	}
	ctx := context.Background()
	for _, ix := range indexes {
		if _, err := ix.coll.Indexes().CreateOne(ctx, ix.model); err != nil {
			return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", ix.name, err)
		}
	}
	return s, nil
}

func storeOutpoint(txid string, vout uint32) bson.D {
	return bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}}
}

// storeFindOne decodes one document into out; found=false when there is none.
func storeFindOne(ctx context.Context, c *mongo.Collection, filter bson.D, out any) (bool, error) {
	err := c.FindOne(ctx, filter, options.FindOne().SetProjection(bson.D{{Key: "_id", Value: 0}})).Decode(out)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	return err == nil, err
}

// storeAll decodes every document of a cursor into a non-nil slice (JSON [], never null).
func storeAll[T any](ctx context.Context, cur *mongo.Cursor, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	rows := []T{}
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// storeDistinct is a sorted, non-nil distinct.
func storeDistinct(ctx context.Context, c *mongo.Collection, field string, filter bson.D) ([]string, error) {
	res := c.Distinct(ctx, field, filter)
	if err := res.Err(); err != nil {
		return nil, err
	}
	out := []string{}
	if err := res.Decode(&out); err != nil {
		return nil, err
	}
	slices.Sort(out)
	return out, nil
}

// storeInsertIfAbsent is the TS first-write-wins idiom: updateOne(filter, {$setOnInsert: doc}, upsert),
// true iff this call inserted. A duplicate-key race with a concurrent insert of the same key is a
// lost race, not a fault.
func storeInsertIfAbsent(ctx context.Context, c *mongo.Collection, filter bson.D, doc any) (bool, error) {
	res, err := c.UpdateOne(ctx, filter, bson.D{{Key: "$setOnInsert", Value: doc}}, options.UpdateOne().SetUpsert(true))
	if mongo.IsDuplicateKeyError(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return res.UpsertedCount == 1, nil
}

// storeUpsertSet is the TS last-write idiom: updateOne(filter, {$set: doc}, upsert).
func storeUpsertSet(ctx context.Context, c *mongo.Collection, filter bson.D, doc any) error {
	_, err := c.UpdateOne(ctx, filter, bson.D{{Key: "$set", Value: doc}}, options.UpdateOne().SetUpsert(true))
	return err
}

// ---- owner journal (append-only, never deleted) ----

// RecordOwners writes the journal rows as one unordered bulk of {$setOnInsert: row} upserts keyed
// (txid, outputIndex, topic): the first write of a row wins and a partly-duplicate batch still
// inserts the rest. An empty batch is a no-op. Any real failure is returned.
func (s *Store) RecordOwners(ctx context.Context, rows []OwnerRecord) error {
	if len(rows) == 0 {
		return nil
	}
	models := make([]mongo.WriteModel, 0, len(rows))
	for _, r := range rows {
		models = append(models, mongo.NewUpdateOneModel().
			SetFilter(bson.D{{Key: "txid", Value: r.Txid}, {Key: "outputIndex", Value: r.OutputIndex}, {Key: "topic", Value: r.Topic}}).
			SetUpdate(bson.D{{Key: "$setOnInsert", Value: r}}).
			SetUpsert(true))
	}
	_, err := s.owners.BulkWrite(ctx, models, options.BulkWrite().SetOrdered(false))
	if err != nil && storeOnlyDuplicateKeys(err) {
		return nil // a concurrent writer inserted the same rows first: first write wins
	}
	return err
}

// storeOnlyDuplicateKeys reports whether every write error of a bulk is a duplicate key.
func storeOnlyDuplicateKeys(err error) bool {
	var bwe mongo.BulkWriteException
	if !errors.As(err, &bwe) || bwe.WriteConcernError != nil || len(bwe.WriteErrors) == 0 {
		return false
	}
	for _, we := range bwe.WriteErrors {
		if we.Code != 11000 {
			return false
		}
	}
	return true
}

// GetOwnerJournal reads the journal row of (txid, vout) on topic, or nil.
func (s *Store) GetOwnerJournal(ctx context.Context, txid string, vout uint32, topic string) (*OwnerRecord, error) {
	var r OwnerRecord
	found, err := storeFindOne(ctx, s.owners, bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}, {Key: "topic", Value: topic}}, &r)
	if !found {
		return nil, err
	}
	return &r, nil
}

// OwnerJournalByOutpoint lists the journal rows of (txid, vout) on every topic, sorted by topic
// (the eviction and compensation restore, plan D-7).
func (s *Store) OwnerJournalByOutpoint(ctx context.Context, txid string, vout uint32) ([]OwnerRecord, error) {
	cur, err := s.owners.Find(ctx, storeOutpoint(txid, vout), options.Find().
		SetSort(bson.D{{Key: "topic", Value: 1}}).SetProjection(bson.D{{Key: "_id", Value: 0}}))
	return storeAll[OwnerRecord](ctx, cur, err)
}

// DistinctOwnerTopics lists, sorted, every topic with a journal row (the boot union's second source).
func (s *Store) DistinctOwnerTopics(ctx context.Context) ([]string, error) {
	return storeDistinct(ctx, s.owners, "topic", bson.D{})
}

// ---- value index (mandalaTokens) ----

// GetTokenRow reads the value row of (txid, vout), or nil.
func (s *Store) GetTokenRow(ctx context.Context, txid string, vout uint32) (*TokenRecord, error) {
	var r TokenRecord
	found, err := storeFindOne(ctx, s.tokens, storeOutpoint(txid, vout), &r)
	if !found {
		return nil, err
	}
	return &r, nil
}

// StoreTokenIfAbsent stores the value row unless one exists: true iff this call inserted.
func (s *Store) StoreTokenIfAbsent(ctx context.Context, r TokenRecord) (bool, error) {
	return storeInsertIfAbsent(ctx, s.tokens, storeOutpoint(r.Txid, r.OutputIndex), r)
}

// TakeToken removes and returns the value row of (txid, vout), or nil: exactly one caller gets it.
func (s *Store) TakeToken(ctx context.Context, txid string, vout uint32) (*TokenRecord, error) {
	var r TokenRecord
	err := s.tokens.FindOneAndDelete(ctx, storeOutpoint(txid, vout),
		options.FindOneAndDelete().SetProjection(bson.D{{Key: "_id", Value: 0}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// storeOutpointText is TS MandalaStorageManager OUTPOINT: case-insensitive txid, vout of 1-10 digits.
var storeOutpointText = regexp.MustCompile(`^([0-9a-fA-F]{64})\.(0|[1-9]\d{0,9})$`)

// liveTokenFilter is TS liveTokenFilter: the token's rows minus its evicted outpoints (txid
// lowercased; malformed entries ignored).
func (s *Store) liveTokenFilter(ctx context.Context, tokenID string) (bson.D, error) {
	var st struct {
		EvictedOutpoints []string `bson:"evictedOutpoints"`
	}
	if _, err := storeFindOne(ctx, s.states, bson.D{{Key: "tokenId", Value: tokenID}}, &st); err != nil {
		return nil, err
	}
	filter := bson.D{{Key: "tokenId", Value: tokenID}}
	nor := bson.A{}
	for _, op := range st.EvictedOutpoints {
		m := storeOutpointText.FindStringSubmatch(op)
		if m == nil {
			continue
		}
		vout, err := strconv.ParseInt(m[2], 10, 64)
		if err != nil {
			continue
		}
		nor = append(nor, bson.D{{Key: "txid", Value: strings.ToLower(m[1])}, {Key: "outputIndex", Value: vout}})
	}
	if len(nor) > 0 {
		filter = append(filter, bson.E{Key: "$nor", Value: nor})
	}
	return filter, nil
}

// FindTokensByTokenID pages the token's live value rows in (txid, outputIndex) order; limit 0 = all.
func (s *Store) FindTokensByTokenID(ctx context.Context, tokenID string, limit, skip int64) ([]TokenRecord, error) {
	filter, err := s.liveTokenFilter(ctx, tokenID)
	if err != nil {
		return nil, err
	}
	opts := options.Find().SetSort(storeAsc("txid", "outputIndex")).SetSkip(skip).SetProjection(bson.D{{Key: "_id", Value: 0}})
	if limit > 0 {
		opts = opts.SetLimit(limit)
	}
	cur, err := s.tokens.Find(ctx, filter, opts)
	return storeAll[TokenRecord](ctx, cur, err)
}

// CirculatingSupply sums the token's live value rows exactly (big.Int, so past 2^53 too).
func (s *Store) CirculatingSupply(ctx context.Context, tokenID string) (*big.Int, error) {
	filter, err := s.liveTokenFilter(ctx, tokenID)
	if err != nil {
		return nil, err
	}
	cur, err := s.tokens.Find(ctx, filter, options.Find().SetProjection(bson.D{{Key: "_id", Value: 0}, {Key: "amount", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	sum := new(big.Int)
	for cur.Next(ctx) {
		var row struct {
			Amount Amount `bson:"amount"`
		}
		if err := cur.Decode(&row); err != nil {
			return nil, err
		}
		sum.Add(sum, big.NewInt(int64(row.Amount)))
	}
	return sum, cur.Err()
}

// IndexedVoutsByTxid lists, ascending and unique, the vouts of txid that hold a value or an
// authority row (the eviction retire set, TS host mongoIndexedVouts).
func (s *Store) IndexedVoutsByTxid(ctx context.Context, txid string) ([]uint32, error) {
	seen := map[uint32]bool{}
	for _, c := range []*mongo.Collection{s.tokens, s.authorities} {
		cur, err := c.Find(ctx, bson.D{{Key: "txid", Value: txid}},
			options.Find().SetProjection(bson.D{{Key: "_id", Value: 0}, {Key: "outputIndex", Value: 1}}))
		rows, err := storeAll[Outpoint](ctx, cur, err)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			seen[r.OutputIndex] = true
		}
	}
	out := make([]uint32, 0, len(seen))
	for v := range seen {
		out = append(out, v)
	}
	slices.Sort(out)
	return out, nil
}

// ---- authority index (mandalaAuthorities) ----

// GetAuthorityRow reads the authority row of (txid, vout) on any topic, or nil.
func (s *Store) GetAuthorityRow(ctx context.Context, txid string, vout uint32) (*AuthorityRecord, error) {
	var r AuthorityRecord
	found, err := storeFindOne(ctx, s.authorities, storeOutpoint(txid, vout), &r)
	if !found {
		return nil, err
	}
	return &r, nil
}

// StoreAuthorityIfAbsent stores the authority row unless one exists: true iff this call inserted.
func (s *Store) StoreAuthorityIfAbsent(ctx context.Context, r AuthorityRecord) (bool, error) {
	return storeInsertIfAbsent(ctx, s.authorities, storeOutpoint(r.Txid, r.OutputIndex), r)
}

// TakeAuthority removes and returns the authority row of (txid, vout) (any topic), or nil.
func (s *Store) TakeAuthority(ctx context.Context, txid string, vout uint32) (*AuthorityRecord, error) {
	var r AuthorityRecord
	err := s.authorities.FindOneAndDelete(ctx, storeOutpoint(txid, vout),
		options.FindOneAndDelete().SetProjection(bson.D{{Key: "_id", Value: 0}})).Decode(&r)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ListAuthorities lists the token's authority rows on topic in (txid, outputIndex) order.
func (s *Store) ListAuthorities(ctx context.Context, topic, tokenID string) ([]AuthorityRecord, error) {
	cur, err := s.authorities.Find(ctx, bson.D{{Key: "topic", Value: topic}, {Key: "tokenId", Value: tokenID}},
		options.Find().SetSort(storeAsc("txid", "outputIndex")).SetProjection(bson.D{{Key: "_id", Value: 0}}))
	return storeAll[AuthorityRecord](ctx, cur, err)
}

// ---- §4.2a repair ----

// RepairOwnerRow rebuilds the owner row of a journal entry (D §4.2a rule 3, TS repairOwnerRow): a
// value journal upserts mandalaTokens {$set {tokenId, amount, identityKey}, $setOnInsert
// {createdAt}} and credits the owner's balance only when this call inserted; a deploy or authority
// journal upserts mandalaAuthorities {$set {topic, tokenId, identityKey}, $setOnInsert {createdAt}}
// and never credits. It never writes the journal. Concurrent repairs of one outpoint credit once:
// only the upsert that inserted sees no prior document.
func (s *Store) RepairOwnerRow(ctx context.Context, journal OwnerRecord) (bool, error) {
	coll, set := s.authorities, bson.D{
		{Key: "topic", Value: journal.Topic},
		{Key: "tokenId", Value: journal.TokenID},
		{Key: "identityKey", Value: journal.IdentityKey},
	}
	if journal.Role == brc162.RoleValue {
		coll, set = s.tokens, bson.D{
			{Key: "tokenId", Value: journal.TokenID},
			{Key: "amount", Value: journal.Amount},
			{Key: "identityKey", Value: journal.IdentityKey},
		}
	}
	update := bson.D{
		{Key: "$set", Value: set},
		{Key: "$setOnInsert", Value: bson.D{{Key: "createdAt", Value: journal.CreatedAt}}},
	}
	opts := options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.Before).SetProjection(bson.D{{Key: "_id", Value: 1}})
	var before bson.Raw
	err := coll.FindOneAndUpdate(ctx, storeOutpoint(journal.Txid, journal.OutputIndex), update, opts).Decode(&before)
	if mongo.IsDuplicateKeyError(err) {
		// Lost an insert race to a concurrent repair: the row exists now, so this call corrects it.
		err = coll.FindOneAndUpdate(ctx, storeOutpoint(journal.Txid, journal.OutputIndex), update, opts).Decode(&before)
	}
	if err == nil {
		return false, nil // corrected an existing row: no credit
	}
	if !errors.Is(err, mongo.ErrNoDocuments) {
		return false, err
	}
	if journal.Role == brc162.RoleValue {
		if err := s.AdjustBalance(ctx, journal.IdentityKey, int64(journal.Amount)); err != nil {
			return true, err
		}
	}
	return true, nil
}

// ---- balances ----

// AdjustBalance adds delta to the identity's balance ($inc, upsert).
func (s *Store) AdjustBalance(ctx context.Context, identityKey string, delta int64) error {
	_, err := s.balances.UpdateOne(ctx, bson.D{{Key: "identityKey", Value: identityKey}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "balance", Value: delta}}}}, options.UpdateOne().SetUpsert(true))
	return err
}

// GetBalance reads the identity's balance, 0 when it has none.
func (s *Store) GetBalance(ctx context.Context, identityKey string) (int64, error) {
	var rec struct {
		Balance Amount `bson:"balance"`
	}
	if _, err := storeFindOne(ctx, s.balances, bson.D{{Key: "identityKey", Value: identityKey}}, &rec); err != nil {
		return 0, err
	}
	return int64(rec.Balance), nil
}

// ---- linkage records (last write wins; read by activity) ----

// StoreLinkage upserts the linkage record of an outpoint ($set: the last write wins).
func (s *Store) StoreLinkage(ctx context.Context, r LinkageRecord) error {
	return storeUpsertSet(ctx, s.linkage, storeOutpoint(r.Txid, r.OutputIndex), r)
}

// ListLinkage lists linkage records newest first, at most limit, created at or before `before`.
func (s *Store) ListLinkage(ctx context.Context, limit int64, before *time.Time) ([]LinkageRecord, error) {
	filter := bson.D{}
	if before != nil {
		filter = bson.D{{Key: "createdAt", Value: bson.D{{Key: "$lte", Value: *before}}}}
	}
	cur, err := s.linkage.Find(ctx, filter, options.Find().
		SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(limit).SetProjection(bson.D{{Key: "_id", Value: 0}}))
	return storeAll[LinkageRecord](ctx, cur, err)
}

// FindLinkageByOutpoints reads the linkage records of the given outpoints (any order).
func (s *Store) FindLinkageByOutpoints(ctx context.Context, ops []Outpoint) ([]LinkageRecord, error) {
	if len(ops) == 0 {
		return []LinkageRecord{}, nil // $or with an empty array is a Mongo error
	}
	or := make(bson.A, 0, len(ops))
	for _, op := range ops {
		or = append(or, storeOutpoint(op.Txid, op.OutputIndex))
	}
	cur, err := s.linkage.Find(ctx, bson.D{{Key: "$or", Value: or}}, options.Find().SetProjection(bson.D{{Key: "_id", Value: 0}}))
	return storeAll[LinkageRecord](ctx, cur, err)
}

// ---- metadata ----

// StoreMetadata upserts the token's metadata ($set by tokenId).
func (s *Store) StoreMetadata(ctx context.Context, m MetadataRecord) error {
	return storeUpsertSet(ctx, s.metadata, bson.D{{Key: "tokenId", Value: m.TokenID}}, m)
}

// FindMetadata reads the token's metadata, or nil.
func (s *Store) FindMetadata(ctx context.Context, tokenID string) (*MetadataRecord, error) {
	var m MetadataRecord
	found, err := storeFindOne(ctx, s.metadata, bson.D{{Key: "tokenId", Value: tokenID}}, &m)
	if !found {
		return nil, err
	}
	return &m, nil
}

// DeleteMetadata deletes the token's metadata (no-op when absent).
func (s *Store) DeleteMetadata(ctx context.Context, tokenID string) error {
	_, err := s.metadata.DeleteOne(ctx, bson.D{{Key: "tokenId", Value: tokenID}})
	return err
}

// AllMetadata lists every token's deploy metadata by tokenId: the set the registry boot repair
// (TokenRegistryLookupService.RestoreMissingRecords, Task 16) reads. TS allMetadata (Q2 258180169).
func (s *Store) AllMetadata(ctx context.Context) ([]MetadataRecord, error) {
	cur, err := s.metadata.Find(ctx, bson.D{}, options.Find().SetSort(storeAsc("tokenId")).SetProjection(bson.D{{Key: "_id", Value: 0}}))
	return storeAll[MetadataRecord](ctx, cur, err)
}

// ---- asset state ----

// storeNormalizedState gives every list a non-nil value, so a state is never written with a BSON null
// list and always reads back as JSON [].
func storeNormalizedState(st AssetAdminState) AssetAdminState {
	if st.BlockedIdentities == nil {
		st.BlockedIdentities = []string{}
	}
	if st.AllowedIdentities == nil {
		st.AllowedIdentities = []string{}
	}
	if st.FrozenOutpoints == nil {
		st.FrozenOutpoints = []FrozenRef{}
	}
	if st.EvictedOutpoints == nil {
		st.EvictedOutpoints = []string{}
	}
	return st
}

// GetAssetState reads the token's state; a token with none reads DefaultAssetState(tokenID, nil),
// which is not persisted.
func (s *Store) GetAssetState(ctx context.Context, tokenID string) (AssetAdminState, error) {
	var st AssetAdminState
	found, err := storeFindOne(ctx, s.states, bson.D{{Key: "tokenId", Value: tokenID}}, &st)
	if err != nil {
		return AssetAdminState{}, err
	}
	if !found {
		return DefaultAssetState(tokenID, nil), nil
	}
	return storeNormalizedState(st), nil
}

// PutAssetState replaces the token's state ($set upsert by tokenId).
func (s *Store) PutAssetState(ctx context.Context, st AssetAdminState) error {
	return storeUpsertSet(ctx, s.states, bson.D{{Key: "tokenId", Value: st.TokenID}}, storeNormalizedState(st))
}

// PutAssetStateIfAbsent stores the state unless the token has one: true iff this call inserted.
func (s *Store) PutAssetStateIfAbsent(ctx context.Context, st AssetAdminState) (bool, error) {
	return storeInsertIfAbsent(ctx, s.states, bson.D{{Key: "tokenId", Value: st.TokenID}}, storeNormalizedState(st))
}

// ---- admin history ----

// AppendAdminHistory appends the entry unless (tokenId, txid, outputIndex) already has one: true
// iff this call inserted. The key index is not unique (TS parity): two truly concurrent first
// writes could both insert, so readers of the summary dedupe by (txid, outputIndex).
func (s *Store) AppendAdminHistory(ctx context.Context, e AdminHistoryEntry) (bool, error) {
	return storeInsertIfAbsent(ctx, s.history, bson.D{
		{Key: "tokenId", Value: e.TokenID}, {Key: "txid", Value: e.Txid}, {Key: "outputIndex", Value: e.OutputIndex},
	}, e)
}

// FindAdminHistory lists the token's history in fold order (height, offset, admitSeq); limit 0 = all.
func (s *Store) FindAdminHistory(ctx context.Context, tokenID string, limit, skip int64) ([]AdminHistoryEntry, error) {
	opts := options.Find().SetSort(storeAsc("height", "offset", "admitSeq")).SetSkip(skip).SetProjection(bson.D{{Key: "_id", Value: 0}})
	if limit > 0 {
		opts = opts.SetLimit(limit)
	}
	cur, err := s.history.Find(ctx, bson.D{{Key: "tokenId", Value: tokenID}}, opts)
	return storeAll[AdminHistoryEntry](ctx, cur, err)
}

// PageAdminHistoryNewestFirst lists a page of the token's history by admitSeq descending. The
// caller clamps limit (>= 1) and offset (>= 0).
func (s *Store) PageAdminHistoryNewestFirst(ctx context.Context, tokenID string, limit, offset int64) ([]AdminHistoryEntry, error) {
	cur, err := s.history.Find(ctx, bson.D{{Key: "tokenId", Value: tokenID}}, options.Find().
		SetSort(bson.D{{Key: "admitSeq", Value: -1}}).SetSkip(offset).SetLimit(limit).SetProjection(bson.D{{Key: "_id", Value: 0}}))
	return storeAll[AdminHistoryEntry](ctx, cur, err)
}

// TokenIDsWithHistory lists, sorted, every token with an admin-history row (the refold set).
func (s *Store) TokenIDsWithHistory(ctx context.Context) ([]string, error) {
	return storeDistinct(ctx, s.history, "tokenId", bson.D{})
}

// TokensTouchedBy lists, sorted, the tokens with a history row from txid.
func (s *Store) TokensTouchedBy(ctx context.Context, txid string) ([]string, error) {
	return storeDistinct(ctx, s.history, "tokenId", bson.D{{Key: "txid", Value: txid}})
}

// DeleteAdminHistoryByTxid deletes every history row of txid.
func (s *Store) DeleteAdminHistoryByTxid(ctx context.Context, txid string) error {
	_, err := s.history.DeleteMany(ctx, bson.D{{Key: "txid", Value: txid}})
	return err
}

// nextSeq increments counter id and returns its new value (TS: findOneAndUpdate $inc, upsert,
// returnDocument after; a missing result reads 1). A duplicate-key race on the first upsert is
// retried: the document exists then, so the retry increments it.
func (s *Store) nextSeq(ctx context.Context, id string) (int64, error) {
	for attempt := 0; ; attempt++ {
		var doc struct {
			Seq int64 `bson:"seq"`
		}
		err := s.counters.FindOneAndUpdate(ctx, bson.D{{Key: "_id", Value: id}},
			bson.D{{Key: "$inc", Value: bson.D{{Key: "seq", Value: 1}}}},
			options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&doc)
		if mongo.IsDuplicateKeyError(err) && attempt < 3 {
			continue
		}
		if errors.Is(err, mongo.ErrNoDocuments) {
			return 1, nil
		}
		if err != nil {
			return 0, err
		}
		return doc.Seq, nil
	}
}

// NextAdmitSeq is the shared "admitSeq" counter: 1, 2, 3, ... unique under concurrency.
func (s *Store) NextAdmitSeq(ctx context.Context) (int64, error) { return s.nextSeq(ctx, "admitSeq") }

// ---- token registry (tm_mandala records, permanent: kept on spend, deleted only on eviction) ----

// StoreRegistryRecord stores the token's registry record unless it has one (first write wins) and
// reports whether this call stored it (TS 2.1 storeRegistryRecord; the boot repair counts restores).
func (s *Store) StoreRegistryRecord(ctx context.Context, r TokenRegistryRecord) (bool, error) {
	return storeInsertIfAbsent(ctx, s.tokenRegistry, bson.D{{Key: "tokenId", Value: r.TokenID}}, r)
}

// FindRegistryRecord reads the token's registry record, or nil.
func (s *Store) FindRegistryRecord(ctx context.Context, tokenID string) (*TokenRegistryRecord, error) {
	var r TokenRegistryRecord
	found, err := storeFindOne(ctx, s.tokenRegistry, bson.D{{Key: "tokenId", Value: tokenID}}, &r)
	if !found {
		return nil, err
	}
	return &r, nil
}

// ListRegistryRecords pages the records in (createdAt, tokenId) order; limit 0 = all.
func (s *Store) ListRegistryRecords(ctx context.Context, limit, skip int64) ([]TokenRegistryRecord, error) {
	opts := options.Find().SetSort(storeAsc("createdAt", "tokenId")).SetSkip(skip).SetProjection(bson.D{{Key: "_id", Value: 0}})
	if limit > 0 {
		opts = opts.SetLimit(limit)
	}
	cur, err := s.tokenRegistry.Find(ctx, bson.D{}, opts)
	return storeAll[TokenRegistryRecord](ctx, cur, err)
}

// DeleteRegistryRecord deletes the token's registry record (eviction of its deploy only).
func (s *Store) DeleteRegistryRecord(ctx context.Context, tokenID string) error {
	_, err := s.tokenRegistry.DeleteOne(ctx, bson.D{{Key: "tokenId", Value: tokenID}})
	return err
}

// AllRegistryTokenIDs lists, sorted, every recorded token (the boot union's first source).
func (s *Store) AllRegistryTokenIDs(ctx context.Context) ([]string, error) {
	return storeDistinct(ctx, s.tokenRegistry, "tokenId", bson.D{})
}

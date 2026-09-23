package mandala

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Outpoint is the wire-compatible {txid, outputIndex} projection shape
// shared by FindByAssetID/FindByOutpoint/FindMetadataByAssetID.
type Outpoint struct {
	Txid        string `bson:"txid" json:"txid"`
	OutputIndex uint32 `bson:"outputIndex" json:"outputIndex"`
}

// TokenRow mirrors TS MandalaTokenRecord (mandalaTokens collection).
type TokenRow struct {
	Txid        string    `bson:"txid"`
	OutputIndex uint32    `bson:"outputIndex"`
	AssetID     string    `bson:"assetId"`
	Amount      int64     `bson:"amount"`
	IdentityKey string    `bson:"identityKey"`
	CreatedAt   time.Time `bson:"createdAt"`
}

// LinkageRow mirrors TS MandalaLinkageRecord (mandalaLinkageRecords
// collection). No TTL — retention is >= 5 years per the TS comment.
type LinkageRow struct {
	Txid        string          `bson:"txid"`
	OutputIndex uint32          `bson:"outputIndex"`
	IdentityKey string          `bson:"identityKey"`
	Linkage     SpecificLinkage `bson:"linkage"`
	CreatedAt   time.Time       `bson:"createdAt"`
}

// MetadataRow mirrors TS MetadataRecord (mandalaMetadata collection).
type MetadataRow struct {
	Txid        string `bson:"txid"`
	OutputIndex uint32 `bson:"outputIndex"`
	AssetID     string `bson:"assetId"`
}

// AdminHistoryEntry mirrors TS AdminHistoryEntry (mandalaAdminHistory
// collection).
type AdminHistoryEntry struct {
	AssetID       string        `bson:"assetId" json:"assetId"`
	Txid          string        `bson:"txid" json:"txid"`
	OutputIndex   uint32        `bson:"outputIndex" json:"outputIndex"`
	Height        int64         `bson:"height" json:"height"`
	Offset        int64         `bson:"offset" json:"offset"`
	AdmitSeq      int64         `bson:"admitSeq" json:"admitSeq"`
	ActionDetails ActionDetails `bson:"actionDetails" json:"actionDetails"`
	CreatedAt     time.Time     `bson:"createdAt" json:"createdAt"`
}

// balanceRecord mirrors TS BalanceRecord (mandalaBalances collection).
type balanceRecord struct {
	IdentityKey string `bson:"identityKey"`
	Balance     int64  `bson:"balance"`
}

// counterDoc mirrors TS's {_id, seq} counters collection document.
type counterDoc struct {
	ID  string `bson:"_id"`
	Seq int64  `bson:"seq"`
}

// Store is the Go port of MandalaStorageManager: Mongo-backed projections
// for the mandala collections, wire-compatible with the TS overlay.
type Store struct {
	tokens, linkage, balances, metadata, states, history, counters, registry *mongo.Collection
	// admissions is the σ_I / verdict record (wire contract §4); see
	// admissions.go.
	admissions *mongo.Collection
}

// NewStore wires up the collections and idempotently ensures all indexes
// (including the two boot-time indexes from overlay/src/index.ts:112-118).
// No TTL index exists anywhere in this store.
//
// Wire contract §9.9: an index that cannot be created ABORTS STARTUP. These
// are not performance hints — the unique index on mandalaAdmissions.txid is
// what makes "one verdict per transaction" true under concurrency, and the
// unique outpoint indexes are what stop a replayed fold from double-crediting
// a balance. A node that came up without them would look healthy while
// silently losing those guarantees, so the error is returned rather than
// logged.
func NewStore(db *mongo.Database) (*Store, error) {
	s := &Store{
		tokens:     db.Collection("mandalaTokens"),
		linkage:    db.Collection("mandalaLinkageRecords"),
		balances:   db.Collection("mandalaBalances"),
		metadata:   db.Collection("mandalaMetadata"),
		states:     db.Collection("mandalaAssetStates"),
		history:    db.Collection("mandalaAdminHistory"),
		counters:   db.Collection("mandalaCounters"),
		registry:   db.Collection("mandalaRegistry"),
		admissions: db.Collection(AdmissionsCollection),
	}
	ctx := context.Background()
	uniq := options.Index().SetUnique(true)
	outpointKeys := bson.D{{Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}}
	if _, err := s.tokens.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: outpointKeys, Options: uniq},
		{Keys: bson.D{{Key: "assetId", Value: 1}}},
		{Keys: bson.D{{Key: "identityKey", Value: 1}}},
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", "mandalaTokens", err)
	}
	if _, err := s.linkage.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: outpointKeys},
		{Keys: bson.D{{Key: "identityKey", Value: 1}}},
		{Keys: bson.D{{Key: "createdAt", Value: -1}}}, // activity paging; NO TTL
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", "mandalaLinkageRecords", err)
	}
	if _, err := s.balances.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "identityKey", Value: 1}}, Options: uniq},
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", "mandalaBalances", err)
	}
	if _, err := s.metadata.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: outpointKeys, Options: uniq},
		{Keys: bson.D{{Key: "assetId", Value: 1}}},
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", "mandalaMetadata", err)
	}
	if _, err := s.states.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "assetId", Value: 1}}, Options: uniq},
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", "mandalaAssetStates", err)
	}
	if _, err := s.history.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "assetId", Value: 1}, {Key: "height", Value: 1}, {Key: "offset", Value: 1}, {Key: "admitSeq", Value: 1}}},
		{Keys: bson.D{{Key: "assetId", Value: 1}, {Key: "admitSeq", Value: -1}}},
		// Admin-chain anchoring looks this up once per admin output per submit.
		{Keys: bson.D{{Key: "assetId", Value: 1}, {Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}}},
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", "mandalaAdminHistory", err)
	}
	if _, err := s.registry.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "identityKey", Value: 1}}, Options: uniq},
		{Keys: bson.D{{Key: "status", Value: 1}}},
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", "mandalaRegistry", err)
	}
	if _, err := s.admissions.Indexes().CreateMany(ctx, []mongo.IndexModel{
		// Unique on txid (wire contract §4): one verdict per transaction, so
		// two concurrent submitters can never persist divergent answers.
		{Keys: bson.D{{Key: "txid", Value: 1}}, Options: uniq},
	}); err != nil {
		return nil, fmt.Errorf("mandala store: index creation failed on %s: %w", AdmissionsCollection, err)
	}
	return s, nil
}

// --- tokens ---

func (s *Store) StoreToken(ctx context.Context, r TokenRow) error {
	_, err := s.tokens.InsertOne(ctx, r)
	return err
}

func (s *Store) GetTokenRow(ctx context.Context, txid string, vout uint32) (*TokenRow, error) {
	var r TokenRow
	err := s.tokens.FindOne(ctx, bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}}).Decode(&r)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) DeleteToken(ctx context.Context, txid string, vout uint32) error {
	_, err := s.tokens.DeleteOne(ctx, bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}})
	return err
}

func (s *Store) FindByAssetID(ctx context.Context, assetID string) ([]Outpoint, error) {
	st, err := s.GetAssetState(ctx, assetID)
	if err != nil {
		return nil, err
	}
	evicted := map[string]bool{}
	for _, op := range st.EvictedOutpoints {
		evicted[op] = true
	}
	cur, err := s.tokens.Find(ctx, bson.D{{Key: "assetId", Value: assetID}},
		options.Find().SetProjection(bson.D{{Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}, {Key: "_id", Value: 0}}))
	if err != nil {
		return nil, err
	}
	var rows []Outpoint
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	out := make([]Outpoint, 0, len(rows))
	for _, r := range rows {
		if !evicted[fmtOutpoint(r.Txid, r.OutputIndex)] {
			out = append(out, r)
		}
	}
	return out, nil
}

func (s *Store) FindByOutpoint(ctx context.Context, txid string, vout uint32) ([]Outpoint, error) {
	cur, err := s.tokens.Find(ctx, bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}},
		options.Find().SetProjection(bson.D{{Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}, {Key: "_id", Value: 0}}))
	if err != nil {
		return nil, err
	}
	var rows []Outpoint
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []Outpoint{}
	}
	return rows, nil
}

// SnapshotTokens fetches the full token rows for the given outpoints (the
// inputs of a tx about to be submitted). Outpoints with no token row are
// simply absent from the result. The snapshot feeds RestoreTokens when the
// pinned overlay engine's broadcast fails after OutputSpent already deleted
// the rows and debited the balances (broadcast-failure compensation).
func (s *Store) SnapshotTokens(ctx context.Context, outpoints []Outpoint) ([]TokenRow, error) {
	if len(outpoints) == 0 {
		// $or with an empty array is a Mongo error — short-circuit.
		return []TokenRow{}, nil
	}
	or := make(bson.A, 0, len(outpoints))
	for _, op := range outpoints {
		or = append(or, bson.D{{Key: "txid", Value: op.Txid}, {Key: "outputIndex", Value: op.OutputIndex}})
	}
	cur, err := s.tokens.Find(ctx, bson.D{{Key: "$or", Value: or}})
	if err != nil {
		return nil, err
	}
	var rows []TokenRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []TokenRow{}
	}
	return rows, nil
}

// RestoreTokens re-inserts snapshotted token rows and re-credits the balance
// of every row carrying an identityKey — the inverse of what OutputSpent did
// (§4.3). Idempotent: each row is upserted by outpoint with $setOnInsert, and
// the balance is only re-incremented when the upsert actually re-inserted the
// row, so a double restore (retry, duplicate compensation) neither duplicates
// rows nor double-credits.
func (s *Store) RestoreTokens(ctx context.Context, rows []TokenRow) error {
	for _, r := range rows {
		res, err := s.tokens.UpdateOne(ctx,
			bson.D{{Key: "txid", Value: r.Txid}, {Key: "outputIndex", Value: r.OutputIndex}},
			bson.D{{Key: "$setOnInsert", Value: r}},
			options.UpdateOne().SetUpsert(true))
		if err != nil {
			return err
		}
		if res.UpsertedCount == 1 && r.IdentityKey != "" {
			if err := s.AdjustBalance(ctx, r.IdentityKey, r.Amount); err != nil {
				return err
			}
		}
	}
	return nil
}

// --- linkage ---

func (s *Store) StoreLinkage(ctx context.Context, r LinkageRow) error {
	_, err := s.linkage.InsertOne(ctx, r)
	return err
}

func (s *Store) GetLinkageRow(ctx context.Context, txid string, vout uint32) (*LinkageRow, error) {
	var r LinkageRow
	err := s.linkage.FindOne(ctx, bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}}).Decode(&r)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) ListLinkage(ctx context.Context, limit int64, before *time.Time) ([]LinkageRow, error) {
	filter := bson.D{}
	if before != nil {
		filter = bson.D{{Key: "createdAt", Value: bson.D{{Key: "$lte", Value: *before}}}}
	}
	cur, err := s.linkage.Find(ctx, filter,
		options.Find().SetSort(bson.D{{Key: "createdAt", Value: -1}}).SetLimit(limit))
	if err != nil {
		return nil, err
	}
	var rows []LinkageRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []LinkageRow{}
	}
	return rows, nil
}

func (s *Store) FindLinkageByOutpoints(ctx context.Context, outpoints []Outpoint) ([]LinkageRow, error) {
	if len(outpoints) == 0 {
		// $or with an empty array is a Mongo error — short-circuit.
		return []LinkageRow{}, nil
	}
	or := make(bson.A, 0, len(outpoints))
	for _, op := range outpoints {
		or = append(or, bson.D{{Key: "txid", Value: op.Txid}, {Key: "outputIndex", Value: op.OutputIndex}})
	}
	cur, err := s.linkage.Find(ctx, bson.D{{Key: "$or", Value: or}})
	if err != nil {
		return nil, err
	}
	var rows []LinkageRow
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []LinkageRow{}
	}
	return rows, nil
}

// --- balances ---

func (s *Store) AdjustBalance(ctx context.Context, identityKey string, delta int64) error {
	_, err := s.balances.UpdateOne(ctx,
		bson.D{{Key: "identityKey", Value: identityKey}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "balance", Value: delta}}}},
		options.UpdateOne().SetUpsert(true))
	return err
}

func (s *Store) GetBalance(ctx context.Context, identityKey string) (int64, error) {
	var rec balanceRecord
	err := s.balances.FindOne(ctx, bson.D{{Key: "identityKey", Value: identityKey}}).Decode(&rec)
	if err == mongo.ErrNoDocuments {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return rec.Balance, nil
}

// --- metadata ---

func (s *Store) StoreMetadata(ctx context.Context, r MetadataRow) error {
	_, err := s.metadata.UpdateOne(ctx,
		bson.D{{Key: "txid", Value: r.Txid}, {Key: "outputIndex", Value: r.OutputIndex}},
		bson.D{{Key: "$set", Value: r}},
		options.UpdateOne().SetUpsert(true))
	return err
}

func (s *Store) FindMetadataByAssetID(ctx context.Context, assetID string) ([]Outpoint, error) {
	cur, err := s.metadata.Find(ctx, bson.D{{Key: "assetId", Value: assetID}},
		options.Find().SetProjection(bson.D{{Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}, {Key: "_id", Value: 0}}))
	if err != nil {
		return nil, err
	}
	var rows []Outpoint
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []Outpoint{}
	}
	return rows, nil
}

func (s *Store) DeleteMetadata(ctx context.Context, txid string, vout uint32) error {
	_, err := s.metadata.DeleteOne(ctx, bson.D{{Key: "txid", Value: txid}, {Key: "outputIndex", Value: vout}})
	return err
}

// --- asset state ---

func (s *Store) GetAssetState(ctx context.Context, assetID string) (AssetAdminState, error) {
	var st AssetAdminState
	err := s.states.FindOne(ctx, bson.D{{Key: "assetId", Value: assetID}}).Decode(&st)
	if err == mongo.ErrNoDocuments {
		return DefaultAssetState(assetID), nil
	}
	if err != nil {
		return AssetAdminState{}, err
	}
	return st, nil
}

// IssuerIdentityKeys lists every distinct non-empty issuerIdentityKey in the
// asset-state cache. The membership gate (A04) exempts these identities, so
// the read is live per check — a fresh register is honoured on the next
// submit, never answered from a cache.
func (s *Store) IssuerIdentityKeys(ctx context.Context) ([]string, error) {
	res := s.states.Distinct(ctx, "issuerIdentityKey",
		bson.D{{Key: "issuerIdentityKey", Value: bson.D{{Key: "$ne", Value: ""}}}})
	if err := res.Err(); err != nil {
		return nil, err
	}
	var keys []string
	if err := res.Decode(&keys); err != nil {
		return nil, err
	}
	return keys, nil
}

func (s *Store) PutAssetState(ctx context.Context, st AssetAdminState) error {
	_, err := s.states.UpdateOne(ctx,
		bson.D{{Key: "assetId", Value: st.AssetID}},
		bson.D{{Key: "$set", Value: st}},
		options.UpdateOne().SetUpsert(true))
	return err
}

// --- admin history ---

func (s *Store) AppendAdminHistory(ctx context.Context, e AdminHistoryEntry) error {
	_, err := s.history.InsertOne(ctx, e)
	return err
}

// IsAdminOutpoint reports whether this topic already admitted the given
// outpoint as an admin-auth output of assetID. It anchors the admin chain:
// an admin action is authorised by SPENDING the recorded prior, never by
// re-deriving a lock key that the named counterparty could also derive.
func (s *Store) IsAdminOutpoint(ctx context.Context, assetID, txid string, vout uint32) (bool, error) {
	err := s.history.FindOne(ctx, bson.D{
		{Key: "assetId", Value: assetID},
		{Key: "txid", Value: txid},
		{Key: "outputIndex", Value: vout},
	}).Err()
	if errors.Is(err, mongo.ErrNoDocuments) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// DeleteAdminHistoryByTxid removes every admin-history row the given
// transaction produced and reports the (sorted, distinct) asset IDs that lost
// a row, so the caller can rebuild exactly those asset states. Eviction is the
// only caller: an evicted transaction never reached the chain, so the actions
// it recorded never happened and must stop being picked as the auth head
// (PickAssetAuthHead) or folded into state. A txid with no rows is a no-op.
func (s *Store) DeleteAdminHistoryByTxid(ctx context.Context, txid string) ([]string, error) {
	filter := bson.D{{Key: "txid", Value: txid}}
	res := s.history.Distinct(ctx, "assetId", filter)
	if err := res.Err(); err != nil {
		return nil, err
	}
	var assets []string
	if err := res.Decode(&assets); err != nil {
		return nil, err
	}
	if len(assets) == 0 {
		return []string{}, nil
	}
	if _, err := s.history.DeleteMany(ctx, filter); err != nil {
		return nil, err
	}
	sort.Strings(assets)
	return assets, nil
}

func (s *Store) FindAdminHistoryByAssetID(ctx context.Context, assetID string) ([]AdminHistoryEntry, error) {
	cur, err := s.history.Find(ctx, bson.D{{Key: "assetId", Value: assetID}},
		options.Find().SetSort(bson.D{{Key: "height", Value: 1}, {Key: "offset", Value: 1}, {Key: "admitSeq", Value: 1}}))
	if err != nil {
		return nil, err
	}
	var rows []AdminHistoryEntry
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []AdminHistoryEntry{}
	}
	return rows, nil
}

// PageAdminHistory returns a newest-first (by admitSeq) page of admin
// history for assetID. limit is clamped to [1, 500]; offset is clamped to
// >= 0 — same defaults as overlay/src/index.ts's /admin/admin-history-page.
func (s *Store) PageAdminHistory(ctx context.Context, assetID string, limit, offset int64) ([]AdminHistoryEntry, error) {
	// Deliberate divergence from the TS literal: TS's `Number(x) || 100`
	// maps 0 (and NaN) to the 100 default but lets negatives through
	// untouched; here both limit<=0 and negative limits fall back to the
	// same 100 default for simplicity — no behavioral cases depend on a
	// distinct "negative limit" outcome.
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	cur, err := s.history.Find(ctx, bson.D{{Key: "assetId", Value: assetID}},
		options.Find().SetSort(bson.D{{Key: "admitSeq", Value: -1}}).SetSkip(offset).SetLimit(limit))
	if err != nil {
		return nil, err
	}
	var rows []AdminHistoryEntry
	if err := cur.All(ctx, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		rows = []AdminHistoryEntry{}
	}
	return rows, nil
}

// AdminSummary aggregates mandalaAdminHistory by actionDetails.kind:
// totalIssued/totalRedeemed sum actionDetails.amount for kind "issue" and
// "redeem" respectively ("reissue" conserves supply and is excluded from
// both totals — overlay/src/index.ts admin-summary route). actionCount is
// the number of distinct on-chain actions for the asset, across all kinds.
// Re-admits (GASP re-sync / reorg replay) append duplicate rows for the
// same on-chain action with a fresh admitSeq — collapse to one per
// (txid, outputIndex) BEFORE summing, or totals double-count.
func (s *Store) AdminSummary(ctx context.Context, assetID string) (totalIssued, totalRedeemed, actionCount int64, err error) {
	cur, err := s.history.Aggregate(ctx, bson.A{
		bson.D{{Key: "$match", Value: bson.D{{Key: "assetId", Value: assetID}}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{
				{Key: "txid", Value: "$txid"},
				{Key: "outputIndex", Value: "$outputIndex"},
			}},
			{Key: "kind", Value: bson.D{{Key: "$first", Value: "$actionDetails.kind"}}},
			{Key: "amount", Value: bson.D{{Key: "$first", Value: "$actionDetails.amount"}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: "$kind"},
			{Key: "total", Value: bson.D{{Key: "$sum", Value: "$amount"}}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
	})
	if err != nil {
		return 0, 0, 0, err
	}
	var groups []struct {
		ID    string `bson:"_id"`
		Total int64  `bson:"total"`
		Count int64  `bson:"count"`
	}
	if err := cur.All(ctx, &groups); err != nil {
		return 0, 0, 0, err
	}
	for _, g := range groups {
		switch g.ID {
		case "issue":
			totalIssued = g.Total
		case "redeem":
			totalRedeemed = g.Total
		}
		actionCount += g.Count
	}
	return totalIssued, totalRedeemed, actionCount, nil
}

// --- counters ---

func (s *Store) NextAdmitSeq(ctx context.Context) (int64, error) {
	var doc counterDoc
	err := s.counters.FindOneAndUpdate(ctx,
		bson.D{{Key: "_id", Value: "admitSeq"}},
		bson.D{{Key: "$inc", Value: bson.D{{Key: "seq", Value: 1}}}},
		options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return 1, nil // TS fallback: (r as {seq:number}|null)?.seq ?? 1
	}
	if err != nil {
		return 0, err // real driver errors (network, context, etc.) propagate
	}
	return doc.Seq, nil
}

func fmtOutpoint(txid string, vout uint32) string {
	return fmt.Sprintf("%s.%d", txid, vout)
}

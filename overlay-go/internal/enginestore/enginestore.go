// Package enginestore is the in-repo Mongo implementation of
// go-overlay-services v1.3.2's engine.Storage (Task 12, amended: the
// b-open-io/overlay storage does not implement the v1.3.2 interface at any
// published tag, so the spec fallback governs and we own the storage layer).
//
// Design (brief-pinned): outputs live in `engineOutputs` (unique index
// topic+txid+outputIndex) with the BEEF bytes inline on the document as a
// binary field; applied transactions live in `engineAppliedTransactions`
// (unique topic+txid). GASP last-interaction bookkeeping needs one more tiny
// keyed record, `engineInteractions` (unique host+topic). No caching, no
// extra features.
package enginestore

import (
	"context"
	"fmt"
	"log"
	"slices"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Store is the concrete Mongo-backed engine.Storage. It is exported (rather
// than hidden behind the interface) because the wiring layer needs the
// compensation/eviction methods below — UnmarkSpentBySpendTxid,
// FindOutputsByTxid, DeleteOutputsByTxid, DeleteAppliedTransactionsByTxid —
// which are deliberately NOT part of go-overlay-services' engine.Storage:
// they exist to undo/evict what the pinned v1.3.2 engine cannot.
type Store struct {
	outputs      *mongo.Collection
	applied      *mongo.Collection
	interactions *mongo.Collection
}

var _ engine.Storage = (*Store)(nil)

// New wires the three collections on the given db (the same db handle the
// mandala Store uses) and idempotently ensures the indexes. The result
// satisfies the engine.Storage the wiring package hands to engine.NewEngine.
//
// Wire contract §9.9: an index that cannot be created ABORTS STARTUP, exactly
// as in mandala.NewStore. The unique (topic, txid, outputIndex) index is what
// makes the engine's output store single-valued and the unique (topic, txid)
// applied-transaction index is the dupe gate FIX C's proof rests on; a node
// running without them would serve confident, wrong answers.
func New(db *mongo.Database) (*Store, error) {
	s := &Store{
		outputs:      db.Collection("engineOutputs"),
		applied:      db.Collection("engineAppliedTransactions"),
		interactions: db.Collection("engineInteractions"),
	}
	ctx := context.Background()
	uniq := options.Index().SetUnique(true)
	if _, err := s.outputs.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "topic", Value: 1}, {Key: "txid", Value: 1}, {Key: "outputIndex", Value: 1}}, Options: uniq},
		{Keys: bson.D{{Key: "txid", Value: 1}}},
		{Keys: bson.D{{Key: "topic", Value: 1}, {Key: "spent", Value: 1}, {Key: "score", Value: 1}}},
		{Keys: bson.D{{Key: "topic", Value: 1}, {Key: "merkleState", Value: 1}}},
	}); err != nil {
		return nil, fmt.Errorf("engine store: index creation failed on %s: %w", "engineOutputs", err)
	}
	if _, err := s.applied.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "topic", Value: 1}, {Key: "txid", Value: 1}}, Options: uniq},
	}); err != nil {
		return nil, fmt.Errorf("engine store: index creation failed on %s: %w", "engineAppliedTransactions", err)
	}
	if _, err := s.interactions.Indexes().CreateMany(ctx, []mongo.IndexModel{
		{Keys: bson.D{{Key: "host", Value: 1}, {Key: "topic", Value: 1}}, Options: uniq},
	}); err != nil {
		return nil, fmt.Errorf("engine store: index creation failed on %s: %w", "engineInteractions", err)
	}
	return s, nil
}

// outpointDoc is the embedded outpoint shape (txid in display hex).
type outpointDoc struct {
	Txid  string `bson:"txid"`
	Index uint32 `bson:"index"`
}

// outputDoc is the engineOutputs document. BEEF bytes are stored inline as a
// binary field per the amended Task 12 brief.
type outputDoc struct {
	Topic       string `bson:"topic"`
	Txid        string `bson:"txid"`
	OutputIndex uint32 `bson:"outputIndex"`
	Spent       bool   `bson:"spent"`
	// SpendTxid records which submitted transaction marked this output
	// spent. Task 12 wrote it as write-only bookkeeping; it is now
	// load-bearing: UnmarkSpentBySpendTxid keys on it to reverse
	// MarkUTXOsAsSpent when the pinned engine's broadcast fails after the
	// inputs were already marked (broadcast-failure compensation).
	SpendTxid       string        `bson:"spendTxid,omitempty"`
	OutputsConsumed []outpointDoc `bson:"outputsConsumed,omitempty"`
	ConsumedBy      []outpointDoc `bson:"consumedBy,omitempty"`
	BlockHeight     uint32        `bson:"blockHeight,omitempty"`
	BlockIdx        uint64        `bson:"blockIdx,omitempty"`
	Score           float64       `bson:"score"`
	Beef            []byte        `bson:"beef,omitempty"`
	AncillaryTxids  []string      `bson:"ancillaryTxids,omitempty"`
	MerkleRoot      string        `bson:"merkleRoot,omitempty"`
	MerkleState     uint8         `bson:"merkleState"`
}

func toOutpointDocs(ops []*transaction.Outpoint) []outpointDoc {
	if len(ops) == 0 {
		return nil
	}
	docs := make([]outpointDoc, 0, len(ops))
	for _, o := range ops {
		docs = append(docs, outpointDoc{Txid: o.Txid.String(), Index: o.Index})
	}
	return docs
}

func fromOutpointDocs(docs []outpointDoc) ([]*transaction.Outpoint, error) {
	if len(docs) == 0 {
		return nil, nil
	}
	ops := make([]*transaction.Outpoint, 0, len(docs))
	for _, d := range docs {
		h, err := chainhash.NewHashFromHex(d.Txid)
		if err != nil {
			return nil, fmt.Errorf("enginestore: bad stored txid %q: %w", d.Txid, err)
		}
		ops = append(ops, &transaction.Outpoint{Txid: *h, Index: d.Index})
	}
	return ops, nil
}

// toOutput maps a document back to the engine.Output shape. Beef is only
// parsed when includeBEEF is set (FindOutput's includeBEEF=false callers,
// e.g. deleteUTXODeep, must get Beef == nil).
func (d *outputDoc) toOutput(includeBEEF bool) (*engine.Output, error) {
	txid, err := chainhash.NewHashFromHex(d.Txid)
	if err != nil {
		return nil, fmt.Errorf("enginestore: bad stored txid %q: %w", d.Txid, err)
	}
	out := &engine.Output{
		Outpoint:    transaction.Outpoint{Txid: *txid, Index: d.OutputIndex},
		Topic:       d.Topic,
		Spent:       d.Spent,
		BlockHeight: d.BlockHeight,
		BlockIdx:    d.BlockIdx,
		Score:       d.Score,
		MerkleState: engine.MerkleState(d.MerkleState),
	}
	if out.OutputsConsumed, err = fromOutpointDocs(d.OutputsConsumed); err != nil {
		return nil, err
	}
	if out.ConsumedBy, err = fromOutpointDocs(d.ConsumedBy); err != nil {
		return nil, err
	}
	for _, a := range d.AncillaryTxids {
		h, err := chainhash.NewHashFromHex(a)
		if err != nil {
			return nil, fmt.Errorf("enginestore: bad stored ancillary txid %q: %w", a, err)
		}
		out.AncillaryTxids = append(out.AncillaryTxids, h)
	}
	if d.MerkleRoot != "" {
		root, err := chainhash.NewHashFromHex(d.MerkleRoot)
		if err != nil {
			return nil, fmt.Errorf("enginestore: bad stored merkle root %q: %w", d.MerkleRoot, err)
		}
		out.MerkleRoot = root
	}
	if includeBEEF && len(d.Beef) > 0 {
		beef, err := transaction.NewBeefFromBytes(d.Beef)
		if err != nil {
			return nil, fmt.Errorf("enginestore: stored BEEF for %s.%d unparseable: %w", d.Txid, d.OutputIndex, err)
		}
		out.Beef = beef
	}
	return out, nil
}

func outpointFilter(topic string, o *transaction.Outpoint) bson.D {
	return bson.D{
		{Key: "topic", Value: topic},
		{Key: "txid", Value: o.Txid.String()},
		{Key: "outputIndex", Value: o.Index},
	}
}

// proofInfo extracts merkle facts for txid from the BEEF's bump, if any.
func proofInfo(beef *transaction.Beef, txid *chainhash.Hash) (root string, state engine.MerkleState, height uint32, idx uint64) {
	state = engine.MerkleStateUnmined
	if beef == nil {
		return
	}
	bump := beef.FindBumpByHash(txid)
	if bump == nil {
		return
	}
	r, err := bump.ComputeRoot(txid)
	if err != nil {
		return
	}
	// The engine SPV-verifies proofs (chain tracker) before anything reaches
	// storage, so a proof-bearing insert lands Validated; ReconcileMerkleRoot
	// moves it later if the chain disagrees.
	root, state, height = r.String(), engine.MerkleStateValidated, bump.BlockHeight
	for _, leaf := range bump.Path[0] {
		if leaf != nil && leaf.Hash != nil && leaf.Hash.Equal(*txid) {
			idx = leaf.Offset
			break
		}
	}
	return
}

// InsertOutputs stores one document per admitted vout, all sharing the
// submitted BEEF bytes, the consumed outpoints and the ancillary txids
// (engine.commitTopicOutputs). Upsert keeps a partial-failure retry
// idempotent under the unique index. An empty admit list is a no-op — the
// engine calls this even for topics that admitted nothing.
func (s *Store) InsertOutputs(ctx context.Context, topic string, txid *chainhash.Hash, outputs []uint32, outpointsConsumed []*transaction.Outpoint, beef *transaction.Beef, ancillaryTxids []*chainhash.Hash) error {
	if len(outputs) == 0 {
		return nil
	}
	var beefBytes []byte
	if beef != nil {
		var err error
		if beefBytes, err = beef.Bytes(); err != nil {
			return fmt.Errorf("enginestore: serialize BEEF: %w", err)
		}
	}
	root, state, height, idx := proofInfo(beef, txid)
	var ancillary []string
	for _, a := range ancillaryTxids {
		ancillary = append(ancillary, a.String())
	}
	consumed := toOutpointDocs(outpointsConsumed)
	score := float64(time.Now().UnixMicro())

	models := make([]mongo.WriteModel, 0, len(outputs))
	for _, vout := range outputs {
		doc := outputDoc{
			Topic:           topic,
			Txid:            txid.String(),
			OutputIndex:     vout,
			OutputsConsumed: consumed,
			BlockHeight:     height,
			BlockIdx:        idx,
			Score:           score,
			Beef:            beefBytes,
			AncillaryTxids:  ancillary,
			MerkleRoot:      root,
			MerkleState:     uint8(state),
		}
		models = append(models, mongo.NewReplaceOneModel().
			SetFilter(outpointFilter(topic, &transaction.Outpoint{Txid: *txid, Index: vout})).
			SetReplacement(doc).
			SetUpsert(true))
	}
	_, err := s.outputs.BulkWrite(ctx, models)
	return err
}

// FindOutput returns the stored output or (nil, nil) when absent — the
// engine's callers (hydrateOneFormula, deleteUTXODeep, hydrateGASPNode)
// branch on a nil output, never on ErrNotFound.
func (s *Store) FindOutput(ctx context.Context, outpoint *transaction.Outpoint, topic *string, spent *bool, includeBEEF bool) (*engine.Output, error) {
	filter := bson.D{
		{Key: "txid", Value: outpoint.Txid.String()},
		{Key: "outputIndex", Value: outpoint.Index},
	}
	if topic != nil {
		filter = append(filter, bson.E{Key: "topic", Value: *topic})
	}
	if spent != nil {
		filter = append(filter, bson.E{Key: "spent", Value: *spent})
	}
	var doc outputDoc
	if err := s.outputs.FindOne(ctx, filter).Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			return nil, nil
		}
		return nil, err
	}
	return doc.toOutput(includeBEEF)
}

// FindOutputs is positional: result[i] pairs with outpoints[i] and is nil
// when missing — engine.mergeExistingOutputs uses the slice index as the
// input vin.
func (s *Store) FindOutputs(ctx context.Context, outpoints []*transaction.Outpoint, topic string, spent *bool, includeBEEF bool) ([]*engine.Output, error) {
	results := make([]*engine.Output, len(outpoints))
	if len(outpoints) == 0 {
		return results, nil
	}
	ors := make(bson.A, 0, len(outpoints))
	for _, o := range outpoints {
		ors = append(ors, bson.D{
			{Key: "txid", Value: o.Txid.String()},
			{Key: "outputIndex", Value: o.Index},
		})
	}
	filter := bson.D{{Key: "topic", Value: topic}, {Key: "$or", Value: ors}}
	if spent != nil {
		filter = append(filter, bson.E{Key: "spent", Value: *spent})
	}
	cur, err := s.outputs.Find(ctx, filter)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	byKey := make(map[string]*engine.Output, len(outpoints))
	for cur.Next(ctx) {
		var doc outputDoc
		if err := cur.Decode(&doc); err != nil {
			return nil, err
		}
		out, err := doc.toOutput(includeBEEF)
		if err != nil {
			return nil, err
		}
		byKey[out.Outpoint.String()] = out
	}
	if err := cur.Err(); err != nil {
		return nil, err
	}
	for i, o := range outpoints {
		results[i] = byKey[o.String()]
	}
	return results, nil
}

// FindOutputsForTransaction returns every topic's outputs for the txid
// (HandleNewMerkleProof updates all of them).
func (s *Store) FindOutputsForTransaction(ctx context.Context, txid *chainhash.Hash, includeBEEF bool) ([]*engine.Output, error) {
	cur, err := s.outputs.Find(ctx, bson.D{{Key: "txid", Value: txid.String()}})
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var outs []*engine.Output
	for cur.Next(ctx) {
		var doc outputDoc
		if err := cur.Decode(&doc); err != nil {
			return nil, err
		}
		out, err := doc.toOutput(includeBEEF)
		if err != nil {
			return nil, err
		}
		outs = append(outs, out)
	}
	return outs, cur.Err()
}

// FindUTXOsForTopic pages unspent outputs by insertion score: score > since,
// ascending, limited (0 = unlimited) — the shape GASP's initial-response
// pagination expects.
func (s *Store) FindUTXOsForTopic(ctx context.Context, topic string, since float64, limit uint32, includeBEEF bool) ([]*engine.Output, error) {
	filter := bson.D{
		{Key: "topic", Value: topic},
		{Key: "spent", Value: false},
		{Key: "score", Value: bson.D{{Key: "$gt", Value: since}}},
	}
	opts := options.Find().SetSort(bson.D{{Key: "score", Value: 1}})
	if limit > 0 {
		opts = opts.SetLimit(int64(limit))
	}
	cur, err := s.outputs.Find(ctx, filter, opts)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	outs := make([]*engine.Output, 0)
	for cur.Next(ctx) {
		var doc outputDoc
		if err := cur.Decode(&doc); err != nil {
			return nil, err
		}
		out, err := doc.toOutput(includeBEEF)
		if err != nil {
			return nil, err
		}
		outs = append(outs, out)
	}
	return outs, cur.Err()
}

// DeleteOutput removes one (topic, outpoint) document; deleting an
// already-gone output is not an error (deleteUTXODeep re-walks graphs).
func (s *Store) DeleteOutput(ctx context.Context, outpoint *transaction.Outpoint, topic string) error {
	_, err := s.outputs.DeleteOne(ctx, outpointFilter(topic, outpoint))
	return err
}

// MarkUTXOsAsSpent flags the topic's inputs of a newly submitted tx
// (engine.markTopicUTXOsSpent), recording the spending txid.
//
// FIX L: this is a COMPARE-AND-SWAP, not an unconditional write. The update
// matches only rows that are still unspent, or that this same transaction
// already marked (the idempotent resubmit — refusing that would strand a
// transaction whose first attempt died between marking and committing), and
// then checks the matched count. A shortfall means some coin is already
// spent by a different transaction: the rows this call DID take are handed
// back, and the error names the competitor. Without the check, two concurrent
// submits of conflicting spends both "succeeded" here and the double spend
// was left for Arcade's broadcast race to notice — or not.
//
// The error is deliberately NOT a topic-manager verdict: the HTTP layer
// classifies it as ERR_UNAVAILABLE (503, retryable), and the retry then meets
// the manager's own conflicting-spend gate, which answers the final
// ERR_INPUT_SPENT.
func (s *Store) MarkUTXOsAsSpent(ctx context.Context, outpoints []*transaction.Outpoint, topic string, spendTxid *chainhash.Hash) error {
	if len(outpoints) == 0 {
		return nil
	}
	ors := make(bson.A, 0, len(outpoints))
	for _, o := range outpoints {
		ors = append(ors, bson.D{
			{Key: "txid", Value: o.Txid.String()},
			{Key: "outputIndex", Value: o.Index},
		})
	}
	spender := ""
	set := bson.D{{Key: "spent", Value: true}}
	if spendTxid != nil {
		spender = spendTxid.String()
		set = append(set, bson.E{Key: "spendTxid", Value: spender})
	}
	claimable := bson.A{bson.D{{Key: "spent", Value: false}}}
	if spender != "" {
		claimable = append(claimable, bson.D{{Key: "spendTxid", Value: spender}})
	}
	res, err := s.outputs.UpdateMany(ctx,
		bson.D{
			{Key: "topic", Value: topic},
			{Key: "$and", Value: bson.A{
				bson.D{{Key: "$or", Value: ors}},
				bson.D{{Key: "$or", Value: claimable}},
			}},
		},
		bson.D{{Key: "$set", Value: set}})
	if err != nil {
		return err
	}
	if res.MatchedCount == int64(len(outpoints)) {
		return nil
	}
	conflict := s.describeSpendConflict(ctx, topic, ors, spender)
	if spender != "" {
		if _, uerr := s.UnmarkSpentBySpendTxid(ctx, spender); uerr != nil {
			log.Printf("engine store: rolling back partial spend marks of %s failed (state may need manual repair): %v", spender, uerr)
		}
	}
	return fmt.Errorf("enginestore: refusing to mark inputs spent for %s: %s", spenderLabel(spender), conflict)
}

func spenderLabel(spender string) string {
	if spender == "" {
		return "an unnamed transaction"
	}
	return spender
}

// describeSpendConflict names the first already-spent outpoint and the
// transaction holding it, for the CAS failure message.
func (s *Store) describeSpendConflict(ctx context.Context, topic string, ors bson.A, spender string) string {
	filter := bson.D{
		{Key: "topic", Value: topic},
		{Key: "spent", Value: true},
		{Key: "$or", Value: ors},
	}
	if spender != "" {
		filter = append(filter, bson.E{Key: "spendTxid", Value: bson.D{{Key: "$ne", Value: spender}}})
	}
	var doc outputDoc
	if err := s.outputs.FindOne(ctx, filter).Decode(&doc); err != nil {
		if err == mongo.ErrNoDocuments {
			return "an input is no longer available on this topic"
		}
		return "conflict lookup failed: " + err.Error()
	}
	return fmt.Sprintf("input %s.%d is already spent by %s", doc.Txid, doc.OutputIndex, doc.SpendTxid)
}

// SpendStateOf reports the transaction that marked (topic, txid.vout) spent,
// or "" when the coin is live or no document exists for it at all. It backs
// the topic manager's FIX L conflicting-spend gate. Not part of
// engine.Storage.
func (s *Store) SpendStateOf(ctx context.Context, topic, txid string, vout uint32) (string, error) {
	var doc outputDoc
	err := s.outputs.FindOne(ctx,
		bson.D{
			{Key: "topic", Value: topic},
			{Key: "txid", Value: txid},
			{Key: "outputIndex", Value: vout},
		},
		options.FindOne().SetProjection(bson.D{
			{Key: "spent", Value: 1},
			{Key: "spendTxid", Value: 1},
		}),
	).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !doc.Spent {
		return "", nil
	}
	return doc.SpendTxid, nil
}

// AdmittedOutputIndexes lists, ascending, the output indexes this topic
// admitted for txid — spent ones included, because admission is history, not
// current liquidity. It is FIX C's fallback source of outputsToAdmit when the
// mandalaAdmissions row is missing but the engine's applied-transaction store
// still proves the transaction went through the topic. Not part of
// engine.Storage.
func (s *Store) AdmittedOutputIndexes(ctx context.Context, topic, txid string) ([]uint32, error) {
	cur, err := s.outputs.Find(ctx,
		bson.D{{Key: "topic", Value: topic}, {Key: "txid", Value: txid}},
		options.Find().SetProjection(bson.D{{Key: "outputIndex", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	out := []uint32{}
	for cur.Next(ctx) {
		var doc outputDoc
		if err := cur.Decode(&doc); err != nil {
			return nil, err
		}
		out = append(out, doc.OutputIndex)
	}
	if err := cur.Err(); err != nil {
		return nil, err
	}
	slices.Sort(out)
	return out, nil
}

// UnmarkSpentBySpendTxid reverses MarkUTXOsAsSpent for every output document
// whose spendTxid matches: spent flips back to false and spendTxid is
// cleared, across all topics. It is NOT part of engine.Storage — it exists
// because go-overlay-services v1.3.2's Submit marks inputs spent BEFORE
// broadcasting and never unwinds on broadcast failure; the HTTP layer calls
// this (via wiring's compensation closure) to restore the engine-side spend
// state. Returns the number of documents modified (0 when nothing matched —
// re-running the compensation is a harmless no-op).
func (s *Store) UnmarkSpentBySpendTxid(ctx context.Context, spendTxid string) (int64, error) {
	res, err := s.outputs.UpdateMany(ctx,
		bson.D{{Key: "spendTxid", Value: spendTxid}},
		bson.D{
			{Key: "$set", Value: bson.D{{Key: "spent", Value: false}}},
			{Key: "$unset", Value: bson.D{{Key: "spendTxid", Value: ""}}},
		})
	if err != nil {
		return 0, err
	}
	return res.ModifiedCount, nil
}

// FindOutputsByTxid lists the distinct outpoints of every stored output of
// txid, deduped across topics. Not part of engine.Storage — it feeds the
// terminal-status eviction path (wiring's EvictTx notifies OutputEvicted per
// outpoint before deleting).
func (s *Store) FindOutputsByTxid(ctx context.Context, txid string) ([]*transaction.Outpoint, error) {
	cur, err := s.outputs.Find(ctx, bson.D{{Key: "txid", Value: txid}},
		options.Find().SetProjection(bson.D{
			{Key: "txid", Value: 1},
			{Key: "outputIndex", Value: 1},
		}))
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	seen := make(map[uint32]bool)
	var ops []*transaction.Outpoint
	for cur.Next(ctx) {
		var doc outputDoc
		if err := cur.Decode(&doc); err != nil {
			return nil, err
		}
		if seen[doc.OutputIndex] {
			continue // same outpoint under another topic
		}
		seen[doc.OutputIndex] = true
		h, err := chainhash.NewHashFromHex(doc.Txid)
		if err != nil {
			return nil, fmt.Errorf("enginestore: bad stored txid %q: %w", doc.Txid, err)
		}
		ops = append(ops, &transaction.Outpoint{Txid: *h, Index: doc.OutputIndex})
	}
	return ops, cur.Err()
}

// DeleteOutputsByTxid removes every output document of txid across all
// topics (terminal-status eviction). Deleting an unknown txid is a no-op.
func (s *Store) DeleteOutputsByTxid(ctx context.Context, txid string) error {
	_, err := s.outputs.DeleteMany(ctx, bson.D{{Key: "txid", Value: txid}})
	return err
}

// RawTxHexByTxid reconstructs the raw transaction hex for txid from any
// stored output document that carries a BEEF containing it — the concrete
// method the /admin/activity route (Task 17) is built over. enginestore has
// no dedicated raw-tx collection (BEEF bytes live inline per output
// document, per the package doc comment); every admitted output shares the
// same submitted BEEF, so the first document found (any topic) is enough.
// Returns (_, false, nil) when no stored output carries this txid at all —
// not an error, mirroring FindOutput's nil-on-missing contract.
func (s *Store) RawTxHexByTxid(ctx context.Context, txid string) (string, bool, error) {
	h, err := chainhash.NewHashFromHex(txid)
	if err != nil {
		return "", false, fmt.Errorf("enginestore: bad txid %q: %w", txid, err)
	}
	var doc struct {
		Beef []byte `bson:"beef"`
	}
	err = s.outputs.FindOne(ctx,
		bson.D{
			{Key: "txid", Value: txid},
			{Key: "beef", Value: bson.D{{Key: "$exists", Value: true}}},
		},
		options.FindOne().SetProjection(bson.D{{Key: "beef", Value: 1}}),
	).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	beef, err := transaction.NewBeefFromBytes(doc.Beef)
	if err != nil {
		return "", false, fmt.Errorf("enginestore: stored BEEF for %s unparseable: %w", txid, err)
	}
	tx := beef.FindTransactionByHash(h)
	if tx == nil {
		return "", false, nil
	}
	return tx.Hex(), true, nil
}

// OutputBeefBytes returns the BEEF bytes stored for one (topic, txid, vout) —
// exactly what InsertOutputs recorded, spent or not — or (nil, false, nil)
// when the topic never admitted that outpoint. It backs the
// /admin/registry/beef and /admin/asset-auth/beef recovery routes (A10/A17),
// which hand a wallet the graph it needs to re-spend a chain head.
func (s *Store) OutputBeefBytes(ctx context.Context, topic, txid string, vout uint32) ([]byte, bool, error) {
	var doc struct {
		Beef []byte `bson:"beef"`
	}
	err := s.outputs.FindOne(ctx,
		bson.D{
			{Key: "topic", Value: topic},
			{Key: "txid", Value: txid},
			{Key: "outputIndex", Value: vout},
		},
		options.FindOne().SetProjection(bson.D{{Key: "beef", Value: 1}}),
	).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(doc.Beef) == 0 {
		return nil, false, nil
	}
	return doc.Beef, true, nil
}

// DeleteAppliedTransactionsByTxid removes the applied-transaction records of
// txid across all topics, so a later re-submit of the same tx is not treated
// as a duplicate (terminal-status eviction). Unknown txid is a no-op.
func (s *Store) DeleteAppliedTransactionsByTxid(ctx context.Context, txid string) error {
	_, err := s.applied.DeleteMany(ctx, bson.D{{Key: "txid", Value: txid}})
	return err
}

// UpdateConsumedBy replaces the consumedBy list wholesale — the engine
// always passes the complete new slice (append on retain, shrink on
// deleteUTXODeep).
func (s *Store) UpdateConsumedBy(ctx context.Context, outpoint *transaction.Outpoint, topic string, consumedBy []*transaction.Outpoint) error {
	docs := toOutpointDocs(consumedBy)
	if docs == nil {
		docs = []outpointDoc{}
	}
	_, err := s.outputs.UpdateOne(ctx, outpointFilter(topic, outpoint),
		bson.D{{Key: "$set", Value: bson.D{{Key: "consumedBy", Value: docs}}}})
	return err
}

// UpdateTransactionBEEF swaps in the re-proved BEEF for every output of the
// txid across topics (engine.updateMerkleProof), refreshing the stored
// merkle facts; block height/idx stay put because the engine follows up
// with UpdateOutputBlockHeight for the outputs it re-anchored.
func (s *Store) UpdateTransactionBEEF(ctx context.Context, txid *chainhash.Hash, beef *transaction.Beef) error {
	beefBytes, err := beef.Bytes()
	if err != nil {
		return fmt.Errorf("enginestore: serialize BEEF: %w", err)
	}
	root, state, _, _ := proofInfo(beef, txid)
	set := bson.D{
		{Key: "beef", Value: beefBytes},
		{Key: "merkleState", Value: uint8(state)},
	}
	if root != "" {
		set = append(set, bson.E{Key: "merkleRoot", Value: root})
	}
	update := bson.D{{Key: "$set", Value: set}}
	if root == "" {
		update = append(update, bson.E{Key: "$unset", Value: bson.D{{Key: "merkleRoot", Value: ""}}})
	}
	_, err = s.outputs.UpdateMany(ctx, bson.D{{Key: "txid", Value: txid.String()}}, update)
	return err
}

// UpdateOutputBlockHeight anchors one output after HandleNewMerkleProof.
func (s *Store) UpdateOutputBlockHeight(ctx context.Context, outpoint *transaction.Outpoint, topic string, blockHeight uint32, blockIndex uint64) error {
	_, err := s.outputs.UpdateOne(ctx, outpointFilter(topic, outpoint),
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "blockHeight", Value: blockHeight},
			{Key: "blockIdx", Value: blockIndex},
		}}})
	return err
}

// InsertAppliedTransaction records (topic, txid) once; a duplicate-key hit
// is success — the engine's submit pipeline may race its own
// DoesAppliedTransactionExist pre-check.
func (s *Store) InsertAppliedTransaction(ctx context.Context, tx *overlay.AppliedTransaction) error {
	_, err := s.applied.InsertOne(ctx, bson.D{
		{Key: "topic", Value: tx.Topic},
		{Key: "txid", Value: tx.Txid.String()},
	})
	if mongo.IsDuplicateKeyError(err) {
		return nil
	}
	return err
}

// DoesAppliedTransactionExist is Submit's per-topic dupe gate.
func (s *Store) DoesAppliedTransactionExist(ctx context.Context, tx *overlay.AppliedTransaction) (bool, error) {
	n, err := s.applied.CountDocuments(ctx, bson.D{
		{Key: "topic", Value: tx.Topic},
		{Key: "txid", Value: tx.Txid.String()},
	}, options.Count().SetLimit(1))
	return n > 0, err
}

// UpdateLastInteraction upserts the GASP sync high-water mark per
// (host, topic).
func (s *Store) UpdateLastInteraction(ctx context.Context, host, topic string, since float64) error {
	_, err := s.interactions.UpdateOne(ctx,
		bson.D{{Key: "host", Value: host}, {Key: "topic", Value: topic}},
		bson.D{{Key: "$set", Value: bson.D{{Key: "score", Value: since}}}},
		options.UpdateOne().SetUpsert(true))
	return err
}

// GetLastInteraction returns 0 when no record exists (interface contract).
func (s *Store) GetLastInteraction(ctx context.Context, host, topic string) (float64, error) {
	var doc struct {
		Score float64 `bson:"score"`
	}
	err := s.interactions.FindOne(ctx,
		bson.D{{Key: "host", Value: host}, {Key: "topic", Value: topic}}).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return doc.Score, nil
}

// FindOutpointsByMerkleState projects just the outpoints in a given state
// (SyncInvalidatedOutputs pages Invalidated ones, limit 1000).
func (s *Store) FindOutpointsByMerkleState(ctx context.Context, topic string, state engine.MerkleState, limit uint32) ([]*transaction.Outpoint, error) {
	opts := options.Find().SetProjection(bson.D{
		{Key: "txid", Value: 1},
		{Key: "outputIndex", Value: 1},
	})
	if limit > 0 {
		opts = opts.SetLimit(int64(limit))
	}
	cur, err := s.outputs.Find(ctx, bson.D{
		{Key: "topic", Value: topic},
		{Key: "merkleState", Value: uint8(state)},
	}, opts)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)
	var ops []*transaction.Outpoint
	for cur.Next(ctx) {
		var doc outputDoc
		if err := cur.Decode(&doc); err != nil {
			return nil, err
		}
		h, err := chainhash.NewHashFromHex(doc.Txid)
		if err != nil {
			return nil, fmt.Errorf("enginestore: bad stored txid %q: %w", doc.Txid, err)
		}
		ops = append(ops, &transaction.Outpoint{Txid: *h, Index: doc.OutputIndex})
	}
	return ops, cur.Err()
}

// ReconcileMerkleRoot applies the storage.go doc-comment contract to every
// output claiming the given block height: matching stored roots become
// Validated, non-matching (non-null) roots become Invalidated, null roots
// stay Unmined. Immutable promotion ("if old enough") is intentionally not
// implemented: storage has no current-chain-height source to age against —
// see the Task 12 report's judgment calls.
func (s *Store) ReconcileMerkleRoot(ctx context.Context, topic string, blockHeight uint32, merkleRoot *chainhash.Hash) error {
	rootHex := merkleRoot.String()
	base := bson.D{
		{Key: "topic", Value: topic},
		{Key: "blockHeight", Value: blockHeight},
	}
	if _, err := s.outputs.UpdateMany(ctx,
		append(base, bson.E{Key: "merkleRoot", Value: rootHex}),
		bson.D{{Key: "$set", Value: bson.D{{Key: "merkleState", Value: uint8(engine.MerkleStateValidated)}}}},
	); err != nil {
		return err
	}
	_, err := s.outputs.UpdateMany(ctx,
		append(base, bson.E{Key: "merkleRoot", Value: bson.D{
			{Key: "$exists", Value: true},
			{Key: "$nin", Value: bson.A{rootHex, ""}},
		}}),
		bson.D{{Key: "$set", Value: bson.D{{Key: "merkleState", Value: uint8(engine.MerkleStateInvalidated)}}}},
	)
	return err
}

// LoadAncillaryBeef merges the output's AncillaryTxids into output.Beef.
// Ancillary transactions that already ride inside the stored BEEF are
// no-ops; otherwise the tx is pulled from any engineOutputs document that
// carries it. A txid known nowhere is an error — the caller asked for the
// full BEEF and it cannot be assembled.
func (s *Store) LoadAncillaryBeef(ctx context.Context, output *engine.Output) error {
	if len(output.AncillaryTxids) == 0 {
		return nil
	}
	if output.Beef == nil {
		return fmt.Errorf("enginestore: LoadAncillaryBeef on output %s with nil Beef", output.Outpoint.String())
	}
	for _, txid := range output.AncillaryTxids {
		if output.Beef.FindTransactionByHash(txid) != nil {
			continue
		}
		var doc struct {
			Beef []byte `bson:"beef"`
		}
		err := s.outputs.FindOne(ctx,
			bson.D{
				{Key: "txid", Value: txid.String()},
				{Key: "beef", Value: bson.D{{Key: "$exists", Value: true}}},
			},
			options.FindOne().SetProjection(bson.D{{Key: "beef", Value: 1}}),
		).Decode(&doc)
		if err == mongo.ErrNoDocuments {
			return fmt.Errorf("enginestore: ancillary beef for %s: %w", txid.String(), engine.ErrNotFound)
		}
		if err != nil {
			return err
		}
		if err := output.Beef.MergeBeefBytes(doc.Beef); err != nil {
			return fmt.Errorf("enginestore: merge ancillary beef %s: %w", txid.String(), err)
		}
	}
	return nil
}

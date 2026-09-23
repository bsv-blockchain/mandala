// Package wiring assembles the mandala overlay engine: Mongo, the mandala
// domain store/verifier, tm_mandala + ls_mandala, the in-repo engine.Storage
// (enginestore) and the chain tracker/broadcaster seams Task 16 fills with
// Arcade implementations. No advertiser, no GASP sync config (GASP off).
package wiring

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/transaction/chaintracker"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/sirdeggen/mandala/overlay-go/internal/arcade"
	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// defaultChaintracksPrefix mirrors overlay/src/index.ts's
// `process.env.CHAINTRACKS_API_PREFIX ?? '/v2'`.
const defaultChaintracksPrefix = "/v2"

// tokenTopic is the topic σ_I speaks for — the one the FIX C applied proof
// and the FIX L spend guard are scoped to.
const tokenTopic = "tm_mandala"

// Config is the node configuration (mirrors the TS overlay's env surface —
// overlay/src/index.ts's ARCADE_URL/ARCADE_API_KEY/CHAINTRACKS_URL/
// CHAINTRACKS_API_PREFIX). ArcadeCallbackURL/ArcadeCallbackToken have no TS
// env-var counterpart in that file (it never calls configureArcCallbackToken
// and lets OverlayExpress derive callbackUrl from its own advertisable
// FQDN); leaving both empty here reproduces that no-token, no-callback-url
// default.
type Config struct {
	NodeName            string
	ServerPrivKeyHex    string
	HostingURL          string
	MongoURL            string
	Network             string
	ArcadeURL           string
	ArcadeAPIKey        string
	ArcadeCallbackURL   string
	ArcadeCallbackToken string
	ChaintracksURL      string
	ChaintracksPrefix   string

	// AdminAPIToken and AdminCORSOrigins are A13's server-side gate for the
	// identity-bearing admin routes (/admin/registry, /admin/activity,
	// /admin/admission/:txid). Read from ADMIN_API_TOKEN / ADMIN_CORS_ORIGINS
	// by cmd/overlay/main.go's loadConfig, which also resolves
	// AdminCORSOrigins's TS-parity default via
	// httpapi.ParseAdminCORSOrigins — done there, not in this package, so
	// this package (which httpapi imports) never has to import httpapi back.
	AdminAPIToken    string
	AdminCORSOrigins []string
}

// App is the wired application: the overlay engine plus the mandala domain
// handles the HTTP layer (Task 13) serves from.
type App struct {
	Engine *engine.Engine
	Store  *mandala.Store
	// EngineStore is the concrete engine.Storage behind Engine, exposed
	// because several seams (compensation, eviction, the FIX L spend guard,
	// the FIX C applied proof) need methods that are deliberately not part of
	// go-overlay-services' engine.Storage interface.
	EngineStore         *enginestore.Store
	Verifier            *mandala.Verifier
	Mongo               *mongo.Database
	ArcadeEnabled       bool
	ArcadeCallbackToken string

	// PrepareSubmitCompensation compensates for the pinned v1.3.2 engine's
	// submit ordering (inputs marked spent + mandala projections destroyed
	// BEFORE broadcast; a failed broadcast aborts without unwinding). The
	// submit handler calls it with the raw BEEF before Engine.Submit; the
	// returned closure — run only on a broadcast-classified Submit error —
	// unmarks the engine-side spends (UnmarkSpentBySpendTxid) and restores
	// the snapshotted mandala token rows/balances (RestoreTokens). The
	// snapshot is ALSO returned as a plain value so the submit handler can
	// persist it on the admission record, which is what makes a post-hoc
	// eviction (FIX E) restorable long after this request's closures are
	// gone. Set only when Arcade is enabled (without a broadcaster, broadcast
	// cannot fail, and without /arc-ingest nothing can be evicted).
	PrepareSubmitCompensation func(ctx context.Context, beef []byte) (func(context.Context) error, *mandala.RestoreSnapshot, error)

	// EvictTx implements the TS /arc-ingest route's
	// Engine.evictAppliedTransaction for terminal Arcade statuses. FIX E: it
	// is the exact inverse of admission — restore the inputs this txid
	// consumed (UnmarkSpentBySpendTxid + RestoreTokens from the admission
	// record's snapshot), stamp evictedAt so the ERR_EVICTED verdict is
	// permanent for these bytes, then notify ls_mandala's OutputEvicted per
	// output and delete the engine's output docs and applied-transaction
	// records. Set only when Arcade is enabled (the /arc-ingest route is only
	// mounted then, and only with a callback token).
	EvictTx func(ctx context.Context, txid string) (mandala.EvictionOutcome, error)

	// AppliedAdmissionProof is FIX C's durable proof seam: whether the
	// engine's own applied-transaction store says txid went through
	// tm_mandala, plus the output indexes it holds for it. It lets /submit
	// and GET /admin/admission/:txid re-sign an admission whose
	// mandalaAdmissions row is missing entirely. Always set.
	AppliedAdmissionProof func(ctx context.Context, txid string) (bool, []uint32, error)

	// FindRawTxs implements activity.Deps.FindRawTxs (Task 17, Appendix B
	// §3e): raw tx hex by txid, batched over the enginestore's per-output
	// BEEFs (enginestore.Store.RawTxHexByTxid — there is no dedicated raw-tx
	// collection). Always set; /admin/activity has no Arcade dependency.
	FindRawTxs func(ctx context.Context, txids []string) (map[string]string, error)

	// OutputBeef serves the BEEF the engine stored for one admitted output
	// (enginestore.Store.OutputBeefBytes) — the /admin/registry/beef and
	// /admin/asset-auth/beef recovery routes (A10/A17). Always set.
	OutputBeef func(ctx context.Context, topic, txid string, vout uint32) ([]byte, bool, error)

	// ServerPrivKeyHex is the overlay identity key; httpapi uses it to
	// attach σ_I on admitted submits.
	ServerPrivKeyHex string

	// AdminAPIToken and AdminCORSOrigins pass Config's A13 fields through to
	// httpapi.New, unmodified (see Config's doc comment for why resolution
	// lives in cmd/overlay/main.go rather than here).
	AdminAPIToken    string
	AdminCORSOrigins []string
}

// buildOptions carries the Task 16 injection seams.
type buildOptions struct {
	broadcaster transaction.Broadcaster
	tracker     chaintracker.ChainTracker
}

// Option customizes Build without changing its signature (Task 12 lands with
// nils; Task 16 injects the Arcade broadcaster and chaintracks tracker).
type Option func(*buildOptions)

// WithBroadcaster injects a transaction broadcaster (Task 16: Arcade,
// broadcast-before-fold, failure rejects the submit).
func WithBroadcaster(b transaction.Broadcaster) Option {
	return func(o *buildOptions) { o.broadcaster = b }
}

// WithChainTracker injects a chain tracker (Task 16: chaintracks client).
func WithChainTracker(ct chaintracker.ChainTracker) Option {
	return func(o *buildOptions) { o.tracker = ct }
}

// scriptsOnlyTracker is the permissive ChainTracker used when no Arcade is
// configured — the Go mirror of the TS engine's 'scripts only' mode: every
// merkle root is accepted, so SPV degrades to script checks.
type scriptsOnlyTracker struct{}

var _ chaintracker.ChainTracker = scriptsOnlyTracker{}

// IsValidRootForHeight always accepts.
func (scriptsOnlyTracker) IsValidRootForHeight(context.Context, *chainhash.Hash, uint32) (bool, error) {
	return true, nil
}

// CurrentHeight reports 0 — nothing in the engine consults it, and 'scripts
// only' mode has no chain view to answer from.
func (scriptsOnlyTracker) CurrentHeight(context.Context) (uint32, error) {
	return 0, nil
}

// Build connects Mongo (db ${NodeName}_lookup_services — same db handle for
// the mandala Store and the engine storage), wires tm_mandala/ls_mandala and
// returns the assembled App. With an empty ArcadeURL the chain tracker is
// scripts-only and the broadcaster nil. With a non-empty ArcadeURL, Build
// defaults the tracker/broadcaster to Arcade-backed implementations
// (overlay/src/index.ts's ARCADE_URL branch) unless opts already injected
// them — the WithBroadcaster/WithChainTracker seam exists so tests can
// substitute a stub instead of hitting a real Arcade deployment.
func Build(ctx context.Context, cfg Config, opts ...Option) (*App, error) {
	var o buildOptions
	for _, opt := range opts {
		opt(&o)
	}

	if cfg.ArcadeURL != "" {
		if o.broadcaster == nil {
			callbackURL := cfg.ArcadeCallbackURL
			if callbackURL == "" && cfg.HostingURL != "" {
				callbackURL = strings.TrimRight(cfg.HostingURL, "/") + "/arc-ingest"
			}
			o.broadcaster = arcade.NewBroadcaster(cfg.ArcadeURL, cfg.ArcadeAPIKey, callbackURL, cfg.ArcadeCallbackToken, nil)
		}
		if o.tracker == nil {
			chaintracksURL := cfg.ChaintracksURL
			if chaintracksURL == "" {
				chaintracksURL = strings.TrimRight(cfg.ArcadeURL, "/") + "/chaintracks"
			}
			prefix := cfg.ChaintracksPrefix
			if prefix == "" {
				prefix = defaultChaintracksPrefix
			}
			o.tracker = arcade.NewChaintracks(chaintracksURL, prefix, nil)
		}
	}

	client, err := mongo.Connect(options.Client().ApplyURI(cfg.MongoURL))
	if err != nil {
		return nil, fmt.Errorf("wiring: mongo connect: %w", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("wiring: mongo ping: %w", err)
	}
	db := client.Database(cfg.NodeName + "_lookup_services")

	// Wire contract §9.9: index creation failures abort startup on both
	// engines — better a node that refuses to come up than one serving
	// confident answers without the uniqueness its invariants rest on.
	store, err := mandala.NewStore(db)
	if err != nil {
		_ = client.Disconnect(context.Background())
		return nil, err
	}
	verifier, err := mandala.NewVerifier(cfg.ServerPrivKeyHex)
	if err != nil {
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("wiring: verifier: %w", err)
	}
	adminWallet, err := mandala.NewAdminWallet(cfg.ServerPrivKeyHex)
	if err != nil {
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("wiring: admin wallet: %w", err)
	}

	// Membership (A04): once the registry has a row, non-admitted identities
	// are refused — except asset issuers (store.IssuerIdentityKeys) and this
	// overlay's own identity, exactly as the TS registryScreening exemptions.
	overlayPriv, err := ec.PrivateKeyFromHex(cfg.ServerPrivKeyHex)
	if err != nil {
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("wiring: overlay identity: %w", err)
	}
	es, err := enginestore.New(db)
	if err != nil {
		_ = client.Disconnect(context.Background())
		return nil, err
	}
	tm := mandala.NewTopicManager(verifier, adminWallet, mandala.NoSanctions{}, store).
		WithRegistry(store).
		WithSpendChecker(spendChecker(es, store)).
		WithMembershipExemptions(overlayPriv.PubKey().ToDERHex())
	ls := mandala.NewLookupService(verifier, store)
	regWallet, err := mandala.NewRegistryWallet(cfg.ServerPrivKeyHex)
	if err != nil {
		_ = client.Disconnect(context.Background())
		return nil, fmt.Errorf("wiring: registry wallet: %w", err)
	}
	rtm := mandala.NewRegistryTopicManager(regWallet, store)
	rls := mandala.NewRegistryLookupService(store)

	tracker := o.tracker
	if tracker == nil {
		tracker = scriptsOnlyTracker{}
	}

	eng := engine.NewEngine(&engine.Config{
		Managers: map[string]engine.TopicManager{
			"tm_mandala":          tm,
			mandala.RegistryTopic: rtm,
		},
		LookupServices: map[string]engine.LookupService{
			"ls_mandala":           ls,
			mandala.RegistryLookup: rls,
		},
		Storage:      es,
		ChainTracker: tracker,
		Broadcaster:  o.broadcaster,
		HostingURL:   cfg.HostingURL,
	})

	app := &App{
		Engine:                eng,
		Store:                 store,
		EngineStore:           es,
		Verifier:              verifier,
		Mongo:                 db,
		ArcadeEnabled:         cfg.ArcadeURL != "",
		ArcadeCallbackToken:   cfg.ArcadeCallbackToken,
		FindRawTxs:            findRawTxs(es),
		OutputBeef:            es.OutputBeefBytes,
		AppliedAdmissionProof: appliedAdmissionProof(es),
		ServerPrivKeyHex:      cfg.ServerPrivKeyHex,
		AdminAPIToken:         cfg.AdminAPIToken,
		AdminCORSOrigins:      cfg.AdminCORSOrigins,
	}
	if app.ArcadeEnabled {
		app.PrepareSubmitCompensation = prepareSubmitCompensation(store, es)
		app.EvictTx = evictTx(es, ls, store)
	}
	return app, nil
}

// findRawTxs adapts enginestore.Store.RawTxHexByTxid (single txid in, single
// raw hex out — the method Task 17 added) into activity.Deps.FindRawTxs's
// batch shape (many txids in, a txid->hex map out). This is the same
// "for each txid, load its BEEF" loop the TS route's Mongo-backed
// findRawTransactions(txids) query condenses into one round trip; here it's
// one RawTxHexByTxid call per txid instead, since enginestore keeps BEEF
// bytes on individual output documents rather than in a dedicated
// raw-tx-by-txid collection. Missing txids are simply absent from the map.
func findRawTxs(es *enginestore.Store) func(context.Context, []string) (map[string]string, error) {
	return func(ctx context.Context, txids []string) (map[string]string, error) {
		out := make(map[string]string, len(txids))
		for _, txid := range txids {
			hexStr, ok, err := es.RawTxHexByTxid(ctx, txid)
			if err != nil {
				return nil, fmt.Errorf("wiring: raw tx %s: %w", txid, err)
			}
			if ok {
				out[txid] = hexStr
			}
		}
		return out, nil
	}
}

// prepareSubmitCompensation builds the App.PrepareSubmitCompensation closure
// over the mandala store (token-row snapshot/restore) and the concrete
// engine store (spend unmarking) — the two projections the pinned engine
// mutates before a broadcast can fail (see App.PrepareSubmitCompensation).
func prepareSubmitCompensation(store *mandala.Store, es *enginestore.Store) func(context.Context, []byte) (func(context.Context) error, *mandala.RestoreSnapshot, error) {
	return func(ctx context.Context, beefBytes []byte) (func(context.Context) error, *mandala.RestoreSnapshot, error) {
		_, tx, txid, err := transaction.ParseBeef(beefBytes)
		if err != nil || tx == nil {
			// Engine.Submit parses the same bytes first thing and will
			// reject them before markSpentAndNotify runs — nothing will be
			// mutated, so there is nothing to compensate.
			return nil, nil, nil
		}
		outpoints := make([]mandala.Outpoint, 0, len(tx.Inputs))
		spentOutpoints := make([]string, 0, len(tx.Inputs))
		for _, in := range tx.Inputs {
			if in.SourceTXID == nil {
				continue
			}
			outpoints = append(outpoints, mandala.Outpoint{Txid: in.SourceTXID.String(), OutputIndex: in.SourceTxOutIndex})
			spentOutpoints = append(spentOutpoints, fmt.Sprintf("%s.%d", in.SourceTXID.String(), in.SourceTxOutIndex))
		}
		snapshot, err := store.SnapshotTokens(ctx, outpoints)
		if err != nil {
			return nil, nil, fmt.Errorf("wiring: snapshot token rows for %s: %w", txid.String(), err)
		}
		// The very same snapshot, handed back as a plain value so the submit
		// handler can persist it on the admission record (FIX E): the
		// closure below dies with this request, the record does not.
		restore := &mandala.RestoreSnapshot{SpentOutpoints: spentOutpoints, TokenRows: snapshot}
		spendTxid := txid.String()
		return func(ctx context.Context) error {
			// A duplicate resubmit of an already-committed tx can reach this
			// closure too: go-overlay-services v1.3.2's per-topic dupe gate
			// lets a resubmit past validation, and a broadcast failure on
			// THAT attempt is classified the same as a genuine one. But a
			// genuine broadcast failure can never have an applied-transaction
			// record for this txid — commitAdmittedOutputs (which writes it)
			// only runs after a successful broadcast. If the record exists,
			// the original submit already committed: unmarking the spend and
			// restoring the snapshotted token rows here would corrupt that
			// committed state (resurrecting rows the original commit
			// correctly deleted, flipping its retained input back to
			// unspent). Skip compensation entirely in that case.
			committed, err := es.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{
				Txid:  txid,
				Topic: "tm_mandala",
			})
			if err != nil {
				return fmt.Errorf("wiring: check applied-transaction record for %s: %w", spendTxid, err)
			}
			if committed {
				log.Printf("wiring: skipping compensation: tx already committed (duplicate resubmit): %s", spendTxid)
				return nil
			}
			if _, err := es.UnmarkSpentBySpendTxid(ctx, spendTxid); err != nil {
				return fmt.Errorf("wiring: unmark spends of %s: %w", spendTxid, err)
			}
			if err := store.RestoreTokens(ctx, snapshot); err != nil {
				return fmt.Errorf("wiring: restore token rows spent by %s: %w", spendTxid, err)
			}
			return nil
		}, restore, nil
	}
}

// appliedAdmissionProof builds App.AppliedAdmissionProof (FIX C): the
// engine's own applied-transaction record for tm_mandala is the durable
// proof that a transaction was admitted, independent of whether the
// mandalaAdmissions row survives, and the stored outputs for that txid are
// the durable proof of WHICH outputs it admitted. Together they let a
// resubmit (or GET /admin/admission/:txid) re-sign an admission with no
// record row at all.
func appliedAdmissionProof(es *enginestore.Store) func(context.Context, string) (bool, []uint32, error) {
	return func(ctx context.Context, txid string) (bool, []uint32, error) {
		h, err := chainhash.NewHashFromHex(txid)
		if err != nil {
			// Not a txid at all: nothing can have been applied under it.
			return false, nil, nil
		}
		applied, err := es.DoesAppliedTransactionExist(ctx, &overlay.AppliedTransaction{Txid: h, Topic: tokenTopic})
		if err != nil {
			return false, nil, fmt.Errorf("wiring: applied-transaction record for %s: %w", txid, err)
		}
		if !applied {
			return false, nil, nil
		}
		outputs, err := es.AdmittedOutputIndexes(ctx, tokenTopic, txid)
		if err != nil {
			return false, nil, fmt.Errorf("wiring: admitted outputs of %s: %w", txid, err)
		}
		return true, outputs, nil
	}
}

// spendChecker builds the FIX L conflicting-spend guard the topic manager
// consults: the engine store says which transaction marked a coin spent, and
// the admission record says whether that transaction was later evicted — in
// which case its spend was undone and the coin counts as live again (wire
// contract §7), so a client racing the restore is never told a live coin is
// gone.
func spendChecker(es *enginestore.Store, store *mandala.Store) mandala.SpendChecker {
	return spendCheckerFunc(func(ctx context.Context, txid string, vout uint32) (string, error) {
		spendTxid, err := es.SpendStateOf(ctx, tokenTopic, txid, vout)
		if err != nil {
			return "", fmt.Errorf("wiring: spend state of %s.%d: %w", txid, vout, err)
		}
		if spendTxid == "" {
			return "", nil
		}
		rec, err := store.GetAdmission(ctx, spendTxid)
		if err != nil {
			return "", fmt.Errorf("wiring: admission record of %s: %w", spendTxid, err)
		}
		if rec != nil && rec.EvictedAt != "" {
			return "", nil
		}
		return spendTxid, nil
	})
}

// spendCheckerFunc adapts a plain func to mandala.SpendChecker.
type spendCheckerFunc func(ctx context.Context, txid string, vout uint32) (string, error)

func (f spendCheckerFunc) SpentBy(ctx context.Context, txid string, vout uint32) (string, error) {
	return f(ctx, txid, vout)
}

// evictTx builds the App.EvictTx closure: the Go equivalent of the TS
// Engine.evictAppliedTransaction, assembled from the concrete stores because
// the pinned engine exposes no eviction API.
//
// FIX E — eviction is the exact inverse of admission for INPUTS, not just a
// deletion of outputs. Before this, an /arc-ingest terminal status (Arcade
// rejects a previously-admitted transaction after the fact — fee/policy
// rejection, reorg) deleted the transaction's outputs and left its inputs
// marked spent with no token row and no path back, stranding coins that are
// provably unspent on chain. The order is deliberate:
//
//  1. restore the inputs (unmark the engine-side spends, re-insert the
//     snapshotted mandala token rows and re-credit balances) — do this FIRST,
//     so a crash anywhere later leaves coins live rather than stranded;
//  2. stamp evictedAt, which makes ERR_EVICTED permanent for these bytes and
//     simultaneously tells the FIX L spend guard that the restored coins are
//     live again;
//  3. notify OutputEvicted and delete the outputs and applied-transaction
//     records, exactly as before.
//
// A missing admission record (an admission predating this feature) is not an
// error: the engine-side unmark still runs and the eviction is still stamped;
// only the token-row restore has nothing to replay.
// The reported outcome (wire contract §9.12) counts what was actually handed
// back, so /arc-ingest's 200 body distinguishes a real unwind from the
// idempotent repeat Arcade is entitled to send.
func evictTx(es *enginestore.Store, ls *mandala.LookupService, store *mandala.Store) func(context.Context, string) (mandala.EvictionOutcome, error) {
	return func(ctx context.Context, txid string) (mandala.EvictionOutcome, error) {
		var out mandala.EvictionOutcome
		rec, err := store.GetAdmission(ctx, txid)
		if err != nil {
			return out, fmt.Errorf("wiring: admission record of %s: %w", txid, err)
		}
		out.AlreadyEvicted = rec != nil && rec.EvictedAt != ""

		// §9.8 — the restore comes FIRST and evictedAt is stamped only once it
		// has succeeded. Any failure below returns before the stamp, so the
		// callback answers 503, Arcade retries, and the transaction is never
		// left marked evicted with its inputs still gone.
		unmarked, err := es.UnmarkSpentBySpendTxid(ctx, txid)
		if err != nil {
			return out, fmt.Errorf("wiring: unmark spends of %s: %w", txid, err)
		}
		out.RestoredOutpoints = int(unmarked)
		if rec != nil && rec.Restore != nil {
			if err := store.RestoreTokens(ctx, rec.Restore.TokenRows); err != nil {
				return out, fmt.Errorf("wiring: restore token rows spent by %s: %w", txid, err)
			}
			out.RestoredTokenRows = len(rec.Restore.TokenRows)
		} else {
			log.Printf("wiring: evicting %s with no restore snapshot on record — engine-side spends unmarked, token rows cannot be replayed", txid)
		}
		if err := store.MarkEvicted(ctx, txid); err != nil {
			return out, fmt.Errorf("wiring: stamp eviction of %s: %w", txid, err)
		}

		outpoints, err := es.FindOutputsByTxid(ctx, txid)
		if err != nil {
			return out, fmt.Errorf("wiring: find outputs of %s: %w", txid, err)
		}
		for _, op := range outpoints {
			if err := ls.OutputEvicted(ctx, op); err != nil {
				return out, fmt.Errorf("wiring: notify eviction of %s: %w", op.String(), err)
			}
		}
		if err := es.DeleteOutputsByTxid(ctx, txid); err != nil {
			return out, fmt.Errorf("wiring: delete outputs of %s: %w", txid, err)
		}
		if err := es.DeleteAppliedTransactionsByTxid(ctx, txid); err != nil {
			return out, fmt.Errorf("wiring: delete applied tx records of %s: %w", txid, err)
		}
		// The evicted tx's admin actions never happened: drop its history
		// rows (what PickAssetAuthHead and the state rebuild read) and refold
		// each touched asset. Runs on a repeat callback too — deliberately
		// not gated on AlreadyEvicted — so a head stuck behind an eviction
		// stamped before this purge existed is repaired by re-delivering the
		// terminal status (2026-09-21 incident).
		assets, err := store.DeleteAdminHistoryByTxid(ctx, txid)
		if err != nil {
			return out, fmt.Errorf("wiring: purge admin history of %s: %w", txid, err)
		}
		for _, assetID := range assets {
			if _, err := ls.RebuildState(ctx, assetID); err != nil {
				return out, fmt.Errorf("wiring: rebuild asset state %s after evicting %s: %w", assetID, txid, err)
			}
		}
		return out, nil
	}
}

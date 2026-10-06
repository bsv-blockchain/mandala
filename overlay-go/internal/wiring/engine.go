// Package wiring assembles the Mandala overlay on BRC-162 with token topics on one overlay: Mongo, the v3 mandala
// store and verifier, the static registry (tm_mandala / ls_mandala) and KYC (tm_mandala_kyc / ls_mandala_kyc) topics,
// the TokenTopics registrar that alone creates tm_<id> / ls_<id>, the in-repo engine.Storage (enginestore), the two
// maintenance gates and the host seams /submit and /arc-ingest use. The overlay neither syncs with peers nor
// advertises (token-topics design §14 A1.1).
package wiring

import (
	"context"
	"fmt"
	"strings"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/transaction"
	"github.com/bsv-blockchain/go-sdk/transaction/chaintracker"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/sirdeggen/mandala/overlay-go/internal/arcade"
	"github.com/sirdeggen/mandala/overlay-go/internal/enginestore"
	"github.com/sirdeggen/mandala/overlay-go/internal/maintenance"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// defaultChaintracksPrefix mirrors overlay/src/index.ts's `process.env.CHAINTRACKS_API_PREFIX ?? '/v2'`.
const defaultChaintracksPrefix = "/v2"

// Config is the node configuration. cmd/overlay's loadConfig fills it from the environment; IssuerKeys come from
// ParseIssuerKeys, TokenAllowlist/TokenAllowlistSet from ParseTokenAllowlist, AdminCORSOrigins from
// httpapi.ParseAdminCORSOrigins (resolved there so this package never imports httpapi).
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
	AdminAPIToken       string
	AdminCORSOrigins    []string
	IssuerKeys          []string // parsed MANDALA_ISSUER_KEYS; Build fails on an empty set (manager constructor error)
	TokenAllowlist      []string // deploy txids; meaningful only when TokenAllowlistSet
	TokenAllowlistSet   bool
}

// App is the wired application: the engine, the Mandala stores, the registrar, the gates and the host seams httpapi
// serves from.
type App struct {
	Engine        *engine.Engine
	Store         *mandala.Store
	EngineStore   *enginestore.Store
	Verifier      *mandala.Verifier
	Mongo         *mongo.Database
	Tokens        *TokenTopics
	Registry      *mandala.TokenRegistryTopicManager
	Gate          *maintenance.Gate
	ReconcileLock *maintenance.Gate

	ArcadeEnabled       bool
	ArcadeCallbackToken string

	// PrepareSubmitCompensation snapshots a submit's inputs before Engine.Submit and returns the broadcast-failure
	// compensation (prepareSubmitCompensation). Always set: the snapshot is also what the admission record keeps for
	// a later eviction.
	PrepareSubmitCompensation func(ctx context.Context, beef []byte, topics []string) (compensate func(context.Context) error, restore *mandala.RestoreSnapshot, err error)
	// EvictTx is the /arc-ingest terminal-status eviction (evictTx). Always set.
	EvictTx func(ctx context.Context, txid string) (mandala.EvictionOutcome, error)
	// AppliedAdmissionProof maps every topic with an engine applied record for txid to its admitted vouts.
	AppliedAdmissionProof func(ctx context.Context, txid string) (map[string][]uint32, error)
	// FindRawTxs resolves raw tx hex by txid (activity, Task 24).
	FindRawTxs func(ctx context.Context, txids []string) (map[string]string, error)
	// OutputBeefWhere serves the stored BEEF of one output from the first topic accept() approves (recovery routes).
	OutputBeefWhere func(ctx context.Context, txid string, vout uint32, accept func(topic string) bool) (beef []byte, topic string, found bool, err error)

	ServerPrivKeyHex string
	AdminAPIToken    string
	AdminCORSOrigins []string
}

// buildOptions carries the injection seams.
type buildOptions struct {
	broadcaster transaction.Broadcaster
	tracker     chaintracker.ChainTracker
}

// Option customizes Build without changing its signature.
type Option func(*buildOptions)

// WithBroadcaster injects a transaction broadcaster.
func WithBroadcaster(b transaction.Broadcaster) Option {
	return func(o *buildOptions) { o.broadcaster = b }
}

// WithChainTracker injects a chain tracker.
func WithChainTracker(ct chaintracker.ChainTracker) Option {
	return func(o *buildOptions) { o.tracker = ct }
}

// scriptsOnlyTracker is the permissive ChainTracker used when no Arcade is configured — the Go mirror of the TS
// engine's 'scripts only' mode: every merkle root is accepted, so SPV degrades to script checks.
type scriptsOnlyTracker struct{}

var _ chaintracker.ChainTracker = scriptsOnlyTracker{}

// IsValidRootForHeight always accepts.
func (scriptsOnlyTracker) IsValidRootForHeight(context.Context, *chainhash.Hash, uint32) (bool, error) {
	return true, nil
}

// CurrentHeight reports 0 — nothing in the engine consults it.
func (scriptsOnlyTracker) CurrentHeight(context.Context) (uint32, error) {
	return 0, nil
}

// Build connects Mongo (db <NodeName>_lookup_services, shared by the Mandala store and the engine storage), wires the
// static topics and the token-topic registrar, and returns the App. Token topics are not registered here: Start runs
// the boot union, and /submit's deploy hook (Task 23) registers new deploys. With an empty ArcadeURL the chain tracker
// is scripts-only and the broadcaster nil; with one, Build defaults both to Arcade unless opts injected them.
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
	fail := func(err error) (*App, error) {
		_ = client.Disconnect(context.Background())
		return nil, err
	}
	db := client.Database(cfg.NodeName + "_lookup_services")

	// Index creation failures abort startup (mandala.NewStore and enginestore.New both create eagerly).
	store, err := mandala.NewStore(db)
	if err != nil {
		return fail(err)
	}
	verifier, err := mandala.NewVerifier(cfg.ServerPrivKeyHex)
	if err != nil {
		return fail(fmt.Errorf("wiring: verifier: %w", err))
	}
	overlayPriv, err := ec.PrivateKeyFromHex(cfg.ServerPrivKeyHex)
	if err != nil {
		return fail(fmt.Errorf("wiring: overlay identity: %w", err))
	}
	es, err := enginestore.New(db)
	if err != nil {
		return fail(err)
	}

	deps := mandala.TokenTopicDeps{
		Verifier:         verifier,
		TrustedIssuers:   cfg.IssuerKeys,
		MembershipExempt: []string{overlayPriv.PubKey().ToDERHex()},
		Store:            store,
		Engine:           es,
		Screening:        mandala.NoSanctions{},
		Membership:       mandala.KYCMembership{Store: store},
		Spends:           spendChecker(es, store),
	}
	registry, err := mandala.NewTokenRegistryTopicManager(deps)
	if err != nil {
		return fail(fmt.Errorf("wiring: %s: %w", mandala.MandalaTopic, err))
	}
	kyc, err := mandala.NewKYCTopicManager(mandala.KYCTopicDeps{
		Verifier:       verifier,
		TrustedIssuers: cfg.IssuerKeys,
		Store:          store,
		Engine:         es,
		Claims:         store,
	})
	if err != nil {
		return fail(fmt.Errorf("wiring: %s: %w", mandala.KYCTopic, err))
	}

	tracker := o.tracker
	if tracker == nil {
		tracker = scriptsOnlyTracker{}
	}
	eng := engine.NewEngine(&engine.Config{
		Managers: map[string]engine.TopicManager{
			mandala.MandalaTopic: registry,
			mandala.KYCTopic:     kyc,
		},
		LookupServices: map[string]engine.LookupService{
			mandala.MandalaLookup: mandala.NewTokenRegistryLookupService(verifier, store),
			mandala.KYCLookup:     mandala.NewKYCLookupService(store),
		},
		Storage:      es,
		ChainTracker: tracker,
		Broadcaster:  o.broadcaster,
		HostingURL:   cfg.HostingURL,
	})

	gate := maintenance.NewGate(maintenance.DefaultDrainTimeout)
	reconcileLock := maintenance.NewGate(maintenance.DefaultDrainTimeout)
	app := &App{
		Engine:                    eng,
		Store:                     store,
		EngineStore:               es,
		Verifier:                  verifier,
		Mongo:                     db,
		Tokens:                    NewTokenTopics(eng, cfg.TokenAllowlist, cfg.TokenAllowlistSet, tokenTopicFactory(deps, verifier, store)),
		Registry:                  registry,
		Gate:                      gate,
		ReconcileLock:             reconcileLock,
		ArcadeEnabled:             cfg.ArcadeURL != "",
		ArcadeCallbackToken:       cfg.ArcadeCallbackToken,
		PrepareSubmitCompensation: prepareSubmitCompensation(es, store),
		EvictTx:                   evictTx(evictDeps{es: es, store: store, quiesce: maintenance.ReconcileThenSubmit(reconcileLock, gate)}),
		AppliedAdmissionProof:     appliedAdmissionProof(es),
		FindRawTxs:                findRawTxs(es),
		OutputBeefWhere:           es.OutputBeefWhere,
		ServerPrivKeyHex:          cfg.ServerPrivKeyHex,
		AdminAPIToken:             cfg.AdminAPIToken,
		AdminCORSOrigins:          cfg.AdminCORSOrigins,
	}
	return app, nil
}

// Start runs the boot union (TT §6.2.1): it registers every token in the union of the registry records and the token
// topics of the owner journal (allowlist permitting), before the overlay listens. Any read or registration fault fails
// boot rather than serving unknown-topic for every token. It then runs the registry's boot repair (Q2
// restoreMissingRecords, D-21), so a hosted token whose ls_mandala record write was lost is back on GET /admin/tokens
// before submissions start; its fault fails boot too.
func (a *App) Start(ctx context.Context) error {
	if _, err := a.Tokens.Boot(ctx, a.Store.AllRegistryTokenIDs, journalTokenIDs(a.Store)); err != nil {
		return fmt.Errorf("wiring: start: %w", err)
	}
	if _, err := mandala.NewTokenRegistryLookupService(a.Verifier, a.Store).RestoreMissingRecords(ctx); err != nil {
		return fmt.Errorf("wiring: start: restore registry records: %w", err)
	}
	return nil
}

// Close stops the App's background work. It never disconnects Mongo; the caller owns the client.
func (a *App) Close() {}

// tokenTopicFactory builds one token's manager and lookup on the shared store with the shared deps (one spend checker,
// one trusted set, one membership provider for every token topic).
func tokenTopicFactory(deps mandala.TokenTopicDeps, v *mandala.Verifier, store *mandala.Store) TokenTopicFactory {
	return func(tokenID string) (engine.TopicManager, engine.LookupService, error) {
		tm, err := mandala.NewTokenTopicManager(tokenID, deps)
		if err != nil {
			return nil, nil, err
		}
		ls, err := mandala.NewTokenLookupService(tokenID, v, store)
		if err != nil {
			return nil, nil, err
		}
		return tm, ls, nil
	}
}

// findRawTxs adapts enginestore.Store.RawTxHexByTxid to the batch shape activity uses; missing txids are absent.
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

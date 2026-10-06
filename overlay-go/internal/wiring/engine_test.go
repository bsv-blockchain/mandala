package wiring

// Build-level tests for the v3 wiring, plus the helpers every Build-based wiring test shares (seams, boot, eviction
// in Task 21, owner index in Task 22). Every Build-based test runs on a fresh <NodeName>_lookup_services database
// (testmongo drops it before and after) and SKIPs when Mongo is down, so gates must count zero "--- SKIP" lines.

import (
	"context"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/chainhash"
	"github.com/bsv-blockchain/go-sdk/overlay"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/arcade"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

// v3Config is the Config every Build-based wiring test starts from: the kit's overlay key as SERVER_PRIVATE_KEY
// (the verifier every kit linkage is revealed to), the kit's issuer as the only trusted issuer, no Arcade.
func v3Config(nodeName string) Config {
	return Config{
		NodeName:         nodeName,
		ServerPrivKeyHex: mandalatest.Overlay.PrivHex(),
		HostingURL:       "http://localhost:8080",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
		IssuerKeys:       []string{mandalatest.Issuer.Identity},
	}
}

// buildV3App gives the test a fresh <NodeName>_lookup_services (testmongo.DB skips when Mongo is unreachable,
// drops the db now and again in cleanup) and Builds on it.
func buildV3App(t *testing.T, cfg Config, opts ...Option) *App {
	t.Helper()
	testmongo.DB(t, cfg.NodeName+"_lookup_services")
	return rebuildV3App(t, cfg, opts...)
}

// rebuildV3App Builds on whatever the database already holds (a restart); cleanup closes the App and its client. Call it
// only after buildV3App (or testmongo.DB) has arranged the skip and the drop for the same NodeName.
func rebuildV3App(t *testing.T, cfg Config, opts ...Option) *App {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, err := Build(ctx, cfg, opts...)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	t.Cleanup(func() {
		app.Close()
		_ = app.Mongo.Client().Disconnect(context.Background())
	})
	return app
}

// submitBuilt submits a kit transaction straight to the engine, threading the envelope exactly as /submit does: on ctx
// for the managers and on the TaggedBEEF for the lookups.
func submitBuilt(t *testing.T, app *App, b *mandalatest.Built, topics ...string) (overlay.Steak, error) {
	t.Helper()
	ctx := mandala.WithOffChainValues(context.Background(), b.OffChain)
	return app.Engine.Submit(ctx, overlay.TaggedBEEF{Beef: b.Beef, Topics: topics, OffChainValues: b.OffChain}, engine.SubmitModeCurrent, nil)
}

func mustSubmitBuilt(t *testing.T, app *App, b *mandalatest.Built, topics ...string) overlay.Steak {
	t.Helper()
	steak, err := submitBuilt(t, app, b, topics...)
	if err != nil {
		t.Fatalf("Submit %s to %v: %v", b.Txid, topics, err)
	}
	return steak
}

// tokenTopicOf is tm_<deploy txid>.
func tokenTopicOf(t *testing.T, deploy *mandalatest.Built) string {
	t.Helper()
	topic, err := mandala.TokenTopic(deploy.Txid + "_0")
	if err != nil {
		t.Fatal(err)
	}
	return topic
}

// deployToken registers the deploy's token topic through the registrar (as Task 23's deploy hook will) and submits
// the deploy to tm_mandala and tm_<txid>.
func deployToken(t *testing.T, app *App, sym string) *mandalatest.Built {
	t.Helper()
	dep := mandalatest.Deploy(t, mandalatest.Issuer, sym)
	if ok, err := app.Tokens.Ensure(dep.Txid + "_0"); err != nil || !ok {
		t.Fatalf("Ensure(%s_0) = %v, %v", dep.Txid, ok, err)
	}
	mustSubmitBuilt(t, app, dep, mandala.MandalaTopic, tokenTopicOf(t, dep))
	return dep
}

func sortedMetaKeys(m map[string]*overlay.MetaData) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// A1.1: one overlay. Build registers exactly the two static topics and lookups (token topics come only from the
// registrar) and configures no sync or advertising on the engine.
func TestBuildRegistersOnlyTheStaticTopicsAndNoSync(t *testing.T) {
	app := buildV3App(t, v3Config("mandala3_test_wiring_build"))

	if got, want := sortedMetaKeys(app.Engine.ListTopicManagers()), []string{mandala.MandalaTopic, mandala.KYCTopic}; !reflect.DeepEqual(got, want) {
		t.Fatalf("topic managers = %v, want %v", got, want)
	}
	if got, want := sortedMetaKeys(app.Engine.ListLookupServiceProviders()), []string{mandala.MandalaLookup, mandala.KYCLookup}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lookup services = %v, want %v", got, want)
	}
	if app.Engine.Advertiser != nil {
		t.Fatalf("Advertiser = %T, want nil (A1.1)", app.Engine.Advertiser)
	}
	if len(app.Engine.SyncConfiguration) != 0 || len(app.Engine.SHIPTrackers) != 0 || len(app.Engine.SLAPTrackers) != 0 {
		t.Fatalf("sync config %v, SHIP %v, SLAP %v: want all empty (A1.1)", app.Engine.SyncConfiguration, app.Engine.SHIPTrackers, app.Engine.SLAPTrackers)
	}
	if app.Store == nil || app.EngineStore == nil || app.Verifier == nil || app.Tokens == nil || app.Registry == nil {
		t.Fatalf("incomplete App: %+v", app)
	}
	if app.Gate == nil || app.ReconcileLock == nil || app.Gate == app.ReconcileLock {
		t.Fatal("Build must create two distinct gates (submit gate, reconcile lock)")
	}
	if app.PrepareSubmitCompensation == nil || app.AppliedAdmissionProof == nil || app.FindRawTxs == nil || app.OutputBeefWhere == nil {
		t.Fatal("the always-set seams must be wired without Arcade")
	}
	if app.ArcadeEnabled {
		t.Fatal("ArcadeEnabled must be false without ARCADE_URL")
	}
	if app.Mongo.Name() != "mandala3_test_wiring_build_lookup_services" {
		t.Fatalf("db = %q", app.Mongo.Name())
	}
	if got := app.Tokens.Registered(); len(got) != 0 {
		t.Fatalf("Build registered tokens %v; only Start (boot union) and Ensure register token topics", got)
	}
}

// Build's first manager is the registry; its constructor refuses an empty trusted set with the TS string
// (F/ts-layers §0, owner = Go type name).
func TestBuildRefusesAnEmptyIssuerSet(t *testing.T) {
	testmongo.DB(t, "mandala3_test_wiring_noissuer_lookup_services")
	cfg := v3Config("mandala3_test_wiring_noissuer")
	cfg.IssuerKeys = nil
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, err := Build(ctx, cfg)
	if err == nil {
		_ = app.Mongo.Client().Disconnect(context.Background())
		t.Fatal("Build accepted an empty issuer set")
	}
	if want := "TokenRegistryTopicManager: trustedIssuers must be a non-empty array"; !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %v, want it to contain %q", err, want)
	}
}

// A1.1 at the source level: no wiring file sets or calls the engine's sync/advertising surface.
func TestWiringSourceNeverConfiguresSyncOrAdvertising(t *testing.T) {
	forbidden := map[string]bool{
		"Advertiser": true, "SyncConfiguration": true, "SHIPTrackers": true, "SLAPTrackers": true,
		"LookupResolver": true, "SyncAdvertisements": true, "StartGASPSync": true, "SyncInvalidatedOutputs": true,
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	checked := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.SelectorExpr:
				if forbidden[x.Sel.Name] {
					t.Errorf("%s: uses %s", fset.Position(x.Pos()), x.Sel.Name)
				}
			case *ast.KeyValueExpr:
				if id, ok := x.Key.(*ast.Ident); ok && forbidden[id.Name] {
					t.Errorf("%s: sets %s", fset.Position(x.Pos()), id.Name)
				}
			}
			return true
		})
	}
	if checked == 0 {
		t.Fatal("no non-test wiring sources found")
	}
}

// A non-empty ArcadeURL defaults the broadcaster and tracker to Arcade (no Arcade is contacted at construction).
func TestBuildWithArcadeURLDefaultsBroadcasterAndTracker(t *testing.T) {
	cfg := v3Config("mandala3_test_wiring_arcade")
	cfg.HostingURL = "https://overlay.example.com"
	cfg.ArcadeURL = "https://arcade.example.com"
	cfg.ArcadeAPIKey = "test-api-key"
	cfg.ArcadeCallbackToken = "test-callback-token"
	app := buildV3App(t, cfg)

	if !app.ArcadeEnabled {
		t.Fatal("ArcadeEnabled must be true when ArcadeURL is set")
	}
	if app.ArcadeCallbackToken != "test-callback-token" {
		t.Fatalf("ArcadeCallbackToken = %q, want test-callback-token", app.ArcadeCallbackToken)
	}
	if _, ok := app.Engine.Broadcaster.(*arcade.Broadcaster); !ok {
		t.Fatalf("Engine.Broadcaster = %T, want *arcade.Broadcaster", app.Engine.Broadcaster)
	}
	if _, ok := app.Engine.ChainTracker.(*arcade.Chaintracks); !ok {
		t.Fatalf("Engine.ChainTracker = %T, want *arcade.Chaintracks", app.Engine.ChainTracker)
	}
}

// WithChainTracker still wins over the ArcadeURL default.
func TestBuildWithArcadeURLHonorsOptionOverride(t *testing.T) {
	cfg := v3Config("mandala3_test_wiring_arcade_override")
	cfg.HostingURL = "https://overlay.example.com"
	cfg.ArcadeURL = "https://arcade.example.com"
	app := buildV3App(t, cfg, WithChainTracker(scriptsOnlyTracker{}))

	if _, ok := app.Engine.ChainTracker.(scriptsOnlyTracker); !ok {
		t.Fatalf("Engine.ChainTracker = %T, want the injected scriptsOnlyTracker override", app.Engine.ChainTracker)
	}
	if _, ok := app.Engine.Broadcaster.(*arcade.Broadcaster); !ok {
		t.Fatalf("Engine.Broadcaster = %T, want *arcade.Broadcaster", app.Engine.Broadcaster)
	}
}

func TestScriptsOnlyTracker(t *testing.T) {
	ctx := context.Background()
	tr := scriptsOnlyTracker{}
	ok, err := tr.IsValidRootForHeight(ctx, nil, 0)
	if err != nil || !ok {
		t.Fatalf("IsValidRootForHeight = %v, %v; want true, nil", ok, err)
	}
	if _, err := tr.CurrentHeight(ctx); err != nil {
		t.Fatal("CurrentHeight:", err)
	}
}

// wiringTestTx builds a minimal transaction: one input spending src:vout (or a dummy outpoint when src is nil) and
// n outputs.
func wiringTestTx(t *testing.T, src *transaction.Transaction, vout uint32, outputs int, fill byte) *transaction.Transaction {
	t.Helper()
	tx := transaction.NewTransaction()
	var srcID *chainhash.Hash
	if src != nil {
		srcID = src.TxID()
	} else {
		raw := make([]byte, 32)
		for i := range raw {
			raw[i] = fill
		}
		var err error
		if srcID, err = chainhash.NewHash(raw); err != nil {
			t.Fatal(err)
		}
	}
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID:       srcID,
		SourceTxOutIndex: vout,
		UnlockingScript:  &script.Script{},
	})
	for i := 0; i < outputs; i++ {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: uint64(i + 1), LockingScript: &script.Script{}})
	}
	return tx
}

// App.FindRawTxs resolves every stored txid to its raw hex and omits unknown ones.
func TestFindRawTxsBatchesOverEnginestore(t *testing.T) {
	app := buildV3App(t, v3Config("mandala3_test_wiring_rawtxs"))
	ctx := context.Background()

	const topic = "tm_mandala"
	tx1 := wiringTestTx(t, nil, 0, 1, 0x71)
	tx1id := tx1.TxID()
	tx2 := wiringTestTx(t, nil, 0, 1, 0x72)
	tx2id := tx2.TxID()

	beef1 := transaction.NewBeefV2()
	if _, err := beef1.MergeTransaction(tx1); err != nil {
		t.Fatal(err)
	}
	beef2 := transaction.NewBeefV2()
	if _, err := beef2.MergeTransaction(tx2); err != nil {
		t.Fatal(err)
	}

	st := app.Engine.Storage
	if err := st.InsertOutputs(ctx, topic, tx1id, []uint32{0}, nil, beef1, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.InsertOutputs(ctx, topic, tx2id, []uint32{0}, nil, beef2, nil); err != nil {
		t.Fatal(err)
	}

	missingID := wiringTestTx(t, nil, 0, 1, 0x73).TxID().String()
	got, err := app.FindRawTxs(ctx, []string{tx1id.String(), tx2id.String(), missingID})
	if err != nil {
		t.Fatal(err)
	}
	if got[tx1id.String()] != tx1.Hex() {
		t.Fatalf("tx1 hex = %q, want %q", got[tx1id.String()], tx1.Hex())
	}
	if got[tx2id.String()] != tx2.Hex() {
		t.Fatalf("tx2 hex = %q, want %q", got[tx2id.String()], tx2.Hex())
	}
	if _, ok := got[missingID]; ok {
		t.Fatalf("missing txid must be absent from the map, got %q", got[missingID])
	}
	if len(got) != 2 {
		t.Fatalf("len(got) = %d, want 2", len(got))
	}
}

// Command fuelkeeper is the Mandala fuel service (spec §4.2): an in-process
// go-wallet-toolbox storage server, the issuer wallet on it, the pool keeper,
// the sweeper and the overlay-facing HTTP API, in one process.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/infra"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/services"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/storage"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wallet/fuelkeeper"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wdk"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/auth"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/chain"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/draft"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/httpapi"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/settle"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/sweeper"
)

const (
	shutdownTimeout = 10 * time.Second
	overlayTimeout  = 10 * time.Second
)

func main() { os.Exit(run()) }

// run returns the process exit code: 0 clean shutdown, 1 runtime failure,
// 2 configuration error.
func run() int {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	// sigCtx ends on the first SIGINT/SIGTERM. ctx is the workers' root: it
	// is cancelled only after the API has drained (or on a fatal error).
	sigCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	fail := func(msg string, err error) int {
		if sigCtx.Err() != nil && errors.Is(err, context.Canceled) {
			logger.Info("shutdown requested during startup", "step", msg)
			return 0
		}
		logger.Error(msg, "err", err)
		return 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Startup steps give up on a signal as well as on a fatal error.
	startCtx, cancelStart := context.WithCancel(ctx)
	defer cancelStart()
	stopStartOnSignal := context.AfterFunc(sigCtx, cancelStart)
	defer stopStartOnSignal()

	// (1) Storage server (BRC-103/104) on the infra yaml's http.port.
	srv, err := infra.NewServer(ctx, infra.WithConfigFile(cfg.StorageConf), infra.WithEnvPrefix("FK_STORAGE"), infra.WithLogger(logger))
	if err != nil {
		return fail("storage server", err)
	}
	defer srv.Cleanup()
	scfg := srv.Config
	if err = checkStorageConfig(cfg, &scfg); err != nil {
		return fail("storage config does not match the keeper config", err)
	}
	if got, bad := storagePortMismatch(cfg.StorageURL, scfg.HTTPConfig.Port); bad {
		logger.Warn("FK_STORAGE_URL port differs from the storage server's http.port", "url_port", got, "server_port", scfg.HTTPConfig.Port)
	}
	go func() {
		if err := srv.ListenAndServe(ctx); err != nil {
			logger.Error("storage server stopped", "err", err)
			cancel()
		}
	}()

	// (2) Issuer wallet over loopback HTTP.
	priv, err := ec.PrivateKeyFromHex(cfg.IssuerRootKeyHex)
	if err != nil {
		return fail("ISSUER_ROOT_KEY", err)
	}
	kd := sdk.NewKeyDeriver(priv)
	w, err := connectWallet(startCtx, cfg, priv, logger)
	if err != nil {
		return fail("issuer wallet", err)
	}
	defer w.Close()

	// Read-only in-process provider on the same DB: the toolbox HTTP client's
	// FindOutputsAuth is a stub at v0.186.3. Never Migrate it (infra did).
	svcCfg, chainCheck := servicesConfig(cfg, scfg.Services)
	svc := services.New(logger, svcCfg)
	reader, err := storage.NewGORMProvider(scfg.BSVNetwork, svc, append(infra.GORMProviderOptionsFromConfig(&scfg), storage.WithLogger(logger))...)
	if err != nil {
		return fail("read-only storage provider", err)
	}
	defer reader.Stop()
	user, err := reader.FindOrInsertUser(startCtx, kd.IdentityKeyHex())
	if err != nil {
		return fail("storage user lookup", err)
	}
	userID := user.User.UserID
	src := fuel.NewWalletSource(w, reader, kd, userID, logger)
	if err = selfCheck(startCtx, w, src, reader, wdk.AuthID{IdentityKey: kd.IdentityKeyHex(), UserID: &userID}, cfg.PoolBasket, logger); err != nil {
		return fail("startup self-check", err)
	}

	// Reservation tables.
	st, err := store.Open(cfg.DBDriver, cfg.DBDSN, time.Now)
	if err != nil {
		return fail("reservation store", err)
	}
	defer func() { _ = st.Close() }()

	var checker chain.Checker = chain.Disabled{}
	if chainCheck {
		checker = chain.NewServicesChecker(svc)
	} else {
		logger.Warn("chain check disabled: set FK_WOC_API_KEY (and keep wallet_services.whats_on_chain enabled) for sweeper rule 2")
	}

	// (3) Pool keeper: validates its config eagerly.
	keeper, err := fuelkeeper.New(w, keeperConfig(cfg), logger)
	if err != nil {
		return fail("pool keeper", err)
	}

	verifier, err := auth.NewVerifier(time.Now)
	if err != nil {
		return fail("request verifier", err)
	}
	drafter := draft.New(cfg, st, src, verifier, time.Now).WithLogger(logger)
	settler := settle.New(st, src, time.Now)
	overlay := sweeper.NewHTTPOverlayClient(cfg.OverlayURL, cfg.OverlayAdminToken,
		&http.Client{Timeout: overlayTimeout}, sweeper.WithFuelKey(cfg.APIKey))
	sw := sweeper.New(st, src, checker, overlay, time.Now, logger, cfg.ReservingTTLSeconds)

	// (4) Mandala API.
	api := &http.Server{
		Addr: fmt.Sprintf(":%d", cfg.APIPort),
		Handler: httpapi.New(httpapi.Deps{
			APIKey:  cfg.APIKey,
			Drafter: drafter,
			Store:   st,
			Settler: settler,
			Source:  src,
			Cfg:     cfg,
			Logger:  logger,
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}

	if startCtx.Err() != nil {
		logger.Info("shutdown requested during startup")
		return exitCode(sigCtx, ctx)
	}
	stopStartOnSignal()

	// (3)+(5) Workers on the root ctx.
	var wg sync.WaitGroup
	wg.Go(func() { keeper.Run(ctx) })
	wg.Go(func() { sw.Run(ctx, time.Duration(cfg.SweeperIntervalSeconds)*time.Second) })
	serveErr := make(chan error, 1)
	go func() { serveErr <- api.ListenAndServe() }()

	chainState := "off"
	if chainCheck {
		chainState = "on"
	}
	logger.Info(fmt.Sprintf("fuelkeeper: network=%s api=:%d storage=%s db=%s assets=%d pool_target=%d chain_check=%s",
		cfg.Network, cfg.APIPort, cfg.StorageURL, cfg.DBDriver, len(cfg.AssetIDs), cfg.PoolTarget, chainState))

	code := 0
	select {
	case <-sigCtx.Done():
		stopSignals() // a second signal now kills the process
		logger.Info("shutdown signal received; draining the API")
	case err := <-serveErr:
		code = fail("api server", err)
	case <-ctx.Done():
		code = 1 // the storage server died; already logged
	}

	sctx, scancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer scancel()
	if err := api.Shutdown(sctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Warn("api shutdown", "err", err)
	}
	cancel()
	if !waitTimeout(&wg, shutdownTimeout) {
		logger.Warn("keeper/sweeper did not stop in time")
	}
	logger.Info("fuelkeeper stopped", "exit", code)
	return code
}

// exitCode is 0 for a signal-initiated stop and 1 for a fatal error.
func exitCode(sigCtx, ctx context.Context) int {
	if sigCtx.Err() != nil {
		return 0
	}
	if ctx.Err() != nil {
		return 1
	}
	return 0
}

// waitTimeout waits for wg up to d and reports whether it finished.
func waitTimeout(wg *sync.WaitGroup, d time.Duration) bool {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

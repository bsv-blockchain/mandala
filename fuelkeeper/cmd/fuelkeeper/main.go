// Command fuelkeeper is the Mandala fuel service (spec §4.2): an in-process
// go-wallet-toolbox storage server, the issuer wallet on it, the pool keeper,
// the sweeper and the overlay-facing HTTP API, in one process.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
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

	// sigCtx ends on the first SIGINT/SIGTERM; from then on the default
	// disposition is restored, so a second signal kills the process in any
	// phase. ctx is the workers' root: it is cancelled only after the API has
	// drained, or with a cause when the storage server dies.
	sigCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	context.AfterFunc(sigCtx, stopSignals)
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	fail := func(step string, err error) int {
		v := classifyStartup(sigCtx, ctx, err)
		switch v {
		case verdictSignal:
			logger.Info("shutdown requested during startup", "step", step)
		case verdictRootCause:
			logger.Error("startup aborted", "step", step, "cause", context.Cause(ctx), "err", err)
		default:
			logger.Error(step, "err", err)
		}
		return v.exitCode()
	}
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
			cancel(fmt.Errorf("storage server stopped: %w", err))
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
	if user.IsNew {
		// The wallet's Balance handshake already created this user on the
		// server's DB, so a fresh insert proves the reader points elsewhere.
		return fail("storage user lookup", fmt.Errorf("%w (user %d was just created for %s)", errReaderOtherDB, user.User.UserID, kd.IdentityKeyHex()))
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
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	if startCtx.Err() != nil {
		return fail("startup", startCtx.Err())
	}
	// Bind before any worker runs: a taken port fails the process cleanly.
	ln, err := net.Listen("tcp", api.Addr)
	if err != nil {
		return fail("api listen", err)
	}
	stopStartOnSignal()

	// (3)+(5) Workers on the root ctx.
	var wg sync.WaitGroup
	wg.Go(func() { keeper.Run(ctx) })
	wg.Go(func() { sw.Run(ctx, time.Duration(cfg.SweeperIntervalSeconds)*time.Second) })
	serveErr := make(chan error, 1)
	go func() { serveErr <- api.Serve(ln) }()

	chainState := "off"
	if chainCheck {
		chainState = "on"
	}
	logger.Info(fmt.Sprintf("fuelkeeper: network=%s api=:%d storage=%s db=%s assets=%d pool_target=%d chain_check=%s",
		cfg.Network, cfg.APIPort, cfg.StorageURL, cfg.DBDriver, len(cfg.AssetIDs), cfg.PoolTarget, chainState))

	code := 0
	select {
	case <-sigCtx.Done():
		logger.Info("shutdown signal received; draining the API")
	case err := <-serveErr:
		logger.Error("api server", "err", err)
		code = 1
	case <-ctx.Done():
		logger.Error("shutting down", "cause", context.Cause(ctx))
		code = 1
	}

	sctx, scancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer scancel()
	if err := api.Shutdown(sctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Warn("api shutdown", "err", err)
	}
	cancel(nil)
	if !waitTimeout(&wg, shutdownTimeout) {
		logger.Warn("keeper/sweeper did not stop in time")
	}
	logger.Info("fuelkeeper stopped", "exit", code)
	return code
}

// startupVerdict classifies a failed or interrupted startup step.
type startupVerdict int

const (
	verdictFailed    startupVerdict = iota // the step's own error: exit 1
	verdictSignal                          // SIGINT/SIGTERM interrupted startup: exit 0
	verdictRootCause                       // the root ctx died (storage server stopped): exit 1
)

// exitCode is the process exit code for the verdict.
func (v startupVerdict) exitCode() int {
	if v == verdictSignal {
		return 0
	}
	return 1
}

// classifyStartup decides how a startup step that returned err ends the
// process. A dead root ctx wins over a signal (its cause is the real
// failure); a signal wins only when err is nil or a cancellation.
func classifyStartup(sigCtx, ctx context.Context, err error) startupVerdict {
	switch {
	case ctx.Err() != nil:
		return verdictRootCause
	case sigCtx.Err() != nil && (err == nil || errors.Is(err, context.Canceled)):
		return verdictSignal
	default:
		return verdictFailed
	}
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

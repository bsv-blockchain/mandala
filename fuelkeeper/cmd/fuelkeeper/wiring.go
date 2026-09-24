package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/defs"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/infra"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/storage"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wallet/fuelkeeper"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wdk"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
)

// originator is the BRC-100 originator the process presents to its wallet.
const originator = "fuelkeeper"

// walletAttemptTimeout bounds one connectWallet attempt (build + Balance).
const walletAttemptTimeout = 30 * time.Second

// keeperConfig maps the process config onto the toolbox pool keeper. The
// chunk fee headroom follows fuelkeeper.FromThroughput: max(1000, 8*D).
func keeperConfig(c config.Config) fuelkeeper.Config {
	headroom := uint64(1000)
	if s := 8 * c.Denomination; s > headroom {
		headroom = s
	}
	return fuelkeeper.Config{
		Denomination:         c.Denomination,
		TargetPoolSize:       c.PoolTarget,
		LowWaterPercent:      c.LowWaterPercent,
		HighWaterPercent:     c.HighWaterPercent,
		FanoutOutputsPerTx:   c.FanoutOutputsPerTx,
		FanoutMaxTxsPerRound: c.FanoutMaxTxsPerRound,
		PoolBasket:           c.PoolBasket,
		ReserveBasket:        c.ReserveBasket,
		Interval:             time.Duration(c.KeeperIntervalSeconds) * time.Second,
		ChunkFeeHeadroom:     headroom,
		Originator:           originator,
	}
}

// retryWithBackoff calls fn until it succeeds, ctx is done, or window has
// elapsed since the first call. The pause starts at initial and doubles up to
// maxDelay; the last pause is trimmed so one final attempt lands at the end
// of the window. onRetry (optional) is told about every failed attempt that
// will be retried. The returned error wraps the last fn error.
func retryWithBackoff(ctx context.Context, window, initial, maxDelay time.Duration, fn func() error, onRetry func(n int, err error, sleep time.Duration)) error {
	if initial <= 0 {
		initial = 100 * time.Millisecond
	}
	if maxDelay < initial {
		maxDelay = initial
	}
	deadline := time.Now().Add(window)
	sleep := initial
	for n := 1; ; n++ {
		err := fn()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return fmt.Errorf("gave up after %d attempts: %w", n, errors.Join(ctx.Err(), err))
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return fmt.Errorf("gave up after %d attempts in %s: %w", n, window, err)
		}
		d := min(sleep, remaining)
		if onRetry != nil {
			onRetry(n, err, d)
		}
		t := time.NewTimer(d)
		select {
		case <-ctx.Done():
			t.Stop()
			return fmt.Errorf("gave up after %d attempts: %w", n, errors.Join(ctx.Err(), err))
		case <-t.C:
		}
		sleep = min(2*sleep, maxDelay)
	}
}

// connectWallet builds the issuer wallet over the loopback storage server
// and waits (up to 2 min) until a Balance round trip succeeds, i.e. the
// server listens and the BRC-103 handshake completes. Each attempt is capped
// at walletAttemptTimeout. AutoKnownTxids is off
// so basket listings carry full BEEF (fuel.ListProven needs each fuel tx's
// own BUMP; a txid-only entry makes the row unusable).
func connectWallet(ctx context.Context, cfg config.Config, priv *ec.PrivateKey, logger *slog.Logger) (*wallet.Wallet, error) {
	var w *wallet.Wallet
	err := retryWithBackoff(ctx, 2*time.Minute, 500*time.Millisecond, 10*time.Second, func() error {
		nw, err := wallet.NewWithStorageFactory(cfg.Network, priv,
			func(uw sdk.Interface) (wdk.WalletStorageProvider, func(), error) {
				return storage.NewClient(cfg.StorageURL, uw, storage.WithClientLogger(logger))
			},
			wallet.WithLogger(logger),
			wallet.WithAutoKnownTxids(false),
		)
		if err != nil {
			return err
		}
		// A hung handshake must not outlive the retry window.
		actx, acancel := context.WithTimeout(ctx, walletAttemptTimeout)
		defer acancel()
		if _, err = nw.Balance(actx); err != nil {
			nw.Close()
			return err
		}
		w = nw
		return nil
	}, func(n int, err error, sleep time.Duration) {
		logger.Warn("storage not ready", "attempt", n, "err", err, "retry_in", sleep.String())
	})
	if err != nil {
		return nil, fmt.Errorf("connect issuer wallet to %s: %w", cfg.StorageURL, err)
	}
	return w, nil
}

// checkStorageConfig fails fast on an infra yaml that cannot serve this
// keeper: the throughput strategy must be on (FanOutFuel and pool funding
// need it), and network, baskets, fan-out width and denomination must match
// the keeper's, or every fan-out is rejected by the server and the pool
// never fills. Metrics must be off: the keeper's read-only provider would
// register a second set of the same gauges in this process.
func checkStorageConfig(cfg config.Config, scfg *infra.Config) error {
	var errs []error
	if scfg.BSVNetwork != cfg.Network {
		errs = append(errs, fmt.Errorf("storage bsv_network %q != FK_NETWORK %q", scfg.BSVNetwork, cfg.Network))
	}
	if scfg.Observability.Metrics.Enabled {
		errs = append(errs, errors.New("storage observability.metrics.enabled must be false: the keeper's in-process read-only provider would register duplicate metric gauges"))
	}
	um := scfg.UTXOManagement
	if !um.Enabled() {
		errs = append(errs, fmt.Errorf("storage utxo_management.strategy is %q, want %q", um.Strategy, defs.StrategyThroughput))
		return errors.Join(errs...)
	}
	if um.Throughput.PoolBasket != cfg.PoolBasket {
		errs = append(errs, fmt.Errorf("storage utxo_management.throughput.pool_basket %q != FK_POOL_BASKET %q", um.Throughput.PoolBasket, cfg.PoolBasket))
	}
	if um.Throughput.ReserveBasket != cfg.ReserveBasket {
		errs = append(errs, fmt.Errorf("storage utxo_management.throughput.reserve_basket %q != FK_RESERVE_BASKET %q", um.Throughput.ReserveBasket, cfg.ReserveBasket))
	}
	// The server bounds leaf counts by, and sizes the minimum chunk from, its
	// own fanout_outputs_per_tx; the keeper sizes both from its own.
	if um.Throughput.FanoutOutputsPerTx != cfg.FanoutOutputsPerTx {
		errs = append(errs, fmt.Errorf("storage utxo_management.throughput.fanout_outputs_per_tx %d != FK_FANOUT_OUTPUTS_PER_TX %d", um.Throughput.FanoutOutputsPerTx, cfg.FanoutOutputsPerTx))
	}
	d, err := um.Throughput.Denomination(scfg.FeeModel, scfg.Commission)
	switch {
	case err != nil:
		errs = append(errs, fmt.Errorf("storage utxo_management.throughput denomination: %w", err))
	case d != cfg.Denomination:
		errs = append(errs, fmt.Errorf("storage resolved denomination %d != FUEL_D %d (set utxo_management.throughput.denomination_satoshis)", d, cfg.Denomination))
	}
	return errors.Join(errs...)
}

// storagePortMismatch reports a loopback FK_STORAGE_URL whose port differs
// from the storage server's http.port (the wallet would retry for 2 min and
// then give up). Unparseable or non-loopback URLs are not second-guessed.
func storagePortMismatch(storageURL string, port uint) (string, bool) {
	u, err := url.Parse(storageURL)
	if err != nil || u.Port() == "" {
		return "", false
	}
	switch u.Hostname() {
	case "127.0.0.1", "localhost", "::1":
	default:
		return "", false
	}
	if u.Port() == strconv.FormatUint(uint64(port), 10) {
		return "", false
	}
	return u.Port(), true
}

// chainCheckNetwork reports whether sweeper rule 2 may use the WhatsOnChain
// UTXO lookup on network. Only main and test have their own WhatsOnChain
// index: go-wallet-toolbox v0.186.3 sends ttn/tstn lookups to the public
// testnet endpoint, which has never seen their outputs and answers "script
// not found", i.e. (false, nil) — indistinguishable from "spent".
func chainCheckNetwork(n defs.BSVNetwork) bool {
	return n == defs.NetworkMainnet || n == defs.NetworkTestnet
}

// servicesConfig derives the toolbox services config for the read-only
// provider and the chain checker from the storage server's. Chaintracks is
// off: neither needs headers, and a second embedded chaintracks would share
// the server's storage path. The chain check needs a network with its own
// WhatsOnChain index (chainCheckNetwork), FK_WOC_API_KEY and a WhatsOnChain
// service the storage config enables; off reports why it is off ("" when on).
func servicesConfig(cfg config.Config, base defs.WalletServices) (svc defs.WalletServices, chainCheck bool, off string) {
	svc = base
	svc.ChaintracksClient.Enabled = false
	switch {
	case !chainCheckNetwork(cfg.Network):
		return svc, false, fmt.Sprintf("FK_NETWORK %q has no WhatsOnChain index of its own (lookups would hit public testnet and report every fuel output spent)", cfg.Network)
	case cfg.WoCAPIKey == "":
		return svc, false, "FK_WOC_API_KEY is not set"
	case !svc.WhatsOnChain.Enabled:
		return svc, false, "the storage config disables wallet_services.whats_on_chain"
	}
	svc.WhatsOnChain.APIKey = cfg.WoCAPIKey
	return svc, true, ""
}

// outputLister is the one wallet call the self-check needs.
type outputLister interface {
	ListOutputs(ctx context.Context, args sdk.ListOutputsArgs, originator string) (*sdk.ListOutputsResult, error)
}

// provenLister is the one fuel.Source call the self-check needs.
type provenLister interface {
	ListProven(ctx context.Context, basket string, max int, minSats uint64) ([]fuel.Row, error)
}

// errReaderBlind is the fatal self-check verdict.
var errReaderBlind = errors.New("storage reader sees no fuel rows: check DB config/user")

// errReaderOtherDB is fatal: FindOrInsertUser on the reader created the
// wallet's user, which the wallet's own handshake had already created on the
// storage server's DB.
var errReaderOtherDB = errors.New("storage reader is on a different database than the wallet")

// selfCheck verifies the read-only provider sees what the wallet sees. It
// returns errReaderBlind (wrapped) only on a definitive mismatch: the pool
// basket lists an output, ListProven returns nothing, and the reader either
// cannot see that output at all or sees it as a completed, spendable,
// unspent change row ListProven should have returned. An empty pool, an
// unproven pool tail or any lookup error is logged and tolerated.
func selfCheck(ctx context.Context, w outputLister, src provenLister, reader fuel.OutputsReader, auth wdk.AuthID, basket string, logger *slog.Logger) error {
	one := uint32(1)
	list, err := w.ListOutputs(ctx, sdk.ListOutputsArgs{Basket: basket, Limit: &one}, originator)
	if err != nil {
		logger.Warn("self-check: cannot list the pool basket; skipped", "basket", basket, "err", err)
		return nil
	}
	if len(list.Outputs) == 0 {
		logger.Info("self-check: pool basket is empty; the keeper will mint", "basket", basket)
		return nil
	}
	rows, err := src.ListProven(ctx, basket, 1, 0)
	if err != nil {
		logger.Warn("self-check: ListProven failed; skipped", "basket", basket, "err", err)
		return nil
	}
	if len(rows) > 0 {
		logger.Info("self-check: reader sees proven fuel", "basket", basket)
		return nil
	}

	op := list.Outputs[0].Outpoint
	txid, vout := op.Txid.String(), op.Index
	all, err := reader.FindOutputsAuth(ctx, auth, wdk.FindOutputsArgs{TxID: &txid, Vout: &vout})
	if err != nil {
		logger.Warn("self-check: cannot read the sampled pool output; skipped", "outpoint", op.String(), "err", err)
		return nil
	}
	if len(all) == 0 {
		return fmt.Errorf("%w (pool output %s is listed by the wallet but absent for user %d)", errReaderBlind, op.String(), deref(auth.UserID))
	}
	done, err := reader.FindOutputsAuth(ctx, auth, wdk.FindOutputsArgs{TxID: &txid, Vout: &vout, TxStatus: []wdk.TxStatus{wdk.TxStatusCompleted}})
	if err != nil {
		logger.Warn("self-check: cannot read the sampled output's tx status; skipped", "outpoint", op.String(), "err", err)
		return nil
	}
	if len(done) == 0 {
		logger.Info("self-check: pool fuel not yet proven; drafts are unavailable until it is", "outpoint", op.String())
		return nil
	}
	r := done[0]
	if !r.Spendable || !r.Change || r.SpentBy != nil {
		logger.Warn("self-check: sampled pool output is not spendable change; skipped", "outpoint", op.String(),
			"spendable", r.Spendable, "change", r.Change, "spent", r.SpentBy != nil)
		return nil
	}
	return fmt.Errorf("%w (pool output %s is a completed spendable change row but ListProven returned none: missing derivation or BUMP)", errReaderBlind, op.String())
}

func deref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

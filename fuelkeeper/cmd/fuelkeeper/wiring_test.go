package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/transaction"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/defs"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/infra"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/wdk"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
)

func TestKeeperConfigFromEnv(t *testing.T) {
	cfg := config.Config{Denomination: 200, PoolTarget: 100, LowWaterPercent: 60, HighWaterPercent: 100, FanoutOutputsPerTx: 20, FanoutMaxTxsPerRound: 5, PoolBasket: "fuel", ReserveBasket: "reserve", KeeperIntervalSeconds: 30}
	k := keeperConfig(cfg)
	require.Equal(t, uint64(200), k.Denomination)
	require.Equal(t, uint64(100), k.TargetPoolSize)
	require.Equal(t, "fuel", k.PoolBasket)
	require.Equal(t, 30*time.Second, k.Interval)
	require.Equal(t, uint64(1600), k.ChunkFeeHeadroom, "max(1000, 8*D)")
	require.Equal(t, "fuelkeeper", k.Originator)

	cfg.Denomination = 50
	require.Equal(t, uint64(1000), keeperConfig(cfg).ChunkFeeHeadroom, "floor of 1000")
}

func TestConnectRetry_GivesUpAfterWindow(t *testing.T) {
	calls := 0
	err := retryWithBackoff(context.Background(), 50*time.Millisecond, time.Millisecond, 10*time.Millisecond, func() error { calls++; return errors.New("down") }, nil)
	require.Error(t, err)
	require.Greater(t, calls, 2)
	require.ErrorContains(t, err, "down")
}

func TestConnectRetry_SucceedsAfterFailures(t *testing.T) {
	calls, retries := 0, 0
	err := retryWithBackoff(context.Background(), time.Second, time.Millisecond, 2*time.Millisecond, func() error {
		calls++
		if calls < 3 {
			return errors.New("not yet")
		}
		return nil
	}, func(n int, err error, sleep time.Duration) {
		retries++
		require.Equal(t, retries, n)
		require.LessOrEqual(t, sleep, 2*time.Millisecond)
	})
	require.NoError(t, err)
	require.Equal(t, 3, calls)
	require.Equal(t, 2, retries)
}

func TestConnectRetry_StopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	start := time.Now()
	err := retryWithBackoff(ctx, time.Minute, 20*time.Millisecond, time.Second, func() error {
		calls++
		if calls == 2 {
			cancel()
		}
		return errors.New("down")
	}, nil)
	require.ErrorIs(t, err, context.Canceled)
	require.Equal(t, 2, calls)
	require.Less(t, time.Since(start), 5*time.Second)
}

func throughputInfra() infra.Config {
	c := infra.Defaults()
	c.BSVNetwork = defs.NetworkTestnet
	c.UTXOManagement.Strategy = defs.StrategyThroughput
	c.UTXOManagement.Throughput.DenominationSatoshis = 200
	c.UTXOManagement.Throughput.FanoutOutputsPerTx = 20
	return c
}

func keeperCfg() config.Config {
	return config.Config{Network: defs.NetworkTestnet, Denomination: 200, PoolBasket: "fuel", ReserveBasket: "reserve", FanoutOutputsPerTx: 20}
}

func TestCheckStorageConfig(t *testing.T) {
	s := throughputInfra()
	require.NoError(t, checkStorageConfig(keeperCfg(), &s))

	s.UTXOManagement.Strategy = defs.StrategyPrivacy
	require.ErrorContains(t, checkStorageConfig(keeperCfg(), &s), "strategy")

	s = throughputInfra()
	s.BSVNetwork = defs.NetworkMainnet
	s.UTXOManagement.Throughput.DenominationSatoshis = 201
	s.UTXOManagement.Throughput.PoolBasket = "other"
	s.UTXOManagement.Throughput.FanoutOutputsPerTx = 100 // the toolbox default
	err := checkStorageConfig(keeperCfg(), &s)
	require.ErrorContains(t, err, "FK_NETWORK")
	require.ErrorContains(t, err, "FUEL_D 200")
	require.ErrorContains(t, err, "FK_POOL_BASKET")
	require.ErrorContains(t, err, "utxo_management.throughput.fanout_outputs_per_tx 100 != FK_FANOUT_OUTPUTS_PER_TX 20")

	s = throughputInfra()
	s.UTXOManagement.Throughput.ReserveBasket = "other-reserve"
	err = checkStorageConfig(keeperCfg(), &s)
	require.ErrorContains(t, err, "utxo_management.throughput.reserve_basket")
	require.ErrorContains(t, err, "FK_RESERVE_BASKET")
	require.NotContains(t, err.Error(), "FUEL_D", "only the reserve basket differs")

	s = throughputInfra()
	s.UTXOManagement.Throughput.DenominationSatoshis = 0 // derive...
	s.UTXOManagement.Throughput.ExpectedTxSizeBytes = 0  // ...from an empty shape
	s.UTXOManagement.Throughput.ExpectedOutputSatoshis = 0
	err = checkStorageConfig(keeperCfg(), &s)
	require.ErrorContains(t, err, "denomination: derived denomination is zero")
}

func TestStoragePortMismatch(t *testing.T) {
	_, bad := storagePortMismatch("http://127.0.0.1:8100", 8100)
	require.False(t, bad)
	got, bad := storagePortMismatch("http://localhost:8200", 8100)
	require.True(t, bad)
	require.Equal(t, "8200", got)
	_, bad = storagePortMismatch("http://storage.internal:8200", 8100)
	require.False(t, bad, "non-loopback hosts are not second-guessed")
	_, bad = storagePortMismatch("http://127.0.0.1", 8100)
	require.False(t, bad)
}

func TestServicesConfig(t *testing.T) {
	base := defs.DefaultServicesConfig(defs.NetworkTestnet)
	base.ChaintracksClient.Enabled = true
	require.True(t, base.WhatsOnChain.Enabled)

	svc, on := servicesConfig(config.Config{}, base)
	require.False(t, on, "no FK_WOC_API_KEY")
	require.False(t, svc.ChaintracksClient.Enabled)
	require.True(t, base.ChaintracksClient.Enabled, "base is not mutated")

	svc, on = servicesConfig(config.Config{WoCAPIKey: "k"}, base)
	require.True(t, on)
	require.Equal(t, "k", svc.WhatsOnChain.APIKey)
	require.Empty(t, base.WhatsOnChain.APIKey)

	base.WhatsOnChain.Enabled = false
	_, on = servicesConfig(config.Config{WoCAPIKey: "k"}, base)
	require.False(t, on, "WhatsOnChain disabled in the storage config (e.g. tstn)")
}

type fakeLister struct {
	outs []sdk.Output
	err  error
}

func (f fakeLister) ListOutputs(context.Context, sdk.ListOutputsArgs, string) (*sdk.ListOutputsResult, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &sdk.ListOutputsResult{TotalOutputs: uint32(len(f.outs)), Outputs: f.outs}, nil
}

type fakeProven struct {
	rows []fuel.Row
	err  error
}

func (f fakeProven) ListProven(context.Context, string, int) ([]fuel.Row, error) {
	return f.rows, f.err
}

// fakeReader answers the self-check's two lookups: any row (no TxStatus
// filter; err) and completed rows (TxStatus filter; errCompleted).
type fakeReader struct {
	any, completed    wdk.TableOutputs
	err, errCompleted error
}

func (f fakeReader) FindOutputsAuth(_ context.Context, a wdk.AuthID, args wdk.FindOutputsArgs) (wdk.TableOutputs, error) {
	if a.UserID == nil || args.TxID == nil || args.Vout == nil {
		return nil, errors.New("bad lookup")
	}
	if len(args.TxStatus) > 0 {
		return f.completed, f.errCompleted
	}
	return f.any, f.err
}

func TestSelfCheck(t *testing.T) {
	const txid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	op, err := transaction.OutpointFromString(txid + ".3")
	require.NoError(t, err)
	listed := fakeLister{outs: []sdk.Output{{Outpoint: *op, Satoshis: 200}}}
	row := wdk.TableOutput{TxID: func() *string { s := txid; return &s }(), Vout: 3, Spendable: true, Change: true, Satoshis: 200}
	notChange := row
	notChange.Change = false
	uid := 7
	a := wdk.AuthID{IdentityKey: "02ab", UserID: &uid}
	log := slog.New(slog.DiscardHandler)

	cases := []struct {
		name   string
		lister fakeLister
		proven fakeProven
		reader fakeReader
		fatal  bool
	}{
		{name: "empty pool", lister: fakeLister{}},
		{name: "list error tolerated", lister: fakeLister{err: errors.New("down")}},
		{name: "reader sees proven fuel", lister: listed, proven: fakeProven{rows: []fuel.Row{{Outpoint: txid + ".3"}}}},
		{name: "reader blind to a listed output", lister: listed, fatal: true},
		{name: "pool not yet proven", lister: listed, reader: fakeReader{any: wdk.TableOutputs{row}}},
		{name: "completed usable row but no proven fuel", lister: listed, reader: fakeReader{any: wdk.TableOutputs{row}, completed: wdk.TableOutputs{row}}, fatal: true},
		{name: "completed non-change row tolerated", lister: listed, reader: fakeReader{any: wdk.TableOutputs{notChange}, completed: wdk.TableOutputs{notChange}}},
		{name: "reader error tolerated", lister: listed, reader: fakeReader{err: errors.New("db down")}},
		{name: "ListProven error tolerated", lister: listed, proven: fakeProven{err: errors.New("beef")}},
		{name: "tx-status lookup error tolerated", lister: listed, reader: fakeReader{any: wdk.TableOutputs{row}, errCompleted: errors.New("db down")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := selfCheck(context.Background(), tc.lister, tc.proven, tc.reader, a, "fuel", log)
			if tc.fatal {
				require.ErrorIs(t, err, errReaderBlind)
				require.ErrorContains(t, err, txid+".3")
			} else {
				require.NoError(t, err)
			}
		})
	}
}

func TestClassifyStartup(t *testing.T) {
	live := context.Background()
	signalled, stop := context.WithCancel(context.Background())
	stop()
	dead, kill := context.WithCancelCause(context.Background())
	kill(errors.New("storage server stopped: bind: address already in use"))
	wrapped := fmt.Errorf("gave up after 3 attempts: %w", errors.Join(context.Canceled, errors.New("dial refused")))

	cases := []struct {
		name        string
		sig, root   context.Context
		err         error
		want        startupVerdict
		wantExitOne bool
	}{
		{"plain failure", live, live, errors.New("bad yaml"), verdictFailed, true},
		{"signal cancels a step", signalled, live, wrapped, verdictSignal, false},
		{"signal with nil err", signalled, live, nil, verdictSignal, false},
		{"signal does not mask a real error", signalled, live, errors.New("bad yaml"), verdictFailed, true},
		{"storage death is the cause, not a signal", live, dead, wrapped, verdictRootCause, true},
		{"storage death wins over a signal", signalled, dead, wrapped, verdictRootCause, true},
		{"cancellation without a signal is a failure", live, live, context.Canceled, verdictFailed, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyStartup(tc.sig, tc.root, tc.err)
			require.Equal(t, tc.want, got)
			require.Equal(t, tc.wantExitOne, got.exitCode() == 1)
		})
	}
}

func TestWaitTimeout(t *testing.T) {
	var wg sync.WaitGroup
	require.True(t, waitTimeout(&wg, time.Second), "nothing to wait for")

	release := make(chan struct{})
	wg.Go(func() { <-release })
	require.False(t, waitTimeout(&wg, 20*time.Millisecond), "a stuck worker times out")
	close(release)
	require.True(t, waitTimeout(&wg, time.Second))
}

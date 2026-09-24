package settle

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/token"
)

var assetID = strings.Repeat("cd", 32) + ".0"

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

type env struct {
	ctx context.Context
	st  *store.Store
	src *fuel.Fake
	c   *clock
	s   *Settler
}

func newEnv(t *testing.T) *env {
	t.Helper()
	c := &clock{t: time.Unix(1_758_600_000, 0)}
	st, err := store.Open(store.DriverSQLite, filepath.Join(t.TempDir(), "fk.sqlite"), c.now)
	require.NoError(t, err)
	t.Cleanup(func() { _ = st.Close() })
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	src := fuel.NewFake(priv)
	return &env{ctx: context.Background(), st: st, src: src, c: c, s: New(st, src)}
}

func newRequester(t *testing.T) string {
	t.Helper()
	priv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	return priv.PubKey().ToDERHex()
}

func feeScript(t *testing.T) []byte {
	t.Helper()
	pkh := make([]byte, 20)
	_, err := rand.Read(pkh)
	require.NoError(t, err)
	s, err := token.LockToken(assetID, 20, pkh)
	require.NoError(t, err)
	return []byte(*s)
}

// pair is one drafted fuel pair: the fuel row and the fee script committed
// for it.
type pair struct {
	fuel fuel.Row
	fee  []byte
}

// draft claims and commits one fuel pair per entry for requestID, pair index
// firstIndex+i, exactly as the drafter does.
func (e *env) draft(t *testing.T, requestID, requester string, firstIndex int, n int) []pair {
	t.Helper()
	pairs := make([]pair, n)
	commit := make([]store.CommitPair, n)
	for i := range pairs {
		r := e.src.AddFuel(t, 1000)
		ok, err := e.st.Claim(e.ctx, store.Candidate{
			Outpoint: r.Outpoint, Satoshis: r.Satoshis, FuelScript: hex.EncodeToString(r.LockingScript),
			FuelBeef: hex.EncodeToString(r.Beef), DerivationPrefix: r.DerivationPrefix, DerivationSuffix: r.DerivationSuffix,
		}, requestID, requester, assetID, firstIndex+i, 60)
		require.NoError(t, err)
		require.True(t, ok)
		pairs[i] = pair{fuel: r, fee: feeScript(t)}
		commit[i] = store.CommitPair{Outpoint: r.Outpoint, FeeScript: hex.EncodeToString(pairs[i].fee), KeyID: "fee-" + r.Outpoint, FeeAmount: "20"}
	}
	_, err := e.st.Commit(e.ctx, requestID, commit, 600)
	require.NoError(t, err)
	return pairs
}

// buildTx spends the pairs' fuel in order, pays each fee output at the same
// index, and appends one unrelated output. Source transactions come from the
// fuel BEEF so tx.BEEF()/AtomicBEEF() carry proven ancestry.
func buildTx(t *testing.T, pairs []pair) *transaction.Transaction {
	t.Helper()
	tx := transaction.NewTransaction()
	for _, p := range pairs {
		src, err := transaction.NewTransactionFromBEEF(p.fuel.Beef)
		require.NoError(t, err)
		in := &transaction.TransactionInput{SourceTXID: src.TxID(), SourceTxOutIndex: p.fuel.Vout, SequenceNumber: 0xffffffff}
		in.SourceTransaction = src
		tx.AddInput(in)
	}
	for _, p := range pairs {
		tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: script.NewFromBytes(p.fee)})
	}
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 0, LockingScript: script.NewFromBytes([]byte{0x6a, 0x01, 0x00})})
	return tx
}

func (e *env) consume(t *testing.T, txid string, items ...store.ConsumeItem) {
	t.Helper()
	ref, err := e.st.Consume(e.ctx, txid, items)
	require.NoError(t, err)
	require.Nil(t, ref)
}

func atomicOf(t *testing.T, tx *transaction.Transaction) []byte {
	t.Helper()
	b, err := tx.AtomicBEEF(false)
	require.NoError(t, err)
	return b
}

type ci struct {
	ProtocolID   []any  `json:"protocolID"`
	KeyID        string `json:"keyID"`
	Counterparty string `json:"counterparty"`
}

func TestSettle_InternalizesEveryRowAndMarksSettled(t *testing.T) {
	e := newEnv(t)
	alice, bob := newRequester(t), newRequester(t)
	a := e.draft(t, "req1", alice, 0, 2)
	b := e.draft(t, "req2", bob, 2, 1)
	// req2's pair is released, cleared by a recheck, then late-submitted by
	// its last holder in the same tx, and wrongly released by an eviction.
	_, err := e.st.ReleaseRequest(e.ctx, "req2")
	require.NoError(t, err)
	ok, err := e.st.SetRechecked(e.ctx, b[0].fuel.Outpoint, true)
	require.NoError(t, err)
	require.True(t, ok)

	all := append(append([]pair(nil), a...), b...)
	tx := buildTx(t, all)
	txid := tx.TxID().String()
	e.consume(t, txid,
		store.ConsumeItem{Outpoint: a[0].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: a[1].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: b[0].fuel.Outpoint, RequestID: "req2"})
	n, err := e.st.ReleaseEvicted(e.ctx, txid, []string{b[0].fuel.Outpoint})
	require.NoError(t, err)
	require.EqualValues(t, 1, n)

	before, err := e.st.ByTxid(e.ctx, txid)
	require.NoError(t, err)
	require.Len(t, before, 3)
	require.Equal(t, store.StatusReleased, before[2].Status, "wrongful release")

	atomic := atomicOf(t, tx)
	settled, err := e.s.Settle(e.ctx, txid, atomic)
	require.NoError(t, err)
	require.Equal(t, 3, settled)

	require.Len(t, e.src.Internalized, 3)
	requesters := []string{alice, alice, bob}
	for i, args := range e.src.Internalized {
		row := before[i]
		require.Equal(t, i, row.PairIndex)
		require.Equal(t, atomic, args.Tx)
		require.Equal(t, "Fee for "+txid, args.Description)
		require.Len(t, args.Outputs, 1)
		out := args.Outputs[0]
		require.EqualValues(t, row.PairIndex, out.OutputIndex)
		require.Equal(t, sdk.InternalizeProtocolBasketInsertion, out.Protocol)
		require.Equal(t, "basket insertion", string(out.Protocol))
		require.Nil(t, out.PaymentRemittance)
		require.NotNil(t, out.InsertionRemittance)
		require.Equal(t, "mandala-tokens", out.InsertionRemittance.Basket)
		require.Equal(t, []string{"mandala", "fee", assetID}, out.InsertionRemittance.Tags)
		var got ci
		require.NoError(t, json.Unmarshal([]byte(out.InsertionRemittance.CustomInstructions), &got))
		require.Equal(t, []any{float64(2), "mandala token"}, got.ProtocolID)
		require.Equal(t, "fee-"+row.Outpoint, got.KeyID)
		require.Equal(t, requesters[i], got.Counterparty)
		require.Equal(t, row.Requester, got.Counterparty)
		require.True(t, strings.HasPrefix(out.InsertionRemittance.CustomInstructions, `{"protocolID":[2,"mandala token"],"keyID":`),
			"field order matches the lib: %s", out.InsertionRemittance.CustomInstructions)
	}

	after, err := e.st.ByTxid(e.ctx, txid)
	require.NoError(t, err)
	for _, r := range after {
		require.Equal(t, store.StatusConsumed, r.Status, r.Outpoint)
		require.NotNil(t, r.SettledAt, r.Outpoint)
		require.Equal(t, e.c.t.Unix(), *r.SettledAt)
		require.False(t, r.NeedsRecheck)
	}
}

func TestSettle_NormalizesToAtomicBeef(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 1)
	tx := buildTx(t, p)
	txid := tx.TxID().String()
	e.consume(t, txid, store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"})

	plain, err := tx.BEEF()
	require.NoError(t, err)
	require.True(t, bytes.HasPrefix(plain, []byte{0x01, 0x00, 0xbe, 0xef}), "BEEF V1")

	n, err := e.s.Settle(e.ctx, txid, plain)
	require.NoError(t, err)
	require.Equal(t, 1, n)
	require.Len(t, e.src.Internalized, 1)
	got := e.src.Internalized[0].Tx
	require.True(t, bytes.HasPrefix(got, []byte{0x01, 0x01, 0x01, 0x01}), "ATOMIC_BEEF prefix")
	_, subject, err := transaction.NewBeefFromAtomicBytes(got)
	require.NoError(t, err)
	require.Equal(t, txid, subject.String())
}

func TestSettle_IdempotentAndUnknownTxid(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 2)
	tx := buildTx(t, p)
	txid := tx.TxID().String()
	e.consume(t, txid,
		store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: p[1].fuel.Outpoint, RequestID: "req1"})
	atomic := atomicOf(t, tx)

	n, err := e.s.Settle(e.ctx, txid, atomic)
	require.NoError(t, err)
	require.Equal(t, 2, n)
	first, err := e.st.ByTxid(e.ctx, txid)
	require.NoError(t, err)

	e.c.t = e.c.t.Add(time.Hour)
	n, err = e.s.Settle(e.ctx, txid, atomic)
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.Len(t, e.src.Internalized, 4, "the repeat internalizes again (known-tx merge)")
	second, err := e.st.ByTxid(e.ctx, txid)
	require.NoError(t, err)
	require.Equal(t, first, second, "rows unchanged, settled_at kept")

	// A valid tx no row points at: nothing to do.
	other := buildTx(t, []pair{{fuel: e.src.AddFuel(t, 1000), fee: feeScript(t)}})
	n, err = e.s.Settle(e.ctx, other.TxID().String(), atomicOf(t, other))
	require.NoError(t, err)
	require.Zero(t, n)
	require.Len(t, e.src.Internalized, 4)
}

func TestSettle_RepairsSpentExternal(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 1)
	tx := buildTx(t, p)
	txid := tx.TxID().String()
	op := p[0].fuel.Outpoint
	e.consume(t, txid, store.ConsumeItem{Outpoint: op, RequestID: "req1"})
	_, err := e.st.ReleaseEvicted(e.ctx, txid, []string{op})
	require.NoError(t, err)
	ok, err := e.st.SetRechecked(e.ctx, op, false)
	require.NoError(t, err)
	require.True(t, ok)

	n, err := e.s.Settle(e.ctx, txid, atomicOf(t, tx))
	require.NoError(t, err)
	require.Equal(t, 1, n)
	rows, _ := e.st.ByTxid(e.ctx, txid)
	require.Equal(t, store.StatusConsumed, rows[0].Status)
	require.NotNil(t, rows[0].SettledAt)
}

func TestSettle_CreditsThePairsActualIndex(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 2)
	// SIGHASH_SINGLE|ANYONECANPAY commits each fuel input to its paired
	// output, not to a position: swapping whole pairs keeps every signature
	// valid, so the fee is credited where the pair actually sits.
	tx := buildTx(t, []pair{p[1], p[0]})
	txid := tx.TxID().String()
	e.consume(t, txid,
		store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: p[1].fuel.Outpoint, RequestID: "req1"})

	n, err := e.s.Settle(e.ctx, txid, atomicOf(t, tx))
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.EqualValues(t, 1, e.src.Internalized[0].Outputs[0].OutputIndex, "pair 0 sits at index 1")
	require.EqualValues(t, 0, e.src.Internalized[1].Outputs[0].OutputIndex, "pair 1 sits at index 0")
}

func TestSettle_RefusesMismatchedInput(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 2)
	tx := buildTx(t, p)
	txid := tx.TxID().String()
	e.consume(t, txid,
		store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: p[1].fuel.Outpoint, RequestID: "req1"})
	before, _ := e.st.ByTxid(e.ctx, txid)

	other := buildTx(t, []pair{{fuel: e.src.AddFuel(t, 1000), fee: feeScript(t)}})
	otherPlain, err := other.BEEF()
	require.NoError(t, err)

	for name, tc := range map[string]struct {
		txid string
		beef []byte
	}{
		"atomic subject is another tx": {txid, atomicOf(t, other)},
		"plain beef lacks the tx":      {txid, otherPlain},
		"garbage":                      {txid, []byte{0x01, 0x02, 0x03}},
		"empty":                        {txid, nil},
		"uppercase txid":               {strings.ToUpper(txid), atomicOf(t, tx)},
		"short txid":                   {txid[:10], atomicOf(t, tx)},
	} {
		t.Run(name, func(t *testing.T) {
			n, err := e.s.Settle(e.ctx, tc.txid, tc.beef)
			require.ErrorIs(t, err, ErrInvalid, "a request that can never succeed is permanent")
			require.Zero(t, n)
		})
	}
	require.Empty(t, e.src.Internalized)
	after, _ := e.st.ByTxid(e.ctx, txid)
	require.Equal(t, before, after)
}

func TestSettle_RefusesTxWhoseFeeOutputDiffers(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 2)
	// Pair 0 is intact; output 1 is not the fee script committed for pair 1.
	bad := buildTx(t, []pair{p[0], {fuel: p[1].fuel, fee: feeScript(t)}})
	txid := bad.TxID().String()
	e.consume(t, txid,
		store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: p[1].fuel.Outpoint, RequestID: "req1"})

	n, err := e.s.Settle(e.ctx, txid, atomicOf(t, bad))
	require.ErrorContains(t, err, "not the fee output")
	require.ErrorIs(t, err, ErrInvalid)
	require.Zero(t, n)
	require.Empty(t, e.src.Internalized, "a mismatch internalizes nothing, not even the intact pair")
	rows, _ := e.st.ByTxid(e.ctx, txid)
	for _, r := range rows {
		require.Nil(t, r.SettledAt)
	}

	// A tx that does not spend a row's fuel at all is refused the same way.
	e2 := newEnv(t)
	q := e2.draft(t, "req1", newRequester(t), 0, 2)
	half := buildTx(t, q[:1])
	e2.consume(t, half.TxID().String(),
		store.ConsumeItem{Outpoint: q[0].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: q[1].fuel.Outpoint, RequestID: "req1"})
	_, err = e2.s.Settle(e2.ctx, half.TxID().String(), atomicOf(t, half))
	require.ErrorContains(t, err, "does not spend fuel")
	require.ErrorIs(t, err, ErrInvalid)
	require.Empty(t, e2.src.Internalized)
}

func TestSettle_InternalizeErrorLeavesRowsUnsettled(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 1)
	tx := buildTx(t, p)
	txid := tx.TxID().String()
	e.consume(t, txid, store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"})
	e.src.InternalizeErr = errors.New("storage down")

	n, err := e.s.Settle(e.ctx, txid, atomicOf(t, tx))
	require.ErrorContains(t, err, "storage down")
	require.NotErrorIs(t, err, ErrInvalid, "a wallet failure is transient")
	require.Zero(t, n)
	rows, _ := e.st.ByTxid(e.ctx, txid)
	require.Equal(t, store.StatusConsumed, rows[0].Status)
	require.Nil(t, rows[0].SettledAt, "the overlay retries; nothing is marked")

	e.src.InternalizeErr = nil
	n, err = e.s.Settle(e.ctx, txid, atomicOf(t, tx))
	require.NoError(t, err)
	require.Equal(t, 1, n)
}

// A failure part-way through: the rows before the failing internalize are
// credited and marked, the failing row and the ones after it are not, and
// the overlay's retry settles the rest without touching what already landed.
func TestSettle_PartialFailureSettlesTheRestOnRetry(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 2)
	tx := buildTx(t, p)
	txid := tx.TxID().String()
	e.consume(t, txid,
		store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"},
		store.ConsumeItem{Outpoint: p[1].fuel.Outpoint, RequestID: "req1"})
	atomic := atomicOf(t, tx)
	boom := errors.New("storage down on the second output")
	e.src.FailNthInternalize(2, boom)

	n, err := e.s.Settle(e.ctx, txid, atomic)
	require.ErrorIs(t, err, boom)
	require.NotErrorIs(t, err, ErrInvalid)
	require.ErrorContains(t, err, p[1].fuel.Outpoint)
	require.Equal(t, 1, n, "row 1 was internalized before row 2 failed")
	require.Len(t, e.src.Internalized, 2)
	rows, err := e.st.ByTxid(e.ctx, txid)
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, p[0].fuel.Outpoint, rows[0].Outpoint)
	require.Equal(t, store.StatusConsumed, rows[0].Status)
	require.NotNil(t, rows[0].SettledAt, "row 1 is settled")
	firstSettledAt := *rows[0].SettledAt
	require.Equal(t, store.StatusConsumed, rows[1].Status)
	require.Nil(t, rows[1].SettledAt, "row 2 is still unsettled: the sweeper and the overlay still see it")

	e.c.t = e.c.t.Add(time.Minute)
	n, err = e.s.Settle(e.ctx, txid, atomic)
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.Len(t, e.src.Internalized, 4, "the retry re-internalizes row 1 (known-tx merge) and row 2")
	rows, err = e.st.ByTxid(e.ctx, txid)
	require.NoError(t, err)
	require.NotNil(t, rows[0].SettledAt)
	require.Equal(t, firstSettledAt, *rows[0].SettledAt, "row 1 keeps its original settled_at")
	require.NotNil(t, rows[1].SettledAt, "row 2 settled on the retry")
	require.Equal(t, e.c.t.Unix(), *rows[1].SettledAt)
	for _, args := range e.src.Internalized[2:] {
		require.Equal(t, atomic, args.Tx)
	}
	require.EqualValues(t, 1, e.src.Internalized[3].Outputs[0].OutputIndex, "row 2's fee output")
}

// A store failure is transient (503 upstream), never ErrInvalid, even for a
// well-formed request.
func TestSettle_StoreErrorIsNotInvalid(t *testing.T) {
	e := newEnv(t)
	p := e.draft(t, "req1", newRequester(t), 0, 1)
	tx := buildTx(t, p)
	txid := tx.TxID().String()
	e.consume(t, txid, store.ConsumeItem{Outpoint: p[0].fuel.Outpoint, RequestID: "req1"})
	require.NoError(t, e.st.Close())

	n, err := e.s.Settle(e.ctx, txid, atomicOf(t, tx))
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrInvalid)
	require.Zero(t, n)
	require.Empty(t, e.src.Internalized)
}

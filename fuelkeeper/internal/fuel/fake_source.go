package fuel

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"slices"
	"sort"
	"sync"
	"testing"

	"github.com/bsv-blockchain/go-sdk/chainhash"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/bsv-blockchain/go-wallet-toolbox/pkg/brc29"
)

// Fake is an in-memory Source for drafter/sweeper/api tests. Its fuel rows
// are real self→self BRC-29 outputs, so Unlocker signatures verify against
// them. All methods are safe for concurrent use; set the exported fields
// before sharing the Fake between goroutines.
type Fake struct {
	mu   sync.Mutex
	priv *ec.PrivateKey
	kd   *sdk.KeyDeriver
	pw   *sdk.ProtoWallet

	rows      map[string]*fakeRow
	nextID    uint
	hidden    bool
	listErr   error
	detErr    error
	listCalls int
	// intFailIn counts down Internalize calls to the one that returns
	// intFailErr (see FailNthInternalize); 0 means no pending failure.
	intFailIn  int
	intFailErr error

	// Internalized records every Internalize call's args, in order.
	Internalized []sdk.InternalizeActionArgs
	// InternalizeErr, when set, is returned by every Internalize call (the
	// args are still recorded).
	InternalizeErr error
	// Balance is what BalanceSats returns.
	Balance uint64
}

type fakeRow struct {
	row           Row
	inBasket      bool
	spendable     bool
	spentBy       string
	spendOnDetach bool
}

var _ Source = (*Fake)(nil)

// NewFake returns an empty Fake whose wallet identity is identityPriv.
func NewFake(identityPriv *ec.PrivateKey) *Fake {
	pw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypePrivateKey, PrivateKey: identityPriv})
	if err != nil {
		panic(fmt.Sprintf("fuel fake: proto wallet: %v", err))
	}
	return &Fake{
		priv:   identityPriv,
		kd:     sdk.NewKeyDeriver(identityPriv),
		pw:     pw,
		rows:   map[string]*fakeRow{},
		nextID: 1,
	}
}

// AddFuel mints a proven, in-basket, spendable fuel row of sats locked the
// way the toolbox locks change: brc29.LockForCounterparty(kd, keyID, kd) with
// random base64 16-byte prefix/suffix. The source tx is synthetic (one
// coinbase-shaped input) and carries a single-leaf BUMP whose root is its
// own txid, so Beef is a self-contained BEEF (the proof is fake: a chain
// tracker must accept root == txid at the row's height to verify it).
func (f *Fake) AddFuel(t testing.TB, sats uint64) Row {
	t.Helper()
	prefix, suffix := randomDerivation(t), randomDerivation(t)
	lock, err := brc29.LockForCounterparty(f.kd, brc29.KeyID{DerivationPrefix: prefix, DerivationSuffix: suffix}, f.kd)
	if err != nil {
		t.Fatalf("fuel fake: lock: %v", err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.nextID
	f.nextID++

	tx := transaction.NewTransaction()
	tx.AddInput(&transaction.TransactionInput{
		SourceTXID:       &chainhash.Hash{},
		SourceTxOutIndex: 0xffffffff,
		SequenceNumber:   transaction.DefaultSequenceNumber,
	})
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: sats, LockingScript: lock})
	txid := tx.TxID()
	isTxid := true
	tx.MerklePath = transaction.NewMerklePath(uint32(1000+id), [][]*transaction.PathElement{{{Offset: 0, Hash: txid, Txid: &isTxid}}})
	beef, err := tx.BEEF()
	if err != nil {
		t.Fatalf("fuel fake: beef: %v", err)
	}

	r := Row{
		Outpoint:         fmt.Sprintf("%s.%d", txid.String(), 0),
		Txid:             txid.String(),
		Vout:             0,
		Satoshis:         sats,
		OutputID:         id,
		LockingScript:    slices.Clone([]byte(*lock)),
		DerivationPrefix: prefix,
		DerivationSuffix: suffix,
		Beef:             beef,
	}
	f.rows[r.Outpoint] = &fakeRow{row: r, inBasket: true, spendable: true}
	return cloneRow(r)
}

// Row returns the row for outpoint as it was minted (zero Row if unknown).
func (f *Fake) Row(outpoint string) Row {
	f.mu.Lock()
	defer f.mu.Unlock()
	if fr, ok := f.rows[outpoint]; ok {
		return cloneRow(fr.row)
	}
	return Row{}
}

// SpendExternally marks the output spent by some other transaction.
func (f *Fake) SpendExternally(outpoint string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if fr, ok := f.rows[outpoint]; ok {
		fr.spendable = false
		fr.spentBy = "external"
	}
}

// SpendAfterDetach makes the next successful Detach of outpoint also mark it
// spent, as if the wallet had selected it as change just before the detach.
func (f *Fake) SpendAfterDetach(outpoint string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if fr, ok := f.rows[outpoint]; ok {
		fr.spendOnDetach = true
	}
}

// FailNextDetach makes the next Detach return err without changing state.
func (f *Fake) FailNextDetach(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.detErr = err
}

// FailNextList makes the next ListProven return err.
func (f *Fake) FailNextList(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listErr = err
}

// HideBasket makes ListProven return no rows until ShowBasket.
func (f *Fake) HideBasket() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hidden = true
}

// ShowBasket undoes HideBasket.
func (f *Fake) ShowBasket() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hidden = false
}

// IdentityKeyHex is the fake wallet's identity public key.
func (f *Fake) IdentityKeyHex() string { return f.kd.IdentityKeyHex() }

// ListProven returns in-basket, spendable, unspent rows of at least minSats
// sorted OutputID desc. The basket name is not modelled: every AddFuel row is
// in "the" basket. Every call is counted (ListProvenCalls).
func (f *Fake) ListProven(_ context.Context, _ string, max int, minSats uint64) ([]Row, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listCalls++
	if err := f.listErr; err != nil {
		f.listErr = nil
		return nil, err
	}
	if f.hidden || max <= 0 {
		return nil, nil
	}
	var out []Row
	for _, fr := range f.rows {
		if fr.inBasket && fr.spendable && fr.spentBy == "" && fr.row.Satoshis >= minSats {
			out = append(out, cloneRow(fr.row))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].OutputID > out[j].OutputID })
	if len(out) > max {
		out = out[:max]
	}
	return out, nil
}

// ListProvenCalls is the number of ListProven calls so far (failed ones
// included).
func (f *Fake) ListProvenCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.listCalls
}

// Detach takes the row out of the basket; idempotent.
func (f *Fake) Detach(_ context.Context, outpoint string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.detErr; err != nil {
		f.detErr = nil
		return err
	}
	fr, ok := f.rows[outpoint]
	if !ok {
		return fmt.Errorf("detach %s: %w", outpoint, errUnknownOutpoint)
	}
	fr.inBasket = false
	if fr.spendOnDetach {
		fr.spendOnDetach = false
		fr.spendable = false
		fr.spentBy = "change"
	}
	return nil
}

// StillSpendable reports spendable && unspent. An unknown outpoint is an
// error, never "spent" (the Source contract WalletSource implements): a
// caller must not drop fuel it cannot see.
func (f *Fake) StillSpendable(_ context.Context, outpoint string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fr, ok := f.rows[outpoint]
	if !ok {
		return false, fmt.Errorf("still spendable %s: %w", outpoint, errUnknownOutpoint)
	}
	return fr.spendable && fr.spentBy == "", nil
}

// FeePubKeyHash derives the issuer-side fee key exactly as WalletSource does.
func (f *Fake) FeePubKeyHash(ctx context.Context, keyID string, requester *ec.PublicKey) ([]byte, error) {
	return feePubKeyHash(ctx, f.pw, keyID, requester)
}

// Unlocker is the same toolbox-change unlocker WalletSource returns.
func (f *Fake) Unlocker(prefix, suffix string) (transaction.UnlockingScriptTemplate, error) {
	return unlocker(f.IdentityKeyHex(), prefix, suffix, f.kd)
}

// FailNthInternalize makes the n-th Internalize call from now (n ≥ 1) return
// err, once; the calls before it and after it behave normally. The failing
// call's args are still recorded.
func (f *Fake) FailNthInternalize(n int, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.intFailIn, f.intFailErr = n, err
}

// Internalize records args and returns InternalizeErr (or the one-shot
// FailNthInternalize error when its call comes up).
func (f *Fake) Internalize(_ context.Context, args sdk.InternalizeActionArgs) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Internalized = append(f.Internalized, args)
	if f.intFailIn > 0 {
		f.intFailIn--
		if f.intFailIn == 0 {
			err := f.intFailErr
			f.intFailErr = nil
			return err
		}
	}
	return f.InternalizeErr
}

// BalanceSats returns Balance.
func (f *Fake) BalanceSats(context.Context) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Balance, nil
}

var errUnknownOutpoint = errors.New("fuel fake: unknown outpoint")

func randomDerivation(t testing.TB) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("fuel fake: random derivation: %v", err)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func cloneRow(r Row) Row {
	r.LockingScript = slices.Clone(r.LockingScript)
	r.Beef = slices.Clone(r.Beef)
	return r
}

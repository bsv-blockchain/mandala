package draft

import (
	"context"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/script"
	"github.com/bsv-blockchain/go-sdk/script/interpreter"
	"github.com/bsv-blockchain/go-sdk/transaction"
	sighash "github.com/bsv-blockchain/go-sdk/transaction/sighash"
	"github.com/bsv-blockchain/go-sdk/transaction/template/p2pkh"
	sdk "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/stretchr/testify/require"

	"github.com/sirdeggen/mandala/fuelkeeper/internal/auth"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/config"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/fuel"
	"github.com/sirdeggen/mandala/fuelkeeper/internal/store"
)

const asset = "abababababababababababababababababababababababababababababababab.0"

type harness struct {
	d      *Drafter
	src    *fuel.Fake
	st     *store.Store
	cfg    config.Config
	now    time.Time
	issuer *ec.PrivateKey
	reqPW  *sdk.ProtoWallet
	reqHex string
}

// newHarness builds a drafter over a sqlite store and a Fake holding fuelRows
// denomination-sized rows. env overrides config keys as key, value pairs.
func newHarness(t *testing.T, fuelRows int, env ...string) *harness {
	t.Helper()
	vars := map[string]string{
		"ISSUER_ROOT_KEY": "dc745c57de627a6d3a3ca549e0f9fb6b8f779108a1fe6fe290cc4df3461125d6", "FK_API_KEY": "0123456789abcdef0123456789abcdef",
		"FK_STORAGE_CONFIG": "x", "FK_NETWORK": "test", "FUEL_ASSET_IDS": asset,
	}
	require.Zero(t, len(env)%2, "env overrides come in key, value pairs")
	for i := 0; i < len(env); i += 2 {
		vars[env[i]] = env[i+1]
	}
	cfg, err := config.Load(func(k string) string { return vars[k] })
	require.NoError(t, err)
	now := time.Unix(1_758_500_000, 0)
	h := &harness{now: now, cfg: cfg}
	h.issuer, _ = ec.PrivateKeyFromHex(cfg.IssuerRootKeyHex)
	h.src = fuel.NewFake(h.issuer)
	for i := 0; i < fuelRows; i++ {
		h.src.AddFuel(t, cfg.Denomination)
	}
	h.st, err = store.Open("sqlite", filepath.Join(t.TempDir(), "fk.sqlite"), func() time.Time { return h.now })
	require.NoError(t, err)
	t.Cleanup(func() { _ = h.st.Close() })
	v, _ := auth.NewVerifier(func() time.Time { return h.now })
	h.d = New(cfg, h.st, h.src, v, func() time.Time { return h.now })
	h.reqPW, h.reqHex = newRequester(t)
	return h
}

func newRequester(t *testing.T) (*sdk.ProtoWallet, string) {
	t.Helper()
	reqPriv, err := ec.NewPrivateKey()
	require.NoError(t, err)
	pw, err := sdk.NewProtoWallet(sdk.ProtoWalletArgs{Type: sdk.ProtoWalletArgsTypePrivateKey, PrivateKey: reqPriv})
	require.NoError(t, err)
	return pw, reqPriv.PubKey().ToDERHex()
}

func (h *harness) request(t *testing.T, n, m int, nonceByte byte) Request {
	return h.signedRequest(t, h.reqPW, h.reqHex, asset, n, m, nonceByte)
}

// signedRequest signs a draft request exactly as the requester's wallet does
// (§3.1), for any requester string and asset.
func (h *harness) signedRequest(t *testing.T, pw *sdk.ProtoWallet, requester, assetID string, n, m int, nonceByte byte) Request {
	t.Helper()
	nonce := hex.EncodeToString(append(make([]byte, 31), nonceByte))
	msg := auth.DraftMessage(assetID, n, m, requester, nonce, h.now.Unix())
	sig, err := auth.Sign(context.Background(), pw, nonce, msg)
	require.NoError(t, err)
	return Request{AssetID: assetID, N: n, M: m, Requester: requester, Nonce: nonce, Ts: h.now.Unix(), Sig: sig,
		FeeRatePerKb: 10, IssuerIdentityKey: h.issuer.PubKey().ToDERHex()}
}

// wire pins the §3.1 status and retryable flag of every refusal code.
func wire(t *testing.T, ref *Refusal) {
	t.Helper()
	want := map[string]struct {
		status    int
		retryable bool
	}{
		CodeShape: {400, false}, CodeAuth: {401, false}, CodeIneligible: {409, true}, CodeDenied: {403, false},
		CodeQuota: {429, true}, CodeTooLarge: {400, false}, CodeUnavailable: {503, true},
	}
	require.NotNil(t, ref)
	w, ok := want[ref.Code]
	require.True(t, ok, "unknown refusal code %q", ref.Code)
	require.Equal(t, w.status, ref.HTTP, ref.Code)
	require.Equal(t, w.retryable, ref.Retryable, ref.Code)
	require.NotEmpty(t, ref.Description, ref.Code)
}

func TestDraft_WorkedExample(t *testing.T) {
	h := newHarness(t, 3)
	res, ref, err := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, 1, res.K)
	require.Equal(t, "20", res.FeePerPair)
	require.Equal(t, h.now.Unix()+600, res.ExpiresAt)
	require.Len(t, res.Pairs, 1)
	p := res.Pairs[0]
	require.Equal(t, 0, p.Vin)
	require.Equal(t, 0, p.Vout)
	require.Equal(t, "fee-"+p.FuelOutpoint, p.KeyID)
	require.Equal(t, h.issuer.PubKey().ToDERHex(), p.Counterparty)
	require.Equal(t, "20", p.FeeAmount)

	tx, err := transaction.NewTransactionFromHex(res.DraftTx)
	require.NoError(t, err)
	require.EqualValues(t, 1, tx.Version)
	require.EqualValues(t, 0, tx.LockTime)
	require.Len(t, tx.Inputs, 1)
	require.Len(t, tx.Outputs, 1)
	require.EqualValues(t, 1, tx.Outputs[0].Satoshis)
	require.Equal(t, p.FeeScript, tx.Outputs[0].LockingScript.String())
	require.EqualValues(t, 0xffffffff, tx.Inputs[0].SequenceNumber)
	// unlocking script ends with the fuel sighash byte before the pubkey push
	us := *tx.Inputs[0].UnlockingScript
	sigLen := int(us[0])
	require.Equal(t, byte(sighash.SingleForkID|sighash.AnyOneCanPay), us[sigLen])

	rows, _ := h.st.ByRequest(context.Background(), res.RequestID)
	require.Len(t, rows, 1)
	require.Equal(t, store.StatusReserved, rows[0].Status)
	require.Equal(t, p.FeeScript, rows[0].FeeScript)
	_, err = transaction.NewBeefFromBytes(mustHex(t, res.FuelBeef))
	require.NoError(t, err)
}

// The core guarantee (spec §1.1): a payer may append inputs/outputs after the
// pairs and the fuel signatures still verify; changing output i breaks input i.
func TestDraft_SkeletonSurvivesExtension(t *testing.T) {
	h := newHarness(t, 6)
	res, ref, err := h.d.Draft(context.Background(), h.request(t, 8, 10, 2)) // k=2
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, 2, res.K)
	tx, _ := transaction.NewTransactionFromHex(res.DraftTx)
	prev := make([]*transaction.TransactionOutput, 2)
	for i, p := range res.Pairs {
		row := h.src.Row(p.FuelOutpoint)
		prev[i] = &transaction.TransactionOutput{Satoshis: row.Satoshis, LockingScript: script.NewFromBytes(row.LockingScript)}
	}
	// Append a payer P2PKH input and two outputs, sign the payer input ALL|FORKID.
	payer, _ := ec.NewPrivateKey()
	payerAddr, err := script.NewAddressFromPublicKey(payer.PubKey(), false)
	require.NoError(t, err)
	payerLock, _ := p2pkh.Lock(payerAddr) // go-sdk 1.5.1: Lock takes an *Address
	srcTx := transaction.NewTransaction()
	srcTx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: payerLock})
	tx.AddInputFromTx(srcTx, 0, mustP2PKHUnlock(t, payer)) // go-sdk 1.5.1: no error return
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: payerLock})
	tx.AddOutput(&transaction.TransactionOutput{Satoshis: 1, LockingScript: payerLock})
	require.NoError(t, tx.Sign()) // signs only inputs with a template (the payer input)

	for i := range res.Pairs {
		require.NoError(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, i, prev[i]), interpreter.WithForkID(), interpreter.WithAfterGenesis()), "fuel input %d must verify after extension", i)
	}
	// Tamper with output 0 → input 0 fails, input 1 still passes.
	tx.Outputs[0].Satoshis = 2
	require.Error(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, 0, prev[0]), interpreter.WithForkID(), interpreter.WithAfterGenesis()))
	require.NoError(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, 1, prev[1]), interpreter.WithForkID(), interpreter.WithAfterGenesis()))
	// Dropping the trailing pair keeps pair 0 valid.
	tx.Outputs[0].Satoshis = 1
	tx.Inputs = tx.Inputs[:1]
	tx.Outputs = tx.Outputs[:1]
	require.NoError(t, interpreter.NewEngine().Execute(interpreter.WithTx(tx, 0, prev[0]), interpreter.WithForkID(), interpreter.WithAfterGenesis()))
}

func TestDraft_Refusals(t *testing.T) {
	h := newHarness(t, 4) // two k=2 drafts below fill MaxOutstanding
	ctx := context.Background()
	const other = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd.0"

	// shape/auth precede eligibility: an assetId changed after signing
	// invalidates the signature.
	bad := h.request(t, 1, 3, 3)
	bad.AssetID = other
	_, ref, _ := h.d.Draft(ctx, bad)
	require.Equal(t, "ERR_FUEL_AUTH", ref.Code)
	wire(t, ref)

	// A properly signed request for a non-allowlisted asset hits the allowlist.
	_, ref, _ = h.d.Draft(ctx, h.signedRequest(t, h.reqPW, h.reqHex, other, 1, 3, 12))
	require.Equal(t, "ERR_FUEL_INELIGIBLE", ref.Code)
	wire(t, ref)

	r := h.request(t, 1, 3, 4)
	sigBytes := mustHex(t, r.Sig)
	sigBytes[len(sigBytes)-1] ^= 0x01 // always a different S (the brief's "00" suffix is a no-op 1 in 256 runs)
	r.Sig = hex.EncodeToString(sigBytes)
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_FUEL_AUTH", ref.Code)
	wire(t, ref)

	r = h.request(t, 0, 3, 5)
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_SHAPE", ref.Code)
	wire(t, ref)

	r = h.request(t, 1, 3, 6)
	r.FeeRatePerKb = 0
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_FUEL_INELIGIBLE", ref.Code)
	wire(t, ref)

	r = h.request(t, 1, 3, 7)
	r.IssuerIdentityKey = h.reqHex
	_, ref, _ = h.d.Draft(ctx, r)
	require.Equal(t, "ERR_FUEL_INELIGIBLE", ref.Code, "issuer key must be this keeper's identity")
	wire(t, ref)

	require.NoError(t, h.st.Deny(ctx, h.reqHex, "test", "x.0"))
	_, ref, _ = h.d.Draft(ctx, h.request(t, 1, 3, 8))
	require.Equal(t, "ERR_FUEL_DENIED", ref.Code)
	wire(t, ref)
	_, _ = h.st.Undeny(ctx, h.reqHex)

	_, ref, _ = h.d.Draft(ctx, h.request(t, 8, 10, 9))
	require.Nil(t, ref)
	_, ref, _ = h.d.Draft(ctx, h.request(t, 8, 10, 10))
	require.Nil(t, ref)
	_, ref, _ = h.d.Draft(ctx, h.request(t, 1, 3, 11))
	require.Equal(t, "ERR_FUEL_QUOTA", ref.Code, "MaxOutstanding=2 reserved drafts")
	wire(t, ref)
}

func TestDraft_TooLargeAndNoFuel(t *testing.T) {
	h := newHarness(t, 0)
	_, ref, _ := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.Equal(t, "ERR_FUEL_UNAVAILABLE", ref.Code)
	wire(t, ref)
	// With the defaults (D=200, BSV_RATE=100) every (n ≤ 20, m ≤ 10) fits in
	// k ≤ 3, so K_MAX is lowered to make (20, 10) → k=3 too large.
	h2 := newHarness(t, 1, "FUEL_K_MAX", "2")
	_, ref, _ = h2.d.Draft(context.Background(), h2.request(t, 20, 10, 1))
	require.Equal(t, "ERR_FUEL_TOO_LARGE", ref.Code)
	wire(t, ref)
}

func TestDraft_FunderRaceDropsAndReplaces(t *testing.T) {
	h := newHarness(t, 3)
	rows, _ := h.src.ListProven(context.Background(), "fuel", 10)
	h.src.SpendAfterDetach(rows[0].Outpoint) // the storage funder allocates it between detach and verify
	res, ref, err := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.NotEqual(t, rows[0].Outpoint, res.Pairs[0].FuelOutpoint)
	all, _ := h.st.ByRequest(context.Background(), res.RequestID)
	statuses := map[string]store.Status{}
	for _, r := range all {
		statuses[r.Outpoint] = r.Status
	}
	require.Equal(t, store.StatusDropped, statuses[rows[0].Outpoint])
}

func TestDraft_RedraftsReleasedRowWithStoredBeef(t *testing.T) {
	h := newHarness(t, 1)
	res, ref, _ := h.d.Draft(context.Background(), h.request(t, 1, 3, 1))
	require.Nil(t, ref)
	_, _ = h.st.ReleaseRequest(context.Background(), res.RequestID)
	ok, err := h.st.SetRechecked(context.Background(), res.Pairs[0].FuelOutpoint, true)
	require.NoError(t, err)
	require.True(t, ok)
	h.src.HideBasket() // basket listing now returns nothing for the detached row
	res2, ref, err := h.d.Draft(context.Background(), h.request(t, 1, 3, 2))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, res.Pairs[0].FuelOutpoint, res2.Pairs[0].FuelOutpoint)
	require.Equal(t, res.FuelBeef, res2.FuelBeef)
	// Same requester and same keyID (fee-<outpoint>) ⇒ the issuer-side fee key,
	// and so the fee script, is identical across re-drafts of the outpoint.
	require.Equal(t, res.Pairs[0].FeeScript, res2.Pairs[0].FeeScript)
}

func TestDraft_NonceReuseIsAuth(t *testing.T) {
	h := newHarness(t, 2)
	req := h.request(t, 1, 3, 1)
	_, ref, err := h.d.Draft(context.Background(), req)
	require.NoError(t, err)
	require.Nil(t, ref)
	_, ref, err = h.d.Draft(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, "ERR_FUEL_AUTH", ref.Code)
	wire(t, ref)
}

// A requester key is keyed in canonical (lowercase compressed) form: a case
// variant of the same key must not escape the deny list or the quotas.
func TestDraft_RequesterIsCanonicalized(t *testing.T) {
	h := newHarness(t, 1)
	ctx := context.Background()
	upper := strings.ToUpper(h.reqHex)
	require.NotEqual(t, upper, h.reqHex)

	require.NoError(t, h.st.Deny(ctx, h.reqHex, "test", "x.0"))
	_, ref, err := h.d.Draft(ctx, h.signedRequest(t, h.reqPW, upper, asset, 1, 3, 1))
	require.NoError(t, err)
	require.Equal(t, "ERR_FUEL_DENIED", ref.Code)
	_, _ = h.st.Undeny(ctx, h.reqHex)

	res, ref, err := h.d.Draft(ctx, h.signedRequest(t, h.reqPW, upper, asset, 1, 3, 2))
	require.NoError(t, err)
	require.Nil(t, ref)
	rows, err := h.st.ByRequest(ctx, res.RequestID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, h.reqHex, rows[0].Requester)
}

// Fewer than k survivors: the verified survivors go released with
// needs_recheck=1 (§4.3 step 7) and the draft is refused as unavailable.
func TestDraft_ShortReleasesSurvivorsForRecheck(t *testing.T) {
	h := newHarness(t, 1)
	res, ref, err := h.d.Draft(context.Background(), h.request(t, 8, 10, 1)) // k=2, one row
	require.NoError(t, err)
	require.Nil(t, res)
	require.Equal(t, "ERR_FUEL_UNAVAILABLE", ref.Code)
	rows, err := h.st.ByRequest(context.Background(), hex.EncodeToString(append(make([]byte, 31), 1)))
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, store.StatusReleased, rows[0].Status)
	require.True(t, rows[0].NeedsRecheck)
}

// An under-denominated basket row is never claimed; a detach error leaves the
// claimed row reserving for sweeper rule 0 (never dropped: the keeper cannot
// see its state) and the draft carries on with the next candidate.
func TestDraft_SkipsUnusableAndLeavesUnverifiedToSweeper(t *testing.T) {
	h := newHarness(t, 2)
	ctx := context.Background()
	small := h.src.AddFuel(t, h.cfg.Denomination-1) // highest id: listed first
	rows, _ := h.src.ListProven(ctx, "fuel", 10)
	require.Equal(t, small.Outpoint, rows[0].Outpoint)
	h.src.FailNextDetach(errors.New("storage blip")) // hits rows[1], the first claimed

	res, ref, err := h.d.Draft(ctx, h.request(t, 1, 3, 1))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, rows[2].Outpoint, res.Pairs[0].FuelOutpoint)

	all, err := h.st.ByRequest(ctx, res.RequestID)
	require.NoError(t, err)
	statuses := map[string]store.Status{}
	for _, r := range all {
		statuses[r.Outpoint] = r.Status
	}
	require.NotContains(t, statuses, small.Outpoint, "under-denominated fuel is never claimed")
	require.Equal(t, store.StatusReserving, statuses[rows[1].Outpoint], "left for sweeper rule 0")
	require.Equal(t, store.StatusReserved, statuses[rows[2].Outpoint])
}

// The drafter verifies its own signatures before handing a draft out. A row
// whose stored derivation does not unlock its script is dropped (so it cannot
// poison every later draft) and the request fails with an infrastructure error.
func TestDraft_SelfVerifyDropsMismatchedRow(t *testing.T) {
	h := newHarness(t, 2)
	ctx := context.Background()
	rows, _ := h.src.ListProven(ctx, "fuel", 10)
	bad := rows[1]
	c := store.Candidate{Outpoint: bad.Outpoint, Satoshis: bad.Satoshis, FuelScript: hex.EncodeToString(bad.LockingScript),
		FuelBeef: hex.EncodeToString(bad.Beef), DerivationPrefix: bad.DerivationPrefix, DerivationSuffix: "AAAAAAAAAAAAAAAAAAAAAA=="}
	ok, err := h.st.Claim(ctx, c, "seed", h.reqHex, asset, 0, 60)
	require.NoError(t, err)
	require.True(t, ok)
	_, err = h.st.Commit(ctx, "seed", []store.CommitPair{{Outpoint: bad.Outpoint, FeeScript: "00", KeyID: "k", FeeAmount: "1"}}, 600)
	require.NoError(t, err)
	_, err = h.st.ReleaseRequest(ctx, "seed")
	require.NoError(t, err)
	ok, err = h.st.SetRechecked(ctx, bad.Outpoint, true)
	require.NoError(t, err)
	require.True(t, ok)

	res, ref, err := h.d.Draft(ctx, h.request(t, 1, 3, 1)) // released candidates go first
	require.Error(t, err)
	require.Nil(t, ref)
	require.Nil(t, res)
	got, err := h.st.ByRequest(ctx, hex.EncodeToString(append(make([]byte, 31), 1)))
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, bad.Outpoint, got[0].Outpoint)
	require.Equal(t, store.StatusDropped, got[0].Status)

	res, ref, err = h.d.Draft(ctx, h.request(t, 1, 3, 2))
	require.NoError(t, err)
	require.Nil(t, ref)
	require.Equal(t, rows[0].Outpoint, res.Pairs[0].FuelOutpoint)
}

// Concurrent drafts (double click, many tabs, many requesters) never hand the
// same fuel output to two requests.
func TestDraft_ConcurrentDraftsNeverShareFuel(t *testing.T) {
	const rowsN, drafts = 3, 8
	h := newHarness(t, rowsN)
	ctx := context.Background()
	reqs := make([]Request, drafts)
	for i := range reqs {
		pw, hexKey := newRequester(t)
		reqs[i] = h.signedRequest(t, pw, hexKey, asset, 1, 3, byte(i+1))
	}
	type result struct {
		res *Response
		ref *Refusal
		err error
	}
	out := make([]result, drafts)
	var wg sync.WaitGroup
	for i := range reqs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, ref, err := h.d.Draft(ctx, reqs[i])
			out[i] = result{res, ref, err}
		}(i)
	}
	wg.Wait()
	seen := map[string]bool{}
	ok := 0
	for _, r := range out {
		require.NoError(t, r.err)
		if r.ref != nil {
			require.Equal(t, "ERR_FUEL_UNAVAILABLE", r.ref.Code)
			continue
		}
		ok++
		for _, p := range r.res.Pairs {
			require.False(t, seen[p.FuelOutpoint], "fuel %s handed out twice", p.FuelOutpoint)
			seen[p.FuelOutpoint] = true
		}
	}
	require.Equal(t, rowsN, ok)
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	require.NoError(t, err)
	return b
}

func mustP2PKHUnlock(t *testing.T, k *ec.PrivateKey) *p2pkh.P2PKH {
	t.Helper()
	f := sighash.AllForkID
	u, err := p2pkh.Unlock(k, &f)
	require.NoError(t, err)
	return u
}

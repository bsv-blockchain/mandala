package mandala

// In-memory fakes of the mandala store and the engine output reader with TS vector-harness
// semantics (F/ts-layers §13 storeOver / engineFor), shared by every package-mandala test that
// needs no Mongo: the layer, manager, lookup, vector and reconciler tests.

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-sdk/transaction"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
	mt "github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
)

// memStore implements StateStore, RepairUndoStore, SweepStore and KYCClaims in memory. Rows read
// back with createdAt = time.Unix(0, 0) (storeOver's new Date(0)).
type memStore struct {
	mu          sync.Mutex
	tokens      []TokenRecord
	authorities []AuthorityRecord
	owners      []OwnerRecord
	states      map[string]AssetAdminState
	balances    map[string]int64
	claim       *string
	failures    map[string]error
}

var (
	_ StateStore      = (*memStore)(nil)
	_ RepairUndoStore = (*memStore)(nil)
	_ SweepStore      = (*memStore)(nil)
	_ KYCClaims       = (*memStore)(nil)
)

func newMemStore() *memStore {
	return &memStore{states: map[string]AssetAdminState{}, balances: map[string]int64{}, failures: map[string]error{}}
}

var memEpoch = time.Unix(0, 0).UTC()

func (m *memStore) putToken(r TokenRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.CreatedAt = memEpoch
	m.tokens = append(m.tokens, r)
}

func (m *memStore) putAuthority(r AuthorityRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.CreatedAt = memEpoch
	m.authorities = append(m.authorities, r)
}

func (m *memStore) putOwner(r OwnerRecord) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r.CreatedAt = memEpoch
	m.owners = append(m.owners, r)
}

func (m *memStore) putState(st AssetAdminState) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.states[st.TokenID] = st
}

func (m *memStore) setClaim(tokenID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.claim = &tokenID
}

// failNext makes the next call of the named method (a StateStore or KYCClaims method name, e.g.
// "GetTokenRow") return err.
func (m *memStore) failNext(method string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failures[method] = err
}

func (m *memStore) balance(identityKey string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.balances[identityKey]
}

// fail consumes a pending failure for method; callers hold m.mu.
func (m *memStore) fail(method string) error {
	err := m.failures[method]
	delete(m.failures, method)
	return err
}

func (m *memStore) GetAssetState(_ context.Context, tokenID string) (AssetAdminState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("GetAssetState"); err != nil {
		return AssetAdminState{}, err
	}
	if st, ok := m.states[tokenID]; ok {
		return st, nil
	}
	return DefaultAssetState(tokenID, nil), nil
}

func (m *memStore) GetTokenRow(_ context.Context, txid string, vout uint32) (*TokenRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("GetTokenRow"); err != nil {
		return nil, err
	}
	for _, r := range m.tokens {
		if r.Txid == txid && r.OutputIndex == vout {
			return &r, nil
		}
	}
	return nil, nil
}

func (m *memStore) GetAuthorityRow(_ context.Context, txid string, vout uint32) (*AuthorityRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("GetAuthorityRow"); err != nil {
		return nil, err
	}
	for _, r := range m.authorities {
		if r.Txid == txid && r.OutputIndex == vout {
			return &r, nil
		}
	}
	return nil, nil
}

func (m *memStore) GetOwnerJournal(_ context.Context, txid string, vout uint32, topic string) (*OwnerRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("GetOwnerJournal"); err != nil {
		return nil, err
	}
	for _, r := range m.owners {
		if r.Txid == txid && r.OutputIndex == vout && r.Topic == topic {
			return &r, nil
		}
	}
	return nil, nil
}

func (m *memStore) RecordOwners(_ context.Context, rows []OwnerRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("RecordOwners"); err != nil {
		return err
	}
next:
	for _, r := range rows {
		for _, o := range m.owners {
			if o.Txid == r.Txid && o.OutputIndex == r.OutputIndex && o.Topic == r.Topic {
				continue next // first write wins
			}
		}
		m.owners = append(m.owners, r)
	}
	return nil
}

func (m *memStore) RepairOwnerRow(_ context.Context, j OwnerRecord) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("RepairOwnerRow"); err != nil {
		return false, err
	}
	if j.Role == brc162.RoleValue {
		for i, r := range m.tokens {
			if r.Txid == j.Txid && r.OutputIndex == j.OutputIndex {
				m.tokens[i].TokenID, m.tokens[i].Amount, m.tokens[i].IdentityKey = j.TokenID, j.Amount, j.IdentityKey
				return false, nil
			}
		}
		m.tokens = append(m.tokens, TokenRecord{Txid: j.Txid, OutputIndex: j.OutputIndex, TokenID: j.TokenID, Amount: j.Amount, IdentityKey: j.IdentityKey, CreatedAt: memEpoch})
		m.balances[j.IdentityKey] += int64(j.Amount)
		return true, nil
	}
	for i, r := range m.authorities {
		if r.Txid == j.Txid && r.OutputIndex == j.OutputIndex {
			m.authorities[i].Topic, m.authorities[i].TokenID, m.authorities[i].IdentityKey = j.Topic, j.TokenID, j.IdentityKey
			return false, nil
		}
	}
	m.authorities = append(m.authorities, AuthorityRecord{Txid: j.Txid, OutputIndex: j.OutputIndex, Topic: j.Topic, TokenID: j.TokenID, IdentityKey: j.IdentityKey, CreatedAt: memEpoch})
	return true, nil
}

func (m *memStore) TakeToken(_ context.Context, txid string, vout uint32) (*TokenRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("TakeToken"); err != nil {
		return nil, err
	}
	for i, r := range m.tokens {
		if r.Txid == txid && r.OutputIndex == vout {
			m.tokens = append(m.tokens[:i], m.tokens[i+1:]...)
			return &r, nil
		}
	}
	return nil, nil
}

func (m *memStore) TakeAuthority(_ context.Context, txid string, vout uint32) (*AuthorityRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("TakeAuthority"); err != nil {
		return nil, err
	}
	for i, r := range m.authorities {
		if r.Txid == txid && r.OutputIndex == vout {
			m.authorities = append(m.authorities[:i], m.authorities[i+1:]...)
			return &r, nil
		}
	}
	return nil, nil
}

func (m *memStore) AdjustBalance(_ context.Context, identityKey string, delta int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("AdjustBalance"); err != nil {
		return err
	}
	m.balances[identityKey] += delta
	return nil
}

func (m *memStore) CirculatingSupply(_ context.Context, tokenID string) (*big.Int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("CirculatingSupply"); err != nil {
		return nil, err
	}
	evicted := map[string]bool{}
	if st, ok := m.states[tokenID]; ok {
		for _, op := range st.EvictedOutpoints {
			evicted[strings.ToLower(op)] = true
		}
	}
	sum := new(big.Int)
	for _, r := range m.tokens {
		if r.TokenID == tokenID && !evicted[strings.ToLower(fmt.Sprintf("%s.%d", r.Txid, r.OutputIndex))] {
			sum.Add(sum, big.NewInt(int64(r.Amount)))
		}
	}
	return sum, nil
}

// FindTokensByTokenID mirrors Store.FindTokensByTokenID: the token's value rows minus its evicted
// outpoints, in (txid, outputIndex) order, skip then limit (0 = all).
func (m *memStore) FindTokensByTokenID(_ context.Context, tokenID string, limit, skip int64) ([]TokenRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("FindTokensByTokenID"); err != nil {
		return nil, err
	}
	evicted := map[string]bool{}
	if st, ok := m.states[tokenID]; ok {
		for _, op := range st.EvictedOutpoints {
			evicted[strings.ToLower(op)] = true
		}
	}
	rows := []TokenRecord{}
	for _, r := range m.tokens {
		if r.TokenID == tokenID && !evicted[strings.ToLower(fmt.Sprintf("%s.%d", r.Txid, r.OutputIndex))] {
			rows = append(rows, r)
		}
	}
	slices.SortFunc(rows, func(a, b TokenRecord) int {
		return cmp.Or(strings.Compare(a.Txid, b.Txid), cmp.Compare(a.OutputIndex, b.OutputIndex))
	})
	rows = rows[min(int(skip), len(rows)):]
	if limit > 0 {
		rows = rows[:min(int(limit), len(rows))]
	}
	return rows, nil
}

// ListTokenRowsByTokenID mirrors Store.ListTokenRowsByTokenID: every value row of the token, evicted
// outpoints included, in (txid, outputIndex) order.
func (m *memStore) ListTokenRowsByTokenID(_ context.Context, tokenID string, limit, skip int64) ([]TokenRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("ListTokenRowsByTokenID"); err != nil {
		return nil, err
	}
	rows := []TokenRecord{}
	for _, r := range m.tokens {
		if r.TokenID == tokenID {
			rows = append(rows, r)
		}
	}
	slices.SortFunc(rows, func(a, b TokenRecord) int {
		return cmp.Or(strings.Compare(a.Txid, b.Txid), cmp.Compare(a.OutputIndex, b.OutputIndex))
	})
	rows = rows[min(int(skip), len(rows)):]
	if limit > 0 {
		rows = rows[:min(int(limit), len(rows))]
	}
	return rows, nil
}

// ListAuthorities mirrors Store.ListAuthorities: the token's authority rows on topic in (txid,
// outputIndex) order.
func (m *memStore) ListAuthorities(_ context.Context, topic, tokenID string) ([]AuthorityRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("ListAuthorities"); err != nil {
		return nil, err
	}
	rows := []AuthorityRecord{}
	for _, r := range m.authorities {
		if r.Topic == topic && r.TokenID == tokenID {
			rows = append(rows, r)
		}
	}
	slices.SortFunc(rows, func(a, b AuthorityRecord) int {
		return cmp.Or(strings.Compare(a.Txid, b.Txid), cmp.Compare(a.OutputIndex, b.OutputIndex))
	})
	return rows, nil
}

func (m *memStore) KYCRegistryTokenID(context.Context) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.fail("KYCRegistryTokenID"); err != nil {
		return "", false, err
	}
	if m.claim == nil {
		return "", false, nil
	}
	return *m.claim, true, nil
}

// memEngine answers FindAdmittedOutput for a fixed set of coins on one topic (satoshis 1).
type memEngine struct {
	mu      sync.Mutex
	topic   string
	coins   map[string][]byte // "<txid>.<vout>" -> locking script bytes
	spentBy map[string]string // "<txid>.<vout>" -> the transaction that marked the coin spent (the document stays)
	fail    error
}

var _ EngineOutputReader = (*memEngine)(nil)

// engineFor admits exactly the source outputs of tx's previousCoins inputs, on topic.
func engineFor(topic string, tx *transaction.Transaction, previousCoins []uint32) *memEngine {
	e := &memEngine{topic: topic, coins: map[string][]byte{}}
	for _, i := range previousCoins {
		if int(i) >= len(tx.Inputs) || tx.Inputs[i].SourceTransaction == nil {
			continue
		}
		in := tx.Inputs[i]
		src := in.SourceTransaction
		if int(in.SourceTxOutIndex) >= len(src.Outputs) {
			continue
		}
		e.coins[fmt.Sprintf("%s.%d", src.TxID().String(), in.SourceTxOutIndex)] = src.Outputs[in.SourceTxOutIndex].LockingScript.Bytes()
	}
	return e
}

// forget drops a coin: the engine has spent it (a concurrent spend).
func (e *memEngine) forget(outpoint string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.coins, outpoint)
}

// spend marks a coin spent by spender, keeping its document (MarkUTXOsAsSpent): FindAdmittedOutput
// reads it absent, AdmittedOutputState reads it spent by spender.
func (e *memEngine) spend(outpoint, spender string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.spentBy == nil {
		e.spentBy = map[string]string{}
	}
	e.spentBy[outpoint] = spender
}

// SpentBy is the conflicting-spend guard's view of the same coins (no eviction).
func (e *memEngine) SpentBy(_ context.Context, topic, txid string, vout uint32) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.fail != nil {
		return "", e.fail
	}
	if topic != e.topic {
		return "", nil
	}
	return e.spentBy[fmt.Sprintf("%s.%d", txid, vout)], nil
}

func (e *memEngine) AdmittedOutputState(_ context.Context, txid string, vout uint32, topic string) ([]byte, bool, string, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.fail != nil {
		return nil, false, "", false, e.fail
	}
	if topic != e.topic {
		return nil, false, "", false, nil
	}
	op := fmt.Sprintf("%s.%d", txid, vout)
	s, ok := e.coins[op]
	if !ok {
		return nil, false, "", false, nil
	}
	by, spent := e.spentBy[op]
	return append([]byte(nil), s...), spent, by, true, nil
}

func (e *memEngine) FindAdmittedOutput(_ context.Context, txid string, vout uint32, topic string) ([]byte, uint64, bool, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.fail != nil {
		return nil, 0, false, e.fail
	}
	if topic != e.topic {
		return nil, 0, false, nil
	}
	op := fmt.Sprintf("%s.%d", txid, vout)
	s, ok := e.coins[op]
	if _, spent := e.spentBy[op]; !ok || spent {
		return nil, 0, false, nil
	}
	return append([]byte(nil), s...), 1, true, nil
}

func (e *memEngine) ListUnspentAdmittedOutputs(context.Context, string, *transaction.Outpoint, int) ([]transaction.Outpoint, error) {
	return nil, nil
}

// ---- shared assertion helpers ----

var errStoreDown = errors.New("store down")

func overlayVerifier(t *testing.T) *Verifier {
	t.Helper()
	v, err := NewVerifier(mt.Overlay.PrivHex())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func envOf(t *testing.T, offChain []byte) *Envelope {
	t.Helper()
	env, err := DecodeEnvelope(offChain)
	if err != nil {
		t.Fatalf("DecodeEnvelope: %v", err)
	}
	return env
}

// mutateEnvelope rewrites an envelope's JSON (generic decode, edit, re-encode).
func mutateEnvelope(t *testing.T, offChain []byte, edit func(env map[string]any)) []byte {
	t.Helper()
	var env map[string]any
	if err := json.Unmarshal(offChain, &env); err != nil {
		t.Fatal(err)
	}
	edit(env)
	out, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func requireReject(t *testing.T, err error, code Code, reason string) *RejectError {
	t.Helper()
	var rej *RejectError
	if !errors.As(err, &rej) {
		t.Fatalf("error %v (%T) is not a *RejectError", err, err)
	}
	if rej.Code != code || rej.Reason != reason {
		t.Fatalf("got %s %q\nwant %s %q", rej.Code, rej.Reason, code, reason)
	}
	return rej
}

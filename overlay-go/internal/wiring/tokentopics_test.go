package wiring

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"
	"github.com/bsv-blockchain/go-sdk/overlay"

	"github.com/sirdeggen/mandala/overlay-go/internal/testmongo"
)

var (
	ttHexA = strings.Repeat("aa", 32)
	ttHexB = strings.Repeat("bb", 32)
	ttHexC = strings.Repeat("cc", 32)
	ttIDA  = ttHexA + "_0"
	ttIDB  = ttHexB + "_0"
	ttIDC  = ttHexC + "_0"
)

// fakeRegistry records every registration in call order.
type fakeRegistry struct {
	mu       sync.Mutex
	calls    []string
	managers map[string]engine.TopicManager
	lookups  map[string]engine.LookupService
}

var _ EngineRegistry = (*fakeRegistry)(nil)

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{managers: map[string]engine.TopicManager{}, lookups: map[string]engine.LookupService{}}
}

func (f *fakeRegistry) HasTopicManager(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.managers[name]
	return ok
}

func (f *fakeRegistry) RegisterTopicManager(name string, m engine.TopicManager) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "manager "+name)
	f.managers[name] = m
}

func (f *fakeRegistry) RegisterLookupService(name string, s engine.LookupService) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "lookup "+name)
	f.lookups[name] = s
}

func (f *fakeRegistry) snapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// countingFactory builds probe managers (Task 1) and counts every build.
type countingFactory struct {
	calls atomic.Int32
	mu    sync.Mutex
	err   error
	nilTM bool
}

func (c *countingFactory) build(string) (engine.TopicManager, engine.LookupService, error) {
	c.calls.Add(1)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return nil, nil, c.err
	}
	if c.nilTM {
		return nil, &probeLS{}, nil
	}
	return &probeTM{admit: admitZero}, &probeLS{}, nil
}

func (c *countingFactory) fail(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.err = err
}

func staticSource(ids ...string) TokenIDSource {
	return func(context.Context) ([]string, error) { return ids, nil }
}

func TestTokenTopicsEnsureRegistersLookupThenManager(t *testing.T) {
	reg, f := newFakeRegistry(), &countingFactory{}
	tt := NewTokenTopics(reg, nil, false, f.build)
	ok, err := tt.Ensure(ttIDA)
	if err != nil || !ok {
		t.Fatalf("Ensure = %v, %v; want true, nil", ok, err)
	}
	if got, want := reg.snapshot(), []string{"lookup ls_" + ttHexA, "manager tm_" + ttHexA}; !slices.Equal(got, want) {
		t.Fatalf("registrations = %v, want %v", got, want)
	}
	if !tt.Hosted(ttIDA) || tt.Hosted(ttIDB) {
		t.Fatalf("Hosted(A) = %v, Hosted(B) = %v", tt.Hosted(ttIDA), tt.Hosted(ttIDB))
	}
	if got := tt.Registered(); !slices.Equal(got, []string{ttIDA}) {
		t.Fatalf("Registered = %v", got)
	}
}

func TestTokenTopicsEnsureIsIdempotent(t *testing.T) {
	reg, f := newFakeRegistry(), &countingFactory{}
	tt := NewTokenTopics(reg, nil, false, f.build)
	for range 3 {
		if ok, err := tt.Ensure(ttIDA); err != nil || !ok {
			t.Fatalf("Ensure = %v, %v", ok, err)
		}
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("factory builds = %d, want 1", n)
	}
	if n := len(reg.snapshot()); n != 2 {
		t.Fatalf("registrations = %d, want 2", n)
	}
}

func TestTokenTopicsEnsureAllowlistRefusesUnlisted(t *testing.T) {
	reg, f := newFakeRegistry(), &countingFactory{}
	tt := NewTokenTopics(reg, []string{ttHexA}, true, f.build)
	if ok, err := tt.Ensure(ttIDB); err != nil || ok {
		t.Fatalf("Ensure(unlisted) = %v, %v; want false, nil", ok, err)
	}
	if f.calls.Load() != 0 || len(reg.snapshot()) != 0 || tt.Hosted(ttIDB) {
		t.Fatal("an unlisted token reached the factory or the engine")
	}
	if ok, err := tt.Ensure(ttIDA); err != nil || !ok {
		t.Fatalf("Ensure(listed) = %v, %v; want true, nil", ok, err)
	}

	none := NewTokenTopics(newFakeRegistry(), []string{}, true, f.build)
	if ok, err := none.Ensure(ttIDA); err != nil || ok {
		t.Fatalf("Ensure under MANDALA_TOKEN_ALLOWLIST=[] = %v, %v; want false, nil (V-3)", ok, err)
	}
}

func TestTokenTopicsEnsureRejectsNonCanonicalID(t *testing.T) {
	reg, f := newFakeRegistry(), &countingFactory{}
	tt := NewTokenTopics(reg, nil, false, f.build)
	for _, id := range []string{ttHexA, ttHexA + "_1", strings.ToUpper(ttHexA) + "_0", "tm_" + ttHexA, ""} {
		ok, err := tt.Ensure(id)
		if ok || err == nil || err.Error() != "not a canonical Mandala token id: "+id {
			t.Fatalf("Ensure(%q) = %v, %v", id, ok, err)
		}
	}
	if f.calls.Load() != 0 || len(reg.snapshot()) != 0 {
		t.Fatal("a non-canonical id reached the factory or the engine")
	}
}

func TestTokenTopicsEnsureFactoryErrorRegistersNothing(t *testing.T) {
	reg, f := newFakeRegistry(), &countingFactory{}
	tt := NewTokenTopics(reg, nil, false, f.build)
	boom := errors.New("boom")
	f.fail(boom)
	ok, err := tt.Ensure(ttIDA)
	if ok || !errors.Is(err, boom) || err.Error() != "token topic "+ttIDA+": boom" {
		t.Fatalf("Ensure = %v, %v", ok, err)
	}
	if len(reg.snapshot()) != 0 || tt.Hosted(ttIDA) {
		t.Fatal("a failed build registered something")
	}
	f.fail(nil)
	if ok, err := tt.Ensure(ttIDA); err != nil || !ok {
		t.Fatalf("Ensure after the factory recovered = %v, %v; want a retry to succeed", ok, err)
	}

	nilReg, nilF := newFakeRegistry(), &countingFactory{nilTM: true}
	ok, err = NewTokenTopics(nilReg, nil, false, nilF.build).Ensure(ttIDB)
	if ok || err == nil || err.Error() != "token topic "+ttIDB+": factory returned a nil topic manager or lookup service" {
		t.Fatalf("Ensure with a nil manager = %v, %v", ok, err)
	}
	if len(nilReg.snapshot()) != 0 {
		t.Fatal("a nil manager was registered")
	}
}

func TestTokenTopicsConcurrentEnsureBuildsOnce(t *testing.T) {
	reg, f := newFakeRegistry(), &countingFactory{}
	tt := NewTokenTopics(reg, nil, false, f.build)
	start := make(chan struct{})
	errs := make(chan error, 32)
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ok, err := tt.Ensure(ttIDA)
			if err == nil && !ok {
				err = errors.New("Ensure returned false")
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if n := f.calls.Load(); n != 1 {
		t.Fatalf("factory builds = %d, want 1", n)
	}
	if got, want := reg.snapshot(), []string{"lookup ls_" + ttHexA, "manager tm_" + ttHexA}; !slices.Equal(got, want) {
		t.Fatalf("registrations = %v, want %v", got, want)
	}
}

// The registrar mutex and engine.mu are never held across a manager call: an
// Ensure completes while a submit on another topic is blocked inside its manager.
func TestTokenTopicsEnsureDuringInFlightSubmit(t *testing.T) {
	db := testmongo.DB(t, "mandala3_test_tokentopics")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	blocking := &probeTM{admit: func(prev []uint32) overlay.AdmittanceInstructions {
		once.Do(func() { close(entered) })
		<-release
		return admitZero(prev)
	}}
	eng, _ := newProbeEngine(t, db, map[string]engine.TopicManager{"tm_probe_block": blocking}, nil)
	beef := atomicBEEF(t, probeSource(t, 2001))
	submitErr := make(chan error, 1)
	go func() {
		_, err := probeSubmit(ctx, eng, beef, "tm_probe_block")
		submitErr <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("the submit never reached its manager")
	}

	f := &countingFactory{}
	tt := NewTokenTopics(eng, nil, false, f.build)
	ensured := make(chan error, 1)
	go func() {
		ok, err := tt.Ensure(ttIDA)
		if err == nil && !ok {
			err = errors.New("Ensure returned false")
		}
		ensured <- err
	}()
	select {
	case err := <-ensured:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Ensure blocked behind a submit that is inside its manager")
	}
	if !eng.HasTopicManager("tm_"+ttHexA) || !eng.HasLookupService("ls_"+ttHexA) {
		t.Fatal("token topic not registered on the engine")
	}
	close(release)
	if err := <-submitErr; err != nil {
		t.Fatalf("the blocked submit: %v", err)
	}
}

func TestTokenTopicsBootUnionAndSourceError(t *testing.T) {
	ctx := context.Background()

	reg, f := newFakeRegistry(), &countingFactory{}
	tt := NewTokenTopics(reg, nil, false, f.build)
	n, err := tt.Boot(ctx, staticSource(ttIDB, ttIDA), staticSource(ttIDA, ttIDC))
	if err != nil || n != 3 {
		t.Fatalf("Boot = %d, %v; want 3, nil", n, err)
	}
	if got := tt.Registered(); !slices.Equal(got, []string{ttIDA, ttIDB, ttIDC}) {
		t.Fatalf("Registered = %v", got)
	}
	want := []string{"lookup ls_" + ttHexA, "manager tm_" + ttHexA, "lookup ls_" + ttHexB, "manager tm_" + ttHexB, "lookup ls_" + ttHexC, "manager tm_" + ttHexC}
	if got := reg.snapshot(); !slices.Equal(got, want) {
		t.Fatalf("registration order = %v, want the sorted union %v", got, want)
	}

	allowed := NewTokenTopics(newFakeRegistry(), []string{ttHexA}, true, (&countingFactory{}).build)
	if n, err := allowed.Boot(ctx, staticSource(ttIDA, ttIDB)); err != nil || n != 1 {
		t.Fatalf("Boot under an allowlist = %d, %v; want 1, nil", n, err)
	}

	down := errors.New("mongo down")
	reg2, f2 := newFakeRegistry(), &countingFactory{}
	tt2 := NewTokenTopics(reg2, nil, false, f2.build)
	n, err = tt2.Boot(ctx, staticSource(ttIDA), func(context.Context) ([]string, error) { return nil, down })
	if n != 0 || !errors.Is(err, down) || err.Error() != "token topics boot: mongo down" {
		t.Fatalf("Boot with a failing source = %d, %v", n, err)
	}
	if f2.calls.Load() != 0 || len(reg2.snapshot()) != 0 {
		t.Fatal("a failed source read still registered tokens")
	}

	n, err = NewTokenTopics(newFakeRegistry(), nil, false, (&countingFactory{}).build).Boot(ctx, staticSource("zz"))
	if n != 0 || err == nil || err.Error() != "token topics boot: not a canonical Mandala token id: zz" {
		t.Fatalf("Boot with a bad id = %d, %v", n, err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	reg3 := newFakeRegistry()
	read := false
	n, err = NewTokenTopics(reg3, nil, false, (&countingFactory{}).build).Boot(cancelled, func(context.Context) ([]string, error) { read = true; return []string{ttIDA}, nil })
	if n != 0 || !errors.Is(err, context.Canceled) || read || len(reg3.snapshot()) != 0 {
		t.Fatalf("Boot with a done ctx = %d, %v, read = %v", n, err, read)
	}
}

func TestParseTokenAllowlist(t *testing.T) {
	const notArray = "MANDALA_TOKEN_ALLOWLIST must be a JSON array of deploy txids"
	for _, c := range []struct {
		name string
		raw  string
		want []string
		set  bool
		err  string
	}{
		{"unset", "", nil, false, ""},
		{"blank", " \t\n", nil, false, ""},
		{"empty array hosts no token", "[]", []string{}, true, ""},
		{"valid, order kept", `["` + ttHexB + `","` + ttHexA + `"]`, []string{ttHexB, ttHexA}, true, ""},
		{"padded", ` [ "` + ttHexA + `" ] `, []string{ttHexA}, true, ""},
		{"not json", "abc", nil, false, notArray},
		{"null", "null", nil, false, notArray},
		{"object", `{"a":1}`, nil, false, notArray},
		{"bare string", `"` + ttHexA + `"`, nil, false, notArray},
		{"trailing data", `["` + ttHexA + `"] x`, nil, false, notArray},
		{"number element", `[1]`, nil, false, "MANDALA_TOKEN_ALLOWLIST[0] is not a deploy txid (64 lowercase hex)"},
		{"null element", `[null]`, nil, false, "MANDALA_TOKEN_ALLOWLIST[0] is not a deploy txid (64 lowercase hex)"},
		{"uppercase", `["` + ttHexA + `","` + strings.ToUpper(ttHexB) + `"]`, nil, false, "MANDALA_TOKEN_ALLOWLIST[1] is not a deploy txid (64 lowercase hex)"},
		{"63 hex", `["` + ttHexA[1:] + `"]`, nil, false, "MANDALA_TOKEN_ALLOWLIST[0] is not a deploy txid (64 lowercase hex)"},
		{"token id, not txid", `["` + ttIDA + `"]`, nil, false, "MANDALA_TOKEN_ALLOWLIST[0] is not a deploy txid (64 lowercase hex)"},
		{"duplicate", `["` + ttHexA + `","` + ttHexB + `","` + ttHexA + `"]`, nil, false, "MANDALA_TOKEN_ALLOWLIST[2] is a duplicate"},
	} {
		got, set, err := ParseTokenAllowlist(c.raw)
		if c.err != "" {
			if err == nil || err.Error() != c.err || got != nil || set {
				t.Errorf("%s: = %v, %v, %v; want error %q", c.name, got, set, err, c.err)
			}
			continue
		}
		if err != nil || set != c.set || !slices.Equal(got, c.want) || (c.want != nil) != (got != nil) {
			t.Errorf("%s: = %#v, %v, %v; want %#v, %v, nil", c.name, got, set, err, c.want, c.set)
		}
	}
}

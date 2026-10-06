package wiring

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/bsv-blockchain/go-overlay-services/pkg/core/engine"

	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
)

// EngineRegistry is satisfied by *engine.Engine (E/engine.go:212-246).
type EngineRegistry interface {
	HasTopicManager(name string) bool
	RegisterTopicManager(name string, manager engine.TopicManager)
	RegisterLookupService(name string, service engine.LookupService)
}

var _ EngineRegistry = (*engine.Engine)(nil)

// TokenTopicFactory builds one token's manager and lookup on the shared storage.
type TokenTopicFactory func(tokenID string) (engine.TopicManager, engine.LookupService, error)

// TokenIDSource lists token ids for the boot union (registry records, journal topics).
type TokenIDSource func(ctx context.Context) ([]string, error)

var errNilTokenTopic = errors.New("factory returned a nil topic manager or lookup service")

// TokenTopics is the only place token topics come into existence (TT §6.1 + A1.1): it registers a
// token's lookup and manager on the engine, once, under one mutex. It never touches SyncConfiguration,
// advertisements or GASP. Registration is in memory; Boot rebuilds it at every start.
//
// Ensure has exactly two call sites (Global Constraints): App.Start's boot union and the /submit deploy
// hook. A submit calls it while holding the gate's shared slot (lock order: shared slot -> registrar
// mutex); an exclusive maintenance section never calls it.
type TokenTopics struct {
	mu         sync.Mutex
	eng        EngineRegistry
	allowSet   bool
	allow      map[string]bool // deploy txids
	factory    TokenTopicFactory
	registered map[string]bool // token ids
}

// NewTokenTopics: allowlistSet false = follow every token; true = only allowlistTxids (an empty list
// hosts no token, V-3).
func NewTokenTopics(eng EngineRegistry, allowlistTxids []string, allowlistSet bool, factory TokenTopicFactory) *TokenTopics {
	allow := make(map[string]bool, len(allowlistTxids))
	for _, txid := range allowlistTxids {
		allow[txid] = true
	}
	return &TokenTopics{eng: eng, allowSet: allowlistSet, allow: allow, factory: factory, registered: map[string]bool{}}
}

// Ensure, under the registrar mutex: non-canonical id -> error "not a canonical Mandala token id: <id>";
// already registered -> true; allowlist set and the txid not in it -> false, nil (factory never called);
// factory error -> false, fmt.Errorf("token topic %s: %w", tokenID, err);
// else RegisterLookupService(ls_<hex>) THEN RegisterTopicManager(tm_<hex>) -> true.
// The lookup goes first so no submit can admit on tm_<hex> before ls_<hex> hears it. A factory that
// returns a nil manager or lookup is a factory error (nothing is registered).
func (r *TokenTopics) Ensure(tokenID string) (registered bool, err error) {
	topic, err := mandala.TokenTopic(tokenID)
	if err != nil {
		return false, err
	}
	lookupName, err := mandala.TokenLookup(tokenID)
	if err != nil {
		return false, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.registered[tokenID] {
		return true, nil
	}
	if r.allowSet && !r.allow[strings.TrimSuffix(tokenID, "_0")] {
		return false, nil
	}
	tm, ls, err := r.factory(tokenID)
	if err == nil && (tm == nil || ls == nil) {
		err = errNilTokenTopic
	}
	if err != nil {
		return false, fmt.Errorf("token topic %s: %w", tokenID, err)
	}
	r.eng.RegisterLookupService(lookupName, ls)
	r.eng.RegisterTopicManager(topic, tm)
	r.registered[tokenID] = true
	return true, nil
}

// Hosted reports whether this registrar registered tokenID.
func (r *TokenTopics) Hosted(tokenID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.registered[tokenID]
}

// Registered returns the registered token ids, sorted.
func (r *TokenTopics) Registered() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Sorted(maps.Keys(r.registered))
}

// Boot reads every source (any error -> 0, fmt.Errorf("token topics boot: %w", err)), Ensures the sorted
// union in order (any Ensure error fails boot the same way) and returns how many are registered.
// Every source is read before the first Ensure, and a ctx that is already done fails before any read,
// so a failed boot registers nothing it could have avoided. The count is len(Registered()) after the
// loop: allowlisted-out ids are not counted.
func (r *TokenTopics) Boot(ctx context.Context, sources ...TokenIDSource) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, fmt.Errorf("token topics boot: %w", err)
	}
	union := map[string]bool{}
	for _, source := range sources {
		ids, err := source(ctx)
		if err != nil {
			return 0, fmt.Errorf("token topics boot: %w", err)
		}
		for _, id := range ids {
			union[id] = true
		}
	}
	for _, id := range slices.Sorted(maps.Keys(union)) {
		if _, err := r.Ensure(id); err != nil {
			return 0, fmt.Errorf("token topics boot: %w", err)
		}
	}
	return len(r.Registered()), nil
}

var deployTxidPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ParseTokenAllowlist: blank (after TrimSpace) -> nil, false, nil. Not a JSON array -> "MANDALA_TOKEN_ALLOWLIST must be a
// JSON array of deploy txids". Element i not a string matching ^[0-9a-f]{64}$ -> "MANDALA_TOKEN_ALLOWLIST[<i>] is not a
// deploy txid (64 lowercase hex)". A repeat -> "MANDALA_TOKEN_ALLOWLIST[<i>] is a duplicate". "[]" -> []string{}, true, nil.
// JSON null is not an array. Input order is kept.
func ParseTokenAllowlist(raw string) (txids []string, set bool, err error) {
	if strings.TrimSpace(raw) == "" {
		return nil, false, nil
	}
	var elems []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &elems); err != nil || elems == nil {
		return nil, false, errors.New("MANDALA_TOKEN_ALLOWLIST must be a JSON array of deploy txids")
	}
	txids = make([]string, 0, len(elems))
	seen := make(map[string]bool, len(elems))
	for i, e := range elems {
		var s string
		if err := json.Unmarshal(e, &s); err != nil || !deployTxidPattern.MatchString(s) {
			return nil, false, fmt.Errorf("MANDALA_TOKEN_ALLOWLIST[%d] is not a deploy txid (64 lowercase hex)", i)
		}
		if seen[s] {
			return nil, false, fmt.Errorf("MANDALA_TOKEN_ALLOWLIST[%d] is a duplicate", i)
		}
		seen[s] = true
		txids = append(txids, s)
	}
	return txids, true, nil
}

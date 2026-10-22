package mandala

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
)

// The color-* query shapes on ls_color_<assetId> (contract §6, 0207:741-775). They exist for interface
// compatibility only: this overlay is not a conforming color service and advertises none (design §3).
const (
	ColorSpendability = "color-spendability"
	ColorAdmission    = "color-admission"

	colorQueryMaxOutpoints = 1000
)

// ErrLookupUnavailable is wrapped around every store or engine read fault of a lookup: the HTTP layer answers it
// 503 ERR_UNAVAILABLE (retryable), never a 400 that a client would take as a final refusal.
var ErrLookupUnavailable = errors.New("lookup unavailable")

func lookupUnavailable(service string, err error) error {
	return fmt.Errorf("%w: %s: %w", ErrLookupUnavailable, service, err)
}

// ColorQuery is a validated color-* query: its type and its outpoints, unique, in query order.
type ColorQuery struct {
	Type      string // ColorSpendability | ColorAdmission
	Outpoints []Outpoint
}

var (
	colorQueryMembers       = []string{"type", "version", "assetId", "topic", "outpoints"}
	colorOutpointPattern    = regexp.MustCompile(`^[0-9a-f]{64}\.(0|[1-9][0-9]{0,9})$`)
	colorOutpointRuleSuffix = " must be <64 lowercase hex txid>.<vout 0..4294967295>"
)

// ParseColorQuery validates a color-* query in a fixed order, each failure an "Invalid lookup query: …" error:
// unexpected members (JS own-key order), missing members (type, version, assetId, topic, outpoints), then type,
// version (the JSON number 1 exactly), assetId (the service's asset), topic (tm_color_<assetId>), the outpoints
// array (1-1000 items), and each outpoint in order (canonical dot form, vout <= 2^32-1, not a duplicate).
func ParseColorQuery(q *lookup.LookupQuestion, service, assetID string) (ColorQuery, error) {
	query, err := RequireLookupQuery(q, service, colorQueryMembers)
	if err != nil {
		return ColorQuery{}, err
	}
	for _, k := range colorQueryMembers {
		if _, ok := query[k]; !ok {
			return ColorQuery{}, lookupInvalid("missing field " + k)
		}
	}
	var typ string
	if json.Unmarshal(query["type"], &typ) != nil || lookupIsNull(query["type"]) || (typ != ColorSpendability && typ != ColorAdmission) {
		return ColorQuery{}, lookupInvalid("type must be color-spendability or color-admission")
	}
	if strings.TrimSpace(string(query["version"])) != "1" {
		return ColorQuery{}, lookupInvalid("version must be 1")
	}
	var asset string
	if json.Unmarshal(query["assetId"], &asset) != nil || lookupIsNull(query["assetId"]) || asset != assetID {
		return ColorQuery{}, lookupInvalid("assetId must be " + assetID + ", the asset " + service + " serves")
	}
	wantTopic := colorTopicPrefix + assetID
	var topic string
	if json.Unmarshal(query["topic"], &topic) != nil || lookupIsNull(query["topic"]) || topic != wantTopic {
		return ColorQuery{}, lookupInvalid("topic must be " + wantTopic)
	}
	var items []json.RawMessage
	raw := strings.TrimSpace(string(query["outpoints"]))
	if !strings.HasPrefix(raw, "[") || json.Unmarshal(query["outpoints"], &items) != nil ||
		len(items) < 1 || len(items) > colorQueryMaxOutpoints {
		return ColorQuery{}, lookupInvalid(fmt.Sprintf("outpoints must be an array of 1-%d outpoints", colorQueryMaxOutpoints))
	}
	ops := make([]Outpoint, 0, len(items))
	seen := make(map[Outpoint]bool, len(items))
	for i, item := range items {
		op, ok := colorOutpoint(item)
		if !ok {
			return ColorQuery{}, lookupInvalid(fmt.Sprintf("outpoints[%d]", i) + colorOutpointRuleSuffix)
		}
		if seen[op] {
			return ColorQuery{}, lookupInvalid(fmt.Sprintf("outpoints[%d] duplicates an earlier outpoint", i))
		}
		seen[op] = true
		ops = append(ops, op)
	}
	return ColorQuery{Type: typ, Outpoints: ops}, nil
}

// colorOutpoint reads one canonical "<64 lowercase hex>.<decimal vout>" string with vout <= 2^32-1.
func colorOutpoint(raw json.RawMessage) (Outpoint, bool) {
	var s string
	if lookupIsNull(raw) || json.Unmarshal(raw, &s) != nil || !colorOutpointPattern.MatchString(s) {
		return Outpoint{}, false
	}
	vout, err := strconv.ParseUint(s[65:], 10, 32)
	if err != nil {
		return Outpoint{}, false
	}
	return Outpoint{Txid: s[:64], OutputIndex: uint32(vout)}, true
}

// assetStateReader is the one StateStore read the spendability answer needs (*Store and memStore).
type assetStateReader interface {
	GetAssetState(ctx context.Context, tokenID string) (AssetAdminState, error)
}

// colorAnswer is the answer to a validated color-* query on topic, as outpoints in query order (a subset of the
// query, so never more than were asked):
//
//	admitted(op)      = the engine holds op on topic (spent or not) AND the txid's admission record exists and is
//	                    not evicted (a provisional record counts: the engine already committed);
//	color-admission   = every admitted op;
//	color-spendability = admitted AND unspent AND not reissued (evictedOutpoints) AND not frozen.
//
// Every read is live (no cache); each txid's record is read once, the asset state at most once. Any read fault
// wraps ErrLookupUnavailable. The answer is read-only, so a crash, a retry or a concurrent query changes nothing.
func colorAnswer(ctx context.Context, q ColorQuery, topic, tokenID string, eng EngineOutputReader, adm AdmissionReader, states assetStateReader) ([]Outpoint, error) {
	service := colorLookupPrefix + tokenID
	spendability := q.Type == ColorSpendability
	type engineState struct{ found, spent bool }
	seenState := make([]engineState, len(q.Outpoints))
	txids := make([]string, 0, len(q.Outpoints))
	admitted := map[string]bool{}
	for i, op := range q.Outpoints {
		_, spent, _, found, err := eng.AdmittedOutputState(ctx, op.Txid, op.OutputIndex, topic)
		if err != nil {
			return nil, lookupUnavailable(service, fmt.Errorf("engine output %s.%d: %w", op.Txid, op.OutputIndex, err))
		}
		seenState[i] = engineState{found: found, spent: spent}
		if !found || (spendability && spent) {
			continue
		}
		if _, queued := admitted[op.Txid]; !queued {
			admitted[op.Txid] = false
			txids = append(txids, op.Txid)
		}
	}
	for _, txid := range txids {
		rec, err := adm.GetAdmission(ctx, txid)
		if err != nil {
			return nil, lookupUnavailable(service, fmt.Errorf("admission record %s: %w", txid, err))
		}
		admitted[txid] = rec != nil && rec.EvictedAt == ""
	}
	var frozen, reissued map[string]bool
	if spendability && len(txids) > 0 {
		state, err := states.GetAssetState(ctx, tokenID)
		if err != nil {
			return nil, lookupUnavailable(service, fmt.Errorf("asset state %s: %w", tokenID, err))
		}
		frozen = make(map[string]bool, len(state.FrozenOutpoints))
		for _, f := range state.FrozenOutpoints {
			frozen[strings.ToLower(f.Outpoint)] = true
		}
		reissued = ctlLowerSet(state.EvictedOutpoints)
	}
	out := make([]Outpoint, 0, len(q.Outpoints))
	for i, op := range q.Outpoints {
		s := seenState[i]
		if !s.found || !admitted[op.Txid] {
			continue
		}
		if spendability {
			key := op.Txid + "." + strconv.FormatUint(uint64(op.OutputIndex), 10)
			if s.spent || frozen[key] || reissued[key] {
				continue
			}
		}
		out = append(out, op)
	}
	return out, nil
}

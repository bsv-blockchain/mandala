package mandala

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/bsv-blockchain/go-sdk/overlay/lookup"
)

// LookupQuery is a validated lookup query: each key's raw JSON value (the last of duplicates).
type LookupQuery map[string]json.RawMessage

var (
	lookupUnsafeKeys  = map[string]bool{"__proto__": true, "constructor": true, "prototype": true}
	lookupTxidPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)
	errLookupShape    = errors.New("lookup query is not a JSON object")
)

func lookupInvalid(message string) error { return errors.New("Invalid lookup query: " + message) }

// RequireLookupQuery ports TS requireLookupQuery (Q2/shared/queryValidation.ts:16-44) with its
// strings: the question, its service, a JSON object query, and every key allowed and safe, judged
// in JS own-key order.
func RequireLookupQuery(q *lookup.LookupQuestion, service string, allowed []string) (LookupQuery, error) {
	if q == nil {
		return nil, lookupInvalid("a question object is required")
	}
	if q.Service != service {
		return nil, errors.New("Lookup service not supported!")
	}
	keys, query, err := lookupObject(q.Query)
	if err != nil {
		return nil, lookupInvalid("query must be an object")
	}
	for _, key := range lookupOwnKeys(keys) {
		if lookupUnsafeKeys[key] || !slices.Contains(allowed, key) {
			return nil, lookupInvalid("unexpected field " + key)
		}
	}
	return query, nil
}

// lookupObject reads one top-level JSON object: its keys in first-occurrence order and each key's
// last value (JSON.parse semantics).
func lookupObject(raw json.RawMessage) ([]string, LookupQuery, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, nil, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, nil, errLookupShape
	}
	query := LookupQuery{}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, nil, errLookupShape
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, nil, err
		}
		if _, seen := query[key]; !seen {
			keys = append(keys, key)
		}
		query[key] = value
	}
	if _, err := dec.Token(); err != nil {
		return nil, nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, nil, errLookupShape
	}
	return keys, query, nil
}

// lookupOwnKeys orders keys as JS Reflect.ownKeys does on an ordinary object: array-index keys
// ascending, then the rest in insertion order.
func lookupOwnKeys(keys []string) []string {
	var indices, names []string
	for _, k := range keys {
		if lookupArrayIndex(k) {
			indices = append(indices, k)
		} else {
			names = append(names, k)
		}
	}
	slices.SortFunc(indices, func(a, b string) int {
		x, _ := strconv.ParseUint(a, 10, 64)
		y, _ := strconv.ParseUint(b, 10, 64)
		return cmp.Compare(x, y)
	})
	return append(indices, names...)
}

func lookupArrayIndex(k string) bool {
	if k == "0" {
		return true
	}
	if k == "" || k[0] < '1' || k[0] > '9' {
		return false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(k, 10, 64)
	return err == nil && n < 4294967295
}

func lookupIsNull(raw json.RawMessage) bool { return string(bytes.TrimSpace(raw)) == "null" }

// TokenID ports the optionalTokenId/requireTokenId pair: absent is not present; anything present
// (null included) must be <64 lowercase hex>_0.
func (q LookupQuery) TokenID(field string) (string, bool, error) {
	raw, ok := q[field]
	if !ok {
		return "", false, nil
	}
	var s string
	if lookupIsNull(raw) || json.Unmarshal(raw, &s) != nil || !IsTokenID(s) {
		return "", true, lookupInvalid(field + " must be a token id (<64 lowercase hex>_0)")
	}
	return s, true, nil
}

// Txid ports readString(maxBytes 64) then requireTxid; the result is lowercased.
func (q LookupQuery) Txid(field string) (string, bool, error) {
	raw, ok := q[field]
	if !ok {
		return "", false, nil
	}
	var s string
	if lookupIsNull(raw) || json.Unmarshal(raw, &s) != nil {
		return "", true, lookupInvalid(field + " must be a string")
	}
	if n := len(s); n < 1 || n > 64 {
		return "", true, lookupInvalid(field + " must contain 1-64 UTF-8 bytes")
	}
	if !lookupTxidPattern.MatchString(s) {
		return "", true, lookupInvalid(field + " must be a transaction ID")
	}
	return strings.ToLower(s), true, nil
}

// Integer ports readInteger: absent or null reads def (JS ??); anything else must be a JSON number
// that is a JS safe integer within [min, max].
func (q LookupQuery) Integer(field string, def, min, max int64) (int64, error) {
	rule := lookupInvalid(fmt.Sprintf("%s must be an integer from %d to %d", field, min, max))
	value := float64(def)
	if raw, ok := q[field]; ok && !lookupIsNull(raw) {
		text := strings.TrimSpace(string(raw))
		if text == "" || !(text[0] == '-' || (text[0] >= '0' && text[0] <= '9')) {
			return 0, rule
		}
		f, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0, rule
		}
		value = f
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value != math.Trunc(value) || math.Abs(value) > maxSafeInteger ||
		value < float64(min) || value > float64(max) {
		return 0, rule
	}
	return int64(value), nil
}

// Bool ports readBoolean: absent reads def; anything but true/false (null included) is refused.
func (q LookupQuery) Bool(field string, def bool) (bool, error) {
	raw, ok := q[field]
	if !ok {
		return def, nil
	}
	switch strings.TrimSpace(string(raw)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, lookupInvalid(field + " must be a boolean")
}

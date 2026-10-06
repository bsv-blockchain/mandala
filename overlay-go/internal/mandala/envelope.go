package mandala

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"unicode/utf8"
)

// IndexedLinkage is one env.inputs / env.outputs entry. Raw is the entry's
// "linkage" value exactly as sent (nil when the key is absent); it is typed
// lazily by ParseLinkage, so a mistyped linkage refuses as ERR_LINKAGE at layer
// B, never as an envelope error (fact base ts-layers §14.2(g)).
type IndexedLinkage struct {
	Index uint64
	Raw   json.RawMessage
}

// AdminEntry is one env.admin entry.
type AdminEntry struct {
	Index   uint64
	Details string // lowercase hex of strict-CBOR details
}

// Envelope is the v3 off-chain values envelope (TS MandalaEnvelope).
type Envelope struct {
	Inputs       []IndexedLinkage
	Outputs      []IndexedLinkage
	Admin        []AdminEntry
	DeploySig    string
	HasDeploySig bool
}

const maxSafeInteger = 9007199254740991 // JS Number.MAX_SAFE_INTEGER

var lowercaseHexPairs = regexp.MustCompile(`^([0-9a-f]{2})+$`)

type rawEntry struct {
	index  uint64
	fields map[string]json.RawMessage
}

func emptyEnvelope() *Envelope {
	return &Envelope{Inputs: []IndexedLinkage{}, Outputs: []IndexedLinkage{}, Admin: []AdminEntry{}}
}

// DecodeEnvelope ports TS decodeEnvelope (ts-stack 37468f290 src/mandala/types.ts:187-201) with JS JSON.parse parity
// (fact base ts-layers §7, §14.2): nil/empty -> empty envelope; BOM or invalid UTF-8 -> "must be UTF-8 JSON"; exact
// lowercase keys (map[string]json.RawMessage, last duplicate wins); null list -> "<label> must be an array"; indices are
// JS safe non-negative integers (1.0, 1e0, -0 valid; 2^53 refused); deploySig null or "" refused; linkage bodies kept
// raw. Order: inputs, outputs, admin (each fully), then admin details, then deploySig. Refusal = rEnvelope(detail).
func DecodeEnvelope(b []byte) (*Envelope, error) {
	if len(b) == 0 {
		return emptyEnvelope(), nil
	}
	// TextDecoder(fatal) refuses invalid UTF-8 anywhere; encoding/json would
	// replace it inside strings, so check first. A leading BOM is valid UTF-8
	// and json.Valid refuses it, as JSON.parse does.
	if !utf8.Valid(b) || !json.Valid(b) {
		return nil, rEnvelope("must be UTF-8 JSON")
	}
	if jsonFirstByte(b) != '{' {
		return nil, rEnvelope("must be an object")
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(b, &payload); err != nil {
		return nil, rEnvelope("must be an object")
	}
	inputs, err := readList(payload, "inputs")
	if err != nil {
		return nil, err
	}
	outputs, err := readList(payload, "outputs")
	if err != nil {
		return nil, err
	}
	admin, err := readList(payload, "admin")
	if err != nil {
		return nil, err
	}
	env := emptyEnvelope()
	for _, e := range inputs {
		env.Inputs = append(env.Inputs, IndexedLinkage{Index: e.index, Raw: e.fields["linkage"]})
	}
	for _, e := range outputs {
		env.Outputs = append(env.Outputs, IndexedLinkage{Index: e.index, Raw: e.fields["linkage"]})
	}
	for _, e := range admin {
		details, ok := jsonString(e.fields["details"])
		if !ok || !lowercaseHexPairs.MatchString(details) {
			return nil, rEnvelope("admin details must be lowercase hex")
		}
		env.Admin = append(env.Admin, AdminEntry{Index: e.index, Details: details})
	}
	raw, present := payload["deploySig"]
	if !present {
		return env, nil
	}
	sig, ok := jsonString(raw)
	if !ok || !lowercaseHexPairs.MatchString(sig) {
		return nil, rEnvelope("deploySig must be lowercase hex")
	}
	env.DeploySig, env.HasDeploySig = sig, true
	return env, nil
}

// readList ports TS readList (types.ts:171-184): only an absent key is an empty
// list; every entry must be an object with a unique safe non-negative integer index.
func readList(payload map[string]json.RawMessage, label string) ([]rawEntry, error) {
	raw, present := payload[label]
	if !present {
		return nil, nil
	}
	if jsonFirstByte(raw) != '[' {
		return nil, rEnvelope(label + " must be an array")
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, rEnvelope(label + " must be an array")
	}
	refusal := rEnvelope(label + " must contain unique non-negative integer indices")
	seen := map[uint64]bool{}
	entries := make([]rawEntry, 0, len(items))
	for _, item := range items {
		if jsonFirstByte(item) != '{' {
			return nil, refusal
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(item, &fields); err != nil {
			return nil, refusal
		}
		index, ok := safeIndex(fields["index"])
		if !ok || seen[index] {
			return nil, refusal
		}
		seen[index] = true
		entries = append(entries, rawEntry{index: index, fields: fields})
	}
	return entries, nil
}

// safeIndex is JS Number.isSafeInteger(v) && v >= 0 over a JSON number literal:
// strconv.ParseFloat rounds exactly as JSON.parse does, so 1.0, 1e0 and -0 are
// valid and 9007199254740992 (or anything rounding to it) is refused. A JSON
// string is never a number (json.Number would accept "12", so check the token).
func safeIndex(raw json.RawMessage) (uint64, bool) {
	t := bytes.TrimSpace(raw)
	if len(t) == 0 || !(t[0] == '-' || (t[0] >= '0' && t[0] <= '9')) {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(t), 64)
	if err != nil || f != math.Trunc(f) || f < 0 || f > maxSafeInteger {
		return 0, false
	}
	return uint64(f), true
}

func jsonString(raw json.RawMessage) (string, bool) {
	if jsonFirstByte(raw) != '"' {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

func jsonFirstByte(b []byte) byte {
	t := bytes.TrimLeft(b, " \t\r\n")
	if len(t) == 0 {
		return 0
	}
	return t[0]
}

// OutputLinkage returns the env.outputs linkage for an output index; found is
// false when no entry names it (Raw may be nil when the entry has no linkage).
func (e *Envelope) OutputLinkage(index uint32) (json.RawMessage, bool) {
	for _, l := range e.Outputs {
		if l.Index == uint64(index) {
			return l.Raw, true
		}
	}
	return nil, false
}

// InputLinkage returns the env.inputs linkage for an input index; found is
// false when no entry names it. TS treats "no entry" as "no input linkage" (the
// step passes) but an entry without a linkage as a failed linkage, so callers
// must check found before Raw.
func (e *Envelope) InputLinkage(index uint32) (json.RawMessage, bool) {
	for _, l := range e.Inputs {
		if l.Index == uint64(index) {
			return l.Raw, true
		}
	}
	return nil, false
}

package mandala

// Admin action details (D §3.3), deploy payloads and authority commitments (D §3.2), all read
// through strict CBOR (D §3.5). Ports TS details.ts (F/ts-layers §5); every detail string ends up
// in a reason and is byte-exact.

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"slices"
	"strconv"
	"unicode/utf8"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"

	"github.com/sirdeggen/mandala/overlay-go/internal/brc162"
)

// AdminKinds are the token admin kinds (TS ADMIN_KINDS, order kept).
var AdminKinds = []string{"issue", "redeem", "reissue", "pause", "unpause", "blockIdentity", "unblockIdentity",
	"allowIdentity", "unallowIdentity", "setAccessMode", "freezeOutput", "unfreezeOutput", "setFeeRate"}

// RegistryKinds are the KYC registry kinds (TS REGISTRY_KINDS).
var RegistryKinds = []string{"admitIdentity", "revokeIdentity"}

// AdminDetails is one decoded admin action. A string field is "" when absent; FeeRatePerKb and
// Reason carry a presence flag because null / "" are values.
type AdminDetails struct {
	Kind            string
	BankRef         []byte // 32 bytes when present
	Outpoint        string // "<display txid>.<vout>"
	Recipient       string // compressed lowercase hex
	IdentityKey     string // compressed lowercase hex
	Mode            string // "denylist" | "allowlist"
	FeeRatePerKb    *int64 // nil with HasFeeRatePerKb = CBOR null
	HasFeeRatePerKb bool
	Reason          string
	HasReason       bool
}

type detSchema struct{ required, optional []string }

var (
	detNoKeys       = detSchema{}
	detIdentityKeys = detSchema{required: []string{"identityKey"}}
	detOutpointKeys = detSchema{required: []string{"outpoint"}}
)

// detSchemas: keys per kind (D §3.3). Every kind also accepts "reason", read last.
var detSchemas = map[string]detSchema{
	"issue":           {optional: []string{"bankRef"}},
	"redeem":          detNoKeys,
	"reissue":         {required: []string{"outpoint", "recipient"}},
	"pause":           detNoKeys,
	"unpause":         detNoKeys,
	"blockIdentity":   detIdentityKeys,
	"unblockIdentity": detIdentityKeys,
	"allowIdentity":   detIdentityKeys,
	"unallowIdentity": detIdentityKeys,
	"setAccessMode":   {required: []string{"mode"}},
	"freezeOutput":    detOutpointKeys,
	"unfreezeOutput":  detOutpointKeys,
	"setFeeRate":      {required: []string{"feeRatePerKb"}},
	"admitIdentity":   detIdentityKeys,
	"revokeIdentity":  detIdentityKeys,
}

const detFeeRateRule = "feeRatePerKb must be a safe integer >= 1 or null"

var detFieldRules = map[string]string{
	"bankRef":      "bankRef must be 32 bytes",
	"outpoint":     "outpoint must be 36 bytes",
	"recipient":    "recipient must be a 33-byte compressed public key",
	"identityKey":  "identityKey must be a 33-byte compressed public key",
	"mode":         "mode must be denylist or allowlist",
	"feeRatePerKb": detFeeRateRule,
	"reason":       "reason must be text",
}

var detHexPairs = regexp.MustCompile(`^([0-9a-f]{2})+$`)

func detBytes(v any, n int) ([]byte, bool) {
	b, ok := v.([]byte)
	return b, ok && len(b) == n
}

// detOutpoint: 36 bytes = the txid in natural order, then the uint32 LE vout.
func detOutpoint(v any) (string, bool) {
	b, ok := detBytes(v, 36)
	if !ok {
		return "", false
	}
	txid := slices.Clone(b[:32])
	slices.Reverse(txid)
	return hex.EncodeToString(txid) + "." + strconv.FormatUint(uint64(binary.LittleEndian.Uint32(b[32:])), 10), true
}

// detPublicKey: 33 bytes, x < p, on the curve, and canonical (re-encoding gives the same bytes).
// TS PublicKey.fromDER reduces x mod p, so an x >= p aliases a valid key under other bytes and is
// refused there by the round trip; go-sdk keeps x unreduced, so the x < p check is explicit here.
func detPublicKey(v any) (string, bool) {
	b, ok := detBytes(v, 33)
	if !ok {
		return "", false
	}
	if new(big.Int).SetBytes(b[1:]).Cmp(ec.S256().Params().P) >= 0 {
		return "", false
	}
	pub, err := ec.ParsePubKey(b)
	if err != nil || !bytes.Equal(pub.Compressed(), b) {
		return "", false
	}
	return hex.EncodeToString(b), true
}

// detFeeRate: CBOR null -> (nil, true); a uint 1..2^53-1 -> its value.
func detFeeRate(v any) (*int64, bool) {
	if v == nil {
		return nil, true
	}
	n, ok := v.(uint64)
	if !ok || n < 1 || n > MaxSafeAmount {
		return nil, false
	}
	x := int64(n)
	return &x, true
}

// detKeyLess orders text keys the strict-CBOR way: shorter UTF-8 first, then bytewise.
func detKeyLess(a, b string) int {
	if len(a) != len(b) {
		return len(a) - len(b)
	}
	return bytes.Compare([]byte(a), []byte(b))
}

func detDecodeMap(b []byte, fail func(string) error) (brc162.CborMap, error) {
	m, err := brc162.DecodeStrictCbor(b)
	if err != nil {
		var se *brc162.StrictCborError
		if errors.As(err, &se) {
			return nil, fail(se.Message)
		}
		return nil, err
	}
	return m, nil
}

// DecodeAdminDetails reads admin details against D §3.3 in TS order: lowercase hex, strict CBOR,
// kind, the first unknown key in CBOR key order, then each key of the kind (required, optional,
// reason), then sha256 of the bytes. Every refusal is rDetailsSchema(outputIndex, detail).
func DecodeAdminDetails(detailsHex string, allowed []string, outputIndex uint32) (AdminDetails, [32]byte, error) {
	fail := func(detail string) error { return rDetailsSchema(outputIndex, detail) }
	if !detHexPairs.MatchString(detailsHex) {
		return AdminDetails{}, [32]byte{}, fail("details must be lowercase hex")
	}
	raw, err := hex.DecodeString(detailsHex)
	if err != nil {
		return AdminDetails{}, [32]byte{}, fail("details must be lowercase hex")
	}
	m, err := detDecodeMap(raw, fail)
	if err != nil {
		return AdminDetails{}, [32]byte{}, err
	}
	kindV, present := m["kind"]
	if !present {
		return AdminDetails{}, [32]byte{}, fail("missing key kind")
	}
	kind, isText := kindV.(string)
	if !isText {
		return AdminDetails{}, [32]byte{}, fail("kind must be text")
	}
	schema, known := detSchemas[kind]
	if !known || !slices.Contains(allowed, kind) {
		return AdminDetails{}, [32]byte{}, fail(fmt.Sprintf("kind %s is not allowed", kind))
	}
	keys := append(append(append([]string{}, schema.required...), schema.optional...), "reason")
	var unknown []string
	for k := range m {
		if k != "kind" && !slices.Contains(keys, k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		slices.SortFunc(unknown, detKeyLess)
		return AdminDetails{}, [32]byte{}, fail("unknown key " + unknown[0])
	}
	d := AdminDetails{Kind: kind}
	for _, field := range keys {
		v, present := m[field]
		if !present {
			if slices.Contains(schema.required, field) {
				return AdminDetails{}, [32]byte{}, fail("missing key " + field)
			}
			continue
		}
		ok := false
		switch field {
		case "bankRef":
			d.BankRef, ok = detBytes(v, 32)
			d.BankRef = slices.Clone(d.BankRef)
		case "outpoint":
			d.Outpoint, ok = detOutpoint(v)
		case "recipient":
			d.Recipient, ok = detPublicKey(v)
		case "identityKey":
			d.IdentityKey, ok = detPublicKey(v)
		case "mode":
			d.Mode, ok = v.(string)
			ok = ok && (d.Mode == "denylist" || d.Mode == "allowlist")
		case "feeRatePerKb":
			d.FeeRatePerKb, ok = detFeeRate(v)
			d.HasFeeRatePerKb = ok
		case "reason":
			d.Reason, ok = v.(string)
			d.HasReason = ok
		}
		if !ok {
			return AdminDetails{}, [32]byte{}, fail(detFieldRules[field])
		}
	}
	return d, sha256.Sum256(raw), nil
}

var (
	detOutpointText    = regexp.MustCompile(`^([0-9a-f]{64})\.(0|[1-9]\d{0,9})$`)
	errDetOutpointText = errors.New("outpoint must be <64 lowercase hex txid>.<vout 0..4294967295>")
)

// EncodeAdminDetails is the TS writer (no schema check): kind plus every present field.
func EncodeAdminDetails(d AdminDetails) ([]byte, error) {
	m := brc162.CborMap{"kind": d.Kind}
	if d.BankRef != nil {
		m["bankRef"] = d.BankRef
	}
	if d.Outpoint != "" {
		g := detOutpointText.FindStringSubmatch(d.Outpoint)
		if g == nil {
			return nil, errDetOutpointText
		}
		vout, err := strconv.ParseUint(g[2], 10, 64)
		if err != nil || vout > 0xffffffff {
			return nil, errDetOutpointText
		}
		txid, _ := hex.DecodeString(g[1])
		slices.Reverse(txid)
		m["outpoint"] = binary.LittleEndian.AppendUint32(txid, uint32(vout))
	}
	for field, value := range map[string]string{"recipient": d.Recipient, "identityKey": d.IdentityKey} {
		if value == "" {
			continue
		}
		b, err := hex.DecodeString(value)
		if err != nil {
			return nil, fmt.Errorf("%s must be hex: %w", field, err)
		}
		m[field] = b
	}
	if d.Mode != "" {
		m["mode"] = d.Mode
	}
	if d.HasFeeRatePerKb {
		if d.FeeRatePerKb == nil {
			m["feeRatePerKb"] = nil
		} else {
			m["feeRatePerKb"] = *d.FeeRatePerKb
		}
	}
	if d.HasReason {
		m["reason"] = d.Reason
	}
	return brc162.EncodeStrictCbor(m)
}

// DeployMetadata is a decoded deploy payload.
type DeployMetadata struct {
	Sym          string
	Dec          int64
	Label        string
	FeeRatePerKb *int64
}

func detLabel(v any, max int) (string, bool) {
	s, ok := v.(string)
	if !ok {
		return "", false
	}
	n := utf8.RuneCountInString(s) // TS [...value].length: code points
	return s, n >= 1 && n <= max
}

// ParseDeployMetadata reads the deploy payload {sym, dec, label, feeRatePerKb?} (unknown keys
// ignored) in TS order: missing payload, non-canonical push, strict CBOR, sym, dec, label, fee
// rate. Every refusal is rDeployPayload(detail).
func ParseDeployMetadata(payload []byte, hasPayload, canonical bool) (DeployMetadata, error) {
	if !hasPayload {
		return DeployMetadata{}, rDeployPayload("missing payload")
	}
	if !canonical {
		return DeployMetadata{}, rDeployPayload("non-canonical payload push")
	}
	m, err := detDecodeMap(payload, func(detail string) error { return rDeployPayload(detail) })
	if err != nil {
		return DeployMetadata{}, err
	}
	need := func(key, rule string, read func(any) bool) error {
		v, present := m[key]
		if !present {
			return rDeployPayload("missing key " + key)
		}
		if !read(v) {
			return rDeployPayload(rule)
		}
		return nil
	}
	var md DeployMetadata
	if err := need("sym", "sym must be text of 1-32 characters", func(v any) (ok bool) { md.Sym, ok = detLabel(v, 32); return }); err != nil {
		return DeployMetadata{}, err
	}
	if err := need("dec", "dec must be an integer 0-18", func(v any) bool {
		n, ok := v.(uint64)
		md.Dec = int64(n)
		return ok && n <= 18
	}); err != nil {
		return DeployMetadata{}, err
	}
	if err := need("label", "label must be text of 1-64 characters", func(v any) (ok bool) { md.Label, ok = detLabel(v, 64); return }); err != nil {
		return DeployMetadata{}, err
	}
	fee, ok := detFeeRate(m["feeRatePerKb"]) // absent reads as null
	if !ok {
		return DeployMetadata{}, rDeployPayload(detFeeRateRule)
	}
	md.FeeRatePerKb = fee
	return md, nil
}

// CommitmentOf reads the authority payload {adm: bytes(32)} (other keys ignored). A missing,
// non-canonical or non-strict payload is simply no commitment, never a refusal.
func CommitmentOf(payload []byte, hasPayload, canonical bool) ([32]byte, bool) {
	if !hasPayload || !canonical {
		return [32]byte{}, false
	}
	m, ok := brc162.TryDecodeStrictCbor(payload)
	if !ok {
		return [32]byte{}, false
	}
	adm, ok := m["adm"].([]byte)
	if !ok || len(adm) != 32 {
		return [32]byte{}, false
	}
	return [32]byte(adm), true
}

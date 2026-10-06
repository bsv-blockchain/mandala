package brc162

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

// brc162.json (ts-stack 37468f290 packages/helpers/ts-templates/test/vectors/brc162.json),
// row schemas per fact base ts-codec §8.
const brc162VectorsPath = "../../testdata/brc162.json"
const brc162VectorsSHA256 = "de5b898bee1a0f848f92e7082a9ca6b9026f9d2801ed7fcdda8ff6eb47e0afb1"

type brc162Vectors struct {
	ID            string              `json:"id"`
	Version       int                 `json:"version"`
	Scripts       []scriptVector      `json:"scripts"`
	PayloadPushes []payloadPushVector `json:"payloadPushes"`
	AmountChunks  []amountChunkVector `json:"amountChunks"`
	RejectScripts []rejectScriptVec   `json:"rejectScripts"`
	StrictCbor    []strictCborVector  `json:"strictCbor"`
	Commitments   []commitmentVector  `json:"commitments"`
}

type scriptVector struct {
	ID         string  `json:"id"`
	TokenID    *string `json:"tokenId"`
	Amount     string  `json:"amount"`
	PubKeyHash string  `json:"pubKeyHash"`
	Payload    *string `json:"payload"`
	ScriptHex  string  `json:"scriptHex"`
	Role       string  `json:"role"`
}

type payloadPushVector struct {
	ID               string `json:"id"`
	ScriptHex        string `json:"scriptHex"`
	Payload          string `json:"payload"`
	PayloadCanonical bool   `json:"payloadCanonical"`
}

type amountChunkVector struct {
	ID       string `json:"id"`
	Amount   string `json:"amount"`
	ChunkHex string `json:"chunkHex"`
}

type rejectScriptVec struct {
	ID          string `json:"id"`
	ScriptHex   string `json:"scriptHex"`
	TokenShaped bool   `json:"tokenShaped"`
	Error       string `json:"error"`
}

type strictCborVector struct {
	ID    string  `json:"id"`
	Hex   string  `json:"hex"`
	Valid bool    `json:"valid"`
	Error *string `json:"error"`
}

type commitmentVector struct {
	ID         string `json:"id"`
	DetailsHex string `json:"detailsHex"`
	Commitment string `json:"commitment"`
}

func loadBRC162Vectors(t *testing.T) brc162Vectors {
	t.Helper()
	b, err := os.ReadFile(brc162VectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var v brc162Vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func mustUint(t *testing.T, s string) uint64 {
	t.Helper()
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatalf("amount %q: %v", s, err)
	}
	return v
}

func TestBRC162VectorsFileIsPinned(t *testing.T) {
	b, err := os.ReadFile(brc162VectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	if got := hex.EncodeToString(sum[:]); got != brc162VectorsSHA256 {
		t.Fatalf("testdata/brc162.json sha256 = %s, want %s (recopy it from ts-stack 37468f290)", got, brc162VectorsSHA256)
	}
	v := loadBRC162Vectors(t)
	if v.ID != "mandala.brc162" || v.Version != 1 {
		t.Fatalf("id/version = %s/%d", v.ID, v.Version)
	}
	counts := []struct {
		name      string
		got, want int
	}{
		{"scripts", len(v.Scripts), 34}, {"payloadPushes", len(v.PayloadPushes), 10},
		{"amountChunks", len(v.AmountChunks), 40}, {"rejectScripts", len(v.RejectScripts), 33},
		{"strictCbor", len(v.StrictCbor), 104}, {"commitments", len(v.Commitments), 19},
	}
	for _, c := range counts {
		if c.got != c.want {
			t.Errorf("%s rows = %d, want %d", c.name, c.got, c.want)
		}
	}
}

func TestVectorScriptsDecodeAndLock(t *testing.T) {
	for _, row := range loadBRC162Vectors(t).Scripts {
		t.Run(row.ID, func(t *testing.T) {
			script := mustHex(t, row.ScriptHex)
			d, err := Decode(script)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if string(d.Role) != row.Role {
				t.Errorf("role = %s, want %s", d.Role, row.Role)
			}
			if row.TokenID == nil {
				if d.TokenID != nil {
					t.Errorf("tokenId = %x, want none", *d.TokenID)
				}
			} else if d.TokenID == nil || TokenIDToString(*d.TokenID) != *row.TokenID {
				t.Errorf("tokenId = %v, want %s", d.TokenID, *row.TokenID)
			}
			if want := mustUint(t, row.Amount); d.Amount != want {
				t.Errorf("amount = %d, want %d", d.Amount, want)
			}
			if row.Payload == nil {
				if d.HasPayload {
					t.Errorf("payload = %x, want none", d.Payload)
				}
			} else if !d.HasPayload || hex.EncodeToString(d.Payload) != *row.Payload {
				t.Errorf("payload = %x (has %v), want %s", d.Payload, d.HasPayload, *row.Payload)
			}
			if !d.PayloadCanonical {
				t.Error("payloadCanonical = false")
			}
			if hex.EncodeToString(d.RestPubKeyHash) != row.PubKeyHash {
				t.Errorf("restPubKeyHash = %x, want %s", d.RestPubKeyHash, row.PubKeyHash)
			}
			p := LockParams{Amount: mustUint(t, row.Amount), PubKeyHash: mustHex(t, row.PubKeyHash)}
			if row.TokenID != nil {
				p.TokenID = *row.TokenID
			}
			if row.Payload != nil {
				p.Payload, p.HasPayload = mustHex(t, *row.Payload), true
			}
			got, err := Lock(p)
			if err != nil {
				t.Fatalf("lock: %v", err)
			}
			if hex.EncodeToString(got) != row.ScriptHex {
				t.Errorf("lock = %x\nwant  %s", got, row.ScriptHex)
			}
		})
	}
}

func TestVectorPayloadPushes(t *testing.T) {
	for _, row := range loadBRC162Vectors(t).PayloadPushes {
		t.Run(row.ID, func(t *testing.T) {
			d, err := Decode(mustHex(t, row.ScriptHex))
			if err != nil {
				t.Fatal(err)
			}
			if !d.HasPayload || hex.EncodeToString(d.Payload) != row.Payload {
				t.Errorf("payload = %x (has %v), want %s", d.Payload, d.HasPayload, row.Payload)
			}
			if d.PayloadCanonical != row.PayloadCanonical {
				t.Errorf("payloadCanonical = %v, want %v", d.PayloadCanonical, row.PayloadCanonical)
			}
		})
	}
}

func TestVectorAmountChunks(t *testing.T) {
	for _, row := range loadBRC162Vectors(t).AmountChunks {
		t.Run(row.ID, func(t *testing.T) {
			amount := mustUint(t, row.Amount)
			if got := hex.EncodeToString(SerializeChunk(EncodeAmountChunk(amount))); got != row.ChunkHex {
				t.Errorf("encode = %s, want %s", got, row.ChunkHex)
			}
			chunks := ParseChunks(mustHex(t, row.ChunkHex))
			if len(chunks) != 1 {
				t.Fatalf("chunkHex parses to %d chunks", len(chunks))
			}
			got, err := DecodeAmountChunk(chunks[0])
			if err != nil || got != amount {
				t.Errorf("decode = %d, %v; want %d", got, err, amount)
			}
		})
	}
}

func TestVectorRejectScripts(t *testing.T) {
	for _, row := range loadBRC162Vectors(t).RejectScripts {
		t.Run(row.ID, func(t *testing.T) {
			script := mustHex(t, row.ScriptHex)
			if got := IsTokenShaped(script); got != row.TokenShaped {
				t.Errorf("IsTokenShaped = %v, want %v", got, row.TokenShaped)
			}
			_, err := Decode(script)
			ce, ok := err.(*CodecError)
			if !ok || ce.Message != row.Error {
				t.Errorf("Decode error = %v, want %q", err, row.Error)
			}
		})
	}
}

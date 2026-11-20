package httpapi_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"sync"
	"testing"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	"github.com/bsv-blockchain/go-sdk/util"

	"github.com/sirdeggen/mandala/overlay-go/internal/httpapi"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandala"
	"github.com/sirdeggen/mandala/overlay-go/internal/mandalatest"
	"github.com/sirdeggen/mandala/overlay-go/internal/wiring"
)

const envelopeNode = "mandala3_test_ts_envelope"

type tsEnvelope struct {
	Keys struct {
		Issuer  string `json:"issuer"`
		Overlay string `json:"overlay"`
	} `json:"keys"`
	PrivateKeys struct {
		Overlay int64 `json:"overlay"`
	} `json:"privateKeys"`
	AssetID string `json:"assetId"`
	Txs     []struct {
		Name              string              `json:"name"`
		Txid              string              `json:"txid"`
		Topics            []string            `json:"topics"`
		AtomicBeefHex     string              `json:"atomicBeefHex"`
		OffChainValuesHex string              `json:"offChainValuesHex"`
		OutputsToAdmit    map[string][]uint32 `json:"outputsToAdmit"`
	} `json:"txs"`
}

// TestTSEnvelopeAdmitted is the contract §10 ENVELOPE seam: the lib-built chain (deploy with the B7 issuer-v1-only req →
// issue → payout → a B7 host-built hand-over with blinded recipient and owned change) is admitted by the engine flow
// with exactly the outputs the lib recorded, every color entry carrying a verifying attestation.
func TestTSEnvelopeAdmitted(t *testing.T) {
	raw, err := os.ReadFile("../mandala/testdata/1color-envelope.json")
	if err != nil {
		t.Fatal(err)
	}
	var f tsEnvelope
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	priv, _ := ec.PrivateKeyFromBytes(new(big.Int).SetInt64(f.PrivateKeys.Overlay).FillBytes(make([]byte, 32)))
	if hex.EncodeToString(priv.PubKey().Compressed()) != f.Keys.Overlay {
		t.Fatal("fixture overlay key mismatch")
	}
	e2eDB(t, envelopeNode)
	ctx := context.Background()
	app, err := wiring.Build(ctx, wiring.Config{
		NodeName:         envelopeNode,
		ServerPrivKeyHex: hex.EncodeToString(priv.Serialize()),
		HostingURL:       "http://localhost:8081",
		MongoURL:         "mongodb://localhost:27017",
		Network:          "test",
		IssuerKeys:       []string{f.Keys.Issuer},
	}, wiring.WithChainTracker(mandalatest.ScriptsOnlyTracker()))
	if err != nil {
		t.Fatalf("wiring.Build: %v", err)
	}
	var once sync.Once
	t.Cleanup(func() {
		once.Do(func() {
			app.Close()
			_ = app.Mongo.Client().Disconnect(context.Background())
		})
	})
	if err := app.Start(ctx); err != nil {
		t.Fatalf("App.Start: %v", err)
	}
	h := httpapi.New(app)
	for _, tx := range f.Txs {
		beef, _ := hex.DecodeString(tx.AtomicBeefHex)
		off, _ := hex.DecodeString(tx.OffChainValuesHex)
		body := append(util.VarInt(uint64(len(beef))).Bytes(), beef...)
		body = append(body, off...)
		hdr, _ := json.Marshal(tx.Topics)
		req := httptest.NewRequest(http.MethodPost, "/submit", bytes.NewReader(body))
		req.Header.Set("X-Topics", string(hdr))
		req.Header.Set("x-includes-off-chain-values", "true")
		req.Header.Set("Content-Type", "application/octet-stream")
		resp, err := h.Test(req, -1)
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		_, _ = out.ReadFrom(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("%s %s: %d %s", tx.Name, tx.Txid, resp.StatusCode, out.String())
		}
		var steak map[string]struct {
			OutputsToAdmit     []uint32 `json:"outputsToAdmit"`
			AdmissionSignature string   `json:"admissionSignature"`
		}
		if err := json.Unmarshal(out.Bytes(), &steak); err != nil {
			t.Fatal(err)
		}
		for topic, want := range tx.OutputsToAdmit {
			got := steak[topic]
			if !slices.Equal(got.OutputsToAdmit, want) {
				t.Fatalf("%s on %s admitted %v, want %v", tx.Name, topic, got.OutputsToAdmit, want)
			}
			if topic != mandala.MandalaTopic && !mandala.VerifyAttestation(topic, tx.Txid, want, got.AdmissionSignature, f.Keys.Overlay) {
				t.Fatal(fmt.Sprintf("%s on %s: attestation does not verify", tx.Name, topic))
			}
		}
	}
}

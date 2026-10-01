// Package arcade is the Go mirror of @bsv/overlay-express's ArcadeProvider
// and ChaintracksProvider (Task 16): a transaction.Broadcaster that posts to
// an Arcade-compatible /tx endpoint and a chaintracker.ChainTracker that
// reads headers from a go-chaintracks-compatible service, both reachable at
// the same Arcade deployment by default.
package arcade

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/bsv-blockchain/go-sdk/transaction"
)

// terminalStatuses mirrors ArcadeProvider.ts's TERMINAL_STATUSES set: Arcade
// txStatus values that will never resolve to a successful broadcast, so the
// caller must treat them as a failure even when the HTTP status was 2xx.
var terminalStatuses = map[string]bool{
	"DOUBLE_SPEND_ATTEMPTED": true,
	"REJECTED":               true,
	"INVALID":                true,
	"MALFORMED":              true,
	"MINED_IN_STALE_BLOCK":   true,
}

// IsTerminalStatus reports whether an Arcade txStatus/extraInfo pair
// indicates a broadcast (or a later /arc-ingest callback) that will never
// succeed — port of ArcadeProvider.ts's isTerminalArcStatus, shared by the
// Broadcaster here and the /arc-ingest handler in internal/httpapi.
func IsTerminalStatus(status, extraInfo string) bool {
	upperStatus := strings.ToUpper(status)
	upperExtra := strings.ToUpper(extraInfo)
	return terminalStatuses[upperStatus] || strings.Contains(upperStatus, "ORPHAN") || strings.Contains(upperExtra, "ORPHAN")
}

// IsBroadcastFailureErr reports whether err is (or wraps) the
// *transaction.BroadcastFailure a transaction.Broadcaster produces. This is
// the submit handler's classification for "the engine marked inputs spent
// but the broadcast failed": go-overlay-services v1.3.7's broadcastIfNeeded
// (engine.go:575-584) returns the Broadcaster's failure value directly as
// Submit's error (`return failure` — *transaction.BroadcastFailure has an
// Error() method), and nothing else in the engine or this codebase creates
// values of that type — the Broadcaster interface pins the failure type, so
// we control both the producer (Broadcaster above) and this matcher.
// errors.As keeps the match robust should a future engine version wrap it.
func IsBroadcastFailureErr(err error) bool {
	var failure *transaction.BroadcastFailure
	return errors.As(err, &failure)
}

// arcTxResponse is the subset of Arcade's /tx response body this package
// reads (ArcadeProvider.ts's ArcadeTxResponse).
type arcTxResponse struct {
	Txid      string `json:"txid"`
	TxStatus  string `json:"txStatus"`
	ExtraInfo string `json:"extraInfo"`
	Detail    string `json:"detail"`
	Reason    string `json:"reason"`
	Error     string `json:"error"`
}

// describe picks the best available human-readable failure text, mirroring
// ArcadeProvider.ts's parseDescription fallback chain.
func (r arcTxResponse) describe(fallback string) string {
	switch {
	case r.Detail != "":
		return r.Detail
	case r.Reason != "":
		return r.Reason
	case r.Error != "":
		return r.Error
	}
	if joined := strings.TrimSpace(r.TxStatus + " " + r.ExtraInfo); joined != "" {
		return joined
	}
	return fallback
}

// rawTxForArcade renders tx the way Arcade wants it: EF (extended format,
// which embeds each input's previous output so Arcade can validate without
// looking anything up) when every input carries a source transaction/output,
// falling back to plain hex otherwise (ArcadeProvider.ts's rawTxForArcade).
func rawTxForArcade(tx *transaction.Transaction) string {
	ef, err := tx.EFHex()
	if err != nil {
		// The expected case is transaction.ErrEmptyPreviousTx (an input
		// missing SourceTransaction/output), matching the one fallback
		// case ArcadeProvider.ts special-cases; any other EFHex error is
		// vanishingly unlikely here (EF succeeded once all inputs pass the
		// same check), so this still degrades to plain hex rather than
		// failing the broadcast outright.
		return tx.Hex()
	}
	return ef
}

// Broadcaster posts transactions to an Arcade-compatible /tx endpoint and
// classifies the response — including terminal txStatus values returned
// with an HTTP 200 — into go-sdk's Broadcaster success/failure shapes.
// Implements transaction.Broadcaster.
type Broadcaster struct {
	baseURL       string
	apiKey        string
	callbackURL   string
	callbackToken string
	client        *http.Client
}

var _ transaction.Broadcaster = (*Broadcaster)(nil)

// NewBroadcaster builds an Arcade-backed Broadcaster. apiKey, callbackURL
// and callbackToken are optional (empty string omits the corresponding
// header); client defaults to http.DefaultClient when nil.
func NewBroadcaster(baseURL, apiKey, callbackURL, callbackToken string, client *http.Client) *Broadcaster {
	if client == nil {
		client = http.DefaultClient
	}
	return &Broadcaster{
		baseURL:       strings.TrimRight(baseURL, "/"),
		apiKey:        apiKey,
		callbackURL:   callbackURL,
		callbackToken: callbackToken,
		client:        client,
	}
}

// Broadcast implements transaction.Broadcaster using context.Background().
func (b *Broadcaster) Broadcast(tx *transaction.Transaction) (*transaction.BroadcastSuccess, *transaction.BroadcastFailure) {
	return b.BroadcastCtx(context.Background(), tx)
}

// BroadcastCtx POSTs {"rawTx": <hex>} to {baseURL}/tx and classifies the
// result (ArcadeProvider.ts's broadcast()): non-2xx is always a failure;
// 2xx with a terminal txStatus in the body is also a failure; anything else
// 2xx is a success.
func (b *Broadcaster) BroadcastCtx(ctx context.Context, tx *transaction.Transaction) (*transaction.BroadcastSuccess, *transaction.BroadcastFailure) {
	payload, err := json.Marshal(map[string]string{"rawTx": rawTxForArcade(tx)})
	if err != nil {
		return nil, &transaction.BroadcastFailure{Code: "500", Description: err.Error()}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.baseURL+"/tx", bytes.NewReader(payload))
	if err != nil {
		return nil, &transaction.BroadcastFailure{Code: "500", Description: err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if b.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+b.apiKey)
	}
	if b.callbackURL != "" {
		req.Header.Set("X-CallbackUrl", b.callbackURL)
	}
	if b.callbackToken != "" {
		req.Header.Set("X-CallbackToken", b.callbackToken)
	}

	resp, err := b.client.Do(req)
	if err != nil {
		return nil, &transaction.BroadcastFailure{Code: "500", Description: err.Error()}
	}
	defer func() { _ = resp.Body.Close() }()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, &transaction.BroadcastFailure{Code: "500", Description: err.Error()}
	}

	var data arcTxResponse
	_ = json.Unmarshal(rawBody, &data) // tolerate empty/non-JSON bodies; data stays zero-valued

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		code := data.TxStatus
		if code == "" {
			code = fmt.Sprintf("%d", resp.StatusCode)
		}
		return nil, &transaction.BroadcastFailure{Code: code, Description: data.describe(resp.Status)}
	}

	if IsTerminalStatus(data.TxStatus, data.ExtraInfo) {
		code := data.TxStatus
		if code == "" {
			code = "UNKNOWN"
		}
		return nil, &transaction.BroadcastFailure{
			Code:        code,
			Description: strings.TrimSpace(data.TxStatus + " " + data.ExtraInfo),
		}
	}

	txid := data.Txid
	if txid == "" {
		txid = tx.TxID().String()
	}
	return &transaction.BroadcastSuccess{
		Txid:    txid,
		Message: strings.TrimSpace(data.TxStatus + " " + data.ExtraInfo),
	}, nil
}

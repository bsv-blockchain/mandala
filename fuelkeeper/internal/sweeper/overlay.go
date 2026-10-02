package sweeper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// overlayTimeout bounds every overlay call, whatever the http.Client says.
const overlayTimeout = 10 * time.Second

// maxOverlayBody caps how much of an overlay response is read.
const maxOverlayBody = 64 << 10

// codeShape is the overlay's malformed-request verdict: final for the
// request, but it says nothing about the transaction, so it is never read as
// a final refusal of the tx.
const codeShape = "ERR_SHAPE"

// noRecordPrefix starts the message of the overlay's own 404 for a txid it
// has no admission for — {"status":"error","message":"no admission on record
// for <txid>"}, verbatim on both stacks (overlay/src/admissionRoute.ts,
// overlay-go/internal/httpapi/admin.go). It carries no code; overlay-go's
// unknown-route 404 does ({"status":"error","code":"ERR_ROUTE_NOT_FOUND"}),
// so the message, not a code, is what identifies a real "no record".
const noRecordPrefix = "no admission on record for "

// maxErrSnippet caps how much of an unusable body goes into an error.
const maxErrSnippet = 256

// HTTPOption configures NewHTTPOverlayClient.
type HTTPOption func(*httpOverlayClient)

// WithFuelKey also sends X-Fuel-Key on POST /fuel/resettle. Spec §5.2/§6.2
// put that internal route under X-Fuel-Key, while the plan (Task 8) sends the
// admin bearer; with this option both headers go out, so either overlay
// guard accepts the call.
func WithFuelKey(key string) HTTPOption {
	return func(c *httpOverlayClient) { c.fuelKey = key }
}

type httpOverlayClient struct {
	base    string
	token   string
	fuelKey string
	hc      *http.Client
}

// NewHTTPOverlayClient talks to the overlay at baseURL with the admin bearer
// adminToken. A nil hc gets a 10 s client. An empty baseURL returns a nil
// OverlayClient, which New treats as "rule 4 disabled".
func NewHTTPOverlayClient(baseURL, adminToken string, hc *http.Client, opts ...HTTPOption) OverlayClient {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return nil
	}
	if hc == nil {
		hc = &http.Client{Timeout: overlayTimeout}
	}
	c := &httpOverlayClient{base: base, token: adminToken, hc: hc}
	for _, o := range opts {
		o(c)
	}
	return c
}

func (c *httpOverlayClient) do(ctx context.Context, method, path string, body []byte, fuelKey bool) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, overlayTimeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return 0, nil, fmt.Errorf("overlay %s %s: %w", method, path, err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if fuelKey && c.fuelKey != "" {
		req.Header.Set("X-Fuel-Key", c.fuelKey)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("overlay %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxOverlayBody))
	if err != nil {
		return 0, nil, fmt.Errorf("overlay %s %s: read body: %w", method, path, err)
	}
	return resp.StatusCode, b, nil
}

// AdmissionStatus is GET {base}/admin/admission/{txid}.
//
// finalReject is true only for a 400 whose body is the overlay's JSON error
// with a code, "retryable": false, and a code other than ERR_SHAPE; no other
// status is ever final (a 401/403 is the keeper's credentials, not the tx).
//
// A 404 is returned as a status only when its body is the overlay's own
// "no admission on record" answer. Any other 404 (a proxy's HTML page, an
// unmounted route, an empty body) says nothing about the tx and returns err,
// like a transport failure or timeout: nothing happens this tick.
func (c *httpOverlayClient) AdmissionStatus(ctx context.Context, txid string) (int, bool, error) {
	code, body, err := c.do(ctx, http.MethodGet, "/admin/admission/"+url.PathEscape(txid), nil, false)
	if err != nil {
		return 0, false, err
	}
	var v struct {
		Status    string `json:"status"`
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable *bool  `json:"retryable"`
	}
	isJSON := json.Unmarshal(body, &v) == nil
	switch code {
	case http.StatusBadRequest:
		final := isJSON && v.Status == "error" && v.Code != "" && v.Code != codeShape && v.Retryable != nil && !*v.Retryable
		return code, final, nil
	case http.StatusNotFound:
		if isJSON && v.Status == "error" && strings.HasPrefix(v.Message, noRecordPrefix) {
			return code, false, nil
		}
		return code, false, fmt.Errorf("overlay admission %s: HTTP 404 is not the overlay's no-record answer (proxy or unmounted route?): %q",
			txid, snippet(body))
	default:
		return code, false, nil
	}
}

func snippet(b []byte) string {
	if len(b) > maxErrSnippet {
		b = b[:maxErrSnippet]
	}
	return string(b)
}

// Resettle is POST {base}/fuel/resettle {"txid": txid}; non-2xx is an error.
func (c *httpOverlayClient) Resettle(ctx context.Context, txid string) error {
	body, err := json.Marshal(map[string]string{"txid": txid})
	if err != nil {
		return fmt.Errorf("overlay resettle: %w", err)
	}
	code, resp, err := c.do(ctx, http.MethodPost, "/fuel/resettle", body, true)
	if err != nil {
		return err
	}
	if code < 200 || code > 299 {
		return fmt.Errorf("overlay resettle %s: HTTP %d: %s", txid, code, snippet(resp))
	}
	return nil
}

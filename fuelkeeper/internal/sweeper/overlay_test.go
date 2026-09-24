package sweeper

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type seenRequest struct {
	method, path, auth, fuelKey, contentType string
	body                                     []byte
}

func overlayServer(t *testing.T, status int, body string) (*httptest.Server, func() []seenRequest) {
	t.Helper()
	var (
		mu   sync.Mutex
		seen []seenRequest
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, seenRequest{r.Method, r.URL.EscapedPath(), r.Header.Get("Authorization"), r.Header.Get("X-Fuel-Key"), r.Header.Get("Content-Type"), b})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv, func() []seenRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]seenRequest(nil), seen...)
	}
}

func TestHTTPOverlay_AdmissionStatus(t *testing.T) {
	txid := strings.Repeat("ab", 32)
	for name, tc := range map[string]struct {
		status    int
		body      string
		wantFinal bool
		wantErr   bool // no usable answer: the sweeper does nothing this tick
	}{
		"admitted": {200, `{"txid":"` + txid + `","outputsToAdmit":[0]}`, false, false},
		// 410 is acted on by its status; only a 400 is ever a final refusal.
		"evicted":                    {410, `{"status":"error","code":"ERR_EVICTED","retryable":false,"description":"x"}`, false, false},
		"final refusal":              {400, `{"status":"error","code":"ERR_TOPIC_REJECTED","retryable":false,"description":"x"}`, true, false},
		"shape is not final":         {400, `{"status":"error","code":"ERR_SHAPE","retryable":false,"description":"x"}`, false, false},
		"retryable 400":              {400, `{"status":"error","code":"ERR_X","retryable":true}`, false, false},
		"400 without flag":           {400, `{"status":"error","code":"ERR_X"}`, false, false},
		"400 without code":           {400, `{"status":"error","retryable":false}`, false, false},
		"400 not the overlay shape":  {400, `{"code":"ERR_X","retryable":false}`, false, false},
		"400 not json":               {400, `nope`, false, false},
		"unavailable":                {503, `{"status":"error","code":"ERR_UNAVAILABLE","retryable":false}`, false, false},
		"401 is never final":         {401, `{"status":"error","code":"ERR_UNAUTHORIZED","retryable":false}`, false, false},
		"403 is never final":         {403, `{"status":"error","code":"ERR_FORBIDDEN","retryable":false}`, false, false},
		"409 is never final":         {409, `{"status":"error","code":"ERR_X","retryable":false}`, false, false},
		"404 overlay no-record json": {404, `{"status":"error","message":"no admission on record for ` + txid + `"}`, false, false},
		"404 html from a proxy":      {404, `<html><body><h1>404 Not Found</h1></body></html>`, false, true},
		"404 plain text":             {404, `404 page not found`, false, true},
		"404 unmounted route":        {404, `{"status":"error","code":"ERR_ROUTE_NOT_FOUND","description":"Route not found."}`, false, true},
		"404 other json":             {404, `{"message":"Not Found"}`, false, true},
		"empty 404 body":             {404, ``, false, true},
	} {
		t.Run(name, func(t *testing.T) {
			srv, seen := overlayServer(t, tc.status, tc.body)
			c := NewHTTPOverlayClient(srv.URL+"/", "tok", nil)
			code, final, err := c.AdmissionStatus(context.Background(), txid)
			if tc.wantErr {
				require.Error(t, err, "a 404 that is not the overlay's answer is no answer")
			} else {
				require.NoError(t, err)
				require.Equal(t, tc.status, code)
			}
			require.Equal(t, tc.wantFinal, final)
			reqs := seen()
			require.Len(t, reqs, 1)
			require.Equal(t, http.MethodGet, reqs[0].method)
			require.Equal(t, "/admin/admission/"+txid, reqs[0].path)
			require.Equal(t, "Bearer tok", reqs[0].auth)
			require.Empty(t, reqs[0].fuelKey, "the fuel key only goes to /fuel/resettle")
		})
	}
}

func TestHTTPOverlay_TransportErrorsAndTimeouts(t *testing.T) {
	srv, _ := overlayServer(t, 200, `{}`)
	url := srv.URL
	srv.Close()
	_, _, err := NewHTTPOverlayClient(url, "tok", nil).AdmissionStatus(context.Background(), strings.Repeat("ab", 32))
	require.Error(t, err, "connection refused is an error, not a status")

	block := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-block:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(block); slow.Close() })
	c := NewHTTPOverlayClient(slow.URL, "tok", &http.Client{Timeout: 50 * time.Millisecond})
	_, _, err = c.AdmissionStatus(context.Background(), strings.Repeat("ab", 32))
	require.Error(t, err, "a timeout is an error, never a verdict")
	require.Error(t, c.Resettle(context.Background(), strings.Repeat("ab", 32)))
}

func TestHTTPOverlay_Resettle(t *testing.T) {
	txid := strings.Repeat("cd", 32)
	srv, seen := overlayServer(t, http.StatusNoContent, ``)
	c := NewHTTPOverlayClient(srv.URL, "tok", nil, WithFuelKey("fuel-key"))
	require.NoError(t, c.Resettle(context.Background(), txid))
	reqs := seen()
	require.Len(t, reqs, 1)
	require.Equal(t, http.MethodPost, reqs[0].method)
	require.Equal(t, "/fuel/resettle", reqs[0].path)
	require.Equal(t, "Bearer tok", reqs[0].auth)
	require.Equal(t, "fuel-key", reqs[0].fuelKey)
	require.Equal(t, "application/json", reqs[0].contentType)
	var body map[string]string
	require.NoError(t, json.Unmarshal(reqs[0].body, &body))
	require.Equal(t, map[string]string{"txid": txid}, body)

	bad, _ := overlayServer(t, http.StatusInternalServerError, `{"status":"error"}`)
	err := NewHTTPOverlayClient(bad.URL, "tok", nil).Resettle(context.Background(), txid)
	require.ErrorContains(t, err, "HTTP 500")
}

func TestHTTPOverlay_EmptyBaseIsNil(t *testing.T) {
	require.Nil(t, NewHTTPOverlayClient("", "tok", nil))
	require.Nil(t, NewHTTPOverlayClient("  ", "tok", nil))
}

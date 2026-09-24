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
	}{
		"admitted":            {200, `{"txid":"` + txid + `","outputsToAdmit":[0]}`, false},
		"evicted":             {410, `{"status":"error","code":"ERR_EVICTED","retryable":false,"description":"x"}`, true},
		"final refusal":       {400, `{"status":"error","code":"ERR_TOPIC_REJECTED","retryable":false,"description":"x"}`, true},
		"shape is not final":  {400, `{"status":"error","code":"ERR_SHAPE","retryable":false,"description":"x"}`, false},
		"retryable 400":       {400, `{"status":"error","code":"ERR_X","retryable":true}`, false},
		"400 without flag":    {400, `{"status":"error","code":"ERR_X"}`, false},
		"400 not json":        {400, `nope`, false},
		"not found":           {404, `{"status":"error","message":"no admission on record for ` + txid + `"}`, false},
		"unavailable":         {503, `{"status":"error","code":"ERR_UNAVAILABLE","retryable":false}`, false},
		"unauthorized is 4xx": {401, `{"status":"error","code":"ERR_UNAUTHORIZED","retryable":false}`, true},
		"empty 404 body":      {404, ``, false},
	} {
		t.Run(name, func(t *testing.T) {
			srv, seen := overlayServer(t, tc.status, tc.body)
			c := NewHTTPOverlayClient(srv.URL+"/", "tok", nil)
			code, final, err := c.AdmissionStatus(context.Background(), txid)
			require.NoError(t, err)
			require.Equal(t, tc.status, code)
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

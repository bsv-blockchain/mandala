package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealth_OK(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, nil)
	for _, path := range []string{"/health", "/health/live", "/health/ready"} {
		t.Run(path, func(t *testing.T) {
			resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, path, nil))
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body: %s)", resp.StatusCode, readRawBody(t, resp))
			}
			if body := decodeJSON(t, resp); body["status"] != "ok" {
				t.Fatalf("body = %v, want status:ok", body)
			}
		})
	}
}

func TestHealthReady_PingFailureIs503(t *testing.T) {
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, func(context.Context) error { return errors.New("mongo down") })
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if body := decodeJSON(t, resp); body["status"] != "error" {
		t.Fatalf("body = %v, want status:error", body)
	}
}

func TestHealthReady_TimeoutBeforeBlockingPing(t *testing.T) {
	blockingPinger := func(ctx context.Context) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Second):
			return nil
		}
	}
	app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, blockingPinger)
	start := time.Now()
	resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("handler took %v, want < 5s (the 2 s ping timeout is not applied)", elapsed)
	}
}

// V-9: the owner-index check degrades readiness but keeps it 200; a failing ping still wins with 503.
func TestHealthReady_ReadinessBodies(t *testing.T) {
	degraded := func() (string, string) { return "degraded", "owner index not yet reconciled" }
	cases := []struct {
		name      string
		readiness Readiness
		ping      Pinger
		status    int
		body      string
	}{
		{"no check", nil, nil, 200, `{"status":"ok"}`},
		{"check ok", func() (string, string) { return "ok", "" }, nil, 200, `{"status":"ok"}`},
		{"check degraded", degraded, nil, 200,
			`{"status":"degraded","checks":[{"name":"mandala-owner-index","status":"degraded","message":"owner index not yet reconciled"}]}`},
		{"ping fails first", degraded, func(context.Context) error { return errors.New("down") }, 503, `{"status":"error"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			app := newServer(&stubSubmitter{}, &stubLookuper{}, nil, c.ping, WithReadiness(c.readiness))
			resp := doRequest(t, app, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
			if got := strings.TrimSpace(string(readRawBody(t, resp))); resp.StatusCode != c.status || got != c.body {
				t.Fatalf("%d %s, want %d %s", resp.StatusCode, got, c.status, c.body)
			}
		})
	}
}

// New(app) wires the owner index into /health/ready: degraded until the boot run, ok after Start.
func TestHealthReady_FollowsTheOwnerIndex(t *testing.T) {
	f := newFlowApp(t, "mandala3_test_httpapi_health")
	resp := doRequest(t, f.srv, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if body := decodeJSON(t, resp); resp.StatusCode != 200 || body["status"] != "degraded" {
		t.Fatalf("before Start: %d %v", resp.StatusCode, body)
	}
	if err := f.app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	resp = doRequest(t, f.srv, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if got := strings.TrimSpace(string(readRawBody(t, resp))); resp.StatusCode != 200 || got != `{"status":"ok"}` {
		t.Fatalf("after Start: %d %s", resp.StatusCode, got)
	}
}

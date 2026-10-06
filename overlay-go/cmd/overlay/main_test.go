package main

import (
	"os"
	"slices"
	"strings"
	"testing"
)

const (
	keyG  = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" // secp256k1 G
	key2G = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5" // 2G
)

// envMap adapts a map into the envLookup shape loadConfig expects, so tests never touch the process environment.
func envMap(vars map[string]string) envLookup {
	return func(name string) string { return vars[name] }
}

// requiredEnv is the minimal set loadConfig needs; MANDALA_ISSUER_KEYS is required since Q3.
func requiredEnv() map[string]string {
	return map[string]string{
		"NODE_NAME":           "mandala_q3",
		"SERVER_PRIVATE_KEY":  "deadbeef",
		"HOSTING_URL":         "http://localhost:8081",
		"MONGO_URL":           "mongodb://localhost:27017",
		"NETWORK":             "test",
		"MANDALA_ISSUER_KEYS": `["` + keyG + `"]`,
	}
}

func TestLoadConfigReadsArcadeCallbackToken(t *testing.T) {
	vars := requiredEnv()
	vars["ARCADE_CALLBACK_TOKEN"] = "shh-secret"
	cfg, err := loadConfig(envMap(vars))
	if err != nil || cfg.ArcadeCallbackToken != "shh-secret" {
		t.Fatalf("cfg.ArcadeCallbackToken = %q, err %v", cfg.ArcadeCallbackToken, err)
	}
}

func TestLoadConfigArcadeCallbackTokenDefaultsEmpty(t *testing.T) {
	cfg, err := loadConfig(envMap(requiredEnv()))
	if err != nil || cfg.ArcadeCallbackToken != "" {
		t.Fatalf("cfg.ArcadeCallbackToken = %q, err %v", cfg.ArcadeCallbackToken, err)
	}
}

func TestLoadConfigMissingRequiredVarFails(t *testing.T) {
	vars := requiredEnv()
	delete(vars, "NODE_NAME")
	if _, err := loadConfig(envMap(vars)); err == nil || err.Error() != "missing required environment variable: NODE_NAME" {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadConfigReadsAdminAPIToken(t *testing.T) {
	vars := requiredEnv()
	vars["ADMIN_API_TOKEN"] = "shh-console-token"
	cfg, err := loadConfig(envMap(vars))
	if err != nil || cfg.AdminAPIToken != "shh-console-token" {
		t.Fatalf("cfg.AdminAPIToken = %q, err %v", cfg.AdminAPIToken, err)
	}
}

func TestLoadConfigAdminAPITokenDefaultsEmpty(t *testing.T) {
	cfg, err := loadConfig(envMap(requiredEnv()))
	if err != nil || cfg.AdminAPIToken != "" {
		t.Fatalf("cfg.AdminAPIToken = %q, err %v", cfg.AdminAPIToken, err)
	}
}

func TestLoadConfigReadsAdminCORSOrigins(t *testing.T) {
	vars := requiredEnv()
	vars["ADMIN_CORS_ORIGINS"] = "https://a.example, https://b.example"
	cfg, err := loadConfig(envMap(vars))
	if err != nil || !slices.Equal(cfg.AdminCORSOrigins, []string{"https://a.example", "https://b.example"}) {
		t.Fatalf("AdminCORSOrigins = %v, err %v", cfg.AdminCORSOrigins, err)
	}
}

func TestLoadConfigAdminCORSOriginsDefaultsToHostingURL(t *testing.T) {
	cfg, err := loadConfig(envMap(requiredEnv()))
	want := []string{"http://localhost:8081", "http://127.0.0.1:5173", "http://localhost:5173"}
	if err != nil || !slices.Equal(cfg.AdminCORSOrigins, want) {
		t.Fatalf("AdminCORSOrigins = %v, err %v", cfg.AdminCORSOrigins, err)
	}
}

// The TS parseIssuerKeys strings (overlay/src/bootConfig.ts:30-46, F/p2-parity §6), byte for byte, in input order.
func TestLoadConfigIssuerKeys(t *testing.T) {
	notCompressed := "MANDALA_ISSUER_KEYS[0] is not a compressed public key (02/03 + 64 hex)"
	for _, c := range []struct {
		name, raw, wantErr string
		want               []string
	}{
		{"unset", "", "MANDALA_ISSUER_KEYS is required (JSON array of compressed identity public keys)", nil},
		{"blank", "   ", "MANDALA_ISSUER_KEYS is required (JSON array of compressed identity public keys)", nil},
		{"not JSON", "02abc", "MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys", nil},
		{"object", `{"k":1}`, "MANDALA_ISSUER_KEYS must be a JSON array of compressed public keys", nil},
		{"empty array", "[]", "MANDALA_ISSUER_KEYS must name at least one issuer key", nil},
		{"number element", "[7]", notCompressed, nil},
		{"uncompressed", `["04` + strings.Repeat("ab", 64) + `"]`, notCompressed, nil},
		{"uppercase", `["02` + strings.ToUpper(keyG[2:]) + `"]`, "MANDALA_ISSUER_KEYS[0] must be lowercase hex", nil},
		{"no curve point (x = 5)", `["02` + strings.Repeat("00", 31) + `05"]`, "MANDALA_ISSUER_KEYS[0] is not a valid public key", nil},
		{"duplicate", `["` + keyG + `","` + keyG + `"]`, "MANDALA_ISSUER_KEYS[1] is a duplicate", nil},
		{"second element bad", `["` + keyG + `",7]`, "MANDALA_ISSUER_KEYS[1] is not a compressed public key (02/03 + 64 hex)", nil},
		{"valid, input order kept", `["` + key2G + `","` + keyG + `"]`, "", []string{key2G, keyG}},
	} {
		t.Run(c.name, func(t *testing.T) {
			vars := requiredEnv()
			vars["MANDALA_ISSUER_KEYS"] = c.raw
			cfg, err := loadConfig(envMap(vars))
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("err = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil || !slices.Equal(cfg.IssuerKeys, c.want) {
				t.Fatalf("IssuerKeys = %v, err %v; want %v", cfg.IssuerKeys, err, c.want)
			}
		})
	}
}

// The plan-defined MANDALA_TOKEN_ALLOWLIST strings (V-3, A1.5).
func TestLoadConfigTokenAllowlist(t *testing.T) {
	txA := strings.Repeat("ab", 32)
	for _, c := range []struct {
		name, raw, wantErr string
		want               []string
		wantSet            bool
	}{
		{"unset follows every token", "", "", nil, false},
		{"blank follows every token", "  ", "", nil, false},
		{"[] hosts no token", "[]", "", []string{}, true},
		{"one txid", `["` + txA + `"]`, "", []string{txA}, true},
		{"not an array", `{}`, "MANDALA_TOKEN_ALLOWLIST must be a JSON array of deploy txids", nil, false},
		{"a token id, not a txid", `["` + txA + `_0"]`, "MANDALA_TOKEN_ALLOWLIST[0] is not a deploy txid (64 lowercase hex)", nil, false},
		{"uppercase", `["` + strings.ToUpper(txA) + `"]`, "MANDALA_TOKEN_ALLOWLIST[0] is not a deploy txid (64 lowercase hex)", nil, false},
		{"duplicate", `["` + txA + `","` + txA + `"]`, "MANDALA_TOKEN_ALLOWLIST[1] is a duplicate", nil, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			vars := requiredEnv()
			vars["MANDALA_TOKEN_ALLOWLIST"] = c.raw
			cfg, err := loadConfig(envMap(vars))
			if c.wantErr != "" {
				if err == nil || err.Error() != c.wantErr {
					t.Fatalf("err = %v, want %q", err, c.wantErr)
				}
				return
			}
			if err != nil || cfg.TokenAllowlistSet != c.wantSet || !slices.Equal(cfg.TokenAllowlist, c.want) ||
				(c.wantSet && cfg.TokenAllowlist == nil) {
				t.Fatalf("allowlist = %v set %v, err %v; want %v set %v", cfg.TokenAllowlist, cfg.TokenAllowlistSet, err, c.want, c.wantSet)
			}
		})
	}
}

// Required vars and NETWORK are checked before the issuer keys, which are checked before the allowlist.
func TestLoadConfigCheckOrder(t *testing.T) {
	vars := requiredEnv()
	delete(vars, "NETWORK")
	vars["MANDALA_ISSUER_KEYS"] = "[]"
	if _, err := loadConfig(envMap(vars)); err == nil || err.Error() != "missing required environment variable: NETWORK" {
		t.Fatalf("missing NETWORK first: %v", err)
	}
	vars = requiredEnv()
	vars["NETWORK"] = "regtest"
	vars["MANDALA_ISSUER_KEYS"] = "[]"
	if _, err := loadConfig(envMap(vars)); err == nil || err.Error() != `NETWORK must be "main" or "test", got "regtest"` {
		t.Fatalf("NETWORK value before the keys: %v", err)
	}
	vars = requiredEnv()
	vars["MANDALA_ISSUER_KEYS"] = "[]"
	vars["MANDALA_TOKEN_ALLOWLIST"] = "{}"
	if _, err := loadConfig(envMap(vars)); err == nil || err.Error() != "MANDALA_ISSUER_KEYS must name at least one issuer key" {
		t.Fatalf("issuer keys before the allowlist: %v", err)
	}
}

func TestParsePort(t *testing.T) {
	for _, c := range []struct{ raw, want string }{{"", "8080"}, {"8081", "8081"}, {"1", "1"}, {"65535", "65535"}} {
		if got, err := parsePort(c.raw); err != nil || got != c.want {
			t.Fatalf("parsePort(%q) = %q, %v; want %q", c.raw, got, err, c.want)
		}
	}
	for _, raw := range []string{"0", "65536", "99999", "123456", "-1", "+80", "080", " 8081", "8081 ", "80a", "1e3", "http"} {
		_, err := parsePort(raw)
		want := `PORT must be an integer from 1 to 65535, got "` + raw + `"`
		if err == nil || err.Error() != want {
			t.Fatalf("parsePort(%q) err = %v, want %q", raw, err, want)
		}
	}
}

// The boot runs before the listener accepts a submit, and shutdown closes the app after the server drains
// (TS indexWiring.test.ts pins the same order). A source-order check: run() itself needs a live Mongo.
func TestRunBootsBeforeItListensAndClosesAfterShutdown(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	start := strings.Index(body, "func run() error {")
	if start < 0 {
		t.Fatal("main.go has no func run() error")
	}
	body = body[start:]
	prev := -1
	for _, s := range []string{
		"loadConfig(os.Getenv)",
		`parsePort(os.Getenv("PORT"))`,
		"wiring.Build(",
		"app.Start(",
		"len(app.Tokens.Registered())",
		"httpapi.New(app)",
		`fiberApp.Listen(":" + port)`,
		"fiberApp.ShutdownWithContext(",
		"stop(shutdownCtx)",
	} {
		i := strings.Index(body, s)
		if i < 0 {
			t.Fatalf("run() no longer contains %q", s)
		}
		if i <= prev {
			t.Fatalf("%q is out of boot order", s)
		}
		prev = i
	}
}

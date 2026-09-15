package main

import "testing"

// envMap adapts a map into the envLookup shape loadConfig expects, so tests
// never touch real process environment variables.
func envMap(vars map[string]string) envLookup {
	return func(name string) string { return vars[name] }
}

// requiredEnv returns the minimal set of required vars loadConfig needs to
// succeed, so each test only needs to override what it's actually checking.
func requiredEnv() map[string]string {
	return map[string]string{
		"NODE_NAME":          "mandala",
		"SERVER_PRIVATE_KEY": "deadbeef",
		"HOSTING_URL":        "http://localhost:8081",
		"MONGO_URL":          "mongodb://localhost:27017",
		"NETWORK":            "test",
	}
}

// TestLoadConfigReadsArcadeCallbackToken pins the final-review fix: loadConfig
// must read the optional ARCADE_CALLBACK_TOKEN var into
// wiring.Config.ArcadeCallbackToken so it reaches WithArcade's /arc-ingest
// guard end to end.
func TestLoadConfigReadsArcadeCallbackToken(t *testing.T) {
	vars := requiredEnv()
	vars["ARCADE_CALLBACK_TOKEN"] = "shh-secret"

	cfg, err := loadConfig(envMap(vars))
	if err != nil {
		t.Fatal("loadConfig:", err)
	}
	if cfg.ArcadeCallbackToken != "shh-secret" {
		t.Fatalf("ArcadeCallbackToken = %q, want %q", cfg.ArcadeCallbackToken, "shh-secret")
	}
}

// TestLoadConfigArcadeCallbackTokenDefaultsEmpty confirms the var is genuinely
// optional: leaving it unset must not error and must leave the field empty
// (WithArcade/hasValidCallbackToken treat empty as "no token check").
func TestLoadConfigArcadeCallbackTokenDefaultsEmpty(t *testing.T) {
	cfg, err := loadConfig(envMap(requiredEnv()))
	if err != nil {
		t.Fatal("loadConfig:", err)
	}
	if cfg.ArcadeCallbackToken != "" {
		t.Fatalf("ArcadeCallbackToken = %q, want empty when unset", cfg.ArcadeCallbackToken)
	}
}

// TestLoadConfigMissingRequiredVarFails is a sanity check that the required/
// optional split still works alongside the new optional var: a missing
// required var still fails fast by name, unaffected by ARCADE_CALLBACK_TOKEN.
func TestLoadConfigMissingRequiredVarFails(t *testing.T) {
	vars := requiredEnv()
	delete(vars, "NODE_NAME")

	_, err := loadConfig(envMap(vars))
	if err == nil {
		t.Fatal("loadConfig: want error for missing NODE_NAME, got nil")
	}
}

// TestLoadConfigReadsAdminAPIToken (A13) pins that ADMIN_API_TOKEN reaches
// wiring.Config verbatim — httpapi.New threads it through to
// AdminAuthMiddleware on the gated routes.
func TestLoadConfigReadsAdminAPIToken(t *testing.T) {
	vars := requiredEnv()
	vars["ADMIN_API_TOKEN"] = "shh-console-token"

	cfg, err := loadConfig(envMap(vars))
	if err != nil {
		t.Fatal("loadConfig:", err)
	}
	if cfg.AdminAPIToken != "shh-console-token" {
		t.Fatalf("AdminAPIToken = %q, want %q", cfg.AdminAPIToken, "shh-console-token")
	}
}

// TestLoadConfigAdminAPITokenDefaultsEmpty confirms the var is genuinely
// optional: leaving it unset must not error, leaving the gated routes open
// (main.go logs the one startup warning for this case).
func TestLoadConfigAdminAPITokenDefaultsEmpty(t *testing.T) {
	cfg, err := loadConfig(envMap(requiredEnv()))
	if err != nil {
		t.Fatal("loadConfig:", err)
	}
	if cfg.AdminAPIToken != "" {
		t.Fatalf("AdminAPIToken = %q, want empty when unset", cfg.AdminAPIToken)
	}
}

// TestLoadConfigReadsAdminCORSOrigins pins that a set ADMIN_CORS_ORIGINS is
// split verbatim (via httpapi.ParseAdminCORSOrigins) rather than defaulted.
func TestLoadConfigReadsAdminCORSOrigins(t *testing.T) {
	vars := requiredEnv()
	vars["ADMIN_CORS_ORIGINS"] = "https://a.example, https://b.example"

	cfg, err := loadConfig(envMap(vars))
	if err != nil {
		t.Fatal("loadConfig:", err)
	}
	want := []string{"https://a.example", "https://b.example"}
	if len(cfg.AdminCORSOrigins) != len(want) || cfg.AdminCORSOrigins[0] != want[0] || cfg.AdminCORSOrigins[1] != want[1] {
		t.Fatalf("AdminCORSOrigins = %v, want %v", cfg.AdminCORSOrigins, want)
	}
}

// TestLoadConfigAdminCORSOriginsDefaultsToHostingURL confirms the unset case
// resolves HOSTING_URL's origin plus the two local dev origins (TS parity:
// overlay/src/adminAuth.ts's parseAdminCorsOrigins).
func TestLoadConfigAdminCORSOriginsDefaultsToHostingURL(t *testing.T) {
	cfg, err := loadConfig(envMap(requiredEnv()))
	if err != nil {
		t.Fatal("loadConfig:", err)
	}
	want := []string{"http://localhost:8081", "http://127.0.0.1:5173", "http://localhost:5173"}
	if len(cfg.AdminCORSOrigins) != len(want) {
		t.Fatalf("AdminCORSOrigins = %v, want %v", cfg.AdminCORSOrigins, want)
	}
	for i := range want {
		if cfg.AdminCORSOrigins[i] != want[i] {
			t.Fatalf("AdminCORSOrigins = %v, want %v", cfg.AdminCORSOrigins, want)
		}
	}
}

package config

import (
	"errors"
	"flag"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// helpers mirroring cmd/server/main.go
// ---------------------------------------------------------------------------

// envOr / envBool are copies of the helpers in cmd/server/main.go. They are
// duplicated here (rather than exported from this package) so the precedence
// tests exercise the *exact* composition main.go performs:
//
//	flag.String("addr", envOr("DEVDECK_ADDR", Pick(cfg.Addr, builtin)), …)
//
// which is what makes flag > env > YAML > built-in fall out of the flag
// package. main.go's envBool calls log.Fatalf on an unparseable value; the
// copy returns the fallback instead, and no test feeds it garbage.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}

const builtinDB = "BUILTIN/data/devdeck.db" // stands in for main.go's defaultDBPath()

// resolved holds one value per flag main.go declares, after flag parsing.
type resolved struct {
	role               string
	addr               string
	db                 string
	key                string
	open               bool
	machineName        string
	publicURL          string
	hubURL             string
	hubKey             string
	tailscaleServe     bool
	twoFA              bool
	secureCookies      bool
	turnstileSiteKey   string
	turnstileSecretKey string
	onlyFrom           string
	trustedProxies     string
	clientIPHeader     string
	socks5Addr         string
	httpProxyAddr      string
	proxyKey           string
	githubToken        string
}

// resolveFlags declares every flag exactly the way cmd/server/main.go will
// after this feature lands — built-in default wrapped in Pick/PickBool,
// wrapped in envOr/envBool — then parses args. It is the system under test for
// the precedence table.
func resolveFlags(t *testing.T, cfg *Config, args []string) resolved {
	t.Helper()
	fs := flag.NewFlagSet("devdeck", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	role := fs.String("role", envOr("DEVDECK_ROLE", Pick(cfg.Role, "hub")), "")
	addr := fs.String("addr", envOr("DEVDECK_ADDR", Pick(cfg.Addr, "127.0.0.1:8989")), "")
	db := fs.String("db", envOr("DEVDECK_DB", Pick(cfg.DB, builtinDB)), "")
	key := fs.String("key", envOr("DEVDECK_KEY", Pick(cfg.Key, "")), "")
	open := fs.Bool("open", envBool("DEVDECK_OPEN", PickBool(cfg.Open, true)), "")
	machineName := fs.String("name", envOr("DEVDECK_MACHINE_NAME", Pick(cfg.Machine.Name, "")), "")
	publicURL := fs.String("public-url", envOr("DEVDECK_PUBLIC_URL", Pick(cfg.Machine.PublicURL, "")), "")
	hubURL := fs.String("hub-url", envOr("DEVDECK_HUB_URL", Pick(cfg.Hub.URL, "")), "")
	hubKey := fs.String("hub-key", envOr("DEVDECK_HUB_KEY", Pick(cfg.Hub.Key, "")), "")
	tailscaleServe := fs.Bool("enable-tailscale-serve", envBool("DEVDECK_TAILSCALE_SERVE", PickBool(cfg.Tailscale.Serve, false)), "")
	twoFA := fs.Bool("2fa", envBool("DEVDECK_2FA", PickBool(cfg.Auth.TwoFA, true)), "")
	secureCookies := fs.Bool("secure-cookies", envBool("DEVDECK_SECURE_COOKIES", PickBool(cfg.Auth.SecureCookies, true)), "")
	turnstileSiteKey := fs.String("turnstile-site-key", envOr("DEVDECK_TURNSTILE_SITE_KEY", Pick(cfg.Auth.Turnstile.SiteKey, "")), "")
	turnstileSecretKey := fs.String("turnstile-secret-key", envOr("DEVDECK_TURNSTILE_SECRET_KEY", Pick(cfg.Auth.Turnstile.SecretKey, "")), "")
	onlyFrom := fs.String("only-from", envOr("DEVDECK_ONLY_FROM", Pick(JoinList(cfg.Network.OnlyFrom), "")), "")
	trustedProxies := fs.String("trusted-proxies", envOr("DEVDECK_TRUSTED_PROXIES", Pick(JoinList(cfg.Network.TrustedProxies), "")), "")
	clientIPHeader := fs.String("client-ip-header", envOr("DEVDECK_CLIENT_IP_HEADER", Pick(cfg.Network.ClientIPHeader, "")), "")
	socks5Addr := fs.String("socks5-addr", envOr("DEVDECK_SOCKS5_ADDR", Pick(cfg.Proxy.Socks5Addr, "")), "")
	httpProxyAddr := fs.String("http-proxy-addr", envOr("DEVDECK_HTTP_PROXY_ADDR", Pick(cfg.Proxy.HTTPAddr, "")), "")
	proxyKey := fs.String("proxy-key", envOr("DEVDECK_PROXY_KEY", Pick(cfg.Proxy.Key, "")), "")
	githubToken := fs.String("github-token", envOr("DEVDECK_GITHUB_TOKEN", Pick(cfg.Updates.GitHubToken, "")), "")

	if err := fs.Parse(args); err != nil {
		t.Fatalf("flag parse %v: %v", args, err)
	}
	return resolved{
		role: *role, addr: *addr, db: *db, key: *key, open: *open,
		machineName: *machineName, publicURL: *publicURL,
		hubURL: *hubURL, hubKey: *hubKey,
		tailscaleServe: *tailscaleServe,
		twoFA:          *twoFA, secureCookies: *secureCookies,
		turnstileSiteKey: *turnstileSiteKey, turnstileSecretKey: *turnstileSecretKey,
		onlyFrom: *onlyFrom, trustedProxies: *trustedProxies, clientIPHeader: *clientIPHeader,
		socks5Addr: *socks5Addr, httpProxyAddr: *httpProxyAddr, proxyKey: *proxyKey,
		githubToken: *githubToken,
	}
}

func boolPtr(v bool) *bool { return &v }

// ---------------------------------------------------------------------------
// Pick / PickBool / JoinList
// ---------------------------------------------------------------------------

func TestPickTreatsEmptyStringAsUnset(t *testing.T) {
	cases := []struct {
		name      string
		yamlValue string
		builtin   string
		want      string
	}{
		{"empty falls through to builtin", "", "127.0.0.1:8989", "127.0.0.1:8989"},
		{"set value wins over builtin", "0.0.0.0:9199", "127.0.0.1:8989", "0.0.0.0:9199"},
		{"empty builtin stays empty", "", "", ""},
		{"whitespace is a real value", " ", "x", " "},
		{"set value wins over empty builtin", "hub", "", "hub"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Pick(tc.yamlValue, tc.builtin); got != tc.want {
				t.Fatalf("Pick(%q, %q) = %q, want %q", tc.yamlValue, tc.builtin, got, tc.want)
			}
		})
	}
}

// TestPickBoolKeysOffNilNotFalse is the reason every boolean in Config is a
// *bool: `two_fa: false` must be distinguishable from omitting the key, or 2FA
// could never be turned off from YAML.
func TestPickBoolKeysOffNilNotFalse(t *testing.T) {
	cases := []struct {
		name      string
		yamlValue *bool
		builtin   bool
		want      bool
	}{
		{"nil falls through to builtin true", nil, true, true},
		{"nil falls through to builtin false", nil, false, false},
		{"explicit false overrides builtin true", boolPtr(false), true, false},
		{"explicit true overrides builtin false", boolPtr(true), false, true},
		{"explicit true agrees with builtin true", boolPtr(true), true, true},
		{"explicit false agrees with builtin false", boolPtr(false), false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PickBool(tc.yamlValue, tc.builtin); got != tc.want {
				t.Fatalf("PickBool(%v, %v) = %v, want %v", tc.yamlValue, tc.builtin, got, tc.want)
			}
		})
	}
}

func TestJoinListProducesCommaSeparatedFlagForm(t *testing.T) {
	cases := []struct {
		name  string
		items []string
		want  string
	}{
		{"nil is empty", nil, ""},
		{"empty slice is empty", []string{}, ""},
		{"single item", []string{"10.0.0.1"}, "10.0.0.1"},
		{"multiple items", []string{"10.0.0.0/8", "192.168.1.5"}, "10.0.0.0/8,192.168.1.5"},
		{"trims surrounding whitespace", []string{" 10.0.0.1 ", "127.0.0.1"}, "10.0.0.1,127.0.0.1"},
		{"drops blank entries", []string{"10.0.0.1", "", "  ", "127.0.0.1"}, "10.0.0.1,127.0.0.1"},
		{"all blank collapses to empty (so Pick sees it as unset)", []string{"", " "}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := JoinList(tc.items); got != tc.want {
				t.Fatalf("JoinList(%q) = %q, want %q", tc.items, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Precedence: flag > env > YAML > built-in default
// ---------------------------------------------------------------------------

// TestPrecedenceStringExhaustive walks all 8 combinations of
// {YAML set?, env set?, flag set?} for a representative string flag.
func TestPrecedenceStringExhaustive(t *testing.T) {
	const builtin = "127.0.0.1:8989"
	cases := []struct {
		name string
		yaml string   // "" = key absent from devdeck.yaml
		env  string   // "" = env var unset
		args []string // nil = flag not passed
		want string
	}{
		{"none", "", "", nil, builtin},
		{"yaml only", "1.1.1.1:1", "", nil, "1.1.1.1:1"},
		{"env only", "", "2.2.2.2:2", nil, "2.2.2.2:2"},
		{"flag only", "", "", []string{"-addr", "3.3.3.3:3"}, "3.3.3.3:3"},
		{"env beats yaml", "1.1.1.1:1", "2.2.2.2:2", nil, "2.2.2.2:2"},
		{"flag beats yaml", "1.1.1.1:1", "", []string{"-addr", "3.3.3.3:3"}, "3.3.3.3:3"},
		{"flag beats env", "", "2.2.2.2:2", []string{"-addr", "3.3.3.3:3"}, "3.3.3.3:3"},
		{"flag beats env beats yaml beats builtin", "1.1.1.1:1", "2.2.2.2:2", []string{"-addr", "3.3.3.3:3"}, "3.3.3.3:3"},
		{"empty yaml value is unset, env still wins", "", "2.2.2.2:2", nil, "2.2.2.2:2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.env != "" {
				t.Setenv("DEVDECK_ADDR", tc.env)
			} else {
				t.Setenv("DEVDECK_ADDR", "")
			}
			cfg := &Config{Addr: tc.yaml}
			if got := resolveFlags(t, cfg, tc.args).addr; got != tc.want {
				t.Fatalf("addr = %q, want %q (yaml=%q env=%q args=%v)", got, tc.want, tc.yaml, tc.env, tc.args)
			}
		})
	}
}

// TestPrecedenceBoolExhaustive enumerates every combination of
// {YAML nil/false/true} x {env unset/false/true} x {flag unset/=false/=true}
// against a built-in default of true (--2fa) and, below, of false
// (--enable-tailscale-serve). Every `want` is written out by hand rather than
// computed, so the test cannot agree with a broken implementation by sharing
// its logic.
func TestPrecedenceBoolExhaustiveBuiltinTrue(t *testing.T) {
	cases := []struct {
		name string
		yaml *bool
		env  string
		args []string
		want bool
	}{
		// YAML absent
		{"nil/unset/unset", nil, "", nil, true},
		{"nil/unset/false", nil, "", []string{"-2fa=false"}, false},
		{"nil/unset/true", nil, "", []string{"-2fa=true"}, true},
		{"nil/false/unset", nil, "false", nil, false},
		{"nil/false/false", nil, "false", []string{"-2fa=false"}, false},
		{"nil/false/true", nil, "false", []string{"-2fa=true"}, true},
		{"nil/true/unset", nil, "true", nil, true},
		{"nil/true/false", nil, "true", []string{"-2fa=false"}, false},
		{"nil/true/true", nil, "true", []string{"-2fa=true"}, true},
		// YAML false — must survive as false, which plain bool could not express
		{"false/unset/unset", boolPtr(false), "", nil, false},
		{"false/unset/false", boolPtr(false), "", []string{"-2fa=false"}, false},
		{"false/unset/true", boolPtr(false), "", []string{"-2fa=true"}, true},
		{"false/false/unset", boolPtr(false), "false", nil, false},
		{"false/false/false", boolPtr(false), "false", []string{"-2fa=false"}, false},
		{"false/false/true", boolPtr(false), "false", []string{"-2fa=true"}, true},
		{"false/true/unset", boolPtr(false), "true", nil, true},
		{"false/true/false", boolPtr(false), "true", []string{"-2fa=false"}, false},
		{"false/true/true", boolPtr(false), "true", []string{"-2fa=true"}, true},
		// YAML true
		{"true/unset/unset", boolPtr(true), "", nil, true},
		{"true/unset/false", boolPtr(true), "", []string{"-2fa=false"}, false},
		{"true/unset/true", boolPtr(true), "", []string{"-2fa=true"}, true},
		{"true/false/unset", boolPtr(true), "false", nil, false},
		{"true/false/false", boolPtr(true), "false", []string{"-2fa=false"}, false},
		{"true/false/true", boolPtr(true), "false", []string{"-2fa=true"}, true},
		{"true/true/unset", boolPtr(true), "true", nil, true},
		{"true/true/false", boolPtr(true), "true", []string{"-2fa=false"}, false},
		{"true/true/true", boolPtr(true), "true", []string{"-2fa=true"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DEVDECK_2FA", tc.env)
			cfg := &Config{Auth: AuthConfig{TwoFA: tc.yaml}}
			if got := resolveFlags(t, cfg, tc.args).twoFA; got != tc.want {
				t.Fatalf("2fa = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPrecedenceBoolExhaustiveBuiltinFalse(t *testing.T) {
	cases := []struct {
		name string
		yaml *bool
		env  string
		args []string
		want bool
	}{
		{"nil/unset/unset", nil, "", nil, false},
		{"nil/unset/false", nil, "", []string{"-enable-tailscale-serve=false"}, false},
		{"nil/unset/true", nil, "", []string{"-enable-tailscale-serve=true"}, true},
		{"nil/false/unset", nil, "false", nil, false},
		{"nil/true/unset", nil, "true", nil, true},
		{"nil/true/false", nil, "true", []string{"-enable-tailscale-serve=false"}, false},
		{"true/unset/unset", boolPtr(true), "", nil, true},
		{"true/false/unset", boolPtr(true), "false", nil, false},
		{"true/unset/false", boolPtr(true), "", []string{"-enable-tailscale-serve=false"}, false},
		{"false/unset/unset", boolPtr(false), "", nil, false},
		{"false/true/unset", boolPtr(false), "true", nil, true},
		{"false/unset/true", boolPtr(false), "", []string{"-enable-tailscale-serve=true"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DEVDECK_TAILSCALE_SERVE", tc.env)
			cfg := &Config{Tailscale: TailscaleConfig{Serve: tc.yaml}}
			if got := resolveFlags(t, cfg, tc.args).tailscaleServe; got != tc.want {
				t.Fatalf("enable-tailscale-serve = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestPrecedenceListExhaustive proves []string YAML fields reach the existing
// comma-separated flag parsers, and lose to env and flag like everything else.
func TestPrecedenceListExhaustive(t *testing.T) {
	cases := []struct {
		name string
		yaml []string
		env  string
		args []string
		want string
	}{
		{"none", nil, "", nil, ""},
		{"yaml only joins with comma", []string{"10.0.0.0/8", "127.0.0.1"}, "", nil, "10.0.0.0/8,127.0.0.1"},
		{"empty yaml list is unset", []string{}, "", nil, ""},
		{"env only", nil, "1.2.3.4", nil, "1.2.3.4"},
		{"env beats yaml", []string{"10.0.0.0/8"}, "1.2.3.4", nil, "1.2.3.4"},
		{"flag beats yaml", []string{"10.0.0.0/8"}, "", []string{"-only-from", "5.6.7.8"}, "5.6.7.8"},
		{"flag beats env beats yaml", []string{"10.0.0.0/8"}, "1.2.3.4", []string{"-only-from", "5.6.7.8"}, "5.6.7.8"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DEVDECK_ONLY_FROM", tc.env)
			cfg := &Config{Network: NetworkConfig{OnlyFrom: tc.yaml}}
			if got := resolveFlags(t, cfg, tc.args).onlyFrom; got != tc.want {
				t.Fatalf("only-from = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestPrecedenceEveryFieldIsWired loads a fully populated YAML document and
// asserts every single flag picks its value up — the guard against a field
// being added to the schema but never threaded into main.go.
func TestPrecedenceEveryFieldIsWired(t *testing.T) {
	for _, key := range []string{
		"DEVDECK_ROLE", "DEVDECK_ADDR", "DEVDECK_DB", "DEVDECK_KEY", "DEVDECK_OPEN",
		"DEVDECK_MACHINE_NAME", "DEVDECK_PUBLIC_URL", "DEVDECK_HUB_URL", "DEVDECK_HUB_KEY",
		"DEVDECK_TAILSCALE_SERVE", "DEVDECK_2FA", "DEVDECK_SECURE_COOKIES",
		"DEVDECK_TURNSTILE_SITE_KEY", "DEVDECK_TURNSTILE_SECRET_KEY",
		"DEVDECK_ONLY_FROM", "DEVDECK_TRUSTED_PROXIES", "DEVDECK_CLIENT_IP_HEADER",
		"DEVDECK_SOCKS5_ADDR", "DEVDECK_HTTP_PROXY_ADDR", "DEVDECK_PROXY_KEY",
		"DEVDECK_GITHUB_TOKEN",
	} {
		t.Setenv(key, "")
	}

	cfg, err := Parse([]byte(fullYAML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	got := resolveFlags(t, cfg, nil)
	want := resolved{
		role: "runtime", addr: "0.0.0.0:9199", db: "data/devdeck.db", key: "a1b2c3",
		open: false, machineName: "builder", publicURL: "https://builder.tail-abc.ts.net",
		hubURL: "https://hq.tail-abc.ts.net", hubKey: "hubsecret",
		tailscaleServe: true, twoFA: false, secureCookies: false,
		turnstileSiteKey: "site", turnstileSecretKey: "secret",
		onlyFrom: "10.0.0.0/8,127.0.0.1", trustedProxies: "192.168.0.1",
		clientIPHeader: "CF-Connecting-IP",
		socks5Addr:     "127.0.0.1:1080", httpProxyAddr: "127.0.0.1:8080", proxyKey: "proxysecret",
		githubToken: "ghp_x",
	}
	if got != want {
		t.Fatalf("resolved from YAML:\n got %+v\nwant %+v", got, want)
	}
}

// TestPrecedenceNoConfigFileKeepsTodaysDefaults is the "existing behaviour did
// not regress" guard: a zero Config must resolve to exactly the built-in
// defaults main.go uses today.
func TestPrecedenceNoConfigFileKeepsTodaysDefaults(t *testing.T) {
	for _, key := range []string{"DEVDECK_ROLE", "DEVDECK_ADDR", "DEVDECK_DB", "DEVDECK_2FA", "DEVDECK_SECURE_COOKIES", "DEVDECK_OPEN", "DEVDECK_TAILSCALE_SERVE"} {
		t.Setenv(key, "")
	}
	got := resolveFlags(t, &Config{}, nil)
	if got.role != "hub" || got.addr != "127.0.0.1:8989" || got.db != builtinDB {
		t.Fatalf("string defaults changed: role=%q addr=%q db=%q", got.role, got.addr, got.db)
	}
	if !got.open || !got.twoFA || !got.secureCookies || got.tailscaleServe {
		t.Fatalf("bool defaults changed: open=%v 2fa=%v secure=%v serve=%v", got.open, got.twoFA, got.secureCookies, got.tailscaleServe)
	}
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const fullYAML = `role: runtime
addr: 0.0.0.0:9199
db: data/devdeck.db
key: a1b2c3
open: false

machine:
  name: builder
  public_url: https://builder.tail-abc.ts.net

hub:
  url: https://hq.tail-abc.ts.net
  key: hubsecret

tailscale:
  serve: true

auth:
  two_fa: false
  secure_cookies: false
  turnstile:
    site_key: site
    secret_key: secret

network:
  only_from:
    - 10.0.0.0/8
    - 127.0.0.1
  trusted_proxies:
    - 192.168.0.1
  client_ip_header: CF-Connecting-IP

proxy:
  socks5_addr: 127.0.0.1:1080
  http_addr: 127.0.0.1:8080
  key: proxysecret

updates:
  github_token: ghp_x
`

func TestParseFullSchema(t *testing.T) {
	cfg, err := Parse([]byte(fullYAML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := &Config{
		Role: "runtime", Addr: "0.0.0.0:9199", DB: "data/devdeck.db", Key: "a1b2c3",
		Open:      boolPtr(false),
		Machine:   MachineConfig{Name: "builder", PublicURL: "https://builder.tail-abc.ts.net"},
		Hub:       HubConfig{URL: "https://hq.tail-abc.ts.net", Key: "hubsecret"},
		Tailscale: TailscaleConfig{Serve: boolPtr(true)},
		Auth: AuthConfig{
			TwoFA: boolPtr(false), SecureCookies: boolPtr(false),
			Turnstile: TurnstileConfig{SiteKey: "site", SecretKey: "secret"},
		},
		Network: NetworkConfig{
			OnlyFrom:       []string{"10.0.0.0/8", "127.0.0.1"},
			TrustedProxies: []string{"192.168.0.1"},
			ClientIPHeader: "CF-Connecting-IP",
		},
		Proxy:   ProxyConfig{Socks5Addr: "127.0.0.1:1080", HTTPAddr: "127.0.0.1:8080", Key: "proxysecret"},
		Updates: UpdatesConfig{GitHubToken: "ghp_x"},
	}
	if !reflect.DeepEqual(cfg, want) {
		t.Fatalf("Parse(fullYAML) =\n%+v\nwant\n%+v", cfg, want)
	}
}

func TestParseEmptyDocumentIsAllDefaults(t *testing.T) {
	for _, doc := range []string{"", "\n", "# only a comment\n"} {
		cfg, err := Parse([]byte(doc))
		if err != nil {
			t.Fatalf("Parse(%q): unexpected error %v", doc, err)
		}
		if !reflect.DeepEqual(cfg, &Config{}) {
			t.Fatalf("Parse(%q) = %+v, want zero Config", doc, cfg)
		}
	}
}

// TestParseRejectsUnknownKey is the whole point of strict decoding: a typo'd
// key must fail loudly, naming the key and its line.
func TestParseRejectsUnknownKey(t *testing.T) {
	cases := []struct {
		name     string
		doc      string
		wantKey  string
		wantLine string
	}{
		{
			name:     "top level typo",
			doc:      "role: hub\naddr: 0.0.0.0:1\nadrr: oops\n",
			wantKey:  "adrr",
			wantLine: "line 3",
		},
		{
			name:     "nested typo",
			doc:      "auth:\n  two_fa: true\n  secure_cookie: true\n",
			wantKey:  "secure_cookie",
			wantLine: "line 3",
		},
		{
			name:     "deeply nested typo",
			doc:      "auth:\n  turnstile:\n    sitekey: x\n",
			wantKey:  "sitekey",
			wantLine: "line 3",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(tc.doc))
			if err == nil {
				t.Fatalf("Parse(%q) succeeded, want an unknown-key error", tc.doc)
			}
			msg := err.Error()
			if !strings.Contains(msg, tc.wantKey) {
				t.Errorf("error %q does not name the offending key %q", msg, tc.wantKey)
			}
			if !strings.Contains(msg, tc.wantLine) {
				t.Errorf("error %q does not name the line (%q)", msg, tc.wantLine)
			}
		})
	}
}

// TestParseRejectsDuplicateKey covers the other way a config file can look
// configured and behave otherwise: the same key twice, where only the last one
// would take effect.
func TestParseRejectsDuplicateKey(t *testing.T) {
	cases := []struct {
		name string
		doc  string
		want string
	}{
		{"top level", "addr: 1.1.1.1:1\naddr: 2.2.2.2:2\n", "addr"},
		{"nested", "auth:\n  two_fa: true\n  two_fa: false\n", "two_fa"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(tc.doc))
			if err == nil {
				t.Fatalf("Parse(%q) succeeded, want a duplicate-key error", tc.doc)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not name the duplicated key %q", err.Error(), tc.want)
			}
		})
	}
}

func TestParseReportsMalformedYAML(t *testing.T) {
	cases := []struct {
		name string
		doc  string
	}{
		{"bad indentation", "role: hub\n  addr: x\n"},
		{"wrong scalar type for bool", "open: notabool\n"},
		{"scalar where a mapping is expected", "auth: nope\n"},
		{"scalar where a list is expected", "network:\n  only_from: 10.0.0.1\n"},
		{"unclosed flow sequence", "network:\n  only_from: [a, b\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Parse([]byte(tc.doc))
			if err == nil {
				t.Fatalf("Parse(%q) succeeded, want a parse error", tc.doc)
			}
			if !strings.Contains(err.Error(), "line") {
				t.Errorf("error %q should point at a line number", err.Error())
			}
		})
	}
}

func TestLoadReadsFileAndNamesItInErrors(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.yaml")
	if err := os.WriteFile(good, []byte("role: runtime\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(good)
	if err != nil {
		t.Fatalf("Load(good): %v", err)
	}
	if cfg.Role != "runtime" {
		t.Fatalf("role = %q, want runtime", cfg.Role)
	}

	bad := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(bad, []byte("nope: 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = Load(bad)
	if err == nil {
		t.Fatal("Load(bad) succeeded, want an unknown-key error")
	}
	if !strings.Contains(err.Error(), bad) {
		t.Errorf("error %q should name the offending file %q", err.Error(), bad)
	}
}

func TestLoadMissingFileIsAnError(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.yaml")
	_, err := Load(missing)
	if err == nil {
		t.Fatal("Load of a missing file succeeded, want an error")
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("error %v should unwrap to fs.ErrNotExist so Resolve can distinguish it", err)
	}
	if !strings.Contains(err.Error(), missing) {
		t.Errorf("error %q should name the missing path", err.Error())
	}
}

// ---------------------------------------------------------------------------
// Lookup order
// ---------------------------------------------------------------------------

// fakeExeDir points DefaultPath()/Resolve() at a temp directory standing in for
// the directory holding the executable.
func fakeExeDir(t *testing.T, dir string) {
	t.Helper()
	prev := osExecutable
	osExecutable = func() (string, error) { return filepath.Join(dir, "devdeck"), nil }
	t.Cleanup(func() { osExecutable = prev })
}

func writeConfig(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// chdir switches to dir and returns the working directory as os.Getwd reports
// it, which on macOS is not always the string t.TempDir handed out
// (/var/folders/… vs /private/var/folders/…).
func chdir(t *testing.T, dir string) string {
	t.Helper()
	t.Chdir(dir)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return cwd
}

func TestResolveLookupOrder(t *testing.T) {
	cases := []struct {
		name       string
		explicit   bool // write and pass an explicit --config file
		env        bool // write and set DEVDECK_CONFIG
		inCWD      bool // write ./devdeck.yaml
		inExeDir   bool // write <exe dir>/devdeck.yaml
		wantRole   string
		wantSource string // "explicit" | "env" | "cwd" | "exedir" | "none"
	}{
		{"explicit beats everything", true, true, true, true, "explicit", "explicit"},
		{"env beats cwd and exe dir", false, true, true, true, "env", "env"},
		{"cwd beats exe dir", false, false, true, true, "cwd", "cwd"},
		{"exe dir is the last resort", false, false, false, true, "exedir", "exedir"},
		{"nothing anywhere is not an error", false, false, false, false, "", "none"},
		{"cwd only", false, false, true, false, "cwd", "cwd"},
		{"explicit with nothing else", true, false, false, false, "explicit", "explicit"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cwd := chdir(t, t.TempDir())
			exeDir := t.TempDir()
			other := t.TempDir()
			fakeExeDir(t, exeDir)

			explicitPath := filepath.Join(other, "explicit.yaml")
			envPath := filepath.Join(other, "env.yaml")
			cwdPath := filepath.Join(cwd, FileName)
			exePath := filepath.Join(exeDir, FileName)

			if tc.explicit {
				writeConfig(t, explicitPath, "role: explicit\n")
			}
			if tc.env {
				writeConfig(t, envPath, "role: env\n")
				t.Setenv(EnvVar, envPath)
			} else {
				t.Setenv(EnvVar, "")
			}
			if tc.inCWD {
				writeConfig(t, cwdPath, "role: cwd\n")
			}
			if tc.inExeDir {
				writeConfig(t, exePath, "role: exedir\n")
			}

			arg := ""
			if tc.explicit {
				arg = explicitPath
			}
			cfg, path, err := Resolve(arg)
			if err != nil {
				t.Fatalf("Resolve(%q): %v", arg, err)
			}
			if cfg == nil {
				t.Fatal("Resolve returned a nil Config; callers must always be able to call Pick on it")
			}
			if cfg.Role != tc.wantRole {
				t.Fatalf("role = %q, want %q (loaded %q)", cfg.Role, tc.wantRole, path)
			}
			wantPath := map[string]string{
				"explicit": explicitPath,
				"env":      envPath,
				"cwd":      cwdPath,
				"exedir":   exePath,
				"none":     "",
			}[tc.wantSource]
			if path != wantPath {
				t.Fatalf("path = %q, want %q", path, wantPath)
			}
		})
	}
}

func TestResolveExplicitMissingPathIsAnError(t *testing.T) {
	cwd := chdir(t, t.TempDir())
	exeDir := t.TempDir()
	fakeExeDir(t, exeDir)
	t.Setenv(EnvVar, "")

	// A config file exists at both implicit locations: an explicit path that
	// does not exist must still fail rather than silently falling through.
	writeConfig(t, filepath.Join(cwd, FileName), "role: cwd\n")
	writeConfig(t, filepath.Join(exeDir, FileName), "role: exedir\n")

	missing := filepath.Join(cwd, "nope.yaml")
	if _, _, err := Resolve(missing); err == nil {
		t.Fatal("Resolve of a nonexistent explicit path succeeded, want an error")
	} else if !strings.Contains(err.Error(), missing) {
		t.Errorf("error %q should name the missing path", err.Error())
	}
}

func TestResolveMissingEnvPathIsAnError(t *testing.T) {
	cwd := chdir(t, t.TempDir())
	exeDir := t.TempDir()
	fakeExeDir(t, exeDir)

	missing := filepath.Join(cwd, "from-env.yaml")
	t.Setenv(EnvVar, missing)
	if _, _, err := Resolve(""); err == nil {
		t.Fatal("Resolve with DEVDECK_CONFIG pointing at a missing file succeeded, want an error")
	}
}

func TestResolvePropagatesParseErrors(t *testing.T) {
	cwd := chdir(t, t.TempDir())
	exeDir := t.TempDir()
	fakeExeDir(t, exeDir)
	t.Setenv(EnvVar, "")
	writeConfig(t, filepath.Join(cwd, FileName), "adrr: oops\n")

	if _, _, err := Resolve(""); err == nil {
		t.Fatal("Resolve of a config with an unknown key succeeded, want an error")
	}
}

func TestSearchPathsOrder(t *testing.T) {
	cwd := chdir(t, t.TempDir())
	exeDir := t.TempDir()
	fakeExeDir(t, exeDir)
	t.Setenv(EnvVar, "")

	got := SearchPaths("")
	want := []string{filepath.Join(cwd, FileName), filepath.Join(exeDir, FileName)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("SearchPaths(\"\") = %q, want %q", got, want)
	}

	got = SearchPaths("/etc/devdeck/custom.yaml")
	if len(got) != 1 || got[0] != "/etc/devdeck/custom.yaml" {
		t.Fatalf("SearchPaths(explicit) = %q, want only the explicit path", got)
	}

	t.Setenv(EnvVar, "/etc/devdeck/env.yaml")
	got = SearchPaths("")
	if len(got) != 1 || got[0] != "/etc/devdeck/env.yaml" {
		t.Fatalf("SearchPaths with %s set = %q, want only the env path", EnvVar, got)
	}
}

// TestSearchPathsDedupesWhenCWDIsTheExeDir: running ./devdeck from its own
// directory (the common case) must not try the same file twice.
func TestSearchPathsDedupesWhenCWDIsTheExeDir(t *testing.T) {
	dir := chdir(t, t.TempDir())
	fakeExeDir(t, dir)
	t.Setenv(EnvVar, "")

	got := SearchPaths("")
	if len(got) != 1 || got[0] != filepath.Join(dir, FileName) {
		t.Fatalf("SearchPaths() = %q, want exactly one entry %q", got, filepath.Join(dir, FileName))
	}

	writeConfig(t, filepath.Join(dir, FileName), "role: both\n")
	cfg, path, err := Resolve("")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if cfg.Role != "both" || path != filepath.Join(dir, FileName) {
		t.Fatalf("Resolve() = role %q from %q, want role \"both\" from %q", cfg.Role, path, filepath.Join(dir, FileName))
	}
}

func TestDefaultPathIsBesideTheExecutable(t *testing.T) {
	exeDir := t.TempDir()
	fakeExeDir(t, exeDir)
	if got, want := DefaultPath(), filepath.Join(exeDir, FileName); got != want {
		t.Fatalf("DefaultPath() = %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

func TestWriteReadRoundTripPreservesEveryField(t *testing.T) {
	cases := []struct {
		name string
		cfg  *Config
	}{
		{
			name: "fully populated",
			cfg: &Config{
				Role: "both", Addr: "0.0.0.0:9199", DB: "/var/lib/devdeck.db", Key: "deadbeef",
				Open:      boolPtr(true),
				Machine:   MachineConfig{Name: "builder", PublicURL: "https://builder.example"},
				Hub:       HubConfig{URL: "https://hq.example", Key: "hubkey"},
				Tailscale: TailscaleConfig{Serve: boolPtr(true)},
				Auth: AuthConfig{
					TwoFA: boolPtr(true), SecureCookies: boolPtr(true),
					Turnstile: TurnstileConfig{SiteKey: "s", SecretKey: "k"},
				},
				Network: NetworkConfig{OnlyFrom: []string{"10.0.0.0/8"}, TrustedProxies: []string{"1.1.1.1", "2.2.2.2"}, ClientIPHeader: "CF-Connecting-IP"},
				Proxy:   ProxyConfig{Socks5Addr: "127.0.0.1:1080", HTTPAddr: "127.0.0.1:8080", Key: "pk"},
				Updates: UpdatesConfig{GitHubToken: "ghp_x"},
			},
		},
		{
			// The tri-state case: every bool explicitly false must come back
			// as a non-nil pointer to false, not as nil.
			name: "all booleans explicitly false",
			cfg: &Config{
				Role:      "hub",
				Open:      boolPtr(false),
				Tailscale: TailscaleConfig{Serve: boolPtr(false)},
				Auth:      AuthConfig{TwoFA: boolPtr(false), SecureCookies: boolPtr(false)},
			},
		},
		{
			// And the other side of it: absent bools must stay absent.
			name: "all booleans absent",
			cfg:  &Config{Role: "runtime", Addr: "0.0.0.0:9199"},
		},
		{"zero value", &Config{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), FileName)
			if err := Write(path, tc.cfg); err != nil {
				t.Fatalf("Write: %v", err)
			}
			got, err := Load(path)
			if err != nil {
				t.Fatalf("Load after Write: %v", err)
			}
			if !reflect.DeepEqual(got, tc.cfg) {
				raw, _ := os.ReadFile(path)
				t.Fatalf("round trip changed the config:\n got %+v\nwant %+v\nyaml:\n%s", got, tc.cfg, raw)
			}
		})
	}
}

func TestWriteAndWriteDefaultsUseMode0600(t *testing.T) {
	dir := t.TempDir()

	cfgPath := filepath.Join(dir, "written.yaml")
	if err := Write(cfgPath, &Config{Key: "secret"}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	assertMode0600(t, cfgPath)

	defaultsPath := filepath.Join(dir, "defaults.yaml")
	if err := WriteDefaults(defaultsPath); err != nil {
		t.Fatalf("WriteDefaults: %v", err)
	}
	assertMode0600(t, defaultsPath)

	// Overwriting a world-readable file must tighten it, not inherit 0644.
	loose := filepath.Join(dir, "loose.yaml")
	if err := os.WriteFile(loose, []byte("role: hub\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(loose, &Config{Key: "secret"}); err != nil {
		t.Fatalf("Write over an existing file: %v", err)
	}
	assertMode0600(t, loose)
}

func assertMode0600(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("%s has mode %04o, want 0600 (the file holds live API keys)", path, mode)
	}
}

func TestWriteCreatesMissingParentDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "dir", FileName)
	if err := Write(path, &Config{Role: "hub"}); err != nil {
		t.Fatalf("Write into a missing directory: %v", err)
	}
	if _, err := Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

// TestDefaultsYAMLParsesBackCleanly is the guard on the file the server writes
// for itself when it boots without a config: it must survive the same strict
// decoder that rejects unknown keys, and it must decode to exactly Defaults().
func TestDefaultsYAMLParsesBackCleanly(t *testing.T) {
	raw := DefaultsYAML()
	if !strings.Contains(string(raw), "#") {
		t.Fatal("the generated defaults file must carry explanatory comments")
	}
	cfg, err := Parse(raw)
	if err != nil {
		t.Fatalf("the generated defaults file does not parse:\n%v\n---\n%s", err, raw)
	}
	if !reflect.DeepEqual(cfg, Defaults()) {
		t.Fatalf("the generated defaults file drifted from Defaults():\n got %+v\nwant %+v", cfg, Defaults())
	}
}

// TestDefaultsResolveToTodaysBuiltins: writing a defaults file must not change
// how the server behaves. Every value in it has to resolve to the same thing a
// server with no config file at all resolves to.
func TestDefaultsResolveToTodaysBuiltins(t *testing.T) {
	for _, key := range []string{"DEVDECK_ROLE", "DEVDECK_ADDR", "DEVDECK_DB", "DEVDECK_KEY", "DEVDECK_OPEN", "DEVDECK_2FA", "DEVDECK_SECURE_COOKIES", "DEVDECK_TAILSCALE_SERVE", "DEVDECK_ONLY_FROM", "DEVDECK_TRUSTED_PROXIES"} {
		t.Setenv(key, "")
	}
	cfg, err := Parse(DefaultsYAML())
	if err != nil {
		t.Fatalf("Parse(DefaultsYAML()): %v", err)
	}
	withDefaults := resolveFlags(t, cfg, nil)
	withoutConfig := resolveFlags(t, &Config{}, nil)
	if withDefaults != withoutConfig {
		t.Fatalf("the generated defaults file changes behaviour:\n with %+v\nwithout %+v", withDefaults, withoutConfig)
	}
}

func TestWriteDefaultsRoundTripsThroughLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), FileName)
	if err := WriteDefaults(path); err != nil {
		t.Fatalf("WriteDefaults: %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load(WriteDefaults output): %v", err)
	}
	if !reflect.DeepEqual(cfg, Defaults()) {
		t.Fatalf("Load(WriteDefaults output) = %+v, want %+v", cfg, Defaults())
	}
}

func TestMarshalIsAcceptedByTheStrictDecoder(t *testing.T) {
	cfg, err := Parse([]byte(fullYAML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	raw, err := Marshal(cfg)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	back, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse(Marshal(cfg)) failed — every emitted key must be a known key:\n%v\n---\n%s", err, raw)
	}
	if !reflect.DeepEqual(back, cfg) {
		t.Fatalf("Marshal/Parse round trip differs:\n got %+v\nwant %+v", back, cfg)
	}
}

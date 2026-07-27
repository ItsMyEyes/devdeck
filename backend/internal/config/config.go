package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// FileName is the config file's name at every implicit lookup location.
const FileName = "devdeck.yaml"

// EnvVar names the environment variable that points at an explicit config
// file, the env-var twin of the --config flag.
const EnvVar = "DEVDECK_CONFIG"

// osExecutable is a seam for tests; production code always uses os.Executable.
var osExecutable = os.Executable

// Config mirrors devdeck.yaml — one key per flag in cmd/server/main.go,
// grouped by concern. Every value is optional: the zero Config resolves to
// exactly the built-in defaults, which is what a server with no config file
// at all gets.
//
// Booleans are *bool so "key absent" (nil) stays distinguishable from
// "explicitly false", the same convention internal/domain's patch structs use.
// Without it, `two_fa: false` would be indistinguishable from omitting the key
// and could never turn 2FA off. Use PickBool, never a bare dereference.
type Config struct {
	Role string `yaml:"role,omitempty"` // hub | runtime | both
	Addr string `yaml:"addr,omitempty"`
	DB   string `yaml:"db,omitempty"`
	Key  string `yaml:"key,omitempty"` // this machine's API key
	Open *bool  `yaml:"open,omitempty"`

	Machine   MachineConfig   `yaml:"machine,omitempty"`
	Hub       HubConfig       `yaml:"hub,omitempty"`
	Tailscale TailscaleConfig `yaml:"tailscale,omitempty"`
	Auth      AuthConfig      `yaml:"auth,omitempty"`
	Network   NetworkConfig   `yaml:"network,omitempty"`
	Tools     ToolsConfig     `yaml:"tools,omitempty"`
	Proxy     ProxyConfig     `yaml:"proxy,omitempty"`
	Updates   UpdatesConfig   `yaml:"updates,omitempty"`
}

// MachineConfig is how this machine identifies itself to a hub.
type MachineConfig struct {
	Name      string `yaml:"name,omitempty"`       // --name
	PublicURL string `yaml:"public_url,omitempty"` // --public-url
}

// HubConfig is runtime-only: the hub this machine self-registers with.
type HubConfig struct {
	URL string `yaml:"url,omitempty"` // --hub-url
	Key string `yaml:"key,omitempty"` // --hub-key
}

// TailscaleConfig controls the optional `tailscale serve` sidecar.
type TailscaleConfig struct {
	Serve *bool `yaml:"serve,omitempty"` // --enable-tailscale-serve
}

// AuthConfig covers login hardening.
type AuthConfig struct {
	TwoFA         *bool           `yaml:"two_fa,omitempty"`         // --2fa
	SecureCookies *bool           `yaml:"secure_cookies,omitempty"` // --secure-cookies
	Turnstile     TurnstileConfig `yaml:"turnstile,omitempty"`
}

// TurnstileConfig holds the Cloudflare Turnstile key pair; both must be set
// for login to require a challenge.
type TurnstileConfig struct {
	SiteKey   string `yaml:"site_key,omitempty"`   // --turnstile-site-key
	SecretKey string `yaml:"secret_key,omitempty"` // --turnstile-secret-key
}

// NetworkConfig covers access control and client-IP resolution. The list
// fields are joined with "," by JoinList before reaching the existing
// comma-separated flag parsers.
type NetworkConfig struct {
	OnlyFrom       []string `yaml:"only_from,omitempty"`        // --only-from
	TrustedProxies []string `yaml:"trusted_proxies,omitempty"`  // --trusted-proxies
	ClientIPHeader string   `yaml:"client_ip_header,omitempty"` // --client-ip-header
}

// ToolsConfig points at the external binaries the Tools module shells out to.
type ToolsConfig struct {
	PythonBin string `yaml:"python_bin,omitempty"` // --python-bin
	PandocBin string `yaml:"pandoc_bin,omitempty"` // --pandoc-bin
	MmdcBin   string `yaml:"mmdc_bin,omitempty"`   // --mmdc-bin
}

// ProxyConfig configures the optional SOCKS5 / HTTP forward proxies.
type ProxyConfig struct {
	Socks5Addr string `yaml:"socks5_addr,omitempty"` // --socks5-addr
	HTTPAddr   string `yaml:"http_addr,omitempty"`   // --http-proxy-addr
	Key        string `yaml:"key,omitempty"`         // --proxy-key
}

// UpdatesConfig holds the credential for the private release repo.
type UpdatesConfig struct {
	GitHubToken string `yaml:"github_token,omitempty"` // --github-token
}

// Pick returns the YAML value when it is set, otherwise the built-in default.
// An empty string counts as unset, matching how main.go's envOr already treats
// an empty environment variable.
func Pick(yamlValue, builtinDefault string) string {
	if yamlValue != "" {
		return yamlValue
	}
	return builtinDefault
}

// PickBool returns the YAML value when the key was present, otherwise the
// built-in default. It keys off nil, not off false — that is the whole reason
// Config's booleans are pointers.
func PickBool(yamlValue *bool, builtinDefault bool) bool {
	if yamlValue != nil {
		return *yamlValue
	}
	return builtinDefault
}

// JoinList renders a YAML list as the comma-separated string the existing flag
// parsers expect. Blank entries are dropped and surrounding whitespace trimmed,
// so an all-blank list collapses to "" and Pick treats it as unset.
func JoinList(values []string) string {
	kept := make([]string, 0, len(values))
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			kept = append(kept, v)
		}
	}
	return strings.Join(kept, ",")
}

// Parse decodes a devdeck.yaml document strictly: an unknown key is a hard
// error naming the key and its line. A typo'd key that silently does nothing
// is the worst failure mode for a config file — it looks configured and
// behaves as if it were not. An empty document is valid and yields the zero
// Config.
func Parse(data []byte) (*Config, error) {
	var cfg Config
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&cfg); err != nil {
		if errors.Is(err, io.EOF) {
			return &cfg, nil // empty or comments-only file
		}
		return nil, err
	}
	return &cfg, nil
}

// Load reads and strictly parses the config file at path. A missing file is an
// error here — callers that treat absence as acceptable (the implicit lookup
// locations) check for it with errors.Is(err, fs.ErrNotExist), which Resolve
// does for them.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	cfg, err := Parse(data)
	if err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	return cfg, nil
}

// DefaultPath is the last lookup location and the place a defaults file is
// written: devdeck.yaml beside the executable. It matches the convention
// main.go's defaultDBPath already uses for data/devdeck.db, and falls back to
// a bare relative name when the executable cannot be located.
func DefaultPath() string {
	exe, err := osExecutable()
	if err != nil {
		return FileName
	}
	return filepath.Join(filepath.Dir(exe), FileName)
}

// SearchPaths returns the config locations to try, in order. An explicit path
// — from --config, or from DEVDECK_CONFIG when the flag is empty — short
// circuits the search: it is the only candidate, and Resolve errors if it does
// not exist. Otherwise the candidates are ./devdeck.yaml then
// <dir of executable>/devdeck.yaml.
func SearchPaths(explicit string) []string {
	if explicit == "" {
		explicit = os.Getenv(EnvVar)
	}
	if explicit != "" {
		return []string{explicit}
	}
	paths := []string{FileName}
	if cwd, err := os.Getwd(); err == nil {
		paths[0] = filepath.Join(cwd, FileName)
	}
	if exeDir := DefaultPath(); exeDir != paths[0] {
		paths = append(paths, exeDir)
	}
	return paths
}

// Resolve finds and loads the config file, returning it along with the path it
// came from. When no config file exists at any implicit location it returns an
// empty Config and an empty path with no error — Pick/PickBool then hand back
// the built-in defaults, so callers never need a nil check.
//
// A file named by --config or DEVDECK_CONFIG that does not exist IS an error:
// the operator asked for that file by name.
func Resolve(explicit string) (*Config, string, error) {
	candidates := SearchPaths(explicit)
	explicitlyNamed := explicit != "" || os.Getenv(EnvVar) != ""

	for _, path := range candidates {
		cfg, err := Load(path)
		switch {
		case err == nil:
			return cfg, path, nil
		case errors.Is(err, fs.ErrNotExist) && !explicitlyNamed:
			continue // this location simply isn't in use
		default:
			return nil, "", err
		}
	}
	return &Config{}, "", nil
}

// Defaults returns the built-in defaults as a Config: the values a server
// resolves to when no config file, environment variable, or flag is present.
// It is what DefaultsYAML documents, and what the setup wizard pre-fills from.
//
// Keys whose default is derived at runtime (db, python_bin) or that have no
// default (every secret, machine name, hub URL) stay empty, so writing this
// file changes nothing about how the server boots.
func Defaults() *Config {
	no, yes := false, true
	return &Config{
		Role:      "hub",
		Addr:      "127.0.0.1:8989",
		Open:      &yes,
		Tailscale: TailscaleConfig{Serve: &no},
		Auth:      AuthConfig{TwoFA: &yes, SecureCookies: &yes},
		// Non-nil empty slices, matching the literal `[]` in DefaultsYAML.
		Network: NetworkConfig{OnlyFrom: []string{}, TrustedProxies: []string{}},
		Tools:   ToolsConfig{PandocBin: "pandoc", MmdcBin: "mmdc"},
	}
}

// defaultsTemplate is the commented file written when the server boots without
// a config. It is hand-written rather than marshalled because the comments are
// the point — this file is the schema documentation an operator edits. Its
// values must stay in sync with Defaults(); a test parses it back and compares.
const defaultsTemplate = `# devdeck.yaml — DevDeck server configuration.
#
# Every key is optional. An omitted or empty value falls back to the built-in
# default noted in the comment above it. Precedence, lowest to highest:
#
#   built-in default  <  this file  <  DEVDECK_* env var  <  command-line flag
#
# Unknown keys are a hard error: a typo here stops the server at startup
# instead of silently doing nothing. Changes take effect on restart.
#
# This file may contain live API keys; it is written with mode 0600 and must
# stay out of version control.

# Server role (--role):
#   hub     organizational data + machine registry + proxy + web UI
#   runtime headless execution daemon, key auth only
#   both    a hub that also self-registers as its own execution machine
role: hub

# Listen address (--addr). Runtimes usually want 0.0.0.0:9199.
addr: 127.0.0.1:8989

# SQLite database path (--db). Empty = <dir of executable>/data/devdeck.db
db: ""

# This machine's static API key (--key). Required for role runtime; optional
# bearer auth for role hub (desktop clients).
key: ""

# Open the embedded UI in the default browser on start (--open).
open: true

machine:
  # Display name in the hub's Machines UI (--name). Empty = OS hostname.
  name: ""
  # This machine's own reachable URL, advertised to the hub during
  # self-registration (--public-url). Empty = http://<addr>
  public_url: ""

# Runtime only: the hub this machine self-registers with on startup.
hub:
  # Hub base URL (--hub-url). Empty disables self-registration.
  url: ""
  # The hub's bearer key (--hub-key). Required when url is set.
  key: ""

tailscale:
  # Expose the server on your tailnet by running ` + "`tailscale serve <port>`" + `
  # alongside it (--enable-tailscale-serve). Requires the tailscale CLI.
  serve: false

auth:
  # Require TOTP two-factor authentication at login (--2fa).
  two_fa: true
  # Set the Secure attribute on auth cookies (--secure-cookies).
  # Disable only for loopback desktop deployments.
  secure_cookies: true
  turnstile:
    # Cloudflare Turnstile keys (--turnstile-site-key / --turnstile-secret-key).
    # With both set, login requires passing a Turnstile challenge.
    site_key: ""
    secret_key: ""

network:
  # IPs/CIDRs allowed to reach the server (--only-from). Empty = no restriction.
  only_from: []
  # Proxy IPs/CIDRs whose forwarding headers are trusted when resolving the
  # client IP (--trusted-proxies).
  trusted_proxies: []
  # Trusted header carrying the real client IP, e.g. CF-Connecting-IP behind a
  # Cloudflare Tunnel (--client-ip-header). Only honored when the direct peer
  # is listed in trusted_proxies.
  client_ip_header: ""

tools:
  # Python interpreter running the markitdown conversion script (--python-bin).
  # Empty = ./tools/venv/bin/python3 when present, otherwise python3.
  python_bin: ""
  # pandoc binary for markdown -> docx/pdf export (--pandoc-bin).
  pandoc_bin: pandoc
  # mermaid-cli binary for rendering diagrams during export (--mmdc-bin).
  mmdc_bin: mmdc

proxy:
  # SOCKS5 forward-proxy listen address (--socks5-addr). Empty = disabled.
  socks5_addr: ""
  # HTTP/HTTPS forward-proxy listen address (--http-proxy-addr). Empty = disabled.
  http_addr: ""
  # Credential required by the forward proxies (--proxy-key). Empty = no auth.
  key: ""

updates:
  # GitHub token used to check for and download releases (--github-token).
  github_token: ""
`

// DefaultsYAML returns the commented defaults document. It parses cleanly
// through the strict decoder and decodes to exactly Defaults().
func DefaultsYAML() []byte {
	return []byte(defaultsTemplate)
}

// Marshal renders a Config as YAML. Unset fields are omitted, so the output
// says only what was actually configured.
func Marshal(cfg *Config) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(cfg); err != nil {
		return nil, fmt.Errorf("config: encode: %w", err)
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("config: encode: %w", err)
	}
	return buf.Bytes(), nil
}

// Write saves cfg to path with mode 0600 — the file holds live API keys.
func Write(path string, cfg *Config) error {
	data, err := Marshal(cfg)
	if err != nil {
		return err
	}
	return writeSecret(path, data)
}

// WriteDefaults writes the commented defaults file to path with mode 0600.
// This is what a non-interactive server does when it boots without a config:
// leave a documented, editable file behind rather than blocking on a prompt.
func WriteDefaults(path string) error {
	return writeSecret(path, DefaultsYAML())
}

// writeSecret writes data at mode 0600, creating parent directories as needed
// and tightening the permissions of an already-existing file (os.WriteFile
// keeps the old mode when the file exists).
func writeSecret(path string, data []byte) error {
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("config: %w", err)
		}
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	return nil
}

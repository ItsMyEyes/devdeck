# Published SOCKS5 Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any machine (hub or runtime) publish a persistent, key-authenticated SOCKS5 proxy that other tools reuse, toggled live from Settings with no restart.

**Architecture:** A machine-local service owns one long-lived listener, persisted in the per-machine `settings` singleton so it survives restart. Two REST routes registered on every role expose it; the frontend reaches any machine through the existing direct-first-then-hub-proxy `machineRequest` transport, so no new hub route is needed.

**Tech Stack:** Go 1.26, `net`, existing `internal/netproxy` SOCKS5 server, SQLite via `internal/store`, React 19 + TanStack Query + `@base-ui/react` Switch, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-published-socks5-design.md`

## Global Constraints

- All API responses use the `{"error":"message"}` envelope. Use `writeErr(w, status, msg)` / `writeJSON(w, status, v)` from `internal/handler`. Never return raw SQL errors.
- All persistence goes through the `port.Store` interface. Never bypass it.
- `frontend/src/store/types.ts` and `backend/internal/domain/models.go` must stay in sync.
- Frontend imports use the `@/*` alias. Never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Icons: `lucide-react` only. Toasts: `sonner`. Class merging: `cn()` from `@/lib/utils`.
- Every data surface renders explicit loading, error, and empty states.
- **New frontend test files must be added to the `test.include` allowlist in `frontend/vite.config.ts`** or they will not run.
- **Convergence files — do not edit these from parallel agents:** `backend/internal/domain/models.go`, `backend/internal/port/store.go`, `backend/cmd/server/main.go`, `frontend/src/store/types.ts`. This plan is sequential, so that is satisfied by construction.
- Verify with `npm run typecheck` (in `frontend/`) and `go vet ./...` (in `backend/`).
- The pre-commit hook runs an unscoped full-project typecheck. If it fails on code unrelated to your task, verify the failure is pre-existing (`git stash && npm run typecheck`) before using `--no-verify`.

---

### Task 1: Domain type, schema column, and store methods

**Files:**
- Modify: `backend/internal/domain/models.go` (append after `Settings`, ~line 220)
- Modify: `backend/internal/store/db.go` (settings table ~line 273; migration list ~line 381; new migration func after `migrateSettingsSignInPIN` ~line 400)
- Modify: `backend/internal/store/settings.go` (append)
- Modify: `backend/internal/port/store.go` (Settings section, ~line 13-20)
- Test: `backend/internal/store/settings_socks_test.go` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `domain.PublishedSOCKSConfig{Enabled bool; Port int; Key string}`; `Store.PublishedSOCKS() (domain.PublishedSOCKSConfig, error)`; `Store.SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error`. Task 2 consumes both methods through a narrow interface.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/store/settings_socks_test.go`:

```go
package store

import "testing"

func TestPublishedSOCKSDefaultsOnFreshDB(t *testing.T) {
	s := newTestStore(t)

	cfg, err := s.PublishedSOCKS()
	if err != nil {
		t.Fatalf("PublishedSOCKS: %v", err)
	}
	if cfg.Enabled {
		t.Errorf("Enabled = true on a fresh db, want false")
	}
	if cfg.Port != 1080 {
		t.Errorf("Port = %d, want 1080", cfg.Port)
	}
	if cfg.Key != "" {
		t.Errorf("Key = %q, want empty", cfg.Key)
	}
}

func TestSetPublishedSOCKSRoundTrips(t *testing.T) {
	s := newTestStore(t)

	want := domain.PublishedSOCKSConfig{Enabled: true, Port: 1081, Key: "abc123"}
	if err := s.SetPublishedSOCKS(want); err != nil {
		t.Fatalf("SetPublishedSOCKS: %v", err)
	}

	got, err := s.PublishedSOCKS()
	if err != nil {
		t.Fatalf("PublishedSOCKS: %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}
```

Add `"devdeck/backend/internal/domain"` to that file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/store/ -run 'PublishedSOCKS' -v`
Expected: FAIL — compile error, `s.PublishedSOCKS undefined` and `domain.PublishedSOCKSConfig` undefined.

- [ ] **Step 3: Add the domain type**

In `backend/internal/domain/models.go`, after the `Settings` struct:

```go
// PublishedSOCKSConfig is one machine's persistent forward-proxy publication
// state, stored on that machine's own settings singleton. Distinct from the
// ephemeral, unauthenticated pair service.ProxyService starts for the desktop
// webview: this one is operator-toggled, fixed-port, and always keyed.
//
// Key is deliberately serializable — like Machine.Key, it is a credential the
// operator must be able to read and paste into another tool. It rides only on
// the authenticated /api/proxy/publish routes, never on GET /api/settings.
type PublishedSOCKSConfig struct {
	Enabled bool   `json:"enabled"`
	Port    int    `json:"port"`
	Key     string `json:"key"`
}
```

- [ ] **Step 4: Add the schema columns and migration**

In `backend/internal/store/db.go`, add to the `settings` CREATE TABLE (after `signin_pin_hash`):

```sql
  ,
  -- Persistent SOCKS5 forward-proxy publication for THIS machine. Survives
  -- restart: enabled=1 re-binds on boot. See
  -- docs/superpowers/specs/2026-08-06-published-socks5-design.md
  socks_publish_enabled INTEGER NOT NULL DEFAULT 0,
  socks_publish_port    INTEGER NOT NULL DEFAULT 1080,
  socks_publish_key     TEXT NOT NULL DEFAULT ''
```

Add the migration function after `migrateSettingsSignInPIN`:

```go
// migrateSettingsPublishedSOCKS adds the published-SOCKS5 columns
// (introduced when the proxy became toggleable from Settings) to
// pre-existing databases.
func migrateSettingsPublishedSOCKS(db *sql.DB) error {
	cols := []string{
		"socks_publish_enabled INTEGER NOT NULL DEFAULT 0",
		"socks_publish_port INTEGER NOT NULL DEFAULT 1080",
		"socks_publish_key TEXT NOT NULL DEFAULT ''",
	}
	for _, col := range cols {
		if _, err := db.Exec("ALTER TABLE settings ADD COLUMN " + col); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	return nil
}
```

Register it in `Open`, immediately after the `migrateSettingsSignInPIN` block (~line 381):

```go
	if err := migrateSettingsPublishedSOCKS(db); err != nil {
		return nil, err
	}
```

- [ ] **Step 5: Add the store methods**

Append to `backend/internal/store/settings.go`:

```go
// PublishedSOCKS returns this machine's forward-proxy publication state.
// Kept off Settings()/domain.Settings for the same reason SignInPINHash is:
// the key must never ride along in the JSON GET /api/settings serves.
func (s *Store) PublishedSOCKS() (domain.PublishedSOCKSConfig, error) {
	var cfg domain.PublishedSOCKSConfig
	err := s.db.QueryRow(
		`SELECT socks_publish_enabled, socks_publish_port, socks_publish_key FROM settings WHERE id = 1`,
	).Scan(&cfg.Enabled, &cfg.Port, &cfg.Key)
	return cfg, err
}

// SetPublishedSOCKS replaces this machine's forward-proxy publication state.
func (s *Store) SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error {
	_, err := s.db.Exec(
		`UPDATE settings SET socks_publish_enabled = ?, socks_publish_port = ?, socks_publish_key = ? WHERE id = 1`,
		cfg.Enabled, cfg.Port, cfg.Key,
	)
	return err
}
```

- [ ] **Step 6: Add both methods to the Store interface**

In `backend/internal/port/store.go`, in the Settings block (after `SetSignInPINHash`):

```go
	// Published SOCKS5 forward proxy for this machine. Kept off
	// domain.Settings so the key can never leak through GET /api/settings.
	PublishedSOCKS() (domain.PublishedSOCKSConfig, error)
	SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd backend && go test ./internal/store/ -run 'PublishedSOCKS' -v && go vet ./...`
Expected: both tests PASS, vet clean.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/domain/models.go backend/internal/store/db.go \
        backend/internal/store/settings.go backend/internal/store/settings_socks_test.go \
        backend/internal/port/store.go
git commit -m "feat(proxy): persist published SOCKS5 config on the settings singleton"
```

---

### Task 2: PublishedSOCKSService

**Files:**
- Create: `backend/internal/service/publishedsocks.go`
- Test: `backend/internal/service/publishedsocks_test.go` (create)

**Interfaces:**
- Consumes: `domain.PublishedSOCKSConfig`, `Store.PublishedSOCKS`, `Store.SetPublishedSOCKS` from Task 1.
- Produces:
  - `service.PublishedSOCKSStore` interface (the two store methods)
  - `service.NewPublishedSOCKSService(store PublishedSOCKSStore, advertiseHost string) *PublishedSOCKSService`
  - `(*PublishedSOCKSService).Status() (domain.PublishedSOCKSStatus, error)`
  - `(*PublishedSOCKSService).Apply(enabled bool, port int, rotateKey bool) (domain.PublishedSOCKSStatus, error)`
  - `(*PublishedSOCKSService).StartIfEnabled() error`
  - `domain.PublishedSOCKSStatus` (added to models.go in this task)

  Task 3 consumes `Status` and `Apply`; Task 4 consumes `StartIfEnabled` and the constructor.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/service/publishedsocks_test.go`:

```go
package service

import (
	"encoding/binary"
	"net"
	"strconv"
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

// fakeSOCKSStore is an in-memory PublishedSOCKSStore.
type fakeSOCKSStore struct {
	cfg domain.PublishedSOCKSConfig
	err error
}

func (f *fakeSOCKSStore) PublishedSOCKS() (domain.PublishedSOCKSConfig, error) {
	return f.cfg, f.err
}

func (f *fakeSOCKSStore) SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error {
	if f.err != nil {
		return f.err
	}
	f.cfg = cfg
	return nil
}

func newTestSOCKSService(t *testing.T) (*PublishedSOCKSService, *fakeSOCKSStore) {
	t.Helper()
	store := &fakeSOCKSStore{cfg: domain.PublishedSOCKSConfig{Port: 1080}}
	svc := NewPublishedSOCKSService(store, "127.0.0.1")
	t.Cleanup(func() { _ = svc.Stop() })
	return svc, store
}

// socksConnect performs an RFC1928 handshake with RFC1929 user/pass auth and
// asks the proxy to CONNECT to target. It returns the reply code byte.
func socksConnect(t *testing.T, proxyAddr, password, target string) byte {
	t.Helper()
	conn, err := net.DialTimeout("tcp", proxyAddr, 3*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(3 * time.Second))

	// Greeting: version 5, 1 method, username/password.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x02}); err != nil {
		t.Fatalf("write greeting: %v", err)
	}
	sel := make([]byte, 2)
	if _, err := conn.Read(sel); err != nil {
		t.Fatalf("read method selection: %v", err)
	}
	if sel[1] != 0x02 {
		t.Fatalf("server selected method %#x, want 0x02 (user/pass)", sel[1])
	}

	// RFC1929: ver=1, ulen=1, "d", plen, password.
	auth := []byte{0x01, 0x01, 'd', byte(len(password))}
	auth = append(auth, []byte(password)...)
	if _, err := conn.Write(auth); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	authResp := make([]byte, 2)
	if _, err := conn.Read(authResp); err != nil {
		t.Fatalf("read auth response: %v", err)
	}
	if authResp[1] != 0x00 {
		return 0xff // auth rejected — caller asserts on this
	}

	host, portStr, err := net.SplitHostPort(target)
	if err != nil {
		t.Fatalf("split target: %v", err)
	}
	port, _ := strconv.Atoi(portStr)
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, []byte(host)...)
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := conn.Write(req); err != nil {
		t.Fatalf("write connect request: %v", err)
	}
	reply := make([]byte, 10)
	if _, err := conn.Read(reply); err != nil {
		t.Fatalf("read connect reply: %v", err)
	}
	return reply[1]
}

// freePort returns a port that was free a moment ago.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestApplyEnableBindsAndAuthenticates(t *testing.T) {
	svc, store := newTestSOCKSService(t)
	// A real upstream for the proxy to CONNECT to.
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	port := freePort(t)
	status, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !status.Running {
		t.Fatalf("Running = false, want true (status %+v)", status)
	}
	if status.Key == "" {
		t.Fatal("Key is empty; enabling must generate one")
	}
	if store.cfg.Key != status.Key || !store.cfg.Enabled {
		t.Errorf("store not persisted: %+v", store.cfg)
	}

	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, status.Key, upstream.Addr().String()); code != 0x00 {
		t.Errorf("CONNECT reply = %#x, want 0x00 (succeeded)", code)
	}
}

func TestApplyRejectsWrongPassword(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	port := freePort(t)
	if _, err := svc.Apply(true, port, false); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, "not-the-key", "127.0.0.1:9"); code != 0xff {
		t.Errorf("reply = %#x, want 0xff (auth rejected)", code)
	}
}

func TestApplyDisableClosesListener(t *testing.T) {
	svc, store := newTestSOCKSService(t)
	port := freePort(t)
	if _, err := svc.Apply(true, port, false); err != nil {
		t.Fatalf("enable: %v", err)
	}

	status, err := svc.Apply(false, 0, false)
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	if status.Running || status.Enabled {
		t.Fatalf("status after disable = %+v, want stopped", status)
	}
	if store.cfg.Enabled {
		t.Error("store still says enabled")
	}
	if _, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second); err == nil {
		t.Error("port still accepts connections after disable")
	}
}

func TestApplyIsIdempotent(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	port := freePort(t)

	first, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("first Apply: %v", err)
	}
	second, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("second Apply: %v", err)
	}
	if first.Key != second.Key || first.BoundAddr != second.BoundAddr {
		t.Errorf("re-apply changed state:\nfirst:  %+v\nsecond: %+v", first, second)
	}
}

func TestApplyRotateKeyChangesKeyAndStillServes(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	port := freePort(t)
	first, err := svc.Apply(true, port, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}

	second, err := svc.Apply(true, port, true)
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if second.Key == first.Key {
		t.Fatal("rotateKey did not change the key")
	}
	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, first.Key, "127.0.0.1:9"); code != 0xff {
		t.Errorf("old key still accepted (reply %#x)", code)
	}
}

func TestApplyRejectsInvalidPort(t *testing.T) {
	svc, _ := newTestSOCKSService(t)
	if _, err := svc.Apply(true, 70000, false); err == nil {
		t.Fatal("Apply accepted port 70000, want error")
	}
}

func TestApplyPortConflictReturnsErrorNotPanic(t *testing.T) {
	svc, store := newTestSOCKSService(t)
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	busy := blocker.Addr().(*net.TCPAddr).Port

	if _, err := svc.Apply(true, busy, false); err == nil {
		t.Fatal("Apply succeeded on a busy port, want error")
	}
	if store.cfg.Enabled {
		t.Error("failed bind must not persist enabled=true")
	}
}

func TestStartIfEnabledBindsWhenStoredEnabled(t *testing.T) {
	port := freePort(t)
	store := &fakeSOCKSStore{cfg: domain.PublishedSOCKSConfig{
		Enabled: true, Port: port, Key: "stored-key",
	}}
	svc := NewPublishedSOCKSService(store, "127.0.0.1")
	t.Cleanup(func() { _ = svc.Stop() })

	if err := svc.StartIfEnabled(); err != nil {
		t.Fatalf("StartIfEnabled: %v", err)
	}
	proxyAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	if code := socksConnect(t, proxyAddr, "stored-key", "127.0.0.1:9"); code == 0xff {
		t.Error("stored key was rejected after StartIfEnabled")
	}
}

func TestStartIfEnabledNoopWhenDisabled(t *testing.T) {
	store := &fakeSOCKSStore{cfg: domain.PublishedSOCKSConfig{Enabled: false, Port: 1080}}
	svc := NewPublishedSOCKSService(store, "127.0.0.1")
	if err := svc.StartIfEnabled(); err != nil {
		t.Fatalf("StartIfEnabled: %v", err)
	}
	status, err := svc.Status()
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if status.Running {
		t.Error("Running = true, want false when stored config is disabled")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run 'SOCKS|Apply|StartIfEnabled' -v`
Expected: FAIL — compile error, `NewPublishedSOCKSService` undefined.

- [ ] **Step 3: Add the status type to the domain**

In `backend/internal/domain/models.go`, immediately after `PublishedSOCKSConfig`:

```go
// PublishedSOCKSStatus is PublishedSOCKSConfig plus live liveness, as served
// by GET/PUT /api/proxy/publish. Enabled is operator intent; Running is what
// is actually bound right now — they differ when a boot-time bind failed.
type PublishedSOCKSStatus struct {
	Enabled   bool   `json:"enabled"`
	Port      int    `json:"port"`
	Running   bool   `json:"running"`
	BoundAddr string `json:"boundAddr,omitempty"`
	// URL is the copy-ready socks5://devdeck:<key>@<advertiseHost>:<port>,
	// empty when not running.
	URL string `json:"url,omitempty"`
	Key string `json:"key"`
}
```

- [ ] **Step 4: Write the service**

Create `backend/internal/service/publishedsocks.go`:

```go
package service

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"sync"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/netproxy"
)

// defaultPublishedSOCKSPort is the conventional SOCKS5 port, used when a
// machine has never been configured.
const defaultPublishedSOCKSPort = 1080

// publishedSOCKSUser is the username half of the RFC 1929 credential. The
// SOCKS5 server accepts any username and checks only the password, but
// clients must send something, so the UI advertises a fixed one.
const publishedSOCKSUser = "devdeck"

// PublishedSOCKSStore is the narrow slice of port.Store this service needs,
// following the sshmgr.ConnStore precedent rather than taking the whole
// interface.
type PublishedSOCKSStore interface {
	PublishedSOCKS() (domain.PublishedSOCKSConfig, error)
	SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error
}

// PublishedSOCKSService owns one long-lived, always-authenticated SOCKS5
// listener so other tools (a browser, curl, k9s) can route through this
// machine's network.
//
// Deliberately NOT an extension of ProxyService. That one binds ephemeral
// ports, dies with the process, and is unauthenticated by necessity — no
// platform's webview proxy_url can carry credentials (see ProxyService.Start).
// This one is operator-toggled, fixed-port, persisted, and refuses to bind
// without a key. The two coexist without interacting.
type PublishedSOCKSService struct {
	store PublishedSOCKSStore
	// advertiseHost is this machine's tailnet-reachable hostname. The
	// listener binds all interfaces, but the advertised URL must not be the
	// bind address: whoever dials this proxy is usually on another machine.
	advertiseHost string

	mu      sync.Mutex
	ln      net.Listener
	running domain.PublishedSOCKSConfig
}

func NewPublishedSOCKSService(store PublishedSOCKSStore, advertiseHost string) *PublishedSOCKSService {
	return &PublishedSOCKSService{store: store, advertiseHost: advertiseHost}
}

// generatePublishedSOCKSKey mints a 32-byte hex credential.
//
// setupui.GenerateKey does the same thing, but setupui is the interactive
// `devdeck setup` wizard; importing a CLI wizard into the service layer for a
// five-line helper is the wrong dependency direction, so this is local.
func generatePublishedSOCKSKey() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand.Read never fails on any supported platform; a failure
		// here means the system CSPRNG is broken and silently continuing
		// would mint a predictable proxy credential.
		panic("service: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(buf)
}

// Status reports stored intent plus what is actually bound right now.
func (s *PublishedSOCKSService) Status() (domain.PublishedSOCKSStatus, error) {
	cfg, err := s.store.PublishedSOCKS()
	if err != nil {
		return domain.PublishedSOCKSStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked(cfg), nil
}

func (s *PublishedSOCKSService) statusLocked(cfg domain.PublishedSOCKSConfig) domain.PublishedSOCKSStatus {
	status := domain.PublishedSOCKSStatus{
		Enabled: cfg.Enabled,
		Port:    cfg.Port,
		Key:     cfg.Key,
		Running: s.ln != nil,
	}
	if s.ln != nil {
		status.BoundAddr = s.ln.Addr().String()
		hostPort := net.JoinHostPort(s.advertiseHost, strconv.Itoa(s.running.Port))
		status.URL = (&url.URL{
			Scheme: "socks5",
			User:   url.UserPassword(publishedSOCKSUser, s.running.Key),
			Host:   hostPort,
		}).String()
	}
	return status
}

// Apply is the single mutation point. It resolves the desired config, stops
// any listener whose port or key changed, binds the new one, and only then
// persists — so a failed bind never leaves the DB claiming a live listener.
//
// port <= 0 means "keep the stored port".
func (s *PublishedSOCKSService) Apply(enabled bool, port int, rotateKey bool) (domain.PublishedSOCKSStatus, error) {
	cfg, err := s.store.PublishedSOCKS()
	if err != nil {
		return domain.PublishedSOCKSStatus{}, err
	}
	if port > 0 {
		cfg.Port = port
	}
	if cfg.Port <= 0 {
		cfg.Port = defaultPublishedSOCKSPort
	}
	if cfg.Port > 65535 {
		return domain.PublishedSOCKSStatus{}, fmt.Errorf("port %d is out of range (1-65535)", cfg.Port)
	}
	// An empty stored key is treated as "rotate" rather than binding open:
	// there is no reachable path to an unauthenticated published listener.
	if rotateKey || cfg.Key == "" {
		cfg.Key = generatePublishedSOCKSKey()
	}
	cfg.Enabled = enabled

	s.mu.Lock()
	defer s.mu.Unlock()

	if !enabled {
		s.stopLocked()
		if err := s.store.SetPublishedSOCKS(cfg); err != nil {
			return domain.PublishedSOCKSStatus{}, err
		}
		return s.statusLocked(cfg), nil
	}

	if s.ln != nil && s.running == cfg {
		return s.statusLocked(cfg), nil // already serving exactly this
	}
	s.stopLocked()
	if err := s.bindLocked(cfg); err != nil {
		// Intent is not persisted on a failed bind: a machine that cannot
		// bind must come back disabled rather than retrying every boot.
		cfg.Enabled = false
		_ = s.store.SetPublishedSOCKS(cfg)
		return domain.PublishedSOCKSStatus{}, err
	}
	if err := s.store.SetPublishedSOCKS(cfg); err != nil {
		s.stopLocked()
		return domain.PublishedSOCKSStatus{}, err
	}
	return s.statusLocked(cfg), nil
}

// StartIfEnabled binds the stored config on boot. A failure is returned for
// the caller to log, never fatal: unlike the --socks5-addr flag (operator-typed
// at launch), this config is replayed automatically, so a since-taken port
// must not stop the server from starting.
func (s *PublishedSOCKSService) StartIfEnabled() error {
	cfg, err := s.store.PublishedSOCKS()
	if err != nil {
		return err
	}
	if !cfg.Enabled || cfg.Key == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bindLocked(cfg)
}

// Stop closes the listener without changing stored intent.
func (s *PublishedSOCKSService) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
	return nil
}

func (s *PublishedSOCKSService) bindLocked(cfg domain.PublishedSOCKSConfig) error {
	if cfg.Key == "" {
		return fmt.Errorf("refusing to publish a SOCKS5 proxy without a key")
	}
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(cfg.Port))
	if err != nil {
		return fmt.Errorf("port %d unavailable: %w", cfg.Port, err)
	}
	srv := netproxy.NewSOCKS5Server(cfg.Key)
	go func() {
		// Serve returns when the listener is closed by stopLocked, which is
		// an ordinary shutdown, not an error worth surfacing.
		_ = srv.Serve(ln)
	}()
	s.ln = ln
	s.running = cfg
	return nil
}

func (s *PublishedSOCKSService) stopLocked() {
	if s.ln != nil {
		_ = s.ln.Close()
		s.ln = nil
		s.running = domain.PublishedSOCKSConfig{}
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run 'SOCKS|Apply|StartIfEnabled' -v`
Expected: all 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/service/publishedsocks.go \
        backend/internal/service/publishedsocks_test.go \
        backend/internal/domain/models.go
git commit -m "feat(proxy): add PublishedSOCKSService with live start/stop"
```

---

### Task 3: HTTP handler

**Files:**
- Modify: `backend/internal/handler/proxy.go`
- Test: `backend/internal/handler/proxy_test.go` (append)

**Interfaces:**
- Consumes: `service.NewPublishedSOCKSService`, `Status`, `Apply` from Task 2.
- Produces: `handler.NewPublishedSOCKSHandler(svc *service.PublishedSOCKSService) *PublishedSOCKSHandler` with methods `Get(w, r)` and `Put(w, r)`. Task 4 registers both.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/handler/proxy_test.go`:

```go
// fakePublishedSOCKSStore is an in-memory service.PublishedSOCKSStore.
type fakePublishedSOCKSStore struct{ cfg domain.PublishedSOCKSConfig }

func (f *fakePublishedSOCKSStore) PublishedSOCKS() (domain.PublishedSOCKSConfig, error) {
	return f.cfg, nil
}

func (f *fakePublishedSOCKSStore) SetPublishedSOCKS(cfg domain.PublishedSOCKSConfig) error {
	f.cfg = cfg
	return nil
}

func newPublishedSOCKSHandler(t *testing.T) *PublishedSOCKSHandler {
	t.Helper()
	svc := service.NewPublishedSOCKSService(&fakePublishedSOCKSStore{
		cfg: domain.PublishedSOCKSConfig{Port: 1080},
	}, "127.0.0.1")
	t.Cleanup(func() { _ = svc.Stop() })
	return NewPublishedSOCKSHandler(svc)
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestPublishedSOCKSGetReportsDisabledByDefault(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodGet, "/api/proxy/publish", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.PublishedSOCKSStatus
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Enabled || body.Running {
		t.Errorf("fresh handler reports %+v, want disabled and not running", body)
	}
	if body.Port != 1080 {
		t.Errorf("Port = %d, want 1080", body.Port)
	}
}

func TestPublishedSOCKSPutEnablesAndReturnsURL(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	port := freeTCPPort(t)
	rec := httptest.NewRecorder()

	req := httptest.NewRequest(http.MethodPut, "/api/proxy/publish",
		strings.NewReader(`{"enabled":true,"port":`+strconv.Itoa(port)+`}`))
	h.Put(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.PublishedSOCKSStatus
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Running || body.Key == "" {
		t.Fatalf("expected a running, keyed proxy, got %+v", body)
	}
	if !strings.HasPrefix(body.URL, "socks5://devdeck:") {
		t.Errorf("URL = %q, want a socks5://devdeck:<key>@host:port form", body.URL)
	}
}

func TestPublishedSOCKSPutPortConflictUsesErrorEnvelope(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	blocker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Close()
	busy := blocker.Addr().(*net.TCPAddr).Port

	rec := httptest.NewRecorder()
	h.Put(rec, httptest.NewRequest(http.MethodPut, "/api/proxy/publish",
		strings.NewReader(`{"enabled":true,"port":`+strconv.Itoa(busy)+`}`)))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["error"] == "" {
		t.Errorf("response %v missing the {\"error\":...} envelope", body)
	}
}

func TestPublishedSOCKSRejectsWrongMethod(t *testing.T) {
	h := newPublishedSOCKSHandler(t)
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodPost, "/api/proxy/publish", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}
```

Extend that file's imports to include `"net"`, `"strconv"`, `"strings"`, and `"devdeck/backend/internal/domain"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run 'PublishedSOCKS' -v`
Expected: FAIL — `NewPublishedSOCKSHandler` undefined.

- [ ] **Step 3: Write the handler**

Append to `backend/internal/handler/proxy.go` (and add `"encoding/json"` to its imports):

```go
// PublishedSOCKSHandler exposes this machine's persistent, key-authenticated
// SOCKS5 publication over HTTP. Registered on every role — a runtime
// publishing a proxy is the primary use case, so unlike most hub routes this
// one is deliberately not gated on the role.
type PublishedSOCKSHandler struct {
	svc *service.PublishedSOCKSService
}

func NewPublishedSOCKSHandler(svc *service.PublishedSOCKSService) *PublishedSOCKSHandler {
	return &PublishedSOCKSHandler{svc: svc}
}

// Get reports stored intent plus current liveness.
func (h *PublishedSOCKSHandler) Get(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	status, err := h.svc.Status()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// publishedSOCKSRequest is the PUT body. Port 0 means "keep the stored port".
type publishedSOCKSRequest struct {
	Enabled   bool `json:"enabled"`
	Port      int  `json:"port"`
	RotateKey bool `json:"rotateKey"`
}

// Put applies the requested state live and persists it.
func (h *PublishedSOCKSHandler) Put(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body publishedSOCKSRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body")
		return
	}
	status, err := h.svc.Apply(body.Enabled, body.Port, body.RotateKey)
	if err != nil {
		// A bind conflict or an out-of-range port is the caller's problem,
		// not a server fault — and must never take the process down.
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -run 'PublishedSOCKS' -v && go vet ./...`
Expected: 4 tests PASS, vet clean.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/proxy.go backend/internal/handler/proxy_test.go
git commit -m "feat(proxy): expose published SOCKS5 over GET/PUT /api/proxy/publish"
```

---

### Task 4: Wire into main.go

**Files:**
- Modify: `backend/cmd/server/main.go` (service construction ~line 393; route registration ~line 697; boot start near `startForwardProxies` ~line 799)

**Interfaces:**
- Consumes: `service.NewPublishedSOCKSService`, `StartIfEnabled` (Task 2); `handler.NewPublishedSOCKSHandler`, `Get`, `Put` (Task 3).
- Produces: live routes `GET|PUT /api/proxy/publish` on every role.

- [ ] **Step 1: Construct the service**

In `backend/cmd/server/main.go`, immediately after the existing `proxySvc` / `proxyH` pair (~line 393):

```go
	publishedSOCKSSvc := service.NewPublishedSOCKSService(st, advertiseURL.Hostname())
	publishedSOCKSH := handler.NewPublishedSOCKSHandler(publishedSOCKSSvc)
```

- [ ] **Step 2: Register the routes**

Immediately after the existing `mux.HandleFunc("POST /api/proxy/start", proxyH.PostStart)` line (~line 697) — note there is **no** `if !isRuntime` guard here, which is deliberate:

```go
	// Registered on every role: publishing a proxy from a runtime (to reach
	// that machine's network from elsewhere) is the primary use case.
	mux.HandleFunc("GET /api/proxy/publish", publishedSOCKSH.Get)
	mux.HandleFunc("PUT /api/proxy/publish", publishedSOCKSH.Put)
```

- [ ] **Step 3: Start it on boot**

Immediately after the existing `startForwardProxies(...)` call (~line 799):

```go
	// Replay this machine's stored publication. Never fatal, unlike
	// startForwardProxies: that config is operator-typed at launch, whereas
	// this is replayed automatically, so a since-taken port must not stop
	// the server from booting.
	if err := publishedSOCKSSvc.StartIfEnabled(); err != nil {
		log.Printf("published socks5 proxy: %v", err)
	}
```

- [ ] **Step 4: Verify it builds and the routes answer**

Run: `cd backend && go build ./... && go vet ./...`
Expected: clean.

Then start a server and probe it:

```bash
cd backend && go run ./cmd/server --role hub --addr 127.0.0.1:8991 --db /tmp/socks-plan.db --open=false &
sleep 3
curl -s http://127.0.0.1:8991/api/proxy/publish
```

Expected: `{"enabled":false,"port":1080,"running":false,"key":""}`. Kill the server afterwards.

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat(proxy): wire published SOCKS5 routes and boot replay"
```

---

### Task 5: Frontend data layer

**Files:**
- Modify: `frontend/src/store/types.ts`
- Modify: `frontend/src/lib/machineApi.ts` (after `startProxy`, ~line 453)
- Modify: `frontend/src/features/data/keys.ts` (after `machineVersion`, ~line 58)
- Modify: `frontend/src/features/data/queries.ts`

**Interfaces:**
- Consumes: the JSON shape of `domain.PublishedSOCKSStatus` from Task 2.
- Produces:
  - `type PublishedSOCKSStatus` in `@/store/types`
  - `fetchPublishedSocks(machine: Machine): Promise<PublishedSOCKSStatus>`
  - `setPublishedSocks(machine: Machine, body: PublishedSOCKSRequest): Promise<PublishedSOCKSStatus>`
  - `qk.publishedSocks(machineId: string)`
  - `usePublishedSocks(machine: Machine | undefined, enabled: boolean)`
  - `useSetPublishedSocks()`

  Task 6 consumes all of the hooks and the type.

- [ ] **Step 1: Mirror the domain type**

In `frontend/src/store/types.ts`, next to the other machine-related types:

```ts
/** Mirror of backend/internal/domain/PublishedSOCKSStatus — one machine's
 *  persistent SOCKS5 publication. `enabled` is operator intent; `running` is
 *  what is actually bound right now (they differ after a failed boot bind). */
export interface PublishedSOCKSStatus {
  enabled: boolean
  port: number
  running: boolean
  boundAddr?: string
  /** Copy-ready `socks5://devdeck:<key>@host:port`; absent when not running. */
  url?: string
  key: string
}
```

- [ ] **Step 2: Add the API calls**

In `frontend/src/lib/machineApi.ts`, after `startProxy`:

```ts
// ---- Published SOCKS5 (persistent, keyed, operator-toggled) ----

export interface PublishedSOCKSRequest {
  enabled: boolean
  /** Omit or 0 to keep the machine's stored port. */
  port?: number
  rotateKey?: boolean
}

/** Reads this machine's persistent SOCKS5 publication. Unlike startProxy's
 *  ephemeral pair, this listener is fixed-port, always keyed, and survives
 *  restart. */
export function fetchPublishedSocks(machine: Machine): Promise<PublishedSOCKSStatus> {
  return machineRequest<PublishedSOCKSStatus>(machine, 'GET', '/proxy/publish')
}

/** Applies publication state live on the machine and persists it. */
export function setPublishedSocks(
  machine: Machine,
  body: PublishedSOCKSRequest,
): Promise<PublishedSOCKSStatus> {
  return machineRequest<PublishedSOCKSStatus>(machine, 'PUT', '/proxy/publish', body)
}
```

Add `PublishedSOCKSStatus` to that file's existing `import type { ... } from '@/store/types'` list.

- [ ] **Step 3: Add the query key**

In `frontend/src/features/data/keys.ts`, after `machineVersion`:

```ts
  publishedSocks: (id: string) => ['machines', id, 'publishedSocks'] as const,
```

- [ ] **Step 4: Add the hooks**

In `frontend/src/features/data/queries.ts`, near `useTailscaleStatus`:

```ts
/** One machine's SOCKS5 publication. `enabled` gates the fetch so the app
 *  never pulls a live proxy credential speculatively — it is requested only
 *  while the Settings network section is on screen. */
export function usePublishedSocks(machine: Machine | undefined, enabled: boolean) {
  return useQuery({
    queryKey: qk.publishedSocks(machine?.id ?? ''),
    queryFn: () => fetchPublishedSocks(machine as Machine),
    enabled: enabled && !!machine,
    staleTime: 5_000,
  })
}

export function useSetPublishedSocks() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, body }: { machine: Machine; body: PublishedSOCKSRequest }) =>
      setPublishedSocks(machine, body),
    onSuccess: (_data, { machine }) =>
      queryClient.invalidateQueries({ queryKey: qk.publishedSocks(machine.id) }),
    onError: (err, { machine }) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update the SOCKS5 proxy')
      // Resync: the machine may have applied part of the change before failing.
      void queryClient.invalidateQueries({ queryKey: qk.publishedSocks(machine.id) })
    },
  })
}
```

Add `fetchPublishedSocks`, `setPublishedSocks` and `type PublishedSOCKSRequest` to the existing `@/lib/machineApi` imports in that file, and confirm `toast` from `sonner` and `Machine` from `@/store/types` are already imported there (add whichever is missing).

- [ ] **Step 5: Verify types**

Run: `cd frontend && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store/types.ts frontend/src/lib/machineApi.ts \
        frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts
git commit -m "feat(proxy): add published SOCKS5 client API and query hooks"
```

---

### Task 6: Settings section UI

**Files:**
- Create: `frontend/src/features/overlays/SocksPublishSection.tsx`
- Create: `frontend/src/features/overlays/SocksPublishSection.test.tsx`
- Modify: `frontend/src/features/overlays/DesktopSettingsDialog.tsx` (network section, ~line 342-358)
- Modify: `frontend/vite.config.ts` (`test.include`)

**Interfaces:**
- Consumes: `usePublishedSocks`, `useSetPublishedSocks`, `PublishedSOCKSStatus` (Task 5); `useMachines` (existing).
- Produces: `<SocksPublishSection open={boolean} />`, mounted by `DesktopSettingsDialog`.

The section lives in its own file rather than inline: `DesktopSettingsDialog.tsx` is already 416 lines, and this card carries real per-machine state.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/overlays/SocksPublishSection.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Machine, PublishedSOCKSStatus } from '@/store/types'

const mockUseMachines = vi.fn()
const mockUsePublishedSocks = vi.fn()
const mockMutate = vi.fn()

vi.mock('@/features/data/queries', () => ({
  useMachines: () => mockUseMachines(),
  usePublishedSocks: (machine: Machine | undefined, enabled: boolean) =>
    mockUsePublishedSocks(machine, enabled),
  useSetPublishedSocks: () => ({ mutate: mockMutate, isPending: false }),
}))

const { SocksPublishSection } = await import('./SocksPublishSection')

const machine: Machine = {
  id: 'm1',
  name: 'prod-runtime',
  url: 'http://runtime:9199',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function status(over: Partial<PublishedSOCKSStatus> = {}): PublishedSOCKSStatus {
  return { enabled: false, port: 1080, running: false, key: '', ...over }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SocksPublishSection', () => {
  it('renders a loading state while machines are loading', () => {
    mockUseMachines.mockReturnValue({ data: undefined, isLoading: true, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: true, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('renders an empty state when no machines are registered', () => {
    mockUseMachines.mockReturnValue({ data: [], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText(/no machines registered/i)).toBeTruthy()
  })

  it('renders an error state when the machine list fails', () => {
    mockUseMachines.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') })
    mockUsePublishedSocks.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<SocksPublishSection open />)

    expect(screen.getByText(/boom/i)).toBeTruthy()
  })

  it('masks the key until revealed', async () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({
      data: status({ enabled: true, running: true, key: 'secret-key-value', url: 'socks5://devdeck:secret-key-value@runtime:1080' }),
      isLoading: false,
      error: null,
    })

    render(<SocksPublishSection open />)

    expect(screen.queryByText('secret-key-value')).toBeNull()
    const reveal = screen.getByRole('button', { name: /show socks5 key/i })
    reveal.click()
    expect(await screen.findByText('secret-key-value')).toBeTruthy()
  })

  it('toggling on sends enabled:true with the machine', () => {
    mockUseMachines.mockReturnValue({ data: [machine], isLoading: false, error: null })
    mockUsePublishedSocks.mockReturnValue({ data: status(), isLoading: false, error: null })

    render(<SocksPublishSection open />)
    screen.getByRole('switch', { name: /publish socks5 on prod-runtime/i }).click()

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({ machine, body: expect.objectContaining({ enabled: true }) }),
    )
  })
})
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts`, add to `test.include`:

```ts
      'src/features/overlays/SocksPublishSection.test.tsx',
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/overlays/SocksPublishSection.test.tsx`
Expected: FAIL — cannot resolve `./SocksPublishSection`.

- [ ] **Step 4: Write the component**

Create `frontend/src/features/overlays/SocksPublishSection.tsx`:

```tsx
import { Switch } from '@base-ui/react/switch'
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { StatusDot } from '@/components/ui/status-dot'
import { useMachines, usePublishedSocks, useSetPublishedSocks } from '@/features/data/queries'
import type { Machine } from '@/store/types'
import { cn } from '@/lib/utils'

const MASKED_KEY = '••••••••••••••••'

const switchRootClass = cn(
  'relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-devdeck-surface-2 transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-devdeck-accent',
)

const switchThumbClass = cn(
  'pointer-events-none block h-3.5 w-3.5 translate-x-1 rounded-full bg-devdeck-fg-2 transition-transform duration-150',
  'data-[checked]:translate-x-[18px] data-[checked]:bg-devdeck-accent-ink',
)

const iconButtonClass = cn(
  'flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md bg-devdeck-surface-2 text-devdeck-muted',
  'hover:bg-devdeck-popover hover:text-devdeck-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
)

/** One machine's publish row: status, toggle, port, key, copy. */
function MachineRow({ machine, open }: { machine: Machine; open: boolean }) {
  const query = usePublishedSocks(machine, open)
  const setPublished = useSetPublishedSocks()
  const [revealed, setRevealed] = useState(false)

  const status = query.data
  const running = status?.running ?? false

  function toggle(next: boolean) {
    setPublished.mutate({ machine, body: { enabled: next } })
  }

  function rotate() {
    setPublished.mutate({ machine, body: { enabled: true, rotateKey: true } })
  }

  function copyUrl() {
    if (!status?.url) return
    void navigator.clipboard.writeText(status.url)
    toast.success('Copied')
  }

  return (
    <div className="rounded-lg border border-devdeck-border bg-devdeck-terminal p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot color={running ? '#56d58a' : '#6b7280'} size={6} />
          <span className="truncate text-[12.5px] text-devdeck-fg">{machine.name}</span>
        </div>
        {query.isLoading ? (
          <span className="font-mono text-[11px] text-devdeck-dim-2">loading…</span>
        ) : query.error ? (
          <span className="font-mono text-[11px] text-devdeck-red-soft">
            {query.error instanceof Error ? query.error.message : 'unreachable'}
          </span>
        ) : (
          <Switch.Root
            checked={status?.enabled ?? false}
            onCheckedChange={toggle}
            disabled={setPublished.isPending}
            aria-label={`Publish SOCKS5 on ${machine.name}`}
            className={switchRootClass}
          >
            <Switch.Thumb className={switchThumbClass} />
          </Switch.Root>
        )}
      </div>

      {status && !query.error && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="w-12 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
              Addr
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg-2">
              {running ? (status.boundAddr ?? `:${status.port}`) : `port ${status.port} — stopped`}
            </span>
          </div>

          {running && (
            <div className="flex items-center gap-3">
              <span className="w-12 flex-none text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">
                Key
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-devdeck-fg">
                {revealed ? status.key : MASKED_KEY}
              </span>
              <div className="flex flex-none items-center gap-2">
                <button
                  type="button"
                  aria-label={revealed ? 'Hide SOCKS5 key' : 'Show SOCKS5 key'}
                  onClick={() => setRevealed((r) => !r)}
                  className={iconButtonClass}
                >
                  {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  type="button"
                  aria-label={`Rotate SOCKS5 key on ${machine.name}`}
                  onClick={rotate}
                  className={iconButtonClass}
                >
                  <RefreshCw size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Copy SOCKS5 URL for ${machine.name}`}
                  onClick={copyUrl}
                  className={iconButtonClass}
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Settings › Network › SOCKS5 Proxy. `open` gates every per-machine fetch so
 *  the app never pulls live proxy credentials while the dialog is closed. */
export function SocksPublishSection({ open }: { open: boolean }) {
  const machines = useMachines(open)

  if (machines.isLoading) {
    return <p className="font-mono text-[11px] text-devdeck-dim-2">Loading machines…</p>
  }
  if (machines.error) {
    return (
      <p className="font-mono text-[11px] text-devdeck-red-soft">
        {machines.error instanceof Error ? machines.error.message : 'Failed to load machines'}
      </p>
    )
  }
  if (!machines.data?.length) {
    return (
      <p className="font-mono text-[11px] text-devdeck-dim-2">
        No machines registered yet — add one to publish a proxy from it.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {machines.data.map((m) => (
        <MachineRow key={m.id} machine={m} open={open} />
      ))}
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/overlays/SocksPublishSection.test.tsx`
Expected: 5 tests PASS.

If `StatusDot`, `devdeck-red-soft`, or `useMachines(open)`'s signature differ from what is written above, adjust to the real ones rather than inventing new tokens — check `@/components/ui/status-dot` and `globals.css`.

- [ ] **Step 6: Mount it in the settings dialog**

In `frontend/src/features/overlays/DesktopSettingsDialog.tsx`, inside the `section === 'network'` block, after the existing Tailscale `InsetPanel`:

```tsx
                <Divider />
                <SectionHeadRow
                  label="Forward proxy"
                  title="SOCKS5"
                  description="Publish a SOCKS5 proxy on a machine so other tools can route through that machine's network."
                />
                <div className="mt-3">
                  <SocksPublishSection open={open && section === 'network'} />
                </div>
```

Add the import:

```tsx
import { SocksPublishSection } from './SocksPublishSection'
```

Update the `network` entry in `SECTION_META` so the subtitle covers both panels:

```tsx
  network: {
    title: 'Network',
    subtitle: 'Tailscale exposure and forward-proxy publishing for this hub and its runtimes.',
  },
```

- [ ] **Step 7: Full verification**

Run:
```bash
cd frontend && npm run typecheck && npx vitest run
cd ../backend && go vet ./... && go test ./internal/service/ ./internal/handler/ ./internal/store/
```
Expected: typecheck clean, all frontend tests pass, all touched Go packages pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/overlays/SocksPublishSection.tsx \
        frontend/src/features/overlays/SocksPublishSection.test.tsx \
        frontend/src/features/overlays/DesktopSettingsDialog.tsx \
        frontend/vite.config.ts
git commit -m "feat(proxy): add SOCKS5 publish section to Settings"
```

---

## Manual verification

After Task 6, confirm the whole path end to end:

1. `make dev` (or the run command in `COMMANDS.md`).
2. Open Settings → Network. The SOCKS5 card lists your machines, all off.
3. Toggle the local hub on. The status dot goes green and an address appears — **without a restart**.
4. Reveal and copy the key, then verify the proxy actually serves:
   ```bash
   curl -x socks5h://devdeck:<key>@127.0.0.1:1080 https://example.com -o /dev/null -w '%{http_code}\n'
   ```
   Expected: `200`.
5. Verify auth is enforced: the same curl without credentials must fail.
6. Restart the server. The proxy comes back up on its own, and Settings still shows it running.
7. Toggle it off, then confirm the port refuses connections.

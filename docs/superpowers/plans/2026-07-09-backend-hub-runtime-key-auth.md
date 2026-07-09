# Backend Hub/Runtime Split + Key Auth — Implementation Plan (Sub-project #1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Context

Approved spec: `docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md`. Loom is being split into a **hub** (organizational source of truth: workspaces, projects, invoices, …, machine registry) and per-machine **runtime** backends (execution: git, worktrees, PTY) that deploy as a single binary authenticated by a static `--key`. All traffic rides one Tailscale tailnet; clients connect **direct-first** to runtimes, with a hub proxy as fallback. The frontend later ships as web (unchanged session auth) + Tauri desktop (bearer key).

This plan is **sub-project #1: backend only**. Fully testable via `go test` + curl, no frontend changes except one type-sync line.

**Phase-1 scoping (deliberate):** roles do NOT yet prune module routes (that lands with sub-project #2 when the frontend re-points). Role differences in this phase:
- `--role hub` (default): current behavior + machines registry + proxy + health + dual auth (session cookie OR bearer `--key`).
- `--role runtime`: requires `--key`; key-only auth; skips auth endpoints, embedded SPA, browser proxy, seed, recurring-invoice scheduler, `--open`.

**Goal:** One Go binary, two roles; static-key auth; machine registry with key distribution; reverse proxy (REST + WS) with server-side key injection; per-machine health endpoint.

**Tech stack:** Go 1.22+ `http.ServeMux` patterns, `net/http/httputil.ReverseProxy` (handles WS upgrades natively), `modernc.org/sqlite`, `nhooyr.io/websocket` (tests only).

## Global Constraints (from CLAUDE.md / CONTRACTS.md / go.md)

- All API errors use the `{"error":"message"}` envelope; handlers use `writeErr`/`writeJSON`/`handleStoreErr`.
- All persistence through `port.Store`; never bypass.
- IDs are type-prefixed hex via `idGen(prefix)` (`backend/internal/store/helpers.go:28`); machines use prefix `m-`.
- SQLite `?` placeholders; schema is idempotent `CREATE TABLE IF NOT EXISTS` + `migrateXxxColumns` for pre-existing DBs (pattern: `backend/internal/store/db.go:244`).
- Patch structs use `*T` pointers.
- `backend/internal/domain/models.go`, `backend/internal/port/store.go`, `backend/cmd/server/main.go` are orchestration convergence files — this plan is executed serially, so fine, but never edit them from parallel agents.
- Domain type changes must sync to `frontend/src/store/types.ts`.
- `go vet ./...` before every commit. Run tests from `backend/`.
- Terminal WS coalescing/compression code (`backend/internal/terminal/server.go`) is untouchable in this project.

---

### Task 1: CORS — allow `Authorization` header

**Files:**
- Modify: `backend/internal/handler/middleware.go:124` (CorsMiddleware)
- Test: `backend/internal/handler/middleware_test.go`

Bearer auth from a cross-origin client (Tauri, or web SPA → runtime direct) fails CORS preflight today because only `Content-Type` is allowed.

- [ ] **Step 1: Write failing test** in `middleware_test.go`:

```go
func TestCorsMiddlewareAllowsAuthorizationHeader(t *testing.T) {
	h := CorsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodOptions, "/api/machines", nil))
	got := rec.Header().Get("Access-Control-Allow-Headers")
	if !strings.Contains(got, "Authorization") {
		t.Errorf("Access-Control-Allow-Headers = %q, want it to include Authorization", got)
	}
}
```

- [ ] **Step 2:** `cd backend && go test ./internal/handler/ -run TestCorsMiddlewareAllowsAuthorizationHeader -v` → FAIL
- [ ] **Step 3:** Change the header line in `CorsMiddleware`:

```go
w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
```

- [ ] **Step 4:** Re-run test → PASS. `go vet ./...`
- [ ] **Step 5:** Commit `feat(auth): allow Authorization header in CORS preflight`

---

### Task 2: `RequireKey` middleware (runtime auth)

**Files:**
- Create: `backend/internal/handler/keyauth.go`
- Test: `backend/internal/handler/keyauth_test.go`

**Interfaces (produced):**
- `func RequireKey(key string) func(http.Handler) http.Handler`
- `func bearerToken(r *http.Request) string` — extracts `Authorization: Bearer x` (empty string if absent/malformed); reused by Task 3.
- `func keyFromRequest(r *http.Request) string` — bearer token, or `?key=` query param **only when** `r.Header.Get("Upgrade") == "websocket"` (browser WS cannot set headers; header-less GETs must not smuggle keys via URL otherwise).

Auth rule: `/api/health` is public; everything else (all paths — runtime has no SPA) requires the key via `crypto/subtle.ConstantTimeCompare`.

- [ ] **Step 1: Write failing tests** in `keyauth_test.go`:

```go
package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func requireKeyServer(t *testing.T) http.Handler {
	t.Helper()
	return RequireKey("sekrit")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}

func TestRequireKeyRejectsMissingKey(t *testing.T) {
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequireKeyRejectsWrongKey(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRequireKeyAcceptsBearerKey(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestRequireKeyHealthIsPublic(t *testing.T) {
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestRequireKeyAcceptsQueryKeyOnlyForWebSocketUpgrade(t *testing.T) {
	// Plain GET with ?key= must be rejected (keys don't belong in URLs)…
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/workspaces?key=sekrit", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("plain GET with ?key: status = %d, want 401", rec.Code)
	}
	// …but a WS upgrade request may use it (browser WS API can't set headers).
	req := httptest.NewRequest(http.MethodGet, "/ws/terminal?key=sekrit", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	rec = httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("WS upgrade with ?key: status = %d, want 200", rec.Code)
	}
}
```

- [ ] **Step 2:** `go test ./internal/handler/ -run TestRequireKey -v` → FAIL (undefined: RequireKey)
- [ ] **Step 3: Implement** `keyauth.go`:

```go
package handler

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// bearerToken extracts the token from an "Authorization: Bearer x" header,
// or "" when absent or malformed.
func bearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return ""
	}
	return auth[len(prefix):]
}

// keyFromRequest resolves the presented API key: the bearer header, or the
// ?key= query param for WebSocket upgrades only (the browser WebSocket API
// cannot set headers; every other request must keep keys out of URLs).
func keyFromRequest(r *http.Request) string {
	if tok := bearerToken(r); tok != "" {
		return tok
	}
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return r.URL.Query().Get("key")
	}
	return ""
}

// keyMatches compares in constant time.
func keyMatches(presented, want string) bool {
	return want != "" && subtle.ConstantTimeCompare([]byte(presented), []byte(want)) == 1
}

// RequireKey returns middleware for the runtime role: every request except
// GET /api/health must present the static API key.
func RequireKey(key string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health" {
				next.ServeHTTP(w, r)
				return
			}
			if !keyMatches(keyFromRequest(r), key) {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
```

- [ ] **Step 4:** Re-run → PASS. `go vet ./...`
- [ ] **Step 5:** Commit `feat(auth): RequireKey middleware for runtime role`

---

### Task 3: Hub dual auth — session cookie OR bearer hub key

**Files:**
- Modify: `backend/internal/handler/middleware.go:83` (`RequireAuth`)
- Modify: `backend/cmd/server/main.go:320` (call site — signature change)
- Test: `backend/internal/handler/middleware_test.go`

**Interfaces (changed):**
- `RequireAuth(svc *service.AuthService) …` → `RequireAuth(svc *service.AuthService, hubKey string) func(http.Handler) http.Handler`. Empty `hubKey` = cookie-only (current behavior).

- [ ] **Step 1: Write failing tests** (mirror the existing middleware_test.go style; a nil-safe fake isn't needed — build a real AuthService the way `newTestAuthHandler` does in `auth_test.go:19-27`):

```go
func TestRequireAuthAcceptsBearerHubKey(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := service.NewAuthService(store.New(db), make([]byte, 32))

	h := RequireAuth(svc, "hubkey")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer hubkey")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("bearer hub key: status = %d, want 200", rec.Code)
	}

	// wrong key still falls through to cookie auth → 401 (no cookie)
	req = httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong bearer key: status = %d, want 401", rec.Code)
	}
}

func TestRequireAuthEmptyHubKeyNeverMatchesBearer(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := service.NewAuthService(store.New(db), make([]byte, 32))

	h := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	req := httptest.NewRequest(http.MethodGet, "/api/workspaces", nil)
	req.Header.Set("Authorization", "Bearer ")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("empty configured key: status = %d, want 401", rec.Code)
	}
}
```

- [ ] **Step 2:** Run → FAIL (signature mismatch / undefined behavior)
- [ ] **Step 3: Implement.** In `RequireAuth`, after the public-path and non-API early returns, before the cookie check:

```go
if keyMatches(keyFromRequest(r), hubKey) {
	next.ServeHTTP(w, r)
	return
}
```

(`keyMatches` already refuses empty configured keys.) Update `main.go:320` to `handler.RequireAuth(authSvc, "")` for now — Task 4 threads the real flag through.

- [ ] **Step 4:** `go test ./internal/handler/ -v` all pass; `go vet ./...`; `go build ./...`
- [ ] **Step 5:** Commit `feat(auth): hub accepts bearer --key alongside session cookies`

---

### Task 4: `--role` and `--key` flags + main.go wiring

**Files:**
- Modify: `backend/cmd/server/main.go` (flags at :33-51, wiring at :195-338)

No unit test target (main.go has none in this repo); verification is build + curl matrix below.

- [ ] **Step 1: Add flags** after `tailscaleServe` (main.go:50):

```go
role := flag.String("role", envOr("LOOM_ROLE", "hub"), "server role: hub (organizational data + machine registry + proxy + web UI) or runtime (headless execution daemon, key auth only)")
apiKey := flag.String("key", envOr("LOOM_KEY", ""), "static API key; required for --role runtime, optional bearer auth for --role hub (desktop clients)")
```

- [ ] **Step 2: Validate** right after `flag.Parse()` / version / updates handling:

```go
if *role != "hub" && *role != "runtime" {
	log.Fatalf("--role must be \"hub\" or \"runtime\", got %q", *role)
}
if *role == "runtime" && *apiKey == "" {
	log.Fatalf("--role runtime requires --key (or LOOM_KEY)")
}
isRuntime := *role == "runtime"
```

- [ ] **Step 3: Conditional wiring.** Guard these existing blocks with `if !isRuntime { … }`:
  - The recurring-invoices startup check + daily goroutine (main.go:124-140).
  - Registration of all 8 `/api/auth/*` routes (main.go:197-204).
  - `GET /api/browser/session`, `/api/browser/proxy` (main.go:313-314) and the `browserH` construction.
  - `POST /api/seed` (main.go:309).
  - `mux.Handle("/", webui.Handler())` (main.go:318).
  - The `openBrowserSoon` call (main.go:354-356) — condition becomes `if !isRuntime && *openUI && webui.Available()`.

  Replace the middleware chain (main.go:320) with:

```go
var authMW func(http.Handler) http.Handler
if isRuntime {
	authMW = handler.RequireKey(*apiKey)
} else {
	authMW = handler.RequireAuth(authSvc, *apiKey)
}
var root http.Handler = handler.CorsMiddleware(handler.JSONErrorMiddleware(authMW(mux)))
```

  Also log the role at startup: `log.Printf("loom role: %s", *role)`.

- [ ] **Step 4: Verify manually:**

```bash
cd backend && go vet ./... && go build ./cmd/server
# runtime without key must fail fast:
./server --role runtime --addr 127.0.0.1:9199 --db /tmp/rt.db ; # expect fatal
# runtime with key:
./server --role runtime --key testkey --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false &
curl -s http://127.0.0.1:9199/api/health                                  # 200 (public)
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9199/api/workspaces               # 401
curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer testkey' http://127.0.0.1:9199/api/workspaces  # 200
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9199/api/auth/config               # 404 (route absent)
curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:9199/api/seed              # 401 → with key: 404
kill %1
```

- [ ] **Step 5:** Commit `feat(server): --role hub|runtime and --key flags`

---

### Task 5: Machine domain type + store + port.Store

**Files:**
- Modify: `backend/internal/domain/models.go` (add Machine)
- Modify: `backend/internal/store/db.go` (schema)
- Create: `backend/internal/store/machine.go`
- Modify: `backend/internal/port/store.go` (interface + MachinePatch)
- Modify: `frontend/src/store/types.ts` (type sync — Machine interface)
- Test: `backend/internal/store/machine_test.go`

**Interfaces (produced):**

```go
// domain
type Machine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
	// Key is the runtime's static API key. Deliberately serialized: the hub
	// distributes it to authenticated clients for direct-first connections
	// (spec: docs/superpowers/specs/2026-07-09-hub-runtime-tauri-design.md).
	Key string `json:"key"`
}

// port.Store additions
Machines() ([]domain.Machine, error)
CreateMachine(name, url, key string) (domain.Machine, error)
UpdateMachine(id string, p MachinePatch) (domain.Machine, error)
DeleteMachine(id string) error
MachineByID(id string) (domain.Machine, error)

// port
type MachinePatch struct {
	Name *string
	URL  *string
	Key  *string
}
```

- [ ] **Step 1: Write failing tests** `machine_test.go` (mirror `company_test.go`, uses `newTestStore` from `worktree_test.go:9`):

```go
package store

import (
	"errors"
	"testing"

	"loom/backend/internal/port"
)

func TestCreateMachinePersistsAndLists(t *testing.T) {
	s := newTestStore(t)
	m, err := s.CreateMachine("builder", "https://builder.tail-x.ts.net", "rt-key-1")
	if err != nil {
		t.Fatal(err)
	}
	if m.ID == "" || m.ID[:2] != "m-" {
		t.Errorf("ID = %q, want m- prefix", m.ID)
	}
	list, err := s.Machines()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Key != "rt-key-1" || list[0].URL != "https://builder.tail-x.ts.net" {
		t.Errorf("Machines() = %+v", list)
	}
}

func TestUpdateMachineAppliesPartialPatch(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.CreateMachine("builder", "https://old.ts.net", "k1")
	newURL := "https://new.ts.net"
	got, err := s.UpdateMachine(m.ID, port.MachinePatch{URL: &newURL})
	if err != nil {
		t.Fatal(err)
	}
	if got.URL != newURL || got.Name != "builder" || got.Key != "k1" {
		t.Errorf("UpdateMachine = %+v, want only URL changed", got)
	}
}

func TestDeleteMachineRemovesIt(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.CreateMachine("builder", "https://b.ts.net", "k")
	if err := s.DeleteMachine(m.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.MachineByID(m.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("MachineByID after delete = %v, want ErrNotFound", err)
	}
}

func TestMachineByIDMissingReturnsNotFound(t *testing.T) {
	s := newTestStore(t)
	if _, err := s.MachineByID("m-nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}
```

- [ ] **Step 2:** `go test ./internal/store/ -run TestCreateMachine -v` → FAIL
- [ ] **Step 3: Implement.** Schema block appended in `db.go` (before the settings INSERT):

```sql
CREATE TABLE IF NOT EXISTS machines (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  url  TEXT NOT NULL DEFAULT '',
  key  TEXT NOT NULL DEFAULT ''
);
```

`store/machine.go` (mirror `company.go` exactly: `scanMachine`, `Machines()` ordered `rowid DESC`, `MachineByID` via `mapNotFound`, `CreateMachine` with `idGen("m-")`, `UpdateMachine` read-modify-write, `DeleteMachine` checking `RowsAffected` → `ErrNotFound`). Add the five methods + `MachinePatch` to `port/store.go` under a `// Machines (runtime registry, hub role only)` comment.

In `frontend/src/store/types.ts` add (type sync contract):

```ts
/** A registered runtime machine (hub registry). */
export interface Machine {
  id: string
  name: string
  url: string
  key: string
}
```

- [ ] **Step 4:** `go test ./internal/store/ -v` all pass; `go vet ./...`; `cd frontend && npm run typecheck`
- [ ] **Step 5:** Commit `feat(machines): Machine domain type, store table, port interface`

---

### Task 6: Machine handler — CRUD + key distribution

**Files:**
- Create: `backend/internal/handler/machine.go`
- Modify: `backend/cmd/server/main.go` (routes, hub only)
- Test: `backend/internal/handler/machine_test.go`

**Interfaces (produced):**
- `NewMachineHandler(st *store.Store) *MachineHandler`
- Routes (registered inside `if !isRuntime { … }`):

```go
mux.HandleFunc("GET /api/machines", machineH.GetMachines)
mux.HandleFunc("POST /api/machines", machineH.PostMachine)
mux.HandleFunc("PATCH /api/machines/{id}", machineH.PatchMachine)
mux.HandleFunc("DELETE /api/machines/{id}", machineH.DeleteMachine)
```

`GET /api/machines` returns machines **including keys** — this is the spec's key-distribution endpoint; it is only reachable behind hub auth.

- [ ] **Step 1: Write failing tests** (handler tests construct a real store like `auth_test.go:19-27`):

```go
package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/store"
)

func newTestMachineHandler(t *testing.T) *MachineHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return NewMachineHandler(store.New(db))
}

func TestPostMachineValidatesRequiredFields(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder"}`))) // missing url + key
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestPostMachineRejectsNonHTTPURL(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"b","url":"ftp://x","key":"k"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestMachineCRUDRoundtrip(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"https://b.ts.net:8989","key":"rt-key"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d, body %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.GetMachines(rec, httptest.NewRequest(http.MethodGet, "/api/machines", nil))
	if !strings.Contains(rec.Body.String(), `"key":"rt-key"`) {
		t.Errorf("GET /api/machines must distribute keys, body = %s", rec.Body.String())
	}
}
```

- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3: Implement** `machine.go` (mirror `company.go` handler; validation before store call):

```go
package handler

import (
	"net/http"
	"net/url"

	"loom/backend/internal/port"
	"loom/backend/internal/store"
)

// MachineHandler handles the hub's runtime-machine registry.
type MachineHandler struct {
	st *store.Store
}

func NewMachineHandler(st *store.Store) *MachineHandler {
	return &MachineHandler{st: st}
}

// validMachineURL accepts absolute http/https URLs.
func validMachineURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// GetMachines lists registered machines, keys included: this is the
// key-distribution endpoint for direct-first clients (behind hub auth).
func (h *MachineHandler) GetMachines(w http.ResponseWriter, r *http.Request) {
	list, err := h.st.Machines()
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (h *MachineHandler) PostMachine(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name *string `json:"name"`
		URL  *string `json:"url"`
		Key  *string `json:"key"`
	}
	if _, err := decodeBody(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if str(body.Name) == "" || str(body.URL) == "" || str(body.Key) == "" {
		writeErr(w, http.StatusBadRequest, "name, url and key are required")
		return
	}
	if !validMachineURL(str(body.URL)) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	m, err := h.st.CreateMachine(str(body.Name), str(body.URL), str(body.Key))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (h *MachineHandler) PatchMachine(w http.ResponseWriter, r *http.Request) {
	var p port.MachinePatch
	if _, err := decodeBody(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if p.URL != nil && !validMachineURL(*p.URL) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	m, err := h.st.UpdateMachine(r.PathValue("id"), p)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, m)
}

func (h *MachineHandler) DeleteMachine(w http.ResponseWriter, r *http.Request) {
	if handleStoreErr(w, h.st.DeleteMachine(r.PathValue("id"))) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

(`str` helper already exists in the handler package — used at `company.go:39`.) Register routes in main.go inside the hub-only block.

- [ ] **Step 4:** `go test ./internal/handler/ -v`; `go vet ./...`
- [ ] **Step 5:** Commit `feat(machines): registry CRUD endpoints with key distribution`

---

### Task 7: `Project.machineId`

**Files:**
- Modify: `backend/internal/store/db.go` (schema + new `migrateProjectColumns`)
- Modify: `backend/internal/domain/models.go:32` (Project struct)
- Modify: `backend/internal/port/store.go:24-25` (CreateProject/UpdateProject signatures)
- Modify: `backend/internal/store/project.go` (scan/insert/update)
- Modify: `backend/internal/service/project.go`, `backend/internal/handler/project.go` (thread through; body field `machineId`)
- Modify: `frontend/src/store/types.ts` (Project gains `machineId: string`)
- Test: extend `backend/internal/store/` tests (project coverage lives in workspace/worktree tests — add `machine_id` cases in `machine_test.go` or a new `project_machine_test.go`)

**Interfaces (changed):**
- `CreateProject(wsID, name, path, repo, machineID string) (domain.Project, error)`
- `UpdateProject(id string, name, path, repo, machineID *string, expanded *bool) (domain.Project, error)`
- `domain.Project` gains `MachineID string \`json:"machineId"\`` — empty string = "local / unassigned" (existing rows default to it).

- [ ] **Step 1: Failing test** (`project_machine_test.go` in store package):

```go
func TestProjectMachineIDRoundtrip(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("Acme")
	p, err := s.CreateProject(ws.ID, "api", "/srv/api", "git@x:api.git", "m-1234")
	if err != nil {
		t.Fatal(err)
	}
	if p.MachineID != "m-1234" {
		t.Errorf("MachineID = %q, want m-1234", p.MachineID)
	}
	other := "m-5678"
	p2, err := s.UpdateProject(p.ID, nil, nil, nil, &other, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p2.MachineID != "m-5678" {
		t.Errorf("after update MachineID = %q, want m-5678", p2.MachineID)
	}
}
```

- [ ] **Step 2:** Run → compile FAIL (signature)
- [ ] **Step 3: Implement:**
  - Schema: add `machine_id TEXT NOT NULL DEFAULT ''` to the projects `CREATE TABLE`, plus:

```go
// migrateProjectColumns adds machine_id (introduced with the hub/runtime
// split) to pre-existing databases. Existing projects default to '' =
// local/unassigned.
func migrateProjectColumns(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE projects ADD COLUMN machine_id TEXT NOT NULL DEFAULT ''"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}
```

    called from `Open` beside the other migrations (db.go:224-235).
  - Thread `machineID` through store scan/INSERT/UPDATE, port, service, and handler (`machineId` JSON field on create/patch bodies, mirroring how `path`/`repo` flow).
  - Frontend `types.ts`: add `machineId: string` to `Project` and `machineId?: string` to the create/update payload types in `frontend/src/lib/api.ts` (`CreateProjectBody`, `UpdateProjectBody`).
- [ ] **Step 4:** `go test ./... && go vet ./...` from backend; `npm run typecheck` from frontend (existing UI never reads the new field — additive, no UI change needed until sub-project #2)
- [ ] **Step 5:** Commit `feat(projects): machineId column linking projects to runtime machines`

---

### Task 8: Machine reverse proxy (REST + WS fallback path)

**Files:**
- Create: `backend/internal/handler/machine_proxy.go`
- Modify: `backend/cmd/server/main.go` (route, hub only)
- Test: `backend/internal/handler/machine_proxy_test.go`

**Interfaces (produced):**
- `NewMachineProxyHandler(st *store.Store) *MachineProxyHandler` with `ServeHTTP`
- Route: `mux.Handle("/api/machines/{id}/proxy/{rest...}", proxyH)` — method-less: forwards every verb plus WebSocket upgrades (`httputil.ReverseProxy` passes 101-switching-protocols through natively since Go 1.12; the terminal/LSP WS ride this on the fallback path).

Proxy contract:
- Target: `machine.URL` + `/` + `{rest...}` + original query, **minus the `key` param** (never forward the hub key to a runtime).
- Inject `Authorization: Bearer <machine.Key>`; drop the inbound `Cookie` and `Authorization` headers (hub credentials must not reach runtimes).
- Strip `Access-Control-Allow-*` headers from runtime responses — the hub's own CorsMiddleware already sets them; forwarding both duplicates the header (exact bug found in the browser proxy on Jul 6: obs 2539).
- Unknown machine id → 404 envelope. Unreachable runtime → `502 {"error":"machine unreachable"}`.

- [ ] **Step 1: Write failing tests:**

```go
package handler

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/store"
)

// proxyTestEnv registers a machine pointing at a fake runtime and returns a
// mux with the proxy route mounted the same way main.go mounts it.
func proxyTestEnv(t *testing.T, runtime http.Handler) (*http.ServeMux, *store.Store) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	backend := httptest.NewServer(runtime)
	t.Cleanup(backend.Close)
	if _, err := st.CreateMachine("rt", backend.URL, "rt-key"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/machines/{id}/proxy/{rest...}", NewMachineProxyHandler(st))
	return mux, st
}

func machineID(t *testing.T, st *store.Store) string {
	t.Helper()
	list, err := st.Machines()
	if err != nil || len(list) == 0 {
		t.Fatal("no machine registered")
	}
	return list[0].ID
}

func TestProxyInjectsRuntimeKeyAndStripsClientCredentials(t *testing.T) {
	var gotAuth, gotCookie string
	mux, st := proxyTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotCookie = r.Header.Get("Cookie")
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/machines/"+machineID(t, st)+"/proxy/api/health", nil)
	req.Header.Set("Authorization", "Bearer hub-key")
	req.Header.Set("Cookie", "loom_session=secret")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if gotAuth != "Bearer rt-key" {
		t.Errorf("runtime saw Authorization = %q, want Bearer rt-key", gotAuth)
	}
	if gotCookie != "" {
		t.Errorf("runtime saw Cookie = %q, want empty", gotCookie)
	}
}

func TestProxyStripsUpstreamCORSHeaders(t *testing.T) {
	mux, st := proxyTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*") // runtime's own CorsMiddleware sets this
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/machines/"+machineID(t, st)+"/proxy/api/health", nil))
	if got := rec.Header().Values("Access-Control-Allow-Origin"); len(got) != 0 {
		t.Errorf("proxied ACAO = %v, want stripped (hub CorsMiddleware adds its own)", got)
	}
}

func TestProxyDropsKeyQueryParam(t *testing.T) {
	var gotQuery string
	mux, st := proxyTestEnv(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
	}))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/machines/"+machineID(t, st)+"/proxy/ws/terminal?session=s1&key=hubkey", nil))
	if strings.Contains(gotQuery, "key=") {
		t.Errorf("hub key leaked to runtime: query = %q", gotQuery)
	}
	if !strings.Contains(gotQuery, "session=s1") {
		t.Errorf("legit params must survive: query = %q", gotQuery)
	}
}

func TestProxyUnknownMachineReturns404(t *testing.T) {
	mux, _ := proxyTestEnv(t, http.NotFoundHandler())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/m-nope/proxy/api/health", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestProxyUnreachableRuntimeReturns502(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	if _, err := st.CreateMachine("dead", "http://127.0.0.1:1", "k"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/machines/{id}/proxy/{rest...}", NewMachineProxyHandler(st))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/machines/"+machineID(t, st)+"/proxy/api/health", nil))
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "machine unreachable") {
		t.Errorf("body = %s, want machine unreachable envelope", rec.Body.String())
	}
}
```

- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3: Implement** `machine_proxy.go`:

```go
package handler

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"

	"loom/backend/internal/store"
)

// MachineProxyHandler forwards /api/machines/{id}/proxy/{rest...} to the
// registered runtime, injecting the runtime's key server-side. It is the
// FALLBACK path — clients connect direct-first over the tailnet (see spec).
// httputil.ReverseProxy passes WebSocket upgrades through, so terminal and
// LSP sessions also work on this path.
type MachineProxyHandler struct {
	st *store.Store
}

func NewMachineProxyHandler(st *store.Store) *MachineProxyHandler {
	return &MachineProxyHandler{st: st}
}

func (h *MachineProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	target, err := url.Parse(m.URL)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "invalid machine url")
		return
	}
	rest := r.PathValue("rest")

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.URL.Path = "/" + rest
			q := pr.In.URL.Query()
			q.Del("key") // never forward the hub key to a runtime
			pr.Out.URL.RawQuery = q.Encode()
			// Hub credentials must not reach runtimes; the runtime key replaces them.
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Set("Authorization", "Bearer "+m.Key)
		},
		ModifyResponse: func(resp *http.Response) error {
			// The hub's CorsMiddleware sets these on the way out; forwarding
			// the runtime's copy would duplicate the header and break browsers.
			resp.Header.Del("Access-Control-Allow-Origin")
			resp.Header.Del("Access-Control-Allow-Methods")
			resp.Header.Del("Access-Control-Allow-Headers")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("machine proxy: %s %s: %v", m.ID, r.URL.Path, err)
			writeErr(w, http.StatusBadGateway, "machine unreachable")
		},
	}
	proxy.ServeHTTP(w, r)
}
```

Register in main.go (hub-only block): `mux.Handle("/api/machines/{id}/proxy/{rest...}", handler.NewMachineProxyHandler(st))`.

- [ ] **Step 4:** `go test ./internal/handler/ -run TestProxy -v` → PASS; `go vet ./...`
- [ ] **Step 5: End-to-end WS smoke check** (manual, needs both roles running): start a runtime with `--key rtk`, register it on a hub, open a terminal through `/api/machines/{id}/proxy/ws/terminal?...` with a WS client, verify frames flow. (Automated WS proxy test is optional; if added, use `nhooyr.io/websocket` against an echo handler.)
- [ ] **Step 6:** Commit `feat(machines): hub fallback reverse proxy (REST + WS) with key injection`

---

### Task 9: Machine health endpoint

**Files:**
- Modify: `backend/internal/handler/machine.go` (+ `GetMachineHealth`)
- Modify: `backend/cmd/server/main.go` (route, hub only)
- Test: `backend/internal/handler/machine_test.go`

**Interfaces (produced):**
- `GET /api/machines/{id}/health` → `200 {"status":"online","latencyMs":12}` or `200 {"status":"offline"}` (200 either way — offline is data, not an error; 404 only for unknown machine id). 3-second timeout. Frontend polls this to drive online/offline badges and the direct-vs-proxy switch.

- [ ] **Step 1: Failing tests:**

```go
func TestMachineHealthOnline(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)
	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("rt", backend.URL, "k")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/health", h.GetMachineHealth)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"online"`) {
		t.Errorf("status=%d body=%s, want 200 online", rec.Code, rec.Body.String())
	}
}

func TestMachineHealthOffline(t *testing.T) {
	h := newTestMachineHandler(t)
	m, err := h.st.CreateMachine("dead", "http://127.0.0.1:1", "k")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/health", h.GetMachineHealth)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"offline"`) {
		t.Errorf("status=%d body=%s, want 200 offline", rec.Code, rec.Body.String())
	}
}
```

- [ ] **Step 2:** Run → FAIL
- [ ] **Step 3: Implement** in `machine.go`:

```go
// GetMachineHealth pings the runtime's public /api/health with a short
// timeout. Offline is a normal answer (200), not an error: the frontend
// polls this to drive status badges and direct-vs-proxy fallback.
func (h *MachineHandler) GetMachineHealth(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, m.URL+"/api/health", nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "invalid machine url")
		return
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "offline"})
		return
	}
	resp.Body.Close()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "online",
		"latencyMs": time.Since(start).Milliseconds(),
	})
}
```

Route in main.go hub-only block: `mux.HandleFunc("GET /api/machines/{id}/health", machineH.GetMachineHealth)`.

- [ ] **Step 4:** `go test ./internal/handler/ -v`; `go vet ./...`
- [ ] **Step 5:** Commit `feat(machines): per-machine health probe endpoint`

---

### Task 10: Docs

**Files:**
- Modify: `COMMANDS.md` (new flags: `--role`, `--key`; runtime curl examples)
- Modify: `CONTRACTS.md` (machines API shapes, key-auth rules incl. WS `?key=` upgrade-only rule, `Project.machineId`, proxy error contract `502 machine unreachable`)
- Modify: `ARCHITECTURE.md` (hub/runtime roles paragraph + pointer to the spec)

- [ ] **Step 1:** Write the three doc updates (each a short section; copy exact endpoint shapes and flag help text from the implementation).
- [ ] **Step 2:** Commit `docs: hub/runtime roles, key auth, machines API`

---

## Verification (end-to-end)

```bash
cd backend && go vet ./... && go test ./...
cd ../frontend && npm run typecheck

# Full two-node smoke test on one laptop:
cd ../backend && go build -o /tmp/loom ./cmd/server
/tmp/loom --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db &
/tmp/loom --role hub --key hubk --addr 127.0.0.1:9198 --db /tmp/hub.db --open=false &

# hub dual auth
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9198/api/workspaces                     # 401
curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/workspaces                       # 200 []

# register the runtime + key distribution
curl -s -X POST -H 'Authorization: Bearer hubk' -H 'Content-Type: application/json' \
  -d '{"name":"local-rt","url":"http://127.0.0.1:9199","key":"rtk"}' http://127.0.0.1:9198/api/machines
curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines                          # includes "key":"rtk"

# health + proxy (hub key in, runtime key injected server-side)
MID=$(curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines/$MID/health              # {"status":"online",...}
curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines/$MID/proxy/api/health    # runtime's health via proxy
kill %1 %2
```

Also confirm no regression: `go test ./internal/terminal/ -v` (WS compression tests must stay green).

## Notes for execution

- On approval, first copy this plan to `docs/superpowers/plans/2026-07-09-backend-hub-runtime-key-auth.md` (superpowers plan location) before starting Task 1.
- Tasks are strictly ordered; 1–4 are the auth/roles spine, 5–9 the machines feature, 10 docs.
- Sub-projects #2 (frontend multi-machine) and #3 (Tauri) get their own plans after this ships.

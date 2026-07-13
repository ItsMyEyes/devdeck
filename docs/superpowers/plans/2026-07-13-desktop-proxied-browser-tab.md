# Desktop Proxied Browser Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, native-webview "Browser" tab to the desktop app's workspace tab strip, backed by a chosen machine's SOCKS5/HTTP forward proxy (started on demand), with bookmarks and a bookmarks-or-blank home page.

**Architecture:** A new `browser` `TileTab` kind (alongside `agents`/`worktree`) renders via `WorkspaceTileCanvas`; its content is a React placeholder `<div>` whose on-screen rect is mirrored, via new Tauri commands, onto a real native child `Webview` (`Window::add_child` + `WebviewBuilder::proxy_url`) so the browsing traffic actually routes through a machine's forward proxy. The proxy itself is started on demand by a new backend endpoint (`POST /api/proxy/start`), not via CLI flags.

**Tech Stack:** Go 1.25 (stdlib `net/http`), React 19 + zustand + immer, Tauri v2 (Rust), `@tauri-apps/api` (new dependency).

## Global Constraints

- Desktop (Tauri) only — every frontend piece is reached only from behind `useIsTauri()`, matching the existing tab-tiling feature.
- `frontend/src/store/useLoomStore.ts` and `backend/cmd/server/main.go` are project convergence files (root `CLAUDE.md`) — each is touched by exactly one task below (Task 6 and Task 3 respectively). Do not edit either from any other task.
- No domain model changes: `domain.Machine`/`frontend/src/store/types.ts` stay exactly as they are — the proxy is ephemeral, in-memory, start-on-demand state, not a persisted field.
- No `port.Store` involvement anywhere in this feature — proxy state is process-local, not database-backed.
- Never hand-edit `frontend/src/routeTree.gen.ts` — this feature adds no new routes at all (a Browser tab is tile-tree state, not a router route).
- Go: `handleStoreErr`/`writeJSON`/`writeErr`/`decodeBody` conventions from `backend/internal/handler/middleware.go` apply to the one new handler in this plan; run `go vet ./...` before every backend commit.
- Frontend: `@/*` import alias, `import type` for type-only imports (`verbatimModuleSyntax`), run `npm run typecheck` before every frontend commit.
- No test runner exists in `frontend/` — frontend/Rust verification is `npm run typecheck` (+ `npm run build` where noted) and manual verification via `make dev-tauri`, matching every prior task in the tab-tiling feature this builds on.
- Spec: `docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md`. Read it before starting if anything below is unclear on intent.

---

### Task 1: `backend/internal/service/proxy.go` — on-demand proxy service

**Files:**
- Create: `backend/internal/service/proxy.go`
- Test: `backend/internal/service/proxy_test.go`

**Interfaces:**
- Consumes: `netproxy.NewSOCKS5Server(key string) *netproxy.SOCKS5Server` and `netproxy.NewHTTPProxyHandler(key string) *netproxy.HTTPProxyHandler` (existing, unchanged, in `backend/internal/netproxy`).
- Produces (used by Task 2): `type ProxyStartResult struct { SOCKS5Addr, HTTPProxyAddr, ProxyKey string }`, `func NewProxyService(advertiseHost string) *ProxyService`, `func (s *ProxyService) Start() (ProxyStartResult, error)`.

- [ ] **Step 1: Write the failing tests**

```go
package service

import (
	"net"
	"testing"
)

func TestProxyServiceStartIsIdempotent(t *testing.T) {
	svc := NewProxyService("127.0.0.1")

	first, err := svc.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if first.SOCKS5Addr == "" || first.HTTPProxyAddr == "" || first.ProxyKey == "" {
		t.Fatalf("Start returned incomplete result: %+v", first)
	}
	if first.SOCKS5Addr == first.HTTPProxyAddr {
		t.Fatalf("socks5 and http proxy addrs must differ, got %q for both", first.SOCKS5Addr)
	}

	second, err := svc.Start()
	if err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if second != first {
		t.Fatalf("second Start() = %+v, want identical to first %+v (idempotent)", second, first)
	}
}

func TestProxyServiceListenersAcceptConnections(t *testing.T) {
	svc := NewProxyService("127.0.0.1")
	result, err := svc.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	conn, err := net.Dial("tcp", result.SOCKS5Addr)
	if err != nil {
		t.Fatalf("dial socks5 listener at %s: %v", result.SOCKS5Addr, err)
	}
	conn.Close()

	conn, err = net.Dial("tcp", result.HTTPProxyAddr)
	if err != nil {
		t.Fatalf("dial http proxy listener at %s: %v", result.HTTPProxyAddr, err)
	}
	conn.Close()
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/ -run TestProxyService -v`
Expected: FAIL — `NewProxyService`/`ProxyStartResult` undefined.

- [ ] **Step 3: Write the implementation**

```go
package service

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"sync"

	"loom/backend/internal/netproxy"
)

// ProxyStartResult is the bound state of an on-demand forward proxy pair.
type ProxyStartResult struct {
	SOCKS5Addr    string
	HTTPProxyAddr string
	ProxyKey      string
}

// ProxyService starts backend/internal/netproxy's SOCKS5 and HTTP forward
// proxies on demand (idempotent) instead of via CLI flags, so a desktop
// client can ask any machine running this backend to "start your forward
// proxy now" and then dial it directly over the tailnet. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.
type ProxyService struct {
	// advertiseHost is the interface this machine is reachable at (the
	// runtime's own --public-url hostname) — the listeners themselves bind
	// on all interfaces (":0"), but the *advertised* address must be
	// tailnet-reachable, not the bind address, since the desktop client
	// dialing this proxy usually runs on a different machine.
	advertiseHost string

	mu      sync.Mutex
	started bool
	result  ProxyStartResult
}

func NewProxyService(advertiseHost string) *ProxyService {
	return &ProxyService{advertiseHost: advertiseHost}
}

// Start starts (once) the SOCKS5+HTTP forward proxies bound to ephemeral
// ports, generating a fresh, non-persisted proxy key. A second call while
// already running returns the existing bound addresses/key rather than
// starting a duplicate listener pair.
func (s *ProxyService) Start() (ProxyStartResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return s.result, nil
	}

	key, err := generateProxyKey()
	if err != nil {
		return ProxyStartResult{}, fmt.Errorf("generate proxy key: %w", err)
	}

	socks5Ln, err := net.Listen("tcp", ":0")
	if err != nil {
		return ProxyStartResult{}, fmt.Errorf("listen socks5: %w", err)
	}
	httpLn, err := net.Listen("tcp", ":0")
	if err != nil {
		socks5Ln.Close()
		return ProxyStartResult{}, fmt.Errorf("listen http proxy: %w", err)
	}

	_, socks5Port, err := net.SplitHostPort(socks5Ln.Addr().String())
	if err != nil {
		socks5Ln.Close()
		httpLn.Close()
		return ProxyStartResult{}, fmt.Errorf("resolve socks5 port: %w", err)
	}
	_, httpPort, err := net.SplitHostPort(httpLn.Addr().String())
	if err != nil {
		socks5Ln.Close()
		httpLn.Close()
		return ProxyStartResult{}, fmt.Errorf("resolve http proxy port: %w", err)
	}

	go func() { _ = netproxy.NewSOCKS5Server(key).Serve(socks5Ln) }()
	go func() {
		srv := &http.Server{Handler: netproxy.NewHTTPProxyHandler(key)}
		_ = srv.Serve(httpLn)
	}()

	s.result = ProxyStartResult{
		SOCKS5Addr:    net.JoinHostPort(s.advertiseHost, socks5Port),
		HTTPProxyAddr: net.JoinHostPort(s.advertiseHost, httpPort),
		ProxyKey:      key,
	}
	s.started = true
	return s.result, nil
}

func generateProxyKey() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run TestProxyService -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/proxy.go backend/internal/service/proxy_test.go
git commit -m "feat(proxy): add on-demand forward-proxy service"
```

---

### Task 2: `backend/internal/handler/proxy.go` — `POST /api/proxy/start`

**Files:**
- Create: `backend/internal/handler/proxy.go`
- Test: `backend/internal/handler/proxy_test.go`

**Interfaces:**
- Consumes: `service.ProxyService`/`service.ProxyStartResult` (Task 1); `writeJSON`, `writeErr` (existing, `backend/internal/handler/middleware.go`).
- Produces (used by Task 3): `func NewProxyHandler(svc *service.ProxyService) *ProxyHandler`, `func (h *ProxyHandler) PostStart(w http.ResponseWriter, r *http.Request)` — response body `{"socks5Addr":"...","httpProxyAddr":"...","proxyKey":"..."}`.

- [ ] **Step 1: Write the failing tests**

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"loom/backend/internal/service"
)

func TestProxyHandlerPostStartReturnsBoundAddresses(t *testing.T) {
	h := NewProxyHandler(service.NewProxyService("127.0.0.1"))
	req := httptest.NewRequest(http.MethodPost, "/api/proxy/start", nil)
	rec := httptest.NewRecorder()

	h.PostStart(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body struct {
		SOCKS5Addr    string `json:"socks5Addr"`
		HTTPProxyAddr string `json:"httpProxyAddr"`
		ProxyKey      string `json:"proxyKey"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.SOCKS5Addr == "" || body.HTTPProxyAddr == "" || body.ProxyKey == "" {
		t.Fatalf("response missing fields: %+v", body)
	}
}

func TestProxyHandlerPostStartIsIdempotent(t *testing.T) {
	h := NewProxyHandler(service.NewProxyService("127.0.0.1"))

	rec1 := httptest.NewRecorder()
	h.PostStart(rec1, httptest.NewRequest(http.MethodPost, "/api/proxy/start", nil))

	rec2 := httptest.NewRecorder()
	h.PostStart(rec2, httptest.NewRequest(http.MethodPost, "/api/proxy/start", nil))

	if rec1.Body.String() != rec2.Body.String() {
		t.Fatalf("second call returned a different body:\nfirst:  %s\nsecond: %s", rec1.Body.String(), rec2.Body.String())
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/ -run TestProxyHandler -v`
Expected: FAIL — `NewProxyHandler` undefined.

- [ ] **Step 3: Write the implementation**

```go
package handler

import (
	"net/http"

	"loom/backend/internal/service"
)

// ProxyHandler exposes ProxyService's on-demand SOCKS5/HTTP forward proxy
// over HTTP, for the desktop app's machine-proxied Browser tab to call
// before pointing a native webview's proxy_url at the result.
type ProxyHandler struct {
	svc *service.ProxyService
}

func NewProxyHandler(svc *service.ProxyService) *ProxyHandler {
	return &ProxyHandler{svc: svc}
}

// PostStart idempotently starts this machine's forward proxy pair. A second
// call while already running returns the existing bound addresses/key.
func (h *ProxyHandler) PostStart(w http.ResponseWriter, r *http.Request) {
	result, err := h.svc.Start()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"socks5Addr":    result.SOCKS5Addr,
		"httpProxyAddr": result.HTTPProxyAddr,
		"proxyKey":      result.ProxyKey,
	})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -run TestProxyHandler -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/proxy.go backend/internal/handler/proxy_test.go
git commit -m "feat(proxy): add POST /api/proxy/start handler"
```

---

### Task 3: Wire into `main.go` + document in `CONTRACTS.md`

**Files:**
- Modify: `backend/cmd/server/main.go` (convergence file — this is the only task touching it)
- Modify: `CONTRACTS.md`

**Interfaces:**
- Consumes: `service.NewProxyService` (Task 1), `handler.NewProxyHandler` (Task 2).
- Produces: nothing further downstream — this is the backend integration task.

- [ ] **Step 1: Add the `net/url` import**

In `backend/cmd/server/main.go`, change the import block (currently):

```go
import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"loom/backend/internal/config"
	"loom/backend/internal/handler"
	"loom/backend/internal/lsp"
	"loom/backend/internal/machineclient"
	"loom/backend/internal/netproxy"
	"loom/backend/internal/port"
	"loom/backend/internal/registry"
	"loom/backend/internal/selfupdate"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
	"loom/backend/internal/terminal"
	"loom/backend/internal/version"
	"loom/backend/internal/webui"
)
```

to:

```go
import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"loom/backend/internal/config"
	"loom/backend/internal/handler"
	"loom/backend/internal/lsp"
	"loom/backend/internal/machineclient"
	"loom/backend/internal/netproxy"
	"loom/backend/internal/port"
	"loom/backend/internal/registry"
	"loom/backend/internal/selfupdate"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
	"loom/backend/internal/terminal"
	"loom/backend/internal/version"
	"loom/backend/internal/webui"
)
```

- [ ] **Step 2: Construct the service + handler**

Change (currently):

```go
	toolsH := handler.NewToolsHandler(toolsSvc)

	mux := http.NewServeMux()
```

to:

```go
	toolsH := handler.NewToolsHandler(toolsSvc)

	advertiseURL, err := url.Parse(*publicURL)
	if err != nil {
		log.Fatalf("--public-url: %v", err)
	}
	proxySvc := service.NewProxyService(advertiseURL.Hostname())
	proxyH := handler.NewProxyHandler(proxySvc)

	mux := http.NewServeMux()
```

- [ ] **Step 3: Register the route (unconditionally — both hub and runtime)**

Change (currently):

```go
	mux.HandleFunc("POST /api/tools/markitdown", toolsH.PostMarkitdown)
	mux.HandleFunc("POST /api/tools/markdown-export", toolsH.PostMarkdownExport)
	if !isRuntime {
		browserH := handler.NewBrowserProxyHandler(authSvc)
		mux.HandleFunc("GET /api/browser/session", browserH.GetSession)
		mux.HandleFunc("/api/browser/proxy", browserH.Proxy)
	}

	mux.HandleFunc("/ws/terminal", termSrv.HandleWS)
```

to:

```go
	mux.HandleFunc("POST /api/tools/markitdown", toolsH.PostMarkitdown)
	mux.HandleFunc("POST /api/tools/markdown-export", toolsH.PostMarkdownExport)
	if !isRuntime {
		browserH := handler.NewBrowserProxyHandler(authSvc)
		mux.HandleFunc("GET /api/browser/session", browserH.GetSession)
		mux.HandleFunc("/api/browser/proxy", browserH.Proxy)
	}

	mux.HandleFunc("POST /api/proxy/start", proxyH.PostStart)

	mux.HandleFunc("/ws/terminal", termSrv.HandleWS)
```

- [ ] **Step 4: Run backend build + vet**

Run: `cd backend && go build ./... && go vet ./...`
Expected: both succeed with no errors.

- [ ] **Step 5: Document the endpoint in `CONTRACTS.md`**

In `CONTRACTS.md`, immediately after the existing "Machines API" section's last bullet (the `/api/machines/{id}/proxy/{rest...}` reverse-proxy contract), add:

```markdown

## On-demand forward proxy API (both roles)

```go
type ProxyStartResponse struct {
    SOCKS5Addr    string `json:"socks5Addr"`
    HTTPProxyAddr string `json:"httpProxyAddr"`
    ProxyKey      string `json:"proxyKey"`
}
```

- `POST /api/proxy/start` — registered on both `--role hub` and `--role runtime`
  (unlike the Machines CRUD routes, which are hub-only). Idempotently starts
  `backend/internal/netproxy`'s SOCKS5+HTTP forward proxy pair in-process,
  bound to ephemeral ports on all interfaces, advertised at the hostname from
  this machine's own `--public-url`. A fresh `crypto/rand` proxy key is
  generated on first start and never persisted; a second call while already
  running returns the exact same response instead of starting a duplicate
  listener pair. No `port.Store` involvement — this is in-memory process
  state. See
  `docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md`.
```

- [ ] **Step 6: Commit**

```bash
git add backend/cmd/server/main.go CONTRACTS.md
git commit -m "feat(proxy): wire POST /api/proxy/start into main.go"
```

---

### Task 4: `frontend/src/lib/machineApi.ts` — `startProxy` client function

**Files:**
- Modify: `frontend/src/lib/machineApi.ts`

**Interfaces:**
- Consumes: `machineRequest` (existing, `./machineClient`), `Machine` (existing, `@/store/types`).
- Produces (used by Task 11): `interface ProxyStartResponse { socks5Addr: string; httpProxyAddr: string; proxyKey: string }`, `function startProxy(machine: Machine): Promise<ProxyStartResponse>`.

- [ ] **Step 1: Append the new section**

At the end of `frontend/src/lib/machineApi.ts` (after `createFsFolder`), add:

```ts
// ---- Forward proxy (on-demand SOCKS5/HTTP, for the machine-proxied Browser tab) ----

export interface ProxyStartResponse {
  socks5Addr: string
  httpProxyAddr: string
  proxyKey: string
}

/** Idempotently starts this machine's SOCKS5+HTTP forward proxy. A second
 *  call while already running returns the same bound addresses/key. */
export function startProxy(machine: Machine): Promise<ProxyStartResponse> {
  return machineRequest<ProxyStartResponse>(machine, 'POST', '/proxy/start')
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/machineApi.ts
git commit -m "feat(proxy): add startProxy machine API client function"
```

---

### Task 5: `tileTree.ts` — `browser` `TileTab` kind

**Files:**
- Modify: `frontend/src/features/tabs/tileTree.ts`

**Interfaces:**
- Consumes: nothing new (existing `generateTileId()`, private to this file).
- Produces (used by Tasks 6, 7, 8, 12): `{ kind: 'browser'; id: string }` added to the `TileTab` union; `createBrowserTab(): TileTab`.

- [ ] **Step 1: Extend the `TileTab` union**

Change:

```ts
export type TileTab =
  | { kind: 'agents'; id: 'agents' }
  | { kind: 'worktree'; id: string; projectId: string; wtId: string }
```

to:

```ts
export type TileTab =
  | { kind: 'agents'; id: 'agents' }
  | { kind: 'worktree'; id: string; projectId: string; wtId: string }
  | { kind: 'browser'; id: string }
```

- [ ] **Step 2: Add the factory, right after `createWorktreeTab`**

Change:

```ts
export function createWorktreeTab(projectId: string, wtId: string): TileTab {
  return { kind: 'worktree', id: wtId, projectId, wtId }
}
```

to:

```ts
export function createWorktreeTab(projectId: string, wtId: string): TileTab {
  return { kind: 'worktree', id: wtId, projectId, wtId }
}

/** A Browser tile carries no routing data of its own — unlike a worktree
 *  tab (which points at a backend-owned worktree by id), a browser tab's
 *  live state (url, history, machine/proxy) lives entirely in the store's
 *  `browserTiles` slice, keyed by this same generated id. */
export function createBrowserTab(): TileTab {
  return { kind: 'browser', id: generateTileId() }
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/tabs/tileTree.ts
git commit -m "feat(tabs): add browser TileTab kind"
```

---

### Task 6: `frontend/src/lib/browserTileBookmarks.ts` — separate bookmark store

**Files:**
- Create: `frontend/src/lib/browserTileBookmarks.ts`

**Interfaces:**
- Consumes: nothing (pure module, `localStorage` only).
- Produces (used by Task 11): `interface BrowserTileBookmark { id: string; title: string; url: string; group: string }`, `loadBrowserTileBookmarks(): BrowserTileBookmark[]`, `addBrowserTileBookmark(bookmarks, entry): BrowserTileBookmark[]`, `removeBrowserTileBookmark(bookmarks, bookmarkId): BrowserTileBookmark[]`, `groupBrowserTileBookmarks(bookmarks): [string, BrowserTileBookmark[]][]`.

- [ ] **Step 1: Write the file**

```ts
// Standalone bookmark store for the machine-proxied workspace Browser tile.
// Deliberately separate from the sandboxed-iframe BrowserModule's own
// `loom.browser.bookmarks` — starring a page in one surface does not appear
// in the other. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.

export interface BrowserTileBookmark {
  id: string
  title: string
  url: string
  group: string
}

const STORAGE_KEY = 'loom.workspaceBrowser.bookmarks'
const HTTP_SCHEME = /^https?:\/\//i

function newBookmarkId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function persist(bookmarks: BrowserTileBookmark[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks))
  } catch {
    // Bookmark persistence is a convenience; browsing itself still works.
  }
}

export function loadBrowserTileBookmarks(): BrowserTileBookmark[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is BrowserTileBookmark =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.url === 'string' &&
        typeof item.group === 'string' &&
        HTTP_SCHEME.test(item.url),
    )
  } catch {
    return []
  }
}

export function addBrowserTileBookmark(
  bookmarks: BrowserTileBookmark[],
  entry: { title: string; url: string; group: string },
): BrowserTileBookmark[] {
  const group = entry.group.trim() || 'Portal'
  const existing = bookmarks.find((b) => b.url === entry.url && b.group.toLowerCase() === group.toLowerCase())
  const next = existing
    ? bookmarks.map((b) => (b.id === existing.id ? { ...b, title: entry.title, group } : b))
    : [...bookmarks, { id: newBookmarkId(), title: entry.title, url: entry.url, group }]
  persist(next)
  return next
}

export function removeBrowserTileBookmark(bookmarks: BrowserTileBookmark[], bookmarkId: string): BrowserTileBookmark[] {
  const next = bookmarks.filter((b) => b.id !== bookmarkId)
  persist(next)
  return next
}

export function groupBrowserTileBookmarks(bookmarks: BrowserTileBookmark[]): [string, BrowserTileBookmark[]][] {
  const groups = new Map<string, BrowserTileBookmark[]>()
  for (const bookmark of bookmarks) {
    const group = bookmark.group.trim() || 'Portal'
    groups.set(group, [...(groups.get(group) ?? []), bookmark])
  }
  return [...groups.entries()]
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/browserTileBookmarks.ts
git commit -m "feat(browser): add separate bookmark store for the workspace Browser tile"
```

---

### Task 7: `useLoomStore.ts` — `browserTiles` slice + `openBrowserTab`

**Files:**
- Modify: `frontend/src/store/useLoomStore.ts` (convergence file — this is the only task touching it)

**Interfaces:**
- Consumes: `createBrowserTab`, `createDefaultTileLayout`, `openTileTab` (Task 5's `@/features/tabs/tileTree`, `createDefaultTileLayout`/`openTileTab` already imported there).
- Produces (used by Tasks 11, 12): `BrowserProxyInfo`, `BrowserDocState`, `BrowserTileState` types; `browserTiles: Record<string, BrowserTileState>` on `LoomState`; actions `openBrowserTab(wsId)`, `ensureBrowserTile(tabId)`, `setBrowserDocState(tabId, docId, patch)`, `addBrowserDoc(tabId)`, `closeBrowserDoc(tabId, docId)`, `selectBrowserDoc(tabId, docId)`, `setBrowserTileFullscreen(tabId, fullscreen)`, `removeBrowserTile(tabId)`.

- [ ] **Step 1: Add the `createBrowserTab` import**

Change:

```ts
import {
  closeTileTab,
  createDefaultTileLayout,
  createWorktreeTab,
  findLeafForTab,
  openTileTab,
  pruneTileTabs,
} from '@/features/tabs/tileTree'
```

to:

```ts
import {
  closeTileTab,
  createBrowserTab,
  createDefaultTileLayout,
  createWorktreeTab,
  findLeafForTab,
  openTileTab,
  pruneTileTabs,
} from '@/features/tabs/tileTree'
```

- [ ] **Step 2: Add the browser-tile types, right after the `MachineDialogState` interface**

Change:

```ts
interface MachineDialogState {
  open: boolean
  editingId: string | null
  name: string
  url: string
  key: string
}
```

to:

```ts
interface MachineDialogState {
  open: boolean
  editingId: string | null
  name: string
  url: string
  key: string
}

export interface BrowserProxyInfo {
  socks5Addr: string
  httpProxyAddr: string
  proxyKey: string
}

/** One browsing "document" within a Browser tile — plural because
 *  fullscreen mode reveals an internal tab strip so a single Browser tile
 *  can hold more than one page at once (see the design spec's Decision 2). */
export interface BrowserDocState {
  id: string
  machineId: string | null
  proxy: BrowserProxyInfo | null
  url: string | null
  title: string
  loading: boolean
  history: string[]
  historyIndex: number
}

export interface BrowserTileState {
  fullscreen: boolean
  activeDocId: string
  docs: BrowserDocState[]
}

function generateDocId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createBrowserDoc(id: string): BrowserDocState {
  return { id, machineId: null, proxy: null, url: null, title: 'New Tab', loading: false, history: [], historyIndex: -1 }
}

function createBrowserTileState(): BrowserTileState {
  const docId = generateDocId()
  return { fullscreen: false, activeDocId: docId, docs: [createBrowserDoc(docId)] }
}
```

- [ ] **Step 3: Add the `browserTiles` field and action signatures to `LoomState`**

Change:

```ts
  /** Chrome-style desktop tab bar (Tauri only): each workspace's tiling
   *  tree of open worktree tabs (splits, per-leaf tab strips). Unused by
   *  the web app. */
  workspaceTileLayouts: Record<string, WorkspaceTileLayout>

  // ---- actions ----
```

to:

```ts
  /** Chrome-style desktop tab bar (Tauri only): each workspace's tiling
   *  tree of open worktree tabs (splits, per-leaf tab strips). Unused by
   *  the web app. */
  workspaceTileLayouts: Record<string, WorkspaceTileLayout>
  /** Live browsing state for every open Browser tile, keyed by the tile's
   *  TileTab id. Deliberately NOT persisted (see the `partialize` config
   *  below) — a restored `browser` tab reopens to its blank/bookmarks home
   *  state, same as `ensureBrowserTile` lazily re-creating a missing entry. */
  browserTiles: Record<string, BrowserTileState>

  // ---- actions ----
```

Change:

```ts
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
  setWorkspaceTileLayout: (wsId: string, layout: WorkspaceTileLayout) => void
```

to:

```ts
  openWorktreeTab: (wsId: string, projectId: string, wtId: string) => void
  closeWorktreeTab: (wsId: string, wtId: string) => void
  pruneWorktreeTabs: (wsId: string, liveWtIds: Set<string>) => void
  setWorkspaceTileLayout: (wsId: string, layout: WorkspaceTileLayout) => void

  // browser tile (Tauri only)
  openBrowserTab: (wsId: string) => void
  ensureBrowserTile: (tabId: string) => void
  setBrowserDocState: (tabId: string, docId: string, patch: Partial<Omit<BrowserDocState, 'id'>>) => void
  addBrowserDoc: (tabId: string) => void
  closeBrowserDoc: (tabId: string, docId: string) => void
  selectBrowserDoc: (tabId: string, docId: string) => void
  setBrowserTileFullscreen: (tabId: string, fullscreen: boolean) => void
  removeBrowserTile: (tabId: string) => void
```

- [ ] **Step 4: Add the initial state field**

Change:

```ts
      worktreeLayouts: {},
      railExpanded: false,
      workspaceTileLayouts: {},
```

to:

```ts
      worktreeLayouts: {},
      railExpanded: false,
      workspaceTileLayouts: {},
      browserTiles: {},
```

- [ ] **Step 5: Add the action implementations, right after `pruneWorktreeTabs`**

Change:

```ts
      pruneWorktreeTabs: (wsId, liveWtIds) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId]
          if (!layout) return
          s.workspaceTileLayouts[wsId] = pruneTileTabs(layout, liveWtIds)
        }),

      openSpawn: (projectId, mode, model) =>
```

to:

```ts
      pruneWorktreeTabs: (wsId, liveWtIds) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId]
          if (!layout) return
          s.workspaceTileLayouts[wsId] = pruneTileTabs(layout, liveWtIds)
        }),

      openBrowserTab: (wsId) =>
        set((s) => {
          const layout = s.workspaceTileLayouts[wsId] ?? createDefaultTileLayout()
          const tab = createBrowserTab()
          s.workspaceTileLayouts[wsId] = openTileTab(layout, tab)
          s.browserTiles[tab.id] = createBrowserTileState()
        }),
      ensureBrowserTile: (tabId) =>
        set((s) => {
          if (!s.browserTiles[tabId]) s.browserTiles[tabId] = createBrowserTileState()
        }),
      setBrowserDocState: (tabId, docId, patch) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          const doc = tile?.docs.find((d) => d.id === docId)
          if (doc) Object.assign(doc, patch)
        }),
      addBrowserDoc: (tabId) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (!tile) return
          const doc = createBrowserDoc(generateDocId())
          tile.docs.push(doc)
          tile.activeDocId = doc.id
        }),
      closeBrowserDoc: (tabId, docId) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (!tile || tile.docs.length === 1) return
          const idx = tile.docs.findIndex((d) => d.id === docId)
          if (idx === -1) return
          tile.docs.splice(idx, 1)
          if (tile.activeDocId === docId) {
            tile.activeDocId = (tile.docs[idx] ?? tile.docs[idx - 1]).id
          }
        }),
      selectBrowserDoc: (tabId, docId) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (tile) tile.activeDocId = docId
        }),
      setBrowserTileFullscreen: (tabId, fullscreen) =>
        set((s) => {
          const tile = s.browserTiles[tabId]
          if (tile) tile.fullscreen = fullscreen
        }),
      removeBrowserTile: (tabId) => set((s) => void delete s.browserTiles[tabId]),

      openSpawn: (projectId, mode, model) =>
```

- [ ] **Step 6: Confirm `partialize`/`migrate` are untouched**

`browserTiles` must **not** appear in the `partialize` object or the `migrate` function's returned object (both further down in the file) — browsing state is intentionally ephemeral, matching the (also-unpersisted) per-tab state in the kept `BrowserModule.tsx`. No edit needed here; this step is a checkpoint, not a change.

- [ ] **Step 7: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/store/useLoomStore.ts
git commit -m "feat(browser): add browserTiles store slice and openBrowserTab action"
```

---

### Task 8: `WorkspaceTileCanvas.tsx` — render/drag support for `browser` tabs

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`

**Interfaces:**
- Consumes: `{ kind: 'browser'; id: string }` (Task 5).
- Produces (used by Task 12): `export type BrowserTileTab = Extract<TileTab, { kind: 'browser' }>`; `WorkspaceTileCanvasProps.renderers.browser: (ctx: { leafId: string; tab: BrowserTileTab }) => ReactNode`; `WorkspaceTileCanvasProps.resolveBrowserTab: (tab: BrowserTileTab) => { label: string } | undefined`.

- [ ] **Step 1: Import the `Globe` icon**

Change:

```ts
import { LayoutGrid, Plus, X } from 'lucide-react'
```

to:

```ts
import { Globe, LayoutGrid, Plus, X } from 'lucide-react'
```

- [ ] **Step 2: Add `BrowserTileTab` and extend `WorkspaceTileCanvasProps`**

Change:

```ts
export type WorktreeTileTab = Extract<TileTab, { kind: 'worktree' }>

export interface WorkspaceTileCanvasProps {
  root: TileNode
  renderers: {
    agents: (ctx: { leafId: string }) => ReactNode
    worktree: (ctx: { leafId: string; tab: WorktreeTileTab }) => ReactNode
  }
  /** Fired for every structural change this component makes itself: drag-and-drop commits and divider-resize commits. */
  onTreeChange: (root: TileNode) => void
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  /** Live label/status-color for a worktree tab, resolved by the caller
   *  from react-query data (not stored statically, since a worktree's
   *  branch/state can change while its tab stays open). `undefined` hides
   *  the tab (e.g. a worktree deleted right before pruning catches up). */
  resolveWorktreeTab: (tab: WorktreeTileTab) => { label: string; color: string; pulse: boolean } | undefined
  className?: string
}

interface TileRenderContext {
  topLeftLeafId: string
  renderers: WorkspaceTileCanvasProps['renderers']
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  onResizeSplit: (splitId: string, sizes: number[]) => void
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  hoverZone: { leafId: string; zone: TileDropZone } | null
}
```

to:

```ts
export type WorktreeTileTab = Extract<TileTab, { kind: 'worktree' }>
export type BrowserTileTab = Extract<TileTab, { kind: 'browser' }>

export interface WorkspaceTileCanvasProps {
  root: TileNode
  renderers: {
    agents: (ctx: { leafId: string }) => ReactNode
    worktree: (ctx: { leafId: string; tab: WorktreeTileTab }) => ReactNode
    browser: (ctx: { leafId: string; tab: BrowserTileTab }) => ReactNode
  }
  /** Fired for every structural change this component makes itself: drag-and-drop commits and divider-resize commits. */
  onTreeChange: (root: TileNode) => void
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  /** Live label/status-color for a worktree tab, resolved by the caller
   *  from react-query data (not stored statically, since a worktree's
   *  branch/state can change while its tab stays open). `undefined` hides
   *  the tab (e.g. a worktree deleted right before pruning catches up). */
  resolveWorktreeTab: (tab: WorktreeTileTab) => { label: string; color: string; pulse: boolean } | undefined
  /** Live title for a browser tab, resolved from the store's `browserTiles`
   *  slice (not stored in the tile tree itself). `undefined` hides the tab
   *  (mirrors `resolveWorktreeTab`'s contract). */
  resolveBrowserTab: (tab: BrowserTileTab) => { label: string } | undefined
  className?: string
}

interface TileRenderContext {
  topLeftLeafId: string
  renderers: WorkspaceTileCanvasProps['renderers']
  onFocusLeaf: (leafId: string) => void
  onSelectTab: (leafId: string, tabId: string) => void
  onCloseTab: (leafId: string, tabId: string) => void
  onNewTab: (leafId: string) => void
  onResizeSplit: (splitId: string, sizes: number[]) => void
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab']
  hoverZone: { leafId: string; zone: TileDropZone } | null
}
```

- [ ] **Step 3: Extend `TileTabButton` with a `browser`-kind branch**

Change:

```tsx
function TileTabButton({
  leafId,
  tab,
  active,
  resolveWorktreeTab,
  onSelect,
  onClose,
}: {
  leafId: string
  tab: TileTab
  active: boolean
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  onSelect: () => void
  onClose?: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tab.id,
    data: { tabId: tab.id, sourceLeafId: leafId },
  })

  const wrapperClass = (dragging: boolean) =>
    cn(
      'group flex h-7 max-w-[180px] flex-none touch-none cursor-grab items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 font-mono text-[11.5px] active:cursor-grabbing',
      active ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
      dragging && 'opacity-40',
    )

  if (tab.kind === 'worktree') {
    const info = resolveWorktreeTab(tab)
    if (!info) return null
    return (
      <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
          <StatusDot color={info.color} pulse={info.pulse} />
          <span className="truncate">{info.label}</span>
        </button>
        {onClose ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            aria-label={`Close ${info.label}`}
            className="flex-none rounded p-0.5 text-loom-dim opacity-0 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100"
          >
            <X size={11} />
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
        <LayoutGrid size={12} />
        <span className="truncate">Agents</span>
      </button>
    </div>
  )
}
```

to:

```tsx
function TileTabButton({
  leafId,
  tab,
  active,
  resolveWorktreeTab,
  resolveBrowserTab,
  onSelect,
  onClose,
}: {
  leafId: string
  tab: TileTab
  active: boolean
  resolveWorktreeTab: WorkspaceTileCanvasProps['resolveWorktreeTab']
  resolveBrowserTab: WorkspaceTileCanvasProps['resolveBrowserTab']
  onSelect: () => void
  onClose?: () => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: tab.id,
    data: { tabId: tab.id, sourceLeafId: leafId },
  })

  const wrapperClass = (dragging: boolean) =>
    cn(
      'group flex h-7 max-w-[180px] flex-none touch-none cursor-grab items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 font-mono text-[11.5px] active:cursor-grabbing',
      active ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
      dragging && 'opacity-40',
    )

  const closeButton = (label: string) =>
    onClose ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${label}`}
        className="flex-none rounded p-0.5 text-loom-dim opacity-0 hover:bg-loom-hover-wash hover:text-loom-fg group-hover:opacity-100"
      >
        <X size={11} />
      </button>
    ) : null

  if (tab.kind === 'worktree') {
    const info = resolveWorktreeTab(tab)
    if (!info) return null
    return (
      <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
          <StatusDot color={info.color} pulse={info.pulse} />
          <span className="truncate">{info.label}</span>
        </button>
        {closeButton(info.label)}
      </div>
    )
  }

  if (tab.kind === 'browser') {
    const info = resolveBrowserTab(tab)
    if (!info) return null
    return (
      <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
          <Globe size={12} />
          <span className="truncate">{info.label}</span>
        </button>
        {closeButton(info.label)}
      </div>
    )
  }

  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={wrapperClass(isDragging)}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5">
        <LayoutGrid size={12} />
        <span className="truncate">Agents</span>
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Wire the new prop through `TileLeafView`'s tab strip and content dispatch**

Change:

```tsx
        {leaf.tabs.map((tab) => (
          <TileTabButton
            key={tab.id}
            leafId={leaf.id}
            tab={tab}
            active={tab.id === leaf.activeTabId}
            resolveWorktreeTab={ctx.resolveWorktreeTab}
            onSelect={() => ctx.onSelectTab(leaf.id, tab.id)}
            onClose={tab.kind === 'worktree' ? () => ctx.onCloseTab(leaf.id, tab.id) : undefined}
          />
        ))}
```

to:

```tsx
        {leaf.tabs.map((tab) => (
          <TileTabButton
            key={tab.id}
            leafId={leaf.id}
            tab={tab}
            active={tab.id === leaf.activeTabId}
            resolveWorktreeTab={ctx.resolveWorktreeTab}
            resolveBrowserTab={ctx.resolveBrowserTab}
            onSelect={() => ctx.onSelectTab(leaf.id, tab.id)}
            onClose={tab.kind !== 'agents' ? () => ctx.onCloseTab(leaf.id, tab.id) : undefined}
          />
        ))}
```

Change:

```tsx
        {leaf.tabs.map((tab) => (
          <div key={tab.id} className={cn('absolute inset-0', tab.id === leaf.activeTabId ? 'flex' : 'hidden')}>
            {tab.kind === 'agents' ? ctx.renderers.agents({ leafId: leaf.id }) : ctx.renderers.worktree({ leafId: leaf.id, tab })}
          </div>
        ))}
```

to:

```tsx
        {leaf.tabs.map((tab) => (
          <div key={tab.id} className={cn('absolute inset-0', tab.id === leaf.activeTabId ? 'flex' : 'hidden')}>
            {tab.kind === 'agents'
              ? ctx.renderers.agents({ leafId: leaf.id })
              : tab.kind === 'worktree'
                ? ctx.renderers.worktree({ leafId: leaf.id, tab })
                : ctx.renderers.browser({ leafId: leaf.id, tab })}
          </div>
        ))}
```

- [ ] **Step 5: Thread `resolveBrowserTab` through `WorkspaceTileCanvas` and the drag overlay**

Change:

```tsx
export function WorkspaceTileCanvas({
  root,
  renderers,
  onTreeChange,
  onFocusLeaf,
  onSelectTab,
  onCloseTab,
  onNewTab,
  resolveWorktreeTab,
  className,
}: WorkspaceTileCanvasProps) {
```

to:

```tsx
export function WorkspaceTileCanvas({
  root,
  renderers,
  onTreeChange,
  onFocusLeaf,
  onSelectTab,
  onCloseTab,
  onNewTab,
  resolveWorktreeTab,
  resolveBrowserTab,
  className,
}: WorkspaceTileCanvasProps) {
```

Change:

```tsx
  const ctx: TileRenderContext = {
    topLeftLeafId,
    renderers,
    onFocusLeaf,
    onSelectTab,
    onCloseTab,
    onNewTab,
    onResizeSplit: handleResizeSplit,
    resolveWorktreeTab,
    hoverZone,
  }
```

to:

```tsx
  const ctx: TileRenderContext = {
    topLeftLeafId,
    renderers,
    onFocusLeaf,
    onSelectTab,
    onCloseTab,
    onNewTab,
    onResizeSplit: handleResizeSplit,
    resolveWorktreeTab,
    resolveBrowserTab,
    hoverZone,
  }
```

Change:

```tsx
      <DragOverlay>
        {dragTab ? (
          <div className="flex h-8 max-w-[200px] items-center gap-1.5 rounded border border-loom-border bg-loom-terminal px-3 font-mono text-[11px] text-loom-fg shadow-[0_10px_28px_rgba(0,0,0,0.5)]">
            {dragTab.kind === 'agents' ? (
              <LayoutGrid size={12} />
            ) : (
              <StatusDot color={resolveWorktreeTab(dragTab)?.color ?? '#6b7280'} />
            )}
            <span className="truncate">
              {dragTab.kind === 'agents' ? 'Agents' : (resolveWorktreeTab(dragTab)?.label ?? dragTab.wtId)}
            </span>
          </div>
        ) : null}
      </DragOverlay>
```

to:

```tsx
      <DragOverlay>
        {dragTab ? (
          <div className="flex h-8 max-w-[200px] items-center gap-1.5 rounded border border-loom-border bg-loom-terminal px-3 font-mono text-[11px] text-loom-fg shadow-[0_10px_28px_rgba(0,0,0,0.5)]">
            {dragTab.kind === 'agents' ? (
              <LayoutGrid size={12} />
            ) : dragTab.kind === 'worktree' ? (
              <StatusDot color={resolveWorktreeTab(dragTab)?.color ?? '#6b7280'} />
            ) : (
              <Globe size={12} />
            )}
            <span className="truncate">
              {dragTab.kind === 'agents'
                ? 'Agents'
                : dragTab.kind === 'worktree'
                  ? (resolveWorktreeTab(dragTab)?.label ?? dragTab.wtId)
                  : (resolveBrowserTab(dragTab)?.label ?? 'Browser')}
            </span>
          </div>
        ) : null}
      </DragOverlay>
```

- [ ] **Step 6: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (`WorkspaceTileArea.tsx` doesn't pass `renderers.browser`/`resolveBrowserTab` yet — that's Task 12 — so this will only compile cleanly once Task 12 lands; if you're executing tasks strictly in order, `WorkspaceTileArea.tsx` isn't touched until Task 12, so the mismatch is expected and resolves there. Typecheck at this exact point may show `WorkspaceTileArea.tsx` errors about missing `renderers.browser`/`resolveBrowserTab` props — that's fine, it's fixed by Task 12; do not treat it as this task's failure.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileCanvas.tsx
git commit -m "feat(tabs): render and drag-and-drop support for browser tabs"
```

---

### Task 9: Tauri Rust — `browser_tiles` module (native child webviews)

**Files:**
- Modify: `frontend/src-tauri/Cargo.toml`
- Create: `frontend/src-tauri/permissions/browser-tiles.toml`
- Modify: `frontend/src-tauri/capabilities/default.json`
- Create: `frontend/src-tauri/src/browser_tiles.rs`
- Modify: `frontend/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing frontend-side yet (Task 10 calls these commands).
- Produces (used by Task 10): Tauri commands `browser_tile_open`, `browser_tile_navigate`, `browser_tile_reload`, `browser_tile_set_bounds`, `browser_tile_hide`, `browser_tile_show`, `browser_tile_close`; event `browser-tile-page-load` with payload `{ label: string, url: string }`.

- [ ] **Step 1: Enable the `unstable` (and macOS `macos-proxy`) Cargo features**

In `frontend/src-tauri/Cargo.toml`, change:

```toml
[dependencies]
serde_json = "1"
serde = { version = "1", features = ["derive"] }
log = "0.4"
tauri = { version = "2.11.3", features = [] }
tauri-plugin-log = "2"
tauri-plugin-shell = "2"
getrandom = "0.4"
tokio = { version = "1", features = ["time", "signal", "macros"] }
reqwest = { version = "0.12", default-features = false, features = ["json"] }
```

to:

```toml
[dependencies]
serde_json = "1"
serde = { version = "1", features = ["derive"] }
log = "0.4"
tauri = { version = "2.11.3", features = ["unstable"] }
tauri-plugin-log = "2"
tauri-plugin-shell = "2"
getrandom = "0.4"
tokio = { version = "1", features = ["time", "signal", "macros"] }
reqwest = { version = "0.12", default-features = false, features = ["json"] }

# `Window::add_child` (unstable) and `WebviewBuilder::proxy_url` (macos-proxy)
# back the machine-proxied Browser tab's native child webviews. macos-proxy
# only compiles for macOS 14+ — Cargo unions this feature into the base
# `tauri` dependency above when building for macOS, leaving other platforms
# unaffected. See
# docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.
[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "2.11.3", features = ["unstable", "macos-proxy"] }
```

- [ ] **Step 2: Write the custom-command permission file**

```toml
# frontend/src-tauri/permissions/browser-tiles.toml
#
# Grants the frontend permission to call this app's own custom browser-tile
# commands. Required because this app already ships an ACL manifest
# (capabilities/default.json) — once an ACL manifest exists, Tauri enforces
# ACL checks on every command, including custom (non-plugin) ones, not just
# its built-in `core:*` commands.
[[permission]]
identifier = "allow-browser-tiles"
description = "Allows the browser tile lifecycle commands (open/navigate/reload/bounds/close/hide/show)."
commands.allow = [
    "browser_tile_open",
    "browser_tile_navigate",
    "browser_tile_reload",
    "browser_tile_set_bounds",
    "browser_tile_hide",
    "browser_tile_show",
    "browser_tile_close",
]
```

- [ ] **Step 3: Grant the permission in the default capability**

Change `frontend/src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "enables the default permissions",
  "windows": [
    "main"
  ],
  "permissions": [
    "core:default"
  ]
}
```

to:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "enables the default permissions",
  "windows": [
    "main"
  ],
  "permissions": [
    "core:default",
    "allow-browser-tiles"
  ]
}
```

- [ ] **Step 4: Write `browser_tiles.rs`**

```rust
// Native child webviews backing the desktop-only, machine-proxied Browser
// tab. Each open "document" (a Browser tile's own internal tab, see the
// design spec's Decision 2) gets its own real Tauri Webview, overlaid at
// the React placeholder div's on-screen rect and routed through a chosen
// machine's SOCKS5/HTTP forward proxy via `proxy_url`. See
// docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

/// Live child webviews, keyed by `webview_label(tab_id, doc_id)`.
/// Mutex-guarded — commands can arrive concurrently (e.g. a resize firing
/// mid-navigation).
pub struct BrowserTiles(Mutex<HashMap<String, tauri::Webview>>);

impl BrowserTiles {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

fn webview_label(tab_id: &str, doc_id: &str) -> String {
    format!("browser-{tab_id}-{doc_id}")
}

/// Creates the native child webview for one Browser-tile document, proxied
/// through `proxy_url` (an `http://` or `socks5://` URL) and immediately
/// navigated to `initial_url`. Called once per document, the first time the
/// user actually navigates somewhere (the bookmarks/blank home page never
/// creates a webview at all).
#[tauri::command]
pub fn browser_tile_open(
    app: AppHandle,
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    proxy_url: String,
    initial_url: String,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let label = webview_label(&tab_id, &doc_id);

    let proxy: Url = proxy_url.parse().map_err(|e| format!("invalid proxy url: {e}"))?;
    let target: Url = initial_url.parse().map_err(|e| format!("invalid target url: {e}"))?;

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target)).proxy_url(proxy);

    // NOTE: `Window::add_child` is defined on `tauri::window::Window`;
    // `WebviewWindow` (returned by `get_webview_window`) derefs to it. If a
    // future Tauri version changes that relationship, this call site is the
    // one to fix — not independently re-verified against docs.rs during
    // planning, unlike every other API used in this file.
    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| format!("create browser tile webview: {e}"))?;

    state.0.lock().unwrap().insert(label, webview);
    Ok(())
}

#[tauri::command]
pub fn browser_tile_navigate(
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    url: String,
) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    let target: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    webview.navigate(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_tile_reload(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.reload().map_err(|e| e.to_string())
}

/// Keeps the native surface glued to the placeholder div's on-screen rect —
/// called from the frontend's `ResizeObserver` on every resize/drag/
/// fullscreen-toggle of the tile.
#[tauri::command]
pub fn browser_tile_set_bounds(
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())
}

/// Moves a backgrounded internal tab's webview to zero size instead of
/// destroying it, so switching between a fullscreen tile's internal tabs
/// doesn't force a full reload each time.
#[tauri::command]
pub fn browser_tile_hide(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let map = state.0.lock().unwrap();
    let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.set_size(LogicalSize::new(0.0, 0.0)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_tile_show(
    state: tauri::State<'_, BrowserTiles>,
    tab_id: String,
    doc_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    browser_tile_set_bounds(state, tab_id, doc_id, x, y, width, height)
}

#[tauri::command]
pub fn browser_tile_close(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id, &doc_id);
    let webview = state
        .0
        .lock()
        .unwrap()
        .remove(&label)
        .ok_or_else(|| format!("no browser tile webview for {label}"))?;
    webview.close().map_err(|e| e.to_string())
}
```

- [ ] **Step 5: Register the module, its commands, and the page-load event bridge in `lib.rs`**

Change:

```rust
mod hubapi;
mod sidecar;

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
```

to:

```rust
mod browser_tiles;
mod hubapi;
mod sidecar;

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use browser_tiles::BrowserTiles;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
```

Change:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
```

to:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BrowserTiles::new())
        .on_page_load(|webview, payload| {
            // Global hook (fires for every webview in the app, including
            // the main UI) filtered to just the Browser tab's own child
            // webviews, so the React address bar can react to in-page
            // navigation (the user clicking a link inside the native
            // webview) instead of only explicit typed-URL navigation.
            if !webview.label().starts_with("browser-") {
                return;
            }
            let _ = webview.emit(
                "browser-tile-page-load",
                serde_json::json!({ "label": webview.label(), "url": payload.url().to_string() }),
            );
        })
        .invoke_handler(tauri::generate_handler![
            browser_tiles::browser_tile_open,
            browser_tiles::browser_tile_navigate,
            browser_tiles::browser_tile_reload,
            browser_tiles::browser_tile_set_bounds,
            browser_tiles::browser_tile_hide,
            browser_tiles::browser_tile_show,
            browser_tiles::browser_tile_close,
        ])
        .setup(|app| {
```

- [ ] **Step 6: Build the Rust side**

Run: `cd frontend/src-tauri && cargo build`
Expected: builds successfully. If `Webview::close()` doesn't exist under that exact name (the one call in `browser_tiles.rs` not independently re-confirmed against docs.rs during planning — see its comment), the compiler error will name the correct method; adjust `browser_tile_close`'s last line to match and re-run.

- [ ] **Step 7: Commit**

```bash
git add frontend/src-tauri/Cargo.toml frontend/src-tauri/Cargo.lock frontend/src-tauri/permissions/browser-tiles.toml frontend/src-tauri/capabilities/default.json frontend/src-tauri/src/browser_tiles.rs frontend/src-tauri/src/lib.rs
git commit -m "feat(browser): add Tauri browser_tiles module (native child webviews)"
```

---

### Task 10: `@tauri-apps/api` dependency + `browserTilesBridge.ts`

**Files:**
- Modify: `frontend/package.json` (via `npm install`, not hand-edited)
- Create: `frontend/src/features/browser/browserTilesBridge.ts`

**Interfaces:**
- Consumes: Tauri commands/event from Task 9.
- Produces (used by Task 11): `browserTileLabel(tabId, docId)`, `openBrowserTile`, `navigateBrowserTile`, `reloadBrowserTile`, `setBrowserTileBounds`, `hideBrowserTile`, `showBrowserTile`, `closeBrowserTile`, `onBrowserTilePageLoad`.

- [ ] **Step 1: Install `@tauri-apps/api`**

Run: `cd frontend && npm install @tauri-apps/api@^2`
Expected: adds `@tauri-apps/api` to `frontend/package.json`'s `dependencies` (matching the existing `@tauri-apps/cli@^2.11.4` major version) and updates the lockfile.

- [ ] **Step 2: Write the bridge module**

```ts
// Thin wrapper around the Tauri commands in
// frontend/src-tauri/src/browser_tiles.rs. Desktop-only — every export here
// assumes useIsTauri() is already true; callers gate on that themselves,
// matching how the rest of the tabs feature reaches into Tauri-only APIs.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export interface BrowserTileBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Tracks which (tabId, docId) pair a given native webview label belongs
 *  to, so `onBrowserTilePageLoad` doesn't need to parse ids back out of a
 *  concatenated label string (unsafe in general, since both ids can contain
 *  hyphens themselves — e.g. generated UUIDs). */
const labelRegistry = new Map<string, { tabId: string; docId: string }>()

export function browserTileLabel(tabId: string, docId: string): string {
  return `browser-${tabId}-${docId}`
}

export function openBrowserTile(tabId: string, docId: string, proxyUrl: string, initialUrl: string): Promise<void> {
  labelRegistry.set(browserTileLabel(tabId, docId), { tabId, docId })
  return invoke('browser_tile_open', { tabId, docId, proxyUrl, initialUrl })
}

export function navigateBrowserTile(tabId: string, docId: string, url: string): Promise<void> {
  return invoke('browser_tile_navigate', { tabId, docId, url })
}

export function reloadBrowserTile(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_reload', { tabId, docId })
}

export function setBrowserTileBounds(tabId: string, docId: string, bounds: BrowserTileBounds): Promise<void> {
  return invoke('browser_tile_set_bounds', { tabId, docId, ...bounds })
}

export function hideBrowserTile(tabId: string, docId: string): Promise<void> {
  return invoke('browser_tile_hide', { tabId, docId })
}

export function showBrowserTile(tabId: string, docId: string, bounds: BrowserTileBounds): Promise<void> {
  return invoke('browser_tile_show', { tabId, docId, ...bounds })
}

export function closeBrowserTile(tabId: string, docId: string): Promise<void> {
  labelRegistry.delete(browserTileLabel(tabId, docId))
  return invoke('browser_tile_close', { tabId, docId })
}

/** Subscribes to page-load events for every browser-tile webview (Rust's
 *  global `on_page_load` hook, filtered there to `browser-*` labels). Looks
 *  the label back up in `labelRegistry` rather than parsing it, since a
 *  regex split would be ambiguous when either id contains a hyphen. */
export function onBrowserTilePageLoad(
  callback: (info: { tabId: string; docId: string; url: string }) => void,
): Promise<() => void> {
  return listen<{ label: string; url: string }>('browser-tile-page-load', (event) => {
    const ids = labelRegistry.get(event.payload.label)
    if (ids) callback({ ...ids, url: event.payload.url })
  })
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/features/browser/browserTilesBridge.ts
git commit -m "feat(browser): add @tauri-apps/api dependency and the browser tile Tauri bridge"
```

---

### Task 11: `BrowserTile.tsx` — the toolbar + body component

**Files:**
- Create: `frontend/src/features/browser/BrowserTile.tsx`

**Interfaces:**
- Consumes: `useLoomStore` slice/actions from Task 7; `startProxy`/`ProxyStartResponse` from Task 4; `browserTilesBridge.ts` from Task 10; `browserTileBookmarks.ts` from Task 6; `useMachines` (existing, `@/features/data/queries`); `Select` (existing, `@/components/ui/select`).
- Produces (used by Task 12): `export function BrowserTile({ tabId }: { tabId: string }): JSX.Element | null`.

- [ ] **Step 1: Write the component**

```tsx
import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Home, Maximize2, Minimize2, Plus, RefreshCw, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useMachines } from '@/features/data/queries'
import {
  addBrowserTileBookmark,
  groupBrowserTileBookmarks,
  loadBrowserTileBookmarks,
  removeBrowserTileBookmark,
} from '@/lib/browserTileBookmarks'
import type { BrowserTileBookmark } from '@/lib/browserTileBookmarks'
import { startProxy } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import { useLoomStore } from '@/store/useLoomStore'
import {
  closeBrowserTile as closeNativeBrowserTile,
  navigateBrowserTile,
  onBrowserTilePageLoad,
  openBrowserTile,
  reloadBrowserTile,
  setBrowserTileBounds,
} from './browserTilesBridge'

interface BrowserTileProps {
  tabId: string
}

function normalizeAddress(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(raw)) return `https://${raw}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`
}

export function BrowserTile({ tabId }: BrowserTileProps) {
  const tile = useLoomStore((s) => s.browserTiles[tabId])
  const ensureBrowserTile = useLoomStore((s) => s.ensureBrowserTile)
  const setBrowserDocState = useLoomStore((s) => s.setBrowserDocState)
  const addBrowserDoc = useLoomStore((s) => s.addBrowserDoc)
  const closeBrowserDoc = useLoomStore((s) => s.closeBrowserDoc)
  const selectBrowserDoc = useLoomStore((s) => s.selectBrowserDoc)
  const setBrowserTileFullscreen = useLoomStore((s) => s.setBrowserTileFullscreen)
  const machines = useMachines().data ?? []
  const [draft, setDraft] = useState('')
  const [bookmarks, setBookmarks] = useState<BrowserTileBookmark[]>(loadBrowserTileBookmarks)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ensureBrowserTile(tabId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  const doc = tile?.docs.find((d) => d.id === tile.activeDocId)

  useEffect(() => {
    setDraft(doc?.url ?? '')
  }, [doc?.id, doc?.url])

  // Keep the native child webview glued to the placeholder's on-screen rect.
  useEffect(() => {
    if (!doc?.url || !bodyRef.current) return
    const el = bodyRef.current
    const docId = doc.id
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      void setBrowserTileBounds(tabId, docId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [tabId, doc?.id, doc?.url])

  // Sync the address bar/title from real in-page navigation inside the native webview.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onBrowserTilePageLoad(({ tabId: t, docId: d, url }) => {
      if (t === tabId) setBrowserDocState(t, d, { url, loading: false })
    }).then((fn) => {
      unlisten = fn
    })
    return () => unlisten?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  if (!tile || !doc) return null

  async function ensureProxyForMachine(machineId: string) {
    const machine = machines.find((m) => m.id === machineId)
    if (!machine) return null
    const proxy = await startProxy(machine)
    setBrowserDocState(tabId, doc.id, { machineId, proxy })
    return proxy
  }

  /** Tauri's `proxy_url` is set at webview-construction time only (see the
   *  design spec's Rust component notes) — switching machines on a doc that
   *  already has a loaded page means destroying the existing native webview
   *  and recreating it against the new proxy, not just updating store state. */
  async function selectMachine(machineId: string) {
    const hadNativeWebview = !!doc.url
    if (hadNativeWebview) await closeNativeBrowserTile(tabId, doc.id)
    const proxy = await ensureProxyForMachine(machineId)
    if (hadNativeWebview && proxy && doc.url) {
      await openBrowserTile(tabId, doc.id, `socks5://x:${proxy.proxyKey}@${proxy.socks5Addr}`, doc.url)
    }
  }

  async function navigate(rawUrl: string) {
    const url = normalizeAddress(rawUrl)
    if (!url) return
    let proxy = doc.proxy
    if (!proxy && doc.machineId) proxy = await ensureProxyForMachine(doc.machineId)
    if (!proxy) return
    const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
    setBrowserDocState(tabId, doc.id, { url, loading: true, history, historyIndex: history.length - 1 })
    if (doc.url) {
      await navigateBrowserTile(tabId, doc.id, url)
    } else {
      await openBrowserTile(tabId, doc.id, `socks5://x:${proxy.proxyKey}@${proxy.socks5Addr}`, url)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void navigate(draft)
  }

  async function goHistory(delta: -1 | 1) {
    const nextIndex = doc.historyIndex + delta
    const url = doc.history[nextIndex]
    if (!url) return
    setBrowserDocState(tabId, doc.id, { url, historyIndex: nextIndex, loading: true })
    await navigateBrowserTile(tabId, doc.id, url)
  }

  async function goHome() {
    if (doc.url) await closeNativeBrowserTile(tabId, doc.id)
    setBrowserDocState(tabId, doc.id, { url: null, history: [], historyIndex: -1, title: 'New Tab' })
  }

  async function reload() {
    if (!doc.url) return
    setBrowserDocState(tabId, doc.id, { loading: true })
    await reloadBrowserTile(tabId, doc.id)
  }

  function openInRealBrowser() {
    if (doc.url) window.open(doc.url, '_blank', 'noopener,noreferrer')
  }

  function addBookmark() {
    if (!doc.url) return
    setBookmarks((current) => addBrowserTileBookmark(current, { title: doc.title, url: doc.url as string, group: 'Portal' }))
  }

  async function closeInternalTab(docId: string) {
    if (doc.id === docId && doc.url) await closeNativeBrowserTile(tabId, docId)
    closeBrowserDoc(tabId, docId)
  }

  const bookmarkGroups = groupBrowserTileBookmarks(bookmarks)
  const canGoBack = doc.historyIndex > 0
  const canGoForward = doc.historyIndex < doc.history.length - 1

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-loom-bg">
      {tile.fullscreen && (
        <div className="flex h-8 flex-none items-center gap-1 overflow-x-auto border-b border-loom-border bg-loom-surface px-2">
          {tile.docs.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => selectBrowserDoc(tabId, d.id)}
              className={cn(
                'group flex h-6 max-w-[160px] flex-none items-center gap-1.5 rounded-md px-2 font-mono text-[11px]',
                d.id === tile.activeDocId ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash',
              )}
            >
              <Globe size={11} />
              <span className="truncate">{d.title}</span>
              {tile.docs.length > 1 && (
                <X
                  size={10}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeInternalTab(d.id)
                  }}
                  className="opacity-0 group-hover:opacity-100"
                />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => addBrowserDoc(tabId)}
            aria-label="New tab"
            className="ml-1 flex h-6 w-6 flex-none items-center justify-center rounded-md text-loom-dim hover:bg-loom-hover-wash"
          >
            <Plus size={12} />
          </button>
        </div>
      )}

      <div className="flex flex-none items-center gap-1.5 border-b border-loom-border bg-loom-bg px-2 py-1.5">
        <Globe size={13} className="flex-none text-loom-dim" />
        <Button size="icon-sm" variant="secondary" onClick={() => void goHistory(-1)} disabled={!canGoBack} aria-label="Back">
          <ArrowLeft size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={() => void goHistory(1)} disabled={!canGoForward} aria-label="Forward">
          <ArrowRight size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={() => void goHome()} aria-label="Home">
          <Home size={12} />
        </Button>
        <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-1.5">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={doc.machineId ? 'Search or enter URL' : 'Choose a machine first'}
            disabled={!doc.machineId}
            className="h-7 flex-1 font-mono text-[11.5px]"
          />
        </form>
        <Button size="icon-sm" variant="secondary" onClick={() => void reload()} disabled={!doc.url} aria-label="Reload">
          <RefreshCw size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={addBookmark} disabled={!doc.url} aria-label="Bookmark this page">
          <Star size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={openInRealBrowser} disabled={!doc.url} aria-label="Open in real browser">
          <ExternalLink size={12} />
        </Button>
        <Select
          value={doc.machineId ?? ''}
          onValueChange={(machineId) => void selectMachine(machineId)}
          options={machines.map((m) => ({ value: m.id, label: m.name }))}
          triggerClassName="h-7 w-32"
          aria-label="Machine"
        />
        <Button
          size="icon-sm"
          variant="secondary"
          onClick={() => setBrowserTileFullscreen(tabId, !tile.fullscreen)}
          aria-label={tile.fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {tile.fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {!doc.url ? (
          <div className="flex h-full flex-col items-center gap-4 overflow-auto p-6">
            {bookmarkGroups.length === 0 ? (
              <div className="mt-16 text-[12px] text-loom-muted">No bookmarks yet — enter a URL above to start browsing.</div>
            ) : (
              bookmarkGroups.map(([group, items]) => (
                <div key={group} className="w-full max-w-[520px]">
                  <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-loom-dim">{group}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {items.map((bookmark) => (
                      <button
                        key={bookmark.id}
                        type="button"
                        onClick={() => void navigate(bookmark.url)}
                        className="flex items-center justify-between rounded-lg border border-loom-border-card bg-loom-surface-2 px-3 py-2.5 text-left hover:border-loom-border-accent"
                      >
                        <span className="truncate text-[12px] text-loom-fg-2">{bookmark.title}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setBookmarks((current) => removeBrowserTileBookmark(current, bookmark.id))
                          }}
                          aria-label={`Remove ${bookmark.title}`}
                          className="text-loom-muted-2 hover:text-loom-red-soft"
                        >
                          <X size={12} />
                        </button>
                      </button>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div ref={bodyRef} className="absolute inset-0" />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (Not mounted anywhere yet, so this only validates its own types against Tasks 4, 6, 7, 10's exports.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/features/browser/BrowserTile.tsx
git commit -m "feat(browser): add BrowserTile component"
```

---

### Task 12: Wire into `WorkspaceTileArea`/`SidebarNav`, verify end-to-end

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileArea.tsx`
- Modify: `frontend/src/features/sidebar/SidebarNav.tsx`

**Interfaces:**
- Consumes: `BrowserTile` (Task 11), `BrowserTileTab` (Task 8), `openBrowserTab` (Task 7), `useIsTauri` (existing, unchanged).
- Produces: nothing further downstream — this is the integration task.

- [ ] **Step 1: Add the `browser` renderer, `resolveBrowserTab`, and route both `agents`/`browser` tabs into tiled scope**

In `frontend/src/features/tabs/WorkspaceTileArea.tsx`, change the import block:

```tsx
import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { WorktreeCardsGrid } from '@/features/agents/WorktreeCardsGrid'
import { ExpandedTerminal } from '@/features/terminal/ExpandedTerminal'
import { useWorkspace } from '@/features/data/queries'
import { STATE } from '@/lib/constants'
import { useLoomStore } from '@/store/useLoomStore'
import { WorkspaceTileCanvas } from './WorkspaceTileCanvas'
import { createDefaultTileLayout, findTileLeaf, findTileTab, firstLeafId, focusTileLeaf, selectTileTab } from './tileTree'
import type { TileTab, WorkspaceTileLayout } from './tileTree'
import type { WorktreeTileTab } from './WorkspaceTileCanvas'
```

to:

```tsx
import { useEffect } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { BrowserTile } from '@/features/browser/BrowserTile'
import { closeBrowserTile as closeNativeBrowserTile } from '@/features/browser/browserTilesBridge'
import { WorktreeCardsGrid } from '@/features/agents/WorktreeCardsGrid'
import { ExpandedTerminal } from '@/features/terminal/ExpandedTerminal'
import { useWorkspace } from '@/features/data/queries'
import { STATE } from '@/lib/constants'
import { useLoomStore } from '@/store/useLoomStore'
import { WorkspaceTileCanvas } from './WorkspaceTileCanvas'
import { createDefaultTileLayout, findTileLeaf, findTileTab, firstLeafId, focusTileLeaf, selectTileTab } from './tileTree'
import type { TileTab, WorkspaceTileLayout } from './tileTree'
import type { BrowserTileTab, WorktreeTileTab } from './WorkspaceTileCanvas'
```

Change the store-hook destructure (currently):

```tsx
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const showToast = useLoomStore((s) => s.showToast)
```

to:

```tsx
  const closeWorktreeTab = useLoomStore((s) => s.closeWorktreeTab)
  const pruneWorktreeTabs = useLoomStore((s) => s.pruneWorktreeTabs)
  const removeBrowserTile = useLoomStore((s) => s.removeBrowserTile)
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const showToast = useLoomStore((s) => s.showToast)
```

Change `handleCloseTab` (currently):

```tsx
  function handleCloseTab(_leafId: string, tabId: string) {
    closeWorktreeTab(wsId, tabId)
    const next = useLoomStore.getState().workspaceTileLayouts[wsId]
    if (!next) return
    const leaf = findTileLeaf(next.root, next.focusedLeafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }
```

to:

```tsx
  // Closing a 'browser' tab must tear down every native child webview it
  // owns (all internal docs, not just the active one) before the tile
  // itself is dropped from the tree — otherwise the Rust side leaks an
  // orphaned webview per doc, and `browserTiles[tabId]` dangles forever in
  // the store. `closeWorktreeTab` itself is id-based, not worktree-specific
  // (see tileTree.ts's `closeTileTab`), so it's reused as-is for the
  // generic tree removal regardless of tab kind.
  async function handleCloseTab(_leafId: string, tabId: string) {
    const tab = findTileTab(layout.root, tabId)
    if (tab?.kind === 'browser') {
      const tile = useLoomStore.getState().browserTiles[tabId]
      if (tile) {
        await Promise.all(
          tile.docs.filter((d) => d.url).map((d) => closeNativeBrowserTile(tabId, d.id)),
        )
      }
      removeBrowserTile(tabId)
    }
    closeWorktreeTab(wsId, tabId)
    const next = useLoomStore.getState().workspaceTileLayouts[wsId]
    if (!next) return
    const leaf = findTileLeaf(next.root, next.focusedLeafId)
    const activeTab = leaf?.type === 'leaf' ? leaf.tabs.find((t) => t.id === leaf.activeTabId) : undefined
    if (activeTab) navigateToTab(activeTab)
  }
```

Change `navigateToTab` (currently):

```tsx
  function navigateToTab(tab: TileTab) {
    if (tab.kind === 'agents') {
      navigate({ to: '/w/$wsId', params: { wsId } })
    } else {
      navigate({
        to: '/w/$wsId/p/$projectId/wt/$wtId',
        params: { wsId, projectId: tab.projectId, wtId: tab.wtId },
      })
    }
  }
```

to:

```tsx
  function navigateToTab(tab: TileTab) {
    if (tab.kind === 'worktree') {
      navigate({
        to: '/w/$wsId/p/$projectId/wt/$wtId',
        params: { wsId, projectId: tab.projectId, wtId: tab.wtId },
      })
    } else {
      // 'agents' and 'browser' tabs both just need to land somewhere inside
      // the tiled scope; '/w/$wsId' redirects into the current project.
      navigate({ to: '/w/$wsId', params: { wsId } })
    }
  }
```

Change the `resolveWorktreeTab` function's neighborhood to add `resolveBrowserTab`:

```tsx
  function resolveWorktreeTab(tab: WorktreeTileTab) {
    const worktree = worktrees.find((w) => w.id === tab.wtId)
    if (!worktree) return undefined
    const st = STATE[worktree.state]
    return {
      label: worktree.root ? 'project root' : worktree.branch,
      color: st.color,
      pulse: worktree.state === 'running' || worktree.state === 'waiting',
    }
  }
```

to:

```tsx
  function resolveWorktreeTab(tab: WorktreeTileTab) {
    const worktree = worktrees.find((w) => w.id === tab.wtId)
    if (!worktree) return undefined
    const st = STATE[worktree.state]
    return {
      label: worktree.root ? 'project root' : worktree.branch,
      color: st.color,
      pulse: worktree.state === 'running' || worktree.state === 'waiting',
    }
  }

  function resolveBrowserTab(tab: BrowserTileTab) {
    const tile = useLoomStore.getState().browserTiles[tab.id]
    const doc = tile?.docs.find((d) => d.id === tile.activeDocId)
    return { label: doc?.title ?? 'Web' }
  }
```

Change the render's `renderers`/`resolveWorktreeTab` props:

```tsx
  return (
    <WorkspaceTileCanvas
      root={layout.root}
      renderers={{
        agents: () => {
          const project = workspace?.projects.find((p) => p.id === (currentProjectId ?? workspace.projects[0]?.id))
          if (!project) return null
          return <WorktreeCardsGrid project={project} wsId={wsId} />
        },
        worktree: ({ tab }) => {
          const worktree = worktrees.find((w) => w.id === tab.wtId)
          if (!worktree) return null
          return <ExpandedTerminal worktree={worktree} wsId={wsId} projectId={tab.projectId} />
        },
      }}
      onTreeChange={handleTreeChange}
      onFocusLeaf={handleFocusLeaf}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
      resolveWorktreeTab={resolveWorktreeTab}
      className="min-h-0"
    />
  )
```

to:

```tsx
  return (
    <WorkspaceTileCanvas
      root={layout.root}
      renderers={{
        agents: () => {
          const project = workspace?.projects.find((p) => p.id === (currentProjectId ?? workspace.projects[0]?.id))
          if (!project) return null
          return <WorktreeCardsGrid project={project} wsId={wsId} />
        },
        worktree: ({ tab }) => {
          const worktree = worktrees.find((w) => w.id === tab.wtId)
          if (!worktree) return null
          return <ExpandedTerminal worktree={worktree} wsId={wsId} projectId={tab.projectId} />
        },
        browser: ({ tab }) => <BrowserTile tabId={tab.id} />,
      }}
      onTreeChange={handleTreeChange}
      onFocusLeaf={handleFocusLeaf}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      onNewTab={handleNewTab}
      resolveWorktreeTab={resolveWorktreeTab}
      resolveBrowserTab={resolveBrowserTab}
      className="min-h-0"
    />
  )
```

- [ ] **Step 2: Restore the Browser sidebar nav item, routed to the new tile on desktop**

In `frontend/src/features/sidebar/SidebarNav.tsx`, change the import block:

```tsx
import { cloneElement, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Blocks, LayoutGrid, Receipt, Server, Wrench, type LucideIcon } from 'lucide-react'
import type { ModuleView } from '@/store/types'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import { Tooltip } from '@/components/ui/tooltip'
```

to:

```tsx
import { cloneElement, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Blocks, Globe, LayoutGrid, Receipt, Server, Wrench, type LucideIcon } from 'lucide-react'
import type { ModuleView } from '@/store/types'
import { cn } from '@/lib/utils'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import { useIsTauri } from '@/features/tabs/useIsTauri'
import { useLoomStore } from '@/store/useLoomStore'
import { Tooltip } from '@/components/ui/tooltip'
```

Change the component body's start:

```tsx
export function SidebarNav({ compact }: SidebarNavProps = {}) {
  const navigate = useNavigate()
  const { wsId, view } = useScope()
  const ws = useWorkspace(wsId).data
  const [hoveredKey, setHoveredKey] = useState<ModuleView | null>(null)
  const [armedKey, setArmedKey] = useState<ModuleView | null>(null)
```

to:

```tsx
export function SidebarNav({ compact }: SidebarNavProps = {}) {
  const navigate = useNavigate()
  const { wsId, view } = useScope()
  const ws = useWorkspace(wsId).data
  const isTauri = useIsTauri()
  const openBrowserTab = useLoomStore((s) => s.openBrowserTab)
  const [hoveredKey, setHoveredKey] = useState<ModuleView | null>(null)
  const [armedKey, setArmedKey] = useState<ModuleView | null>(null)
```

Change the `items` array and `goto` function:

```tsx
  const items: NavDef[] = [
    { key: 'agents', label: 'Agents', Icon: LayoutGrid, badge: running },
    { key: 'management', label: 'Agent management', Icon: Blocks, badge: 0 },
    { key: 'invoices', label: 'Invoices', Icon: Receipt, badge: openInvoices },
    // 'browser' nav item hidden for now — replaced by a backend SOCKS5/HTTP proxy; route still exists.
    { key: 'tools', label: 'Tools', Icon: Wrench, badge: 0 },
    { key: 'machines', label: 'Machines', Icon: Server, badge: 0 },
  ]

  function goto(key: ModuleView) {
    if (!wsId) return
    if (key === 'agents') navigate({ to: '/w/$wsId', params: { wsId } })
    else if (key === 'management') navigate({ to: '/w/$wsId/management', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }
```

to:

```tsx
  const items: NavDef[] = [
    { key: 'agents', label: 'Agents', Icon: LayoutGrid, badge: running },
    { key: 'management', label: 'Agent management', Icon: Blocks, badge: 0 },
    { key: 'invoices', label: 'Invoices', Icon: Receipt, badge: openInvoices },
    { key: 'browser', label: 'Browser', Icon: Globe, badge: 0 },
    { key: 'tools', label: 'Tools', Icon: Wrench, badge: 0 },
    { key: 'machines', label: 'Machines', Icon: Server, badge: 0 },
  ]

  function goto(key: ModuleView) {
    if (!wsId) return
    // Desktop: a Browser click opens a new machine-proxied Browser tile in
    // the workspace tab strip instead of the web's sandboxed-iframe route.
    if (key === 'browser' && isTauri) {
      openBrowserTab(wsId)
      navigate({ to: '/w/$wsId', params: { wsId } })
      return
    }
    if (key === 'agents') navigate({ to: '/w/$wsId', params: { wsId } })
    else if (key === 'management') navigate({ to: '/w/$wsId/management', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }
```

- [ ] **Step 3: Run typecheck and production build**

Run: `cd frontend && npm run typecheck && npm run build`
Expected: both PASS with no errors.

- [ ] **Step 4: Manual verification in the desktop app**

Run: `make dev-tauri` (from the repo root). Walk through, confirming each behavior from the design spec (`docs/superpowers/specs/2026-07-13-desktop-proxied-browser-tab-design.md`):

1. Click the sidebar's "Browser" icon: a new Browser tile opens in the workspace tab strip, showing the compact toolbar and either a bookmarks grid or a blank page (no bookmarks saved yet).
2. In the toolbar's machine selector, pick a machine. Type a runtime-local URL only reachable on that machine (e.g. a `npm run dev` server bound to that machine's own `127.0.0.1:5173`) into the address bar and press Enter: the page loads inside the tile — proof the traffic is actually routed through that machine's forward proxy, not the operator's own machine.
3. Drag the Browser tab to split it next to a worktree tab: both remain live and interactive at the same time, same as two worktree tabs.
4. Click the star icon on a loaded page, then the home icon: the bookmarks grid reappears and includes the just-starred page.
5. Fullscreen the tile: an internal tab strip appears above the toolbar; click "+" to open a second internal tab, confirm both pages are independently navigable and switching between them doesn't reload either.
6. Exit fullscreen: back to the single-page compact toolbar (the previously-active internal tab).
7. Close the Browser tab entirely: no lingering native webview (check via your OS's process/window inspector that no stray webview surface remains).
8. Confirm the sandboxed-iframe Browser module is unaffected: its route (if reachable) still renders the old iframe-based UI, unrelated to this feature.
9. Run `make dev` (the web app) in a browser: confirm the sidebar's "Browser" nav item still behaves exactly as it did before this feature (unaffected, since `isTauri` is always `false` there).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileArea.tsx frontend/src/features/sidebar/SidebarNav.tsx
git commit -m "feat(browser): wire the machine-proxied Browser tab into the workspace tile area and sidebar"
```

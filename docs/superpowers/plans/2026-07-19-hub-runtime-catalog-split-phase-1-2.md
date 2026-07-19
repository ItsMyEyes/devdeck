# Hub/Runtime Catalog Split — Phases 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `--role runtime` process serve its own web UI, authenticate an operator against it, and hold a read-only replica of its slice of the hub's catalog — so it stays usable while the hub is down.

**Architecture:** The hub stays the catalog source of truth. A runtime gains (a) the existing key→cookie session flow, currently gated off runtimes, (b) `RequireRuntimeAuth`, which accepts a session cookie *in addition to* the bearer key and `?key=` paths the hub UI already depends on, and (c) a new `RunSyncLoop` that pulls `{workspaces, projects, sshConnections}` scoped to itself every 30s and applies it in one SQLite transaction.

**Tech Stack:** Go 1.22+ (`net/http` enhanced ServeMux, `database/sql` + SQLite), React 19 + TanStack Router/Query, Vite 8.

**Spec:** `docs/superpowers/specs/2026-07-19-hub-runtime-catalog-split-design.md`

## Global Constraints

- Module path is `devdeck/backend`; internal packages under `devdeck/backend/internal/`.
- All API errors use the `{"error":"message"}` envelope. Never change this shape.
- Store errors map to HTTP via `handleStoreErr(w, err)`. Never return raw SQL errors.
- All persistence goes through the `port.Store` interface (`backend/internal/port/store.go`).
- Domain types in `backend/internal/domain/models.go` and `frontend/src/store/types.ts` must stay in sync.
- SQLite only; `?` placeholders, never `$1`.
- IDs are type-prefixed hex via `idGen("p-")` etc. (`crypto/rand`).
- Frontend imports use the `@/*` alias — never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Never hand-edit `frontend/src/routeTree.gen.ts` (generated).
- Run `go vet ./...` and `npm run typecheck` before every commit.
- **Do not modify `frontend/src/lib/machineClient.ts`.** It is the hub→runtime path and must keep working unchanged.

## File Structure

**Phase 1 — runtime UI + auth**

| File | Responsibility |
|---|---|
| `backend/internal/handler/auth.go` (modify) | `setAuthCookie` gains a `sameSite` parameter |
| `backend/internal/handler/runtimeauth.go` (create) | `RequireRuntimeAuth` — cookie ∪ bearer key ∪ `?key=` |
| `backend/internal/handler/runtimeauth_test.go` (create) | Middleware table test incl. regression guards |
| `backend/internal/handler/health.go` (modify) | `WhoamiHandler` reports role + machine identity |
| `backend/cmd/server/main.go` (modify) | Mount UI + key-session on runtimes; swap middleware |
| `frontend/src/features/auth/RuntimeSignIn.tsx` (create) | Runtime sign-in page (paste key) |
| `frontend/src/features/data/queries.ts` (modify) | `useWhoami` exposes role |

**Phase 2 — catalog replica**

| File | Responsibility |
|---|---|
| `backend/internal/domain/models.go` (modify) | `CatalogSnapshot` type |
| `backend/internal/port/store.go` (modify) | `MachineByKey`, `ProjectsByMachine`, `SSHConnectionsByExecutor`, `ApplyCatalogSnapshot`, `LastSyncedAt` |
| `backend/internal/store/db.go` (modify) | `sync_state` table + `projects.origin` migration |
| `backend/internal/store/machine.go` (modify) | `MachineByKey` |
| `backend/internal/store/catalog.go` (create) | Snapshot read (hub side) + apply (runtime side) |
| `backend/internal/store/catalog_test.go` (create) | Transaction, scoping, and `origin` preservation tests |
| `backend/internal/handler/machinekey.go` (create) | `RequireMachineKey` + context accessor |
| `backend/internal/handler/catalog.go` (create) | `GET /api/runtime/catalog` |
| `backend/internal/handler/catalog_test.go` (create) | Cross-machine isolation test |
| `backend/internal/machineclient/catalog.go` (create) | `FetchCatalog` |
| `backend/internal/service/sync.go` (create) | `RunSyncLoop` |
| `frontend/src/features/sidebar/NeverSyncedNotice.tsx` (create) | "Never synced" empty state |

---

## Phase 1 — Runtime UI + key→cookie auth

### Task 1: Make cookie SameSite configurable

The hub's cookie must stay `Strict`. The runtime's must be `Lax`, or the hub→runtime handover in phase 4 silently shows a sign-in page to an already-authenticated operator (spec: "The runtime session cookie must be SameSite=Lax, not Strict").

**Files:**
- Modify: `backend/internal/handler/auth.go:48-58`
- Test: `backend/internal/handler/auth_test.go`

**Interfaces:**
- Produces: `setAuthCookie(w http.ResponseWriter, name, value string, maxAge time.Duration, sameSite http.SameSite)` — package-private, used by Task 3.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/handler/auth_test.go`:

```go
func TestSetAuthCookieHonoursSameSite(t *testing.T) {
	tests := []struct {
		name     string
		sameSite http.SameSite
		want     string
	}{
		{"strict for hub", http.SameSiteStrictMode, "SameSite=Strict"},
		{"lax for runtime", http.SameSiteLaxMode, "SameSite=Lax"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			setAuthCookie(rec, "devdeck_session", "tok", time.Hour, tt.sameSite)
			got := rec.Header().Get("Set-Cookie")
			if !strings.Contains(got, tt.want) {
				t.Errorf("Set-Cookie = %q, want it to contain %q", got, tt.want)
			}
		})
	}
}
```

Ensure the file imports `net/http`, `net/http/httptest`, `strings`, `testing`, and `time`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run TestSetAuthCookieHonoursSameSite
```

Expected: FAIL — `too many arguments in call to setAuthCookie`.

- [ ] **Step 3: Add the parameter**

Replace `backend/internal/handler/auth.go:48-58` with:

```go
func setAuthCookie(w http.ResponseWriter, name, value string, maxAge time.Duration, sameSite http.SameSite) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   secureCookies,
		SameSite: sameSite,
		MaxAge:   int(maxAge.Seconds()),
	})
}
```

- [ ] **Step 4: Update all existing call sites to preserve hub behaviour**

Every current caller passes `http.SameSiteStrictMode` — this task must not change hub behaviour. Find them:

```bash
cd backend && grep -rn "setAuthCookie(" internal/handler/
```

Expected call sites: `auth.go:99`, `auth.go:103`, `auth.go:146`, `auth.go:150`, `auth.go:256`, plus any in the TOTP verify handlers. Append `, http.SameSiteStrictMode` to each, e.g.:

```go
setAuthCookie(w, sessionCookieName, sessionToken, 30*24*time.Hour, http.SameSiteStrictMode)
```

```go
setAuthCookie(w, pendingCookieName, pendingToken, 2*time.Minute, http.SameSiteStrictMode)
```

- [ ] **Step 5: Run the full handler suite**

```bash
cd backend && go test ./internal/handler/ && go vet ./...
```

Expected: PASS, no vet output. Existing auth tests must still pass — they assert hub behaviour, which is unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/auth.go backend/internal/handler/auth_test.go
git commit -m "refactor(auth): make setAuthCookie SameSite configurable"
```

---

### Task 2: RequireRuntimeAuth middleware

**Files:**
- Create: `backend/internal/handler/runtimeauth.go`
- Create: `backend/internal/handler/runtimeauth_test.go`

**Interfaces:**
- Consumes: `keyFromRequest`, `keyMatches`, `writeErr` (`keyauth.go`); `service.AuthService.CurrentUser` (`service/auth.go:413`); `sessionCookieName` (`auth.go:12`).
- Produces: `RequireRuntimeAuth(svc *service.AuthService, key string) func(http.Handler) http.Handler` — used by Task 3.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/handler/runtimeauth_test.go`:

```go
package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// okHandler records that the middleware let the request through.
func okHandler(hit *bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*hit = true
		w.WriteHeader(http.StatusOK)
	})
}

func TestRequireRuntimeAuthAcceptsBearerKey(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees", nil)
	req.Header.Set("Authorization", "Bearer rt-key")
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if !hit || rec.Code != http.StatusOK {
		t.Errorf("bearer key rejected: code=%d hit=%v", rec.Code, hit)
	}
}

func TestRequireRuntimeAuthAcceptsWebSocketQueryKey(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/ws/terminal?key=rt-key", nil)
	req.Header.Set("Upgrade", "websocket")
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if !hit || rec.Code != http.StatusOK {
		t.Errorf("websocket ?key= rejected: code=%d hit=%v", rec.Code, hit)
	}
}

func TestRequireRuntimeAuthAllowsHealthAndStaticAssets(t *testing.T) {
	for _, path := range []string{"/api/health", "/", "/assets/index.js"} {
		var hit bool
		mw := RequireRuntimeAuth(nil, "rt-key")
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		mw(okHandler(&hit)).ServeHTTP(rec, req)
		if !hit {
			t.Errorf("path %q was blocked, want public", path)
		}
	}
}

func TestRequireRuntimeAuthRejectsMissingCredential(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees", nil)
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if hit || rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated request allowed: code=%d hit=%v", rec.Code, hit)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
}

func TestRequireRuntimeAuthRejectsWrongKey(t *testing.T) {
	var hit bool
	mw := RequireRuntimeAuth(nil, "rt-key")
	req := httptest.NewRequest(http.MethodGet, "/api/worktrees", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	mw(okHandler(&hit)).ServeHTTP(rec, req)
	if hit || rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong key allowed: code=%d hit=%v", rec.Code, hit)
	}
}
```

Note: `svc` is `nil` in these tests because none of them reach the cookie branch. Cookie acceptance is covered end-to-end in Task 3's manual verification and by the `verify` skill later; unit-testing it here would require constructing a full `AuthService` with a store, which `auth_test.go` already does for the hub.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/handler/ -run TestRequireRuntimeAuth
```

Expected: FAIL — `undefined: RequireRuntimeAuth`.

- [ ] **Step 3: Implement the middleware**

Create `backend/internal/handler/runtimeauth.go`:

```go
package handler

import (
	"net/http"
	"strings"

	"devdeck/backend/internal/service"
)

// RequireRuntimeAuth returns middleware for the runtime role. It is additive
// over RequireKey: the bearer-key and ?key= paths that frontend/src/lib/
// machineClient.ts already depends on keep working unchanged, and a session
// cookie is accepted as well so the runtime can serve its own web UI.
//
// svc may be nil when the runtime has no UI session support wired; the cookie
// branch is then simply never taken.
func RequireRuntimeAuth(svc *service.AuthService, key string) func(http.Handler) http.Handler {
	publicPaths := map[string]bool{
		"/api/health":          true,
		"/api/auth/key-session": true,
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if publicPaths[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}
			// Static SPA assets stay public, mirroring RequireAuth's rule
			// (middleware.go:105-108) so the UI shell can load and then
			// authenticate itself.
			if !strings.HasPrefix(r.URL.Path, "/api") && !strings.HasPrefix(r.URL.Path, "/ws/") {
				next.ServeHTTP(w, r)
				return
			}
			if keyMatches(keyFromRequest(r), key) {
				next.ServeHTTP(w, r)
				return
			}
			if svc != nil {
				if cookie, err := r.Cookie(sessionCookieName); err == nil {
					if _, err := svc.CurrentUser(cookie.Value); err == nil {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
			writeErr(w, http.StatusUnauthorized, "unauthorized")
		})
	}
}
```

`/api/auth/key-session` is public because it re-verifies the bearer key itself (`auth.go:247-251`) — it is how a client *becomes* authenticated, exactly as the hub treats `/api/auth/login`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/handler/ -run TestRequireRuntimeAuth -v && go vet ./...
```

Expected: all five PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/runtimeauth.go backend/internal/handler/runtimeauth_test.go
git commit -m "feat(runtime): add RequireRuntimeAuth accepting cookie or key"
```

---

### Task 3: Serve the UI and key-session on runtimes

**Files:**
- Modify: `backend/cmd/server/main.go:273-286` (auth routes), `:448-450` (UI), `:452-457` (middleware)
- Modify: `backend/internal/handler/auth.go:244-258` (`PostKeySession` cookie SameSite)

**Interfaces:**
- Consumes: `RequireRuntimeAuth` (Task 2), `setAuthCookie(..., sameSite)` (Task 1).
- Produces: a runtime that serves `webui.Handler()` at `/` and `POST /api/auth/key-session`.

- [ ] **Step 1: Give PostKeySession a runtime-aware SameSite**

`PostKeySession` serves both roles. Add a field so the runtime instance issues `Lax` while the hub keeps `Strict`.

In `backend/internal/handler/auth.go`, add to the `AuthHandler` struct (after `desktopKey string`, around line 23):

```go
	sessionSameSite http.SameSite
```

Add a setter next to `SetDesktopKey`:

```go
// SetSessionSameSite overrides the SameSite attribute on issued session
// cookies. The hub keeps the default Strict; runtimes use Lax so a top-level
// navigation from the hub still carries an existing runtime session.
func (h *AuthHandler) SetSessionSameSite(mode http.SameSite) { h.sessionSameSite = mode }

func (h *AuthHandler) sameSite() http.SameSite {
	if h.sessionSameSite == 0 {
		return http.SameSiteStrictMode
	}
	return h.sessionSameSite
}
```

Then change line 256 in `PostKeySession` from the Strict literal added in Task 1 to:

```go
	setAuthCookie(w, sessionCookieName, sessionToken, 12*time.Hour, h.sameSite())
```

The 12-hour TTL is the spec's deliberate choice for runtime sessions, versus the hub's 30 days.

- [ ] **Step 2: Mount key-session and the UI on runtimes**

In `backend/cmd/server/main.go`, replace the block at lines 273-286 with:

```go
	if !isRuntime {
		mux.HandleFunc("GET /api/auth/config", authH.GetConfig)
		mux.HandleFunc("POST /api/auth/register", authH.PostRegister)
		mux.HandleFunc("POST /api/auth/login", authH.PostLogin)
		mux.HandleFunc("POST /api/auth/totp/setup", authH.PostTotpSetup)
		mux.HandleFunc("POST /api/auth/totp/verify-setup", authH.PostTotpVerifySetup)
		mux.HandleFunc("POST /api/auth/totp/verify", authH.PostTotpVerify)
		mux.HandleFunc("POST /api/auth/logout", authH.PostLogout)
		mux.HandleFunc("GET /api/auth/me", authH.GetMe)
		if *apiKey != "" {
			authH.SetDesktopKey(*apiKey)
			mux.HandleFunc("POST /api/auth/key-session", authH.PostKeySession)
		}
	} else {
		// Runtimes have no password/TOTP flow: possession of --key is the
		// entire authorization, exchanged here for a session cookie so the
		// runtime's own web UI works in a browser.
		authH.SetDesktopKey(*apiKey)
		authH.SetSessionSameSite(http.SameSiteLaxMode)
		mux.HandleFunc("POST /api/auth/key-session", authH.PostKeySession)
		mux.HandleFunc("POST /api/auth/logout", authH.PostLogout)
		mux.HandleFunc("GET /api/auth/me", authH.GetMe)
	}
```

Add `"net/http"` to the imports if it is not already there (it is — the file already uses `http.Serve`).

- [ ] **Step 3: Serve the UI on both roles and swap the middleware**

Replace lines 448-450:

```go
	mux.Handle("/", webui.Handler())
```

(Delete the `if !isRuntime` wrapper — both roles now serve the SPA.)

Replace lines 452-457:

```go
	var authMW func(http.Handler) http.Handler
	if isRuntime {
		authMW = handler.RequireRuntimeAuth(authSvc, *apiKey)
	} else {
		authMW = handler.RequireAuth(authSvc, *apiKey)
	}
```

- [ ] **Step 4: Verify the runtime boots and both auth paths work**

```bash
cd backend && go build ./... && go vet ./...
```

Then run a runtime and exercise all three paths:

```bash
cd backend && go run ./cmd/server --role runtime --key testkey --addr 127.0.0.1:9911 --db /tmp/rt-test.db &
sleep 2
# 1. health is public
curl -s -o /dev/null -w "health=%{http_code}\n" http://127.0.0.1:9911/api/health
# 2. no credential is rejected
curl -s -o /dev/null -w "nokey=%{http_code}\n" http://127.0.0.1:9911/api/worktrees
# 3. bearer key still works (machineClient.ts regression guard)
curl -s -o /dev/null -w "bearer=%{http_code}\n" -H "Authorization: Bearer testkey" http://127.0.0.1:9911/api/workspaces
# 4. key-session mints a Lax cookie
curl -s -i -X POST -H "Authorization: Bearer testkey" http://127.0.0.1:9911/api/auth/key-session | grep -i set-cookie
```

Expected: `health=200`, `nokey=401`, `bearer=200`, and a `Set-Cookie:` line containing both `devdeck_session=` and `SameSite=Lax`.

Stop the server: `kill %1`

- [ ] **Step 5: Commit**

```bash
git add backend/cmd/server/main.go backend/internal/handler/auth.go
git commit -m "feat(runtime): serve web UI and key-session on --role runtime"
```

---

### Task 4: Report role from /api/whoami and add the runtime sign-in page

**Files:**
- Modify: `backend/internal/handler/health.go:16-29`
- Modify: `backend/cmd/server/main.go:220` (handler construction)
- Test: `backend/internal/handler/health_test.go` (create if absent)
- Create: `frontend/src/features/auth/RuntimeSignIn.tsx`
- Modify: `frontend/src/features/data/queries.ts`
- Modify: `frontend/src/store/types.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GET /api/whoami` → `{"status":"ok","role":"hub"|"runtime","machineName":"..."}`; TS type `Whoami`; hook `useWhoami()`.

- [ ] **Step 1: Write the failing Go test**

Create `backend/internal/handler/health_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWhoamiReportsRoleAndKeepsStatus(t *testing.T) {
	h := NewWhoamiHandler("runtime", "builder")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	// status must survive: machineclient.Probe checks only for a 200, but
	// older clients read this field.
	if got["status"] != "ok" {
		t.Errorf("status = %q, want ok", got["status"])
	}
	if got["role"] != "runtime" {
		t.Errorf("role = %q, want runtime", got["role"])
	}
	if got["machineName"] != "builder" {
		t.Errorf("machineName = %q, want builder", got["machineName"])
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run TestWhoami
```

Expected: FAIL — `too many arguments in call to NewWhoamiHandler`.

- [ ] **Step 3: Implement**

Replace `backend/internal/handler/health.go:22-29` with:

```go
type WhoamiHandler struct {
	role        string
	machineName string
}

// NewWhoamiHandler creates a whoami handler. role is "hub" or "runtime";
// machineName is this process's display name when it is a runtime.
func NewWhoamiHandler(role, machineName string) *WhoamiHandler {
	return &WhoamiHandler{role: role, machineName: machineName}
}

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":      "ok",
		"role":        h.role,
		"machineName": h.machineName,
	})
}
```

In `backend/cmd/server/main.go`, change line 220 from `whoamiH := handler.NewWhoamiHandler()` to:

```go
	whoamiH := handler.NewWhoamiHandler(*role, *machineName)
```

- [ ] **Step 4: Run tests**

```bash
cd backend && go test ./internal/... && go vet ./...
```

Expected: PASS. `machineclient` tests that probe `/api/whoami` must still pass — they assert status 200 only.

- [ ] **Step 5: Add the frontend type and hook**

In `frontend/src/store/types.ts`, add:

```ts
export interface Whoami {
  status: string
  role: 'hub' | 'runtime'
  machineName: string
}
```

In `frontend/src/features/data/queries.ts`, add (matching the file's existing query style):

```ts
import type { Whoami } from '@/store/types'

export function useWhoami() {
  return useQuery({
    queryKey: ['whoami'],
    queryFn: () => request<Whoami>('GET', '/whoami'),
    staleTime: Infinity,
    retry: false,
  })
}
```

Check the file's existing imports first — `useQuery` and `request` are already imported there; do not duplicate them.

- [ ] **Step 6: Create the runtime sign-in page**

Create `frontend/src/features/auth/RuntimeSignIn.tsx`:

```tsx
import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { request } from '@/lib/api'

/**
 * Sign-in for a runtime's own web UI. A runtime has no password/TOTP flow —
 * possession of its static --key is the entire authorization, exchanged here
 * for a session cookie. This is the path that still works when the hub is
 * down.
 *
 * The spec's second option — a "Sign in via hub" button granting SSO with
 * inherited 2FA — needs the Ed25519 handover token that Phase 4 delivers, so
 * it is deliberately absent here rather than shipped as a dead control.
 */
export function RuntimeSignIn({ machineName }: { machineName: string }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!key.trim()) return
    setBusy(true)
    try {
      await request('POST', '/auth/key-session', undefined, {
        headers: { Authorization: `Bearer ${key.trim()}` },
      })
      window.location.reload()
    } catch {
      toast.error('That key was not accepted')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-lg font-medium text-[var(--fg)]">{machineName || 'Runtime'}</h1>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">
            Paste this runtime&rsquo;s key to sign in.
          </p>
        </div>
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Runtime key"
          autoFocus
          className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-subtle)] px-3 py-2 text-sm text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={busy || !key.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Sign in
        </button>
      </form>
    </div>
  )
}
```

Before writing this, open `frontend/src/globals.css` and confirm the CSS custom property names (`--bg`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--accent-fg`, `--bg-subtle`). Use the actual token names defined there — the design is dark-only and token-driven, and inventing names will render an invisible form.

Also confirm `request`'s signature in `frontend/src/lib/api.ts` accepts a fourth `RequestOpts` argument with `headers` (it does — `machineClient.ts:85` calls it that way).

- [ ] **Step 7: Typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/internal/handler/health.go backend/internal/handler/health_test.go \
        backend/cmd/server/main.go frontend/src/store/types.ts \
        frontend/src/features/data/queries.ts frontend/src/features/auth/RuntimeSignIn.tsx
git commit -m "feat(runtime): report role from whoami and add runtime sign-in page"
```

---

## Phase 2 — Catalog replica

### Task 5: MachineByKey lookup

**Files:**
- Modify: `backend/internal/port/store.go`
- Modify: `backend/internal/store/machine.go`
- Test: `backend/internal/store/machine_test.go`

**Interfaces:**
- Produces: `MachineByKey(key string) (domain.Machine, error)` on `port.Store` — used by Task 6.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/store/machine_test.go`:

```go
func TestMachineByKeyResolvesAndRejectsEmpty(t *testing.T) {
	s := newTestStore(t)
	want, _ := s.CreateMachine("builder", "https://a.ts.net", "rt-key-a", false)
	s.CreateMachine("other", "https://b.ts.net", "rt-key-b", false)

	got, err := s.MachineByKey("rt-key-a")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != want.ID {
		t.Errorf("MachineByKey returned %q, want %q", got.ID, want.ID)
	}

	if _, err := s.MachineByKey("nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown key error = %v, want ErrNotFound", err)
	}
	// An empty key must never match a machine whose key column is blank.
	if _, err := s.MachineByKey(""); !errors.Is(err, ErrNotFound) {
		t.Errorf("empty key error = %v, want ErrNotFound", err)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/store/ -run TestMachineByKey
```

Expected: FAIL — `s.MachineByKey undefined`.

- [ ] **Step 3: Implement**

Add to `backend/internal/store/machine.go` after `MachineByID`:

```go
// MachineByKey resolves a machine from its static API key. An empty key never
// matches, so a machine row with a blank key cannot be impersonated by a
// caller that presents no credential.
func (s *Store) MachineByKey(key string) (domain.Machine, error) {
	if key == "" {
		return domain.Machine{}, ErrNotFound
	}
	m, err := scanMachine(s.db.QueryRow(`SELECT id, name, url, key, is_local FROM machines WHERE key = ?`, key))
	if err != nil {
		return domain.Machine{}, mapNotFound(err)
	}
	return m, nil
}
```

Add to the `Store` interface in `backend/internal/port/store.go`, next to `MachineByID(id string) (domain.Machine, error)` (line 84):

```go
	MachineByKey(key string) (domain.Machine, error)
```

- [ ] **Step 4: Run tests**

```bash
cd backend && go test ./internal/... && go vet ./...
```

Expected: PASS. If any test fake implements `port.Store`, it now needs a `MachineByKey` method — add one returning `domain.Machine{}, store.ErrNotFound`. Find them with:

```bash
cd backend && grep -rln "MachineByID(id string)" --include=*_test.go .
```

- [ ] **Step 5: Commit**

```bash
git add backend/internal/port/store.go backend/internal/store/machine.go backend/internal/store/machine_test.go
git commit -m "feat(store): add MachineByKey lookup"
```

---

### Task 6: Hub catalog endpoint, scoped by machine key

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `backend/internal/port/store.go`
- Create: `backend/internal/store/catalog.go`
- Create: `backend/internal/handler/machinekey.go`
- Create: `backend/internal/handler/catalog.go`
- Create: `backend/internal/handler/catalog_test.go`
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `MachineByKey` (Task 5).
- Produces: `domain.CatalogSnapshot`; `RequireMachineKey(st port.Store)`; `MachineFromContext(ctx)`; `GET /api/runtime/catalog`; store methods `ProjectsByMachine`, `SSHConnectionsByExecutor`, `CatalogForMachine`.

- [ ] **Step 1: Add the domain type**

In `backend/internal/domain/models.go`, add near `Workspace` (line 176):

```go
// CatalogSnapshot is one runtime's slice of the hub's catalog: every
// workspace (they are the grouping), but only the projects and SSH
// connections bound to that machine. Rows for other machines are never
// included — not merely hidden.
type CatalogSnapshot struct {
	Workspaces     []Workspace     `json:"workspaces"`
	Projects       []Project       `json:"projects"`
	SSHConnections []SSHConnection `json:"sshConnections"`
}
```

Mirror it in `frontend/src/store/types.ts`:

```ts
export interface CatalogSnapshot {
  workspaces: Workspace[]
  projects: Project[]
  sshConnections: SSHConnection[]
}
```

- [ ] **Step 2: Write the failing isolation test**

Create `backend/internal/handler/catalog_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/store"
)

func TestCatalogIsScopedToThePresentedMachineKey(t *testing.T) {
	st := newCatalogTestStore(t) // helper defined below

	// Machine A asks with its own key and must see only its own project.
	req := httptest.NewRequest(http.MethodGet, "/api/runtime/catalog", nil)
	req.Header.Set("Authorization", "Bearer key-a")
	rec := httptest.NewRecorder()
	catalogRouter(st).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var snap domain.CatalogSnapshot
	if err := json.NewDecoder(rec.Body).Decode(&snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.Projects) != 1 || snap.Projects[0].Name != "a-project" {
		t.Fatalf("projects = %+v, want only a-project", snap.Projects)
	}

	// An unknown key is rejected outright.
	req2 := httptest.NewRequest(http.MethodGet, "/api/runtime/catalog", nil)
	req2.Header.Set("Authorization", "Bearer not-a-machine")
	rec2 := httptest.NewRecorder()
	catalogRouter(st).ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusUnauthorized {
		t.Errorf("unknown key status = %d, want 401", rec2.Code)
	}
}
```

Add the two helpers at the bottom of the same file:

```go
func catalogRouter(st *store.Store) http.Handler {
	mux := http.NewServeMux()
	h := NewCatalogHandler(st)
	mux.HandleFunc("GET /api/runtime/catalog", h.GetCatalog)
	return RequireMachineKey(st)(mux)
}

func newCatalogTestStore(t *testing.T) *store.Store {
	t.Helper()
	st := store.NewTestStore(t) // see step 3 note
	ma, _ := st.CreateMachine("a", "https://a.ts.net", "key-a", false)
	mb, _ := st.CreateMachine("b", "https://b.ts.net", "key-b", false)
	ws, _ := st.CreateWorkspace("clients")
	st.CreateProject(ws.ID, "a-project", "/srv/a", "", ma.ID)
	st.CreateProject(ws.ID, "b-project", "/srv/b", "", mb.ID)
	return st
}
```

**Note:** `newTestStore` in `backend/internal/store/*_test.go` is package-private. Before writing this, check whether an exported test helper exists:

```bash
cd backend && grep -rn "func newTestStore\|func NewTestStore" internal/store/
```

If only the private one exists, add an exported wrapper in a new file `backend/internal/store/testing.go`:

```go
package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// NewTestStore opens a throwaway store backed by a temp-dir SQLite file, for
// use by tests in other packages.
func NewTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(db)
}

var _ = sql.ErrNoRows // keep the database/sql import honest if unused
```

Confirm the real signature of the DB opener first (`grep -n "^func Open" internal/store/db.go`) and match it; drop the `sql` import and the `var _` line if unneeded.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && go test ./internal/handler/ -run TestCatalogIsScoped
```

Expected: FAIL — `undefined: NewCatalogHandler`, `undefined: RequireMachineKey`.

- [ ] **Step 4: Implement the store reads**

Create `backend/internal/store/catalog.go`:

```go
package store

import "devdeck/backend/internal/domain"

// ProjectsByMachine returns every project bound to one machine, flat.
func (s *Store) ProjectsByMachine(machineID string) ([]domain.Project, error) {
	rows, err := s.db.Query(
		`SELECT id, workspace_id, name, repo, path, expanded, machine_id
		 FROM projects WHERE machine_id = ? ORDER BY rowid`, machineID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Project{}
	for rows.Next() {
		var p domain.Project
		var expanded int
		if err := rows.Scan(&p.ID, &p.WorkspaceID, &p.Name, &p.Repo, &p.Path, &expanded, &p.MachineID); err != nil {
			return nil, err
		}
		p.Expanded = expanded != 0
		out = append(out, p)
	}
	return out, rows.Err()
}

// SSHConnectionsByExecutor returns the connections this machine is
// responsible for dialing. Secrets are never included — they are
// runtime-owned and never travel from the hub.
func (s *Store) SSHConnectionsByExecutor(machineID string) ([]domain.SSHConnection, error) {
	rows, err := s.db.Query(
		`SELECT id, name, group_name, host, port, username, auth_type,
		        jump_connection_id, executor_machine_id, host_key_fingerprint
		 FROM ssh_connections WHERE executor_machine_id = ? ORDER BY rowid`, machineID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.SSHConnection{}
	for rows.Next() {
		c, err := scanSSHConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// CatalogForMachine assembles one machine's slice of the catalog. Workspaces
// are returned without their nested project trees: the Projects list is the
// authoritative, machine-scoped set, and leaving both populated would ship
// other machines' projects inside the workspace tree.
func (s *Store) CatalogForMachine(machineID string) (domain.CatalogSnapshot, error) {
	workspaces, err := s.Workspaces()
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	for i := range workspaces {
		workspaces[i].Projects = nil
	}
	projects, err := s.ProjectsByMachine(machineID)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	conns, err := s.SSHConnectionsByExecutor(machineID)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	return domain.CatalogSnapshot{Workspaces: workspaces, Projects: projects, SSHConnections: conns}, nil
}
```

Check the real column list and `scanSSHConnection` helper name first:

```bash
cd backend && grep -n "func scanSSHConnection\|SELECT" internal/store/ssh.go | head
cd backend && grep -n "func scanProject\|SELECT" internal/store/project.go | head
```

Reuse the existing scan helpers rather than duplicating column lists if they exist.

Add to `port.Store` in `backend/internal/port/store.go`:

```go
	ProjectsByMachine(machineID string) ([]domain.Project, error)
	SSHConnectionsByExecutor(machineID string) ([]domain.SSHConnection, error)
	CatalogForMachine(machineID string) (domain.CatalogSnapshot, error)
```

- [ ] **Step 5: Implement the middleware**

Create `backend/internal/handler/machinekey.go`:

```go
package handler

import (
	"context"
	"net/http"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/port"
)

type machineCtxKey struct{}

// RequireMachineKey resolves the calling runtime from the API key it presents
// and stores it on the request context. Because the machine is derived from
// the credential rather than a path parameter, a runtime cannot express a
// request for another machine's data at all.
func RequireMachineKey(st port.Store) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			m, err := st.MachineByKey(keyFromRequest(r))
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), machineCtxKey{}, m)))
		})
	}
}

// MachineFromContext returns the machine resolved by RequireMachineKey.
func MachineFromContext(ctx context.Context) (domain.Machine, bool) {
	m, ok := ctx.Value(machineCtxKey{}).(domain.Machine)
	return m, ok
}
```

Create `backend/internal/handler/catalog.go`:

```go
package handler

import (
	"net/http"

	"devdeck/backend/internal/port"
)

// CatalogHandler serves a runtime's slice of the hub catalog.
type CatalogHandler struct{ store port.Store }

// NewCatalogHandler creates a catalog handler.
func NewCatalogHandler(s port.Store) *CatalogHandler { return &CatalogHandler{store: s} }

// GetCatalog handles GET /api/runtime/catalog. The machine is taken from the
// request context (RequireMachineKey), never from a parameter.
func (h *CatalogHandler) GetCatalog(w http.ResponseWriter, r *http.Request) {
	m, ok := MachineFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	snap, err := h.store.CatalogForMachine(m.ID)
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, snap)
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd backend && go test ./internal/handler/ -run TestCatalogIsScoped -v
```

Expected: PASS — machine A sees exactly one project, unknown key gets 401.

- [ ] **Step 7: Mount it on the hub**

In `backend/cmd/server/main.go`, inside the existing `if !isRuntime {` block at line 404 (alongside the machines routes), add:

```go
		catalogH := handler.NewCatalogHandler(st)
		catalogMux := http.NewServeMux()
		catalogMux.HandleFunc("GET /api/runtime/catalog", catalogH.GetCatalog)
		mux.Handle("GET /api/runtime/catalog", handler.RequireMachineKey(st)(catalogMux))
```

The nested mux is deliberate: `RequireMachineKey` must wrap only this route, not the whole hub, because every other hub route authenticates by session cookie or hub key instead.

- [ ] **Step 8: Verify and commit**

```bash
cd backend && go test ./internal/... && go vet ./...
cd ../frontend && npm run typecheck
```

```bash
git add backend/internal/domain/models.go backend/internal/port/store.go \
        backend/internal/store/catalog.go backend/internal/store/testing.go \
        backend/internal/handler/machinekey.go backend/internal/handler/catalog.go \
        backend/internal/handler/catalog_test.go backend/cmd/server/main.go \
        frontend/src/store/types.ts
git commit -m "feat(hub): serve machine-scoped catalog at /api/runtime/catalog"
```

---

### Task 7: Replica schema and transactional snapshot apply

**Files:**
- Modify: `backend/internal/store/db.go`
- Modify: `backend/internal/store/catalog.go`
- Modify: `backend/internal/port/store.go`
- Create: `backend/internal/store/catalog_test.go`

**Interfaces:**
- Consumes: `domain.CatalogSnapshot` (Task 6).
- Produces: `ApplyCatalogSnapshot(snap domain.CatalogSnapshot, syncedAt time.Time) error`, `LastSyncedAt() (*time.Time, error)` — used by Task 8.

- [ ] **Step 1: Add the schema**

In `backend/internal/store/db.go`, append to the `schema` const (after the `settings` table, around line 198):

```sql
CREATE TABLE IF NOT EXISTS sync_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_synced_at TEXT
);
```

Add a migration alongside `migrateInvoiceColumns` (which starts at line 293):

```go
// migrateProjectOrigin adds the origin column to pre-existing databases.
// 'hub' means the row came from a catalog snapshot and is replaceable;
// 'local' means it was created on this runtime while the hub was
// unreachable and must survive snapshot overwrites until it is replayed.
func migrateProjectOrigin(db *sql.DB) error {
	if _, err := db.Exec("ALTER TABLE projects ADD COLUMN origin TEXT NOT NULL DEFAULT 'hub'"); err != nil {
		if !strings.Contains(err.Error(), "duplicate column name") {
			return err
		}
	}
	return nil
}
```

Add `origin TEXT NOT NULL DEFAULT 'hub'` to the `projects` CREATE TABLE at line 18-27, and call `migrateProjectOrigin(db)` wherever `migrateInvoiceColumns(db)` is called in `Open` — find it with:

```bash
cd backend && grep -n "migrateInvoiceColumns(db)" internal/store/db.go
```

- [ ] **Step 2: Write the failing tests**

Create `backend/internal/store/catalog_test.go`:

```go
package store

import (
	"testing"
	"time"

	"devdeck/backend/internal/domain"
)

func TestApplyCatalogSnapshotPreservesLocalProjectsAndWorktrees(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")
	hubProj, _ := s.CreateProject(ws.ID, "from-hub", "/srv/hub", "", "m-1")
	localProj, _ := s.CreateProject(ws.ID, "made-offline", "/srv/local", "", "m-1")
	if err := s.MarkProjectLocal(localProj.ID); err != nil {
		t.Fatal(err)
	}
	wt, err := s.CreateWorktree(hubProj.ID, "feature", "main", "/srv/hub/wt")
	if err != nil {
		t.Fatal(err)
	}

	// A snapshot that contains neither project: the hub row must vanish, the
	// local row must survive, and the worktree must be untouched.
	snap := domain.CatalogSnapshot{
		Workspaces: []domain.Workspace{{ID: ws.ID, Name: "clients"}},
	}
	if err := s.ApplyCatalogSnapshot(snap, time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatal(err)
	}

	projects, err := s.ProjectsByMachine("m-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].ID != localProj.ID {
		t.Fatalf("projects = %+v, want only the local one (%s)", projects, localProj.ID)
	}
	if _, err := s.WorktreeByID(wt.ID); err != nil {
		t.Errorf("worktree was destroyed by a snapshot: %v", err)
	}
}

func TestApplyCatalogSnapshotRollsBackOnFailure(t *testing.T) {
	s := newTestStore(t)
	ws, _ := s.CreateWorkspace("clients")

	// A project whose workspace_id does not exist violates the FK, failing
	// mid-apply after workspaces have already been written.
	bad := domain.CatalogSnapshot{
		Workspaces: []domain.Workspace{{ID: "ws-new", Name: "renamed"}},
		Projects:   []domain.Project{{ID: "p-x", WorkspaceID: "ws-missing", Name: "orphan"}},
	}
	if err := s.ApplyCatalogSnapshot(bad, time.Unix(1_700_000_000, 0)); err == nil {
		t.Fatal("ApplyCatalogSnapshot succeeded on an FK violation, want error")
	}

	// The original workspace must still be there, unrenamed.
	got, err := s.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != ws.ID || got[0].Name != "clients" {
		t.Errorf("workspaces = %+v, want the pre-apply state intact", got)
	}
	if at, _ := s.LastSyncedAt(); at != nil {
		t.Errorf("LastSyncedAt = %v, want nil after a failed apply", at)
	}
}

func TestLastSyncedAtIsNilBeforeFirstSync(t *testing.T) {
	s := newTestStore(t)
	at, err := s.LastSyncedAt()
	if err != nil {
		t.Fatal(err)
	}
	if at != nil {
		t.Errorf("LastSyncedAt = %v, want nil", at)
	}
}
```

Confirm the real signatures of `CreateWorktree` and `WorktreeByID` before writing:

```bash
cd backend && grep -n "func (s \*Store) CreateWorktree\|func (s \*Store) WorktreeByID" internal/store/worktree.go
```

Adjust the calls to match.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd backend && go test ./internal/store/ -run "TestApplyCatalogSnapshot|TestLastSyncedAt"
```

Expected: FAIL — `s.MarkProjectLocal undefined`, `s.ApplyCatalogSnapshot undefined`, `s.LastSyncedAt undefined`.

- [ ] **Step 4: Implement**

Append to `backend/internal/store/catalog.go`:

```go
// MarkProjectLocal flags a project as created on this runtime and not yet
// accepted by the hub, so snapshots leave it alone.
func (s *Store) MarkProjectLocal(id string) error {
	_, err := s.db.Exec(`UPDATE projects SET origin = 'local' WHERE id = ?`, id)
	return err
}

// ApplyCatalogSnapshot replaces this runtime's replica with snap, in a single
// transaction. Two invariants hold absolutely:
//
//   - Projects with origin='local' are never deleted. They exist only here
//     until the hub accepts them.
//   - Worktrees are never touched. A catalog row disappearing is cheap and
//     reversible; deleting an unpushed worktree is permanent loss. The two
//     must never be triggered by the same remote event, so orphaned
//     worktrees simply outlive their project row.
func (s *Store) ApplyCatalogSnapshot(snap domain.CatalogSnapshot, syncedAt time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM projects WHERE origin = 'hub'`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM ssh_connections`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM workspaces`); err != nil {
		return err
	}

	for _, ws := range snap.Workspaces {
		if _, err := tx.Exec(`INSERT INTO workspaces (id, name) VALUES (?, ?)`, ws.ID, ws.Name); err != nil {
			return err
		}
	}
	for _, p := range snap.Projects {
		if _, err := tx.Exec(
			`INSERT INTO projects (id, workspace_id, name, repo, path, expanded, machine_id, origin)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'hub')`,
			p.ID, p.WorkspaceID, p.Name, p.Repo, p.Path, boolInt(p.Expanded), p.MachineID); err != nil {
			return err
		}
	}
	for _, c := range snap.SSHConnections {
		if _, err := tx.Exec(
			`INSERT INTO ssh_connections
			 (id, name, group_name, host, port, username, auth_type, jump_connection_id, executor_machine_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			c.ID, c.Name, c.Group, c.Host, c.Port, c.Username, c.AuthType,
			c.JumpConnectionID, c.ExecutorMachineID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(
		`INSERT INTO sync_state (id, last_synced_at) VALUES (1, ?)
		 ON CONFLICT(id) DO UPDATE SET last_synced_at = excluded.last_synced_at`,
		syncedAt.UTC().Format(time.RFC3339)); err != nil {
		return err
	}
	return tx.Commit()
}

// LastSyncedAt reports when a snapshot last applied cleanly. A nil result
// means never — which the UI must render distinctly from "no projects",
// since a wrong hub key otherwise looks exactly like an empty account.
func (s *Store) LastSyncedAt() (*time.Time, error) {
	var raw *string
	if err := s.db.QueryRow(`SELECT last_synced_at FROM sync_state WHERE id = 1`).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	at, err := time.Parse(time.RFC3339, *raw)
	if err != nil {
		return nil, err
	}
	return &at, nil
}
```

Add `"database/sql"`, `"errors"`, and `"time"` to the file's imports.

**Note on `host_key_fingerprint`:** it is deliberately *not* written by the snapshot. Per the spec it is runtime-owned (TOFU is a statement by the observer), and the hub never sends it. Deleting and re-inserting `ssh_connections` therefore drops any locally-pinned fingerprint — that is a known gap closed in Phase 5, when the fingerprint moves to its own runtime-owned table. Leave a `// TODO(phase-5)` comment on the `DELETE FROM ssh_connections` line noting this.

Add to `port.Store`:

```go
	MarkProjectLocal(id string) error
	ApplyCatalogSnapshot(snap domain.CatalogSnapshot, syncedAt time.Time) error
	LastSyncedAt() (*time.Time, error)
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && go test ./internal/store/ -run "TestApplyCatalogSnapshot|TestLastSyncedAt" -v && go test ./internal/... && go vet ./...
```

Expected: all three PASS, whole suite green.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/store/db.go backend/internal/store/catalog.go \
        backend/internal/store/catalog_test.go backend/internal/port/store.go
git commit -m "feat(store): apply catalog snapshots transactionally, preserving local rows"
```

---

### Task 8: FetchCatalog and the periodic sync loop

**Files:**
- Create: `backend/internal/machineclient/catalog.go`
- Create: `backend/internal/machineclient/catalog_test.go`
- Create: `backend/internal/service/sync.go`
- Modify: `backend/cmd/server/main.go:503-513`

**Interfaces:**
- Consumes: `ApplyCatalogSnapshot`, `LastSyncedAt` (Task 7); `GET /api/runtime/catalog` (Task 6).
- Produces: `machineclient.FetchCatalog(ctx, hubURL, machineKey string) (domain.CatalogSnapshot, error)`; `service.RunSyncLoop(ctx, cfg service.SyncConfig, every time.Duration)`.

- [ ] **Step 1: Write the failing client test**

Create `backend/internal/machineclient/catalog_test.go`:

```go
package machineclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchCatalogSendsMachineKeyAndDecodes(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"workspaces":[{"id":"ws-1","name":"clients"}],"projects":[{"id":"p-1","name":"api"}],"sshConnections":[]}`))
	}))
	defer srv.Close()

	snap, err := FetchCatalog(context.Background(), srv.URL, "rt-key-a")
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer rt-key-a" {
		t.Errorf("Authorization = %q, want the machine's own key", gotAuth)
	}
	if gotPath != "/api/runtime/catalog" {
		t.Errorf("path = %q, want /api/runtime/catalog", gotPath)
	}
	if len(snap.Workspaces) != 1 || len(snap.Projects) != 1 {
		t.Errorf("snapshot = %+v, want 1 workspace and 1 project", snap)
	}
}

func TestFetchCatalogErrorsOnNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	if _, err := FetchCatalog(context.Background(), srv.URL, "bad"); err == nil {
		t.Fatal("FetchCatalog succeeded on 401, want error")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/machineclient/ -run TestFetchCatalog
```

Expected: FAIL — `undefined: FetchCatalog`.

- [ ] **Step 3: Implement the client**

Create `backend/internal/machineclient/catalog.go`:

```go
package machineclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"devdeck/backend/internal/domain"
)

// FetchCatalog pulls this runtime's slice of the hub catalog. It authenticates
// with the runtime's *own* key rather than the hub key: the hub resolves which
// machine is asking from the credential itself, so there is no way to express
// a request for another machine's catalog.
func FetchCatalog(ctx context.Context, hubURL, machineKey string) (domain.CatalogSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	url := strings.TrimRight(hubURL, "/") + "/api/runtime/catalog"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	req.Header.Set("Authorization", "Bearer "+machineKey)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return domain.CatalogSnapshot{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return domain.CatalogSnapshot{}, fmt.Errorf("hub returned status %d for GET %s", resp.StatusCode, url)
	}

	var snap domain.CatalogSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		return domain.CatalogSnapshot{}, fmt.Errorf("decode catalog: %w", err)
	}
	return snap, nil
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd backend && go test ./internal/machineclient/ -run TestFetchCatalog -v
```

Expected: both PASS.

- [ ] **Step 5: Implement the sync loop**

Create `backend/internal/service/sync.go`:

```go
package service

import (
	"context"
	"log"
	"time"

	"devdeck/backend/internal/machineclient"
	"devdeck/backend/internal/port"
)

// SyncConfig describes what a runtime needs to keep its catalog replica fresh.
type SyncConfig struct {
	HubURL     string // hub base URL
	MachineKey string // this runtime's own key; the hub resolves us from it
}

// RunSyncLoop refreshes the catalog replica forever, every `every`.
//
// Unlike machineclient.RunSelfRegisterLoop — which retries until it succeeds
// once and then returns — this loop never exits: the replica has to keep
// tracking the hub for the process's whole life. Start it only after
// registration has succeeded, since the hub cannot resolve a machine by a key
// it has never stored.
//
// Failures are logged and retried on the next tick, never fatal. A stale
// replica is always better than an empty one, so a failed pull deliberately
// leaves the previous snapshot in place.
func RunSyncLoop(ctx context.Context, st port.Store, cfg SyncConfig, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		syncOnce(ctx, st, cfg)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func syncOnce(ctx context.Context, st port.Store, cfg SyncConfig) {
	snap, err := machineclient.FetchCatalog(ctx, cfg.HubURL, cfg.MachineKey)
	if err != nil {
		log.Printf("catalog sync: fetch: %v", err)
		return
	}
	if err := st.ApplyCatalogSnapshot(snap, time.Now()); err != nil {
		log.Printf("catalog sync: apply: %v", err)
		return
	}
	log.Printf("catalog sync: %d workspace(s), %d project(s), %d ssh connection(s)",
		len(snap.Workspaces), len(snap.Projects), len(snap.SSHConnections))
}
```

- [ ] **Step 6: Wire it into main**

In `backend/cmd/server/main.go`, replace lines 503-513 with:

```go
	if (isRuntime || isBoth) && *hubURL != "" {
		go func() {
			machineclient.RunSelfRegisterLoop(context.Background(), machineclient.SelfRegisterConfig{
				HubURL:    *hubURL,
				HubKey:    *hubKey,
				PublicURL: *publicURL,
				Name:      *machineName,
				Key:       *apiKey,
				IsLocal:   isBoth,
			}, 30*time.Second)

			// CRITICAL: only a pure runtime syncs. A --role both process is
			// its own hub, so `st` here IS the hub store — running the sync
			// loop against it would make ApplyCatalogSnapshot delete every
			// workspace and every project belonging to *other* machines,
			// then repopulate from a snapshot scoped to itself. That is
			// silent, permanent destruction of the hub's catalog. A both
			// process already has the truth locally and has nothing to pull.
			if !isRuntime {
				return
			}
			// Registration has now succeeded at least once, so the hub can
			// resolve this machine from its key. Only then can the catalog
			// pull authenticate.
			service.RunSyncLoop(context.Background(), st, service.SyncConfig{
				HubURL:     *hubURL,
				MachineKey: *apiKey,
			}, 30*time.Second)
		}()
		log.Printf("self-register: will register with hub %s as %q (%s)", *hubURL, *machineName, *publicURL)
	}
```

- [ ] **Step 7: Verify end-to-end against a real hub**

```bash
cd backend && go build ./... && go vet ./... && go test ./internal/...
```

Then run a hub and a runtime and watch the replica fill:

```bash
cd backend
go run ./cmd/server --role hub --key hubkey --2fa=false --addr 127.0.0.1:9900 --db /tmp/hub-test.db &
sleep 3
# Create a workspace and a project on the hub.
curl -s -X POST -H "Authorization: Bearer hubkey" -H "Content-Type: application/json" \
  -d '{"name":"clients"}' http://127.0.0.1:9900/api/workspaces
```

Note the returned workspace id, then start a runtime pointed at the hub:

```bash
go run ./cmd/server --role runtime --key rtkey --addr 127.0.0.1:9911 \
  --db /tmp/rt-test.db --hub-url http://127.0.0.1:9900 --hub-key hubkey \
  --public-url http://127.0.0.1:9911 --machine-name builder &
sleep 5
curl -s -H "Authorization: Bearer rtkey" http://127.0.0.1:9911/api/workspaces
```

Expected: the runtime's log shows `catalog sync: 1 workspace(s), 0 project(s), 0 ssh connection(s)`, and the `/api/workspaces` response contains the `clients` workspace pulled from the hub.

Clean up: `kill %1 %2 && rm -f /tmp/hub-test.db* /tmp/rt-test.db*`

- [ ] **Step 7b: Verify `--role both` does NOT sync**

This guards the data-loss path called out in the code comment above.

```bash
cd backend
go run ./cmd/server --role both --key bothkey --2fa=false --addr 127.0.0.1:9922 \
  --db /tmp/both-test.db --hub-url http://127.0.0.1:9922 --hub-key bothkey \
  --public-url http://127.0.0.1:9922 --machine-name solo 2>&1 | tee /tmp/both.log &
sleep 8
grep -c "catalog sync:" /tmp/both.log
```

Expected: `0`. A `--role both` process must self-register but never log a
catalog sync. If this prints anything above 0, the `if !isRuntime { return }`
guard is missing or misplaced — stop and fix it before continuing, because
this configuration destroys the hub catalog.

Clean up: `kill %1 && rm -f /tmp/both-test.db* /tmp/both.log`

- [ ] **Step 8: Commit**

```bash
git add backend/internal/machineclient/catalog.go backend/internal/machineclient/catalog_test.go \
        backend/internal/service/sync.go backend/cmd/server/main.go
git commit -m "feat(runtime): pull catalog replica from hub every 30s"
```

---

### Task 9: Runtime serves workspaces from the replica

`WorkspaceService.List` fans out to machines to fetch worktrees (`backend/internal/service/workspace.go:30-62`). On a runtime that is wrong twice over: there are no machines to fan out to, and its own worktrees are already local.

**Files:**
- Modify: `backend/internal/service/workspace.go`
- Modify: `backend/cmd/server/main.go:211`
- Test: `backend/internal/service/workspace_test.go` (create if absent)

**Interfaces:**
- Consumes: `ProjectsByMachine` (Task 6), `LastSyncedAt` (Task 7).
- Produces: `NewWorkspaceServiceForRuntime(s port.Store) *WorkspaceService`.

- [ ] **Step 1: Write the failing test**

Create or append to `backend/internal/service/workspace_test.go`:

```go
package service

import (
	"testing"

	"devdeck/backend/internal/store"
)

func TestRuntimeWorkspaceListNestsLocalProjectsWithoutFanout(t *testing.T) {
	st := store.NewTestStore(t)
	ws, _ := st.CreateWorkspace("clients")
	// machineID is set, which on a hub would trigger a machineclient fetch.
	st.CreateProject(ws.ID, "api", "/srv/api", "", "m-1")

	svc := NewWorkspaceServiceForRuntime(st)
	got, err := svc.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].Projects) != 1 || got[0].Projects[0].Name != "api" {
		t.Fatalf("List() = %+v, want one workspace holding one project", got)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && go test ./internal/service/ -run TestRuntimeWorkspaceList
```

Expected: FAIL — `undefined: NewWorkspaceServiceForRuntime`.

- [ ] **Step 3: Implement**

In `backend/internal/service/workspace.go`, add a `runtime bool` field to `WorkspaceService`, a constructor, and an early return in `List`:

```go
// WorkspaceService wraps workspace operations with business logic.
type WorkspaceService struct {
	store   port.Store
	runtime bool
}

// NewWorkspaceService creates a workspace service for the hub role.
func NewWorkspaceService(s port.Store) *WorkspaceService {
	return &WorkspaceService{store: s}
}

// NewWorkspaceServiceForRuntime creates a workspace service for the runtime
// role, which serves its local replica directly. A runtime has no machine
// registry to fan out to, and its worktrees are already local — the hub's
// per-project fetch would be a network call to nowhere.
func NewWorkspaceServiceForRuntime(s port.Store) *WorkspaceService {
	return &WorkspaceService{store: s, runtime: true}
}
```

Then at the top of `List`, immediately after the `svc.store.Workspaces()` call and its error check (line 31-34), insert:

```go
	if svc.runtime {
		return workspaces, nil
	}
```

- [ ] **Step 4: Run tests**

```bash
cd backend && go test ./internal/... && go vet ./...
```

Expected: PASS, including the existing hub-side workspace tests, which construct the service with `NewWorkspaceService` and are unaffected.

- [ ] **Step 5: Wire it in main**

In `backend/cmd/server/main.go`, replace line 211:

```go
	var wsSvc *service.WorkspaceService
	if isRuntime {
		wsSvc = service.NewWorkspaceServiceForRuntime(st)
	} else {
		wsSvc = service.NewWorkspaceService(st)
	}
```

- [ ] **Step 6: Verify and commit**

```bash
cd backend && go build ./... && go test ./internal/... && go vet ./...
```

```bash
git add backend/internal/service/workspace.go backend/internal/service/workspace_test.go backend/cmd/server/main.go
git commit -m "feat(runtime): serve workspaces from the local replica"
```

---

### Task 10: Distinguish "never synced" from "no projects" in the UI

**Files:**
- Modify: `backend/internal/handler/health.go`
- Modify: `backend/cmd/server/main.go`
- Create: `frontend/src/features/sidebar/NeverSyncedNotice.tsx`
- Modify: `frontend/src/store/types.ts`

**Interfaces:**
- Consumes: `LastSyncedAt` (Task 7), `Whoami` (Task 4).
- Produces: `GET /api/whoami` gains `lastSyncedAt: string | null`.

- [ ] **Step 1: Extend whoami with sync state**

Replace the `WhoamiHandler` from Task 4 in `backend/internal/handler/health.go` with:

```go
type WhoamiHandler struct {
	role        string
	machineName string
	store       port.Store // nil on the hub; only runtimes report sync state
}

// NewWhoamiHandler creates a whoami handler. Pass a non-nil store on runtimes
// so the response can report catalog freshness.
func NewWhoamiHandler(role, machineName string, s port.Store) *WhoamiHandler {
	return &WhoamiHandler{role: role, machineName: machineName, store: s}
}

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"status":       "ok",
		"role":         h.role,
		"machineName":  h.machineName,
		"lastSyncedAt": nil,
	}
	if h.store != nil {
		if at, err := h.store.LastSyncedAt(); err == nil && at != nil {
			body["lastSyncedAt"] = at.UTC().Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, body)
}
```

Add `"time"` and the `port` import. Update the Task 4 test to pass `nil` as the third argument, and add:

```go
func TestWhoamiReportsNullLastSyncedBeforeFirstSync(t *testing.T) {
	h := NewWhoamiHandler("runtime", "builder", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))

	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["lastSyncedAt"] != nil {
		t.Errorf("lastSyncedAt = %v, want null", got["lastSyncedAt"])
	}
}
```

In `main.go`, update the construction:

```go
	var whoamiStore port.Store
	if isRuntime {
		whoamiStore = st
	}
	whoamiH := handler.NewWhoamiHandler(*role, *machineName, whoamiStore)
```

Add the `port` import to `main.go` if absent (it is present — `main.go:201` declares `var baseReg port.AgentRegistry`).

- [ ] **Step 2: Run tests**

```bash
cd backend && go test ./internal/handler/ -run TestWhoami -v && go vet ./...
```

Expected: both PASS.

- [ ] **Step 3: Update the frontend type**

In `frontend/src/store/types.ts`, replace the `Whoami` interface from Task 4 with:

```ts
export interface Whoami {
  status: string
  role: 'hub' | 'runtime'
  machineName: string
  /** RFC3339 timestamp of the last clean catalog snapshot, or null if never. */
  lastSyncedAt: string | null
}
```

- [ ] **Step 4: Create the notice component**

Create `frontend/src/features/sidebar/NeverSyncedNotice.tsx`:

```tsx
import { CloudOff } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

/**
 * A runtime whose replica has never been filled looks identical to one with
 * no projects. That ambiguity hides the most common misconfiguration — a
 * wrong --hub-key — so the two states are rendered distinctly and the failure
 * is named rather than shown as a normal empty list.
 */
export function NeverSyncedNotice({ lastSyncedAt }: { lastSyncedAt: string | null }) {
  if (lastSyncedAt === null) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <CloudOff className="h-5 w-5 text-[var(--fg-muted)]" />
        <p className="text-sm font-medium text-[var(--fg)]">Never synced with the hub</p>
        <p className="text-xs text-[var(--fg-muted)]">
          This runtime has not received a catalog yet. Check <code>--hub-url</code> and{' '}
          <code>--hub-key</code>, then look at this runtime&rsquo;s log.
        </p>
      </div>
    )
  }
  return (
    <p className="px-4 py-2 text-xs text-[var(--fg-muted)]">
      Catalog synced {formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })}
    </p>
  )
}
```

Confirm the CSS token names against `frontend/src/globals.css` as in Task 4.

- [ ] **Step 5: Typecheck and commit**

```bash
cd frontend && npm run typecheck
```

```bash
git add backend/internal/handler/health.go backend/internal/handler/health_test.go \
        backend/cmd/server/main.go frontend/src/store/types.ts \
        frontend/src/features/sidebar/NeverSyncedNotice.tsx
git commit -m "feat(runtime): distinguish never-synced from empty in the UI"
```

---

## Definition of done for Phases 1–2

- [ ] `go test ./...` passes in `backend/`
- [ ] `go vet ./...` is silent
- [ ] `npm run typecheck` passes in `frontend/`
- [ ] `npm run build` succeeds
- [ ] A `--role runtime` process serves the SPA at `/` and accepts a pasted key at its sign-in page
- [ ] `Authorization: Bearer <key>` and `?key=` still work against a runtime (the `machineClient.ts` regression guard)
- [ ] A runtime pointed at a hub logs `catalog sync: N workspace(s), …` within 30s and serves those workspaces from `GET /api/workspaces`
- [ ] Runtime A's key returns 401 against a catalog request when the hub knows it as machine B's key
- [ ] Killing the hub leaves the runtime UI serving its last snapshot rather than an empty list
- [ ] A `--role both` process logs self-registration but **never** logs a catalog sync (guards against wiping its own hub catalog)

## Out of scope (later phases)

Phase 3 (offline project create + replay, `POST /api/runtime/projects`), Phase 4 (Ed25519 handover token, `POST /api/machines/{id}/token`), Phase 5 (SSH secrets and `host_key_fingerprint` moving to the runtime), Phase 6 (route cleanup, UI role gating). Each gets its own plan.

**Known gap carried into Phase 5:** `ApplyCatalogSnapshot` deletes and re-inserts `ssh_connections`, discarding any locally pinned `host_key_fingerprint`. The fingerprint moves to a runtime-owned table in Phase 5, which closes this. Until then, SSH still executes on the hub, so nothing depends on the runtime-side value.

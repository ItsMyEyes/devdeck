# Hub Paste-Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator connect a reachable runtime machine to the hub by pasting a `name|url|key` connection string into the Add Runtime dialog, with the hub verifying (before registering) that the machine is actually reachable and the key actually correct.

**Architecture:** A new authenticated probe route (`GET /api/whoami`) exists on every backend instance, gated by the normal key/session middleware (unlike `/api/health`, which is deliberately open). A new `machineclient.Probe` function hits that route with the submitted key; `PostMachine` calls it before creating a registry row, so a bad URL or wrong key is rejected immediately with a clear error instead of silently registering a broken machine. On the frontend, the existing (already implemented, currently unused) `useCreateMachine` hook gets wired to a new "paste connection string" mode in the Add Runtime dialog, alongside the existing self-register-command mode.

**Tech Stack:** Go 1.22+ (`net/http`, stdlib `testing` + `httptest`), React 19 + TypeScript (no test runner configured — frontend tests are standalone `check()`/`main()` scripts run via `npx tsx`).

## Global Constraints

- All API responses use the `{"error":"message"}` envelope — use `writeErr(w, status, msg)`, never a different shape.
- Use `handleStoreErr(w, err)` to map store errors; this plan's new check happens *before* the store call, so it uses `writeErr` directly, not `handleStoreErr`.
- Frontend imports use the `@/*` alias; never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Run `go vet ./...` (from `backend/`) before committing any Go change.
- Run `npm run typecheck` (from `frontend/`) before committing any frontend change.
- `backend/cmd/server/main.go` is a convergence file (per `CLAUDE.md`) — this plan touches it once (Task 2); do not parallelize edits to it.
- Domain types (`backend/internal/domain/models.go` / `frontend/src/store/types.ts`) are unchanged by this plan — no new fields on `Machine`.

---

### Task 1: `machineclient.Probe` — authenticated reachability check

**Files:**
- Modify: `backend/internal/machineclient/client.go`
- Test: `backend/internal/machineclient/client_test.go`

**Interfaces:**
- Consumes: nothing new (uses stdlib `net/http` only).
- Produces: `func Probe(ctx context.Context, rawURL, key string) error` in package `loom/backend/internal/machineclient`. Returns `nil` on a 200 from `<rawURL>/api/whoami` with the given key as `Authorization: Bearer <key>`; a non-nil error otherwise, with the string containing `"unreachable"` for network/timeout failures and `"rejected the key"` for a 401. Task 3 consumes this exact signature and these exact substrings (it doesn't re-check status codes itself, it surfaces `err.Error()` to the client).

- [ ] **Step 1: Write the failing tests**

Add `"strings"` to the existing import block and append these three tests to the end of `backend/internal/machineclient/client_test.go`:

```go
func TestProbeSucceedsWithCorrectKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/whoami" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	if err := Probe(context.Background(), srv.URL, "k"); err != nil {
		t.Errorf("Probe() error = %v, want nil", err)
	}
}

func TestProbeFailsOnUnreachable(t *testing.T) {
	err := Probe(context.Background(), "http://127.0.0.1:1", "k")
	if err == nil {
		t.Fatal("Probe() error = nil, want an unreachable error")
	}
	if !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("error = %q, want it to mention unreachable", err.Error())
	}
}

func TestProbeFailsOnWrongKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)

	err := Probe(context.Background(), srv.URL, "wrong")
	if err == nil {
		t.Fatal("Probe() error = nil, want a rejected-key error")
	}
	if !strings.Contains(err.Error(), "rejected the key") {
		t.Errorf("error = %q, want it to mention the key was rejected", err.Error())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/machineclient/... -run TestProbe -v`
Expected: FAIL — `undefined: Probe`

- [ ] **Step 3: Implement `Probe`**

Append to `backend/internal/machineclient/client.go` (after `CheckHealth`):

```go
// Probe verifies a machine is reachable at rawURL and that key is accepted
// by its key-gated routes. Unlike /api/health (deliberately open — see
// RequireKey/RequireAuth's public-path allowlists), /api/whoami enforces
// the normal auth middleware, so a 200 here proves both reachability and a
// correct key. A 401 is reported distinctly from other failures so callers
// (PostMachine, before registering a new machine) can tell "wrong key" from
// "machine unreachable".
func Probe(ctx context.Context, rawURL, key string) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(rawURL, "/")+"/api/whoami", nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+key)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("machine unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("machine rejected the key")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("machine returned status %d", resp.StatusCode)
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/machineclient/... -v`
Expected: PASS (all tests in the package, including the pre-existing `TestCheckHealth*`, `TestFetchWorktrees*`, and self-registration tests, unaffected)

- [ ] **Step 5: Vet and commit**

Run: `cd backend && go vet ./...`

```bash
git add backend/internal/machineclient/client.go backend/internal/machineclient/client_test.go
git commit -m "feat(backend): add machineclient.Probe authenticated reachability check"
```

---

### Task 2: `GET /api/whoami` — authenticated liveness route

**Files:**
- Modify: `backend/internal/handler/health.go`
- Modify: `backend/cmd/server/main.go`
- Test: `backend/internal/handler/keyauth_test.go`
- Test: `backend/internal/handler/middleware_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `handler.WhoamiHandler` struct, `handler.NewWhoamiHandler() *WhoamiHandler`, method `(*WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request)`; route `GET /api/whoami` registered on the shared mux, reachable on every role (hub, runtime, both) since it isn't gated by an `if !isRuntime` block, same as `/api/health` and the fs/workspace routes. Task 1's `Probe` already targets this exact path — this task is what makes that path real.

- [ ] **Step 1: Add regression-guard middleware tests (these already pass — see note)**

Append to `backend/internal/handler/keyauth_test.go`:

```go
func TestRequireKeyProtectsWhoami(t *testing.T) {
	rec := httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401 (whoami must NOT be exempt like /api/health)", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/whoami", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec = httptest.NewRecorder()
	requireKeyServer(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 with the correct key", rec.Code)
	}
}
```

Append to `backend/internal/handler/middleware_test.go`:

```go
func TestRequireAuthBlocksWhoamiWithoutCookie(t *testing.T) {
	svc := newTestAuthServiceForMiddleware(t)
	called := false
	mw := RequireAuth(svc, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/whoami", nil))
	if called {
		t.Error("RequireAuth let /api/whoami through without a session cookie or key (it must not be public like /api/health)")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}
```

**Note on why these aren't a red/green pair:** both `RequireKey` and `RequireAuth` only special-case the literal path `/api/health`; they don't know or care whether a route is registered for any other path. So these two tests pass today, *before* Step 2 below — they exercise the middleware directly, not the real mux, so there's nothing here for Step 3's handler to make newly pass. Their value is as a regression guard: if someone later adds `/api/whoami` to a public-path allowlist by mistake, these catch it. The actual red→green cycle for this task is the route registration itself, verified in Step 2.

- [ ] **Step 2: Confirm the route doesn't exist yet (the real "red" step)**

Run: `cd backend && go build -o /tmp/loom-smoke ./cmd/server && /tmp/loom-smoke --role hub --key test-key --db /tmp/loom-smoke.db --open=false --addr 127.0.0.1:18989 &`
Then: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer test-key' http://127.0.0.1:18989/api/whoami`
Expected: `404` (no route registered yet)
Kill it: `kill %1`

Also run the two new unit tests to confirm they already pass (documenting the starting state, not a failure):
Run: `cd backend && go test ./internal/handler/... -run 'TestRequireKeyProtectsWhoami|TestRequireAuthBlocksWhoamiWithoutCookie' -v`
Expected: PASS (see note above — this is expected, not a bug)

- [ ] **Step 3: Implement `WhoamiHandler`**

Append to `backend/internal/handler/health.go`:

```go

// WhoamiHandler answers an authenticated liveness probe. Unlike
// /api/health (deliberately exempt from auth — see RequireKey/RequireAuth's
// public-path allowlists), this route is gated by the normal auth
// middleware: reaching it with a 200 proves both reachability and a
// correct credential. Used by machineclient.Probe before registering a new
// machine (see MachineHandler.PostMachine).
type WhoamiHandler struct{}

// NewWhoamiHandler creates a whoami handler.
func NewWhoamiHandler() *WhoamiHandler { return &WhoamiHandler{} }

func (h *WhoamiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
```

In `backend/cmd/server/main.go`, change:

```go
	healthH := handler.NewHealthHandler()
```

to:

```go
	healthH := handler.NewHealthHandler()
	whoamiH := handler.NewWhoamiHandler()
```

And change:

```go
	mux.HandleFunc("GET /api/health", healthH.ServeHTTP)
	mux.HandleFunc("GET /api/fs/list", fsH.ListDir)
```

to:

```go
	mux.HandleFunc("GET /api/health", healthH.ServeHTTP)
	mux.HandleFunc("GET /api/whoami", whoamiH.ServeHTTP)
	mux.HandleFunc("GET /api/fs/list", fsH.ListDir)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/handler/... -v`
Expected: PASS (full `handler` package, including the two new tests and every pre-existing test)

- [ ] **Step 5: Manual smoke check + vet + commit**

Run: `cd backend && go build -o /tmp/loom-smoke ./cmd/server && /tmp/loom-smoke --role hub --key test-key --db /tmp/loom-smoke.db --open=false --addr 127.0.0.1:18989 &`
Then: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18989/api/whoami` → expect `401`
Then: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer test-key' http://127.0.0.1:18989/api/whoami` → expect `200`
Kill the smoke server: `kill %1` (or `pkill -f loom-smoke`)

Run: `cd backend && go vet ./...`

```bash
git add backend/internal/handler/health.go backend/internal/handler/keyauth_test.go backend/internal/handler/middleware_test.go backend/cmd/server/main.go
git commit -m "feat(backend): add authenticated GET /api/whoami liveness route"
```

---

### Task 3: Wire `Probe` into `PostMachine`

**Files:**
- Modify: `backend/internal/handler/machine.go`
- Modify: `backend/internal/handler/machine_test.go`

**Interfaces:**
- Consumes: `machineclient.Probe(ctx, rawURL, key string) error` (Task 1), reachable `GET /api/whoami` (Task 2, via the test servers this task's tests spin up — it doesn't call the real route directly, it stubs it the same way `TestMachineHealthOnline` stubs `/api/health`).
- Produces: no new exported symbol — `PostMachine`'s behavior changes (see below). Nothing later in this plan consumes this directly; Task 5 (frontend) exercises it end-to-end manually.

**Behavior change:** `PostMachine` now calls `machineclient.Probe` after URL validation and before `st.CreateMachine`. A `Probe` failure returns `400` with `{"error":"could not connect to machine: <detail>"}` — this applies to every `POST /api/machines` caller, including the runtime's own self-registration path (a benefit: a misconfigured `--public-url` now fails loudly instead of silently registering an unreachable entry).

- [ ] **Step 1: Update existing tests that use fake unreachable URLs**

These three tests in `backend/internal/handler/machine_test.go` currently POST with URLs like `https://b.ts.net:8989` that no longer pass (nothing is listening there, so `Probe` now rejects them). Replace `TestMachineCRUDRoundtrip`, `TestPostMachineAcceptsIsLocal`, and `TestPostMachineDefaultsIsLocalFalse` with:

```go
func TestMachineCRUDRoundtrip(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rt-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"`+backend.URL+`","key":"rt-key"}`)))
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

```go
func TestPostMachineAcceptsIsLocal(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"desktop","url":"`+backend.URL+`","key":"k","isLocal":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"isLocal":true`) {
		t.Errorf("body = %s, want isLocal:true", rec.Body.String())
	}
}
```

```go
func TestPostMachineDefaultsIsLocalFalse(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"`+backend.URL+`","key":"k"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"isLocal":false`) {
		t.Errorf("body = %s, want isLocal:false", rec.Body.String())
	}
}
```

Also add two new tests, appended after `TestPostMachineDefaultsIsLocalFalse`:

```go
func TestPostMachineRejectsUnreachableURL(t *testing.T) {
	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"ghost","url":"http://127.0.0.1:1","key":"k"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for an unreachable machine", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "could not connect") {
		t.Errorf("body = %s, want it to mention the connection failure", rec.Body.String())
	}
}

func TestPostMachineRejectsWrongKey(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer correct-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(backend.Close)

	h := newTestMachineHandler(t)
	rec := httptest.NewRecorder()
	h.PostMachine(rec, httptest.NewRequest(http.MethodPost, "/api/machines",
		strings.NewReader(`{"name":"builder","url":"`+backend.URL+`","key":"wrong-key"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a rejected key", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "rejected the key") {
		t.Errorf("body = %s, want it to mention the key was rejected", rec.Body.String())
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run TestMachine -v` and `-run TestPostMachine`
Expected: `TestMachineCRUDRoundtrip`, `TestPostMachineAcceptsIsLocal`, `TestPostMachineDefaultsIsLocalFalse` still PASS (no behavior change yet — they already point at real `httptest.Server`s that answer 200 to anything, so they'd pass even before Step 3). `TestPostMachineRejectsUnreachableURL` and `TestPostMachineRejectsWrongKey` FAIL (currently `PostMachine` creates the machine regardless of reachability, so both get 200 instead of the expected 400).

- [ ] **Step 3: Wire `Probe` into `PostMachine`**

In `backend/internal/handler/machine.go`, change:

```go
	if !validMachineURL(str(body.URL)) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	m, err := h.st.CreateMachine(str(body.Name), str(body.URL), str(body.Key), body.IsLocal != nil && *body.IsLocal)
```

to:

```go
	if !validMachineURL(str(body.URL)) {
		writeErr(w, http.StatusBadRequest, "url must be an absolute http(s) URL")
		return
	}
	if err := machineclient.Probe(r.Context(), str(body.URL), str(body.Key)); err != nil {
		writeErr(w, http.StatusBadRequest, "could not connect to machine: "+err.Error())
		return
	}
	m, err := h.st.CreateMachine(str(body.Name), str(body.URL), str(body.Key), body.IsLocal != nil && *body.IsLocal)
```

(`machineclient` is already imported in this file for `GetMachineHealth`, so no import change is needed.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && go test ./internal/handler/... -v`
Expected: PASS (full `handler` package)

- [ ] **Step 5: Vet, full backend test suite, and commit**

Run: `cd backend && go vet ./... && go test ./...`
Expected: PASS across every package (double-checks `machineclient`'s self-registration tests are unaffected, since they stub the hub's API directly rather than exercising `PostMachine`)

```bash
git add backend/internal/handler/machine.go backend/internal/handler/machine_test.go
git commit -m "feat(backend): verify reachability and key before registering a machine"
```

---

### Task 4: `parseConnectionString` (frontend)

**Files:**
- Create: `frontend/src/features/machines/connectionString.ts`
- Test: `frontend/src/features/machines/connectionString.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function parseConnectionString(raw: string): { name: string; url: string; key: string } | null`. Task 5 imports this exact function and return shape.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/machines/connectionString.test.ts`:

```ts
/**
 * Plain assertion-based tests for connectionString.ts.
 *
 * No test runner (Vitest/Jest) is configured in this frontend project, so
 * this is a standalone script: every `check()` call throws on failure,
 * `main()` runs them all and prints a pass count. Run manually with:
 *
 *   npx tsx src/features/machines/connectionString.test.ts
 */

import { parseConnectionString } from './connectionString'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

check('parses a well-formed connection string', () => {
  const result = parseConnectionString('builder|https://builder.tail-x.ts.net|abc123')
  assertEqual(result, { name: 'builder', url: 'https://builder.tail-x.ts.net', key: 'abc123' }, 'parsed fields')
})

check('trims surrounding whitespace and newlines from a pasted string', () => {
  const result = parseConnectionString('  builder|https://x.ts.net|abc123\n')
  assertEqual(result, { name: 'builder', url: 'https://x.ts.net', key: 'abc123' }, 'trimmed fields')
})

check('rejects too few fields', () => {
  assertEqual(parseConnectionString('builder|https://x.ts.net'), null, 'two fields')
})

check('rejects too many fields', () => {
  assertEqual(parseConnectionString('a|b|c|d'), null, 'four fields')
})

check('rejects an empty field', () => {
  assertEqual(parseConnectionString('builder||abc123'), null, 'empty url field')
})

check('rejects a non-http(s) url', () => {
  assertEqual(parseConnectionString('builder|ftp://x.ts.net|abc123'), null, 'ftp url')
})

check('rejects an empty string', () => {
  assertEqual(parseConnectionString(''), null, 'empty input')
})

function main() {
  console.log(`\n${passed} passed`)
}

main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx tsx src/features/machines/connectionString.test.ts`
Expected: FAIL — module not found / `connectionString.ts` doesn't exist yet

- [ ] **Step 3: Implement `parseConnectionString`**

Create `frontend/src/features/machines/connectionString.ts`:

```ts
/** A runtime's hub connection details, as generated into `copy-this.md` by
 *  the install script (see
 *  docs/superpowers/specs/2026-07-16-runtime-bootstrap-installer-design.md). */
export interface ParsedConnection {
  name: string
  url: string
  key: string
}

/** Parses a `name|url|key` connection string pasted from a runtime's
 *  copy-this.md. Returns null unless there are exactly 3 non-empty
 *  pipe-delimited fields and the url is absolute http(s) — the same
 *  validation `validMachineURL` applies server-side in PostMachine. */
export function parseConnectionString(raw: string): ParsedConnection | null {
  const parts = raw
    .trim()
    .split('|')
    .map((p) => p.trim())
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null
  const [name, url, key] = parts
  if (!/^https?:\/\//.test(url)) return null
  return { name, url, key }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx tsx src/features/machines/connectionString.test.ts`
Expected: `7 passed`

- [ ] **Step 5: Typecheck and commit**

Run: `cd frontend && npm run typecheck`

```bash
git add frontend/src/features/machines/connectionString.ts frontend/src/features/machines/connectionString.test.ts
git commit -m "feat(frontend): add parseConnectionString for pasted runtime connection strings"
```

---

### Task 5: "Paste connection string" mode in the Add Runtime dialog

**Files:**
- Modify: `frontend/src/features/machines/MachineDialog.tsx`

**Interfaces:**
- Consumes: `parseConnectionString` (Task 4), `useCreateMachine` (already exists, `frontend/src/features/data/queries.ts:178`, previously unused).
- Produces: nothing new for later tasks — this is the last task in this plan.

- [ ] **Step 1: Replace `MachineDialog.tsx` with the paste-mode version**

Replace the full contents of `frontend/src/features/machines/MachineDialog.tsx` with:

```tsx
import { Copy, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { parseConnectionString } from '@/features/machines/connectionString'
import { useCreateMachine, useUpdateMachine } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

/** 32 random bytes as 64 lowercase hex chars — mirrors the desktop sidecar's generate_key(). */
function generateRuntimeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function runtimeCommand(key: string, name: string): string {
  const hubUrl = window.location.origin
  return [
    `./loom.exe --role runtime --key ${key} --addr 0.0.0.0:9199 --db runtime.db --open=false \\`,
    `  --hub-url ${hubUrl} --hub-key <your-hub-key> --public-url http://<hostname>:9199 --name ${name.trim() || '<name>'}`,
  ].join('\n')
}

export function MachineDialog() {
  const dialog = useLoomStore((s) => s.machineDialog)
  const setDialog = useLoomStore((s) => s.setMachineDialog)
  const close = useLoomStore((s) => s.closeMachineDialog)
  const showToast = useLoomStore((s) => s.showToast)
  const updateMachine = useUpdateMachine()
  const createMachine = useCreateMachine()

  const isEdit = dialog.editingId !== null
  const busy = updateMachine.isPending || createMachine.isPending
  const canSubmit = dialog.name.trim().length > 0 && dialog.url.trim().length > 0 && dialog.key.trim().length > 0 && !busy

  const [runtimeKey, setRuntimeKey] = useState('')
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteText, setPasteText] = useState('')
  useEffect(() => {
    if (dialog.open && !isEdit) {
      setRuntimeKey(generateRuntimeKey())
      setPasteMode(false)
      setPasteText('')
    }
  }, [dialog.open, isEdit])

  const parsedPaste = pasteText.trim().length > 0 ? parseConnectionString(pasteText) : null
  const pasteInvalid = pasteText.trim().length > 0 && parsedPaste === null

  function copyCommand() {
    void navigator.clipboard.writeText(runtimeCommand(runtimeKey, dialog.name))
    toast.success('Command copied')
  }

  function submit() {
    if (!canSubmit || !dialog.editingId) return
    const body = { name: dialog.name.trim(), url: dialog.url.trim(), key: dialog.key.trim() }
    updateMachine.mutate(
      { id: dialog.editingId, patch: body },
      {
        onSuccess: () => {
          close()
          showToast(`Updated machine "${body.name}"`)
        },
        onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to update machine'),
      },
    )
  }

  function submitPaste() {
    if (!parsedPaste || busy) return
    createMachine.mutate(parsedPaste, {
      onSuccess: () => {
        close()
        showToast(`Connected machine "${parsedPaste.name}"`)
      },
      onError: (err) => showToast(err instanceof Error ? err.message : 'Failed to connect machine'),
    })
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(o) => !o && !busy && close()} width={480}>
      <DialogTitle>{isEdit ? 'Edit runtime' : 'Add runtime'}</DialogTitle>
      <DialogDescription className="mb-[18px]">
        Runtimes run worktrees, terminals, and git — reachable over your tailnet.
      </DialogDescription>

      {!isEdit ? (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setPasteMode((m) => !m)}
            className="cursor-pointer font-mono text-[11px] text-loom-muted-2 underline decoration-dotted hover:text-loom-accent-soft"
          >
            {pasteMode ? 'Use the self-register command instead' : 'Have a connection string instead?'}
          </button>
        </div>
      ) : null}

      {isEdit ? (
        <>
          <Label>Name</Label>
          <Input
            value={dialog.name}
            disabled={busy}
            onChange={(e) => setDialog({ name: e.target.value })}
            placeholder="builder"
            className="mb-3 font-mono"
          />

          <Label>URL</Label>
          <Input
            value={dialog.url}
            disabled={busy}
            onChange={(e) => setDialog({ url: e.target.value })}
            placeholder="https://builder.tail-x.ts.net:8989"
            className="mb-3 font-mono"
          />

          <Label>Key</Label>
          <Input
            value={dialog.key}
            disabled={busy}
            type="password"
            onChange={(e) => setDialog({ key: e.target.value })}
            placeholder="runtime --key value"
            className="mb-5 font-mono"
          />
        </>
      ) : pasteMode ? (
        <>
          <Label>Connection string</Label>
          <p className="mb-2 font-mono text-[10.5px] text-loom-dim-2">
            Paste the line from the runtime's <code>copy-this.md</code> (format: name|url|key).
          </p>
          <Input
            value={pasteText}
            disabled={busy}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="builder|https://builder.tail-x.ts.net|a1b2c3..."
            className="mb-1 font-mono"
          />
          <p className={`mb-5 font-mono text-[10.5px] ${pasteInvalid ? 'text-loom-red-soft' : 'text-loom-dim-2'}`}>
            {pasteInvalid
              ? 'Expected exactly 3 fields separated by "|": name, an https:// URL, and a key.'
              : parsedPaste
                ? `Will connect "${parsedPaste.name}" at ${parsedPaste.url}`
                : ' '}
          </p>
        </>
      ) : (
        <>
          <Label>Name</Label>
          <Input
            value={dialog.name}
            disabled={busy}
            onChange={(e) => setDialog({ name: e.target.value })}
            placeholder="builder"
            className="mb-3 font-mono"
          />

          <Label>Runtime command</Label>
          <p className="mb-2 font-mono text-[10.5px] text-loom-dim-2">
            Run this on the target runtime — replace &lt;your-hub-key&gt; and &lt;hostname&gt;. It self-registers with
            this hub on startup.
          </p>
          <div className="relative mb-5 rounded-lg border border-loom-border-card bg-loom-terminal p-2.5 pr-9">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-loom-fg">
              {runtimeCommand(runtimeKey, dialog.name)}
            </pre>
            <button
              type="button"
              onClick={copyCommand}
              aria-label="Copy command"
              className="absolute right-2.5 top-2.5 cursor-pointer p-1 text-loom-muted-2 hover:text-loom-accent-soft"
            >
              <Copy size={12} />
            </button>
          </div>
        </>
      )}

      <div className="flex justify-end gap-2.5">
        <Button variant="secondary" onClick={close} disabled={busy}>
          {isEdit ? 'Cancel' : 'Close'}
        </Button>
        {isEdit ? (
          <Button onClick={submit} disabled={!canSubmit}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Save
          </Button>
        ) : pasteMode ? (
          <Button onClick={submitPaste} disabled={!parsedPaste || busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Connect
          </Button>
        ) : (
          <Button onClick={copyCommand}>
            <Copy size={13} />
            Copy command
          </Button>
        )}
      </div>
    </Dialog>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS with no new errors

- [ ] **Step 3: Manual verification**

1. Start a hub and a runtime: `make dev-hub` (terminal 1), `make dev-runtime` (terminal 2) — see `Makefile` targets, the runtime self-registers with `--name local-runtime` automatically.
2. Start the frontend: `cd frontend && npm run dev:web`, open the app, go to the Runtimes page. Confirm `local-runtime` already appears (from self-registration).
3. Delete that row (trash icon) so its name is free to reuse.
4. Click **Add runtime**, click **Have a connection string instead?**. Paste an invalid string first, e.g. `bad-string`, and confirm the red validation message appears and **Connect** stays disabled.
5. Paste a valid one: `local-runtime|http://127.0.0.1:9199|dev-runtime-key` (matching `make dev-runtime`'s `--key`/`--public-url`/`--name`). Confirm the preview line shows `Will connect "local-runtime" at http://127.0.0.1:9199`, then click **Connect**.
6. Confirm the dialog closes, a success toast appears, and `local-runtime` re-appears in the list with an "online" status badge.
7. Repeat step 4-5 with a syntactically valid but unreachable string, e.g. `ghost|http://127.0.0.1:1|whatever-key`, and confirm the toast shows the "could not connect to machine: machine unreachable: …" error from Task 3 instead of silently succeeding.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/features/machines/MachineDialog.tsx
git commit -m "feat(frontend): add paste-connection-string mode to the Add Runtime dialog"
```

---

## Self-Review Notes

- **Spec coverage:** Decision 9 (pipe-delimited format) → Task 4. Decision 10 (authenticated check, not `/api/health`) → Tasks 1-2. "Backend: reachability + auth check on machine creation" section → Task 3. "Hub UI: paste connection string" section → Task 5. The installer/bundle/checklist portions of the spec (Decisions 1-8, 11) are covered by the separate `2026-07-16-runtime-bootstrap-installer.md` plan, not this one — this plan only covers the hub-side half of the spec, by design (see that plan's header for why it's split out).
- **Placeholder scan:** no TBD/TODO; every step has complete code or exact commands.
- **Type consistency:** `parseConnectionString`'s return shape `{name, url, key}` (Task 4) matches `CreateMachineBody` (`frontend/src/lib/api.ts:622`) exactly, so `createMachine.mutate(parsedPaste, ...)` in Task 5 type-checks without adapting the shape. `machineclient.Probe(ctx, rawURL, key string) error` (Task 1) is called with `(r.Context(), str(body.URL), str(body.Key))` in Task 3 — same argument order and types.

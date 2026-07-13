# Loom Desktop (Tauri v2, bundled hub sidecar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Loom as a self-contained Tauri v2 desktop app that spawns the existing Go backend as a bundled sidecar hub and loads its embedded SPA from localhost.

**Architecture:** The Rust shell generates an ephemeral key, spawns `loom-server --role hub --addr 127.0.0.1:0`, parses the bound port from the listen log line, upserts a "local machine" registry entry, and navigates the webview to `http://127.0.0.1:<port>/?key=<key>`. The SPA exchanges the key for a normal session cookie via a new `POST /api/auth/key-session` endpoint, after which the desktop behaves exactly like a logged-in web session. Spec: `docs/superpowers/specs/2026-07-13-tauri-desktop-sidecar-design.md`.

**Tech Stack:** Go 1.x backend (unchanged patterns), React 19 + Vite 8 SPA, Tauri v2 (`tauri` crate 2.x, `tauri-plugin-shell` 2.x, `@tauri-apps/cli` ^2.11), reqwest 0.12 (no TLS backend), getrandom 0.4.

## Global Constraints

- v1 sidecar targets: `aarch64-apple-darwin`, `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu` (spec §Decisions 3).
- Desktop operator email is exactly `operator@loom.desktop`; launch key is 32 random bytes as 64 lowercase hex chars.
- Sidecar flags, exactly: `--role hub --addr 127.0.0.1:0 --key <K> --db <appDataDir>/loom.db --env <appDataDir>/.env --open=false --2fa=false --secure-cookies=false`.
- All API error responses keep the `{"error":"message"}` envelope; Go handlers use `handleStoreErr()` for store errors (CONTRACTS.md).
- All persistence via `port.Store`; never bypass it.
- Frontend: `@/*` import alias only; `import type` for type-only imports; never edit `frontend/src/routeTree.gen.ts`.
- `backend/cmd/server/main.go` is a convergence file — Tasks 1–3 modify it and MUST run sequentially, never in parallel agents.
- Verify commands: backend `cd backend && go test ./... && go vet ./...`; frontend `cd frontend && npm run typecheck`; Rust `cd frontend/src-tauri && cargo test && cargo check`.
- Commit after every task (repo pre-commit hook runs the frontend typecheck automatically).

## File Structure

| File | Responsibility |
|---|---|
| `backend/internal/handler/auth.go` (modify) | `secureCookies` toggle; `SetDesktopKey` + `PostKeySession` handler |
| `backend/internal/service/auth.go` (modify) | `KeySession()` — desktop operator create-or-reuse + session issue |
| `backend/cmd/server/main.go` (modify) | `--secure-cookies` flag; key-session route; listen-line contract comment |
| `frontend/src/main.tsx` (modify) | Pre-render `?key=` → session bootstrap (web-inert) |
| `frontend/src-tauri/` (new) | Tauri project: config, capabilities, splash/error pages, icons |
| `frontend/src-tauri/src/sidecar.rs` (new) | Key gen, launch args, listen-line parsing, log file handling |
| `frontend/src-tauri/src/hubapi.rs` (new) | Health wait + local-machine upsert against the sidecar hub |
| `frontend/src-tauri/src/lib.rs` (new) | Orchestration: spawn → ready → upsert → navigate; respawn; exit kill |
| `Makefile` (modify) | `prepare-sidecar` (3 triples) and `sidecar-host` targets |
| `CONTRACTS.md`, `COMMANDS.md`, `ARCHITECTURE.md` (modify) | Document the new surface |

---

### Task 1: Backend — `--secure-cookies` flag

WebKit-based webviews (macOS WKWebView, Linux WebKitGTK) may drop `Secure` cookies set over plain `http://127.0.0.1`. Make the `Secure` attribute toggleable; default stays `true` so web deployments are untouched.

**Files:**
- Modify: `backend/internal/handler/auth.go` (setAuthCookie/clearAuthCookie, ~line 39)
- Modify: `backend/cmd/server/main.go` (flag block ~line 45, wiring after `handler.NewAuthHandler` ~line 144)
- Test: `backend/internal/handler/auth_test.go`

**Interfaces:**
- Consumes: existing `setAuthCookie` / `clearAuthCookie` package functions.
- Produces: `handler.SetSecureCookies(enabled bool)` — package-level toggle used by `main.go`; Task 8's sidecar args rely on the `--secure-cookies` flag existing.

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/handler/auth_test.go` (match the file's existing imports; it already imports `httptest` and `time`):

```go
func TestSetSecureCookiesTogglesSecureAttribute(t *testing.T) {
	t.Cleanup(func() { SetSecureCookies(true) })

	rec := httptest.NewRecorder()
	setAuthCookie(rec, sessionCookieName, "tok", time.Hour)
	if c := rec.Result().Cookies()[0]; !c.Secure {
		t.Fatal("expected Secure cookie by default")
	}

	SetSecureCookies(false)
	rec = httptest.NewRecorder()
	setAuthCookie(rec, sessionCookieName, "tok", time.Hour)
	if c := rec.Result().Cookies()[0]; c.Secure {
		t.Fatal("expected non-Secure cookie after SetSecureCookies(false)")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestSetSecureCookies -v`
Expected: FAIL to compile with `undefined: SetSecureCookies`

- [ ] **Step 3: Implement the toggle**

In `backend/internal/handler/auth.go`, above `setAuthCookie`:

```go
// secureCookies controls the Secure attribute on auth cookies. Desktop
// (Tauri) builds serve the UI over plain http://127.0.0.1, where WebKit
// webviews drop Secure cookies; the sidecar passes --secure-cookies=false.
var secureCookies = true

// SetSecureCookies toggles the Secure attribute on all auth cookies.
func SetSecureCookies(enabled bool) { secureCookies = enabled }
```

Change `Secure: true,` to `Secure: secureCookies,` in BOTH `setAuthCookie` and `clearAuthCookie`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/handler/ -run TestSetSecureCookies -v`
Expected: PASS

- [ ] **Step 5: Wire the flag in main.go**

In `backend/cmd/server/main.go`, after the `twoFA` flag (line ~45):

```go
	secureCookiesFlag := flag.Bool("secure-cookies", envBool("LOOM_SECURE_COOKIES", true), "set the Secure attribute on auth cookies; disable only for loopback desktop deployments (--secure-cookies=false)")
```

After `authH := handler.NewAuthHandler(authSvc)` (line ~144):

```go
	handler.SetSecureCookies(*secureCookiesFlag)
```

- [ ] **Step 6: Full backend check**

Run: `cd backend && go test ./... && go vet ./...`
Expected: all PASS, vet clean

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handler/auth.go backend/internal/handler/auth_test.go backend/cmd/server/main.go
git commit -m "feat(auth): --secure-cookies flag for loopback desktop deployments"
```

---

### Task 2: Backend — `AuthService.KeySession()`

Issues a session for the single desktop operator account, creating it on first run. Caller (the handler, Task 3) must already have verified the static key.

**Files:**
- Modify: `backend/internal/service/auth.go`
- Test: `backend/internal/service/auth_test.go`

**Interfaces:**
- Consumes: existing `a.store.UserCount()`, `a.store.UserByEmail(email)`, `a.Register(email, password)`, private `a.issueSession(userID)`, `ErrConflict`.
- Produces: `func (a *AuthService) KeySession() (string, domain.User, error)` — returns `(sessionToken, user)`; Task 3's handler calls it. Const `desktopOperatorEmail = "operator@loom.desktop"`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/service/auth_test.go`, matching the file's existing setup style (it opens a real temp-dir SQLite store — see its top; reuse the file's existing constructor helper if one exists, otherwise inline as below):

```go
func TestKeySessionCreatesDesktopOperatorOnFirstRun(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := NewAuthService(store.New(db), make([]byte, 32))

	token, user, err := svc.KeySession()
	if err != nil {
		t.Fatalf("KeySession: %v", err)
	}
	if user.Email != "operator@loom.desktop" {
		t.Fatalf("email = %q, want operator@loom.desktop", user.Email)
	}
	got, err := svc.CurrentUser(token)
	if err != nil || got.ID != user.ID {
		t.Fatalf("CurrentUser(token) = %+v, %v; want the operator user", got, err)
	}
}

func TestKeySessionReusesExistingDesktopOperator(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := NewAuthService(store.New(db), make([]byte, 32))

	_, first, err := svc.KeySession()
	if err != nil {
		t.Fatal(err)
	}
	token2, second, err := svc.KeySession()
	if err != nil {
		t.Fatalf("second KeySession: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("second call created a new user: %s != %s", second.ID, first.ID)
	}
	if _, err := svc.CurrentUser(token2); err != nil {
		t.Fatalf("second session invalid: %v", err)
	}
}

func TestKeySessionRejectsForeignOperatorAccount(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	svc := NewAuthService(store.New(db), make([]byte, 32))

	if _, _, err := svc.Register("me@example.com", "sufficiently-long-password"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.KeySession(); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}
```

(If the file's package or store constructor differs, adapt to what's already there — the assertions stay identical.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/ -run TestKeySession -v`
Expected: FAIL to compile with `undefined: svc.KeySession` (method missing)

- [ ] **Step 3: Implement KeySession**

In `backend/internal/service/auth.go`, after `CompleteLogin` (~line 356). Add `crypto/rand` and `encoding/hex` to imports if not already present:

```go
// desktopOperatorEmail identifies the auto-created single-operator account
// used by the desktop app's key-session bootstrap (POST /api/auth/key-session).
const desktopOperatorEmail = "operator@loom.desktop"

// KeySession issues a session for the desktop operator account, creating it
// on first run. The caller must already have proven possession of the hub's
// static --key, so this deliberately bypasses password and TOTP.
func (a *AuthService) KeySession() (string, domain.User, error) {
	count, err := a.store.UserCount()
	if err != nil {
		return "", domain.User{}, err
	}
	if count == 0 {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return "", domain.User{}, err
		}
		// Throwaway password: desktop logins always come through KeySession.
		user, _, err := a.Register(desktopOperatorEmail, hex.EncodeToString(buf))
		if err != nil {
			return "", domain.User{}, err
		}
		token, err := a.issueSession(user.ID)
		if err != nil {
			return "", domain.User{}, err
		}
		return token, user, nil
	}
	user, err := a.store.UserByEmail(desktopOperatorEmail)
	if err != nil {
		return "", domain.User{}, fmt.Errorf("key session requires the desktop operator account: %w", ErrConflict)
	}
	token, err := a.issueSession(user.ID)
	if err != nil {
		return "", domain.User{}, err
	}
	return token, user, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run TestKeySession -v`
Expected: PASS (all three)

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/auth.go backend/internal/service/auth_test.go
git commit -m "feat(auth): KeySession issues desktop operator sessions"
```

---

### Task 3: Backend — `POST /api/auth/key-session` route

**Files:**
- Modify: `backend/internal/handler/auth.go` (AuthHandler struct + new handler)
- Modify: `backend/cmd/server/main.go` (route registration in the `!isRuntime` auth block, ~line 237; listen-line contract comment ~line 406)
- Modify: `CONTRACTS.md` (section `## Key auth (hub/runtime roles)`, line ~65)
- Test: `backend/internal/handler/auth_test.go`

**Interfaces:**
- Consumes: `svc.KeySession()` (Task 2), existing `keyMatches`/`bearerToken` (keyauth.go), `setAuthCookie`, `handleStoreErr`, `writeErr`, `writeJSON`.
- Produces: `(h *AuthHandler) SetDesktopKey(key string)` and `(h *AuthHandler) PostKeySession(w, r)`; route `POST /api/auth/key-session` active only when `--role hub` and `--key` non-empty. Task 4's frontend bootstrap and Task 7's Rust upsert depend on this endpoint setting the `loom_session` cookie.

- [ ] **Step 1: Write the failing tests**

Append to `backend/internal/handler/auth_test.go` (uses the existing `newTestAuthHandler(t)` helper at the top of that file):

```go
func TestKeySessionExchangesKeyForSession(t *testing.T) {
	h := newTestAuthHandler(t)
	h.SetDesktopKey("sekrit")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer sekrit")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			session = c
		}
	}
	if session == nil || session.Value == "" {
		t.Fatal("no session cookie set")
	}

	// The minted session must work against GetMe.
	me := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	me.AddCookie(session)
	meRec := httptest.NewRecorder()
	h.GetMe(meRec, me)
	if meRec.Code != http.StatusOK {
		t.Fatalf("GetMe with key-session cookie = %d, want 200", meRec.Code)
	}
}

func TestKeySessionRejectsWrongKey(t *testing.T) {
	h := newTestAuthHandler(t)
	h.SetDesktopKey("sekrit")

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestKeySessionRejectsWhenNoKeyConfigured(t *testing.T) {
	h := newTestAuthHandler(t) // SetDesktopKey never called

	req := httptest.NewRequest(http.MethodPost, "/api/auth/key-session", nil)
	req.Header.Set("Authorization", "Bearer anything")
	rec := httptest.NewRecorder()
	h.PostKeySession(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/ -run TestKeySession -v`
Expected: FAIL to compile with `undefined` methods

- [ ] **Step 3: Implement handler**

In `backend/internal/handler/auth.go`: add field `desktopKey string` to the `AuthHandler` struct, then after `GetMe`:

```go
// SetDesktopKey enables POST /api/auth/key-session, which exchanges the
// hub's static --key for a normal operator session (desktop app bootstrap;
// see docs/superpowers/specs/2026-07-13-tauri-desktop-sidecar-design.md).
func (h *AuthHandler) SetDesktopKey(key string) { h.desktopKey = key }

// PostKeySession handles POST /api/auth/key-session. It re-verifies the
// bearer key itself: the auth middleware also admits session cookies, and
// key possession is the entire authorization for minting this session.
func (h *AuthHandler) PostKeySession(w http.ResponseWriter, r *http.Request) {
	if !keyMatches(bearerToken(r), h.desktopKey) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	sessionToken, user, err := h.svc.KeySession()
	if handleStoreErr(w, err) {
		return
	}
	setAuthCookie(w, sessionCookieName, sessionToken, 30*24*time.Hour)
	writeJSON(w, http.StatusOK, user)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -run TestKeySession -v`
Expected: PASS (all three)

- [ ] **Step 5: Register the route and mark the listen-line contract**

In `backend/cmd/server/main.go`, inside the existing `if !isRuntime {` auth-route block, after the `GET /api/auth/me` line (~line 236):

```go
		if *apiKey != "" {
			authH.SetDesktopKey(*apiKey)
			mux.HandleFunc("POST /api/auth/key-session", authH.PostKeySession)
		}
```

And directly above the `log.Printf("loom listening on %s (db: %s)", uiURL, *dbPath)` line (~406):

```go
	// NOTE: the desktop shell (frontend/src-tauri/src/sidecar.rs) parses this
	// exact line to discover the bound port when launched with --addr 127.0.0.1:0.
```

- [ ] **Step 6: Document in CONTRACTS.md**

Append to the `## Key auth (hub/runtime roles)` section:

```markdown
- `POST /api/auth/key-session` (hub with `--key` only): exchanges
  `Authorization: Bearer <hub key>` for a regular `loom_session` cookie tied
  to the auto-created `operator@loom.desktop` account. Desktop (Tauri)
  bootstrap only — the SPA calls it once at startup when launched with
  `?key=`. Returns the user JSON; 401 on a wrong/absent key.
- `--secure-cookies=false` drops the `Secure` attribute on auth cookies for
  loopback desktop deployments (WebKit webviews reject Secure cookies over
  plain `http://127.0.0.1`). Web deployments keep the default (`true`).
```

- [ ] **Step 7: Full backend check**

Run: `cd backend && go test ./... && go vet ./...`
Expected: all PASS, vet clean

- [ ] **Step 8: Commit**

```bash
git add backend/internal/handler/auth.go backend/internal/handler/auth_test.go backend/cmd/server/main.go CONTRACTS.md
git commit -m "feat(auth): POST /api/auth/key-session desktop bootstrap endpoint"
```

---

### Task 4: Frontend — `main.tsx` session bootstrap

**Files:**
- Modify: `frontend/src/main.tsx`

**Interfaces:**
- Consumes: `POST /api/auth/key-session` (Task 3).
- Produces: on `?key=<K>` startup URLs, a session cookie exists before the router's root `beforeLoad` guard runs, so the login redirect never triggers. No key → byte-identical behavior to today.

- [ ] **Step 1: Implement the bootstrap**

In `frontend/src/main.tsx`, wrap the existing `createRoot(...)` call (lines 41–47) in a function and gate rendering on the bootstrap:

```tsx
/**
 * Desktop (Tauri) bootstrap: the shell launches the SPA at /?key=<hub key>.
 * Exchange it for a normal session cookie before the router's auth guard
 * runs, then scrub the key from the URL. No-op on the web (no ?key=).
 */
async function bootstrapDesktopSession(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const key = params.get('key')
  if (!key) return
  params.delete('key')
  const query = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  try {
    const res = await fetch('/api/auth/key-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!res.ok) console.error(`desktop key-session bootstrap failed: ${res.status}`)
  } catch (err) {
    console.error('desktop key-session bootstrap failed', err)
  }
}

function renderApp() {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('#root not found')

  createRoot(rootEl).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
}

void bootstrapDesktopSession().finally(renderApp)
```

(The existing top-level `const rootEl` block is replaced by `renderApp`. On bootstrap failure the root guard redirects to /login as usual — a visible failure surface, not a blank screen.)

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: clean

- [ ] **Step 3: Verify web flow is untouched**

Run: `cd frontend && npm run build`
Expected: build succeeds. (No `?key=` → `bootstrapDesktopSession` returns before any fetch; render path identical.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/main.tsx
git commit -m "feat(desktop): exchange ?key= for a session before first render"
```

---

### Task 5: Makefile sidecar targets + Tauri scaffold

**Files:**
- Modify: `Makefile` (after the `portable-all` target, ~line 108; add new names to `.PHONY` line 1)
- Modify: `frontend/package.json` (devDependency + scripts)
- Modify: `frontend/.gitignore`
- Create: `frontend/src-tauri/Cargo.toml`, `frontend/src-tauri/build.rs`, `frontend/src-tauri/tauri.conf.json`, `frontend/src-tauri/capabilities/default.json`, `frontend/src-tauri/src/main.rs`, `frontend/src-tauri/src/lib.rs` (minimal), `frontend/src-tauri/ui/index.html`, `frontend/src-tauri/ui/error.html`, `frontend/src-tauri/icons/*` (generated)

**Interfaces:**
- Consumes: existing Makefile vars `LDFLAGS`, `WINDOWS_EXT`, target `prepare-webui`.
- Produces: `make prepare-sidecar` (3 release triples into `frontend/src-tauri/binaries/`), `make sidecar-host` (host triple only, required before `tauri dev`/`cargo check` because tauri-build fails on missing externalBin files); a compiling Tauri project that Tasks 6–8 fill in.

- [ ] **Step 1: Add Makefile targets**

Append after `portable-all`; also add `prepare-sidecar sidecar-host` to the `.PHONY` list on line 1:

```make
# ── Desktop (Tauri) ──────────────────────────────────────────
# Sidecar binaries for the desktop app, named by Rust target triple as
# tauri's externalBin convention requires. tauri-build FAILS if these are
# missing, so run sidecar-host before `tauri dev` / `cargo check`.
TAURI_BIN_DIR := frontend/src-tauri/binaries

prepare-sidecar: prepare-webui
	mkdir -p $(TAURI_BIN_DIR)
	cd backend && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-aarch64-apple-darwin ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-x86_64-pc-windows-msvc.exe ./cmd/server
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-x86_64-unknown-linux-gnu ./cmd/server

sidecar-host: prepare-webui
	mkdir -p $(TAURI_BIN_DIR)
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o ../$(TAURI_BIN_DIR)/loom-server-$$(rustc --print host-tuple)$(WINDOWS_EXT) ./cmd/server
```

(`rustc --print host-tuple` needs rustc ≥ 1.84; fallback `rustc -Vv | sed -n 's/^host: //p'`.)

- [ ] **Step 2: Scaffold the Tauri project**

```bash
cd frontend && npm install -D @tauri-apps/cli@^2
npx tauri init --ci --app-name Loom --window-title Loom \
  --frontend-dist ui --dev-url http://localhost:5173 \
  --before-dev-command "npm run dev" \
  --before-build-command "cd .. && make prepare-sidecar"
```

(If `--ci` is unsupported by the installed CLI, run `npx tauri init` interactively and give the same six answers, in prompt order: `Loom`, `Loom`, `ui`, `http://localhost:5173`, `npm run dev`, `cd .. && make prepare-sidecar`.)

Then add the Rust dependencies:

```bash
cd src-tauri
cargo add tauri-plugin-shell@2
cargo add getrandom@0.4
cargo add tokio@1 --features time
cargo add reqwest@0.12 --no-default-features --features json
cargo add serde_json@1
cargo add serde@1 --features derive
```

- [ ] **Step 3: Write tauri.conf.json**

Overwrite `frontend/src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Loom",
  "identifier": "dev.kiyora.loom",
  "version": "0.1.0",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "cd .. && make prepare-sidecar",
    "devUrl": "http://localhost:5173",
    "frontendDist": "ui"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Loom",
        "width": 1400,
        "height": 900,
        "visible": true
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "externalBin": ["binaries/loom-server"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

Keep the scaffold-generated `capabilities/default.json` as-is (`core:default` for the `main` window; no shell permissions needed — the sidecar is spawned from Rust, which the capability system does not gate). Keep scaffold icons for v1.

- [ ] **Step 4: Splash and error pages**

`frontend/src-tauri/ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Loom</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0d1017; color: #8b93a7;
        font: 13px/1.4 -apple-system, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      .pulse { animation: pulse 1.2s ease-in-out infinite; }
      @keyframes pulse { 50% { opacity: 0.35; } }
    </style>
  </head>
  <body><div class="pulse">Starting Loom…</div></body>
</html>
```

`frontend/src-tauri/ui/error.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Loom — startup failed</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0d1017; color: #c0c6d4;
        font: 13px/1.6 -apple-system, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { max-width: 480px; }
      h1 { font-size: 15px; color: #e46962; }
      code { color: #8b93a7; word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <h1>Loom failed to start</h1>
      <p id="msg">The bundled loom-server did not start.</p>
      <p>Details are in the sidecar log:<br /><code id="logpath">app log directory / sidecar.log</code></p>
    </main>
  </body>
</html>
```

- [ ] **Step 5: Minimal lib.rs / main.rs (scaffold defaults)**

`frontend/src-tauri/src/main.rs` (keep the generated one; it should be equivalent to):

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    loom_lib::run()
}
```

`frontend/src-tauri/src/lib.rs` (temporary — Task 8 replaces it):

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

(Match the generated crate/lib name — whatever `tauri init` put in `Cargo.toml` `[lib] name`; `main.rs` must call that crate's `run()`.)

- [ ] **Step 6: gitignore + npm scripts**

Append to `frontend/.gitignore`:

```
src-tauri/target/
src-tauri/binaries/
src-tauri/gen/
```

Add to `frontend/package.json` scripts:

```json
"tauri": "tauri",
"tauri:dev": "cd .. && make sidecar-host && cd frontend && tauri dev",
"tauri:build": "tauri build"
```

- [ ] **Step 7: Verify the scaffold compiles**

Run: `make sidecar-host && cd frontend/src-tauri && cargo check`
Expected: compiles cleanly (first run downloads crates; takes a few minutes)

- [ ] **Step 8: Commit**

```bash
git add Makefile frontend/package.json frontend/package-lock.json frontend/.gitignore frontend/src-tauri
git commit -m "feat(desktop): scaffold Tauri v2 shell with sidecar build targets"
```

---

### Task 6: Rust — `sidecar.rs` (args, port parsing, key gen, log)

**Files:**
- Create: `frontend/src-tauri/src/sidecar.rs`
- Test: inline `#[cfg(test)]` module in the same file

**Interfaces:**
- Consumes: `getrandom::fill`.
- Produces (used by Task 8): `generate_key() -> String` (64 hex chars), `sidecar_args(data_dir: &Path, key: &str) -> Vec<String>`, `parse_listen_port(line: &str) -> Option<u16>`, `open_sidecar_log(log_dir: &Path) -> std::io::Result<File>`, `pub const READY_TIMEOUT_SECS: u64 = 15`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src-tauri/src/sidecar.rs` with only the test module first:

```rust
//! Sidecar process helpers: launch args, readiness detection, log capture.

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn key_is_64_lowercase_hex_chars() {
        let k = generate_key();
        assert_eq!(k.len(), 64);
        assert!(k.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(generate_key(), k, "keys must be random");
    }

    #[test]
    fn parses_port_from_listen_line() {
        let line = "2026/07/13 10:00:00 loom listening on http://127.0.0.1:52341 (db: /x/loom.db)";
        assert_eq!(parse_listen_port(line), Some(52341));
        assert_eq!(parse_listen_port("unrelated log noise"), None);
        assert_eq!(parse_listen_port("loom listening on http://127.0.0.1: (db)"), None);
    }

    #[test]
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0");
        let joined = args.join(" ");
        assert!(joined.contains("--role hub"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--open=false"));
        assert!(joined.contains("--2fa=false"));
        assert!(joined.contains("--secure-cookies=false"));
        assert!(joined.contains("loom.db"));
    }

    #[test]
    fn log_open_truncates_oversized_file() {
        let dir = std::env::temp_dir().join(format!("loom-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sidecar.log");
        std::fs::write(&path, vec![b'x'; (LOG_TRUNCATE_BYTES + 1) as usize]).unwrap();
        drop(open_sidecar_log(&dir).unwrap());
        assert!(std::fs::metadata(&path).unwrap().len() <= LOG_TRUNCATE_BYTES);
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

And register the module in `lib.rs`: add `mod sidecar;` at the top.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/src-tauri && cargo test sidecar`
Expected: FAIL to compile (`generate_key` etc. not found)

- [ ] **Step 3: Implement**

Above the test module in `sidecar.rs`:

```rust
use std::fs::File;
use std::path::Path;

/// Seconds the shell waits for the listen line + health check.
pub const READY_TIMEOUT_SECS: u64 = 15;
/// Truncate sidecar.log at startup once it exceeds 5 MB (spec: no rotation in v1).
pub const LOG_TRUNCATE_BYTES: u64 = 5 * 1024 * 1024;

const LISTEN_MARKER: &str = "loom listening on http://127.0.0.1:";

/// Per-launch hub key: 32 random bytes as 64 lowercase hex chars.
pub fn generate_key() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// loom-server args for desktop-sidecar mode. `--addr 127.0.0.1:0` makes the
/// OS pick the port; parse_listen_port recovers it from the startup log line
/// (the contract is marked with a NOTE next to the log.Printf in
/// backend/cmd/server/main.go).
pub fn sidecar_args(data_dir: &Path, key: &str) -> Vec<String> {
    vec![
        "--role".into(), "hub".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("loom.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--open=false".into(),
        "--2fa=false".into(),
        "--secure-cookies=false".into(),
    ]
}

/// Extracts the bound port from the server's "loom listening on" line.
pub fn parse_listen_port(line: &str) -> Option<u16> {
    let idx = line.find(LISTEN_MARKER)?;
    let digits: String = line[idx + LISTEN_MARKER.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

/// Opens <log_dir>/sidecar.log for appending, truncating it first when it
/// has grown past LOG_TRUNCATE_BYTES.
pub fn open_sidecar_log(log_dir: &Path) -> std::io::Result<File> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join("sidecar.log");
    if std::fs::metadata(&path).map(|m| m.len() > LOG_TRUNCATE_BYTES).unwrap_or(false) {
        std::fs::remove_file(&path)?;
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/src-tauri && cargo test sidecar`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src-tauri/src/sidecar.rs frontend/src-tauri/src/lib.rs
git commit -m "feat(desktop): sidecar launch args, port parsing, log handling"
```

---

### Task 7: Rust — `hubapi.rs` (health wait + local-machine upsert)

Terminals/LSP/files resolve through a registered `Machine` (`project.machineId`), so the desktop hub must exist in its own registry with the current launch's URL + key.

**Files:**
- Create: `frontend/src-tauri/src/hubapi.rs`
- Test: inline `#[cfg(test)]` module

**Interfaces:**
- Consumes: hub REST API — `GET /api/health` (public), `POST /api/machines` / `PATCH /api/machines/{id}` with `Authorization: Bearer <key>`; bodies `{"name","url","key"}` / `{"url","key"}`; response `{"id","name","url","key"}` (CONTRACTS.md "Machines API").
- Produces (used by Task 8): `async fn wait_healthy(port: u16, timeout: Duration) -> Result<(), String>`, `async fn upsert_local_machine(port: u16, key: &str, data_dir: &Path) -> Result<(), String>`, `fn device_name() -> String`. Persists the machine id at `<data_dir>/local-machine-id`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src-tauri/src/hubapi.rs` with the test module:

```rust
//! Minimal REST client for the sidecar hub: health wait + machine upsert.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_name_is_never_empty() {
        assert!(!device_name().trim().is_empty());
    }

    #[test]
    fn machine_bodies_have_the_contract_fields() {
        let create = create_body("mac", 4321, "k");
        assert_eq!(create["name"], "mac");
        assert_eq!(create["url"], "http://127.0.0.1:4321");
        assert_eq!(create["key"], "k");
        let patch = patch_body(4321, "k");
        assert_eq!(patch["url"], "http://127.0.0.1:4321");
        assert_eq!(patch["key"], "k");
        assert!(patch.get("name").is_none(), "PATCH must not rename the machine");
    }
}
```

Register `mod hubapi;` in `lib.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/src-tauri && cargo test hubapi`
Expected: FAIL to compile

- [ ] **Step 3: Implement**

```rust
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

const MACHINE_ID_FILE: &str = "local-machine-id";

#[derive(Deserialize)]
struct MachineResp {
    id: String,
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn create_body(name: &str, port: u16, key: &str) -> Value {
    json!({ "name": name, "url": base(port), "key": key })
}

pub fn patch_body(port: u16, key: &str) -> Value {
    json!({ "url": base(port), "key": key })
}

/// Hostname as the machine display name; falls back to a constant.
pub fn device_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This device".to_string())
}

/// Polls GET /api/health (public route) until 200 or the deadline passes.
pub async fn wait_healthy(port: u16, timeout: Duration) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}/api/health", base(port));
    let deadline = Instant::now() + timeout;
    loop {
        match client
            .get(&url)
            .timeout(Duration::from_secs(2))
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => return Ok(()),
            _ if Instant::now() >= deadline => {
                return Err(format!(
                    "loom-server did not become healthy within {}s",
                    timeout.as_secs()
                ))
            }
            _ => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
}

/// Upserts this device's Machine registry entry so terminals/LSP resolve to
/// the local hub. The row id is persisted at <data_dir>/local-machine-id;
/// URL and key change every launch (ephemeral port + key), so an existing id
/// is PATCHed and a missing/stale id falls back to POST.
pub async fn upsert_local_machine(port: u16, key: &str, data_dir: &Path) -> Result<(), String> {
    let client = reqwest::Client::new();
    let id_path = data_dir.join(MACHINE_ID_FILE);

    if let Ok(saved) = std::fs::read_to_string(&id_path) {
        let id = saved.trim();
        if !id.is_empty() {
            let res = client
                .patch(format!("{}/api/machines/{id}", base(port)))
                .bearer_auth(key)
                .json(&patch_body(port, key))
                .send()
                .await;
            if let Ok(res) = res {
                if res.status().is_success() {
                    return Ok(());
                }
            }
            // Stale id (e.g. machine row deleted): fall through and recreate.
        }
    }

    let created: MachineResp = client
        .post(format!("{}/api/machines", base(port)))
        .bearer_auth(key)
        .json(&create_body(&device_name(), port, key))
        .send()
        .await
        .map_err(|e| format!("create local machine: {e}"))?
        .error_for_status()
        .map_err(|e| format!("create local machine: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse machine response: {e}"))?;

    std::fs::write(&id_path, &created.id).map_err(|e| format!("save machine id: {e}"))?;
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/src-tauri && cargo test hubapi`
Expected: PASS (2 tests)

- [ ] **Step 5: Integration check against the real backend**

```bash
cd backend && go run ./cmd/server --role hub --addr 127.0.0.1:0 --key itest \
  --db /tmp/loom-itest.db --open=false --2fa=false --secure-cookies=false &
sleep 2
# grab the port from the process output, then:
curl -s http://127.0.0.1:<PORT>/api/health
curl -s -X POST http://127.0.0.1:<PORT>/api/machines \
  -H "Authorization: Bearer itest" -H "Content-Type: application/json" \
  -d '{"name":"itest-device","url":"http://127.0.0.1:<PORT>","key":"itest"}'
kill %1 && rm -f /tmp/loom-itest.db
```

Expected: health returns 200; POST returns the machine JSON with an `id` — confirming the exact contract `hubapi.rs` codes against.

- [ ] **Step 6: Commit**

```bash
git add frontend/src-tauri/src/hubapi.rs frontend/src-tauri/src/lib.rs
git commit -m "feat(desktop): hub health wait and local-machine upsert"
```

---

### Task 8: Rust — `lib.rs` orchestration (spawn → ready → navigate; respawn; exit kill)

**Files:**
- Modify: `frontend/src-tauri/src/lib.rs` (replace the Task 5 stub)

**Interfaces:**
- Consumes: `sidecar::*` (Task 6), `hubapi::*` (Task 7), `tauri_plugin_shell::ShellExt` (`app.shell().sidecar("loom-server")`), `WebviewWindow::navigate/show/eval`, `RunEvent::ExitRequested`/`Exit`.
- Produces: the complete desktop runtime behavior. Dev mode (`cfg!(debug_assertions)`, i.e. `tauri dev`) skips the sidecar entirely — the window loads the Vite dev server per `devUrl` and the Go backend comes from `npm run dev`.

- [ ] **Step 1: Implement**

Replace `frontend/src-tauri/src/lib.rs`:

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

/// Current sidecar child, so app exit can kill it (kill() consumes the child).
struct ServerProc(Mutex<Option<CommandChild>>);
/// Set on ExitRequested so the monitor loop stops respawning during shutdown.
struct ShuttingDown(AtomicBool);

const MAX_RESPAWNS: u32 = 3;

enum LaunchEnd {
    /// Process exited; respawn unless shutting down or out of attempts.
    Crashed,
    /// Never became ready — navigate to the error page and stop.
    Failed(String),
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                // `tauri dev`: window already points at the Vite dev server
                // (devUrl); the Go backend comes from `npm run dev`.
                return Ok(());
            }
            app.manage(ServerProc(Mutex::new(None)));
            app.manage(ShuttingDown(AtomicBool::new(false)));
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut respawns = 0;
                loop {
                    match launch_once(&handle).await {
                        LaunchEnd::Failed(msg) => {
                            show_error(&handle, &msg);
                            break;
                        }
                        LaunchEnd::Crashed => {
                            if handle.state::<ShuttingDown>().0.load(Ordering::SeqCst) {
                                break;
                            }
                            respawns += 1;
                            if respawns > MAX_RESPAWNS {
                                show_error(&handle, "loom-server crashed repeatedly");
                                break;
                            }
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                handle.state::<ShuttingDown>().0.store(true, Ordering::SeqCst);
                if let Some(child) = handle.state::<ServerProc>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}

/// One full sidecar lifetime: spawn, wait ready, register machine, navigate,
/// then pump events until the process terminates.
async fn launch_once(handle: &AppHandle) -> LaunchEnd {
    let data_dir = match handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => return LaunchEnd::Failed(format!("resolve app data dir: {e}")),
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        return LaunchEnd::Failed(format!("create app data dir: {e}"));
    }
    let log_dir = match handle.path().app_log_dir() {
        Ok(d) => d,
        Err(e) => return LaunchEnd::Failed(format!("resolve app log dir: {e}")),
    };
    let mut log = match sidecar::open_sidecar_log(&log_dir) {
        Ok(f) => f,
        Err(e) => return LaunchEnd::Failed(format!("open sidecar log: {e}")),
    };

    let key = sidecar::generate_key();
    let cmd = match handle.shell().sidecar("loom-server") {
        Ok(c) => c.args(sidecar::sidecar_args(&data_dir, &key)),
        Err(e) => return LaunchEnd::Failed(format!("resolve sidecar binary: {e}")),
    };
    let (mut rx, child) = match cmd.spawn() {
        Ok(pair) => pair,
        Err(e) => return LaunchEnd::Failed(format!("spawn loom-server: {e}")),
    };
    *handle.state::<ServerProc>().0.lock().unwrap() = Some(child);

    // Phase 1: wait for the listen line (or early termination / timeout).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(sidecar::READY_TIMEOUT_SECS);
    let mut port: Option<u16> = None;
    while port.is_none() {
        let event = match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => return LaunchEnd::Failed("loom-server produced no listen line in time".into()),
            Ok(None) => return LaunchEnd::Crashed,
            Ok(Some(ev)) => ev,
        };
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                let _ = writeln!(log, "{}", line.trim_end());
                port = sidecar::parse_listen_port(&line);
            }
            CommandEvent::Terminated(_) => return LaunchEnd::Crashed,
            _ => {}
        }
    }
    let port = port.unwrap();

    // Phase 2: readiness + local machine registration + navigation.
    if let Err(msg) = hubapi::wait_healthy(port, Duration::from_secs(sidecar::READY_TIMEOUT_SECS)).await {
        return LaunchEnd::Failed(msg);
    }
    if let Err(msg) = hubapi::upsert_local_machine(port, &key, &data_dir).await {
        return LaunchEnd::Failed(msg);
    }
    if let Some(win) = handle.get_webview_window("main") {
        let url = format!("http://127.0.0.1:{port}/?key={key}");
        if let Err(e) = win.navigate(url.parse().expect("static loopback url")) {
            return LaunchEnd::Failed(format!("navigate to loom ui: {e}"));
        }
        let _ = win.show();
    }

    // Phase 3: pump output to the log until the process dies.
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let _ = writeln!(log, "{}", String::from_utf8_lossy(&bytes).trim_end());
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    LaunchEnd::Crashed
}

/// Sends the main window to the bundled error page with the failure message.
fn show_error(handle: &AppHandle, msg: &str) {
    let log_path = handle
        .path()
        .app_log_dir()
        .map(|d| d.join("sidecar.log").to_string_lossy().into_owned())
        .unwrap_or_else(|_| "app log directory / sidecar.log".into());
    // Bundled frontendDist pages are served on the app's custom protocol:
    // tauri://localhost on macOS/Linux, http://tauri.localhost on Windows.
    #[cfg(not(windows))]
    let error_url = "tauri://localhost/error.html";
    #[cfg(windows)]
    let error_url = "http://tauri.localhost/error.html";
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(error_url.parse().expect("static error url"));
        let _ = win.eval(format!(
            "document.getElementById('msg').textContent = {}; document.getElementById('logpath').textContent = {};",
            serde_json::to_string(msg).unwrap_or_default(),
            serde_json::to_string(&log_path).unwrap_or_default(),
        ));
        let _ = win.show();
    }
}
```

Note for the implementer: `WebviewWindow::navigate` takes a `tauri::Url` (a re-exported `url::Url`); the custom-protocol strings above serve the bundled `frontendDist` pages. The requirement is behavioral — the error page must actually render in the window during the Task 9 smoke test.

- [ ] **Step 2: Compile + tests**

Run: `cd frontend/src-tauri && cargo test && cargo check`
Expected: existing unit tests PASS; no compile errors

- [ ] **Step 3: Release build sanity**

Run: `cd frontend && npm run tauri:build`
Expected: completes; bundle produced under `frontend/src-tauri/target/release/bundle/` (macOS: `macos/Loom.app` and a `.dmg`). This also exercises `beforeBuildCommand → make prepare-sidecar`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src-tauri/src/lib.rs
git commit -m "feat(desktop): sidecar lifecycle — spawn, ready-gate, navigate, respawn, exit kill"
```

---

### Task 9: End-to-end smoke test (macOS) + web regression

**Files:** none (verification only)

- [ ] **Step 1: Launch the built app with visible logs**

```bash
/Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev/frontend/src-tauri/target/release/bundle/macos/Loom.app/Contents/MacOS/loom
```

(Binary name = whatever `Cargo.toml` `[package] name` produced; check `Contents/MacOS/`.)

Expected within ~5 s: splash → Loom dashboard, **no login screen**.

- [ ] **Step 2: Verify the core flows in the app window**

- Create a workspace and a project (the Machines page should already show one machine named after the hostname).
- Open a worktree terminal; run `echo hello` — output appears (PTY over `ws://127.0.0.1:<port>/ws/terminal?...&key=...`).
- An issue with an attachment renders its image (session-cookie `<img>` path).

- [ ] **Step 3: Verify lifecycle**

```bash
pgrep -fl loom-server        # exactly one while the app runs
# Quit the app (Cmd+Q), then:
pgrep -fl loom-server        # expected: no output — no orphaned sidecar
ls "$HOME/Library/Application Support/dev.kiyora.loom/"   # loom.db, local-machine-id
tail -5 "$HOME/Library/Logs/dev.kiyora.loom/sidecar.log"
```

- [ ] **Step 4: Relaunch persistence check**

Launch again: the same workspace/project/machine appear (DB reused; machine row PATCHed with the new port/key, count still 1 on the Machines page).

- [ ] **Step 5: Web regression**

```bash
cd backend && go test ./... && go vet ./...
cd ../frontend && npm run typecheck && npm run build
```

Expected: all clean. (Web login flow is untouched: no `?key=` → bootstrap is a no-op; `--secure-cookies` defaults to true.)

- [ ] **Step 6: Fix anything found, then commit fixes**

Any defect found here gets its own minimal fix + re-run of the failing step before moving on.

---

### Task 10: Documentation

**Files:**
- Modify: `COMMANDS.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: COMMANDS.md — Desktop section**

Append:

```markdown
## Desktop app (Tauri)

- `cd frontend && npm run tauri:dev` — desktop shell in dev mode: builds the
  host-triple sidecar (`make sidecar-host`, required or tauri-build fails),
  then opens a window on the Vite dev server (normal login; sidecar flow is
  release-only).
- `cd frontend && npm run tauri:build` — full release build: web UI →
  embedded into the Go sidecars (`make prepare-sidecar`, 3 target triples) →
  platform bundles under `frontend/src-tauri/target/release/bundle/`.
- Desktop data lives in the app-data dir (macOS:
  `~/Library/Application Support/dev.kiyora.loom/` — `loom.db`, `.env`,
  `local-machine-id`); sidecar logs in the app log dir (`sidecar.log`).
```

- [ ] **Step 2: ARCHITECTURE.md — Desktop subsection**

Add a short subsection under the deployment/architecture area:

```markdown
### Desktop (Tauri sidecar)

`frontend/src-tauri/` wraps the app for macOS/Windows/Linux: the Rust shell
spawns the Go binary as a sidecar hub (`--addr 127.0.0.1:0`, ephemeral
`--key`), parses the bound port from the listen line, upserts a local
Machine entry (terminals need one), and points the webview at the sidecar's
embedded UI with `?key=`, which `main.tsx` exchanges for a session cookie via
`POST /api/auth/key-session`. Spec:
`docs/superpowers/specs/2026-07-13-tauri-desktop-sidecar-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add COMMANDS.md ARCHITECTURE.md
git commit -m "docs: desktop (Tauri sidecar) commands and architecture notes"
```

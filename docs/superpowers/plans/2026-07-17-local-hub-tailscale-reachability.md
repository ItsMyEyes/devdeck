# Local-Hub Tailscale Reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop app's "Host locally" hub mode show a runtime-connect command that actually works, and give the operator clear in-dialog guidance when Tailscale isn't set up yet.

**Architecture:** A Rust-side preflight (reusing the existing `tailscale::public_url()` check) decides whether the local-hub sidecar is launched with `--enable-tailscale-serve`, avoiding the flag's fatal-on-missing-binary crash. A new Go `GET /api/tailscale-status` endpoint reports live readiness for whatever machine the hub process runs on. `MachineDialog.tsx` queries that endpoint only when its own origin is a loopback address, and swaps its "Runtime command" section for install/sign-in/restart guidance when not ready.

**Tech Stack:** Rust (Tauri v2, `tauri-plugin-shell`), Go 1.22+ (`net/http`, `os/exec`), React 19 + TanStack Query.

## Global Constraints

- Never edit `frontend/src/routeTree.gen.ts`. (Not touched by this plan.)
- All API responses use the existing `{"error":"message"}` envelope for *errors*; this endpoint never errors — every outcome (including "not installed") is `200` with a structured body (per the spec's Error handling section).
- Frontend imports use the `@/*` alias; never relative paths into `src/`.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Go handlers use `writeJSON`/`handleStoreErr` conventions from `internal/handler`; this handler has no store dependency so only `writeJSON` applies.
- Run `cd frontend && npm run typecheck`, `cd backend && go vet ./...` before considering any task done.
- `backend/cmd/server/main.go` is a listed convergence file (see root `CLAUDE.md`) — Task 2 is the only task that touches it; do not parallelize edits to it.

---

### Task 1: Rust — gate `--enable-tailscale-serve` for the local hub

**Files:**
- Modify: `frontend/src-tauri/src/sidecar.rs` (`sidecar_args` function, lines 25-36, and its test at lines 133-144)
- Modify: `frontend/src-tauri/src/lib.rs` (`launch_once`, lines 466-470)

**Interfaces:**
- Consumes: `tailscale::public_url() -> Result<String, String>` (already exists, unchanged, `frontend/src-tauri/src/tailscale.rs:36`).
- Produces: `sidecar::sidecar_args(data_dir: &Path, key: &str, enable_tailscale_serve: bool) -> Vec<String>` — the new third parameter. No other task in this plan calls `sidecar_args`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src-tauri/src/sidecar.rs`, replace the existing `args_carry_the_desktop_contract` test (it currently calls `sidecar_args` with only two arguments, which won't compile once Step 3 lands) and add a new test for the flag:

```rust
    #[test]
    fn args_carry_the_desktop_contract() {
        let args = sidecar_args(Path::new("/data"), "k0", false);
        let joined = args.join(" ");
        assert!(joined.contains("--role hub"));
        assert!(joined.contains("--addr 127.0.0.1:0"));
        assert!(joined.contains("--key k0"));
        assert!(joined.contains("--open=false"));
        assert!(joined.contains("--2fa=false"));
        assert!(joined.contains("--secure-cookies=false"));
        assert!(joined.contains("loom.db"));
        assert!(!joined.contains("--enable-tailscale-serve"));
    }

    #[test]
    fn args_include_tailscale_serve_flag_when_enabled() {
        let args = sidecar_args(Path::new("/data"), "k0", true);
        assert!(args.join(" ").contains("--enable-tailscale-serve"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend/src-tauri && cargo test sidecar`
Expected: FAIL to compile — `this function takes 3 arguments but 2 arguments were supplied` (from the untouched `sidecar_args` definition) and `sidecar_args` doesn't accept a third argument yet.

- [ ] **Step 3: Implement — extend `sidecar_args`**

In `frontend/src-tauri/src/sidecar.rs`, replace the existing function:

```rust
/// loom-server args for desktop-sidecar mode. `--addr 127.0.0.1:0` makes the
/// OS pick the port; parse_listen_port recovers it from the startup log line
/// (the contract is marked with a NOTE next to the log.Printf in
/// backend/cmd/server/main.go). `enable_tailscale_serve` is true only when a
/// preflight `tailscale::public_url()` check already succeeded — passing
/// `--enable-tailscale-serve` when the tailscale binary is missing is fatal
/// on the Go side (see docs/superpowers/specs/2026-07-04-enable-tailscale-serve-design.md).
pub fn sidecar_args(data_dir: &Path, key: &str, enable_tailscale_serve: bool) -> Vec<String> {
    let mut args = vec![
        "--role".into(), "hub".into(),
        "--addr".into(), "127.0.0.1:0".into(),
        "--key".into(), key.into(),
        "--db".into(), data_dir.join("loom.db").to_string_lossy().into_owned(),
        "--env".into(), data_dir.join(".env").to_string_lossy().into_owned(),
        "--open=false".into(),
        "--2fa=false".into(),
        "--secure-cookies=false".into(),
    ];
    if enable_tailscale_serve {
        args.push("--enable-tailscale-serve".into());
    }
    args
}
```

- [ ] **Step 4: Update the call site in `lib.rs`**

In `frontend/src-tauri/src/lib.rs`, `launch_once` currently reads:

```rust
    let key = sidecar::generate_key();
    let cmd = match handle.shell().sidecar("loom-server") {
        Ok(c) => c.args(sidecar::sidecar_args(&data_dir, &key)),
        Err(e) => return LaunchEnd::Failed(format!("resolve sidecar binary: {e}")),
    };
```

Replace it with:

```rust
    let key = sidecar::generate_key();
    // Non-blocking preflight: if Tailscale isn't installed/logged in, the
    // local hub still starts (local-only) — see
    // docs/superpowers/specs/2026-07-17-local-hub-tailscale-reachability-design.md.
    let enable_tailscale_serve = tailscale::public_url().await.is_ok();
    let cmd = match handle.shell().sidecar("loom-server") {
        Ok(c) => c.args(sidecar::sidecar_args(&data_dir, &key, enable_tailscale_serve)),
        Err(e) => return LaunchEnd::Failed(format!("resolve sidecar binary: {e}")),
    };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend/src-tauri && cargo test sidecar`
Expected: PASS — `args_carry_the_desktop_contract` and `args_include_tailscale_serve_flag_when_enabled` both green.

Run: `cd frontend/src-tauri && cargo build`
Expected: builds cleanly (confirms `lib.rs`'s new call site compiles against the changed signature).

- [ ] **Step 6: Commit**

```bash
git add frontend/src-tauri/src/sidecar.rs frontend/src-tauri/src/lib.rs
git commit -m "feat(desktop): gate --enable-tailscale-serve on a Tailscale preflight for the local hub"
```

---

### Task 2: Go — `GET /api/tailscale-status` endpoint

**Files:**
- Create: `backend/internal/handler/tailscale_status.go`
- Create: `backend/internal/handler/tailscale_status_test.go`
- Modify: `backend/cmd/server/main.go` (handler construction near line 219-220, route registration near line 287-288)

**Interfaces:**
- Produces: `handler.NewTailscaleStatusHandler(tailscaleServeEnabled bool) *TailscaleStatusHandler`, whose `ServeHTTP` writes a JSON body shaped `{ready: bool, reason?: "not_installed"|"not_ready"|"serve_disabled", url?: string}`. Task 3 (frontend `fetchTailscaleStatus`) hard-codes this exact shape and must match it field-for-field.
- Consumes: `writeJSON(w http.ResponseWriter, status int, v any)` (existing helper already used by `backend/internal/handler/health.go`).

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/handler/tailscale_status_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func writeFakeTailscale(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "tailscale")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatalf("write fake tailscale: %v", err)
	}
	t.Setenv("PATH", dir)
}

func getTailscaleStatus(t *testing.T, h *TailscaleStatusHandler) tailscaleStatusResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/tailscale-status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var resp tailscaleStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}

func TestTailscaleStatusServeDisabled(t *testing.T) {
	h := NewTailscaleStatusHandler(false)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "serve_disabled" {
		t.Fatalf("got %+v, want reason=serve_disabled", resp)
	}
}

func TestTailscaleStatusNotInstalled(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // empty dir: `tailscale` isn't on PATH
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "not_installed" {
		t.Fatalf("got %+v, want reason=not_installed", resp)
	}
}

func TestTailscaleStatusNotReadyOnNonZeroExit(t *testing.T) {
	writeFakeTailscale(t, "exit 1\n")
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "not_ready" {
		t.Fatalf("got %+v, want reason=not_ready", resp)
	}
}

func TestTailscaleStatusNotReadyOnEmptyDNSName(t *testing.T) {
	writeFakeTailscale(t, `echo '{"Self":{"DNSName":""}}'`+"\n")
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if resp.Ready || resp.Reason != "not_ready" {
		t.Fatalf("got %+v, want reason=not_ready", resp)
	}
}

func TestTailscaleStatusReady(t *testing.T) {
	writeFakeTailscale(t, `echo '{"Self":{"DNSName":"my-mac.tail1234.ts.net."}}'`+"\n")
	h := NewTailscaleStatusHandler(true)
	resp := getTailscaleStatus(t, h)
	if !resp.Ready || resp.URL != "https://my-mac.tail1234.ts.net" {
		t.Fatalf("got %+v, want ready with trimmed https URL", resp)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run TestTailscaleStatus -v`
Expected: FAIL to compile — `undefined: NewTailscaleStatusHandler`, `undefined: TailscaleStatusHandler`, `undefined: tailscaleStatusResponse`.

- [ ] **Step 3: Implement the handler**

Create `backend/internal/handler/tailscale_status.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
)

// TailscaleStatusHandler answers whether this hub process is currently
// reachable on the operator's tailnet, so MachineDialog can decide what
// --hub-url to show when its own origin is a loopback address (desktop
// "Host locally" mode). See
// docs/superpowers/specs/2026-07-17-local-hub-tailscale-reachability-design.md.
type TailscaleStatusHandler struct {
	// tailscaleServeEnabled mirrors main.go's *tailscaleServe flag — even a
	// fully working Tailscale install doesn't help until this process is
	// restarted with --enable-tailscale-serve on.
	tailscaleServeEnabled bool
}

// NewTailscaleStatusHandler creates a tailscale-status handler.
func NewTailscaleStatusHandler(tailscaleServeEnabled bool) *TailscaleStatusHandler {
	return &TailscaleStatusHandler{tailscaleServeEnabled: tailscaleServeEnabled}
}

type tailscaleStatusResponse struct {
	Ready  bool   `json:"ready"`
	Reason string `json:"reason,omitempty"`
	URL    string `json:"url,omitempty"`
}

type tailscaleSelfStatus struct {
	Self struct {
		DNSName string `json:"DNSName"`
	} `json:"Self"`
}

func (h *TailscaleStatusHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.tailscaleServeEnabled {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Reason: "serve_disabled"})
		return
	}
	url, reason := tailscaleSelfURL()
	if reason != "" {
		writeJSON(w, http.StatusOK, tailscaleStatusResponse{Reason: reason})
		return
	}
	writeJSON(w, http.StatusOK, tailscaleStatusResponse{Ready: true, URL: url})
}

// tailscaleSelfURL runs `tailscale status --self --json` and derives this
// device's tailnet-reachable URL, mirroring
// frontend/src-tauri/src/tailscale.rs's parse_dns_name/public_url.
func tailscaleSelfURL() (url string, reason string) {
	bin, err := exec.LookPath("tailscale")
	if err != nil {
		return "", "not_installed"
	}
	out, err := exec.Command(bin, "status", "--self", "--json").Output()
	if err != nil {
		return "", "not_ready"
	}
	var status tailscaleSelfStatus
	if err := json.Unmarshal(out, &status); err != nil {
		return "", "not_ready"
	}
	dns := strings.TrimSuffix(status.Self.DNSName, ".")
	if dns == "" {
		return "", "not_ready"
	}
	return "https://" + dns, ""
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/... -run TestTailscaleStatus -v`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Wire the route into `main.go`**

In `backend/cmd/server/main.go`, near the existing handler construction (around line 219-220):

```go
	healthH := handler.NewHealthHandler()
	whoamiH := handler.NewWhoamiHandler()
```

becomes:

```go
	healthH := handler.NewHealthHandler()
	whoamiH := handler.NewWhoamiHandler()
	tailscaleStatusH := handler.NewTailscaleStatusHandler(*tailscaleServe)
```

And near the existing route registration (around line 287-288):

```go
	mux.HandleFunc("GET /api/health", healthH.ServeHTTP)
	mux.HandleFunc("GET /api/whoami", whoamiH.ServeHTTP)
```

becomes:

```go
	mux.HandleFunc("GET /api/health", healthH.ServeHTTP)
	mux.HandleFunc("GET /api/whoami", whoamiH.ServeHTTP)
	mux.HandleFunc("GET /api/tailscale-status", tailscaleStatusH.ServeHTTP)
```

This falls under the same blanket `authMW(mux)` wrapping as every other `/api` route (`main.go:450-457`) — no further changes needed for auth.

- [ ] **Step 6: Run go vet and the full handler test package**

Run: `cd backend && go vet ./...`
Expected: no output (clean).

Run: `cd backend && go build ./...`
Expected: builds cleanly (confirms `main.go`'s new call sites compile).

Run: `cd backend && go test ./internal/handler/... -v`
Expected: PASS, including the 5 new tests and all pre-existing handler tests (no regressions).

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handler/tailscale_status.go backend/internal/handler/tailscale_status_test.go backend/cmd/server/main.go
git commit -m "feat(hub): add GET /api/tailscale-status readiness endpoint"
```

---

### Task 3: Frontend data layer — `fetchTailscaleStatus` + query hook

**Files:**
- Modify: `frontend/src/lib/api.ts` (add type + fetch function near the existing Machines section, around line 620-657)
- Modify: `frontend/src/features/data/keys.ts` (add one query key)
- Modify: `frontend/src/features/data/queries.ts` (add one query hook + imports)

**Interfaces:**
- Consumes: `request<T>(method, path)` from `frontend/src/lib/api.ts` (existing, unchanged).
- Produces: `TailscaleHubStatus` type (`{ready: boolean; reason?: 'not_installed' | 'not_ready' | 'serve_disabled'; url?: string}`), `fetchTailscaleStatus(): Promise<TailscaleHubStatus>`, `useTailscaleStatus(enabled: boolean)` returning a TanStack Query result with `.data?: TailscaleHubStatus`. Task 4 consumes all three by these exact names.

- [ ] **Step 1: Add the type and fetch function**

In `frontend/src/lib/api.ts`, find the existing Machines section (`fetchMachineHealth`/`MachineHealth`, around line 620-657) and add directly below `fetchMachineHealth`:

```ts
export interface TailscaleHubStatus {
  ready: boolean
  reason?: 'not_installed' | 'not_ready' | 'serve_disabled'
  url?: string
}

export function fetchTailscaleStatus(): Promise<TailscaleHubStatus> {
  return request<TailscaleHubStatus>('GET', '/tailscale-status')
}
```

- [ ] **Step 2: Add the query key**

In `frontend/src/features/data/keys.ts`, next to the existing `machineHealth` key, add:

```ts
  tailscaleStatus: ['tailscaleStatus'] as const,
```

- [ ] **Step 3: Add the query hook**

In `frontend/src/features/data/queries.ts`:

1. Add `fetchTailscaleStatus` to the existing `import { ... } from '@/lib/api'` block (alphabetical, next to `fetchSettings`/`fetchSSHConnections`).
2. Add `type TailscaleHubStatus` to the existing `import type { ... } from '@/lib/api'` block (alphabetical).
3. Add the hook next to `useMachineHealth` (after line 210):

```ts
/** Only meaningful when the current page origin is a loopback address
 *  (desktop "Host locally" mode) — MachineDialog gates `enabled` on that
 *  check itself. See
 *  docs/superpowers/specs/2026-07-17-local-hub-tailscale-reachability-design.md. */
export function useTailscaleStatus(enabled: boolean) {
  return useQuery({
    queryKey: qk.tailscaleStatus,
    queryFn: fetchTailscaleStatus,
    enabled,
    staleTime: 5_000,
  })
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (No test runner exists for this file today — `queries.ts`/`api.ts` have no existing `*.test.ts` siblings in this codebase; typecheck plus Task 4's manual verification is the coverage for this layer, consistent with how `useMachineHealth` itself has no dedicated test.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts
git commit -m "feat(machines): add tailscale-status query hook"
```

---

### Task 4: Frontend — `MachineDialog.tsx` guidance UI

**Files:**
- Modify: `frontend/src/features/machines/MachineDialog.tsx`

**Interfaces:**
- Consumes: `useTailscaleStatus(enabled: boolean)`, `TailscaleHubStatus` (both from Task 3, `@/features/data/queries` and `@/lib/api` respectively).

- [ ] **Step 1: Update imports**

At the top of `frontend/src/features/machines/MachineDialog.tsx`, add to the existing `useCreateMachine, useUpdateMachine` import from `@/features/data/queries`:

```tsx
import { useCreateMachine, useTailscaleStatus, useUpdateMachine } from '@/features/data/queries'
```

Add a new type-only import:

```tsx
import type { TailscaleHubStatus } from '@/lib/api'
```

- [ ] **Step 2: Fix `runtimeCommand` to take an explicit hub URL, and fix the pre-existing stray `}` typo**

Replace:

```tsx
function runtimeCommand(key: string): string {
  const hubUrl = window.location.origin
  return [
    `./loom.exe --role runtime --key ${key} --addr 0.0.0.0:9199 --db runtime.db --open=false \\`,
    `  --hub-url ${hubUrl} --hub-key <your-hub-key>}`,
  ].join('\n')
}
```

With:

```tsx
function runtimeCommand(key: string, hubUrl: string): string {
  return [
    `./loom.exe --role runtime --key ${key} --addr 0.0.0.0:9199 --db runtime.db --open=false \\`,
    `  --hub-url ${hubUrl} --hub-key <your-hub-key>`,
  ].join('\n')
}
```

- [ ] **Step 3: Add a pure copy-text helper for the three not-ready reasons**

Add this function above the `MachineDialog` component, below `runtimeCommand`:

```tsx
function tailscaleGuidance(reason: TailscaleHubStatus['reason']): {
  title: string
  body: string
  copyLabel?: string
  copyValue?: string
} {
  switch (reason) {
    case 'not_installed':
      return {
        title: "Tailscale isn't installed on this machine",
        body: 'Remote runtimes reach this hub over your tailnet. Install Tailscale here, then restart Loom.',
        copyLabel: 'Copy Tailscale download link',
        copyValue: 'https://tailscale.com/download',
      }
    case 'not_ready':
      return {
        title: "Tailscale isn't signed in",
        body: "Open Tailscale (or run `tailscale up` in a terminal) and sign in with the same account you'll use on your runtime machines.",
      }
    case 'serve_disabled':
    default:
      return {
        title: 'Restart Loom to expose this hub',
        body: 'Tailscale looks ready, but this hub was started before it was set up. Restart Loom to pick it up.',
      }
  }
}
```

- [ ] **Step 4: Compute loopback state and query status inside the component**

Inside `MachineDialog`, the existing code has, in order: `dialog`/`setDialog`/`close`/`showToast`/`updateMachine`/`createMachine`, then `isEdit`/`busy`/`canSubmit`, then `useState` for `runtimeKey`/`pasteMode`/`pasteText`, then a `useEffect` resetting them on open, then `const parsedPaste = ...`. Insert the new block **after that `useEffect` block, immediately before `const parsedPaste = ...`** — it needs both `isEdit` and `pasteMode`, which aren't in scope any earlier:

```tsx
  const isLoopbackHub = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
  const wantsTailscaleStatus = dialog.open && !isEdit && !pasteMode && isLoopbackHub
  const tailscaleStatus = useTailscaleStatus(wantsTailscaleStatus)
  const resolvedHubUrl = isLoopbackHub ? tailscaleStatus.data?.url : window.location.origin
  const tailscaleNotReady =
    isLoopbackHub && tailscaleStatus.data && !tailscaleStatus.data.ready
      ? tailscaleGuidance(tailscaleStatus.data.reason)
      : null
```

- [ ] **Step 5: Use `resolvedHubUrl` in `copyCommand`**

Replace:

```tsx
  function copyCommand() {
    void navigator.clipboard.writeText(runtimeCommand(runtimeKey))
    toast.success('Command copied')
  }
```

With:

```tsx
  function copyCommand() {
    void navigator.clipboard.writeText(runtimeCommand(runtimeKey, resolvedHubUrl ?? window.location.origin))
    toast.success('Command copied')
  }

  function copyTailscaleLink(value: string) {
    void navigator.clipboard.writeText(value)
    toast.success('Link copied')
  }
```

- [ ] **Step 6: Branch the "Runtime command" section**

The current non-edit, non-paste-mode branch reads:

```tsx
      ) : (
        <>
          <Label>Runtime command</Label>
          <p className="mb-2 font-mono text-[10.5px] text-loom-dim-2">
            Run this on the target runtime — replace &lt;your-hub-key&gt; and &lt;hostname&gt;. It self-registers with
            this hub on startup.
          </p>
          <div className="relative mb-5 rounded-lg border border-loom-border-card bg-loom-terminal p-2.5 pr-9">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-loom-fg">
              {runtimeCommand(runtimeKey)}
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
```

Replace it with:

```tsx
      ) : tailscaleNotReady ? (
        <div className="mb-5 rounded-lg border border-loom-border-card bg-loom-terminal p-3">
          <p className="mb-1 font-mono text-[11px] text-loom-fg">{tailscaleNotReady.title}</p>
          <p className="mb-2 font-mono text-[10.5px] text-loom-dim-2">{tailscaleNotReady.body}</p>
          {tailscaleNotReady.copyValue ? (
            <button
              type="button"
              onClick={() => copyTailscaleLink(tailscaleNotReady.copyValue!)}
              className="cursor-pointer font-mono text-[10.5px] text-loom-accent-soft underline decoration-dotted"
            >
              {tailscaleNotReady.copyLabel}
            </button>
          ) : null}
        </div>
      ) : isLoopbackHub && tailscaleStatus.isLoading ? (
        <p className="mb-5 font-mono text-[10.5px] text-loom-dim-2">Checking Tailscale…</p>
      ) : (
        <>
          <Label>Runtime command</Label>
          <p className="mb-2 font-mono text-[10.5px] text-loom-dim-2">
            Run this on the target runtime — replace &lt;your-hub-key&gt; and &lt;hostname&gt;. It self-registers with
            this hub on startup.
          </p>
          <div className="relative mb-5 rounded-lg border border-loom-border-card bg-loom-terminal p-2.5 pr-9">
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-loom-fg">
              {runtimeCommand(runtimeKey, resolvedHubUrl ?? window.location.origin)}
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
```

- [ ] **Step 7: Hide the footer's "Copy command" button when there's nothing copyable**

The footer currently reads:

```tsx
        ) : (
          <Button onClick={copyCommand}>
            <Copy size={13} />
            Copy command
          </Button>
        )}
```

Replace with:

```tsx
        ) : tailscaleNotReady || (isLoopbackHub && tailscaleStatus.isLoading) ? null : (
          <Button onClick={copyCommand}>
            <Copy size={13} />
            Copy command
          </Button>
        )}
```

- [ ] **Step 8: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Manual verification**

There is no existing test harness for this component (no `MachineDialog.test.tsx` sibling in the codebase). Verify manually:

1. Note `isLoopbackHub` is true for both `127.0.0.1` and `localhost`, so plain `make dev`/`make dev-hub` (Vite on `localhost:5173`) now also exercises the new query path — this is correct, not a regression: a Vite dev server is just as unreachable from another machine as the desktop app's loopback port. Confirm this by opening Machines → Add runtime under `make dev` and checking the Network tab for a `GET /api/tailscale-status` request. Then confirm the *non-loopback* path is unaffected by visiting the dev server via a LAN IP or hostname instead (e.g. `http://<your-machine's-LAN-IP>:5173`) — Add runtime should show the plain runtime command immediately with no `/api/tailscale-status` request, exactly as before this change.
2. `make dev-tauri-full` in "Host locally" mode on a machine without Tailscale installed — confirm Add-runtime shows the "Tailscale isn't installed" prompt, and "Copy Tailscale download link" copies the correct URL.
3. Same, on a machine with Tailscale installed and logged in — confirm the app needed a restart after Tailscale was set up (`serve_disabled` before restart) and shows a working `https://<device>.<tailnet>.ts.net` command after restart.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/machines/MachineDialog.tsx
git commit -m "feat(machines): guide desktop operators through Tailscale setup in MachineDialog"
```

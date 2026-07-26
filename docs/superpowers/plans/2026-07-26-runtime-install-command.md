# Add-runtime Install Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Add-runtime dialog's unusable placeholder command with a real copy-pasteable `curl` / `wget` / PowerShell one-liner that installs the DevDeck binary on a target machine and self-registers it with this hub.

**Architecture:** A new hub-only `GET /api/self/hub-key` endpoint supplies the one value the browser cannot know. A pure TypeScript builder turns that key, the resolved hub URL, the machine name, and an operator-supplied GitHub token into a correctly shell-quoted command. A new `RuntimeInstallCommand` component owns the target toggle, the token field, and every load/error state; `MachineDialog` just renders it.

**Tech Stack:** Go 1.25 (stdlib `net/http`), React 19, TypeScript 5.7, `@tanstack/react-query`, Tailwind v4, `lucide-react`, `sonner`.

**Spec:** `docs/superpowers/specs/2026-07-26-runtime-install-command-design.md` — read it before starting.

## Global Constraints

- Go: follow `.claude/rules/go.md`. Handlers return void and write via `writeJSON()` / `writeErr()`. Logger is stdlib `log`. Run `go vet ./...` before committing.
- All API responses use the `{"error":"message"}` envelope. Never change that shape (`CONTRACTS.md`).
- Frontend: follow `.claude/rules/frontend.md`. Imports use the `@/*` alias — **never** relative paths into `src/`. `verbatimModuleSyntax` is on, so type-only imports must use `import type`.
- Server state goes in `@tanstack/react-query` (`src/features/data/queries.ts`), cache keys in `src/features/data/keys.ts`, HTTP calls in `src/lib/api.ts`.
- Icons from `lucide-react` only. Toasts via `sonner`. Design is dark-only — use the existing `devdeck-*` CSS custom properties, and copy class patterns from the surrounding `MachineDialog.tsx` markup rather than inventing new ones.
- Every data surface renders explicit loading, error, and empty states.
- **There is no test runner in the frontend.** Tests are standalone scripts run with `npx tsx <file>`, following `frontend/src/features/machines/connectionString.test.ts` exactly: a `check()` helper, an `assertEqual()` helper, and a pass count printed at the end.
- Never hand-edit `frontend/src/routeTree.gen.ts`.
- The install base URL is `https://kiyora.is-a.dev/devdeck` and the scripts are `install.sh` and `install.ps1`, matching `scripts/README.md`.
- Env var names in the generated command must be exactly `GITHUB_TOKEN`, `DEVDECK_HUB_URL`, `DEVDECK_HUB_KEY`, `DEVDECK_MACHINE_NAME` — these are read by `scripts/install.sh` and `backend/cmd/server/main.go`.
- The GitHub token is **never** sent to the server, never persisted, and never logged. It exists only to compose the displayed string.

---

### Task 1: `GET /api/self/hub-key`

**Files:**
- Create: `backend/internal/handler/hubkey.go`
- Create: `backend/internal/handler/hubkey_test.go`
- Modify: `backend/cmd/server/main.go:292` (handler construction) and `backend/cmd/server/main.go:501` (route registration)

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /api/self/hub-key` returning `{"configured": bool, "key": string}` with a `Cache-Control: no-store` header. Task 3's `fetchHubKey()` deserializes exactly these two fields.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/handler/hubkey_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHubKeyHandlerConfigured(t *testing.T) {
	h := NewHubKeyHandler("hub-secret-key")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/self/hub-key", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body struct {
		Configured bool   `json:"configured"`
		Key        string `json:"key"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.Configured {
		t.Error("configured = false, want true when the hub was started with --key")
	}
	if body.Key != "hub-secret-key" {
		t.Errorf("key = %q, want %q", body.Key, "hub-secret-key")
	}
}

// A hub started without --key cannot accept self-registration at all. Saying
// so lets the dialog explain the problem instead of handing the operator a
// command that fails with a 401 on the target machine.
func TestHubKeyHandlerNotConfigured(t *testing.T) {
	h := NewHubKeyHandler("")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/self/hub-key", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body struct {
		Configured bool   `json:"configured"`
		Key        string `json:"key"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Configured {
		t.Error("configured = true, want false when no --key was set")
	}
	if body.Key != "" {
		t.Errorf("key = %q, want an empty string when unconfigured", body.Key)
	}
}

// The response carries a long-lived credential, so it must not sit in any
// intermediary or browser cache.
func TestHubKeyHandlerSetsNoStore(t *testing.T) {
	for _, key := range []string{"hub-secret-key", ""} {
		rec := httptest.NewRecorder()
		NewHubKeyHandler(key).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/self/hub-key", nil))
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Errorf("Cache-Control = %q for key %q, want %q", got, key, "no-store")
		}
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run TestHubKey -v`
Expected: FAIL — `undefined: NewHubKeyHandler`.

- [ ] **Step 3: Write the minimal implementation**

Create `backend/internal/handler/hubkey.go`:

```go
package handler

import "net/http"

// HubKeyHandler hands this hub's own bearer key to an authenticated caller so
// the Add-runtime dialog can build a copy-pasteable install command. See
// docs/superpowers/specs/2026-07-26-runtime-install-command-design.md.
//
// Registered only on --role hub and --role both (main.go) — a pure runtime has
// no hub key to hand out. The key is a long-lived credential, so the response
// is marked no-store and the key is never logged. A bearer-key caller had to
// present this same key to get past RequireAuth, so it learns nothing new; a
// cookie-session caller is the operator.
type HubKeyHandler struct {
	hubKey string
}

// NewHubKeyHandler creates a hub-key handler. hubKey is main.go's --key value,
// which is empty when the hub was started without one.
func NewHubKeyHandler(hubKey string) *HubKeyHandler {
	return &HubKeyHandler{hubKey: hubKey}
}

type hubKeyResponse struct {
	Configured bool   `json:"configured"`
	Key        string `json:"key"`
}

// ServeHTTP reports the hub key, or configured:false when this hub has none.
func (h *HubKeyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if h.hubKey == "" {
		writeJSON(w, http.StatusOK, hubKeyResponse{})
		return
	}
	writeJSON(w, http.StatusOK, hubKeyResponse{Configured: true, Key: h.hubKey})
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && go test ./internal/handler/ -run TestHubKey -v`
Expected: PASS — all three tests.

- [ ] **Step 5: Register the route**

In `backend/cmd/server/main.go`, next to the other handler constructors (immediately after the `selfH := handler.NewSelfHandler(managed)` line), add:

```go
	hubKeyH := handler.NewHubKeyHandler(*apiKey)
```

Then, inside the existing `if !isRuntime {` block that registers the machines routes (the one beginning `mux.HandleFunc("GET /api/machines", machineH.GetMachines)`), add as the first line of that block:

```go
		// Hub-only: a runtime has no hub key to hand out. Lives with the
		// machines routes because its only consumer is the Add-runtime
		// dialog. Not in RequireAuth's publicPaths, so it stays behind the
		// session-cookie/bearer-key check.
		mux.HandleFunc("GET /api/self/hub-key", hubKeyH.ServeHTTP)
```

`!isRuntime` is true for both `--role hub` and `--role both`, which is exactly the intended set.

- [ ] **Step 6: Verify the whole backend**

Run: `cd backend && go build ./... && go test ./... 2>&1 | grep -E "^(FAIL|ok +devdeck/backend/internal/handler)" && go vet ./...`
Expected: the handler package reports `ok`, no `FAIL` lines, no vet output.

Confirm the route is registered only for the right roles by reading the diff:

Run: `git diff backend/cmd/server/main.go`
Expected: the `mux.HandleFunc("GET /api/self/hub-key", ...)` line sits inside an `if !isRuntime {` block.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/handler/hubkey.go backend/internal/handler/hubkey_test.go backend/cmd/server/main.go
git commit -m "feat(api): add GET /api/self/hub-key for the Add-runtime dialog

The dialog needs a real DEVDECK_HUB_KEY to build a copy-pasteable
install command, and the browser cannot know it. Hub and both roles
only; a pure runtime has no hub key to hand out. Reports
configured:false rather than erroring when the hub was started without
--key, so the UI can explain that instead of emitting a command that
401s on the target machine."
```

---

### Task 2: `buildInstallCommand`

**Files:**
- Create: `frontend/src/features/machines/installCommand.ts`
- Create: `frontend/src/features/machines/installCommand.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, for Task 4:
  - `type InstallTarget = 'curl' | 'wget' | 'powershell'`
  - `interface InstallCommandInput { target: InstallTarget; hubUrl: string; hubKey: string; machineName: string; githubToken: string }`
  - `function buildInstallCommand(input: InstallCommandInput): string`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/machines/installCommand.test.ts`:

```ts
/**
 * Plain assertion-based tests for installCommand.ts.
 *
 * No test runner (Vitest/Jest) is configured in this frontend project, so
 * this is a standalone script: every `check()` call throws on failure,
 * `main()` runs them all and prints a pass count. Run manually with:
 *
 *   npx tsx src/features/machines/installCommand.test.ts
 */

import { buildInstallCommand } from './installCommand'

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

function assertContains(haystack: string, needle: string, message: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`assertion failed: ${message} (expected to find ${JSON.stringify(needle)} in ${JSON.stringify(haystack)})`)
  }
}

const full = {
  hubUrl: 'https://hub.tail-x.ts.net',
  hubKey: 'a1b2c3',
  machineName: 'builder',
  githubToken: 'ghp_xxx',
}

check('curl command has the expected shape', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl' })
  assertContains(cmd, 'curl -fsSL https://kiyora.is-a.dev/devdeck/install.sh |', 'curl fetcher')
  assertContains(cmd, "GITHUB_TOKEN='ghp_xxx'", 'token env')
  assertContains(cmd, "DEVDECK_HUB_URL='https://hub.tail-x.ts.net'", 'hub url env')
  assertContains(cmd, "DEVDECK_HUB_KEY='a1b2c3'", 'hub key env')
  assertContains(cmd, "DEVDECK_MACHINE_NAME='builder' sh", 'name env and shell')
})

check('wget command swaps only the fetcher', () => {
  const cmd = buildInstallCommand({ ...full, target: 'wget' })
  assertContains(cmd, 'wget -qO- https://kiyora.is-a.dev/devdeck/install.sh |', 'wget fetcher')
  assertContains(cmd, "DEVDECK_MACHINE_NAME='builder' sh", 'name env and shell')
  if (cmd.includes('curl')) throw new Error('assertion failed: wget command must not mention curl')
})

check('powershell command uses $env: assignments and irm | iex', () => {
  const cmd = buildInstallCommand({ ...full, target: 'powershell' })
  assertContains(cmd, "$env:GITHUB_TOKEN='ghp_xxx'", 'token env')
  assertContains(cmd, "$env:DEVDECK_HUB_URL='https://hub.tail-x.ts.net'", 'hub url env')
  assertContains(cmd, "$env:DEVDECK_HUB_KEY='a1b2c3'", 'hub key env')
  assertContains(cmd, "$env:DEVDECK_MACHINE_NAME='builder'", 'name env')
  assertContains(cmd, 'irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex', 'ps1 invocation')
  if (cmd.includes('\n')) throw new Error('assertion failed: the powershell command must be a single line')
})

check('empty values fall back to placeholders', () => {
  const cmd = buildInstallCommand({
    target: 'curl',
    hubUrl: '',
    hubKey: '',
    machineName: '',
    githubToken: '',
  })
  assertContains(cmd, "GITHUB_TOKEN='<github-token>'", 'token placeholder')
  assertContains(cmd, "DEVDECK_HUB_URL='<hub-url>'", 'hub url placeholder')
  assertContains(cmd, "DEVDECK_HUB_KEY='<your-hub-key>'", 'hub key placeholder')
  assertContains(cmd, "DEVDECK_MACHINE_NAME='<name>'", 'name placeholder')
})

check('whitespace-only values fall back to placeholders too', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', machineName: '   ' })
  assertContains(cmd, "DEVDECK_MACHINE_NAME='<name>'", 'blank name placeholder')
})

// Machine names are free text. Unquoted, "my box" would split into two
// arguments and the install would register the wrong name — or fail outright.
check('a name with a space stays a single POSIX argument', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', machineName: 'my box' })
  assertContains(cmd, "DEVDECK_MACHINE_NAME='my box' sh", 'quoted name')
})

// An apostrophe terminates a POSIX single-quoted run, so it has to be closed,
// escaped, and reopened.
check("a name with an apostrophe is escaped for POSIX", () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', machineName: "o'brien" })
  assertContains(cmd, `DEVDECK_MACHINE_NAME='o'\\''brien' sh`, 'escaped apostrophe')
})

// PowerShell escapes an embedded single quote by doubling it instead.
check('a name with an apostrophe is doubled for PowerShell', () => {
  const cmd = buildInstallCommand({ ...full, target: 'powershell', machineName: "o'brien" })
  assertContains(cmd, `$env:DEVDECK_MACHINE_NAME='o''brien'`, 'doubled apostrophe')
})

check('quoting applies to the hub key too, not just the name', () => {
  const cmd = buildInstallCommand({ ...full, target: 'curl', hubKey: "k'ey" })
  assertContains(cmd, `DEVDECK_HUB_KEY='k'\\''ey'`, 'escaped hub key')
})

assertEqual(passed, 9, 'all checks ran')
console.log(`\n${passed} passed`)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx tsx src/features/machines/installCommand.test.ts`
Expected: FAIL — cannot resolve `./installCommand`.

- [ ] **Step 3: Write the minimal implementation**

Create `frontend/src/features/machines/installCommand.ts`:

```ts
/** The shell the one-liner will be pasted into. The operator picks this to
 *  match the target machine: the fetcher differs, and so do the quoting
 *  rules. See docs/superpowers/specs/2026-07-26-runtime-install-command-design.md. */
export type InstallTarget = 'curl' | 'wget' | 'powershell'

export interface InstallCommandInput {
  target: InstallTarget
  /** Resolved hub base URL — Tailscale's URL on a loopback hub, else window.location.origin. */
  hubUrl: string
  /** The hub's bearer key from GET /api/self/hub-key; '' renders a placeholder. */
  hubKey: string
  /** Display name for the machine; '' renders a placeholder. */
  machineName: string
  /** Operator-supplied GitHub token. Never sent to the server — it exists only
   *  to compose this string. '' renders a placeholder. */
  githubToken: string
}

/** Where deploy-docs.yml publishes the installer scripts. Matches scripts/README.md. */
const INSTALL_BASE_URL = 'https://kiyora.is-a.dev/devdeck'

/** Wraps a value in POSIX single quotes. An embedded single quote ends the
 *  quoted run, so it is closed, escaped, and reopened — the '\'' idiom. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Wraps a value in PowerShell single quotes, where an embedded single quote
 *  is escaped by doubling it. */
function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`
}

function orPlaceholder(value: string, placeholder: string): string {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : placeholder
}

/** Builds the one-line install command shown in the Add-runtime dialog.
 *  Missing values render as angle-bracket placeholders rather than producing
 *  a command that looks complete but silently misbehaves. */
export function buildInstallCommand(input: InstallCommandInput): string {
  const token = orPlaceholder(input.githubToken, '<github-token>')
  const hubUrl = orPlaceholder(input.hubUrl, '<hub-url>')
  const hubKey = orPlaceholder(input.hubKey, '<your-hub-key>')
  const name = orPlaceholder(input.machineName, '<name>')

  if (input.target === 'powershell') {
    return [
      `$env:GITHUB_TOKEN=${powershellQuote(token)}`,
      `$env:DEVDECK_HUB_URL=${powershellQuote(hubUrl)}`,
      `$env:DEVDECK_HUB_KEY=${powershellQuote(hubKey)}`,
      `$env:DEVDECK_MACHINE_NAME=${powershellQuote(name)}`,
      `irm ${INSTALL_BASE_URL}/install.ps1 | iex`,
    ].join('; ')
  }

  const fetcher =
    input.target === 'wget'
      ? `wget -qO- ${INSTALL_BASE_URL}/install.sh`
      : `curl -fsSL ${INSTALL_BASE_URL}/install.sh`

  return [
    `${fetcher} | \\`,
    `  GITHUB_TOKEN=${posixQuote(token)} \\`,
    `  DEVDECK_HUB_URL=${posixQuote(hubUrl)} \\`,
    `  DEVDECK_HUB_KEY=${posixQuote(hubKey)} \\`,
    `  DEVDECK_MACHINE_NAME=${posixQuote(name)} sh`,
  ].join('\n')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx tsx src/features/machines/installCommand.test.ts`
Expected: 9 `ok - ...` lines then `9 passed`, exit 0.

Run: `cd frontend && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/machines/installCommand.ts frontend/src/features/machines/installCommand.test.ts
git commit -m "feat(machines): build the runtime install one-liner

Pure builder for the curl/wget/PowerShell install command, with the
quoting the target shells actually require: machine names are free text,
so an unquoted 'my box' would split into two arguments and an
apostrophe would terminate the quoted run early."
```

---

### Task 3: Wire the hub-key query

**Files:**
- Modify: `frontend/src/lib/api.ts` (append near `fetchTailscaleStatus`, around line 687)
- Modify: `frontend/src/features/data/keys.ts:51` (beside `tailscaleStatus`)
- Modify: `frontend/src/features/data/queries.ts` (beside `useTailscaleStatus`, around line 295)

**Interfaces:**
- Consumes: `GET /api/self/hub-key` from Task 1.
- Produces, for Task 4:
  - `interface HubKeyStatus { configured: boolean; key: string }` exported from `@/lib/api`
  - `function useHubKey(enabled: boolean)` exported from `@/features/data/queries`, returning the standard react-query result whose `data` is `HubKeyStatus | undefined`

- [ ] **Step 1: Add the API client function**

In `frontend/src/lib/api.ts`, immediately after the `fetchTailscaleStatus` function, add:

```ts
export interface HubKeyStatus {
  /** False when this hub was started without --key, which makes runtime
   *  self-registration impossible. */
  configured: boolean
  /** The hub's bearer key, or '' when not configured. */
  key: string
}

/** Fetches this hub's own bearer key so the Add-runtime dialog can build a
 *  copy-pasteable install command. Hub and `both` roles only — see
 *  backend/internal/handler/hubkey.go. */
export function fetchHubKey(): Promise<HubKeyStatus> {
  return request<HubKeyStatus>('GET', '/self/hub-key')
}
```

- [ ] **Step 2: Add the cache key**

In `frontend/src/features/data/keys.ts`, immediately after the `tailscaleStatus` entry, add:

```ts
  hubKey: ['hubKey'] as const,
```

- [ ] **Step 3: Add the query hook**

In `frontend/src/features/data/queries.ts`, immediately after `useTailscaleStatus`, add:

```ts
/** The hub's own bearer key, used only to compose the Add-runtime install
 *  command. Enabled only while that dialog is open, so the app never fetches a
 *  long-lived credential speculatively. gcTime is 0 so the key is dropped from
 *  the cache as soon as the dialog unmounts rather than lingering for the
 *  default five minutes. */
export function useHubKey(enabled: boolean) {
  return useQuery({
    queryKey: qk.hubKey,
    queryFn: fetchHubKey,
    enabled,
    staleTime: 0,
    gcTime: 0,
  })
}
```

Add `fetchHubKey` to the existing `@/lib/api` import list at the top of the file — it is a value import, not a type import, so it goes in the plain `import { ... } from '@/lib/api'` statement.

- [ ] **Step 4: Verify it compiles**

Run: `cd frontend && npm run typecheck`
Expected: no errors.

Confirm the hook is exported and the key is registered:

Run: `grep -n "useHubKey\|hubKey" frontend/src/features/data/queries.ts frontend/src/features/data/keys.ts frontend/src/lib/api.ts`
Expected: `fetchHubKey`/`HubKeyStatus` in `api.ts`, `hubKey:` in `keys.ts`, `useHubKey` in `queries.ts`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts
git commit -m "feat(data): add the useHubKey query

Enabled only while the Add-runtime dialog is open, with gcTime 0 so the
hub key is dropped from the react-query cache on unmount instead of
lingering for the default five minutes."
```

---

### Task 4: `RuntimeInstallCommand` and the dialog rewiring

**Files:**
- Create: `frontend/src/features/machines/RuntimeInstallCommand.tsx`
- Modify: `frontend/src/features/machines/MachineDialog.tsx` (remove lines 13-24, rewire the add-mode body and the footer button)

**Interfaces:**
- Consumes: `buildInstallCommand`, `InstallTarget` from Task 2; `useHubKey` from Task 3.
- Produces: `<RuntimeInstallCommand hubUrl={string} machineName={string} />`.

- [ ] **Step 1: Write the component**

Create `frontend/src/features/machines/RuntimeInstallCommand.tsx`:

```tsx
import { Copy } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useHubKey } from '@/features/data/queries'
import { buildInstallCommand } from '@/features/machines/installCommand'
import type { InstallTarget } from '@/features/machines/installCommand'
import { cn } from '@/lib/utils'

const TARGETS: { value: InstallTarget; label: string }[] = [
  { value: 'curl', label: 'curl' },
  { value: 'wget', label: 'wget' },
  { value: 'powershell', label: 'PowerShell' },
]

interface RuntimeInstallCommandProps {
  /** Resolved hub base URL the runtime will register against. */
  hubUrl: string
  /** Name typed into the dialog; may be empty while the operator is still typing. */
  machineName: string
}

/** The copy-pasteable install one-liner shown in the Add-runtime dialog. Owns
 *  the target toggle, the GitHub-token field, and the hub-key fetch, so
 *  MachineDialog only has to place it. See
 *  docs/superpowers/specs/2026-07-26-runtime-install-command-design.md. */
export function RuntimeInstallCommand({ hubUrl, machineName }: RuntimeInstallCommandProps) {
  const [target, setTarget] = useState<InstallTarget>('curl')
  // Held in component state only — never sent to the server, never persisted,
  // and dropped when the dialog unmounts.
  const [githubToken, setGithubToken] = useState('')
  const hubKey = useHubKey(true)

  if (hubKey.isLoading) {
    return <p className="mb-5 font-mono text-[10.5px] text-devdeck-dim-2">Loading hub key…</p>
  }

  // A hub with no --key cannot accept self-registration at all, so there is no
  // useful command to show — explaining the fix beats printing one that 401s
  // on the target machine.
  if (hubKey.data && !hubKey.data.configured) {
    return (
      <div className="mb-5 rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-3">
        <p className="mb-1 font-mono text-[11px] text-devdeck-fg">This hub has no API key</p>
        <p className="font-mono text-[10.5px] text-devdeck-dim-2">
          A runtime authenticates its self-registration with the hub&apos;s key. Restart DevDeck with{' '}
          <code>--key &lt;value&gt;</code> (or set <code>DEVDECK_KEY</code>), then reopen this dialog.
        </p>
      </div>
    )
  }

  const command = buildInstallCommand({
    target,
    hubUrl,
    hubKey: hubKey.data?.key ?? '',
    machineName,
    githubToken,
  })

  function copyCommand() {
    void navigator.clipboard.writeText(command)
    toast.success('Command copied')
  }

  return (
    <>
      <Label>Target</Label>
      <div className="mb-3 flex gap-1.5">
        {TARGETS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTarget(t.value)}
            className={cn(
              'cursor-pointer rounded-md border px-2.5 py-1 font-mono text-[10.5px]',
              target === t.value
                ? 'border-devdeck-accent-soft text-devdeck-accent-soft'
                : 'border-devdeck-border-card text-devdeck-muted-2 hover:text-devdeck-fg',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Label>GitHub token (optional)</Label>
      <p className="mb-2 font-mono text-[10.5px] text-devdeck-dim-2">
        The release repo is private, so the installer needs one. Used only to build the command below — it is never
        sent to this server or saved.
      </p>
      <Input
        value={githubToken}
        type="password"
        onChange={(e) => setGithubToken(e.target.value)}
        placeholder="ghp_…"
        className="mb-3 font-mono"
      />

      <Label>Install command</Label>
      <p className="mb-2 font-mono text-[10.5px] text-devdeck-dim-2">
        Run this on the target machine. It downloads DevDeck, registers it with this hub, and verifies the
        registration landed.
      </p>
      {hubKey.isError ? (
        <p className="mb-2 font-mono text-[10.5px] text-devdeck-red-soft">
          Could not load the hub key — fill in &lt;your-hub-key&gt; yourself before running this.
        </p>
      ) : null}
      <div className="relative mb-5 rounded-lg border border-devdeck-border-card bg-devdeck-terminal p-2.5 pr-9">
        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-devdeck-fg">{command}</pre>
        <button
          type="button"
          onClick={copyCommand}
          aria-label="Copy command"
          className="absolute right-2.5 top-2.5 cursor-pointer p-1 text-devdeck-muted-2 hover:text-devdeck-accent-soft"
        >
          <Copy size={12} />
        </button>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Verify it compiles before wiring it in**

Run: `cd frontend && npm run typecheck`
Expected: no errors. (The component is unused at this point, which is fine — TypeScript does not error on that.)

- [ ] **Step 3: Rewire `MachineDialog.tsx`**

Delete the now-dead `generateRuntimeKey` and `runtimeCommand` functions (lines 13-24, from the `/** 32 random bytes…` comment through the closing brace of `runtimeCommand`). The installer generates the runtime's own `DEVDECK_KEY` on the target machine and reports it during self-registration, so a hub-side pre-generated key has no consumer once the manual command is gone.

Delete the `runtimeKey` state and its initialiser:

```tsx
  const [runtimeKey, setRuntimeKey] = useState('')
```

and the `setRuntimeKey(generateRuntimeKey())` line inside the `useEffect`, leaving the rest of that effect intact:

```tsx
  useEffect(() => {
    if (dialog.open && !isEdit) {
      setPasteMode(false)
      setPasteText('')
    }
  }, [dialog.open, isEdit])
```

Delete the `copyCommand` function (lines 89-92) — the copy button now lives inside `RuntimeInstallCommand`.

Replace the whole `<>…</>` fragment in the final `else` branch of the command area — the block starting `<Label>Runtime command</Label>` and ending with its closing `</div>`, i.e. lines 223-242's inner content — with:

```tsx
            <RuntimeInstallCommand hubUrl={resolvedHubUrl ?? window.location.origin} machineName={dialog.name} />
```

In the footer, drop the `Copy command` button entirely — copying now happens inside the command block, and the Tailscale-state branch that guarded it collapses with it. Add mode is left with just the existing `Close` button. The final shape is:

```tsx
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
        ) : null}
      </div>
```

Add the import (alias path, per the frontend rules):

```tsx
import { RuntimeInstallCommand } from '@/features/machines/RuntimeInstallCommand'
```

Remove any now-unused imports — `Copy` and `toast` are no longer referenced by `MachineDialog` unless `copyTailscaleLink` still uses them. `copyTailscaleLink` does use `toast`, so keep `toast`; `Copy` is only used by the deleted button, so remove it from the `lucide-react` import, leaving `Loader2`.

- [ ] **Step 4: Verify**

Run: `cd frontend && npm run typecheck`
Expected: no errors, and specifically no "declared but never read" errors for `Copy`, `runtimeKey`, `generateRuntimeKey`, or `runtimeCommand`.

Run: `cd frontend && npx tsx src/features/machines/installCommand.test.ts && npx tsx src/features/machines/connectionString.test.ts`
Expected: both scripts pass — the second confirms paste mode's parser is untouched.

Run: `grep -n "generateRuntimeKey\|runtimeCommand\|runtimeKey" frontend/src/features/machines/MachineDialog.tsx`
Expected: no output — all three are gone.

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/machines/RuntimeInstallCommand.tsx frontend/src/features/machines/MachineDialog.tsx
git commit -m "feat(machines): show a copy-pasteable install command

The Add-runtime dialog offered a command with three angle-bracket
placeholders and assumed a devdeck binary already existed on the target
— the actual hard part. It now shows the installer one-liner for the
platform the operator picks, with the hub key filled in.

Drops generateRuntimeKey: the installer generates the runtime's own key
on the target machine and reports it during self-registration, so the
hub-side pre-generated key no longer has a consumer."
```

---

## Manual Verification

The unit tests cover the builder and the endpoint. These need a running app.

1. **Hub with a key** — start `make dev` (its `DEV_HUB_KEY` gives the hub a `--key`), open Machines → Add runtime. Expect the command block to render with a real `DEVDECK_HUB_KEY`, not a placeholder.
2. **Target toggle** — switch between `curl`, `wget`, and `PowerShell`; the command changes fetcher and quoting style, and the copy button copies exactly what is displayed.
3. **Name interpolation** — type `my box` as the name and confirm the command shows `DEVDECK_MACHINE_NAME='my box'`, quoted.
4. **Token field** — type a token, confirm it appears in the command; confirm via the browser devtools Network tab that no request carries it.
5. **Hub without a key** — run a hub with no `--key` (`go run ./cmd/server --role hub --addr 127.0.0.1:9198 --db /tmp/nokey.db --open=false`) and confirm the dialog shows the "This hub has no API key" panel instead of a command.
6. **Runtime role** — `curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer rtk' http://127.0.0.1:9199/api/self/hub-key` against a `--role runtime` process. Expect `404` — the route must not exist there.
7. **Unauthenticated** — `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8989/api/self/hub-key` with no cookie or key. Expect `401`.
8. **Paste mode still works** — toggle to "Have a connection string instead?" and confirm parsing and the Connect button are unchanged.

## Self-Review

**Spec coverage.** Endpoint and its `configured:false` state → Task 1; role restriction → Task 1 Step 5 and Manual Verification 6; `no-store` → Task 1 Step 1; command builder and quoting → Task 2; hub URL staying client-side → Task 4 Step 3 passes `resolvedHubUrl`; GitHub token never leaving the browser → Task 4 Step 1 plus Manual Verification 4; the four UI states → Task 4 Step 1; dead-code removal → Task 4 Step 3; paste mode preserved → Task 4 Step 4's `connectionString.test.ts` run and Manual Verification 8.

**Naming consistency.** `HubKeyStatus { configured, key }` in Task 3 matches `hubKeyResponse { Configured, Key }`'s JSON tags in Task 1. `useHubKey(enabled: boolean)` in Task 3 is called as `useHubKey(true)` in Task 4. `InstallTarget` and `buildInstallCommand`'s five input fields are identical between Task 2's definition and Task 4's call site.

**Known gap, deliberate.** The generated command points at `https://kiyora.is-a.dev/devdeck/install.sh`, which 404s until the first `v*.*.*` tag is pushed. The spec records this; no task mitigates it, because mitigating it in the UI would mean removing that mitigation again once the tag lands.

# Runtime Self-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `--role runtime` process, given `--hub-url`/`--hub-key`, upserts itself into the hub's machine registry on startup — no manual step in the Machines UI.

**Architecture:** A new `machineclient.SelfRegister` function reuses the hub's existing `GET`/`POST`/`PATCH /api/machines` endpoints (no hub-side change) to upsert-by-URL; `machineclient.RunSelfRegisterLoop` retries it in the background until one success. `cmd/server/main.go` gains four new runtime-only flags and launches the loop as a goroutine, gated entirely on the new `--hub-url` flag being set so every existing invocation (including `make dev`/`make dev-api`) is unaffected.

**Tech Stack:** Go 1.22+ stdlib `net/http`/`net/http/httptest`, the existing `machineclient` package (`backend/internal/machineclient/client.go`).

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md`. Every task's requirements implicitly include it.
- No hub-side code changes at all — this is 100% additive on the runtime side, reusing `GET`/`POST`/`PATCH /api/machines` exactly as they exist today (see `CONTRACTS.md`).
- Feature is opt-in via `--hub-url`; absent, behavior is byte-identical to before this plan. `make dev`/`make dev-api` never pass it, so they are unaffected by construction — no verification step needed beyond "don't touch the Makefile."
- `--hub-url` set without `--hub-key` fails fast at startup (mirrors the existing `--role runtime requires --key` check in `main.go:85-87`).
- `go vet ./...` and `go test ./...` before every commit. Run from `backend/`.
- `backend/cmd/server/main.go` is a listed convergence file (see root `CLAUDE.md`) — this plan touches it once, in Task 2, after Task 1 is fully independent and committed. Do not parallelize Task 2 with anything else touching `main.go`.

---

### Task 1: `machineclient.SelfRegister` + `RunSelfRegisterLoop`

**Files:**
- Create: `backend/internal/machineclient/selfregister.go`
- Test: `backend/internal/machineclient/selfregister_test.go`

**Interfaces (produced):**
```go
type SelfRegisterConfig struct {
	HubURL    string
	HubKey    string
	PublicURL string
	Name      string
	Key       string
}

func SelfRegister(ctx context.Context, cfg SelfRegisterConfig) error
func RunSelfRegisterLoop(ctx context.Context, cfg SelfRegisterConfig, retryEvery time.Duration)
```
`RunSelfRegisterLoop` returns when `SelfRegister` succeeds once, or when `ctx` is cancelled — never runs forever on success, never blocks its caller (Task 2 calls it via `go RunSelfRegisterLoop(...)`).

- [ ] **Step 1: Write the failing tests**

```go
package machineclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// hubMachineStub is a tiny in-memory hub machines API used by every test
// below: it starts with a fixed set of machines and records what it
// receives, so tests can assert on method/body without a real store.
type hubMachineStub struct {
	machines []hubMachine
	requests []recordedRequest
}

type recordedRequest struct {
	method string
	path   string
	body   map[string]string
}

func newHubMachineStub(initial ...hubMachine) *hubMachineStub {
	return &hubMachineStub{machines: initial}
}

func (s *hubMachineStub) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer hubk" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]string
		if r.Method == http.MethodPost || r.Method == http.MethodPatch {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		s.requests = append(s.requests, recordedRequest{method: r.Method, path: r.URL.Path, body: body})

		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(s.machines)
		case http.MethodPost:
			m := hubMachine{ID: "m-new", Name: body["name"], URL: body["url"], Key: body["key"]}
			s.machines = append(s.machines, m)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(m)
		case http.MethodPatch:
			id := r.URL.Path[len("/api/machines/"):]
			for i, m := range s.machines {
				if m.ID == id {
					if v, ok := body["name"]; ok {
						s.machines[i].Name = v
					}
					if v, ok := body["key"]; ok {
						s.machines[i].Key = v
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(s.machines[i])
					return
				}
			}
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}
}

func TestSelfRegisterCreatesWhenAbsent(t *testing.T) {
	stub := newHubMachineStub() // no existing machines
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 2 || stub.requests[0].method != http.MethodGet || stub.requests[1].method != http.MethodPost {
		t.Fatalf("requests = %+v, want [GET, POST]", stub.requests)
	}
	if stub.requests[1].body["url"] != "https://rt-a.tail.ts.net:8989" || stub.requests[1].body["key"] != "rtk" {
		t.Errorf("POST body = %+v", stub.requests[1].body)
	}
}

func TestSelfRegisterPatchesWhenURLMatchesButFieldsDiffer(t *testing.T) {
	stub := newHubMachineStub(hubMachine{ID: "m-1", Name: "old-name", URL: "https://rt-a.tail.ts.net:8989", Key: "old-key"})
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 2 || stub.requests[1].method != http.MethodPatch || stub.requests[1].path != "/api/machines/m-1" {
		t.Fatalf("requests = %+v, want [GET, PATCH /api/machines/m-1]", stub.requests)
	}
	if stub.machines[0].Name != "rt-a" || stub.machines[0].Key != "rtk" {
		t.Errorf("machine after patch = %+v", stub.machines[0])
	}
}

func TestSelfRegisterNoOpWhenAlreadyCorrect(t *testing.T) {
	stub := newHubMachineStub(hubMachine{ID: "m-1", Name: "rt-a", URL: "https://rt-a.tail.ts.net:8989", Key: "rtk"})
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 1 || stub.requests[0].method != http.MethodGet {
		t.Fatalf("requests = %+v, want only [GET] (no-op)", stub.requests)
	}
}

func TestSelfRegisterReturnsErrorOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
	})
	if err == nil {
		t.Fatal("expected error on 500 response, got nil")
	}
}

func TestRunSelfRegisterLoopRetriesThenStopsOnSuccess(t *testing.T) {
	var mu int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu++
		if mu < 3 { // fail the first 2 requests (simulates hub not ready yet)
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]hubMachine{})
	}))
	t.Cleanup(srv.Close)

	done := make(chan struct{})
	go func() {
		RunSelfRegisterLoop(context.Background(), SelfRegisterConfig{
			HubURL: srv.URL, HubKey: "hubk",
			PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk",
		}, 5*time.Millisecond)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunSelfRegisterLoop did not stop after a successful registration")
	}
	if mu < 3 {
		t.Errorf("hub received %d requests, want at least 3 (2 failures + 1 success)", mu)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/machineclient/ -v`
Expected: FAIL with `undefined: SelfRegister` (and `hubMachine`, `SelfRegisterConfig`, `RunSelfRegisterLoop`)

- [ ] **Step 3: Implement** `backend/internal/machineclient/selfregister.go`:

```go
package machineclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

// SelfRegisterConfig describes a runtime's identity for self-registration
// with a hub, so an operator doesn't have to add each machine by hand
// through the Machines UI. See
// docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md.
type SelfRegisterConfig struct {
	HubURL    string // hub base URL, e.g. https://hub.tail-xxxx.ts.net:8989
	HubKey    string // hub's bearer key, used to authenticate this call
	PublicURL string // this runtime's own reachable URL
	Name      string // display name in the hub's Machines UI
	Key       string // this runtime's own static API key
}

// hubMachine mirrors domain.Machine's JSON shape for decoding the hub's
// GET /api/machines response; kept local (not imported from domain) since
// this package already depends on domain.Worktree/Machine for the
// hub->runtime direction and this is the inverse, runtime->hub direction.
type hubMachine struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	URL  string `json:"url"`
	Key  string `json:"key"`
}

// SelfRegister upserts this runtime's entry in the hub's machine registry
// by URL: an existing entry whose url matches cfg.PublicURL is PATCHed if
// its name/key differ (a no-op if already correct); no match creates a new
// entry. It reuses the hub's existing GET/POST/PATCH /api/machines
// endpoints — no hub-side change was needed for this.
func SelfRegister(ctx context.Context, cfg SelfRegisterConfig) error {
	machines, err := listHubMachines(ctx, cfg)
	if err != nil {
		return fmt.Errorf("list hub machines: %w", err)
	}

	for _, m := range machines {
		if m.URL != cfg.PublicURL {
			continue
		}
		if m.Name == cfg.Name && m.Key == cfg.Key {
			return nil
		}
		return patchHubMachine(ctx, cfg, m.ID)
	}
	return createHubMachine(ctx, cfg)
}

// RunSelfRegisterLoop retries SelfRegister on retryEvery until it succeeds
// once, then returns. A failure is logged, never fatal — the caller (the
// runtime's main goroutine) keeps serving regardless of registration
// status. Returns early if ctx is cancelled.
func RunSelfRegisterLoop(ctx context.Context, cfg SelfRegisterConfig, retryEvery time.Duration) {
	for {
		if err := SelfRegister(ctx, cfg); err != nil {
			log.Printf("self-register: %v; retrying in %s", err, retryEvery)
		} else {
			log.Printf("self-register: registered with hub as %q (%s)", cfg.Name, cfg.PublicURL)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryEvery):
		}
	}
}

func listHubMachines(ctx context.Context, cfg SelfRegisterConfig) ([]hubMachine, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(cfg.HubURL, "/")+"/api/machines", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.HubKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hub returned status %d", resp.StatusCode)
	}
	var machines []hubMachine
	if err := json.NewDecoder(resp.Body).Decode(&machines); err != nil {
		return nil, fmt.Errorf("decode machines: %w", err)
	}
	return machines, nil
}

func createHubMachine(ctx context.Context, cfg SelfRegisterConfig) error {
	body, err := json.Marshal(map[string]string{"name": cfg.Name, "url": cfg.PublicURL, "key": cfg.Key})
	if err != nil {
		return err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPost, strings.TrimRight(cfg.HubURL, "/")+"/api/machines", body)
}

func patchHubMachine(ctx context.Context, cfg SelfRegisterConfig, id string) error {
	body, err := json.Marshal(map[string]string{"name": cfg.Name, "key": cfg.Key})
	if err != nil {
		return err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPatch, strings.TrimRight(cfg.HubURL, "/")+"/api/machines/"+id, body)
}

func doHubMachineRequest(ctx context.Context, cfg SelfRegisterConfig, method, url string, body []byte) error {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.HubKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("hub returned status %d for %s %s", resp.StatusCode, method, url)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/machineclient/ -v`
Expected: `PASS` for all 6 tests (`TestSelfRegisterCreatesWhenAbsent`,
`TestSelfRegisterPatchesWhenURLMatchesButFieldsDiffer`,
`TestSelfRegisterNoOpWhenAlreadyCorrect`,
`TestSelfRegisterReturnsErrorOnNon200`,
`TestRunSelfRegisterLoopRetriesThenStopsOnSuccess`, plus the pre-existing
`TestFetchWorktrees*` tests if any exist in this package). Also run
`go vet ./internal/machineclient/`.

- [ ] **Step 5: Commit**

```bash
cd backend && git add internal/machineclient/selfregister.go internal/machineclient/selfregister_test.go
git commit -m "feat(machines): SelfRegister + RunSelfRegisterLoop for runtime self-registration"
```

---

### Task 2: Wire `--hub-url`/`--hub-key`/`--public-url`/`--name` into `main.go`

**Files:**
- Modify: `backend/cmd/server/main.go`

**Interfaces (consumes):**
- `machineclient.SelfRegisterConfig{HubURL, HubKey, PublicURL, Name, Key string}` (Task 1)
- `machineclient.RunSelfRegisterLoop(ctx context.Context, cfg machineclient.SelfRegisterConfig, retryEvery time.Duration)` (Task 1)

No unit test target for this file (matches the existing pattern — `main.go` has no test file in this repo). Verification is `go build` + a manual two-process curl check in Step 4.

- [ ] **Step 1: Add the import**

In the import block (`main.go:3-30`), add `"loom/backend/internal/machineclient"` alongside the other `loom/backend/internal/*` imports (e.g. right after `"loom/backend/internal/lsp"`):

```go
	"loom/backend/internal/lsp"
	"loom/backend/internal/machineclient"
	"loom/backend/internal/port"
```

- [ ] **Step 2: Add the four flags**

Right after the existing `apiKey` flag definition (`main.go:52`), before `flag.Parse()` (`main.go:53`):

```go
	apiKey := flag.String("key", envOr("LOOM_KEY", ""), "static API key; required for --role runtime, optional bearer auth for --role hub (desktop clients)")
	hubURL := flag.String("hub-url", envOr("LOOM_HUB_URL", ""), "hub base URL this runtime should self-register with on startup; empty disables self-registration")
	hubKey := flag.String("hub-key", envOr("LOOM_HUB_KEY", ""), "hub's bearer key, used to authenticate this runtime's self-registration call; required if --hub-url is set")
	publicURL := flag.String("public-url", envOr("LOOM_PUBLIC_URL", ""), "this runtime's own reachable URL, advertised to the hub during self-registration (default: http://<--addr>)")
	machineName := flag.String("name", envOr("LOOM_MACHINE_NAME", ""), "display name for this machine in the hub's Machines UI during self-registration (default: OS hostname)")
	flag.Parse()
```

- [ ] **Step 3: Validate and default, right after the existing role/key validation**

Replace this block at `main.go:82-88`:

```go
	if *role != "hub" && *role != "runtime" {
		log.Fatalf("--role must be \"hub\" or \"runtime\", got %q", *role)
	}
	if *role == "runtime" && *apiKey == "" {
		log.Fatalf("--role runtime requires --key (or LOOM_KEY)")
	}
	isRuntime := *role == "runtime"
```

with:

```go
	if *role != "hub" && *role != "runtime" {
		log.Fatalf("--role must be \"hub\" or \"runtime\", got %q", *role)
	}
	if *role == "runtime" && *apiKey == "" {
		log.Fatalf("--role runtime requires --key (or LOOM_KEY)")
	}
	if *hubURL != "" && *hubKey == "" {
		log.Fatalf("--hub-url requires --hub-key (or LOOM_HUB_KEY) to authenticate self-registration")
	}
	isRuntime := *role == "runtime"

	if *publicURL == "" {
		*publicURL = "http://" + *addr
	}
	if *machineName == "" {
		if hostname, err := os.Hostname(); err == nil {
			*machineName = hostname
		} else {
			*machineName = "runtime"
		}
	}
```

(`os` is already imported at `main.go:12`; `addr` is already defined at `main.go:37`, above this block.)

- [ ] **Step 4: Launch the background loop, gated on `isRuntime && *hubURL != ""`**

Find this block (`main.go:386-391`, right after the "loom listening on" log line and the `--enable-tailscale-serve` block):

```go
	log.Printf("loom listening on %s (db: %s)", uiURL, *dbPath)
	if *tailscaleServe {
		if err := startTailscaleServe(listener.Addr()); err != nil {
			log.Fatalf("--enable-tailscale-serve: %v", err)
		}
	}
```

Insert immediately after it (still before the `if !isRuntime && *openUI ...` block):

```go
	if isRuntime && *hubURL != "" {
		go machineclient.RunSelfRegisterLoop(context.Background(), machineclient.SelfRegisterConfig{
			HubURL:    *hubURL,
			HubKey:    *hubKey,
			PublicURL: *publicURL,
			Name:      *machineName,
			Key:       *apiKey,
		}, 30*time.Second)
		log.Printf("self-register: will register with hub %s as %q (%s)", *hubURL, *machineName, *publicURL)
	}
```

(`context` and `time` are already imported at `main.go:4` and `main.go:17`.)

- [ ] **Step 5: Verify — build, then a two-process manual smoke test**

```bash
cd backend && go build -o /tmp/loom ./cmd/server && go vet ./...
```

```bash
# hub
/tmp/loom --role hub --key hubk --addr 127.0.0.1:9198 --db /tmp/hub.db --open=false &
# runtime, self-registering
/tmp/loom --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false \
  --hub-url http://127.0.0.1:9198 --hub-key hubk --public-url http://127.0.0.1:9199 --name test-rt &
sleep 1
curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines
# expect: [{"id":"m-...","name":"test-rt","url":"http://127.0.0.1:9199","key":"rtk"}]
kill %1 %2
```

Expected: the `GET /api/machines` response already contains the runtime's entry — created without ever calling `POST /api/machines` yourself. Also confirm a runtime started **without** `--hub-url` behaves exactly as before (no self-register log line, no goroutine): `/tmp/loom --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt2.db --open=false` should start cleanly with no `self-register:` log line.

- [ ] **Step 6: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat(server): --hub-url/--hub-key/--public-url/--name for runtime self-registration"
```

---

### Task 3: Docs

**Files:**
- Modify: `COMMANDS.md` (new flags in the flag list + the "Hub / runtime roles" curl example)
- Modify: `CONTRACTS.md` (a short "Runtime self-registration" note under the existing Machines API section)
- Modify: `ARCHITECTURE.md` (one sentence in the "Hub / runtime roles" section pointing at the new spec)

- [ ] **Step 1: `COMMANDS.md`** — add the four new flags to the flag list (after the existing `--key` bullet, matching the existing bullet style):

```markdown
- `--hub-url` — hub base URL this runtime should self-register with on
  startup (env `LOOM_HUB_URL`, empty = self-registration disabled).
- `--hub-key` — hub's bearer key, used to authenticate this runtime's
  self-registration call; required if `--hub-url` is set (env `LOOM_HUB_KEY`).
- `--public-url` — this runtime's own reachable URL, advertised to the hub
  during self-registration (env `LOOM_PUBLIC_URL`, default `http://<--addr>`).
- `--name` — display name for this machine in the hub's Machines UI during
  self-registration (env `LOOM_MACHINE_NAME`, default: OS hostname).
```

Then extend the "Hub / runtime roles" curl example with a self-registering variant, right after the existing runtime example:

```markdown
# Start a runtime that self-registers with a hub instead of being added
# manually through the Machines UI:
cd backend && go run ./cmd/server --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false \
  --hub-url http://127.0.0.1:9198 --hub-key hubk --public-url http://127.0.0.1:9199 --name my-laptop

curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines  # already includes "my-laptop"
```

- [ ] **Step 2: `CONTRACTS.md`** — add this subsection right after the existing "Machines API (hub role only — runtime registry)" section (after its last bullet, before "## Project.machineId"):

```markdown
### Runtime self-registration

A `--role runtime` process with `--hub-url`/`--hub-key` set upserts itself
into the hub's registry on startup instead of requiring a manual `POST
/api/machines` — see
`docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md`.
It's implemented entirely client-side (`machineclient.SelfRegister`),
reusing the endpoints above unchanged: `GET /api/machines` to find an
existing entry whose `url` matches this runtime's `--public-url`, then
`PATCH` (if found and `name`/`key` differ) or `POST` (if not found).
Failure is logged and retried every 30s in the background; it never blocks
or fails runtime startup.
```

- [ ] **Step 3: `ARCHITECTURE.md`** — in the "Hub / runtime roles" section, in the first paragraph, after the existing sentence ending "...for desktop (Tauri) clients.", add:

```markdown
A runtime can also self-register with its hub on startup via
`--hub-url`/`--hub-key` instead of being added by hand through the
Machines UI — see
`docs/superpowers/specs/2026-07-09-runtime-self-registration-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add COMMANDS.md CONTRACTS.md ARCHITECTURE.md
git commit -m "docs: runtime self-registration flags and semantics"
```

---

## Verification (end-to-end)

```bash
cd backend && go vet ./... && go test ./...
cd ../frontend && npm run typecheck   # unaffected by this plan; confirms no regression

# Full two-node smoke test (also covered in Task 2 Step 5):
cd ../backend && go build -o /tmp/loom ./cmd/server
/tmp/loom --role hub --key hubk --addr 127.0.0.1:9198 --db /tmp/hub.db --open=false &
/tmp/loom --role runtime --key rtk --addr 127.0.0.1:9199 --db /tmp/rt.db --open=false \
  --hub-url http://127.0.0.1:9198 --hub-key hubk --public-url http://127.0.0.1:9199 --name test-rt &
sleep 1
curl -s -H 'Authorization: Bearer hubk' http://127.0.0.1:9198/api/machines   # includes test-rt, auto-registered
kill %1 %2
```

Also confirm no regression on a plain runtime with no `--hub-url` (today's
default, and what `make dev`/`make dev-api` always use): it must start
identically to before this plan, with no `self-register:` log line and no
outbound calls to anything.

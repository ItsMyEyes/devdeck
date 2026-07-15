# Hub/Runtime Dual-Role, Remote Hub Connect, and Hub-Side Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--role both` backend mode (one process, self-registered as its own execution machine), a Tauri desktop "Connect to a hub" mode alongside the existing local sidecar, and server-side polling of every registered machine's health so the Machines page reflects live status without per-tab, per-request pings.

**Architecture:** Backend: extract the existing inline health-ping into a reusable `machineclient.CheckHealth`, add an in-memory `service.MachineHealthCache` refreshed by a background poller, thread an `IsLocal` flag through the existing self-registration client, and wire a new `--role both` value in `main.go` that reuses that same self-registration loop pointed at itself. Desktop: a new first-run choice screen persists which mode the install uses (`hubmode.rs`); "Host locally" is the existing sidecar flow, completely unchanged; "Connect to a hub" just navigates the window at an operator-supplied URL. A "Change Hub…" menu item clears the saved choice and restarts the app.

**Tech Stack:** Go 1.25 (stdlib `net/http`, `encoding/json`), Rust (Tauri v2, `tauri-plugin-shell`, `tauri-plugin-process`, `serde`/`serde_json`), no new frontend (SPA) code.

## Global Constraints

- Networking model stays tailnet-only — no public-internet exposure, no new TLS/auth hardening (spec decision #4).
- No DB/schema changes — machine health stays in-memory/ephemeral (spec decision #3).
- `frontend/src-tauri/src/hubapi.rs` and `frontend/src-tauri/src/sidecar.rs` are **not modified** — "Host locally" reuses them exactly as they are today; only `--role both` (a distinct, fixed-address deployment mode) gets the new self-registration path (spec correction, 2026-07-14).
- `backend/cmd/server/main.go` is a convergence file (per `CLAUDE.md` orchestration rules) — only Task 5 touches it, and it must not run in parallel with any other task that also touches it.
- Every existing test (`machine_test.go`, `selfregister_test.go`, `sidecar.rs` tests, `hubapi.rs` tests) must keep passing unchanged in behavior; only call sites that change signatures get updated.

---

## Backend sub-project

### Task 1: Extract `machineclient.CheckHealth`

**Files:**
- Modify: `backend/internal/machineclient/client.go`
- Test: `backend/internal/machineclient/client_test.go` (new)

**Interfaces:**
- Produces: `type HealthStatus struct { Status string; LatencyMs int64 }` and `func CheckHealth(ctx context.Context, m domain.Machine) HealthStatus` — `Status` is `"online"` or `"offline"`; `LatencyMs` is only meaningful when `Status == "online"`. Never returns an error — an unreachable machine is a normal `"offline"` result, matching the existing handler's designed behavior (`backend/internal/handler/machine.go:87-89`).

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/machineclient/client_test.go`:

```go
package machineclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"loom/backend/internal/domain"
)

func TestCheckHealthOnline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if status.Status != "online" {
		t.Errorf("status = %q, want online", status.Status)
	}
}

func TestCheckHealthOfflineOnUnreachable(t *testing.T) {
	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: "http://127.0.0.1:1", Key: "k"})
	if status.Status != "offline" {
		t.Errorf("status = %q, want offline", status.Status)
	}
}

func TestCheckHealthOfflineOnNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	status := CheckHealth(context.Background(), domain.Machine{ID: "m-1", URL: srv.URL, Key: "k"})
	if status.Status != "offline" {
		t.Errorf("status = %q, want offline", status.Status)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/machineclient/... -run TestCheckHealth -v`
Expected: FAIL with `undefined: CheckHealth` (compile error).

- [ ] **Step 3: Implement `CheckHealth`**

In `backend/internal/machineclient/client.go`, add after the existing `FetchWorktrees` function:

```go
// HealthStatus is the result of pinging a machine's /api/health endpoint.
type HealthStatus struct {
	Status    string // "online" or "offline"
	LatencyMs int64  // only meaningful when Status == "online"
}

// CheckHealth pings m's /api/health with a short timeout. Offline is a
// normal result (not an error) — the same design as the hub's per-machine
// health badge always had, just reusable outside the handler package now
// (see MachineHealthCache in package service).
func CheckHealth(ctx context.Context, m domain.Machine) HealthStatus {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(m.URL, "/")+"/api/health", nil)
	if err != nil {
		return HealthStatus{Status: "offline"}
	}
	req.Header.Set("Authorization", "Bearer "+m.Key)

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return HealthStatus{Status: "offline"}
	}
	resp.Body.Close()
	return HealthStatus{Status: "online", LatencyMs: time.Since(start).Milliseconds()}
}
```

No new imports are needed — `client.go` already imports `context`, `net/http`, `strings`, `time`, and `loom/backend/internal/domain`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/machineclient/... -v`
Expected: PASS (all tests in the package, including the pre-existing `clone_test.go`/`selfregister_test.go` ones).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/machineclient/client.go backend/internal/machineclient/client_test.go
git commit -m "feat(machineclient): extract CheckHealth for reuse outside the machine handler"
```

---

### Task 2: Add `IsLocal` to self-registration

**Files:**
- Modify: `backend/internal/machineclient/selfregister.go`
- Modify: `backend/internal/machineclient/selfregister_test.go`

**Interfaces:**
- Produces: `SelfRegisterConfig.IsLocal bool` (new field, zero value `false` preserves today's behavior for every existing caller).
- Consumes: none (independent of Task 1; can run in parallel with it — different files in the same package).

- [ ] **Step 1: Write the failing test**

Append to `backend/internal/machineclient/selfregister_test.go`:

```go
func TestSelfRegisterCreateIncludesIsLocalWhenTrue(t *testing.T) {
	var captured map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode([]hubMachine{})
		case http.MethodPost:
			_ = json.NewDecoder(r.Body).Decode(&captured)
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)

	err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "http://127.0.0.1:8989", Name: "desktop", Key: "k", IsLocal: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if captured["isLocal"] != true {
		t.Errorf("POST body isLocal = %v, want true", captured["isLocal"])
	}
}

func TestSelfRegisterPatchesWhenOnlyIsLocalDiffers(t *testing.T) {
	stub := newHubMachineStub(hubMachine{ID: "m-1", Name: "rt-a", URL: "https://rt-a.tail.ts.net:8989", Key: "rtk", IsLocal: false})
	srv := httptest.NewServer(stub.handler())
	t.Cleanup(srv.Close)

	err := SelfRegister(context.Background(), SelfRegisterConfig{
		HubURL: srv.URL, HubKey: "hubk",
		PublicURL: "https://rt-a.tail.ts.net:8989", Name: "rt-a", Key: "rtk", IsLocal: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(stub.requests) != 2 || stub.requests[1].method != http.MethodPatch {
		t.Fatalf("requests = %+v, want [GET, PATCH] (isLocal alone must trigger a patch)", stub.requests)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/machineclient/... -run TestSelfRegister -v`
Expected: FAIL — `TestSelfRegisterCreateIncludesIsLocalWhenTrue` fails because `captured["isLocal"]` is nil (not sent yet); `TestSelfRegisterPatchesWhenOnlyIsLocalDiffers` fails to compile (`hubMachine{...IsLocal: false}` — field doesn't exist yet) or, once that's added, fails because the no-op check doesn't compare `IsLocal`.

- [ ] **Step 3: Implement `IsLocal` threading**

In `backend/internal/machineclient/selfregister.go`, make these changes:

Add `IsLocal` to `SelfRegisterConfig` (after `Key`):

```go
type SelfRegisterConfig struct {
	HubURL    string // hub base URL, e.g. https://hub.tail-xxxx.ts.net:8989
	HubKey    string // hub's bearer key, used to authenticate this call
	PublicURL string // this runtime's own reachable URL
	Name      string // display name in the hub's Machines UI
	Key       string // this runtime's own static API key
	// IsLocal marks this entry as a same-process, self-registered machine
	// (a --role both process registering itself) so the hub protects it
	// from accidental edit/delete the same way it already protects the
	// Tauri desktop's embedded runtime entry. Zero value (false) is exactly
	// today's behavior for a runtime self-registering with a remote hub.
	IsLocal bool
}
```

Add `IsLocal` to the `hubMachine` mirror struct:

```go
type hubMachine struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Key     string `json:"key"`
	IsLocal bool   `json:"isLocal"`
}
```

Update the no-op check in `SelfRegister` to also compare `IsLocal`:

```go
	for _, m := range machines {
		if m.URL != cfg.PublicURL {
			continue
		}
		if m.Name == cfg.Name && m.Key == cfg.Key && m.IsLocal == cfg.IsLocal {
			return nil
		}
		return patchHubMachine(ctx, cfg, m.ID)
	}
```

Replace the `map[string]string` body construction in `createHubMachine`/`patchHubMachine` with typed structs so `isLocal` (a bool) can be included without breaking the existing `map[string]string`-decoding test stub (which never sees `isLocal` unless `IsLocal` is true, since `omitempty` drops it at its zero value):

```go
func createHubMachine(ctx context.Context, cfg SelfRegisterConfig) error {
	body, err := json.Marshal(struct {
		Name    string `json:"name"`
		URL     string `json:"url"`
		Key     string `json:"key"`
		IsLocal bool   `json:"isLocal,omitempty"`
	}{Name: cfg.Name, URL: cfg.PublicURL, Key: cfg.Key, IsLocal: cfg.IsLocal})
	if err != nil {
		return err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPost, strings.TrimRight(cfg.HubURL, "/")+"/api/machines", body)
}

func patchHubMachine(ctx context.Context, cfg SelfRegisterConfig, id string) error {
	body, err := json.Marshal(struct {
		Name    string `json:"name"`
		Key     string `json:"key"`
		IsLocal bool   `json:"isLocal,omitempty"`
	}{Name: cfg.Name, Key: cfg.Key, IsLocal: cfg.IsLocal})
	if err != nil {
		return err
	}
	return doHubMachineRequest(ctx, cfg, http.MethodPatch, strings.TrimRight(cfg.HubURL, "/")+"/api/machines/"+id, body)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/machineclient/... -v`
Expected: PASS — including every pre-existing `TestSelfRegister*`/`TestRunSelfRegisterLoop*` test, whose `SelfRegisterConfig` literals never set `IsLocal`, so `omitempty` keeps their JSON bodies byte-for-byte identical to before.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/machineclient/selfregister.go backend/internal/machineclient/selfregister_test.go
git commit -m "feat(machineclient): thread IsLocal through self-registration"
```

---

### Task 3: Add `service.MachineHealthCache` + poller

**Files:**
- Create: `backend/internal/service/machinehealth.go`
- Test: `backend/internal/service/machinehealth_test.go`

**Interfaces:**
- Consumes: `machineclient.HealthStatus`, `machineclient.CheckHealth` (Task 1) — this task must run **after** Task 1.
- Produces:
  - `func NewMachineHealthCache() *MachineHealthCache`
  - `func (c *MachineHealthCache) Get(machineID string) (machineclient.HealthStatus, bool)`
  - `func (c *MachineHealthCache) Set(machineID string, status machineclient.HealthStatus)`
  - `func (c *MachineHealthCache) RunPoller(ctx context.Context, st *store.Store, interval time.Duration)` — blocks until `ctx` is cancelled; never returns otherwise.

- [ ] **Step 1: Write the failing tests**

Create `backend/internal/service/machinehealth_test.go`:

```go
package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"loom/backend/internal/store"
)

func TestMachineHealthCacheGetMissReturnsFalse(t *testing.T) {
	c := NewMachineHealthCache()
	if _, ok := c.Get("m-none"); ok {
		t.Error("Get on an empty cache should return ok=false")
	}
}

func TestMachineHealthCacheSetThenGet(t *testing.T) {
	c := NewMachineHealthCache()
	c.Set("m-1", machineclient.HealthStatus{Status: "online", LatencyMs: 42})
	status, ok := c.Get("m-1")
	if !ok || status.Status != "online" || status.LatencyMs != 42 {
		t.Errorf("Get = %+v, %v, want online/42/true", status, ok)
	}
}

func TestRunPollerCachesEveryRegisteredMachine(t *testing.T) {
	online := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(online.Close)

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	if _, err := st.CreateMachine("online-machine", online.URL, "k", false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateMachine("dead-machine", "http://127.0.0.1:1", "k", false); err != nil {
		t.Fatal(err)
	}

	c := NewMachineHealthCache()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.RunPoller(ctx, st, 5*time.Millisecond)
		close(done)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		machines, _ := st.Machines()
		allCached := true
		for _, m := range machines {
			if _, ok := c.Get(m.ID); !ok {
				allCached = false
			}
		}
		if allCached && len(machines) == 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	machines, _ := st.Machines()
	for _, m := range machines {
		status, ok := c.Get(m.ID)
		if !ok {
			t.Fatalf("machine %s never got a cached status", m.ID)
		}
		wantStatus := "offline"
		if m.Name == "online-machine" {
			wantStatus = "online"
		}
		if status.Status != wantStatus {
			t.Errorf("machine %s status = %q, want %q", m.Name, status.Status, wantStatus)
		}
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunPoller did not return after ctx cancellation")
	}
}
```

Add the import:

```go
import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"loom/backend/internal/machineclient"
	"loom/backend/internal/store"
)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/service/... -run TestMachineHealthCache -v`
Expected: FAIL with `undefined: NewMachineHealthCache` (compile error).

- [ ] **Step 3: Implement `MachineHealthCache`**

Create `backend/internal/service/machinehealth.go`:

```go
// Package service: MachineHealthCache holds the most recent health-check
// result for every registered machine, refreshed by a background poller so
// the Machines page reflects live status without a per-request round trip
// to each runtime. See
// docs/superpowers/specs/2026-07-14-hub-runtime-dual-role-and-polling-design.md.
package service

import (
	"context"
	"sync"
	"time"

	"loom/backend/internal/machineclient"
	"loom/backend/internal/store"
)

type MachineHealthCache struct {
	mu   sync.RWMutex
	byID map[string]machineclient.HealthStatus
}

func NewMachineHealthCache() *MachineHealthCache {
	return &MachineHealthCache{byID: make(map[string]machineclient.HealthStatus)}
}

// Get returns the cached status for machineID and whether one exists yet.
func (c *MachineHealthCache) Get(machineID string) (machineclient.HealthStatus, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	status, ok := c.byID[machineID]
	return status, ok
}

func (c *MachineHealthCache) Set(machineID string, status machineclient.HealthStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byID[machineID] = status
}

// RunPoller pings every machine currently in st's registry immediately,
// then every interval thereafter, caching each result. It blocks until ctx
// is cancelled; a failed store read or a single unreachable machine never
// stops the loop or affects any other machine's cached result.
func (c *MachineHealthCache) RunPoller(ctx context.Context, st *store.Store, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		c.pollOnce(ctx, st)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *MachineHealthCache) pollOnce(ctx context.Context, st *store.Store) {
	machines, err := st.Machines()
	if err != nil {
		return
	}
	for _, m := range machines {
		c.Set(m.ID, machineclient.CheckHealth(ctx, m))
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/... -v`
Expected: PASS (all tests in the package, including pre-existing service tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/machinehealth.go backend/internal/service/machinehealth_test.go
git commit -m "feat(service): add MachineHealthCache with a background poller"
```

---

### Task 4: Cache-first `GetMachineHealth` handler

**Files:**
- Modify: `backend/internal/handler/machine.go`
- Modify: `backend/internal/handler/machine_test.go`

**Interfaces:**
- Consumes: `machineclient.CheckHealth`/`HealthStatus` (Task 1), `service.MachineHealthCache` (Task 3) — must run after both.
- Produces: `handler.NewMachineHandler(st *store.Store, healthCache *service.MachineHealthCache) *MachineHandler` (signature change — the one caller, `backend/cmd/server/main.go`, is updated in Task 5).

- [ ] **Step 1: Update the existing tests for the new constructor signature, and add a cache-hit test**

In `backend/internal/handler/machine_test.go`, update the helper:

```go
func newTestMachineHandler(t *testing.T) *MachineHandler {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return NewMachineHandler(store.New(db), service.NewMachineHealthCache())
}
```

Add the import:

```go
import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"loom/backend/internal/machineclient"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
)
```

Append a new test proving the handler serves from the cache without a live round trip:

```go
func TestMachineHealthServesFromCacheWithoutLiveCheck(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	st := store.New(db)
	cache := service.NewMachineHealthCache()
	h := NewMachineHandler(st, cache)

	// Unreachable URL: if the handler ever did a live check here, it would
	// report offline. The cached value must win instead.
	m, err := st.CreateMachine("cached", "http://127.0.0.1:1", "k", false)
	if err != nil {
		t.Fatal(err)
	}
	cache.Set(m.ID, machineclient.HealthStatus{Status: "online", LatencyMs: 42})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/machines/{id}/health", h.GetMachineHealth)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/machines/"+m.ID+"/health", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"online"`) || !strings.Contains(rec.Body.String(), `"latencyMs":42`) {
		t.Errorf("status=%d body=%s, want cached online/42", rec.Code, rec.Body.String())
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/handler/... -run TestMachine -v`
Expected: FAIL to compile — `NewMachineHandler` still takes one argument.

- [ ] **Step 3: Implement the cache-first handler**

In `backend/internal/handler/machine.go`, replace the struct, constructor, and `GetMachineHealth`:

```go
package handler

import (
	"net/http"
	"net/url"

	"loom/backend/internal/machineclient"
	"loom/backend/internal/port"
	"loom/backend/internal/service"
	"loom/backend/internal/store"
)

// MachineHandler handles the hub's runtime-machine registry.
type MachineHandler struct {
	st          *store.Store
	healthCache *service.MachineHealthCache
}

func NewMachineHandler(st *store.Store, healthCache *service.MachineHealthCache) *MachineHandler {
	return &MachineHandler{st: st, healthCache: healthCache}
}
```

(`net/http` stays for the handler methods; `time` and its two uses are removed entirely since `CheckHealth` now owns the timeout/latency logic.)

Replace `GetMachineHealth`:

```go
// GetMachineHealth reports a machine's status. It serves the background
// poller's cached result when one exists (see MachineHealthCache), falling
// back to a single live check for a machine that hasn't been polled yet
// (just added, or the hub just started). Offline is a normal answer (200),
// not an error: the frontend polls this to drive status badges and
// direct-vs-proxy fallback.
func (h *MachineHandler) GetMachineHealth(w http.ResponseWriter, r *http.Request) {
	m, err := h.st.MachineByID(r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	status, ok := h.healthCache.Get(m.ID)
	if !ok {
		status = machineclient.CheckHealth(r.Context(), m)
	}
	writeJSON(w, http.StatusOK, healthResponse(status))
}

func healthResponse(s machineclient.HealthStatus) map[string]any {
	if s.Status != "online" {
		return map[string]any{"status": "offline"}
	}
	return map[string]any{"status": "online", "latencyMs": s.LatencyMs}
}
```

Leave `validMachineURL`, `GetMachines`, `PostMachine`, `PatchMachine`, `DeleteMachine` exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/... -v`
Expected: PASS — including the pre-existing `TestMachineHealthOnline`/`TestMachineHealthOffline` (empty cache on both → fall back to the same live-check behavior as before) and `TestMachineCRUDRoundtrip`.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/handler/machine.go backend/internal/handler/machine_test.go
git commit -m "feat(handler): serve machine health from the poller's cache first"
```

---

### Task 5: Wire `--role both` and the health cache into `main.go`

**Files:**
- Modify: `backend/cmd/server/main.go` (convergence file — this is the only task that touches it; do not run in parallel with anything else)

**Interfaces:**
- Consumes: `SelfRegisterConfig.IsLocal` (Task 2), `service.NewMachineHealthCache`/`RunPoller` (Task 3), `handler.NewMachineHandler(st, healthCache)` (Task 4). Must run after Tasks 1–4.

- [ ] **Step 1: Update the `--role` flag validation and key/hub-url defaulting**

In `backend/cmd/server/main.go`, replace:

```go
	role := flag.String("role", envOr("LOOM_ROLE", "hub"), "server role: hub (organizational data + machine registry + proxy + web UI) or runtime (headless execution daemon, key auth only)")
```

with:

```go
	role := flag.String("role", envOr("LOOM_ROLE", "hub"), "server role: hub (organizational data + machine registry + proxy + web UI), runtime (headless execution daemon, key auth only), or both (hub that also self-registers as its own execution machine, for solo self-hosting on a fixed address)")
```

Then replace:

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
```

with:

```go
	if *role != "hub" && *role != "runtime" && *role != "both" {
		log.Fatalf("--role must be \"hub\", \"runtime\", or \"both\", got %q", *role)
	}
	isRuntime := *role == "runtime"
	isBoth := *role == "both"
	if (isRuntime || isBoth) && *apiKey == "" {
		log.Fatalf("--role %s requires --key (or LOOM_KEY)", *role)
	}
	if isBoth {
		// --role both self-registers with itself: default the self-register
		// target to this same process unless the operator overrode it.
		if *hubURL == "" {
			*hubURL = "http://" + *addr
		}
		if *hubKey == "" {
			*hubKey = *apiKey
		}
	}
	if *hubURL != "" && *hubKey == "" {
		log.Fatalf("--hub-url requires --hub-key (or LOOM_HUB_KEY) to authenticate self-registration")
	}

	// publicURLWasDefaulted tracks whether the operator left --public-url
	// unset, so it can be recomputed after the listener binds (needed when
	// --addr uses port 0 and the OS assigns the real port — see Step 2).
	publicURLWasDefaulted := *publicURL == ""
	if publicURLWasDefaulted {
		*publicURL = "http://" + *addr
	}
```

Leave the `machineName` defaulting block immediately below unchanged.

- [ ] **Step 2: Recompute `--public-url` after the listener binds when it was defaulted**

Find:

```go
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen on %s: %v", *addr, err)
	}
	uiURL, err := browserURL(listener.Addr())
```

Replace with:

```go
	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen on %s: %v", *addr, err)
	}
	if publicURLWasDefaulted {
		// *addr may have used port 0 (OS-assigned); the flag-parse-time
		// default baked in the literal ":0", so recompute it now that the
		// OS has bound a real port. advertiseURL (used only for its
		// hostname, above) is unaffected by this — hostnames don't change
		// when a port is reassigned.
		*publicURL = "http://" + listener.Addr().String()
	}
	uiURL, err := browserURL(listener.Addr())
```

- [ ] **Step 3: Broaden the self-register loop launch condition and pass `IsLocal`**

Find:

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

Replace with:

```go
	if (isRuntime || isBoth) && *hubURL != "" {
		go machineclient.RunSelfRegisterLoop(context.Background(), machineclient.SelfRegisterConfig{
			HubURL:    *hubURL,
			HubKey:    *hubKey,
			PublicURL: *publicURL,
			Name:      *machineName,
			Key:       *apiKey,
			IsLocal:   isBoth,
		}, 30*time.Second)
		log.Printf("self-register: will register with hub %s as %q (%s)", *hubURL, *machineName, *publicURL)
	}
```

- [ ] **Step 4: Construct the health cache, start the poller, and wire it into `NewMachineHandler`**

Find the recurring-invoices startup block:

```go
	if !isRuntime {
		if generated, err := st.RunDueRecurringInvoices(); err != nil {
			log.Printf("recurring invoices: startup check failed: %v", err)
		} else if len(generated) > 0 {
			log.Printf("recurring invoices: generated %d draft invoice(s) on startup", len(generated))
		}

		go func() {
			ticker := time.NewTicker(24 * time.Hour)
			defer ticker.Stop()
			for range ticker.C {
				if generated, err := st.RunDueRecurringInvoices(); err != nil {
					log.Printf("recurring invoices: daily check failed: %v", err)
				} else if len(generated) > 0 {
					log.Printf("recurring invoices: generated %d draft invoice(s)", len(generated))
				}
			}
		}()
	}
```

Immediately after it (still before `var baseReg port.AgentRegistry`), add:

```go
	healthCache := service.NewMachineHealthCache()
	if !isRuntime {
		go healthCache.RunPoller(context.Background(), st, 15*time.Second)
	}
```

Then find:

```go
	machineH := handler.NewMachineHandler(st)
```

and replace with:

```go
	machineH := handler.NewMachineHandler(st, healthCache)
```

- [ ] **Step 5: Build and vet**

Run: `cd backend && go build ./... && go vet ./...`
Expected: no errors.

- [ ] **Step 6: Run the full backend test suite**

Run: `cd backend && go test ./...`
Expected: PASS across every package.

- [ ] **Step 7: Manually verify `--role both` end-to-end**

Run (from `backend/`):

```bash
go run ./cmd/server --role both --addr 127.0.0.1:19001 --key testkey --db /tmp/loom-both-test.db --open=false &
sleep 1
curl -s -H "Authorization: Bearer testkey" http://127.0.0.1:19001/api/machines
kill %1
rm -f /tmp/loom-both-test.db
```

Expected: the `curl` output is a JSON array containing exactly one machine, with `"url":"http://127.0.0.1:19001"`, `"key":"testkey"`, and `"isLocal":true`.

- [ ] **Step 8: Commit**

```bash
git add backend/cmd/server/main.go
git commit -m "feat(server): add --role both — a hub that self-registers as its own execution machine"
```

---

## Tauri sub-project (independent of the backend sub-project — no shared files, no `--role both` dependency)

### Task 6: First-run hub choice — "Host locally" (unchanged) / "Connect to a hub" (new)

**Files:**
- Create: `frontend/src-tauri/src/hubmode.rs`
- Modify: `frontend/src-tauri/src/lib.rs`
- Create: `frontend/src-tauri/ui/choose.html`
- Modify: `frontend/src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: `hubmode::HubMode` (`Local` / `Remote { url: String }`), `hubmode::load/save/clear(data_dir: &Path)`, Tauri command `choose_hub_mode(mode: String, url: Option<String>)`.
- `frontend/src-tauri/src/hubapi.rs` and `frontend/src-tauri/src/sidecar.rs` are untouched by this task — "Host locally" reuses `launch_once` (and therefore `hubapi::upsert_local_machine`) exactly as it exists today.

- [ ] **Step 1: Write the failing `hubmode` tests**

Create `frontend/src-tauri/src/hubmode.rs`:

```rust
//! Persisted first-run choice: run the bundled sidecar locally, or connect
//! to a hub the operator already hosts elsewhere. See
//! docs/superpowers/specs/2026-07-14-hub-runtime-dual-role-and-polling-design.md.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MODE_FILE: &str = "hub-mode.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum HubMode {
    Local,
    Remote { url: String },
}

fn mode_path(data_dir: &Path) -> PathBuf {
    data_dir.join(MODE_FILE)
}

/// Reads the saved choice, if any. None means first run (or a corrupt/
/// missing file, treated the same as first run rather than a fatal error).
pub fn load(data_dir: &Path) -> Option<HubMode> {
    let contents = std::fs::read_to_string(mode_path(data_dir)).ok()?;
    serde_json::from_str(&contents).ok()
}

pub fn save(data_dir: &Path, mode: &HubMode) -> std::io::Result<()> {
    let json = serde_json::to_string(mode).expect("HubMode always serializes");
    std::fs::write(mode_path(data_dir), json)
}

/// Removes the saved choice so the next launch shows the choice screen
/// again. Missing file is not an error (nothing to clear).
pub fn clear(data_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(mode_path(data_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(suffix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("loom-hubmode-test-{}-{suffix}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_returns_none_when_no_file() {
        let dir = temp_dir("none");
        assert_eq!(load(&dir), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_load_roundtrips_local() {
        let dir = temp_dir("local");
        save(&dir, &HubMode::Local).unwrap();
        assert_eq!(load(&dir), Some(HubMode::Local));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_load_roundtrips_remote() {
        let dir = temp_dir("remote");
        let mode = HubMode::Remote { url: "https://hub.tail-xxxx.ts.net".into() };
        save(&dir, &mode).unwrap();
        assert_eq!(load(&dir), Some(mode));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_removes_saved_mode_and_is_idempotent() {
        let dir = temp_dir("clear");
        save(&dir, &HubMode::Local).unwrap();
        clear(&dir).unwrap();
        assert_eq!(load(&dir), None);
        clear(&dir).unwrap(); // missing file: still Ok
        std::fs::remove_dir_all(&dir).ok();
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd frontend/src-tauri && cargo test hubmode:: -- --nocapture`
Expected: PASS — this module has no dependency on the rest of `lib.rs`, so it compiles and passes standalone once added to `mod hubmode;` in the next step.

- [ ] **Step 3: Wire `hubmode` into `lib.rs` and add the choice/navigation flow**

Replace the entire contents of `frontend/src-tauri/src/lib.rs` with:

```rust
mod browser_tiles;
mod hubapi;
mod hubmode;
mod sidecar;

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use browser_tiles::BrowserTiles;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
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
            choose_hub_mode,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                // `tauri dev`: window already points at the Vite dev server
                // (devUrl); the Go backend comes from `npm run dev`.
                return Ok(());
            }
            app.manage(ServerProc(Mutex::new(None)));
            app.manage(ShuttingDown(AtomicBool::new(false)));
            let handle = app.handle().clone();
            // A raw SIGTERM (killall, forced logout, `pkill`) bypasses AppKit's
            // quit sequence entirely, so RunEvent::ExitRequested/Exit below never
            // fires and the sidecar is orphaned. Handle it explicitly on unix.
            #[cfg(unix)]
            install_signal_handlers(handle.clone());
            tauri::async_runtime::spawn(async move { start(&handle).await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|handle, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => kill_sidecar(handle),
            _ => {}
        });
}

/// Resolves which hub mode this install is in (or shows the first-run
/// choice screen if none is saved yet) and proceeds accordingly.
async fn start(handle: &AppHandle) {
    let data_dir = match handle.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            show_error(handle, &format!("resolve app data dir: {e}"));
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        show_error(handle, &format!("create app data dir: {e}"));
        return;
    }
    match hubmode::load(&data_dir) {
        Some(mode) => proceed_with_mode(handle, mode).await,
        None => show_choose_screen(handle),
    }
}

/// Tauri command invoked from choose.html once the operator picks a mode.
/// Persists the choice, then proceeds the same way a saved-mode launch
/// would (spawn the local sidecar, or navigate to the remote hub).
#[tauri::command]
async fn choose_hub_mode(app: AppHandle, mode: String, url: Option<String>) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let hub_mode = match mode.as_str() {
        "local" => hubmode::HubMode::Local,
        "remote" => hubmode::HubMode::Remote { url: url.ok_or("url is required for remote mode")? },
        other => return Err(format!("unknown hub mode {other}")),
    };
    hubmode::save(&data_dir, &hub_mode).map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move { proceed_with_mode(&handle, hub_mode).await });
    Ok(())
}

async fn proceed_with_mode(handle: &AppHandle, mode: hubmode::HubMode) {
    match mode {
        hubmode::HubMode::Remote { url } => navigate_remote(handle, &url),
        hubmode::HubMode::Local => run_local_respawn_loop(handle).await,
    }
}

/// Navigates the main window straight at an operator-hosted hub URL and
/// shows it. No sidecar is spawned — the window behaves like a plain
/// browser tab against that hub's existing web SPA/session-cookie login.
fn navigate_remote(handle: &AppHandle, url: &str) {
    let Ok(parsed) = url.parse() else {
        show_error(handle, &format!("invalid hub URL: {url}"));
        return;
    };
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(parsed);
        let _ = win.show();
    }
}

/// The sidecar spawn/respawn loop, reachable from both a first-run choice
/// and a saved "local" mode from a previous launch.
async fn run_local_respawn_loop(handle: &AppHandle) {
    let mut respawns = 0;
    loop {
        match launch_once(handle).await {
            LaunchEnd::Failed(msg) => {
                show_error(handle, &msg);
                break;
            }
            LaunchEnd::Crashed => {
                if handle.state::<ShuttingDown>().0.load(Ordering::SeqCst) {
                    break;
                }
                respawns += 1;
                if respawns > MAX_RESPAWNS {
                    show_error(handle, "loom-server crashed repeatedly");
                    break;
                }
            }
        }
    }
}

/// Navigates the main window to the bundled first-run choice screen.
fn show_choose_screen(handle: &AppHandle) {
    #[cfg(not(windows))]
    let url = "tauri://localhost/choose.html";
    #[cfg(windows)]
    let url = "http://tauri.localhost/choose.html";
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.navigate(url.parse().expect("static choose url"));
        let _ = win.show();
    }
}

/// Marks shutdown (stops the respawn loop) and kills the sidecar child.
/// Idempotent: the child is taken out of ServerProc, so a second call
/// (e.g. RunEvent::Exit firing after a signal handler already ran this) is
/// a no-op. Also a no-op in remote mode (no child was ever spawned).
fn kill_sidecar(handle: &AppHandle) {
    handle.state::<ShuttingDown>().0.store(true, Ordering::SeqCst);
    if let Some(child) = handle.state::<ServerProc>().0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

/// Kills the sidecar on a raw SIGTERM/SIGINT, then asks Tauri to exit
/// normally (which will also run kill_sidecar via RunEvent::Exit, safely a
/// no-op the second time).
#[cfg(unix)]
fn install_signal_handlers(handle: AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};
    tauri::async_runtime::spawn(async move {
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(_) => return,
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
        kill_sidecar(&handle);
        handle.exit(0);
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

- [ ] **Step 4: Add the choice screen static page**

Create `frontend/src-tauri/ui/choose.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Loom — choose a hub</title>
    <style>
      html, body { height: 100%; margin: 0; background: #0d1017; color: #c0c6d4;
        font: 13px/1.6 -apple-system, "Segoe UI", sans-serif; }
      body { display: grid; place-items: center; }
      main { max-width: 420px; width: 100%; padding: 0 24px; }
      h1 { font-size: 15px; margin-bottom: 16px; }
      button { display: block; width: 100%; margin: 8px 0; padding: 10px 12px;
        background: #1a1f2b; color: #c0c6d4; border: 1px solid #2a3040;
        border-radius: 6px; cursor: pointer; font: inherit; text-align: left; }
      button:hover { background: #232936; }
      input { width: 100%; padding: 8px 10px; margin: 8px 0; box-sizing: border-box;
        background: #1a1f2b; color: #c0c6d4; border: 1px solid #2a3040;
        border-radius: 6px; font: inherit; }
      #remote-form { display: none; }
      #error { color: #e46962; min-height: 18px; }
    </style>
  </head>
  <body>
    <main>
      <h1>How do you want to run Loom?</h1>
      <button id="local-btn">Host locally on this device</button>
      <button id="remote-btn">Connect to a hub I already host</button>
      <div id="remote-form">
        <input id="url" type="text" placeholder="https://hub.tail-xxxx.ts.net" />
        <button id="connect-btn">Connect</button>
      </div>
      <p id="error"></p>
    </main>
    <script>
      const invoke = window.__TAURI__.core.invoke
      const errorEl = document.getElementById('error')
      document.getElementById('local-btn').addEventListener('click', () => {
        errorEl.textContent = ''
        invoke('choose_hub_mode', { mode: 'local' }).catch((e) => {
          errorEl.textContent = String(e)
        })
      })
      document.getElementById('remote-btn').addEventListener('click', () => {
        document.getElementById('remote-form').style.display = 'block'
      })
      document.getElementById('connect-btn').addEventListener('click', () => {
        const url = document.getElementById('url').value.trim()
        if (!url) return
        errorEl.textContent = ''
        invoke('choose_hub_mode', { mode: 'remote', url }).catch((e) => {
          errorEl.textContent = String(e)
        })
      })
    </script>
  </body>
</html>
```

- [ ] **Step 5: Enable `window.__TAURI__` for the static choice page**

In `frontend/src-tauri/tauri.conf.json`, add `"withGlobalTauri": true` to the `"app"` object:

```json
  "app": {
    "withGlobalTauri": true,
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
```

- [ ] **Step 6: Run the Rust test suite and build check**

Run: `cd frontend/src-tauri && cargo test`
Expected: PASS — every existing test (`sidecar.rs`, `hubapi.rs`, `browser_tiles.rs` if any) plus the new `hubmode` tests. `sidecar_args` and `hubapi::upsert_local_machine` are unmodified, so their tests are unaffected.

Run: `cd frontend/src-tauri && cargo build`
Expected: no errors (this also validates `lib.rs` compiles with the restructured `setup()`/`start()`/`choose_hub_mode` flow).

- [ ] **Step 7: Commit**

```bash
git add frontend/src-tauri/src/hubmode.rs frontend/src-tauri/src/lib.rs frontend/src-tauri/ui/choose.html frontend/src-tauri/tauri.conf.json
git commit -m "feat(desktop): add first-run choice between hosting locally and connecting to a hub"
```

---

### Task 7: "Change Hub…" menu action

**Files:**
- Modify: `frontend/src-tauri/src/lib.rs`
- Modify: `frontend/src-tauri/Cargo.toml`
- Modify: `frontend/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `hubmode::clear` (Task 6). Must run after Task 6 (same file, `lib.rs`).

- [ ] **Step 1: Add the `tauri-plugin-process` dependency**

In `frontend/src-tauri/Cargo.toml`, add to `[dependencies]` (alongside the existing `tauri-plugin-shell = "2"`):

```toml
tauri-plugin-process = "2"
```

- [ ] **Step 2: Allow the restart permission**

In `frontend/src-tauri/capabilities/default.json`, add `"process:allow-restart"` to `"permissions"`:

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
    "allow-browser-tiles",
    "process:allow-restart"
  ]
}
```

- [ ] **Step 3: Register the plugin, add the menu, and add the `change_hub` command**

In `frontend/src-tauri/src/lib.rs`:

Add the import (alongside the existing `use tauri::{...}` line):

```rust
use tauri::menu::MenuBuilder;
```

Add a constant near `MAX_RESPAWNS`:

```rust
const CHANGE_HUB_MENU_ID: &str = "change-hub";
```

Register the plugin — change:

```rust
        .plugin(tauri_plugin_shell::init())
```

to:

```rust
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
```

Add `change_hub` to the invoke handler list — change:

```rust
        .invoke_handler(tauri::generate_handler![
            browser_tiles::browser_tile_open,
            browser_tiles::browser_tile_navigate,
            browser_tiles::browser_tile_reload,
            browser_tiles::browser_tile_set_bounds,
            browser_tiles::browser_tile_hide,
            browser_tiles::browser_tile_show,
            browser_tiles::browser_tile_close,
            choose_hub_mode,
        ])
```

to:

```rust
        .invoke_handler(tauri::generate_handler![
            browser_tiles::browser_tile_open,
            browser_tiles::browser_tile_navigate,
            browser_tiles::browser_tile_reload,
            browser_tiles::browser_tile_set_bounds,
            browser_tiles::browser_tile_hide,
            browser_tiles::browser_tile_show,
            browser_tiles::browser_tile_close,
            choose_hub_mode,
            change_hub,
        ])
```

Add the menu inside `.setup()`, right after `app.manage(ShuttingDown(AtomicBool::new(false)));`:

```rust
            app.manage(ServerProc(Mutex::new(None)));
            app.manage(ShuttingDown(AtomicBool::new(false)));
            let menu = MenuBuilder::new(app).text(CHANGE_HUB_MENU_ID, "Change Hub…").build()?;
            app.set_menu(menu)?;
            app.on_menu_event(move |app_handle, event| {
                if event.id() == CHANGE_HUB_MENU_ID {
                    let _ = change_hub(app_handle.clone());
                }
            });
            let handle = app.handle().clone();
```

Add the `change_hub` command (place it near `choose_hub_mode`):

```rust
/// Clears the saved hub mode and restarts the app. On restart, `start`
/// (see Step 3 of Task 6) finds no saved mode and shows the first-run
/// choice screen again. Using a full app restart (rather than hand-rolled
/// cross-task cancellation of the running respawn loop) means the normal
/// RunEvent::Exit handler kills any local sidecar exactly as it would on a
/// real quit — no separate teardown path to get right.
#[tauri::command]
fn change_hub(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    hubmode::clear(&data_dir).map_err(|e| e.to_string())?;
    app.restart();
}
```

- [ ] **Step 4: Run the Rust test suite and build check**

Run: `cd frontend/src-tauri && cargo test`
Expected: PASS — no test exercises the menu or `change_hub` directly (menu wiring is UI-only and covered by the manual smoke check below, matching this codebase's existing precedent of keeping Rust unit tests to pure helpers).

Run: `cd frontend/src-tauri && cargo build`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src-tauri/src/lib.rs frontend/src-tauri/Cargo.toml frontend/src-tauri/Cargo.lock frontend/src-tauri/capabilities/default.json
git commit -m "feat(desktop): add a Change Hub menu action that restarts into the choice screen"
```

---

## Final integration check (after all 7 tasks)

- [ ] Run the full backend suite once more: `cd backend && go build ./... && go vet ./... && go test ./...` — expect PASS.
- [ ] Run `cd frontend && npm run typecheck` — expect PASS (no frontend/SPA files were touched by this plan, but this confirms nothing else regressed).
- [ ] Run `cd frontend/src-tauri && cargo build && cargo test` — expect PASS.
- [ ] Manual smoke (desktop, release build): `cd frontend && npm run tauri:build`, launch the built app fresh (no `hub-mode.json` yet) — confirm the choice screen appears, "Host locally" behaves exactly as before (splash → sidecar → SPA), and "Connect to a hub" navigates to an operator-typed URL and shows that hub's login screen. Confirm "Change Hub…" (app menu) returns to the choice screen.

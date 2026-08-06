# Host Metrics Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stats pane showing live CPU, memory and disk for either a runtime machine or an SSH host, using one shared shape for both.

**Architecture:** Machines are measured in-process with gopsutil behind `GET /api/system/stats`. SSH hosts are measured by one batched `/proc` + `df` command over the existing pooled `sshmgr` exec path, parsed server-side into the same struct. No persistence — the frontend polls every 2s and keeps a rolling ~5 minute window in React state.

**Tech Stack:** Go 1.26, `github.com/shirou/gopsutil/v4`, existing `internal/sshmgr` exec pool, React 19 + TanStack Query + recharts 3.9 via `@/components/ui/chart`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-host-metrics-charts-design.md`

## Global Constraints

- Dependency: `github.com/shirou/gopsutil/v4` at `v4.26.7` (BSD-3-Clause). It is the **only** new dependency. Update `NOTICE`.
- All API responses use the `{"error":"message"}` envelope via `writeErr` / `writeJSON`. SSH handlers use `handleStoreErr` for store errors.
- `frontend/src/store/types.ts` and `backend/internal/domain/models.go` must stay in sync.
- Frontend imports use the `@/*` alias; `import type` for type-only imports.
- Icons: `lucide-react` only. Class merging: `cn()` from `@/lib/utils`.
- Charts use `ChartContainer` / `ChartTooltip` / `ChartTooltipContent` from `@/components/ui/chart`, with colors from the `--devdeck-*` CSS custom properties in `src/styles/globals.css`. Never hardcode hexes that aren't already tokens.
- Every data surface renders explicit loading, error, empty **and unsupported** states.
- **New frontend test files must be added to `test.include` in `frontend/vite.config.ts`** or they will not run.
- `frontend/src/features/terminal/paneTree.ts` is deliberately pure and store-free — do not import the store or React into it.
- **Convergence files:** `backend/internal/domain/models.go`, `backend/cmd/server/main.go`, `frontend/src/store/types.ts`. This plan is sequential.
- Verify with `npm run typecheck` (frontend) and `go vet ./...` (backend).

## Error handling (from the spec — binding on every task)

Reproduced verbatim from the spec rather than referenced, because a per-task
brief is the only thing a reviewer checks the code against: a requirement that
lives only in the spec is a requirement no per-task review can enforce. The
first version of this plan omitted this table, and the SSH collector shipped
turning *every* transport failure into `200 {"supported":false}` — which made
the handler's error path unreachable and the pane's error state dead code —
through three rounds of review, because no brief ever said otherwise.

All REST errors use the mandatory `{"error":"message"}` envelope.

| Condition | Behaviour |
|---|---|
| SSH host has no `/proc` | `200` with `supported:false` + reason. Pane renders an explanatory empty state. |
| SSH connection unreachable / auth failure | Normal handler error envelope; pane renders its error state and keeps retrying on the poll interval. |
| First SSH sample | `cpuPct: null`; chart shows mem/disk immediately, CPU from the second tick. |
| Counter goes backwards (reboot) | Sample discarded, `cpuPct: null`, previous sample replaced. |
| `disk.Usage("/")` fails on a machine | Zeroed `Disk` with the error surfaced; CPU/mem still render. |
| Machine offline | Existing machine-transport error path; pane error state. |

Two consequences worth stating outright, since both were got wrong:

- **"Cannot be measured" and "could not be reached" are different answers.**
  The first is a fact about the host and is a `200`. The second is a failure of
  the request and must reach the client as an error envelope. Collapsing them
  loses the second one entirely.
- **`cpuPct: null` is never rendered as `0`.** Not in the headline number and
  not in the chart series — a fabricated zero reads as "idle", which is a
  claim the collector did not make.

---

### Task 1: Domain types and frontend mirror

**Files:**
- Modify: `backend/internal/domain/models.go`
- Modify: `frontend/src/store/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `domain.Usage{Used, Total uint64}`, `domain.HostStats{Supported, Reason, CPUPct *float64, Mem, Disk Usage, SampledAt time.Time}`; TS mirror `Usage` and `HostStats`. Every later task uses both.

- [ ] **Step 1: Add the Go types**

In `backend/internal/domain/models.go`, near the other machine types:

```go
// Usage is a used/total byte pair, for memory and disk.
type Usage struct {
	Used  uint64 `json:"used"`
	Total uint64 `json:"total"`
}

// HostStats is one live CPU/memory/disk sample. Deliberately identical for a
// runtime machine (measured in-process by internal/hoststats) and an SSH host
// (measured by a batched /proc + df command), so the chart component never
// branches on where the numbers came from.
type HostStats struct {
	// Supported is false when the target cannot be measured — e.g. an SSH
	// host with no /proc. Reporting this beats approximating: wrong numbers
	// on an ops readout are worse than no numbers.
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	// CPUPct is nil when no delta exists yet. /proc/stat reports cumulative
	// jiffies, so the first sample after opening a pane genuinely has no
	// answer — nil says "unknown" where 0 would wrongly read as "idle".
	CPUPct    *float64  `json:"cpuPct"`
	Mem       Usage     `json:"mem"`
	Disk      Usage     `json:"disk"`
	SampledAt time.Time `json:"sampledAt"`
}
```

Confirm `time` is already imported in that file; add it if not.

- [ ] **Step 2: Add the TS mirror**

In `frontend/src/store/types.ts`:

```ts
/** Mirror of backend/internal/domain/Usage. */
export interface Usage {
  used: number
  total: number
}

/** Mirror of backend/internal/domain/HostStats — one live CPU/mem/disk sample.
 *  Identical for a machine and an SSH host by design. */
export interface HostStats {
  supported: boolean
  reason?: string
  /** null until a delta exists — see the Go doc comment. */
  cpuPct: number | null
  mem: Usage
  disk: Usage
  sampledAt: string
}
```

- [ ] **Step 3: Verify both sides compile**

Run: `cd backend && go build ./... && cd ../frontend && npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add backend/internal/domain/models.go frontend/src/store/types.ts
git commit -m "feat(stats): add HostStats domain type and frontend mirror"
```

---

### Task 2: Local collector (`internal/hoststats`)

**Files:**
- Create: `backend/internal/hoststats/hoststats.go`
- Test: `backend/internal/hoststats/hoststats_test.go` (create)
- Modify: `backend/go.mod`, `backend/go.sum`
- Modify: `NOTICE`

**Interfaces:**
- Consumes: `domain.HostStats`, `domain.Usage` (Task 1).
- Produces: `hoststats.NewCollector() *Collector` and `(*Collector).Collect() (domain.HostStats, error)`. Task 3 consumes both.

- [ ] **Step 1: Add the dependency**

```bash
cd backend && go get github.com/shirou/gopsutil/v4@v4.26.7
```

- [ ] **Step 2: Write the failing test**

Create `backend/internal/hoststats/hoststats_test.go`:

```go
package hoststats

import (
	"sync"
	"testing"
	"time"
)

func TestCollectReturnsPlausibleTotals(t *testing.T) {
	c := NewCollector()

	stats, err := c.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !stats.Supported {
		t.Fatalf("Supported = false on the test host: %s", stats.Reason)
	}
	if stats.Mem.Total == 0 {
		t.Error("Mem.Total = 0; the test host must report some memory")
	}
	if stats.Mem.Used > stats.Mem.Total {
		t.Errorf("Mem.Used (%d) > Mem.Total (%d)", stats.Mem.Used, stats.Mem.Total)
	}
	if stats.Disk.Total == 0 {
		t.Error("Disk.Total = 0; the root filesystem must report some size")
	}
	if stats.SampledAt.IsZero() {
		t.Error("SampledAt is zero")
	}
}

func TestCollectCPUPctInRange(t *testing.T) {
	c := NewCollector()
	// First call primes gopsutil's internal delta window.
	if _, err := c.Collect(); err != nil {
		t.Fatalf("first Collect: %v", err)
	}
	time.Sleep(60 * time.Millisecond)

	stats, err := c.Collect()
	if err != nil {
		t.Fatalf("second Collect: %v", err)
	}
	if stats.CPUPct == nil {
		return // acceptable: no delta was available yet
	}
	if *stats.CPUPct < 0 || *stats.CPUPct > 100 {
		t.Errorf("CPUPct = %f, want 0..100", *stats.CPUPct)
	}
}

// Concurrent callers must not corrupt each other's CPU delta window.
func TestCollectIsSafeUnderConcurrency(t *testing.T) {
	c := NewCollector()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 5; j++ {
				stats, err := c.Collect()
				if err != nil {
					t.Errorf("Collect: %v", err)
					return
				}
				if stats.CPUPct != nil && (*stats.CPUPct < 0 || *stats.CPUPct > 100) {
					t.Errorf("CPUPct out of range: %f", *stats.CPUPct)
					return
				}
			}
		}()
	}
	wg.Wait()
}

func TestCollectCachesWithinTTL(t *testing.T) {
	c := NewCollector()
	first, err := c.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	second, err := c.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !first.SampledAt.Equal(second.SampledAt) {
		t.Error("two immediate calls produced different samples; the cache is not working")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && go test ./internal/hoststats/ -v`
Expected: FAIL — `NewCollector` undefined.

- [ ] **Step 4: Write the collector**

Create `backend/internal/hoststats/hoststats.go`:

```go
// Package hoststats measures this machine's own CPU, memory and root-disk
// usage. Its SSH counterpart (service.SSHStatsService) produces the same
// domain.HostStats from a remote /proc read, so the two are interchangeable
// to every consumer above them.
package hoststats

import (
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"

	"devdeck/backend/internal/domain"
)

// cacheTTL bounds how stale a served sample may be. It exists for
// correctness, not just cost: cpu.Percent(0, false) is delta-since-last-call,
// so two clients polling concurrently would each consume the other's window
// and report nonsense. Sharing one sample for a beat fixes that. It is well
// under the frontend's 2s poll, so it never makes the chart look frozen.
const cacheTTL = time.Second

// rootPath is the filesystem the disk figure describes. Root only — a
// multi-volume readout is explicitly out of scope.
const rootPath = "/"

// Collector serves cached host samples. Safe for concurrent use.
type Collector struct {
	mu     sync.Mutex
	last   domain.HostStats
	lastAt time.Time
}

func NewCollector() *Collector { return &Collector{} }

// Collect returns a sample no older than cacheTTL.
func (c *Collector) Collect() (domain.HostStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	if !c.lastAt.IsZero() && now.Sub(c.lastAt) < cacheTTL {
		return c.last, nil
	}

	stats := domain.HostStats{Supported: true, SampledAt: now}

	// percpu=false gives one aggregate figure; interval 0 means "delta since
	// the previous call" rather than blocking to sample a window.
	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		pct := pcts[0]
		if pct >= 0 && pct <= 100 {
			stats.CPUPct = &pct
		}
	}

	vm, err := mem.VirtualMemory()
	if err != nil {
		return domain.HostStats{}, err
	}
	stats.Mem = domain.Usage{Used: vm.Total - vm.Available, Total: vm.Total}

	// A failed disk read must not sink the whole sample — CPU and memory are
	// still worth showing. It must not vanish either: the Disk figure stays
	// zeroed, and Reason says why, so the pane explains the zeros instead of
	// asserting them (the error-handling table's "disk.Usage fails" row).
	if du, err := diskUsage(rootPath); err == nil {
		stats.Disk = domain.Usage{Used: du.Used, Total: du.Total}
	} else {
		stats.Reason = "disk usage unavailable: " + err.Error()
	}

	c.last = stats
	c.lastAt = now
	return stats, nil
}
```

`diskUsage` is a package-level `var diskUsage = disk.Usage`, purely as a test
seam: the failure branch is real — the Windows runtime has no `/` volume — but
it cannot be provoked on a host where the call succeeds, and an unexercised
error branch is how "0 B / 0 B with no explanation" survives review.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/hoststats/ -race -v`
Expected: 4 tests PASS, no race detected.

- [ ] **Step 6: Update NOTICE**

Add gopsutil to `NOTICE`, following the format already used there for other third-party Go modules:

```
github.com/shirou/gopsutil/v4
Copyright (c) 2014, WAKAYAMA Shirou
Licensed under the BSD 3-Clause License.
```

Read the existing `NOTICE` first and match its exact formatting rather than appending a differently-shaped block.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/hoststats/ backend/go.mod backend/go.sum NOTICE
git commit -m "feat(stats): add hoststats local CPU/mem/disk collector"
```

---

### Task 3: `GET /api/system/stats`

**Files:**
- Create: `backend/internal/handler/systemstats.go`
- Test: `backend/internal/handler/systemstats_test.go` (create)
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: `hoststats.NewCollector`, `Collect` (Task 2).
- Produces: `handler.NewSystemStatsHandler(c *hoststats.Collector) *SystemStatsHandler` with `Get(w, r)`; the live route `GET /api/system/stats` on every role. Task 6 calls it from the frontend.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/handler/systemstats_test.go`:

```go
package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/hoststats"
)

func TestSystemStatsGetReturnsSupportedSample(t *testing.T) {
	h := NewSystemStatsHandler(hoststats.NewCollector())
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodGet, "/api/system/stats", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body domain.HostStats
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Supported {
		t.Errorf("Supported = false, reason %q", body.Reason)
	}
	if body.Mem.Total == 0 {
		t.Error("Mem.Total = 0")
	}
}

func TestSystemStatsRejectsWrongMethod(t *testing.T) {
	h := NewSystemStatsHandler(hoststats.NewCollector())
	rec := httptest.NewRecorder()

	h.Get(rec, httptest.NewRequest(http.MethodPost, "/api/system/stats", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/handler/ -run SystemStats -v`
Expected: FAIL — `NewSystemStatsHandler` undefined.

- [ ] **Step 3: Write the handler**

Create `backend/internal/handler/systemstats.go`:

```go
package handler

import (
	"net/http"

	"devdeck/backend/internal/hoststats"
)

// SystemStatsHandler serves this machine's own live CPU/memory/disk sample.
// Registered on every role: measuring a runtime is the primary use case, so
// unlike most hub routes this one is deliberately not role-gated.
type SystemStatsHandler struct {
	collector *hoststats.Collector
}

func NewSystemStatsHandler(collector *hoststats.Collector) *SystemStatsHandler {
	return &SystemStatsHandler{collector: collector}
}

func (h *SystemStatsHandler) Get(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	stats, err := h.collector.Collect()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}
```

- [ ] **Step 4: Wire it in main.go**

Construct it near the other handlers (after the `publishedSOCKSH` line if the SOCKS5 plan landed first, otherwise near `proxyH`):

```go
	systemStatsH := handler.NewSystemStatsHandler(hoststats.NewCollector())
```

Register it next to the other non-role-gated routes (near `POST /api/proxy/start`):

```go
	// Every role: this is how a runtime reports its own load.
	mux.HandleFunc("GET /api/system/stats", systemStatsH.Get)
```

Add `"devdeck/backend/internal/hoststats"` to the imports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && go test ./internal/handler/ -run SystemStats -v && go build ./... && go vet ./...`
Expected: 2 tests PASS, build and vet clean.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/systemstats.go backend/internal/handler/systemstats_test.go \
        backend/cmd/server/main.go
git commit -m "feat(stats): serve local host stats at GET /api/system/stats"
```

---

### Task 4: `/proc` and `df` parsers

Pure functions, no I/O — the whole SSH correctness surface lives here, so it gets its own task and its own table-driven tests.

Four of these functions shipped with a wrong-numbers bug that a
happy-path fixture cannot catch, so the fixtures must include the awkward
cases explicitly. Beyond the fixtures listed below, cover:

- a `/proc/stat` line with **non-zero `guest` and `guest_nice`** — a fixture
  with those columns at 0 cannot distinguish a correct parser from one that
  double-counts guest time, which is why the bug survived;
- a `/proc/meminfo` with **`MemAvailable` greater than `MemTotal`** (lxcfs
  fakes this per-container), asserting a clamp rather than a uint64 underflow;
- a `df` data row whose **Filesystem column contains `---`**
  (`/dev/mapper/vg---root`), asserting the sample still parses;
- `statsCommand` running **`df -Pk /`**, since `parseDF` hard-codes a 1024
  block size that plain `-P` does not guarantee.

**Files:**
- Create: `backend/internal/service/sshstats_parse.go`
- Test: `backend/internal/service/sshstats_parse_test.go` (create)

**Interfaces:**
- Consumes: `domain.Usage` (Task 1).
- Produces:
  - `type cpuSample struct{ total, idle uint64 }`
  - `parseProcStat(text string) (cpuSample, error)`
  - `cpuPercent(prev, cur cpuSample) *float64`
  - `parseMeminfo(text string) (domain.Usage, error)`
  - `parseDF(text string) (domain.Usage, error)`
  - `splitStatsOutput(out string) (procStat, meminfo, df string, err error)`

  Task 5 consumes all six. They are unexported — same package.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/service/sshstats_parse_test.go`:

```go
package service

import "testing"

const sampleProcStat = `cpu  100 20 30 800 40 0 10 0 0 0
cpu0 50 10 15 400 20 0 5 0 0 0
intr 12345
ctxt 67890
`

const sampleMeminfo = `MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:    8000000 kB
Buffers:          200000 kB
Cached:          4000000 kB
SwapTotal:       2048000 kB
`

const sampleMeminfoNoAvailable = `MemTotal:       16384000 kB
MemFree:         1000000 kB
Buffers:          200000 kB
Cached:          4000000 kB
`

const sampleDF = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1        102400000  41000000  61400000      41% /
`

func TestParseProcStat(t *testing.T) {
	got, err := parseProcStat(sampleProcStat)
	if err != nil {
		t.Fatalf("parseProcStat: %v", err)
	}
	// 100+20+30+800+40+0+10+0+0+0 = 1000
	if got.total != 1000 {
		t.Errorf("total = %d, want 1000", got.total)
	}
	// idle(800) + iowait(40) = 840
	if got.idle != 840 {
		t.Errorf("idle = %d, want 840", got.idle)
	}
}

func TestParseProcStatRejectsGarbage(t *testing.T) {
	for name, input := range map[string]string{
		"empty":         "",
		"no cpu line":   "intr 1\nctxt 2\n",
		"too few cols":  "cpu 1 2\n",
		"non-numeric":   "cpu a b c d e f g h\n",
	} {
		if _, err := parseProcStat(input); err == nil {
			t.Errorf("%s: expected an error, got nil", name)
		}
	}
}

func TestCPUPercent(t *testing.T) {
	tests := []struct {
		name       string
		prev, cur  cpuSample
		wantNil    bool
		want       float64
	}{
		{
			name: "half busy",
			prev: cpuSample{total: 1000, idle: 800},
			cur:  cpuSample{total: 2000, idle: 1300},
			// totalDelta 1000, idleDelta 500 => 50%
			want: 50,
		},
		{
			name: "fully idle",
			prev: cpuSample{total: 1000, idle: 800},
			cur:  cpuSample{total: 2000, idle: 1800},
			want: 0,
		},
		{
			name: "fully busy",
			prev: cpuSample{total: 1000, idle: 800},
			cur:  cpuSample{total: 2000, idle: 800},
			want: 100,
		},
		{
			name:    "no elapsed time",
			prev:    cpuSample{total: 1000, idle: 800},
			cur:     cpuSample{total: 1000, idle: 800},
			wantNil: true,
		},
		{
			name:    "counter went backwards (reboot)",
			prev:    cpuSample{total: 5000, idle: 4000},
			cur:     cpuSample{total: 1000, idle: 800},
			wantNil: true,
		},
		{
			name:    "idle outran total",
			prev:    cpuSample{total: 1000, idle: 800},
			cur:     cpuSample{total: 1100, idle: 1000},
			wantNil: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := cpuPercent(tc.prev, tc.cur)
			if tc.wantNil {
				if got != nil {
					t.Fatalf("got %f, want nil", *got)
				}
				return
			}
			if got == nil {
				t.Fatal("got nil, want a value")
			}
			if *got != tc.want {
				t.Errorf("got %f, want %f", *got, tc.want)
			}
		})
	}
}

func TestParseMeminfoPrefersMemAvailable(t *testing.T) {
	got, err := parseMeminfo(sampleMeminfo)
	if err != nil {
		t.Fatalf("parseMeminfo: %v", err)
	}
	const kb = 1024
	if got.Total != 16384000*kb {
		t.Errorf("Total = %d, want %d", got.Total, uint64(16384000*kb))
	}
	// used = MemTotal - MemAvailable = 16384000 - 8000000 = 8384000 kB
	if got.Used != 8384000*kb {
		t.Errorf("Used = %d, want %d", got.Used, uint64(8384000*kb))
	}
}

func TestParseMeminfoFallsBackWithoutMemAvailable(t *testing.T) {
	got, err := parseMeminfo(sampleMeminfoNoAvailable)
	if err != nil {
		t.Fatalf("parseMeminfo: %v", err)
	}
	const kb = 1024
	// used = Total - Free - Buffers - Cached
	//      = 16384000 - 1000000 - 200000 - 4000000 = 11184000 kB
	if got.Used != 11184000*kb {
		t.Errorf("Used = %d, want %d", got.Used, uint64(11184000*kb))
	}
}

func TestParseMeminfoRejectsMissingTotal(t *testing.T) {
	if _, err := parseMeminfo("MemFree: 100 kB\n"); err == nil {
		t.Fatal("expected an error when MemTotal is absent")
	}
}

func TestParseDF(t *testing.T) {
	got, err := parseDF(sampleDF)
	if err != nil {
		t.Fatalf("parseDF: %v", err)
	}
	const block = 1024
	if got.Total != 102400000*block {
		t.Errorf("Total = %d, want %d", got.Total, uint64(102400000*block))
	}
	if got.Used != 41000000*block {
		t.Errorf("Used = %d, want %d", got.Used, uint64(41000000*block))
	}
}

func TestParseDFRejectsHeaderOnly(t *testing.T) {
	if _, err := parseDF("Filesystem 1024-blocks Used Available Capacity Mounted on\n"); err == nil {
		t.Fatal("expected an error when df has no data row")
	}
}

func TestSplitStatsOutput(t *testing.T) {
	out := sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF
	stat, meminfo, df, err := splitStatsOutput(out)
	if err != nil {
		t.Fatalf("splitStatsOutput: %v", err)
	}
	if stat == "" || meminfo == "" || df == "" {
		t.Fatalf("empty section: stat=%d meminfo=%d df=%d", len(stat), len(meminfo), len(df))
	}
	if _, err := parseProcStat(stat); err != nil {
		t.Errorf("stat section does not parse: %v", err)
	}
}

func TestSplitStatsOutputRejectsWrongSectionCount(t *testing.T) {
	if _, _, _, err := splitStatsOutput("only one section\n"); err == nil {
		t.Fatal("expected an error for a single-section output")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run 'ParseProc|CPUPercent|ParseMeminfo|ParseDF|SplitStats' -v`
Expected: FAIL — `parseProcStat` undefined.

- [ ] **Step 3: Write the parsers**

Create `backend/internal/service/sshstats_parse.go`:

```go
package service

import (
	"fmt"
	"strconv"
	"strings"

	"devdeck/backend/internal/domain"
)

// statsSectionSep separates the three payloads in the single batched command
// SSHStatsService runs. One round trip matters: this polls every 2s over a
// link that may be transcontinental.
const statsSectionSep = "---"

// cpuSample is one cumulative /proc/stat reading. Both fields are jiffies
// since boot, so a percentage needs two samples and the delta between them.
type cpuSample struct {
	total uint64
	idle  uint64
}

// Column offsets within the aggregate "cpu " line, after the leading label.
const (
	colUser = iota
	colNice
	_ // system
	colIdle
	colIOWait
	_ // irq
	_ // softirq
	_ // steal
	colGuest
	colGuestNice
)

// minCPUColumns is user through softirq. steal, guest and guest_nice arrived
// in later kernels and are read only when present.
const minCPUColumns = 7

// parseProcStat reads the aggregate "cpu " line. Idle counts idle+iowait:
// a CPU waiting on disk is not doing work, and treating iowait as busy makes
// an I/O-bound host look pegged.
//
// Guest time is subtracted back out of user and nice before summing. The
// kernel's account_guest_time folds guest into user and guest_nice into nice
// *and* publishes both in their own columns, so a naive sum of all ten counts
// that time twice — inflating total while idle stands still, which drags a
// hypervisor's busy% toward 100 (a box at a true 50% reads as 67%). procps and
// htop do the same subtraction. Test it with non-zero guest columns: a fixture
// with guest at 0 cannot tell the two implementations apart.
func parseProcStat(text string) (cpuSample, error) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "cpu" {
			continue
		}
		// user nice system idle iowait irq softirq [steal guest guest_nice]
		values := fields[1:]
		if len(values) < minCPUColumns {
			return cpuSample{}, fmt.Errorf("/proc/stat cpu line has %d fields, want at least %d", len(values), minCPUColumns)
		}
		cols := make([]uint64, len(values))
		for i, raw := range values {
			v, err := strconv.ParseUint(raw, 10, 64)
			if err != nil {
				return cpuSample{}, fmt.Errorf("/proc/stat field %d: %w", i, err)
			}
			cols[i] = v
		}
		if len(cols) > colGuest {
			cols[colUser] = subFloor(cols[colUser], cols[colGuest])
		}
		if len(cols) > colGuestNice {
			cols[colNice] = subFloor(cols[colNice], cols[colGuestNice])
		}

		var sample cpuSample
		for i, v := range cols {
			sample.total += v
			if i == colIdle || i == colIOWait {
				sample.idle += v
			}
		}
		return sample, nil
	}
	return cpuSample{}, fmt.Errorf("/proc/stat has no aggregate cpu line")
}

// subFloor subtracts without wrapping. guest can only exceed user on a kernel
// that is lying to us; 0 is the honest answer there, not 1.8e19.
func subFloor(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
}

// cpuPercent returns busy percentage between two samples, or nil when the
// delta is unusable: no elapsed jiffies, or counters that went backwards
// (the host rebooted between polls). nil means "unknown" — reporting 0 there
// would read as "idle", which is a different and wrong claim.
func cpuPercent(prev, cur cpuSample) *float64 {
	if cur.total <= prev.total || cur.idle < prev.idle {
		return nil
	}
	totalDelta := float64(cur.total - prev.total)
	idleDelta := float64(cur.idle - prev.idle)
	if idleDelta > totalDelta {
		return nil
	}
	pct := (totalDelta - idleDelta) / totalDelta * 100
	return &pct
}

// parseMeminfo converts /proc/meminfo (kB units) to bytes. MemAvailable is
// the kernel's own estimate of what a new workload could claim and is the
// right "free" figure; the Free+Buffers+Cached fallback covers kernels older
// than 3.14 that do not publish it.
func parseMeminfo(text string) (domain.Usage, error) {
	vals := map[string]uint64{}
	for _, line := range strings.Split(text, "\n") {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		v, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		vals[key] = v * 1024 // every /proc/meminfo value is in kB
	}

	total, ok := vals["MemTotal"]
	if !ok || total == 0 {
		return domain.Usage{}, fmt.Errorf("/proc/meminfo has no MemTotal")
	}
	// Both branches clamp: a container's synthesised /proc/meminfo (lxcfs) can
	// report more available than total, and an unclamped subtraction wraps
	// uint64 into "16.0 EB used".
	if available, ok := vals["MemAvailable"]; ok {
		return domain.Usage{Used: subFloor(total, available), Total: total}, nil
	}
	free := vals["MemFree"] + vals["Buffers"] + vals["Cached"]
	return domain.Usage{Used: subFloor(total, free), Total: total}, nil
}

// parseDF reads `df -Pk /` output. -P forces POSIX single-line records, so a
// long device name cannot wrap and shift the columns; -k pins the block size
// this function hard-codes (see statsCommand).
func parseDF(text string) (domain.Usage, error) {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) < 2 {
		return domain.Usage{}, fmt.Errorf("df output has no data row")
	}
	// Filesystem 1024-blocks Used Available Capacity Mounted-on
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 4 {
		return domain.Usage{}, fmt.Errorf("df data row has %d fields, want at least 4", len(fields))
	}
	const blockSize = 1024
	total, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return domain.Usage{}, fmt.Errorf("df total blocks: %w", err)
	}
	used, err := strconv.ParseUint(fields[2], 10, 64)
	if err != nil {
		return domain.Usage{}, fmt.Errorf("df used blocks: %w", err)
	}
	return domain.Usage{Used: used * blockSize, Total: total * blockSize}, nil
}

// splitStatsOutput cuts the batched command's stdout into its three payloads.
//
// Bounded at three parts, not split on every occurrence: the separator is a
// bare "---" and df's Filesystem column is arbitrary remote text — LVM doubles
// the hyphens in device-mapper names, so an ordinary root on a VG named "vg-"
// prints "/dev/mapper/vg---root". df is the last section, so stopping the
// split there puts every such occurrence harmlessly inside the df payload
// instead of shattering the whole sample into "unsupported".
func splitStatsOutput(out string) (procStat, meminfo, df string, err error) {
	parts := strings.SplitN(out, statsSectionSep, 3)
	if len(parts) != 3 {
		return "", "", "", fmt.Errorf("stats output has %d sections, want 3", len(parts))
	}
	return parts[0], parts[1], parts[2], nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run 'ParseProc|CPUPercent|ParseMeminfo|ParseDF|SplitStats' -v`
Expected: all PASS (note `TestParseProcStatRejectsGarbage` and `TestCPUPercent` are table-driven with several subcases).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/sshstats_parse.go backend/internal/service/sshstats_parse_test.go
git commit -m "feat(stats): add /proc and df parsers for SSH host metrics"
```

---

### Task 5: SSH stats service and route

**Files:**
- Create: `backend/internal/service/sshstats.go`
- Test: `backend/internal/service/sshstats_test.go` (create)
- Create: `backend/internal/handler/sshstats.go`
- Test: `backend/internal/handler/sshstats_test.go` (create) — the success
  shape, the unsupported `200`, and the `{"error":...}` envelope. The envelope
  case is not optional: without a test that asserts a non-200, "the service can
  never return an error" is invisible, and the handler's error path is dead
  code that reads as live.
- Modify: `backend/cmd/server/main.go`

**Interfaces:**
- Consumes: the six parser helpers (Task 4); `sshmgr.RunCommand(ctx, pool, connectionID, args) ([]byte, []byte, error)` and `sshmgr.NewFilePool` (existing).
- Produces: `service.NewSSHStatsService(pool *sshmgr.FilePool) *SSHStatsService`, `(*SSHStatsService).Collect(ctx, connectionID string) (domain.HostStats, error)`; `handler.NewSSHStatsHandler(svc) *SSHStatsHandler` with `Get(w, r)`; route `GET /api/ssh/connections/{id}/stats`.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/service/sshstats_test.go`. These exercise the delta
state machine through an injectable runner, so no SSH server is needed. The
runner is `func(ctx, connectionID) (stdout, stderr string, err error)`: `err`
means *transport*, and the third return is what keeps the error-handling
table's first two rows apart.

```go
package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

var fullSample = sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF

func okRunner(out string) statsRunner {
	return func(context.Context, string) (string, string, error) { return out, "", nil }
}

func TestSSHStatsFirstSampleHasNilCPU(t *testing.T) {
	svc := newSSHStatsServiceWithRunner(okRunner(fullSample))

	stats, err := svc.Collect(context.Background(), "conn-1")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !stats.Supported {
		t.Fatalf("Supported = false: %s", stats.Reason)
	}
	if stats.CPUPct != nil {
		t.Errorf("CPUPct = %f on the first sample, want nil", *stats.CPUPct)
	}
	if stats.Mem.Total == 0 || stats.Disk.Total == 0 {
		t.Error("mem/disk should be populated even on the first sample")
	}
}

func TestSSHStatsSecondSampleComputesCPU(t *testing.T) {
	outputs := []string{
		sampleProcStat + "---\n" + sampleMeminfo + "---\n" + sampleDF,
		// total 2000, idle+iowait 1300 => 50% busy against the first sample
		"cpu  200 40 60 1300 0 0 400 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
	}
	i := 0
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, string, error) {
		out := outputs[i]
		i++
		return out, "", nil
	})
	ctx := context.Background()

	if _, err := svc.Collect(ctx, "conn-1"); err != nil {
		t.Fatalf("first Collect: %v", err)
	}
	stats, err := svc.Collect(ctx, "conn-1")
	if err != nil {
		t.Fatalf("second Collect: %v", err)
	}
	if stats.CPUPct == nil {
		t.Fatal("CPUPct = nil on the second sample, want a value")
	}
	if *stats.CPUPct != 50 {
		t.Errorf("CPUPct = %f, want 50", *stats.CPUPct)
	}
}

func TestSSHStatsPerConnectionDeltaIsolation(t *testing.T) {
	svc := newSSHStatsServiceWithRunner(okRunner(fullSample))
	ctx := context.Background()

	if _, err := svc.Collect(ctx, "conn-a"); err != nil {
		t.Fatal(err)
	}
	// conn-b's first sample must still be nil — it does not inherit conn-a's.
	stats, err := svc.Collect(ctx, "conn-b")
	if err != nil {
		t.Fatal(err)
	}
	if stats.CPUPct != nil {
		t.Errorf("conn-b CPUPct = %f, want nil on its own first sample", *stats.CPUPct)
	}
}

// The two rows of the error-handling table, in one table-driven test. This is
// the case the first version of this plan got wrong: it asserted that *any*
// runner error must come back as Supported:false, which is true of a `cat`
// that found no /proc and false of a host that was never reached.
func TestSSHStatsSeparatesTransportFailureFromUnmeasurableHost(t *testing.T) {
	tests := []struct {
		name           string
		stdout, stderr string
		runErr         error
		wantErr        string // substring; empty means "no error"
		wantSupported  bool
		wantReason     string // substring
	}{
		{name: "auth failure", runErr: errors.New("ssh: handshake failed: unable to authenticate"), wantErr: "unable to authenticate"},
		{name: "connection refused", runErr: errors.New("connect: connection refused"), wantErr: "connection refused"},
		{name: "host key rejected", runErr: errors.New("ssh: host key mismatch"), wantErr: "host key mismatch"},
		{name: "poll timed out", runErr: context.DeadlineExceeded, wantErr: context.DeadlineExceeded.Error()},
		{
			// The command ran: sh printed the separators and df's output, and
			// cat complained. Reachable, unmeasurable.
			name:       "ran but the host has no /proc",
			stdout:     "---\n---\n" + sampleDF,
			stderr:     "cat: /proc/stat: No such file or directory\n",
			wantReason: "/proc/stat: No such file or directory",
		},
		{name: "ran and printed nothing usable", stdout: "not remotely a proc dump", wantReason: "Linux only"},
		{name: "healthy host", stdout: fullSample, wantSupported: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, string, error) {
				return tc.stdout, tc.stderr, tc.runErr
			})

			stats, err := svc.Collect(context.Background(), "conn-1")

			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("Collect returned nil error; the handler can never surface an envelope. stats = %+v", stats)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %q, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Collect: %v", err)
			}
			if stats.Supported != tc.wantSupported {
				t.Fatalf("Supported = %v, want %v (reason %q)", stats.Supported, tc.wantSupported, stats.Reason)
			}
			if tc.wantReason != "" && !strings.Contains(stats.Reason, tc.wantReason) {
				t.Errorf("Reason = %q, want it to contain %q", stats.Reason, tc.wantReason)
			}
		})
	}
}

// ranAndFailed is what keeps the branches apart in production, where the
// runner is sshmgr.RunCommand rather than a closure.
func TestRanAndFailedOnlyMatchesARemoteExitStatus(t *testing.T) {
	if !ranAndFailed(&ssh.ExitError{}) {
		t.Error("a remote nonzero exit is a command that ran; want true")
	}
	if ranAndFailed(errors.New("dial tcp: connection refused")) {
		t.Error("a dial failure never ran anything; want false")
	}
}

// An unreadable df must not sink CPU and memory — and must not render as a
// confident "0 B / 0 B" either.
func TestSSHStatsSurfacesDiskFailureWithoutSinkingTheSample(t *testing.T) {
	out := sampleProcStat + "---\n" + sampleMeminfo + "---\n" + "df: /: Permission denied\n"
	svc := newSSHStatsServiceWithRunner(okRunner(out))

	stats, err := svc.Collect(context.Background(), "c")
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if !stats.Supported || stats.Mem.Total == 0 {
		t.Fatalf("a bad df must not sink the sample: %+v", stats)
	}
	if stats.Disk.Total != 0 {
		t.Errorf("Disk.Total = %d, want 0", stats.Disk.Total)
	}
	if !strings.Contains(strings.ToLower(stats.Reason), "disk") {
		t.Errorf("Reason = %q, want it to explain the empty disk figure", stats.Reason)
	}
}

// GNU df's default block size is 1024 — except under POSIXLY_CORRECT, where it
// is 512. parseDF hard-codes 1024, so the command must pin it; getting this
// wrong reports every disk at exactly twice its size, confidently.
func TestStatsCommandPinsDFBlockSize(t *testing.T) {
	if joined := strings.Join(statsCommand, " "); !strings.Contains(joined, "df -Pk /") {
		t.Errorf("statsCommand = %q, want it to run `df -Pk /`", joined)
	}
}

func TestSSHStatsRebootResetsToNil(t *testing.T) {
	outputs := []string{
		"cpu  500 0 0 4500 0 0 0 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
		// counters went backwards — the host rebooted
		"cpu  10 0 0 90 0 0 0 0 0 0\n" + "---\n" + sampleMeminfo + "---\n" + sampleDF,
	}
	i := 0
	svc := newSSHStatsServiceWithRunner(func(context.Context, string) (string, string, error) {
		out := outputs[i]
		i++
		return out, "", nil
	})
	ctx := context.Background()

	if _, err := svc.Collect(ctx, "c"); err != nil {
		t.Fatal(err)
	}
	stats, err := svc.Collect(ctx, "c")
	if err != nil {
		t.Fatal(err)
	}
	if stats.CPUPct != nil {
		t.Errorf("CPUPct = %f after a reboot, want nil", *stats.CPUPct)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/service/ -run SSHStats -v`
Expected: FAIL — `newSSHStatsServiceWithRunner` undefined.

- [ ] **Step 3: Write the service**

Create `backend/internal/service/sshstats.go`:

```go
package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/sshmgr"
)

// statsCommand reads all three sources in one round trip. Deliberately a
// single command: a 2s poll over a high-latency link cannot afford three.
//
// -k pins df's block size to 1024 to match parseDF. -P alone is not enough:
// GNU df defaults to 1024 blocks *except* under POSIXLY_CORRECT, where it
// switches to 512 and every disk would be reported at exactly twice its size.
var statsCommand = []string{
	"sh", "-c",
	"cat /proc/stat; echo " + statsSectionSep + "; cat /proc/meminfo; echo " + statsSectionSep + "; df -Pk /",
}

// statsRunner runs the batched command for a connection. stdout and stderr
// come back separately, and err is reserved for *transport* failures — a host
// that could not be reached, authenticated to, or answered within the poll.
// A command that ran and exited nonzero is not an error here: it is a
// measurement result (this host has no /proc), and arrives as whatever the
// remote printed with a nil error.
//
// Injectable so the delta state machine and this split are both testable
// without a live host.
type statsRunner func(ctx context.Context, connectionID string) (stdout, stderr string, err error)

// SSHStatsService measures a saved SSH host's CPU, memory and root disk,
// producing the same domain.HostStats that hoststats produces locally.
//
// It holds the previous /proc/stat reading per connection because that file
// is cumulative: a percentage needs two samples. The first poll for a
// connection therefore reports CPUPct nil, and the chart starts one tick later.
type SSHStatsService struct {
	run statsRunner

	mu   sync.Mutex
	prev map[string]cpuSample
}

func NewSSHStatsService(pool *sshmgr.FilePool) *SSHStatsService {
	return newSSHStatsServiceWithRunner(func(ctx context.Context, connectionID string) (string, string, error) {
		stdout, stderr, err := sshmgr.RunCommand(ctx, pool, connectionID, statsCommand)
		if err != nil && !ranAndFailed(err) {
			return "", "", err
		}
		return string(stdout), string(stderr), nil
	})
}

// ranAndFailed reports whether err means the remote command executed and
// exited nonzero — a `cat` that found no /proc, a `df` that could not stat / —
// as opposed to never reaching the host at all (dial, auth, host key, a
// dropped connection, a cancelled context). Only the first is a measurement;
// the second is a request failure and must reach the client as one.
func ranAndFailed(err error) bool {
	var exitErr *ssh.ExitError
	return errors.As(err, &exitErr)
}

func newSSHStatsServiceWithRunner(run statsRunner) *SSHStatsService {
	return &SSHStatsService{run: run, prev: map[string]cpuSample{}}
}

// Collect samples the host.
//
// The two failure modes are deliberately kept apart, per the plan's
// error-handling table. A host that answered but cannot be measured — no
// /proc, so not Linux — comes back as Supported:false with a reason and a nil
// error: that is a fact to display, not a request failure, and the pane says
// so calmly. A host that could not be reached or authenticated to was never
// measured at all; that returns an error, so the handler emits the
// {"error":...} envelope and the pane shows its error state and keeps retrying
// on the poll interval.
func (s *SSHStatsService) Collect(ctx context.Context, connectionID string) (domain.HostStats, error) {
	out, stderr, err := s.run(ctx, connectionID)
	if err != nil {
		return domain.HostStats{}, err
	}

	procStat, meminfo, df, err := splitStatsOutput(out)
	if err != nil {
		return unsupportedStats(remoteReason(stderr, "this host did not return readable /proc output — Linux only")), nil
	}
	sample, err := parseProcStat(procStat)
	if err != nil {
		return unsupportedStats(remoteReason(stderr, "this host has no readable /proc/stat — Linux only")), nil
	}
	memUsage, err := parseMeminfo(meminfo)
	if err != nil {
		return unsupportedStats(remoteReason(stderr, "this host has no readable /proc/meminfo — Linux only")), nil
	}

	stats := domain.HostStats{Supported: true, Mem: memUsage, SampledAt: time.Now()}
	// A df failure must not sink the sample; CPU and memory still matter. It
	// must not pass silently either: an unexplained "0 B / 0 B" reads as a bug
	// in DevDeck rather than a filesystem the host would not report.
	if diskUsage, err := parseDF(df); err == nil {
		stats.Disk = diskUsage
	} else {
		stats.Reason = "disk usage unavailable: " + remoteReason(stderr, err.Error())
	}

	s.mu.Lock()
	if prev, ok := s.prev[connectionID]; ok {
		stats.CPUPct = cpuPercent(prev, sample)
	}
	s.prev[connectionID] = sample
	s.mu.Unlock()

	return stats, nil
}

// remoteReason prefers what the remote actually printed — "cat: /proc/stat: No
// such file or directory" tells an operator more than anything this process
// can invent — and falls back when the command failed silently. First line
// only: sh runs three commands and all three may have complained.
func remoteReason(stderr, fallback string) string {
	if msg, _, _ := strings.Cut(strings.TrimSpace(stderr), "\n"); msg != "" {
		return strings.TrimSpace(msg)
	}
	return fallback
}

func unsupportedStats(reason string) domain.HostStats {
	return domain.HostStats{Supported: false, Reason: reason, SampledAt: time.Now()}
}
```

Do **not** add a `Forget(connectionID)` to drop a connection's delta state: it
reads as obviously useful and has no caller — nothing in this feature observes
a disconnect, and a stale `cpuSample` is already handled by `cpuPercent`'s
counter-went-backwards branch.

- [ ] **Step 4: Write the handler**

Create `backend/internal/handler/sshstats.go`:

```go
package handler

import (
	"context"
	"net/http"

	"devdeck/backend/internal/domain"
	"devdeck/backend/internal/service"
)

// sshStatsCollector is the one method this handler needs. Declared as an
// interface so both response shapes — the 200 carrying a sample and the
// {"error":...} envelope a transport failure produces — are testable without
// a live SSH host. The constructor still takes the concrete service, so the
// main.go wiring is unchanged.
type sshStatsCollector interface {
	Collect(ctx context.Context, connectionID string) (domain.HostStats, error)
}

// SSHStatsHandler serves live CPU/memory/disk for a saved SSH connection.
// Hub-scoped like the rest of the SSH API: the hub holds the credentials, and
// only the outbound dial moves to the connection's executor machine.
type SSHStatsHandler struct {
	svc sshStatsCollector
}

func NewSSHStatsHandler(svc *service.SSHStatsService) *SSHStatsHandler {
	return &SSHStatsHandler{svc: svc}
}

func (h *SSHStatsHandler) Get(w http.ResponseWriter, r *http.Request) {
	stats, err := h.svc.Collect(r.Context(), r.PathValue("id"))
	if handleStoreErr(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, stats)
}
```

- [ ] **Step 5: Wire it in main.go**

Next to `sshFileSvc` (~line 359):

```go
	sshStatsSvc := service.NewSSHStatsService(sshmgr.NewFilePool(sshDialer))
	sshStatsH := handler.NewSSHStatsHandler(sshStatsSvc)
```

Reuse the existing pool if one is already in a variable rather than constructing a second; check the line and prefer `service.NewSSHStatsService(sshFilePool)` if `sshmgr.NewFilePool(sshDialer)` is bound to a name. A second pool would double the connection count for no reason.

Register the route inside the `!isRuntime` SSH block, after the file routes (~line 639):

```go
		mux.HandleFunc("GET /api/ssh/connections/{id}/stats", sshStatsH.Get)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && go test ./internal/service/ -run SSHStats -v && go build ./... && go vet ./...`
Expected: 6 tests PASS, build and vet clean.

- [ ] **Step 7: Commit**

```bash
git add backend/internal/service/sshstats.go backend/internal/service/sshstats_test.go \
        backend/internal/handler/sshstats.go backend/cmd/server/main.go
git commit -m "feat(stats): add SSH host metrics service and route"
```

---

### Task 6: Frontend data layer and rolling buffer

**Files:**
- Modify: `frontend/src/lib/machineApi.ts`
- Modify: `frontend/src/lib/api.ts` (SSH stats — hub route, not a machine route)
- Modify: `frontend/src/features/data/keys.ts`
- Modify: `frontend/src/features/data/queries.ts`
- Create: `frontend/src/features/stats/useRollingSamples.ts`
- Test: `frontend/src/features/stats/useRollingSamples.test.ts` (create)
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: `HostStats` (Task 1); routes from Tasks 3 and 5.
- Produces:
  - `fetchMachineStats(machine: Machine): Promise<HostStats>`
  - `fetchSSHStats(connectionId: string): Promise<HostStats>`
  - `qk.machineStats(id)`, `qk.sshStats(id)`
  - `useMachineStats(machine, enabled)`, `useSSHStats(connectionId, enabled)`
  - `useRollingSamples<T>(latest: T | undefined, cap: number): T[]`

  Task 8 consumes all of them.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/stats/useRollingSamples.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRollingSamples } from './useRollingSamples'

describe('useRollingSamples', () => {
  it('starts empty when there is no sample yet', () => {
    const { result } = renderHook(() => useRollingSamples(undefined, 3))
    expect(result.current).toEqual([])
  })

  it('appends each new sample in order', () => {
    const { result, rerender } = renderHook(({ v }: { v: number | undefined }) => useRollingSamples(v, 5), {
      initialProps: { v: 1 as number | undefined },
    })
    rerender({ v: 2 })
    rerender({ v: 3 })
    expect(result.current).toEqual([1, 2, 3])
  })

  it('evicts the oldest past the cap', () => {
    const { result, rerender } = renderHook(({ v }: { v: number | undefined }) => useRollingSamples(v, 3), {
      initialProps: { v: 1 as number | undefined },
    })
    rerender({ v: 2 })
    rerender({ v: 3 })
    rerender({ v: 4 })
    expect(result.current).toEqual([2, 3, 4])
  })

  it('ignores a re-render that carries the same sample object', () => {
    const sample = { cpu: 1 }
    const { result, rerender } = renderHook(({ v }: { v: object | undefined }) => useRollingSamples(v, 5), {
      initialProps: { v: sample as object | undefined },
    })
    rerender({ v: sample })
    rerender({ v: sample })
    expect(result.current).toEqual([sample])
  })

  it('drops the sample when it becomes undefined without clearing history', () => {
    const { result, rerender } = renderHook(({ v }: { v: number | undefined }) => useRollingSamples(v, 5), {
      initialProps: { v: 1 as number | undefined },
    })
    rerender({ v: undefined })
    expect(result.current).toEqual([1])
  })
})
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts` `test.include`:

```ts
      'src/features/stats/useRollingSamples.test.ts',
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/stats/useRollingSamples.test.ts`
Expected: FAIL — cannot resolve `./useRollingSamples`.

- [ ] **Step 4: Write the hook**

Create `frontend/src/features/stats/useRollingSamples.ts`:

```ts
import { useEffect, useRef, useState } from 'react'

/**
 * Keeps the last `cap` distinct samples in memory — the whole of the metrics
 * feature's "history". Deliberately not persisted: this is a live ops readout,
 * so the window resets when the pane closes.
 *
 * Identity, not value, decides what counts as new: TanStack Query hands back
 * the same object across unrelated re-renders, and appending on every render
 * would fill the buffer with duplicates in seconds.
 */
export function useRollingSamples<T>(latest: T | undefined, cap: number): T[] {
  const [samples, setSamples] = useState<T[]>([])
  const lastRef = useRef<T | undefined>(undefined)

  useEffect(() => {
    if (latest === undefined || latest === lastRef.current) return
    lastRef.current = latest
    setSamples((prev) => {
      const next = [...prev, latest]
      return next.length > cap ? next.slice(next.length - cap) : next
    })
  }, [latest, cap])

  return samples
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/stats/useRollingSamples.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 6: Add the API calls**

In `frontend/src/lib/machineApi.ts`:

```ts
// ---- Host metrics ----

/** One live CPU/memory/disk sample from this machine. */
export function fetchMachineStats(machine: Machine): Promise<HostStats> {
  return machineRequest<HostStats>(machine, 'GET', '/system/stats')
}
```

In `frontend/src/lib/api.ts` (SSH stats is a hub route — the hub holds the credentials), following the shape of the neighbouring SSH functions:

```ts
/** One live CPU/memory/disk sample from a saved SSH host. */
export function fetchSSHStats(connectionId: string): Promise<HostStats> {
  return request<HostStats>('GET', `/api/ssh/connections/${connectionId}/stats`)
}
```

Match the actual local `request` helper's signature in each file rather than assuming; add `HostStats` to the `@/store/types` type imports in both.

- [ ] **Step 7: Add query keys and hooks**

In `frontend/src/features/data/keys.ts`:

```ts
  machineStats: (id: string) => ['machines', id, 'stats'] as const,
  sshStats: (connectionId: string) => ['ssh', connectionId, 'stats'] as const,
```

In `frontend/src/features/data/queries.ts`:

```ts
/** Live host metrics poll. `enabled` is driven by pane visibility so a
 *  backgrounded stats pane stops polling instead of sampling forever. */
export function useMachineStats(machine: Machine | undefined, enabled: boolean) {
  return useQuery({
    queryKey: qk.machineStats(machine?.id ?? ''),
    queryFn: () => fetchMachineStats(machine as Machine),
    enabled: enabled && !!machine,
    refetchInterval: 2000,
    // Metrics are worthless once stale; never serve a cached sample as fresh.
    staleTime: 0,
  })
}

export function useSSHStats(connectionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: qk.sshStats(connectionId ?? ''),
    queryFn: () => fetchSSHStats(connectionId as string),
    enabled: enabled && !!connectionId,
    refetchInterval: 2000,
    staleTime: 0,
  })
}
```

Import `fetchMachineStats` from `@/lib/machineApi` and `fetchSSHStats` from `@/lib/api`.

- [ ] **Step 8: Verify**

Run: `cd frontend && npm run typecheck && npx vitest run src/features/stats/`
Expected: clean, tests pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/lib/machineApi.ts frontend/src/lib/api.ts \
        frontend/src/features/data/keys.ts frontend/src/features/data/queries.ts \
        frontend/src/features/stats/useRollingSamples.ts \
        frontend/src/features/stats/useRollingSamples.test.ts \
        frontend/vite.config.ts
git commit -m "feat(stats): add host metrics queries and rolling sample buffer"
```

---

### Task 7: `stats` pane content kind

**Files:**
- Modify: `frontend/src/features/terminal/paneTree.ts`
- Test: `frontend/src/features/terminal/paneTree.stats.test.ts` (create)
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (paneTree is store-free and pure).
- Produces: `StatsTarget`, `StatsContent`, `statsTargetKey(t)`, `createStatsContent(target, label)`, and `'stats'` in `PaneContentKind` / the `PaneContent` union. Task 8 consumes all of them.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/terminal/paneTree.stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createStatsContent, statsTargetKey } from './paneTree'
import type { StatsTarget } from './paneTree'

describe('statsTargetKey', () => {
  it('namespaces machine and ssh targets so ids cannot collide', () => {
    const machine: StatsTarget = { kind: 'machine', machineId: 'x1' }
    const ssh: StatsTarget = { kind: 'ssh', connectionId: 'x1' }

    expect(statsTargetKey(machine)).toBe('stats:machine:x1')
    expect(statsTargetKey(ssh)).toBe('stats:ssh:x1')
    expect(statsTargetKey(machine)).not.toBe(statsTargetKey(ssh))
  })
})

describe('createStatsContent', () => {
  it('uses the target key as the content id so re-opening refocuses', () => {
    const target: StatsTarget = { kind: 'machine', machineId: 'm1' }

    const first = createStatsContent(target, 'prod-runtime')
    const second = createStatsContent({ kind: 'machine', machineId: 'm1' }, 'prod-runtime')

    expect(first.id).toBe(statsTargetKey(target))
    expect(first.id).toBe(second.id)
  })

  it('carries kind, label and target', () => {
    const content = createStatsContent({ kind: 'ssh', connectionId: 'c9' }, 'prod-web')

    expect(content.kind).toBe('stats')
    expect(content.label).toBe('prod-web')
    expect(content.target).toEqual({ kind: 'ssh', connectionId: 'c9' })
  })
})
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts` `test.include`:

```ts
      'src/features/terminal/paneTree.stats.test.ts',
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/terminal/paneTree.stats.test.ts`
Expected: FAIL — `createStatsContent` is not exported.

- [ ] **Step 4: Extend paneTree**

In `frontend/src/features/terminal/paneTree.ts`, add `'stats'` to the kind union (line 14):

```ts
export type PaneContentKind = 'terminal' | 'git' | 'git-diff' | 'file' | 'explorer' | 'untitled' | 'stats'
```

After `GitDiffTarget` / `gitDiffTargetKey`, add:

```ts
/** What a stats pane measures. Declared here rather than in the store for the
 *  same reason GitDiffTarget is: this module is deliberately store-free (see
 *  the file header) and StatsContent needs it. */
export type StatsTarget =
  | { kind: 'machine'; machineId: string }
  | { kind: 'ssh'; connectionId: string }

/** Stable identity for a stats target — doubles as the pane tab's id, so
 *  re-opening stats for the same target refocuses instead of stacking a
 *  duplicate. The kind is part of the key because a machine id and an SSH
 *  connection id could otherwise collide. */
export function statsTargetKey(target: StatsTarget): string {
  return target.kind === 'machine' ? `stats:machine:${target.machineId}` : `stats:ssh:${target.connectionId}`
}
```

Add the content interface next to `ExplorerContent`:

```ts
/** Live CPU/memory/disk for one machine or SSH host. Its `id` is the target
 *  key — the same "one instance per target" rule FileContent enforces with
 *  its path and GitDiffContent with its target. */
export interface StatsContent extends BasePaneContent {
  kind: 'stats'
  target: StatsTarget
}
```

Extend the union (line 75):

```ts
export type PaneContent =
  | TerminalContent
  | GitContent
  | GitDiffContent
  | FileContent
  | ExplorerContent
  | UntitledContent
  | StatsContent
```

Add the factory next to `createExplorerContent`:

```ts
export function createStatsContent(target: StatsTarget, label: string): StatsContent {
  return { kind: 'stats', id: statsTargetKey(target), target, label }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/terminal/paneTree.stats.test.ts src/features/terminal/paneTree.test.ts && npm run typecheck`
Expected: new tests PASS, the existing `paneTree.test.ts` still passes, typecheck clean.

Adding a union member may surface exhaustive-switch errors wherever `PaneContent` is consumed (`PaneCanvas`, `PanelHeader`, and similar). Handle `'stats'` in each — Task 8 supplies the real renderer, so until then render `null` in the canvas and treat it like any other non-terminal tab elsewhere.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/terminal/paneTree.ts \
        frontend/src/features/terminal/paneTree.stats.test.ts \
        frontend/vite.config.ts
git commit -m "feat(stats): add stats pane content kind to paneTree"
```

---

### Task 8: StatsPane and entry points

**Files:**
- Create: `frontend/src/features/stats/StatsPane.tsx`
- Create: `frontend/src/features/stats/MetricChart.tsx`
- Test: `frontend/src/features/stats/StatsPane.test.tsx` (create)
- Modify: `frontend/src/features/terminal/PaneCanvas.tsx` (render the kind)
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: `useMachineStats`, `useSSHStats`, `useRollingSamples` (Task 6); `StatsContent`, `StatsTarget` (Task 7); `HostStats` (Task 1).
- Produces: `<StatsPane target={StatsTarget} visible={boolean} />`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/stats/StatsPane.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { HostStats } from '@/store/types'

const mockUseMachineStats = vi.fn()
const mockUseSSHStats = vi.fn()

// StatsPane also imports useMachines to resolve a machineId to a Machine, so
// the mock factory must supply it too — a partial factory makes the import
// itself fail, not just the call.
vi.mock('@/features/data/queries', () => ({
  useMachines: () => ({
    data: [{ id: 'm1', name: 'local', url: '', key: '', isLocal: true, signingPublicKey: '' }],
    isLoading: false,
    error: null,
  }),
  useMachineStats: (...args: unknown[]) => mockUseMachineStats(...args),
  useSSHStats: (...args: unknown[]) => mockUseSSHStats(...args),
}))

// recharts needs layout the jsdom environment does not provide; the assertions
// here are about states and readouts, not SVG geometry.
vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}))

const { StatsPane } = await import('./StatsPane')

function stats(over: Partial<HostStats> = {}): HostStats {
  return {
    supported: true,
    cpuPct: 47,
    mem: { used: 6_200_000_000, total: 16_000_000_000 },
    disk: { used: 412_000_000_000, total: 932_000_000_000 },
    sampledAt: '2026-08-06T00:00:00Z',
    ...over,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('StatsPane', () => {
  it('renders a loading state before the first sample', () => {
    mockUseMachineStats.mockReturnValue({ data: undefined, isLoading: true, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  it('renders an error state', () => {
    mockUseMachineStats.mockReturnValue({ data: undefined, isLoading: false, error: new Error('offline') })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText(/offline/i)).toBeTruthy()
  })

  it('renders the unsupported state with its reason', () => {
    mockUseSSHStats.mockReturnValue({
      data: stats({ supported: false, reason: 'this host has no readable /proc/stat — Linux only' }),
      isLoading: false,
      error: null,
    })
    mockUseMachineStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'ssh', connectionId: 'c1' }} visible />)

    expect(screen.getByText(/Linux only/i)).toBeTruthy()
  })

  it('shows CPU, memory and disk readouts when supported', () => {
    mockUseMachineStats.mockReturnValue({ data: stats(), isLoading: false, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText('47%')).toBeTruthy()
    expect(screen.getByText(/CPU/i)).toBeTruthy()
    expect(screen.getByText(/MEM/i)).toBeTruthy()
    expect(screen.getByText(/DISK/i)).toBeTruthy()
  })

  it('shows a dash for CPU while the first delta is pending', () => {
    mockUseMachineStats.mockReturnValue({ data: stats({ cpuPct: null }), isLoading: false, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(screen.getByText('—')).toBeTruthy()
  })

  it('polls only the query matching the target kind', () => {
    mockUseMachineStats.mockReturnValue({ data: stats(), isLoading: false, error: null })
    mockUseSSHStats.mockReturnValue({ data: undefined, isLoading: false, error: null })

    render(<StatsPane target={{ kind: 'machine', machineId: 'm1' }} visible />)

    expect(mockUseMachineStats).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), true)
    expect(mockUseSSHStats).toHaveBeenCalledWith(undefined, false)
  })
})
```

Note the last test assumes `StatsPane` resolves a machine id to a `Machine` object. If the real component takes a machine id instead, adjust the assertion to match the implementation you write in Step 4 — do not change the implementation to fit a guessed assertion.

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts` `test.include`:

```ts
      'src/features/stats/StatsPane.test.tsx',
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/stats/StatsPane.test.tsx`
Expected: FAIL — cannot resolve `./StatsPane`.

- [ ] **Step 4: Write the chart component**

Create `frontend/src/features/stats/MetricChart.tsx`:

```tsx
import { Area, AreaChart, YAxis } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'

const config: ChartConfig = { value: { label: 'Value', color: 'var(--devdeck-accent)' } }

/** A compact filled sparkline over the rolling window. No X axis: the window
 *  is always "the last few minutes", and a timestamp axis in a pane this
 *  short costs more room than it repays.
 *
 *  `value` is nullable because "unknown" is a real reading here: the first CPU
 *  sample after a pane opens has no delta to measure, and so does the sample
 *  after a host reboots. Those points are plotted as gaps, never as zeros. */
export function MetricChart({ data }: { data: { value: number | null }[] }) {
  return (
    <ChartContainer config={config} className="h-[52px] w-full">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        {/* Fixed 0-100 domain: an auto domain rescales every tick and makes a
            flat 2% line look like a dramatic spike. */}
        <YAxis domain={[0, 100]} hide />
        {/* Explicitly not connecting nulls: a bridged gap is a line drawn
            through data that does not exist, and here it would draw straight
            across a reboot. Stated rather than left to the library default so
            it survives a recharts upgrade. */}
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          fill="var(--color-value)"
          fillOpacity={0.18}
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
```

- [ ] **Step 5: Write the pane**

Create `frontend/src/features/stats/StatsPane.tsx`:

```tsx
import { useMachines, useMachineStats, useSSHStats } from '@/features/data/queries'
import type { StatsTarget } from '@/features/terminal/paneTree'
import type { HostStats, Usage } from '@/store/types'
import { useRollingSamples } from './useRollingSamples'
import { MetricChart } from './MetricChart'

/** ~5 minutes at the 2s poll interval. */
const SAMPLE_CAP = 150

function fmtBytes(n: number): string {
  if (n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function pctOf(u: Usage): number {
  return u.total > 0 ? (u.used / u.total) * 100 : 0
}

function MetricRow({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-devdeck-dim-2">{label}</span>
        <span className="font-mono text-[12px] text-devdeck-fg">{value}</span>
      </div>
      {children}
    </div>
  )
}

/** Disk renders as a bar, not a series: it moves on a scale of hours, so a
 *  five-minute time axis of it would be a flat line pretending to be
 *  information. */
function DiskBar({ pct }: { pct: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-devdeck-surface-2">
      <div className="h-full rounded-full bg-devdeck-accent" style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  )
}

export function StatsPane({ target, visible }: { target: StatsTarget; visible: boolean }) {
  const isMachine = target.kind === 'machine'
  const machines = useMachines(isMachine && visible)
  const machine = isMachine ? machines.data?.find((m) => m.id === target.machineId) : undefined

  const machineQuery = useMachineStats(machine, isMachine && visible)
  const sshQuery = useSSHStats(isMachine ? undefined : target.connectionId, !isMachine && visible)
  const query = isMachine ? machineQuery : sshQuery

  const stats = query.data as HostStats | undefined
  const cpuSeries = useRollingSamples(stats, SAMPLE_CAP)

  if (query.isLoading && !stats) {
    return <div className="p-4 font-mono text-[11px] text-devdeck-dim-2">Loading metrics…</div>
  }
  if (query.error) {
    return (
      <div className="p-4 font-mono text-[11px] text-devdeck-red-soft">
        {query.error instanceof Error ? query.error.message : 'Failed to read host metrics'}
      </div>
    )
  }
  if (!stats) {
    return <div className="p-4 font-mono text-[11px] text-devdeck-dim-2">No sample yet.</div>
  }
  if (!stats.supported) {
    return (
      <div className="p-4 font-mono text-[11px] text-devdeck-dim-2">
        {stats.reason || 'This host cannot be measured.'}
      </div>
    )
  }

  // An unknown CPU sample is plotted as a gap, not as 0. `?? 0` would fabricate
  // an idle-looking floor: the buffer holds ~5 minutes, so the first sample's
  // fake zero sits on the chart that whole time, and a mid-window reboot (which
  // correctly yields null) would draw a cliff to 0 that reads as "the box went
  // quiet" when it means "the box restarted". MetricChart's data prop is
  // therefore `{ value: number | null }[]`, with `connectNulls={false}` on the
  // Area so recharts breaks the line rather than bridging the gap.
  const cpuData = cpuSeries.map((s) => ({ value: s.cpuPct }))
  const memData = cpuSeries.map((s) => ({ value: pctOf(s.mem) }))
  const diskPct = pctOf(stats.disk)

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      <MetricRow label="CPU" value={stats.cpuPct === null ? '—' : `${Math.round(stats.cpuPct)}%`}>
        <MetricChart data={cpuData} />
      </MetricRow>

      <MetricRow label="MEM" value={`${fmtBytes(stats.mem.used)} / ${fmtBytes(stats.mem.total)}`}>
        <MetricChart data={memData} />
      </MetricRow>

      {/* The spec asks for used/total *with a percentage* — computing pctOf only
          to size the bar leaves the number the operator actually reads off. */}
      <MetricRow
        label="DISK"
        value={`${fmtBytes(stats.disk.used)} / ${fmtBytes(stats.disk.total)} · ${Math.round(diskPct)}%`}
      >
        <DiskBar pct={diskPct} />
        {/* A supported sample can still carry a reason: both collectors zero the
            disk figure rather than fail the sample when the root filesystem will
            not report. Without this the pane asserts a confident "0 B / 0 B". */}
        {stats.reason ? <span className="text-[10px] text-devdeck-fg-2">{stats.reason}</span> : null}
      </MetricRow>
    </div>
  )
}
```

- [ ] **Step 6: Render the kind in the canvas**

In `frontend/src/features/terminal/PaneCanvas.tsx`, wherever `PaneContent` kinds are switched to a renderer, replace the Task 7 placeholder:

```tsx
        {content.kind === 'stats' && <StatsPane target={content.target} visible={isActiveTab} />}
```

Use whatever the surrounding code already calls its "this tab is the visible one" flag rather than inventing `isActiveTab`; the point is that a backgrounded stats tab must stop polling.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/stats/ && npm run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 8: Add the entry points**

Add "Stats" to the pane `+` menu and the command palette, both constructing content through `createStatsContent` so the dedupe-by-target rule holds from either path. Follow how the `+` menu already adds an Explorer tab (`createExplorerContent`) and how the palette registers its other verbs — do not add a second content-construction path.

- [ ] **Step 9: Full verification**

Run:
```bash
cd frontend && npm run typecheck && npx vitest run
cd ../backend && go vet ./... && go test ./internal/...
```
Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/stats/ frontend/src/features/terminal/PaneCanvas.tsx frontend/vite.config.ts
git commit -m "feat(stats): add StatsPane with CPU/mem sparklines and disk bar"
```

---

## Manual verification

1. Run the app. Open a stats pane for the local machine from the `+` menu.
2. CPU shows `—` for the first tick, then a number. Memory and disk populate immediately.
3. Run `yes > /dev/null` and confirm the CPU sparkline climbs, then `Ctrl-C` and confirm it falls.
4. Split the pane, open a stats pane for a saved **Linux** SSH host, and confirm the same three readouts appear.
5. Open a stats pane for a **macOS** SSH host (if you have one) and confirm it says the host cannot be measured, rather than showing zeros.
6. Close the stats tab and confirm polling stops (no further `/api/system/stats` requests in the network panel).
7. Re-open stats for the same target and confirm it refocuses the existing tab instead of opening a duplicate.

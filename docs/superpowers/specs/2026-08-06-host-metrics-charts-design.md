# Host Metrics Charts (CPU / Memory / Disk)

**Date:** 2026-08-06
**Status:** design approved, pending implementation plan

## Problem

DevDeck drives work across many machines — the hub, every registered runtime,
and every saved SSH host — and shows the health of none of them. The only
existing signal is `machineclient.CheckHealth`, which answers "online / offline"
and a latency number, nothing more. When an agent's build is crawling or a
worktree write fails, there is no way to see from inside the app whether the box
is out of memory, out of disk, or pinned at 100% CPU. You leave DevDeck, open a
shell, and run `top`.

Nothing in the codebase collects system metrics today: no `gopsutil`, no `/proc`
reads, no metrics endpoint.

## Goal

A stats pane, openable next to the shell it belongs to, showing live CPU, memory
and disk for either a **runtime machine** or an **SSH host** — the same view and
the same numbers regardless of which.

## Non-goals

- **No persistence.** Live-only, in-browser rolling window. No metrics table, no
  retention job, no sampling poller running when nothing is watching. This is a
  live ops readout, not a monitoring system.
- **No alerting or thresholds.**
- **No network or disk I/O counters, no per-process list.**
- **Root filesystem only** — not every mounted volume.
- `machineclient.CheckHealth` and the existing online/offline dot are untouched.

## Shared shape

One domain type serves both target kinds, so the chart component never branches
on where the numbers came from:

```go
type Usage struct {
    Used  uint64 `json:"used"`
    Total uint64 `json:"total"`
}

type HostStats struct {
    // Supported is false when the target cannot be measured (e.g. an SSH host
    // with no /proc). Reason carries the operator-facing explanation.
    Supported bool   `json:"supported"`
    Reason    string `json:"reason,omitempty"`
    // CPUPct is nil when no delta exists yet — see "CPU needs two samples".
    CPUPct    *float64  `json:"cpuPct"`
    Mem       Usage     `json:"mem"`
    Disk      Usage     `json:"disk"`
    SampledAt time.Time `json:"sampledAt"`
}
```

Mirrored in `frontend/src/store/types.ts` per the standing domain-sync contract.

## Local collector — machines

New package `backend/internal/hoststats`:

```go
func Collect() (domain.HostStats, error)
```

Backed by `github.com/shirou/gopsutil/v4`: `cpu.Percent`, `mem.VirtualMemory`,
`disk.Usage("/")`. gopsutil is chosen over hand-rolled `/proc` parsing because
the hub and runtimes genuinely run on all three platforms — Linux servers, the
operator's macOS desktop, and the Tauri desktop shell's embedded runtime on
Windows — and it is the one dependency that gets all three right.

Exposed as `GET /api/system/stats`, registered on **every** role (not
`!isRuntime`-gated): measuring a runtime is the primary use case. The frontend
reaches it direct-first-then-hub-proxy through the existing `machineRequest` /
`/api/machines/{id}/proxy/{rest...}` path, so no new hub route is needed.

**Concurrency.** `cpu.Percent(0, false)` is delta-since-the-last-call: it stores
the previous CPU times internally and reports the change. Two clients polling
concurrently would each consume the other's window and report nonsense. The
collector therefore holds a mutex and caches its last result for ~1s, so
overlapping polls share one sample rather than racing the delta.

## SSH collector — saved connections

`GET /api/ssh/connections/{id}/stats`, served by the same machine that already
serves the other `/api/ssh/connections/{id}/...` routes, so executor routing is
inherited rather than reinvented.

One batched round trip through the existing pooled exec helper
(`sshmgr.RunCommand`, which reuses `FilePool`'s live client rather than dialing
per poll):

```
sh -c 'cat /proc/stat; echo ---; cat /proc/meminfo; echo ---; df -P /'
```

Parsed server-side into the same `HostStats`. One command, one round trip —
important because this runs every 2s over a link that may be transcontinental.

**Unsupported hosts.** A host without `/proc/stat` (macOS, BSD, a minimal
container) returns `Supported: false` with a reason. Reporting `supported:false`
is a deliberate choice over silently falling back to a partial or approximated
reading: wrong numbers on an ops readout are worse than no numbers.

## CPU needs two samples

`/proc/stat` reports **cumulative** jiffies since boot, not a rate. A percentage
requires two readings and the delta between them.

The SSH service keeps the previous raw sample per connection id in memory and
computes the delta on the next poll. This is why `CPUPct` is a pointer: the
first poll after opening a pane has no previous sample and legitimately has no
answer. It returns `nil`, and the chart starts one tick later — rather than
fabricating a `0%` that reads as "idle" when it means "unknown".

The alternative — sleeping 1s inside the remote command to take both samples in
one trip — was rejected: it adds a second of latency to every poll and holds the
SSH channel open for it, for a number the next poll produces for free.

Delta math must handle a counter that goes backwards (host reboot between polls)
by discarding the sample and returning `nil` rather than emitting a negative or
absurd percentage.

## Frontend

### Pane model

`paneTree.ts` gains `'stats'` in `PaneContentKind` plus:

```ts
export type StatsTarget =
  | { kind: 'machine'; machineId: string }
  | { kind: 'ssh'; connectionId: string }

export interface StatsContent extends BasePaneContent {
  kind: 'stats'
  target: StatsTarget
}

export function statsTargetKey(t: StatsTarget): string
export function createStatsContent(target: StatsTarget, label: string): StatsContent
```

`id` is `statsTargetKey(target)` — `machine:<id>` or `ssh:<id>` — following the
rule `FileContent` (id === path) and `GitDiffContent` (id === target key)
already establish: re-opening stats for the same target refocuses the existing
tab instead of stacking duplicates.

`paneTree.ts` is deliberately store-free and pure (see its file header); adding
this kind must not change that — `StatsTarget` is declared there, exactly as
`GitDiffTarget` already is, for the same reason.

### Components

- **`features/stats/StatsPane.tsx`** — resolves its target to the right query,
  renders the three metrics.
- **`features/stats/useRollingSamples.ts`** — `useRollingSamples(latest, cap)`
  appends each new sample and evicts the oldest past `cap`. Cap 150 at a 2s
  interval is a ~5 minute window.
- **`features/data/queries.ts`** — `useMachineStats(machineId)` and
  `useSSHStats(connectionId)`, both `refetchInterval: 2000`, both disabled when
  the pane is not visible so a backgrounded tab stops polling.

Charts use `recharts` through the existing `components/ui/chart.tsx` wrapper.

**CPU and memory render as time-series sparklines. Disk renders as a bar, not a
series** — disk usage moves on a scale of hours, so a 5-minute time axis of it
would be a flat line pretending to be information. The bar shows used/total with
a percentage.

Loading, error, empty, and `unsupported` states are each rendered explicitly,
per the standing frontend contract.

### Entry points

The pane `+` menu and the command palette both offer "Stats", targeting the
machine or SSH connection the current pane belongs to. Both go through
`createStatsContent`, so the dedupe-by-target rule holds no matter which is used.

## Error handling

All REST errors use the mandatory `{"error":"message"}` envelope.

| Condition | Behaviour |
|---|---|
| SSH host has no `/proc` | `200` with `supported:false` + reason. Pane renders an explanatory empty state. |
| SSH connection unreachable / auth failure | Normal handler error envelope; pane renders its error state and keeps retrying on the poll interval. |
| First SSH sample | `cpuPct: null`; chart shows mem/disk immediately, CPU from the second tick. |
| Counter goes backwards (reboot) | Sample discarded, `cpuPct: null`, previous sample replaced. |
| `disk.Usage("/")` fails on a machine | Zeroed `Disk` with the error surfaced; CPU/mem still render. |
| Machine offline | Existing machine-transport error path; pane error state. |

## Testing

**Go**

- Table-driven parser tests against captured `/proc/stat`, `/proc/meminfo` and
  `df -P` fixtures, including a `/proc/meminfo` with and without `MemAvailable`.
- CPU delta math: normal case, first-sample-nil, counter-wrap/reboot.
- Unsupported detection when `/proc/stat` is absent.
- `hoststats.Collect` returns plausible non-zero totals on the test host.
- Handler shapes, auth, and `{"error":...}` envelope.

**Frontend**

- `useRollingSamples` caps length and evicts oldest first.
- `StatsPane` renders loading, error, unsupported, and populated states.
- `paneTree`: `createStatsContent` id rule, and opening the same target twice
  refocuses rather than duplicating.

## Dependency

`github.com/shirou/gopsutil/v4` (BSD-3-Clause) is the only new dependency —
`v4.26.7` at time of writing, verified available on the module proxy. This repo
ships a `NOTICE` file, so the implementation plan includes updating it.

## Build order

1. `domain.HostStats` + `types.ts` mirror.
2. `internal/hoststats` + gopsutil + `NOTICE` + tests.
3. `GET /api/system/stats` handler + `main.go` wiring on all roles.
4. SSH probe service (batched command, parsers, per-connection delta) + tests.
5. `GET /api/ssh/connections/{id}/stats` handler.
6. `paneTree` stats kind + factory + tests.
7. `useRollingSamples`, queries, `StatsPane` + tests.
8. `+` menu and command palette entry points.

## Related work

Second of three independent features requested together:

1. **Published SOCKS5** — `2026-08-06-published-socks5-design.md` (specced).
3. **SSH port forwarding** — `-L` / `-R` / `-D`, build-order phase 3 of
   `2026-07-14-ssh-management-design.md`. Spec to follow.

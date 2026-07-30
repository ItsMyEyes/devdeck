# Browser Tile Bug Fixes + Localhost Address Rewrite — Design

**Date:** 2026-07-31
**Status:** Approved (brainstorming complete) — ready for implementation plan.
**Builds on:** `2026-07-13-desktop-proxied-browser-tab-design.md` (the native
`BrowserTile` this work fixes). Does **not** touch `frontend/src/features/modules/BrowserModule.tsx`
(the sandboxed-iframe web fallback) — confirmed out of scope, see Non-Goals.

## Goal

Fix four confirmed bug classes in the desktop-only native-webview `BrowserTile`
feature, and add a URL rewrite so a `localhost`/loopback address typed or
bookmarked while browsing through a remote machine's proxy actually reaches
that machine instead of silently hitting the operator's own machine (or
nothing).

## Context: why "use a real browser" needed no code change

`frontend/src/routes/w.$wsId.tsx` (`WorkspaceLayout`) already swaps its
entire content area on `useIsTauri()`: for any tiled-scope path (including
`/w/$wsId/browser`), Tauri renders `WorkspaceTileArea` (native-webview
`BrowserTile` inside), and `BrowserModule`'s route `<Outlet/>` never mounts.
`BrowserModule` only renders on a plain web browser with no Tauri runtime.
Since the reported bugs are all on the desktop app, every fix below targets
`BrowserTile` and its supporting files only.

## Non-Goals

- No changes to `BrowserModule.tsx` or its backend proxy
  (`backend/internal/handler/browser_proxy.go`) — it has no machine concept
  at all (no picker, no `machineId` on its own bookmarks), and building that
  in is a separate feature, explicitly deferred.
- No changes to the cross-leaf tab-move remount behavior
  (`tileTree.ts`'s `moveTileTab`) — traced through React's commit ordering
  and confirmed the existing hide-on-unmount/idempotent-reopen dance is
  already correct (cleanup for the outgoing instance runs before the
  incoming instance's mount effect within the same commit). Not touched.
- No attempt to give the native webview real OS-level back/forward or
  history — only to stop our own tracked `history` array from going stale
  after in-page navigation.

## Bug fixes

### 1. Proxy-start failures are silently swallowed

**Root cause:** `ensureProxyForMachine()` in `BrowserTile.tsx` calls
`startProxy(machine)` (`lib/machineApi.ts`) with no try/catch. Every caller
(`navigate()`, `selectMachine()`, `openBookmark()`) invokes it via `void
someAsyncFn()` — a rejection (machine offline, network error, non-2xx) becomes
an unhandled promise rejection. No toast, no state change; the tile just does
nothing and the address bar/input give no feedback.

**Fix:** wrap the `startProxy` call inside `ensureProxyForMachine` in a
try/catch. On failure, `toast.error('Could not start browser proxy on <machine
name>: <message>')` (matching the project convention in `.claude/rules/frontend.md`)
and return `null` (already the contract callers expect — they all already
check `if (!proxy) return`). No caller-side changes needed beyond this.

### 2. In-page navigation isn't recorded in `history`/`historyIndex`

**Root cause:** `onBrowserTilePageLoad`'s handler
(`BrowserTile.tsx`, the page-load effect) only does
`setBrowserDocState(t, d, { url, loading: false })` — it never touches
`history`/`historyIndex`. Only `navigate()` and `goHistory()` append/move
through that array. So a real in-page navigation (clicking a link inside the
loaded page) changes `doc.url` but not `doc.history`, leaving Back/Forward
operating on a stale list disconnected from what's actually loaded.

**Fix:** add a per-doc "programmatic navigation in flight" ref
(`Set<string>` of doc ids, or a `Map<docId, true>`) set immediately before
`navigateBrowserTile()` is called from `navigate()` and `goHistory()`, cleared
once the corresponding page-load event for that doc arrives. In the
page-load handler:
- If the doc's flag is set: clear it, update `url`/`loading` only (current
  behavior) — this load is the expected result of our own call, already
  recorded.
- If not set: this is a real in-page navigation the user triggered inside
  the webview itself. Treat it like `navigate()` does — truncate
  `history` at `historyIndex + 1`, append the new URL, bump `historyIndex`,
  update `url`/`title`/`loading`.

### 3. Native-webview overlay/z-index gaps

**Root cause:** a native child webview always paints above the entire DOM;
every floating UI element must call the existing
`useNativeOverlayBlocker(open)` hook (`frontend/src/features/browser/useNativeOverlayBlocker.ts`)
while open. A fresh audit found nine components that render a floating/portal
element and don't call it (directly or via a covered primitive):

| # | File | What it renders |
|---|------|------------------|
| 1 | `frontend/src/features/overlays/TransferStatusPanel.tsx` | Fixed bottom-right transfer-progress panel |
| 2 | `frontend/src/features/sidebar/WorkspaceSwitcher.tsx` | Raw `@base-ui/react/popover`, not built on the covered `Select`/`Combobox` |
| 3 | `frontend/src/features/database/DBExportMenu.tsx` | Same — raw `Popover.Root` |
| 4 | `frontend/src/features/terminal/TerminalExplorer.tsx` | Right-click `ContextMenu.Root`, currently fully uncontrolled (no `open` state at all yet) |
| 5 | `frontend/src/features/tabs/WorkspaceTileCanvas.tsx` | `dnd-kit` `DragOverlay` tab-drag ghost — reachable for `kind === 'browser'` tabs |
| 6 | `frontend/src/features/terminal/PaneCanvas.tsx` | Same `DragOverlay` pattern, in-worktree pane-tab drag |
| 7 | `frontend/src/features/agent-management/EnvProfileManagement.tsx` | Hand-rolled mobile "⋮" actions sheet |
| 8 | `frontend/src/features/terminal/Terminal.tsx` | In-terminal "Find" search bar |
| 9 | `frontend/src/features/terminal/MarkdownFileEditor.tsx` / `frontend/src/features/issues/MarkdownEditor.tsx` | "/" slash-command menu (two near-identical instances) |

**Fix:** wire `useNativeOverlayBlocker` to each one's existing (or, for #4,
newly-added) open/closed boolean state. #4 additionally needs `ContextMenu.Root`
converted from uncontrolled to controlled (`open`/`onOpenChange` state) so
there's something to feed the hook.

### 4. Native webview overflows/lags during interactive pane-divider drags

**Root cause:** `TileSplitView`'s divider drag itself is clean — real
`flexGrow` mutations on every `pointermove`, no CSS transform, no
transition — so `ResizeObserver` fires every tick. The drift is downstream:
`browser_tile_set_bounds` is an unordered, unbatched Tauri IPC call; the
existing per-label serialize queue in `browserTilesBridge.ts` guarantees
eventual convergence but not frame-perfect tracking, so a fast drag can leave
the native surface visibly behind for a few frames. Since a native webview is
a separate OS surface, `overflow-hidden` on the CSS pane box does nothing to
clip it — a stale/larger rect bleeds visibly across the divider into the
neighboring pane instead of being invisibly clipped like equivalent DOM
content would be.

**Fix (chosen over throttling/clamping):** hide every currently-visible
`BrowserTile`'s native webview for the duration of an interactive divider
drag, and reveal it once, at the final settled rect, on drag end. This is
the same `hideBrowserTile`/`showBrowserTile` pair `BrowserTile.tsx` already
uses for `nativeOverlayBlockers`, driven by a new, similarly-shaped signal
(e.g. a `tileDragActive` boolean in the zustand store, set by
`TileSplitView`'s pointer-down/up handlers in `WorkspaceTileCanvas.tsx`,
read by `BrowserTile` the same way it reads `nativeOverlayBlockers`).
Throttling/clamping was considered but rejected: the root cause is IPC
round-trip latency, which bounding-box math can't close, only narrow — the
visible artifact would still occur on a fast-enough drag.

## New feature: localhost → machine address rewrite

**Problem:** `doc.machineId`'s native webview routes all traffic through
that machine's own SOCKS5 proxy (`startProxy`), but OS/browser network
stacks conventionally bypass configured proxies for loopback-class
addresses (`localhost`, `127.0.0.1`, `::1`). So typing a `localhost:3000`
URL served by a remote runtime machine doesn't route through the proxy at
all — it silently resolves against the operator's own machine instead.

**Fix:** `Machine.url`'s hostname is provably the same address that
machine's own `ProxyService.advertiseHost` (and therefore its
`socks5Addr`/`httpProxyAddr`) is built from (both trace back to the same
`--public-url` value — see `backend/cmd/server/main.go:358-362` vs.
`main.go:698-707`). Add a small pure helper, e.g.
`frontend/src/lib/localhostRewrite.ts`:

```ts
export function rewriteLoopbackHost(url: string, machine: Machine | undefined): string
```

Behavior: parse `url`; if its hostname is loopback-class
(`localhost`, `127.0.0.1`, `::1`) and `machine` is defined and
`new URL(machine.url).hostname` is *not itself* loopback-class, rebuild the
URL with that hostname substituted, keeping the original scheme, port,
path, and query untouched. Otherwise return `url` unchanged (covers: no
machine selected, machine's own registered URL is itself `127.0.0.1`/
`localhost` — e.g. an unconfigured local runtime — in which case there's no
better address to substitute).

Call sites (both in `BrowserTile.tsx`, after `normalizeAddress()`, before the
URL is stored/navigated):
- `navigate()` — using `machines.find((m) => m.id === doc.machineId)`.
- `openBookmark()` — using whichever machine ends up active for that
  bookmark (`bookmark.machineId ?? doc.machineId`).

Not applied in `goHistory()` — history entries already store the rewritten
URL from when they were first navigated to.

## Testing

- Unit test for `rewriteLoopbackHost` covering: loopback host + real machine
  URL (rewrites), loopback host + machine with loopback URL (no-op),
  non-loopback host (no-op), no machine (no-op), port/path/query
  preservation.
- Unit/component test for the history-tracking fix: simulate a page-load
  event with and without the programmatic-navigation flag set, assert
  `history`/`historyIndex` update only in the unflagged case.
- Manual verification in the running desktop app (per project convention of
  testing UI changes live): drag a Browser tab across a split, drag a pane
  divider while a Browser tile is visible, open a dialog/dropdown/context
  menu/drag a tab over an open Browser tile, disconnect/stop a machine and
  try to navigate a Browser tile pointed at it, click a link inside a loaded
  page then use Back.

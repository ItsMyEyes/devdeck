# Desktop Proxied Browser Tab — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorming complete) — ready for implementation plan.
**Builds on:** `2026-07-13-desktop-chrome-style-tabs-design.md` (the workspace-level
`tileTree`/`WorkspaceTileArea` tab system) and `backend/internal/netproxy`
(SOCKS5/HTTP forward proxy, previously CLI-flag-only). Unrelated to the
existing sandboxed-iframe `frontend/src/features/modules/BrowserModule.tsx`,
which is kept as-is.

## Goal

Add a real, native browser tab to the desktop app's workspace tab strip — not
a sandboxed iframe. A **Browser** tile behaves like a tab in the existing
Chrome-style tiling system (splits, drags, closes like an "Agents"/worktree
tab), but its content is a genuine OS webview whose entire network stack is
routed through a chosen machine's SOCKS5/HTTP forward proxy, so it can reach
that machine's loopback-bound services (e.g. `npm run dev` on a remote
runtime) the same way `ssh -D` does for a shell. It supports bookmarks
(star/"Portal") and opens to a bookmarks-or-blank home page.

This is **desktop (Tauri) only** — gated by the existing `useIsTauri()` hook.
The web app is unaffected. Setting a proxy on a webview's network stack is a
native OS webview capability; a browser `<iframe>` cannot do this, which is
why this feature cannot exist on the web build.

## Decisions (from brainstorming)

1. **Tab placement — workspace-level, not a per-worktree pane, not a
   separate OS window.** A new `TileTab` kind (`{ kind: 'browser'; id: string
   }`) alongside `agents` and `worktree` in `frontend/src/features/tabs/
   tileTree.ts`. A Browser tile lives in the same tiling grid as Agents/
   worktree tabs — it can be split, dragged, and closed with the existing
   `WorkspaceTileCanvas` machinery, with zero changes to that file's core
   drag/drop/resize logic (only its `renderers` prop grows a `browser` case).

2. **Tiled vs. fullscreen tab strip.** At normal tiled size, a Browser tile
   shows one page at a time behind a single compact toolbar (matching the
   reference screenshot: globe icon + label, back/forward, home, address
   bar, reload, "open in real browser", settings gear, fullscreen toggle,
   close — no visible tab strip). Expanding to fullscreen reveals a
   Chrome-like internal tab strip above that toolbar, so the user can hold
   multiple pages open within that one workspace tile. Clicking "+" while
   fullscreen adds an internal tab. Clicking "+" while tiled instead offers a
   choice: open as a new internal tab (same tile), or open as a new sibling
   Browser tile in the workspace (a second top-level `browser` `TileTab` via
   `openTileTab`).

3. **New-tab / home page.** Before first navigation, a Browser tab (or a
   fresh internal tab) shows a bookmarks grid (grouped, like the existing
   `BrowserModule`'s "Portal" concept) if any bookmarks exist, else a blank
   page with the address bar focused. No native child webview is created
   until the user actually navigates somewhere — the home page is rendered
   entirely by React, which also cleanly avoids spinning up a native surface
   for a page nobody asked for yet.

4. **Bookmarks are a separate store from the old `BrowserModule`.** New
   `localStorage` key (e.g. `loom.workspaceBrowser.bookmarks`), same
   `{id,title,url,group}` shape as the existing `loom.browser.bookmarks`,
   but intentionally independent — starring a page in one surface does not
   appear in the other.

5. **Machine selection is a picker; the proxy itself is hub-managed and
   started on demand.** No manual `--socks5-addr`/`--http-proxy-addr`/
   `--proxy-key` CLI flags to configure, and no persisted proxy fields on
   `domain.Machine`. The gear icon opens a picker over existing registered
   machines (`useMachines()`); picking one calls a new endpoint that tells
   that machine's runtime "start your forward-proxy now." The call is
   idempotent — if already running, it returns the existing bound address
   instead of starting a second listener.

6. **Old `BrowserModule.tsx` (sandboxed iframe + backend HTTP-fetch proxy)
   is kept, unmodified, coexisting with this new feature.** They are
   unrelated surfaces reachable through different means: the old module's
   route/nav-item stays hidden exactly as it is today; this new feature is
   reached only via the Browser tile inside the desktop tab strip.

## Architecture

```
┌─ WorkspaceTileArea (existing) ─────────────────────────────────────┐
│  TileTab: 'agents' | 'worktree' | 'browser' (new)                  │
│  WorkspaceTileCanvas renders each leaf's active tab via renderers  │
└───────────────┬──────────────────────────────────────────────────-┘
                │ browser tab active
                ▼
┌─ BrowserTile.tsx (new, frontend/src/features/browser/) ────────────┐
│  Toolbar: back/forward/home/address bar/reload/real-browser/       │
│           gear (machine picker)/fullscreen/close                   │
│  Body (no URL yet): bookmarks grid or blank                        │
│  Body (navigated):  transparent placeholder <div>, ResizeObserver  │
│                      reports screen rect → Rust via invoke()       │
└───────────────┬──────────────────────────────────────────────────-┘
                │ Tauri invoke(): open/navigate/reload/set_bounds/close
                ▼
┌─ Rust: browser_tiles module (new, frontend/src-tauri/src/) ────────┐
│  HashMap<tab_id, Webview> (Mutex-guarded app state)                │
│  Window::add_child(WebviewBuilder.proxy_url(socks5://...), pos,    │
│                     size) → child Webview, overlaid on the main    │
│                     window at the placeholder div's exact bounds   │
└───────────────┬──────────────────────────────────────────────────-┘
                │ SOCKS5/HTTP CONNECT over tailnet
                ▼
┌─ Runtime machine (backend/internal/netproxy, existing) ────────────┐
│  POST /api/proxy/start (new) → starts SOCKS5+HTTP listeners        │
│  in-process, ephemeral port + fresh key, returns bound address     │
└──────────────────────────────────────────────────────────────────-┘
```

Grounded against Tauri 2.9's actual Rust API (not assumed):
`Window::add_child(WebviewBuilder, position, size)` (needs the `unstable`
Cargo feature — not currently enabled), `WebviewBuilder::proxy_url(Url)`
(accepts `http://`/`socks5://`; macOS requires the `macos-proxy` feature +
macOS 14+, also not currently enabled), and `Webview::set_position`/
`set_size`/`set_bounds`/`navigate(url)`/`reload()`/`url()`. Whether Tauri
exposes a navigation/page-load event hook to detect in-page link clicks (for
updating the React address bar automatically) is unconfirmed by the docs
lookups done during brainstorming — the implementation plan must verify this
against `docs.rs/tauri` directly before relying on it; if no such hook
exists, the address bar simply doesn't react to in-page navigation and only
updates when the user explicitly types a URL (a real, disclosed limitation,
not silently papered over).

## Components

### Backend

- **`backend/internal/netproxy`**: no changes to `socks5.go`/`httpproxy.go`
  themselves — both already support in-process construction with a caller-
  supplied key.
- **New `backend/internal/service/proxy.go`**: singleton start/get-state
  service. Mutex-guarded; a second "start" call while already running
  returns the existing bound addresses rather than starting a duplicate
  listener (idempotent, same shape as the existing runtime self-registration
  idempotent-PATCH pattern). Binds to `:0` on the interface implied by the
  machine's own registered `URL` (parse that hostname, bind the listeners
  there) rather than guessing the tailnet interface independently — the
  desktop client dialing this proxy is generally a *different* machine on
  the tailnet, so `127.0.0.1` would be unreachable from it. Generates a
  fresh `crypto/rand` proxy key per first start; never persisted (same
  ephemeral-secret pattern as the Tauri sidecar's own launch key and the old
  `BrowserModule`'s `fetchBrowserProxySession`).
- **New `backend/internal/handler/proxy.go`**: `POST /api/proxy/start` (both
  `--role runtime` and `--role hub`, since the hub's own bundled sidecar can
  itself be the "local machine" target). Response:
  `{"socks5Addr":"host:port","httpProxyAddr":"host:port","proxyKey":"..."}`.
  No `port.Store` involvement — this is in-memory process state, not
  persisted data.
- **Registration**: wired in `main.go` alongside the existing route
  registration block. Reached from the frontend the same way every other
  machine call is: direct-first via `machineClient.ts`, with the existing
  `/api/machines/{id}/proxy/{rest...}` reverse-proxy fallback (no new hub
  plumbing needed for the REST call itself — only the raw SOCKS5/HTTP TCP
  traffic afterward must reach the runtime directly, which is why the bound
  address must be tailnet-reachable, not loopback).
- **`domain.Machine`**: unchanged. No new persisted fields — the picker just
  lists existing machines by their current `URL`/`Key`.

### Rust (Tauri desktop shell)

- **`Cargo.toml`**: add the `unstable` feature to the `tauri` dependency
  (required for `Window::add_child`); add the `macos-proxy` feature
  (macOS-only, gated the same way the existing `#[cfg(target_os = "macos")]`
  blocks in this codebase are) for `proxy_url` to compile there — macOS 14+
  only, an accepted platform floor for this feature specifically (does not
  raise the floor for the rest of the desktop app).
- **New `frontend/src-tauri/src/browser_tiles.rs`**: first module in this
  codebase to register real `#[tauri::command]`s (today only sidecar
  lifecycle exists in `lib.rs`, no `invoke_handler` yet). Holds
  `Mutex<HashMap<String, Webview>>` app state (`tab_id` → child webview
  handle) and exposes:
  - `browser_tile_open(tab_id, proxy_url, initial_url?)` — `add_child` with
    `.proxy_url(...)` set at construction (Tauri's proxy is builder-time
    only; switching a tab's machine mid-session means destroying and
    recreating its child webview, not reconfiguring one in place).
  - `browser_tile_set_bounds(tab_id, x, y, w, h)` — driven by the frontend's
    `ResizeObserver`, debounced to animation frames.
  - `browser_tile_navigate(tab_id, url)`, `browser_tile_reload(tab_id)`.
  - `browser_tile_close(tab_id)` — drops the webview handle.
  - `browser_tile_hide(tab_id)` / `browser_tile_show(tab_id)` — moves an
    inactive internal tab's webview to zero size instead of destroying it,
    so switching between a fullscreen tile's internal tabs doesn't force a
    full reload each time. Capped (e.g. 5 warm backgrounded webviews per
    Browser tile) to bound native memory; beyond the cap the least-recently-
    used backgrounded tab is destroyed instead of hidden.
  - Back/forward: Tauri's `Webview` has no history-traversal API found
    during brainstorming's docs lookups, so back/forward is implemented the
    same way the existing (kept) `BrowserModule` already does it — React
    tracks its own `history`/`historyIndex` array per tab and calls
    `browser_tile_navigate` with the recalled URL, rather than relying on
    native browser history.
  - `browser_tile_open` failure (feature unavailable, macOS < 14 without
    `macos-proxy`, `add_child` errors) surfaces as a one-time capability
    check — if the very first attempt fails, the Browser tab entry point is
    disabled app-wide with a toast, rather than failing silently tile by
    tile.
- **`lib.rs`**: gains `.invoke_handler(tauri::generate_handler![...])` for
  the new commands; `browser_tiles` module registered alongside the existing
  `hubapi`/`sidecar` modules.
- **`capabilities/default.json`**: needs the relevant `core:webview:*`
  permissions for `add_child` (mirrors the existing multiwebview example
  pattern — `core:webview:allow-create-webview-window` plus whatever the
  `add_child`-specific permission is; implementation plan confirms the exact
  permission identifier against current Tauri docs).

### Frontend

- **`@tauri-apps/api` becomes a real dependency.** Today only
  `@tauri-apps/cli` (a dev/build tool) is installed; `useIsTauri()` avoids
  the runtime package entirely by reading the injected global directly. This
  feature's much larger command surface (open/navigate/reload/set_bounds/
  hide/show/close) is invoked through `@tauri-apps/api/core`'s `invoke()`
  rather than hand-rolling raw `window.__TAURI_INTERNALS__.invoke` calls
  everywhere.
- **`tileTree.ts`**: add `{ kind: 'browser'; id: string }` to the `TileTab`
  union and a `createBrowserTab(): TileTab` factory, following the exact
  pattern of `createWorktreeTab`. The tile tree only tracks tab identity/
  position (same as a `worktree` tab only stores `projectId`/`wtId`) — live
  browsing state (current URL, title, loading, internal-tab history) is
  **not** part of the persisted tile tree.
- **New `browserTiles` zustand slice** (no `persist` middleware — browsing
  state is ephemeral by design, same as the kept `BrowserModule`'s per-tab
  state, which also isn't persisted): `Record<tabId, BrowserTileState>`
  holding per-tab URL/history/loading/selected-machine/internal-tabs.
- **`WorkspaceTileCanvas`'s `renderers` prop**: gains a `browser` case.
- **New `frontend/src/features/browser/BrowserTile.tsx`**: the toolbar +
  body described in Decision 2/3, wired to the new store slice and the new
  Tauri commands.
- **New `frontend/src/lib/browserTileBookmarks.ts`**: separate bookmark
  store per Decision 4, otherwise structurally identical to the existing
  bookmark logic in `BrowserModule.tsx`.
- **Machine/proxy picker**: the gear icon's popover lists machines from the
  existing `useMachines()` query; selecting one calls the new
  `POST /proxy/start` via a new `machineApi` function (following the exact
  direct-first/fallback pattern every other machine call already uses in
  `machineClient.ts`), then invokes `browser_tile_open` with the returned
  proxy address/key.

## Data flow (opening a Browser tab and navigating)

1. User clicks "+" → chooses "Browser" (or drags one via the existing
   new-tile flow) → `openTileTab(layout, createBrowserTab())`.
2. `BrowserTile` mounts with no URL yet → renders bookmarks grid or blank
   home page. No Tauri command fired yet.
3. User picks a machine from the gear popover → frontend calls
   `POST /proxy/start` against that machine (direct-first, hub-fallback) →
   backend idempotently starts/returns `{socks5Addr, httpProxyAddr,
   proxyKey}`.
4. User types a URL or clicks a bookmark → frontend calls
   `browser_tile_open(tabId, "socks5://x:<proxyKey>@<socks5Addr>", url)` →
   Rust creates the child `Webview` via `add_child`, positioned at the
   placeholder div's current rect. (`netproxy`'s SOCKS5/HTTP auth accepts
   any username with the proxy key as password, matching `COMMANDS.md`'s
   existing `curl --socks5 pxk:pxk@127.0.0.1:1080` example — the URL needs
   *some* username token even though it's ignored.)
5. `ResizeObserver` on the placeholder div fires on every tile resize/drag/
   fullscreen-toggle → `browser_tile_set_bounds` keeps the native surface
   glued to the tile's on-screen rect.
6. Back/forward/reload/home in the toolbar call `browser_tile_navigate`/
   `browser_tile_reload` with a URL recalled from the tab's own React-side
   history array.
7. Switching machines mid-session → `browser_tile_close` the existing
   webview, repeat step 3-4 against the new machine.
8. Closing the tab (or the whole tile) → `browser_tile_close` for every
   webview belonging to it (including backgrounded internal tabs).

## Error handling

- No machine selected yet: address bar disabled, prompts "choose a machine."
- `/proxy/start` fails (unreachable runtime, 502, etc.): inline error in the
  tile body (mirrors the kept `BrowserModule`'s existing `proxyError`
  pattern), with a retry action.
- Runtime predates this feature (404 on `/proxy/start`): same inline error,
  "this machine's runtime doesn't support the browser proxy; update it."
- Native load failures (DNS, refused, TLS): rendered by the OS webview's own
  native error page inside that surface — no special handling needed, this
  is a real browser engine.
- `add_child`/`proxy_url` capability failure (feature not compiled in,
  macOS < 14 without `macos-proxy`): detected on first attempt, Browser tab
  entry point disabled app-wide with a toast rather than a per-tile failure
  state.

## Testing

- **Backend**: table-driven tests for `POST /proxy/start` idempotency
  (`internal/handler`/`internal/service`, following existing patterns like
  `keyauth_test.go`), plus `go vet ./...`.
- **Frontend**: `npm run typecheck` (no test runner exists in this repo, per
  the existing tile-splitting plan's own stated constraint).
- **Rust**: kept thin per this repo's existing Tauri conventions — bounds/
  position math is the only piece amenable to a pure unit test; the real
  gate is a manual end-to-end smoke test via `make dev-tauri`: open a
  Browser tab, pick a machine, confirm proxied navigation reaches a
  runtime-local dev server otherwise unreachable, drag-split it next to a
  worktree tab, fullscreen it and open a second internal tab, star a
  bookmark, close and reopen to confirm the separate bookmark store.

## Out of scope (v1)

- Dragging a Browser tile out into its own separate OS-level window (out of
  scope for the tile system generally, per the chrome-style-tabs spec).
- Real native browser history (back/forward is React-tracked, not
  OS-webview-native, per the Rust component notes above).
- Auto-detecting/advertising which machines currently have a proxy running
  before the user picks one — the picker always attempts start-on-demand.
- Syncing bookmarks between the old `BrowserModule` and this new feature.
- Any change to the terminal WebSocket framing/compression (production
  tunnel depends on it) or to `domain.Machine`'s persisted shape.

# Chrome Polish + Loading Affordances — Design

**Date:** 2026-08-02
**Status:** Approved — ready for implementation plan.
**Builds on:** `2026-08-01-browser-tile-chrome-replication-design.md` (the
current three-zone `BrowserToolbar` / `BrowserTabStrip` / `BrowserUrlCard`
split this refines — that spec's §3.3/§3.4/§3.8 are amended here, not
replaced).
**Scope:** Frontend only. The browser tile chrome
(`frontend/src/features/browser/*`), the workspace tab strip's pill styling
(`WorkspaceTileCanvas.tsx` → `TileTabButton` / `TabDot` only), and the left
rail (`SidebarNav.tsx`, `Sidebar.tsx`). No backend, no Rust, no store-shape
change.

**Non-goals:**
- Refactoring `WorkspaceTileCanvas.tsx` (923 lines) beyond the pill/dot
  changes in §4. Splitting that file is real debt but out of scope here.
- Removing multi-doc browser tiles. `BrowserDocState[]` stays; §3.2 only
  changes when its strip is *rendered*.
- Skeleton loaders for non-browser data surfaces. Deferred by explicit
  decision (§8).
- Any change to `BrowserUrlCard`'s behavior or the global command palette.

---

## 1. Problem

### 1.1 The chrome reads as two competing tab systems

With one document open in a Browser tile — the common case — the workspace
tab strip shows a pill labeled `youtube.com — Penelusuran…`, and directly
below it `BrowserTabStrip` renders a *second*, centered pill labeled
`www.youtube.com`. They are structurally different (`TileTab` vs
`BrowserDocState`) but visually near-identical, stacked 8px apart. The user
reads them as duplication.

The cost is also vertical: `h-8` strip + `h-9` toolbar ≈ 68px of chrome
before content starts, on every browser tile, permanently.

### 1.2 The toolbar's horizontal rhythm is broken

`BrowserToolbar.tsx:109` renders back/forward **conditionally** on
`canGoBack || canGoForward`. The first navigation therefore injects two 28px
buttons into the row and shifts the centered tab strip and the entire right
cluster sideways. Layout that moves as a side effect of navigation is a
defect, not a style preference.

The right cluster compounds it: four 28px icon buttons plus one 112px
`Select` for the machine picker (`BrowserToolbar.tsx:85-91`). The Select is
the single heaviest element in the whole chrome, yet it carries a value that
is set once and rarely changed.

### 1.3 Loading is nearly invisible

`loading` flows correctly from the native webview through
`browserTilesBridge.ts:133-137` into `BrowserDocState`. Its **only** visual
consequence is `BrowserToolbar.tsx:127` swapping the `RefreshCw` glyph for an
`X`. There is no progress indicator, no motion, and no signal at all on a
tile that is not currently focused. A static glyph swap does not read as
"something is happening".

### 1.4 Tab pills read as buttons, and the rail's active state is faint

`WorkspaceTileCanvas.tsx:331-337` gives an active tab five simultaneous
affordances: a dot, a strong border, an elevated background, an inset
highlight, and a drop shadow. That is button styling, not tab styling. Labels
also use `font-mono` at 11.5px for what is prose (a page title).

In the rail, `SidebarNav.tsx:58` marks the active item with
`bg-devdeck-accent-tint` + `ring-1 ring-inset ring-devdeck-border-accent`. The
ring is too low-contrast to register peripherally. Worse, the "N running"
badge (`SidebarNav.tsx:63`) is `bg-devdeck-accent-soft` — accent-on-accent-tint
— so it nearly vanishes on precisely the item that is active.

---

## 2. Approach

One row of chrome in the common case; a centered omnibox as the row's anchor;
motion as the loading signal; and exactly one active-state affordance per
surface. Four independent workstreams, listed §3–§6, sharing two new
primitives from §7.

---

## 3. Browser tile chrome

### 3.1 Three fixed zones, `h-9`, never shifting

```
┌────────────────────────────────────────────────────────────┐
│ ‹  ›  ↻    ╭──── omnibox ─────────────────╮    + ⌂ ⌕ ⤡    │
│            │ ◆ www.youtube.com · ● home-l │               │
│            ╰──────────────────────────────╯               │
└════════════════════════════════════════════════════════════┘
   left: nav       center: flex-1 max-w-[640px]     right: 4 icons
```

- **Left cluster.** Back, forward, reload/stop — **always rendered**.
  Back/forward take `disabled` when unavailable rather than unmounting. This
  fixes §1.2's shift.
- **Center.** `BrowserOmnibox`, `flex-1` with `max-w-[640px]`, horizontally
  centered in the remaining space.
- **Right cluster.** `+` (new tab), Home, Find, Fullscreen — four uniform
  28px icon buttons (`pointer-coarse:h-9 w-9`, per the existing
  `toolbarButtonClass`). The machine `Select` leaves this cluster entirely
  (§3.3).
- Below `@sm/tile` the right cluster still collapses into the existing
  `TabStripPopoverMenu`. Its contents change by exactly one item: the machine
  `Select` is **no longer** in the popover (it now lives in the omnibox, §3.3),
  so `rightCluster(compact)` becomes `+`, Home, Find, Fullscreen. The
  `compact` parameter — which existed only to widen the Select inside the
  narrow popover — is therefore removed.

### 3.2 Tab strip collapses at one document

`BrowserTabStrip` renders **only when `tile.docs.length > 1`**. When it does
render it becomes its own `h-8` row **above** the toolbar, **left-aligned**
(a centered strip reads as decoration; a left-aligned one reads as tabs).

`TabPill`'s mount-at-width-0 → measured-width grow/shrink transition and its
`onShrinkComplete` splice are **retained as-is** — that mechanism is correct
and load-bearing for close animation.

Result: 36px of chrome at one doc, 68px at two or more.

### 3.3 `BrowserOmnibox` (new component)

`h-7`, `rounded-full`, `bg-devdeck-surface-2`, `border-devdeck-border-card`,
hover/focus-within → `border-devdeck-border-strong`. Contents, left to right:

1. `BrowserFaviconChip`, `size={14}`.
2. **URL with domain emphasis.** The registrable domain renders
   `text-devdeck-fg`; scheme, subdomain, path, and query render
   `text-devdeck-dim`. This is what makes an 11px URL scannable, and it
   matches the security-relevant emphasis every mainstream browser uses.
   Backed by `splitUrlForDisplay()` (§7.2).
3. A `·` separator, then the **machine chip** at the right inner edge:
   `StatusDot` driven by `machineHealth.get(machineId)?.status`, plus the
   machine name truncated to `max-w-[72px]`. Clicking the chip opens the
   existing `Select` dropdown with the same `options`/`onValueChange`
   contract — only the trigger's presentation changes.

Clicking anywhere on the omnibox **other than the machine chip** calls the
existing `onEditActiveUrl` → opens `BrowserUrlCard`. `BrowserUrlCard` itself
is untouched.

The omnibox is a `<div>` containing a `<button>` (URL area) and the Select
trigger as siblings — never nested interactive elements.

**Narrow tiles.** Below `@sm/tile` the machine chip drops its text label and
renders as the `StatusDot` alone (still clickable, `aria-label` retains the
machine name). The omnibox's `max-w-[640px]` yields to the available width;
the URL truncates from the *path* end first, so the domain — the part that
matters — is the last thing to be cut.

### 3.4 One `+` button

The `+` currently lives at the end of `BrowserTabStrip`
(`BrowserTabStrip.tsx:65-72`). It moves permanently into the right cluster as
the first item, tooltip `New tab (⌘T)`, and is **removed from the strip**.
One control, one location, whether or not the strip is visible.

---

## 4. Loading affordances

### 4.1 `ProgressLine` — indeterminate, by necessity

The bridge supplies `loading: boolean` only
(`browserTilesBridge.ts:133`); there is no percentage. A determinate bar
would fabricate progress, so the indicator is **indeterminate**: a segment
~30% of track width traveling left→right, 1.1s ease-in-out loop, painted
with `--devdeck-accent-gradient` on a transparent 2px track.

It is positioned absolutely at the **bottom seam of the chrome block**,
spanning the tile's full width, so it reads as "this tile is loading" rather
than decorating any single control.

Two behaviors carry most of the perceived quality:

- **150ms show delay.** Cache-served navigations resolve in one or two
  frames; without the delay the bar flashes and reads as a glitch. If
  `loading` goes false before 150ms elapse, the bar never mounts.
- **180ms fade-out.** On completion the bar fades rather than snapping off.

`prefers-reduced-motion: reduce` → a static full-width accent line at 40%
opacity, no travel, same show/hide timing.

### 4.2 Reload button: spin, then stop-on-hover

Replaces the immediate glyph swap of §1.3. While `loading`:

- Default: `RefreshCw` with `animate-spin` (900ms linear).
- On hover or keyboard focus: swaps to `X`, `aria-label="Stop"`.
- On `pointer-coarse` (no hover): shows `X` immediately while loading, since
  hover-to-reveal is unreachable by touch.

`aria-label` tracks whichever action the button will actually perform.

### 4.3 Loading propagates to the workspace tab dot

When a browser tile's active doc is loading, that tile's `TabDot` in the
workspace strip pulses (accent, 1.4s ease-in-out, opacity 0.45→1). This is
the only signal that a **non-focused** tile is working. Suppressed under
`prefers-reduced-motion`.

`TabDot` gains an optional `loading?: boolean` prop; `TileTabButton` passes it
for `kind === 'browser'` tabs, resolved from the same `resolveBrowserTab`
lookup already in place.

---

## 5. Workspace tab strip

Reduce five competing active affordances (§1.4) to two:

| Aspect | Now | After |
|---|---|---|
| Label font | `font-mono` 11.5px | UI sans 12px (mono retained for the `⌘N` `<kbd>` only) |
| Active | dot + strong border + elevated bg + inset highlight + drop shadow | dot + `bg-devdeck-elevated` |
| Inactive hover | adds a border **and** a background | background only (`bg-devdeck-hover-wash`) |
| `⌘N` badge | `opacity-35` always visible | active tab always; others `opacity-0 group-hover:opacity-60` |

Dropping the hover border also removes a 1px reflow on every hover.

The `<kbd>`-swaps-to-close-`X` mechanism on hover
(`WorkspaceTileCanvas.tsx:377-391`) is correct and stays.

---

## 6. Left rail

- **Active indicator becomes an edge bar.** A 2px × 16px accent bar on the
  rail's left edge, vertically translated to the active item with
  `transition-transform duration-150`. The `ring-1 ring-inset` is removed;
  `bg-devdeck-accent-tint` stays. A bar at the container edge is readable
  peripherally in a way an inset ring is not. Under
  `prefers-reduced-motion` the bar jumps instead of sliding.
- **Badge recolored.** `bg-devdeck-green` + `ring-2 ring-devdeck-surface`,
  replacing `bg-devdeck-accent-soft`. It survives the active tint (§1.4), and
  green is the honest color for "N worktrees running" — a health signal, not
  a brand accent.
- **Badge waits for data.** Render only once `useWorkspace(wsId)` has settled,
  avoiding a 0→N pop on first paint.
- **Three groups, two hairlines.** `h-px w-6 bg-devdeck-border` between
  `WorkspaceSwitcher` and `SidebarNav`, and above the bottom PIN/settings
  group.
- Item spacing `gap-1.5` → `gap-1`; item box stays `h-10 w-10`.

---

## 7. New shared units

Each is independently testable and has one job.

### 7.1 `components/ui/progress-line.tsx`

```ts
interface ProgressLineProps {
  active: boolean
  /** ms to wait before showing — suppresses flashes on instant loads. */
  delayMs?: number   // default 150
  className?: string
}
```

Owns only the delay/fade state machine and the bar markup. Generic — no
browser-tile coupling, reusable by any surface later.

### 7.2 `features/browser/splitUrlForDisplay.ts`

```ts
interface UrlParts { prefix: string; domain: string; rest: string }
function splitUrlForDisplay(url: string): UrlParts
```

Pure. Sits beside the existing `displayUrl.ts` and follows the same
convention (pure module + colocated `.test.ts`). `prefix` holds scheme and
any subdomain, `domain` the registrable domain, `rest` path/query/hash.
Non-URL input (a search phrase, an empty string) returns it all in `domain`
so the caller renders it at full contrast.

### 7.3 `features/browser/BrowserOmnibox.tsx`

Per §3.3.

### 7.4 `styles/globals.css`

Two `@keyframes` — `progress-slide` (§4.1) and `dot-pulse` (§4.3) — beside
the existing `agblink`, each guarded by a `prefers-reduced-motion` override.

---

## 8. Testing & verification

Follows the codebase's existing convention: **pure logic gets unit tests,
presentational composition does not.**

- `splitUrlForDisplay.test.ts` — covers https/http, bare domain, subdomain,
  deep path + query + hash, `localhost:PORT`, IP literal, non-URL search
  text, and empty string. Modeled on the existing `displayUrl.test.ts`.
- `ProgressLine` — its delay/fade state machine is the one piece of new
  *behavior* worth testing directly (show suppressed under `delayMs`, shown
  after, fade on deactivate). Uses fake timers.
- No test for `docs.length > 1`; it is a one-expression render guard.
- Gate: `npm run typecheck`, then `npm run build`.

Manual check (desktop/Tauri, since the native webview drives `loading`): load
a slow page and confirm bar + spinner appear; load a cached page and confirm
the bar does **not** flash; split a tile and confirm a background tile's dot
pulses.

---

## 9. Risks

- **Native-webview occlusion.** The omnibox and its machine dropdown sit over
  a native webview. The dropdown must keep using the existing
  `useNativeOverlayBlocker` path that `Select` already wires up
  (`components/ui/select.tsx`); the omnibox itself is inline chrome, not an
  overlay, so it needs no blocker.
- **`+` relocation is a learned-position change** for anyone already using
  the strip's `+`. Mitigated by the tooltip naming `⌘T`.
- **`TabDot` gains a prop consumed in one branch.** Keep it optional and
  defaulted so the worktree/ssh/agents branches are untouched.

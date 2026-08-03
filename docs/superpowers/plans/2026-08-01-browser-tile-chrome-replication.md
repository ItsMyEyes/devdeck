# Browser Tile Chrome Replication + Occlusion-Aware Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This plan is split into exactly THREE slices, executed by three separate agents in sequence** (Slice 1 → Slice 2 → Slice 3). Each slice is self-contained: it ends with a passing `npm --prefix frontend run typecheck` and a working app, regardless of whether the next slice ever lands. Do not start Slice 2 before Slice 1 is committed; do not start Slice 3 before Slice 2 is committed.

**Goal:** Replace `BrowserTile.tsx`'s wrapping single-row toolbar and fullscreen-only internal tab strip with a fixed-height, never-wrapping chrome (toolbar / animated tab strip / URL card / Find bar / Zoom toast), and replace the app-global `nativeOverlayBlockers` counter with a keyed, rect-scoped occlusion system so a Browser tile's native webview only hides for an overlay that actually overlaps it — per `docs/superpowers/specs/2026-08-01-browser-tile-chrome-replication-design.md`.

**Architecture:**
- **Slice 1 (Foundation)** changes the shared occlusion primitive: `nativeOverlayBlockers` goes from a bare `number` to `Record<string, OverlayBlockerRegion>` in `useDevDeckStore.ts` (the only slice allowed to touch that file), `useNativeOverlayBlocker` gains an optional `rectRef` parameter that is a true drop-in for all existing callers, a pure `tileShouldBeHidden` decision function is extracted and unit-tested, the highest-value existing call sites are migrated to report a precise rect instead of the `'viewport'` default, the one known counter-leak vector (`TileSplitView`'s divider drag) is closed structurally, and the small Rust surface this whole feature depends on (`on_page_load` payload fix, `set_zoom`, JS-eval find-in-page) is added. `BrowserTile.tsx` gets only the one-line change required to keep compiling against the new store shape — its real visibility-effect rewrite is Slice 3's job.
- **Slice 2 (Chrome components)** adds every new presentational file the redesigned chrome needs — toolbar, animated tab strip, URL card, Find bar, a shared favicon-chip, and the pure `browserTabWidth`/`displayUrl`/`browserZoom` helpers — as brand-new files with no BrowserTile.tsx dependency in either direction, so they compile and are testable in total isolation.
- **Slice 3 (Integration)** rewrites `BrowserTile.tsx` onto the Slice 2 components, wires the real occlusion-aware visibility effect using Slice 1's `tileShouldBeHidden`, wires the reload↔stop icon to the fixed `on_page_load` payload, and adds the three tile-scoped keybindings (Cmd/Ctrl+L, Cmd/Ctrl+F, zoom chords), deleting everything the rewrite makes dead.

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`), zustand (immer middleware), `@base-ui/react`, `sonner`, Tauri v2.11 / wry, Rust. No test runner is installed — pure-logic tests use hand-rolled `check`/`assertEqual` scripts run via `npx tsx`.

## Global Constraints

- This is ordinary application feature work (a desktop browser-tab chrome redesign), not security-sensitive code — terms like "proxy", "token", "SOCKS5", "occlusion blocker" below refer to normal app functionality, not exploit development.
- **`frontend/src/store/useDevDeckStore.ts` is a CONVERGENCE FILE: only Slice 1 may touch it.** Slices 2 and 3 must not edit it, even to add a selector — if Slice 3 needs something new from the store, that's a sign the task belongs in Slice 1 instead.
- **Slice 2 creates only new files.** No step in Slice 2 may modify an existing file, and no new Slice 2 file may import from or be imported by `frontend/src/features/browser/BrowserTile.tsx`.
- **Every slice ends with `npm --prefix frontend run typecheck` passing** before that slice's final commit.
- Use the `@/*` path alias for all imports from `src/` in `.ts`/`.tsx` source files — **except** `.test.ts` files, which use relative imports (e.g. `./browserTabWidth`), matching every existing `*.test.ts` file in this repo (they run via plain `npx tsx`, which does not resolve the `@/*` alias).
- `verbatimModuleSyntax` is on — use `import type` for all type-only imports.
- This repo has **no Vitest/Jest/RTL/jsdom** — do not add one. Pure-logic helpers get a same-directory `<name>.test.ts` following the exact style of `frontend/src/lib/browserTileBookmarks.test.ts` (a local `check(name, fn)` + `assertEqual(actual, expected, message)`, run via `npx tsx src/<path>.test.ts` from `frontend/`). Presentational/wiring changes have no unit test — verify with typecheck and a manual check in the running desktop app.
- Default to no comments; only add one when it captures a non-obvious WHY, matching the density and voice of the surrounding file — no banner comments, no restating what the code already says.
- Never edit `frontend/src/routeTree.gen.ts`.
- Never hardcode hex colors in new components — use the existing `--devdeck-*` Tailwind classes (`bg-devdeck-bg`, `text-devdeck-muted`, `border-devdeck-border-menu`, ...), already used throughout `BrowserTile.tsx` and its siblings.
- Icons: `lucide-react` only. Toasts: `import { toast } from 'sonner'`. className merging: `cn()` from `@/lib/utils`.
- **Preserve existing behavior that already works**: bookmarks grouping (`groupBookmarksByMachine`), the legacy-bookmark one-shot migration (`legacyBookmarksMigrated`/`takeLegacyBrowserTileBookmarks`), proxy/machine-switching semantics (`ensureProxyForMachine`/`selectMachine`), the serialized `setBrowserTileBounds` queue in `browserTilesBridge.ts`, `@container/tile` responsiveness (`@sm/tile`/`@lg/tile` breakpoints), and `pointer-coarse:` touch targets. None of these are in scope to change; only their surrounding chrome is.
- This spec's own §7 table already confirms: Task 1 (`tileDragActive`) and Task 2 (drag-ghost blocker) of the 2026-07-31 bugfixes plan are **landed** — this plan builds on top of them (and Slice 1 modifies both further), not around them. Tasks 3–5 and 6–13 of that plan are still open and explicitly out of scope here; do not let this plan's Rust/store changes block them.

---

# Slice 1 — Foundation (store + hook + Rust)

Everything in this slice is either additive (new pure files, new Rust commands) or a narrow, behavior-preserving rewrite of the occlusion primitive. No visual chrome changes yet — the app must look and behave exactly as it does today after this slice lands, just with the blink-suppression machinery in place underneath.

## Task 1: Occlusion types + store shape

**Files:**
- Modify: `frontend/src/store/types.ts` (append at end of file)
- Modify: `frontend/src/store/useDevDeckStore.ts:21-29` (type import), `:275-283` (state field), `:329-330` (action types), `:548` (initial value), `:656-657` (action implementations)

**Interfaces:**
- Produces: `OverlayBlockerRect` and `OverlayBlockerRegion` (`frontend/src/store/types.ts`); `useDevDeckStore`'s `nativeOverlayBlockers: Record<string, OverlayBlockerRegion>`, `pushNativeOverlayBlocker(id: string, region: OverlayBlockerRegion): void`, `popNativeOverlayBlocker(id: string): void`.

- [ ] **Step 1: Add the region types to `frontend/src/store/types.ts`**

  Append at the end of the file:

  ```ts
  /** Purely frontend UI state — no backend counterpart, so the CONTRACTS.md
   *  domain-type-mirroring rule doesn't apply here. Lives in `types.ts` rather
   *  than colocated in `useDevDeckStore.ts` (like `BrowserDocState`) because
   *  every occlusion-aware component (7+ files across `components/ui/` and
   *  `features/browser/`) needs to import just the type, not the store's own
   *  runtime logic. */
  export interface OverlayBlockerRect {
    left: number
    top: number
    right: number
    bottom: number
  }

  /** A blocker's on-screen footprint. `'viewport'` is a first-class region —
   *  not a special-cased rect — meaning "covers the whole app": a modal
   *  backdrop, the mobile sidebar drawer. Anything smaller reports its own
   *  `OverlayBlockerRect` instead. See `useNativeOverlayBlocker.ts`. */
  export type OverlayBlockerRegion = OverlayBlockerRect | 'viewport'
  ```

- [ ] **Step 2: Import the new type into the store**

  In `frontend/src/store/useDevDeckStore.ts`, add `OverlayBlockerRegion` to the existing type-only import block (around line 21-29):

  ```ts
  import type {
    DBConnection,
    DBEngine,
    OverlayBlockerRegion,
    Priority,
    Project,
    SSHConnection,
    Workspace,
    Worktree,
  } from './types'
  ```

- [ ] **Step 3: Replace the `nativeOverlayBlockers` field's type and doc comment**

  Replace (around line 275-283):

  ```ts
    /** Count of currently-open DOM overlays that must render above everything
     *  (command palettes, dialogs, dropdowns) — Tauri's native child webviews
     *  (Browser tiles) are separate OS-composited surfaces the window manager
     *  always stacks above the app's own DOM, so no CSS `z-index` can put a
     *  DOM overlay in front of one. `BrowserTile` hides its native webview
     *  while this is nonzero and restores it once every blocker has closed —
     *  see `FileQuickOpen`'s `useEffect` for the push/pop pattern other
     *  full-screen overlays should follow. */
    nativeOverlayBlockers: number
  ```

  with:

  ```ts
    /** Currently-open DOM overlays that must render above the entire app DOM
     *  (command palettes, dialogs, dropdowns) — Tauri's native child webviews
     *  (Browser tiles) are separate OS-composited surfaces the window manager
     *  always stacks above the app's own DOM, so no CSS `z-index` can put a
     *  DOM overlay in front of one. Keyed by a per-hook-instance id (see
     *  `useNativeOverlayBlocker.ts`'s `useId()`) rather than a bare counter,
     *  so `BrowserTile` can hide only for the blockers whose own reported
     *  region actually overlaps its rect — an empty object is the exact
     *  equivalent of today's `nativeOverlayBlockers === 0`. */
    nativeOverlayBlockers: Record<string, OverlayBlockerRegion>
  ```

- [ ] **Step 4: Update the two action type signatures**

  Replace (around line 329-330):

  ```ts
    pushNativeOverlayBlocker: () => void
    popNativeOverlayBlocker: () => void
  ```

  with:

  ```ts
    pushNativeOverlayBlocker: (id: string, region: OverlayBlockerRegion) => void
    popNativeOverlayBlocker: (id: string) => void
  ```

- [ ] **Step 5: Update the initial value**

  Replace (around line 548):

  ```ts
        nativeOverlayBlockers: 0,
  ```

  with:

  ```ts
        nativeOverlayBlockers: {},
  ```

- [ ] **Step 6: Update the action implementations**

  Replace (around line 656-657):

  ```ts
        pushNativeOverlayBlocker: () => set((s) => void (s.nativeOverlayBlockers += 1)),
        popNativeOverlayBlocker: () => set((s) => void (s.nativeOverlayBlockers = Math.max(0, s.nativeOverlayBlockers - 1))),
  ```

  with:

  ```ts
        pushNativeOverlayBlocker: (id, region) => set((s) => void (s.nativeOverlayBlockers[id] = region)),
        popNativeOverlayBlocker: (id) => set((s) => void delete s.nativeOverlayBlockers[id]),
  ```

  (`tileDragActive`/`setTileDragActive`, immediately below, are untouched by this task — see Task 5.)

- [ ] **Step 7: Confirm the store alone doesn't yet typecheck clean**

  Run: `npm --prefix frontend run typecheck` from the repo root. Expect exactly one new error, in `frontend/src/features/browser/BrowserTile.tsx`, on the line comparing `nativeOverlayBlockers > 0` — a `Record` no longer supports `>`. This is fixed in Task 5. Every other file is fine because the hook itself (`useNativeOverlayBlocker.ts`) hasn't been touched yet and still calls the old zero-arg actions — Task 3 fixes that next.

---

## Task 2: Pure occlusion decision helper + tests

**Files:**
- Create: `frontend/src/features/browser/browserTileOcclusion.ts`
- Test: `frontend/src/features/browser/browserTileOcclusion.test.ts`

**Interfaces:**
- Produces: `TileRect`, `rectsIntersect(a: TileRect, b: TileRect): boolean`, `tileShouldBeHidden(tileRect: TileRect, blockers: Record<string, OverlayBlockerRegion>, tileDragActive: boolean): boolean`.

- [ ] **Step 1: Write the failing test**

  Create `frontend/src/features/browser/browserTileOcclusion.test.ts`:

  ```ts
  import { rectsIntersect, tileShouldBeHidden } from './browserTileOcclusion'

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

  const tileRect = { left: 100, top: 100, right: 300, bottom: 300 }

  check('rectsIntersect is true for overlapping rects', () => {
    assertEqual(rectsIntersect(tileRect, { left: 200, top: 200, right: 400, bottom: 400 }), true, 'overlapping')
  })

  check('rectsIntersect is false for disjoint rects', () => {
    assertEqual(rectsIntersect(tileRect, { left: 400, top: 400, right: 500, bottom: 500 }), false, 'disjoint')
  })

  check('rectsIntersect is false for merely-touching (edge-adjacent) rects', () => {
    assertEqual(rectsIntersect(tileRect, { left: 300, top: 100, right: 400, bottom: 300 }), false, 'edge-adjacent, not overlapping')
  })

  check('tileShouldBeHidden is false with no blockers and no drag', () => {
    assertEqual(tileShouldBeHidden(tileRect, {}, false), false, 'nothing blocking')
  })

  check("tileShouldBeHidden is true for a 'viewport' blocker regardless of rect", () => {
    assertEqual(tileShouldBeHidden(tileRect, { a: 'viewport' }, false), true, "'viewport' always hides")
  })

  check('tileShouldBeHidden is false for a blocker rect that does not intersect the tile', () => {
    assertEqual(tileShouldBeHidden(tileRect, { a: { left: 400, top: 400, right: 500, bottom: 500 } }, false), false, 'non-intersecting rect never hides')
  })

  check('tileShouldBeHidden is true for a blocker rect that intersects the tile', () => {
    assertEqual(tileShouldBeHidden(tileRect, { a: { left: 200, top: 200, right: 400, bottom: 400 } }, false), true, 'intersecting rect hides')
  })

  check('tileShouldBeHidden short-circuits on tileDragActive before any rect math', () => {
    assertEqual(tileShouldBeHidden(tileRect, {}, true), true, 'tileDragActive hides even with zero blockers')
  })

  console.log(`\n${passed} tests passed`)
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `frontend/`): `npx tsx src/features/browser/browserTileOcclusion.test.ts`
  Expected: FAIL — `Cannot find module './browserTileOcclusion'`.

- [ ] **Step 3: Write the minimal implementation**

  Create `frontend/src/features/browser/browserTileOcclusion.ts`:

  ```ts
  import type { OverlayBlockerRegion } from '@/store/types'

  /** A measured on-screen rect — structurally identical to `OverlayBlockerRect`
   *  but named separately since this side of the comparison is always a live
   *  `getBoundingClientRect()` result, not a stored blocker region. */
  export interface TileRect {
    left: number
    top: number
    right: number
    bottom: number
  }

  export function rectsIntersect(a: TileRect, b: TileRect): boolean {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  }

  /** The occlusion decision rule (chrome-replication design spec §5.4):
   *  `tileDragActive` short-circuits to an immediate, geometry-free hide
   *  (an interactive divider drag needs zero latency, and native webviews lag
   *  behind fast CSS resizes — see `WorkspaceTileCanvas.tsx`'s `TileSplitView`).
   *  Otherwise, hide only for a `'viewport'` blocker (unconditional, matches
   *  today's behavior for app-wide overlays) or a rect blocker that actually
   *  overlaps `tileRect` — the core of the "stop blinking for overlays
   *  nowhere near this tile" fix. */
  export function tileShouldBeHidden(
    tileRect: TileRect,
    blockers: Record<string, OverlayBlockerRegion>,
    tileDragActive: boolean,
  ): boolean {
    if (tileDragActive) return true
    for (const region of Object.values(blockers)) {
      if (region === 'viewport') return true
      if (rectsIntersect(tileRect, region)) return true
    }
    return false
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run (from `frontend/`): `npx tsx src/features/browser/browserTileOcclusion.test.ts`
  Expected: all 8 `ok - ...` lines print, then `8 tests passed`.

---

## Task 3: Rewrite `useNativeOverlayBlocker` with an optional `rectRef`

**Files:**
- Modify: `frontend/src/features/browser/useNativeOverlayBlocker.ts` (full rewrite)

**Interfaces:**
- Produces: `useNativeOverlayBlocker(active: boolean, rectRef?: RefObject<HTMLElement | null>): void` — a true drop-in for every existing `useNativeOverlayBlocker(active)` call site (omitting `rectRef` reproduces today's exact `'viewport'` behavior).

- [ ] **Step 1: Replace the file in full**

  ```ts
  import { useEffect, useId } from 'react'
  import type { RefObject } from 'react'
  import { useDevDeckStore } from '@/store/useDevDeckStore'

  /** Pushes a scoped occlusion blocker while `active` is true. The desktop
   *  Browser tile is a native OS webview stacked above the entire app DOM (see
   *  `BrowserTile`'s occlusion effect) — no CSS `z-index` can put a DOM
   *  overlay in front of one, so every overlay that must appear above a
   *  Browser tile (dialogs, dropdowns, tooltips, popovers, the mobile
   *  sidebar) has to call this for as long as it's open.
   *
   *  `rectRef` is optional and a true drop-in: omitting it (or passing a ref
   *  whose `.current` is still null when this fires) pushes a `'viewport'`
   *  blocker, reproducing today's "hide every open Browser tile" behavior
   *  exactly. Passing a ref to the overlay's own positioned element instead
   *  scopes the blocker to that element's live rect, so a Browser tile only
   *  hides when this overlay's rect actually overlaps it — see the
   *  chrome-replication design spec §5.2/§5.3 for which call sites should
   *  make that switch and which should deliberately stay `'viewport'`. */
  export function useNativeOverlayBlocker(active: boolean, rectRef?: RefObject<HTMLElement | null>): void {
    const push = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
    const pop = useDevDeckStore((s) => s.popNativeOverlayBlocker)
    const id = useId()

    useEffect(() => {
      if (!active) return
      if (!rectRef?.current) {
        push(id, 'viewport')
        return () => pop(id)
      }
      const el = rectRef.current
      const update = () => {
        const r = el.getBoundingClientRect()
        push(id, { left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
      update()
      const observer = new ResizeObserver(update)
      observer.observe(el)
      window.addEventListener('scroll', update, true)
      window.addEventListener('resize', update)
      return () => {
        observer.disconnect()
        window.removeEventListener('scroll', update, true)
        window.removeEventListener('resize', update)
        pop(id)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, rectRef, push, pop, id])
  }
  ```

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck`. Expect the same single pre-existing error from Task 1 Step 7 (`BrowserTile.tsx`'s `nativeOverlayBlockers > 0`) — every one of the ~11 existing bare `useNativeOverlayBlocker(active)` calls (`dialog.tsx`, `drawer.tsx`, `select.tsx`, `combobox.tsx`, `tooltip.tsx` x2, `tab-strip-popover-menu.tsx`, `FileQuickOpen.tsx`, `ContentSearchPanel.tsx`, `WorkspaceTileCanvas.tsx`, `Sidebar.tsx`) now compiles unchanged against the new optional second parameter.

---

## Task 4: Migrate the highest-value call sites to report a precise rect

Per the design spec §5.3: migrate anything small, frequent, and positioned; leave anything meant to visually dominate the whole app (`dialog.tsx`, `drawer.tsx`, `Sidebar.tsx`'s mobile drawer, `FileQuickOpen.tsx`) as `'viewport'`, unmigrated, intentionally.

**Files:**
- Modify: `frontend/src/components/ui/tooltip.tsx`, `frontend/src/components/ui/select.tsx`, `frontend/src/components/ui/combobox.tsx`, `frontend/src/components/ui/tab-strip-popover-menu.tsx`, `frontend/src/features/terminal/ContentSearchPanel.tsx`

**Interfaces:**
- Consumes: `useNativeOverlayBlocker(active, rectRef)` from Task 3.

- [ ] **Step 1: `tooltip.tsx` — the §1.2 worst offender, both `Tooltip` and `InfoTooltip`**

  In `frontend/src/components/ui/tooltip.tsx`, change the import line:

  ```ts
  import { useState, type ReactElement } from 'react'
  ```

  to:

  ```ts
  import { useRef, useState, type ReactElement } from 'react'
  ```

  In `Tooltip` (around line 21-22), replace:

  ```ts
    const [localOpen, setLocalOpen] = useState(false)
    useNativeOverlayBlocker(open ?? localOpen)
  ```

  with:

  ```ts
    const [localOpen, setLocalOpen] = useState(false)
    const popupRef = useRef<HTMLDivElement>(null)
    useNativeOverlayBlocker(open ?? localOpen, popupRef)
  ```

  and add `ref={popupRef}` to its `<BaseTooltip.Popup>` (around line 29):

  ```tsx
            <BaseTooltip.Popup
              ref={popupRef}
              className={cn(
  ```

  In `InfoTooltip` (around line 47-48), replace:

  ```ts
    const [open, setOpen] = useState(false)
    useNativeOverlayBlocker(open)
  ```

  with:

  ```ts
    const [open, setOpen] = useState(false)
    const popupRef = useRef<HTMLDivElement>(null)
    useNativeOverlayBlocker(open, popupRef)
  ```

  and add `ref={popupRef}` to its own `<BaseTooltip.Popup>` (around line 61).

- [ ] **Step 2: `select.tsx` — the machine picker inside `BrowserTile`'s own toolbar**

  Change the import line:

  ```ts
  import { useState } from 'react'
  ```

  to:

  ```ts
  import { useRef, useState } from 'react'
  ```

  Replace (around line 26-31):

  ```ts
    const [open, setOpen] = useState(false)
    // A Browser tile's native webview always stacks above this popup (see
    // useNativeOverlayBlocker's doc comment) — most visibly for this
    // component, since it's the machine picker inside BrowserTile's own
    // toolbar, sitting right on top of the surface it needs to appear above.
    useNativeOverlayBlocker(open)
  ```

  with:

  ```ts
    const [open, setOpen] = useState(false)
    // A Browser tile's native webview always stacks above this popup (see
    // useNativeOverlayBlocker's doc comment) — most visibly for this
    // component, since it's the machine picker inside BrowserTile's own
    // toolbar, sitting right on top of the surface it needs to appear above.
    // Scoped to this popup's own rect (not 'viewport'): opening the machine
    // picker in one Browser tile must not blank every other open tile.
    const popupRef = useRef<HTMLDivElement>(null)
    useNativeOverlayBlocker(open, popupRef)
  ```

  and add `ref={popupRef}` to `<BaseSelect.Popup>` (around line 69).

- [ ] **Step 3: `combobox.tsx` — the plain-`<div>` results dropdown**

  Change the import line:

  ```ts
  import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
  ```

  (already imports `useRef` — no change needed here.)

  Replace (around line 21-24):

  ```ts
    const [open, setOpen] = useState(false)
    const [highlighted, setHighlighted] = useState(-1)
    const rootRef = useRef<HTMLDivElement>(null)
    useNativeOverlayBlocker(open)
  ```

  with:

  ```ts
    const [open, setOpen] = useState(false)
    const [highlighted, setHighlighted] = useState(-1)
    const rootRef = useRef<HTMLDivElement>(null)
    const popupRef = useRef<HTMLDivElement>(null)
    useNativeOverlayBlocker(open, popupRef)
  ```

  and add `ref={popupRef}` to the results `<div>` (around line 85-89):

  ```tsx
        {open && matches.length > 0 ? (
          <div
            ref={popupRef}
            className={cn(
  ```

  (When `open` is true but `matches.length === 0`, this div doesn't render and `popupRef.current` stays null — the hook then falls back to `'viewport'` for that instant, an acceptable, safe default for a rare empty-results edge case.)

- [ ] **Step 4: `tab-strip-popover-menu.tsx`**

  Change the import line:

  ```ts
  import { useState, type ReactNode } from 'react'
  ```

  to:

  ```ts
  import { useRef, useState, type ReactNode } from 'react'
  ```

  Replace (around line 27-28):

  ```ts
    const [open, setOpen] = useState(false)
    useNativeOverlayBlocker(open)
  ```

  with:

  ```ts
    const [open, setOpen] = useState(false)
    const popupRef = useRef<HTMLDivElement>(null)
    useNativeOverlayBlocker(open, popupRef)
  ```

  and add `ref={popupRef}` to `<Popover.Popup>` (around line 37).

- [ ] **Step 5: `ContentSearchPanel.tsx` — its own bounded panel, not the full-viewport click-away backdrop**

  Replace (around line 100):

  ```ts
    useNativeOverlayBlocker(open)
  ```

  with:

  ```ts
    const panelRef = useRef<HTMLDivElement>(null)
    useNativeOverlayBlocker(open, panelRef)
  ```

  (`useRef` is already imported at the top of this file.) Add `ref={panelRef}` to the bounded inner panel `<div>` — **not** the outer `fixed inset-0` click-away backdrop — around line 220-225:

  ```tsx
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Search in files"
  ```

  `FileQuickOpen.tsx` has the near-identical structure but deliberately **stays unmigrated** (design spec §5.3's table) — it is treated as a large centered quick-open dialog, conceptually app-wide; do not touch it in this task.

- [ ] **Step 6: Verify**

  Run: `npm --prefix frontend run typecheck`. Expect the same single pre-existing error (`BrowserTile.tsx`).
  Manual check (can be deferred to Slice 3's own manual pass, since visible chrome hasn't changed yet): open the app, hover a tooltip on a button far away from any open Browser tile — no other verification is meaningfully different yet since no Browser tile currently reads the new rect-aware blockers until Slice 3's occlusion-effect rewrite (Task 5 below only fixes the compile error with a temporary always-`'viewport'`-equivalent check).

---

## Task 5: `WorkspaceTileCanvas.tsx` — drag-ghost rect + divider leak-proofing

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx:187-266` (`TileSplitView`), `:741-746` (drag-ghost hook call), `:876-898` (`DragOverlay` content)

**Interfaces:**
- Consumes: `useNativeOverlayBlocker(active, rectRef)` from Task 3.
- `tileDragActive`/`setTileDragActive` on the store are **unchanged** by this task (still the zero-latency, geometry-free immediate-hide signal `tileShouldBeHidden` short-circuits on — see Task 2's doc comment). This task adds a second, independent, rect-scoped safety net on top, per the design spec §5.5 point 1.

- [ ] **Step 1: Scope the drag-ghost blocker to the ghost's own rect**

  In `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`, replace (around line 741-746):

  ```ts
    const [dragTab, setDragTab] = useState<TileTab | null>(null)
    // A dragged tab's ghost preview (DragOverlay below) is a DOM portal, and a
    // native Browser-tile webview always paints above the DOM — without this,
    // dragging any tab (including a Browser tab itself) renders its ghost
    // underneath an open Browser tile instead of following the pointer over it.
    useNativeOverlayBlocker(dragTab !== null)
  ```

  with:

  ```ts
    const [dragTab, setDragTab] = useState<TileTab | null>(null)
    const dragGhostRef = useRef<HTMLDivElement>(null)
    // A dragged tab's ghost preview (DragOverlay below) is a DOM portal, and a
    // native Browser-tile webview always paints above the DOM — without this,
    // dragging any tab (including a Browser tab itself) renders its ghost
    // underneath an open Browser tile instead of following the pointer over
    // it. Scoped to the ghost element's own rect (it already tracks a real
    // on-screen rect following the pointer) rather than 'viewport', so
    // dragging a tab far from an open Browser tile doesn't blank it.
    useNativeOverlayBlocker(dragTab !== null, dragGhostRef)
  ```

  Add `ref={dragGhostRef}` to the ghost's own `<div>` inside `<DragOverlay>` (around line 878):

  ```tsx
        {dragTab ? (
          <div
            ref={dragGhostRef}
            className="flex h-8 max-w-[240px] items-center gap-1.5 rounded-[9px] border border-devdeck-border-strong bg-devdeck-elevated px-3 font-mono text-[11px] text-devdeck-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_12px_30px_rgba(0,0,0,0.52)]"
          >
  ```

- [ ] **Step 2: Add a second, structurally leak-proof blocker to the divider drag, on top of the existing `tileDragActive` flag**

  Replace the whole `TileSplitView` function (around line 187-266):

  ```tsx
  function TileSplitView({ node, ctx }: { node: TileSplit; ctx: TileRenderContext }) {
    const containerRef = useRef<HTMLDivElement>(null)
    const dragRef = useRef<{ index: number; startSizes: number[]; startPos: number; containerSize: number } | null>(
      null,
    )
    const [liveSizes, setLiveSizes] = useState<number[] | null>(null)
    const [dragging, setDragging] = useState(false)
    const setTileDragActive = useDevDeckStore((s) => s.setTileDragActive)
    // A second, independent signal alongside `tileDragActive` (still the
    // zero-latency, whole-app-immediate hide `tileShouldBeHidden` short-
    // circuits on): scoped to this split's own container rect, so only the
    // panes actually being resized report a blocker, and — because it goes
    // through the same push/pop-on-effect-cleanup path every other
    // `useNativeOverlayBlocker` caller gets for free — its entry can never
    // outlive this component the way a raw pointer-handler-set boolean can
    // (see the design spec §5.5's leak-proofing point 1).
    useNativeOverlayBlocker(dragging, containerRef)

    const isRow = node.direction === 'row'
    const sizes = liveSizes ?? node.sizes

    function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
      const drag = dragRef.current
      if (!drag || drag.containerSize <= 0) return
      const pos = isRow ? event.clientX : event.clientY
      const deltaFrac = (pos - drag.startPos) / drag.containerSize
      const a = drag.startSizes[drag.index]
      const b = drag.startSizes[drag.index + 1]
      const clampedDelta = Math.min(Math.max(deltaFrac, MIN_PANE_SIZE - a), b - MIN_PANE_SIZE)
      const next = [...drag.startSizes]
      next[drag.index] = a + clampedDelta
      next[drag.index + 1] = b - clampedDelta
      setLiveSizes(next)
    }

    function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
      if (!dragRef.current) return
      dragRef.current = null
      setTileDragActive(false)
      setDragging(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      setLiveSizes((current) => {
        if (current) ctx.onResizeSplit(node.id, current)
        return null
      })
    }

    return (
      <div ref={containerRef} className={cn('flex min-h-0 min-w-0 flex-1', isRow ? 'flex-row' : 'flex-col')}>
        {node.children.map((child, i) => (
          <Fragment key={child.id}>
            {i > 0 ? (
              <div
                role="separator"
                aria-orientation={isRow ? 'vertical' : 'horizontal'}
                className={cn(
                  'flex-none touch-none bg-devdeck-border transition-colors hover:bg-devdeck-accent active:bg-devdeck-accent',
                  isRow ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
                )}
                onPointerDown={(event) => {
                  const container = containerRef.current
                  if (!container) return
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  setTileDragActive(true)
                  setDragging(true)
                  const rect = container.getBoundingClientRect()
                  dragRef.current = {
                    index: i - 1,
                    startSizes: node.sizes,
                    startPos: isRow ? event.clientX : event.clientY,
                    containerSize: isRow ? rect.width : rect.height,
                  }
                }}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onLostPointerCapture={handlePointerUp}
              />
            ) : null}
            <div
              className="flex min-h-0 min-w-0 overflow-hidden"
              style={{ flexGrow: sizes[i] ?? 1, flexBasis: 0, flexShrink: 1 }}
            >
              <TileNodeView node={child} ctx={ctx} />
            </div>
          </Fragment>
        ))}
      </div>
    )
  }
  ```

  The only functional additions over the already-landed version: `dragging` state + `useNativeOverlayBlocker(dragging, containerRef)`, `setDragging(true)`/`setDragging(false)` alongside the existing `setTileDragActive` calls, and `onLostPointerCapture={handlePointerUp}` — `lostpointercapture` is a standards-guaranteed event that fires whenever pointer capture ends for **any** reason (explicit release, cancellation, or the OS stealing the gesture), closing the one gap `onPointerCancel` alone doesn't reliably cover.

- [ ] **Step 3: Verify**

  Run: `npm --prefix frontend run typecheck`. Expect the same single pre-existing error (`BrowserTile.tsx`, fixed next in Task 6).
  Manual check: drag a workspace tab across a split containing an open Browser tile — the ghost still renders above it. Drag a pane divider quickly back and forth in a split containing a Browser tile — it still hides smoothly during the drag and reappears once you release.

---

## Task 6: `BrowserTile.tsx` — minimal compile-compat shim for the new `Record` shape

**Files:**
- Modify: `frontend/src/features/browser/BrowserTile.tsx:228` only

This is deliberately the *only* change Slice 1 makes to `BrowserTile.tsx`. The real occlusion-aware rewrite of this effect (using `tileShouldBeHidden` + a debounced show, per the design spec §5.4/§5.6) is Slice 3's job, once the new chrome exists to wire it into. This step exists purely so Slice 1 ends with a green typecheck on its own.

**Interfaces:** none new — behavior is unchanged (still hides for *any* open blocker anywhere, exactly like today's `> 0` check on the old counter).

- [ ] **Step 1: Fix the one broken comparison**

  Replace (line 228):

  ```ts
      if (nativeOverlayBlockers > 0 || tileDragActive) {
  ```

  with:

  ```ts
      // TODO(chrome-replication Slice 3): replace with `tileShouldBeHidden`
      // (rect-aware) — this still reproduces today's exact "hide for any
      // open blocker anywhere" behavior against the new Record shape.
      if (Object.keys(nativeOverlayBlockers).length > 0 || tileDragActive) {
  ```

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck` — expect **zero** errors now.
  Manual check: open a Browser tile, hover any tooltip anywhere in the app — the tile still blinks out exactly as it does today (Slice 3 is what stops the far-away-tooltip case from doing this).

---

## Task 7: Rust — `on_page_load` Started/Finished fix + `browser_tile_set_zoom`

**Files:**
- Modify: `frontend/src-tauri/src/lib.rs:12-14` (import), `:73-86` (`on_page_load` closure), `:87-94` (`generate_handler!`)
- Modify: `frontend/src-tauri/src/browser_tiles.rs:132-138` (insert after `browser_tile_reload`)
- Modify: `frontend/src-tauri/permissions/browser-tiles.toml`

**Interfaces:**
- Produces: `browser_tile_set_zoom(tab_id: String, doc_id: String, scale: f64) -> Result<(), String>`; the `browser-tile-page-load` event payload gains a `loading: bool` field.

- [ ] **Step 1: Fix the Started/Finished conflation in `on_page_load`**

  In `frontend/src-tauri/src/lib.rs`, add an import alongside the existing `use tauri::{...}` line (around line 14):

  ```rust
  use tauri::webview::PageLoadEvent;
  ```

  Replace the `.on_page_load(...)` closure (around line 73-86):

  ```rust
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
  ```

  with:

  ```rust
          .on_page_load(|webview, payload| {
              // Global hook (fires for every webview in the app, including
              // the main UI) filtered to just the Browser tab's own child
              // webviews, so the React address bar can react to in-page
              // navigation (the user clicking a link inside the native
              // webview) instead of only explicit typed-URL navigation.
              if !webview.label().starts_with("browser-") {
                  return;
              }
              // Previously fired this same event for both Started and
              // Finished, so `loading` flipped back to false almost
              // immediately after every navigation — the toolbar's
              // Reload<->Stop icon swap (chrome-replication design spec
              // §3.3) depends on this actually distinguishing the two.
              let loading = matches!(payload.event(), PageLoadEvent::Started);
              let _ = webview.emit(
                  "browser-tile-page-load",
                  serde_json::json!({
                      "label": webview.label(),
                      "url": payload.url().to_string(),
                      "loading": loading,
                  }),
              );
          })
  ```

- [ ] **Step 2: Add `browser_tile_set_zoom`**

  In `frontend/src-tauri/src/browser_tiles.rs`, insert immediately after `browser_tile_reload` (around line 138, before `browser_tile_set_bounds`):

  ```rust
  /// Thin wrapper over `Webview::set_zoom` (available on macOS 11+ / iOS 14+;
  /// no-op-returning-error on Android). No getter exists on the Tauri side, so
  /// the frontend owns the current zoom level as source of truth — see
  /// `browserZoom.ts`.
  #[tauri::command]
  pub fn browser_tile_set_zoom(
      state: tauri::State<'_, BrowserTiles>,
      tab_id: String,
      doc_id: String,
      scale: f64,
  ) -> Result<(), String> {
      let label = webview_label(&tab_id, &doc_id);
      let map = state.0.lock().unwrap();
      let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
      webview.set_zoom(scale).map_err(|e| e.to_string())
  }
  ```

- [ ] **Step 3: Register the new command**

  In `frontend/src-tauri/src/lib.rs`, add to `tauri::generate_handler![...]` (around line 87-94), immediately after `browser_tiles::browser_tile_close,`:

  ```rust
              browser_tiles::browser_tile_set_zoom,
  ```

- [ ] **Step 4: Grant the permission**

  In `frontend/src-tauri/permissions/browser-tiles.toml`, add to `commands.allow`:

  ```toml
      "browser_tile_set_zoom",
  ```

- [ ] **Step 5: Verify**

  Run: `cd frontend/src-tauri && cargo check` (or, if a full Tauri dev build is easier in this environment, `npm --prefix frontend run tauri:dev` per `COMMANDS.md` and confirm it starts). Expect no compile errors. This step has no frontend-visible effect yet — nothing calls `browser_tile_set_zoom` or reads the new `loading` field until Slice 3.

---

## Task 8: Rust — find-in-page JS-eval MVP

**Files:**
- Modify: `frontend/src-tauri/src/browser_tiles.rs:8-9` (imports), append near end of file (after `browser_tile_close`)
- Modify: `frontend/src-tauri/src/lib.rs:87-94` (`generate_handler!`)
- Modify: `frontend/src-tauri/permissions/browser-tiles.toml`

Per the design spec §6.1.4/§6.2: no native `WKWebView.findString` this round (a new `objc2-web-kit` feature-flag surface the design explicitly defers) — this is the "cheap zero-Rust-dependency MVP": a small injected `TreeWalker`/`Range` highlighter, re-run in full on every call rather than mirroring match state in Rust.

**Interfaces:**
- Produces: `browser_tile_find(tab_id: String, doc_id: String, query: String, direction: String) -> Result<FindResult, String>` where `FindResult { active: u32, total: u32 }`; `browser_tile_find_clear(tab_id: String, doc_id: String) -> Result<(), String>`.

- [ ] **Step 1: Add the new imports**

  In `frontend/src-tauri/src/browser_tiles.rs`, replace (line 8-9):

  ```rust
  use std::collections::HashMap;
  use std::sync::Mutex;
  ```

  with:

  ```rust
  use std::collections::HashMap;
  use std::sync::{mpsc, Mutex};
  use std::time::Duration;
  ```

- [ ] **Step 2: Append the find-in-page commands**

  Append at the end of `frontend/src-tauri/src/browser_tiles.rs` (after `browser_tile_close`):

  ```rust
  #[derive(serde::Serialize, serde::Deserialize)]
  pub struct FindResult {
      pub active: u32,
      pub total: u32,
  }

  /// `__QUERY__`/`__STEP__` are substituted via plain string replacement
  /// rather than `format!`'s `{}` — the script itself is full of literal JS
  /// braces, and escaping every one of them for `format!` is far more
  /// error-prone than two `.replace()` calls on placeholder tokens that can't
  /// otherwise appear in the script.
  const FIND_JS_TEMPLATE: &str = r#"(function() {
      var q = __QUERY__;
      var step = __STEP__;
      document.querySelectorAll('mark[data-devdeck-find]').forEach(function(mark) {
          var parent = mark.parentNode;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          parent.removeChild(mark);
          parent.normalize();
      });
      if (!q) { window.__devdeckFindIndex = 0; return { active: 0, total: 0 }; }
      var needle = q.toLowerCase();
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: function(node) {
              var tag = node.parentNode && node.parentNode.nodeName;
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
              return node.nodeValue.toLowerCase().indexOf(needle) === -1 ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
          }
      });
      var matches = [];
      var node;
      while ((node = walker.nextNode())) {
          var lower = node.nodeValue.toLowerCase();
          var from = 0, at;
          while ((at = lower.indexOf(needle, from)) !== -1) {
              matches.push({ node: node, start: at, end: at + needle.length });
              from = at + needle.length;
          }
      }
      var total = matches.length;
      if (total === 0) { window.__devdeckFindIndex = 0; return { active: 0, total: 0 }; }
      var current = (typeof window.__devdeckFindIndex === 'number' ? window.__devdeckFindIndex : -step);
      current = ((current + step) % total + total) % total;
      window.__devdeckFindIndex = current;
      matches.forEach(function(m, i) {
          var range = document.createRange();
          range.setStart(m.node, m.start);
          range.setEnd(m.node, m.end);
          var mark = document.createElement('mark');
          mark.setAttribute('data-devdeck-find', i === current ? 'active' : 'match');
          mark.style.background = i === current ? '#ff9632' : '#ffeb3b';
          mark.style.color = '#000';
          try { range.surroundContents(mark); } catch (e) {}
          if (i === current) mark.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
      return { active: current + 1, total: total };
  })()"#;

  const FIND_CLEAR_JS: &str = r#"(function() {
      document.querySelectorAll('mark[data-devdeck-find]').forEach(function(mark) {
          var parent = mark.parentNode;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          parent.removeChild(mark);
          parent.normalize();
      });
      window.__devdeckFindIndex = 0;
  })()"#;

  /// Holds the `BrowserTiles` lock for the whole call body (unlike
  /// `browser_tile_open`'s release-then-reacquire pattern, which is
  /// TOCTOU-prone) — deliberate per report D's guidance in the
  /// chrome-replication design spec §6.1.4, and safe here because
  /// `eval_with_callback`'s callback fires on the webview's own event loop,
  /// not this command's calling thread, so blocking on `rx.recv_timeout`
  /// doesn't deadlock it.
  #[tauri::command]
  pub fn browser_tile_find(
      state: tauri::State<'_, BrowserTiles>,
      tab_id: String,
      doc_id: String,
      query: String,
      direction: String,
  ) -> Result<FindResult, String> {
      let label = webview_label(&tab_id, &doc_id);
      let map = state.0.lock().unwrap();
      let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;

      let query_json = serde_json::to_string(&query).map_err(|e| e.to_string())?;
      let step = if direction == "prev" { "-1" } else { "1" };
      let js = FIND_JS_TEMPLATE.replace("__QUERY__", &query_json).replace("__STEP__", step);

      let (tx, rx) = mpsc::channel::<String>();
      webview
          .eval_with_callback(js, move |result| {
              let _ = tx.send(result);
          })
          .map_err(|e| e.to_string())?;
      let raw = rx
          .recv_timeout(Duration::from_secs(5))
          .map_err(|_| "find-in-page eval timed out".to_string())?;
      serde_json::from_str::<FindResult>(&raw).map_err(|e| format!("could not parse find result: {e}"))
  }

  #[tauri::command]
  pub fn browser_tile_find_clear(state: tauri::State<'_, BrowserTiles>, tab_id: String, doc_id: String) -> Result<(), String> {
      let label = webview_label(&tab_id, &doc_id);
      let map = state.0.lock().unwrap();
      let webview = map.get(&label).ok_or_else(|| format!("no browser tile webview for {label}"))?;
      webview.eval(FIND_CLEAR_JS).map_err(|e| e.to_string())
  }
  ```

- [ ] **Step 3: Register the two new commands**

  In `frontend/src-tauri/src/lib.rs`'s `generate_handler!` list, add after `browser_tiles::browser_tile_set_zoom,`:

  ```rust
              browser_tiles::browser_tile_find,
              browser_tiles::browser_tile_find_clear,
  ```

- [ ] **Step 4: Grant the permissions**

  In `frontend/src-tauri/permissions/browser-tiles.toml`, add to `commands.allow`:

  ```toml
      "browser_tile_find",
      "browser_tile_find_clear",
  ```

- [ ] **Step 5: Verify**

  Run: `cd frontend/src-tauri && cargo check`. Expect no compile errors. No frontend-visible effect yet — nothing calls these commands until Slice 3's Find Bar wiring.

---

## Task 9: `browserTilesBridge.ts` additions

**Files:**
- Modify: `frontend/src/features/browser/browserTilesBridge.ts`

**Interfaces:**
- Produces: `setZoomBrowserTile(tabId, docId, scale): Promise<void>`, `findInBrowserTile(tabId, docId, query, direction): Promise<BrowserTileFindResult>`, `clearBrowserTileFind(tabId, docId): Promise<void>`.
- Changes: `onBrowserTilePageLoad`'s callback now also receives `loading: boolean`.

- [ ] **Step 1: Add the zoom wrapper**

  Insert after `reloadBrowserTile` (after its closing brace):

  ```ts
  export function setZoomBrowserTile(tabId: string, docId: string, scale: number): Promise<void> {
    return invoke('browser_tile_set_zoom', { tabId, docId, scale })
  }
  ```

- [ ] **Step 2: Add the find-in-page wrappers**

  Insert after `closeBrowserTile`:

  ```ts
  export interface BrowserTileFindResult {
    active: number
    total: number
  }

  export function findInBrowserTile(
    tabId: string,
    docId: string,
    query: string,
    direction: 'next' | 'prev',
  ): Promise<BrowserTileFindResult> {
    return invoke('browser_tile_find', { tabId, docId, query, direction })
  }

  export function clearBrowserTileFind(tabId: string, docId: string): Promise<void> {
    return invoke('browser_tile_find_clear', { tabId, docId })
  }
  ```

- [ ] **Step 3: Carry `loading` through `onBrowserTilePageLoad`**

  Replace:

  ```ts
  export function onBrowserTilePageLoad(
    callback: (info: { tabId: string; docId: string; url: string }) => void,
  ): Promise<() => void> {
    return listen<{ label: string; url: string }>('browser-tile-page-load', (event) => {
      const ids = labelRegistry.get(event.payload.label)
      if (ids) callback({ ...ids, url: event.payload.url })
    })
  }
  ```

  with:

  ```ts
  export function onBrowserTilePageLoad(
    callback: (info: { tabId: string; docId: string; url: string; loading: boolean }) => void,
  ): Promise<() => void> {
    return listen<{ label: string; url: string; loading: boolean }>('browser-tile-page-load', (event) => {
      const ids = labelRegistry.get(event.payload.label)
      if (ids) callback({ ...ids, url: event.payload.url, loading: event.payload.loading })
    })
  }
  ```

  (`BrowserTile.tsx`'s current listener destructures only `{ tabId, docId, url }` from the callback param, so this additive field doesn't break its compile — it's simply unused until Slice 3 reads it.)

- [ ] **Step 4: Verify**

  Run: `npm --prefix frontend run typecheck` — expect zero errors.

---

## Task 10: Slice 1 final verification + commit

- [ ] **Step 1: Full verification**

  Run, from the repo root:
  - `npm --prefix frontend run typecheck` — zero errors.
  - `npx tsx src/features/browser/browserTileOcclusion.test.ts` (from `frontend/`) — `8 tests passed`.
  - `cd frontend/src-tauri && cargo check` — no errors.
  - Manual: launch the desktop app (`make dev-tauri` or per `COMMANDS.md`), open a Browser tile, confirm it still opens/navigates/hides-during-overlay exactly as before this slice.

- [ ] **Step 2: Commit**

  ```bash
  git add frontend/src/store/types.ts frontend/src/store/useDevDeckStore.ts \
    frontend/src/features/browser/useNativeOverlayBlocker.ts \
    frontend/src/features/browser/browserTileOcclusion.ts frontend/src/features/browser/browserTileOcclusion.test.ts \
    frontend/src/features/browser/browserTilesBridge.ts \
    frontend/src/features/browser/BrowserTile.tsx \
    frontend/src/components/ui/tooltip.tsx frontend/src/components/ui/select.tsx \
    frontend/src/components/ui/combobox.tsx frontend/src/components/ui/tab-strip-popover-menu.tsx \
    frontend/src/features/terminal/ContentSearchPanel.tsx \
    frontend/src/features/tabs/WorkspaceTileCanvas.tsx \
    frontend/src-tauri/src/lib.rs frontend/src-tauri/src/browser_tiles.rs \
    frontend/src-tauri/permissions/browser-tiles.toml
  git commit -m "feat(browser): rect-scoped occlusion blockers + find/zoom Rust commands"
  ```

---

# Slice 2 — Chrome components (new files only)

Every file in this slice is brand new. None of them import from or are imported by `frontend/src/features/browser/BrowserTile.tsx` — they take plain props/callbacks and compile in total isolation. Wiring them into `BrowserTile.tsx` is entirely Slice 3's job.

## Task 1: `browserTabWidth.ts` — the pure tab-pill width function

**Files:**
- Create: `frontend/src/features/browser/browserTabWidth.ts`
- Test: `frontend/src/features/browser/browserTabWidth.test.ts`

**Interfaces:**
- Produces: `TabWidthInput { labelLength: number; hasFavicon: boolean; isActive: boolean }`, `tabPillTargetWidth(input: TabWidthInput): number`.

- [ ] **Step 1: Write the failing test**

  Create `frontend/src/features/browser/browserTabWidth.test.ts`:

  ```ts
  import { tabPillTargetWidth } from './browserTabWidth'

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

  check('a short inactive label without a favicon hits MIN_WIDTH', () => {
    assertEqual(tabPillTargetWidth({ labelLength: 2, hasFavicon: false, isActive: false }), 72, 'clamped to MIN_WIDTH')
  })

  check('label length beyond 28 chars is clamped before the width math', () => {
    const at28 = tabPillTargetWidth({ labelLength: 28, hasFavicon: false, isActive: false })
    const at200 = tabPillTargetWidth({ labelLength: 200, hasFavicon: false, isActive: false })
    assertEqual(at200, at28, '28-char clamp')
  })

  check('a favicon adds its reserved width', () => {
    const without = tabPillTargetWidth({ labelLength: 12, hasFavicon: false, isActive: false })
    const with_ = tabPillTargetWidth({ labelLength: 12, hasFavicon: true, isActive: false })
    assertEqual(with_ - without, 22, 'FAVICON_W (16) + FAVICON_GAP (6)')
  })

  check('an active pill reserves extra close-slot width over an inactive one', () => {
    const inactive = tabPillTargetWidth({ labelLength: 12, hasFavicon: false, isActive: false })
    const active = tabPillTargetWidth({ labelLength: 12, hasFavicon: false, isActive: true })
    assertEqual(active - inactive, 26, 'CLOSE_W (20) + 6 extra reserved for the active pill')
  })

  check('width is clamped at MAX_WIDTH for a very long active label with a favicon', () => {
    assertEqual(tabPillTargetWidth({ labelLength: 28, hasFavicon: true, isActive: true }), 220, 'clamped to MAX_WIDTH')
  })

  console.log(`\n${passed} tests passed`)
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `frontend/`): `npx tsx src/features/browser/browserTabWidth.test.ts`
  Expected: FAIL — `Cannot find module './browserTabWidth'`.

- [ ] **Step 3: Write the implementation**

  Create `frontend/src/features/browser/browserTabWidth.ts`:

  ```ts
  export interface TabWidthInput {
    /** Display label's character count (post-clamp inputs beyond 28 chars
     *  don't change the result any further). */
    labelLength: number
    hasFavicon: boolean
    isActive: boolean
  }

  const CHAR_W = 6 // estimated px/char at text-[11px] — a calibrated estimate
                    // against DevDeck's proportional UI font, not an exact
                    // per-glyph size (see the chrome-replication design spec
                    // §4.2 and its §8 risk note on expected width jitter).
  const CLOSE_W = 20
  const CLOSE_GAP = 6
  const FAVICON_W = 16
  const FAVICON_GAP = 6
  const BASE_PAD = 24 // px-3 both sides
  const MIN_WIDTH = 72
  const MAX_WIDTH = 220

  /** Target width for one tab-strip pill, animated via CSS `transition-[width]`
   *  rather than a JS interpolation loop (design spec §4.1) — this function
   *  only computes the *target*, the compositor owns the animation. Ported
   *  from terminal-browser's `target()` with DevDeck's own metrics
   *  substituted; `MIN_WIDTH`/`MAX_WIDTH` clamping is a DevDeck-specific
   *  addition the reference didn't need. */
  export function tabPillTargetWidth(input: TabWidthInput): number {
    let width = BASE_PAD + Math.min(input.labelLength, 28) * CHAR_W
    if (input.hasFavicon) width += FAVICON_W + FAVICON_GAP
    if (input.isActive) width += CLOSE_W + 6 // extra reserved space, active only
    width += CLOSE_W + CLOSE_GAP // unconditional close-slot reservation
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run (from `frontend/`): `npx tsx src/features/browser/browserTabWidth.test.ts`
  Expected: all 5 `ok - ...` lines print, then `5 tests passed`.

---

## Task 2: `displayUrl.ts` — active-tab pill label helper

**Files:**
- Create: `frontend/src/features/browser/displayUrl.ts`
- Test: `frontend/src/features/browser/displayUrl.test.ts`

**Interfaces:**
- Produces: `displayUrl(url: string): string`.

- [ ] **Step 1: Write the failing test**

  Create `frontend/src/features/browser/displayUrl.test.ts`:

  ```ts
  import { displayUrl } from './displayUrl'

  let passed = 0
  function check(name: string, fn: () => void) {
    fn()
    passed += 1
    console.log(`ok - ${name}`)
  }
  function assertEqual(actual: string, expected: string, message: string) {
    if (actual !== expected) {
      throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
    }
  }

  check('strips scheme and a bare trailing slash', () => {
    assertEqual(displayUrl('https://example.com/'), 'example.com', 'bare trailing slash root')
  })

  check('keeps a non-root path without a trailing slash', () => {
    assertEqual(displayUrl('https://example.com/dashboard/'), 'example.com/dashboard', 'trailing slash stripped from a path')
  })

  check('keeps the query string', () => {
    assertEqual(displayUrl('https://example.com/search?q=x'), 'example.com/search?q=x', 'query preserved')
  })

  check('an empty url reads as New Tab', () => {
    assertEqual(displayUrl(''), 'New Tab', 'empty url')
  })

  check('an unparseable string is returned as-is', () => {
    assertEqual(displayUrl('not a url'), 'not a url', 'unparseable input unchanged')
  })

  console.log(`\n${passed} tests passed`)
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `frontend/`): `npx tsx src/features/browser/displayUrl.test.ts`
  Expected: FAIL — `Cannot find module './displayUrl'`.

- [ ] **Step 3: Write the implementation**

  Create `frontend/src/features/browser/displayUrl.ts`:

  ```ts
  /** The active tab pill's label (design spec §3.3): scheme and a single bare
   *  trailing slash stripped — e.g. `https://example.com/dashboard/` becomes
   *  `example.com/dashboard`, but `https://example.com/` (nothing but the
   *  root slash) becomes just `example.com`. Falls back to the raw string for
   *  anything that doesn't parse as a URL (a blank `New Tab`, or a value
   *  still mid-typing in the URL card). */
  export function displayUrl(url: string): string {
    if (!url) return 'New Tab'
    try {
      const parsed = new URL(url)
      const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
      return `${parsed.hostname}${path}${parsed.search}`
    } catch {
      return url
    }
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run (from `frontend/`): `npx tsx src/features/browser/displayUrl.test.ts`
  Expected: all 5 `ok - ...` lines print, then `5 tests passed`.

---

## Task 3: `browserZoom.ts` — pure zoom step/clamp helper

**Files:**
- Create: `frontend/src/features/browser/browserZoom.ts`
- Test: `frontend/src/features/browser/browserZoom.test.ts`

**Interfaces:**
- Produces: `ZOOM_LEVELS: number[]`, `DEFAULT_ZOOM: number`, `zoomStep(current: number, direction: 1 | -1): number`.

- [ ] **Step 1: Write the failing test**

  Create `frontend/src/features/browser/browserZoom.test.ts`:

  ```ts
  import { DEFAULT_ZOOM, zoomStep, ZOOM_LEVELS } from './browserZoom'

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

  check('zooming in from the default level moves to the next level up', () => {
    assertEqual(zoomStep(DEFAULT_ZOOM, 1), 1.1, 'one step up from 100%')
  })

  check('zooming out from the default level moves to the next level down', () => {
    assertEqual(zoomStep(DEFAULT_ZOOM, -1), 0.9, 'one step down from 100%')
  })

  check('zooming in clamps at the top of ZOOM_LEVELS', () => {
    assertEqual(zoomStep(ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 1), ZOOM_LEVELS[ZOOM_LEVELS.length - 1], 'clamped at max')
  })

  check('zooming out clamps at the bottom of ZOOM_LEVELS', () => {
    assertEqual(zoomStep(ZOOM_LEVELS[0], -1), ZOOM_LEVELS[0], 'clamped at min')
  })

  check('stepping from a level not exactly on the table snaps to the nearest one first', () => {
    assertEqual(zoomStep(1.05, 1), 1.25, 'nearest-then-step from an off-table value')
  })

  console.log(`\n${passed} tests passed`)
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `frontend/`): `npx tsx src/features/browser/browserZoom.test.ts`
  Expected: FAIL — `Cannot find module './browserZoom'`.

- [ ] **Step 3: Write the implementation**

  Create `frontend/src/features/browser/browserZoom.ts`:

  ```ts
  /** Fixed zoom steps (50%-300%), matching the design spec §3.6's "clamp
   *  50-300% in fixed steps" — the frontend owns this as source of truth
   *  since `browser_tile_set_zoom` has no matching getter on the Tauri side. */
  export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  export const DEFAULT_ZOOM = 1

  function nearestIndex(current: number): number {
    let best = 0
    let bestDiff = Infinity
    ZOOM_LEVELS.forEach((level, i) => {
      const diff = Math.abs(level - current)
      if (diff < bestDiff) {
        best = i
        bestDiff = diff
      }
    })
    return best
  }

  /** One step up (`1`) or down (`-1`) `ZOOM_LEVELS` from whichever entry is
   *  nearest `current` — snaps an off-table value (e.g. a stale/rounded
   *  number) onto the table before stepping, and clamps at either end
   *  instead of wrapping. */
  export function zoomStep(current: number, direction: 1 | -1): number {
    const next = nearestIndex(current) + direction
    return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, next))]
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run (from `frontend/`): `npx tsx src/features/browser/browserZoom.test.ts`
  Expected: all 5 `ok - ...` lines print, then `5 tests passed`.

---

## Task 4: `BrowserFaviconChip.tsx` — shared favicon-chip fallback

**Files:**
- Create: `frontend/src/features/browser/BrowserFaviconChip.tsx`

Generalized from the `BookmarkIcon`/`chipColorFor`/`CHIP_COLORS` trio currently inline in `BrowserTile.tsx:68-95` — this new file is what both the bookmarks-home grid and the tab strip's favicon slot import going forward (Slice 3 deletes the inline originals and repoints both usages here).

**Interfaces:**
- Produces: `BrowserFaviconChip({ seed, title, iconDataUrl, size, className }): JSX.Element`.

- [ ] **Step 1: Create the file**

  ```tsx
  import { cn } from '@/lib/utils'

  const CHIP_COLORS = [
    'bg-devdeck-accent-tint text-devdeck-accent-soft',
    'bg-devdeck-green-tint text-devdeck-green-soft',
    'bg-devdeck-yellow/20 text-devdeck-yellow',
    'bg-devdeck-red-tint text-devdeck-red-soft',
  ]

  function chipColorFor(seed: string): string {
    let hash = 0
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
    return CHIP_COLORS[hash % CHIP_COLORS.length]
  }

  export interface BrowserFaviconChipProps {
    /** Stable id the chip's color is derived from (a bookmark id or an
     *  internal doc id) — deliberately not the title, so two pages sharing a
     *  title still get visually distinct chips. */
    seed: string
    title: string
    iconDataUrl?: string | null
    size?: number
    className?: string
  }

  /** First-letter chip fallback for a real favicon (deferred — see the
   *  chrome-replication design spec §2). Shared by the bookmarks-home grid
   *  and the tab strip's favicon slot so both pick up real favicons
   *  identically once that lands, without a layout change — the slot's
   *  dimensions are reserved today. */
  export function BrowserFaviconChip({ seed, title, iconDataUrl, size = 20, className }: BrowserFaviconChipProps) {
    if (iconDataUrl) {
      return (
        <img
          src={iconDataUrl}
          alt=""
          style={{ height: size, width: size }}
          className={cn('flex-none rounded-[3px]', className)}
        />
      )
    }
    return (
      <div
        style={{ height: size, width: size }}
        className={cn(
          'flex flex-none items-center justify-center rounded-[3px] text-[10px] font-semibold',
          chipColorFor(seed),
          className,
        )}
      >
        {(title.trim()[0] ?? '?').toUpperCase()}
      </div>
    )
  }
  ```

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck` — expect zero errors (this file has no dependents yet).

---

## Task 5: `BrowserToolbar.tsx` — the fixed single-row toolbar shell

**Files:**
- Create: `frontend/src/features/browser/BrowserToolbar.tsx`

Per the design spec §3.3: `h-9`, never wraps, back/forward render only as a pair and only if there's history in that direction, reload↔stop swaps on `loading`, and the right-hand DevDeck cluster (Home, Find, Machine picker, Bookmark, Fullscreen) collapses behind a "…" `TabStripPopoverMenu` below `@sm/tile` (design spec §3.8). The tab strip itself is a separate component, passed in as `children` and rendered in the middle `flex-1` slot.

**Interfaces:**
- Produces: `BrowserToolbar(props): JSX.Element` — see `BrowserToolbarProps` below.

- [ ] **Step 1: Create the file**

  ```tsx
  import type { ReactNode } from 'react'
  import { ArrowLeft, ArrowRight, Home, Maximize2, Minimize2, MoreHorizontal, RefreshCw, Search, Star, X } from 'lucide-react'
  import { Button } from '@/components/ui/button'
  import { Select } from '@/components/ui/select'
  import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
  import { cn } from '@/lib/utils'
  import type { MachineHealth } from '@/lib/api'
  import type { Machine } from '@/store/types'

  /** The 28px toolbar buttons are fine under a mouse but far too small to hit
   *  reliably with a thumb, so they grow to 36px on touch pointers only. */
  const toolbarButtonClass = 'pointer-coarse:h-9 pointer-coarse:w-9'

  export interface BrowserToolbarProps {
    canGoBack: boolean
    canGoForward: boolean
    onBack: () => void
    onForward: () => void
    loading: boolean
    hasUrl: boolean
    onReload: () => void
    onStop: () => void
    onHome: () => void
    onOpenFind: () => void
    machineId: string
    machines: Machine[]
    machineHealth: Map<string, MachineHealth | undefined>
    onSelectMachine: (machineId: string) => void
    onBookmark: () => void
    fullscreen: boolean
    onToggleFullscreen: () => void
    /** The tab strip, centered between the two clusters — a separate
     *  component/file (`BrowserTabStrip.tsx`) per the one-component-per-file
     *  convention; this toolbar only owns the row shell and its own clusters. */
    children: ReactNode
  }

  /** Fixed single row, `h-9`, never wraps (design spec §3.3) — the
   *  always-visible address `<Input>` that used to force a wrap below
   *  `@lg/tile` is gone, replaced by `BrowserUrlCard`. */
  export function BrowserToolbar({
    canGoBack,
    canGoForward,
    onBack,
    onForward,
    loading,
    hasUrl,
    onReload,
    onStop,
    onHome,
    onOpenFind,
    machineId,
    machines,
    machineHealth,
    onSelectMachine,
    onBookmark,
    fullscreen,
    onToggleFullscreen,
    children,
  }: BrowserToolbarProps) {
    const machineOptions = machines.map((m) => ({
      value: m.id,
      label: m.name,
      disabled: machineHealth.get(m.id)?.status === 'offline',
    }))

    // Rendered twice — inline above `@sm/tile`, inside the "…" popover below
    // it (design spec §3.8) — `compact` only changes the Select's own width
    // so it reads sensibly inside a narrow popover menu.
    const rightCluster = (compact: boolean) => (
      <>
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onHome} aria-label="Home">
          <Home size={12} />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          className={toolbarButtonClass}
          onClick={onOpenFind}
          disabled={!hasUrl}
          aria-label="Find on page"
        >
          <Search size={12} />
        </Button>
        <Select
          value={machineId}
          onValueChange={onSelectMachine}
          options={machineOptions}
          triggerClassName={cn('h-7 pointer-coarse:h-9', compact ? 'w-full' : 'w-28 max-w-none flex-none')}
          aria-label="Machine"
        />
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onBookmark} disabled={!hasUrl} aria-label="Bookmark this page">
          <Star size={12} />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          className={toolbarButtonClass}
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </Button>
      </>
    )

    return (
      <div className="flex h-9 flex-none items-center gap-1 border-b border-devdeck-border bg-devdeck-bg px-2">
        {canGoBack || canGoForward ? (
          <>
            <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onBack} disabled={!canGoBack} aria-label="Back">
              <ArrowLeft size={12} />
            </Button>
            <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onForward} disabled={!canGoForward} aria-label="Forward">
              <ArrowRight size={12} />
            </Button>
          </>
        ) : null}
        <Button
          size="icon-sm"
          variant="secondary"
          className={toolbarButtonClass}
          onClick={loading ? onStop : onReload}
          disabled={!hasUrl}
          aria-label={loading ? 'Stop' : 'Reload'}
        >
          {loading ? <X size={12} /> : <RefreshCw size={12} />}
        </Button>

        {children}

        <div className="hidden items-center gap-1 @sm/tile:flex">{rightCluster(false)}</div>
        <div className="@sm/tile:hidden">
          <TabStripPopoverMenu
            trigger={<MoreHorizontal size={13} />}
            triggerClassName={cn(
              toolbarButtonClass,
              'flex h-7 w-7 items-center justify-center rounded-md text-devdeck-muted hover:bg-devdeck-hover-wash',
            )}
            triggerTitle="More"
            triggerAriaLabel="More browser controls"
            align="end"
          >
            <div className="grid w-44 gap-1 p-1">{rightCluster(true)}</div>
          </TabStripPopoverMenu>
        </div>
      </div>
    )
  }
  ```

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck` — expect zero errors.

---

## Task 6: `BrowserTabStrip.tsx` — the animated internal tab strip

**Files:**
- Create: `frontend/src/features/browser/BrowserTabStrip.tsx`

Per the design spec §3.4/§4.3: always visible (not gated on `tile.fullscreen` anymore — that gate is deleted in Slice 3), centered, clips rather than scrolls, grow-in on mount via a `useEffect`-deferred width, shrink-out (ghost) on close via `onTransitionEnd`. Depends only on Slice 2's own `browserTabWidth.ts`/`displayUrl.ts`/`BrowserFaviconChip.tsx` and the `BrowserDocState` type already exported by `useDevDeckStore.ts` — not on `BrowserTile.tsx` itself.

**Interfaces:**
- Produces: `BrowserTabStrip(props): JSX.Element` — see `BrowserTabStripProps` below.

- [ ] **Step 1: Create the file**

  ```tsx
  import { useEffect, useState } from 'react'
  import { Plus, X } from 'lucide-react'
  import { cn } from '@/lib/utils'
  import type { BrowserDocState } from '@/store/useDevDeckStore'
  import { BrowserFaviconChip } from './BrowserFaviconChip'
  import { tabPillTargetWidth } from './browserTabWidth'
  import { displayUrl } from './displayUrl'

  export interface BrowserTabStripProps {
    docs: BrowserDocState[]
    activeDocId: string
    onSelect: (docId: string) => void
    onClose: (docId: string) => void
    onAdd: () => void
    /** Clicking the *active* pill's label opens the URL card (design spec
     *  §3.4) rather than switching tabs — it's already the active one. */
    onEditActiveUrl: () => void
  }

  interface PillRecord {
    id: string
    doc: BrowserDocState
    closing: boolean
  }

  /** Centered, clips rather than scrolls (design spec §3.4) — `overflow-hidden`
   *  lets each pill's own `truncate` compress before the strip itself would
   *  ever need a scroll affordance, matching terminal-browser's explicit
   *  no-scroll choice. */
  export function BrowserTabStrip({ docs, activeDocId, onSelect, onClose, onAdd, onEditActiveUrl }: BrowserTabStripProps) {
    const [pills, setPills] = useState<PillRecord[]>(() => docs.map((doc) => ({ id: doc.id, doc, closing: false })))

    // Keeps a *closing* pill in `pills` after the store has already dropped
    // its doc — its own onTransitionEnd below (via TabPill's onShrinkComplete)
    // removes it once the shrink-to-0 CSS transition actually finishes
    // (design spec §4.3: "stays until width hits 0, then spliced out").
    useEffect(() => {
      setPills((current) => {
        const next = docs.map((doc) => ({ id: doc.id, doc, closing: false }))
        const stillClosing = current.filter((p) => p.closing && !docs.some((d) => d.id === p.id))
        for (const prev of current) {
          if (prev.closing) continue
          if (!docs.some((d) => d.id === prev.id)) stillClosing.push({ ...prev, closing: true })
        }
        return [...next, ...stillClosing]
      })
    }, [docs])

    const single = docs.length <= 1

    return (
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-hidden px-2">
        {pills.map((pill) => (
          <TabPill
            key={pill.id}
            doc={pill.doc}
            active={pill.id === activeDocId}
            single={single}
            closing={pill.closing}
            onSelect={() => (pill.id === activeDocId ? onEditActiveUrl() : onSelect(pill.id))}
            onClose={() => onClose(pill.id)}
            onShrinkComplete={() => setPills((current) => current.filter((p) => p.id !== pill.id))}
          />
        ))}
        <button
          type="button"
          onClick={onAdd}
          aria-label="New tab"
          className="ml-1 flex h-6 w-6 flex-none items-center justify-center rounded-full text-devdeck-dim hover:bg-devdeck-hover-wash"
        >
          <Plus size={12} />
        </button>
      </div>
    )
  }

  function TabPill({
    doc,
    active,
    single,
    closing,
    onSelect,
    onClose,
    onShrinkComplete,
  }: {
    doc: BrowserDocState
    active: boolean
    single: boolean
    closing: boolean
    onSelect: () => void
    onClose: () => void
    onShrinkComplete: () => void
  }) {
    const [mounted, setMounted] = useState(false)

    // Mounts at width 0, then sets the real computed width on the next frame
    // — the CSS transition needs a starting value to animate *from* (design
    // spec §4.3's "grow-in" mechanics).
    useEffect(() => {
      const frame = requestAnimationFrame(() => setMounted(true))
      return () => cancelAnimationFrame(frame)
    }, [])

    const label = active ? displayUrl(doc.url ?? '') : doc.title
    const width =
      closing || !mounted ? 0 : tabPillTargetWidth({ labelLength: label.length, hasFavicon: true, isActive: active })

    return (
      <button
        type="button"
        onClick={onSelect}
        onTransitionEnd={(event) => {
          if (closing && event.propertyName === 'width') onShrinkComplete()
        }}
        style={{ width }}
        className={cn(
          'group flex h-7 flex-none items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full px-3',
          'transition-[width] duration-200 ease-out',
          active && !single ? 'bg-devdeck-elevated' : 'hover:bg-devdeck-hover-wash',
        )}
      >
        <BrowserFaviconChip seed={doc.id} title={doc.title} size={16} />
        <span className={cn('min-w-0 flex-1 truncate text-left text-[11px]', active ? 'text-devdeck-fg' : 'text-devdeck-muted')}>
          {label}
        </span>
        <span
          role="button"
          aria-label={`Close ${doc.title}`}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          className="flex h-5 w-5 flex-none items-center justify-center rounded-full opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100"
        >
          <X size={11} />
        </span>
      </button>
    )
  }
  ```

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck` — expect zero errors. `BrowserDocState` is already exported from `useDevDeckStore.ts` (used today by `BrowserTile.tsx` itself for its own local `doc` variable's inferred type), so this import doesn't require any Slice 1 change.

---

## Task 7: `BrowserUrlCard.tsx` — hide-while-open URL editor

**Files:**
- Create: `frontend/src/features/browser/BrowserUrlCard.tsx`

Per the design spec §3.4b: technique 2 (hide-while-open), positioned `absolute` inside the tile's own `@container/tile` — **not** a `Dialog` portal — centered on the tile's own width. Pushes an occlusion blocker scoped to a ref on its own card element (via Slice 1's `useNativeOverlayBlocker`), which Slice 3's caller is responsible for keeping inside the tile's positioning context (`position: relative`).

**Interfaces:**
- Produces: `BrowserUrlCard(props): JSX.Element | null` — see `BrowserUrlCardProps` below.

- [ ] **Step 1: Create the file**

  ```tsx
  import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
  import { Search } from 'lucide-react'
  import { Input } from '@/components/ui/input'
  import { useNativeOverlayBlocker } from './useNativeOverlayBlocker'

  export interface BrowserUrlCardProps {
    open: boolean
    draft: string
    onDraftChange: (value: string) => void
    onSubmit: (value: string) => void
    onClose: () => void
  }

  /** Hide-while-open (design spec §3.0 technique 2): a minimal, single-purpose
   *  editor for the active doc's own URL — no suggestions list, no fuzzy
   *  ranking (that's the global command palette's job, not this card's — see
   *  the design spec §2). Opening it pushes an occlusion blocker scoped to
   *  this card's own rect via Slice 1's `useNativeOverlayBlocker`, not
   *  `'viewport'` — only *this* tile needs to hide, not every open Browser
   *  tile in the workspace. */
  export function BrowserUrlCard({ open, draft, onDraftChange, onSubmit, onClose }: BrowserUrlCardProps) {
    const cardRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    useNativeOverlayBlocker(open, cardRef)

    useEffect(() => {
      if (open) requestAnimationFrame(() => inputRef.current?.select())
    }, [open])

    if (!open) return null

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault()
      onSubmit(draft)
    }

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.key === 'Escape') onClose()
    }

    return (
      <>
        {/* Invisible, tile-scoped click-away backdrop — no visual scrim, since
            this card sits inside the tile's own bounds, not the viewport's. */}
        <div className="absolute inset-0 z-10" onClick={onClose} />
        <div
          ref={cardRef}
          onKeyDown={handleKeyDown}
          style={{ width: 'min(28rem, 100cqw - 4rem)' }}
          className="absolute left-1/2 top-[calc(2.25rem+0.75rem)] z-20 -translate-x-1/2 rounded-[13px] border border-devdeck-border-menu bg-devdeck-card p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
        >
          <form onSubmit={handleSubmit} className="flex items-center gap-2 px-1">
            <Search size={13} className="flex-none text-devdeck-dim" />
            <Input
              ref={inputRef}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder="Search or enter URL"
              className="h-8 flex-1 border-none bg-transparent px-0 text-[12px] shadow-none focus-visible:ring-0 pointer-coarse:text-[16px]"
            />
          </form>
        </div>
      </>
    )
  }
  ```

  (`top: calc(2.25rem + 0.75rem)` — `2.25rem` = the toolbar's `h-9`, `0.75rem` matches the design spec §3.4b's "toolbar height + 0.75rem" anchor.)

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck` — expect zero errors.

---

## Task 8: `BrowserFindBar.tsx` — spatially-disjoint inserted find row

**Files:**
- Create: `frontend/src/features/browser/BrowserFindBar.tsx`

Per the design spec §3.5: technique 1 (spatially disjoint) — an inserted `h-8` row, not a floating overlay, so it needs **no** occlusion blocker at all (it never overlaps the webview by construction).

**Interfaces:**
- Produces: `BrowserFindBar(props): JSX.Element | null` — see `BrowserFindBarProps` below.

- [ ] **Step 1: Create the file**

  ```tsx
  import { useEffect, useRef, type KeyboardEvent } from 'react'
  import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

  export interface BrowserFindBarProps {
    open: boolean
    query: string
    onQueryChange: (value: string) => void
    active: number
    total: number
    onNext: () => void
    onPrev: () => void
    onClose: () => void
  }

  /** Spatially disjoint (design spec §3.0 technique 1): an inserted row
   *  between the toolbar and the page surface, not a floating overlay — it
   *  shrinks the page-surface wrapper's rect (and therefore the webview's own
   *  bounds) by its own height, the same mechanism the toolbar itself already
   *  uses to coexist with the live webview. Needs no occlusion blocker at
   *  all (§3.5) — it's never spatially on top of the webview to begin with. */
  export function BrowserFindBar({ open, query, onQueryChange, active, total, onNext, onPrev, onClose }: BrowserFindBarProps) {
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
      if (open) requestAnimationFrame(() => inputRef.current?.focus())
    }, [open])

    if (!open) return null

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (event.shiftKey) onPrev()
        else onNext()
      }
    }

    return (
      <div className="flex h-8 flex-none items-center gap-2 border-b border-devdeck-border bg-devdeck-bg px-2">
        <Search size={12} className="flex-none text-devdeck-dim" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find on page"
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-devdeck-fg outline-none placeholder:text-devdeck-dim"
        />
        <span className="flex-none text-[10.5px] text-devdeck-muted">{total > 0 ? `${active}/${total}` : ''}</span>
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous match"
          className="flex h-6 w-6 flex-none items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
        >
          <ChevronUp size={13} />
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next match"
          className="flex h-6 w-6 flex-none items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
        >
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close find bar"
          className="flex h-6 w-6 flex-none items-center justify-center rounded text-devdeck-dim hover:bg-devdeck-hover-wash hover:text-devdeck-fg"
        >
          <X size={12} />
        </button>
      </div>
    )
  }
  ```

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck` — expect zero errors.

---

## Task 9: Slice 2 final verification + commit

- [ ] **Step 1: Full verification**

  From `frontend/`, run every new test file and confirm all pass:

  ```bash
  npx tsx src/features/browser/browserTabWidth.test.ts
  npx tsx src/features/browser/displayUrl.test.ts
  npx tsx src/features/browser/browserZoom.test.ts
  ```

  Then from the repo root: `npm --prefix frontend run typecheck` — zero errors. Confirm no file in this slice appears in `git diff --stat` for anything outside `frontend/src/features/browser/` and confirm none of the new files import `./BrowserTile` or are imported by it (`grep -rn "BrowserTile" frontend/src/features/browser/Browser{Toolbar,TabStrip,UrlCard,FindBar}.tsx frontend/src/features/browser/BrowserFaviconChip.tsx` should print nothing).

- [ ] **Step 2: Commit**

  ```bash
  git add frontend/src/features/browser/browserTabWidth.ts frontend/src/features/browser/browserTabWidth.test.ts \
    frontend/src/features/browser/displayUrl.ts frontend/src/features/browser/displayUrl.test.ts \
    frontend/src/features/browser/browserZoom.ts frontend/src/features/browser/browserZoom.test.ts \
    frontend/src/features/browser/BrowserFaviconChip.tsx \
    frontend/src/features/browser/BrowserToolbar.tsx \
    frontend/src/features/browser/BrowserTabStrip.tsx \
    frontend/src/features/browser/BrowserUrlCard.tsx \
    frontend/src/features/browser/BrowserFindBar.tsx
  git commit -m "feat(browser): add new chrome components (toolbar, tab strip, URL card, find bar)"
  ```

---

# Slice 3 — Integration

This slice rewrites `BrowserTile.tsx` onto Slice 2's components, wires Slice 1's occlusion primitives for real, and adds the three tile-scoped keybindings. It also touches `WorkspaceTileArea.tsx` (one line, to pass a new `isFocused` prop — mirroring the existing `SSHShellPane` pattern) and deletes the now-dead old toolbar/tab-strip JSX plus the inline `BookmarkIcon`/`chipColorFor`/`CHIP_COLORS` trio Slice 2's `BrowserFaviconChip.tsx` supersedes.

## Task 1: Wire `isFocused` through `WorkspaceTileArea.tsx`

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileArea.tsx:269`

**Interfaces:**
- Consumes: the new `isFocused?: boolean` prop `BrowserTile` gains in Task 2.

- [ ] **Step 1: Pass `isFocused`, mirroring the existing `sshShell` renderer**

  Replace (line 269):

  ```ts
            browser: ({ tab }) => <BrowserTile tabId={tab.id} />,
  ```

  with:

  ```ts
            browser: ({ leafId, tab }) => <BrowserTile tabId={tab.id} isFocused={leafId === layout.focusedLeafId} />,
  ```

  (Matches the `sshShell` renderer immediately below it, which already does `isFocused={leafId === layout.focusedLeafId}` for the identical reason — see `SSHShellPane`.)

- [ ] **Step 2: Verify**

  This alone doesn't yet typecheck clean — `BrowserTile` doesn't accept `isFocused` until Task 2. Continue to Task 2 before verifying.

---

## Task 2: Rewrite `BrowserTile.tsx` onto the new chrome

**Files:**
- Modify: `frontend/src/features/browser/BrowserTile.tsx` (full rewrite)

This replaces the whole file. Everything **not** called out below as changed is carried over unchanged from today's file: the legacy-bookmark migration effect, the native-webview mount effect (lines 172-216 of the pre-Slice-3 file), `groupBookmarksByMachine`, `machineLabelFor`, `normalizeAddress`, `titleFor`, `ensureProxyForMachine`, `selectMachine`, `navigate`, `goHistory`, `goHome`, `reload`, `openBookmarkDialog`, `openBookmark`, `closeInternalTab`, `canGoBack`/`canGoForward`, and `BookmarkDialog`'s wiring.

**Interfaces:**
- Produces: `BrowserTile({ tabId, isFocused }): JSX.Element | null`.
- Consumes: `BrowserToolbar`, `BrowserTabStrip`, `BrowserUrlCard`, `BrowserFindBar`, `BrowserFaviconChip` (Slice 2); `tileShouldBeHidden` (Slice 1 Task 2); `DEFAULT_ZOOM`/`zoomStep` (Slice 2 Task 3); `setZoomBrowserTile`/`findInBrowserTile`/`clearBrowserTileFind` and the `loading`-carrying `onBrowserTilePageLoad` (Slice 1 Task 9).

- [ ] **Step 1: Replace the file in full**

  ```tsx
  import { useEffect, useMemo, useRef, useState } from 'react'
  import { X } from 'lucide-react'
  import { toast } from 'sonner'
  import { useBookmarks, useCreateBookmark, useDeleteBookmark, useMachines, useMachinesHealth } from '@/features/data/queries'
  import { takeLegacyBrowserTileBookmarks } from '@/lib/browserTileBookmarks'
  import { startProxy } from '@/lib/machineApi'
  import type { Bookmark, Machine } from '@/store/types'
  import { useDevDeckStore } from '@/store/useDevDeckStore'
  import { BookmarkDialog } from './BookmarkDialog'
  import { BrowserFaviconChip } from './BrowserFaviconChip'
  import { BrowserFindBar } from './BrowserFindBar'
  import { BrowserTabStrip } from './BrowserTabStrip'
  import { BrowserToolbar } from './BrowserToolbar'
  import { BrowserUrlCard } from './BrowserUrlCard'
  import { tileShouldBeHidden } from './browserTileOcclusion'
  import { DEFAULT_ZOOM, zoomStep } from './browserZoom'
  import {
    clearBrowserTileFind,
    closeBrowserTile as closeNativeBrowserTile,
    findInBrowserTile,
    hideBrowserTile,
    navigateBrowserTile,
    onBrowserTilePageLoad,
    onBrowserTileTitleChange,
    openBrowserTile,
    reloadBrowserTile,
    setBrowserTileBounds,
    setZoomBrowserTile,
    showBrowserTile,
  } from './browserTilesBridge'

  interface BrowserTileProps {
    tabId: string
    /** Whether this tile's own leaf owns the keyboard — scopes Cmd/Ctrl+L (URL
     *  card), Cmd/Ctrl+F (find), and the zoom chords to the one focused
     *  Browser tile, mirroring `SSHShellPane`'s existing `isFocused` prop (see
     *  `WorkspaceTileArea.tsx`). Defaults to false so an un-migrated caller
     *  degrades to "no tile owns these keys" rather than every tile owning
     *  them at once. */
    isFocused?: boolean
  }

  /** True exactly once across this page load, regardless of how many
   *  BrowserTile instances mount (e.g. a split view with two browser tiles) —
   *  otherwise every tile would re-import the same handful of legacy
   *  bookmarks the instant it mounts. */
  let legacyBookmarksMigrated = false

  const UNASSIGNED_MACHINE_LABEL = 'Unassigned'

  function machineLabelFor(machineId: string, machines: Machine[]): string {
    if (!machineId) return UNASSIGNED_MACHINE_LABEL
    return machines.find((m) => m.id === machineId)?.name ?? 'Unknown machine'
  }

  /** Groups bookmarks by machine (top-level), then by the operator's own
   *  `group` field within each machine — approved as "all, grouped by
   *  machine" so switching machines never hides a bookmark, it just needs an
   *  extra glance to find. */
  function groupBookmarksByMachine(bookmarks: Bookmark[], machines: Machine[]): [string, [string, Bookmark[]][]][] {
    const byMachine = new Map<string, Bookmark[]>()
    for (const b of bookmarks) {
      const label = machineLabelFor(b.machineId, machines)
      byMachine.set(label, [...(byMachine.get(label) ?? []), b])
    }
    return [...byMachine.entries()]
      .sort(([a], [b]) => (a === UNASSIGNED_MACHINE_LABEL ? 1 : b === UNASSIGNED_MACHINE_LABEL ? -1 : a.localeCompare(b)))
      .map(([machineLabel, items]) => {
        const byGroup = new Map<string, Bookmark[]>()
        for (const b of items) {
          const group = b.group.trim() || 'Portal'
          byGroup.set(group, [...(byGroup.get(group) ?? []), b])
        }
        return [machineLabel, [...byGroup.entries()]] as [string, [string, Bookmark[]][]]
      })
  }

  function normalizeAddress(value: string): string {
    const raw = value.trim()
    if (!raw) return ''
    if (/^https?:\/\//i.test(raw)) return raw
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(raw)) return `https://${raw}`
    return `https://google.com/?q=${encodeURIComponent(raw)}`
  }

  /** Readable placeholder shown the instant navigation starts, before the real
   *  page `<title>` arrives (or for pages that never set one) — mirrors
   *  `BrowserModule.tsx`'s own `titleFor`, deliberately duplicated rather than
   *  shared since the two browsers are separate surfaces (see
   *  `lib/browserTileBookmarks.ts`'s header comment). */
  function titleFor(url: string): string {
    try {
      const parsed = new URL(url)
      const search = parsed.hostname.includes('google.com') ? parsed.searchParams.get('q') : null
      if (search) return `Search: ${search}`
      return parsed.hostname.replace(/^www\./, '') || url
    } catch {
      return url
    }
  }

  export function BrowserTile({ tabId, isFocused = false }: BrowserTileProps) {
    const tile = useDevDeckStore((s) => s.browserTiles[tabId])
    const ensureBrowserTile = useDevDeckStore((s) => s.ensureBrowserTile)
    const setBrowserDocState = useDevDeckStore((s) => s.setBrowserDocState)
    const addBrowserDoc = useDevDeckStore((s) => s.addBrowserDoc)
    const closeBrowserDoc = useDevDeckStore((s) => s.closeBrowserDoc)
    const selectBrowserDoc = useDevDeckStore((s) => s.selectBrowserDoc)
    const setBrowserTileFullscreen = useDevDeckStore((s) => s.setBrowserTileFullscreen)
    const nativeOverlayBlockers = useDevDeckStore((s) => s.nativeOverlayBlockers)
    const tileDragActive = useDevDeckStore((s) => s.tileDragActive)
    const machines = useMachines().data ?? []
    const machineHealth = useMachinesHealth(machines)
    const bookmarks = useBookmarks().data ?? []
    const createBookmark = useCreateBookmark()
    const deleteBookmark = useDeleteBookmark()
    const bookmarksByMachine = useMemo(() => groupBookmarksByMachine(bookmarks, machines), [bookmarks, machines])
    const [draft, setDraft] = useState('')
    const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false)
    const [urlCardOpen, setUrlCardOpen] = useState(false)
    const [findOpen, setFindOpen] = useState(false)
    const [findQuery, setFindQuery] = useState('')
    const [findResult, setFindResult] = useState<{ active: number; total: number }>({ active: 0, total: 0 })
    const bodyRef = useRef<HTMLDivElement>(null)
    const zoomLevelRef = useRef(DEFAULT_ZOOM)
    const scheduledShowRef = useRef<number | null>(null)

    useEffect(() => {
      ensureBrowserTile(tabId)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId])

    // One-shot migration off the old localStorage bookmark store — see
    // takeLegacyBrowserTileBookmarks's doc comment. Fire-and-forget: a failed
    // import of a handful of old bookmarks is a cheap loss next to leaking the
    // legacy key forever, and useCreateBookmark already invalidates qk.bookmarks
    // on each success so the New Tab list picks them up as they land.
    useEffect(() => {
      if (legacyBookmarksMigrated) return
      legacyBookmarksMigrated = true
      for (const legacy of takeLegacyBrowserTileBookmarks()) {
        createBookmark.mutate({ title: legacy.title, url: legacy.url, group: legacy.group })
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const doc = tile?.docs.find((d) => d.id === tile.activeDocId)
    const openedDocsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
      setDraft(doc?.url ?? '')
    }, [doc?.id, doc?.url])

    useEffect(() => {
      zoomLevelRef.current = DEFAULT_ZOOM
    }, [doc?.id])

    // Creates the native webview (once per doc, sized correctly from the
    // start) and keeps it glued to the placeholder's on-screen rect on every
    // resize/drag/fullscreen-toggle after that. Opening lives here — not in
    // `navigate()` — because the placeholder <div> this measures doesn't
    // exist in the DOM until React re-renders with `doc.url` set; opening
    // from `navigate()` directly raced this effect's first bounds report
    // against `browser_tile_open` still creating the webview, leaving it
    // stuck at its 1x1 placeholder size whenever the resize lost that race.
    useEffect(() => {
      if (!doc?.url || !bodyRef.current) return
      const el = bodyRef.current
      const docId = doc.id
      const url = doc.url
      const proxy = doc.proxy

      function sendBounds() {
        const rect = el.getBoundingClientRect()
        void setBrowserTileBounds(tabId, docId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      }

      if (!openedDocsRef.current.has(docId)) {
        openedDocsRef.current.add(docId)
        if (proxy) {
          const rect = el.getBoundingClientRect()
          void openBrowserTile(tabId, docId, `socks5://${proxy.socks5Addr}`, url).then(() =>
            setBrowserTileBounds(tabId, docId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }),
          )
        }
      }

      const observer = new ResizeObserver(sendBounds)
      observer.observe(el)
      return () => {
        observer.disconnect()
        // This cleanup fires both when switching to a different doc (internal tab
        // switch) and when the whole tile unmounts (e.g. navigating to a non-tiled
        // route like Machines/Tools — see WorkspaceTileArea's `showContent: false`).
        // Either way the native webview is about to stop being this component's
        // active surface, so it must be hidden — otherwise it keeps rendering at its
        // last on-screen rect on top of whatever comes next. `browser_tile_open` is
        // idempotent, so re-showing this doc later doesn't recreate or reload it.
        if (openedDocsRef.current.has(docId)) void hideBrowserTile(tabId, docId)
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId, doc?.id, doc?.url])

    function cancelScheduledShow() {
      if (scheduledShowRef.current !== null) {
        cancelAnimationFrame(scheduledShowRef.current)
        scheduledShowRef.current = null
      }
    }

    function scheduleShow(tId: string, dId: string, measure: () => DOMRect | undefined) {
      cancelScheduledShow()
      scheduledShowRef.current = requestAnimationFrame(() => {
        scheduledShowRef.current = null
        const rect = measure()
        if (!rect) return
        // Freshly read at the moment this frame actually runs, not the
        // closed-over values from when the show was scheduled (design spec
        // §5.6) — a blocker can push/pop again in the time between scheduling
        // and this callback firing.
        const state = useDevDeckStore.getState()
        if (tileShouldBeHidden(rect, state.nativeOverlayBlockers, state.tileDragActive)) return
        void showBrowserTile(tId, dId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
      })
    }

    // Occlusion-aware visibility (design spec §5.4/§5.6), replacing the
    // Slice-1 placeholder's blunt "any open blocker anywhere" check: a
    // Browser tile now only hides for a blocker whose own reported region
    // actually intersects this tile's rect (or `tileDragActive`/a
    // `'viewport'`-scoped blocker, which still hide unconditionally). Hide is
    // always immediate; show is coalesced behind one rAF so a same-frame
    // hide-then-show never round-trips an extra IPC call to Rust.
    useEffect(() => {
      if (!doc?.url || !openedDocsRef.current.has(doc.id)) return
      const docId = doc.id
      const el = bodyRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (tileShouldBeHidden(rect, nativeOverlayBlockers, tileDragActive)) {
        cancelScheduledShow()
        void hideBrowserTile(tabId, docId)
        return
      }
      scheduleShow(tabId, docId, () => bodyRef.current?.getBoundingClientRect())
      return cancelScheduledShow
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nativeOverlayBlockers, tileDragActive, tabId, doc?.id, doc?.url])

    // Sync the address bar/title from real in-page navigation inside the
    // native webview. `loading` now comes straight from the fixed
    // `on_page_load` payload (Slice 1 Task 7) instead of being hardcoded
    // false, so the toolbar's Reload<->Stop icon actually swaps.
    useEffect(() => {
      let unlisten: (() => void) | undefined
      void onBrowserTilePageLoad(({ tabId: t, docId: d, url, loading }) => {
        if (t === tabId) setBrowserDocState(t, d, { url, loading })
      }).then((fn) => {
        unlisten = fn
      })
      return () => unlisten?.()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId])

    // Follow the loaded page's own <title> (falls back to the humanized
    // hostname set by navigate()/goHistory() below until the real title
    // arrives, or for pages that never set one at all).
    useEffect(() => {
      let unlisten: (() => void) | undefined
      void onBrowserTileTitleChange(({ tabId: t, docId: d, title }) => {
        if (t === tabId && title) setBrowserDocState(t, d, { title })
      }).then((fn) => {
        unlisten = fn
      })
      return () => unlisten?.()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabId])

    // Cmd/Ctrl+L (URL card), Cmd/Ctrl+F (find), and the zoom chords — scoped
    // to this tile only while its leaf is focused (see the `isFocused` prop
    // doc comment), so a Browser tile in a background split never steals
    // these from whichever tile the operator is actually looking at.
    // Deliberately does not touch Cmd/Ctrl+K or Cmd/Ctrl+P — those stay the
    // global command palette's and file-quick-open's own bindings (see
    // `WorkspaceTileArea.tsx`'s own keydown handler and
    // `paletteKeyMatches` in the command-palette implementation), and
    // Cmd/Ctrl+N/P inside an *open* palette are that palette's own internal
    // selection-move bindings, unrelated to this tile.
    useEffect(() => {
      if (!isFocused || !doc) return
      function handleKeydown(event: KeyboardEvent) {
        const primary = event.metaKey || event.ctrlKey
        if (!primary || event.altKey || !doc) return
        const key = event.key
        if (!event.shiftKey && key.toLowerCase() === 'l') {
          event.preventDefault()
          setUrlCardOpen(true)
          return
        }
        if (!event.shiftKey && key.toLowerCase() === 'f') {
          event.preventDefault()
          setFindOpen(true)
          return
        }
        if (key === '=' || key === '+' || key === '-' || key === '_' || key === '0') {
          event.preventDefault()
          zoomLevelRef.current =
            key === '0' ? DEFAULT_ZOOM : zoomStep(zoomLevelRef.current, key === '-' || key === '_' ? -1 : 1)
          if (doc.url) void setZoomBrowserTile(tabId, doc.id, zoomLevelRef.current)
          // Stable `id` (design spec §3.6): a repeated zoom keypress replaces
          // the existing toast and resets its timer instead of stacking one.
          toast(`${Math.round(zoomLevelRef.current * 100)}%`, { id: 'browser-zoom', duration: 1500 })
        }
      }
      window.addEventListener('keydown', handleKeydown)
      return () => window.removeEventListener('keydown', handleKeydown)
    }, [isFocused, tabId, doc])

    if (!tile || !doc) return null

    const ensureProxyForMachine = async (machineId: string) => {
      const machine = machines.find((m) => m.id === machineId)
      if (!machine) return null
      const proxy = await startProxy(machine)
      setBrowserDocState(tabId, doc.id, { machineId, proxy })
      return proxy
    }

    /** Tauri's `proxy_url` is set at webview-construction time only (see the
     *  design spec's Rust component notes) — switching machines on a doc that
     *  already has a loaded page means destroying the existing native webview
     *  and recreating it against the new proxy, not just updating store state. */
    const selectMachine = async (machineId: string) => {
      const hadNativeWebview = !!doc.url
      if (hadNativeWebview) await closeNativeBrowserTile(tabId, doc.id)
      const proxy = await ensureProxyForMachine(machineId)
      if (hadNativeWebview && proxy && doc.url) {
        await openBrowserTile(tabId, doc.id, `socks5://${proxy.socks5Addr}`, doc.url)
        // The recreated webview starts at the same 1x1 placeholder size as a
        // brand-new one — the mount effect won't re-fire here (doc.url/doc.id
        // are unchanged), so this doc's own already-mounted rect has to be
        // reasserted explicitly instead of relying on the ResizeObserver.
        if (bodyRef.current) {
          const rect = bodyRef.current.getBoundingClientRect()
          await setBrowserTileBounds(tabId, doc.id, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        }
      }
    }

    const navigate = async (rawUrl: string) => {
      const url = normalizeAddress(rawUrl)
      if (!url) return
      let proxy = doc.proxy
      if (!proxy && doc.machineId) proxy = await ensureProxyForMachine(doc.machineId)
      if (!proxy) return
      const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
      setBrowserDocState(tabId, doc.id, { url, title: titleFor(url), loading: true, history, historyIndex: history.length - 1 })
      // First navigation for this doc (doc.url was still null): the mount
      // effect above creates the native webview once the placeholder <div>
      // exists, sized correctly from the start — see that effect's comment
      // for why opening doesn't happen here.
      if (doc.url) {
        await navigateBrowserTile(tabId, doc.id, url)
      }
    }

    const goHistory = async (delta: -1 | 1) => {
      const nextIndex = doc.historyIndex + delta
      const url = doc.history[nextIndex]
      if (!url) return
      setBrowserDocState(tabId, doc.id, { url, title: titleFor(url), historyIndex: nextIndex, loading: true })
      await navigateBrowserTile(tabId, doc.id, url)
    }

    const goHome = async () => {
      if (doc.url) await closeNativeBrowserTile(tabId, doc.id)
      // Un-mark this doc as opened so the next navigate() re-creates the
      // webview via the mount effect instead of assuming one still exists.
      openedDocsRef.current.delete(doc.id)
      setBrowserDocState(tabId, doc.id, { url: null, history: [], historyIndex: -1, title: 'New Tab' })
    }

    const reload = async () => {
      if (!doc.url) return
      setBrowserDocState(tabId, doc.id, { loading: true })
      await reloadBrowserTile(tabId, doc.id)
    }

    const stop = () => {
      // No native "cancel navigation" primitive exists on this Tauri/wry
      // version (design spec §6 only adds set_zoom and find this round) —
      // this clears the local loading flag so the icon swaps back, even
      // though the in-flight request itself isn't actually aborted.
      setBrowserDocState(tabId, doc.id, { loading: false })
    }

    // Opening the dialog is the whole action — BookmarkDialog itself owns the
    // useCreateBookmark() call once the operator confirms title/group (see
    // BookmarkDialog.tsx). This just seeds it with the current page.
    const openBookmarkDialog = () => {
      if (!doc.url) return
      setBookmarkDialogOpen(true)
    }

    /** Opening a bookmark saved from a *different* machine than this doc's
     *  current one switches machines first — mirrors `selectMachine`, but
     *  skips its native-webview teardown/rebuild dance since a New Tab (where
     *  bookmarks are the only thing rendered) never has one to begin with. */
    const openBookmark = async (bookmark: Bookmark) => {
      const proxy =
        bookmark.machineId && bookmark.machineId !== doc.machineId
          ? await ensureProxyForMachine(bookmark.machineId)
          : (doc.proxy ?? (doc.machineId ? await ensureProxyForMachine(doc.machineId) : null))
      if (!proxy) return
      const url = normalizeAddress(bookmark.url)
      if (!url) return
      const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
      setBrowserDocState(tabId, doc.id, { url, title: bookmark.title, loading: true, history, historyIndex: history.length - 1 })
    }

    const closeInternalTab = async (docId: string) => {
      // Keyed on `openedDocsRef`, not `doc.id === docId` — a *backgrounded* internal
      // tab (switched away from, now hidden per the bounds effect above) still owns
      // a live native webview and must be closed too, not just the active one.
      if (openedDocsRef.current.has(docId)) {
        openedDocsRef.current.delete(docId)
        await closeNativeBrowserTile(tabId, docId)
      }
      closeBrowserDoc(tabId, docId)
    }

    const submitUrlCard = (value: string) => {
      setUrlCardOpen(false)
      void navigate(value)
    }

    const closeUrlCard = () => {
      setDraft(doc.url ?? '')
      setUrlCardOpen(false)
    }

    const runFind = (direction: 'next' | 'prev') => {
      if (!doc.url || !findQuery.trim()) return
      void findInBrowserTile(tabId, doc.id, findQuery, direction).then(setFindResult)
    }

    const closeFind = () => {
      setFindOpen(false)
      setFindQuery('')
      setFindResult({ active: 0, total: 0 })
      if (doc.url) void clearBrowserTileFind(tabId, doc.id)
    }

    const canGoBack = doc.historyIndex > 0
    const canGoForward = doc.historyIndex < doc.history.length - 1

    return (
      // `@container/tile` — the toolbar below reflows on the *tile's* width, not
      // the viewport's: a browser tile split three ways on a desktop is just as
      // narrow as a full-width one on a phone, and needs the same layout.
      <div className="@container/tile flex min-h-0 min-w-0 flex-1 flex-col bg-devdeck-bg">
        <BrowserToolbar
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onBack={() => void goHistory(-1)}
          onForward={() => void goHistory(1)}
          loading={doc.loading}
          hasUrl={!!doc.url}
          onReload={() => void reload()}
          onStop={stop}
          onHome={() => void goHome()}
          onOpenFind={() => setFindOpen((v) => !v)}
          machineId={doc.machineId ?? ''}
          machines={machines}
          machineHealth={machineHealth}
          onSelectMachine={(machineId) => void selectMachine(machineId)}
          onBookmark={openBookmarkDialog}
          fullscreen={tile.fullscreen}
          onToggleFullscreen={() => setBrowserTileFullscreen(tabId, !tile.fullscreen)}
        >
          <BrowserTabStrip
            docs={tile.docs}
            activeDocId={tile.activeDocId}
            onSelect={(docId) => selectBrowserDoc(tabId, docId)}
            onClose={(docId) => void closeInternalTab(docId)}
            onAdd={() => addBrowserDoc(tabId)}
            onEditActiveUrl={() => setUrlCardOpen(true)}
          />
        </BrowserToolbar>

        <BrowserFindBar
          open={findOpen}
          query={findQuery}
          onQueryChange={setFindQuery}
          active={findResult.active}
          total={findResult.total}
          onNext={() => runFind('next')}
          onPrev={() => runFind('prev')}
          onClose={closeFind}
        />

        <div className="relative min-h-0 min-w-0 flex-1 rounded-b-lg border border-devdeck-border-card">
          <BrowserUrlCard open={urlCardOpen} draft={draft} onDraftChange={setDraft} onSubmit={submitUrlCard} onClose={closeUrlCard} />
          {!doc.url ? (
            <div className="flex h-full flex-col items-center gap-5 overflow-auto p-4 @sm/tile:p-6">
              {bookmarksByMachine.length === 0 ? (
                <div className="mt-16 text-[12px] text-devdeck-muted">No bookmarks yet — enter a URL above to start browsing.</div>
              ) : (
                bookmarksByMachine.map(([machineLabel, groups]) => (
                  <div key={machineLabel} className="w-full max-w-[520px]">
                    <div className="mb-2.5 flex items-center gap-2">
                      <span className="text-[11px] font-semibold text-devdeck-fg-2">{machineLabel}</span>
                      <div className="h-px flex-1 bg-devdeck-border" />
                    </div>
                    <div className="grid gap-3">
                      {groups.map(([group, items]) => (
                        <div key={group}>
                          <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-devdeck-dim">{group}</div>
                          <div className="grid grid-cols-1 gap-2 @sm/tile:grid-cols-2">
                            {items.map((bookmark) => (
                              // Open and remove are siblings, not nested <button>s — nesting
                              // is invalid HTML and made the two tap targets overlap.
                              <div
                                key={bookmark.id}
                                className="flex items-center gap-2 rounded-lg border border-devdeck-border-card bg-devdeck-surface-2 pr-1 focus-within:border-devdeck-border-accent hover:border-devdeck-border-accent"
                              >
                                <button
                                  type="button"
                                  onClick={() => void openBookmark(bookmark)}
                                  className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pl-3 text-left"
                                >
                                  <BrowserFaviconChip seed={bookmark.id} title={bookmark.title} iconDataUrl={bookmark.iconDataUrl} />
                                  <span className="min-w-0 flex-1 truncate text-[12px] text-devdeck-fg-2">{bookmark.title}</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteBookmark.mutate(bookmark.id)}
                                  aria-label={`Remove ${bookmark.title}`}
                                  className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-devdeck-muted-2 hover:text-devdeck-red-soft pointer-coarse:h-9 pointer-coarse:w-9"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div ref={bodyRef} className="absolute inset-0" />
          )}
        </div>

        <BookmarkDialog
          open={bookmarkDialogOpen}
          onOpenChange={setBookmarkDialogOpen}
          machineId={doc.machineId}
          machineName={machineLabelFor(doc.machineId ?? '', machines)}
          url={doc.url ?? ''}
          initialTitle={doc.title}
        />
      </div>
    )
  }
  ```

  This rewrite deletes, as dead code the rewrite makes obsolete: the inline `CHIP_COLORS`/`chipColorFor`/`BookmarkIcon` trio (superseded by `BrowserFaviconChip`), `toolbarButtonClass` (moved into `BrowserToolbar.tsx`), the `tile.fullscreen`-gated internal tab strip block, the old wrapping toolbar row and its `<form>`/`<Input>` address bar, and the `submit`/draft-form-submit handler (superseded by `BrowserUrlCard`'s own form).

- [ ] **Step 2: Verify**

  Run: `npm --prefix frontend run typecheck` — expect zero errors across the whole frontend (this also resolves Task 1's dangling `isFocused` prop reference in `WorkspaceTileArea.tsx`).

---

## Task 3: Manual verification pass

No new automated tests in this task — this is UI wiring, verified live per this project's convention for chrome/overlay work (matching the design spec §9's manual verification list).

- [ ] **Step 1: Launch the desktop app**

  Run the appropriate dev command per `COMMANDS.md` (e.g. `make dev-tauri`).

- [ ] **Step 2: Toolbar + tab strip**

  - Open a Browser tile, split the workspace 3-4 ways so the tile is narrow. Confirm the toolbar never wraps to a second row at any width, and the right-hand cluster (Home, Find, Machine, Bookmark, Fullscreen) collapses behind a "…" button below roughly 24rem (`@sm/tile`) and every item in it still works from inside the popover.
  - Open several internal tabs via the trailing `+`. Confirm each new pill grows in from 0 width (not a hard pop-in), and closing one shrinks it to 0 before it disappears (not an instant removal).
  - Confirm the tab strip is visible **without** needing `tile.fullscreen` — split view included.
  - Confirm Back/Forward are both absent on a fresh tab with no history, and appear together once you've navigated.
  - Navigate to a page; confirm the Reload icon swaps to an X while `loading` is true, and clicking it stops showing the spinner-equivalent state.

- [ ] **Step 3: URL card**

  - Click the active tab's pill label — confirm the URL card opens centered on the *tile*, not the viewport, and this tile's own webview hides while it's open. A sibling Browser tile in another split must stay live.
  - Press `Cmd/Ctrl+L` while this tile's leaf is focused — same card opens. Press it while a *different* tile's leaf is focused — confirm it does nothing to this tile.
  - Type a new URL, submit — confirm it navigates and the card closes. Open it again, press `Escape` — confirm the draft reverts to the current URL without navigating.

- [ ] **Step 4: Find bar**

  - Press `Cmd/Ctrl+F` (or the toolbar's Find icon) — confirm the find row appears *between* the toolbar and the page, the page stays visibly live underneath, and typing in it does not hide the webview.
  - Type a query present on the page — confirm matches highlight and the `active/total` counter updates. Press `Enter`/`Shift+Enter` — confirm next/previous cycling and wraparound at the ends.
  - Close it (`Escape` or the × button) — confirm highlights clear from the page.

- [ ] **Step 5: Zoom**

  - With this tile focused, press `Cmd/Ctrl +`/`-`/`0` repeatedly — confirm a `sonner` toast appears top-center, and a rapid repeat resets its timer instead of stacking multiple toasts.

- [ ] **Step 6: Occlusion**

  - Open two Browser tiles in separate splits. Hover a tooltip on a toolbar button that is nowhere near either tile — confirm **neither** tile blinks.
  - Open the machine picker `Select` in one tile — confirm only that tile hides, not the sibling one.
  - Drag a pane divider quickly — confirm tiles in the split being resized hide smoothly and reappear at the correct settled size; a Browser tile in an unrelated split (if any) is unaffected.
  - Open the global command palette (`Cmd/Ctrl+K`) or the mobile sidebar drawer at a narrow width — confirm it still covers every open Browser tile (these stay `'viewport'`-scoped, by design).

- [ ] **Step 7: Keybinding collisions**

  - Confirm `Cmd/Ctrl+K` still opens the command palette, and `Cmd/Ctrl+P` still opens file quick-open, unaffected by this change.
  - With the command palette open, confirm `Ctrl+N`/`Ctrl+P` still move its own selection (unrelated to this tile's bindings).
  - Confirm `Cmd/Ctrl+1..4`, `Cmd/Ctrl+T`/`O`, `Cmd/Ctrl+W`, and `Cmd+Shift+[`/`]` (all owned by `WorkspaceTileArea.tsx`'s existing global handler) are unaffected.

---

## Task 4: Slice 3 final verification + commit

- [ ] **Step 1: Full verification**

  - `npm --prefix frontend run typecheck` — zero errors.
  - `npm --prefix frontend run build` — succeeds.
  - Confirm `git diff --stat` shows no changes to `frontend/src/store/useDevDeckStore.ts`, `frontend/src/store/types.ts`, or any file under `frontend/src-tauri/` (all convergence/Slice-1-only files) — this slice should only have touched `BrowserTile.tsx` and `WorkspaceTileArea.tsx`.
  - Re-confirm Task 3's full manual pass.

- [ ] **Step 2: Commit**

  ```bash
  git add frontend/src/features/browser/BrowserTile.tsx frontend/src/features/tabs/WorkspaceTileArea.tsx
  git commit -m "feat(browser): replicate browser-standard chrome onto BrowserTile"
  ```

---

## Relationship to prior work (from the design spec §7 — do not re-litigate)

| Task (2026-07-31 plan) | Status | Disposition here |
|---|---|---|
| 1 — `tileDragActive` flag | Landed (`bbe1c03`) | Kept. Slice 1 Task 5 adds the `onLostPointerCapture` fix and a second, rect-scoped `useNativeOverlayBlocker` signal alongside it — does not remove or revert `tileDragActive` itself. |
| 2 — drag-ghost blocker | Landed (`451dc6a`) | Kept. Slice 1 Task 5 migrates it from an implicit `'viewport'` region to the ghost element's own rect. |
| 3 — proxy-start error handling | Not landed | Out of scope here — still owned by the 07-31 plan; nothing in this plan conflicts with `resolveProxyForMachine`/`browserProxy.ts` landing independently. |
| 4 — in-page nav history tracking | Not landed | Out of scope here — still the correct near-term fix; this plan's `navigate`/`goHistory`/`openBookmark` are carried over unchanged from today's file (not the eventual `browserHistory.ts` version) in Slice 3 Task 2. Whoever lands Task 4 afterward should re-diff against Slice 3's rewritten `BrowserTile.tsx`, not the pre-rewrite file. |
| 5 — localhost → machine rewrite | Not landed | Out of scope, unaffected. |
| 6–13 — nine z-index gaps | Not landed | Superseded in shape, not intent, per the design spec §7: each should use the new two-argument `useNativeOverlayBlocker(active, rectRef)` signature from Slice 1 Task 3 when it lands, supplying a `rectRef` where a natural bounded anchor exists, rather than the plan's original bare-boolean call. |

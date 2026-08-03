# Browser Tile Chrome Replication + Occlusion-Aware Visibility — Design

**Date:** 2026-08-01
**Status:** Approved (decision already made on the two central questions — see
Non-Goals) — ready for implementation plan.
**Builds on:** `2026-07-13-desktop-proxied-browser-tab-design.md` (the native
`BrowserTile` whose chrome this replaces), `2026-07-31-browser-tile-bugfixes-design.md`
(only Task 1 of that plan has landed — see §7 for the full reconciliation).
**Reference (read-only, unmodified):** `temp/terminal-browser/browser/src/ui/*`
— a `pixel-react` (canvas-painted) desktop browser chrome. Every measurement
and behavior below is translated from that source into DevDeck's DOM/Tailwind
stack, not copied verbatim — the translation constraints are called out
explicitly wherever they change the design (see especially §3.0 and §3.5).
**Scope:** Frontend chrome + occlusion visibility only, desktop-only
(`frontend/src/features/browser/BrowserTile.tsx` and its native-webview
support files). Does not touch `frontend/src/features/modules/BrowserModule.tsx`
(the sandboxed-iframe web fallback — no native webview, no occlusion problem).
A small, prioritized native (Rust) surface addition is in scope; see §6.

## 1. Problem

### 1.1 The chrome is cramped and feels unpolished

`BrowserTile.tsx:426-474` renders a single toolbar row that tries to hold
back/forward, reload, an always-visible address-bar `<Input>`, bookmark,
machine picker, and fullscreen toggle all at once. The row's own comment
(`BrowserTile.tsx:421-425`) admits the address bar was already losing a fight
for space in an earlier `overflow-x-auto` version and now just drops to its
own full-width second line below `@lg/tile` (32rem) — i.e. the toolbar
**wraps to two rows** on anything narrower than a fairly wide single-pane
tile, which on a multi-way split is the common case, not the exception.

Worse, the per-tile internal tab strip (multiple pages open inside one
Browser tile) only renders **when `tile.fullscreen` is true**
(`BrowserTile.tsx:382-419`) — in the normal, non-fullscreen split-view case
that is what most Browser tiles actually are, there is no way to see or
switch between a tile's own open pages at all. When it is visible, it's a
plain row of `<button>`s with a generic `Globe` icon, no favicon, no width
animation on open/close (tabs just appear/disappear), and a hover-only close
affordance patched for touch via `pointer-coarse:opacity-100`.

None of this is a single bug; it's the accumulated cost of a toolbar that
was extended piece by piece and a tab strip that was bolted on only for the
fullscreen case. The result is a native browser surface that visibly looks
and behaves like an app feature bolted onto a generic tab-splitter, not like
a real browser chrome.

### 1.2 The global overlay blocker makes the webview blink out constantly

The mechanism: `nativeOverlayBlockers: number` (`store/useDevDeckStore.ts:274`)
is a single **app-global counter**, shared by every overlay in the app,
incremented/decremented by `pushNativeOverlayBlocker`/`popNativeOverlayBlocker`
(`useDevDeckStore.ts:640-641`). `BrowserTile.tsx:225-236` hides **every
currently-visible** Browser tile's native webview whenever that counter is
above zero — with no positional check of any kind:

```ts
// BrowserTile.tsx:228-231
if (nativeOverlayBlockers > 0 || tileDragActive) {
  void hideBrowserTile(tabId, docId)
  return
}
```

The worst concrete offender: `components/ui/tooltip.tsx:22` (`Tooltip`) and
`:48` (`InfoTooltip`) both call `useNativeOverlayBlocker` on their own
150ms hover/focus-driven `open` state. `Tooltip` is a generic wrapper used on
icon buttons throughout the entire app. Hovering almost **any** button
anywhere in the UI — including in a split with no Browser tile anywhere near
it — blanks every open Browser tile in the workspace for the duration of the
hover. This is the dominant, highest-frequency contributor to the "zindex
tinggi dan banyak bug" complaint: it is not one dialog occasionally covering
a tile, it is a background flicker that fires on ordinary mouse movement.

A second, independent failure mode compounds it: `tileDragActive`
(landed in `bbe1c03` as Task 1 of the 07-31 plan) is set directly from raw
`onPointerDown`/`onPointerUp`/`onPointerCancel` handlers on the divider
element in `WorkspaceTileCanvas.tsx`'s `TileSplitView`, **not** from a
React effect cleanup the way `nativeOverlayBlockers` is. If the divider
element is ever removed from the DOM mid-drag, or the OS steals pointer
capture before `pointerup`/`pointercancel` fires, nothing ever calls
`setTileDragActive(false)` — the flag is stuck `true` forever, and every
Browser tile in the app stays hidden until the process restarts. This is a
gap in the fix that already landed to reduce blink, not a hypothetical: it
is exactly the counter-leak failure mode §5 must make structurally
impossible.

## 2. Non-Goals

- **No CDP screencast / canvas re-architecture.** This is the decision
  already made, not one this spec re-opens: DevDeck keeps rendering the
  Browser tile as a real native child `Webview` (`browser_tiles.rs`),
  overlaid at the placeholder `<div>`'s on-screen rect. Re-architecting to a
  CDP screencast piped into a `<canvas>` would trade a well-understood
  overlay-visibility problem (solved by §5) for a much larger rewrite —
  losing native scrolling, native text selection, GPU compositing, and the
  proxy-scoped `WebviewBuilder` this feature already depends on — to fix a
  problem that doesn't require it. Out of scope, full stop.
- **No native find-in-page (`WKWebView.findString`) this round.** Report D's
  own effort table rates it the one item where the native path (new
  `objc2-web-kit` feature flags `WKFindConfiguration`/`WKFindResult` that
  wry does not currently enable, a completion-handler → channel/emit bridge)
  meaningfully outweighs every other native change in this spec for a single
  toolbar affordance. §3.5/§6 ship the Find Bar's chrome and a JS-eval MVP
  backend (rated **Low** effort by the same table); the native version is
  deferred to a future spec once find is a proven enough feature to justify
  the unsafe-macOS surface.
- **No native favicon fetching (`eval_with_callback` + a new
  `browser-tile-favicon-changed` event) this round.** Rated **Medium**
  effort by report D (new event wiring, though no new Cargo dependency).
  Tab pills fall back to the existing generic chip/`Globe` idiom
  (`BrowserTile.tsx:81-95`, `BookmarkIcon`) until this lands; the tab-pill
  layout (§3.2) reserves the favicon slot's exact dimensions today so
  wiring in real favicons later is a data change, not a layout change.
- **No native `canGoBack`/`canGoForward`/`goBack`/`goForward`
  (`WKWebView` via the `with_webview` raw-pointer escape hatch) this round.**
  Rated **Medium** effort, new unsafe macOS code. The still-open Task 4 of
  the 07-31 plan (JS-array history tracking, `frontend/src/lib/browserHistory.ts`
  — not yet landed) is the correct, lower-risk near-term fix and should land
  independently of this spec (see §7); native back/forward is a candidate
  to *later* supersede it, not something this spec should block on.
- **No reimplementation of terminal-browser's `UrlCard`/`PaletteCard` as a
  fuzzy-search/history-ranked surface.** DevDeck's global command palette
  (`2026-08-01-global-command-palette-design.md`) already owns "search or
  open anything from anywhere" — `providers/bookmarks.ts`'s `looksLikeUrl`/
  `normalizeUrl`/`bookmarkItems` is the same job terminal-browser's combined
  address/search bar does. The URL Card this spec adds (§3.4) is narrower:
  editing *this tab's own URL in place*, with no suggestions list, no
  frecency, no fuzzy ranking — a different job the palette doesn't do and
  shouldn't be made to do.
- **No app-wide performance pass.** Tile-canvas memoization, xterm
  throughput, and general overlay latency are out of scope, same carve-out
  the palette spec already made for itself.
- **No Download HUD.** Report A documents one in the reference source, but
  Browser tiles have no download feature today; porting the HUD shape ahead
  of the feature it's for is speculative work with nothing to test it
  against.

## 3. The new chrome

### 3.0 A constraint that shapes every component below

The native webview is a separate OS surface the window manager always
stacks above the entire app DOM — this is true regardless of what's
*inside* the DOM's stacking context, including DOM content that lives
spatially inside this same tile. Two different techniques are available,
and this spec uses both, deliberately, per component:

1. **Spatial disjointness** — position the DOM chrome entirely *outside*
   the webview's own bounds (`bodyRef`'s rect, which is exactly what
   `browser_tile_set_bounds`/`show` size the webview to). No stacking
   contest exists because the two surfaces never claim the same pixels.
   This is how the existing toolbar already works today, uneventfully —
   `layout.page.y` starts below it. It requires the webview's rect to
   shrink to make room, which the existing `ResizeObserver`-driven bounds
   effect already handles.
2. **Hide-while-open** — accept that this tile's own webview is not visible
   for as long as this piece of chrome is open, exactly the way the
   existing machine-picker `Select` already works. Correct for anything
   that is itself a focused, modal-like interaction where the live page
   isn't meant to be visible underneath anyway (a centered URL edit card,
   a dropdown).

What does **not** work, and this spec does not attempt it: a DOM element
positioned as a *floating overlay on top of the live, still-interactive
page* (terminal-browser's own `FindBar`/`ZoomHud`, which live happily on
top of the page because in that source the "page" is itself just another
layer of the same canvas). In DevDeck's architecture that DOM element would
silently render *behind* the always-on-top webview — invisible, not merely
z-index-wrong. Every component spec below states explicitly which of the
two techniques it uses and why.

### 3.1 Wireframe

Default state:

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [←][→] [⟳]   ╭──────╮ ╭───────────────╮ ╭──────╮      [+]  [⌂][machine▾][★][⛶] │
│              │ tab 1│ │ ● example.com │ │ tab 3│                              │
│              ╰──────╯ ╰───────────────╯ ╰──────╯                              │
├───────────────────────────────────────────────────────────────────────────┤ ← page.y starts here
│ ╭─────────────────────────────────────────────────────────────────────╮   │
│ │                                                                     │   │
│ │                 (native webview — live page content)                │   │
│ │                                                                     │   │
│ ╰─────────────────────────────────────────────────────────────────────╯   │
└───────────────────────────────────────────────────────────────────────────┘
```

URL Card open (technique 2 — hide-while-open, tile-scoped):

```
│              ╭──────╮ ╭───────────────╮ ╭──────╮                              │
│              │ tab 1│ │ ● example.com │ │ tab 3│                              │
│              ╰──────╯ ╰───────────────╯ ╰──────╯                              │
│        ┌──────────────────────────────────────────┐                          │
│        │ 🔍 https://example.com/dashboard          │  ← centered in the TILE  │
│        └──────────────────────────────────────────┘                          │
├───────────────────────────────────────────────────────────────────────────┤
│     (this tile's webview hidden — only tiles whose rect intersects this     │
│      card's rect are affected; sibling Browser tiles stay live)             │
```

Find Bar open (technique 1 — spatial disjointness, page.y shrinks):

```
│ [←][→] [⟳]   ╭──────╮ ╭───────────────╮ ╭──────╮      [+]  [⌂][machine▾][★][⛶] │
├───────────────────────────────────────────────────────────────────────────┤
│  🔍 [ query…                          ]   3 / 12    [˄] [˅] [×]             │ ← new slim row, h-8
├───────────────────────────────────────────────────────────────────────────┤ ← page.y now starts here
│                     (native webview — still live and interactive,           │
│                      just vertically shorter; nothing is hidden)            │
```

Zoom "HUD" is not a positioned overlay at all — see §3.6.

### 3.2 File layout

Per the one-component-per-file convention, `BrowserTile.tsx` (currently one
541-line file) splits into:

| File | Responsibility |
|---|---|
| `BrowserTile.tsx` | orchestration: store wiring, native-webview lifecycle effects (unchanged from today), composes the pieces below |
| `BrowserToolbar.tsx` | back/forward, reload↔stop, right-hand DevDeck cluster |
| `BrowserTabStrip.tsx` | the tab strip (§3.3), owns the animated-width logic from §4 |
| `browserTabWidth.ts` | the pure width function from §4.2 — no React, unit-tested |
| `BrowserUrlCard.tsx` | §3.4, hide-while-open |
| `BrowserFindBar.tsx` | §3.5, spatially-disjoint inserted row |
| `BookmarkDialog.tsx` | unchanged, existing file |

### 3.3 Toolbar

Fixed single row, `h-9` (36px), never wraps — this alone recovers most of
the vertical space §1.1 identifies, because the always-visible address
`<Input>` (the thing that was forcing the wrap) is gone (§3.4).

```
className="flex h-9 flex-none items-center gap-1 border-b border-devdeck-border bg-devdeck-bg px-2"
```

**Left cluster (browser-standard, mirrors terminal-browser 1:1):**

- Back + Forward, rendered **as a pair**, and — matching terminal-browser's
  rule exactly — the pair renders **only if `canGoBack || canGoForward`**.
  A fresh tab with no history shows neither button, not a permanently
  disabled pair (today's DevDeck always renders both, always-enabled-or-not;
  this changes to match the reference).
- Reload ↔ Stop: same button/position, icon swaps `RefreshCw` ↔ `X` bound to
  `doc.loading`. Requires the `on_page_load` payload fix (§6.1) — without
  it `loading` flips back to `false` almost immediately after every
  navigation, and the icon would never visibly show "Stop."

Both reuse `Button size="icon-sm" variant="secondary"` unchanged, plus the
existing `toolbarButtonClass` (`pointer-coarse:h-9 pointer-coarse:w-9`,
`BrowserTile.tsx:100`) verbatim.

**Center: tab strip**, `flex-1`, see §3.3.

**Right cluster — where the DevDeck-specific controls live.** Terminal-browser
has nothing here at all (its tab strip is the last element); this is the
one deliberate structural addition DevDeck makes to the reference layout,
because these four controls have no browser-standard equivalent:

- **Home** (`Home` icon) — go to this doc's bookmarks/new-tab landing page.
  Moved here from the old left-side position: it's a DevDeck concept
  (per-doc landing page), not a universal browser control, so it belongs
  with the other DevDeck-specific affordances, not mixed into the
  browser-standard back/forward/reload cluster.
- **Machine picker** (`Select`, unchanged component/behavior).
- **Bookmark star** (unchanged `Button`, unchanged `BookmarkDialog`).
- **Fullscreen toggle** (unchanged `Button`).

No extra divider is needed between the two clusters — the tab strip's own
`flex-1` already separates them, the same way terminal-browser's tab strip
separates its left cluster from empty space.

### 3.4 Tab strip (static shape — motion is §4)

Pill: `h-7` (28px), `rounded-full`, `px-3`, internal `gap-1.5`.

- **Background:** `bg-devdeck-elevated` when `tab.active && docs.length > 1`
  — matching terminal-browser's `single` rule exactly: with only one doc
  open in the tile, no pill background is drawn at all (nothing to
  distinguish, and it stops the lone tab from reading as a button).
- **Hover:** `hover:bg-devdeck-hover-wash` on every non-active pill.
- **Label:** active tab shows a display URL (scheme + trailing slash
  stripped — a small pure helper, `displayUrl(url): string`); inactive
  shows `doc.title`. `text-[11px]`, active `text-devdeck-fg`, inactive
  `text-devdeck-muted`, `truncate`.
- **Favicon slot:** `h-4 w-4` (16px), `rounded-[3px]`, reuses the existing
  `BookmarkIcon` chip-fallback component (`BrowserTile.tsx:81-95`) since
  real favicons are deferred (§2). Slot dimensions are reserved now so
  wiring in `browser-tile-favicon-changed` later doesn't reflow the pill.
- **Close button:** a fixed `w-5 h-5` slot, `ml-1`, always present in
  layout — swaps only its *content* (empty vs. an `X` button) on hover,
  never inserts/removes the slot, so hovering never shifts a neighboring
  pill's position. Desktop: `opacity-0 group-hover:opacity-100`. Touch:
  always visible via the existing `pointer-coarse:opacity-100` idiom
  (`BrowserTile.tsx:405`).
- **Click behavior:** clicking the **active** pill's label opens the URL
  Card (§3.4b); clicking an **inactive** pill switches to it
  (`selectBrowserDoc`) — single click, no two-step, matching terminal-browser.
- **Container:** `flex-1 flex items-center justify-center gap-1 overflow-hidden px-2`
  — centered (not left-anchored), clips rather than scrolls when tabs don't
  fit (each pill's own `truncate` lets labels compress before the outer
  clip engages — matches terminal-browser's explicit no-scroll-affordance
  choice).
- **Trailing `+`:** `h-6 w-6 rounded-full hover:bg-devdeck-hover-wash`,
  `Plus size={12}`, calls the existing `addBrowserDoc(tabId)` directly — a
  blank internal doc, no modal. (This is *internal* new-doc creation within
  one tile; it is not the "open something from anywhere" job the palette
  owns, so §2's palette carve-out doesn't apply here.)

### 3.4b URL Card (technique 2 — hide-while-open, tile-scoped)

Not a global palette-style search surface (§2) — a minimal, single-purpose
editor for the active doc's own URL, matching the approved chrome language
("no persistent address bar; click the tab pill or `Cmd/Ctrl+L` opens a
centered modal card").

- **Trigger:** click on the active tab pill's label, or `Cmd/Ctrl+L` while
  this tile is the focused leaf's active Browser tab.
- **Positioning:** `position: absolute` **inside** the tile's own
  `@container/tile` wrapper (not a `Dialog` portal to `document.body`) —
  centered on the *tile's* width, not the viewport's: `width: min(28rem, 100cqw - 4rem)`.
  `top` anchored just below the toolbar (`top: theme toolbar height + 0.75rem`).
- **Shell:** `rounded-[13px] border border-devdeck-border-menu bg-devdeck-card`,
  matching the existing `Dialog`/`TabStripPopoverMenu` shadow/radius idiom —
  `bg-devdeck-card` specifically because report C flags that a floating card
  should step up one surface level from the chrome's own `bg-devdeck-bg`,
  exactly what `dialog.tsx` already does.
- **Content:** leading search icon, `Input` (`h-8`, `text-[12px]`), value
  bound to the existing `draft` state, `onSubmit` navigates and closes. No
  suggestions list.
- **Dismissal:** `Escape` or a click on the tile-scoped invisible backdrop
  (a `<div>` sibling behind the card, `absolute inset-0`, `onClick={close}`,
  no visual scrim — same "click outside to dismiss" pattern report A
  documents for terminal-browser's own modal cards) reverts `draft` to
  `doc.url` without navigating.
- **Occlusion:** opening it pushes a blocker scoped to **this tile's own
  rect** (§5), not `'viewport'` — the machine-picker `Select` already only
  ever needs to hide its own tile too; this is the first component built
  against the new scoped system from day one instead of inheriting the old
  global-hide default.

### 3.5 Find Bar (technique 1 — spatially disjoint, inserted row)

Terminal-browser's `FindBar` floats as a corner overlay because in that
source the page is just another canvas layer underneath it. That doesn't
translate here (§3.0): a DOM find bar floating over the *live, still
type-into-able* page would render invisibly behind the webview, and hiding
the webview to make the input visible would defeat the entire point of a
find bar (searching text on a page you can no longer see). The chrome
therefore does **not** float — it inserts a slim row between the toolbar
and the page surface, shrinking `bodyRef`'s rect (and therefore the
webview's bounds) by its own height. This is exactly the mechanism that
already lets the main toolbar coexist with the webview today; the find bar
just becomes a second, conditional instance of it.

- **Row:** `h-8` (32px), `flex items-center gap-2 border-b border-devdeck-border bg-devdeck-bg px-2`,
  inserted directly below the toolbar, above the page-surface wrapper.
- **Content:** search icon → `Input` (`flex-1`, `text-[11.5px]`) → match
  count (`text-[10.5px] text-devdeck-muted`, `"{active}/{total}"` or empty)
  → three `h-6 w-6` icon buttons (previous, next, close).
- **Open:** a Find icon added to the toolbar's right cluster, or
  `Cmd/Ctrl+F` while this tile is the focused leaf's active Browser tab —
  confirm this chord is unbound elsewhere in DevDeck before claiming it,
  the same collision check the palette spec did for `Cmd/Ctrl+K`.
- **Close:** `Escape`, or the close button. `Enter` = find next,
  `Shift+Enter` = find previous, matching terminal-browser's binding.
- **Backend:** `browser_tile_find`/`browser_tile_find_clear` (§6.1) — a
  small injected TreeWalker/`Range` highlighter, per report D's own
  "cheap zero-Rust-dependency MVP" recommendation. No native
  `WKWebView.findString` this round (§2).
- **Occlusion:** none needed — spatially disjoint from the webview by
  construction, so it never calls `useNativeOverlayBlocker` at all.

### 3.6 Zoom "HUD"

Not a bespoke absolutely-positioned card, per report C's own observation
that this is exactly the job `sonner` already does. A floating corner HUD
would hit the identical invisible-behind-the-webview problem §3.5 just
solved for Find, and reserving persistent layout space for a 1.5s transient
toast would jank the page size on every zoom keypress — neither option is
acceptable, so it routes through the one overlay class DevDeck has already
solved this exact problem for at the app level: `routes/__root.tsx`'s
`Toaster` already renders `position="top-center"` specifically so it never
overlaps a Browser tile's placeholder rect.

- **Trigger:** `Cmd + (=, +, -, _, 0)` while this tile is focused, same
  chords as terminal-browser.
- **Implementation:** `toast(`${Math.round(factor*100)}%`, { id: 'browser-zoom', duration: 1500 })`
  — a stable `id` means a repeated zoom keypress *replaces* the existing
  toast and resets its timer instead of stacking a new one, reproducing
  terminal-browser's "resets on every repeated zoom keypress" behavior
  (report A §4) without a bespoke timer.
- **Backend:** `browser_tile_set_zoom` (§6.1).

### 3.7 Page surface frame

Report A's reference has a two-box nested-radius trick (an outer 1px stroke
box plus an inner background-filled surface box) because in a canvas
renderer the "surface box" *is* the rendered page. In DevDeck the
equivalent rect is always the webview itself — there is nothing to fill,
the webview already paints its own background. Only the outer ring is DOM
chrome, and it's safe precisely because it sits **outside** the webview's
bounds (§3.0's spatial-disjointness technique), so it can never be occluded:

```
className="border border-devdeck-border-card rounded-b-lg"
```

applied to the existing wrapper `<div className="relative min-h-0 min-w-0 flex-1">`
(`BrowserTile.tsx:476`) that already contains `bodyRef`. No devtools-docking
seam logic (report A §5's `seamRadius`) is needed — DevDeck has no docked
devtools pane.

### 3.8 Responsive / narrow-tile behavior

`@container/tile` stays exactly as it is today (`BrowserTile.tsx:381`); the
existing named container breakpoints (`@sm/tile`, `@md/tile`, `@lg/tile` —
Tailwind v4's default 24rem/28rem/32rem scale, already in use at
`BrowserTile.tsx:427,437,445,462`) are reused, not replaced.

Removing the persistent address-bar `<Input>` frees enough toolbar width
that **the toolbar no longer needs to wrap in the common case** — this is
itself a large part of fixing §1.1's cramped feel. The floor case that
still needs a fallback is an extreme split (four-plus panes on a small
laptop): below `@sm/tile` (24rem), the right-hand DevDeck cluster (Home,
Machine picker, Bookmark, Fullscreen) collapses behind a single "…"
trigger, reusing the existing `TabStripPopoverMenu` primitive verbatim (it
already exists, is already overlay-blocker-aware, and is already used for
an equivalent overflow-menu job elsewhere). Back/Forward/Reload and the tab
strip are never collapsed — they're the browser-standard cluster and stay
visible at any width, clipping/truncating via the tab strip's own
`overflow-hidden` before anything else gives.

Touch targets are unchanged from today's pattern: every toolbar button
keeps `pointer-coarse:h-9 pointer-coarse:w-9`, the tab-close reveal keeps
`pointer-coarse:opacity-100`, the `Select` trigger keeps its pointer-coarse
height bump. The Input inside the URL Card keeps the existing
`pointer-coarse:text-[16px]` rule (`BrowserTile.tsx:445`'s comment about
mobile Safari auto-zoom on focus applies identically here).

## 4. The animated tab strip

### 4.1 CSS transitions, not a JS interpolation loop

DevDeck already solves the identical "animate a box's width smoothly"
problem twice with plain CSS: `DBImportWizard.tsx:471` and
`TransferStatusPanel.tsx:50` both animate a progress bar's width with
`transition-[width] duration-200`, and `WorkspaceTileCanvas.tsx`'s own
existing tab strip already uses `transition-[...] duration-150` for
color/opacity state with no interpolation loop at all. Terminal-browser's
hand-rolled `setInterval(16)` easing loop (report A §8.1) exists **only**
because its rendering target is a GPU canvas with no CSS engine to hand the
interpolation to — that constraint is specific to `pixel-react` and does
not apply to DevDeck's plain DOM/Tailwind stack, where the compositor
already performs the equivalent of an exponential ease-out via the
`ease-out` timing function, for zero JS ticks, zero forced re-renders, and
correct interruption/retargeting for free (a CSS transition re-eases from
its current computed value automatically if the target changes mid-flight —
terminal-browser's loop has to implement that by hand). The only piece of
the reference worth porting as-is is the pure target-*width* math (§4.2);
the interpolation loop around it is exactly what `transition-[width]
duration-200 ease-out` replaces outright.

### 4.2 The pure width-layout function

```ts
// frontend/src/features/browser/browserTabWidth.ts
export interface TabWidthInput {
  labelLength: number   // display label's character count
  hasFavicon: boolean
  isActive: boolean
}

export function tabPillTargetWidth(input: TabWidthInput): number
```

Translated from terminal-browser's `target()` (report A §2), with DevDeck's
own metrics substituted for its rem-based terminal-cell ones:

```ts
const CHAR_W = 6      // estimated px/char at text-[11px] — same category of
                       // estimate as the reference's own "estimated glyph
                       // width", not exact (DevDeck's font is proportional,
                       // not the reference's monospace terminal cell)
const CLOSE_W = 20     // the reserved close-slot, §3.3
const CLOSE_GAP = 6
const FAVICON_W = 16
const FAVICON_GAP = 6
const BASE_PAD = 24    // px-3 both sides
const MIN_WIDTH = 72
const MAX_WIDTH = 220

export function tabPillTargetWidth(input: TabWidthInput): number {
  let width = BASE_PAD + Math.min(input.labelLength, 28) * CHAR_W
  if (input.hasFavicon) width += FAVICON_W + FAVICON_GAP
  if (input.isActive) width += CLOSE_W + 6   // extra reserved space, active only —
                                              // mirrors the reference's literal
                                              // doubling for the highlighted pill
  width += CLOSE_W + CLOSE_GAP               // unconditional close-slot reservation
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}
```

`MIN_WIDTH`/`MAX_WIDTH` clamping is a DevDeck-specific addition, not present
in the reference — necessary because `CHAR_W` is a calibrated estimate
against a proportional font rather than an exact per-cell size, so
degenerate inputs (empty label, a 200-character title) need a floor and
ceiling the reference didn't need to worry about.

`single`/`ghost` are deliberately **not** inputs to this function — per
report A, they only affect the pill's *background* (§3.3) and lifecycle,
never its width formula, and this port keeps that separation.

### 4.3 Mechanics on top of the pure function

- **Applying it:** `style={{ width: `${tabPillTargetWidth(input)}px` }}`,
  `className="transition-[width] duration-200 ease-out"` on the pill.
- **Grow-in (new tab):** mount at `width: 0`, then set the real computed
  width on the next frame (a `useEffect` after mount, or
  `requestAnimationFrame`) so the transition has a starting value to
  animate from — the standard "measure then animate" DOM technique,
  replacing the reference's manual `{ width: 0, ghost: false }` entry.
- **Ghost/shrink-out (closing tab):** on close, the pill's own target width
  becomes `0` (not removed from the DOM immediately); an `onTransitionEnd`
  handler (or a `setTimeout` matching the 200ms duration as a fallback)
  removes it from render once the shrink finishes — the CSS-transition
  equivalent of the reference's "stays in the Map until width hits 0, then
  spliced out."
- **No `setInterval`, no `useRef` entry map, no forced re-render loop** —
  each pill just re-renders (React's normal path) whenever its own inputs
  change; the browser's compositor owns everything between renders.

### 4.4 Testing

`browserTabWidth.test.ts` (Vitest, per report C's correction that this is
now the live convention — see §9) locks down: short label, label clamped
at 28 chars, with/without favicon, active vs. inactive, and the
`MIN_WIDTH`/`MAX_WIDTH` clamp boundaries.

## 5. Occlusion-aware visibility

This is the core of the change: replacing the bare global counter with a
keyed collection of overlay regions, so a Browser tile only ever hides for
an overlay that actually overlaps it.

### 5.1 Store shape

```ts
// frontend/src/store/types.ts — purely frontend UI state, no backend
// counterpart; the CONTRACTS.md domain-type-mirroring rule doesn't apply.
export interface OverlayBlockerRect {
  left: number
  top: number
  right: number
  bottom: number
}

export type OverlayBlockerRegion = OverlayBlockerRect | 'viewport'
```

```ts
// store/useDevDeckStore.ts — replaces nativeOverlayBlockers: number
nativeOverlayBlockers: Record<string, OverlayBlockerRegion>

pushNativeOverlayBlocker: (id: string, region: OverlayBlockerRegion) => void
popNativeOverlayBlocker: (id: string) => void
```

An empty object is the exact equivalent of today's `nativeOverlayBlockers === 0`
— "nothing is blocking anywhere." `'viewport'` is a first-class region value
(not a special rect) representing a full-viewport overlay: a modal backdrop,
the mobile sidebar drawer — anything that conceptually covers the whole app
and should hide every Browser tile it could possibly overlap, same as
today's behavior for those specific cases. Neither field is added to
`partialize` — stays unpersisted, exactly like today's counter and like
`tileDragActive`.

### 5.2 Hook signature — stays a drop-in for all ~11 existing call sites

```ts
export function useNativeOverlayBlocker(
  active: boolean,
  rectRef?: React.RefObject<HTMLElement | null>,
): void
```

`rectRef` is optional. Every one of the 11 existing bare calls —
`dialog.tsx:21`, `drawer.tsx:17`, `select.tsx:31`, `combobox.tsx:24`,
`tooltip.tsx:22,48`, `tab-strip-popover-menu.tsx:28`,
`FileQuickOpen.tsx:68`, `ContentSearchPanel.tsx:100`,
`WorkspaceTileCanvas.tsx:746`, `Sidebar.tsx:47` — keeps compiling and
behaving **exactly as it does today** (region `'viewport'`, blocks every
tile) without a single line changed at the call site. This is what makes
the migration safe to land incrementally: the type/store change is
zero-risk on its own, and each call site opts into precision independently
afterward.

```ts
export function useNativeOverlayBlocker(active, rectRef) {
  const push = useDevDeckStore((s) => s.pushNativeOverlayBlocker)
  const pop = useDevDeckStore((s) => s.popNativeOverlayBlocker)
  const id = useId()          // stable per hook instance

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
  }, [active, rectRef, push, pop, id])
}
```

`useId()`, not `crypto.randomUUID()` in a ref — it's already the idiomatic
React primitive for a stable per-instance identity and avoids a manual ref
just to hold one.

### 5.3 Migrating call sites to precise rects — where the actual fix lives

The signature change alone fixes nothing by itself (an un-migrated Tooltip
call still defaults to `'viewport'`, identical to today). The value comes
from supplying `rectRef` at the sites that are the actual source of §1.2's
constant-blink complaint — every one of them is a positioned popover/
tooltip/menu with a real DOM anchor already available:

| Call site | Rect source |
|---|---|
| `tooltip.tsx:22,48` | the tooltip's own `Popup` element ref — **highest priority**, this is the §1.2 worst offender |
| `select.tsx:31` | the `Select.Popup` element ref |
| `combobox.tsx:24` | the `Combobox.Popup` element ref |
| `tab-strip-popover-menu.tsx:28` | the `Popover.Popup` element ref |
| `WorkspaceTileCanvas.tsx:746` (drag ghost) | the `DragOverlay` element's own ref (it already tracks a real on-screen rect following the pointer) |
| `ContentSearchPanel.tsx:100` | the panel's own bounded element ref, if it renders as a fixed-size panel rather than a full-height overlay |
| `dialog.tsx:21`, `drawer.tsx:17`, `Sidebar.tsx:47`, `FileQuickOpen.tsx:68` | **stay `'viewport'`, unmigrated, intentionally** — a modal backdrop, the mobile drawer, and a large centered quick-open dialog are conceptually full-app overlays; precision buys nothing here and risks under-hiding a tile a translucent backdrop should have covered |

This table is illustrative for the implementation plan, not exhaustive —
the rule of thumb is: migrate anything small, frequent, and positioned;
leave anything that is itself meant to visually dominate the whole app as
`'viewport'`.

### 5.4 The decision rule (pseudocode)

```
function tileShouldBeHidden(tileRect, blockers, tileDragActive):
  if tileDragActive:
    return true                          // interactive drag — always immediate, no geometry needed

  for region in values(blockers):
    if region == 'viewport':
      return true
    if rectsIntersect(tileRect, region):
      return true

  return false

function rectsIntersect(a, b):
  return a.left < b.right and a.right > b.left
     and a.top  < b.bottom and a.bottom > b.top
```

`BrowserTile.tsx`'s existing show/hide effect (`:225-236`) changes shape
but not architecture — still an effect reacting to store state plus the
tile's own measured rect, just replacing `nativeOverlayBlockers > 0` with
`tileShouldBeHidden(rect, blockers, tileDragActive)`:

```ts
useEffect(() => {
  if (!doc?.url || !openedDocsRef.current.has(doc.id)) return
  const el = bodyRef.current
  if (!el) return
  const rect = el.getBoundingClientRect()
  if (tileShouldBeHidden(rect, nativeOverlayBlockers, tileDragActive)) {
    void hideBrowserTile(tabId, doc.id)             // immediate — see §5.6
    return
  }
  scheduleShow(tabId, doc.id, () => bodyRef.current?.getBoundingClientRect())  // debounced — see §5.6
}, [nativeOverlayBlockers, tileDragActive, tabId, doc?.id, doc?.url])
```

### 5.5 Making the counter-leak failure mode impossible, not just smaller

Two independent fixes, addressing two different failure classes:

1. **The known, concrete leak vector (finding in §1.2): `tileDragActive`
   set from raw pointer handlers with no unmount guarantee.** Add an
   `onLostPointerCapture={handlePointerUp}` handler alongside the existing
   `onPointerUp`/`onPointerCancel` on the divider element. `lostpointercapture`
   is a standards-guaranteed event: it fires whenever pointer capture ends
   for **any** reason — explicit release, cancellation, or the OS stealing
   the gesture — which is exactly the case `onPointerCancel` alone doesn't
   reliably cover. This closes the root cause at the source, using a
   platform guarantee rather than a workaround. Additionally, route the
   divider's drag-active boolean through `useNativeOverlayBlocker(dragging, ref)`
   itself instead of the bespoke `tileDragActive` store field — so if this
   drag flag *is* ever left stuck by some future code path, its blocker
   entry still automatically pops on divider-element unmount, the same
   effect-cleanup guarantee every other call site already gets for free.
2. **Any future/unknown leak vector.** Because every blocker is now scoped
   to a caller-owned id in a `Record`, one stray entry can only ever hide
   the Browser tiles whose rects intersect *that one region* (or, in the
   worst case where the leaked push happened to be `'viewport'`, every
   tile — same blast radius as today, not worse). What is structurally no
   longer possible is a single bug freezing the feature app-wide until
   restart while every *other* still-correctly-managed overlay's entries
   continue popping normally around it — today's bare counter has no such
   isolation, one stuck increment poisons the shared total forever.

### 5.6 Flicker: immediate hide, debounced show

- **Hide is always immediate**, no debounce, no `requestAnimationFrame`.
  The webview always paints above the DOM, so any frame where it's still
  shown while an overlay is supposed to be in front of it is a visible
  glitch — the exact bug this whole redesign removes. Latency on hide is
  directly visible; it must be zero.
- **Show is coalesced behind one `requestAnimationFrame`.** If the
  hidden/shown decision flips rapidly (e.g. a popover repositioning across
  a couple of paint frames while it animates open, or two blockers pushing/
  popping in the same tick), firing an actual `hideBrowserTile`/
  `showBrowserTile` IPC round trip to Rust for every intermediate state
  reproduces the exact stutter this spec exists to remove. `scheduleShow`
  cancels any pending scheduled show the instant a new hide is requested,
  and only issues the real `showBrowserTile(...)` call — with a **freshly
  measured** rect at the moment the callback actually runs, not the rect
  from when it was scheduled — on the next animation frame if the tile is
  still not supposed to be hidden by then. This collapses a hide-then-show
  flicker within the same frame into nothing, and it composes correctly
  with `browser_tile_show`'s own existing "reassert bounds, then show"
  ordering (`browser_tiles.rs:179-194`) — no stale-rect flash on the far
  side either.

## 6. Native (Rust) changes

Only the minimal set from report D's own priority-ordered recommendation
that this spec's chrome actually depends on.

### 6.1 In scope, priority order

1. **Fix the `Started`/`Finished` conflation in `on_page_load`**
   (`lib.rs:73-86`). Today it ignores `PageLoadPayload::event()` and fires
   the identical `browser-tile-page-load` event for both phases, so
   `loading` flips back to `false` almost immediately after every
   navigation — already effectively a no-op. Branch on `payload.event()`
   and add a `loading: bool` field to the emitted payload:
   `{ label, url, loading }`. Trivial; **blocks §3.3's reload↔stop icon
   swap from ever working** if skipped.
2. **`browser_tile_set_zoom`** — thin wrapper over the already-public
   `Webview::set_zoom`:
   ```rust
   #[tauri::command]
   pub fn browser_tile_set_zoom(
       state: tauri::State<'_, BrowserTiles>,
       tab_id: String,
       doc_id: String,
       scale: f64,
   ) -> Result<(), String>
   ```
   Same shape as the existing `browser_tile_reload`. Trivial; unlocks
   §3.6's Zoom toast outright. No getter exists on the Tauri side, so the
   frontend owns the current zoom level as source of truth (clamp 50–300%
   in fixed steps).
3. **Occlusion-aware visibility (§5) needs zero Rust change.** `hide()`/
   `show()` already map to a single `NSView.setHidden:` flip
   (`wry-0.55.1/src/wkwebview/mod.rs:534,1031-1032`) — the cheapest
   possible occlusion primitive already exists. The entire fix is
   frontend-side: deciding *when* to call the existing
   `hideBrowserTile`/`showBrowserTile` bridge functions, per §5.4's rule,
   instead of the blunt global-counter check.
4. **Find-in-page JS-eval MVP** — new commands, following report D's "hold
   the lock for the whole call body" guidance (unlike `browser_tile_open`'s
   release-then-reacquire pattern, which is TOCTOU-prone per report D §6):
   ```rust
   #[tauri::command]
   pub fn browser_tile_find(
       state: tauri::State<'_, BrowserTiles>,
       tab_id: String,
       doc_id: String,
       query: String,
       direction: String,   // "next" | "prev"
   ) -> Result<FindResult, String>   // FindResult { active: u32, total: u32 }

   #[tauri::command]
   pub fn browser_tile_find_clear(
       state: tauri::State<'_, BrowserTiles>,
       tab_id: String,
       doc_id: String,
   ) -> Result<(), String>
   ```
   Implemented via `webview.eval_with_callback(js, callback)` (the same
   idiom report D recommends for the deferred favicon feature, and the
   idiom `on_document_title_changed` already uses) running a small
   `TreeWalker`/`Range` highlighter injected per call — no new Cargo
   dependency, rated **Low** effort by report D specifically because it
   reuses this file's existing eval/emit pattern rather than adding the
   `WKFindConfiguration`/`WKFindResult` feature flags the native path
   needs. Both require new entries in
   `frontend/src-tauri/permissions/browser-tiles.toml`.

### 6.2 Deferred

- **Native `WKWebView.findString`** — see §2. Revisit once find-in-page's
  JS-eval MVP proves the feature is worth the unsafe-macOS surface.
- **Native `canGoBack`/`canGoForward`/`goBack`/`goForward`** — see §2 and
  §7. The 07-31 plan's still-open Task 4 (JS-array history tracking) is
  the near-term fix; this would supersede it later, not now.
- **Favicon via `eval_with_callback`** — see §2. Tab pills use the
  existing chip fallback (§3.3) until this lands.
- **`Mutex` poison recovery, `browser_tile_open` TOCTOU, double-close
  silent-error swallowing** (report D §6) — real robustness gaps, but
  orthogonal to chrome/occlusion and not required for anything in this
  spec to function correctly. Worth a dedicated follow-up, not bundled
  here to keep this change reviewable.

## 7. Relationship to the 2026-07-31 plan

| Task | Status before this spec | Disposition |
|---|---|---|
| 1 — `tileDragActive` flag | **Landed** (`bbe1c03`) | Kept, not reverted. Migrated to route through `useNativeOverlayBlocker` itself (§5.5) instead of its own bespoke boolean, and gains the `onLostPointerCapture` fix that closes the leak in the landed version. |
| 2 — drag-ghost blocker (`WorkspaceTileCanvas.tsx:746`) | **Landed** (inside `451dc6a`, a docs commit — hygiene gap, not a code gap) | Kept, not reverted. Behaviorally identical `active` boolean; migrates from an implicit `'viewport'` region to the `DragOverlay` element's own rect per §5.3's table. |
| 3 — proxy-start error handling | **Not landed** (`browserProxy.ts` exists, untracked, unwired) | Out of scope here — still owned by the 07-31 plan. Land it as originally written; nothing in this spec depends on or conflicts with it. |
| 4 — in-page nav history tracking | **Not landed** | Out of scope here — still the correct near-term fix (§2, §6.2). Do not let native back/forward's later availability be used as a reason to skip landing this. |
| 5 — localhost → machine rewrite | **Not landed** | Out of scope, unaffected. Land independently. |
| 6–13 — nine z-index gaps (`TransferStatusPanel`, `WorkspaceSwitcher`, `DBExportMenu`, `TerminalExplorer` context menu, `PaneCanvas` drag ghost, `EnvProfileManagement` mobile sheet, `Terminal` find bar, two Markdown editors' slash menu) | **Not landed** | **Superseded in shape, not in intent.** Each site still needs exactly one `useNativeOverlayBlocker(active)` call, per the original plan — but implementers should use the new two-argument signature from §5.2 and supply a `rectRef` for any of these with a natural bounded anchor (most do: a context menu, a drag ghost, a slash-command menu are all positioned popups), rather than the plan's original bare-boolean call, which predates this redesign and would default every one of them to `'viewport'` unnecessarily. |

Nothing already landed is reverted or re-litigated; every still-open task
in the 07-31 plan remains valid and should land on its own schedule.

## 8. Risks + Rollback

**Risks**

1. **Rect-migration regressions are the single highest-risk change.**
   Moving a call site from always-`'viewport'` to a precise rect is exactly
   the kind of change that can silently under-hide a tile it should have
   covered — a regression back to §1.2's original bug class, not merely a
   leftover of it. Mitigation: the hook defaults to `'viewport'` when
   `rectRef` is omitted (§5.2), so an unmigrated or newly-added call site is
   always safe by default; migrate one call site at a time, starting with
   `Tooltip` (highest value, per §1.2), verified manually per this
   project's existing convention for overlay work.
2. **`BrowserTile.tsx` is touched by this spec, by the still-open 07-31
   Tasks 3–5, and by the 6–13 z-index tasks all at once.** Several touch
   the exact same functions (`navigate`, `openBookmark`,
   `ensureProxyForMachine`) this spec's URL-Card and Find-Bar wiring also
   touches. Sequence carefully — land 07-31's remaining tasks first or
   very deliberately interleaved, not blind-merged after this lands.
3. **The `on_page_load` payload-shape fix (§6.1.1) is a breaking change to
   an existing event.** Only one consumer exists today
   (`BrowserTile.tsx`'s listener), but it must be updated in the same
   commit as the Rust change — a split commit would silently break the
   loading indicator, not fail loudly.
4. **Find Bar's page.y-shrink approach (§3.5) resizes the webview on
   open/close**, going through the existing `ResizeObserver`-driven bounds
   tick rather than an instant layout change — a one-frame visible jump on
   open/close is possible and should be checked live; Rust's `set_size` has
   no interpolation primitive to smooth it, so if it's jarring in practice
   this is a follow-up polish item, not something blocking this spec.
5. **`CHAR_W` in §4.2 is a calibrated estimate**, not exact (DevDeck's
   proportional UI font vs. the reference's fixed terminal cell) — expect
   minor width jitter/clamping in practice, same category of imprecision
   the reference source itself accepts.

**Rollback**

- **§5 (occlusion-aware visibility) is additive-compatible on its own** —
  every existing bare `useNativeOverlayBlocker(active)` call keeps working
  unchanged (§5.2). Reverting is deleting the rect-migration commits only;
  no data migration, since the store field stays unpersisted exactly like
  today's counter.
- **§3/§4 (chrome, tab strip) are purely presentational.** Reverting is a
  straight file revert of the split-out `Browser*.tsx` files; no store or
  schema impact.
- **§6 (Rust) changes are additive** — a new command
  (`browser_tile_set_zoom`, `browser_tile_find`) is self-contained and
  removing it only orphans the feature it backs. The `on_page_load` payload
  fix must be reverted paired with its one frontend consumer (risk #3
  above), not independently.
- **Nothing in this spec touches the Go backend, `port.Store`, migrations,
  or `domain.Settings`.** There is no persisted-data rollback concern
  anywhere in this change.

## 9. Testing

Test-driven for every pure function, matching the palette spec's already-
established convention (Vitest, not the legacy hand-rolled `check`/
`assertEqual` style — report C confirms the hand-rolled convention is
mid-migration and no longer the one to follow for new files).

| Test file | What it locks down |
|---|---|
| `browserTabWidth.test.ts` | §4.2's clamp/formula boundaries: short label, 28-char clamp, favicon on/off, active/inactive, `MIN_WIDTH`/`MAX_WIDTH` |
| `useNativeOverlayBlocker.test.ts` (or a pure `tileShouldBeHidden` extracted to its own file) | §5.4's decision rule: `'viewport'` always hides, a non-intersecting rect never hides, an intersecting rect hides, `tileDragActive` short-circuits before any rect math |
| `displayUrl.test.ts` | scheme/trailing-slash stripping for the active tab's label (§3.3) |

Manual verification in the running desktop app (per project convention):
hover a tooltip far from any Browser tile and confirm it stays visible;
drag a divider fast across a split containing a Browser tile; open the URL
Card and confirm only that tile hides, not a sibling Browser tile in
another split; open Find and confirm the page stays live and interactive
while typing; trigger a zoom chord repeatedly and confirm the toast resets
its timer instead of stacking.

Verification gates: `npm --prefix frontend run typecheck`,
`npm --prefix frontend test`, `npm --prefix frontend run build`.

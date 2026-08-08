# Glass and Flat: DevDeck Visual Retune

## Problem

DevDeck's chrome carries more visual apparatus than it needs. The token layer
in `frontend/src/styles/globals.css` defines **seven** surface values
(`bg`, `surface`, `surface-2`, `card`, `terminal`, `popover`, `elevated`),
**four** border values, and **seven** text values. Every boundary in the app is
drawn with a hairline: `border-devdeck-border` alone appears **440 times across
120 files**. The teal accent `#39c6bd` is used **229 times**
(`bg-devdeck-accent` 100, `text-devdeck-accent` 129), which means it no longer
signals anything in particular.

The result reads as busy for an app whose job is to hold terminals, editors,
and file trees for hours at a time. The operator's words: *"kerja udah stress,
jangan membuat DevDeck-nya numpuk"* — the work is already stressful, don't make
DevDeck pile up on top of it.

A reference screenshot (a macOS agent client) was used to calibrate. Pixel
sampling of that image, not visual estimation, established the target:

| Sampled region | Value |
|---|---|
| Entire content area (title row, code, status row, prompt) | `#1c1c1d`, one flat value |
| The only raised surface (two pills, top-right) | `#282829` |
| Sidebar, neutral regions | L 21-25%, **S 2-3%** (native macOS vibrancy) |
| Sidebar, over strong orange wallpaper | L 19%, S 30-32% |
| Active sidebar row | `#1d1d1d` — **darker** than the glass around it |
| Text hierarchy | three levels only |
| Diff bands | `#3d0100` / `#012801`, full-bleed, no border, no radius |

Two findings from that sampling corrected assumptions that would otherwise
have shipped:

1. The reference sidebar is **lighter** than its content area (L 23% vs 11%).
   An early draft had the relationship inverted.
2. Its corner profile measures `8,6,4,3,3,2,1,1,0` px. A circular arc of radius
   8 would measure `8,4.6,3.1,2.0,1.3,0.8,0.4,0.1,0`. The slow start and long
   tail is a **squircle** (macOS continuous corner), which is what reads as
   "smoother".

## Goals

- Reduce the surface count from seven to two, plus one state wash.
- Remove structural hairlines without touching 120 component files.
- Narrow the accent to a single, measurable job.
- Adopt macOS vibrancy on the Tauri build without introducing new layers.
- Fix accessibility defects the retune exposes, and record the ones we
  deliberately accept.

## Non-Goals

- **Tab labels are not changed.** `worktreeTabLabel` in
  `frontend/src/lib/worktreeLabel.ts:44` composes `project.name + "/" +
  machineName` as the prefix. This already carries the project. It degrades
  when several tabs share one project (the prefix repeats and eats the width
  that the distinguishing branch name needs), but the operator chose to leave
  it. Grouping tabs by project is a separate future spec.
- **The two tab strips stay.** The top full-width strip
  (`WorkspaceTileCanvas.tsx:659`, `fixed top-0 z-40 h-10`) and the per-pane
  strip both remain, in their current positions.
- **The terminal renderer is not touched.** See "Terminal stays opaque" below.
- No information-architecture changes, no route changes, no component moves.

## What already exists

Worth stating, because it removes work people would otherwise plan for:

- `frontend/src-tauri/tauri.macos.conf.json` already sets
  `titleBarStyle: "Overlay"`, `hiddenTitle: true`, and
  `trafficLightPosition: {x: 12, y: 18}`. The title bar is already hidden.
- `WorkspaceTileCanvas.tsx:19,667` already reserves a 76px traffic-light gutter
  with `data-tauri-drag-region`, and `w.$wsId.tsx:94` already reserves `pt-10`
  for the pinned strip.
- `w.$wsId.tsx:100` already skips `Header` on the Tauri build; the tab strip is
  the top bar.
- `Sidebar.tsx` already has a `mobileDrawer` path with `max-md:fixed` overlay
  behaviour.

So this spec is a token and material change, not a chrome rebuild.

---

## Design

### 1. Surfaces

Two materials, plus one state wash. The sidebar card is not a third material;
it is the glass with a wash on top, for the reason given below.

```
window backdrop   native macOS vibrancy (Tauri) / solid (web, see Open Decisions)
  └ glass layer   covers the ENTIRE window; the wallpaper only shows through it
      ├ sidebar card   glass + rgba(255,255,255,.055)
      └ pane card      #1c1c1d, opaque
```

The glass layer covers the whole window, not just the sidebar. This was an
explicit correction: an earlier draft applied glass only to the rail and
sidebar, which let the raw wallpaper bleed through the gaps around the pane and
produced a bright band at the window's bottom edge. Covering everything means
the wallpaper acts purely as a colour cast.

The **rail** is a bare column on the glass with no card of its own.
The **top tab strip** is part of the glass layer (not darkened). This was
compared against a darker strip and the lighter one was kept.

The sidebar card needs the `rgba(255,255,255,.055)` wash for a mechanical
reason, not a decorative one: if it were the same value as the gap around it,
its rounded corners would have nothing to read against and would be invisible.
The same failure was found and fixed earlier at the sidebar's right edge.

**Glass recipe (CSS, for web and for the mockups):**

```css
background: rgba(63, 62, 59, 0.80);
backdrop-filter: blur(48px) saturate(0.34) brightness(0.92);
```

`saturate(0.34)` is the load-bearing value. An earlier draft used
`saturate(1.5)`, which *increases* saturation; macOS sidebar vibrancy does the
opposite. Measured against the same wallpaper, the wrong recipe produced
S 20-72% where the reference sits at S 2-3%.

**On Tauri, do not use this CSS.** Use the native material via Tauri's
`windowEffects` with the `sidebar` effect. It is the same engine the reference
uses, it is composited by the OS rather than blurred inside the webview, and it
handles wallpaper variance better than any CSS approximation.

### 2. Geometry

- Gap between cards: **8px**. Also 8px from the window edge.
- Cards: pane and sidebar. Each split leaf is its own pane card.
- Splits nest as they do today (`tileTree.ts`); nothing about the tree changes.

Measured space cost, so it is on the record:

| Layout | Gaps | Tab strips | Cost at 1400x900 |
|---|---|---|---|
| Single | - | 29px | 3.2% vertical |
| Split 2 (horizontal) | 8px horizontal | 29px | 3.2% vertical, 0.6% horizontal |
| Split 3 and Split 4 | 8px each axis | 29 + 29px | 7.3% vertical, 0.6% horizontal |

The expensive part is stacked tab strips in vertical splits (66px, about five
terminal rows), and that cost **exists today**. This design's own contribution
is 8px per gap.

### 3. Radius scale

Three steps. No other value may appear.

| Token | Value | Applies to |
|---|---|---|
| `--r-container` | 14px | pane card, sidebar card, dialogs, popovers |
| `--r-control` | 10px | tabs, tree rows, buttons, icon buttons, inputs |
| `--r-micro` | 5px | keyboard badges, status chips |

The window's own corner belongs to macOS.

Squircle corners (`corner-shape`) are **not** part of this spec. The property is
new and its behaviour in WKWebView is unverified. If it is later confirmed to
work, it can be added behind `@supports` as a progressive enhancement. 14px
circular reads close enough to the reference's 8px squircle.

### 4. Borders

`border-devdeck-border` is used 440 times across 120 files. All 440 point at
one CSS custom property, so the value changes and no component file is touched.
Border *width* stays 1px, so nothing reflows; only the colour disappears.

| Token | Uses | Change |
|---|---|---|
| `--devdeck-border` | 440 | `#292b2f` -> `rgba(255,255,255,.028)` |
| `--devdeck-border-card` | 107 | `#303237` -> `rgba(255,255,255,.055)` |

| `--devdeck-border-menu` | 61 | `#3b3f45` -> `rgba(255,255,255,.075)` |
| `--devdeck-border-strong` | 77 | `#35383d` -> `#80807d` (see below) |

`--devdeck-border-card` and the sidebar card's own wash share the value
`rgba(255,255,255,.055)`. That is a coincidence of two different roles landing
on the same step of the light ramp, not a shared token. Keep them separate so
either can move without dragging the other.

`border-strong` is **not** softened. It carries input edges and focus
affordances. Its old value measures **1.01:1** against the sidebar's glass card,
which is to say invisible. It moves to `#80807d`, which passes 3:1 on every
surface.

**This token flip does not finish the job.** In some places both sides of a
boundary use the same background and the hairline is the only separator. When
the line goes, the two areas merge. A confirmed example: `Sidebar.tsx:84`
(rail, `bg-devdeck-surface`) and `Sidebar.tsx:125` (tree panel, also
`bg-devdeck-surface`), separated by `border-r`. The fix is a tone step, not a
restored line. An estimated 8-14 such places exist; they can only be found by
running the app, not by grep, and the plan allocates a pass for it.

### 5. Text and foreground tokens

Text uses two scales, because the app has two backgrounds of different
lightness. The last two rows are not text; they are included here because they
are verified against the same three backgrounds. All ratios measured against
glass (`#363737` composite), pane (`#1c1c1d`), and the reduced-transparency
solid (`#33322f`).

| Token | Value | Role | glass | pane | solid |
|---|---|---|---|---|---|
| `--fg` | `#f4f4f2` | primary | 10.84 | 15.46 | 11.64 |
| `--fg-2` | `#9f9f9c` | secondary, placeholders | 4.50 | 6.42 | 4.83 |
| `--dim-glass` | `#8d8d8a` | dim, on glass | 3.59 | - | 3.85 |
| `--dim-pane` | `#747476` | dim, in pane (line numbers) | - | 3.65 | - |
| `--line` | `#80807d` | input edges, non-text separators | 3.01 | 4.30 | 3.24 |
| `--ring` | `#39c6bd` | focus ring, state marker | 5.68 | 8.10 | 6.10 |

Replaced values and why:

- Placeholders were `#555b60`: **1.74:1** on the glass card. Fails AA badly.
- Input edges were `#35383d`: **1.01:1** on the glass card.
- Focus ring was `--devdeck-border-accent` `#315b59`: **1.58:1** on the glass
  card. It moves to teal, which is coherent because teal is already the state
  marker (section 6), so it is also the focus marker.

**Accepted exception.** `--dim-pane` at 3.65:1 is below the AA threshold of
4.5:1 for body text. This is deliberate. Line numbers are meant to recede.
Today's equivalent (`#686e73` on `#111214`) measures 3.63:1, and VS Code's
default dark line number measures 3.59:1, so this holds parity rather than
regressing. Without the new token the same surface change would have dropped it
to 3.10:1, which *would* be a regression.

### 6. Accent

`#39c6bd` keeps one job and loses the rest.

**Keeps:** focus ring, the active-state bar (section 7), text selection, links,
and the single primary action per screen (`+ Worktree`).

**Loses:** decorative badges, decorative icons, accented dividers, tinted hover
washes, and every other position among the current 229 usages.

The primary button stays teal. An early draft made it neutral to imitate the
reference's pills; that was withdrawn after looking at the actual app. The
reference has no primary action and DevDeck does. What makes a UI feel busy is
not that an accent exists, it is that it appears in 229 places.

### 7. Active and focused state

One vocabulary for "active", everywhere:

```
background: rgba(255,255,255,.20)      /* the wash */
+ 2px #39c6bd bar                       /* the marker */
```

The wash is *relative*: it adds light to whatever sits behind it. Over glass it
resolves to `#5e5f5f`, inside the pane to `#49494a`. Both rise one step from
their own background, so they read as the same gesture. An earlier draft used a
darker fill on glass and a lighter fill inside the pane, which meant two
opposite rules for one concept.

**Why the wash alone is not enough.** WCAG 1.4.11 asks for 3:1 on UI state
indicators. Measured:

| Wash | State contrast | Text on it |
|---|---|---|
| .11 | 1.41:1 fail | 7.6:1 pass |
| .20 | 1.86:1 fail | 5.7:1 pass |
| .32 | 2.66:1 fail | 4.0:1 **fail** |
| .38 | 3.14:1 pass | 3.4:1 **fail** |

A white fill needs `.365` to pass state contrast, but text drops below AA at
`.32`. **The window is empty; no single value satisfies both.** Inverting does
not help either: a dark fill on glass measures 1.42:1, symmetrically bad.

So the fill does not carry the state alone. The teal bar does, and it passes
comfortably: 5.68:1 on glass, 8.10:1 in the pane, 3.05:1 against the wash on
glass, 4.28:1 against the wash in the pane.

**The bar follows the axis of its list:** bottom edge for tabs laid out
horizontally, left edge for rows stacked vertically. Same convention as VS Code.

**The bar also means focus.** With more than one pane open there are two
different questions: *which tab is selected in this pane*, and *which pane
receives my keystrokes*. The wash answers the first, the bar answers the second.
Therefore **exactly one teal bar is visible at a time**, regardless of how many
panes are open. Unfocused panes still show their selected tab with the wash, but
without the bar. `focusedLeafId` already exists in the store.

### 8. Terminal stays opaque

The pane keeps `#1c1c1d` as a solid fill and the xterm theme background changes
from `#111214` to match. `Terminal.tsx:34,167` is otherwise untouched.

A translucent terminal was investigated and rejected by the operator. For the
record, it was feasible: `@xterm/addon-webgl/src/TextureAtlas.ts:100` passes
`allowTransparency` into the 2D context's `alpha`, so the WebGL renderer stays
active rather than falling back to the DOM renderer. The cost would have been
the atlas losing its opaque path (`TextureAtlas.ts:310,657,701`), grayscale
antialiasing instead of subpixel, plus lifting every dim token and reworking
the diff bands into translucent washes. Keeping the terminal opaque removes all
of that.

### 9. Reduced transparency

```css
@media (prefers-reduced-transparency: reduce) {
  /* glass -> solid */
  --glass: #33322f;
  backdrop-filter: none;
}
```

Nothing else changes: gaps, radii, the wash, the teal bar, and both text scales
stay identical, and every token still passes on `#33322f` (the "solid" column in
section 5). The fallback is one swapped value, not a second design to maintain.

On Tauri the native material honours the OS setting on its own; this block is
mainly for the web build. Browser support for the query is uneven and must be
tested rather than assumed.

### 10. Mobile

Below `md`:

- The sidebar returns to the drawer behaviour that already exists in
  `Sidebar.tsx`. The drawer is still a card (radius 14, 6px inset) floating over
  a scrim.
- **The drawer is solid, not glass.** Not an aesthetic call: the drawer animates
  `transform`, and `backdrop-filter` on a transforming element forces a repaint
  every frame. Solid keeps the slide at 60fps on phones.
- **Splits are disabled below `md`.** One pane, tabs only. A 2x2 grid at 390px
  produces nothing readable.

### 11. Empty, loading, and error states

Required by `.claude/rules/frontend.md` ("Every data surface must render
explicit loading, error, and empty states") and previously undesigned in this
language.

- **Empty** always carries the action that resolves it, not just a sentence.
  Example: "No worktrees yet" plus a `+ Worktree` button.
- **Loading** uses skeleton blocks that echo the rhythm of the real content.
  No circular spinners.
- **Error** renders inline where the content belongs, with a 2px `--err` bar on
  the left edge and a retry action. Toasts stay, but only for transient
  confirmations ("Copied").

### 12. Narrow pane controls

At quarter width the pane controls (`split-h`, `split-v`, `more`, `close`)
consume as much room as the tab label. Rule: **below 260px of pane width, only
`✕` remains inline; the rest collapse into the `⋯` menu.**

---

## Known limitations

Recorded rather than hidden.

1. **Calibrated against a dark wallpaper only.** The operator chose to keep the
   dark wallpaper as the design reference. With the CSS approximation, a light
   wallpaper drops secondary text from 5.7:1 to about 3.2:1 and dim text to
   about 1.9:1. The native macOS material is expected to be more resistant, but
   **this has not been tested**. A cheap mitigation exists if it proves
   necessary: raise the tint alpha from `.80` toward `.90`, at the cost of less
   wallpaper bleed.
2. **`--dim-pane` is below AA** at 3.65:1, deliberately, at parity with today
   and with VS Code.
3. **Not exercised at content extremes.** Twelve open tabs, 200-file trees, and
   very long branch names have not been drawn.

## Open decisions

**Web build glass fallback.** The web build has no wallpaper behind the window,
so `backdrop-filter` has nothing meaningful to sample and the glass degenerates
to a flat tint. The reduced-transparency solid `#33322f` is a ready answer and
would make the web build honest rather than pretending to have a material it
cannot have. This was raised and left open; it should be decided before the
token work lands, since it determines whether the web build ships
`backdrop-filter` at all.

## Verification

- `npm run typecheck` and `npm run build` clean.
- Full frontend test suite green (currently 419 tests / 46 files).
- Visual audit pass against a running app for the merged-boundary cases in
  section 4. This cannot be done by grep.
- Contrast spot-checks reproduced against the table in section 5.
- Both `prefers-reduced-transparency` states exercised.
- Mobile width exercised with the drawer open and closed.

## References

- Mockups and comparisons: `.superpowers/brainstorm/6658-1785951395/content/`
  (`mockup-v7.html`, `mockup-splits.html`, `active-contrast.html`,
  `preflight-fixes.html`, `strip-dark.html`).
- Design system rules: `DESIGN.md` at the repository root.

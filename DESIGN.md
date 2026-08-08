# DESIGN.md

DevDeck's visual system. Dark only. Read this before adding any surface, state,
border, radius, or colour. Design rationale and measurements live in
`docs/superpowers/specs/2026-08-06-glass-flat-retune-design.md`.

## The one rule

**Two surfaces, one state wash, one accent.** If a change needs a third
surface, a second accent, or a new border colour, it is probably solving a
hierarchy problem with paint. Solve it with tone or space instead.

---

## Surfaces

| Layer | Value | Where |
|---|---|---|
| Glass | `rgba(58,63,63,.80)` + `blur(48px) saturate(.34) brightness(.92)` | Covers the whole window. Rail and top tab strip sit directly on it. |
| Glass card | glass + `rgba(255,255,255,.055)` | Sidebar column only |
| Pane | `#1a1d1d` opaque | Every tile leaf, and the xterm background |

### Neutral temperature (why these are not plain greys)

**Every neutral carries its chroma at the accent's hue, 188.6°.** Chroma stays
tiny (0.003–0.007 OKLCH), so nothing reads as "coloured" — but the direction
is deliberate and it is the difference between clean and dirty.

These surfaces used to sit at hue 91–107° (olive/khaki) while the accent sits
at 188.6° (cyan). A ~90° split between base and accent is what made the teal
look loud and pasted on, and the greys look muddy. Lightness was not touched,
so every ratio in this document still holds.

If you add a neutral, do not pick it by eye. Take the lightness you want and
put its chroma at 188.6°. A neutral that drifts warm will fight the accent.

`#1a1d1d` is duplicated as a literal in `TERMINAL_THEME` (`Terminal.tsx`),
because xterm cannot read CSS custom properties. The two must move together
or a seam appears between the terminal canvas and its pane card.

The glass covers the **entire window**. The wallpaper is a colour cast, never a
visible area. If raw wallpaper shows anywhere except through the glass, that is
a bug.

`saturate(0.34)` is not decorative. macOS sidebar vibrancy desaturates; a value
above 1 inverts the effect and the wallpaper's colour floods the chrome.

**On Tauri use the native material** (`windowEffects`, `sidebar` effect), not
the CSS above. The CSS is for the web build and for mockups.

### Reduced transparency

```css
@media (prefers-reduced-transparency: reduce) {
  --glass: #2e3333;   /* solid */
  backdrop-filter: none;
}
```

Nothing else changes. Every token below still passes on `#2e3333`. Do not
design a separate layout for this state.

---

## Text

Two scales, because there are two backgrounds of different lightness. Pick by
what is *behind* the text, not by which component you are in.

| Token | Value | Role | glass | pane | solid |
|---|---|---|---|---|---|
| `--fg` | `#f2f5f4` | primary | 10.82 | 15.47 | 11.69 |
| `--fg-2` | `#9ca09f` | secondary, placeholders | 4.49 | 6.42 | 4.85 |
| `--dim-glass` | `#8a8e8d` | dim, on glass | 3.58 | - | 3.87 |
| `--dim-pane` | `#727575` | dim in pane (line numbers, status line) | - | 3.65 | - |

Three levels per background. Not four. The old seven-value ramp
(`fg, fg-2, muted, muted-2, dim, dim-2, dim-3`) is retired.

`--dim-pane` sits below AA at 3.65:1. **This is a recorded, deliberate
exception** for recessive numeric chrome, at parity with today and with VS
Code (3.59:1). Do not extend the exception to anything else, and never use
`--dim-pane` for text a user has to read.

---

## Accent

`#39c6bd`. It has exactly four jobs:

1. Focus ring
2. The active/focused state bar (see below)
3. Text selection and links
4. The single primary action on a screen (`+ Worktree`)

**Never** use it for: decorative badges, decorative icons, dividers, hover
washes, section headers, or "this bit looks empty". The accent was previously
in 229 places and meant nothing. One job per screen.

Status colours are separate and semantic, not accents:
`--run #7fb37f`, `--wait #c9a86a`, `--err #c98080`. Syntax and file-type icon
colours are content, not chrome, and are out of scope for this rule.

---

## State

One vocabulary, everywhere:

```css
/* selected */
background: rgba(255,255,255,.20);

/* focused: the above, plus */
/* 2px #39c6bd bar */
```

The wash is relative: it adds light to whatever is behind it, so one value
works on both glass (`#5e5f5f`) and pane (`#49494a`). Never use a darker fill
for "active" on one surface and a lighter fill on another.

**The wash cannot carry state contrast on its own.** It measures 1.86:1 against
its own background, and no white alpha satisfies both WCAG 1.4.11 (3:1 for the
state) and AA (4.5:1 for text on it). The teal bar carries it: 5.68:1 on glass,
8.10:1 in the pane.

**Bar axis follows the list axis:** bottom edge for horizontal tabs, left edge
for vertical rows.

**Exactly one teal bar on screen at a time.** The wash answers "which tab is
selected in this pane"; the bar answers "which pane receives my keystrokes".
Unfocused panes show the wash without the bar.

---

## Borders

Boundaries are made of tone and space. A line is the last resort, not the first.

| Token | Value | Use |
|---|---|---|
| `--devdeck-border` | `rgba(255,255,255,.028)` | structural, effectively invisible |
| `--devdeck-border-card` | `rgba(255,255,255,.055)` | card edges |
| `--devdeck-border-menu` | `rgba(255,255,255,.075)` | menu item dividers |
| `--line` | `#7d8180` | **input edges and non-text separators that must be seen** |

Input edges, focus affordances, and anything WCAG 1.4.11 applies to use
`--line`, which passes 3:1 on every surface. The old `#35383d` measured
**1.01:1** on the glass card, which is to say it was not there.

If removing a line makes two areas merge, the fix is a **tone step**, not a
restored line.

---

## Radius

Three steps.

| Token | Class | Value | Applies to |
|---|---|---|---|
| `--r-container` | `rounded-container` | 14px | pane card, sidebar card, dialogs, popovers |
| `--r-control` | `rounded-control` | 10px | tabs, rows, buttons, icon buttons, inputs |
| `--r-micro` | `rounded-micro` | 5px | keyboard badges, status chips |

**Tailwind's named scale is aliased onto these three**, so the ~280 call sites
that already say `rounded-md` / `rounded-lg` are on the system rather than
outside it. `sm` maps to micro, `md` and `lg` to control, `xl` and `2xl` to
container. Prefer the named classes in new code; the Tailwind names are not a
violation.

**`rounded-full` is outside the scale, on purpose.** A circle or a pill is a
shape, not a corner radius. Avatars, status dots, and toggle knobs keep it.

**Arbitrary `rounded-[Npx]` is not allowed for corners.** The one exception is
sub-5px rounding on hairline elements (the 2px accent bar, progress tracks),
where the value is the bar's own end-cap, not a container corner.

The window corner belongs to macOS. `corner-shape: squircle` is not adopted;
its WKWebView behaviour is unverified. If that changes, add it behind
`@supports` as enhancement only.

---

## Space

- Gap between cards, and from the window edge: **8px**.
- Below `md`: sidebar becomes a drawer, **solid not glass** (a transforming
  element with `backdrop-filter` repaints every frame), and splits are
  disabled.
- Below **260px of pane width**: only `✕` stays inline in the pane controls;
  the rest collapse into `⋯`.
  **Not yet wired to a rendered control.** The collapse rule exists as a
  tested pure function (`paneControlsFor`/`usePaneWidth` in
  `WorkspaceTileCanvas.tsx`), but no leaf currently renders a
  split/more/close control cluster to apply it to — this codebase has no
  per-leaf "split" or "close pane" action yet (splits are only created by
  dragging a tab onto an edge zone). Wire this in once those actions exist;
  until then the rule is unused by the running app.

---

## Layering

Five z-index steps. Anything outside them is a bug, not a new step.

| Value | Layer |
|---|---|
| `z-[45]` | sidebar drawer below `md` |
| `z-[70]` | overlays: file quick-open, content search, editor menus |
| `z-[75]` | command palette (above overlays, it can be opened from them) |
| `z-[100]` | popovers anchored inside a dialog (combobox, select) |

Everything else composes with document order. Do not reach for a z-index to
fix a stacking problem inside one of these layers; fix the DOM order.

---

## Motion

There is almost none, deliberately: two custom keyframes, plus `animate-spin`
and `animate-pulse`. A pane tool should not move on its own.

`prefers-reduced-motion: reduce` is handled **globally** in `globals.css`, not
per component: it collapses every animation and transition to `0.01ms` and
caps iteration count at 1. So a new spinner is guarded the moment it is
written, and no one has to remember `motion-reduce:`.

`0.01ms`, not `0s` — a zero-length transition does not reliably fire
`transitionend`, and two components listen for it.

---

## Recorded typographic exceptions

- **`—` means "no value"**, in tables, metric rows, and detail lists (26
  sites). It is a data glyph, not prose. Prose uses a plain hyphen; there are
  no em-dashes in any user-facing sentence.
- Second-level slide bullets use `◦`, not an en-dash.

---

## Required states

Every data surface renders all three. This is also a project rule
(`.claude/rules/frontend.md`).

- **Empty** carries the action that resolves it, not just a sentence.
- **Loading** uses skeletons shaped like the real content. No circular spinners.
- **Error** renders inline where the content belongs, with a retry.
  Toasts are for transient confirmations only.

Use the existing components in `src/features/screens/`: `DataLoading`,
`DataError`, `EmptyState`, plus the domain-specific empty screens
(`AgentsEmpty`, `ProjectEmpty`, and friends). Do not write a new state
component; one of these almost certainly already covers it.

**Honest status: this rule is not yet met everywhere.** An audit found roughly
56 data surfaces missing at least one of the three states. `DataLoading` was
converted from a remote Lottie animation to skeleton rows, which brought its
28-plus call sites into line at once, but adopting the family across the
remaining surfaces is its own piece of work and has not been done. Treat the
rule as binding for new and touched code, and as a backlog for the rest.

---

## Checks before shipping UI

1. Does this add a surface, an accent, a border colour, or a radius outside the
   tables above? If yes, it needs a reason in the PR, not just a preference.
2. Does every new text colour pass 4.5:1 against **the background it actually
   sits on**, on glass and pane and `#2e3333`?
3. Does every new state indicator reach 3:1, or does it lean on the teal bar?
4. Does it still read with `prefers-reduced-transparency` on?
5. Does it still read below `md`?
6. Are empty, loading, and error drawn?

---

## Known open items

- **Web build.** No wallpaper exists behind a browser window, so the glass
  degenerates to a flat tint there. Whether the web build ships
  `backdrop-filter` at all, or simply uses the solid `#2e3333`, is undecided.
- **Light wallpapers are untested.** The system was calibrated against a dark
  wallpaper. With the CSS approximation, a light wallpaper pushes secondary
  text to roughly 3.2:1. The native material is expected to be more resistant.
  Mitigation if needed: raise the tint alpha from `.80` toward `.90`.

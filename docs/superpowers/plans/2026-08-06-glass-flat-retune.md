# Glass and Flat Retune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse DevDeck's chrome from seven surfaces, four border colours, and seven text values down to two materials, one state wash, and one accent, adopting macOS vibrancy on the Tauri build.

**Architecture:** Almost all of the visual change lands in one file, `frontend/src/styles/globals.css`, because every colour in the app already routes through a CSS custom property. `border-devdeck-border` alone is used 440 times across 120 files and is retuned by changing one value, not 440 call sites. Component work is limited to five files: the window shell gains a glass wrapper and card geometry, the tile canvas gains the focused-pane bar and the narrow-control rule, and the terminal theme follows the new pane colour.

**Tech Stack:** Tailwind v4 (`@theme inline` in `globals.css`), React 19, Vitest + Testing Library (jsdom), Tauri v2 (`windowEffects`), xterm.js 6 with `@xterm/addon-webgl`.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-06-glass-flat-retune-design.md`. Every task's requirements implicitly include this section.

- **Materials:** two. Glass `rgba(63,62,59,.80)` with `blur(48px) saturate(.34) brightness(.92)`, and pane `#1c1c1d` opaque. The sidebar card is glass plus `rgba(255,255,255,.055)`, not a third material.
- **`saturate(0.34)` is load-bearing.** A value above 1 inverts macOS vibrancy behaviour and floods the chrome with wallpaper colour.
- **On Tauri use the native material** (`windowEffects`, `sidebar`), not the CSS recipe. The CSS is for the web build.
- **Text tokens:** `--fg #f4f4f2`, `--fg-2 #9f9f9c`, `--dim-glass #8d8d8a`, `--dim-pane #747476`, `--line #80807d`, `--ring #39c6bd`.
- **Radius: exactly three values.** `--r-container 14px`, `--r-control 10px`, `--r-micro 5px`. No other radius may appear.
- **Gap:** 8px between cards and from the window edge.
- **Accent `#39c6bd` has four jobs only:** focus ring, active/focused state bar, selection and links, and the single primary action per screen. Nothing decorative.
- **State:** `rgba(255,255,255,.20)` wash for selected, plus a 2px `#39c6bd` bar for focused. Bar on the bottom edge for horizontal tabs, left edge for vertical rows. **Exactly one bar visible at a time.**
- **Accepted exception:** `--dim-pane` measures 3.65:1, below AA 4.5:1. Deliberate, at parity with today (3.63:1) and VS Code (3.59:1). Do not extend this exception to any other token.
- **Terminal renderer is not touched.** `allowTransparency` stays `false`; the WebGL addon keeps working as it does today.
- **Tab labels are not changed.** `worktreeTabLabel` in `frontend/src/lib/worktreeLabel.ts:44` stays as-is.
- **Below `md` (768px):** sidebar drawer is solid, not glass; splits are disabled.
- **Below 260px pane width:** only `✕` stays inline in pane controls; the rest collapse into `⋯`.

**Commands:** `cd frontend && npm run typecheck`, `npm test`, `npm run build`.

**Commit hook, read this before planning your commits.** This repo sets
`core.hooksPath = .githooks`, not the usual `.git/hooks` or `.husky`, so a
casual check will report "no hook" and be wrong. `.githooks/pre-commit` runs
`cd frontend && npm run typecheck` against the **whole project**, ignoring the
commit's pathspec, and `pretypecheck` additionally runs a full `vite build`
(`frontend/package.json:14`). Every commit in this plan therefore requires the
entire tree to typecheck and build, not just the files you touched.

For this plan that is workable: the tasks are additive or value-only, and no
task leaves the tree in a broken intermediate state. The one to watch is
**Task 1**, which deletes Tailwind colour utilities. Those are strings in
`className`, so `tsc` will not catch a stale `bg-devdeck-surface`; it will
silently render unstyled. Task 1 step 7 exists to catch that by running the
test suite, and Task 10's visual walk is the real backstop. If you find
yourself unable to commit mid-task, group the dependent tasks into one commit
rather than bypassing the hook.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `frontend/src/styles/globals.css` | All token values. The single lever for the retune. | 1 |
| `frontend/src/styles/globals.tokens.test.ts` | **Create.** Regression guard: retired hexes must not reappear. | 1 |
| `frontend/src/features/useReducedTransparency.ts` | **Create.** `prefers-reduced-transparency` media hook. | 2 |
| `frontend/src/features/useReducedTransparency.test.ts` | **Create.** Hook tests. | 2 |
| `frontend/src-tauri/tauri.macos.conf.json` | Native vibrancy on the macOS window. | 3 |
| `frontend/src/routes/w.$wsId.tsx` | Window glass wrapper, 8px gaps, card geometry. | 4 |
| `frontend/src/features/sidebar/Sidebar.tsx` | Sidebar becomes a card; rail loses its own background. | 4 |
| `frontend/src/features/tabs/WorkspaceTileCanvas.tsx` | State wash, focused-pane bar, narrow-control rule, split gating. | 5, 7, 8 |
| `frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx` | **Create.** One-bar-at-a-time and narrow-control tests. | 5, 7 |
| `frontend/src/features/terminal/Terminal.tsx` | `TERMINAL_THEME` follows the new pane colour. | 6 |
| `frontend/src/features/terminal/terminalTheme.test.ts` | **Create.** Theme constant assertions. | 6 |
| `frontend/src/components/ui/state-panel.tsx` | **Create.** Shared empty / loading / error panel. | 9 |
| `frontend/src/components/ui/state-panel.test.tsx` | **Create.** State panel tests. | 9 |

**Honest note on testing.** Tasks 1 and 3 are not meaningfully unit-testable. A token swap has no behaviour to assert and a Tauri window effect is an OS call. Task 1 gets a regression guard (retired hexes must not reappear anywhere in the token file), which is genuinely useful across 120 consuming files, but it is a guard, not a spec. Task 3 is verified by running the app. Do not invent assertions that only restate the source; a test that reads a hex and asserts the same hex proves nothing. Tasks 2, 5, 6, 7, 8, and 9 are properly test-driven.

---

### Task 1: Retune the token layer

**Files:**
- Modify: `frontend/src/styles/globals.css:20-102` (raw palette and semantic block), `:104-191` (`@theme inline`)
- Create: `frontend/src/styles/globals.tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties consumed by every later task and by 120 existing component files. New names introduced here: `--devdeck-glass`, `--devdeck-glass-solid`, `--devdeck-card-wash`, `--devdeck-pane`, `--devdeck-on`, `--devdeck-line`, `--devdeck-ring`, `--dim-glass`, `--dim-pane`, `--r-container`, `--r-control`, `--r-micro`. Tailwind utilities produced: `bg-devdeck-pane`, `text-devdeck-dim-glass`, `text-devdeck-dim-pane`, `border-devdeck-line`, `rounded-container`, `rounded-control`, `rounded-micro`.

- [ ] **Step 1: Write the failing guard test**

Create `frontend/src/styles/globals.css`'s guard at `frontend/src/styles/globals.tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8')

/** Hexes the retune removes. If one reappears, someone reintroduced a retired
 *  surface, border, or text level instead of using the new token. */
const RETIRED = [
  '#292b2f', // --devdeck-border, the 440-use hairline
  '#303237', // --devdeck-border-card
  '#3b3f45', // --devdeck-border-menu
  '#35383d', // --devdeck-border-strong, measured 1.01:1 on the glass card
  '#315b59', // --devdeck-border-accent, the old focus ring at 1.58:1
  '#555b60', // --devdeck-dim-2, the old placeholder at 1.74:1
  '#161719', // --devdeck-surface
  '#1d1e21', // --devdeck-surface-2
  '#202124', // --devdeck-card
  '#242629', // --devdeck-popover
  '#2a2c30', // --devdeck-elevated
  '#111214', // --devdeck-terminal
]

describe('globals.css token layer', () => {
  it.each(RETIRED)('no longer defines the retired value %s', (hex) => {
    expect(css.toLowerCase()).not.toContain(hex)
  })

  it('defines exactly three radius steps', () => {
    expect(css).toContain('--r-container: 14px')
    expect(css).toContain('--r-control: 10px')
    expect(css).toContain('--r-micro: 5px')
  })

  it('keeps the glass desaturating, not saturating', () => {
    const match = css.match(/saturate\(([\d.]+)\)/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeLessThan(1)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/styles/globals.tokens.test.ts`
Expected: FAIL. Most `RETIRED` cases fail because those hexes are still in the file, and both structural cases fail because `--r-container` and `saturate()` do not exist yet.

- [ ] **Step 3: Replace the raw palette block**

In `frontend/src/styles/globals.css`, replace everything from `/* raw devdeck palette */` (line 20) through the closing of the semantic block (line 102, `--radius: 0.45rem;` and its `}`) with:

```css
  /* ── materials ──────────────────────────────────────────────────────────
     Two, plus one state wash. The sidebar card is glass + a wash, not a third
     material. See DESIGN.md.

     saturate(.34) is load-bearing: macOS sidebar vibrancy DEsaturates. A value
     above 1 inverts the effect and floods the chrome with wallpaper colour. */
  --devdeck-glass: rgba(63, 62, 59, 0.8);
  --devdeck-glass-filter: blur(48px) saturate(0.34) brightness(0.92);
  /* swapped in under prefers-reduced-transparency, and available to the web
     build, which has no wallpaper to sample. */
  --devdeck-glass-solid: #33322f;
  --devdeck-card-wash: rgba(255, 255, 255, 0.055);
  --devdeck-pane: #1c1c1d;

  /* state: one wash for "selected", plus --devdeck-ring as a 2px bar for
     "focused". The wash is relative — it adds light to whatever is behind it,
     so one value reads the same on glass (#5e5f5f) and in the pane (#49494a).
     It cannot carry state contrast alone (1.86:1); the ring does that. */
  --devdeck-on: rgba(255, 255, 255, 0.2);

  /* ── foreground ─────────────────────────────────────────────────────────
     Two scales, because there are two backgrounds of different lightness.
     Pick by what is BEHIND the text. Ratios verified against glass (#363737
     composite), pane (#1c1c1d), and the reduced-transparency solid (#33322f). */
  --devdeck-fg: #f4f4f2; /* 10.84 / 15.46 / 11.64 */
  --devdeck-fg-2: #9f9f9c; /* 4.50 / 6.42 / 4.83 — also placeholders */
  --devdeck-dim-glass: #8d8d8a; /* 3.59 on glass */
  /* Below AA at 3.65:1, deliberately, for recessive numeric chrome only
     (line numbers, status line). Parity with today (3.63) and VS Code (3.59).
     Never use for text a user has to read. */
  --devdeck-dim-pane: #747476;

  /* non-text: input edges, separators that must be seen, focus ring. */
  --devdeck-line: #80807d; /* 3.01 / 4.30 / 3.24 */
  --devdeck-ring: #39c6bd; /* 5.68 / 8.10 / 6.10 */

  /* accent: four jobs only — focus ring, state bar, selection/links, and the
     single primary action per screen. Nothing decorative. */
  --devdeck-accent: #39c6bd;
  --devdeck-accent-hover: #55d2ca;
  --devdeck-accent-ink: #0d1717; /* 8.67:1 on the accent */

  /* status: semantic, not accents. */
  --devdeck-run: #7fb37f;
  --devdeck-wait: #c9a86a;
  --devdeck-err: #c98080;
  --devdeck-purple: #c7a3ff;

  /* diff bands: full-bleed, no border, no radius. */
  --devdeck-diff-del: #3d0100;
  --devdeck-diff-add: #012801;

  /* ── borders ────────────────────────────────────────────────────────────
     Boundaries are tone and space. These stay defined because 608 call sites
     across 120 files reference them; the VALUES go near-invisible so no
     component file has to be edited and nothing reflows (width stays 1px).
     Anything that must actually be seen uses --devdeck-line instead. */
  --devdeck-border: rgba(255, 255, 255, 0.028);
  --devdeck-border-card: rgba(255, 255, 255, 0.055);
  --devdeck-border-menu: rgba(255, 255, 255, 0.075);
  --devdeck-border-strong: var(--devdeck-line);
  --devdeck-border-accent: var(--devdeck-ring);

  --devdeck-hover-wash: rgba(255, 255, 255, 0.035);
  --devdeck-hover-wash-menu: rgba(255, 255, 255, 0.06);

  /* ── radius: exactly three steps. No other value may appear. ──────────── */
  --r-container: 14px; /* pane card, sidebar card, dialogs, popovers */
  --r-control: 10px; /* tabs, rows, buttons, icon buttons, inputs */
  --r-micro: 5px; /* keyboard badges, status chips */

  /* ── gap ────────────────────────────────────────────────────────────── */
  --devdeck-gap: 8px;

  /* ── semantic (shadcn-style) ─────────────────────────────────────────── */
  --background: var(--devdeck-pane);
  --foreground: var(--devdeck-fg);
  --card: var(--devdeck-pane);
  --card-foreground: var(--devdeck-fg);
  --popover: var(--devdeck-glass-solid);
  --popover-foreground: var(--devdeck-fg);
  --primary: var(--devdeck-accent);
  --primary-foreground: var(--devdeck-accent-ink);
  --secondary: var(--devdeck-on);
  --secondary-foreground: var(--devdeck-fg);
  --muted: var(--devdeck-pane);
  --muted-foreground: var(--devdeck-fg-2);
  --accent: var(--devdeck-on);
  --accent-foreground: var(--devdeck-fg);
  --destructive: var(--devdeck-err);
  --destructive-foreground: var(--devdeck-accent-ink);
  --border: var(--devdeck-line);
  --input: var(--devdeck-line);
  --ring: var(--devdeck-ring);

  --radius: var(--r-control);
}

@media (prefers-reduced-transparency: reduce) {
  :root {
    --devdeck-glass: var(--devdeck-glass-solid);
    --devdeck-glass-filter: none;
  }
}
```

Leave the `--app-height` block at lines 12-18 exactly as it is; it is unrelated and load-bearing for mobile keyboards.

- [ ] **Step 4: Rewire the `@theme inline` block**

In the same file, inside `@theme inline`, delete the retired `--color-devdeck-*` entries for `surface`, `surface-2`, `card`, `terminal`, `popover`, `elevated`, `muted`, `muted-2`, `dim`, `dim-2`, `dim-3`, `accent-soft`, `green-soft`, `yellow-soft`, `red-soft`, and `gray`, then add:

**Keep every `*-tint*` entry and keep `green`, `yellow`, `red`, `fg-2` as aliases.** Deleting them would break the call sites that use `bg-devdeck-accent-tint`, `text-devdeck-green`, and friends, and the build would fail. Their values are re-pointed instead:

```css
  /* aliases: kept so ~200 existing call sites keep compiling. Task 11 retires
     the decorative ones; until then they resolve to the new palette. */
  --color-devdeck-green: var(--devdeck-run);
  --color-devdeck-yellow: var(--devdeck-wait);
  --color-devdeck-red: var(--devdeck-err);
  --color-devdeck-fg-2: var(--devdeck-fg-2);
```

and in `:root`, re-point the tint values so they sit on the new surfaces:

```css
  --devdeck-accent-tint: rgba(57, 198, 189, 0.14);
  --devdeck-accent-tint-hover: rgba(57, 198, 189, 0.2);
  --devdeck-green-tint: rgba(127, 179, 127, 0.12);
  --devdeck-green-tint-border: rgba(127, 179, 127, 0.24);
  --devdeck-green-tint-hover: rgba(127, 179, 127, 0.18);
  --devdeck-yellow-tint: rgba(201, 168, 106, 0.12);
  --devdeck-yellow-tint-border: rgba(201, 168, 106, 0.24);
  --devdeck-yellow-tint-text: var(--devdeck-wait);
  --devdeck-yellow-ink: var(--devdeck-accent-ink);
  --devdeck-warning-ink: var(--devdeck-accent-ink);
  --devdeck-red-tint: rgba(201, 128, 128, 0.12);
  --devdeck-red-tint-hover: rgba(201, 128, 128, 0.18);
  --devdeck-red-tint-strong: rgba(201, 128, 128, 0.2);
  --devdeck-red-tint-strong-border: rgba(201, 128, 128, 0.34);
  --devdeck-red-tint-strong-hover: rgba(201, 128, 128, 0.26);
  --devdeck-red-tint-strong-text: var(--devdeck-err);
  --devdeck-accent-gradient: linear-gradient(135deg, var(--devdeck-accent), #238d87);
```

Then add the new utilities:

```css
  --color-devdeck-glass: var(--devdeck-glass);
  --color-devdeck-glass-solid: var(--devdeck-glass-solid);
  --color-devdeck-card-wash: var(--devdeck-card-wash);
  --color-devdeck-pane: var(--devdeck-pane);
  --color-devdeck-on: var(--devdeck-on);
  --color-devdeck-fg: var(--devdeck-fg);
  --color-devdeck-fg-2: var(--devdeck-fg-2);
  --color-devdeck-dim-glass: var(--devdeck-dim-glass);
  --color-devdeck-dim-pane: var(--devdeck-dim-pane);
  --color-devdeck-line: var(--devdeck-line);
  --color-devdeck-ring: var(--devdeck-ring);
  --color-devdeck-run: var(--devdeck-run);
  --color-devdeck-wait: var(--devdeck-wait);
  --color-devdeck-err: var(--devdeck-err);
  --color-devdeck-diff-del: var(--devdeck-diff-del);
  --color-devdeck-diff-add: var(--devdeck-diff-add);

  --radius-container: var(--r-container);
  --radius-control: var(--r-control);
  --radius-micro: var(--r-micro);
```

Keep `--color-devdeck-border*`, `--color-devdeck-accent*`, `--color-devdeck-hover-wash*`, `--color-devdeck-purple`, the `--font-*` entries, and the `--animate-*` entries. Removing the border colour utilities would break 608 call sites; only their values changed.

- [ ] **Step 5: Update `@layer base`**

Replace the `body` rule at lines 258-266 and the placeholder rule at 286-289:

```css
  body {
    margin: 0;
    background: var(--devdeck-pane);
    color: var(--devdeck-fg);
    font-family: var(--font-sans);
    font-size: 13px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  input::placeholder,
  textarea::placeholder {
    color: var(--devdeck-fg-2);
  }
```

Change the scrollbar thumb at lines 272-281 from `#23272f` / `#2f343d` to `rgba(255, 255, 255, 0.09)` / `rgba(255, 255, 255, 0.14)` so it reads on both glass and pane.

- [ ] **Step 6: Run the guard test to verify it passes**

Run: `cd frontend && npx vitest run src/styles/globals.tokens.test.ts`
Expected: PASS, all cases.

- [ ] **Step 7: Run typecheck and the full suite**

Run: `cd frontend && npm run typecheck && npm test`
Expected: typecheck clean. Some existing tests may fail if they assert removed utility class names such as `bg-devdeck-surface`. Fix those assertions to the new names; do not re-add the retired tokens to make a test pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/styles/globals.css frontend/src/styles/globals.tokens.test.ts
git commit -m "refactor(ui): collapse token layer to two materials and one state wash"
```

---

### Task 2: `prefers-reduced-transparency` hook

**Files:**
- Create: `frontend/src/features/useReducedTransparency.ts`
- Create: `frontend/src/features/useReducedTransparency.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `useReducedTransparency(): boolean`. Task 4 uses it to decide whether the window wrapper applies `backdrop-filter`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/useReducedTransparency.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useReducedTransparency } from './useReducedTransparency'

type Listener = () => void
let listeners: Listener[] = []

function mockMatchMedia(matches: boolean) {
  listeners = []
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: (_: string, fn: Listener) => listeners.push(fn),
      removeEventListener: (_: string, fn: Listener) => {
        listeners = listeners.filter((l) => l !== fn)
      },
    })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useReducedTransparency', () => {
  it('reports false when the user has not asked to reduce transparency', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useReducedTransparency())
    expect(result.current).toBe(false)
  })

  it('reports true when the media query matches', () => {
    mockMatchMedia(true)
    const { result } = renderHook(() => useReducedTransparency())
    expect(result.current).toBe(true)
  })

  it('reacts when the preference changes while mounted', () => {
    mockMatchMedia(false)
    const { result } = renderHook(() => useReducedTransparency())
    expect(result.current).toBe(false)

    act(() => {
      // the hook re-reads matchMedia on change, so flip it before notifying
      mockMatchMedia(true)
      // notifying via the ORIGINAL listener list is not possible after
      // restubbing, so drive the stored listener directly
    })
    // re-render with the new stub to confirm the hook reads the live value
    const second = renderHook(() => useReducedTransparency())
    expect(second.result.current).toBe(true)
  })

  it('removes its listener on unmount', () => {
    mockMatchMedia(false)
    const { unmount } = renderHook(() => useReducedTransparency())
    expect(listeners).toHaveLength(1)
    unmount()
    expect(listeners).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/features/useReducedTransparency.test.ts`
Expected: FAIL with "Failed to resolve import './useReducedTransparency'".

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/useReducedTransparency.ts`, mirroring the existing `useIsDesktop` pattern at `frontend/src/features/terminal/ExpandedTerminal.tsx:109`:

```ts
import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-transparency: reduce)'

/** True when the OS asks apps to avoid translucency (macOS Accessibility →
 *  Display → Reduce transparency, and equivalents).
 *
 *  The whole chrome rests on a glass material, so people who turn this on need
 *  a real answer, not a slightly-less-blurry one. The design swaps the glass
 *  for a solid `--devdeck-glass-solid` and changes nothing else — gaps, radii,
 *  the state wash, and both text scales all still pass on that surface.
 *
 *  Browser support for this query is uneven. Treating "no match" as "wants
 *  transparency" is the safe default: a browser that does not know the query
 *  gets the normal design rather than a permanently degraded one. On Tauri the
 *  native material honours the OS setting on its own, so this mainly serves
 *  the web build. */
export function useReducedTransparency(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  )

  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => setReduced(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/useReducedTransparency.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/useReducedTransparency.ts frontend/src/features/useReducedTransparency.test.ts
git commit -m "feat(ui): add prefers-reduced-transparency hook"
```

---

### Task 3: Native macOS vibrancy

**Files:**
- Modify: `frontend/src-tauri/tauri.macos.conf.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a transparent window whose backdrop is the OS `sidebar` material. Task 4 relies on the window being transparent where the glass wrapper does not paint.

- [ ] **Step 1: Add the window effect**

Replace the contents of `frontend/src-tauri/tauri.macos.conf.json` with:

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "DevDeck",
        "width": 1400,
        "height": 900,
        "visible": true,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "trafficLightPosition": { "x": 12, "y": 18 },
        "transparent": true,
        "windowEffects": {
          "effects": ["sidebar"],
          "state": "followsWindowActiveState"
        }
      }
    ]
  }
}
```

`titleBarStyle`, `hiddenTitle`, and `trafficLightPosition` are already correct and stay untouched. Only `transparent` and `windowEffects` are new.

- [ ] **Step 2: Verify by running the desktop app**

Run: `cd frontend && npm run tauri:dev`

Expected, checked by eye against a **dark** desktop wallpaper (the design reference):
- The desktop wallpaper is faintly visible through the sidebar and around the pane.
- The sidebar reads as a near-neutral grey, not tinted with the wallpaper's hue. If it looks colourful, `saturate()` is wrong somewhere.
- Traffic lights still sit correctly in the top strip.

Then open System Settings → Accessibility → Display → Reduce transparency and confirm the window becomes opaque without the layout shifting.

- [ ] **Step 3: Commit**

```bash
git add frontend/src-tauri/tauri.macos.conf.json
git commit -m "feat(desktop): enable macOS sidebar vibrancy on the main window"
```

---

### Task 4: Window glass layer and card geometry

**Files:**
- Modify: `frontend/src/routes/w.$wsId.tsx:83-118`
- Modify: `frontend/src/features/sidebar/Sidebar.tsx:72-129`

**Interfaces:**
- Consumes: `useReducedTransparency` from Task 2; tokens from Task 1.
- Produces: a single glass wrapper element around the whole window, and a sidebar rendered as a card with `rounded-container` and an 8px gap. No exported symbols change.

- [ ] **Step 1: Add the glass wrapper in the route shell**

In `frontend/src/routes/w.$wsId.tsx`, add the import:

```tsx
import { useReducedTransparency } from '@/features/useReducedTransparency'
```

Inside the component, next to the existing `const isTauri = useIsTauri()` at line 47:

```tsx
const reducedTransparency = useReducedTransparency()
```

Then replace the outer wrapper at lines 84-95 with:

```tsx
    <div
      className={cn(
        'flex h-[var(--app-height)] w-full flex-col overflow-hidden text-devdeck-fg',
        // One glass layer covers the ENTIRE window. An earlier revision put
        // glass only on the rail and sidebar, which let raw wallpaper bleed
        // through the gaps around the pane and produced a bright band along
        // the window's bottom edge. Covering everything makes the wallpaper a
        // colour cast rather than a visible area.
        reducedTransparency
          ? 'bg-devdeck-glass-solid'
          : 'bg-devdeck-glass [backdrop-filter:var(--devdeck-glass-filter)]',
        // Reserves space for WorkspaceTileCanvas's top-left leaf strip, which
        // is `fixed` to the true viewport top so it merges with macOS's
        // overlaid traffic-light buttons. Unchanged by this retune.
        isTauri && 'pt-10',
      )}
    >
```

Note the removal of `bg-devdeck-bg`: that token is retired, and the wrapper now paints the glass instead.

- [ ] **Step 2: Give the pane column its gap**

In the same file, replace the `<section>` at line 103 with:

```tsx
        <section className="flex min-w-0 flex-1 flex-col gap-[var(--devdeck-gap)] p-[var(--devdeck-gap)] pl-0">
```

Removing `bg-devdeck-bg` here is deliberate: the section is now transparent so the glass wrapper shows through the gaps.

- [ ] **Step 3: Turn the sidebar into a card**

In `frontend/src/features/sidebar/Sidebar.tsx`, replace the `<aside>` className block at lines 72-83 with:

```tsx
      <aside
        className={cn(
          'flex flex-none overflow-hidden',
          // The sidebar is a card on the glass: glass + a light wash. The wash
          // is mechanical, not decorative — without it the card is the same
          // value as the gap around it and its rounded corners have nothing to
          // read against.
          'my-[var(--devdeck-gap)] ml-[var(--devdeck-gap)] rounded-container bg-devdeck-card-wash',
          hasSidebarPanel ? 'w-[306px]' : 'w-[56px]',
          mobileDrawer &&
            cn(
              'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-[45] max-md:max-w-[86vw]',
              // The drawer animates `transform`, and backdrop-filter on a
              // transforming element repaints every frame. Solid keeps the
              // slide at 60fps on phones.
              'max-md:m-0 max-md:rounded-none max-md:bg-devdeck-glass-solid',
              'max-md:shadow-[8px_0_40px_rgba(0,0,0,0.55)] max-md:transition-transform max-md:duration-200',
              sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
            ),
        )}
      >
```

- [ ] **Step 4: Strip the rail's own background**

In the same file, replace the rail wrapper at line 84 with:

```tsx
        <div className={cn('flex flex-none flex-col items-center py-2.5', hasSidebarPanel ? 'w-[56px]' : 'w-full')}>
```

and the panel wrapper at line 125 with:

```tsx
          <div className="flex min-w-0 flex-1 flex-col">
```

Both previously carried `bg-devdeck-surface` and a `border-r`. The card behind them now provides the surface, and the two areas no longer need a line to separate them because they are one card. This is one of the merged-boundary cases Task 10 hunts for; it is fixed here because it is known.

Also update `railControlClass` at line 50: `rounded-[10px]` becomes `rounded-control`, and `focus-visible:ring-ring/50` becomes `focus-visible:ring-devdeck-ring`.

- [ ] **Step 5: Verify**

Run: `cd frontend && npm run typecheck && npm test && npm run build`
Expected: all clean. Then `npm run tauri:dev` and confirm the sidebar floats as a rounded card with an even 8px gap on all four sides, and the rail and tree read as one surface with no seam.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/w.\$wsId.tsx frontend/src/features/sidebar/Sidebar.tsx
git commit -m "feat(ui): single glass layer with sidebar and pane as cards"
```

---

### Task 5: One state vocabulary and the focused-pane bar

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx:372-410` (tab wrapper classes), `:647-700` (leaf chrome strip)
- Create: `frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`

**Interfaces:**
- Consumes: `--devdeck-on` and `--devdeck-ring` from Task 1. The existing `focused: boolean` prop already threaded into `TileTabButton`.
- Produces: a `data-active-bar` attribute on the focused leaf's active tab. Task 7 renders inside the same strip and must not disturb it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`:

```tsx
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TileTabButton } from './WorkspaceTileCanvas'

afterEach(() => {
  cleanup()
})

// Match this against the real `TileTabButton` prop type before running; the
// call site at WorkspaceTileCanvas.tsx:672 passes `compact`, `shortcutNumber`,
// and `onClose` as well. Add whichever of those the type marks as required.
const base = {
  leafId: 'leaf-1',
  tab: { kind: 'agents', id: 'agents' } as const,
  resolveWorktreeTab: () => undefined,
  resolveBrowserTab: () => ({ label: 'Web' }),
  resolveSSHShellTab: () => ({ label: 'SSH' }),
  onSelect: () => {},
}

describe('active and focused state', () => {
  it('shows the accent bar on the active tab of a focused leaf', () => {
    const { container } = render(<TileTabButton {...base} active focused />)
    expect(container.querySelector('[data-active-bar]')).not.toBeNull()
  })

  it('omits the accent bar when the leaf is not focused, but keeps the wash', () => {
    const { container } = render(<TileTabButton {...base} active focused={false} />)
    expect(container.querySelector('[data-active-bar]')).toBeNull()
    expect(container.querySelector('[data-selected="true"]')).not.toBeNull()
  })

  it('shows neither on an inactive tab', () => {
    const { container } = render(<TileTabButton {...base} active={false} focused />)
    expect(container.querySelector('[data-active-bar]')).toBeNull()
    expect(container.querySelector('[data-selected="true"]')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`
Expected: FAIL. `TileTabButton` is not exported, so the import throws.

- [ ] **Step 3: Export the component and implement the state**

In `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`, change `function TileTabButton(` to `export function TileTabButton(`.

Then replace the `wrapperClass` helper (around line 372) with:

```tsx
  /** One vocabulary for state, on every surface.
   *
   *  The wash is relative: it adds light to whatever sits behind it, so a
   *  single value reads the same over glass (#5e5f5f) and inside a pane
   *  (#49494a). An earlier revision used a darker fill on glass and a lighter
   *  fill in the pane, which meant two opposite rules for one concept.
   *
   *  The wash cannot carry state contrast on its own — it measures 1.86:1
   *  against its own background, and no white alpha satisfies both WCAG 1.4.11
   *  (3:1 for the state) and AA (4.5:1 for text on it). The accent bar carries
   *  it: 5.68:1 on glass, 8.10:1 in the pane.
   *
   *  The bar also means FOCUS, not just selection. With several panes open,
   *  "which tab is selected here" and "which pane takes my keystrokes" are
   *  different questions. The wash answers the first, the bar the second, so
   *  exactly one bar is visible at a time. */
  const wrapperClass = (isDragging: boolean) =>
    cn(
      'group relative flex min-w-0 items-center rounded-control transition-colors',
      active && 'bg-devdeck-on text-devdeck-fg',
      !active && 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash',
      isDragging && 'opacity-50',
    )
```

Inside the returned markup of each tab variant, add the two markers as the first children of the wrapper:

```tsx
      {active ? <span data-selected="true" hidden /> : null}
      {active && focused ? (
        <span
          data-active-bar
          aria-hidden
          className="pointer-events-none absolute inset-x-[10px] bottom-[3px] h-[2px] rounded-[2px] bg-devdeck-ring"
        />
      ) : null}
```

The bar sits on the **bottom** edge because this strip is horizontal. Vertical lists (the file tree, the Git changes list) use `absolute inset-y-[6px] left-[3px] w-[2px]` instead.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Update the leaf chrome strip**

In the same file, replace the strip className at lines 651-664 with:

```tsx
      className={cn(
        'flex items-center overflow-hidden',
        topChrome
          ? // Every leaf touching the workspace's top edge gets a real chrome
            // strip. The first starts at the true viewport edge so it fuses
            // with macOS's overlaid traffic lights; siblings are measured to
            // their split column. The strip is part of the glass layer, so it
            // paints nothing of its own.
            'fixed top-0 z-40 h-10 bg-transparent'
          : // Lower split panes keep an in-pane header on the pane surface.
            'h-8 flex-none bg-transparent',
      )}
```

The `border-b`, `border-l`, `bg-devdeck-surface`, `bg-devdeck-surface-2`, and the inset highlight `shadow` all go. The pane card behind the lower strip provides its surface.

- [ ] **Step 6: Run the full suite**

Run: `cd frontend && npm run typecheck && npm test`
Expected: clean. Existing `WorkspaceTileCanvas` tests that assert `bg-devdeck-surface` need their assertions updated.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileCanvas.tsx frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx
git commit -m "feat(ui): unify active state and add focused-pane accent bar"
```

---

### Task 6: Terminal theme follows the pane

**Files:**
- Modify: `frontend/src/features/terminal/Terminal.tsx:33-50`
- Create: `frontend/src/features/terminal/terminalTheme.test.ts`

**Interfaces:**
- Consumes: the pane and status values from Task 1.
- Produces: the updated `TERMINAL_THEME` export, already consumed at `Terminal.tsx:154`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/terminal/terminalTheme.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TERMINAL_THEME } from './Terminal'

describe('TERMINAL_THEME', () => {
  it('matches the pane surface so the terminal and its card are one plane', () => {
    expect(TERMINAL_THEME.background).toBe('#1c1c1d')
    expect(TERMINAL_THEME.cursorAccent).toBe('#1c1c1d')
  })

  it('uses the accent for the cursor and a readable selection', () => {
    expect(TERMINAL_THEME.cursor).toBe('#39c6bd')
    // the retired #315b5980 selection was tuned for the old darker surface
    expect(TERMINAL_THEME.selectionBackground).toBe('#39c6bd40')
  })

  it('uses the dim-pane token for recessive chrome, not the retired value', () => {
    expect(TERMINAL_THEME.brightBlack).toBe('#747476')
    expect(TERMINAL_THEME.brightBlack).not.toBe('#686e73')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/features/terminal/terminalTheme.test.ts`
Expected: FAIL, `expected '#111214' to be '#1c1c1d'`.

- [ ] **Step 3: Update the theme constant**

In `frontend/src/features/terminal/Terminal.tsx`, change these four entries inside `TERMINAL_THEME`:

```ts
  background: '#1c1c1d',
  cursor: '#39c6bd',
  cursorAccent: '#1c1c1d',
  selectionBackground: '#39c6bd40',
```

and further down:

```ts
  brightBlack: '#747476',
```

Leave `foreground` and the other ANSI colours alone. They are content, not chrome, and re-tuning a whole ANSI palette is out of this spec's scope.

Do **not** add `allowTransparency`. The spec keeps the terminal opaque, which is what avoids touching the WebGL renderer at `Terminal.tsx:167`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/terminal/terminalTheme.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/terminal/Terminal.tsx frontend/src/features/terminal/terminalTheme.test.ts
git commit -m "feat(ui): align terminal theme with the pane surface"
```

---

### Task 7: Narrow pane controls

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx:692-720` (control cluster)
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx` (add cases)

**Interfaces:**
- Consumes: the strip markup from Task 5.
- Produces: `paneControlsFor(width: number): { inline: PaneControl[]; overflow: PaneControl[] }` where `type PaneControl = 'split-h' | 'split-v' | 'more' | 'close'`. Exported from `WorkspaceTileCanvas.tsx`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`:

```tsx
import { paneControlsFor } from './WorkspaceTileCanvas'

describe('paneControlsFor', () => {
  it('keeps every control inline at a comfortable width', () => {
    expect(paneControlsFor(600)).toEqual({
      inline: ['split-h', 'split-v', 'more', 'close'],
      overflow: [],
    })
  })

  it('collapses everything but close below 260px', () => {
    // At quarter width in a 2x2 split the controls consume as much room as
    // the tab label itself.
    expect(paneControlsFor(259)).toEqual({
      inline: ['more', 'close'],
      overflow: ['split-h', 'split-v'],
    })
  })

  it('treats 260 as comfortable, not narrow', () => {
    expect(paneControlsFor(260).overflow).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`
Expected: FAIL, `paneControlsFor` is not exported.

- [ ] **Step 3: Implement the rule**

Add to `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`, above the leaf component:

```tsx
export type PaneControl = 'split-h' | 'split-v' | 'more' | 'close'

/** Below this width the split buttons cost as much room as the tab label they
 *  sit next to, which is what a 2x2 split produces on a 1400px window. `more`
 *  stays inline because it is where the collapsed controls go, and `close`
 *  stays because it is the one control people reach for without looking. */
const NARROW_PANE_WIDTH = 260

export function paneControlsFor(width: number): {
  inline: PaneControl[]
  overflow: PaneControl[]
} {
  if (width >= NARROW_PANE_WIDTH) {
    return { inline: ['split-h', 'split-v', 'more', 'close'], overflow: [] }
  }
  return { inline: ['more', 'close'], overflow: ['split-h', 'split-v'] }
}
```

Then measure the leaf and render from the result. Add above the leaf component:

```tsx
/** Width of the leaf's chrome strip, observed rather than derived, because a
 *  leaf's width comes from the split tree and the window, not from props. */
function usePaneWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY)
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width]
}
```

In the leaf component, next to the existing `setLeafRef`:

```tsx
  const [setWidthRef, paneWidth] = usePaneWidth()
  const controls = paneControlsFor(paneWidth, useIsDesktop())
```

Attach `setWidthRef` to the strip element from Task 5, then replace the hard-coded control cluster with:

```tsx
      <div className="ml-auto flex flex-none items-center gap-2 pr-2 text-devdeck-fg-2">
        {controls.inline.includes('split-h') ? (
          <button type="button" onClick={() => ctx.onSplit(leaf.id, 'row')} aria-label="Split right"
            className="rounded-control p-1 hover:bg-devdeck-hover-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-devdeck-ring">
            <Columns2 size={14} />
          </button>
        ) : null}
        {controls.inline.includes('split-v') ? (
          <button type="button" onClick={() => ctx.onSplit(leaf.id, 'col')} aria-label="Split down"
            className="rounded-control p-1 hover:bg-devdeck-hover-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-devdeck-ring">
            <Rows2 size={14} />
          </button>
        ) : null}
        <PaneOverflowMenu leafId={leaf.id} extraActions={controls.overflow} />
        <button type="button" onClick={() => ctx.onCloseLeaf(leaf.id)} aria-label="Close pane"
          className="rounded-control p-1 hover:bg-devdeck-hover-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-devdeck-ring">
          <X size={14} />
        </button>
      </div>
```

`PaneOverflowMenu` is the existing `⋯` menu; give it an `extraActions: PaneControl[]` prop and render a menu item per entry. Import `Columns2`, `Rows2`, and `X` from `lucide-react`, matching the project's icon rule in `.claude/rules/frontend.md`. Match the real handler names on `ctx` when wiring; the names above follow the existing `ctx.onNewTab` / `ctx.onCloseTab` convention in this file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`
Expected: PASS, 6 tests total.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileCanvas.tsx frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx
git commit -m "feat(ui): collapse pane controls below 260px"
```

---

### Task 8: Disable splits below `md`

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx` (split action guards)
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx` (add cases)

**Interfaces:**
- Consumes: `useIsDesktop` from `frontend/src/features/terminal/ExpandedTerminal.tsx:109`, and `paneControlsFor` from Task 7.
- Produces: `paneControlsFor(width: number, isDesktop: boolean)` — the signature gains a second parameter. Update Task 7's call sites.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`:

```tsx
describe('paneControlsFor below md', () => {
  it('offers no split controls at all on a phone, at any width', () => {
    // A 2x2 grid at 390px produces nothing readable, so the affordance is
    // removed rather than left to disappoint.
    const result = paneControlsFor(390, false)
    expect(result.inline).toEqual(['more', 'close'])
    expect(result.overflow).toEqual([])
  })

  it('still offers splits on a narrow desktop pane, via overflow', () => {
    expect(paneControlsFor(200, true).overflow).toEqual(['split-h', 'split-v'])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`
Expected: FAIL. The current one-argument function ignores the second argument and returns split controls in overflow.

- [ ] **Step 3: Extend the rule**

Replace `paneControlsFor` from Task 7 with:

```tsx
export function paneControlsFor(
  width: number,
  isDesktop = true,
): { inline: PaneControl[]; overflow: PaneControl[] } {
  // Splits do not exist below `md`. Hiding them entirely is kinder than
  // offering a control that produces an unreadable 2x2 grid on a 390px screen.
  if (!isDesktop) return { inline: ['more', 'close'], overflow: [] }
  if (width >= NARROW_PANE_WIDTH) {
    return { inline: ['split-h', 'split-v', 'more', 'close'], overflow: [] }
  }
  return { inline: ['more', 'close'], overflow: ['split-h', 'split-v'] }
}
```

At the call site the second argument is already `useIsDesktop()` from Task 7, so no change is needed there.

Then guard the split keyboard shortcuts so they no-op below `md`. Find the split key handler in this file and wrap its body:

```tsx
  const isDesktop = useIsDesktop()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Splits do not exist below `md`, so the shortcut must not create a
      // layout the viewport cannot show. Bail before preventDefault so the
      // keystroke stays available to the browser.
      if (!isDesktop) return
      // ... existing split handling, unchanged
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isDesktop])
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/tabs/WorkspaceTileCanvas.focus.test.tsx`
Expected: PASS, 8 tests total.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/tabs/WorkspaceTileCanvas.tsx frontend/src/features/tabs/WorkspaceTileCanvas.focus.test.tsx
git commit -m "feat(ui): disable pane splits below md"
```

---

### Task 9: Empty, loading, and error panels

**Files:**
- Create: `frontend/src/components/ui/state-panel.tsx`
- Create: `frontend/src/components/ui/state-panel.test.tsx`

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces: `<StatePanel kind="empty" | "loading" | "error" … />`. Feature modules replace their ad-hoc states with it.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui/state-panel.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { StatePanel } from './state-panel'

afterEach(() => {
  cleanup()
})

describe('StatePanel', () => {
  it('empty state carries the action that resolves it', () => {
    const onAction = vi.fn()
    render(
      <StatePanel
        kind="empty"
        title="No worktrees yet"
        detail="Create one to start running agents."
        actionLabel="+ Worktree"
        onAction={onAction}
      />,
    )
    expect(screen.getByRole('button', { name: '+ Worktree' })).toBeTruthy()
  })

  it('loading renders skeleton rows, never a spinner', () => {
    const { container } = render(<StatePanel kind="loading" rows={4} />)
    expect(container.querySelectorAll('[data-skeleton-row]')).toHaveLength(4)
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('error renders inline with a retry, not a toast', () => {
    const onAction = vi.fn()
    render(
      <StatePanel
        kind="error"
        title="Runtime unreachable"
        detail="home-lab did not respond within 10 seconds."
        actionLabel="Try again"
        onAction={onAction}
      />,
    )
    expect(screen.getByText('Runtime unreachable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('error is marked as an alert for assistive tech', () => {
    render(<StatePanel kind="error" title="Runtime unreachable" />)
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npx vitest run src/components/ui/state-panel.test.tsx`
Expected: FAIL with "Failed to resolve import './state-panel'".

- [ ] **Step 3: Write the implementation**

Create `frontend/src/components/ui/state-panel.tsx`:

```tsx
import { cn } from '@/lib/utils'

export type StatePanelKind = 'empty' | 'loading' | 'error'

export interface StatePanelProps {
  kind: StatePanelKind
  title?: string
  detail?: string
  actionLabel?: string
  onAction?: () => void
  /** Skeleton row count for `kind="loading"`. */
  rows?: number
  className?: string
}

/** The three states every data surface owes the operator.
 *
 *  Three rules separate this from the usual default:
 *  - `empty` always carries the action that resolves it, not just a sentence.
 *  - `loading` uses skeletons shaped like the real content, never a spinner,
 *    so the layout does not jump when the data lands.
 *  - `error` renders inline where the content belongs, with an accent bar on
 *    the leading edge. Toasts stay, but only for transient confirmations. */
export function StatePanel({
  kind,
  title,
  detail,
  actionLabel,
  onAction,
  rows = 6,
  className,
}: StatePanelProps) {
  if (kind === 'loading') {
    return (
      <div className={cn('flex flex-col gap-[7px] p-3', className)} aria-busy="true">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            data-skeleton-row
            className="h-2 rounded-micro bg-[rgba(255,255,255,0.07)]"
            style={{ width: `${40 + ((i * 13) % 45)}%` }}
          />
        ))}
      </div>
    )
  }

  if (kind === 'error') {
    return (
      <div role="alert" className={cn('flex gap-[9px] p-3', className)}>
        <div aria-hidden className="w-[2px] flex-none rounded-[2px] bg-devdeck-err" />
        <div className="min-w-0">
          {title ? <p className="text-[12px] text-devdeck-fg">{title}</p> : null}
          {detail ? <p className="mt-1 text-[11px] text-devdeck-dim-pane">{detail}</p> : null}
          {actionLabel && onAction ? (
            <button
              type="button"
              onClick={onAction}
              className="mt-2 rounded-control text-[11px] text-devdeck-ring hover:underline"
            >
              {actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 p-6 text-center', className)}>
      {title ? <p className="text-[12px] text-devdeck-fg-2">{title}</p> : null}
      {detail ? <p className="text-[11px] leading-relaxed text-devdeck-dim-pane">{detail}</p> : null}
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="mt-1 rounded-control bg-devdeck-accent px-3 py-1.5 text-[11px] font-semibold text-devdeck-accent-ink transition-colors hover:bg-devdeck-accent-hover"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ui/state-panel.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/state-panel.tsx frontend/src/components/ui/state-panel.test.tsx
git commit -m "feat(ui): add shared empty, loading, and error panel"
```

---

### Task 10: Merged-boundary audit

**Files:**
- Modify: whichever files the audit finds. `Sidebar.tsx` is already fixed in Task 4.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new. This task closes the gap the token flip cannot.

**This task has no unit tests and that is correct.** The defect it hunts only exists on screen: two areas whose backgrounds are the same value, previously separated by a hairline that is now invisible. Grep cannot find it, because the CSS is valid and the classes are unchanged. Do not fabricate tests here.

- [ ] **Step 1: Run the app and walk every surface**

Run: `cd frontend && npm run tauri:dev`

Visit, in order, looking specifically for two areas that have visibly merged into one: the Agents view, a worktree with a terminal, the file Explorer with a folder expanded, the Git panel with changes, the SSH connections list, a Browser tile, the Database module, the command palette, the Settings dialog, and any popover menu.

- [ ] **Step 2: For each merge found, add a tone step**

The fix is **never** to restore a border. Give one side a step: the recessive side takes `bg-[rgba(0,0,0,0.14)]`, or the raised side takes `bg-devdeck-card-wash`. Record each fix as a line in the commit body so the count is on the record. The spec estimates 8 to 14 sites.

- [ ] **Step 3: Verify both transparency states and both widths**

With the app running:
- Toggle System Settings → Accessibility → Display → Reduce transparency and re-walk the same surfaces.
- Resize below 768px and confirm the sidebar drawer is solid, splits are gone, and nothing overlaps.

- [ ] **Step 4: Run the full verification**

Run: `cd frontend && npm run typecheck && npm test && npm run build`
Expected: typecheck clean, full suite green, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "fix(ui): add tone steps where removed hairlines merged two surfaces"
```

---

### Task 11: Narrow the accent to its four jobs

**Files:**
- Modify: whichever files the sweep finds. Start from the counts below.

**Interfaces:**
- Consumes: the tokens from Task 1 and the state vocabulary from Task 5.
- Produces: nothing new. This removes usage; it adds no API.

Task 1 retuned the accent's *value*. It did not reduce its *reach*. The accent
is currently in **229 places** (`bg-devdeck-accent` 100, `text-devdeck-accent`
129), which is the reason it stopped meaning anything. This task is the other
half of spec section 6.

- [ ] **Step 1: Take the baseline count**

```bash
cd frontend/src
echo "bg:   $(grep -ro 'bg-devdeck-accent\b' . | wc -l)"
echo "text: $(grep -ro 'text-devdeck-accent\b' . | wc -l)"
grep -rn 'devdeck-accent' . --include='*.tsx' | grep -v test > /tmp/accent-sites.txt
wc -l /tmp/accent-sites.txt
```

Record the two numbers. They are the before-state for step 4.

- [ ] **Step 2: Classify every site**

Walk `/tmp/accent-sites.txt`. Each line is exactly one of:

**Keep (the four jobs).** Focus rings (`focus-visible:ring-*`), the active/focused bar from Task 5, text selection, links, and the one primary action on a screen (`+ Worktree` and the equivalent primary button in each dialog).

**Replace.** Everything else. Substitutions, in order of what you will actually hit:
- decorative icon colour -> `text-devdeck-fg-2`
- badge or chip background -> `bg-devdeck-on`
- accented divider -> delete the divider; use the gap that is already there
- accented hover wash -> `hover:bg-devdeck-hover-wash`
- accented section heading -> `text-devdeck-fg`
- status-adjacent use (a running agent, a healthy runtime) -> the semantic token, `text-devdeck-run` / `text-devdeck-wait` / `text-devdeck-err`

The last one matters: some accent uses are really status uses wearing the wrong
colour. Moving them to the status tokens is a correctness fix, not a style one.

- [ ] **Step 3: Apply, one feature directory at a time**

Work through `src/features/*` one directory per pass, running
`cd frontend && npm run typecheck && npm test` after each. Committing per
directory keeps each diff reviewable; there is no pre-commit hook to fight.

- [ ] **Step 4: Verify the reach actually shrank**

```bash
cd frontend/src
echo "bg:   $(grep -ro 'bg-devdeck-accent\b' . | wc -l)"
echo "text: $(grep -ro 'text-devdeck-accent\b' . | wc -l)"
```

Expected: a large reduction from 100 and 129. There is no correct target
number, so do not invent one; what matters is that every surviving site is one
of the four jobs. Spot-check ten survivors at random and name which job each
one serves. If you cannot name it, it should have been replaced.

- [ ] **Step 5: Confirm on screen**

Run `cd frontend && npm run tauri:dev`. Open the Agents view, a worktree, the
Explorer, the Git panel, and Settings. On each screen, teal should appear on at
most: one primary button, the focused pane's bar, and whatever currently has
keyboard focus. If teal appears anywhere else, that site was misclassified.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src
git commit -m "refactor(ui): narrow the accent to focus, state, selection, and the primary action"
```

---

## Deferred, deliberately

These are in the spec as known limitations and are **not** tasks here. Raise them again before calling the retune finished.

1. **Web build glass fallback — undecided.** A browser window has no wallpaper behind it, so `backdrop-filter` has nothing meaningful to sample and the glass degenerates to a flat tint. `--devdeck-glass-solid` is a ready answer. This needs a decision, not a default.
2. **Light wallpapers are untested.** The system was calibrated against a dark wallpaper by choice. With the CSS approximation a light wallpaper pushes secondary text to roughly 3.2:1. The native material is expected to resist better, but nobody has looked. Mitigation if needed: raise the tint alpha from `.80` toward `.90`.
3. **Content extremes are undrawn.** Twelve open tabs, 200-file trees, very long branch names.
4. **Tab grouping by project.** The current label already carries the project but repeats it when several tabs share one. Its own spec.
5. **Task 7/8's narrow-pane-control collapse is not wired to a rendered control.** `paneControlsFor`/`usePaneWidth`/`NARROW_PANE_WIDTH` in `WorkspaceTileCanvas.tsx` are implemented and unit-tested, exactly per spec section 12, but nothing calls them: this codebase has no per-leaf split or close-pane action for them to gate (splits are only created by dragging a tab onto an edge zone; see the deviation comment above `usePaneWidth` in that file). Wiring them up requires new `tileTree.ts` split/close-leaf mutations and a new overflow-menu component, which is a follow-up task, not a fix to this one. `DESIGN.md`'s "Space" section carries the same caveat.

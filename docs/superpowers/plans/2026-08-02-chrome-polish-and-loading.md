# Chrome Polish + Loading Affordances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the browser tile's duplicate tab strip, replace the machine `Select` with a centered omnibox, and make page loading visible through an indeterminate progress line, a spinning reload button, and a pulsing workspace tab dot.

**Architecture:** Two new generic units (`splitUrlForDisplay` pure module, `ProgressLine` component) are built and tested first, then composed into a new `BrowserOmnibox`, then wired through the existing `BrowserToolbar` / `BrowserTabStrip` / `BrowserTile` chain. Two independent restyle tasks (workspace tab pill, left rail) close it out.

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax`), Tailwind v4, Base UI (`@base-ui/react`), lucide-react, zustand, Vitest 4.1.10 + @testing-library/react + jsdom.

**Spec:** `docs/superpowers/specs/2026-08-02-chrome-polish-and-loading-design.md`

## Global Constraints

- **Imports use the `@/*` alias.** Never a relative path into `src/`. Exception: files importing a sibling in the *same* feature directory use `./sibling` — follow whatever the file being modified already does.
- **`verbatimModuleSyntax` is on.** Type-only imports MUST use `import type { X } from '...'`.
- **Icons come from `lucide-react` only.**
- **Dark-only design.** Use the `--devdeck-*` custom properties from `src/styles/globals.css`; never hardcode a hex color.
- **`cn()` from `@/lib/utils`** for all className merging.
- **One component per file**, under `src/features/<name>/` or `src/components/ui/`.
- **Never edit `src/routeTree.gen.ts`** — it is generated.
- **Vitest uses an explicit allowlist.** `vite.config.ts:61-66` lists which test files run. A new test file that is not added to that `include` array **will silently never run**. Every task that adds a test MUST also add its glob there.
- **Test style:** `import { describe, expect, it } from 'vitest'`. Do NOT copy the hand-rolled `check()`/`console.log` harness in `src/features/browser/displayUrl.test.ts` — that is legacy debt that no runner executes.
- **All commands run from `frontend/`.**
- **Baseline to preserve:** `npm test` is currently 170 passed / 14 files. It must never go down.
- Every task ends with `npm run typecheck` passing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/features/browser/splitUrlForDisplay.ts` | **Create.** Pure. Split a URL into `{ prefix, domain, rest }` for contrast-tiered rendering. |
| `src/features/browser/splitUrlForDisplay.test.ts` | **Create.** Vitest unit tests for the above. |
| `src/components/ui/progress-line.tsx` | **Create.** Generic indeterminate 2px progress bar owning only its delay/fade state machine. |
| `src/components/ui/progress-line.test.tsx` | **Create.** Fake-timer tests for the delay/fade machine. |
| `src/features/browser/BrowserOmnibox.tsx` | **Create.** Favicon + tiered URL + machine chip; the toolbar's center zone. |
| `src/components/ui/select.tsx` | **Modify.** Add optional `renderValue` and `chevronSize` props. Additive only. |
| `src/styles/globals.css` | **Modify.** Two `@keyframes` + two `--animate-*` tokens + a reduced-motion override. |
| `src/features/browser/BrowserToolbar.tsx` | **Modify.** Three fixed zones; always-render nav; `+` moves in; machine `Select` moves out; spinning reload. |
| `src/features/browser/BrowserTabStrip.tsx` | **Modify.** Drop the trailing `+`; left-align. |
| `src/features/browser/BrowserTile.tsx` | **Modify.** Render the strip only at 2+ docs; mount omnibox and `ProgressLine`. |
| `src/features/tabs/WorkspaceTileCanvas.tsx` | **Modify.** `TabDot` gains `loading`; pill restyle. Nothing else in this 923-line file. |
| `src/features/sidebar/SidebarNav.tsx` | **Modify.** Edge-bar active indicator; badge recolor + gating. |
| `src/features/sidebar/Sidebar.tsx` | **Modify.** Two group hairlines. |
| `vite.config.ts` | **Modify.** Register the two new test globs. |

---

### Task 1: `splitUrlForDisplay` — tiered URL parts

Spec §3.3 item 2, §7.2, §8.

**Files:**
- Create: `frontend/src/features/browser/splitUrlForDisplay.ts`
- Create: `frontend/src/features/browser/splitUrlForDisplay.test.ts`
- Modify: `frontend/vite.config.ts:61-66`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface UrlParts { prefix: string; domain: string; rest: string }` and `function splitUrlForDisplay(url: string): UrlParts`. Task 4 renders `prefix` and `rest` at `text-devdeck-dim` and `domain` at `text-devdeck-fg`.

**Contract:** `prefix` is the scheme-stripped subdomain labels **including their trailing dot** (`"www."`), or `""`. `domain` is the registrable domain plus `:port` when present. `rest` is path + search + hash, with a lone root `/` dropped and a trailing `/` stripped — matching the existing `displayUrl()` behavior. Unparseable input returns it whole in `domain` so the caller renders it at full contrast. Empty input returns `domain: 'New Tab'`.

- [ ] **Step 1: Register the test file so it actually runs**

In `frontend/vite.config.ts`, add one entry to the `test.include` array (it currently ends with `'src/lib/fuzzyHighlight.test.ts',`):

```ts
    include: [
      'src/features/palette/**/*.test.{ts,tsx}',
      'src/features/ssh/{sshCommand,sshQuickAdd,jumpHostDraft}.test.ts',
      'src/features/tabs/tileTree.ssh.test.ts',
      'src/lib/fuzzyHighlight.test.ts',
      'src/features/browser/splitUrlForDisplay.test.ts',
    ],
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/features/browser/splitUrlForDisplay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { splitUrlForDisplay } from '@/features/browser/splitUrlForDisplay'

describe('splitUrlForDisplay', () => {
  it('splits a www subdomain off the registrable domain', () => {
    expect(splitUrlForDisplay('https://www.youtube.com/')).toEqual({
      prefix: 'www.',
      domain: 'youtube.com',
      rest: '',
    })
  })

  it('treats a bare two-label host as all domain', () => {
    expect(splitUrlForDisplay('https://example.com/')).toEqual({
      prefix: '',
      domain: 'example.com',
      rest: '',
    })
  })

  it('keeps path, query and hash in rest', () => {
    expect(splitUrlForDisplay('https://docs.example.com/a/b?q=1#top')).toEqual({
      prefix: 'docs.',
      domain: 'example.com',
      rest: '/a/b?q=1#top',
    })
  })

  it('strips a trailing slash from a non-root path', () => {
    expect(splitUrlForDisplay('http://example.com/dashboard/')).toEqual({
      prefix: '',
      domain: 'example.com',
      rest: '/dashboard',
    })
  })

  it('keeps a multi-part public suffix intact', () => {
    expect(splitUrlForDisplay('https://shop.google.co.uk/cart')).toEqual({
      prefix: 'shop.',
      domain: 'google.co.uk',
      rest: '/cart',
    })
  })

  it('keeps the port on the domain for localhost', () => {
    expect(splitUrlForDisplay('http://localhost:5173/w/1')).toEqual({
      prefix: '',
      domain: 'localhost:5173',
      rest: '/w/1',
    })
  })

  it('treats an IPv4 literal as a single domain', () => {
    expect(splitUrlForDisplay('http://192.168.1.10:8080/status')).toEqual({
      prefix: '',
      domain: '192.168.1.10:8080',
      rest: '/status',
    })
  })

  it('returns non-URL search text whole, at full contrast', () => {
    expect(splitUrlForDisplay('how to center a div')).toEqual({
      prefix: '',
      domain: 'how to center a div',
      rest: '',
    })
  })

  it('reads an empty url as New Tab', () => {
    expect(splitUrlForDisplay('')).toEqual({ prefix: '', domain: 'New Tab', rest: '' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- splitUrlForDisplay`
Expected: FAIL — `Failed to load url .../splitUrlForDisplay` (module does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `frontend/src/features/browser/splitUrlForDisplay.ts`:

```ts
/** The omnibox renders a URL in two contrast tiers (design spec §3.3): the
 *  registrable domain at full contrast, everything around it dimmed. That is
 *  the emphasis every mainstream browser uses, and it is what makes an 11px
 *  URL scannable. This module owns only the split — the styling lives in
 *  `BrowserOmnibox`. Sibling of `displayUrl.ts`, whose trailing-slash rules
 *  it deliberately mirrors. */
export interface UrlParts {
  /** Subdomain labels including the trailing dot (`"www."`), or `''`. */
  prefix: string
  /** Registrable domain plus `:port`. Also the fallback bucket: unparseable
   *  input lands here whole, so the caller renders it at full contrast. */
  domain: string
  /** Path + search + hash, root-only `/` dropped. */
  rest: string
}

/** Second-level labels that are part of a public suffix rather than a
 *  registrable domain, so `google.co.uk` doesn't split as `co.uk`. A full
 *  Public Suffix List is far more than this display concern warrants. */
const PUBLIC_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'])

function splitHost(hostname: string): { prefix: string; domain: string } {
  // IPv6 literals arrive bracketed; IPv4 and single-label hosts (`localhost`)
  // have no registrable domain to isolate.
  if (hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return { prefix: '', domain: hostname }
  }
  const labels = hostname.split('.')
  if (labels.length <= 2) return { prefix: '', domain: hostname }

  const tld = labels[labels.length - 1]
  const secondLevel = labels[labels.length - 2]
  const take = tld.length === 2 && PUBLIC_SECOND_LEVEL.has(secondLevel) ? 3 : 2
  if (labels.length <= take) return { prefix: '', domain: hostname }

  return {
    prefix: `${labels.slice(0, -take).join('.')}.`,
    domain: labels.slice(-take).join('.'),
  }
}

export function splitUrlForDisplay(url: string): UrlParts {
  if (!url) return { prefix: '', domain: 'New Tab', rest: '' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { prefix: '', domain: url, rest: '' }
  }

  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  const { prefix, domain } = splitHost(parsed.hostname)

  return {
    prefix,
    domain: parsed.port ? `${domain}:${parsed.port}` : domain,
    rest: `${path}${parsed.search}${parsed.hash}`,
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- splitUrlForDisplay`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify the full suite did not regress**

Run: `npm test`
Expected: 15 test files, 179 tests passed (170 baseline + 9 new).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/features/browser/splitUrlForDisplay.ts src/features/browser/splitUrlForDisplay.test.ts vite.config.ts
git commit -m "feat(browser): add splitUrlForDisplay for tiered URL rendering"
```

---

### Task 2: `ProgressLine` + motion tokens

Spec §4.1, §7.1, §7.4, §8.

**Files:**
- Modify: `frontend/src/styles/globals.css:187-210`
- Create: `frontend/src/components/ui/progress-line.tsx`
- Create: `frontend/src/components/ui/progress-line.test.tsx`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `function ProgressLine(props: { active: boolean; delayMs?: number; className?: string })`. Task 6 mounts it inside a `relative` chrome wrapper. It renders `null` when hidden, and a `role="progressbar"` element when shown.

**Why indeterminate:** `browserTilesBridge.ts:133` delivers `loading: boolean` with no percentage. A determinate bar would fabricate progress.

- [ ] **Step 1: Add the motion tokens and keyframes**

In `frontend/src/styles/globals.css`, extend the `--animate-*` block (currently ending `--animate-slide-in: agslidein 0.18s ease;`) to:

```css
  --animate-blink: agblink 1.1s step-end infinite;
  --animate-slide-in: agslidein 0.18s ease;
  --animate-progress-slide: agprogress 1.1s ease-in-out infinite;
  --animate-dot-pulse: agdotpulse 1.4s ease-in-out infinite;
```

Then add these after the existing `@keyframes agslidein { ... }` block:

```css
/* The segment is 30% of the track, so travelling from fully off-left to
   fully off-right is -100% → 333% of its *own* width. */
@keyframes agprogress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(333%);
  }
}
@keyframes agdotpulse {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .animate-progress-slide {
    width: 100%;
    opacity: 0.4;
    transform: none;
    animation: none;
  }
  .animate-dot-pulse {
    animation: none;
  }
}
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts`, add to `test.include`:

```ts
      'src/components/ui/progress-line.test.tsx',
```

- [ ] **Step 3: Write the failing test**

Create `frontend/src/components/ui/progress-line.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ProgressLine } from '@/components/ui/progress-line'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('ProgressLine', () => {
  it('renders nothing while inactive', () => {
    render(<ProgressLine active={false} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('waits out the delay before showing', () => {
    vi.useFakeTimers()
    render(<ProgressLine active delayMs={150} />)
    expect(screen.queryByRole('progressbar')).toBeNull()

    advance(149)
    expect(screen.queryByRole('progressbar')).toBeNull()

    advance(1)
    expect(screen.getByRole('progressbar')).toBeTruthy()
  })

  it('never shows when loading finishes inside the delay window', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ProgressLine active delayMs={150} />)

    advance(100)
    rerender(<ProgressLine active={false} delayMs={150} />)
    advance(500)

    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('fades out rather than unmounting instantly', () => {
    vi.useFakeTimers()
    const { rerender } = render(<ProgressLine active delayMs={150} />)
    advance(150)
    expect(screen.getByRole('progressbar')).toBeTruthy()

    rerender(<ProgressLine active={false} delayMs={150} />)
    // Still mounted, now transparent — this is the 180ms fade.
    expect(screen.getByRole('progressbar').className).toContain('opacity-0')

    advance(180)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- progress-line`
Expected: FAIL — cannot resolve `@/components/ui/progress-line`.

- [ ] **Step 5: Write the implementation**

Create `frontend/src/components/ui/progress-line.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/** How long the bar takes to fade out once loading ends. Must match the
 *  `duration-[180ms]` on the element below. */
const FADE_MS = 180

export interface ProgressLineProps {
  active: boolean
  /** Grace period before the bar appears. Cache-served navigations resolve in
   *  a frame or two; without this the bar flashes once and reads as a glitch
   *  rather than as progress (design spec §4.1). */
  delayMs?: number
  className?: string
}

type Phase = 'hidden' | 'visible' | 'leaving'

/** Indeterminate 2px progress line. Indeterminate by necessity, not by
 *  preference: the native webview bridge reports only `loading: boolean`, so a
 *  determinate bar would be inventing a percentage. Absolutely positioned —
 *  the caller supplies a `relative` ancestor. */
export function ProgressLine({ active, delayMs = 150, className }: ProgressLineProps) {
  const [phase, setPhase] = useState<Phase>('hidden')

  // One effect, keyed on `phase` as well as `active`: the leaving branch
  // re-arms its own timer after the `setPhase('leaving')` re-render clears it,
  // which two separate effects could not do without a ref.
  useEffect(() => {
    if (active) {
      if (phase === 'visible') return
      const timer = setTimeout(() => setPhase('visible'), delayMs)
      return () => clearTimeout(timer)
    }
    if (phase === 'hidden') return
    const timer = setTimeout(() => setPhase('hidden'), FADE_MS)
    if (phase !== 'leaving') setPhase('leaving')
    return () => clearTimeout(timer)
  }, [active, delayMs, phase])

  if (phase === 'hidden') return null

  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      aria-busy={phase === 'visible'}
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-0.5 overflow-hidden',
        'transition-opacity duration-[180ms] ease-out',
        phase === 'leaving' ? 'opacity-0' : 'opacity-100',
        className,
      )}
    >
      <span
        className="animate-progress-slide block h-full w-[30%] rounded-full"
        style={{ background: 'var(--devdeck-accent-gradient)' }}
      />
    </div>
  )
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- progress-line`
Expected: PASS, 4 tests.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
npm test          # expect 16 files, 183 tests
npm run typecheck
git add src/components/ui/progress-line.tsx src/components/ui/progress-line.test.tsx src/styles/globals.css vite.config.ts
git commit -m "feat(ui): add indeterminate ProgressLine with show delay and fade"
```

---

### Task 3: `Select` gains a custom value renderer

Spec §3.3 — the machine chip needs a `StatusDot` beside a truncated label, which `BaseSelect.Value` cannot express.

**Files:**
- Modify: `frontend/src/components/ui/select.tsx:14-22` (props), `:59-62` (trigger body)

**Interfaces:**
- Consumes: nothing.
- Produces: two optional props on the existing `Select`. `renderValue?: (option: SelectOption | undefined) => ReactNode` replaces the default `<BaseSelect.Value />`. `chevronSize?: number` (default `13`) sizes the trailing `ChevronDown`. Task 4 passes both.

**Constraint:** additive only. Every existing call site (`BrowserToolbar`, machine pickers elsewhere) must keep compiling untouched.

- [ ] **Step 1: Add the props to the interface**

In `frontend/src/components/ui/select.tsx`, add a `ReactNode` type import at the top:

```ts
import { useRef, useState, type ReactNode } from 'react'
```

Then extend `SelectProps`:

```ts
interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  className?: string
  triggerClassName?: string
  disabled?: boolean
  /** Replaces the default `<BaseSelect.Value />` when the trigger needs more
   *  than a text label — e.g. the browser omnibox's machine chip, which pairs
   *  a `StatusDot` with a truncated name. Receives the currently selected
   *  option, or `undefined` when `value` matches nothing. */
  renderValue?: (option: SelectOption | undefined) => ReactNode
  /** Default 13. Compact triggers need a smaller chevron. */
  chevronSize?: number
  'aria-label'?: string
}
```

- [ ] **Step 2: Destructure and use them**

Change the signature:

```ts
export function Select({
  value,
  onValueChange,
  options,
  className,
  triggerClassName,
  disabled,
  renderValue,
  chevronSize = 13,
  ...rest
}: SelectProps) {
```

Then replace the trigger body (the `<BaseSelect.Value className="truncate" />` and `<BaseSelect.Icon>` pair) with:

```tsx
        {/* The trigger is a fixed-height row, so a long value (e.g. a machine
            hostname in a narrow browser toolbar) has to truncate — left to wrap
            it doubles the trigger's height and pushes its own toolbar out. */}
        {renderValue ? renderValue(options.find((o) => o.value === value)) : <BaseSelect.Value className="truncate" />}
        <BaseSelect.Icon className="flex-none text-devdeck-dim">
          <ChevronDown size={chevronSize} />
        </BaseSelect.Icon>
```

- [ ] **Step 3: Verify nothing regressed**

```bash
npm run typecheck   # expect clean — both props are optional
npm test            # expect 16 files, 183 tests
```

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/select.tsx
git commit -m "feat(ui): let Select render a custom trigger value"
```

---

### Task 4: `BrowserOmnibox`

Spec §3.3.

**Files:**
- Create: `frontend/src/features/browser/BrowserOmnibox.tsx`

**Interfaces:**
- Consumes: `splitUrlForDisplay` (Task 1); `Select`'s `renderValue` + `chevronSize` (Task 3); the existing `BrowserFaviconChip` (`{ seed, title, iconDataUrl?, size? }`), `StatusDot` (`{ color, size? }`), and `MachineHealth` (`{ status: 'online' | 'offline'; latencyMs?: number }`).
- Produces: `function BrowserOmnibox(props: BrowserOmniboxProps)` — Task 5 renders it as `BrowserToolbar`'s `children`.

**Layout rule:** `prefix` and `domain` are `flex-none`; only `rest` truncates. The path is therefore cut before the domain, so the part that matters survives longest.

**Narrow tiles:** the machine chip's text label is `hidden @sm/tile:inline` — below that breakpoint only the `StatusDot` shows. `BrowserTile` already establishes `@container/tile`.

- [ ] **Step 1: Write the component**

Create `frontend/src/features/browser/BrowserOmnibox.tsx`:

```tsx
import { Star } from 'lucide-react'
import { Select } from '@/components/ui/select'
import { StatusDot } from '@/components/ui/status-dot'
import { cn } from '@/lib/utils'
import type { MachineHealth } from '@/lib/api'
import type { Machine } from '@/store/types'
import { BrowserFaviconChip } from './BrowserFaviconChip'
import { splitUrlForDisplay } from './splitUrlForDisplay'

export interface BrowserOmniboxProps {
  /** Seeds the favicon chip — the active doc's id. */
  docId: string
  url: string
  title: string
  machineId: string
  machines: Machine[]
  machineHealth: Map<string, MachineHealth | undefined>
  onSelectMachine: (machineId: string) => void
  /** Opens `BrowserUrlCard`. Fires from the URL area only, never from the
   *  machine chip or the star. */
  onEdit: () => void
  /** Opens `BookmarkDialog`. The star lives here rather than in the toolbar's
   *  right cluster because it acts on the *address*, not the window. */
  onBookmark: () => void
}

function dotColor(status: MachineHealth['status'] | undefined): string {
  if (status === 'online') return 'var(--devdeck-green)'
  if (status === 'offline') return 'var(--devdeck-red)'
  return 'var(--devdeck-dim)'
}

/** The toolbar's center zone and its anchor (design spec §3.3). Replaces both
 *  the old centered single-tab pill and the 112px machine `Select` that used
 *  to dominate the right cluster. */
export function BrowserOmnibox({
  docId,
  url,
  title,
  machineId,
  machines,
  machineHealth,
  onSelectMachine,
  onEdit,
  onBookmark,
}: BrowserOmniboxProps) {
  const { prefix, domain, rest } = splitUrlForDisplay(url)
  const options = machines.map((m) => ({
    value: m.id,
    label: m.name,
    disabled: machineHealth.get(m.id)?.status === 'offline',
  }))
  const machineName = machines.find((m) => m.id === machineId)?.name ?? 'No machine'

  return (
    <div
      className={cn(
        'flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border bg-devdeck-surface-2 pl-2 pr-1',
        'border-devdeck-border-card transition-colors',
        'hover:border-devdeck-border-strong focus-within:border-devdeck-border-strong',
        'max-w-[640px] pointer-coarse:h-9',
      )}
    >
      <BrowserFaviconChip seed={docId} title={title} size={14} />
      {/* Sibling of the Select trigger, never its ancestor — nesting two
          interactive elements is invalid HTML and overlaps their hit areas. */}
      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit address"
        className="flex min-w-0 flex-1 items-center text-left text-[11px] focus-visible:outline-none pointer-coarse:text-[13px]"
      >
        <span className="flex-none text-devdeck-dim">{prefix}</span>
        <span className="flex-none font-medium text-devdeck-fg">{domain}</span>
        <span className="min-w-0 truncate text-devdeck-dim">{rest}</span>
      </button>
      <span aria-hidden className="h-3 w-px flex-none bg-devdeck-border" />
      <Select
        value={machineId}
        onValueChange={onSelectMachine}
        options={options}
        chevronSize={10}
        aria-label={`Machine: ${machineName}`}
        triggerClassName={cn(
          'h-5 w-auto min-w-0 flex-none gap-1 rounded-full border-none bg-transparent px-1.5',
          'text-[10.5px] hover:bg-devdeck-hover-wash pointer-coarse:h-7',
        )}
        renderValue={(option) => (
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusDot color={dotColor(machineHealth.get(machineId)?.status)} size={6} />
            <span className="hidden max-w-[72px] truncate @sm/tile:inline">{option?.label ?? 'No machine'}</span>
          </span>
        )}
      />
      <button
        type="button"
        onClick={onBookmark}
        disabled={!url}
        aria-label="Bookmark this page"
        className={cn(
          'flex h-5 w-5 flex-none items-center justify-center rounded-full text-devdeck-dim transition-colors',
          'hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2 disabled:opacity-40 disabled:hover:bg-transparent',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/60 pointer-coarse:h-7 pointer-coarse:w-7',
        )}
      >
        <Star size={11} />
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. (The component is not mounted yet — Task 5 does that.)

- [ ] **Step 3: Commit**

```bash
git add src/features/browser/BrowserOmnibox.tsx
git commit -m "feat(browser): add BrowserOmnibox with tiered URL and machine chip"
```

---

### Task 5: `BrowserToolbar` — three fixed zones

Spec §3.1, §3.4, §4.2.

**Files:**
- Modify: `frontend/src/features/browser/BrowserToolbar.tsx` (whole file)

**Interfaces:**
- Consumes: `BrowserOmnibox` via `children` (Task 4).
- Produces: `BrowserToolbarProps` **minus** `machineId`, `machines`, `machineHealth`, `onSelectMachine`, `onBookmark` (all five move to `BrowserOmnibox`, which `BrowserTile` constructs directly) and **plus** `onNewTab: () => void`. Task 6 updates the call site.

**Three defects this fixes:**
1. `:109` renders back/forward conditionally, so the first navigation shifts the whole row sideways. They now always render, `disabled` when unavailable.
2. The 112px machine `Select` leaves the right cluster entirely.
3. `:127` swaps the reload glyph to a static `X`, killing the only motion cue.

**Reload behavior:** while `loading`, show a spinning `RefreshCw`; swap to `X` on hover or keyboard focus. Touch has no hover, so under `pointer-coarse` show `X` immediately. Implement the swap with CSS group state — no JS hover tracking — and keep `aria-label` describing the action the click performs (`"Stop"` while loading, `"Reload"` otherwise).

- [ ] **Step 1: Replace the file**

Overwrite `frontend/src/features/browser/BrowserToolbar.tsx`:

```tsx
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Home, Maximize2, Minimize2, MoreHorizontal, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { cn } from '@/lib/utils'

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
  onNewTab: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  /** `BrowserOmnibox` — the row's centered anchor. A separate component per
   *  the one-component-per-file convention; this toolbar owns only the row
   *  shell and its two icon clusters. */
  children: ReactNode
}

/** Fixed single row, `h-9`, three zones that never move relative to each
 *  other (design spec §3.1). Back/forward are always mounted — rendering them
 *  conditionally made the first navigation shove the whole row sideways. */
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
  onNewTab,
  fullscreen,
  onToggleFullscreen,
  children,
}: BrowserToolbarProps) {
  // Rendered twice — inline above `@sm/tile`, inside the "…" popover below it
  // (design spec §3.1). The machine picker that used to live here now sits in
  // the omnibox, so there is nothing left that needs a compact variant.
  const rightCluster = (
    <>
      <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onNewTab} aria-label="New tab" title="New tab (⌘T)">
        <Plus size={12} />
      </Button>
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
      <div className="flex flex-none items-center gap-1">
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onBack} disabled={!canGoBack} aria-label="Back">
          <ArrowLeft size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={onForward} disabled={!canGoForward} aria-label="Forward">
          <ArrowRight size={12} />
        </Button>
        <Button
          size="icon-sm"
          variant="secondary"
          className={cn(toolbarButtonClass, 'group')}
          onClick={loading ? onStop : onReload}
          disabled={!hasUrl}
          aria-label={loading ? 'Stop' : 'Reload'}
        >
          {loading ? (
            <>
              {/* Spin by default, reveal the stop affordance on hover/focus.
                  Touch pointers get `X` outright — hover is unreachable. */}
              <RefreshCw
                size={12}
                className="animate-spin [animation-duration:900ms] group-hover:hidden group-focus-visible:hidden pointer-coarse:hidden"
              />
              <X size={12} className="hidden group-hover:block group-focus-visible:block pointer-coarse:block" />
            </>
          ) : (
            <RefreshCw size={12} />
          )}
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 justify-center px-2">{children}</div>

      <div className="hidden flex-none items-center gap-1 @sm/tile:flex">{rightCluster}</div>
      <div className="flex-none @sm/tile:hidden">
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
          <div className="grid w-44 gap-1 p-1">{rightCluster}</div>
        </TabStripPopoverMenu>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Confirm the expected compile error**

Run: `npm run typecheck`
Expected: FAIL in `BrowserTile.tsx` — it still passes `machineId` / `machines` / `machineHealth` / `onSelectMachine` and does not pass `onNewTab`. Task 6 fixes exactly this. **Do not commit a broken typecheck** — continue straight to Task 6 and commit them together.

---

### Task 6: Collapse the strip and wire loading

Spec §3.2, §3.4, §4.1.

**Files:**
- Modify: `frontend/src/features/browser/BrowserTabStrip.tsx:51-75`
- Modify: `frontend/src/features/browser/BrowserTile.tsx:457-489`

**Interfaces:**
- Consumes: `BrowserToolbar`'s new props (Task 5), `BrowserOmnibox` (Task 4), `ProgressLine` (Task 2).
- Produces: `BrowserTabStripProps` **minus** `onAdd` (the `+` moved to the toolbar) and **minus** `onEditActiveUrl` (the omnibox owns URL editing now; the strip's job is switching only).

**Behavioral change:** clicking the active pill in the strip no longer opens the URL card — with the strip visible there are 2+ docs, and the omnibox below is always the address affordance. This removes the `onSelect` branch at `BrowserTabStrip.tsx:60`.

- [ ] **Step 1: Simplify `BrowserTabStrip`**

In `frontend/src/features/browser/BrowserTabStrip.tsx`:

Remove `Plus` from the lucide import (keep `X`):

```ts
import { X } from 'lucide-react'
```

Replace the props interface:

```ts
export interface BrowserTabStripProps {
  docs: BrowserDocState[]
  activeDocId: string
  onSelect: (docId: string) => void
  onClose: (docId: string) => void
}
```

Update the doc comment above the component and its signature/body — replace from `/** Centered, clips rather than scrolls` through the closing `)}\n}` of the exported function with:

```tsx
/** Left-aligned, clips rather than scrolls (design spec §3.2) —
 *  `overflow-hidden` lets each pill's own `truncate` compress before the strip
 *  would ever need a scroll affordance. Left-aligned, not centered: a centered
 *  strip reads as decoration, a left-aligned one reads as tabs. Rendered only
 *  at 2+ docs; `BrowserTile` owns that guard. */
export function BrowserTabStrip({ docs, activeDocId, onSelect, onClose }: BrowserTabStripProps) {
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

  return (
    <div className="flex h-8 min-w-0 flex-none items-center justify-start gap-1 overflow-hidden border-b border-devdeck-border bg-devdeck-bg px-2">
      {pills.map((pill) => (
        <TabPill
          key={pill.id}
          doc={pill.doc}
          active={pill.id === activeDocId}
          single={false}
          closing={pill.closing}
          onSelect={() => onSelect(pill.id)}
          onClose={() => onClose(pill.id)}
          onShrinkComplete={() => setPills((current) => current.filter((p) => p.id !== pill.id))}
        />
      ))}
    </div>
  )
}
```

Leave `TabPill` itself, `PillRecord`, and the remaining imports (`useEffect`, `useState`, `cn`, `BrowserDocState`, `BrowserFaviconChip`, `tabPillTargetWidth`, `displayUrl`) exactly as they are.

- [ ] **Step 2: Wire `BrowserTile`**

In `frontend/src/features/browser/BrowserTile.tsx`, add these imports alongside the existing browser-feature imports:

```ts
import { ProgressLine } from '@/components/ui/progress-line'
import { BrowserOmnibox } from './BrowserOmnibox'
```

Replace the `<BrowserToolbar>…</BrowserToolbar>` block (currently `:462-489`) with:

```tsx
      {/* `relative` so ProgressLine can pin itself to the chrome's bottom seam
          — it spans the tile's full width, reading as "this tile is loading"
          rather than decorating any one control. */}
      <div className="relative flex-none">
        {tile.docs.length > 1 ? (
          <BrowserTabStrip
            docs={tile.docs}
            activeDocId={tile.activeDocId}
            onSelect={(docId) => selectBrowserDoc(tabId, docId)}
            onClose={(docId) => void closeInternalTab(docId)}
          />
        ) : null}
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
          onNewTab={() => addBrowserDoc(tabId)}
          fullscreen={tile.fullscreen}
          onToggleFullscreen={() => setBrowserTileFullscreen(tabId, !tile.fullscreen)}
        >
          <BrowserOmnibox
            docId={doc.id}
            url={doc.url ?? ''}
            title={doc.title}
            machineId={doc.machineId ?? ''}
            machines={machines}
            machineHealth={machineHealth}
            onSelectMachine={(machineId) => void selectMachine(machineId)}
            onEdit={() => setUrlCardOpen(true)}
            onBookmark={openBookmarkDialog}
          />
        </BrowserToolbar>
        <ProgressLine active={doc.loading} />
      </div>
```

`openBookmarkDialog` keeps its existing definition and stays wired — it simply moves from the toolbar's `onBookmark` prop to the omnibox's. `BookmarkDialog` at the bottom of the file is untouched.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Full suite and build**

```bash
npm test        # expect 16 files, 183 tests
npm run build   # expect success
```

- [ ] **Step 5: Commit Tasks 5 + 6 together**

```bash
git add src/features/browser/BrowserToolbar.tsx src/features/browser/BrowserTabStrip.tsx src/features/browser/BrowserTile.tsx
git commit -m "feat(browser): collapse single-doc tab strip into a centered omnibox"
```

---

### Task 7: Workspace tab pill — quieter, and loading-aware

Spec §4.3, §5.

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx:106-119` (`TabDot`), `:322-337` (`wrapperClass`), `:361-392` (`trailingAction`), `:445-465` (browser branch)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by other tasks.

**Critical constraint — do not route `loading` through `resolveBrowserTab`.** That helper (`WorkspaceTileArea.tsx:178-182`) reads `useDevDeckStore.getState()`, a **non-reactive snapshot** taken during render. A `loading` field added there would never trigger a re-render when the flag flips, and the dot would sit frozen. Subscribe in `TileTabButton` instead.

**Hook rule:** call the selector **unconditionally** at the top of `TileTabButton`, before any `if (tab.kind === …)` early return. The selector itself returns `false` for non-browser tabs.

- [ ] **Step 1: Make `TabDot` loading-aware**

Replace `TabDot` (`:106-119`):

```tsx
function TabDot({ active, focused, loading = false }: { active: boolean; focused: boolean; loading?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 flex-none rounded-full transition-[background-color,box-shadow] duration-150',
        // Loading outranks active/focused: a background tile that is fetching
        // is the one thing the strip can tell you that nothing else can.
        loading
          ? 'animate-dot-pulse bg-devdeck-accent shadow-[0_0_0_2px_rgba(57,198,189,0.16)]'
          : active
            ? focused
              ? 'bg-devdeck-green shadow-[0_0_0_2px_rgba(86,213,138,0.14),0_0_7px_rgba(86,213,138,0.22)]'
              : 'bg-devdeck-green/40'
            : 'bg-devdeck-dim-3',
      )}
    />
  )
}
```

- [ ] **Step 2: Subscribe to the active doc's loading flag**

At the very top of `TileTabButton`'s body — immediately before the existing `const { attributes, listeners, setNodeRef, isDragging } = useDraggable({…})` call — insert:

```tsx
  // Subscribed, not read via getState(): `resolveBrowserTab` takes a snapshot
  // during render, so a loading flag routed through it would never re-render
  // this dot. Called unconditionally — the selector short-circuits for tabs
  // that aren't browsers.
  const browserLoading = useDevDeckStore((s) => {
    if (tab.kind !== 'browser') return false
    const tile = s.browserTiles[tab.id]
    return tile?.docs.find((d) => d.id === tile.activeDocId)?.loading ?? false
  })
```

Verify `useDevDeckStore` is already imported in this file; if not, add `import { useDevDeckStore } from '@/store/useDevDeckStore'`.

Then in the `tab.kind === 'browser'` branch (`:458`), change the dot to:

```tsx
          <TabDot active={active} focused={focused} loading={browserLoading} />
```

Leave the `worktree`, `ssh-shell`, and default branches' `<TabDot active={active} focused={focused} />` untouched.

- [ ] **Step 3: Quiet the pill**

Replace `wrapperClass` (`:322-337`) with:

```tsx
  const wrapperClass = (dragging: boolean) =>
    cn(
      'group flex flex-none touch-none cursor-grab items-center gap-1.5 rounded-[9px] border',
      'transition-[background-color,border-color,color,opacity] duration-150 active:cursor-grabbing',
      // Wider than the old label-only pills: a worktree tab now carries a
      // "<project>/<machine> · " origin prefix ahead of its session name.
      compact
        ? 'h-6 max-w-[200px] rounded-[7px] pl-2 pr-1 text-[11px]'
        : 'h-8 max-w-[270px] pl-2.5 pr-1.5 text-[12px]',
      // Two affordances for "active", not five: fill plus the dot. The border
      // and the two shadows this used to stack read as a *button*, not a tab —
      // and the hover border cost a 1px reflow on every pointer pass.
      active && focused
        ? 'border-transparent bg-devdeck-elevated text-devdeck-fg'
        : active
          ? 'border-transparent bg-devdeck-surface-2 text-devdeck-fg-2'
          : 'border-transparent bg-transparent text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
      dragging && 'opacity-40',
    )
```

Note `font-mono` is gone (a page title is prose, not code) and the size rose 11.5px → 12px.

- [ ] **Step 4: Quiet the shortcut badge**

In `trailingAction`, both `<kbd>` elements currently use `active ? 'opacity-75' : 'opacity-35'`. Change **both** occurrences to:

```tsx
            active ? 'opacity-75' : 'opacity-0 group-hover:opacity-60',
```

The `<kbd>`-hides-on-hover-to-reveal-close mechanism around them stays exactly as-is. The `<kbd>` keeps `font-mono` — that one *is* code.

- [ ] **Step 5: Verify**

```bash
npm run typecheck
npm test        # expect 16 files, 183 tests — tileTree.ssh.test.ts must still pass
```

- [ ] **Step 6: Commit**

```bash
git add src/features/tabs/WorkspaceTileCanvas.tsx
git commit -m "feat(tabs): quiet the tab pill and pulse its dot while loading"
```

---

### Task 8: Left rail

Spec §6.

**Files:**
- Modify: `frontend/src/features/sidebar/SidebarNav.tsx` (whole file)
- Modify: `frontend/src/features/sidebar/Sidebar.tsx:83-95`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by other tasks.

**Why an edge bar:** `SidebarNav.tsx:58`'s `ring-1 ring-inset ring-devdeck-border-accent` is too low-contrast to register peripherally. A bar at the rail's own edge is readable without being looked at.

**Why green:** the badge means "N worktrees running" — a health signal. Today it is `bg-devdeck-accent-soft` sitting on `bg-devdeck-accent-tint`, so it nearly vanishes on the one item that is active.

- [ ] **Step 1: Rewrite `SidebarNav`**

Overwrite `frontend/src/features/sidebar/SidebarNav.tsx`:

```tsx
import { useNavigate } from '@tanstack/react-router'
import { SquareTerminal, LayoutGrid, Server, Wrench, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useScope } from '@/features/useScope'
import { useWorkspace } from '@/features/data/queries'
import type { ModuleView } from '@/store/types'

interface RailDef {
  key: Extract<ModuleView, 'agents' | 'ssh' | 'database' | 'tools' | 'invoices' | 'machines'>
  label: string
  Icon: LucideIcon
  badge?: number
}

interface SidebarNavProps {
  compact?: boolean
}

export function SidebarNav({ compact: _compact }: SidebarNavProps = {}) {
  const navigate = useNavigate()
  const { wsId, view } = useScope()
  const workspace = useWorkspace(wsId)
  const ws = workspace.data
  const runningHosts = ws?.projects.flatMap((project) => project.worktrees).filter((worktree) => worktree.state === 'running').length ?? 0

  const items: RailDef[] = [
    { key: 'agents', label: 'Agents', Icon: LayoutGrid, badge: runningHosts },
    { key: 'machines', label: 'Runtimes', Icon: Server },
    { key: 'ssh', label: 'SSH', Icon: SquareTerminal },
    { key: 'tools', label: 'Tools', Icon: Wrench },
  ]

  function goto(key: RailDef['key']) {
    if (!wsId) return
    if (key === 'agents') navigate({ to: '/w/$wsId', params: { wsId } })
    else if (key === 'machines') navigate({ to: '/w/$wsId/machines', params: { wsId } })
    else navigate({ to: `/w/$wsId/${key}`, params: { wsId } })
  }

  return (
    <nav className="flex w-full flex-none flex-col items-center gap-1 px-2 py-2" aria-label="Primary menu">
      {items.map((item) => {
        const active = view === item.key
        // Gate on `isSuccess`, not on the count: rendering `?? 0` immediately
        // makes the badge pop 0 → N a beat after first paint.
        const showBadge = workspace.isSuccess && !!item.badge
        return (
          <Tooltip key={item.key} label={item.label} side="right">
            <button
              type="button"
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => goto(item.key)}
              className={cn(
                'group relative flex h-10 w-10 cursor-pointer items-center justify-center rounded-[11px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'bg-devdeck-accent-tint text-devdeck-accent-soft'
                  : 'text-devdeck-muted hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
              )}
            >
              {/* Active marker at the rail's own edge. An inset ring — what this
                  replaces — is invisible in peripheral vision; a bar at the
                  container edge is not. */}
              <span
                aria-hidden
                className={cn(
                  'absolute -left-2 h-4 w-0.5 rounded-r-full bg-devdeck-accent transition-opacity duration-150',
                  active ? 'opacity-100' : 'opacity-0',
                )}
              />
              <item.Icon size={18} strokeWidth={active ? 2.2 : 1.9} />
              {showBadge ? (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-devdeck-green ring-2 ring-devdeck-surface" />
              ) : null}
            </button>
          </Tooltip>
        )
      })}
    </nav>
  )
}
```

Note the marker is a per-item element toggled by opacity rather than one shared sliding bar — a shared bar would need a measured offset and a ref into each button, which is materially more machinery for a 4-item rail. Opacity crossfade also degrades correctly under reduced motion without a media query.

- [ ] **Step 2: Add the group hairlines in `Sidebar`**

In `frontend/src/features/sidebar/Sidebar.tsx`, define the divider next to `railControlClass` (around `:49`):

```tsx
  const railDivider = <div aria-hidden className="my-1.5 h-px w-6 flex-none bg-devdeck-border" />
```

Then in the rail column, change:

```tsx
          <WorkspaceSwitcher compact />
          <SidebarNav compact />
          <div className="flex-1" />
```

to:

```tsx
          <WorkspaceSwitcher compact />
          {railDivider}
          <SidebarNav compact />
          <div className="flex-1" />
          {isRuntimeUI || showDesktopSettings ? railDivider : null}
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck
npm test        # expect 16 files, 183 tests
npm run build   # expect success
```

- [ ] **Step 4: Commit**

```bash
git add src/features/sidebar/SidebarNav.tsx src/features/sidebar/Sidebar.tsx
git commit -m "feat(sidebar): edge-bar active marker, green running badge, group dividers"
```

---

## Final verification

- [ ] `npm test` — 16 files, 183 tests passed, zero failures.
- [ ] `npm run typecheck` — clean.
- [ ] `npm run build` — succeeds.
- [ ] `git log --oneline` shows 7 feature commits on top of the spec commit.
- [ ] Manual, desktop/Tauri only (the native webview is what drives `loading`):
  - Open a browser tile with one doc → chrome is one 36px row, no inner tab strip.
  - Open a second doc via the toolbar `+` → strip appears above the toolbar, left-aligned.
  - Load a slow page → progress line animates at the chrome's bottom seam; reload button spins; hovering it shows the stop `X`.
  - Load a cached page → the progress line does **not** flash.
  - Split the tile and load in the unfocused one → its workspace tab dot pulses.
  - Narrow a tile below `@sm/tile` → machine chip collapses to the status dot alone; the URL truncates from the path end, never the domain.

# Browser Tile Bug Fixes + Localhost Address Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four confirmed bugs in DevDeck's desktop-only native-webview `BrowserTile` (proxy-start error handling, in-page navigation history tracking, native-webview z-index gaps, divider-drag position drift) and add a localhost→machine-address URL rewrite, per `docs/superpowers/specs/2026-07-31-browser-tile-bugfixes-design.md`.

**Architecture:** Three bugs are pure-logic extractions into new `frontend/src/lib/*.ts` helper files (unit-tested with this repo's existing framework-free `tsx`-run convention), wired into `BrowserTile.tsx`. The fourth (position drift) and the nine z-index gaps are one-line hook/state wiring changes to existing components, verified by typecheck + manual interaction (this repo has no component-test framework — see Global Constraints).

**Tech Stack:** React 19, TypeScript (`verbatimModuleSyntax`), zustand, `@base-ui/react`, `sonner`, Tauri v2. No test runner is installed — pure-logic tests use hand-rolled `check`/`assertEqual` scripts run via `npx tsx`.

## Global Constraints

- This is ordinary application feature work (a desktop browser tab feature), not security-sensitive code — terms like "proxy", "token", "SOCKS5", "context menu" below refer to normal app functionality, not exploit development.
- Use the `@/*` path alias for all imports from `src/` in `.ts`/`.tsx` source files — **except** new `.test.ts` files, which must use relative imports (e.g. `./browserProxy`), matching every existing `*.test.ts` file in this repo (they run via plain `npx tsx`, which does not resolve the `@/*` alias — only `tsc`/Vite do, via `tsconfig.json`/`vite.config.ts`).
- `verbatimModuleSyntax` is on — use `import type` for all type-only imports (e.g. `import type { Machine } from '@/store/types'`). This also means those imports are erased at build time, so a `.test.ts` file that only needs a type from `@/store/types` never needs to resolve that path at runtime.
- This repo has **no Vitest/Jest/RTL/jsdom** — do not add one. Pure-logic helpers get a same-directory `<name>.test.ts` following the exact style of `frontend/src/lib/browserTileBookmarks.test.ts` (a local `check(name, fn)` + `assertEqual(actual, expected, message)`, run via `npx tsx src/lib/<name>.test.ts` from `frontend/`). Pure UI-wiring changes (hook calls, state additions) have no unit test — verify with `npm run typecheck` and a manual check in the running desktop app, per this project's convention for UI changes.
- Run `npm --prefix frontend run typecheck` before every commit in this plan.
- Never edit `frontend/src/routeTree.gen.ts`.
- Default to no comments; only add one when it captures a non-obvious WHY (see existing files in this plan for the house style — most functions already carry one explaining a subtle invariant).
- Toast convention: `import { toast } from 'sonner'`, `toast.error(message)` with a plain string (no JSX).

---

## Task 1: `tileDragActive` store flag + hide Browser tiles during an interactive divider drag

**Files:**
- Modify: `frontend/src/store/useDevDeckStore.ts:270` (state field, after `nativeOverlayBlockers`), `:309` (action type), `:518` (initial value), `:628` (action implementation)
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx:1-9` (import), `:185-219` (`TileSplitView`)
- Modify: `frontend/src/features/browser/BrowserTile.tsx:134` (store read), `:224-235` (show/hide effect)

**Interfaces:**
- Produces: `useDevDeckStore`'s `tileDragActive: boolean` state and `setTileDragActive(active: boolean): void` action — read by `BrowserTile.tsx`, set by `WorkspaceTileCanvas.tsx`'s `TileSplitView`.

- [ ] **Step 1: Add the `tileDragActive` field, action type, initial value, and implementation to the store**

  In `frontend/src/store/useDevDeckStore.ts`, add this field to the `DevDeckState` interface immediately after the existing `nativeOverlayBlockers: number` field (around line 270):

  ```ts
  /** True for the duration of an interactive pane-divider drag (see
   *  `WorkspaceTileCanvas.tsx`'s `TileSplitView`). Native child webviews
   *  (Browser tiles) ignore CSS `overflow-hidden` clipping and can visibly
   *  lag behind a fast divider drag — `BrowserTile` hides its webview for as
   *  long as this is true and reveals it once at the final settled rect, the
   *  same way it already does for `nativeOverlayBlockers`. */
  tileDragActive: boolean
  ```

  Add the action type immediately after `popNativeOverlayBlocker: () => void` (around line 309):

  ```ts
  setTileDragActive: (active: boolean) => void
  ```

  Add the initial value immediately after `nativeOverlayBlockers: 0,` (around line 518):

  ```ts
  tileDragActive: false,
  ```

  Add the action implementation immediately after `popNativeOverlayBlocker: ...` (around line 628):

  ```ts
  setTileDragActive: (active) => set((s) => void (s.tileDragActive = active)),
  ```

  Do not add `tileDragActive` to the `partialize` allowlist — it must stay unpersisted, exactly like `nativeOverlayBlockers`.

- [ ] **Step 2: Verify the store change typechecks**

  Run: `npm --prefix frontend run typecheck`
  Expected: no new errors.

- [ ] **Step 3: Wire `setTileDragActive` into `TileSplitView`'s divider drag handlers**

  In `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`, add this import alongside the existing ones (after `import { cn } from '@/lib/utils'` near line 6):

  ```ts
  import { useDevDeckStore } from '@/store/useDevDeckStore'
  ```

  Replace the `TileSplitView` function (lines 185-219) with:

  ```ts
  function TileSplitView({ node, ctx }: { node: TileSplit; ctx: TileRenderContext }) {
    const containerRef = useRef<HTMLDivElement>(null)
    const dragRef = useRef<{ index: number; startSizes: number[]; startPos: number; containerSize: number } | null>(
      null,
    )
    const [liveSizes, setLiveSizes] = useState<number[] | null>(null)
    const setTileDragActive = useDevDeckStore((s) => s.setTileDragActive)

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

  (Only additions: the `setTileDragActive` read, the `setTileDragActive(true)`/`setTileDragActive(false)` calls, and the new `onPointerCancel={handlePointerUp}` — added so a cancelled/interrupted drag, e.g. an OS gesture stealing the pointer, can never leave every Browser tile permanently hidden.)

- [ ] **Step 4: Read `tileDragActive` in `BrowserTile.tsx` and fold it into the existing show/hide effect**

  In `frontend/src/features/browser/BrowserTile.tsx`, add this line immediately after the existing `const nativeOverlayBlockers = useDevDeckStore((s) => s.nativeOverlayBlockers)` (line 134):

  ```ts
  const tileDragActive = useDevDeckStore((s) => s.tileDragActive)
  ```

  Replace the show/hide effect (lines 224-235) with:

  ```ts
  useEffect(() => {
    if (!doc?.url || !openedDocsRef.current.has(doc.id)) return
    const docId = doc.id
    if (nativeOverlayBlockers > 0 || tileDragActive) {
      void hideBrowserTile(tabId, docId)
      return
    }
    const el = bodyRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    void showBrowserTile(tabId, docId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  }, [nativeOverlayBlockers, tileDragActive, tabId, doc?.id, doc?.url])
  ```

- [ ] **Step 5: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check in the running desktop app: open a Browser tile pointed at any page, split the workspace so the Browser tile shares a pane with something else, then drag the divider between them quickly back and forth. Expect: the Browser tile's content is hidden while dragging and reappears correctly sized once you release — it must never visibly bleed past the divider.

- [ ] **Step 6: Commit**

  ```bash
  git add frontend/src/store/useDevDeckStore.ts frontend/src/features/tabs/WorkspaceTileCanvas.tsx frontend/src/features/browser/BrowserTile.tsx
  git commit -m "fix(browser): hide native webview during interactive divider drags"
  ```

---

## Task 2: Native-webview z-index gap — tab drag-and-drop ghost in `WorkspaceTileCanvas`

**Files:**
- Modify: `frontend/src/features/tabs/WorkspaceTileCanvas.tsx:1-9` (import), `:735` (hook call)

**Interfaces:**
- Consumes: `useNativeOverlayBlocker(active: boolean): void` from `frontend/src/features/browser/useNativeOverlayBlocker.ts` (existing, unchanged).

- [ ] **Step 1: Add the import and hook call**

  Add to the import list at the top of `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  In the `WorkspaceTileCanvas` function body, immediately after `const [dragTab, setDragTab] = useState<TileTab | null>(null)` (line 735), add:

  ```ts
  // A dragged tab's ghost preview (DragOverlay below) is a DOM portal, and a
  // native Browser-tile webview always paints above the DOM — without this,
  // dragging any tab (including a Browser tab itself) renders its ghost
  // underneath an open Browser tile instead of following the pointer over it.
  useNativeOverlayBlocker(dragTab !== null)
  ```

- [ ] **Step 2: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: with a Browser tile open and showing a page, drag any workspace tab (a worktree tab, or the Browser tab itself) across the tile canvas. Expect: the drag ghost preview is visible on top of the Browser tile's content throughout the drag.

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/features/tabs/WorkspaceTileCanvas.tsx
  git commit -m "fix(browser): keep tab drag ghost above native Browser tile webviews"
  ```

---

## Task 3: Proxy-start error handling

**Files:**
- Create: `frontend/src/lib/browserProxy.ts`
- Test: `frontend/src/lib/browserProxy.test.ts`
- Modify: `frontend/src/features/browser/BrowserTile.tsx` (imports, `ensureProxyForMachine`)

**Interfaces:**
- Produces: `resolveProxyForMachine(machineId: string, machines: Machine[], startProxy: (machine: Machine) => Promise<BrowserProxyInfo>): Promise<ProxyResolution>` where `ProxyResolution = { ok: true; proxy: BrowserProxyInfo } | { ok: false; error: string }`.

- [ ] **Step 1: Write the failing test**

  Create `frontend/src/lib/browserProxy.test.ts`:

  ```ts
  import { resolveProxyForMachine } from './browserProxy'

  let passed = 0
  function check(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve(fn()).then(() => {
      passed += 1
      console.log(`ok - ${name}`)
    })
  }
  function assertEqual<T>(actual: T, expected: T, message: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
    }
  }

  const machine = {
    id: 'm1',
    name: 'builder',
    url: 'https://builder.tail1234.ts.net:8989',
    key: 'k',
    isLocal: false,
    signingPublicKey: '',
  }

  async function main() {
    await check('returns ok with the started proxy on success', async () => {
      const result = await resolveProxyForMachine('m1', [machine], async () => ({
        socks5Addr: '1.2.3.4:9',
        httpProxyAddr: '1.2.3.4:10',
      }))
      assertEqual(result, { ok: true, proxy: { socks5Addr: '1.2.3.4:9', httpProxyAddr: '1.2.3.4:10' } }, 'success path')
    })

    await check('returns a not-found error when the machine id is unknown', async () => {
      const result = await resolveProxyForMachine('missing', [machine], async () => ({ socks5Addr: '', httpProxyAddr: '' }))
      assertEqual(result, { ok: false, error: 'Machine not found' }, 'unknown machine id')
    })

    await check('returns a descriptive error instead of throwing when startProxy rejects', async () => {
      const result = await resolveProxyForMachine('m1', [machine], async () => {
        throw new Error('machine offline')
      })
      assertEqual(result, { ok: false, error: 'Could not start browser proxy on builder: machine offline' }, 'rejected startProxy')
    })

    console.log(`\n${passed} tests passed`)
  }

  void main()
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `frontend/`): `npx tsx src/lib/browserProxy.test.ts`
  Expected: FAIL — `Cannot find module './browserProxy'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

  Create `frontend/src/lib/browserProxy.ts`:

  ```ts
  import type { BrowserProxyInfo, Machine } from '@/store/types'

  export type ProxyResolution = { ok: true; proxy: BrowserProxyInfo } | { ok: false; error: string }

  /** Resolves (starting if needed) the forward proxy for a machine, without
   *  throwing — `BrowserTile`'s navigate()/selectMachine()/openBookmark() all
   *  call this via `void`, so an unhandled rejection here would silently
   *  strand the tile with no feedback (see the 2026-07-31
   *  browser-tile-bugfixes design spec, bug #1). Every failure path returns
   *  `{ ok: false, error }` instead of throwing. */
  export async function resolveProxyForMachine(
    machineId: string,
    machines: Machine[],
    startProxy: (machine: Machine) => Promise<BrowserProxyInfo>,
  ): Promise<ProxyResolution> {
    const machine = machines.find((m) => m.id === machineId)
    if (!machine) return { ok: false, error: 'Machine not found' }
    try {
      const proxy = await startProxy(machine)
      return { ok: true, proxy }
    } catch (err) {
      return {
        ok: false,
        error: `Could not start browser proxy on ${machine.name}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run (from `frontend/`): `npx tsx src/lib/browserProxy.test.ts`
  Expected: all 3 `ok - ...` lines print, then `3 tests passed`.

- [ ] **Step 5: Wire the helper into `BrowserTile.tsx`**

  Add these imports to `frontend/src/features/browser/BrowserTile.tsx` (alongside the existing ones):

  ```ts
  import { toast } from 'sonner'
  import { resolveProxyForMachine } from '@/lib/browserProxy'
  ```

  Replace the `ensureProxyForMachine` function with:

  ```ts
  const ensureProxyForMachine = async (machineId: string) => {
    const result = await resolveProxyForMachine(machineId, machines, startProxy)
    if (!result.ok) {
      toast.error(result.error)
      return null
    }
    setBrowserDocState(tabId, doc.id, { machineId, proxy: result.proxy })
    return result.proxy
  }
  ```

- [ ] **Step 6: Verify typecheck**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.

- [ ] **Step 7: Manually verify the error path**

  In the running desktop app, stop/disconnect a registered machine (or point at one that's offline), then try to browse to it in a Browser tile. Expect: a toast reading "Could not start browser proxy on `<name>`: ..." appears, and the tile does not hang silently.

- [ ] **Step 8: Commit**

  ```bash
  git add frontend/src/lib/browserProxy.ts frontend/src/lib/browserProxy.test.ts frontend/src/features/browser/BrowserTile.tsx
  git commit -m "fix(browser): surface an error toast when a machine's proxy fails to start"
  ```

---

## Task 4: In-page navigation history tracking

**Files:**
- Create: `frontend/src/lib/browserHistory.ts`
- Test: `frontend/src/lib/browserHistory.test.ts`
- Modify: `frontend/src/features/browser/BrowserTile.tsx` (imports, `navigate`, `goHistory`, `openBookmark`, page-load effect)

**Interfaces:**
- Produces: `nextStateForPageLoad(doc: Pick<BrowserDocState, 'history' | 'historyIndex'>, url: string, programmatic: boolean): PageLoadPatch` where `PageLoadPatch = { url: string; loading: boolean; history: string[]; historyIndex: number }`.

- [ ] **Step 1: Write the failing test**

  Create `frontend/src/lib/browserHistory.test.ts`:

  ```ts
  import { nextStateForPageLoad } from './browserHistory'

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

  check('a programmatic load only updates url/loading, history untouched', () => {
    const doc = { history: ['https://a.test', 'https://b.test'], historyIndex: 1 }
    const patch = nextStateForPageLoad(doc, 'https://b.test', true)
    assertEqual(patch, { url: 'https://b.test', loading: false, history: doc.history, historyIndex: 1 }, 'programmatic load')
  })

  check('a real in-page navigation appends to history and moves the index forward', () => {
    const doc = { history: ['https://a.test'], historyIndex: 0 }
    const patch = nextStateForPageLoad(doc, 'https://a.test/next', false)
    assertEqual(
      patch,
      { url: 'https://a.test/next', loading: false, history: ['https://a.test', 'https://a.test/next'], historyIndex: 1 },
      'in-page navigation',
    )
  })

  check('a real in-page navigation after going Back truncates the stale forward stack', () => {
    const doc = { history: ['https://a.test', 'https://b.test', 'https://c.test'], historyIndex: 0 }
    const patch = nextStateForPageLoad(doc, 'https://d.test', false)
    assertEqual(
      patch,
      { url: 'https://d.test', loading: false, history: ['https://a.test', 'https://d.test'], historyIndex: 1 },
      'truncates the stale b.test/c.test forward stack since the user branched from historyIndex 0',
    )
  })

  console.log(`\n${passed} tests passed`)
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `frontend/`): `npx tsx src/lib/browserHistory.test.ts`
  Expected: FAIL — `Cannot find module './browserHistory'`.

- [ ] **Step 3: Write the minimal implementation**

  Create `frontend/src/lib/browserHistory.ts`:

  ```ts
  import type { BrowserDocState } from '@/store/types'

  export interface PageLoadPatch {
    url: string
    loading: boolean
    history: string[]
    historyIndex: number
  }

  /** Computes the doc-state patch for a native Browser-tile page-load event.
   *  `programmatic` is true when this load is the direct result of our own
   *  navigate()/goHistory() call — already recorded in `history`, so only
   *  `url`/`loading` need updating. `false` means the user navigated for real
   *  inside the loaded page itself (e.g. clicking a link), which nothing else
   *  records — this truncates any forward stack and appends the new URL, the
   *  same way navigate() does for an address-bar entry. */
  export function nextStateForPageLoad(
    doc: Pick<BrowserDocState, 'history' | 'historyIndex'>,
    url: string,
    programmatic: boolean,
  ): PageLoadPatch {
    if (programmatic) {
      return { url, loading: false, history: doc.history, historyIndex: doc.historyIndex }
    }
    const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
    return { url, loading: false, history, historyIndex: history.length - 1 }
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run (from `frontend/`): `npx tsx src/lib/browserHistory.test.ts`
  Expected: all 3 `ok - ...` lines print, then `3 tests passed`.

- [ ] **Step 5: Wire the helper into `BrowserTile.tsx`**

  Add this import:

  ```ts
  import { nextStateForPageLoad } from '@/lib/browserHistory'
  ```

  Add a new ref immediately after `const openedDocsRef = useRef<Set<string>>(new Set())` (line 165):

  ```ts
  const pendingProgrammaticNavRef = useRef<Set<string>>(new Set())
  ```

  Replace `navigate` with:

  ```ts
  const navigate = async (rawUrl: string) => {
    const url = normalizeAddress(rawUrl)
    if (!url) return
    let proxy = doc.proxy
    if (!proxy && doc.machineId) proxy = await ensureProxyForMachine(doc.machineId)
    if (!proxy) return
    const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
    pendingProgrammaticNavRef.current.add(doc.id)
    setBrowserDocState(tabId, doc.id, { url, title: titleFor(url), loading: true, history, historyIndex: history.length - 1 })
    if (doc.url) {
      await navigateBrowserTile(tabId, doc.id, url)
    }
  }
  ```

  Replace `goHistory` with:

  ```ts
  const goHistory = async (delta: -1 | 1) => {
    const nextIndex = doc.historyIndex + delta
    const url = doc.history[nextIndex]
    if (!url) return
    pendingProgrammaticNavRef.current.add(doc.id)
    setBrowserDocState(tabId, doc.id, { url, title: titleFor(url), historyIndex: nextIndex, loading: true })
    await navigateBrowserTile(tabId, doc.id, url)
  }
  ```

  Replace `openBookmark` with:

  ```ts
  const openBookmark = async (bookmark: Bookmark) => {
    const proxy =
      bookmark.machineId && bookmark.machineId !== doc.machineId
        ? await ensureProxyForMachine(bookmark.machineId)
        : (doc.proxy ?? (doc.machineId ? await ensureProxyForMachine(doc.machineId) : null))
    if (!proxy) return
    const url = normalizeAddress(bookmark.url)
    if (!url) return
    const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
    pendingProgrammaticNavRef.current.add(doc.id)
    setBrowserDocState(tabId, doc.id, { url, title: bookmark.title, loading: true, history, historyIndex: history.length - 1 })
  }
  ```

  Replace the page-load effect with:

  ```ts
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onBrowserTilePageLoad(({ tabId: t, docId: d, url }) => {
      if (t !== tabId) return
      const programmatic = pendingProgrammaticNavRef.current.delete(d)
      const current = useDevDeckStore.getState().browserTiles[t]?.docs.find((entry) => entry.id === d)
      if (!current) return
      setBrowserDocState(t, d, nextStateForPageLoad(current, url, programmatic))
    }).then((fn) => {
      unlisten = fn
    })
    return () => unlisten?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])
  ```

- [ ] **Step 6: Verify typecheck**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.

- [ ] **Step 7: Manually verify**

  In the running desktop app, navigate a Browser tile to a page with internal links (e.g. a documentation site), click a couple of links inside the loaded page (not via the address bar), then click the Back button. Expect: Back steps through the pages you actually visited by clicking, in order — not back to whatever was open before the in-page clicks.

- [ ] **Step 8: Commit**

  ```bash
  git add frontend/src/lib/browserHistory.ts frontend/src/lib/browserHistory.test.ts frontend/src/features/browser/BrowserTile.tsx
  git commit -m "fix(browser): record real in-page navigation into Back/Forward history"
  ```

---

## Task 5: localhost → machine address rewrite

**Files:**
- Create: `frontend/src/lib/localhostRewrite.ts`
- Test: `frontend/src/lib/localhostRewrite.test.ts`
- Modify: `frontend/src/features/browser/BrowserTile.tsx` (imports, `navigate`, `openBookmark`)

**Interfaces:**
- Produces: `rewriteLoopbackHost(url: string, machine: Machine | undefined): string`.

- [ ] **Step 1: Write the failing test**

  Create `frontend/src/lib/localhostRewrite.test.ts`:

  ```ts
  import { rewriteLoopbackHost } from './localhostRewrite'

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

  const remoteMachine = {
    id: 'm1',
    name: 'builder',
    url: 'https://builder.tail1234.ts.net:8989',
    key: '',
    isLocal: false,
    signingPublicKey: '',
  }
  const unconfiguredMachine = {
    id: 'm2',
    name: 'local-runtime',
    url: 'http://127.0.0.1:8989',
    key: '',
    isLocal: true,
    signingPublicKey: '',
  }

  check("rewrites a localhost URL to the remote machine's own host, keeping port and path", () => {
    assertEqual(
      rewriteLoopbackHost('http://localhost:3000/dashboard?tab=1', remoteMachine),
      'http://builder.tail1234.ts.net:3000/dashboard?tab=1',
      'localhost -> machine host',
    )
  })

  check('rewrites a 127.0.0.1 URL the same way', () => {
    assertEqual(rewriteLoopbackHost('http://127.0.0.1:5173/', remoteMachine), 'http://builder.tail1234.ts.net:5173/', '127.0.0.1 -> machine host')
  })

  check('leaves a non-loopback URL untouched', () => {
    assertEqual(rewriteLoopbackHost('https://example.com', remoteMachine), 'https://example.com', 'non-loopback unchanged')
  })

  check('leaves the URL untouched when there is no machine', () => {
    assertEqual(rewriteLoopbackHost('http://localhost:3000', undefined), 'http://localhost:3000', 'no machine unchanged')
  })

  check("leaves the URL untouched when the machine's own url is itself loopback (nothing better to substitute)", () => {
    assertEqual(rewriteLoopbackHost('http://localhost:3000', unconfiguredMachine), 'http://localhost:3000', 'unconfigured local runtime unchanged')
  })

  check('leaves an unparseable string untouched', () => {
    assertEqual(rewriteLoopbackHost('not a url', remoteMachine), 'not a url', 'unparseable input unchanged')
  })

  console.log(`\n${passed} tests passed`)
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run (from `frontend/`): `npx tsx src/lib/localhostRewrite.test.ts`
  Expected: FAIL — `Cannot find module './localhostRewrite'`.

- [ ] **Step 3: Write the minimal implementation**

  Create `frontend/src/lib/localhostRewrite.ts`:

  ```ts
  import type { Machine } from '@/store/types'

  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

  /** True for hostnames that OS/browser network stacks conventionally bypass
   *  configured proxies for — typing one of these while browsing through a
   *  machine's own SOCKS5 proxy would otherwise silently reach the
   *  operator's own machine instead of the target one. */
  function isLoopbackHost(hostname: string): boolean {
    return LOOPBACK_HOSTS.has(hostname.toLowerCase())
  }

  /** Rewrites a loopback-hostnamed URL to the given machine's own registered
   *  address, keeping scheme/port/path/query untouched — see the 2026-07-31
   *  browser-tile-bugfixes design spec's "localhost -> machine address
   *  rewrite" section for why `machine.url`'s hostname is the right
   *  substitute (it's provably the same host that machine's own forward
   *  proxy advertises itself on). Returns `url` unchanged when there's no
   *  machine, the URL isn't loopback-hostnamed, or the machine's own
   *  registered URL is itself loopback (nothing better to substitute). */
  export function rewriteLoopbackHost(url: string, machine: Machine | undefined): string {
    if (!machine) return url
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return url
    }
    if (!isLoopbackHost(parsed.hostname)) return url

    let machineHost: string
    try {
      machineHost = new URL(machine.url).hostname
    } catch {
      return url
    }
    if (isLoopbackHost(machineHost)) return url

    parsed.hostname = machineHost
    return parsed.toString()
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run (from `frontend/`): `npx tsx src/lib/localhostRewrite.test.ts`
  Expected: all 6 `ok - ...` lines print, then `6 tests passed`.

- [ ] **Step 5: Wire the helper into `BrowserTile.tsx`**

  Add this import:

  ```ts
  import { rewriteLoopbackHost } from '@/lib/localhostRewrite'
  ```

  Replace `navigate` (as it stands after Task 4) with:

  ```ts
  const navigate = async (rawUrl: string) => {
    const normalized = normalizeAddress(rawUrl)
    if (!normalized) return
    let proxy = doc.proxy
    if (!proxy && doc.machineId) proxy = await ensureProxyForMachine(doc.machineId)
    if (!proxy) return
    const machine = machines.find((m) => m.id === doc.machineId)
    const url = rewriteLoopbackHost(normalized, machine)
    const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
    pendingProgrammaticNavRef.current.add(doc.id)
    setBrowserDocState(tabId, doc.id, { url, title: titleFor(url), loading: true, history, historyIndex: history.length - 1 })
    if (doc.url) {
      await navigateBrowserTile(tabId, doc.id, url)
    }
  }
  ```

  Replace `openBookmark` (as it stands after Task 4) with:

  ```ts
  const openBookmark = async (bookmark: Bookmark) => {
    const proxy =
      bookmark.machineId && bookmark.machineId !== doc.machineId
        ? await ensureProxyForMachine(bookmark.machineId)
        : (doc.proxy ?? (doc.machineId ? await ensureProxyForMachine(doc.machineId) : null))
    if (!proxy) return
    const normalized = normalizeAddress(bookmark.url)
    if (!normalized) return
    const targetMachineId = bookmark.machineId || doc.machineId
    const machine = machines.find((m) => m.id === targetMachineId)
    const url = rewriteLoopbackHost(normalized, machine)
    const history = [...doc.history.slice(0, doc.historyIndex + 1), url]
    pendingProgrammaticNavRef.current.add(doc.id)
    setBrowserDocState(tabId, doc.id, { url, title: bookmark.title, loading: true, history, historyIndex: history.length - 1 })
  }
  ```

  (`goHistory` is unchanged — history entries already store the rewritten URL from when they were first navigated to.)

- [ ] **Step 6: Verify typecheck**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.

- [ ] **Step 7: Manually verify**

  Pick a machine whose registered URL is a real (non-loopback) address (e.g. a Tailscale-registered runtime), select it in a Browser tile, and navigate to `http://localhost:<port-of-something-running-on-that-machine>`. Expect: the page loads from that machine, not from the operator's own machine.

- [ ] **Step 8: Commit**

  ```bash
  git add frontend/src/lib/localhostRewrite.ts frontend/src/lib/localhostRewrite.test.ts frontend/src/features/browser/BrowserTile.tsx
  git commit -m "feat(browser): rewrite localhost URLs to the active machine's real address"
  ```

---

## Task 6: Native-webview z-index gap — `TransferStatusPanel`

**Files:** Modify: `frontend/src/features/overlays/TransferStatusPanel.tsx`

- [ ] **Step 1: Add the import and hook call**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const dismissTransfer = useDevDeckStore((s) => s.dismissTransfer)` (line 10), add:

  ```ts
  useNativeOverlayBlocker(transfers.length > 0)
  ```

- [ ] **Step 2: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: with a Browser tile open, upload or download a file in the file explorer so the transfer panel appears at the bottom-right. Expect: the panel renders above the Browser tile.

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/features/overlays/TransferStatusPanel.tsx
  git commit -m "fix(browser): keep transfer status panel above native Browser tile webviews"
  ```

---

## Task 7: Native-webview z-index gap — `WorkspaceSwitcher`

**Files:** Modify: `frontend/src/features/sidebar/WorkspaceSwitcher.tsx`

- [ ] **Step 1: Add the import and hook call**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const open = useDevDeckStore((s) => s.wsMenuOpen)` (line 21), add:

  ```ts
  useNativeOverlayBlocker(open)
  ```

- [ ] **Step 2: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: with a Browser tile open, click the workspace switcher in the sidebar. Expect: the popover renders above the Browser tile.

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/features/sidebar/WorkspaceSwitcher.tsx
  git commit -m "fix(browser): keep workspace switcher popover above native Browser tile webviews"
  ```

---

## Task 8: Native-webview z-index gap — `DBExportMenu`

**Files:** Modify: `frontend/src/features/database/DBExportMenu.tsx`

- [ ] **Step 1: Add the import and hook call**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const [open, setOpen] = useState(false)` (line 42), add:

  ```ts
  useNativeOverlayBlocker(open)
  ```

- [ ] **Step 2: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: with a Browser tile open in one split and a database table view in another, click the Export button. Expect: the format popover renders above the Browser tile.

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/features/database/DBExportMenu.tsx
  git commit -m "fix(browser): keep DB export popover above native Browser tile webviews"
  ```

---

## Task 9: Native-webview z-index gap — `TerminalExplorer`'s context menu

**Files:** Modify: `frontend/src/features/terminal/TerminalExplorer.tsx`

**Note:** this menu is currently fully uncontrolled (no `open` state at all) — this task adds that state as part of wiring the hook.

- [ ] **Step 1: Add controlled-open state and the hook call**

  Add to the imports:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const [menuEntry, setMenuEntry] = useState<SelectedEntry | null>(null)` (line 206), add:

  ```ts
  const [contextMenuOpen, setContextMenuOpen] = useState(false)
  useNativeOverlayBlocker(contextMenuOpen)
  ```

- [ ] **Step 2: Make `ContextMenu.Root` controlled**

  Change (line 683):

  ```tsx
  <ContextMenu.Root>
  ```

  to:

  ```tsx
  <ContextMenu.Root open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
  ```

- [ ] **Step 3: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors. If `ContextMenu.Root` doesn't accept `open`/`onOpenChange`, typecheck will fail here — check `@base-ui/react/context-menu`'s type definitions for the exact controlled-prop names it exposes (it mirrors `Popover.Root`, used the same way in `DBExportMenu.tsx`) and adjust the prop names to match.

  Manual check: right-click still opens the menu and all its actions (New File, Cut, Copy, Paste, Rename, Delete, ...) still work exactly as before. Then, with a Browser tile open in a split alongside a worktree's file explorer, right-click a file. Expect: the context menu renders above the Browser tile.

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/features/terminal/TerminalExplorer.tsx
  git commit -m "fix(browser): keep file explorer context menu above native Browser tile webviews"
  ```

---

## Task 10: Native-webview z-index gap — `PaneCanvas`'s drag ghost

**Files:** Modify: `frontend/src/features/terminal/PaneCanvas.tsx`

- [ ] **Step 1: Add the import and hook call**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const [dragContent, setDragContent] = useState<PaneContent | null>(null)` (line 326), add:

  ```ts
  useNativeOverlayBlocker(dragContent !== null)
  ```

- [ ] **Step 2: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: inside a worktree's terminal workspace (which uses this same pane canvas for Terminal/Explorer/File panes), with a Browser tile open in a sibling workspace split, drag a pane tab. Expect: the drag ghost renders above the Browser tile.

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/features/terminal/PaneCanvas.tsx
  git commit -m "fix(browser): keep pane drag ghost above native Browser tile webviews"
  ```

---

## Task 11: Native-webview z-index gap — `EnvProfileManagement`'s mobile actions sheet

**Files:** Modify: `frontend/src/features/agent-management/EnvProfileManagement.tsx`

- [ ] **Step 1: Add the import and hook call**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  In the same component function that declares `const [menuOpen, setMenuOpen] = useState<string | null>(null)` (line 70), immediately after that line, add:

  ```ts
  useNativeOverlayBlocker(menuOpen !== null)
  ```

- [ ] **Step 2: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: on a narrow window (or resize below the `sm` breakpoint), with a Browser tile open in a split, open a profile's "⋮" actions sheet. Expect: it renders above the Browser tile.

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/features/agent-management/EnvProfileManagement.tsx
  git commit -m "fix(browser): keep env profile actions sheet above native Browser tile webviews"
  ```

---

## Task 12: Native-webview z-index gap — `Terminal`'s find bar

**Files:** Modify: `frontend/src/features/terminal/Terminal.tsx`

- [ ] **Step 1: Add the import and hook call**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const [searchOpen, setSearchOpen] = useState(false)` (line 99), add:

  ```ts
  useNativeOverlayBlocker(searchOpen)
  ```

- [ ] **Step 2: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: with a Browser tile open in a split alongside a terminal, open the terminal's Find bar (its usual shortcut). Expect: the find bar renders above the Browser tile.

- [ ] **Step 3: Commit**

  ```bash
  git add frontend/src/features/terminal/Terminal.tsx
  git commit -m "fix(browser): keep terminal find bar above native Browser tile webviews"
  ```

---

## Task 13: Native-webview z-index gap — Markdown editors' slash-command menu

**Files:**
- Modify: `frontend/src/features/terminal/MarkdownFileEditor.tsx`
- Modify: `frontend/src/features/issues/MarkdownEditor.tsx`

- [ ] **Step 1: Fix `MarkdownFileEditor.tsx`**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)` (line 53), add:

  ```ts
  useNativeOverlayBlocker(slashMenu !== null)
  ```

- [ ] **Step 2: Fix `MarkdownEditor.tsx`**

  Add:

  ```ts
  import { useNativeOverlayBlocker } from '@/features/browser/useNativeOverlayBlocker'
  ```

  Immediately after `const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)` (line 47), add:

  ```ts
  useNativeOverlayBlocker(slashMenu !== null)
  ```

- [ ] **Step 3: Verify and manually test**

  Run: `npm --prefix frontend run typecheck` — expect no new errors.
  Manual check: open a markdown file in a worktree's file editor (sibling split to an open Browser tile), type `/` to open the slash-command menu. Expect: it renders above the Browser tile.

- [ ] **Step 4: Commit**

  ```bash
  git add frontend/src/features/terminal/MarkdownFileEditor.tsx frontend/src/features/issues/MarkdownEditor.tsx
  git commit -m "fix(browser): keep markdown editors' slash-command menu above native Browser tile webviews"
  ```

---

## Task Ordering / Parallelism Notes

- **Tasks 1 → 2 → 3 → 4 → 5 must run strictly in this order** — they all edit `frontend/src/features/browser/BrowserTile.tsx` (and Tasks 1–2 also both edit `frontend/src/features/tabs/WorkspaceTileCanvas.tsx`), and each task's steps are written assuming the previous task's edits already landed.
- **Tasks 6–13 are fully independent of each other and of the 1–5 chain** — each touches exactly one file untouched by any other task in this plan. They can be implemented and reviewed in any order, or in parallel.

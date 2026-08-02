import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { ProgressLine } from '@/components/ui/progress-line'
import { useBookmarks, useCreateBookmark, useDeleteBookmark, useMachines, useMachinesHealth } from '@/features/data/queries'
import { takeLegacyBrowserTileBookmarks } from '@/lib/browserTileBookmarks'
import { startProxy } from '@/lib/machineApi'
import type { Bookmark, Machine } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { BookmarkDialog } from './BookmarkDialog'
import { BrowserFaviconChip } from './BrowserFaviconChip'
import { BrowserFindBar } from './BrowserFindBar'
import { BrowserOmnibox } from './BrowserOmnibox'
import { BrowserTabStrip } from './BrowserTabStrip'
import { BrowserToolbar } from './BrowserToolbar'
import { BrowserUrlCard } from './BrowserUrlCard'
import { recordPageLoad } from './browserHistory'
import { visibleTileRect } from './visibleTileRect'
import { DEFAULT_ZOOM, zoomStep } from './browserZoom'
import {
  clearBrowserTileFind,
  closeBrowserTile as closeNativeBrowserTile,
  findInBrowserTile,
  goBackBrowserTile,
  goForwardBrowserTile,
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
  /** Bumped to pull the caret back into the omnibox's inline address input
   *  (Cmd/Ctrl+L on a tab that has no URL yet). */
  const [addressFocusSignal, setAddressFocusSignal] = useState(0)
  /** True while a load DevDeck itself asked for is in flight, so the page-load
   *  listener confirms the entry already written instead of appending a second
   *  one. Consumed by the next committed load. */
  const initiatedLoadRef = useRef(false)
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
      // Re-clip against whatever is currently covering the tile. Reporting the
      // placeholder's full rect here would put the webview straight back under
      // an open overlay on the next resize, undoing the shrink below.
      const state = useDevDeckStore.getState()
      const visible = visibleTileRect(rect, state.nativeOverlayBlockers, state.tileDragActive)
      if (!visible) return
      void setBrowserTileBounds(tabId, docId, {
        x: visible.left,
        y: visible.top,
        width: visible.right - visible.left,
        height: visible.bottom - visible.top,
      })
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
      const visible = visibleTileRect(rect, state.nativeOverlayBlockers, state.tileDragActive)
      if (!visible) return
      void showBrowserTile(tId, dId, {
        x: visible.left,
        y: visible.top,
        width: visible.right - visible.left,
        height: visible.bottom - visible.top,
      })
    })
  }

  // Occlusion-aware visibility (design spec §5.4/§5.6). A blocker whose region
  // misses this tile is ignored entirely; one that hits it now shrinks the
  // webview to the largest uncovered rectangle rather than blanking the page,
  // and only a `'viewport'` blocker, a tile drag, or an overlay that leaves too
  // little of the tile behind hides it outright. Hide is always immediate; show
  // is coalesced behind one rAF so a same-frame hide-then-show never
  // round-trips an extra IPC call to Rust.
  useEffect(() => {
    if (!doc?.url || !openedDocsRef.current.has(doc.id)) return
    const docId = doc.id
    const el = bodyRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!visibleTileRect(rect, nativeOverlayBlockers, tileDragActive)) {
      cancelScheduledShow()
      void hideBrowserTile(tabId, docId)
      return
    }
    scheduleShow(tabId, docId, () => bodyRef.current?.getBoundingClientRect())
    return cancelScheduledShow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeOverlayBlockers, tileDragActive, tabId, doc?.id, doc?.url])

  // Sync the address bar/title/history from real navigation inside the native
  // webview. `loading` comes straight from the `on_page_load` payload, so the
  // toolbar's Reload<->Stop icon swaps correctly.
  //
  // History is folded in on the *committed* load only (`loading === false`).
  // Recording on the Started event instead would enter URLs that then fail,
  // redirect away, or get cancelled. This is what makes back/forward work
  // after a link click: the event used to update `url` alone, leaving
  // `historyIndex` at 0 forever, so `canGoBack` never became true.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onBrowserTilePageLoad(({ tabId: t, docId: d, url, loading }) => {
      if (t !== tabId) return
      setBrowserDocState(t, d, { url, loading })
      if (loading) return

      const initiated = initiatedLoadRef.current
      initiatedLoadRef.current = false
      // Read through the store rather than the captured `doc`: this listener is
      // registered once per tab and would otherwise fold every load into the
      // history snapshot taken when it was created.
      const current = useDevDeckStore.getState().browserTiles[t]?.docs.find((candidate) => candidate.id === d)
      if (!current) return
      const next = recordPageLoad({ history: current.history, historyIndex: current.historyIndex }, url, initiated)
      if (next.history === current.history && next.historyIndex === current.historyIndex) return
      setBrowserDocState(t, d, next)
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
        // A tab with no URL already edits its address inline in the omnibox,
        // so opening the card would stack a second input for the same job.
        if (doc.url) setUrlCardOpen(true)
        else setAddressFocusSignal((signal) => signal + 1)
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
    initiatedLoadRef.current = true
    setBrowserDocState(tabId, doc.id, { url, title: titleFor(url), loading: true, history, historyIndex: history.length - 1 })
    // First navigation for this doc (doc.url was still null): the mount
    // effect above creates the native webview once the placeholder <div>
    // exists, sized correctly from the start — see that effect's comment
    // for why opening doesn't happen here.
    if (doc.url) {
      await navigateBrowserTile(tabId, doc.id, url)
    }
  }

  // Steps the webview's own session history rather than re-navigating to the
  // remembered URL. Re-navigating refetched the page, so back landed you at the
  // top of a search results page instead of where you left it, and pushed a
  // fresh native entry each time — the toolbar and a trackpad swipe then
  // disagreed about where "back" went.
  //
  // Deliberately does NOT set `initiatedLoadRef` or move the index here: the
  // resulting load arrives on an adjacent entry, which `recordPageLoad` already
  // follows the same way it follows a swipe gesture. Moving the index here as
  // well would double-count the step.
  const goHistory = async (delta: -1 | 1) => {
    const nextIndex = doc.historyIndex + delta
    if (nextIndex < 0 || nextIndex >= doc.history.length) return
    setBrowserDocState(tabId, doc.id, { loading: true })
    await (delta === -1 ? goBackBrowserTile(tabId, doc.id) : goForwardBrowserTile(tabId, doc.id))
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
    initiatedLoadRef.current = true
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
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={submitUrlCard}
            autoFocus={isFocused}
            focusSignal={addressFocusSignal}
          />
        </BrowserToolbar>
        <ProgressLine active={doc.loading} />
      </div>

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
              <div className="mt-16 text-[12px] text-devdeck-muted">No bookmarks yet.</div>
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

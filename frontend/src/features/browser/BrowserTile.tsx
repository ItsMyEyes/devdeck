import type { FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Home, Maximize2, Minimize2, Plus, RefreshCw, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useBookmarks, useCreateBookmark, useDeleteBookmark, useMachines, useMachinesHealth } from '@/features/data/queries'
import { takeLegacyBrowserTileBookmarks } from '@/lib/browserTileBookmarks'
import { startProxy } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import type { Bookmark, Machine } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { BookmarkDialog } from './BookmarkDialog'
import {
  closeBrowserTile as closeNativeBrowserTile,
  hideBrowserTile,
  navigateBrowserTile,
  onBrowserTilePageLoad,
  onBrowserTileTitleChange,
  openBrowserTile,
  reloadBrowserTile,
  setBrowserTileBounds,
  showBrowserTile,
} from './browserTilesBridge'

interface BrowserTileProps {
  tabId: string
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

/** First letter of the bookmark's title on a color picked from its id, shown
 *  whenever FaviconService couldn't resolve a real icon (page has none, or
 *  the owning machine was unreachable at save time). */
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

function BookmarkIcon({ bookmark }: { bookmark: Bookmark }) {
  if (bookmark.iconDataUrl) {
    return <img src={bookmark.iconDataUrl} alt="" className="h-5 w-5 flex-none rounded-[3px]" />
  }
  return (
    <div
      className={cn(
        'flex h-5 w-5 flex-none items-center justify-center rounded-[3px] text-[10px] font-semibold',
        chipColorFor(bookmark.id),
      )}
    >
      {(bookmark.title.trim()[0] ?? '?').toUpperCase()}
    </div>
  )
}

/** The 28px toolbar buttons are fine under a mouse but far too small to hit
 *  reliably with a thumb, so they grow to 36px on touch pointers only — the
 *  toolbar wraps, so the extra width costs nothing. */
const toolbarButtonClass = 'pointer-coarse:h-9 pointer-coarse:w-9'

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

export function BrowserTile({ tabId }: BrowserTileProps) {
  const tile = useDevDeckStore((s) => s.browserTiles[tabId])
  const ensureBrowserTile = useDevDeckStore((s) => s.ensureBrowserTile)
  const setBrowserDocState = useDevDeckStore((s) => s.setBrowserDocState)
  const addBrowserDoc = useDevDeckStore((s) => s.addBrowserDoc)
  const closeBrowserDoc = useDevDeckStore((s) => s.closeBrowserDoc)
  const selectBrowserDoc = useDevDeckStore((s) => s.selectBrowserDoc)
  const setBrowserTileFullscreen = useDevDeckStore((s) => s.setBrowserTileFullscreen)
  const nativeOverlayBlockers = useDevDeckStore((s) => s.nativeOverlayBlockers)
  const machines = useMachines().data ?? []
  const machineHealth = useMachinesHealth(machines)
  const bookmarks = useBookmarks().data ?? []
  const createBookmark = useCreateBookmark()
  const deleteBookmark = useDeleteBookmark()
  const bookmarksByMachine = useMemo(() => groupBookmarksByMachine(bookmarks, machines), [bookmarks, machines])
  const [draft, setDraft] = useState('')
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

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

  // Native webviews are separate OS surfaces the window manager always
  // stacks above the app's DOM — no CSS z-index can put a dialog/command
  // palette in front of one (see `nativeOverlayBlockers`'s doc comment).
  // Hide the webview for as long as any such overlay is open, then restore
  // it once the last one closes — mirrors the machine-switch path above,
  // since the ResizeObserver won't fire on its own (the placeholder's
  // on-screen size hasn't actually changed).
  useEffect(() => {
    if (!doc?.url || !openedDocsRef.current.has(doc.id)) return
    const docId = doc.id
    if (nativeOverlayBlockers > 0) {
      void hideBrowserTile(tabId, docId)
      return
    }
    const el = bodyRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    void showBrowserTile(tabId, docId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
  }, [nativeOverlayBlockers, tabId, doc?.id, doc?.url])

  // Sync the address bar/title from real in-page navigation inside the native webview.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void onBrowserTilePageLoad(({ tabId: t, docId: d, url }) => {
      if (t === tabId) setBrowserDocState(t, d, { url, loading: false })
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
    // effect below creates the native webview once the placeholder <div>
    // exists, sized correctly from the start — see that effect's comment
    // for why opening doesn't happen here.
    if (doc.url) {
      await navigateBrowserTile(tabId, doc.id, url)
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void navigate(draft)
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

  const canGoBack = doc.historyIndex > 0
  const canGoForward = doc.historyIndex < doc.history.length - 1

  return (
    // `@container/tile` — the toolbar below reflows on the *tile's* width, not
    // the viewport's: a browser tile split three ways on a desktop is just as
    // narrow as a full-width one on a phone, and needs the same layout.
    <div className="@container/tile flex min-h-0 min-w-0 flex-1 flex-col bg-devdeck-bg">
      {tile.fullscreen && (
        <div className="flex h-8 flex-none items-center gap-1 overflow-x-auto border-b border-devdeck-border bg-devdeck-surface px-2">
          {tile.docs.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => selectBrowserDoc(tabId, d.id)}
              className={cn(
                'group flex h-6 max-w-[160px] flex-none items-center gap-1.5 rounded-md px-2 font-mono text-[11px]',
                d.id === tile.activeDocId ? 'bg-devdeck-elevated text-devdeck-fg' : 'text-devdeck-muted hover:bg-devdeck-hover-wash',
              )}
            >
              <Globe size={11} />
              <span className="truncate">{d.title}</span>
              {tile.docs.length > 1 && (
                <X
                  size={10}
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeInternalTab(d.id)
                  }}
                  // Touch devices never fire hover, so the reveal-on-hover close
                  // affordance leaves internal tabs impossible to close there.
                  className="flex-none opacity-0 group-hover:opacity-100 pointer-coarse:h-3.5 pointer-coarse:w-3.5 pointer-coarse:opacity-100"
                />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => addBrowserDoc(tabId)}
            aria-label="New tab"
            className="ml-1 flex h-6 w-6 flex-none items-center justify-center rounded-md text-devdeck-dim hover:bg-devdeck-hover-wash"
          >
            <Plus size={12} />
          </button>
        </div>
      )}

      {/* Wraps rather than scrolls: every control here is fixed-width, so the
          old `overflow-x-auto` row had nothing to give but the address bar,
          which collapsed to a few unreadable pixels long before the row ever
          became scrollable. Below 32rem the address bar drops to its own
          full-width line instead (`order-last` + `w-full`). */}
      <div className="flex min-w-0 flex-none flex-wrap items-center gap-1.5 border-b border-devdeck-border bg-devdeck-bg px-2 py-1.5">
        <Globe size={13} className="hidden flex-none text-devdeck-dim @lg/tile:block" />
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={() => void goHistory(-1)} disabled={!canGoBack} aria-label="Back">
          <ArrowLeft size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={() => void goHistory(1)} disabled={!canGoForward} aria-label="Forward">
          <ArrowRight size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={() => void goHome()} aria-label="Home">
          <Home size={12} />
        </Button>
        <form onSubmit={submit} className="order-last flex w-full min-w-0 items-center gap-1.5 @lg/tile:order-none @lg/tile:w-auto @lg/tile:flex-1">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={doc.machineId ? 'Search or enter URL' : 'Choose a machine first'}
            disabled={!doc.machineId}
            /* 16px on touch: anything smaller makes mobile Safari zoom the
               whole page in on focus, which drags the native webview off-screen. */
            className="h-7 min-w-0 flex-1 font-mono text-[11.5px] pointer-coarse:h-9 pointer-coarse:text-[16px]"
          />
        </form>
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={() => void reload()} disabled={!doc.url} aria-label="Reload">
          <RefreshCw size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={openBookmarkDialog} disabled={!doc.url} aria-label="Bookmark this page">
          <Star size={12} />
        </Button>
        <Select
          value={doc.machineId ?? ''}
          onValueChange={(machineId) => void selectMachine(machineId)}
          options={machines.map((m) => ({
            value: m.id,
            label: m.name,
            disabled: machineHealth.get(m.id)?.status === 'offline',
          }))}
          triggerClassName="h-7 min-w-24 max-w-40 flex-1 pointer-coarse:h-9 @lg/tile:w-32 @lg/tile:max-w-none @lg/tile:flex-none"
          aria-label="Machine"
        />
        <Button
          size="icon-sm"
          variant="secondary"
          className={cn(toolbarButtonClass, 'ml-auto @lg/tile:ml-0')}
          onClick={() => setBrowserTileFullscreen(tabId, !tile.fullscreen)}
          aria-label={tile.fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {tile.fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </Button>
      </div>

      <div className="relative min-h-0 min-w-0 flex-1">
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
                                <BookmarkIcon bookmark={bookmark} />
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

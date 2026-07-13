import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Home, Maximize2, Minimize2, Plus, RefreshCw, Star, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useMachines } from '@/features/data/queries'
import {
  addBrowserTileBookmark,
  groupBrowserTileBookmarks,
  loadBrowserTileBookmarks,
  removeBrowserTileBookmark,
} from '@/lib/browserTileBookmarks'
import type { BrowserTileBookmark } from '@/lib/browserTileBookmarks'
import { startProxy } from '@/lib/machineApi'
import { cn } from '@/lib/utils'
import { useLoomStore } from '@/store/useLoomStore'
import {
  closeBrowserTile as closeNativeBrowserTile,
  hideBrowserTile,
  navigateBrowserTile,
  onBrowserTilePageLoad,
  openBrowserTile,
  reloadBrowserTile,
  setBrowserTileBounds,
} from './browserTilesBridge'

interface BrowserTileProps {
  tabId: string
}

function normalizeAddress(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(raw)) return `https://${raw}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`
}

export function BrowserTile({ tabId }: BrowserTileProps) {
  const tile = useLoomStore((s) => s.browserTiles[tabId])
  const ensureBrowserTile = useLoomStore((s) => s.ensureBrowserTile)
  const setBrowserDocState = useLoomStore((s) => s.setBrowserDocState)
  const addBrowserDoc = useLoomStore((s) => s.addBrowserDoc)
  const closeBrowserDoc = useLoomStore((s) => s.closeBrowserDoc)
  const selectBrowserDoc = useLoomStore((s) => s.selectBrowserDoc)
  const setBrowserTileFullscreen = useLoomStore((s) => s.setBrowserTileFullscreen)
  const machines = useMachines().data ?? []
  const [draft, setDraft] = useState('')
  const [bookmarks, setBookmarks] = useState<BrowserTileBookmark[]>(loadBrowserTileBookmarks)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ensureBrowserTile(tabId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

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
    setBrowserDocState(tabId, doc.id, { url, loading: true, history, historyIndex: history.length - 1 })
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
    setBrowserDocState(tabId, doc.id, { url, historyIndex: nextIndex, loading: true })
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

  const openInRealBrowser = () => {
    if (doc.url) window.open(doc.url, '_blank', 'noopener,noreferrer')
  }

  const addBookmark = () => {
    if (!doc.url) return
    setBookmarks((current) => addBrowserTileBookmark(current, { title: doc.title, url: doc.url as string, group: 'Portal' }))
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

  const bookmarkGroups = groupBrowserTileBookmarks(bookmarks)
  const canGoBack = doc.historyIndex > 0
  const canGoForward = doc.historyIndex < doc.history.length - 1

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-loom-bg">
      {tile.fullscreen && (
        <div className="flex h-8 flex-none items-center gap-1 overflow-x-auto border-b border-loom-border bg-loom-surface px-2">
          {tile.docs.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => selectBrowserDoc(tabId, d.id)}
              className={cn(
                'group flex h-6 max-w-[160px] flex-none items-center gap-1.5 rounded-md px-2 font-mono text-[11px]',
                d.id === tile.activeDocId ? 'bg-loom-elevated text-loom-fg' : 'text-loom-muted hover:bg-loom-hover-wash',
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
                  className="opacity-0 group-hover:opacity-100"
                />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => addBrowserDoc(tabId)}
            aria-label="New tab"
            className="ml-1 flex h-6 w-6 flex-none items-center justify-center rounded-md text-loom-dim hover:bg-loom-hover-wash"
          >
            <Plus size={12} />
          </button>
        </div>
      )}

      <div className="flex flex-none items-center gap-1.5 border-b border-loom-border bg-loom-bg px-2 py-1.5">
        <Globe size={13} className="flex-none text-loom-dim" />
        <Button size="icon-sm" variant="secondary" onClick={() => void goHistory(-1)} disabled={!canGoBack} aria-label="Back">
          <ArrowLeft size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={() => void goHistory(1)} disabled={!canGoForward} aria-label="Forward">
          <ArrowRight size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={() => void goHome()} aria-label="Home">
          <Home size={12} />
        </Button>
        <form onSubmit={submit} className="flex min-w-0 flex-1 items-center gap-1.5">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={doc.machineId ? 'Search or enter URL' : 'Choose a machine first'}
            disabled={!doc.machineId}
            className="h-7 flex-1 font-mono text-[11.5px]"
          />
        </form>
        <Button size="icon-sm" variant="secondary" onClick={() => void reload()} disabled={!doc.url} aria-label="Reload">
          <RefreshCw size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={addBookmark} disabled={!doc.url} aria-label="Bookmark this page">
          <Star size={12} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={openInRealBrowser} disabled={!doc.url} aria-label="Open in real browser">
          <ExternalLink size={12} />
        </Button>
        <Select
          value={doc.machineId ?? ''}
          onValueChange={(machineId) => void selectMachine(machineId)}
          options={machines.map((m) => ({ value: m.id, label: m.name }))}
          triggerClassName="h-7 w-32"
          aria-label="Machine"
        />
        <Button
          size="icon-sm"
          variant="secondary"
          onClick={() => setBrowserTileFullscreen(tabId, !tile.fullscreen)}
          aria-label={tile.fullscreen ? 'Exit full screen' : 'Full screen'}
        >
          {tile.fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {!doc.url ? (
          <div className="flex h-full flex-col items-center gap-4 overflow-auto p-6">
            {bookmarkGroups.length === 0 ? (
              <div className="mt-16 text-[12px] text-loom-muted">No bookmarks yet — enter a URL above to start browsing.</div>
            ) : (
              bookmarkGroups.map(([group, items]) => (
                <div key={group} className="w-full max-w-[520px]">
                  <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-loom-dim">{group}</div>
                  <div className="grid grid-cols-2 gap-2">
                    {items.map((bookmark) => (
                      <button
                        key={bookmark.id}
                        type="button"
                        onClick={() => void navigate(bookmark.url)}
                        className="flex items-center justify-between rounded-lg border border-loom-border-card bg-loom-surface-2 px-3 py-2.5 text-left hover:border-loom-border-accent"
                      >
                        <span className="truncate text-[12px] text-loom-fg-2">{bookmark.title}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setBookmarks((current) => removeBrowserTileBookmark(current, bookmark.id))
                          }}
                          aria-label={`Remove ${bookmark.title}`}
                          className="text-loom-muted-2 hover:text-loom-red-soft"
                        >
                          <X size={12} />
                        </button>
                      </button>
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
    </div>
  )
}
